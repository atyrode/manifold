// The meadow's simulation: the near grass in the wind, the dandelion clocks, and the seeds the gusts
// carry off them.
//
// One gust field drives it all. `meadowGust` is a deterministic function of a point on the ground
// and the clock, mirrored line for line in shader.ts (generated from the same constants), so the
// waves of light the shader rolls across the field, the gusts that bow the near blades, rock the
// clocks and pull their seeds, and the air the seeds ride are one and the same wind:
//   three trains of gust fronts travel downwind (mostly across the view, a little away), each a broad
//   swell with a soft leading edge and a long tail, then a faint rebound where the released grass
//   springs up past upright. The fronts are bent by slow crosswind wobbles, and a gate drifting with
//   them switches stretches of a front on and off: the 'gust frequency' knob moves only the gate's
//   threshold, so turning it never shifts a front. 'Now' adds one big front released at the left of
//   the field that sweeps across all of it, through the near grass, out to the right.
//
// Ground: x to the right, z away from the viewer (world units, about metres), the eye MEADOW_GROUND
// above the ground looking level over the grass, the horizon at uv.y = MEADOW_HORIZON. Screen
// positions here are in screen heights from the bottom-left corner (x in 0..aspect, y in 0..1).
//
// Near grass: two layers of blades rooted below the frame, one per column `pitch` apart. Each column
// is a pair of damped springs (lean sideways, bow away from the viewer) pushed by the gust at its
// root and by the pointer's breath; the shader draws each blade with its column's bend. They are
// underdamped, so a blade overshoots a little and settles after each gust.
//
// Dandelion clocks: up to MAX_CLOCKS on long stalks (springs too), each head a sphere of
// SECTORS × SEEDS_PER_SECTOR seeds. Gusts and the breath pull seeds off one at a time, mostly from
// the downwind side, so a head goes lopsided before it goes bare; a click blows a handful off the
// nearest one. Rain, from the first drizzle, closes the heads and holds the seeds. A bare clock
// wilts and fades; a fresh one rises close by as a closed bud and opens.
//
// Seeds: at most MAX_SEEDS in the air, each a little parachute with drag, moving in the world and
// seen through the eye (a LevelCamera). It relaxes toward the air around it: a breeze and the gusts
// blowing along the gust direction, so it drifts across the view and away from it as one motion,
// gusts that lift it, slow eddies of its own, a gentle sink. Receding, it slows across the frame and
// closes in on the horizon, and it fades into the haze.
//
// Time runs in fixed steps of STEP on the shader's clock (the motion clock, uMotionTime), each step
// at its own moment on it, so the simulation and the picture evaluate the gusts alike. The first
// frame pre-runs PREWARM seconds (a fixed count of steps, spread over frames only when one frame
// cannot hold them all) up to the moment that frame began, where the live steps take over, so the
// page opens with seeds already in the air. The grass, the clocks and the seeds are drawn between
// their last two steps by the clock's alpha (a step behind the newest), so the meadow moves the same
// at 60 and 144 Hz; the pointer's breath follows the pointer frame by frame, as input does.
//
// Passage (entrance and exit): the camera is lowered into the grass on arrival and rises above it on
// leaving, a real change of the eye's height over the same scene (MEADOW_MOVE: `meadowDrop` is how
// far above its rest height the eye is). The field is drawn from that height by the shader, and the
// near grass, the clocks and the seeds sit that much lower in the frame, nearer ones by more
// (focal length x drop / depth). A passage gust sweeps through on the way (`meadowPassageGust`,
// another term of the gust field, in the shader too): arriving, the first one lifts the seeds off;
// leaving, a strong one carries a burst of them across the frame. At rest none of it is in effect.
//
// Textures:
//   uSim0  rgba16f 32×3, nearest. Rows 0–1: the seeds sorted by x (row 0: uv x, uv y, pappus radius
//          in screen heights, alpha; row 1: tilt, depth, squash, 0). Row 2: texels 0–3 the uv
//          bounding box of each group of eight (min x, min y, max x, max y; inverted when empty),
//          texel 4 the breath (uv x, uv y, strength, 0).
//   uSim1  rg16f columns×2, nearest: per column of near grass (row = layer) the lean and the bow.
//   uSim2  rgba16f 18×5, nearest: per clock (row): texel 0 root uv xy and head uv xy; texel 1 head
//          radius (screen heights), presence, open 0..1, fullness 0..1; texels 2–17 the share of seeds
//          left in each sector (r), sector k centred (k + 0.5) / 16 of a turn from +x, anticlockwise;
//          texel 2 also carries the clock's depth (g, world units) and how closed it is (b, 0..1).
import { KnobReader, type ParamDef } from "../../params.ts";
import { LevelCamera } from "../../sims/camera.ts";
import { FixedStep, runBudgeted } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { springStep, type Spring } from "../../sims/spring.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PrincipalState, SceneSim, SimFactory, SimFrame } from "../types.ts";
import { GUST_TRIGGER, MAX_CLOCKS, MEADOW_PASSAGE } from "./constants.ts";

const TAU = Math.PI * 2;
/** TAU as the shader spells it, so the gust phases match the GLSL. */
const GLSL_TAU = 6.2831853;

// ---- the view (shared with shader.ts) -----------------------------------------------------------

/** Screen height of the horizon (uv.y). */
export const MEADOW_HORIZON = 0.4;
/** Focal length in screen heights per unit of ray slope: a vertical field of view of about 46°. */
export const MEADOW_FOCAL = 1.18;
/** Eye height above the ground, world units: standing in grass that reaches past the hips. */
export const MEADOW_GROUND = 2;
/** Depth of the tree line at the far edge of the meadow. */
export const MEADOW_TREES_Z = 110;

// ---- the gust field (shared with shader.ts) -----------------------------------------------------

/**
 * Every constant of the gust field. Three trains (k = 0..2) of fronts `lambda` apart; distances in
 * world units, times in seconds of the shader's clock, phases in radians.
 */
export const MEADOW_GUST = {
  /** Downwind direction before normalising: to the right (mirrored by a negative wind) and away. */
  dirX: 1,
  dirZ: 0.45,
  /** Front speed: base, and added at full wind. */
  speed: 3,
  speedWind: 3,
  lambda: [31, 47, 73],
  offset: [0, 0.37, 0.71],
  /** Crosswind wobble bending each train's fronts: amplitude, wavenumber, rate, phase; a second, finer harmonic at this share. */
  wobA: [5, 7, 9],
  wobK: [0.083, 0.061, 0.047],
  wobW: [0.11, 0.07, 0.05],
  wobP: [0, 2.1, 4.3],
  wobSecond: 0.4,
  /** The gate: its phase steps this many turns per front, varies across the wind, drifts in time. */
  gateStep: [0.29, 0.43, 0.23],
  gateK: [0.13, 0.09, 0.17],
  gateW: [0.05, 0.035, 0.06],
  gateP: [1.3, 3.7, 5.9],
  weight: [1, 0.85, 0.7],
  /** Gate threshold at gust frequency 0 and 1, and the width of its soft edge. */
  gateRare: 0.75,
  gateOften: -0.55,
  gateSoft: 0.5,
  /** A front over one period f in 0..1 (downwind = larger f): its tail starts, it peaks, and its soft leading edge ends. */
  tail: 0.04,
  peak: 0.58,
  edge: 0.8,
  /** The rebound just upwind of the tail: depth, centre, width (periods). */
  rebound: 0.15,
  reboundAt: 0.975,
  reboundWidth: 0.05,
  /** The front's mean over a period: what it fades to once a cell spans too much of it. */
  frontMean: 0.37,
  blurFrom: 0.04,
  blurTo: 0.16,
  /** Overlapping fronts saturate: sum / (1 + softclip × sum). */
  softclip: 0.35,
  /** The 'now' gust: released this far along the wind (left of the field), at this multiple of the front speed, its leading edge and tail lengths, gain, life (s), fade-in (s) and its gentle bend. */
  nowStart: -12,
  nowPace: 2,
  nowEdge: 4,
  nowTail: 20,
  nowGain: 1.3,
  nowLife: 24,
  nowRise: 0.6,
  nowWob: 4,
  nowWobK: 0.07,
  nowWobP: 1.3,
} as const;

