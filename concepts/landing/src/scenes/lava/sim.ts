// The lava lamp's wax, on the CPU. Each lamp holds up to LAVA_MAX parcels of wax: soft discs with a
// temperature, in the glass's own units (gy 0 at the bottom of the liquid .. 1 under the cap, gx
// across, the same scale). The shader (shader.ts) draws their metaball surface, so parcels that
// touch read as one blob, a pair pulling apart draws a neck, and a neck that stretches too far
// snaps.
//
// The physics, per parcel:
//   heat     the coil under the glass heats the wax resting on it; everywhere else the liquid
//            (warmer low down than under the cap, but below floating everywhere, and only once the
//            lamp has warmed up) slowly cools it, small parcels faster; parcels in touch share heat;
//            your hand on the glass warms what is under it
//   buoyancy warm wax (T above NEUTRAL) is lighter than the liquid and rises, cool wax sinks; wax
//            clings to the coil until it is well past floating, so it leaves with heat to spare
//   drag     a viscous liquid: velocities relax toward the liquid's own slow convection (up the
//            middle, down the sides); solid (cold) wax hardly moves at all
//   bonds    neighbours repel inside their rest distance and attract beyond it, up to a break
//            distance where the pull fades to nothing: a warm parcel tearing away from the heap
//            draws out a neck, then lets go; cold wax binds harder; bonded parcels damp their
//            relative motion (a blob moves as one) and share heat; warm and cool parcels slide
//            through one another (they pass at different depths in the glass) and barely hold on
// So the heap on the coil warms, swells and sends up blobs one at a time; each cools against the
// cap and sinks, merges with the heap and warms again. The Manifold M draws a dozen parcels onto its
// strokes for a few seconds while the rest flows round it. Lamps run on fixed steps (deterministic
// for a seed).
//
// The scene's passage (LAVA_PASSAGE; the shader needs no change, it draws whatever the wax does). A sim
// built while the scene comes in skips the prewarm: the wax lies in a cool, solid heap at the bottom
// of a lit lamp, warms toward the liquid's temperature while the coil's heating is boosted, and the
// heap on the coil tears its first blob free and sends it up; the boost eases out before the entrance
// ends and the lamp runs on as ever. On the way out the coil lets go, the wax cools, grows heavy and
// sinks, merging back into the pool at the bottom, and any M lets go. At rest none of it runs.
//
// The wax's body (the viscosity knob, sims/material.ts conventions): the classic wax at the knob's
// middle, silky to the left and chunky to the right, on the same parcels. Silky wax holds together
// more loosely but further (cohesion, the bonds' break distance), slides through itself (the bonds'
// viscosity), trails long tails and merges smoothly (the shader's teardrop stretch and metaball
// reach); chunky wax binds hard, tears off short, moves as one lump and keeps its knobbly parcels.
//
// Units: glass units (the liquid is 1 tall), seconds of scene time × motion.
//
// Textures:
//   uSim0  rgba16f, LAVA_MAX × 4, nearest. Row 0: lamp A's parcels (x, y, radius, temperature);
//          row 1: (vx, vy, M glow 0..1, 0). Rows 2 and 3: lamp B (the twin), the same.
//   uSim1  rg16f, LAVA_GRID_X × 2·LAVA_GRID_Y, linear: a coarse picture of the wax over the glass
//          (gx in ±LAVA_GRID_HALF, gy 0..1), lamp A below lamp B: r how much wax (soft), g how much
//          of the bulb's light still gets up through the wax below.
//   uSim2  rgba16f, 3 × 1, nearest: per lamp (texels 0, 1), the parcels in use, the bulb 0..1, the
//          warm-up 0..1 (cold liquid is cloudy) and the share of the glass the wax covers in the
//          picture; texel 2, the wax's body for the shader: its metaball reach and teardrop stretch
//          (× the classic wax's), 0, 0.
import { KnobReader, type ParamDef } from "../../params.ts";
import { materialAt } from "../../sims/material.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

// ---- the lamp's shape and the room's layout, shared with the shader -----------------------------

/** The lamp in lamp units: 1 tall from the foot of its base to the top of its cap. */
const SHAPE = {
  /** Heights of the metal base, the glass between base and cap, and the cap. */
  base: 0.3,
  glass: 0.58,
  cap: 0.12,
  /** The base's radius at its foot and at its collar, where the glass sits. */
  foot: 0.165,
  collar: 0.09,
  /** The glass's outer radius at the collar, at its widest (and where, up its height), and under the cap. */
  glassBottom: 0.088,
  glassWide: 0.148,
  wideAt: 0.2,
  glassTop: 0.066,
  /** The glass's thickness. */
  wall: 0.006,
  /** The cap's radius at its rim and its top. */
  capBottom: 0.074,
  capTop: 0.034,
} as const;

/** Where each lamp stands: share of the frame's width, foot height and lamp height (frame heights). */
const LAMPS = [
  { x: 0.655, foot: 0.118, size: 0.76 },
  { x: 0.85, foot: 0.162, size: 0.54 },
] as const;

/** Parcels per lamp at most, and the coarse wax picture's texels. */
export const LAVA_MAX = 28;
export const LAVA_GRID_X = 24;
export const LAVA_GRID_Y = 48;
/** Half the width of glass the coarse picture covers (glass units). */
const GRID_HALF = 0.27;
/** A parcel's metaball reaches this many radii; an isolated parcel's surface sits at its radius. */
const REACH = 1.9;
const ISO = (1 - 1 / (REACH * REACH)) ** 3;
/** The liquid magnifies the middle of the glass: what shows at the middle is this much nearer the axis. */
const LENS = 0.8;
/** The teardrop: how far a parcel's tail stretches per unit of speed (glass units/s). */
const STRETCH = 7;
/** The Manifold M the wax gathers into: centre and height in glass units. */
const MARK_X = 0;
const MARK_Y = 0.43;
const MARK_SIZE = 0.3;

const glslFloat = (value: number): string => {
  const text = value.toFixed(5);
  return text.includes(".") ? text : `${text}.0`;
};

