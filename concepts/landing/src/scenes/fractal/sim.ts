// The fractal scene's motion. Every picture is drawn from scratch each frame by the shader; this
// module is the hand that moves it: the walk of c from station to station round the Mandelbrot
// set, the dive's zoom and its loop, the flow of the Apollonian circles, the dance of the garden's
// stones, the pointer's nudge and drag, and the wipes that carry one picture into the next.
//
// Two layers: the shader draws layer 0 (incoming) inside a soft, expanding front and layer 1
// (outgoing) outside it, so a mode change, a new dive or the dive's own loop blooms out of a point
// instead of cutting. The dive loops by self-similarity: it zooms toward the fixed point of the map
// that carries the whole Mandelbrot set onto one of its islands (a minibrot), so the view at the
// end of a loop shows that island framed exactly as the set was at the start; the last stretch is
// wiped, from the zoom's focus outward, into the start again.
//
// The state reaches the shader as one row of float32 texels (half floats cannot carry the dive's
// view offsets or the walk of c without visible steps), uSim0, FRACTAL_TEXELS × 1, nearest:
//   texel 0   the wipe: front centre (content units), radius, softness (radius ≥ 1e3: one layer)
//   texel 1   drag pan (content units), M strength 0..1, M size knob
//   texel 2   the passage: scale about the focus (0 at rest, else < 1), focus (content units),
//             e-folds per second the picture is smeared at (#advancePassage)
//   then one block of FRACTAL_LAYER_TEXELS per layer, incoming first:
//     +0      mode, iterations, ripple phase, a mode's scalar (Julia, garden: z units per content
//             unit; dive: the zoom's speed, 1/s)
//     +1..+9  mode-specific, written by write* below; velocities are per second of the scene
//             clock: they only set how far moving detail is smeared (shader.ts)
//     +10     orbit trap: centre (z), pearl radius, lace radius
//     +11     M trap: centre (z), size, rotation
// Content units: half the screen height, origin at the centre, after the pan.
import { KnobReader, type ParamDef } from "../../params.ts";
import { clamp, smoothstep } from "../../sims/math.ts";
import { ElasticPan } from "../../sims/pan.ts";
import type {
  PointerState,
  SceneDef,
  ScenePassageProgress,
  SceneSim,
  SimFactory,
  SimFrame,
} from "../types.ts";

/** The `mode` knob's values, in order. */
export const fractalModes = ["julia", "dive", "gasket", "garden"] as const;

/** State row: these global texels, then one block per layer (incoming first); see the top. */
export const FRACTAL_GLOBAL_TEXELS = 3;
export const FRACTAL_LAYER_TEXELS = 12;
export const FRACTAL_TEXELS = FRACTAL_GLOBAL_TEXELS + 2 * FRACTAL_LAYER_TEXELS;

/** Seconds of travel a moving feature is smeared over (shader.ts). */
export const FRACTAL_SMEAR = 0.7;

const TAU = Math.PI * 2;
const MODE_JULIA = 0;
const MODE_DIVE = 1;
const MODE_GASKET = 2;
const MODE_GARDEN = 3;

// The wipes.
/** Seconds a mode change or a new dive takes to bloom across the screen. */
const SWAP_SECONDS = 4.5;
/** Width of the wipe's soft front (content units). */
const SWAP_SOFT = 0.45;
const LOOP_SOFT = 0.35;

// The passage: the entrance and exit happen in the world, as a camera. Entering, it rises from a
// point deep in the fractal and settles into the usual framing while the iteration count climbs,
// so the fine detail grows in; leaving, it falls into a point, accelerating. Julia, gasket and
// garden scale their view about a focus (shader.ts, texel 2); the dive spends its own zoom: its
// loop phase runs deeper than usual and back (the self-similarity keeps the framing exact at rest).
/** Seconds the entrance and exit take (SceneDef.passage). */
export const FRACTAL_PASSAGE: NonNullable<SceneDef["passage"]> = { enter: 2.8, exit: 1.4 };
/**
 * The camera's depth is a power of the time left (entrance) or gone (exit): it rises at its fastest
 * and settles softly, or sets off softly and falls ever faster.
 */
const PASSAGE_ENTER_CURVE = 4;
const PASSAGE_EXIT_CURVE = 3.5;
/** The share of the iterations the entrance starts with, rising to all of them over its last 85%. */
const PASSAGE_ITER_FROM = 0.15;
const PASSAGE_MIN_ITERATIONS = 10;
/** Where the focus may lie on screen, as a share of the half-extents (it is kept in view). */
const PASSAGE_FOCUS_MARGIN = 0.8;

/** How deep the camera is, in e-folds of zoom, on entering and leaving, and the share of iterations it starts with. */
interface PassageReach {
  enter: number;
  exit: number;
  floor: number;
}
const PASSAGE_NONE: PassageReach = { enter: 0, exit: 0, floor: 1 };
/** In the order of the modes. */
const PASSAGE_REACH: readonly PassageReach[] = [
  { enter: 3, exit: 3.4, floor: 0.3 }, // julia: toward the repelling fixed point, on the set
  { enter: 3.6, exit: 3.4, floor: 0.3 }, // dive: further into the island
  { enter: 2.6, exit: 3, floor: 0.4 }, // gasket: toward where two big circles kiss
  { enter: 2.2, exit: 2.6, floor: 0.65 }, // garden: toward where the stones' pulls balance
];

// The pointer.
/**
 * Seconds for the hover nudge to follow the pointer, and the half-life of a released drag. The
 * drag keeps the picture's centre within the frame: it meets a rubber band's resistance there and
 * can stretch it at most PAN_GIVE (content units) further; an overshoot springs back in about
 * PAN_SNAP seconds once let go.
 */
const NUDGE_EASE = 1.2;
const PAN_HALF_LIFE = 6;
const PAN_GIVE = 0.3;
const PAN_SNAP = 0.25;
/** Seconds over which velocities are smoothed (they only set how much detail softens as it moves). */
const VELOCITY_EASE = 0.3;