/**
 * The passage's choreography (shared with shader.ts), in seconds into the entrance or the exit.
 * The camera's height above rest, world units: it starts `dropIn` up (the sky and the far field in
 * view, the near grass below the frame) already on its way down, lowers into the grass over the
 * first `descentLength` seconds, braking (ease-out) and settling a little past rest (`settle`: the
 * phase of the cosine that overshoots); and leaving it rises from `liftFrom` over `liftLength`,
 * accelerating to the end, to `dropOut`. Both are eased in the height as the picture sees it,
 * drop / (drop + `near`): the near grass fills the view while the eye is within `near` of rest and
 * moves the picture far more than the same rise does higher up, so a height eased in that measure
 * moves the picture at the pace the ease gives (fastest as the scene arrives, and as it leaves).
 * The passage gust is a front like the 'now' gust (its shape, wobble and the same ground), with its
 * own gain, leading edge and short tail so it is a wave and not a flood: it starts `gustFrom` along
 * the wind (clear of the view, to the left), sweeps at `gustInSpeed` from `gustInAt` while arriving
 * (amplitude `gustInAmp`, rising over `gustInRise` and gone over the last `gustInFade` seconds so
 * nothing pops as the scene arrives), and at `gustOutSpeed` from the start of the exit.
 */
export const MEADOW_MOVE = {
  dropIn: 1.35,
  dropOut: 2.4,
  near: 0.5,
  descentLength: 2.55,
  settle: 0.8 * Math.PI,
  liftFrom: 0.25,
  liftLength: 1.35,
  gustFrom: -4,
  gustGain: 1.2,
  gustEdge: 3,
  gustTail: 7,
  gustInAt: 1.3,
  gustInSpeed: 18,
  gustInAmp: 0.75,
  gustInRise: 0.3,
  gustInFade: 0.9,
  gustOutSpeed: 22,
  gustOutAmp: 1.2,
  gustOutRise: 0.25,
} as const;

/** How far above its rest height the camera is, world units: 0 at rest. Shader: meadowDrop. */
export function meadowDrop(enter: number, exit: number): number {
  const M = MEADOW_MOVE;
  const a = clamp((enter * MEADOW_PASSAGE.enter) / M.descentLength, 0, 1);
  const down = 1 - (1 - a) * (1 - a);
  const up = clamp((exit * MEADOW_PASSAGE.exit - M.liftFrom) / M.liftLength, 0, 1);
  // The height as the picture sees it (drop / (drop + near)), eased, and back to world units.
  const seen =
    (M.dropIn / (M.dropIn + M.near)) * (1 - down) * Math.cos(down * M.settle) +
    (M.dropOut / (M.dropOut + M.near)) * up * up;
  return (M.near * seen) / (1 - seen);
}

/** The passage gust's front (ground distance along the wind) and amplitude (0: none, as at rest). */
export interface PassageGust {
  front: number;
  amp: number;
}

/** Fill `out` with the passage gust for the entrance and exit progress 0..1. Shader: meadowPassageGust. */
export function meadowPassageGust(out: PassageGust, enter: number, exit: number): PassageGust {
  const M = MEADOW_MOVE;
  out.front = M.gustFrom;
  out.amp = 0;
  if (exit > 0) {
    const t = exit * MEADOW_PASSAGE.exit;
    out.front = M.gustFrom + M.gustOutSpeed * t;
    out.amp = M.gustOutAmp * smoothstep(0, M.gustOutRise, t);
  } else if (enter < 1) {
    const tin = enter * MEADOW_PASSAGE.enter;
    const t = tin - M.gustInAt;
    out.front = M.gustFrom + M.gustInSpeed * t;
    out.amp =
      M.gustInAmp *
      smoothstep(0, M.gustInRise, t) *
      (1 - smoothstep(MEADOW_PASSAGE.enter - M.gustInFade, MEADOW_PASSAGE.enter, tin));
  }
  return out;
}

/** The wind as the gust field reads it, from the knobs. */
export interface MeadowWind {
  /** Unit downwind direction on the ground. */
  dirX: number;
  dirZ: number;
  /** Front speed, world units per second. */
  speed: number;
  /** The 'gusts' knob (0 while off). */
  strength: number;
  /** The gate's threshold, from the 'gust frequency' knob. */
  threshold: number;
  /** Motion seconds (on the motion clock) since 'now' sent a big gust; negative while idle. */
  nowAge: number;
  /** The passage gust's front (ground distance along the wind) and amplitude; 0 outside a passage. */
  passFront: number;
  passAmp: number;
}

/** Fill `out` from the knobs: wind -1..1, gusts 0..1, gust frequency 0..1; and the passage's gust. */
export function meadowWind(
  out: MeadowWind,
  wind: number,
  gusts: number,
  rate: number,
  nowAge: number,
  pass: Readonly<PassageGust>,
): MeadowWind {
  const G = MEADOW_GUST;
  const side = wind < 0 ? -1 : 1;
  const length = Math.sqrt(G.dirX * G.dirX + G.dirZ * G.dirZ);
  out.dirX = (side * G.dirX) / length;
  out.dirZ = G.dirZ / length;
  out.speed = G.speed + G.speedWind * Math.abs(wind);
  out.strength = gusts;
  out.threshold = G.gateRare + (G.gateOften - G.gateRare) * rate;
  out.nowAge = nowAge;
  out.passFront = pass.front;
  out.passAmp = pass.amp;
  return out;
}

/** One front over its period, f in 0..1, blurred by b periods (shader: meadowFront). */
function meadowFront(f: number, b: number): number {
  const G = MEADOW_GUST;
  const rise = smoothstep(G.tail - b, G.peak + b, f);
  const fall = 1 - smoothstep(G.peak - b, G.edge + b, f);
  const width = Math.sqrt(G.reboundWidth * G.reboundWidth + b * b);
  let df = f - G.reboundAt;
  df -= Math.floor(df + 0.5);
  return (
    rise * fall - G.rebound * (G.reboundWidth / width) * Math.exp((-df * df) / (width * width))
  );
}

/**
 * The gust load at ground point (x, z) at time tm (the motion clock): about 0 in a lull, up to ~1
 * in a strong gust (more under 'now'), slightly negative in a rebound. `blur` is the ground length a
 * sample spans along the wind (the shader's footprint; 0 for a point). Shader: meadowGust.
 */
export function meadowGust(w: MeadowWind, x: number, z: number, tm: number, blur: number): number {
  const G = MEADOW_GUST;
  const s = x * w.dirX + z * w.dirZ;
  const c = x * w.dirZ - z * w.dirX;
  let sum = 0;
  for (let k = 0; k < 3; k++) {
    const lambda = G.lambda[k] ?? 1;
    const wobK = G.wobK[k] ?? 0;
    const wobW = G.wobW[k] ?? 0;
    const wobP = G.wobP[k] ?? 0;
    const wob =
      (G.wobA[k] ?? 0) *
      (Math.sin(c * wobK + tm * wobW + wobP) +
        G.wobSecond * Math.sin(c * wobK * 2.3 - tm * wobW * 1.4 + wobP * 2 + 1));
    const u = (s - w.speed * tm + wob) / lambda + (G.offset[k] ?? 0);
    const b = blur / lambda;
    const raw = meadowFront(u - Math.floor(u), b);
    const front = raw + (G.frontMean - raw) * smoothstep(G.blurFrom, G.blurTo, b);
    const n = Math.sin(
      GLSL_TAU * (G.gateStep[k] ?? 0) * u +
        c * (G.gateK[k] ?? 0) +
        tm * (G.gateW[k] ?? 0) +
        (G.gateP[k] ?? 0),
    );
    sum += (G.weight[k] ?? 0) * smoothstep(w.threshold, w.threshold + G.gateSoft, n) * front;
  }
  let g = (w.strength * sum) / (1 + G.softclip * Math.max(sum, 0));
  if (w.nowAge >= 0 && w.nowAge < G.nowLife) {
    const at = G.nowStart + G.nowPace * w.speed * w.nowAge;
    const d = at - s - G.nowWob * Math.sin(c * G.nowWobK + G.nowWobP);
    const edge = G.nowEdge + blur;
    const life =
      smoothstep(0, G.nowRise, w.nowAge) * (1 - smoothstep(G.nowLife * 0.6, G.nowLife, w.nowAge));
    g += G.nowGain * life * smoothstep(0, edge, d) * Math.exp(-Math.max(d - edge, 0) / G.nowTail);
  }
  if (w.passAmp > 0) {
    const d = w.passFront - s - G.nowWob * Math.sin(c * G.nowWobK + G.nowWobP);
    const edge = MEADOW_MOVE.gustEdge + blur;
    g +=
      MEADOW_MOVE.gustGain *
      w.passAmp *
      smoothstep(0, edge, d) *
      Math.exp(-Math.max(d - edge, 0) / MEADOW_MOVE.gustTail);
  }
  return g;
}

// ---- the near grass (shared with shader.ts) -----------------------------------------------------

