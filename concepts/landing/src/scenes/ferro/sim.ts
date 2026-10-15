// Ferrofluid over a magnet, on the CPU. The pool is seven blobs of fluid on damped springs: the
// middle one is drawn after the magnet and the ring after the middle one, so the pool lags,
// stretches and sloshes when the magnet moves, and draws in and heaps up when the field rises. Over
// the pool, a field of spike heights follows the magnet's field past the Rosensweig threshold (height
// growing as a power of the excess, each patch on its own slightly springy oscillator), with a lean
// that splays the spikes outward along the field lines. The shader (shader.ts) stands the spikes on
// a hexagonal lattice centred on the magnet and lights the fluid as a black mirror in a studio.
//
// The passage (FERRO_PASSAGE): the magnet's field is gated. Coming in, the pool lies flat with no
// spikes, then the field comes on and the crown rises from the middle (where it passes the
// threshold first), each spike on its usual spring, the pool drawing in as it pulls. Going out the
// field switches off and the spikes sink on critically damped springs while the shader runs a
// ripple over the pool. At rest the gate is exactly 1 and nothing else differs.
//
//   uSim0  rgba16f, FERRO_GRID² texels over dish coordinates [-FERRO_SPAN, FERRO_SPAN]² (the dish's
//          radius is 1, y away from the three-quarter camera): r the height of a spike standing
//          there, gb the offset of its tip (lean), a the pool's field φ (1 at its edge)
//   uSim1  rgba16f, FERRO_STATE_HEAD + FERRO_BLOBS texels, nearest:
//          0 lattice origin xy, lattice spacing, M amount 0..1
//          1 the pool's bounding circle xy and radius, the height of its tallest point
//          2 the M's height (dish units)
//          3.. the blobs: centre xy, radius, weight
import { KnobReader, type ParamDef } from "../../params.ts";
import { markDistance } from "../../mark.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** Spike-field texels per side, and the half-width of dish it covers. */
export const FERRO_GRID = 96;
export const FERRO_SPAN = 1;
/** Blobs making up the pool: a middle one and a ring of six. */
export const FERRO_BLOBS = 7;
/** uSim1 texels before the blobs. */
export const FERRO_STATE_HEAD = 3;

/** The cameras, shared with the shader so the pointer lands on the dish where it is drawn. */
export const FERRO_VIEW = {
  /** Three-quarter: elevation over the dish (radians), distance to the aim point, the aim point.
   * Close and low, so the crown spans about half a wide frame and its back row stands against
   * the softbox mirrored in the far dish; the near lip of the dish just touches the frame's bottom. */
  elevation: 0.4189,
  distance: 2.65,
  target: [0, -0.22, 0.12],
  /** tan of half the vertical field of view: a long lens, so the lattice stays regular. */
  tanHalfFov: 0.2309,
  /** Frames narrower than this aspect pull the camera back so the dish keeps its width. */
  fit: 1.25,
  /** Above: half the frame's height in dish units, the eye's height (it sets the mirrored
   * directions; the picture itself is orthographic), and the aspect below which it pulls back. */
  topHalf: 1.3,
  topEye: 3,
  topFit: 0.95,
} as const;

/** The fluid's surface, shared with the shader (dish units). */
export const FERRO_SHAPE = {
  /** A shallow pool's height, and the φ above 1 over which its rounded edge rises to it. */
  puddle: 0.045,
  edge: 0.12,
  /** How the pool heaps where it runs deep (φ well above 1). */
  mound: 0.05,
  moundSoft: 0.6,
  /** A spike's footprint radius in lattice spacings, and the φ above 1 over which spikes reach full
   * height going in from the pool's edge. */
  radius: 0.6,
  spikeFade: 0.35,
} as const;

/** Seconds the entrance and the exit take (SceneDef.passage; the shader reads the exit's for its ripple). */
export const FERRO_PASSAGE = { enter: 3, exit: 1.7 } as const;

/**
 * The ripple that crosses the pool as the spikes slump on the way out (shader.ts): a ring packet
 * running out from the middle blob. Height (dish units), speed (units/s), seconds into the exit it
 * starts, the packet's width and wavelength.
 */