/** The shape and layout as GLSL, for the scene's shader. */
export const lavaLayoutGlsl = `
#define LAVA_MAX ${LAVA_MAX}
#define LAVA_GRID_X ${glslFloat(LAVA_GRID_X)}
#define LAVA_GRID_Y ${glslFloat(LAVA_GRID_Y)}
#define LAVA_GRID_HALF ${glslFloat(GRID_HALF)}
#define LAVA_REACH ${glslFloat(REACH)}
#define LAVA_ISO ${glslFloat(ISO)}
#define LAVA_LENS ${glslFloat(LENS)}
#define LAVA_STRETCH ${glslFloat(STRETCH)}
#define LAVA_BASE_H ${glslFloat(SHAPE.base)}
#define LAVA_GLASS_H ${glslFloat(SHAPE.glass)}
#define LAVA_CAP_H ${glslFloat(SHAPE.cap)}
#define LAVA_FOOT_R ${glslFloat(SHAPE.foot)}
#define LAVA_COLLAR_R ${glslFloat(SHAPE.collar)}
#define LAVA_GLASS_BOTTOM ${glslFloat(SHAPE.glassBottom)}
#define LAVA_GLASS_WIDE ${glslFloat(SHAPE.glassWide)}
#define LAVA_WIDE_AT ${glslFloat(SHAPE.wideAt)}
#define LAVA_GLASS_TOP ${glslFloat(SHAPE.glassTop)}
#define LAVA_WALL ${glslFloat(SHAPE.wall)}
#define LAVA_CAP_BOTTOM ${glslFloat(SHAPE.capBottom)}
#define LAVA_CAP_TOP ${glslFloat(SHAPE.capTop)}
#define LAVA_A_X ${glslFloat(LAMPS[0].x)}
#define LAVA_A_FOOT ${glslFloat(LAMPS[0].foot)}
#define LAVA_A_SIZE ${glslFloat(LAMPS[0].size)}
#define LAVA_B_X ${glslFloat(LAMPS[1].x)}
#define LAVA_B_FOOT ${glslFloat(LAMPS[1].foot)}
#define LAVA_B_SIZE ${glslFloat(LAMPS[1].size)}

// The glass's outer radius (lamp units) at s, 0 at the collar .. 1 under the cap: a rounded
// shoulder low down, then a long straight taper.
float lavaGlassR(float s) {
  float t = clamp(s, 0.0, 1.0);
  float a = 1.0 - t / LAVA_WIDE_AT;
  float low = LAVA_GLASS_BOTTOM + (LAVA_GLASS_WIDE - LAVA_GLASS_BOTTOM) * (1.0 - a * a);
  float high = LAVA_GLASS_WIDE + (LAVA_GLASS_TOP - LAVA_GLASS_WIDE) * (t - LAVA_WIDE_AT) / (1.0 - LAVA_WIDE_AT);
  return t < LAVA_WIDE_AT ? low : high;
}
`;

// ---- tuning ------------------------------------------------------------------------------------

/** Fixed simulation step (s), the most steps one frame may take, and the prewarm: seconds of lamp
 * time run before the first frame so the flow has forgotten how it started, in coarser steps (the
 * forces are soft enough for them) to keep both lamps' prewarm near 50 ms. */
const STEP = 1 / 60;
const MAX_STEPS = 8;
const PREWARM = 75;
const PREWARM_STEP = 1 / 30;
/** Settling a fresh cold heap before the first frame (s). */
const SETTLE = 4;
/** A parcel's mean radius (glass units) and the spread of sizes either side (share). */
const R0 = 0.047;
const SIZE_SPREAD = 0.28;
/** Parcels for the wax knob at 0 and 1, and the twin's share of them. */
const COUNT_MIN = 9;
const COUNT_MAX = 23;
const TWIN_SHARE = 0.7;
/** Time constant of a parcel growing in or melting away when the amount of wax changes (s). */
const GROW_TAU = 1.5;

/** Temperatures: 0 is the cold room; wax at NEUTRAL floats, warmer rises, cooler sinks. */
const NEUTRAL = 0.5;
/** Below SOLID_LO the wax is solid, above SOLID_HI it flows. */
const SOLID_LO = 0.1;
const SOLID_HI = 0.2;
/** The warm liquid's temperature: LIQ_TOP under the cap plus LIQ_BOTTOM · e^(−LIQ_FALL · gy). It
 * stays well below NEUTRAL everywhere, so wax left to the liquid always cools and sinks, and the heap
 * lies heavy on the coil: only the coil lifts wax, one warm blob at a time, and nothing can hover for
 * ever at a height where the liquid would hold it neutral. */
const LIQ_TOP = 0.22;
const LIQ_BOTTOM = 0.12;
const LIQ_FALL = 3;
/** Heat exchange with the liquid (1/s for a parcel of radius R0; small ones faster). */
const EXCHANGE = 1 / 30;
/** The coil: how close to it a parcel's underside must rest to touch it (glass units), its
 * half-width, its pull toward the coil's temperature (1/s) and that temperature at bulb heat 0 and
 * 1. Wax clings to the coil until it is RELEASE warm, well past floating: it leaves with heat to
 * spare and rises a long way, instead of bobbing just over the coil. */
const COIL_REACH = 0.035;
const COIL_HALF = 0.055;
const COIL_RATE = 0.18;
const COIL_T0 = 1.25;
const COIL_T1 = 0.15;
const RELEASE = 0.85;
/** The cap: wax pressed up under it (its top within CAP_REACH, glass units) loses heat to the air
 * through the metal (1/s toward CAP_T), so each blob that arrives turns round on its own instead of
 * pooling under the cap with the next ones into one heavy mass. */
const CAP_REACH = 0.06;
const CAP_RATE = 0.25;
const CAP_T = 0.12;
/** Warm-up time constant from cold at the middle heat (s). */
const WARM_TAU = 45;
/** The bulb fading out and back in for a cold restart (time constants, s of scene clock). */
const BULB_OFF = 0.08;
const BULB_ON = 0.45;

/** Buoyancy: acceleration per unit of temperature above NEUTRAL (glass units/s²). */
const BUOYANCY = 0.45;
/** Viscous drag toward the liquid's flow (1/s for a parcel of radius R0) and its multiple when solid. */
const DRAG = 1.8;
const SOLID_DRAG = 12;
/** The liquid's convection, up the middle and down the sides (glass units/s). */
const FLOW = 0.005;
/** Bonds, in shares of the two radii: rest and break distance; repulsion and cohesion peaks
 * (glass units/s²), cold wax's extra bond, relative-velocity damping (1/s) and heat sharing (1/s). */
const REST = 0.7;
const BREAK = 1.05;
const REPEL = 1;
const COHESION = 0.035;
const COLD_BOND = 2;
const VISCOSITY = 0.3;
const CONDUCT = 0.006;
/** Parcels this much apart in temperature (from PASS_LO to PASS_HI) lose PASS of their repulsion
 * and viscosity (warm and cool wax slide past each other) and TEAR of their cohesion. */
const PASS = 0.85;
const TEAR = 0.6;
const PASS_LO = 0.08;
const PASS_HI = 0.3;
/** The glass pushing wax back (1/s²); how far a parcel may press into it (share of its radius). */
const WALL = 40;
const WALL_GIVE = 0.15;