/** A layer of near grass. Lengths in screen heights (heights before the grass-height knob). */
export interface MeadowLayer {
  /** Depth, for the gust at its roots. */
  readonly z: number;
  /** Where the roots are, below the frame. */
  readonly root: number;
  /** One blade per column this wide. */
  readonly pitch: number;
  readonly hMin: number;
  readonly hMax: number;
  /** Half-width of a blade at its root. */
  readonly width: number;
  /** Length and half-width of the seed head on a flowering stalk. */
  readonly spike: number;
  readonly spikeWidth: number;
  /** Share of the edge density kept in the middle of the frame, which stays open onto the field. */
  readonly centre: number;
  /** Share of the edge height the blades keep in the middle of the frame. */
  readonly low: number;
  /** Share of flowering stalks with a seed head (the rest are leaf blades). */
  readonly stalks: number;
  /** Darker toward the viewer: the nearest grass stands in its own shade. */
  readonly shade: number;
}

export const MEADOW_LAYERS: readonly MeadowLayer[] = [
  // The nearest grass: wide dark blades and seed heads, tall at the sides where they rise past the
  // horizon, short along the bottom in the middle, so they frame the view without closing it.
  {
    z: 1.6,
    root: -0.06,
    pitch: 0.036,
    hMin: 0.16,
    hMax: 0.7,
    width: 0.012,
    spike: 0.06,
    spikeWidth: 0.008,
    centre: 0.6,
    low: 0.3,
    stalks: 0.3,
    shade: 0.65,
  },
  // A little further: mostly flowering grasses, their seed heads against the bright field.
  {
    z: 3,
    root: -0.03,
    pitch: 0.045,
    hMin: 0.12,
    hMax: 0.34,
    width: 0.006,
    spike: 0.045,
    spikeWidth: 0.0055,
    centre: 0.45,
    low: 0.6,
    stalks: 0.65,
    shade: 0.9,
  },
];

/** Grass height knob k scales every blade by MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN × k. */
export const MEADOW_HEIGHT_MIN = 0.45;
export const MEADOW_HEIGHT_SPAN = 1.1;
/** Largest lean (tip offset / (BEND_SHAPE × height)) and bow; a bow of 1 would fold the blade down by MEADOW_BOW of its height. */
export const MEADOW_LEAN_MAX = 0.55;
export const MEADOW_AWAY_MAX = 0.7;
export const MEADOW_BEND_SHAPE = 0.6;
export const MEADOW_BOW = 0.45;
/** How far a blade's centreline can stray from its root, per screen height above the roots. */
export const MEADOW_REACH =
  (MEADOW_BEND_SHAPE * MEADOW_LEAN_MAX) / (1 - MEADOW_BOW * MEADOW_AWAY_MAX);
/** Extra reach per layer: a leaning seed head and the blade's own width. */
export const MEADOW_LAYER_PAD: readonly number[] = MEADOW_LAYERS.map(
  (layer) =>
    layer.spike * (MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN) * 0.8 +
    layer.width * 1.5 +
    layer.spikeWidth,
);
/** Columns either side of the frame in uSim1, enough for the tallest blades leaning their furthest. */
export const MEADOW_MARGIN =
  1 +
  Math.max(
    ...MEADOW_LAYERS.map((layer, l) => {
      const scale = MEADOW_HEIGHT_MIN + MEADOW_HEIGHT_SPAN;
      const top = (layer.hMax + layer.spike) * scale;
      return Math.ceil((MEADOW_REACH * top + (MEADOW_LAYER_PAD[l] ?? 0)) / layer.pitch);
    }),
  );

// ---- clocks and seeds (shared with shader.ts) ---------------------------------------------------

export const SECTORS = 16;
export const MAX_SEEDS = 32;
export const SEED_GROUP = 8;
export const SEED_GROUPS = MAX_SEEDS / SEED_GROUP;
const CLOCK_TEXELS = 2 + SECTORS;
const SEED_ROWS = 3;
const SEEDS_PER_SECTOR = 4;
const CLOCK_SEEDS = SECTORS * SEEDS_PER_SECTOR;

// ---- the simulation's own tuning ----------------------------------------------------------------

/** Simulated seconds per step, and the most steps one frame may take (a hitch drops time). */
const STEP = 1 / 60;
const MAX_STEPS = 8;
/** Seconds pre-run before a meadow is first shown, and on a reseed (the blades only need the last few). */
const PREWARM = 16;
const BLADE_PREWARM = 3;
const PREWARM_STEPS = Math.round(PREWARM / STEP);
const BLADE_FROM = PREWARM_STEPS - Math.round(BLADE_PREWARM / STEP);
/**
 * The pre-run is a count of steps, never a duration, so the opening meadow does not depend on how
 * fast the machine is: this is only how long one frame may spend on the first meadow's (at least;
 * the frame's own budget raises it, to all of it under test) before the rest waits for the next
 * frame. A reseed's, with the old meadow still on screen, takes the frame's budget alone. Until it
 * is done the sim holds its clock and uploads nothing new.
 */
const PREWARM_BUDGET_MS = 90;
/** Seeds let go this much more readily while pre-running, so the page opens with some in the air. */
const PREWARM_DETACH = 3;

// Near grass springs.
/**
 * Natural frequencies (Hz) and damping ratio: a slow, heavy sway with a little overshoot. Kept slow
 * and small so a moving blade's edge crosses a dither cell at most once or twice a second.
 */
const BLADE_FREQ_MIN = 0.28;
const BLADE_FREQ_MAX = 0.5;
const BLADE_DAMPING = 0.45;
/** Lean and bow per unit of gust (along the wind's sideways and away components). */
const BLADE_BEND = 0.32;
const BLADE_BOW = 0.7;
/** The breeze's own slow sway, at no wind and added per unit of wind. */
const BLADE_FLUTTER = 0.01;
const BLADE_FLUTTER_WIND = 0.03;

// Dandelion clocks.
/** Where the clocks stand: share of the width, head height (uv), head radius (screen heights), depth. The first stands in the sky above the horizon, well clear of the low sun's glare (left of centre at golden hour) and of the mown M. */
const CLOCK_SLOTS: readonly { share: number; head: number; radius: number; z: number }[] = [
  { share: 0.52, head: 0.56, radius: 0.046, z: 3 },
  { share: 0.77, head: 0.37, radius: 0.04, z: 3.4 },
  { share: 0.16, head: 0.31, radius: 0.054, z: 2.4 },
  { share: 0.62, head: 0.27, radius: 0.034, z: 4 },
  { share: 0.45, head: 0.21, radius: 0.03, z: 4.6 },
];
/** Lifecycle (s): bud to open clock, appearing, fading when no longer wanted, standing bare, wilting, gone before the next. */
const OPEN_TIME = 10;
const APPEAR_TIME = 1.5;
const LEAVE_TIME = 2;
const BARE_HOLD = 10;
const WILT_TIME = 6;
const GONE_HOLD = 4;
/** How each slot starts: the share of its seeds left, and how far it has opened (below 0: still a closed bud). */
const CLOCK_START: readonly { fill: number; open: number }[] = [
  { fill: 0.92, open: 1 },
  { fill: 1, open: 0.45 - PREWARM / OPEN_TIME },
  { fill: 0.5, open: 1 },
  { fill: 0.8, open: 1 },
  { fill: 0.3, open: 1 },
];
/** Stalk roots, below the frame. */
const CLOCK_ROOT = -0.04;
/** A new clock's place, size and height wander this much from its slot. */
const CLOCK_JITTER_SHARE = 0.06;
const CLOCK_JITTER_HEAD = 0.05;
const CLOCK_JITTER_RADIUS = 0.2;
/** The stalks nod slowly and only a little: the heads' fine spokes must not slide across the cells. */
const CLOCK_FREQ = 0.35;
const CLOCK_DAMPING = 0.5;
const CLOCK_BEND = 0.16;
const CLOCK_BOW = 0.25;
const CLOCK_FLUTTER = 0.012;
/** A wilting stalk droops this far (bow) and leans downwind. */
const WILT_DROOP = 0.7;
const WILT_LEAN = 0.3;
/** A clock counts as bare with this many seeds left. */
const BARE_LEFT = 5;
/** Seeds let go per second in a lull, and in a gust (load between DETACH_FROM and DETACH_TO). */
const DETACH_CALM = 0.05;
const DETACH_GUST = 1.3;
const DETACH_FROM = 0.15;
const DETACH_TO = 0.85;
/** The sectors' shown fill follows the seeds left at this rate (/s), so a seed visibly pulls away. */
const FILL_EASE = 3;
/**
 * Rain closes the heads over CLOSE_TIME seconds and holds the seeds: the first drizzle closes them
 * this far, more with the amount; a closed head is this much smaller (and folded narrow in the shader).
 */