// Julia: c dwells at a station, breathing on a small circle round it, then glides on to the next.
// Most stations are centres of bulbs of the Mandelbrot set, where the Julia set is crisp and its
// chambers settle at once; between them c crosses the set's edge, where the set pinches, spirals
// and shatters, but only in passing. The walk goes round the top of the Mandelbrot set and back
// along the bottom, whose sets are the mirror images of those above.
const JULIA_STATIONS: readonly (readonly [number, number])[] = [
  [0.245, 0], // deep in the cardioid by its cusp: a round, cauliflower set, ruled by its Koenigs grid
  [0.2822, 0.5301], // centre of the 1/4 bulb: a four-armed rabbit
  [0, 1], // a dendrite: all branches, no inside
  [-0.1225, 0.7449], // the Douady rabbit, centre of the 1/3 bulb
  // The golden-mean Siegel disc, just inside the cardioid (c = μ/2 − μ²/4, μ = 0.97 e^{2πi·0.382}):
  // slow spirals round a fixed point that turns by the golden angle.
  (() => {
    const radius = 0.97;
    const angle = TAU * 0.381966;
    return [
      0.5 * radius * Math.cos(angle) - 0.25 * radius * radius * Math.cos(2 * angle),
      0.5 * radius * Math.sin(angle) - 0.25 * radius * radius * Math.sin(2 * angle),
    ] as const;
  })(),
  [-0.5043, 0.5628], // centre of the 2/5 bulb: a five-armed star
  [-0.7269, 0.1889], // just outside the set by seahorse valley: a spiral galaxy of dust
  [-1, 0], // the basilica, centre of the 2-bulb
  [-1.7549, 0], // the airplane, centre of the period-3 island on the needle
  [-0.5043, -0.5628],
  [-0.1225, -0.7449],
  [0.2822, -0.5301],
];
/** The station the walk starts at: the rabbit. */
const JULIA_START = 3;
/** Seconds of drift spent at a station at wander 0 and 1. */
const JULIA_DWELL_LONG = 90;
const JULIA_DWELL_SHORT = 20;
/** A glide takes this long, plus this much per unit of c it covers (seconds of drift). */
const JULIA_GLIDE_BASE = 10;
const JULIA_GLIDE_SPAN = 45;
/** Seconds of a breath, and the radius of its circle in c per unit of the breath knob. */
const JULIA_BREATH_PERIOD = 34;
const JULIA_BREATH_RADIUS = 0.03;
/** z units per content unit at zoom 1, and how far the hover nudges c per content unit. */
const JULIA_REACH = 1.5;
const JULIA_NUDGE = 0.012;

// The dive: islands of the Mandelbrot set and how each loop starts (the whole set, framed so the
// island's focus sits well on screen). Nucleus and scale are found from the seeds at load.
const DIVE_SEEDS = [
  { seed: [-0.1565, 1.0322], period: 4, start: [-0.55, 0.25], height: 1.3 }, // on the antenna above the 1/3 bulb
  { seed: [-1.7549, 0], period: 3, start: [-0.75, 0], height: 1.25 }, // the island on the needle
  { seed: [-1.2564, 0.3803], period: 5, start: [-0.7, 0.15], height: 1.25 }, // off the 2-bulb, turning
  { seed: [0.3593, 0.6425], period: 5, start: [-0.45, 0.2], height: 1.25 }, // above the elephants
] as const;
/** e-folds of zoom per second at pace 1, and how much the breath quickens and slows it. */
const DIVE_ZOOM = 0.03;
const DIVE_BREATH = 0.6;
const DIVE_BREATH_PERIOD = 40;
/** Share of a loop over which its end is wiped into its start. */
const DIVE_BLEND = 0.18;
/** Where a fresh dive starts, as a share of its loop. */
const DIVE_ENTRY = 0.02;
/** The dive's parallax under a hovering pointer (content units per content unit). */
const DIVE_NUDGE = 0.05;

// The gasket: the band packing (circles between y = 0 and y = 1) carried onto the classic round
// gasket by GASKET_CLASSIC, flowing along the band (a parabolic conveyor round the top circle),
// turning, and seen through a moving disc automorphism (a lens that swells one side).
/** Lens positions (disc units) a 'now' moves between. */
const GASKET_LENSES = [
  [0, 0],
  [-0.27, 0.3],
  [0.4, -0.22],
  [0.1, 0.42],
] as const;
/** Band periods per second of flow, radians per second of turn, and the lens's breath (disc units). */
const GASKET_FLOW = 1 / 80;
const GASKET_TURN = TAU / 720;
const GASKET_BREATH = 0.1;
const GASKET_BREATH_PERIOD = 34;
const GASKET_MORPH_SECONDS = 6;
/** The gasket's radius in content units at zoom 1, and the hover lean (disc units per content unit). */
const GASKET_RADIUS = 0.93;
const GASKET_LEAN = 0.12;

// The garden: Newton's method for Π (z − r_k)^{w_k}, stones at the roots. Arrangements are
// [x, y, weight] (z units); a weight of 0 hides a stone (its basin closes as the weight falls).
const GARDEN_ARRANGEMENTS = [
  [
    [-0.95, 0.35, 1],
    [0.25, -0.45, 1.08],
    [1.05, 0.5, 0.94],
    [-1.6, -0.6, 0],
    [1.7, -0.3, 0],
  ],
  [
    [-1.35, 0.25, 1],
    [-0.95, -0.38, 0.9],
    [0.15, 0.55, 1.1],
    [0.95, -0.25, 1],
    [1.45, 0.38, 0.92],
  ],
  [
    [-0.75, -0.22, 1.05],
    [-0.2, 0.55, 0.95],
    [0.62, -0.5, 1],
    [1.3, 0.2, 1.06],
    [1.9, -0.6, 0],
  ],
  [
    [-1.2, -0.1, 1],
    [0, 0.28, 1.12],
    [1.15, -0.22, 0.9],
    [-0.3, -0.9, 0],
    [0.5, 1.0, 0],
  ],
] as const;
const GARDEN_STONES = 5;
/** Each stone circles its place: radius (z units) and period (s of drift) per stone. */
const GARDEN_DANCE_RADIUS = 0.035;
const GARDEN_DANCE_PERIODS = [125, 107, 146, 96, 164] as const;
const GARDEN_MORPH_SECONDS = 8;
/** Seconds of drift per ripple drifting outward one band, and the breath's twist (imaginary relaxation). */
const GARDEN_RAKE = 120;
const GARDEN_TWIST = 0.08;
const GARDEN_BREATH_PERIOD = 48;
/** z units per content unit at zoom 1, the hovering pebble's weight and how fast it follows. */
const GARDEN_REACH = 1.3;
const GARDEN_PEBBLE = 0.55;
const GARDEN_PEBBLE_EASE = 0.35;

// Gasket and garden rearrange themselves every so often while wandering (s of drift, wander 0..1).
const REARRANGE_RARE = 200;
const REARRANGE_OFTEN = 40;

// The M: how long a 'now' shows it while the feature is off, and how fast it fades (s).
const MARK_SUMMON = 14;
const MARK_FADE = 2.5;

type Complex = readonly [number, number];
const add = (a: Complex, b: Complex): Complex => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Complex, b: Complex): Complex => [a[0] - b[0], a[1] - b[1]];
const mul = (a: Complex, b: Complex): Complex => [
  a[0] * b[0] - a[1] * b[1],
  a[0] * b[1] + a[1] * b[0],
];
const scale = (a: Complex, k: number): Complex => [a[0] * k, a[1] * k];
const polar = (radius: number, angle: number): Complex => [
  radius * Math.cos(angle),
  radius * Math.sin(angle),
];

function div(a: Complex, b: Complex): Complex {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
}