/**
 * The wax's body, each property × the classic wax's (the constants above): cohesion (COHESION),
 * reach (how far a neck draws out before it snaps, BREAK), viscosity (VISCOSITY: bonded parcels
 * moving as one), stretch (the shader's teardrop, LAVA_STRETCH) and blend (the shader's metaball
 * reach, LAVA_REACH: high merges parcels into smooth blobs, low leaves each a lump of its own).
 */
interface WaxBody {
  cohesion: number;
  reach: number;
  viscosity: number;
  stretch: number;
  blend: number;
}
/** Silky, runny wax: loose and far-reaching bonds, slipping through itself, long tails, smooth merges. */
const SILKY: Readonly<WaxBody> = { cohesion: 0.35, reach: 1.3, viscosity: 0.15, stretch: 1.7, blend: 1.15 };
/** The classic wax every constant above was tuned on, at the knob's middle. */
const CLASSIC: Readonly<WaxBody> = { cohesion: 1, reach: 1, viscosity: 1, stretch: 1, blend: 1 };
/** Chunky, stiff wax: hard, short bonds that snap early, moving in lumps that keep their knobbly parcels. */
const CHUNKY: Readonly<WaxBody> = { cohesion: 3, reach: 0.9, viscosity: 6, stretch: 0.45, blend: 0.86 };

/** Your hand on the glass: its warmth (1/s toward HAND_T) and reach (glass units). */
const HAND_RATE = 0.9;
const HAND_T = 1.3;
const HAND_REACH = 0.1;

/** The M: parcels gathering into it, seconds to gather, hold and let go; its pull (1/s²) and damping
 * (1/s); how much harder than usual it pushes other wax away (so blobs flow round it, not through);
 * seconds between Ms at "how often" 0 and 1, and before the first one once it is switched on. */
const MARK_PARCELS = 13;
const MARK_GATHER = 4.5;
const MARK_HOLD = 6;
const MARK_RELEASE = 4;
const MARK_PULL = 2.5;
const MARK_DAMP = 3.2;
const MARK_SHIELD = 3;
const MARK_EVERY_RARE = 150;
const MARK_EVERY_OFTEN = 40;
const MARK_FIRST = 0.5;

/** The coarse wax picture: a parcel's soft footprint (radii), and how much light a unit of wax stops. */
const GRID_REACH = 1.5;
const GRID_KAPPA = 7;

// ---- the passage -------------------------------------------------------------------------------

/** Seconds the entrance and the exit take (SceneDef.passage). Both play in the simulation: the
 * shader draws whatever the wax does. */
export const LAVA_PASSAGE = { enter: 3, exit: 1.8 } as const;
/** Entrance: the pooled wax starts cool and solid at this temperature (plus a little spread); the
 * lamp is lit and its liquid clear. It then warms (every parcel toward the liquid's temperature,
 * pull 1/s, between these seconds, easing out again later) while the coil's heating is multiplied
 * (up to 1 + ENTER_COIL, between these seconds, easing out later), so the heap on the coil gets hot
 * enough to tear a first blob free within the entrance. The lamp runs quicker through it. */
const ENTER_T0 = 0.1;
const ENTER_T_SPREAD = 0.02;
const ENTER_WARM = 2;
const ENTER_WARM_IN = [0.3, 0.75] as const;
const ENTER_WARM_OUT = [1.8, 2.4] as const;
const ENTER_COIL = 7;
const ENTER_COIL_IN = [0.35, 0.8] as const;
const ENTER_COIL_OUT = [2.2, 3] as const;
const ENTER_PACE = 0.9;
/** Exit: the coil lets go (over this many seconds), every parcel cools toward EXIT_T (1/s at most)
 * and the wax grows heavy: between these seconds it falls at up to EXIT_FALL (glass units/s), its
 * drag rising by EXIT_DRAG times that share so it gets up to speed, slowing toward the pool (between
 * these heights). The M lets go at once. The lamp runs a little quicker through it. */
const EXIT_T = 0.27;
const EXIT_COOL = 3.5;
const EXIT_COIL_OFF = 0.3;
const EXIT_FALL = 0.8;
const EXIT_FALL_IN = [0.05, 0.45] as const;
const EXIT_DRAG = 2;
const EXIT_FALL_POOL = [0.02, 0.4] as const;
const EXIT_PACE = 0.4;