const CLOSE_DRIZZLE = 0.55;
const CLOSE_PER_RAIN = 0.6;
const CLOSE_SHARE = 0.35;
const CLOSE_TIME = 4;

// Seeds in the air (screen heights per second unless stated). The air's speeds are paces seen at
// SEED_REF_DEPTH; see there.
/** Pappus radius, world units; never drawn below this many cells across its radius. */
const SEED_RADIUS = 0.034;
const SEED_MIN_CELLS = 2.2;
/** Seconds for a seed to take up the speed of the air around it. */
const SEED_DRAG = 0.7;
/** Drift along the wind: the breeze (at no wind, added at full wind), and per unit of gust. */
const SEED_BREEZE = 0.035;
const SEED_BREEZE_WIND = 0.05;
const SEED_GUST = 0.2;
/** Climb per unit of gust, a warm afternoon's updraft, the settling speed (raised by rain). */
const SEED_LIFT = 0.085;
const SEED_THERMAL = 0.012;
const SEED_SINK = 0.02;
const SEED_RAIN_SINK = 3;
/** The seed's own eddies: speed, and their rates (rad/s). */
const SEED_EDDY = 0.02;
const SEED_EDDY_RATE = 0.45;
/**
 * The air moves every seed in the world, along the gust direction (meadowWind's dir: across the view
 * and away from it), so drifting off and drifting away are one motion. Its speeds above are given as
 * the paces they make on screen at this depth (the nearest clocks'), and are the same world speeds
 * for every seed: farther ones cross the frame more slowly and close in on the horizon as they go.
 */
const SEED_REF_DEPTH = 3;
/** World units per screen height at SEED_REF_DEPTH: turns the paces above into world speeds. */
const SEED_AIR = SEED_REF_DEPTH / MEADOW_FOCAL;
/** The eye at its rest height: the seeds live in the world and are projected through it. */
const CAMERA = new LevelCamera({
  horizon: MEADOW_HORIZON,
  eye: MEADOW_GROUND,
  focal: MEADOW_FOCAL,
});
/** Life (s): at least, plus up to; fading out over the last FADE seconds. Depth over which seeds fade into the haze. */
const SEED_LIFE = 26;
const SEED_LIFE_SPAN = 18;
const SEED_FADE = 3;
const SEED_DEPTH_FADE_FROM = 9;
const SEED_DEPTH_FADE_TO = 14;
/** Tilt (rad) per unit of sideways speed, and how quickly it follows. */
const SEED_TILT = 1.6;
const SEED_TILT_TIME = 0.6;
/** Outward speed a seed leaves its head with. */
const SEED_POP = 0.02;
/** Seeds within this margin (screen heights) outside the frame are kept; beyond, let go. */
const SEED_MARGIN = 0.12;

// The breath: the pointer over the page blows softly on whatever is near it.
/** Radius (screen heights), strength at rest, the speed (screen heights/s) for a full breath, extra while held. */
const BREATH_RADIUS = 0.14;
const BREATH_REST = 0.35;
const BREATH_FULL_SPEED = 0.8;
const BREATH_HELD = 0.6;
/** Seconds to fade in and out, and to follow the pointer's speed. */
const BREATH_IN = 0.25;
const BREATH_OUT = 0.5;
const BREATH_FOLLOW = 0.2;
/** Lean and bow per unit of breath on grass and clocks; push on seeds; extra pull on a clock's seeds. */
const BREATH_BEND = 0.5;
const BREATH_BOW = 0.35;
const BREATH_CLOCK = 0.35;
const BREATH_SEED = 0.25;
const BREATH_DETACH = 0.6;

// A click: seeds blown off the nearest clock.
const CLICK_BURST = 7;
const CLICK_SPEED = 0.2;
const CLICK_LIFT = 0.05;
const CLICK_SHOVE = 1.2;

// The passage (MEADOW_MOVE is the part the shader shares).
/** Arriving, while the first gust sweeps: seeds come away this many times more readily, and are lifted (screen heights per second). */
const ENTRY_DETACH = 3;
const ENTRY_LIFT = 0.1;
/**
 * Leaving, a burst of seeds from every ripe clock: per clock per second, between these seconds of
 * the exit (ramped over 0.15 and 0.2 s), kicked downwind at this speed with a little lift; the air
 * then carries them downwind and up with this much extra speed (screen heights per second).
 */
const EXIT_BURST = 12;
const EXIT_BURST_FROM = 0.1;
const EXIT_BURST_TO = 1.1;
const EXIT_KICK = 0.45;
const EXIT_KICK_LIFT = 0.08;
const EXIT_PUSH = 0.9;
const EXIT_LIFT = 0.12;
/** No passage gust: what the pre-run runs under. */
const NO_PASSAGE_GUST: Readonly<PassageGust> = { front: 0, amp: 0 };

type MeadowKnob = "wind" | "gusts" | "gustRate" | "dandelions" | "meadowSeed" | "rain";

export class MeadowSimError extends Error {}

/** A stable 0..1 per (a, b): a column's own sway, unchanged by resizes or re-seeding. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Blade {
  lean: Spring;
  bow: Spring;
  /** Lean and bow a step before: drawn between them and the springs'. */
  leanWas: number;
  bowWas: number;
  omega: number;
  phase: number;
}

type ClockPhase = "gone" | "opening" | "ripe" | "bare" | "wilting";

interface Clock {
  phase: ClockPhase;
  /** Seconds in the current phase. */
  timer: number;
  presence: number;
  /** Below 0 a closed bud, 0..1 opening, 1 open. */
  open: number;
  wilt: number;
  /** Root x as a share of the width, head height at rest (uv), head radius (screen heights), depth. */
  share: number;
  head: number;
  radius: number;
  z: number;
  /** Seeds left per sector, and the fill shown (easing after them). */
  counts: number[];
  shown: number[];
  lean: Spring;
  bow: Spring;
  phaseOffset: number;
  headX: number;
  headY: number;
  headVX: number;
  headVY: number;
  /** What is drawn of it as it stood a step before: drawn between that and now. */
  presenceWas: number;
  openWas: number;
  shownWas: number[];
  leanWas: number;
  bowWas: number;
}

interface Seed {
  live: boolean;
  /** World position (x right of the view's centre line, y above the ground, z away from the eye) and velocity, world units and per second. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Where it is drawn, between its last two steps: screen heights right of the frame's centre line (for sorting and packing). */
  sx: number;
  age: number;
  life: number;
  /** Pappus radius, world units. */
  size: number;
  /** The tuft turning over: phase and rate (rad, rad/s). */
  tumble: number;
  tumbleRate: number;
  /** Phase of its own eddies. */
  drift: number;
  tilt: number;
  /** Position, age, tumble and tilt a step before: drawn between them and now. */
  xWas: number;
  yWas: number;
  zWas: number;
  ageWas: number;
  tumbleWas: number;
  tiltWas: number;
}

function remaining(clock: Clock): number {
  let n = 0;
  for (const count of clock.counts) n += count;
  return n;
}

/** A seed as it stands becomes the step before: the next step is drawn from it. */
function keepSeed(seed: Seed): void {
  seed.xWas = seed.x;
  seed.yWas = seed.y;
  seed.zWas = seed.z;
  seed.ageWas = seed.age;
  seed.tumbleWas = seed.tumble;
  seed.tiltWas = seed.tilt;
}

const byX = (a: Seed, b: Seed): number => a.sx - b.sx;

