// Chladni figures: sand on a metal plate driven at a tone, gathering on the lines where the plate
// stands still (E. F. F. Chladni, "Entdeckungen über die Theorie des Klanges", 1787).
//
// The plate. Driven at one of its resonances, a free plate vibrates as a standing wave u(x, y);
// sand is thrown about where it swings and comes to rest on the nodal lines, where u = 0. The modes
// are taken in closed form, as is usual for drawing them:
//   square  cos(nπa)cos(mπb) ± cos(mπa)cos(nπb), a and b running 0..1 across the plate: the sum
//           or difference of a degenerate pair, which gives Chladni's classic figures
//   round   J_n(αr)cos(n(θ − turn)), α a root of J_n' so the free rim swings, mostly as pairs of
//           modes of nearby pitch (rings with petals), as real round plates mix them. Each is lifted
//           by (1 + (αr)²)^¼ so the outer rings swing as hard as the inner ones (J_n fades as 1/√r).
//   M       the Manifold landmark: a 'mode' still along the M's strokes and swinging harder the
//           further from them, u = d / (d + MARK_REACH) + MARK_SLOPE·d, d the distance to the
//           nearest stroke (the short inner strokes pull from further: MARK_PULL)
// Each figure is sampled once onto a MODE_NODES² grid over the plate and scaled to RMS 0.5 on it.
// The tone sweeps up through the shape's figures and back down. Between two figures the field is
// crossfaded, u = norm·((1 − s)·u_from + s·u_to), so the nodal lines slide and reconnect and the
// sand follows them; norm keeps the plate's overall swing steady through the mix.
//
// The sand. Every grain has its own threshold θ (grains differ in size and grip): it only moves
// while the plate's local swing A|u| exceeds it, so it comes to rest a little way off the nodal
// line, on its own contour |u| = θ/A. That gives the lines their width (wider where the plate's
// slope is gentle) and settled sand that holds perfectly still. While it moves, a grain drifts down
// the slope of |u| (sand is thrown further where the plate swings harder) at a pace that eases with
// the excess A|u| − θ and never overshoots its contour, and it dances: a smooth random walk
// (Ornstein–Uhlenbeck) of the same strength. The plate is driven through a bolt at its centre,
// which swings hardest of all, so no sand rests on the hub. Carried from figure to figure, the sand
// would drift into ever fewer, heavier lines: each move between figures lifts a share of the grains
// off the deepest heaps and lets them fall anywhere on the plate again (most on the way to the M,
// whose few strokes must be fed evenly to read).
//
// The grain (sims/granular.ts, the grainSize knob): dry sand at the knob's middle, finer or coarser
// either side. Finer grains have less grip (θ scaled by the grain's grip, spread by its exponent:
// they settle closer to the line, in a tight core) and are held back by the air (the drift by its
// pace) and thrown less far (the dance by its hop); grit grips more, spreads into a halo, and is
// thrown further and faster. A new grain is a new batch: it is strewn over the plate again and
// sung into the figure. The shader raises the ridges by the grain's angle of repose (uSim2).
//
// Clicking pours a pinch of sand at the pointer and dragging pours a trail; the grains are taken up
// at random from the plate, so the amount of sand stays as set. The grains are splatted into a
// density field (cloud-in-cell) and uploaded only when something moved: settled sand costs nothing.
//
// The passage. A sim built while the scene comes in plays its entrance in place of settling the
// opening figure: sand is poured evenly over the still plate (grains land in a front sweeping down
// the slope), then the plate begins to sing, its swing swelling to the knob's, and the sand runs
// into the figure's lines at a boosted pace that eases back to 1 as the entrance ends. On the way
// out the plate stops singing and tilts, and the sand slips (downhill first) and slides off its
// low edge. Neither touches the sim's random draws; at rest every passage term is exactly neutral.
//
// Textures (plate units: the plate spans [-1, 1] on both axes, the round plate is the unit disc, y up):
//   uSim0  rg16f CHLADNI_SAND_TEXELS² over the plate's square: R grains at rest per texel, G grains
//          on the move, eased over SHOWN_MEMORY seconds so passing grains never flicker.
//   uSim1  rg16f MODE_NODES² over the same square: R the figure the plate comes from, G the one it
//          goes to (each at RMS 0.5).
//   uSim2  rgba16f 2×1, nearest. Texel 0: eased crossfade s, norm, swing A, share of the M in the field.
//          Texel 1: the passage: the strewn veil (0 at rest), the plate's tilt, the veil's gain; and
//          the grain's relief, its angle of repose's tangent over dry sand's (1 for dry sand).
import { KnobReader, type ParamDef } from "../../params.ts";
import { markVertex, segmentDistance } from "../../mark.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { grainAt, SAND, type Grain } from "../../sims/granular.ts";
import { clamp, hash31, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

const TAU = Math.PI * 2;

/** The `grains` choice. */
export const CHLADNI_GRAINS = [15000, 25000, 40000] as const;
const MAX_GRAINS = Math.max(...CHLADNI_GRAINS);

/**
 * The plate's half-size in screen heights, and at most this share of the screen's half-width (a
 * portrait screen still shows all of it). The shader sizes the plate the same way.
 */
export const CHLADNI_PLATE = 0.42;
export const CHLADNI_PLATE_FIT = 0.9;
/**
 * The M's centre height and its height, plate units: set a little low, so the hub sits in the
 * notch above its V, clear of the strokes (whose sand the hub would otherwise shake loose).
 */
export const CHLADNI_MARK_Y = -0.15;
export const CHLADNI_MARK_SIZE = 1.15;
/** Radius of the hub (the bolt and washer the plate is driven through), plate units. */
export const CHLADNI_HUB = 0.065;
/** Texels per side of the sand field over the plate's square: about 1.8 dither cells each. */
export const CHLADNI_SAND_TEXELS = 256;
/** Nodes per side of the grid each figure is sampled onto (the finest figure has ~12 per half-wave). */
const MODE_NODES = 192;
const MODE_SIZE = MODE_NODES * MODE_NODES;

// The sand.
/**
 * Grains' thresholds θ = THRESHOLD_MAX·grip·r^spread (r uniform, grip and spread the grain's; dry
 * sand's spread is 3): most rest close to the line (a tight core), a sparse few well off it (a halo
 * of loose grains).
 */
const THRESHOLD_MAX = 0.22;
/** The plate's swing A at vibration 0 and 1 (geometric in between, 1 at the middle). */
const SWING_GENTLE = 0.55;
const SWING_HARD = 1.8;
/** Drift down the slope of |u| for dry sand (× the grain's pace): plate units per second at full excess, and the excess that gets half of it. */
const DRIFT = 0.09;
const DRIFT_EASE = 0.15;
/** Slope of A|u| (per plate unit) under which the drift fades: on a crest a grain has no way down. */
const DRIFT_FLAT = 0.2;
/** A step covers at most this share of the (linearised) way to the grain's contour: no overshoot. */
const DRIFT_REACH = 0.5;
/** The dance for dry sand (× the grain's hop): speed (plate units per second at excess 1) and memory (s) of the smooth random walk. */
const DANCE = 0.03;
const DANCE_MEMORY = 0.4;
/** Excess under which a grain comes to rest, and at which it counts as fully on the move (G channel). */
const REST = 0.004;
const AIRBORNE = 0.08;
/** The hub: its extra swing (times A) and the radius it falls off over, plate units. */
const DRIVE = 0.5;
const DRIVE_RADIUS = CHLADNI_HUB * 1.15;
/** Grains keep this far inside the rim. */
const RIM = 0.985;
/** Longest simulated step (s); a frame takes as many as its time needs. */
const MAX_STEP = 0.05;
/**
 * Memory (s) of the sand field as shown: it eases toward where the grains are, so the count of
 * grains passing through a texel never flickers from one frame to the next.
 */
const SHOWN_MEMORY = 0.8;
/**
 * Share of the grains each move between figures lifts off the deepest heaps (at least SHED_HEAP
 * grains per texel, found in SHED_DRAWS tries) and lets fall again anywhere on the plate.
 */
const SHED = 0.12;
const SHED_HEAP = 4;
const SHED_DRAWS = 4;
/** The same on the way into the M, much more: its strokes are few and far apart, and must be fed evenly. */
const MARK_SHED = 0.6;

// The sweep.
/** The figure seed 0 opens on (a ring on a cross, or eight spokes and a ring); other seeds count on from it. */
const FIRST_FIGURE = 5;
/**
 * Seconds a figure holds, and seconds of crossfade into the next, at mode sweep 0 and 1. The lines
 * slide at the pace of the crossfade, so a long one keeps them calm under the dither.
 */
const HOLD_SLOW = 48;
const HOLD_FAST = 6;
const MOVE_SLOW = 18;
const MOVE_FAST = 7;
/** After a "now" (or a new plate) the sand runs at full pace, even with motion off, for the move and this long after. */
const URGENT_SETTLE = 4;
/** After a new grain is strewn the sand runs at full pace, even with motion off, this long: about as long as it takes to gather. */
const REGRAIN_SETTLE = 10;
/** Figures between two Ms at frequency 0 and 1. */
const MARK_RARE = 8;
const MARK_OFTEN = 2;
/**
 * The M's 'mode', u = d / (d + MARK_REACH) + MARK_SLOPE·d: still on the strokes, steep beside them
 * (lines as fine as a figure's), and still sloping far from them so the sand comes in from the corners.
 */
const MARK_REACH = 0.08;
const MARK_SLOPE = 1;

// Settling the first figure before it is shown.
/** Step (s), most steps, time cap (ms), and the share of grains still moving that counts as settled. */
const PREWARM_STEP = 0.4;
const PREWARM_STEPS = 28;
const PREWARM_MS = 120;
const PREWARM_DONE = 0.004;

// Pouring.
/** A click pours a pinch of PINCH grains this wide (plate units); a drag pours per plate unit travelled and per second held. */
const PINCH = 420;
const PINCH_RADIUS = 0.05;
const POUR_PER_UNIT = 5000;
const POUR_PER_SECOND = 700;
const POUR_RADIUS = 0.03;

// The scene's passage (index.ts `passage`).
/** Seconds the entrance and the exit take. */
export const CHLADNI_ENTER = 3;
export const CHLADNI_EXIT = 1.6;
/**
 * The entrance, in seconds: sand is poured over the still plate in a front sweeping down the slope
 * (POUR_FRONT of a grain's landing time follows the front, the rest is its own), then the plate
 * begins to sing and its swing swells to full, and the sand runs into the lines at ARRIVE_PACE
 * times its pace, easing back to 1 as the entrance ends. The sparse strewn sand is drawn as
 * single grains (the shader's veil) until it has gathered, VEIL_FROM..VEIL_TO.
 */
const POUR_FROM = 0.4;
const POUR_SPAN = 0.9;
const POUR_FRONT = 0.8;
const SING_FROM = 1.15;
const SING_TO = 2.1;
const ARRIVE_PACE = 3.5;
const VEIL_FROM = 2;
const VEIL_TO = 2.9;
/**
 * The exit: the plate stops singing and tilts down toward SLIDE (a unit vector, plate units) and
 * the sand lets go: a grain slips from SLIP_FROM + SLIP_SPAN·(its slot on the slope, mostly: the
 * downhill sand first, then a little by its own grip), then slides at SLIDE_ACCEL (plate units
 * per s²) off the plate's edge. SLIDE_SPAN is the plate's longest reach along SLIDE.
 */
const SLIDE_X = 0.3827;
const SLIDE_Y = -0.9239;
const SLIDE_SPAN = 1.31;
const SLIDE_ACCEL = 5;
const SLIP_FROM = 0.1;
const SLIP_SPAN = 0.4;
const SLIP_ROW = 0.7;
/** Memory (s) of the sand field as shown while it comes and goes: closer to the grains than SHOWN_MEMORY. */
const PASSAGE_MEMORY = 0.3;
/** The grain count the shader's veil is tuned for; it is scaled for other counts. */
const STREW_REFERENCE = 25000;

/** Each stroke's pull on the sand in the M's 'mode' (its distance is scaled by this): the leg, the inner strokes, the leg. */
const MARK_PULL = [1, 0.6, 0.6, 1] as const;

/** Roots of J_n' (n = 0..8): the free round plate's radial wavenumbers. */
const ROOTS: readonly (readonly number[])[] = [
  [3.8317, 7.0156, 10.1735, 13.3237, 16.4706],
  [1.8412, 5.3314, 8.5363, 11.706, 14.8636],
  [3.0542, 6.7061, 9.9695, 13.1704, 16.3475],
  [4.2012, 8.0152, 11.3459, 14.5858, 17.7887],
  [5.3176, 9.2824, 12.6819, 15.9641, 19.196],
  [6.4156, 10.5199, 13.9872, 17.3128, 20.5755],
  [7.5013, 11.7349, 15.2682, 18.6374, 21.9317],
  [8.5778, 12.9324, 16.5294, 19.9419, 23.2681],
  [9.6474, 14.1155, 17.774, 21.2291, 24.5872],
];

/** cos(nπa)cos(mπb) + sign·cos(mπa)cos(nπb), a and b running 0..1 across the plate. */
interface SquareFigure {
  kind: "square";
  n: number;
  m: number;
  sign: 1 | -1;
}

/** One round mode, J_n(αr)cos(nθ), with its share of the figure. */
interface RoundTerm {
  n: number;
  alpha: number;
  weight: number;
}

interface RoundFigure {
  kind: "round";
  terms: readonly RoundTerm[];
}

interface MarkFigure {
  kind: "mark";
}

type Figure = SquareFigure | RoundFigure | MarkFigure;

/** A round term of the given weight on the `s`-th root of J_n'. */
function wave(n: number, s: number, weight: number): RoundTerm {
  const alpha = ROOTS[n]?.[s];
  if (alpha === undefined) throw new Error(`chladni: no root ${s} of J${n}'`);
  return { n, alpha, weight };
}

/** The square plate's figures, rising in pitch (n² + m²). */
const SQUARE_FIGURES: readonly SquareFigure[] = [
  { kind: "square", n: 2, m: 0, sign: 1 }, // a diamond
  { kind: "square", n: 3, m: 1, sign: -1 }, // an eight-pointed star
  { kind: "square", n: 3, m: 1, sign: 1 }, // a cross between four arcs
  { kind: "square", n: 4, m: 1, sign: 1 }, // a cross and loose curls
  { kind: "square", n: 4, m: 2, sign: 1 }, // a ring in a diamond
  { kind: "square", n: 5, m: 3, sign: 1 }, // a ring on a cross
  { kind: "square", n: 5, m: 3, sign: -1 }, // a star among arcs
  { kind: "square", n: 6, m: 2, sign: 1 }, // a ring in a lattice
  { kind: "square", n: 6, m: 4, sign: 1 }, // a four-petalled flower in a diamond
  { kind: "square", n: 7, m: 5, sign: -1 }, // a star in lace
  { kind: "square", n: 8, m: 6, sign: 1 }, // flowers in flowers
  { kind: "square", n: 9, m: 7, sign: 1 }, // a fine rose window
];

/** The round plate's figures, rising in pitch: rings with petals, spokes, and a few free curls. */
const ROUND_FIGURES: readonly RoundFigure[] = [
  { kind: "round", terms: [wave(0, 0, 1), wave(3, 0, 0.8)] }, // a rounded triangle
  { kind: "round", terms: [wave(0, 0, 1), wave(4, 0, 0.8)] }, // a cushion
  { kind: "round", terms: [wave(4, 0, 1), wave(1, 1, 0.8)] }, // curls
  { kind: "round", terms: [wave(0, 1, 1), wave(3, 1, 0.8)] }, // a triangle in a ring
  { kind: "round", terms: [wave(0, 1, 1), wave(6, 0, 0.8)] }, // a six-pointed star round a ring
  { kind: "round", terms: [wave(4, 1, 1)] }, // eight spokes and a ring
  { kind: "round", terms: [wave(0, 2, 1), wave(5, 1, 0.8)] }, // a five-petalled flower
  { kind: "round", terms: [wave(6, 1, 1), wave(4, 2, 0.8)] }, // loops and curls
  { kind: "round", terms: [wave(0, 3, 1), wave(5, 2, 0.8)] }, // nested pentagons
  { kind: "round", terms: [wave(0, 3, 1), wave(8, 1, 0.8)] }, // an eight-petalled rosette
  { kind: "round", terms: [wave(0, 4, 1), wave(4, 3, 0.8)] }, // nested cushions
  { kind: "round", terms: [wave(0, 4, 1), wave(7, 2, 0.8)] }, // a seven-petalled rosette
];

const MARK: MarkFigure = { kind: "mark" };

// ---- figures -------------------------------------------------------------------------------------

/** Samples of the Bessel integral below; enough for x up to ~60 at double precision. */
const BESSEL_SAMPLES = 128;
const BESSEL_SIN = Float64Array.from({ length: BESSEL_SAMPLES }, (_, k) =>
  Math.sin((k / BESSEL_SAMPLES) * TAU),
);

/**
 * J_n(x) = (1/2π)∫ cos(nτ − x sin τ) dτ over a full turn (Bessel's integral). The trapezoid rule
 * converges geometrically on a smooth periodic integrand, so evenly spaced samples are exact enough.
 */
function besselJ(n: number, x: number): number {
  let sum = 0;
  for (let k = 0; k < BESSEL_SAMPLES; k++)
    sum += Math.cos(n * (k / BESSEL_SAMPLES) * TAU - x * (BESSEL_SIN[k] ?? 0));
  return sum / BESSEL_SAMPLES;
}

/** Radial samples of a round term, out to the plate square's corners. */
const RADIAL_SAMPLES = 512;
const RADIAL_SPAN = 1.5;

/** Plate coordinate of grid node i. */
const node = (i: number): number => (2 * i) / (MODE_NODES - 1) - 1;

/** Each grid node's radius and bearing on the plate, worked out once for the round figures. */
const NODE_RADIUS = new Float32Array(MODE_SIZE);
const NODE_BEARING = new Float32Array(MODE_SIZE);
for (let j = 0; j < MODE_NODES; j++) {
  for (let i = 0; i < MODE_NODES; i++) {
    NODE_RADIUS[j * MODE_NODES + i] = Math.hypot(node(i), node(j));
    NODE_BEARING[j * MODE_NODES + i] = Math.atan2(node(j), node(i));
  }
}

/**
 * Distance from (x, y) to the M's strokes in mark units, as markDistance in mark.ts but with each
 * stroke's distance scaled by its MARK_PULL: the short inner strokes draw sand from further, or the
 * legs would take nearly all of it.
 */
function pulledMarkDistance(x: number, y: number): number {
  let best = Infinity;
  for (let k = 0; k < 4; k++) {
    const a = markVertex(k);
    const b = markVertex(k + 1);
    best = Math.min(best, segmentDistance(x, y, a[0], a[1], b[0], b[1]) * (MARK_PULL[k] ?? 1));
  }
  return best;
}

function fillSquare(out: Float32Array, figure: SquareFigure): void {
  const cn = new Float64Array(MODE_NODES);
  const cm = new Float64Array(MODE_NODES);
  for (let i = 0; i < MODE_NODES; i++) {
    const a = i / (MODE_NODES - 1);
    cn[i] = Math.cos(figure.n * Math.PI * a);
    cm[i] = Math.cos(figure.m * Math.PI * a);
  }
  for (let j = 0; j < MODE_NODES; j++) {
    const nj = cn[j] ?? 0;
    const mj = cm[j] ?? 0;
    for (let i = 0; i < MODE_NODES; i++)
      out[j * MODE_NODES + i] = (cn[i] ?? 0) * mj + figure.sign * (cm[i] ?? 0) * nj;
  }
}

/** Each round term's radial profile, weight included: the terms are fixed, so they are worked out once. */
const radialTables = new Map<RoundTerm, Float64Array>();

function radialTable(term: RoundTerm): Float64Array {
  const known = radialTables.get(term);
  if (known !== undefined) return known;
  const table = new Float64Array(RADIAL_SAMPLES + 2);
  for (let k = 0; k < table.length; k++) {
    const ar = (term.alpha * k * RADIAL_SPAN) / RADIAL_SAMPLES;
    table[k] = term.weight * besselJ(term.n, ar) * Math.pow(1 + ar * ar, 0.25);
  }
  radialTables.set(term, table);
  return table;
}

function fillRound(out: Float32Array, figure: RoundFigure, turn: number): void {
  out.fill(0);
  for (const term of figure.terms) {
    const table = radialTable(term);
    for (let k = 0; k < MODE_SIZE; k++) {
      const at = ((NODE_RADIUS[k] ?? 0) / RADIAL_SPAN) * RADIAL_SAMPLES;
      const r = Math.floor(at);
      const f = at - r;
      const radial = (table[r] ?? 0) * (1 - f) + (table[r + 1] ?? 0) * f;
      out[k] = (out[k] ?? 0) + radial * Math.cos(term.n * ((NODE_BEARING[k] ?? 0) - turn));
    }
  }
}

function fillMark(out: Float32Array): void {
  for (let j = 0; j < MODE_NODES; j++) {
    const y = (node(j) - CHLADNI_MARK_Y) / CHLADNI_MARK_SIZE;
    for (let i = 0; i < MODE_NODES; i++) {
      const d = pulledMarkDistance(node(i) / CHLADNI_MARK_SIZE, y) * CHLADNI_MARK_SIZE;
      out[j * MODE_NODES + i] = d / (d + MARK_REACH) + MARK_SLOPE * d;
    }
  }
}

/** Mean of a·b over the grid nodes on the plate (the round plate leaves out its square's corners). */
function plateMean(a: Float32Array, b: Float32Array, round: boolean): number {
  let sum = 0;
  let count = 0;
  for (let k = 0; k < MODE_SIZE; k++) {
    if (round && (NODE_RADIUS[k] ?? 0) > 1) continue;
    sum += (a[k] ?? 0) * (b[k] ?? 0);
    count++;
  }
  return sum / Math.max(1, count);
}

/** Sample a figure onto the grid, scaled to RMS 0.5 over the plate. `turn` turns a round figure. */
function fillFigure(out: Float32Array, figure: Figure, turn: number, round: boolean): void {
  switch (figure.kind) {
    case "square":
      fillSquare(out, figure);
      break;
    case "round":
      fillRound(out, figure, turn);
      break;
    case "mark":
      fillMark(out);
      break;
    default: {
      const unreachable: never = figure;
      throw new Error(`chladni: unknown figure ${String(unreachable)}`);
    }
  }
  const scale = 0.5 / Math.sqrt(Math.max(1e-9, plateMean(out, out, round)));
  for (let k = 0; k < out.length; k++) out[k] = (out[k] ?? 0) * scale;
}

// ---- the simulation ------------------------------------------------------------------------------

type ChladniKnob = "shape" | "sweep" | "vibration" | "plateSeed" | "grains" | "grainSize" | "mark";

class ChladniSim implements SceneSim {
  readonly #knobs: KnobReader<ChladniKnob>;
  readonly #sweepTrigger: number;
  readonly #markTrigger: number;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #sandTexture: DataTexture;
  readonly #modeTexture: DataTexture;
  readonly #stateTexture: DataTexture;
  /** Where the grains are (rg per texel, see the header), and the field as shown, easing toward it. */
  readonly #sand = new Float32Array(CHLADNI_SAND_TEXELS * CHLADNI_SAND_TEXELS * 2);
  readonly #shown = new Float32Array(CHLADNI_SAND_TEXELS * CHLADNI_SAND_TEXELS * 2);
  readonly #modes = new Float32Array(MODE_SIZE * 2);
  /** Texel 0: crossfade, norm, swing, M share. Texel 1: the strewn veil, the plate's tilt, the veil's gain, the grain's relief. */
  readonly #state = new Float32Array(8);

  // The grains, all MAX_GRAINS laid out (the first #count are on the plate).
  readonly #x = new Float32Array(MAX_GRAINS);
  readonly #y = new Float32Array(MAX_GRAINS);
  readonly #vx = new Float32Array(MAX_GRAINS);
  readonly #vy = new Float32Array(MAX_GRAINS);
  readonly #threshold = new Float32Array(MAX_GRAINS);
  /** Each grain's uniform draw r for its threshold, kept so a new grain size can re-grade the batch. */
  readonly #draw = new Float64Array(MAX_GRAINS);
  /** The grain the plate is strewn with (sims/granular.ts), and the knob it was read at. */
  readonly #grain: Grain = grainAt(0.5);
  #grainSize = Number.NaN;
  /** 0 at rest, up to 1 on the move. */
  readonly #airborne = new Float32Array(MAX_GRAINS);
  #count = 0;

  // The field: the figure the plate comes from and the one it goes to, crossfaded by #mix.
  #from = new Float32Array(MODE_SIZE);
  #to = new Float32Array(MODE_SIZE);
  #fromMark = 0;
  #toMark = 0;
  #moving = false;
  /** Linear progress of the crossfade 0..1; the field uses smoothstep(0, 1, #mix). */
  #mix = 0;
  #norm = 1;
  #correlation = 0;
  #held = 0;
  #holdSeconds = 0;
  #moveSeconds = 0;

  // The sweep through the shape's figures.
  #figures: readonly Figure[] = SQUARE_FIGURES;
  #round = false;
  #index = 0;
  #direction = 1;
  #sinceMark = 0;
  #markQueued = false;
  #markWas = 0;
  #urgent = 0;
  #seed = Number.NaN;

  #amp = 1;
  /** The swing the grains were last stepped at: settled sand is only revisited when the field changes. */
  #steppedAmp = Number.NaN;
  readonly #plan = new Random();
  readonly #hand = new Random();
  /** xorshift32 state for the dance. */
  #noise = 0x2545f491;
  /** Whether a drag is pouring, and where it last poured. */
  #pouring = false;
  #pourX = 0;
  #pourY = 0;
  /** Steps of settling the opening figure done so far (PREWARM_STEPS: finished). */
  #warmed = PREWARM_STEPS;
  #pourDebt = 0;
  #shedDebt = 0;
  #sandDirty = true;
  /** The shown field has not caught up with the grains yet; `#snap` shows them as they are at once. */
  #easing = false;
  #snap = true;
  #modesDirty = true;

  // The scene's passage (see the header). All off, and `#pace` 1, once the entrance is over (or never was).
  #born = false;
  #arriving = false;
  /** Grains are still landing: those whose `#land` time is after `#clock` are not on the plate yet. */
  #landing = false;
  /** Seconds into the entrance. */
  #clock = 0;
  /** The sand's pace and dance, times the plate's own, while it gathers into the first figure. */
  #pace = 1;
  /** Each grain's landing time (s into the entrance). */
  readonly #land = new Float32Array(MAX_GRAINS);
  /** The exit has begun: each grain's place when it did, which it slides from. */
  #sliding = false;
  readonly #homeX = new Float32Array(MAX_GRAINS);
  readonly #homeY = new Float32Array(MAX_GRAINS);

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<ChladniKnob>("chladni", params, [
      "shape",
      "sweep",
      "vibration",
      "plateSeed",
      "grains",
      "grainSize",
      "mark",
    ]);
    this.#sweepTrigger = this.#knobs.trigger("sweep");
    this.#markTrigger = this.#knobs.trigger("mark");
    this.#sandTexture = new DataTexture(gl, {
      width: CHLADNI_SAND_TEXELS,
      height: CHLADNI_SAND_TEXELS,
      format: "rg16f",
    });
    this.#modeTexture = new DataTexture(gl, {
      width: MODE_NODES,
      height: MODE_NODES,
      format: "rg16f",
    });
    this.#stateTexture = new DataTexture(gl, {
      width: 2,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [
      this.#sandTexture.texture,
      this.#modeTexture.texture,
      this.#stateTexture.texture,
    ];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const dt = Math.min(Math.max(Number.isFinite(frame.dt) ? frame.dt : 0, 0), 0.1);
    const knobs = this.#knobs;
    const round = knobs.value(frame, "shape") > 0.5;
    const seed = Math.round(knobs.value(frame, "plateSeed"));
    const count = Math.min(MAX_GRAINS, Math.max(1000, Math.round(knobs.value(frame, "grains"))));
    const sweep = Math.min(1, Math.max(0, knobs.value(frame, "sweep")));
    const mark = knobs.value(frame, "mark");
    const grainSize = clamp(knobs.value(frame, "grainSize"), 0, 1);
    grainAt(grainSize, this.#grain);
    this.#amp =
      SWING_GENTLE *
      Math.pow(
        SWING_HARD / SWING_GENTLE,
        Math.min(1, Math.max(0, knobs.value(frame, "vibration"))),
      );
    this.#holdSeconds = HOLD_SLOW + (HOLD_FAST - HOLD_SLOW) * sweep;
    this.#moveSeconds = MOVE_SLOW + (MOVE_FAST - MOVE_SLOW) * sweep;

    // The scene's passage. Only a sim built while the scene is coming in plays the entrance.
    if (!this.#born) {
      this.#born = true;
      this.#arriving = frame.passage.enter < 1;
    }
    const leaving = frame.passage.exit > 0;
    const exit = clamp(frame.passage.exit, 0, 1);
    if (this.#arriving && !leaving) {
      if (frame.passage.enter >= 1) {
        this.#arriving = false;
        this.#landing = false;
        this.#pace = 1;
      } else {
        const enter = clamp(frame.passage.enter, 0, 1);
        this.#clock = enter * CHLADNI_ENTER;
        // The plate begins to sing, its swing swelling to the knob's.
        this.#amp *= smoothstep(SING_FROM, SING_TO, this.#clock);
        this.#pace = 1 + (ARRIVE_PACE - 1) * (1 - smoothstep(0.8, 1, enter));
        if (this.#clock >= POUR_FROM + POUR_SPAN) this.#landing = false;
      }
    }

    if (seed !== this.#seed) {
      this.#grainSize = grainSize;
      this.#reset(seed, round, count);
    } else {
      if (round !== this.#round) this.#reshape(round);
      if (count !== this.#count) {
        // Grains back on the plate may lie where an earlier figure left them: let them all look again.
        this.#airborne.fill(1, this.#count, count);
        this.#count = count;
        this.#sandDirty = true;
      }
      // A new grain: a fresh batch of it, strewn and sung into the figure.
      if (grainSize !== this.#grainSize && !leaving) this.#regrain(grainSize);
    }
    // Settle a new plate's opening figure in steps; a slow machine takes more frames, not a different picture.
    if (this.#warmed < PREWARM_STEPS) {
      this.#warmed = runBudgeted(() => this.#settle(), PREWARM_MS, PREWARM_STEPS, this.#warmed);
      if (this.#warmed < PREWARM_STEPS) return this.#textures;
    }
    // Switching the M on brings it as the next figure.
    if (mark > 0 && this.#markWas <= 0) this.#markQueued = true;
    this.#markWas = mark;

    if (leaving) {
      this.#slide(exit);
    } else {
      if (frame.fired[this.#markTrigger] === true) this.#moveTo(this.#target(true, mark), true);
      else if (frame.fired[this.#sweepTrigger] === true)
        this.#moveTo(this.#target(false, mark), true);

      this.#pourAt(frame.pointer, dt, frame.aspect);

      // Motion scales the plate; a "now" plays out even while motion is 0, and so does the entrance.
      const span = dt * Math.max(frame.motion, this.#arriving || this.#urgent > 0 ? 1 : 0);
      this.#urgent = Math.max(0, this.#urgent - dt);
      if (span > 0) {
        const steps = Math.ceil(span / MAX_STEP);
        for (let k = 0; k < steps; k++) this.#tick(span / steps, mark);
      }
    }

    if (this.#landing || this.#sliding) this.#sandDirty = true;
    if (this.#sandDirty) {
      this.#splat();
      this.#sandDirty = false;
      this.#easing = true;
    }
    if (this.#easing) {
      const memory = this.#arriving || this.#sliding ? PASSAGE_MEMORY : SHOWN_MEMORY;
      this.#ease(this.#snap || dt <= 0 ? 0 : Math.exp(-dt / memory));
      this.#snap = false;
      this.#sandTexture.upload(this.#shown);
    }
    if (this.#modesDirty) {
      const modes = this.#modes;
      const from = this.#from;
      const to = this.#to;
      for (let k = 0; k < MODE_SIZE; k++) {
        modes[2 * k] = from[k] ?? 0;
        modes[2 * k + 1] = to[k] ?? 0;
      }
      this.#modeTexture.upload(modes);
      this.#modesDirty = false;
    }
    const s = smoothstep(0, 1, this.#mix);
    const state = this.#state;
    state[0] = s;
    state[1] = this.#norm;
    // The plate stops singing as it tilts.
    state[2] = leaving ? this.#amp * (1 - smoothstep(0, 0.25, exit)) : this.#amp;
    state[3] = this.#fromMark * (1 - s) + this.#toMark * s;
    // The strewn veil: the sand drawn as single grains while it is spread thin, and the plate's tilt.
    state[4] = leaving
      ? smoothstep(0, 0.2, exit)
      : this.#arriving
        ? 1 - smoothstep(VEIL_FROM, VEIL_TO, this.#clock)
        : 0;
    state[5] = leaving ? smoothstep(0, 0.7, exit) : 0;
    state[6] = (STREW_REFERENCE / this.#count) * (this.#round ? 4 / Math.PI : 1);
    state[7] = this.#grain.talus / SAND.talus;
    this.#stateTexture.upload(state);
    return this.#textures;
  }

  dispose(): void {
    this.#sandTexture.dispose();
    this.#modeTexture.dispose();
    this.#stateTexture.dispose();
  }

  /** A fresh plate for a new seed: sand strewn evenly, then settled into the sweep's first figure. */
  #reset(seed: number, round: boolean, count: number): void {
    this.#seed = seed;
    this.#round = round;
    this.#figures = round ? ROUND_FIGURES : SQUARE_FIGURES;
    this.#count = count;
    const plan = this.#plan;
    plan.seed(Math.imul(seed + 1, 0x9e3779b1));
    this.#hand.seed(Math.imul(seed + 7, 0x85ebca6b));
    // Odd, so never the xorshift's stuck state 0.
    this.#noise = Math.imul(seed + 3, 0x27d4eb2d) | 1;
    this.#shedDebt = 0;
    for (let i = 0; i < MAX_GRAINS; i++) {
      this.#strewEvenly(i, plan);
      this.#draw[i] = plan.next();
    }
    this.#grade();
    this.#index = (seed + FIRST_FIGURE) % this.#figures.length;
    this.#direction = 1;
    this.#sinceMark = 0;
    this.#markQueued = false;
    this.#urgent = 0;
    fillFigure(this.#from, this.#figures[this.#index] ?? MARK, plan.next() * TAU, round);
    this.#fromMark = 0;
    this.#toMark = 0;
    this.#moving = false;
    this.#mix = 0;
    this.#norm = 1;
    this.#held = 0;
    // Settled in `frame`, in steps (the first figure never depends on the machine's speed).
    this.#steppedAmp = this.#amp;
    this.#warmed = 0;
    this.#sandDirty = true;
    this.#snap = true;
    this.#modesDirty = true;
    if (this.#arriving) this.#beginArrival();
  }

  /** Each grain's threshold from its draw, for the grain the plate is strewn with (see THRESHOLD_MAX). */
  #grade(): void {
    const { grip, spread } = this.#grain;
    for (let i = 0; i < MAX_GRAINS; i++)
      this.#threshold[i] = THRESHOLD_MAX * grip * Math.pow(this.#draw[i] ?? 0, spread);
  }

  /**
   * A new grain size: a fresh batch of that grain, graded anew, strewn evenly over the plate and sung
   * into the figure at full pace even while motion is off.
   */
  #regrain(grainSize: number): void {
    this.#grainSize = grainSize;
    this.#grade();
    for (let i = 0; i < MAX_GRAINS; i++) this.#strewEvenly(i, this.#hand);
    this.#urgent = Math.max(this.#urgent, REGRAIN_SETTLE);
    this.#sandDirty = true;
  }

  /**
   * The entrance, in place of settling the opening figure: the sand lies strewn evenly on the still
   * plate (at rest, so nothing moves until the plate begins to sing) and lands in a front sweeping
   * down the slope, each grain at its own time.
   */
  #beginArrival(): void {
    this.#warmed = PREWARM_STEPS;
    this.#airborne.fill(0);
    this.#landing = true;
    this.#sandDirty = true;
    for (let i = 0; i < MAX_GRAINS; i++) {
      // 0 at the top of the slope, 1 at the foot.
      const row = clamp(
        0.5 + (0.5 * ((this.#x[i] ?? 0) * SLIDE_X + (this.#y[i] ?? 0) * SLIDE_Y)) / SLIDE_SPAN,
        0,
        1,
      );
      this.#land[i] =
        POUR_FROM + POUR_SPAN * (POUR_FRONT * row + (1 - POUR_FRONT) * hash31(i, 0, 0x51ed));
    }
  }

  /**
   * The exit, at progress `exit`: the plate tilts and the sand slides off its low edge (see
   * SLIDE_X). Each grain's place is worked out from where it lay when the exit began.
   */
  #slide(exit: number): void {
    const count = this.#count;
    const xs = this.#x;
    const ys = this.#y;
    const homeX = this.#homeX;
    const homeY = this.#homeY;
    if (!this.#sliding) {
      this.#sliding = true;
      homeX.set(xs);
      homeY.set(ys);
      // The sand slides as one heap, not a cloud: at rest, for the shader.
      this.#airborne.fill(0);
    }
    const now = exit * CHLADNI_EXIT;
    const thresholds = this.#threshold;
    for (let i = 0; i < count; i++) {
      const x0 = homeX[i] ?? 0;
      const y0 = homeY[i] ?? 0;
      // 0 at the foot of the slope (it goes first), 1 at the top.
      const top = 1 - clamp(0.5 + (0.5 * (x0 * SLIDE_X + y0 * SLIDE_Y)) / SLIDE_SPAN, 0, 1);
      const grip = Math.cbrt((thresholds[i] ?? 0) / THRESHOLD_MAX);
      const slid = now - (SLIP_FROM + SLIP_SPAN * (SLIP_ROW * top + (1 - SLIP_ROW) * grip));
      const run = slid > 0 ? 0.5 * SLIDE_ACCEL * slid * slid : 0;
      xs[i] = x0 + SLIDE_X * run;
      ys[i] = y0 + SLIDE_Y * run;
    }
  }

  /** Drop grain i anywhere on the plate, evenly (the round plate's by radius √r so the disc fills evenly). */
  #strewEvenly(i: number, random: Random): void {
    const a = random.next();
    const b = random.next();
    if (this.#round) {
      const r = RIM * Math.sqrt(a);
      this.#x[i] = r * Math.cos(b * TAU);
      this.#y[i] = r * Math.sin(b * TAU);
    } else {
      this.#x[i] = RIM * (2 * a - 1);
      this.#y[i] = RIM * (2 * b - 1);
    }
    this.#vx[i] = 0;
    this.#vy[i] = 0;
    this.#airborne[i] = 1;
  }

  /** Lift a share of the grains off the deepest heaps and let them fall anywhere on the plate (see the header). */
  #shed(dt: number): void {
    this.#shedDebt +=
      (this.#count * (this.#toMark > 0 ? MARK_SHED : SHED) * dt) / this.#moveSeconds;
    const grains = Math.floor(this.#shedDebt);
    this.#shedDebt -= grains;
    const size = CHLADNI_SAND_TEXELS;
    const hand = this.#hand;
    for (let g = 0; g < grains; g++) {
      // A few draws for a grain in a deep heap; if none turns up, nothing is shed.
      for (let draw = 0; draw < SHED_DRAWS; draw++) {
        const i = Math.min(this.#count - 1, Math.floor(hand.next() * this.#count));
        const tx = Math.min(
          size - 1,
          Math.max(0, Math.floor(((this.#x[i] ?? 0) + 1) * 0.5 * size)),
        );
        const ty = Math.min(
          size - 1,
          Math.max(0, Math.floor(((this.#y[i] ?? 0) + 1) * 0.5 * size)),
        );
        const k = (ty * size + tx) * 2;
        if ((this.#sand[k] ?? 0) + (this.#sand[k + 1] ?? 0) < SHED_HEAP) continue;
        this.#strewEvenly(i, hand);
        this.#sandDirty = true;
        break;
      }
    }
  }

  /** One long step of settling the first figure, without the dance: true once nearly every grain rests. */
  #settle(): boolean {
    return this.#advance(PREWARM_STEP, 0, false) <= this.#count * PREWARM_DONE;
  }

  /**
   * The other plate, and sand spread evenly over it again: going round, the sand off the disc is
   * sprinkled back over it; going square, the corners get their share (1 − π/4 of the grains,
   * taken up at random). Then it all flows into the new plate's figure.
   */
  #reshape(round: boolean): void {
    this.#round = round;
    this.#figures = round ? ROUND_FIGURES : SQUARE_FIGURES;
    const hand = this.#hand;
    const corners = 1 - Math.PI / 4;
    for (let i = 0; i < MAX_GRAINS; i++) {
      if (round ? Math.hypot(this.#x[i] ?? 0, this.#y[i] ?? 0) <= RIM : hand.next() >= corners)
        continue;
      let x = 0;
      let y = 0;
      do {
        x = RIM * (2 * hand.next() - 1);
        y = RIM * (2 * hand.next() - 1);
      } while (round ? x * x + y * y > RIM * RIM : x * x + y * y <= 1);
      this.#x[i] = x;
      this.#y[i] = y;
      this.#vx[i] = 0;
      this.#vy[i] = 0;
      this.#airborne[i] = 1;
    }
    this.#index = Math.min(this.#figures.length - 1, this.#index);
    this.#direction = 1;
    this.#moveTo(this.#figures[this.#index] ?? MARK, true);
    this.#sandDirty = true;
  }

  /** The next figure of the sweep (up, then back down), or the M when it is asked for or due. */
  #target(markNow: boolean, mark: number): Figure {
    const every = Math.round(MARK_RARE + (MARK_OFTEN - MARK_RARE) * mark);
    if (markNow || this.#markQueued || (mark > 0 && this.#sinceMark >= every)) {
      this.#markQueued = false;
      this.#sinceMark = 0;
      return MARK;
    }
    const last = this.#figures.length - 1;
    if (this.#index + this.#direction < 0 || this.#index + this.#direction > last)
      this.#direction = -this.#direction;
    this.#index = Math.min(last, Math.max(0, this.#index + this.#direction));
    this.#sinceMark++;
    return this.#figures[this.#index] ?? MARK;
  }

  /** Start the crossfade into a figure; one already under way is frozen where it is and left from there. */
  #moveTo(figure: Figure, urgent: boolean): void {
    if (this.#moving) {
      const s = smoothstep(0, 1, this.#mix);
      const a = (1 - s) * this.#norm;
      const b = s * this.#norm;
      const from = this.#from;
      const to = this.#to;
      for (let k = 0; k < MODE_SIZE; k++) from[k] = a * (from[k] ?? 0) + b * (to[k] ?? 0);
      this.#fromMark = this.#fromMark * (1 - s) + this.#toMark * s;
    }
    // Each visit turns a round figure anew.
    fillFigure(this.#to, figure, this.#plan.next() * TAU, this.#round);
    this.#toMark = figure.kind === "mark" ? 1 : 0;
    this.#correlation = plateMean(this.#from, this.#to, this.#round) / 0.25;
    this.#moving = true;
    this.#mix = 0;
    this.#norm = 1;
    this.#held = 0;
    this.#modesDirty = true;
    if (urgent) this.#urgent = this.#moveSeconds + URGENT_SETTLE;
  }

  /** One step of the sweep and the sand. */
  #tick(dt: number, mark: number): void {
    if (this.#moving) {
      this.#mix = Math.min(1, this.#mix + dt / this.#moveSeconds);
      const s = smoothstep(0, 1, this.#mix);
      // Two figures at RMS 0.5 mix to 0.5·√((1 − s)² + s² + 2s(1 − s)c): lift the mix back to 0.5.
      this.#norm =
        1 /
        Math.sqrt(Math.max(0.05, (1 - s) * (1 - s) + s * s + 2 * s * (1 - s) * this.#correlation));
    } else {
      this.#held += dt;
      if (this.#held >= this.#holdSeconds) this.#moveTo(this.#target(false, mark), false);
    }
    const still = !this.#moving && this.#amp === this.#steppedAmp;
    this.#steppedAmp = this.#amp;
    if (this.#moving) this.#shed(dt);
    if (this.#advance(dt, DANCE * this.#grain.hop * (1 + 0.5 * (this.#pace - 1)), still) > 0)
      this.#sandDirty = true;
    if (this.#moving && this.#mix >= 1) {
      // Arrived: the target becomes the figure the plate holds.
      const from = this.#from;
      this.#from = this.#to;
      this.#to = from;
      this.#fromMark = this.#toMark;
      this.#moving = false;
      this.#mix = 0;
      this.#norm = 1;
      this.#held = 0;
      this.#modesDirty = true;
    }
  }

  /**
   * Step the grains on the plate by dt (see the header); `still` skips grains at rest because the
   * field has not changed since they settled. Returns how many grains moved or came to rest.
   */
  #advance(dt: number, dance: number, still: boolean): number {
    const count = this.#count;
    const xs = this.#x;
    const ys = this.#y;
    const vxs = this.#vx;
    const vys = this.#vy;
    const thresholds = this.#threshold;
    const airborne = this.#airborne;
    const boost = this.#pace;
    const drift = DRIFT * this.#grain.pace;
    const from = this.#from;
    const to = this.#to;
    const s = this.#moving ? smoothstep(0, 1, this.#mix) : 0;
    const blend = s > 0;
    const wFrom = (1 - s) * this.#norm;
    const wTo = s * this.#norm;
    const amp = this.#amp;
    const round = this.#round;
    const scale = (MODE_NODES - 1) / 2;
    const last = MODE_NODES - 2;
    const memory = Math.min(1, dt / DANCE_MEMORY);
    // A uniform draw in [-0.5, 0.5] has variance 1/12: scale it to the walk's unit variance.
    const kick = Math.sqrt(2 * memory * 12);
    const drive = amp * DRIVE;
    const driveFall = 1 / (DRIVE_RADIUS * DRIVE_RADIUS);
    const driveReach = 9 * DRIVE_RADIUS * DRIVE_RADIUS;
    let noise = this.#noise;
    let stirred = 0;
    for (let i = 0; i < count; i++) {
      if (still && airborne[i] === 0) continue;
      let x = xs[i] ?? 0;
      let y = ys[i] ?? 0;
      const fx = (x + 1) * scale;
      const fy = (y + 1) * scale;
      const ix = Math.min(last, Math.max(0, Math.floor(fx)));
      const iy = Math.min(last, Math.max(0, Math.floor(fy)));
      const tx = fx - ix;
      const ty = fy - iy;
      const k = iy * MODE_NODES + ix;
      let u00 = (from[k] ?? 0) * wFrom;
      let u10 = (from[k + 1] ?? 0) * wFrom;
      let u01 = (from[k + MODE_NODES] ?? 0) * wFrom;
      let u11 = (from[k + MODE_NODES + 1] ?? 0) * wFrom;
      if (blend) {
        u00 += (to[k] ?? 0) * wTo;
        u10 += (to[k + 1] ?? 0) * wTo;
        u01 += (to[k + MODE_NODES] ?? 0) * wTo;
        u11 += (to[k + MODE_NODES + 1] ?? 0) * wTo;
      }
      const u = (u00 + (u10 - u00) * tx) * (1 - ty) + (u01 + (u11 - u01) * tx) * ty;
      // The swing A|u| and its slope.
      const side = u < 0 ? -amp : amp;
      let level = u * side;
      let sx = ((u10 - u00) * (1 - ty) + (u11 - u01) * ty) * scale * side;
      let sy = ((u01 - u00) * (1 - tx) + (u11 - u10) * tx) * scale * side;
      const r2 = x * x + y * y;
      if (r2 < driveReach) {
        const hub = drive * Math.exp(-r2 * driveFall);
        level += hub;
        sx -= 2 * x * driveFall * hub;
        sy -= 2 * y * driveFall * hub;
      }
      const excess = level - (thresholds[i] ?? 0);
      if (excess <= REST) {
        if (airborne[i] !== 0) {
          airborne[i] = 0;
          stirred++;
        }
        continue;
      }
      const slope = Math.sqrt(sx * sx + sy * sy) + 1e-6;
      const pace = (drift * boost * excess) / (excess + DRIFT_EASE);
      // Distance down the slope this step, as a multiple of the slope vector.
      const down =
        Math.min((pace * dt * slope) / (slope + DRIFT_FLAT), (DRIFT_REACH * excess) / slope) /
        slope;
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      const n1 = (noise >>> 0) / 4294967296 - 0.5;
      noise ^= noise << 13;
      noise ^= noise >>> 17;
      noise ^= noise << 5;
      const n2 = (noise >>> 0) / 4294967296 - 0.5;
      const vx = (vxs[i] ?? 0) * (1 - memory) + kick * n1;
      const vy = (vys[i] ?? 0) * (1 - memory) + kick * n2;
      vxs[i] = vx;
      vys[i] = vy;
      const sway = dance * Math.min(excess, 1) * dt;
      x += vx * sway - sx * down;
      y += vy * sway - sy * down;
      if (round) {
        const r = Math.sqrt(x * x + y * y);
        if (r > RIM) {
          x *= RIM / r;
          y *= RIM / r;
        }
      } else {
        x = Math.min(RIM, Math.max(-RIM, x));
        y = Math.min(RIM, Math.max(-RIM, y));
      }
      xs[i] = x;
      ys[i] = y;
      airborne[i] = Math.min(1, excess / AIRBORNE);
      stirred++;
    }
    this.#noise = noise;
    return stirred;
  }

  /** Click: a pinch of sand where the pointer is. Drag: a trail of it, and a trickle while held still. */
  #pourAt(pointer: PointerState, dt: number, aspect: number): void {
    const a = aspect > 0 ? aspect : 16 / 9;
    const half = Math.min(CHLADNI_PLATE, (CHLADNI_PLATE_FIT * a) / 2);
    const x = ((pointer.x - 0.5) * a) / half;
    const y = (pointer.y - 0.5) / half;
    // A press (even one already released within the frame) pours a pinch.
    if (pointer.pressed && pointer.inside) this.#strew(x, y, x, y, PINCH, PINCH_RADIUS);
    if (!pointer.down || !pointer.inside) {
      this.#pouring = false;
      return;
    }
    if (!this.#pouring || pointer.pressed) {
      this.#pouring = true;
      this.#pourX = x;
      this.#pourY = y;
      this.#pourDebt = 0;
      return;
    }
    const lastX = this.#pourX;
    const lastY = this.#pourY;
    this.#pourDebt += Math.hypot(x - lastX, y - lastY) * POUR_PER_UNIT + dt * POUR_PER_SECOND;
    const grains = Math.floor(this.#pourDebt);
    this.#pourDebt -= grains;
    this.#strew(lastX, lastY, x, y, grains, POUR_RADIUS);
    this.#pourX = x;
    this.#pourY = y;
  }

  #onPlate(x: number, y: number): boolean {
    return this.#round ? Math.hypot(x, y) < RIM : Math.max(Math.abs(x), Math.abs(y)) < RIM;
  }

  /** Take `grains` grains up at random and drop them along the segment, `radius` about it; those landing off the plate are not poured. */
  #strew(x0: number, y0: number, x1: number, y1: number, grains: number, radius: number): void {
    const hand = this.#hand;
    const count = this.#count;
    for (let g = 0; g < grains; g++) {
      const along = (g + hand.next()) / Math.max(1, grains);
      // Twice the sum of three uniforms less 1.5: a rounded heap, one radius wide (σ), never past three.
      const x =
        x0 + (x1 - x0) * along + radius * 2 * (hand.next() + hand.next() + hand.next() - 1.5);
      const y =
        y0 + (y1 - y0) * along + radius * 2 * (hand.next() + hand.next() + hand.next() - 1.5);
      if (!this.#onPlate(x, y)) continue;
      const i = Math.min(count - 1, Math.floor(hand.next() * count));
      this.#x[i] = x;
      this.#y[i] = y;
      this.#vx[i] = 0;
      this.#vy[i] = 0;
      this.#airborne[i] = 1;
      this.#sandDirty = true;
    }
  }

  /** Ease the shown field toward the grains, keeping `keep` of the difference; done once within a hair of them. */
  #ease(keep: number): void {
    const shown = this.#shown;
    const sand = this.#sand;
    let easing = false;
    for (let k = 0; k < shown.length; k++) {
      const target = sand[k] ?? 0;
      const gap = ((shown[k] ?? 0) - target) * keep;
      if (gap > 0.01 || gap < -0.01) {
        shown[k] = target + gap;
        easing = true;
      } else {
        shown[k] = target;
      }
    }
    this.#easing = easing;
  }

  /** Cloud-in-cell: each grain shares itself bilinearly among the four nearest texels. */
  #splat(): void {
    const field = this.#sand;
    field.fill(0);
    const size = CHLADNI_SAND_TEXELS;
    const half = size / 2;
    const last = size - 2;
    const xs = this.#x;
    const ys = this.#y;
    const airborne = this.#airborne;
    const landing = this.#landing;
    const clock = this.#clock;
    const land = this.#land;
    const sliding = this.#sliding;
    for (let i = 0; i < this.#count; i++) {
      // Grains still to be poured are not on the plate; those slid off its edge are gone.
      if (landing && (land[i] ?? 0) > clock) continue;
      if (sliding && !this.#onPlate(xs[i] ?? 0, ys[i] ?? 0)) continue;
      const gx = ((xs[i] ?? 0) + 1) * half - 0.5;
      const gy = ((ys[i] ?? 0) + 1) * half - 0.5;
      const i0 = Math.min(last, Math.max(0, Math.floor(gx)));
      const j0 = Math.min(last, Math.max(0, Math.floor(gy)));
      const ax = Math.min(1, Math.max(0, gx - i0));
      const ay = Math.min(1, Math.max(0, gy - j0));
      const flying = airborne[i] ?? 0;
      const resting = 1 - flying;
      const k = (j0 * size + i0) * 2;
      const up = size * 2;
      const w00 = (1 - ax) * (1 - ay);
      const w10 = ax * (1 - ay);
      const w01 = (1 - ax) * ay;
      const w11 = ax * ay;
      field[k] = (field[k] ?? 0) + w00 * resting;
      field[k + 1] = (field[k + 1] ?? 0) + w00 * flying;
      field[k + 2] = (field[k + 2] ?? 0) + w10 * resting;
      field[k + 3] = (field[k + 3] ?? 0) + w10 * flying;
      field[k + up] = (field[k + up] ?? 0) + w01 * resting;
      field[k + up + 1] = (field[k + up + 1] ?? 0) + w01 * flying;
      field[k + up + 2] = (field[k + up + 2] ?? 0) + w11 * resting;
      field[k + up + 3] = (field[k + up + 3] ?? 0) + w11 * flying;
    }
  }
}

/** The Chladni plate's simulation, for a scene whose `params` carry the knobs `ChladniKnob` names. */
export function chladniSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new ChladniSim(gl, params);
}