// ---- helpers -----------------------------------------------------------------------------------

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Xorshift32 stream in [0, 1). */
function lavaRandom(seed: number): () => number {
  let s = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** The glass's outer radius (lamp units) at s, as lavaGlassR in the shader. */
function glassRadius(s: number): number {
  const t = clamp(s, 0, 1);
  if (t < SHAPE.wideAt) {
    const a = 1 - t / SHAPE.wideAt;
    return SHAPE.glassBottom + (SHAPE.glassWide - SHAPE.glassBottom) * (1 - a * a);
  }
  return SHAPE.glassWide + ((SHAPE.glassTop - SHAPE.glassWide) * (t - SHAPE.wideAt)) / (1 - SHAPE.wideAt);
}

/** The liquid's half-width at glass height gy (glass units). */
function innerRadius(gy: number): number {
  return (glassRadius(gy) - SHAPE.wall) / SHAPE.glass;
}

/** The liquid's area in the picture (glass units²): what the wax's share of the glass is out of. */
const GLASS_AREA = Array.from({ length: 64 }, (_, j) => (2 * innerRadius((j + 0.5) / 64)) / 64).reduce((sum, a) => sum + a, 0);

/** The warm liquid's temperature at height gy, `warm` of the way through its warm-up. */
function liquidTemperature(gy: number, warm: number): number {
  const y = clamp(gy, 0, 1);
  return (LIQ_TOP + LIQ_BOTTOM * Math.exp(-LIQ_FALL * y)) * warm ** (1 + 1.5 * y);
}

/** The Manifold M as target points (glass units): its five corners and `count - 5` more along its strokes. */
function markTargets(count: number): { x: number; y: number }[] {
  const corners = [[-0.47, -0.5], [-0.47, 0.5], [0, -0.08], [0.47, 0.5], [0.47, -0.5]] as const;
  const strokes = corners.slice(0, 4).map((a, k) => {
    const b = corners[k + 1] ?? a;
    return { a, b, length: Math.hypot(b[0] - a[0], b[1] - a[1]) };
  });
  const total = strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  const spare = Math.max(0, count - corners.length);
  // Largest remainder: each stroke gets its share of the in-between points.
  const shares = strokes.map((stroke) => (spare * stroke.length) / total);
  const inner = shares.map(Math.floor);
  let left = spare - inner.reduce((sum, n) => sum + n, 0);
  const order = shares.map((share, k) => ({ k, rest: share - Math.floor(share) })).sort((p, q) => q.rest - p.rest);
  for (const { k } of order) {
    if (left <= 0) break;
    inner[k] = (inner[k] ?? 0) + 1;
    left -= 1;
  }
  const points: { x: number; y: number }[] = [];
  const place = (x: number, y: number) => points.push({ x: MARK_X + x * MARK_SIZE, y: MARK_Y + y * MARK_SIZE });
  strokes.forEach((stroke, k) => {
    place(stroke.a[0], stroke.a[1]);
    const n = inner[k] ?? 0;
    for (let i = 1; i <= n; i++) {
      const f = i / (n + 1);
      place(stroke.a[0] + (stroke.b[0] - stroke.a[0]) * f, stroke.a[1] + (stroke.b[1] - stroke.a[1]) * f);
    }
  });
  const last = corners[4];
  place(last[0], last[1]);
  return points.slice(0, count);
}

// ---- knobs -------------------------------------------------------------------------------------

type LavaKnob = "heat" | "fill" | "viscosity" | "cold" | "pour" | "hand" | "twin" | "mark";
const LAVA_KNOBS: readonly LavaKnob[] = ["heat", "fill", "viscosity", "cold", "pour", "hand", "twin", "mark"];

interface Settings {
  /** 0..1 bulb heat: how hot the coil runs and how fast it heats the wax on it. */
  heat: number;
  /** Parcels in lamp A. */
  count: number;
  cold: boolean;
  seed: number;
  hand: boolean;
  twin: boolean;
  /** Seconds between Ms of wax; 0 while the M is off. */
  markEvery: number;
  /** The wax's body, 0 silky .. 0.5 classic .. 1 chunky. */
  viscosity: number;
}

/** Where a hand rests on a lamp's glass, in glass units, if it does. */
interface Hand {
  x: number;
  y: number;
}

// ---- one lamp ----------------------------------------------------------------------------------

interface Wax {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radius now, easing toward `size` while present and toward 0 once the wax knob drops it. */
  r: number;
  size: number;
  present: boolean;
  /** Temperature: 0 the cold room, NEUTRAL floating, about 1 fresh off the coil. */
  T: number;
  /** Gathered into the M, its place there, and its glow 0..1. */
  inMark: boolean;
  tx: number;
  ty: number;
  glow: number;
  // This step's accumulators.
  ax: number;
  ay: number;
  dT: number;
}

const blankWax = (): Wax => ({
  x: 0, y: 0, vx: 0, vy: 0, r: 0, size: R0, present: false, T: 0, inMark: false, tx: 0, ty: 0, glow: 0, ax: 0, ay: 0, dT: 0,
});

/** How the passage bends a lamp's physics this step: all neutral (and absent) at rest. */
interface Stage {
  /** Multiple of the coil's heating rate. */
  coil: number;
  /** Pull (1/s) of every parcel's temperature toward the liquid's. */
  warm: number;
  /** Pull (1/s) of every parcel's temperature toward EXIT_T. */
  cool: number;
  /** 0..1: how heavy the wax has grown. */
  fall: number;
}

class Lamp {
  readonly wax: Wax[] = Array.from({ length: LAVA_MAX }, blankWax);
  /** Slots in use: present parcels and ones still melting away. */
  used = 0;
  /** 0 cold .. 1 warmed through. */
  warm = 1;
  /** The bulb, 0 off .. 1 on, and where it is heading. */
  bulb = 1;
  bulbOn = true;
  /** Seconds into an M (-1: none), and seconds until the next one. */
  markAge = -1;
  markWait = MARK_FIRST;
  /** The wax's body (WaxBody), shared with the other lamp and set by the sim before it steps. */
  body: Readonly<WaxBody> = CLASSIC;
  readonly #index: number;
  #random = lavaRandom(0);

  constructor(index: number) {
    this.#index = index;
  }

  /** A fresh pour: sizes from the seed; warm and running (prewarmed), or a cold heap. */
  reset(seed: number, count: number, cold: boolean, heat: number, arrive = false): void {
    this.#random = lavaRandom(seed * 7919 + this.#index * 104729);
    const random = this.#random;
    this.markAge = -1;
    this.markWait = MARK_FIRST;
    for (const [i, w] of this.wax.entries()) {
      Object.assign(w, blankWax());
      w.size = R0 * (1 - SIZE_SPREAD + 2 * SIZE_SPREAD * random());
      w.present = i < count;
      w.r = w.present ? w.size : 0;
    }
    this.used = count;
    this.bulb = 1;
    this.bulbOn = true;
    this.#heap();
    if (cold) {
      this.warm = 0;
      return;
    }
    // An entrance: the heap lies cool and solid at the bottom of a lit lamp (no prewarm); the
    // passage warms it from there. The same draws as the warm lamp's, in the same order.
    if (arrive) {
      this.warm = 1;
      for (const w of this.wax) w.T = ENTER_T0 + ENTER_T_SPREAD * random();
      return;
    }
    // A warm lamp: the heap at its liquid's temperature, run until the coil has sent up a stream of
    // blobs one by one (starting them scattered would send them all round the lamp in step).
    this.warm = 1;
    for (const w of this.wax) w.T = liquidTemperature(w.y, 1) + 0.04 * random();
    for (let t = 0; t < PREWARM; t += PREWARM_STEP) this.step(PREWARM_STEP, heat, undefined, 0);
  }

  /** Cold wax packed on the bottom of the glass, settled under its own weight. */
  #heap(): void {
    const random = this.#random;
    let y = 0;
    let row: Wax[] = [];
    const rows: Wax[][] = [];
    let width = 0;
    for (const w of this.wax) {
      if (!w.present) continue;
      const d = 1.55 * w.size;
      const room = 2 * (innerRadius(y + w.size) - 0.02);
      if (width + d > room && row.length > 0) {
        rows.push(row);
        row = [];
        width = 0;
        y += 1.3 * R0;
      }
      row.push(w);
      width += d;
    }
    if (row.length > 0) rows.push(row);
    let height = 0;
    for (const line of rows) {
      const span = line.reduce((sum, w) => sum + 1.55 * w.size, 0);
      let x = -span / 2;
      for (const w of line) {
        w.x = x + 0.775 * w.size + 0.01 * (random() - 0.5);
        w.y = height + w.size * 0.9;
        w.T = 0.04;
        x += 1.55 * w.size;
      }
      height += 1.3 * R0;
    }
    // Let it slump as if it had cooled where it settled: solid drag off, no heat.
    for (let t = 0; t < SETTLE; t += STEP) this.step(STEP, 0, undefined, 0, true);
    for (const w of this.wax) {
      w.vx = 0;
      w.vy = 0;
      w.T = 0.04;
    }
  }

  /** Add or drop parcels to match the wax knob: new ones grow in on the coil. */
  setCount(count: number): void {
    for (const [i, w] of this.wax.entries()) {
      const present = i < count;
      if (present && !w.present) {
        if (w.r <= 1e-4) {
          w.x = 0.08 * (this.#random() - 0.5);
          w.y = 0.03 + 0.03 * this.#random();
          w.vx = 0;
          w.vy = 0;
          w.T = liquidTemperature(w.y, this.warm);
          w.glow = 0;
          w.inMark = false;
        }
        w.present = true;
      } else if (!present) {
        w.present = false;
        w.inMark = false;
      }
    }
    let used = 0;
    for (const [i, w] of this.wax.entries()) if (w.present || w.r > 1e-4) used = i + 1;
    this.used = used;
  }

  /** Begin an M: the parcels nearest its points are drawn onto them. */
  startMark(): void {
    const candidates = this.wax.filter((w) => w.present && w.r > 0.5 * w.size);
    const count = Math.min(MARK_PARCELS, candidates.length - 3);
    if (count < 5) return;
    const targets = markTargets(count);
    const pairs: { w: Wax; t: { x: number; y: number }; d: number }[] = [];
    for (const w of candidates) for (const t of targets) pairs.push({ w, t, d: Math.hypot(w.x - t.x, w.y - t.y) });
    pairs.sort((a, b) => a.d - b.d);
    const taken = new Set<Wax>();
    const filled = new Set<{ x: number; y: number }>();
    for (const w of this.wax) w.inMark = false;
    for (const { w, t } of pairs) {
      if (taken.has(w) || filled.has(t)) continue;
      taken.add(w);
      filled.add(t);
      w.inMark = true;
      w.tx = t.x;
      w.ty = t.y;
    }
    this.markAge = 0;
    // The next one waits a full interval from the end of this one (tickMark), however it began.
    this.markWait = Number.POSITIVE_INFINITY;
  }

  /** Let go of the M at once (the scene is leaving). */
  dropMark(): void {
    this.markAge = -1;
    for (const w of this.wax) w.inMark = false;
  }

  /** How strongly the M holds its parcels now, 0..1. */
  markPull(): number {
    const age = this.markAge;
    if (age < 0) return 0;
    return smoothstep(0, MARK_GATHER * 0.6, age) * (1 - smoothstep(MARK_GATHER + MARK_HOLD, MARK_GATHER + MARK_HOLD + MARK_RELEASE, age));
  }

  /** How brightly the gathered wax glows now, 0..1: it lights as the M forms and fades as it lets go. */
  markGlow(): number {
    const age = this.markAge;
    if (age < 0) return 0;
    return smoothstep(MARK_GATHER * 0.4, MARK_GATHER, age) * (1 - smoothstep(MARK_GATHER + MARK_HOLD, MARK_GATHER + MARK_HOLD + 0.6 * MARK_RELEASE, age));
  }

  /** Count down to the next M and age the one running (it plays out even if the M is switched off,
   * so "now" shows one either way); `every` 0 while the M is off. */
  tickMark(h: number, every: number): void {
    if (this.markAge >= 0) {
      this.markAge += h;
      if (this.markAge > MARK_GATHER + MARK_HOLD + MARK_RELEASE) {
        this.markAge = -1;
        for (const w of this.wax) w.inMark = false;
      }
      return;
    }
    if (every === 0) {
      this.markWait = MARK_FIRST;
      return;
    }
    this.markWait = Math.min(this.markWait, every) - h;
    if (this.markWait <= 0) {
      this.startMark();
      this.markWait = every;
    }
  }

  /** The bulb on the scene clock: fading out for a restart, coming back up. */
  tickBulb(dt: number): void {
    const target = this.bulbOn ? 1 : 0;
    this.bulb = target + (this.bulb - target) * Math.exp(-dt / (this.bulbOn ? BULB_ON : BULB_OFF));
  }

  /** Back on, from a cold heap (called once the bulb has gone dark). */
  restartCold(): void {
    for (const w of this.wax) {
      w.inMark = false;
      w.glow = 0;
      if (!w.present) w.r = 0;
      else w.r = w.size;
    }
    this.setCount(this.wax.filter((w) => w.present).length);
    this.markAge = -1;
    this.markWait = MARK_FIRST;
    this.#heap();
    this.warm = 0;
    this.bulbOn = true;
  }

  /**
   * One fixed step of `h` seconds of lamp time at bulb `heat` 0..1: a hotter bulb warms the lamp
   * and the wax on its coil faster and hotter, stirs the liquid a little more and lifts warm wax a
   * little harder (a lazy lamp sends up fewer blobs, not weaker ones).
   */
  step(h: number, heat: number, hand: Hand | undefined, markPull: number, settling = false, stage?: Stage): void {
    const wax = this.wax;
    const n = this.used;
    const quick = 0.75 + 0.5 * heat;
    if (!settling) this.warm += (1 - this.warm) * (1 - Math.exp((-h * quick) / WARM_TAU));
    const warm = this.warm;
    // The coil heats with the bulb, well before the liquid around it has warmed.
    const coilT = (COIL_T0 + COIL_T1 * heat) * Math.min(1, 0.35 + 3 * warm) * this.bulb;
    const lift = BUOYANCY * (0.85 + 0.3 * heat);
    const grow = 1 - Math.exp(-h / GROW_TAU);

    for (let i = 0; i < n; i++) {
      const w = wax[i];
      if (w === undefined) continue;
      w.r += ((w.present ? w.size : 0) - w.r) * grow;
      w.ax = 0;
      w.ay = 0;
      w.dT = 0;
      if (w.r <= 1e-4) continue;
      const scale = R0 / Math.max(w.r, 0.25 * R0);
      // Heat: the liquid, the coil, a hand, and the M's calm.
      if (!settling) {
        let dT = EXCHANGE * scale * (liquidTemperature(w.y, warm) - w.T);
        const contact = smoothstep(COIL_REACH, 0, w.y - w.r) * Math.exp(-((w.x / COIL_HALF) ** 2));
        dT += COIL_RATE * quick * (stage === undefined ? 1 : stage.coil) * contact * (coilT - w.T);
        dT += CAP_RATE * smoothstep(CAP_REACH, 0, 1 - w.y - w.r) * (CAP_T - w.T);
        if (hand !== undefined) {
          const d2 = (w.x - hand.x) ** 2 + (w.y - hand.y) ** 2;
          dT += HAND_RATE * Math.exp(-d2 / (HAND_REACH * HAND_REACH)) * (HAND_T - w.T);
        }
        if (stage !== undefined) dT += stage.warm * (liquidTemperature(w.y, warm) - w.T) + stage.cool * (EXIT_T - w.T);
        if (w.inMark) dT += 2 * markPull * (NEUTRAL - w.T);
        w.dT = dT;
      }
      // Forces: buoyancy (on the coil, only past RELEASE), drag toward the liquid's convection (still
      // at the floor, so it never lifts the heap), the M's pull.
      const hold = w.inMark ? markPull : 0;
      const solid = settling ? 0 : 1 - smoothstep(SOLID_LO, SOLID_HI, w.T);
      const drag = DRAG * Math.sqrt(scale) * (1 + SOLID_DRAG * solid) * (stage === undefined ? 1 : 1 + EXIT_DRAG * stage.fall);
      const R = innerRadius(w.y);
      const xi = clamp(w.x / R, -1, 1);
      const yc = clamp(w.y, 0, 1);
      const flow = FLOW * warm * (0.6 + 0.8 * heat);
      const rise = Math.sin(Math.PI * yc);
      const fx = -0.5 * flow * Math.sin(Math.PI * xi) * Math.cos(Math.PI * yc);
      const fy = flow * Math.cos(Math.PI * xi) * rise * rise;
      const T = settling ? 0 : w.T;
      const neutral = NEUTRAL + (RELEASE - NEUTRAL) * smoothstep(COIL_REACH, 0, w.y - w.r);
      // The passage's exit: the wax grows heavy and falls, easing toward the pool.
      const fallV = stage === undefined ? 0 : EXIT_FALL * stage.fall * smoothstep(EXIT_FALL_POOL[0], EXIT_FALL_POOL[1], w.y);
      w.ax += drag * (fx - w.vx);
      w.ay += drag * (fy - fallV - w.vy) + lift * (T - neutral) * (1 - hold);
      if (hold > 0) {
        w.ax += hold * (MARK_PULL * (w.tx - w.x) - MARK_DAMP * w.vx);
        w.ay += hold * (MARK_PULL * (w.ty - w.y) - MARK_DAMP * w.vy);
      }
      // The glass: sides, bottom and the cap's underside push back (the sides without friction:
      // warm wax slides down the funnel of the glass's foot to the coil instead of wedging in it).
      const side = R - (1 - WALL_GIVE) * w.r;
      const over = Math.abs(w.x) - side;
      if (over > 0) w.ax -= WALL * over * Math.sign(w.x);
      const floor = (1 - WALL_GIVE) * w.r;
      if (w.y < floor) w.ay += WALL * (floor - w.y);
      const ceiling = 1 - (1 - WALL_GIVE) * w.r;
      if (w.y > ceiling) w.ay -= WALL * (w.y - ceiling);
    }

    // Bonds between neighbours, as the wax's body has them.
    const breakAt = BREAK * this.body.reach;
    const cohesion = COHESION * this.body.cohesion;
    const viscosity = VISCOSITY * this.body.viscosity;
    for (let i = 0; i < n; i++) {
      const a = wax[i];
      if (a === undefined || a.r <= 1e-4) continue;
      const ma = (a.r / R0) ** 2;
      for (let j = i + 1; j < n; j++) {
        const b = wax[j];
        if (b === undefined || b.r <= 1e-4) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const reach = breakAt * (a.r + b.r);
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2) + 1e-6;
        const nx = dx / d;
        const ny = dy / d;
        const rest = REST * (a.r + b.r);
        const mb = (b.r / R0) ** 2;
        const m = Math.min(ma, mb);
        const solid = settling ? 1 : 1 - smoothstep(SOLID_LO, SOLID_HI, Math.min(a.T, b.T));
        // While the M holds, its parcels let go of the rest and of each other: the M keeps its shape.
        const held = (a.inMark || b.inMark) ? markPull : 0;
        const bond = (1 + COLD_BOND * solid) * (1 - held);
        // Rising (warm) and sinking (cool) wax pass each other at different depths in the glass: in
        // the picture they slide through one another instead of jamming, and a warm blob holds on to
        // the cool heap only by a thinning neck.
        const apart = smoothstep(PASS_LO, PASS_HI, Math.abs(a.T - b.T));
        let pass = 1 - PASS * apart;
        // The M's own parcels slip past each other into their places; all other wax flows round it.
        if (a.inMark && b.inMark) pass *= 1 - markPull;
        else if (a.inMark || b.inMark) pass += (MARK_SHIELD - pass) * markPull;
        let f: number;
        if (d < rest) f = (-REPEL * pass * (rest - d)) / rest;
        else {
          const u = (d - rest) / (reach - rest);
          f = cohesion * bond * (1 - TEAR * apart) * 4 * u * (1 - u);
        }
        a.ax += (f * m * nx) / ma;
        a.ay += (f * m * ny) / ma;
        b.ax -= (f * m * nx) / mb;
        b.ay -= (f * m * ny) / mb;
        const near = 1 - d / reach;
        const vis = viscosity * bond * pass * near * m;
        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        a.ax += (vis * rvx) / ma;
        a.ay += (vis * rvy) / ma;
        b.ax -= (vis * rvx) / mb;
        b.ay -= (vis * rvy) / mb;
        if (!settling) {
          const q = CONDUCT * near * m * (b.T - a.T);
          a.dT += q / ma;
          b.dT -= q / mb;
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const w = wax[i];
      if (w === undefined || w.r <= 1e-4) continue;
      w.vx += w.ax * h;
      w.vy += w.ay * h;
      w.x += w.vx * h;
      w.y += w.vy * h;
      w.T += w.dT * h;
      // Never through the glass, whatever the step.
      w.y = clamp(w.y, 0.4 * w.r, 1 - 0.4 * w.r);
      const lim = Math.max(0, innerRadius(w.y) - 0.6 * w.r);
      w.x = clamp(w.x, -lim, lim);
    }
  }

  /** Ease each parcel's M glow toward the M's (its own parcels only). */
  glowStep(dt: number): void {
    const glow = this.markGlow();
    const ease = 1 - Math.exp(-dt / 0.4);
    for (const w of this.wax) w.glow += ((w.inMark ? glow : 0) - w.glow) * ease;
  }

  /** Parcels into rows `row` and `row + 1` of the parcel texture. */
  writeParcels(data: Float32Array, row: number): void {
    for (const [i, w] of this.wax.entries()) {
      const o = (row * LAVA_MAX + i) * 4;
      const v = (o + LAVA_MAX * 4);
      const on = w.r > 1e-4;
      data[o] = w.x;
      data[o + 1] = w.y;
      data[o + 2] = on ? w.r : 0;
      data[o + 3] = w.T;
      data[v] = on ? w.vx : 0;
      data[v + 1] = on ? w.vy : 0;
      data[v + 2] = on ? w.glow : 0;
      data[v + 3] = 0;
    }
  }

  /**
   * The coarse picture of the wax into `grid` (rg, LAVA_GRID_X × LAVA_GRID_Y from row `row0`): soft
   * wax amount, and the bulb's light left after the wax below has stopped some of it (each column
   * from the bottom up, then blurred across a little: the light spreads). `light` is scratch.
   * Returns the share of the glass the wax covers in the picture (where blobs overlap, once): it
   * grows as they spread out and shrinks as they merge, and tints the light the lamp throws.
   */
  writeGrid(grid: Float32Array, row0: number, dens: Float32Array, light: Float32Array): number {
    const nx = LAVA_GRID_X;
    const ny = LAVA_GRID_Y;
    const cw = (2 * GRID_HALF) / nx;
    const ch = 1 / ny;
    dens.fill(0);
    let covered = 0;
    for (let k = 0; k < this.used; k++) {
      const w = this.wax[k];
      if (w === undefined || w.r <= 1e-4) continue;
      const R = GRID_REACH * w.r;
      const i0 = Math.max(0, Math.floor((w.x - R + GRID_HALF) / cw));
      const i1 = Math.min(nx - 1, Math.ceil((w.x + R + GRID_HALF) / cw));
      const j0 = Math.max(0, Math.floor((w.y - R) / ch));
      const j1 = Math.min(ny - 1, Math.ceil((w.y + R) / ch));
      for (let j = j0; j <= j1; j++) {
        const y = (j + 0.5) * ch - w.y;
        for (let i = i0; i <= i1; i++) {
          const x = -GRID_HALF + (i + 0.5) * cw - w.x;
          const s = (x * x + y * y) / (R * R);
          if (s < 1) dens[j * nx + i] = (dens[j * nx + i] ?? 0) + (1 - s) * (1 - s);
        }
      }
    }
    for (let i = 0; i < nx; i++) {
      let column = 0;
      for (let j = 0; j < ny; j++) {
        const at = j * nx + i;
        column += Math.min(dens[at] ?? 0, 1.5) * ch;
        light[at] = Math.exp(-GRID_KAPPA * column);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const at = j * nx + i;
        const left = light[j * nx + Math.max(0, i - 1)] ?? 1;
        const right = light[j * nx + Math.min(nx - 1, i + 1)] ?? 1;
        const o = ((row0 + j) * nx + i) * 2;
        const wax = Math.min(dens[at] ?? 0, 1);
        covered += wax;
        grid[o] = wax;
        grid[o + 1] = 0.25 * left + 0.5 * (light[at] ?? 1) + 0.25 * right;
      }
    }
    return Math.min(1, (covered * cw * ch) / GLASS_AREA);
  }
}

// ---- the simulation ----------------------------------------------------------------------------

/** Where the pointer rests on lamp `index`'s glass (glass units), if it does. */
function handOn(pointer: PointerState, aspect: number, index: number): Hand | undefined {
  const lamp = LAMPS[index === 0 ? 0 : 1];
  const lx = (pointer.x * aspect - lamp.x * aspect) / lamp.size;
  const gy = ((pointer.y - lamp.foot) / lamp.size - SHAPE.base) / SHAPE.glass;
  if (gy < -0.03 || gy > 1.03) return undefined;
  const rg = glassRadius(gy);
  if (Math.abs(lx) > rg + 0.015) return undefined;
  const ri = rg - SHAPE.wall;
  const xi = clamp(lx / ri, -1, 1);
  return { x: (ri / SHAPE.glass) * xi * (LENS + (1 - LENS) * xi * xi), y: clamp(gy, 0, 1) };
}

class LavaSim implements SceneSim {
  readonly #knobs: KnobReader<LavaKnob>;
  readonly #lamps = [new Lamp(0), new Lamp(1)] as const;
  readonly #parcels: DataTexture;
  readonly #grid: DataTexture;
  readonly #state: DataTexture;
  readonly #parcelData = new Float32Array(LAVA_MAX * 4 * 4);
  readonly #gridData = new Float32Array(LAVA_GRID_X * LAVA_GRID_Y * 2 * 2);
  readonly #stateData = new Float32Array(3 * 4);
  /** The wax's body both lamps step with, re-read from the viscosity knob every frame. */
  readonly #body: WaxBody = { ...CLASSIC };
  readonly #dens = new Float32Array(LAVA_GRID_X * LAVA_GRID_Y);
  readonly #light = new Float32Array(LAVA_GRID_X * LAVA_GRID_Y);
  #seed = -1;
  #cold = false;
  #count = -1;
  #primed = false;
  /** The first build came in with the scene and is still playing the entrance's start-up. */
  #arriving = false;
  /** The exit has begun. */
  #leaving = false;
  /** Lamp time not yet stepped (s). */
  #carry = 0;
  /** A cold restart in progress: the bulbs are fading out. */
  #restarting = false;
  #triggers: number[] | undefined;
  #signature = "";

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<LavaKnob>) {
    this.#knobs = knobs;
    this.#parcels = new DataTexture(gl, { width: LAVA_MAX, height: 4, format: "rgba16f", filter: "nearest" });
    this.#grid = new DataTexture(gl, { width: LAVA_GRID_X, height: 2 * LAVA_GRID_Y, format: "rg16f" });
    this.#state = new DataTexture(gl, { width: 3, height: 1, format: "rgba16f", filter: "nearest" });
    for (const lamp of this.#lamps) lamp.body = this.#body;
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = this.#read(frame);
    materialAt(settings.viscosity, SILKY, CLASSIC, CHUNKY, this.#body);
    const enter = clamp(frame.passage.enter, 0, 1);
    const exit = clamp(frame.passage.exit, 0, 1);
    // Only a sim built while the scene comes in, warm, plays the entrance.
    if (!this.#primed) this.#arriving = enter < 1 && !settings.cold;
    const fired = this.#fired(frame.triggers);
    const [a, b] = this.#lamps;
    const textures = [this.#parcels.texture, this.#grid.texture, this.#state.texture] as const;

    // A new pour, or the first frame: start over (cold, if asked).
    if (!this.#primed || settings.seed !== this.#seed) {
      this.#seed = settings.seed;
      this.#count = settings.count;
      this.#cold = settings.cold;
      this.#restarting = false;
      // A new pour mid-scene is a plain prewarmed lamp: only the first build comes in from the pool.
      const arrive = this.#arriving && !this.#primed;
      this.#arriving = arrive;
      a.reset(settings.seed, settings.count, settings.cold, settings.heat, arrive);
      b.reset(settings.seed, twinCount(settings.count), settings.cold, settings.heat, arrive);
      this.#carry = 0;
    }
    // "Now", or cold start switched on: off, and back on from cold.
    const coldOn = settings.cold && !this.#cold;
    this.#cold = settings.cold;
    if (this.#primed && (fired[0] === true || coldOn)) {
      this.#restarting = true;
      this.#arriving = false;
      // Off: the bulbs fade; once dark, the restart below swaps in the cold heaps.
      a.bulbOn = false;
      b.bulbOn = false;
    }
    if (settings.count !== this.#count) {
      this.#count = settings.count;
      a.setCount(settings.count);
      b.setCount(twinCount(settings.count));
    }
    if (fired[1] === true && a.markAge < 0) a.startMark();
    if (exit > 0 && !this.#leaving) {
      this.#leaving = true;
      a.dropMark();
    }

    const dt = Math.max(frame.dt, 0);
    const signature = `${frame.values.join(",")}|${frame.aspect}`;
    if (this.#primed && dt === 0 && !fired.some(Boolean) && signature === this.#signature) return textures;
    this.#signature = signature;

    // The bulbs on the scene clock; once dark, the restart swaps in the cold heaps.
    a.tickBulb(dt);
    b.tickBulb(dt);
    if (this.#restarting && a.bulb < 0.03) {
      a.restartCold();
      b.restartCold();
      this.#restarting = false;
    }

    // The wax on fixed steps of lamp time.
    const pointer = frame.pointer;
    const pressing = settings.hand && pointer.inside && pointer.down;
    const handA = pressing ? handOn(pointer, frame.aspect, 0) : undefined;
    const handB = pressing && settings.twin ? handOn(pointer, frame.aspect, 1) : undefined;
    const stage = this.#stage(enter, exit);
    // A passage plays in real time whatever the motion, and the lamp hurries through it.
    this.#carry += dt * (stage === undefined ? Math.max(0, frame.motion) : Math.max(1, frame.motion) * this.#pace(enter, exit));
    let steps = 0;
    while (this.#carry >= STEP && steps < MAX_STEPS) {
      if (stage === undefined) a.tickMark(STEP, settings.markEvery);
      a.step(STEP, settings.heat, handA, a.markPull(), false, stage);
      b.step(STEP, settings.heat, handB, 0, false, stage);
      this.#carry -= STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS) this.#carry = Math.min(this.#carry, STEP);
    a.glowStep(steps * STEP);
    this.#primed = true;

    a.writeParcels(this.#parcelData, 0);
    b.writeParcels(this.#parcelData, 2);
    const shareA = a.writeGrid(this.#gridData, 0, this.#dens, this.#light);
    const shareB = b.writeGrid(this.#gridData, LAVA_GRID_Y, this.#dens, this.#light);
    const state = this.#stateData;
    const body = this.#body;
    state.set([a.used, a.bulb, a.warm, shareA, b.used, b.bulb, b.warm, shareB, body.blend, body.stretch, 0, 0]);
    this.#parcels.upload(this.#parcelData);
    this.#grid.upload(this.#gridData);
    this.#state.upload(state);
    return textures;
  }

  dispose(): void {
    this.#parcels.dispose();
    this.#grid.dispose();
    this.#state.dispose();
  }

  #read(frame: SimFrame): Settings {
    const knobs = this.#knobs;
    const heat = clamp(knobs.value(frame, "heat"), 0, 1);
    const mark = knobs.value(frame, "mark");
    return {
      heat,
      count: Math.round(COUNT_MIN + (COUNT_MAX - COUNT_MIN) * clamp(knobs.value(frame, "fill"), 0, 1)),
      cold: knobs.value(frame, "cold") > 0.5,
      seed: Math.round(knobs.value(frame, "pour")),
      hand: knobs.value(frame, "hand") > 0.5,
      twin: knobs.value(frame, "twin") > 0.5,
      markEvery: mark > 0 ? MARK_EVERY_RARE + (MARK_EVERY_OFTEN - MARK_EVERY_RARE) * clamp(mark, 0, 1) : 0,
      viscosity: clamp(knobs.value(frame, "viscosity"), 0, 1),
    };
  }

  /** Trigger slots stamped since the previous frame. */
  #fired(triggers: readonly number[]): boolean[] {
    const previous = this.#triggers;
    this.#triggers = [...triggers];
    return triggers.map((at, slot) => previous !== undefined && at !== previous[slot] && at > -1e3);
  }

  /** The passage's bend of the physics now (seconds into the entrance or the exit), or none at rest. */
  #stage(enter: number, exit: number): Stage | undefined {
    if (exit > 0) {
      const t = exit * LAVA_PASSAGE.exit;
      const cool = smoothstep(0, EXIT_COIL_OFF, t);
      return { coil: 1 - cool, warm: 0, cool: EXIT_COOL * cool, fall: smoothstep(EXIT_FALL_IN[0], EXIT_FALL_IN[1], t) };
    }
    if (this.#arriving && enter < 1) {
      const t = enter * LAVA_PASSAGE.enter;
      const warm = smoothstep(ENTER_WARM_IN[0], ENTER_WARM_IN[1], t) * (1 - smoothstep(ENTER_WARM_OUT[0], ENTER_WARM_OUT[1], t));
      const coil = smoothstep(ENTER_COIL_IN[0], ENTER_COIL_IN[1], t) * (1 - smoothstep(ENTER_COIL_OUT[0], ENTER_COIL_OUT[1], t));
      return { coil: 1 + ENTER_COIL * coil, warm: ENTER_WARM * warm, cool: 0, fall: 0 };
    }
    return undefined;
  }

  /** How much quicker than real time the lamp runs through the passage. */
  #pace(enter: number, exit: number): number {
    if (exit > 0) return 1 + EXIT_PACE * smoothstep(0, 0.2, exit);
    return 1 + ENTER_PACE * (1 - smoothstep(0, 1, enter));
  }
}

/** The twin's parcels for lamp A's count: a smaller lamp, a little less wax. */
function twinCount(count: number): number {
  return Math.max(COUNT_MIN - 2, Math.round(count * TWIN_SHARE));
}

/** The lava lamps, for a scene whose `params` carry the knobs `LavaKnob` names. */
export function lavaSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new KnobReader<LavaKnob>("lava", params, LAVA_KNOBS);
  return (gl) => new LavaSim(gl, knobs);
}
