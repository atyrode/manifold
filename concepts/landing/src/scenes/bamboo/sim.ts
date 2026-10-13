// The bamboo grove's simulation: everything that moves with weight.
// - The grove: every culm in view, depth layer by depth layer, is a damped spring whose target is set
//   by the wind: a gentle breeze always rolling through, and gust fronts that cross the grove a little
//   obliquely, so the stems bow one after another, the front rows first, and ring on after it passes.
// - The shishi-odoshi: a bamboo tube on a pivot, a damped rotational oscillator whose torque comes
//   from its own weight (heavier behind the pivot) and the water filling its mouth. It fills, lifts
//   off its stone, tips past its balance point as the water rushes to the mouth, pours into the
//   basin, swings back and clacks on the stone with a small bounce.
// - Leaves letting go of the canopy and gliding down; some land on the basin and float.
// - Rings on the basin's water: the pour, the clack, a leaf landing, a click.
// The shader (shader.ts) reads three textures:
//   uSim0  rg16f, BAMBOO_CELLS x layers, linear: per culm (column = grid cell + BAMBOO_CELLS / 2, row =
//          depth layer) its deflection in metres at BAMBOO_SWAY_HEIGHT, and the gust on it 0..1.
//   uSim1  rgba16f, (2 + BAMBOO_RIPPLES) x 1, nearest: texel 0 the tube (angle in radians, mouth up
//          positive; fill relative to the tipping point; pour 0..1; spout flow 0 dry, 1 steady, more
//          while it gushes), texel 1 (seconds since the clack, its strength 0..1, the grove's mean gust
//          0..1, 0), then one texel per ripple (centre in basin-disc units, age in seconds, strength).
//   uSim2  rgba16f, 2 x BAMBOO_MAX_LEAVES, nearest: one row per leaf. Falling or lying: (screen x, y,
//          angle, length in screen heights), (width 0..1, depth m, alpha, 1). Floating: (disc u, v,
//          angle, length in disc units), (1, depth m, alpha, 2). Unused rows are 0.
import { KnobReader, type ParamDef } from "../../params.ts";
import { hash31, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- geometry shared with shader.ts ----

/**
 * Side-on camera: the ground's horizon in screen heights, and the eye's height in metres. A point at
 * depth z and height y (metres) lands at screen y = HORIZON + (y - EYE) / z; x scales by 1 / z.
 */
export const BAMBOO_HORIZON = 0.4;
export const BAMBOO_EYE = 1.3;

export interface BambooLayer {
  /** Metres from the eye. */
  readonly depth: number;
  /** Grid cell width in metres: each cell may hold one culm. */
  readonly spacing: number;
  /** Culm diameter in metres (each culm varies about it). */
  readonly diameter: number;
}

/**
 * The grove's depth layers, near to far. The nearest holds a single big culm framing the left edge
 * (shader.ts places it); the others are grids of cells, each of which may hold a culm.
 */
export const BAMBOO_LAYERS: readonly BambooLayer[] = [
  { depth: 0.85, spacing: 1.2, diameter: 0.14 },
  { depth: 1.6, spacing: 1.0, diameter: 0.12 },
  { depth: 3.6, spacing: 0.95, diameter: 0.11 },
  { depth: 7, spacing: 0.9, diameter: 0.1 },
  { depth: 13, spacing: 0.85, diameter: 0.1 },
];
/** Grid cells simulated per layer, centred on the view axis (enough for a 2.9:1 frame). */
export const BAMBOO_CELLS = 64;
/** Height (m) at which a culm's deflection is measured; it bends as (height / this)^1.5. */
export const BAMBOO_SWAY_HEIGHT = 8;

/**
 * The water clock, in device units: screen heights before the corner's scale (bambooDeviceScale,
 * 1.25 on landscape frames, less on narrow ones), origin at the frame's bottom-right corner, y up.
 * The tube pivots at (x, y); `back` and `front` are its lengths behind and ahead of the pivot, the
 * mouth is cut obliquely over `cut`; it rests mouth up at `rest` (radians) on the striking stone and
 * tips no lower than `low`. At full size the tube spans about a quarter of a 16:9 frame's width.
 */
export const BAMBOO_TUBE = { x: -0.31, y: 0.22, back: 0.15, front: 0.22, radius: 0.022, cut: 0.055, rest: 0.38, low: -0.4 } as const;
/** Where the tube's closed end strikes: the top of the stone under it at rest. */
export const BAMBOO_STRIKE = {
  x: BAMBOO_TUBE.x - BAMBOO_TUBE.back * Math.cos(BAMBOO_TUBE.rest),
  top: BAMBOO_TUBE.y - BAMBOO_TUBE.back * Math.sin(BAMBOO_TUBE.rest) - BAMBOO_TUBE.radius * Math.cos(BAMBOO_TUBE.rest),
} as const;
/** The spout (kakei): a thin cane from beyond the right edge to its cut end. */
export const BAMBOO_SPOUT = { fromX: 0.05, fromY: 0.367, toX: -0.135, toY: 0.356, radius: 0.012 } as const;
/** The spout's lower lip, where the trickle leaves it: the cane's end, one radius below its axis. */
export const BAMBOO_LIP = (() => {
  const dx = BAMBOO_SPOUT.toX - BAMBOO_SPOUT.fromX;
  const dy = BAMBOO_SPOUT.toY - BAMBOO_SPOUT.fromY;
  const length = Math.hypot(dx, dy);
  // The cane's "up" normal: its direction turned a quarter toward +y.
  const upX = dy / length;
  const upY = -dx / length;
  return { x: BAMBOO_SPOUT.toX - BAMBOO_SPOUT.radius * upX, y: BAMBOO_SPOUT.toY - BAMBOO_SPOUT.radius * upY } as const;
})();
/** The post the spout is tied to. */
export const BAMBOO_POST_X = -0.035;
/** The basin's water: centre and radii of its ellipse (a circle seen from a little above). */
export const BAMBOO_BASIN = { x: -0.13, y: 0.06, rx: 0.078, ry: 0.02 } as const;
/** The pour leaves the mouth along the tube at `speed` and falls under `gravity` (device units). */
export const BAMBOO_POUR = { speed: 0.12, gravity: 1.2 } as const;
/** How far away the water clock stands (m): its parallax, and the depth of leaves meant for it. */
export const BAMBOO_DEVICE_DEPTH = 1.35;
/** The stone lantern standing on the grove floor left of the water clock: its axis in device units
 *  across, its depth in metres (it stands between the second and third layers of culms). */
export const BAMBOO_LANTERN = { x: -0.64, depth: 3.4 } as const;
/** Ripple events the shader rings at once. */
export const BAMBOO_RIPPLES = 8;
/** Leaves in the air or on the water at once. */
export const BAMBOO_MAX_LEAVES = 12;

/** The corner group (water clock and lantern) is drawn `size` times its device units from this aspect
 *  up, and shrinks with narrower frames down to `smallest` of that, so it never fills a phone's screen. */
export const BAMBOO_CORNER_FIT = { aspect: 1.5, smallest: 0.55, size: 1.25 } as const;

/** The corner group's scale (screen heights per device unit) for a frame of this aspect. */
export function bambooDeviceScale(aspect: number): number {
  return BAMBOO_CORNER_FIT.size * Math.min(1, Math.max(BAMBOO_CORNER_FIT.smallest, aspect / BAMBOO_CORNER_FIT.aspect));
}

/**
 * Where the pour meets the water, in device x, for the tube at `angle`: it leaves the mouth's lower
 * lip along the tube and falls in a parabola.
 */
export function bambooPourLanding(angle: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lipX = BAMBOO_TUBE.x + BAMBOO_TUBE.front * c + BAMBOO_TUBE.radius * s;
  const lipY = BAMBOO_TUBE.y + BAMBOO_TUBE.front * s - BAMBOO_TUBE.radius * c;
  const vx = BAMBOO_POUR.speed * c;
  const vy = BAMBOO_POUR.speed * s;
  const drop = Math.max(lipY - BAMBOO_BASIN.y, 0);
  const g = BAMBOO_POUR.gravity;
  const flight = (vy + Math.sqrt(vy * vy + 2 * g * drop)) / g;
  return lipX + vx * flight;
}

// ---- wind ----

/** Fronts cross the grove this far off square (radians), so they reach the front rows first. */
const FRONT_SKEW = 0.35;
const SKEW_COS = Math.cos(FRONT_SKEW);
const SKEW_SIN = Math.sin(FRONT_SKEW);
/** The culms' damping ratio: low, so a passing gust leaves them swaying a few times. */
const CULM_DAMPING = 0.08;
/** The always-present breeze: two slow waves (wavenumbers per metre) rolling downwind. */
const BREEZE_LONG = (2 * Math.PI) / 22;
const BREEZE_SHORT = (2 * Math.PI) / 9;
/** A gust's leading edge rises over this many metres; its tail is set per gust. */
const GUST_RISE = 0.8;
const GROVE_STEP = 1 / 60;
const PREWARM_SECONDS = 6;

/** Deflection (m at BAMBOO_SWAY_HEIGHT) per unit of breeze or gust, for the wind knob -1..1. */
function windSway(wind: number): number {
  return 0.12 + 1.5 * Math.abs(wind) ** 0.9;
}

/** How fast gust fronts and the breeze travel (m/s). */
function windSpeed(wind: number): number {
  return 1.8 + 2.6 * Math.abs(wind);
}

/** Peak of the gust pulse (1 - e^(-xi/rise)) e^(-xi/tail), so a gust's crest can be normalised. */
function pulsePeak(tail: number): number {
  const xi = GUST_RISE * Math.log(1 + tail / GUST_RISE);
  return (1 - Math.exp(-xi / GUST_RISE)) * Math.exp(-xi / tail);
}

// ---- the pointer ----

/** How far either side of the pointer (screen heights) stems are brushed. */
const BRUSH_REACH = 0.08;
/** Deflection (m) per screen height per second of pointer speed. */
const BRUSH_GAIN = 0.3;
const BRUSH_MAX = 2.5;
/** Smoothing of the pointer's speed (s). */
const BRUSH_SMOOTH = 0.12;

// ---- the tube (SI units: metres, kilograms, seconds) ----

const TUBE_STEP = 1 / 240;
const GRAVITY = 9.8;
/** The empty tube's mass times its centre's distance along it from the pivot: behind it, so it rests mouth up. */
const TUBE_MOMENT = -0.05;
/** The empty tube's moment of inertia about the pivot (kg m^2). */
const TUBE_INERTIA = 0.07;
/** Water the mouth holds when full (kg). */
const WATER_MASS = 0.45;
/** Where the water's centre sits along the tube (m from the pivot): pooled against the inner node
 *  while the mouth is up, rushed to the mouth once it is down. */
const waterUp = (fill: number): number => 0.05 + 0.16 * fill;
const waterDown = (fill: number): number => 0.34 - 0.08 * fill;
/** How quickly the water slops to its new place as the tube turns (s). */
const SLOSH_TIME = 0.12;
const PIVOT_DAMPING = 0.015;
/** Extra damping per kilogram of water sloshing inside. */
const WATER_DRAG = 0.04;
/** Bounce off the striking stone, and off the soft stop below. */
const RESTITUTION = 0.32;
const SOFT_RESTITUTION = 0.15;
/** Impact speeds (rad/s): slower is a silent touch, this fast a full clack. */
const CLACK_MIN = 0.25;
const CLACK_FULL = 3;
/** Fill per second poured per unit of water above what the mouth can hold at its angle. */
const POUR_RATE = 6;
/** Pour (fill per second) drawn at full width. */
const POUR_FULL = 3;
/** The fill at which the full tube lifts off its stone: the water's moment balances the tube's. */
const TIP_FILL = (() => {
  // WATER_MASS f (a + b f) = -TUBE_MOMENT, with waterUp(f) = a + b f.
  const a = waterUp(0);
  const b = waterUp(1) - a;
  const qa = WATER_MASS * b;
  const qb = WATER_MASS * a;
  return (-qb + Math.sqrt(qb * qb - 4 * qa * TUBE_MOMENT)) / (2 * qa);
})();
/** Seconds of each cycle spent lifting, tipping, pouring, swinging back and settling. */
const CYCLE_OVERHEAD = 2.2;
/** A "now": the spout gushes at this extra fill per second until the tube tips (or this long). */
const GUSH_RATE = 0.8;
const GUSH_LIMIT = 6;
/** Seconds between rings while the pour lands. */
const RIPPLE_EVERY = 0.11;

// ---- leaves ----

/** Sinking speed at the ends of each swing, and extra mid-swing (m/s). */
const LEAF_SINK = 0.25;
const LEAF_DIVE = 0.45;
const LEAF_FADE_IN = 0.6;
const LEAF_REST = 5;
const LEAF_FADE = 3;
const FLOAT_LIFE = 80;
const FLOAT_FADE = 6;
const MAX_FLOATING = 2;
/** Leaves let go per second at amount 1: always a few, many more in a gust. */
const RELEASE_CALM = 0.12;
const RELEASE_GUST = 1.2;
/** Share that let go above the basin, at the water clock's depth. */
const NEAR_SHARE = 0.3;
/** Depth range (m) of the other leaves. */
const LEAF_NEAR = 1.8;
const LEAF_FAR = 8;

const TAU = 2 * Math.PI;

export class BambooSimError extends Error {}

interface Culm {
  readonly layer: number;
  readonly depth: number;
  /** Cell centre, metres across the grove. */
  readonly x: number;
  /** Natural angular frequency (rad/s). */
  omega: number;
  /** Deflection (m at BAMBOO_SWAY_HEIGHT) and its rate. */
  deflect: number;
  rate: number;
  /** The gust on it now, 0..1. */
  gust: number;
  /** Extra deflection from the pointer brushing past. */
  push: number;
}

interface Gust {
  readonly born: number;
  /** Front position along its heading when it set off (m). */
  readonly from: number;
  /** Only culms at or past this position feel it (a gust sent from the pointer starts there). */
  readonly origin: number;
  /** +1 blowing toward +x, -1 toward -x. */
  readonly heading: number;
  readonly speed: number;
  /** Strength over the pulse's own peak, so its crest reaches the strength asked for. */
  readonly gain: number;
  /** e-folding length of its tail (m). */
  readonly tail: number;
}

type LeafState = "free" | "falling" | "resting" | "floating";

interface Leaf {
  state: LeafState;
  /** Let go above the basin, at the water clock's depth. */
  near: boolean;
  /** Metres across, metres up from the ground, metres deep. */
  x: number;
  y: number;
  z: number;
  /** The side-to-side swing of a falling leaf: phase, angular rate, half-width (m). */
  phase: number;
  swingRate: number;
  swing: number;
  /** Turning about its long axis (shows it edge-on now and then). */
  spin: number;
  spinRate: number;
  tilt: number;
  size: number;
  /** Seconds in its current state. */
  age: number;
  /** On the water: place in basin-disc units, and its heading there. */
  u: number;
  v: number;
  turn: number;
}

interface Ripple {
  u: number;
  v: number;
  born: number;
  strength: number;
}

type KnobKey = "clock" | "gusts" | "leaves" | "groveSeed" | "wind";

class BambooSim implements SceneSim {
  readonly #groveTexture: DataTexture;
  readonly #deviceTexture: DataTexture;
  readonly #leafTexture: DataTexture;
  readonly #groveData = new Float32Array(BAMBOO_CELLS * BAMBOO_LAYERS.length * 2);
  readonly #deviceData = new Float32Array((2 + BAMBOO_RIPPLES) * 4);
  readonly #leafData = new Float32Array(2 * BAMBOO_MAX_LEAVES * 4);
  readonly #knobs: KnobReader<KnobKey>;
  readonly #textures: (WebGLTexture | undefined)[] = [undefined, undefined, undefined];

  readonly #culms: Culm[] = [];
  readonly #gusts: Gust[] = [];
  readonly #leaves: Leaf[] = [];
  readonly #ripples: Ripple[] = [];
  #nextRipple = 0;

  // Knobs, as the sim follows them.
  #period = 20;
  #gustRate = 0.4;
  #leafAmount = 0.4;
  #wind = 0.2;
  #seed = -1;
  #random = mulberry32(1);

  /** The sim's own clock: scene seconds scaled by motion. */
  #clock = 0;
  #warm = false;
  #dirty = true;
  #nextGust = Number.POSITIVE_INFINITY;
  #gustMean = 0;

  // The tube.
  #angle: number = BAMBOO_TUBE.rest;
  #spin = 0;
  #fill = 0.5;
  #slosh = waterUp(0.5);
  #outflow = 0;
  #gushLeft = 0;
  #clackAt = -60;
  #clackStrength = 0;
  #lastPourRipple = -1;

  // The pointer.
  #pointerX: number | undefined;
  #pointerSpeed = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("bamboo", params, ["clock", "gusts", "leaves", "groveSeed", "wind"]);
    this.#groveTexture = new DataTexture(gl, { width: BAMBOO_CELLS, height: BAMBOO_LAYERS.length, format: "rg16f" });
    this.#deviceTexture = new DataTexture(gl, { width: 2 + BAMBOO_RIPPLES, height: 1, format: "rgba16f", filter: "nearest" });
    this.#leafTexture = new DataTexture(gl, { width: 2, height: BAMBOO_MAX_LEAVES, format: "rgba16f", filter: "nearest" });
    for (const [layer, { depth, spacing }] of BAMBOO_LAYERS.entries()) {
      for (let cell = 0; cell < BAMBOO_CELLS; cell++) {
        this.#culms.push({ layer, depth, x: (cell - BAMBOO_CELLS / 2 + 0.5) * spacing, omega: 1, deflect: 0, rate: 0, gust: 0, push: 0 });
      }
    }
    for (let i = 0; i < BAMBOO_MAX_LEAVES; i++) {
      this.#leaves.push({ state: "free", near: false, x: 0, y: 0, z: 1, phase: 0, swingRate: 1, swing: 0, spin: 0, spinRate: 0, tilt: 0, size: 0, age: 0, u: 0, v: 0, turn: 0 });
    }
    for (let i = 0; i < BAMBOO_RIPPLES; i++) this.#ripples.push({ u: 0, v: 0, born: -1e4, strength: 0 });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const aspect = frame.aspect > 0 ? frame.aspect : 16 / 9;
    this.#readKnobs(frame);
    if (!this.#warm) {
      this.#prewarm(aspect);
      this.#warm = true;
    }
    this.#watchTriggers(frame.fired, aspect);
    this.#trackPointer(frame.pointer, frame.dt, aspect);

    const advance = Math.min(Math.max(0, frame.dt) * Math.max(0, frame.motion), 0.25);
    if (advance > 0) this.#advance(advance, aspect);
    if (advance > 0 || this.#dirty) {
      this.#pack(aspect);
      this.#groveTexture.upload(this.#groveData);
      this.#deviceTexture.upload(this.#deviceData);
      this.#leafTexture.upload(this.#leafData);
      this.#dirty = false;
    }
    this.#textures[0] = this.#groveTexture.texture;
    this.#textures[1] = this.#deviceTexture.texture;
    this.#textures[2] = this.#leafTexture.texture;
    return this.#textures;
  }

  dispose(): void {
    this.#groveTexture.dispose();
    this.#deviceTexture.dispose();
    this.#leafTexture.dispose();
  }

  #readKnobs(frame: SimFrame): void {
    const knobs = this.#knobs;
    this.#period = knobs.value(frame, "clock");
    this.#gustRate = knobs.value(frame, "gusts");
    this.#leafAmount = knobs.value(frame, "leaves");
    this.#wind = knobs.value(frame, "wind");
    const seed = Math.round(knobs.value(frame, "groveSeed"));
    if (seed !== this.#seed) {
      this.#seed = seed;
      this.#random = mulberry32(0x6b616b65 ^ Math.imul(seed + 1, 0x9e3779b1));
      for (const [i, culm] of this.#culms.entries()) {
        const cell = i % BAMBOO_CELLS;
        // Thick near stems a little slower; each its own pace, so they drift out of step.
        culm.omega = TAU * (0.2 + 0.16 * hash31(seed, culm.layer, cell)) * (0.88 + 0.04 * culm.layer);
      }
      this.#dirty = true;
    }
  }

  /**
   * Before the first frame: the grove has been swaying for a while with a gust half way across it,
   * two leaves are on their way down, and the tube is half full, so the first seconds already live.
   */
  #prewarm(aspect: number): void {
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    for (const culm of this.#culms) culm.deflect = heading * sway * 0.28;
    const mid = BAMBOO_LAYERS[2]?.depth ?? 6.4;
    const crossing = mid * SKEW_SIN - 0.15 * aspect * mid * SKEW_COS;
    this.#launchGust(crossing - windSpeed(this.#wind) * PREWARM_SECONDS, Number.NEGATIVE_INFINITY, 0.9);
    const steps = Math.round(PREWARM_SECONDS / GROVE_STEP);
    for (let s = 0; s < steps; s++) {
      this.#clock += GROVE_STEP;
      this.#scheduleGusts(aspect);
      this.#stepGrove(GROVE_STEP, aspect);
    }
    this.#fill = TIP_FILL * (0.7 + 0.12 * this.#random());
    this.#slosh = waterUp(this.#fill);
    this.#release(aspect, true);
    this.#release(aspect, false);
    for (let s = 0; s < 25; s++) this.#stepLeaves(0.1, aspect);
  }

  #watchTriggers(fired: readonly boolean[], aspect: number): void {
    const knobs = this.#knobs;
    if (fired[knobs.trigger("clock")] === true) this.#gushLeft = GUSH_LIMIT;
    if (fired[knobs.trigger("gusts")] === true) {
      // Felt even in still air: at least half a metre of sway at its crest.
      this.#launchGust(this.#gustStart(aspect), Number.NEGATIVE_INFINITY, Math.max(1, 0.55 / windSway(this.#wind)));
    }
    if (fired[knobs.trigger("leaves")] === true) {
      this.#release(aspect, true);
      this.#release(aspect, false);
      this.#release(aspect, false);
    }
  }

  /** Moving the pointer through the stems brushes them aside; a click sends a gust or rings the basin. */
  #trackPointer(pointer: PointerState, dt: number, aspect: number): void {
    if (!pointer.inside) {
      this.#pointerX = undefined;
      this.#pointerSpeed = 0;
      for (const culm of this.#culms) culm.push = 0;
      return;
    }
    const px = (pointer.x - 0.5) * aspect;
    const py = pointer.y;
    if (this.#pointerX !== undefined && dt > 0) {
      const speed = Math.min(BRUSH_MAX, Math.max(-BRUSH_MAX, (px - this.#pointerX) / dt));
      this.#pointerSpeed += (speed - this.#pointerSpeed) * (1 - Math.exp(-dt / BRUSH_SMOOTH));
    }
    this.#pointerX = px;
    for (const culm of this.#culms) {
      const base = BAMBOO_HORIZON - BAMBOO_EYE / culm.depth;
      const off = (culm.x / culm.depth - px) / BRUSH_REACH;
      culm.push = py > base && off * off < 9 ? BRUSH_GAIN * this.#pointerSpeed * Math.exp(-off * off) : 0;
    }
    if (pointer.pressed) this.#press(px, py, aspect);
  }

  #press(px: number, py: number, aspect: number): void {
    const k = bambooDeviceScale(aspect);
    const u = (px - (aspect / 2 + k * BAMBOO_BASIN.x)) / (k * BAMBOO_BASIN.rx);
    const v = (py - k * BAMBOO_BASIN.y) / (k * BAMBOO_BASIN.ry);
    if (u * u + 0.25 * v * v < 1.1) {
      this.#addRipple(u, Math.min(0.9, Math.max(-0.9, v)), 0.8);
      return;
    }
    // A breath of wind from where the click landed, downwind only.
    const heading = this.#wind < 0 ? -1 : 1;
    const z = BAMBOO_LAYERS[2]?.depth ?? 6.4;
    const at = heading * px * z * SKEW_COS + z * SKEW_SIN;
    this.#launchGust(at, at, Math.max(0.9, 0.5 / windSway(this.#wind)));
  }

  /** Front position just upwind of everything in view. */
  #gustStart(aspect: number): number {
    const far = BAMBOO_LAYERS[BAMBOO_LAYERS.length - 1]?.depth ?? 17;
    return far * (SKEW_SIN - (aspect / 2 + 0.3) * SKEW_COS) - 2;
  }

  #launchGust(from: number, origin: number, strength: number): void {
    const tail = 4 + 3 * this.#random();
    this.#gusts.push({
      born: this.#clock,
      from,
      origin,
      heading: this.#wind < 0 ? -1 : 1,
      speed: windSpeed(this.#wind),
      gain: strength / pulsePeak(tail),
      tail,
    });
  }

  #scheduleGusts(aspect: number): void {
    const rate = this.#gustRate;
    if (rate <= 0) {
      this.#nextGust = Number.POSITIVE_INFINITY;
    } else {
      // Mean wait from 18 s (rare) down to 5 s (restless).
      const mean = 18 - 13 * Math.min(1, rate);
      if (!Number.isFinite(this.#nextGust)) this.#nextGust = this.#clock + this.#wait(mean);
      if (this.#clock >= this.#nextGust) {
        this.#launchGust(this.#gustStart(aspect), Number.NEGATIVE_INFINITY, 0.7 + 0.3 * this.#random());
        this.#nextGust = this.#clock + this.#wait(mean);
      }
    }
    // Retire gusts whose tails have left the far side of the view.
    const far = BAMBOO_LAYERS[BAMBOO_LAYERS.length - 1]?.depth ?? 17;
    const end = far * (SKEW_SIN + (aspect / 2 + 0.3) * SKEW_COS);
    for (let i = this.#gusts.length - 1; i >= 0; i--) {
      const gust = this.#gusts[i];
      if (gust && gust.from + gust.speed * (this.#clock - gust.born) - end > 8 * gust.tail) this.#gusts.splice(i, 1);
    }
  }

  /** The wait until the next gust: exponential about `mean` seconds, kept between 0.35x and 2.5x. */
  #wait(mean: number): number {
    return mean * Math.min(2.5, Math.max(0.35, -Math.log(1 - this.#random())));
  }

  /** The gusts' push at (x, z) in the grove: signed toward +x. */
  #gustAt(x: number, z: number): number {
    let sum = 0;
    for (const gust of this.#gusts) {
      const at = gust.heading * x * SKEW_COS + z * SKEW_SIN;
      if (at < gust.origin) continue;
      const xi = gust.from + gust.speed * (this.#clock - gust.born) - at;
      if (xi <= 0) continue;
      sum += gust.heading * gust.gain * (1 - Math.exp(-xi / GUST_RISE)) * Math.exp(-xi / gust.tail);
    }
    return sum;
  }

  #advance(total: number, aspect: number): void {
    const groveSteps = Math.ceil(total / GROVE_STEP);
    const h = total / groveSteps;
    for (let s = 0; s < groveSteps; s++) {
      this.#clock += h;
      this.#scheduleGusts(aspect);
      this.#stepGrove(h, aspect);
    }

    // The tube: steady inflow from the spout at the period knob's pace, plus any gush.
    const steady = this.#period > 0 ? TIP_FILL / Math.max(this.#period - CYCLE_OVERHEAD, 3) : 0;
    const tubeSteps = Math.ceil(total / TUBE_STEP);
    const ht = total / tubeSteps;
    let poured = 0;
    for (let s = 0; s < tubeSteps; s++) {
      const gushing = this.#gushLeft > 0;
      if (gushing) {
        this.#gushLeft -= ht;
        if (this.#angle < BAMBOO_TUBE.rest - 0.15) this.#gushLeft = 0;
      }
      poured += this.#stepTube(ht, steady + (gushing ? GUSH_RATE : 0), aspect);
    }
    this.#outflow = poured / total;
    if (this.#outflow > 0.3 && this.#clock - this.#lastPourRipple > RIPPLE_EVERY) {
      this.#lastPourRipple = this.#clock;
      const landing = (bambooPourLanding(this.#angle) - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
      this.#addRipple(landing + 0.08 * (this.#random() - 0.5), 0.3 * (this.#random() - 0.5), 0.4 + 0.6 * Math.min(1, this.#outflow / POUR_FULL));
    }

    // Leaves let go: a few in still air, many more in a gust.
    const amount = this.#leafAmount;
    if (amount > 0) {
      const chance = amount * (RELEASE_CALM + RELEASE_GUST * this.#gustMean) * total;
      if (this.#random() < chance) this.#release(aspect, this.#random() < NEAR_SHARE);
    }
    this.#stepLeaves(total, aspect);
  }

  #stepGrove(h: number, aspect: number): void {
    const t = this.#clock;
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    const speed = windSpeed(this.#wind);
    const half = aspect / 2;
    let gustSum = 0;
    let counted = 0;
    for (const culm of this.#culms) {
      const along = heading * culm.x * SKEW_COS + culm.depth * SKEW_SIN;
      const breeze = 0.28 + 0.12 * Math.sin(BREEZE_LONG * (along - speed * t)) + 0.08 * Math.sin(BREEZE_SHORT * (along - 0.8 * speed * t) + 1.7);
      const gust = this.#gustAt(culm.x, culm.depth);
      const target = sway * (heading * breeze + gust) + culm.push;
      const w = culm.omega;
      culm.rate += (w * w * (target - culm.deflect) - 2 * CULM_DAMPING * w * culm.rate) * h;
      culm.deflect += culm.rate * h;
      culm.gust = Math.min(1, Math.abs(gust));
      if (culm.layer >= 1 && culm.layer <= 3 && Math.abs(culm.x / culm.depth) < half) {
        gustSum += culm.gust;
        counted++;
      }
    }
    this.#gustMean = counted > 0 ? gustSum / counted : 0;
  }

  /** One step of the tube; returns the fill poured out over it. */
  #stepTube(h: number, inflow: number, aspect: number): number {
    const mass = WATER_MASS * this.#fill;
    const upright = smoothstep(-0.2, 0.25, this.#angle);
    const settle = waterDown(this.#fill) + (waterUp(this.#fill) - waterDown(this.#fill)) * upright;
    this.#slosh += (settle - this.#slosh) * (1 - Math.exp(-h / SLOSH_TIME));
    const inertia = TUBE_INERTIA + mass * this.#slosh * this.#slosh;
    const torque = -GRAVITY * Math.cos(this.#angle) * (TUBE_MOMENT + mass * this.#slosh) - (PIVOT_DAMPING + WATER_DRAG * mass) * this.#spin;
    this.#spin += (torque / inertia) * h;
    this.#angle += this.#spin * h;

    if (this.#angle >= BAMBOO_TUBE.rest) {
      // The closed end comes down on the stone.
      this.#angle = BAMBOO_TUBE.rest;
      if (this.#spin > CLACK_MIN) {
        this.#clack(Math.min(1, this.#spin / CLACK_FULL), aspect);
        this.#spin *= -RESTITUTION;
      } else if (this.#spin > 0) {
        this.#spin = 0;
      }
    } else if (this.#angle <= BAMBOO_TUBE.low) {
      this.#angle = BAMBOO_TUBE.low;
      if (this.#spin < 0) this.#spin *= -SOFT_RESTITUTION;
    }

    // The mouth holds less as it dips; what it cannot hold pours out.
    this.#fill = Math.min(1, this.#fill + inflow * h);
    const holds = smoothstep(-0.12, 0.22, this.#angle);
    const out = POUR_RATE * Math.max(this.#fill - holds, 0) * h;
    this.#fill -= out;
    return out;
  }

  #clack(strength: number, aspect: number): void {
    this.#clackAt = this.#clock;
    this.#clackStrength = strength;
    // The knock carries through the stones: a soft ring across the basin.
    this.#addRipple(0, 0, 0.45 * strength);
    // A full clack sometimes startles a leaf above the basin into letting go.
    if (strength > 0.6 && this.#leafAmount > 0 && this.#random() < 0.3 + 0.6 * this.#leafAmount) this.#release(aspect, true);
  }

  #addRipple(u: number, v: number, strength: number): void {
    const ripple = this.#ripples[this.#nextRipple];
    if (!ripple) return;
    ripple.u = u;
    ripple.v = v;
    ripple.born = this.#clock;
    ripple.strength = strength;
    this.#nextRipple = (this.#nextRipple + 1) % BAMBOO_RIPPLES;
  }

  /** A leaf lets go of the canopy: above the basin (near) or anywhere in the grove. */
  #release(aspect: number, near: boolean): void {
    let leaf: Leaf | undefined;
    for (const candidate of this.#leaves) {
      if (candidate.state === "free") {
        leaf = candidate;
        break;
      }
    }
    if (!leaf) return;
    const random = this.#random;
    const heading = this.#wind < 0 ? -1 : 1;
    const right = aspect / 2;
    const z = near ? BAMBOO_DEVICE_DEPTH : LEAF_NEAR * (LEAF_FAR / LEAF_NEAR) ** random();
    const top = 0.88 + 0.14 * random();
    leaf.y = BAMBOO_EYE + (top - BAMBOO_HORIZON) * z;
    leaf.z = z;
    leaf.near = near;
    let across: number;
    if (near) {
      // Aim upwind of the basin by the drift the fall will bring, give or take.
      const k = bambooDeviceScale(aspect);
      const water = BAMBOO_EYE + (k * BAMBOO_BASIN.y - BAMBOO_HORIZON) * z;
      const fall = (leaf.y - water) / (LEAF_SINK + (LEAF_DIVE * 2) / Math.PI);
      const drift = (heading * (0.1 + 0.35 * windSway(this.#wind) * 0.5) * fall) / z;
      across = right + k * BAMBOO_BASIN.x - drift + (random() - 0.5) * 0.14 * k;
    } else {
      across = (random() * 2 - 1) * (right + 0.1) - heading * 0.1;
    }
    leaf.x = across * z;
    leaf.phase = random() * TAU;
    leaf.swingRate = TAU / (2.2 + 1.2 * random());
    leaf.swing = 0.12 + 0.1 * random();
    leaf.spin = random() * TAU;
    leaf.spinRate = (0.5 + 0.8 * random()) * (random() < 0.5 ? -1 : 1);
    leaf.tilt = (random() - 0.5) * 0.6;
    leaf.size = near ? 0.075 + 0.03 * random() : 0.1 + 0.06 * random();
    leaf.age = 0;
    leaf.state = "falling";
  }

  #stepLeaves(h: number, aspect: number): void {
    const heading = this.#wind < 0 ? -1 : 1;
    const sway = windSway(this.#wind);
    const right = aspect / 2;
    const k = bambooDeviceScale(aspect);
    const pouring = Math.min(1, this.#outflow / POUR_FULL);
    const landing = (bambooPourLanding(this.#angle) - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
    for (const leaf of this.#leaves) {
      switch (leaf.state) {
        case "free":
          break;
        case "falling": {
          leaf.age += h;
          // A falling leaf swings side to side like a pendulum, diving through the middle of each
          // swing and stalling at its ends, while the wind carries it along.
          const gust = Math.abs(this.#gustAt(leaf.x, leaf.z));
          leaf.phase += leaf.swingRate * h;
          const c = Math.cos(leaf.phase);
          const drift = heading * (0.1 + 0.35 * sway * (0.4 + gust));
          leaf.x += (drift + leaf.swing * leaf.swingRate * c) * h;
          leaf.y -= (LEAF_SINK + LEAF_DIVE * Math.abs(c)) * h;
          leaf.spin += leaf.spinRate * h;
          const sx = leaf.x / leaf.z;
          const sy = BAMBOO_HORIZON + (leaf.y - BAMBOO_EYE) / leaf.z;
          if (Math.abs(sx) > right + 0.3) {
            leaf.state = "free";
          } else if (leaf.near) {
            if (sy / k <= BAMBOO_BASIN.y + 0.004) {
              const u = ((sx - right) / k - BAMBOO_BASIN.x) / BAMBOO_BASIN.rx;
              if (Math.abs(u) < 0.8) {
                leaf.state = "floating";
                leaf.age = 0;
                leaf.u = u;
                leaf.v = (this.#random() - 0.5) * 0.7;
                leaf.turn = leaf.tilt + 0.6 * Math.sin(leaf.phase);
                this.#addRipple(leaf.u, leaf.v, 0.35);
                this.#sinkOldest();
              } else if (sy < -0.05) {
                leaf.state = "free";
              }
            }
          } else if (leaf.y <= 0) {
            leaf.y = 0;
            leaf.state = "resting";
            leaf.age = 0;
          }
          break;
        }
        case "resting":
          leaf.age += h;
          if (leaf.age > LEAF_REST + LEAF_FADE) leaf.state = "free";
          break;
        case "floating": {
          leaf.age += h;
          // A slow turn about the basin; the pour pushes it away from where the water lands.
          let du = -0.05 * leaf.v;
          let dv = 0.05 * leaf.u;
          if (pouring > 0) {
            const ox = leaf.u - landing;
            const oy = leaf.v;
            const d = Math.max(Math.hypot(ox, oy), 0.1);
            du += (0.3 * pouring * ox) / d;
            dv += (0.3 * pouring * oy) / d;
          }
          leaf.u += du * h;
          leaf.v += dv * h;
          const r = Math.hypot(leaf.u, leaf.v);
          if (r > 0.75) {
            leaf.u *= 0.75 / r;
            leaf.v *= 0.75 / r;
          }
          leaf.turn += 0.04 * h;
          if (leaf.age > FLOAT_LIFE + FLOAT_FADE) leaf.state = "free";
          break;
        }
        default: {
          const unreachable: never = leaf.state;
          throw new BambooSimError(`bamboo: unknown leaf state ${String(unreachable)}`);
        }
      }
    }
  }

  /** Too many leaves on the water: the oldest starts to sink. */
  #sinkOldest(): void {
    let floating = 0;
    let oldest: Leaf | undefined;
    for (const leaf of this.#leaves) {
      if (leaf.state !== "floating" || leaf.age >= FLOAT_LIFE) continue;
      floating++;
      if (!oldest || leaf.age > oldest.age) oldest = leaf;
    }
    if (floating > MAX_FLOATING && oldest) oldest.age = FLOAT_LIFE;
  }

  #pack(aspect: number): void {
    const grove = this.#groveData;
    for (let i = 0; i < this.#culms.length; i++) {
      const culm = this.#culms[i];
      if (!culm) continue;
      grove[i * 2] = culm.deflect;
      grove[i * 2 + 1] = culm.gust;
    }

    const device = this.#deviceData;
    device[0] = this.#angle;
    device[1] = this.#fill / TIP_FILL;
    device[2] = Math.min(1, this.#outflow / POUR_FULL);
    device[3] = (this.#period > 0 ? 1 : 0) + (this.#gushLeft > 0 ? 1.5 : 0);
    device[4] = Math.min(this.#clock - this.#clackAt, 60);
    device[5] = this.#clackStrength;
    device[6] = this.#gustMean;
    device[7] = 0;
    for (let i = 0; i < this.#ripples.length; i++) {
      const ripple = this.#ripples[i];
      if (!ripple) continue;
      const o = 8 + i * 4;
      device[o] = ripple.u;
      device[o + 1] = ripple.v;
      device[o + 2] = Math.min(this.#clock - ripple.born, 30);
      device[o + 3] = ripple.strength;
    }

    const leaves = this.#leafData;
    const k = bambooDeviceScale(aspect);
    for (let i = 0; i < this.#leaves.length; i++) {
      const leaf = this.#leaves[i];
      if (!leaf) continue;
      const o = i * 8;
      switch (leaf.state) {
        case "free":
          leaves.fill(0, o, o + 8);
          break;
        case "falling":
        case "resting": {
          const falling = leaf.state === "falling";
          leaves[o] = leaf.x / leaf.z;
          leaves[o + 1] = BAMBOO_HORIZON + (leaf.y - BAMBOO_EYE) / leaf.z;
          leaves[o + 2] = falling ? leaf.tilt + 0.6 * Math.sin(leaf.phase) : leaf.tilt;
          leaves[o + 3] = leaf.size / leaf.z;
          // Lying on the ground it is seen nearly edge-on; falling it turns about its long axis.
          leaves[o + 4] = falling ? 0.35 + 0.65 * Math.abs(Math.cos(leaf.spin)) : 0.45;
          leaves[o + 5] = leaf.z;
          leaves[o + 6] = falling ? Math.min(1, leaf.age / LEAF_FADE_IN) : 1 - smoothstep(LEAF_REST, LEAF_REST + LEAF_FADE, leaf.age);
          leaves[o + 7] = 1;
          break;
        }
        case "floating":
          leaves[o] = leaf.u;
          leaves[o + 1] = leaf.v;
          leaves[o + 2] = leaf.turn;
          leaves[o + 3] = Math.min(leaf.size / (BAMBOO_DEVICE_DEPTH * k * BAMBOO_BASIN.rx), 0.6);
          leaves[o + 4] = 1;
          leaves[o + 5] = leaf.z;
          leaves[o + 6] = 1 - smoothstep(FLOAT_LIFE, FLOAT_LIFE + FLOAT_FADE, leaf.age);
          leaves[o + 7] = 2;
          break;
        default: {
          const unreachable: never = leaf.state;
          throw new BambooSimError(`bamboo: unknown leaf state ${String(unreachable)}`);
        }
      }
    }
  }
}

/** The grove's simulation for a scene whose knobs are `params` (looked up by key). */
export function bambooSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new BambooSim(gl, params);
}