/** Principal square root. */
function csqrt(a: Complex): Complex {
  const r = Math.hypot(a[0], a[1]);
  const re = Math.sqrt(Math.max(0, (r + a[0]) / 2));
  const im = Math.sqrt(Math.max(0, (r - a[0]) / 2));
  return [re, a[1] < 0 ? -im : im];
}

/** z ↦ (az + b)/(cz + d). */
interface Mobius {
  a: Complex;
  b: Complex;
  c: Complex;
  d: Complex;
}

/** m after n. */
function compose(m: Mobius, n: Mobius): Mobius {
  return {
    a: add(mul(m.a, n.a), mul(m.b, n.c)),
    b: add(mul(m.a, n.b), mul(m.b, n.d)),
    c: add(mul(m.c, n.a), mul(m.d, n.c)),
    d: add(mul(m.c, n.b), mul(m.d, n.d)),
  };
}

/** The same map with ad − bc = 1, so its derivative is 1/(cz + d)². */
function unimodular(m: Mobius): Mobius {
  const root = csqrt(sub(mul(m.a, m.d), mul(m.b, m.c)));
  return { a: div(m.a, root), b: div(m.b, root), c: div(m.c, root), d: div(m.d, root) };
}

/**
 * The classic gasket (unit circle round three equal circles, one at the top) onto the band: the
 * outer circle goes to y = 0, the top circle to y = 1 (its tangency with the outer circle to
 * infinity), the lower left and right circles to the unit circles touching both lines at x = 0
 * and x = 1.
 */
const GASKET_CLASSIC: Mobius = ((): Mobius => {
  const top = polar(1, TAU / 4);
  const left = polar(1, (TAU * 210) / 360);
  const right = polar(1, (TAU * 330) / 360);
  const k = div(sub(right, top), sub(right, left));
  return { a: k, b: scale(mul(k, left), -1), c: [1, 0], d: scale(top, -1) };
})();

/** Newton's method on f_c^p(0) = 0 from a seed: the island of period p's nucleus, and |dz_p/dc| there. */
function nucleus(seed: Complex, period: number): { c: Complex; slope: number } {
  let c = seed;
  let slope = 1;
  for (let step = 0; step < 64; step++) {
    let z: Complex = [0, 0];
    let dz: Complex = [0, 0];
    for (let i = 0; i < period; i++) {
      dz = add(scale(mul(z, dz), 2), [1, 0]);
      z = add(mul(z, z), c);
    }
    const delta = div(z, dz);
    c = sub(c, delta);
    slope = Math.hypot(dz[0], dz[1]);
    if (Math.hypot(delta[0], delta[1]) < 1e-16) break;
  }
  return { c, slope };
}

/**
 * The island's size and turn as one complex σ: near the nucleus c0 the Mandelbrot set looks like
 * c0 + σ·M. From the derivative of the critical orbit round its cycle (the "atom size" estimate:
 * l = Π 2z_i, b = Σ 1/l_i, σ = 1/(b l²)).
 */
function islandScale(c: Complex, period: number): Complex {
  let z: Complex = [0, 0];
  let l: Complex = [1, 0];
  let b: Complex = [1, 0];
  for (let i = 1; i < period; i++) {
    z = add(mul(z, z), c);
    l = scale(mul(z, l), 2);
    b = add(b, div([1, 0], l));
  }
  return div([1, 0], mul(b, mul(l, l)));
}

interface DiveSite {
  nucleus: Complex;
  period: number;
  /** |dz_p/dc| at the nucleus: near the island, its orbits' traps shrink by this per period. */
  slope: number;
  /** The fixed point of c ↦ c0 + σc: the zoom's focus. */
  focus: Complex;
  /** σ^s = e^{s·log σ}. */
  logScale: Complex;
  scale: Complex;
  start: Complex;
  height: number;
}

const DIVE_SITES: readonly DiveSite[] = DIVE_SEEDS.map(({ seed, period, start, height }) => {
  const { c: c0, slope } = nucleus(seed, period);
  const sigma = islandScale(c0, period);
  return {
    nucleus: c0,
    period,
    slope,
    focus: div(c0, sub([1, 0], sigma)),
    logScale: [Math.log(Math.hypot(sigma[0], sigma[1])), Math.atan2(sigma[1], sigma[0])],
    scale: sigma,
    start,
    height,
  };
});

/** What a layer shows: its mode, and for a dive, which island and how far into its loop. */
interface Layer {
  mode: number;
  site: number;
  phase: number;
}

type KnobKey = "kind" | "pace" | "breath" | "wander" | "zoom" | "detail" | "mark";

/** One frame's knob values as the motion reads them. */
interface Knobs {
  mode: number;
  pace: number;
  breath: number;
  /** 0 while wandering is off. */
  wander: number;
  zoom: number;
  detail: number;
  /** The M feature's size; 0 while off. */
  mark: number;
}

/** A float32 RGBA row the renderer binds as uSim0 (sampled with texelFetch). */
class StateRow {
  readonly texture: WebGLTexture;
  readonly #gl: WebGL2RenderingContext;
  readonly #width: number;

  constructor(gl: WebGL2RenderingContext, width: number) {
    this.#gl = gl;
    this.#width = width;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    // 32-bit float textures are only complete with nearest filtering in WebGL2.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, null);
  }

  upload(data: Float32Array): void {
    const gl = this.#gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.#width, 1, gl.RGBA, gl.FLOAT, data);
  }

  dispose(): void {
    this.#gl.deleteTexture(this.texture);
  }
}

/** Exponential follow: the share of the way to close in `dt` seconds with time constant `ease`. */
const follow = (dt: number, ease: number): number => 1 - Math.exp(-dt / ease);

/**
 * Smoothed rate of change of a value, by backward difference over frames. It only sets how much
 * moving detail is softened, so a frame that cannot be differenced (paused, or the value jumped by
 * a period of its pattern) keeps the last rate instead of spiking.
 */
class Rate {
  #previous: readonly number[] | undefined;
  readonly value: number[];

  constructor(size: number) {
    this.value = new Array<number>(size).fill(0);
  }

  /** Follow `now` over `dt` seconds of the scene clock. */
  track(now: readonly number[], dt: number): void {
    const previous = this.#previous;
    if (previous && dt > 0) {
      const k = follow(dt, VELOCITY_EASE);
      for (let i = 0; i < now.length; i++) {
        const rate = ((now[i] ?? 0) - (previous[i] ?? 0)) / dt;
        this.value[i] = (this.value[i] ?? 0) + (rate - (this.value[i] ?? 0)) * k;
      }
    }
    this.#previous = now;
  }

  /** Take `now` as the new reference without measuring a rate (unseen, or wrapped round). */
  rebase(now: readonly number[]): void {
    this.#previous = now;
  }
}