class MeadowSim implements SceneSim {
  readonly #knobs: KnobReader<MeadowKnob>;
  readonly #textures: readonly (WebGLTexture | undefined)[];
  readonly #seedTexture: DataTexture;
  readonly #bladeTexture: DataTexture;
  readonly #clockTexture: DataTexture;
  readonly #seedData = new Float32Array(MAX_SEEDS * SEED_ROWS * 4);
  readonly #clockData = new Float32Array(CLOCK_TEXELS * MAX_CLOCKS * 4);
  #bladeData = new Float32Array(2 * 2);
  #bladeWidth = 1;
  readonly #random = new Random();
  readonly #wind: MeadowWind = {
    dirX: 1,
    dirZ: 0,
    speed: 1,
    strength: 0,
    threshold: 1,
    nowAge: -1,
    passFront: 0,
    passAmp: 0,
  };
  /** This frame's passage: the gust, how freely seeds come away (x), the burst rate per clock, the air's extra push and lift on seeds, and the camera's height above rest. */
  readonly #pass: PassageGust = { front: 0, amp: 0 };
  #boost = 1;
  #burst = 0;
  #push = 0;
  #lift = 0;
  #drop = 0;

  readonly #blades: Blade[][] = MEADOW_LAYERS.map(() => []);
  readonly #clocks: Clock[] = Array.from({ length: MAX_CLOCKS }, (): Clock => ({
    phase: "gone",
    timer: GONE_HOLD,
    presence: 0,
    open: 0,
    wilt: 0,
    share: 0,
    head: 0,
    radius: 0,
    z: 1,
    counts: new Array<number>(SECTORS).fill(0),
    shown: new Array<number>(SECTORS).fill(0),
    lean: { x: 0, v: 0 },
    bow: { x: 0, v: 0 },
    phaseOffset: 0,
    headX: 0,
    headY: 0,
    headVX: 0,
    headVY: 0,
    presenceWas: 0,
    openWas: 0,
    shownWas: new Array<number>(SECTORS).fill(0),
    leanWas: 0,
    bowWas: 0,
  }));
  readonly #seeds: Seed[] = Array.from({ length: MAX_SEEDS }, (): Seed => ({
    live: false,
    x: 0,
    y: 0,
    z: 1,
    vx: 0,
    vy: 0,
    vz: 0,
    sx: 0,
    age: 0,
    life: 1,
    size: SEED_RADIUS,
    tumble: 0,
    tumbleRate: 0,
    drift: 0,
    tilt: 0,
    xWas: 0,
    yWas: 0,
    zWas: 1,
    ageWas: 0,
    tumbleWas: 0,
    tiltWas: 0,
  }));
  readonly #sorted: Seed[] = [];

  // Knobs, as of this frame.
  #windKnob = 0;
  #gusts = 0;
  #gustRate = 0;
  #rain = 0;
  #count = 0;
  #arrangement = Number.NaN;

  #aspect = 16 / 9;
  #rows = 540;
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  #warm = false;
  /** The pre-run's progress: the step to resume at, and the shader's clock where it ends (NaN: not begun). */
  #warmFrom = 0;
  #warmClock = Number.NaN;
  /** Whether a meadow has been uploaded: a reseed's pre-run then takes the frame's budget alone. */
  #shown = false;
  #dirty = true;
  /** How closed the heads are against the rain, 0..1, now and a step before. */
  #closed = 0;
  #closedWas = 0;

  // The breath: where, how strong, and what feeds it. It follows the pointer frame by frame on the
  // scene clock, as an interaction does, so it parts the field's grass even with the motion at 0.
  #breath = 0;
  #breathX = 0;
  #breathY = 0;
  #presence = 0;
  #speed = 0;
  #lastX = 0;
  #lastY = 0;
  #hadPointer = false;
  /** Unit direction away from the breath at the last #breathAt sample. */
  #pushX = 0;
  #pushY = 0;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader<MeadowKnob>("meadow", params, [
      "wind",
      "gusts",
      "gustRate",
      "dandelions",
      "meadowSeed",
      "rain",
    ]);
    this.#seedTexture = new DataTexture(gl, {
      width: MAX_SEEDS,
      height: SEED_ROWS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#bladeTexture = new DataTexture(gl, {
      width: 1,
      height: 2,
      format: "rg16f",
      filter: "nearest",
    });
    this.#clockTexture = new DataTexture(gl, {
      width: CLOCK_TEXELS,
      height: MAX_CLOCKS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#textures = [
      this.#seedTexture.texture,
      this.#bladeTexture.texture,
      this.#clockTexture.texture,
    ];
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    this.#windKnob = knobs.value(frame, "wind");
    this.#gusts = knobs.value(frame, "gusts");
    this.#gustRate = knobs.value(frame, "gustRate");
    this.#rain = knobs.value(frame, "rain");
    this.#count = Math.round(clamp(knobs.value(frame, "dandelions"), 0, MAX_CLOCKS));
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#rows = Math.max(1, frame.height);
    this.#fitBlades();

    const arrangement = Math.round(knobs.value(frame, "meadowSeed"));
    if (arrangement !== this.#arrangement) this.#reset(arrangement);

    const enter = frame.passage.enter;
    const exit = frame.passage.exit;
    // The shader's clock: everything it draws moves on the motion clock (uMotionTime).
    const motion = Math.max(0, frame.motion);
    const tmNow = frame.motionTime;
    const fired = frame.motionTriggers?.[GUST_TRIGGER];
    const ageNow =
      fired === undefined || (frame.triggers[GUST_TRIGGER] ?? -1e4) < -1e3 ? -1 : tmNow - fired;
    if (!this.#warm) {
      // Pre-run PREWARM seconds up to the moment the frame it starts in began, where the live steps
      // take over, a step count over as many frames as the budget needs; until it is done nothing
      // else moves. The first meadow takes PREWARM_BUDGET_MS a frame at least; a reseed, with the
      // old meadow still on screen, the frame's budget.
      if (Number.isNaN(this.#warmClock)) this.#warmClock = tmNow - Math.max(0, frame.dt) * motion;
      this.#warmFrom = runBudgeted(
        (k) => this.#prewarmStep(k),
        this.#shown ? frame.budget : Math.max(PREWARM_BUDGET_MS, frame.budget),
        PREWARM_STEPS,
        this.#warmFrom,
        32,
      );
      if (this.#warmFrom < PREWARM_STEPS) return this.#textures;
      this.#warm = true;
      // Arriving, the sky starts clear of the pre-run's seeds: the first gust lifts the first ones.
      if (enter < 1) for (const seed of this.#seeds) seed.live = false;
    }

    this.#choreograph(enter, exit);
    this.#follow(frame.pointer, frame.dt);
    if (frame.pointer.pressed && frame.pointer.inside) this.#blowNearest(frame.pointer);

    const advance = Math.max(0, frame.dt) * motion;
    const steps = this.#clock.advance(advance);
    for (let i = 0; i < steps; i++) {
      const lag = this.#clock.lag(i);
      this.#step(tmNow - lag, ageNow < 0 ? -1 : ageNow - lag, this.#boost, true, this.#pass);
    }

    // Drawn between the last two steps, so every frame that moves the clock repaints.
    if (advance > 0 || this.#dirty) {
      this.#pack(this.#clock.alpha);
      this.#seedTexture.upload(this.#seedData);
      this.#bladeTexture.upload(this.#bladeData);
      this.#clockTexture.upload(this.#clockData);
      this.#dirty = false;
      this.#shown = true;
    }
    return this.#textures;
  }

  dispose(): void {
    this.#seedTexture.dispose();
    this.#bladeTexture.dispose();
    this.#clockTexture.dispose();
  }

  /** Columns of near grass for the frame's width (the margins cover blades leaning in from outside). */
  #fitBlades(): void {
    let width = 1;
    MEADOW_LAYERS.forEach((layer, l) => {
      const columns = Math.ceil(this.#aspect / layer.pitch) + 2 * MEADOW_MARGIN;
      width = Math.max(width, columns);
      const blades = this.#blades[l];
      if (!blades || blades.length === columns) return;
      blades.length = 0;
      for (let j = 0; j < columns; j++) {
        const column = j - MEADOW_MARGIN;
        const omega =
          TAU * (BLADE_FREQ_MIN + (BLADE_FREQ_MAX - BLADE_FREQ_MIN) * hash01(column, l));
        blades.push({
          lean: { x: 0, v: 0 },
          bow: { x: 0, v: 0 },
          leanWas: 0,
          bowWas: 0,
          omega,
          phase: TAU * hash01(column, l + 17),
        });
      }
      this.#dirty = true;
    });
    if (width !== this.#bladeWidth) {
      this.#bladeWidth = width;
      this.#bladeData = new Float32Array(width * MEADOW_LAYERS.length * 2);
      this.#bladeTexture.resize(width, MEADOW_LAYERS.length);
      this.#dirty = true;
    }
  }

  /** A fresh meadow for this arrangement: clocks in their starting states, no seeds in the air. */
  #reset(arrangement: number): void {
    this.#arrangement = arrangement;
    this.#random.seed(Math.imul(arrangement + 1, 0x9e3779b1) ^ 0x6d2b79f5);
    for (const seed of this.#seeds) seed.live = false;
    for (const blades of this.#blades) {
      for (const blade of blades) {
        blade.lean.x = 0;
        blade.lean.v = 0;
        blade.bow.x = 0;
        blade.bow.v = 0;
        blade.leanWas = 0;
        blade.bowWas = 0;
      }
    }
    const side = this.#windKnob < 0 ? -1 : 1;
    this.#clocks.forEach((clock, i) => {
      this.#regrow(clock, i);
      const start = CLOCK_START[i] ?? { fill: 1, open: 1 };
      if (i >= this.#count) {
        this.#vanish(clock);
        clock.timer = GONE_HOLD;
        return;
      }
      clock.presence = 1;
      clock.open = start.open;
      if (start.open >= 1) {
        clock.open = 1;
        clock.phase = "ripe";
        const gone = Math.round((1 - start.fill) * CLOCK_SEEDS);
        for (let n = 0; n < gone; n++) {
          const sector = this.#pickSector(clock, Math.atan2(0.35, side));
          if (sector < 0) break;
          clock.counts[sector] = (clock.counts[sector] ?? 1) - 1;
        }
        clock.counts.forEach((count, k) => {
          clock.shown[k] = count / SEEDS_PER_SECTOR;
        });
      }
    });
    for (const clock of this.#clocks) this.#keepClock(clock);
    // The pre-run ends where the frame it starts in began, and the live steps go on from there.
    this.#clock.reset();
    this.#warm = false;
    this.#warmFrom = 0;
    this.#warmClock = Number.NaN;
    this.#dirty = true;
  }

  /** Pre-run step k of PREWARM_STEPS, ending at the clock the pre-run ends at (the blades only the last BLADE_PREWARM). */
  #prewarmStep(k: number): void {
    this.#step(
      this.#warmClock - (PREWARM_STEPS - 1 - k) * STEP,
      -1,
      PREWARM_DETACH,
      k >= BLADE_FROM,
      NO_PASSAGE_GUST,
    );
  }

  /** This frame's part of the passage: its gust, the seeds' freedom, burst and lift, and the camera's height. */
  #choreograph(enter: number, exit: number): void {
    const pass = meadowPassageGust(this.#pass, enter, exit);
    if (this.#gusts <= 0) pass.amp = 0;
    const leaving = exit > 0;
    const tout = exit * MEADOW_PASSAGE.exit;
    const sweep = enter < 1 && !leaving ? pass.amp / MEADOW_MOVE.gustInAmp : 0;
    const rise = smoothstep(0.05, 0.45, tout);
    this.#boost = 1 + ENTRY_DETACH * sweep;
    this.#burst = leaving
      ? EXIT_BURST *
        smoothstep(EXIT_BURST_FROM, EXIT_BURST_FROM + 0.15, tout) *
        (1 - smoothstep(EXIT_BURST_TO - 0.2, EXIT_BURST_TO, tout))
      : 0;
    this.#push = leaving ? EXIT_PUSH * rise : 0;
    this.#lift = leaving ? EXIT_LIFT * rise : ENTRY_LIFT * sweep;
    const drop = meadowDrop(enter, exit);
    if (drop !== this.#drop) {
      this.#drop = drop;
      this.#dirty = true;
    }
  }

  #step(
    tm: number,
    nowAge: number,
    detachBoost: number,
    blades: boolean,
    pass: Readonly<PassageGust>,
  ): void {
    const wind = meadowWind(this.#wind, this.#windKnob, this.#gusts, this.#gustRate, nowAge, pass);
    const closing = this.#rain > 0 ? Math.min(1, CLOSE_DRIZZLE + CLOSE_PER_RAIN * this.#rain) : 0;
    this.#closedWas = this.#closed;
    this.#closed += (closing - this.#closed) * (1 - Math.exp(-STEP / CLOSE_TIME));
    if (blades) this.#stepBlades(tm, wind);
    this.#stepClocks(tm, wind, detachBoost);
    this.#stepSeeds(tm, wind);
  }

  #stepBlades(tm: number, wind: MeadowWind): void {
    const aspect = this.#aspect;
    const flutter = BLADE_FLUTTER + BLADE_FLUTTER_WIND * Math.abs(this.#windKnob);
    MEADOW_LAYERS.forEach((layer, l) => {
      const blades = this.#blades[l];
      if (!blades) return;
      const breathY = layer.root + 0.3 * (layer.hMin + layer.hMax);
      blades.forEach((blade, j) => {
        const x = (j - MEADOW_MARGIN + 0.5) * layer.pitch;
        const g = meadowGust(wind, CAMERA.worldX(x - 0.5 * aspect, layer.z), layer.z, tm, 0);
        const push = this.#breathAt(x, breathY);
        const sway = flutter * Math.sin(tm * blade.omega * 0.37 + blade.phase);
        blade.leanWas = blade.lean.x;
        blade.bowWas = blade.bow.x;
        springStep(
          blade.lean,
          clamp(
            wind.dirX * BLADE_BEND * g + sway + this.#pushX * push * BREATH_BEND,
            -MEADOW_LEAN_MAX,
            MEADOW_LEAN_MAX,
          ),
          blade.omega,
          BLADE_DAMPING,
          STEP,
        );
        springStep(
          blade.bow,
          clamp(wind.dirZ * BLADE_BOW * g + push * BREATH_BOW, -0.2, MEADOW_AWAY_MAX),
          blade.omega,
          BLADE_DAMPING,
          STEP,
        );
      });
    });
  }

  #stepClocks(tm: number, wind: MeadowWind, detachBoost: number): void {
    const aspect = this.#aspect;
    const side = wind.dirX < 0 ? -1 : 1;
    // Seeds leave from the downwind side of a head, a little above its equator.
    const downwind = Math.atan2(0.35, side);
    const omega = TAU * CLOCK_FREQ;
    const ease = 1 - Math.exp(-STEP * FILL_EASE);
    this.#clocks.forEach((clock, i) => {
      const wanted = i < this.#count;
      this.#keepClock(clock);
      this.#live(clock, i, wanted);
      if (clock.phase === "gone" && clock.presence <= 0) return;

      const g = meadowGust(
        wind,
        CAMERA.worldX(clock.headX - 0.5 * aspect, clock.z),
        clock.z,
        tm,
        0,
      );
      const push = this.#breathAt(clock.headX, clock.headY);
      const sway = CLOCK_FLUTTER * Math.sin(tm * 1.3 + clock.phaseOffset);
      springStep(
        clock.lean,
        clamp(
          wind.dirX * CLOCK_BEND * g +
            sway +
            this.#pushX * push * BREATH_CLOCK +
            side * WILT_LEAN * clock.wilt,
          -MEADOW_LEAN_MAX,
          MEADOW_LEAN_MAX,
        ),
        omega,
        CLOCK_DAMPING,
        STEP,
      );
      springStep(
        clock.bow,
        clamp(
          wind.dirZ * CLOCK_BOW * g + push * BREATH_BOW + WILT_DROOP * clock.wilt,
          -0.2,
          MEADOW_AWAY_MAX,
        ),
        omega,
        CLOCK_DAMPING,
        STEP,
      );
      const x0 = clock.headX;
      const y0 = clock.headY;
      this.#placeHead(clock);
      clock.headVX = (clock.headX - x0) / STEP;
      clock.headVY = (clock.headY - y0) / STEP;

      if (wanted && (clock.phase === "ripe" || clock.phase === "bare")) {
        const left = remaining(clock);
        if (left > 0) {
          const load = Math.max(g, 0) + push * BREATH_DETACH;
          const rate =
            (DETACH_CALM + DETACH_GUST * smoothstep(DETACH_FROM, DETACH_TO, load)) *
            (0.35 + (0.65 * left) / CLOCK_SEEDS) *
            (1 - this.#closed) *
            detachBoost;
          if (this.#random.next() < rate * STEP) this.#detach(clock, downwind, 0, 0);
          if (this.#burst > 0 && this.#random.next() < this.#burst * STEP) {
            const kick = EXIT_KICK * (0.6 + 0.8 * this.#random.next());
            this.#detach(clock, downwind, side * kick, EXIT_KICK_LIFT * this.#random.next());
          }
        }
      }
      const opened = clamp(clock.open, 0, 1);
      clock.counts.forEach((count, k) => {
        const shown = clock.shown[k] ?? 0;
        clock.shown[k] = shown + (opened * (count / SEEDS_PER_SECTOR) - shown) * ease;
      });
    });
  }

  /** The clock's life: a bud opens, the seeds go, the bare stalk wilts, and a new one comes up. */
  #live(clock: Clock, slot: number, wanted: boolean): void {
    clock.timer += STEP;
    if (!wanted && clock.phase !== "gone") {
      clock.presence = Math.max(0, clock.presence - STEP / LEAVE_TIME);
      if (clock.presence <= 0) this.#vanish(clock);
      return;
    }
    switch (clock.phase) {
      case "gone":
        if (wanted && clock.timer >= GONE_HOLD) this.#regrow(clock, slot);
        break;
      case "opening":
        clock.presence = Math.min(1, clock.presence + STEP / APPEAR_TIME);
        clock.open += STEP / OPEN_TIME;
        if (clock.open >= 1) {
          clock.open = 1;
          clock.phase = "ripe";
          clock.timer = 0;
        }
        break;
      case "ripe":
        clock.presence = Math.min(1, clock.presence + STEP / APPEAR_TIME);
        if (remaining(clock) <= BARE_LEFT) {
          clock.phase = "bare";
          clock.timer = 0;
        }
        break;
      case "bare":
        if (clock.timer >= BARE_HOLD) {
          clock.phase = "wilting";
          clock.timer = 0;
        }
        break;
      case "wilting":
        clock.wilt = Math.min(1, clock.wilt + STEP / WILT_TIME);
        clock.presence = 1 - smoothstep(0.45, 1, clock.wilt);
        if (clock.wilt >= 1) this.#vanish(clock);
        break;
      default: {
        const unreachable: never = clock.phase;
        throw new MeadowSimError(`meadow: unknown clock phase ${String(unreachable)}`);
      }
    }
  }

  /** A new clock near its slot: a closed bud on a fresh stalk, every seed in place. */
  #regrow(clock: Clock, slot: number): void {
    const random = this.#random;
    const at = CLOCK_SLOTS[slot] ?? { share: 0.5, head: 0.3, radius: 0.03, z: 3 };
    clock.phase = "opening";
    clock.timer = 0;
    clock.presence = 0;
    clock.open = 0;
    clock.wilt = 0;
    clock.share = at.share + (random.next() - 0.5) * CLOCK_JITTER_SHARE;
    clock.head = at.head + (random.next() - 0.5) * CLOCK_JITTER_HEAD;
    clock.radius =
      at.radius * (1 - 0.5 * CLOCK_JITTER_RADIUS + CLOCK_JITTER_RADIUS * random.next());
    clock.z = at.z;
    clock.counts.fill(SEEDS_PER_SECTOR);
    clock.shown.fill(0);
    clock.lean.x = 0;
    clock.lean.v = 0;
    clock.bow.x = 0;
    clock.bow.v = 0;
    clock.phaseOffset = random.next() * TAU;
    this.#placeHead(clock);
    clock.headVX = 0;
    clock.headVY = 0;
    // Drawn where it comes up, not slid there from where the last one stood.
    this.#keepClock(clock);
  }

  /** What is drawn of the clock as it stands becomes the step before: the next step is drawn from it. */
  #keepClock(clock: Clock): void {
    clock.presenceWas = clock.presence;
    clock.openWas = clock.open;
    clock.leanWas = clock.lean.x;
    clock.bowWas = clock.bow.x;
    clock.shown.forEach((fill, k) => {
      clock.shownWas[k] = fill;
    });
  }

  #vanish(clock: Clock): void {
    clock.phase = "gone";
    clock.timer = 0;
    clock.presence = 0;
  }

  /** The head sits on the bent stalk's tip; the shader draws the stalk to it with the same curve. */
  #placeHead(clock: Clock): void {
    clock.headX = this.#headX(clock, clock.lean.x);
    clock.headY = this.#headY(clock, clock.bow.x);
  }

  /** The head's x on a stalk leaning `lean` (screen heights from the frame's left edge). */
  #headX(clock: Clock, lean: number): number {
    const tall = clock.head - CLOCK_ROOT;
    return (
      clock.share * this.#aspect +
      MEADOW_BEND_SHAPE * clamp(lean, -MEADOW_LEAN_MAX, MEADOW_LEAN_MAX) * tall
    );
  }

  /** The head's height on a stalk bowed `bow` away (screen heights). */
  #headY(clock: Clock, bow: number): number {
    const tall = clock.head - CLOCK_ROOT;
    return CLOCK_ROOT + tall * (1 - MEADOW_BOW * clamp(bow, -0.2, MEADOW_AWAY_MAX));
  }

  /** A sector with seeds left, favouring those facing `toward` (radians) and the fuller ones; -1 if bare. */
  #pickSector(clock: Clock, toward: number): number {
    let best = -1;
    let bestScore = 0;
    clock.counts.forEach((count, k) => {
      if (count <= 0) return;
      const angle = ((k + 0.5) / SECTORS) * TAU;
      const score =
        (1.25 + Math.cos(angle - toward)) *
        (0.4 + this.#random.next()) *
        (0.5 + count / SEEDS_PER_SECTOR);
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    });
    return best;
  }

  /** Let one seed go from the side facing `toward`, with an extra kick; false if none could go. */
  #detach(clock: Clock, toward: number, kickX: number, kickY: number): boolean {
    const seed = this.#seeds.find((candidate) => !candidate.live);
    if (!seed) return false;
    const sector = this.#pickSector(clock, toward);
    if (sector < 0) return false;
    clock.counts[sector] = (clock.counts[sector] ?? 1) - 1;
    const random = this.#random;
    const angle = ((sector + 0.5 + (random.next() - 0.5) * 0.8) / SECTORS) * TAU;
    const reach = clock.radius * (1 - CLOSE_SHARE * this.#closed) * 0.85;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    seed.live = true;
    // Released where the head is seen, at its own depth, moving as the head and the kick move it on
    // screen there.
    seed.z = clock.z * (0.95 + 0.1 * random.next());
    const perHeight = 1 / CAMERA.scale(seed.z);
    seed.x = CAMERA.worldX(clock.headX + cos * reach - 0.5 * this.#aspect, seed.z);
    seed.y = CAMERA.worldY(clock.headY + sin * reach, seed.z);
    seed.vx = (clock.headVX + cos * SEED_POP + kickX) * perHeight;
    seed.vy = (clock.headVY + sin * SEED_POP + kickY) * perHeight;
    seed.vz = 0;
    seed.age = 0;
    seed.life = SEED_LIFE + SEED_LIFE_SPAN * random.next();
    seed.size = SEED_RADIUS * (0.85 + 0.3 * random.next());
    seed.tumble = random.next() * TAU;
    seed.tumbleRate = (0.3 + 0.5 * random.next()) * (random.next() < 0.5 ? -1 : 1);
    seed.drift = random.next() * TAU;
    seed.tilt = 0;
    // Drawn from where it leaves the head.
    keepSeed(seed);
    return true;
  }

  #stepSeeds(tm: number, wind: MeadowWind): void {
    const aspect = this.#aspect;
    const breeze = SEED_BREEZE + SEED_BREEZE_WIND * Math.abs(this.#windKnob);
    const sink = SEED_SINK * (1 + SEED_RAIN_SINK * this.#closed);
    const follow = 1 - Math.exp(-STEP / SEED_DRAG);
    const turn = 1 - Math.exp(-STEP / SEED_TILT_TIME);
    for (const seed of this.#seeds) {
      if (!seed.live) continue;
      keepSeed(seed);
      const g = meadowGust(wind, seed.x, seed.z, tm, 0);
      const lift = Math.max(g, 0);
      const eddy = tm * SEED_EDDY_RATE * (1 + 0.5 * Math.abs(seed.tumbleRate)) + seed.drift;
      // The air runs along the gust direction: for every unit it carries a seed across the view it
      // carries it dirZ / |dirX| away.
      const across = (breeze + SEED_GUST * Math.max(g, -0.1) + this.#push) * SEED_AIR;
      const along = across / Math.abs(wind.dirX);
      let airX = wind.dirX * along + SEED_EDDY * Math.sin(eddy) * SEED_AIR;
      let airY =
        (SEED_LIFT * lift +
          SEED_THERMAL -
          sink +
          SEED_EDDY * Math.cos(eddy * 0.77 + seed.drift) +
          this.#lift) *
        SEED_AIR;
      const airZ = wind.dirZ * along;
      // The breath blows in the frame: the same push on screen whatever the seed's depth.
      const push =
        (this.#breathAt(
          CAMERA.screenX(seed.x, seed.z) + 0.5 * aspect,
          CAMERA.screenY(seed.y, seed.z),
        ) *
          BREATH_SEED) /
        CAMERA.scale(seed.z);
      airX += this.#pushX * push;
      airY += this.#pushY * push;
      seed.vx += (airX - seed.vx) * follow;
      seed.vy += (airY - seed.vy) * follow;
      seed.vz += (airZ - seed.vz) * follow;
      seed.x += seed.vx * STEP;
      seed.y += seed.vy * STEP;
      seed.z += seed.vz * STEP;
      seed.age += STEP;
      seed.tumble += seed.tumbleRate * STEP;
      // The tuft leads, the seed hangs behind it: the stalk tilts with the drift across the frame.
      const tilt =
        clamp(-CAMERA.screenVX(seed.x, seed.z, seed.vx, seed.vz) * SEED_TILT, -0.7, 0.7) +
        0.12 * Math.sin(seed.tumble);
      seed.tilt += (tilt - seed.tilt) * turn;
      const sx = CAMERA.screenX(seed.x, seed.z);
      const sy = CAMERA.screenY(seed.y, seed.z);
      const out =
        Math.abs(sx) > 0.5 * aspect + SEED_MARGIN || sy < -SEED_MARGIN || sy > 1 + SEED_MARGIN;
      if (out || seed.age >= seed.life || seed.z >= SEED_DEPTH_FADE_TO) seed.live = false;
    }
  }

  /** Follow the pointer: present over the page, stronger as it moves or while held. */
  #follow(pointer: PrincipalState, dt: number): void {
    if (dt <= 0) return;
    const x = pointer.x * this.#aspect;
    const y = pointer.y;
    let speed = 0;
    if (pointer.inside && this.#hadPointer)
      speed = Math.hypot(x - this.#lastX, y - this.#lastY) / dt;
    this.#hadPointer = pointer.inside;
    this.#lastX = x;
    this.#lastY = y;
    this.#speed +=
      (Math.min(speed, 2 * BREATH_FULL_SPEED) - this.#speed) * (1 - Math.exp(-dt / BREATH_FOLLOW));
    this.#presence +=
      ((pointer.inside ? 1 : 0) - this.#presence) *
      (1 - Math.exp(-dt / (pointer.inside ? BREATH_IN : BREATH_OUT)));
    const target =
      this.#presence *
        (BREATH_REST + (1 - BREATH_REST) * Math.min(1, this.#speed / BREATH_FULL_SPEED)) +
      (pointer.inside && pointer.down ? BREATH_HELD : 0);
    this.#breath += (target - this.#breath) * (1 - Math.exp(-dt / BREATH_FOLLOW));
    if (pointer.inside) {
      this.#breathX = x;
      this.#breathY = y;
    }
    this.#dirty = true;
  }

  /** The breath's strength at (x, y); leaves the unit direction away from it in #pushX, #pushY. */
  #breathAt(x: number, y: number): number {
    this.#pushX = 0;
    this.#pushY = 0;
    if (this.#breath <= 0.001) return 0;
    const dx = x - this.#breathX;
    const dy = y - this.#breathY;
    const d2 = dx * dx + dy * dy;
    const d = Math.sqrt(d2) + 1e-4;
    this.#pushX = dx / d;
    this.#pushY = dy / d;
    return this.#breath * Math.exp(-d2 / (BREATH_RADIUS * BREATH_RADIUS));
  }

  /** A click blows a handful of seeds off the clock nearest the pointer, away from it. */
  #blowNearest(pointer: PrincipalState): void {
    const x = pointer.x * this.#aspect;
    const y = pointer.y;
    let best: Clock | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const clock of this.#clocks) {
      if (
        clock.presence < 0.5 ||
        (clock.phase !== "ripe" && clock.phase !== "bare") ||
        remaining(clock) === 0
      )
        continue;
      const d = Math.hypot(clock.headX - x, clock.headY - y);
      if (d < nearest) {
        nearest = d;
        best = clock;
      }
    }
    if (!best) return;
    const away = Math.atan2(best.headY - y, best.headX - x);
    const random = this.#random;
    for (let n = 0; n < CLICK_BURST; n++) {
      const speed = CLICK_SPEED * (0.6 + 0.8 * random.next());
      const spread = (random.next() - 0.5) * 0.9;
      if (
        !this.#detach(
          best,
          away,
          Math.cos(away + spread) * speed,
          Math.sin(away + spread) * speed + CLICK_LIFT,
        )
      )
        break;
    }
    best.lean.v += Math.cos(away) * CLICK_SHOVE;
    best.bow.v += 0.5 * CLICK_SHOVE;
    this.#dirty = true;
  }

  /** The textures' data, `alpha` of the way from the step before last to the last (FixedStep.alpha). */
  #pack(alpha: number): void {
    const aspect = this.#aspect;
    const drop = this.#drop;
    const seeds = this.#seedData;
    seeds.fill(0);
    const sorted = this.#sorted;
    sorted.length = 0;
    for (const seed of this.#seeds) {
      if (!seed.live) continue;
      seed.sx = CAMERA.screenX(lerp(seed.xWas, seed.x, alpha), lerp(seed.zWas, seed.z, alpha));
      sorted.push(seed);
    }
    sorted.sort(byX);
    const minRadius = SEED_MIN_CELLS / this.#rows;
    const groupRow = 2 * MAX_SEEDS * 4;
    for (let g = 0; g < SEED_GROUPS; g++) {
      const o = groupRow + g * 4;
      seeds[o] = 2;
      seeds[o + 1] = 2;
      seeds[o + 2] = -1;
      seeds[o + 3] = -1;
    }
    sorted.forEach((seed, n) => {
      const z = lerp(seed.zWas, seed.z, alpha);
      const age = lerp(seed.ageWas, seed.age, alpha);
      const y = CAMERA.screenY(lerp(seed.yWas, seed.y, alpha) - drop, z);
      const radius = Math.max((seed.size * MEADOW_FOCAL) / z, minRadius);
      const opacity =
        (1 - smoothstep(seed.life - SEED_FADE, seed.life, age)) *
        (1 - smoothstep(SEED_DEPTH_FADE_FROM, SEED_DEPTH_FADE_TO, z));
      const u = seed.sx / aspect + 0.5;
      const o0 = n * 4;
      seeds[o0] = u;
      seeds[o0 + 1] = y;
      seeds[o0 + 2] = radius;
      seeds[o0 + 3] = opacity;
      const o1 = (MAX_SEEDS + n) * 4;
      seeds[o1] = lerp(seed.tiltWas, seed.tilt, alpha);
      seeds[o1 + 1] = z;
      seeds[o1 + 2] = 0.55 + 0.45 * Math.abs(Math.cos(lerp(seed.tumbleWas, seed.tumble, alpha)));
      // The group's box, in uv, wide enough for the seed's halo and hanging stalk.
      const reach = 3 * radius;
      const o = groupRow + Math.floor(n / SEED_GROUP) * 4;
      seeds[o] = Math.min(seeds[o] ?? 2, u - reach / aspect);
      seeds[o + 1] = Math.min(seeds[o + 1] ?? 2, y - reach);
      seeds[o + 2] = Math.max(seeds[o + 2] ?? -1, u + reach / aspect);
      seeds[o + 3] = Math.max(seeds[o + 3] ?? -1, y + reach);
    });
    const breath = groupRow + SEED_GROUPS * 4;
    seeds[breath] = this.#breathX / aspect;
    seeds[breath + 1] = this.#breathY;
    seeds[breath + 2] = this.#breath;

    const width = this.#bladeWidth;
    const blades = this.#bladeData;
    blades.fill(0);
    this.#blades.forEach((layer, l) => {
      layer.forEach((blade, j) => {
        const o = (l * width + j) * 2;
        blades[o] = lerp(blade.leanWas, blade.lean.x, alpha);
        blades[o + 1] = lerp(blade.bowWas, blade.bow.x, alpha);
      });
    });

    const closed = lerp(this.#closedWas, this.#closed, alpha);
    const clocks = this.#clockData;
    clocks.fill(0);
    this.#clocks.forEach((clock, c) => {
      // Placed again here so a resize moves the clocks even while the scene stands still.
      this.#placeHead(clock);
      const o = c * CLOCK_TEXELS * 4;
      // The camera's height over rest lowers a clock in the frame, by its own depth.
      const rise = (MEADOW_FOCAL * drop) / clock.z;
      clocks[o] = clock.share;
      clocks[o + 1] = CLOCK_ROOT - rise;
      clocks[o + 2] = this.#headX(clock, lerp(clock.leanWas, clock.lean.x, alpha)) / aspect;
      clocks[o + 3] = this.#headY(clock, lerp(clock.bowWas, clock.bow.x, alpha)) - rise;
      let fullness = 0;
      clock.shown.forEach((fill, k) => {
        const shown = lerp(clock.shownWas[k] ?? fill, fill, alpha);
        clocks[o + (2 + k) * 4] = shown;
        fullness += shown;
      });
      clocks[o + 2 * 4 + 1] = clock.z;
      clocks[o + 2 * 4 + 2] = closed;
      clocks[o + 4] = clock.radius * (1 - CLOSE_SHARE * closed);
      clocks[o + 5] = lerp(clock.presenceWas, clock.presence, alpha);
      clocks[o + 6] = clamp(lerp(clock.openWas, clock.open, alpha), 0, 1);
      clocks[o + 7] = fullness / SECTORS;
    });
  }
}

/** The meadow's simulation, for a scene whose knobs include those MeadowKnob names (looked up by key). */
export function meadowSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new MeadowSim(gl, params);
}