export const FERRO_RIPPLE = {
  height: 0.007,
  speed: 0.75,
  start: 0.2,
  width: 0.17,
  wavelength: 0.2,
} as const;

/** Height of the pool's surface without its spikes, for the blob field φ (1 at the edge). */
export function ferroBase(phi: number): number {
  const x = Math.max(phi - 1, 0);
  return (
    FERRO_SHAPE.puddle * Math.sqrt(1 - Math.exp(-x / FERRO_SHAPE.edge)) +
    (FERRO_SHAPE.mound * x * x) / (x + FERRO_SHAPE.moundSoft)
  );
}

// ---- tuning ----------------------------------------------------------------------------------

/** Longest frame the sim steps in one go, and its spring substep (seconds). */
const MAX_DT = 0.1;
const STEP = 1 / 60;
/** A pool of size 1: blob radius, and how far the ring of blobs sits from the middle one (its edge
 * then lies at about 0.68, leaving a ring of smooth mirror round the crown). */
const BLOB_RADIUS = 0.76;
const RING_REACH = 0.52;
/** A strong field draws the ring in by up to this share: the pool tightens and heaps. */
const PULL_IN = 0.25;
/** While the M stands the pool spreads to at least this (dish units), to carry every magnet. */
const MARK_BLOB_RADIUS = 0.98;
const MARK_RING_REACH = 0.58;
/** The magnet's depth under the fluid as a share of the pool's size: how wide its field spreads. */
const MAGNET_DEPTH = 0.56;
/** Field (1 at full strength over the magnet) where spikes appear, how their height grows past it
 * (a power of the excess: they jump up just past the threshold, then grow slowly), and its cap. */
const THRESHOLD = 0.35;
const ONSET = 0.6;
const EXCESS_CAP = 1.6;
/** Between breaths the field rests at this share of its peak: a heaped pool, below the threshold. */
const BREATH_FLOOR = 0.28;
/** Seconds per breath at the middle speed; the scene opens near the top of a rise. */
const BREATH_SECONDS = 30;
const START_PHASE = 0.36;
/** Holding the button presses the magnet closer: the field grows by this share. */
const PRESS_BOOST = 0.45;
/** The lattice tightens by this share at full pull: the crown gathers in as it rises. */
const CROWD = 0.12;
/** Spike heights ring like a slightly underdamped spring: angular frequency (rad/s), damping. */
const SPIKE_OMEGA = 4.2;
const SPIKE_DAMPING = 0.42;
/** A tip leans out by this many lattice spacings per magnet depth from the magnet, up to the cap
 * (which keeps every tip inside its own lattice cell, where the shader's tracer looks for it). */
const LEAN = 0.5;
const LEAN_MAX = 0.42;
/** The magnet follows its target critically damped (rad/s). */
const MAGNET_OMEGA = 5.5;
/** The M of magnets: nominal height (dish units); the lattice it stands on, finer than the crown's
 * so its diagonals get enough spikes (share of the spike scale); the band of full-height spikes
 * and where it fades out (lattice spacings from its strokes); its spikes' height over the crown's
 * tallest. */
const MARK_HEIGHT = 0.9;
const MARK_SPACING = 0.8;
const MARK_CORE = 0.36;
const MARK_FADE = 0.7;
const MARK_LIFT = 1;
/** "now": an M episode's rise, hold and fall (seconds). */
const EPISODE_RISE = 2.5;
const EPISODE_HOLD = 6;
const EPISODE_FALL = 3;
/** Easing time constants (seconds): the M amount, and pressing the magnet closer. */
const MARK_EASE = 0.6;
const PRESS_EASE = 0.3;
/** Entrance: the pool lies flat, then the field comes on between these seconds (the spikes stand
 * where it passes the threshold, middle first). Exit: the field is gone within `FIELD_OFF` seconds,
 * and the spikes sink on stiffer, critically damped springs: no ringing under the flat pool. */