class FractalSim implements SceneSim {
  readonly #row: StateRow;
  readonly #data = new Float32Array(FRACTAL_TEXELS * 4);
  readonly #reader: KnobReader<KnobKey>;
  readonly #nextTrigger: number;
  readonly #markTrigger: number;
  readonly #knobs: Knobs = {
    mode: 0,
    pace: 1,
    breath: 0.5,
    wander: 0.4,
    zoom: 1,
    detail: 0.5,
    mark: 0,
  };

  #aspect = 16 / 9;
  #height = 540;
  #time = 0;
  #motion = 1;
  #started = false;
  /** Seconds of drift: every mode's breath is a sine of it, each with its own period. */
  #breathClock = 0;
  // The passage: how many e-folds deeper than the usual framing the camera is, how fast in e-folds
  // per second the picture is smeared (#advancePassage), and the share of the iterations in use. 0,
  // 0 and 1 at rest.
  #depth = 0;
  #smearRate = 0;
  #iterShare = 1;

  // Layers and the wipe between them.
  #incoming: Layer = { mode: MODE_JULIA, site: 0, phase: DIVE_ENTRY };
  #outgoing: Layer | undefined;
  /** "loop": the dive's end into its start, timed by its phase; "swap": a new mode or island. */
  #wipe: "loop" | "swap" | undefined;
  #wipeProgress = 0;
  #pendingNext = false;
  #loops = 0;
  #diveSite = 0;

  // Pointer.
  #nudge: Complex = [0, 0];
  readonly #pan = new ElasticPan({ halfLife: PAN_HALF_LIFE, give: PAN_GIVE, snap: PAN_SNAP });
  #dragFrom: Complex | undefined;

  // Julia: the station c rests at (or glides from), how far along the glide (−1: resting), how
  // long it has rested, and whether a 'now' started the glide (it then runs even at motion 0).
  #station = JULIA_START;
  #glide = -1;
  #rest = 0;
  #glideNow = false;
  readonly #juliaRate = new Rate(2);

  // Gasket.
  #flow = 0;
  #turn = 0;
  #lens = 0;
  #lensFrom: Complex = [0, 0];
  #lensMorph = 1;
  #gasketClock = 0;
  readonly #gasketRate = new Rate(8);
  #gasketNow: Mobius | undefined;

  // Garden.
  #dance = 0;
  #rake = 0;
  #arrangement = 0;
  #arrangementFrom = 0;
  #arrangementMorph = 1;
  #gardenClock = 0;
  readonly #gardenRate = new Rate(12);
  #pebble: Complex = [0, 0];
  #pebbleWeight = 0;

  // The M.
  #markStrength = 0;
  #summonedUntil = -1;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#reader = new KnobReader<KnobKey>("fractal", params, [
      "kind",
      "pace",
      "breath",
      "wander",
      "zoom",
      "detail",
      "mark",
    ]);
    this.#nextTrigger = this.#reader.trigger("wander");
    this.#markTrigger = this.#reader.trigger("mark");
    this.#row = new StateRow(gl, FRACTAL_TEXELS);
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const reader = this.#reader;
    const knobs = this.#knobs;
    knobs.mode = clamp(Math.round(reader.value(frame, "kind")), 0, fractalModes.length - 1);
    knobs.pace = reader.value(frame, "pace");
    knobs.breath = reader.value(frame, "breath");
    knobs.wander = reader.value(frame, "wander");
    knobs.zoom = Math.max(0.1, reader.value(frame, "zoom"));
    knobs.detail = reader.value(frame, "detail");
    knobs.mark = reader.value(frame, "mark");
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    if (frame.height > 0) this.#height = frame.height;
    this.#time = frame.time;
    this.#motion = Math.max(0, frame.motion);

    // `real` runs transitions a 'now' or a knob asked for, even with motion at 0; `drift` runs
    // everything that moves by itself.
    const real = Math.max(0, frame.dt);
    const drift = real * this.#motion * knobs.pace;
    this.#breathClock += drift;

    if (frame.fired[this.#markTrigger] === true) this.#summonedUntil = this.#time + MARK_SUMMON;
    const next = frame.fired[this.#nextTrigger] === true;
    this.#steer(frame.pointer, real);
    if (!this.#started) this.#incoming.mode = knobs.mode;
    this.#started = true;
    if (knobs.mode !== this.#incoming.mode) this.#changeMode(knobs.mode);
    if (next) this.#next();

    this.#advanceJulia(drift, real);
    this.#advanceGasket(drift, real);
    this.#advanceGarden(drift, real, frame.pointer);
    this.#advanceLayers(drift, real);
    this.#advanceMark(real);

    this.#advancePassage(frame.passage);
    this.#write();
    this.#row.upload(this.#data);
    return [this.#row.texture];
  }

  dispose(): void {
    this.#row.dispose();
  }

  /**
   * Hover nudges (eased); a drag pans the picture, which drifts home once let go. The pan keeps the
   * picture's centre within the frame, and the nudge, measured from that centre, reaches no further
   * than the frame's half-diagonal, as it would unpanned: no stack of drags flings the picture off
   * screen or drives c far off its walk.
   */
  #steer(pointer: PointerState, dt: number): void {
    const aspect = this.#aspect;
    const at: Complex = [(pointer.x - 0.5) * aspect * 2, (pointer.y - 0.5) * 2];
    const dragging = pointer.down && pointer.inside;
    if (dragging) {
      if (this.#dragFrom)
        this.#pan.drag(at[0] - this.#dragFrom[0], at[1] - this.#dragFrom[1], aspect, 1);
      this.#dragFrom = at;
    } else {
      this.#dragFrom = undefined;
      this.#pan.release(dt, aspect, 1);
    }
    let target: Complex = pointer.inside && !dragging ? sub(at, this.#pan.offset) : [0, 0];
    const reach = Math.hypot(target[0], target[1]);
    const most = Math.hypot(aspect, 1);
    if (reach > most) target = scale(target, most / reach);
    if (dt > 0)
      this.#nudge = add(this.#nudge, scale(sub(target, this.#nudge), follow(dt, NUDGE_EASE)));
  }

  /** Bloom from the current picture into a mode's own (a running wipe snaps to its incoming side). */
  #changeMode(mode: number): void {
    const from = this.#incoming;
    const to: Layer = { mode, site: this.#diveSite, phase: DIVE_ENTRY };
    this.#startSwap(from, to);
  }

  /** 'now', or the wander timer: move on to the next place in the current mode. */
  #next(): void {
    switch (this.#incoming.mode) {
      case MODE_JULIA: {
        if (this.#glide >= 0) return;
        this.#glide = 0;
        this.#glideNow = true;
        return;
      }
      case MODE_DIVE: {
        if (this.#wipe) {
          this.#pendingNext = true;
          return;
        }
        this.#diveSite = (this.#incoming.site + 1) % DIVE_SITES.length;
        this.#startSwap(this.#incoming, {
          mode: MODE_DIVE,
          site: this.#diveSite,
          phase: DIVE_ENTRY,
        });
        return;
      }
      case MODE_GASKET: {
        this.#lensFrom = this.#lensAt();
        this.#lens = (this.#lens + 1) % GASKET_LENSES.length;
        this.#lensMorph = 0;
        this.#gasketClock = 0;
        return;
      }
      case MODE_GARDEN: {
        this.#arrangementFrom = this.#arrangement;
        this.#arrangement = (this.#arrangement + 1) % GARDEN_ARRANGEMENTS.length;
        this.#arrangementMorph = 0;
        this.#gardenClock = 0;
        return;
      }
      default:
        return;
    }
  }

  #startSwap(from: Layer, to: Layer): void {
    this.#outgoing = { ...from };
    this.#incoming = to;
    this.#wipe = "swap";
    this.#wipeProgress = 0;
    this.#loops = 0;
  }

  #advanceLayers(drift: number, real: number): void {
    const knobs = this.#knobs;
    const outgoing = this.#outgoing;
    if (this.#incoming.mode === MODE_DIVE)
      this.#incoming.phase += drift * this.#diveRate(this.#incoming.site);
    if (outgoing?.mode === MODE_DIVE) outgoing.phase += drift * this.#diveRate(outgoing.site);
    if (this.#wipe === "swap") {
      this.#wipeProgress = Math.min(1, this.#wipeProgress + real / SWAP_SECONDS);
      if (this.#wipeProgress >= 1) this.#endWipe();
    } else if (this.#wipe === "loop") {
      const outgoing = this.#outgoing;
      this.#wipeProgress = outgoing
        ? smoothstep(0, 1, (outgoing.phase - (1 - DIVE_BLEND)) / DIVE_BLEND)
        : 1;
      if (!outgoing || outgoing.phase >= 1) {
        this.#endWipe();
        this.#loops++;
        const hold = knobs.wander > 0 ? Math.round(3 - 2 * knobs.wander) : Number.POSITIVE_INFINITY;
        if (this.#loops >= hold) this.#pendingNext = true;
      }
    }
    const incoming = this.#incoming;
    if (!this.#wipe && incoming.mode === MODE_DIVE && incoming.phase >= 1 - DIVE_BLEND) {
      // The loop's last stretch: the same island one level up blooms out of the focus.
      this.#outgoing = { ...incoming };
      incoming.phase -= 1;
      this.#wipe = "loop";
      this.#wipeProgress = 0;
    }
    if (!this.#wipe && this.#pendingNext) {
      this.#pendingNext = false;
      this.#next();
    }
  }

  #endWipe(): void {
    this.#wipe = undefined;
    this.#outgoing = undefined;
    this.#wipeProgress = 0;
  }

  /** Loop phase per second of drift for a dive site: the zoom's e-folds per second, breathing. */
  #diveRate(site: number): number {
    const dive = DIVE_SITES[site] ?? DIVE_SITES[0];
    if (!dive) return 0;
    const breath =
      1 +
      DIVE_BREATH * this.#knobs.breath * Math.sin((this.#breathClock * TAU) / DIVE_BREATH_PERIOD);
    return (DIVE_ZOOM * breath) / -dive.logScale[0];
  }

  #advanceJulia(drift: number, real: number): void {
    const knobs = this.#knobs;
    if (this.#glide < 0) {
      this.#rest += drift;
      const stay = JULIA_DWELL_LONG + (JULIA_DWELL_SHORT - JULIA_DWELL_LONG) * knobs.wander;
      if (knobs.wander > 0 && this.#incoming.mode === MODE_JULIA && this.#rest > stay) {
        this.#glide = 0;
        this.#glideNow = false;
      }
    }
    if (this.#glide >= 0) {
      const [from, to] = this.#juliaLeg();
      const length =
        JULIA_GLIDE_BASE + JULIA_GLIDE_SPAN * Math.hypot(to[0] - from[0], to[1] - from[1]);
      this.#glide += (this.#glideNow ? real : drift) / length;
      if (this.#glide >= 1) {
        this.#station = (this.#station + 1) % JULIA_STATIONS.length;
        this.#glide = -1;
        this.#rest = 0;
      }
    }
    const c = this.#juliaC();
    if (this.#shows(MODE_JULIA)) this.#juliaRate.track(c, real);
    else this.#juliaRate.rebase(c);
  }

  /** Whether either layer is drawing `mode`. */
  #shows(mode: number): boolean {
    return this.#incoming.mode === mode || this.#outgoing?.mode === mode;
  }

  /** The station c rests at (or glides from) and the next. */
  #juliaLeg(): [Complex, Complex] {
    const count = JULIA_STATIONS.length;
    return [
      JULIA_STATIONS[this.#station % count] ?? [0, 0],
      JULIA_STATIONS[(this.#station + 1) % count] ?? [0, 0],
    ];
  }

  /** The breath, in radians. */
  #juliaBreath(): number {
    return (this.#breathClock * TAU) / JULIA_BREATH_PERIOD;
  }

  /** c: on its leg (eased to rest at both ends), on the breath's small circle, nudged by the pointer. */
  #juliaC(): Complex {
    const [from, to] = this.#juliaLeg();
    const at = add(from, scale(sub(to, from), smoothstep(0, 1, Math.max(0, this.#glide))));
    const breath = this.#juliaBreath();
    const radius = JULIA_BREATH_RADIUS * this.#knobs.breath;
    const sway: Complex = [radius * Math.cos(breath), 0.6 * radius * Math.sin(breath + 0.7)];
    return add(add(at, sway), scale(this.#nudge, JULIA_NUDGE));
  }

  #advanceGasket(drift: number, real: number): void {
    const knobs = this.#knobs;
    this.#flow += drift * GASKET_FLOW;
    // The band repeats every 2 in x: wrapping the flow is no motion (rebased, not differenced).
    const wrapped = this.#flow >= 2;
    this.#flow -= 2 * Math.floor(this.#flow / 2);
    this.#turn = (this.#turn + drift * GASKET_TURN) % TAU;
    if (this.#lensMorph < 1)
      this.#lensMorph = Math.min(1, this.#lensMorph + real / GASKET_MORPH_SECONDS);
    this.#gasketClock += drift;
    if (
      knobs.wander > 0 &&
      this.#incoming.mode === MODE_GASKET &&
      this.#gasketClock > REARRANGE_RARE + (REARRANGE_OFTEN - REARRANGE_RARE) * knobs.wander
    )
      this.#next();
    const map = this.#gasketMap();
    const previous = this.#gasketNow;
    // ±m is the same map: keep the sign continuous so the frame-to-frame difference is the flow.
    const flip =
      previous &&
      map.a[0] * previous.a[0] +
        map.a[1] * previous.a[1] +
        map.d[0] * previous.d[0] +
        map.d[1] * previous.d[1] <
        0;
    const signed: Mobius = flip
      ? { a: scale(map.a, -1), b: scale(map.b, -1), c: scale(map.c, -1), d: scale(map.d, -1) }
      : map;
    const entries = [...signed.a, ...signed.b, ...signed.c, ...signed.d];
    if (this.#shows(MODE_GASKET) && !wrapped) this.#gasketRate.track(entries, real);
    else this.#gasketRate.rebase(entries);
    this.#gasketNow = signed;
  }

  #lensAt(): Complex {
    const to: Complex = GASKET_LENSES[this.#lens] ?? [0, 0];
    const t = smoothstep(0, 1, this.#lensMorph);
    return add(this.#lensFrom, scale(sub(to, this.#lensFrom), t));
  }

  /** Content units to band coordinates, ad − bc = 1. */
  #gasketMap(): Mobius {
    const knobs = this.#knobs;
    const breath = (this.#breathClock * TAU) / GASKET_BREATH_PERIOD;
    const sway: Complex = [
      GASKET_BREATH * knobs.breath * Math.cos(breath),
      GASKET_BREATH * knobs.breath * Math.sin(breath * 0.7),
    ];
    let lens = add(
      add(this.#lensAt(), sway),
      scale(
        this.#incoming.mode === MODE_GASKET ? this.#nudge : [0, 0],
        GASKET_LEAN / GASKET_RADIUS,
      ),
    );
    const reach = Math.hypot(lens[0], lens[1]);
    if (reach > 0.75) lens = scale(lens, 0.75 / reach);
    const radius = GASKET_RADIUS * knobs.zoom;
    const shrink: Mobius = { a: [1 / radius, 0], b: [0, 0], c: [0, 0], d: [1, 0] };
    // The disc automorphism z ↦ (z − w)/(1 − w̄z): a lens that swells the side it leans toward.
    const lean: Mobius = { a: [1, 0], b: scale(lens, -1), c: [-lens[0], lens[1]], d: [1, 0] };
    const turn: Mobius = { a: polar(1, this.#turn), b: [0, 0], c: [0, 0], d: [1, 0] };
    const flow: Mobius = { a: [1, 0], b: [this.#flow, 0], c: [0, 0], d: [1, 0] };
    return unimodular(compose(flow, compose(GASKET_CLASSIC, compose(turn, compose(lean, shrink)))));
  }

  #advanceGarden(drift: number, real: number, pointer: PointerState): void {
    const knobs = this.#knobs;
    this.#dance += drift;
    this.#rake += drift / GARDEN_RAKE;
    this.#rake -= Math.floor(this.#rake);
    if (this.#arrangementMorph < 1)
      this.#arrangementMorph = Math.min(1, this.#arrangementMorph + real / GARDEN_MORPH_SECONDS);
    this.#gardenClock += drift;
    if (
      knobs.wander > 0 &&
      this.#incoming.mode === MODE_GARDEN &&
      this.#gardenClock > REARRANGE_RARE + (REARRANGE_OFTEN - REARRANGE_RARE) * knobs.wander
    )
      this.#next();

    // The pebble: the hovering pointer, as one more (lighter) root.
    const reach = GARDEN_REACH / knobs.zoom;
    const hovering = pointer.inside && !pointer.down && this.#incoming.mode === MODE_GARDEN;
    const at: Complex = scale(
      sub([(pointer.x - 0.5) * this.#aspect * 2, (pointer.y - 0.5) * 2], this.#pan.offset),
      reach,
    );
    if (real > 0) {
      if (hovering)
        this.#pebble =
          this.#pebbleWeight < 0.02
            ? at
            : add(this.#pebble, scale(sub(at, this.#pebble), follow(real, GARDEN_PEBBLE_EASE)));
      this.#pebbleWeight +=
        ((hovering ? GARDEN_PEBBLE : 0) - this.#pebbleWeight) * follow(real, NUDGE_EASE);
    }
    const stones = this.#gardenStones();
    const tracked = [...stones.slice(0, GARDEN_STONES * 2), ...this.#gardenRelax()];
    if (this.#shows(MODE_GARDEN)) this.#gardenRate.track(tracked, real);
    else this.#gardenRate.rebase(tracked);
  }

  /** Stone positions (x, y per stone) then weights, blending arrangements and dancing. */
  #gardenStones(): number[] {
    const from = GARDEN_ARRANGEMENTS[this.#arrangementFrom] ?? GARDEN_ARRANGEMENTS[0];
    const to = GARDEN_ARRANGEMENTS[this.#arrangement] ?? GARDEN_ARRANGEMENTS[0];
    const t = smoothstep(0, 1, this.#arrangementMorph);
    const positions: number[] = [];
    const weights: number[] = [];
    for (let k = 0; k < GARDEN_STONES; k++) {
      const a: readonly [number, number, number] = from[k] ?? [0, 0, 0];
      const b: readonly [number, number, number] = to[k] ?? [0, 0, 0];
      const period = GARDEN_DANCE_PERIODS[k] ?? 80;
      const angle = (this.#dance / period) * TAU + k * 2.4;
      positions.push(
        a[0] + (b[0] - a[0]) * t + GARDEN_DANCE_RADIUS * Math.cos(angle),
        a[1] + (b[1] - a[1]) * t + 0.7 * GARDEN_DANCE_RADIUS * Math.sin(angle),
      );
      weights.push(a[2] + (b[2] - a[2]) * t);
    }
    return [...positions, ...weights];
  }

  /** The relaxation of Newton's step: 1 plus a breathing imaginary twist that swirls the rake. */
  #gardenRelax(): [number, number] {
    return [
      1,
      GARDEN_TWIST *
        this.#knobs.breath *
        Math.sin((this.#breathClock * TAU) / GARDEN_BREATH_PERIOD),
    ];
  }

  #advanceMark(real: number): void {
    const target = this.#knobs.mark > 0 || this.#time < this.#summonedUntil ? 1 : 0;
    if (real > 0)
      this.#markStrength +=
        Math.sign(target - this.#markStrength) *
        Math.min(Math.abs(target - this.#markStrength), real / MARK_FADE);
  }

  /**
   * The camera's depth, its smear and the iterations' share, from how far in and out the scene is.
   * The picture is smeared like any moving one, but never over more than the way it has come from
   * its place at rest (leaving) or has still to go to it (entering): the smear sets in and clears
   * with the camera's travel instead of all at once as the speed leaves or reaches 0.
   */
  #advancePassage(passage: Readonly<ScenePassageProgress>): void {
    const reach = PASSAGE_REACH[this.#incoming.mode] ?? PASSAGE_NONE;
    const entered = clamp(passage.enter, 0, 1);
    const left = clamp(passage.exit, 0, 1);
    const coming = 1 - entered;
    this.#depth =
      reach.enter * Math.pow(coming, PASSAGE_ENTER_CURVE) +
      reach.exit * Math.pow(left, PASSAGE_EXIT_CURVE);
    let rate = 0;
    if (coming > 0)
      rate +=
        (reach.enter * PASSAGE_ENTER_CURVE * Math.pow(coming, PASSAGE_ENTER_CURVE - 1)) /
        FRACTAL_PASSAGE.enter;
    if (left > 0)
      rate +=
        (reach.exit * PASSAGE_EXIT_CURVE * Math.pow(left, PASSAGE_EXIT_CURVE - 1)) /
        FRACTAL_PASSAGE.exit;
    this.#smearRate = Math.min(rate, -Math.expm1(-this.#depth) / FRACTAL_SMEAR);
    this.#iterShare =
      coming > 0 ? reach.floor + (1 - reach.floor) * smoothstep(PASSAGE_ITER_FROM, 1, entered) : 1;
  }

  /** An iteration count with the passage's share of it (itself at rest). */
  #iterations(count: number): number {
    return this.#iterShare < 1
      ? Math.max(PASSAGE_MIN_ITERATIONS, Math.round(count * this.#iterShare))
      : count;
  }

  /**
   * Where the camera falls into and rises from, in content units: a point where the fractal is all
   * fine detail. Julia: the repelling fixed point β = 1 − α, on the set, where it is self-similar.
   * Gasket: the kiss of the two big circles A and B, at (1/2, 1/2) in the band. Garden: the balance
   * of the stones' pulls, where their basins braid. Kept in view: on screen it stands at `at` plus
   * the pan, so that is what is held within the margins.
   */
  #passageFocus(): Complex {
    let at: Complex = [0, 0];
    switch (this.#incoming.mode) {
      case MODE_JULIA: {
        const root = csqrt(sub([1, 0], scale(this.#juliaC(), 4)));
        at = scale(add([1, 0], root), (0.5 * this.#knobs.zoom) / JULIA_REACH);
        break;
      }
      case MODE_GASKET: {
        const map = this.#gasketNow ?? this.#gasketMap();
        const kiss: Complex = [0.5, 0.5];
        at = div(sub(mul(map.d, kiss), map.b), sub(map.a, mul(map.c, kiss)));
        break;
      }
      case MODE_GARDEN:
        at = scale(this.#gardenCentre(this.#gardenStones()), this.#knobs.zoom / GARDEN_REACH);
        break;
      default:
        break;
    }
    if (!Number.isFinite(at[0]) || !Number.isFinite(at[1])) return [0, 0];
    const [panX, panY] = this.#pan.offset;
    const rangeX = PASSAGE_FOCUS_MARGIN * this.#aspect;
    return [
      clamp(at[0] + panX, -rangeX, rangeX) - panX,
      clamp(at[1] + panY, -PASSAGE_FOCUS_MARGIN, PASSAGE_FOCUS_MARGIN) - panY,
    ];
  }

  #write(): void {
    const data = this.#data;
    data.fill(0);
    const knobs = this.#knobs;
    const outgoing = this.#outgoing;

    // The wipe's front: from the incoming dive's focus (or the centre) out past the farthest corner.
    let centre: Complex = [0, 0];
    if (this.#wipe && this.#incoming.mode === MODE_DIVE)
      centre = this.#diveFocus(this.#incoming.site);
    const soft = this.#wipe === "loop" ? LOOP_SOFT : SWAP_SOFT;
    let reach = 0;
    for (const corner of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      reach = Math.max(
        reach,
        Math.hypot(
          corner[0] * this.#aspect - this.#pan.offset[0] - centre[0],
          corner[1] - this.#pan.offset[1] - centre[1],
        ),
      );
    }
    // Margins of a softness either side keep the wobbling front clear of both ends.
    const radius =
      outgoing && this.#wipe ? -2 * soft + (reach + 4 * soft) * this.#wipeProgress : 1e4;
    data.set([centre[0], centre[1], radius, soft], 0);
    // The dive leans a little toward a hovering pointer: parallax, as if looking past its edge.
    const lean: Complex =
      this.#incoming.mode === MODE_DIVE ? scale(this.#nudge, DIVE_NUDGE) : [0, 0];
    data.set(
      [
        this.#pan.offset[0] + lean[0],
        this.#pan.offset[1] + lean[1],
        this.#markStrength,
        knobs.mark > 0 ? knobs.mark : 0.5,
      ],
      4,
    );
    if (this.#depth > 0 && this.#incoming.mode !== MODE_DIVE) {
      const fall = this.#passageFocus();
      data.set([Math.exp(-this.#depth), fall[0], fall[1], this.#smearRate], 8);
    }

    this.#writeLayer(this.#incoming, FRACTAL_GLOBAL_TEXELS);
    if (outgoing) this.#writeLayer(outgoing, FRACTAL_GLOBAL_TEXELS + FRACTAL_LAYER_TEXELS);
  }

  /** Iterations for the escape-time modes: more for finer detail and taller screens. */
  #budget(base: number, span: number): number {
    const tall = Math.min(1.25, Math.max(0.8, 0.8 + 0.2 * (this.#height / 540)));
    return (base + span * this.#knobs.detail) * tall;
  }

  #writeLayer(layer: Layer, texel: number): void {
    const at = texel * 4;
    switch (layer.mode) {
      case MODE_JULIA:
        this.#writeJulia(at);
        return;
      case MODE_DIVE:
        this.#writeDive(at, layer);
        return;
      case MODE_GASKET:
        this.#writeGasket(at);
        return;
      case MODE_GARDEN:
        this.#writeGarden(at);
        return;
      default:
        return;
    }
  }

  /**
   * +1 c, dc/dt; +2 the fixed point α and its multiplier μ; +3 Koenigs grid strength (fades as
   * |μ| nears 1, where the interior converges too slowly to resolve).
   */
  #writeJulia(at: number): void {
    const data = this.#data;
    const knobs = this.#knobs;
    const c = this.#juliaC();
    const velocity = this.#juliaRate.value;
    const alpha = scale(sub([1, 0], csqrt(sub([1, 0], scale(c, 4)))), 0.5);
    const mu = scale(alpha, 2);
    const iterations = this.#iterations(
      Math.min(128, Math.max(32, Math.round(this.#budget(44, 84)))),
    );
    // The rings round the set need no sway of their own: they follow c as it breathes.
    data.set([MODE_JULIA, iterations, 0, JULIA_REACH / knobs.zoom], at);
    data.set([c[0], c[1], velocity[0] ?? 0, velocity[1] ?? 0], at + 4);
    data.set([alpha[0], alpha[1], mu[0], mu[1]], at + 8);
    data.set([smoothstep(0.985, 0.94, Math.hypot(mu[0], mu[1])), 0, 0, 0], at + 12);
    // Pearls and lace round the critical point 0: one in the heart of every chamber.
    data.set([0, 0, 0.08, 0.12], at + 40);
    data.set([0.85, 0.85, 0.2 + 0.3 * this.#markSize(), 0], at + 44);
  }

  /**
   * +1 the nucleus c0 (the perturbation's reference) and δc at the centre; +2 δc per content unit
   * and σ (the island's scale, for testing its cardioid); +3 the zoom's focus on screen, the
   * island's slope |dz_p/dc| and period (pearls shrink by the slope per period, as the island does).
   * δc = (z* − c0) + σ^s (start − z* + h·q): the view at phase s is the start view carried s of
   * the way along the spiral similarity c ↦ z* + σ (c − z*).
   */
  #writeDive(at: number, layer: Layer): void {
    const data = this.#data;
    const dive = DIVE_SITES[layer.site] ?? DIVE_SITES[0];
    if (!dive) return;
    const s = layer.phase;
    // The passage runs the loop's phase deeper than usual (a stretch of the dive's own zoom).
    const deeper = this.#incoming.mode === MODE_DIVE ? 1 / -dive.logScale[0] : 0;
    const power = polar(
      Math.exp((s + this.#depth * deeper) * dive.logScale[0]),
      (s + this.#depth * deeper) * dive.logScale[1],
    );
    const height = dive.height / this.#knobs.zoom;
    const centre = add(sub(dive.focus, dive.nucleus), mul(power, sub(dive.start, dive.focus)));
    const step = scale(power, height);
    const focus = this.#diveFocus(layer.site);
    const iterations = this.#iterations(
      Math.min(
        128,
        Math.max(32, Math.round(this.#budget(22, 14) * Math.pow(dive.period, Math.max(0, s)))),
      ),
    );
    // The zoom's speed in e-folds (and turns) per second of the scene clock, for softening moving detail.
    const speed =
      this.#diveRate(layer.site) *
        Math.hypot(dive.logScale[0], dive.logScale[1]) *
        this.#motion *
        this.#knobs.pace +
      this.#smearRate * deeper * Math.hypot(dive.logScale[0], dive.logScale[1]);
    data.set([MODE_DIVE, iterations, 0, speed], at);
    data.set([dive.nucleus[0], dive.nucleus[1], centre[0], centre[1]], at + 4);
    data.set([step[0], step[1], dive.scale[0], dive.scale[1]], at + 8);
    data.set([focus[0], focus[1], dive.slope, dive.period], at + 12);
    // Pearls round the critical point: the nucleus of every bulb and island (z_p = 0 there).
    data.set([0, 0, 0.07, 0.1], at + 40);
    data.set([0.55, 0.95, 0.24 + 0.36 * this.#markSize(), 0], at + 44);
  }

  #diveFocus(site: number): Complex {
    const dive = DIVE_SITES[site] ?? DIVE_SITES[0];
    if (!dive) return [0, 0];
    return scale(sub(dive.focus, dive.start), this.#knobs.zoom / dive.height);
  }

  /** +1 a, b; +2 c, d (content units to band coordinates); +3, +4 the flow on screen v(p) = α + βp + γp². */
  #writeGasket(at: number): void {
    const data = this.#data;
    const map = this.#gasketNow ?? this.#gasketMap();
    const rate = this.#gasketRate.value;
    const dot = (i: number): Complex => [rate[i] ?? 0, rate[i + 1] ?? 0];
    const [da, db, dc, dd] = [dot(0), dot(2), dot(4), dot(6)];
    // A feature fixed in the band sits where T_t(p) stays put: ṗ = −∂T/∂t / T'(p), which for
    // ad − bc = 1 is the quadratic (ȧc − aċ)p² + (ȧd + ḃc − aḋ − bċ)p + (ḃd − bḋ), up to sign.
    const gamma = sub(mul(da, map.c), mul(map.a, dc));
    const beta = sub(add(mul(da, map.d), mul(db, map.c)), add(mul(map.a, dd), mul(map.b, dc)));
    const alpha = sub(mul(db, map.d), mul(map.b, dd));
    const iterations = this.#iterations(
      Math.min(64, Math.max(24, Math.round(this.#budget(30, 34)))),
    );
    // The growth rings swell and ebb a little with the breath; +4 z carries how fast (rings per second).
    const breath = (this.#breathClock * TAU) / GASKET_BREATH_PERIOD;
    const rings =
      (0.15 * TAU * this.#motion * this.#knobs.pace * Math.cos(breath)) / GASKET_BREATH_PERIOD;
    data.set([MODE_GASKET, iterations, 0.15 * Math.sin(breath), 0], at);
    data.set([map.a[0], map.a[1], map.b[0], map.b[1]], at + 4);
    data.set([map.c[0], map.c[1], map.d[0], map.d[1]], at + 8);
    data.set([alpha[0], alpha[1], beta[0], beta[1]], at + 12);
    data.set([gamma[0], gamma[1], rings, 0], at + 16);
    data.set([0, 0, 0, 0], at + 40);
    data.set([0, 0, 0.16 + 0.12 * this.#markSize(), 0], at + 44);
  }

  /**
   * +1..+3 roots (x, y) for the five stones and the pebble; +4, +5 their weights and the
   * relaxation a (Newton's step is a/Σ w/(z − r)); +6..+8 the stones' velocities and da/dt.
   */
  #writeGarden(at: number): void {
    const data = this.#data;
    const knobs = this.#knobs;
    const stones = this.#gardenStones();
    const rate = this.#gardenRate.value;
    const relax = this.#gardenRelax();
    const weights = stones.slice(GARDEN_STONES * 2);
    data.set(
      [
        MODE_GARDEN,
        this.#iterations(Math.min(40, Math.max(18, Math.round(this.#budget(20, 16))))),
        this.#rake,
        GARDEN_REACH / knobs.zoom,
      ],
      at,
    );
    data.set([...stones.slice(0, GARDEN_STONES * 2), this.#pebble[0], this.#pebble[1]], at + 4);
    data.set([...weights, this.#pebbleWeight, relax[0], relax[1]], at + 16);
    data.set([...rate.slice(0, GARDEN_STONES * 2), rate[10] ?? 0, rate[11] ?? 0], at + 24);
    // The raked rings drift outward: bands of the step count per second.
    data.set([(this.#motion * knobs.pace) / GARDEN_RAKE, 0, 0, 0], at + 36);
    // Pearls gather where the stones' pulls balance: round their weighted centre.
    const centre = this.#gardenCentre(stones);
    data.set([centre[0], centre[1], 0.06, 0.1], at + 40);
    const first: Complex = [stones[0] ?? 0, stones[1] ?? 0];
    data.set([first[0] + 0.3, first[1] + 0.22, 0.12 + 0.12 * this.#markSize(), 0], at + 44);
  }

  /** The stones' centre of weight (z units): where their pulls balance. */
  #gardenCentre(stones: readonly number[]): Complex {
    let cx = 0;
    let cy = 0;
    let total = 0;
    for (let k = 0; k < GARDEN_STONES; k++) {
      const w = stones[GARDEN_STONES * 2 + k] ?? 0;
      cx += (stones[2 * k] ?? 0) * w;
      cy += (stones[2 * k + 1] ?? 0) * w;
      total += w;
    }
    return total > 0 ? [cx / total, cy / total] : [0, 0];
  }

  /** The M's size knob, or its middle when a 'now' summoned it with the feature off. */
  #markSize(): number {
    return this.#knobs.mark > 0 ? this.#knobs.mark : 0.5;
  }
}

/** The fractal scene's motion for a scene whose knobs are `params` (looked up by key). */
export function fractalSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new FractalSim(gl, params);
}