const FIELD_ON_FROM = 0.55;
const FIELD_ON_TO = 2.3;
const FIELD_OFF = 0.55;
const SLUMP_OMEGA = 6.5;
const SLUMP_DAMPING = 1;

// ---- helpers ---------------------------------------------------------------------------------

const TAU = Math.PI * 2;

/** Move `value` toward `target` with time constant `tau` over `dt` seconds. */
const approach = (value: number, target: number, dt: number, tau: number): number =>
  value + (target - value) * (1 - Math.exp(-dt / tau));

/** Xorshift32 stream in [0, 1), seeded from the pour knob. */
function ferroRandom(seed: number): () => number {
  let state = (Math.imul(seed + 1, 0x2c1b3c6d) ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/** One breath, over phase 0..1: rest, rise, hold at the top, sink, rest. */
function breathCurve(phase: number): number {
  return smoothstep(0.1, 0.38, phase) - smoothstep(0.58, 0.85, phase);
}

const EPISODE_LENGTH = EPISODE_RISE + EPISODE_HOLD + EPISODE_FALL;

/** How far up a "now" M episode is, `age` seconds after the button (negative: none running). */
function episodeShow(age: number): number {
  if (age < 0) return 0;
  if (age < EPISODE_RISE) return smoothstep(0, EPISODE_RISE, age);
  if (age < EPISODE_RISE + EPISODE_HOLD) return 1;
  return 1 - smoothstep(EPISODE_RISE + EPISODE_HOLD, EPISODE_LENGTH, age);
}

/** The M's height for a lattice spacing: its upright strokes land exactly on lattice columns. */
function markScale(spacing: number): number {
  const column = 0.8660254 * spacing;
  const columns = Math.max(2, Math.round((MARK_HEIGHT * 0.47) / column));
  return (columns * column) / 0.47;
}

/**
 * Where the pointer (uv, y up) falls on the dish floor, through the same camera as the shader;
 * undefined if its ray never comes down.
 */
function ferroGround(
  x: number,
  y: number,
  aspect: number,
  above: boolean,
): { x: number; y: number } | undefined {
  const sx = (x - 0.5) * aspect * 2;
  const sy = (y - 0.5) * 2;
  if (above) {
    const k = FERRO_VIEW.topHalf * Math.max(1, FERRO_VIEW.topFit / aspect);
    return { x: sx * k, y: sy * k };
  }
  const fit = Math.max(1, FERRO_VIEW.fit / aspect);
  const ce = Math.cos(FERRO_VIEW.elevation);
  const se = Math.sin(FERRO_VIEW.elevation);
  const [tx, ty, tz] = FERRO_VIEW.target;
  const oy = ty - FERRO_VIEW.distance * fit * ce;
  const oz = tz + FERRO_VIEW.distance * fit * se;
  const dx = sx * FERRO_VIEW.tanHalfFov;
  const dy = ce + sy * se * FERRO_VIEW.tanHalfFov;
  const dz = -se + sy * ce * FERRO_VIEW.tanHalfFov;
  if (dz > -1e-4) return undefined;
  const t = -oz / dz;
  return { x: tx + dx * t, y: oy + dy * t };
}

/** Pull (x, y) smoothly inside radius `limit`. */
function softClamp(x: number, y: number, limit: number): { x: number; y: number } {
  const r = Math.hypot(x, y);
  if (r < 1e-9) return { x, y };
  const k = (limit * Math.tanh(r / limit)) / r;
  return { x: x * k, y: y * k };
}

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Step a damped spring pulling `body` toward (tx, ty): semi-implicit Euler, h seconds. */
function spring(
  body: Body,
  tx: number,
  ty: number,
  omega: number,
  damping: number,
  h: number,
): void {
  const k = omega * omega;
  const c = 2 * damping * omega;
  body.vx += (k * (tx - body.x) - c * body.vx) * h;
  body.vy += (k * (ty - body.y) - c * body.vy) * h;
  body.x += body.vx * h;
  body.y += body.vy * h;
}

interface Blob extends Body {
  /** Rest direction from the middle blob (radians) and reach (share of the ring's); 0 for the middle. */
  angle: number;
  reach: number;
  weight: number;
  /** Its spring: angular frequency (rad/s) and damping ratio. */
  omega: number;
  damping: number;
  /** A slow swell of its reach, so the pool's outline breathes on its own: share, rad/s, phase. */
  wobble: number;
  wobbleRate: number;
  wobblePhase: number;
}

// ---- knobs -----------------------------------------------------------------------------------

type FerroKnob =
  | "strength"
  | "breath"
  | "drift"
  | "follow"
  | "size"
  | "spacing"
  | "sharpness"
  | "pour"
  | "camera"
  | "mark";
const FERRO_KNOBS: readonly FerroKnob[] = [
  "strength",
  "breath",
  "drift",
  "follow",
  "size",
  "spacing",
  "sharpness",
  "pour",
  "camera",
  "mark",
];

interface Settings {
  /** The field over the magnet at the top of a breath (1: the crown just reaches the pool's edge). */
  peak: number;
  breathing: boolean;
  /** Breaths per second of idle time (they keep counting while breathing is off, for the M). */
  rate: number;
  drift: number;
  follow: boolean;
  /** Pool scale, 0.72..1.28. */
  size: number;
  /** Lattice spacing at rest (dish units). */
  spacing: number;
  /** Height of a spike at the threshold's full excess (dish units). */
  height: number;
  seed: number;
  above: boolean;
  /** Breaths per M breath while the M of magnets is on; 0 while it is off. */
  markEvery: number;
}

// ---- the simulation --------------------------------------------------------------------------

class FerroSim implements SceneSim {
  readonly #knobs: KnobReader<FerroKnob>;
  readonly #markTrigger: number;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #field: DataTexture;
  readonly #state: DataTexture;
  readonly #fieldData = new Float32Array(FERRO_GRID * FERRO_GRID * 4);
  readonly #stateData = new Float32Array((FERRO_STATE_HEAD + FERRO_BLOBS) * 4);
  /** Each texel's spike height and its rate of change. */
  readonly #amp = new Float32Array(FERRO_GRID * FERRO_GRID);
  readonly #vel = new Float32Array(FERRO_GRID * FERRO_GRID);
  readonly #blobs: Blob[];
  readonly #magnet: Body = { x: 0, y: 0, vx: 0, vy: 0 };
  #wanderPhase: readonly [number, number, number] = [0, 0, 0];
  #seed = -1;

  /** Settled at the first frame: everything starts at rest on its target, the crown already up. */
  #primed = false;
  /** The knobs, the one record `#read` fills in each frame, and the last frame's knobs and aspect (see `#sameAsLast`). */
  readonly #settings: Settings = {
    peak: 0,
    breathing: false,
    rate: 0,
    drift: 0,
    follow: false,
    size: 1,
    spacing: 0,
    height: 0,
    seed: 0,
    above: false,
    markEvery: 0,
  };
  readonly #lastValues: number[] = [];
  /** The field's passage gate last frame (see `frame`). */
  #lastGate = 1;
  #lastAspect = Number.NaN;
  /** Idle clock (scene time × motion): the drift and the pool's own swell. */
  #clock = 0;
  /** Breath phase 0..1, whether this breath draws the M, and breaths until the next one that does. */
  #phase = START_PHASE;
  #markBreath = false;
  #untilMark = 0;
  #markEvery = 0;
  /** Seconds into a "now" M episode; -1 while none runs. */
  #episode = -1;
  /** M amount 0..1 (eased), and the magnet pressed closer 0..1 (eased). */
  #mark = 0;
  #press = 0;

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<FerroKnob>) {
    this.#knobs = knobs;
    this.#markTrigger = knobs.trigger("mark");
    this.#blobs = Array.from({ length: FERRO_BLOBS }, () => ({
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      angle: 0,
      reach: 0,
      weight: 1,
      omega: 1,
      damping: 1,
      wobble: 0,
      wobbleRate: 0,
      wobblePhase: 0,
    }));
    this.#field = new DataTexture(gl, { width: FERRO_GRID, height: FERRO_GRID, format: "rgba16f" });
    this.#state = new DataTexture(gl, {
      width: FERRO_STATE_HEAD + FERRO_BLOBS,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [this.#field.texture, this.#state.texture];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = this.#read(frame);
    if (settings.seed !== this.#seed) this.#reseed(settings.seed);
    const fired = frame.fired[this.#markTrigger] === true;
    if (fired) this.#episode = 0;

    const dt = Math.min(Math.max(frame.dt, 0), MAX_DT);
    const enterSeconds = clamp(frame.passage.enter, 0, 1) * FERRO_PASSAGE.enter;
    const exitSeconds = clamp(frame.passage.exit, 0, 1) * FERRO_PASSAGE.exit;
    // The passage gate on the magnet's field: 0 while the pool lies flat, 1 at rest.
    const gate =
      smoothstep(FIELD_ON_FROM, FIELD_ON_TO, enterSeconds) *
      (1 - smoothstep(0, FIELD_OFF, exitSeconds));
    const leaving = exitSeconds > 0;
    const unchanged = this.#sameAsLast(frame) && gate === this.#lastGate;
    this.#lastGate = gate;
    // Paused with nothing changed: the textures already hold this frame.
    if (this.#primed && dt === 0 && unchanged && !fired) return this.#textures;

    const idle = dt * Math.max(0, frame.motion);
    this.#clock += idle;
    this.#breathe(idle * settings.rate, settings.markEvery);
    // A "now" episode plays on the scene clock, even while motion is 0.
    if (this.#episode >= 0) {
      this.#episode += dt;
      if (this.#episode > EPISODE_LENGTH) this.#episode = -1;
    }

    const breath = breathCurve(this.#phase);
    const markTarget = Math.max(this.#markBreath ? breath : 0, episodeShow(this.#episode)) * gate;
    this.#mark = this.#primed ? approach(this.#mark, markTarget, dt, MARK_EASE) : markTarget;
    const mark = this.#mark;
    const pointer = frame.pointer;
    const pressing = settings.follow && pointer.inside && pointer.down;
    this.#press = approach(this.#press, pressing ? 1 : 0, dt, PRESS_EASE);

    // The magnet's field: it breathes (or holds), an M breath lets it rest, a press boosts it.
    const breathField = settings.breathing ? (this.#markBreath ? 0 : breath) : 1;
    const field =
      settings.peak *
      (BREATH_FLOOR + (1 - BREATH_FLOOR) * breathField) *
      (1 + PRESS_BOOST * this.#press) *
      gate;
    const pull = clamp((field - 0.3) / 0.9, 0, 1) * (1 - mark);

    this.#move(frame, settings, dt, mark, pull);

    // The crown's lattice tightens as the field pulls; the M stands on a finer one, centred on the dish.
    const markSpacing = settings.spacing * MARK_SPACING;
    const spacing = lerp(settings.spacing * (1 - CROWD * pull), markSpacing, mark);
    const originX = lerp(this.#magnet.x, 0, mark);
    const originY = lerp(this.#magnet.y, 0, mark);
    const blobRadius = this.#blobRadius(settings.size, mark);
    const scale = markScale(markSpacing);
    const { phiMax, ampMax, reach } = this.#spikes(
      settings,
      dt,
      field,
      mark,
      spacing,
      scale,
      blobRadius,
      leaving,
    );
    this.#primed = true;

    this.#writeState(
      originX,
      originY,
      spacing,
      mark,
      blobRadius,
      scale,
      reach,
      ferroBase(phiMax * 1.03) +
        Math.max(ampMax, 0) * 1.05 +
        0.005 +
        (leaving ? FERRO_RIPPLE.height : 0),
    );
    this.#field.upload(this.#fieldData);
    this.#state.upload(this.#stateData);
    return this.#textures;
  }

  dispose(): void {
    this.#field.dispose();
    this.#state.dispose();
  }

  /** The knobs as the shader sees them, written into the sim's one `Settings` record. */
  #read(frame: SimFrame): Settings {
    const knobs = this.#knobs;
    const settings = this.#settings;
    const mark = knobs.value(frame, "mark");
    const spacing = 0.085 + 0.07 * knobs.value(frame, "spacing");
    const speed = knobs.amount(frame, "breath");
    settings.peak = 0.55 + 1.1 * knobs.value(frame, "strength");
    settings.breathing = knobs.value(frame, "breath") > 0;
    settings.rate = 1 / (BREATH_SECONDS * 2 ** ((0.5 - speed) * 2.5));
    settings.drift = knobs.value(frame, "drift");
    settings.follow = knobs.value(frame, "follow") > 0.5;
    settings.size = 0.72 + 0.56 * knobs.value(frame, "size");
    settings.spacing = spacing;
    settings.height = spacing * (1 + 1.5 * knobs.value(frame, "sharpness"));
    settings.seed = Math.round(knobs.value(frame, "pour"));
    settings.above = Math.round(knobs.value(frame, "camera")) === 0;
    settings.markEvery = mark > 0 ? Math.max(1, Math.round(1 + 5 * (1 - mark))) : 0;
    return settings;
  }

  /** Whether the knobs and aspect are those of the previous frame; remembers this frame's. */
  #sameAsLast(frame: SimFrame): boolean {
    const values = frame.values;
    const last = this.#lastValues;
    let same = frame.aspect === this.#lastAspect && values.length === last.length;
    for (let i = 0; i < values.length; i++) {
      const value = values[i] ?? 0;
      if (last[i] !== value) same = false;
      last[i] = value;
    }
    last.length = values.length;
    this.#lastAspect = frame.aspect;
    return same;
  }

  /** A new pour: the ring's directions, reaches, weights, springs and swells, and the drift's path. */
  #reseed(seed: number): void {
    const random = ferroRandom(seed);
    const turn = (random() * Math.PI) / 3;
    this.#blobs.forEach((blob, i) => {
      const ring = i > 0;
      blob.angle = ring ? turn + ((i - 1) * Math.PI) / 3 + (random() - 0.5) * 0.3 : 0;
      blob.reach = ring ? 1 + (random() - 0.5) * 0.14 : 0;
      blob.weight = 0.93 + random() * 0.14;
      blob.omega = TAU * (ring ? 0.32 + random() * 0.08 : 0.55);
      blob.damping = ring ? 0.28 + random() * 0.08 : 0.62;
      blob.wobble = ring ? 0.025 + random() * 0.025 : 0;
      blob.wobbleRate = 0.32 + random() * 0.3;
      blob.wobblePhase = random() * TAU;
    });
    this.#wanderPhase = [random() * TAU, random() * TAU, random() * TAU];
    this.#seed = seed;
  }

  /** Count breaths; while the M is on, every `every`-th one raises it (the first right after it is switched on). */
  #breathe(advance: number, every: number): void {
    if (every > 0 && this.#markEvery === 0) this.#untilMark = 1;
    if (every === 0) this.#markBreath = false;
    else this.#untilMark = Math.min(this.#untilMark, every);
    this.#markEvery = every;
    this.#phase += advance;
    while (this.#phase >= 1) {
      this.#phase -= 1;
      this.#untilMark -= 1;
      this.#markBreath = every > 0 && this.#untilMark <= 0;
      if (this.#markBreath) this.#untilMark = every;
    }
  }

  #blobRadius(size: number, mark: number): number {
    const radius = BLOB_RADIUS * size;
    return lerp(radius, Math.max(radius, MARK_BLOB_RADIUS), mark);
  }

  /** The magnet after the pointer (or its drift), the middle blob after the magnet, the ring after it. */
  #move(frame: SimFrame, settings: Settings, dt: number, mark: number, pull: number): void {
    const pointer = frame.pointer;
    const ground =
      settings.follow && pointer.inside
        ? ferroGround(pointer.x, pointer.y, frame.aspect, settings.above)
        : undefined;
    const [w0, w1, w2] = this.#wanderPhase;
    const c = this.#clock;
    const aim = ground ?? {
      x: settings.drift * (0.2 * Math.sin(0.11 * c + w0) + 0.05 * Math.sin(0.29 * c + w1)),
      y: settings.drift * 0.13 * Math.sin(0.083 * c + w2),
    };
    // The pool keeps clear of the dish's wall.
    const target = softClamp(aim.x, aim.y, Math.max(0.05, 0.92 - 0.7 * settings.size));

    const reach = RING_REACH * settings.size * (1 - PULL_IN * pull);
    const ringReach = lerp(reach, Math.max(reach, MARK_RING_REACH), mark);
    const magnet = this.#magnet;
    const blobs = this.#blobs;
    const middle = blobs[0];
    if (middle === undefined) return;

    if (!this.#primed) {
      magnet.x = target.x;
      magnet.y = target.y;
      for (const blob of blobs) {
        const r =
          blob.reach *
          ringReach *
          (1 + blob.wobble * Math.sin(blob.wobbleRate * c + blob.wobblePhase));
        blob.x = lerp(target.x, 0, mark) + Math.cos(blob.angle) * r;
        blob.y = lerp(target.y, 0, mark) + Math.sin(blob.angle) * r;
      }
      return;
    }

    const steps = dt > 0 ? Math.ceil(dt / STEP - 1e-9) : 0;
    const h = steps > 0 ? dt / steps : 0;
    for (let step = 0; step < steps; step++) {
      spring(magnet, target.x, target.y, MAGNET_OMEGA, 1, h);
      spring(
        middle,
        lerp(magnet.x, 0, mark),
        lerp(magnet.y, 0, mark),
        middle.omega,
        middle.damping,
        h,
      );
      for (let i = 1; i < blobs.length; i++) {
        const blob = blobs[i];
        if (blob === undefined) continue;
        const r =
          blob.reach *
          ringReach *
          (1 + blob.wobble * Math.sin(blob.wobbleRate * c + blob.wobblePhase));
        spring(
          blob,
          middle.x + Math.cos(blob.angle) * r,
          middle.y + Math.sin(blob.angle) * r,
          blob.omega,
          blob.damping,
          h,
        );
      }
    }
  }

  /**
   * Every texel: the pool's field φ, the spike height the magnet (or the M) calls for there, the
   * spring carrying the height toward it, and the lean. Returns the largest φ and height, and how
   * far the fluid reaches from the middle blob: the shader's bounds on the surface.
   */
  #spikes(
    settings: Settings,
    dt: number,
    field: number,
    mark: number,
    spacing: number,
    scale: number,
    blobRadius: number,
    leaving: boolean,
  ): { phiMax: number; ampMax: number; reach: number } {
    const n = FERRO_GRID;
    const texel = (2 * FERRO_SPAN) / n;
    const blobs = this.#blobs;
    const magnet = this.#magnet;
    const depth = MAGNET_DEPTH * settings.size;
    const invDepth2 = 1 / (depth * depth);
    const crown = field * (1 - mark);
    const markLift = settings.height * MARK_LIFT * mark;
    const markCore = MARK_CORE * settings.spacing * MARK_SPACING;
    const markFade = MARK_FADE * settings.spacing * MARK_SPACING;
    const lean = (LEAN * spacing) / depth;
    const leanMax = LEAN_MAX * spacing * (1 - mark);
    const invRadius2 = 1 / (blobRadius * blobRadius);

    // Only texels within the pool's reach can hold fluid.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const blob of blobs) {
      minX = Math.min(minX, blob.x - blobRadius);
      maxX = Math.max(maxX, blob.x + blobRadius);
      minY = Math.min(minY, blob.y - blobRadius);
      maxY = Math.max(maxY, blob.y + blobRadius);
    }

    const steps = dt > 0 ? Math.ceil(dt / STEP - 1e-9) : 0;
    const h = steps > 0 ? dt / steps : 0;
    const omega = leaving ? SLUMP_OMEGA : SPIKE_OMEGA;
    const k = omega * omega;
    const c = 2 * (leaving ? SLUMP_DAMPING : SPIKE_DAMPING) * omega;
    const amp = this.#amp;
    const vel = this.#vel;
    const data = this.#fieldData;
    let phiMax = 0;
    let ampMax = 0;
    let reach2 = 0;
    const cx = blobs[0]?.x ?? 0;
    const cy = blobs[0]?.y ?? 0;

    for (let j = 0; j < n; j++) {
      const y = -FERRO_SPAN + (j + 0.5) * texel;
      const rowInside = y > minY && y < maxY;
      for (let i = 0; i < n; i++) {
        const x = -FERRO_SPAN + (i + 0.5) * texel;
        const at = j * n + i;
        let phi = 0;
        if (rowInside && x > minX && x < maxX) {
          for (const blob of blobs) {
            const dx = x - blob.x;
            const dy = y - blob.y;
            const d2 = (dx * dx + dy * dy) * invRadius2;
            if (d2 < 1) {
              const u = 1 - d2;
              phi += blob.weight * u * u * u;
            }
          }
        }

        const mx = x - magnet.x;
        const my = y - magnet.y;
        let target = 0;
        if (phi > 1) {
          const q = 1 + (mx * mx + my * my) * invDepth2;
          const excess = (crown / (q * Math.sqrt(q)) - THRESHOLD) / (1 - THRESHOLD);
          if (excess > 0) target = settings.height * Math.pow(Math.min(excess, EXCESS_CAP), ONSET);
          if (markLift > 0) {
            const d = markDistance(x / scale, y / scale) * scale;
            target += markLift * (1 - smoothstep(markCore, markFade, d));
          }
          target *= smoothstep(1.05, 1.45, phi);
        }

        let a = amp[at] ?? 0;
        let v = vel[at] ?? 0;
        if (!this.#primed) {
          a = target;
          v = 0;
        } else if (target !== 0 || a !== 0 || v !== 0) {
          for (let s = 0; s < steps; s++) {
            v += (k * (target - a) - c * v) * h;
            a += v * h;
          }
          // Settled flat: stop ringing forever on float dust.
          if (target === 0 && Math.abs(a) < 1e-5 && Math.abs(v) < 1e-4) {
            a = 0;
            v = 0;
          }
        }
        amp[at] = a;
        vel[at] = v;

        let lx = mx * lean;
        let ly = my * lean;
        const l = Math.hypot(lx, ly);
        if (l > leanMax) {
          const f = leanMax / l;
          lx *= f;
          ly *= f;
        }

        const o = at * 4;
        data[o] = a;
        data[o + 1] = lx;
        data[o + 2] = ly;
        data[o + 3] = phi;
        if (phi > phiMax) phiMax = phi;
        if (a > ampMax) ampMax = a;
        if (phi > 1) reach2 = Math.max(reach2, (x - cx) * (x - cx) + (y - cy) * (y - cy));
      }
    }
    // The analytic edge lies within a texel of the last texel inside it.
    return { phiMax, ampMax, reach: Math.sqrt(reach2) + 1.5 * texel };
  }

  #writeState(
    originX: number,
    originY: number,
    spacing: number,
    mark: number,
    blobRadius: number,
    scale: number,
    reach: number,
    top: number,
  ): void {
    const data = this.#stateData;
    const blobs = this.#blobs;
    data[0] = originX;
    data[1] = originY;
    data[2] = spacing;
    data[3] = mark;
    data[4] = blobs[0]?.x ?? 0;
    data[5] = blobs[0]?.y ?? 0;
    data[6] = reach;
    data[7] = top;
    data[8] = scale;
    data[9] = 0;
    data[10] = 0;
    data[11] = 0;
    for (let i = 0; i < blobs.length; i++) {
      const blob = blobs[i];
      if (blob === undefined) continue;
      const o = (FERRO_STATE_HEAD + i) * 4;
      data[o] = blob.x;
      data[o + 1] = blob.y;
      data[o + 2] = blobRadius;
      data[o + 3] = blob.weight;
    }
  }
}

/** The ferrofluid pool, for a scene whose `params` carry the knobs `FerroKnob` names. */
export function ferroSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<FerroKnob>("ferro", params, FERRO_KNOBS);
  return (gl) => new FerroSim(gl, knobs);
}
