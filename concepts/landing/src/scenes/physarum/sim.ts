// Physarum polycephalum, the many-headed slime mould: a living network of veins that links its
// food into an efficient transport network, thickening the tubes that carry the most and letting
// the rest go. Laid out as the cities around Tokyo, its oat flakes grew a network much like the
// railways (A. Tero et al., "Rules for biologically inspired adaptive network design", Science 327,
// 2010). Grown here with Jeff Jones's agent model ("Characteristics of pattern formation and
// evolution in approximations of Physarum transport networks", Artificial Life 16(2), 2010) on the
// GPU (sims/gpu.ts):
//   - Each agent is a speck of plasmodium with a position and a heading. Every step it smells the
//     trail at three sensors ahead of it, turns toward the strongest smell, steps forward and
//     deposits trail where it lands; the trail spreads (a 3×3 blur) and evaporates. Specks follow
//     each other's trail and bundle into filaments, which knit into a reticulated lace over the
//     whole dish; the busiest filaments draw the most traffic and thicken into trunks.
//   - Oat flakes feed the specks that reach them and are where new plasmodium is born: a speck
//     that goes a minute without food dies and is reborn at a flake, heading out from it, so every
//     flake sends out a fan of fresh filaments. A hungry speck (half a minute since it ate) smells
//     a flake within its sensors' reach as strongly as a trunk, a fed one ignores food and roams.
//     So fed plasmodium spreads out over the lace and hungry plasmodium homes back in along it:
//     the filaments between flakes carry traffic both ways and thicken into trunks; when a flake
//     is eaten its trunks lose their traffic and relax back into lace. Food is sensed, never
//     poured into the trail, so the trail is only ever plasmodium (no glowing pool round a flake),
//     and it has no long-range scent: one pulled the whole population into the flakes' basins and
//     starved the lace.
//   - Salt (dragged across the dish), light (the sea on the Tokyo map, lit in the experiment so
//     the mould would shun it) and the dish's glass wall repel it, block it and kill the trail.
//   - Sensing saturates: where the plasmodium crowds onto a flake every sensor reads the same, so
//     specks cross it in straight lines and leave along the veins instead of circling it forever.
// Per frame the trail is normalised by its trunk level (Σt³ / Σt² outside the flakes, followed
// over a second or two), so the picture is the same at any population or evaporation and the
// shader can draw trunks bright and the lace dim; smoothed over half a second, so the specks'
// flicker never reaches the dither; and remembered over a minute, so abandoned veins leave a faint
// track of slime. A distance field along the veins from the heart (where the mould began) carries
// the shuttle streaming: a slow brightness wave running out along the veins, easing to a stop and
// running back every minute or so.
//
// The first frame opens on a grown network: a sketch of one (see "the sketch" below) seeds the
// trail and the view, the specks are spread over it, and a GPU prewarm (as many steps as ~130 ms
// allows) lets the mould take it over. The view crosses over from the sketch to the live mould as
// the steps come in, and the sketch lingers a while as slime. Without float render targets the
// scene shows the sketch, still, with its streaming.
//
// Textures:
//   uSim0  rg16f over the trail grid (the frame plus PHYSARUM_MARGIN texels on every side): R the
//          trail in units of its trunk level, smoothed; G its memory over the last minute.
//   uSim1  r32f at half resolution, nearest (r16f still, without float targets): distance along the
//          veins from the heart, screen heights (PHYSARUM_FAR off the network). 32-bit because it is
//          relaxed by adding steps of ~1/150 height, which half floats round away at a few heights.
//   uSim2  rgba16f PHYSARUM_MAX_FOOD × 3, nearest. Row 0 per flake: centre (screen uv), radius
//          (screen heights), presence (negative while it is being eaten). Row 1: turn (radians),
//          squash, grain (its own random number), 1 for a crumb. Row 2: texel 0 streaming phase
//          (0..1) and the heart's presence; texel 1 the M (centre uv, height in screen heights,
//          shown 0..1).
//   uSim3  rgba at half resolution: R food scent, G salt, B feeding (1 in a flake's pool, 0.5 at its
//          rim, a halo beyond), A light (the lit sea, and everything past the dish's glass wall).
import type { ParamDef } from "../../params.ts";
import { GpuCompute, gridSize, type Pass, type PingPong, type RenderTarget, type Scatter } from "../../sims/gpu.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

export class PhysarumError extends Error {}

const TAU = Math.PI * 2;

// ---- grids ------------------------------------------------------------------------------------

/**
 * Trail texels across the frame's shorter side, and at most along its longer one. Fine enough that
 * the specks occupy only ~10% of the texels (see physarumAgentCounts); the view's blur draws a
 * one-texel filament as a soft line ~2 cells wide.
 */
const TRAIL_SHORT = 400;
const TRAIL_LONG = 960;
/** Trail texels beyond each edge of the frame: the specks bounce off the grid's edge out of sight. */
export const PHYSARUM_MARGIN = 10;
/** Flake slots: the shader's loop and the passes' uniform arrays. */
export const PHYSARUM_MAX_FOOD = 32;
/**
 * The `agents` knob's choices (power-of-two state textures). On a 16:9 frame's 711 × 400 texels
 * they occupy ~6%, ~12% and ~23% of them: Jones's model knits a reticulated network at a few to
 * ~15% occupancy and condenses into a few thick bands and loops well above it.
 */
export const physarumAgentCounts = [16_384, 32_768, 65_536] as const;
/** Deposits are scaled so the trail's total is the same at any population. */
const REFERENCE_AGENTS = 32_768;

// ---- the mould --------------------------------------------------------------------------------

/** Agent steps per second at tempo 1 (one texel each): calm growth, a link in five to ten seconds. */
const STEPS_PER_SECOND = 40;
/** Most steps in one frame; a slow machine's mould runs slow rather than skipping. */
const MAX_STEPS = 4;
/** Steps a speck lives without reaching food (a minute): it roams the whole dish. */
const LIFE = 2400;
/** Texels per step. */
const SPEED = 1;
/** Random wobble per step (radians, full width): a little, so filaments wander rather than rule lines. */
const WANDER = 0.08;
/** Rotation per step (degrees): Jones's 45°, or the sensor angle where that is wider. */
const TURN_MIN = 45;
/** Sensed trail saturates here (× the trunk level): crowds on a flake read flat, so specks cross them. */
const SENSE_CAP = 1.5;
/** A flake as a hungry speck senses it (× the trunk level), and how hungry that is (share of LIFE left). */
const FOOD_SENSE = 1;
const HUNGRY = 0.5;
/** Salt, light and the dish's wall as sensed (× the trunk level). */
const REPEL = 6;
/** The scent laid along the M's strokes as sensed (× the trunk level), and its half-width in trail texels. */
const MARK_SCENT = 0.5;
const MARK_WIDTH = 10;
/** Trail one speck per texel keeps up at the reference population. */
const AGENT_UNIT = 0.1;
/** A flake feeds out to this many of its radii. */
const FEED_SCALE = 1.3;
/** Evaporation per step at evaporation 0 and 1 (log-spaced between; Jones's ~10% at 0.5). */
const LOSS_MIN = 0.03;
const LOSS_MAX = 0.3;
/** Specks seeded along the sketch's trunks, along its fans and at the flakes; the rest anywhere on the dish. */
const SEED_TRUNKS = 0.3;
const SEED_FANS = 0.12;
const SEED_FLAKES = 0.18;

// ---- the view ---------------------------------------------------------------------------------

/** The trail is shown smoothed over this many seconds: single specks' motion never reaches the dither. */
const VIEW_SECONDS = 0.7;
/**
 * Tone: a typical filament is shown at LACE_TONE (trunks at 1), through a power curve whose
 * exponent follows the mould's own contrast (the filament's share of the trunk level, as measured,
 * held within SHARE_MIN..SHARE_MAX; the exponent within GAMMA_MIN..GAMMA_MAX).
 */
const LACE_TONE = 0.3;
/** Below this share of the trunk level the trail is background haze, not a filament. */
const FILAMENT_FLOOR = 0.04;
const SHARE_MIN = 0.02;
const SHARE_MAX = 0.9;
const GAMMA_MIN = 0.3;
const GAMMA_MAX = 1.2;

/** The view pass's tone curve (see VIEW): `level` in trunk levels, `share` a filament's share of it. */
function tone(level: number, share: number): number {
  const gamma = clamp(Math.log(LACE_TONE) / Math.log(clamp(share, SHARE_MIN, SHARE_MAX)), GAMMA_MIN, GAMMA_MAX);
  return Math.pow(Math.max(level, 1e-6), gamma);
}

/**
 * Steps after a reset by which the view has crossed over from the sketch to the live mould, and its
 * smoothing (seconds) at the start of the crossing: a fast GPU's prewarm covers it, a slow one's
 * mould grows out of the sketch over its first seconds.
 */
const SETTLE_STEPS = 160;
const SETTLE_SECONDS = 1.5;
/** Slime memory: seconds it takes to follow the network, updated every MEMORY_EVERY seconds. */
const MEMORY_SECONDS = 50;
const MEMORY_EVERY = 0.5;
/** The trunk level follows the trail over this many seconds. */
const REF_SECONDS = 1.5;
/** Distance relaxation passes per frame (strides alternate 1 and 2 texels). */
const DIST_PASSES = 2;
/** Distance off the network, screen heights. */
export const PHYSARUM_FAR = 8;
/** Crossing lace or bare agar costs this many times more than following a vein. */
const COST_OFF = 40;
/** Streaming: wavelength along the veins (screen heights) and wave speed (heights per second). */
export const PHYSARUM_WAVE = 0.3;
const PULSE_SPEED = 0.05;
/** Shuttle streaming reverses every half period; the flow eases through zero over SHUTTLE_SOFT. */
const SHUTTLE_PERIOD = 96;
const SHUTTLE_SOFT = 0.06;
/** Phase of the shuttle at the start: flowing out, the first reversal after ~40 seconds. */
const SHUTTLE_START = 0.6;

// ---- prewarm ----------------------------------------------------------------------------------

/** GPU prewarm at a reset: steps in chunks, synced, until the budget is spent. */
const PREWARM_MS = 130;
const PREWARM_STEPS = 320;
const PREWARM_CHUNK = 8;

// ---- the sketch -------------------------------------------------------------------------------

/** How far trunks wander off their chord (share of its length). */
const TRUNK_WANDER = 0.07;
/** Tributaries fanning out of each flake: how many, how far (heights), how much they wander. */
const FAN_MIN = 4;
const FAN_MAX = 8;
const FAN_SHORT = 0.03;
const FAN_LONG = 0.08;
const FAN_WANDER = 0.12;
/** The lace: Voronoi cell size (heights), level (sketch units: trunks ~1.3) and line half-width (texels). */
const LACE_CELL = 0.07;
const LACE_LEVEL = 0.2;
const LACE_SIGMA = 0.6;

// ---- the dish ---------------------------------------------------------------------------------

/** The petri dish's radius as a share of the frame's half-diagonal: its glass wall cuts the corners. */
export const PHYSARUM_DISH = 0.9;

/** The dish's radius in screen heights for a frame aspect (its centre is the frame's). */
const dishRadius = (aspect: number): number => (PHYSARUM_DISH * Math.hypot(aspect, 1)) / 2;

// ---- food -------------------------------------------------------------------------------------

/** Flake and crumb radii in screen heights; the heart (where the mould began) is bigger. */
const FLAKE_RADIUS = 0.014;
const CRUMB_RADIUS = 0.009;
const HEART_SCALE = 1.35;
/** Seconds a flake takes to land, to be eaten, and to give way to the M (or come back after). */
const FADE_IN = 3;
const EAT_SECONDS = 14;
const MARK_FADE = 6;
/** Flakes keep this far from the frame's edges and the dish's wall (screen heights). */
const EDGE_GAP = 0.06;
const DROP_GAP = 0.03;
/** Random layout: flakes per unit of aspect, within these bounds. */
const RANDOM_PER_ASPECT = 14;
const RANDOM_MIN = 12;
const RANDOM_MAX = 26;
/** Candidates tried for a free spot (the one farthest from every flake wins). */
const SPOT_CANDIDATES = 24;
/** Grid layout: about this many honeycomb sites over the frame (at most GRID_MAX), share left empty at a time. */
const GRID_COUNT = 26;
const GRID_MAX = 26;
const GRID_VACANT = 0.22;
/** Cities left without food at a time, the frame margin and the closest two may sit (heights). */
const CITY_VACANT = 3;
const CITY_GAP = 0.05;
const CITY_MIN_GAP = 0.06;
/** Feeding: sim seconds between flakes eaten, at pace 0 and 1 (log-spaced between). */
const FEED_SLOW = 70;
const FEED_FAST = 14;
/** Flakes dropped by hand may exceed the layout's count by this many before old ones are eaten. */
const USER_EXTRA = 2;
/** A constellation: its radius and the closest two of its flakes (heights). */
const CONSTELLATION_RADIUS = 0.16;
const CONSTELLATION_GAP = 0.075;
/** A flake being eaten gives its slot up at once to a newcomer below this presence. */
const STEAL_BELOW = 0.3;
/** The M: height (screen heights) at size 0 and 1, crumbs along its strokes (mark units apart). */
const MARK_MIN = 0.4;
const MARK_MAX = 0.8;
const MARK_SPACING = 0.17;
/** Seconds the "now" button lays the M for; frames a size change must rest before it is relaid. */
const MARK_HOLD = 60;
const MARK_SETTLE = 20;
/** The Manifold M's five vertices in mark units (common.ts markVertex): the middle one is the heart. */
const MARK: readonly Point[] = [
  { x: -0.47, y: -0.5 },
  { x: -0.47, y: 0.5 },
  { x: 0, y: -0.08 },
  { x: 0.47, y: 0.5 },
  { x: 0.47, y: -0.5 },
];

// ---- touch ------------------------------------------------------------------------------------

/** A press that moves farther than this (heights) is a drag. */
const DRAG_START = 0.012;
/** Half-width of a line of salt (heights). */
const SALT_RADIUS = 0.011;
/** Salt lasts (sim seconds) at "lasts" 0 and 1; it is cleared away for good after SALT_TAIL × that. */
const SALT_SHORT = 15;
const SALT_LONG = 120;
const SALT_TAIL = 1.5;
/** A resize that changes the aspect by more than this share lays the dish out afresh once it rests. */
const RELAYOUT = 0.06;
const RELAYOUT_FRAMES = 30;
/** The step counter seeding the specks' random numbers wraps here. */
const STEP_WRAP = 1 << 24;

// ---- the Tokyo map ----------------------------------------------------------------------------

/** The map's centre (degrees) and the cosine of its latitude (x is in degrees of latitude). */
const MAP_LAT = 35.615;
const MAP_LON = 139.735;
const MAP_COS = 0.8131;
/** Half the extent always kept in view: Odawara to Narita, Yokosuka to Kasukabe (degrees). */
const MAP_HALF_LAT = 0.365;
const MAP_HALF_LON = 0.585;
/** Margin round that extent (heights), and how far a narrow frame may zoom out to keep it. */
const MAP_GAP = 0.07;
const MAP_ZOOM_OUT = 1.7;

/**
 * Cities round Tokyo Bay, [name, latitude, longitude], where oat flakes stand in for them as in Tero
 * et al.'s dish; coastal ones nudged a little inland. Tokyo first: the mould starts there.
 */
const CITIES: readonly (readonly [string, number, number])[] = [
  ["Tokyo", 35.685, 139.755],
  ["Yokohama", 35.472, 139.6],
  ["Kawasaki", 35.535, 139.69],
  ["Chiba", 35.625, 140.135],
  ["Funabashi", 35.715, 139.99],
  ["Omiya", 35.906, 139.624],
  ["Hachioji", 35.656, 139.339],
  ["Machida", 35.542, 139.446],
  ["Fujisawa", 35.345, 139.487],
  ["Yokosuka", 35.25, 139.655],
  ["Odawara", 35.27, 139.14],
  ["Hiratsuka", 35.345, 139.345],
  ["Atsugi", 35.439, 139.364],
  ["Kawagoe", 35.908, 139.486],
  ["Tokorozawa", 35.787, 139.469],
  ["Kashiwa", 35.862, 139.971],
  ["Matsudo", 35.784, 139.901],
  ["Kasukabe", 35.975, 139.752],
  ["Tsukuba", 36.083, 140.111],
  ["Narita", 35.776, 140.318],
  ["Ichihara", 35.49, 140.125],
  ["Kisarazu", 35.39, 139.955],
  ["Ome", 35.788, 139.276],
  ["Toride", 35.911, 140.05],
  ["Sakura", 35.724, 140.224],
  ["Mobara", 35.428, 140.288],
  ["Kawaguchi", 35.807, 139.724],
  ["Kichijoji", 35.703, 139.58],
  ["Kumagaya", 36.147, 139.389],
];

/**
 * The sea as [longitude, latitude]: Sagami Bay from Izu, round the Miura peninsula, Tokyo Bay, down
 * the Boso peninsula and up its Pacific coast to Choshi, closed far out to sea.
 */
const COAST: readonly (readonly [number, number])[] = [
  [138.95, 34.67], [139.1, 34.97], [139.075, 35.095], [139.14, 35.155], [139.165, 35.245],
  [139.25, 35.29], [139.31, 35.305], [139.4, 35.315], [139.48, 35.3], [139.545, 35.305],
  [139.58, 35.265], [139.605, 35.19], [139.62, 35.135], [139.68, 35.14], [139.715, 35.22],
  [139.745, 35.256], [139.67, 35.29], [139.63, 35.33], [139.635, 35.41], [139.665, 35.43],
  [139.645, 35.455], [139.695, 35.49], [139.75, 35.515], [139.79, 35.545], [139.755, 35.6],
  [139.775, 35.645], [139.83, 35.64], [139.905, 35.63], [139.985, 35.685], [140.035, 35.645],
  [140.1, 35.595], [140.085, 35.52], [140.03, 35.48], [139.95, 35.44], [139.89, 35.38],
  [139.78, 35.315], [139.82, 35.17], [139.85, 34.99], [139.89, 34.9], [140.1, 35.1],
  [140.32, 35.15], [140.39, 35.26], [140.4, 35.45], [140.46, 35.54], [140.58, 35.66],
  [140.87, 35.73], [141.6, 35.75], [141.6, 34.0], [138.8, 34.0],
];

// ---- small helpers ----------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

/** A food site in trail texels, with its feeding radius. */
interface SketchNode extends Point {
  r: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A number as a GLSL float literal. */
const glsl = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(value));

/** An element the code has just checked is there. */
function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new PhysarumError(`physarum: no item ${index} of ${items.length}`);
  return value;
}

/** Mulberry32: small, fast and seedable, so a seed always lays the same dish. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const swap = item(out, i);
    out[i] = item(out, j);
    out[j] = swap;
  }
  return out;
}

/** The trail grid for a frame aspect: square texels, the frame plus a margin on every side. */
class Grid {
  readonly width: number;
  readonly height: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly envWidth: number;
  readonly envHeight: number;

  constructor(aspect: number) {
    let frame = gridSize(aspect, TRAIL_SHORT);
    const long = Math.max(frame.width, frame.height);
    if (long > TRAIL_LONG) frame = gridSize(aspect, (TRAIL_SHORT * TRAIL_LONG) / long);
    this.frameWidth = frame.width;
    this.frameHeight = frame.height;
    this.width = frame.width + 2 * PHYSARUM_MARGIN;
    this.height = frame.height + 2 * PHYSARUM_MARGIN;
    this.envWidth = Math.ceil(this.width / 2);
    this.envHeight = Math.ceil(this.height / 2);
  }

  /** Trail texels per screen height. */
  get perHeight(): number {
    return this.frameHeight;
  }

  /** The dish's radius in trail texels; its centre is the frame's, (trailX(0.5), trailY(0.5)). */
  get dish(): number {
    return dishRadius(this.frameWidth / this.frameHeight) * this.frameHeight;
  }

  /** Trail texel coordinates of a point in screen uv. */
  trailX(u: number): number {
    return PHYSARUM_MARGIN + u * this.frameWidth;
  }

  trailY(v: number): number {
    return PHYSARUM_MARGIN + v * this.frameHeight;
  }

  /** The fields' uv (0..1 over the whole grid, margins included) of a point in screen uv. */
  domainX(u: number): number {
    return this.trailX(u) / this.width;
  }

  domainY(v: number): number {
    return this.trailY(v) / this.height;
  }

  /** Half-resolution texel coordinates of a point in screen uv. */
  envX(u: number): number {
    return this.domainX(u) * this.envWidth;
  }

  envY(v: number): number {
    return this.domainY(v) * this.envHeight;
  }

  same(other: Grid): boolean {
    return other.width === this.width && other.height === this.height;
  }
}

// ---- knobs ------------------------------------------------------------------------------------

type PhysarumKnob = "agents" | "angle" | "reach" | "decay" | "tempo" | "layout" | "feeding" | "foodSeed" | "salt" | "mark";

interface KnobSlot {
  /** Position in the scene's `params` (and so in `SimFrame.values`). */
  index: number;
  /** The knob's default (a feature's default amount). */
  fallback: number;
}

/** Reads the scene's knobs by key, through their position in the scene's `params`. */
class PhysarumKnobs {
  readonly #slots: Record<PhysarumKnob, KnobSlot>;

  constructor(params: readonly ParamDef[]) {
    const slot = (key: PhysarumKnob): KnobSlot => {
      const index = params.findIndex((def) => def.key === key);
      const def = params[index];
      if (def === undefined) throw new PhysarumError(`physarum: the scene has no ${key} knob`);
      return { index, fallback: def.value };
    };
    this.#slots = {
      agents: slot("agents"),
      angle: slot("angle"),
      reach: slot("reach"),
      decay: slot("decay"),
      tempo: slot("tempo"),
      layout: slot("layout"),
      feeding: slot("feeding"),
      foodSeed: slot("foodSeed"),
      salt: slot("salt"),
      mark: slot("mark"),
    };
  }

  /** As the shader sees it: a feature reads its amount while on, 0 while off. */
  value(frame: SimFrame, key: PhysarumKnob): number {
    const slot = this.#slots[key];
    return frame.values[slot.index] ?? slot.fallback;
  }

  /** A feature's amount even while it is off (its "now" button still plays one). */
  amount(frame: SimFrame, key: PhysarumKnob): number {
    return frame.params[`${key}-amount`] ?? this.#slots[key].fallback;
  }
}

type Layout = "random" | "grid" | "cities";
/** In `layout` knob order. */
const LAYOUTS: readonly Layout[] = ["random", "grid", "cities"];

interface Settings {
  agents: number;
  /** Sensor angle, radians. */
  angle: number;
  /** Sensor distance, trail texels. */
  reach: number;
  /** Share of the trail evaporating per step. */
  loss: number;
  tempo: number;
  layout: Layout;
  /** Sim seconds between flakes eaten; undefined while feeding is off. */
  feedEvery: number | undefined;
  seed: number;
  /** Dragging sprinkles salt. */
  salt: boolean;
  /** How long salt lasts, sim seconds. */
  saltSeconds: number;
  /** Height of the M while the feature is on, else undefined. */
  mark: number | undefined;
  /** Height of the M the "now" button lays. */
  markNow: number;
}

const markHeight = (amount: number): number => MARK_MIN + (MARK_MAX - MARK_MIN) * clamp(amount, 0, 1);

function readSettings(knobs: PhysarumKnobs, frame: SimFrame): Settings {
  const wanted = knobs.value(frame, "agents");
  let agents: number = REFERENCE_AGENTS;
  for (const count of physarumAgentCounts) if (Math.abs(count - wanted) < Math.abs(agents - wanted)) agents = count;
  const feeding = knobs.value(frame, "feeding");
  const mark = knobs.value(frame, "mark");
  return {
    agents,
    angle: (clamp(knobs.value(frame, "angle"), 1, 90) * Math.PI) / 180,
    reach: clamp(knobs.value(frame, "reach"), 1, 40),
    loss: LOSS_MIN * Math.pow(LOSS_MAX / LOSS_MIN, clamp(knobs.value(frame, "decay"), 0, 1)),
    tempo: clamp(knobs.value(frame, "tempo"), 0, 4),
    layout: LAYOUTS[Math.round(knobs.value(frame, "layout"))] ?? "random",
    feedEvery: feeding > 0 ? FEED_SLOW * Math.pow(FEED_FAST / FEED_SLOW, clamp(feeding, 0, 1)) : undefined,
    seed: Math.round(knobs.value(frame, "foodSeed")),
    salt: knobs.value(frame, "salt") > 0,
    saltSeconds: SALT_SHORT * Math.pow(SALT_LONG / SALT_SHORT, clamp(knobs.amount(frame, "salt"), 0, 1)),
    mark: mark > 0 ? markHeight(mark) : undefined,
    markNow: markHeight(knobs.amount(frame, "mark")),
  };
}

// ---- layouts ----------------------------------------------------------------------------------

/** How the Tokyo map sits in a frame of this aspect: degrees of latitude per screen height. */
interface CityMap {
  readonly aspect: number;
  readonly span: number;
}

function cityMap(aspect: number): CityMap {
  const tall = (2 * MAP_HALF_LAT) / (1 - 2 * MAP_GAP);
  const wide = (2 * MAP_HALF_LON * MAP_COS) / Math.max(aspect - 2 * MAP_GAP, 0.1);
  return { aspect, span: Math.max(tall, Math.min(wide, MAP_ZOOM_OUT * tall)) };
}

/** A place on the map in screen uv. */
function project(map: CityMap, lon: number, lat: number): Point {
  return {
    x: 0.5 + ((lon - MAP_LON) * MAP_COS) / map.span / map.aspect,
    y: 0.5 + (lat - MAP_LAT) / map.span,
  };
}

/** Light cover 0..1 at a point in screen uv. */
type SeaSampler = (u: number, v: number) => number;

/**
 * Honeycomb sites (screen uv) spaced so about GRID_COUNT cover the frame, those inside the dish,
 * nearest the centre first: the heart is the first.
 */
function hexSites(aspect: number): { sites: Point[]; heart: number } {
  const halfWidth = aspect / 2 - EDGE_GAP;
  const halfHeight = 0.5 - EDGE_GAP;
  const spacing = Math.sqrt((8 * halfWidth * halfHeight) / (Math.sqrt(3) * GRID_COUNT));
  const rowHeight = (spacing * Math.sqrt(3)) / 2;
  const inside = dishRadius(aspect) - EDGE_GAP;
  const rows = Math.max(1, Math.floor((2 * halfHeight) / rowHeight) + 1);
  const frame: Point[] = [];
  for (let j = 0; j < rows; j++) {
    const y = (j - (rows - 1) / 2) * rowHeight;
    const shift = (j % 2 === 0 ? -0.25 : 0.25) * spacing;
    const reach = Math.floor((halfWidth + Math.abs(shift)) / spacing) + 1;
    for (let i = -reach; i <= reach; i++) {
      const x = shift + i * spacing;
      if (Math.abs(x) <= halfWidth && Math.hypot(x, y) <= inside) frame.push({ x, y });
    }
  }
  frame.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  const sites = frame.slice(0, GRID_MAX).map((p) => ({ x: 0.5 + p.x / aspect, y: 0.5 + p.y }));
  return { sites, heart: 0 };
}

/** The cities in view, inside the dish and on land (screen uv); Tokyo, the heart, first. */
function citySites(map: CityMap | undefined, aspect: number, sea: SeaSampler): { sites: Point[]; heart: number } {
  const sites: Point[] = [];
  if (map === undefined) return { sites, heart: 0 };
  const inside = dishRadius(aspect) - EDGE_GAP;
  for (const [, lat, lon] of CITIES) {
    const p = project(map, lon, lat);
    if (p.x < CITY_GAP / aspect || p.x > 1 - CITY_GAP / aspect || p.y < CITY_GAP || p.y > 1 - CITY_GAP) continue;
    if (Math.hypot((p.x - 0.5) * aspect, p.y - 0.5) > inside) continue;
    if (sea(p.x, p.y) > 0.2) continue;
    if (sites.some((s) => Math.hypot((s.x - p.x) * aspect, s.y - p.y) < CITY_MIN_GAP)) continue;
    sites.push(p);
  }
  return { sites, heart: 0 };
}

/** Coverage 0..1 of a closed polygon (even–odd) over a width × height grid, rows bottom to top. */
function fillPolygon(points: readonly (readonly [number, number])[], width: number, height: number): Float32Array {
  const cover = new Float32Array(width * height);
  const SUB = 4;
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    for (let s = 0; s < SUB; s++) {
      const y = row + (s + 0.5) / SUB;
      xs.length = 0;
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = item(points, i);
        const [bx, by] = item(points, (i + 1) % points.length);
        if (ay <= y === by <= y) continue;
        xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, item(xs, k));
        const x1 = Math.min(width, item(xs, k + 1));
        if (x1 <= x0) continue;
        const last = Math.min(width - 1, Math.floor(x1));
        for (let i = Math.floor(x0); i <= last; i++) {
          const overlap = Math.min(i + 1, x1) - Math.max(i, x0);
          if (overlap > 0) cover[row * width + i] = (cover[row * width + i] ?? 0) + overlap / SUB;
        }
      }
    }
  }
  return cover;
}

/** The lit sea at half resolution, or nothing off the map. */
function seaCover(map: CityMap | undefined, grid: Grid): Float32Array {
  if (map === undefined) return new Float32Array(grid.envWidth * grid.envHeight);
  const points = COAST.map(([lon, lat]): readonly [number, number] => {
    const p = project(map, lon, lat);
    return [grid.envX(p.x), grid.envY(p.y)];
  });
  return fillPolygon(points, grid.envWidth, grid.envHeight);
}

function seaAt(cover: Float32Array, grid: Grid, u: number, v: number): number {
  const x = clamp(Math.floor(grid.envX(u)), 0, grid.envWidth - 1);
  const y = clamp(Math.floor(grid.envY(v)), 0, grid.envHeight - 1);
  return cover[y * grid.envWidth + x] ?? 0;
}

// ---- food -------------------------------------------------------------------------------------

type FoodKind = "flake" | "crumb";

interface FoodSpec {
  /** Centre in screen uv. */
  readonly x: number;
  readonly y: number;
  /** Screen heights. */
  readonly radius: number;
  readonly kind: FoodKind;
  /** The layout site it stands on, or -1. */
  readonly site: number;
  /** Part of the M. */
  readonly mark: boolean;
  /** Its look: turn, squash and grain. */
  readonly rot: number;
  readonly elong: number;
  readonly grain: number;
}

interface FoodNode extends FoodSpec {
  readonly id: number;
  /** Sim seconds it was laid: the oldest is eaten first. */
  born: number;
  /** 0..1, toward `target` (1 laid, 0 eaten). */
  strength: number;
  target: number;
  /** Seconds from 1 to 0 once it is going. */
  fadeOut: number;
}

/**
 * The dish's oat flakes: laid by the layout, eaten and replaced by the feeding, dropped by hand, set
 * aside for the M and laid again after. Up to PHYSARUM_MAX_FOOD sit on the dish; newcomers wait for
 * a slot (a flake on its way out gives its slot up early).
 */
class FoodBook {
  nodes: FoodNode[] = [];
  map: CityMap | undefined = undefined;
  #pending: FoodNode[] = [];
  #rand: () => number = mulberry32(1);
  #nextId = 1;
  #time = 0;
  #nextFeed = -1;
  #layout: Layout = "random";
  #aspect = 16 / 9;
  /** The dish's radius, screen heights. */
  #dish = dishRadius(16 / 9);
  #sea: SeaSampler = () => 0;
  #sites: Point[] = [];
  #vacant: number[] = [];
  #target = 1;
  #heart = 0;
  #markSize: number | undefined = undefined;
  #markHeight = 0;
  #markShown = 0;
  #saved: FoodNode[] = [];
  #savedHeart = -1;

  /** Height of the M laid now, or undefined. */
  get markSize(): number | undefined {
    return this.#markSize;
  }

  /** Height of the M last laid (screen heights), and how much of its dust shows (0..1). */
  get markHeight(): number {
    return this.#markHeight;
  }

  get markShown(): number {
    return this.#markShown;
  }

  /** A fresh dish: the layout's flakes all laid (or set aside under an M laid at once). */
  reset(layout: Layout, seed: number, aspect: number, map: CityMap | undefined, sea: SeaSampler, mark: number | undefined): void {
    this.nodes = [];
    this.#pending = [];
    this.#saved = [];
    this.#savedHeart = -1;
    this.#rand = mulberry32((Math.imul(seed + 1, 0x9e3779b1) ^ 0x2c1b3c6d) >>> 0);
    this.#time = 0;
    this.#nextFeed = -1;
    this.#layout = layout;
    this.#aspect = aspect;
    this.#dish = dishRadius(aspect);
    this.map = map;
    this.#sea = sea;
    this.#sites = [];
    this.#vacant = [];
    this.#markSize = undefined;
    this.#markShown = 0;
    const specs: FoodSpec[] = [];
    switch (layout) {
      case "random": {
        this.#target = Math.round(clamp(aspect * RANDOM_PER_ASPECT, RANDOM_MIN, RANDOM_MAX));
        // The heart lands somewhere in the middle; the rest spread out from it as far as they can.
        specs.push(this.#flake(0.5 + (this.#rand() - 0.5) * 0.4, 0.5 + (this.#rand() - 0.5) * 0.36, -1, HEART_SCALE));
        while (specs.length < this.#target) {
          const at = this.#freeSpot(specs);
          specs.push(this.#flake(at.x, at.y, -1, 1));
        }
        break;
      }
      case "grid":
      case "cities": {
        const { sites, heart } = layout === "grid" ? hexSites(aspect) : citySites(map, aspect, sea);
        this.#sites = sites;
        if (sites.length === 0) {
          this.#target = 1;
          specs.push(this.#flake(0.5, 0.5, -1, HEART_SCALE));
          break;
        }
        const empty = Math.min(layout === "grid" ? Math.round(sites.length * GRID_VACANT) : CITY_VACANT, Math.max(0, sites.length - 2));
        this.#target = sites.length - empty;
        const others = shuffled(sites.map((_, i) => i).filter((i) => i !== heart), this.#rand);
        this.#vacant = others.slice(0, empty);
        for (const site of [heart, ...others.slice(empty)]) {
          const at = item(sites, site);
          specs.push(this.#flake(at.x, at.y, site, site === heart ? HEART_SCALE : 1));
        }
        break;
      }
      default: {
        const unreachable: never = layout;
        throw new PhysarumError(`physarum: unknown layout ${String(unreachable)}`);
      }
    }
    const laid = specs.map((spec) => this.#plant(spec, mark === undefined));
    this.#heart = item(laid, 0).id;
    if (mark !== undefined) {
      // Laid straight into an M: the dish's own flakes wait aside, unseen, until it is lifted.
      this.nodes = [];
      this.#pending = [];
      this.#saved = laid;
      this.#savedHeart = 0;
      this.#markSize = mark;
      this.#layMark(mark, true);
      this.#markShown = 1;
    }
  }

  /** Flakes land and are eaten; now and then (while feeding) one is eaten and another appears. */
  advance(dt: number, feedEvery: number | undefined): void {
    if (dt <= 0) return;
    this.#time += dt;
    for (const node of this.nodes) {
      // Landing over FADE_IN seconds, eaten over its own fadeOut.
      node.strength = node.target > node.strength
        ? Math.min(node.target, node.strength + dt / FADE_IN)
        : Math.max(node.target, node.strength - dt / node.fadeOut);
    }
    let kept = 0;
    for (const node of this.nodes) if (node.target > 0 || node.strength > 0) this.nodes[kept++] = node;
    this.nodes.length = kept;
    this.#placePending();
    this.#markShown = this.#markSize === undefined
      ? Math.max(0, this.#markShown - dt / MARK_FADE)
      : Math.min(1, this.#markShown + dt / MARK_FADE);
    if (feedEvery === undefined || this.#markSize !== undefined) {
      this.#nextFeed = -1;
      return;
    }
    if (this.#nextFeed < 0) {
      this.#nextFeed = this.#time + feedEvery * (0.5 + 0.5 * this.#rand());
    } else if (this.#time >= this.#nextFeed) {
      this.#feed();
      this.#nextFeed = this.#time + feedEvery * (0.75 + 0.5 * this.#rand());
    }
  }

  /** A flake dropped by hand (not into the light). */
  drop(x: number, y: number): void {
    const u = clamp(x, DROP_GAP / this.#aspect, 1 - DROP_GAP / this.#aspect);
    const v = clamp(y, DROP_GAP, 1 - DROP_GAP);
    if (this.#sea(u, v) > 0.3 || this.#beyondDish(u, v, DROP_GAP)) return;
    this.#plant(this.#flake(u, v, -1, 1), false);
    this.#trim();
  }

  /** A cluster of four to six flakes somewhere open; as many old ones are eaten to make room. */
  constellation(): void {
    const centre = this.#freeSpot([]);
    const count = 4 + Math.floor(this.#rand() * 3);
    const placed: Point[] = [];
    const aspect = this.#aspect;
    for (let tries = 0; placed.length < count && tries < 80; tries++) {
      const a = this.#rand() * TAU;
      const r = CONSTELLATION_RADIUS * Math.sqrt(this.#rand());
      const x = centre.x + (Math.cos(a) * r) / aspect;
      const y = centre.y + Math.sin(a) * r;
      if (x < EDGE_GAP / aspect || x > 1 - EDGE_GAP / aspect || y < EDGE_GAP || y > 1 - EDGE_GAP) continue;
      if (this.#beyondDish(x, y, EDGE_GAP)) continue;
      if (this.#sea(x, y) > 0.05) continue;
      if (placed.some((p) => Math.hypot((p.x - x) * aspect, p.y - y) < CONSTELLATION_GAP)) continue;
      placed.push({ x, y });
    }
    for (const at of placed) this.#plant(this.#flake(at.x, at.y, -1, 1), false);
    this.#trim();
  }

  /**
   * Lay the M (its five corners and crumbs along its strokes) at this height, or lift it. Laying it
   * sets the dish's flakes aside (they are eaten away); lifting it lays them again where they were.
   */
  setMark(size: number | undefined): void {
    if (size === this.#markSize) return;
    if (this.#markSize !== undefined) {
      for (const node of this.nodes) if (node.mark) this.#retire(node, MARK_FADE);
      this.#pending = this.#pending.filter((node) => !node.mark);
    } else {
      this.#saved = [];
      this.#savedHeart = -1;
      for (const node of [...this.nodes, ...this.#pending]) {
        if (node.target <= 0) continue;
        if (node.id === this.#heart) this.#savedHeart = this.#saved.length;
        this.#saved.push(node);
        this.#retire(node, MARK_FADE);
      }
      this.#pending = [];
    }
    this.#markSize = size;
    if (size === undefined) this.#restore();
    else this.#layMark(size, false);
  }

  heartNode(): FoodNode | undefined {
    for (const node of this.nodes) if (node.id === this.#heart) return node;
    return undefined;
  }

  /** The flakes on the dish (laid or landing) in trail texels, with the heart's index (-1: none). */
  sketchNodes(grid: Grid): { points: SketchNode[]; heart: number } {
    const points: SketchNode[] = [];
    let heart = -1;
    for (const node of this.nodes) {
      if (node.target <= 0) continue;
      if (node.id === this.#heart) heart = points.length;
      points.push({ x: grid.trailX(node.x), y: grid.trailY(node.y), r: node.radius * FEED_SCALE * grid.perHeight });
    }
    return { points, heart };
  }

  /** The passes' uniform array: domain uv, feeding radius (trail texels), presence. Returns the count. */
  writeUniform(data: Float32Array, grid: Grid): number {
    data.fill(0);
    let count = 0;
    for (const node of this.nodes) {
      if (node.strength <= 0.001 || count >= PHYSARUM_MAX_FOOD) continue;
      const o = count * 4;
      data[o] = grid.domainX(node.x);
      data[o + 1] = grid.domainY(node.y);
      data[o + 2] = node.radius * FEED_SCALE * grid.perHeight;
      data[o + 3] = node.strength;
      count++;
    }
    return count;
  }

  /** The shader's flake texture (see the file header). */
  writeTexture(data: Float32Array, phase: number): void {
    data.fill(0);
    const row = PHYSARUM_MAX_FOOD * 4;
    const count = Math.min(this.nodes.length, PHYSARUM_MAX_FOOD);
    for (let i = 0; i < count; i++) {
      const node = item(this.nodes, i);
      const o = i * 4;
      data[o] = node.x;
      data[o + 1] = node.y;
      data[o + 2] = node.radius;
      data[o + 3] = node.target > 0 ? node.strength : -node.strength;
      data[row + o] = node.rot;
      data[row + o + 1] = node.elong;
      data[row + o + 2] = node.grain;
      data[row + o + 3] = node.kind === "crumb" ? 1 : 0;
    }
    const heart = this.heartNode();
    data[2 * row] = phase;
    data[2 * row + 1] = heart === undefined ? 0 : heart.strength;
    data[2 * row + 4] = 0.5;
    data[2 * row + 5] = 0.5;
    data[2 * row + 6] = this.#markHeight;
    data[2 * row + 7] = this.#markShown;
  }

  #flake(x: number, y: number, site: number, scale: number): FoodSpec {
    return {
      x, y, radius: FLAKE_RADIUS * scale * (0.9 + 0.2 * this.#rand()), kind: "flake", site, mark: false,
      rot: this.#rand() * TAU, elong: 0.55 + 0.25 * this.#rand(), grain: this.#rand(),
    };
  }

  #plant(spec: FoodSpec, now: boolean): FoodNode {
    const node: FoodNode = {
      ...spec,
      id: this.#nextId++,
      born: this.#time,
      strength: now ? 1 : 0,
      target: 1,
      fadeOut: EAT_SECONDS,
    };
    if (this.nodes.length < PHYSARUM_MAX_FOOD) this.nodes.push(node);
    else this.#pending.push(node);
    return node;
  }

  #retire(node: FoodNode, seconds: number): void {
    node.fadeOut = node.target > 0 ? seconds : Math.min(node.fadeOut, seconds);
    node.target = 0;
  }

  #placePending(): void {
    while (this.#pending.length > 0) {
      if (this.nodes.length >= PHYSARUM_MAX_FOOD) {
        let weakest = -1;
        let low = STEAL_BELOW;
        this.nodes.forEach((node, i) => {
          if (node.target === 0 && node.strength < low) {
            low = node.strength;
            weakest = i;
          }
        });
        if (weakest < 0) return;
        this.nodes.splice(weakest, 1);
      }
      const next = this.#pending.shift();
      if (next === undefined) return;
      next.born = this.#time;
      this.nodes.push(next);
    }
  }

  /** The longest-laid flake on the dish that may be eaten (not the heart, not the M). */
  #oldest(): FoodNode | undefined {
    let oldest: FoodNode | undefined;
    for (const node of this.nodes) {
      if (node.target <= 0 || node.mark || node.id === this.#heart) continue;
      if (oldest === undefined || node.born < oldest.born || (node.born === oldest.born && node.id < oldest.id)) oldest = node;
    }
    return oldest;
  }

  #activeCount(): number {
    let active = this.#pending.length;
    for (const node of this.nodes) if (node.target > 0) active++;
    return active;
  }

  /** One feeding: the oldest flake is eaten, and (if the dish is short) food appears elsewhere. */
  #feed(): void {
    const oldest = this.#oldest();
    if (oldest === undefined) return;
    this.#retire(oldest, EAT_SECONDS);
    if (oldest.site >= 0) this.#vacant.push(oldest.site);
    if (this.#activeCount() >= this.#target) return;
    if (this.#layout === "random") {
      const at = this.#freeSpot([]);
      this.#plant(this.#flake(at.x, at.y, -1, 1), false);
      return;
    }
    const site = this.#vacant.shift();
    if (site === undefined) return;
    const at = item(this.#sites, site);
    this.#plant(this.#flake(at.x, at.y, site, 1), false);
  }

  /** Hand-dropped food beyond the allowance: the oldest flakes are eaten. */
  #trim(): void {
    const limit = this.#target + USER_EXTRA;
    for (;;) {
      let active = 0;
      for (const node of this.nodes) if (node.target > 0 && !node.mark) active++;
      for (const node of this.#pending) if (!node.mark) active++;
      if (active <= limit) return;
      const oldest = this.#oldest();
      if (oldest === undefined) return;
      this.#retire(oldest, EAT_SECONDS);
      if (oldest.site >= 0) this.#vacant.push(oldest.site);
    }
  }

  /** Whether a point (screen uv) lies within `margin` (heights) of the dish's wall, or past it. */
  #beyondDish(x: number, y: number, margin: number): boolean {
    return Math.hypot((x - 0.5) * this.#aspect, y - 0.5) > this.#dish - margin;
  }

  /** The open spot (screen uv, in the dish, off the light) farthest from every flake, of a few candidates. */
  #freeSpot(extra: readonly Point[]): Point {
    const aspect = this.#aspect;
    let best: Point = { x: 0.5, y: 0.5 };
    let bestGap = -1;
    for (let k = 0; k < SPOT_CANDIDATES; k++) {
      const x = 0.5 + (this.#rand() - 0.5) * (1 - (2 * EDGE_GAP) / aspect);
      const y = 0.5 + (this.#rand() - 0.5) * (1 - 2 * EDGE_GAP);
      if (this.#sea(x, y) > 0.05 || this.#beyondDish(x, y, EDGE_GAP)) continue;
      let gap = Infinity;
      for (const p of this.nodes) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      for (const p of this.#pending) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      for (const p of extra) gap = Math.min(gap, Math.hypot((p.x - x) * aspect, p.y - y));
      if (gap > bestGap) {
        bestGap = gap;
        best = { x, y };
      }
    }
    return best;
  }

  /** Lay the M `size` tall, or smaller where the frame or the dish is too narrow for it. */
  #layMark(size: number, now: boolean): void {
    const aspect = this.#aspect;
    // The M's corners lie 0.47 heights out across, 0.69 from its centre (per unit of height).
    const height = Math.min(size, (aspect / 2 - EDGE_GAP) / 0.47, (this.#dish - EDGE_GAP) / Math.hypot(0.47, 0.5));
    const lay = (v: Point, kind: FoodKind): FoodNode =>
      this.#plant({
        x: 0.5 + (v.x * height) / aspect, y: 0.5 + v.y * height,
        radius: kind === "crumb" ? CRUMB_RADIUS * (0.85 + 0.3 * this.#rand()) : FLAKE_RADIUS,
        kind, site: -1, mark: true,
        rot: this.#rand() * TAU, elong: kind === "crumb" ? 0.7 + 0.25 * this.#rand() : 0.55 + 0.25 * this.#rand(), grain: this.#rand(),
      }, now);
    // Corners first, so they take the free slots before the crumbs.
    MARK.forEach((v, i) => {
      const node = lay(v, "flake");
      if (i === 2) this.#heart = node.id;
    });
    for (let s = 0; s + 1 < MARK.length; s++) {
      const a = item(MARK, s);
      const b = item(MARK, s + 1);
      const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / MARK_SPACING));
      for (let k = 1; k < pieces; k++) lay({ x: a.x + ((b.x - a.x) * k) / pieces, y: a.y + ((b.y - a.y) * k) / pieces }, "crumb");
    }
    this.#markHeight = height;
  }

  /** The dish's flakes laid again after the M: those still fading come back where they are. */
  #restore(): void {
    let heart = -1;
    this.#saved.forEach((saved, i) => {
      const node = this.nodes.includes(saved) ? saved : this.#plant(saved, false);
      node.target = 1;
      if (i === this.#savedHeart) heart = node.id;
    });
    this.#saved = [];
    this.#savedHeart = -1;
    this.#heart = heart >= 0 ? heart : (this.nodes.find((node) => node.target > 0 && !node.mark)?.id ?? 0);
    this.#nextFeed = -1;
    this.#trim();
  }
}

// ---- the sketch: a grown network for the first frame --------------------------------------------
//
// What the mould looks like once it has spread, drawn on the CPU so the first frame (and a machine
// without float targets) shows one: a faint reticulated lace over the dish (the edges of a jittered
// Voronoi tiling, patchy), trunks wandering between neighbouring flakes (their relative-
// neighbourhood graph, the sparse network a Physarum approximates; the minimum spanning tree's
// links thickest, every one swelling and narrowing along its length) and a fan of fine tributaries
// round each flake. The live mould starts from it and grows its own network out of it.

/** A vein of the sketch, as points ~0.7 texel apart (trail texels). */
interface Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Texels along it. */
  readonly length: number;
  /** The flake it leaves, and the one it reaches (-1: a tributary, petering out in the agar). */
  readonly from: number;
  readonly to: number;
  /** Trail level (sketch units) and profile width (texels); a tributary tapers from these to nothing. */
  readonly level: number;
  readonly sigma: number;
}

interface SketchPaths {
  readonly trunks: readonly Path[];
  readonly fans: readonly Path[];
}

/** Relative-neighbourhood graph: i–j unless some k is nearer to both than they are to each other. */
function neighbourhood(points: readonly Point[]): (readonly [number, number])[] {
  const edges: (readonly [number, number])[] = [];
  const gap = (i: number, j: number): number => {
    const a = item(points, i);
    const b = item(points, j);
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = gap(i, j);
      let keep = true;
      for (let k = 0; k < points.length && keep; k++) {
        if (k !== i && k !== j && Math.max(gap(i, k), gap(j, k)) < d) keep = false;
      }
      if (keep) edges.push([i, j]);
    }
  }
  return edges;
}

/** Edges of the minimum spanning tree (Prim), as i * 64 + j keys with i < j. */
function spanningTree(points: readonly Point[]): Set<number> {
  const n = points.length;
  const tree = new Set<number>();
  if (n < 2) return tree;
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  best[0] = 0;
  for (let round = 0; round < n; round++) {
    let next = -1;
    for (let i = 0; i < n; i++) if (inTree[i] === 0 && (next < 0 || (best[i] ?? Infinity) < (best[next] ?? Infinity))) next = i;
    if (next < 0) break;
    inTree[next] = 1;
    const parent = from[next] ?? -1;
    if (parent >= 0) tree.add(Math.min(parent, next) * 64 + Math.max(parent, next));
    const p = item(points, next);
    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) continue;
      const q = item(points, i);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < (best[i] ?? Infinity)) {
        best[i] = d;
        from[i] = next;
      }
    }
  }
  return tree;
}

/** A line from a to b wandering off to its side: a bow and two slow waves, pinned at both ends. */
function wander(ax: number, ay: number, bx: number, by: number, amplitude: number, rand: () => number): { xs: Float64Array; ys: Float64Array; length: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const span = Math.max(Math.hypot(dx, dy), 1e-6);
  const bow = (rand() - 0.5) * 1.2 * amplitude;
  const a1 = amplitude * (0.5 + rand());
  const f1 = 1 + rand();
  const p1 = rand() * TAU;
  const a2 = amplitude * 0.4 * rand();
  const f2 = 2.5 + 2 * rand();
  const p2 = rand() * TAU;
  const n = Math.max(2, Math.ceil(span / 0.7));
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  let length = 0;
  let px = ax;
  let py = ay;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const side = span * Math.sin(Math.PI * t) * (bow + a1 * Math.sin(TAU * f1 * t + p1) + a2 * Math.sin(TAU * f2 * t + p2));
    const x = ax + dx * t - (dy / span) * side;
    const y = ay + dy * t + (dx / span) * side;
    length += Math.hypot(x - px, y - py);
    xs[k] = x;
    ys[k] = y;
    px = x;
    py = y;
  }
  return { xs, ys, length };
}

/** The sketch's veins: trunks along the flakes' neighbourhood graph, and tributaries fanning out of each flake. */
function sketchPaths(points: readonly SketchNode[], grid: Grid, rand: () => number): SketchPaths {
  const tree = spanningTree(points);
  const trunks = neighbourhood(points).map(([i, j]): Path => {
    const a = item(points, i);
    const b = item(points, j);
    const main = tree.has(i * 64 + j);
    return { ...wander(a.x, a.y, b.x, b.y, TRUNK_WANDER, rand), from: i, to: j, level: main ? 1.3 : 0.6, sigma: main ? 1.3 : 0.9 };
  });
  const fans: Path[] = [];
  points.forEach((p, i) => {
    const count = FAN_MIN + Math.floor(rand() * (FAN_MAX - FAN_MIN + 1));
    for (let k = 0; k < count; k++) {
      const a = rand() * TAU;
      const reach = (FAN_SHORT + (FAN_LONG - FAN_SHORT) * rand()) * grid.perHeight;
      const x = p.x + Math.cos(a) * p.r;
      const y = p.y + Math.sin(a) * p.r;
      fans.push({ ...wander(x, y, x + Math.cos(a) * reach, y + Math.sin(a) * reach, FAN_WANDER, rand), from: i, to: -1, level: 0.35, sigma: 0.8 });
    }
  });
  return { trunks, fans };
}

/** A soft dot of sketch trail at (x, y) (trail texels), keeping the larger value. */
function splat(field: Float32Array, grid: Grid, x: number, y: number, level: number, sigma: number): void {
  const reach = Math.ceil(3 * sigma);
  const x0 = Math.max(0, Math.floor(x - reach));
  const x1 = Math.min(grid.width - 1, Math.ceil(x + reach));
  const y0 = Math.max(0, Math.floor(y - reach));
  const y1 = Math.min(grid.height - 1, Math.ceil(y + reach));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const dx = xx + 0.5 - x;
      const dy = yy + 0.5 - y;
      const v = level * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      const at = yy * grid.width + xx;
      if (v > (field[at] ?? 0)) field[at] = v;
    }
  }
}

/** A vein swelling and narrowing along its length, as no tube is even; a tributary tapers away. */
function stampPath(field: Float32Array, grid: Grid, path: Path, taper: boolean): void {
  const count = path.xs.length;
  const phase = path.from * 1.7 + path.to * 0.9;
  for (let k = 0; k < count; k++) {
    const t = k / (count - 1);
    const swell = 0.75 + 0.5 * (0.5 + 0.5 * Math.sin(t * path.length * 0.08 + phase));
    const tip = taper ? Math.pow(1 - t, 0.7) : 1;
    const sigma = path.sigma * (taper ? 0.6 + 0.4 * (1 - t) : 0.7 + 0.3 * swell);
    splat(field, grid, path.xs[k] ?? 0, path.ys[k] ?? 0, path.level * swell * tip, sigma);
  }
}

/** A faint reticulated lace: the edges of a jittered Voronoi tiling LACE_CELL across, patchy. */
function stampLace(field: Float32Array, grid: Grid, rand: () => number): void {
  const cell = LACE_CELL * grid.perHeight;
  const cols = Math.ceil(grid.width / cell) + 2;
  const rows = Math.ceil(grid.height / cell) + 2;
  const fx = new Float64Array(cols * rows);
  const fy = new Float64Array(cols * rows);
  const patch = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const at = j * cols + i;
      fx[at] = (i - 1 + 0.15 + 0.7 * rand()) * cell;
      fy[at] = (j - 1 + 0.15 + 0.7 * rand()) * cell;
      patch[at] = 0.3 + 0.7 * rand();
    }
  }
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ci = Math.floor(px / cell) + 1;
      const cj = Math.floor(py / cell) + 1;
      let d1 = Infinity;
      let d2 = Infinity;
      let i1 = 0;
      let i2 = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const at = (cj + dj) * cols + ci + di;
          const ex = (fx[at] ?? 0) - px;
          const ey = (fy[at] ?? 0) - py;
          const d = ex * ex + ey * ey;
          if (d < d1) {
            d2 = d1;
            i2 = i1;
            d1 = d;
            i1 = at;
          } else if (d < d2) {
            d2 = d;
            i2 = at;
          }
        }
      }
      // Distance to the bisector of the two nearest sites: an edge of the tiling, even in width.
      const gap = (d2 - d1) / (2 * Math.max(Math.hypot((fx[i2] ?? 0) - (fx[i1] ?? 0), (fy[i2] ?? 0) - (fy[i1] ?? 0)), 1e-6));
      const v = LACE_LEVEL * 0.5 * ((patch[i1] ?? 0) + (patch[i2] ?? 0)) * Math.exp(-(gap * gap) / (2 * LACE_SIGMA * LACE_SIGMA));
      const at = y * grid.width + x;
      if (v > (field[at] ?? 0)) field[at] = v;
    }
  }
}

/** The sketch as trail, in sketch units (lace ≤ 0.2, fans ~0.35, branches ~0.6, trunks ~1.3, the crowd on a flake 1); nothing past the dish's wall. */
function stampSketch(paths: SketchPaths, points: readonly SketchNode[], grid: Grid, rand: () => number): Float32Array {
  const field = new Float32Array(grid.width * grid.height);
  stampLace(field, grid, rand);
  for (const path of paths.trunks) stampPath(field, grid, path, false);
  for (const path of paths.fans) stampPath(field, grid, path, true);
  for (const p of points) splat(field, grid, p.x, p.y, 1, Math.max(1, 0.7 * p.r));
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > dish) field[y * grid.width + x] = 0;
  }
  return field;
}

/** The sketch's trunk level (Σs³ / Σs²) and a typical filament's share of it, as the GPU measures them. */
function sketchLevel(sketch: Float32Array): { level: number; share: number } {
  let s2 = 0;
  let s3 = 0;
  for (const s of sketch) {
    s2 += s * s;
    s3 += s * s * s;
  }
  if (s2 <= 0) return { level: 1, share: LACE_TONE };
  const level = s3 / s2;
  let lit = 0;
  let sum = 0;
  for (const s of sketch) {
    if (s < FILAMENT_FLOOR * level) continue;
    lit++;
    sum += s;
  }
  return { level, share: lit > 0 ? sum / lit / level : LACE_TONE };
}

/** Distance along the sketch from the heart (screen heights) at half resolution; PHYSARUM_FAR elsewhere. */
function stampDistance(paths: SketchPaths, points: readonly SketchNode[], heart: number, grid: Grid): Float32Array {
  const ew = grid.envWidth;
  const eh = grid.envHeight;
  const field = new Float32Array(ew * eh).fill(PHYSARUM_FAR);
  if (heart < 0 || heart >= points.length) return field;
  const sx = ew / grid.width;
  const sy = eh / grid.height;
  const unitX = 1 / (sx * grid.perHeight);
  const unitY = 1 / (sy * grid.perHeight);
  // Dijkstra over the trunks, in heights along them.
  const n = points.length;
  const along = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  along[heart] = 0;
  for (;;) {
    let next = -1;
    for (let i = 0; i < n; i++) if (done[i] === 0 && Number.isFinite(along[i] ?? Infinity) && (next < 0 || (along[i] ?? 0) < (along[next] ?? 0))) next = i;
    if (next < 0) break;
    done[next] = 1;
    for (const path of paths.trunks) {
      if (path.from !== next && path.to !== next) continue;
      const other = path.from === next ? path.to : path.from;
      const d = (along[next] ?? 0) + path.length / grid.perHeight;
      if (d < (along[other] ?? Infinity)) along[other] = d;
    }
  }
  const stamp = (x: number, y: number, base: number, reach: number): void => {
    const x0 = Math.max(0, Math.floor(x - reach));
    const x1 = Math.min(ew - 1, Math.ceil(x + reach));
    const y0 = Math.max(0, Math.floor(y - reach));
    const y1 = Math.min(eh - 1, Math.ceil(y + reach));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const v = base + Math.hypot((xx + 0.5 - x) * unitX, (yy + 0.5 - y) * unitY);
        const at = yy * ew + xx;
        if (v < (field[at] ?? PHYSARUM_FAR)) field[at] = v;
      }
    }
  };
  for (const path of [...paths.trunks, ...paths.fans]) {
    const from = along[path.from] ?? Infinity;
    const to = path.to < 0 ? Infinity : (along[path.to] ?? Infinity);
    if (!Number.isFinite(from) && !Number.isFinite(to)) continue;
    const span = path.length / grid.perHeight;
    const count = path.xs.length;
    for (let k = 0; k < count; k++) {
      const t = k / (count - 1);
      stamp((path.xs[k] ?? 0) * sx, (path.ys[k] ?? 0) * sy, Math.min(from + t * span, to + (1 - t) * span), 2.5);
    }
  }
  points.forEach((p, i) => {
    const base = along[i] ?? Infinity;
    if (Number.isFinite(base)) stamp(p.x * sx, p.y * sy, base, p.r * sx + 2);
  });
  return field;
}

/**
 * The specks for a sketch: SEED_TRUNKS laid along its trunks heading either way, SEED_FANS out
 * along its tributaries, SEED_FLAKES at the flakes heading out, the rest anywhere on the dish, any
 * way; ages spread so they do not all starve at once. Also returns the trail level (raw units) they
 * will keep up on the trunks, to scale the seeded trail by.
 */
function seedAgents(shape: { width: number; height: number }, paths: SketchPaths, points: readonly SketchNode[], grid: Grid, rand: () => number): { data: Float32Array; level: number } {
  const total = shape.width * shape.height;
  const data = new Float32Array(total * 4);
  const trunks = paths.trunks;
  const fans = paths.fans;
  let length = 0;
  const ends = new Float64Array(trunks.length);
  trunks.forEach((path, i) => {
    length += path.length;
    ends[i] = length;
  });
  const onTrunks = length > 0 ? Math.floor(total * SEED_TRUNKS) : 0;
  const onFans = onTrunks + (fans.length > 0 ? Math.floor(total * SEED_FANS) : 0);
  const atFlakes = onFans + (points.length > 0 ? Math.floor(total * SEED_FLAKES) : 0);
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish - 2;
  for (let i = 0; i < total; i++) {
    let x: number;
    let y: number;
    let heading: number;
    if (i < onFans) {
      let path: Path;
      if (i < onTrunks) {
        const pick = rand() * length;
        let lo = 0;
        let hi = trunks.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((ends[mid] ?? 0) < pick) lo = mid + 1;
          else hi = mid;
        }
        path = item(trunks, lo);
      } else {
        path = item(fans, Math.min(fans.length - 1, Math.floor(rand() * fans.length)));
      }
      const k = Math.min(path.xs.length - 2, Math.floor(rand() * (path.xs.length - 1)));
      const x0 = path.xs[k] ?? 0;
      const y0 = path.ys[k] ?? 0;
      const tx = (path.xs[k + 1] ?? 0) - x0;
      const ty = (path.ys[k + 1] ?? 0) - y0;
      const tl = Math.max(Math.hypot(tx, ty), 1e-6);
      const side = (rand() - 0.5) * 2.4;
      x = x0 - (ty / tl) * side;
      y = y0 + (tx / tl) * side;
      heading = Math.atan2(ty, tx) + (path.to >= 0 && rand() < 0.5 ? Math.PI : 0) + (rand() - 0.5) * 0.3;
    } else if (i < atFlakes) {
      const p = item(points, Math.min(points.length - 1, Math.floor(rand() * points.length)));
      const a = rand() * TAU;
      const r = p.r * (0.3 + 0.6 * rand());
      x = p.x + Math.cos(a) * r;
      y = p.y + Math.sin(a) * r;
      heading = a + (rand() - 0.5) * 1.2;
    } else {
      do {
        x = rand() * grid.width;
        y = rand() * grid.height;
      } while (Math.hypot(x - cx, y - cy) > dish);
      heading = rand() * TAU;
    }
    const o = i * 4;
    data[o] = clamp(x / grid.width, 0, 1);
    data[o + 1] = clamp(y / grid.height, 0, 1);
    data[o + 2] = ((heading % TAU) + TAU) % TAU;
    data[o + 3] = LIFE * (0.2 + 0.8 * rand());
  }
  // Specks per texel across a trunk about three texels wide, each keeping up AGENT_UNIT × REF / N.
  const level = length > 0 ? (AGENT_UNIT * REFERENCE_AGENTS * onTrunks) / (total * 3 * length) : AGENT_UNIT;
  return { data, level };
}

/** Streaming phase: crests advance along the veins, ease to a stop and run back, again and again. */
class PulseClock {
  phase = 0;
  #time = 0;

  advance(dt: number): void {
    if (dt <= 0) return;
    this.#time += dt;
    const s = Math.sin((TAU * this.#time) / SHUTTLE_PERIOD + SHUTTLE_START);
    const flow = s / Math.sqrt(s * s + SHUTTLE_SOFT);
    this.phase = ((((this.phase + (dt * PULSE_SPEED * flow) / PHYSARUM_WAVE) % 1) + 1) % 1);
  }
}

function agentShape(count: number): { width: number; height: number } {
  const width = 2 ** Math.ceil(Math.log2(count) / 2);
  return { width, height: Math.ceil(count / width) };
}

/** Block sums of the trail: one texel per 16 × 16. */
function sumSize(grid: Grid): { width: number; height: number } {
  return { width: Math.ceil(grid.width / 16), height: Math.ceil(grid.height / 16) };
}

// ---- GPU passes -------------------------------------------------------------------------------

const HASH = `
uint physarumHash(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float physarumRandom(inout uint state) {
  state = physarumHash(state);
  return float(state >> 8u) * (1.0 / 16777216.0);
}
`;

const MARK_GLSL = `
float physarumSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
float physarumMarkDistance(vec2 q) {
  vec2 m0 = vec2(-0.47, -0.5), m1 = vec2(-0.47, 0.5), m2 = vec2(0.0, -0.08), m3 = vec2(0.47, 0.5), m4 = vec2(0.47, -0.5);
  return min(min(physarumSegment(q, m0, m1), physarumSegment(q, m1, m2)), min(physarumSegment(q, m2, m3), physarumSegment(q, m3, m4)));
}
`;

/** Jones's step: sense at three sensors, turn, move (or bounce), starve or feed; the dead are reborn at a flake. */
const MOVE = `
const float TAU = 6.2831853;
uniform sampler2D uAgents;   // x, y (domain uv), heading, steps left without food (<= 0: waiting to be reborn)
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uRef;
uniform vec2 uGrid;
uniform float uReach;
uniform float uAngle;
uniform float uTurn;
uniform float uLife;
uniform int uStep;
uniform vec4 uFood[${PHYSARUM_MAX_FOOD}];
uniform int uFoodCount;
${HASH}
// What a sensor smells: the trail (saturating), the M's strokes, a flake (if the speck is hungry),
// less salt, light and the dish's wall.
float physarumSense(vec2 at, float cap, float mark, float food, float repel) {
  vec4 env = texture(uEnv, at);
  return min(texture(uTrail, at).r, cap) + mark * env.r + food * clamp(2.0 * env.b - 1.0, 0.0, 1.0) - repel * (env.g + env.a);
}
void main() {
  ivec2 texel = ivec2(gl_FragCoord.xy);
  vec4 agent = texelFetch(uAgents, texel, 0);
  uint state = physarumHash(uint(texel.y) * uint(uSize.x) + uint(texel.x) + physarumHash(uint(uStep)));
  vec2 unit = 1.0 / uGrid;
  if (agent.w <= 0.0) {
    for (int k = 0; k < 4; k++) {
      if (uFoodCount <= 0) break;
      int i = min(int(physarumRandom(state) * float(uFoodCount)), uFoodCount - 1);
      vec4 food = uFood[i];
      if (physarumRandom(state) >= food.w) continue;
      float a = physarumRandom(state) * TAU;
      float r = food.z * (0.4 + 0.5 * physarumRandom(state));
      float heading = a + (physarumRandom(state) - 0.5) * 1.2;
      fragColor = vec4(food.xy + vec2(cos(a), sin(a)) * r * unit, mod(heading, TAU), uLife * (0.5 + 0.5 * physarumRandom(state)));
      return;
    }
    fragColor = vec4(agent.xyz, 0.0);
    return;
  }
  float ref = max(texelFetch(uRef, ivec2(0), 0).r, 1e-4);
  float cap = ${glsl(SENSE_CAP)} * ref;
  float mark = ${glsl(MARK_SCENT)} * ref;
  float food = agent.w < ${glsl(HUNGRY)} * uLife ? ${glsl(FOOD_SENSE)} * ref : 0.0;
  float repel = ${glsl(REPEL)} * ref;
  float heading = agent.z;
  float front = physarumSense(agent.xy + uReach * vec2(cos(heading), sin(heading)) * unit, cap, mark, food, repel);
  float left = physarumSense(agent.xy + uReach * vec2(cos(heading + uAngle), sin(heading + uAngle)) * unit, cap, mark, food, repel);
  float right = physarumSense(agent.xy + uReach * vec2(cos(heading - uAngle), sin(heading - uAngle)) * unit, cap, mark, food, repel);
  float coin = physarumRandom(state);
  if (front < left && front < right) heading += coin < 0.5 ? uTurn : -uTurn;
  else if (front <= max(left, right)) heading += left > right ? uTurn : (right > left ? -uTurn : 0.0);
  heading += (physarumRandom(state) - 0.5) * ${glsl(WANDER)};
  vec2 next = agent.xy + vec2(cos(heading), sin(heading)) * unit * ${glsl(SPEED)};
  vec4 there = texture(uEnv, next);
  if (any(lessThan(next, unit)) || any(greaterThan(next, 1.0 - unit)) || there.g + there.a > 0.5) {
    next = agent.xy;
    heading = physarumRandom(state) * TAU;
    there = texture(uEnv, next);
  }
  float energy = there.b > 0.5 ? uLife : agent.w - 1.0;
  if (there.g + there.a > 0.9) energy = 0.0;
  fragColor = vec4(next, mod(heading, TAU), energy);
}
`;

/** Every living speck adds its deposit where it stands. */
const DEPOSIT = `
uniform sampler2D uAgents;
uniform float uDeposit;
bool particle(int id, out vec2 uv, out vec4 value) {
  vec4 agent = texelFetch(uAgents, particleTexel(id, textureSize(uAgents, 0)), 0);
  uv = agent.xy;
  value = vec4(uDeposit);
  return agent.w > 0.0;
}
`;

/** The trail spreads and evaporates; salt, light and the dish's wall kill it. */
const DIFFUSE = `
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform float uKeep;
void main() {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) sum += texture(uTrail, vUv + vec2(float(x), float(y)) * uTexel).r;
  }
  vec4 env = texture(uEnv, vUv);
  float trail = uKeep * sum / 9.0;
  trail *= 1.0 - clamp(1.6 * (env.g + env.a), 0.0, 1.0);
  fragColor = vec4(trail, 0.0, 0.0, 1.0);
}
`;

/**
 * The agar's state at half resolution: the M's scent along its strokes (0..1), salt, light (the lit
 * sea, and everything past the dish's glass wall), and feeding: 1 in a flake's pool, 0.5 at its rim
 * (specks feed, and hungry ones smell food, above 0.5), then a halo fading out to 2.6 radii that
 * the trunk level is never measured in, so the plasmodium crowding onto the flakes never sets it.
 */
const ENV = `
uniform sampler2D uSalt;
uniform sampler2D uSea;
uniform vec2 uGrid;
uniform vec4 uFood[${PHYSARUM_MAX_FOOD}];
uniform int uFoodCount;
uniform vec4 uMark;
uniform float uLight;
uniform vec3 uDish;   // centre (domain uv), radius (trail texels)
${MARK_GLSL}
void main() {
  vec2 p = vUv * uGrid;
  float scent = 0.0;
  float feed = 0.0;
  for (int i = 0; i < ${PHYSARUM_MAX_FOOD}; i++) {
    if (i >= uFoodCount) break;
    vec4 food = uFood[i];
    float dist = length(p - food.xy * uGrid);
    float pool = 1.0 - smoothstep(0.8 * food.z, 1.2 * food.z, dist);
    float halo = 1.0 - smoothstep(1.2 * food.z, 2.6 * food.z, dist);
    feed = max(feed, food.w * 0.5 * (pool + halo));
  }
  if (uMark.w > 0.0 && uMark.z > 0.0) {
    float m = physarumMarkDistance((p - uMark.xy * uGrid) / uMark.z) * uMark.z;
    scent = uMark.w * exp(-m * m / ${glsl(MARK_WIDTH * MARK_WIDTH)});
  }
  // The dish's glass wall is light to the mould: it blocks it and nothing grows past it.
  float wall = smoothstep(uDish.z - 1.5, uDish.z + 0.5, length(p - uDish.xy * uGrid));
  fragColor = vec4(scent, texture(uSalt, vUv).r, feed, max(texture(uSea, vUv).r * uLight, wall));
}
`;

/** Salt dissolves; a drag sprinkles a frayed line of it. Half-resolution texels. */
const SALT = `
uniform sampler2D uSalt;
uniform float uKeep;
uniform float uPaint;
uniform vec4 uSegment;
uniform float uRadius;
${HASH}
void main() {
  float salt = texelFetch(uSalt, ivec2(gl_FragCoord.xy), 0).r * uKeep;
  if (uPaint > 0.5) {
    vec2 pa = gl_FragCoord.xy - uSegment.xy, ba = uSegment.zw - uSegment.xy;
    float d = length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
    uint state = physarumHash(uint(gl_FragCoord.x) * 7919u + uint(gl_FragCoord.y) * 104729u);
    float fray = physarumRandom(state);
    salt = max(salt, 1.0 - smoothstep(uRadius * (0.5 + 0.4 * fray), uRadius * (1.0 + 0.35 * fray), d));
  }
  fragColor = vec4(salt, 0.0, 0.0, 1.0);
}
`;

/**
 * One relaxation of the distance from the heart along the veins (Bellman–Ford on the texel grid):
 * each texel takes its cheapest neighbour plus the step, cheap along veins and dear across agar.
 * Recomputed from the neighbours every pass, so it also grows back where a vein is lost.
 */
const DISTANCE = `
uniform sampler2D uDist;
uniform sampler2D uView;
uniform vec4 uHeart;   // domain uv, radius (texels), 1 while the heart is on the dish
uniform vec2 uStepH;   // one texel in screen heights
uniform float uStride;
const vec2 PHYSARUM_RING[8] = vec2[8](vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
  vec2(1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(-1.0, -1.0));
float physarumCost(vec2 at) {
  return 1.0 + ${glsl(COST_OFF)} * (1.0 - smoothstep(0.35, 0.6, texture(uView, at).r));
}
void main() {
  vec2 toHeart = (vUv - uHeart.xy) * uSize;
  if (uHeart.w > 0.5 && length(toHeart) < uHeart.z) {
    fragColor = vec4(length(toHeart * uStepH), 0.0, 0.0, 1.0);
    return;
  }
  float here = physarumCost(vUv);
  float best = ${glsl(PHYSARUM_FAR)};
  for (int k = 0; k < 8; k++) {
    vec2 o = PHYSARUM_RING[k] * uStride;
    vec2 at = vUv + o * uTexel;
    float cost = length(o * uStepH) * 0.5 * (here + physarumCost(at));
    best = min(best, texture(uDist, at).r + cost);
  }
  fragColor = vec4(min(best, ${glsl(PHYSARUM_FAR)}), 0.0, 0.0, 1.0);
}
`;

/**
 * What the shader sees: the trail in tone, smoothed in time, and its slow memory. Tone is the trail
 * over its trunk level raised to the power that puts a typical filament (the share of the trunk
 * level uRef.g) at LACE_TONE: whatever the mould's own contrast, trunks read ~1 and the lace a dim,
 * steady ~0.3, never lost in the dark nor shouting as loud as the trunks.
 */
const VIEW = `
uniform sampler2D uPrev;
uniform sampler2D uTrail;
uniform sampler2D uRef;
uniform float uBlend;
uniform float uRemember;
void main() {
  vec2 h = 0.5 * uTexel;
  float trail = 0.25 * (texture(uTrail, vUv + h).r + texture(uTrail, vUv - h).r
    + texture(uTrail, vUv + vec2(h.x, -h.y)).r + texture(uTrail, vUv + vec2(-h.x, h.y)).r);
  vec2 ref = texelFetch(uRef, ivec2(0), 0).rg;
  float gamma = clamp(log(${glsl(LACE_TONE)}) / log(clamp(ref.y, ${glsl(SHARE_MIN)}, ${glsl(SHARE_MAX)})), ${glsl(GAMMA_MIN)}, ${glsl(GAMMA_MAX)});
  float tone = pow(max(trail / max(ref.x, 1e-4), 1e-6), gamma);
  vec2 prev = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rg;
  float now = mix(prev.r, tone, uBlend);
  fragColor = vec4(now, mix(prev.g, now, uRemember), 0.0, 1.0);
}
`;

/**
 * Block moments of the trail away from the flakes and their halos: (Σt², Σt³) for the trunk level,
 * and the sum and count of texels lit above FILAMENT_FLOOR of it, for a typical filament.
 */
const SUMS = `
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uRef;
void main() {
  float haze = ${glsl(FILAMENT_FLOOR)} * texelFetch(uRef, ivec2(0), 0).r;
  vec2 grid = vec2(textureSize(uTrail, 0));
  vec2 base = floor(gl_FragCoord.xy) * 16.0;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      // Each tap sits on a texel corner, so the linear filter averages a 2 × 2 block.
      vec2 at = base + vec2(float(i), float(j)) * 2.0 + 1.0;
      if (at.x > grid.x || at.y > grid.y) continue;
      vec2 uv = at / grid;
      float t = texture(uTrail, uv).r * (1.0 - smoothstep(0.01, 0.1, texture(uEnv, uv).b));
      float lit = step(haze, t);
      sum += vec4(t * t, t * t * t, t * lit, lit);
    }
  }
  fragColor = sum;
}
`;

/**
 * The trunk level (the trail's mean weighted by its square, Σt³ / Σt²) and a typical filament's
 * share of it (the mean of the lit texels, over the trunk level), followed smoothly.
 */
const LEVEL = `
uniform sampler2D uSums;
uniform sampler2D uPrev;
uniform float uBlend;
void main() {
  ivec2 size = textureSize(uSums, 0);
  vec4 total = vec4(0.0);
  for (int j = 0; j < 64; j++) {
    if (j >= size.y) break;
    for (int i = 0; i < 64; i++) {
      if (i >= size.x) break;
      total += texelFetch(uSums, ivec2(i, j), 0);
    }
  }
  vec2 prev = texelFetch(uPrev, ivec2(0), 0).rg;
  vec2 now = prev;
  if (total.x > 1e-9 && total.w > 0.5) {
    float trunk = total.y / total.x;
    now = vec2(trunk, (total.z / total.w) / trunk);
  }
  fragColor = vec4(max(mix(prev, now, uBlend), vec2(1e-5)), 0.0, 1.0);
}
`;

// ---- the simulation ---------------------------------------------------------------------------

/** The slime mould grown on the GPU. */
class PhysarumSim implements SceneSim {
  readonly #gpu: GpuCompute;
  readonly #knobs: PhysarumKnobs;
  readonly #food = new FoodBook();
  readonly #pulse = new PulseClock();
  readonly #foodTexture: DataTexture;
  readonly #foodData = new Float32Array(PHYSARUM_MAX_FOOD * 3 * 4);
  readonly #foodUniform = new Float32Array(PHYSARUM_MAX_FOOD * 4);
  readonly #markUniform = new Float32Array(4);
  readonly #heartUniform = new Float32Array(4);
  readonly #gridUniform = new Float32Array(2);
  readonly #stepHeight = new Float32Array(2);
  readonly #segment = new Float32Array(4);
  readonly #dishUniform = new Float32Array(3);

  readonly #move: Pass;
  readonly #deposit: Scatter;
  readonly #diffuse: Pass;
  readonly #envPass: Pass;
  readonly #saltPass: Pass;
  readonly #distPass: Pass;
  readonly #viewPass: Pass;
  readonly #sumPass: Pass;
  readonly #levelPass: Pass;

  #grid: Grid;
  #frameGrid: Grid;
  #frameAspect = 0;
  #agents: PingPong;
  #agentCount: number;
  readonly #trail: PingPong;
  readonly #view: PingPong;
  readonly #env: RenderTarget;
  readonly #salt: PingPong;
  readonly #dist: PingPong;
  readonly #sea: RenderTarget;
  readonly #sums: RenderTarget;
  readonly #level: PingPong;
  #seaCover: Float32Array;

  #layout: Layout | undefined = undefined;
  #seed = 0;
  #layoutAspect = 1;
  #resetIn = 0;
  #triggers: number[] | undefined = undefined;
  #markUntil = -1;
  #markLast: number | undefined = undefined;
  #markHeld = 0;
  #press: { x: number; y: number; dragging: boolean } | undefined = undefined;
  #saltX = 0;
  #saltY = 0;
  #paint = false;
  #saltLeft = 0;
  #envDirty = true;
  #stepDebt = 0;
  #stepCount = 0;
  #stride = 1;
  #memoryDebt = 0;
  /** Steps since the last reset: the view crosses over from the sketch to the mould over SETTLE_STEPS. */
  #grown = 0;

  constructor(gpu: GpuCompute, knobs: PhysarumKnobs) {
    this.#gpu = gpu;
    this.#knobs = knobs;
    const gl = gpu.gl;
    this.#frameAspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
    const grid = new Grid(this.#frameAspect);
    this.#grid = grid;
    this.#frameGrid = grid;
    const field = { width: grid.width, height: grid.height };
    const half = { width: grid.envWidth, height: grid.envHeight };
    this.#agentCount = REFERENCE_AGENTS;
    this.#agents = gpu.pingPong({ ...agentShape(REFERENCE_AGENTS), format: "rgba32f", filter: "nearest" });
    this.#trail = gpu.pingPong({ ...field, format: "r16f" });
    this.#view = gpu.pingPong({ ...field, format: "rg16f" });
    this.#env = gpu.target({ ...half, format: "rgba16f" });
    this.#salt = gpu.pingPong({ ...half, format: "r16f" });
    this.#dist = gpu.pingPong({ ...half, format: "r32f", filter: "nearest" });
    this.#sea = gpu.target({ ...half, format: "r8" });
    this.#sums = gpu.target({ ...sumSize(grid), format: "rgba32f", filter: "nearest" });
    this.#level = gpu.pingPong({ width: 1, height: 1, format: "rg32f", filter: "nearest" });
    this.#seaCover = new Float32Array(half.width * half.height);
    this.#foodTexture = new DataTexture(gl, { width: PHYSARUM_MAX_FOOD, height: 3, format: "rgba16f", filter: "nearest" });

    this.#move = gpu.pass(MOVE, "physarum move");
    this.#deposit = gpu.scatter(DEPOSIT, { name: "physarum deposit" });
    this.#diffuse = gpu.pass(DIFFUSE, "physarum diffuse");
    this.#envPass = gpu.pass(ENV, "physarum agar");
    this.#saltPass = gpu.pass(SALT, "physarum salt");
    this.#distPass = gpu.pass(DISTANCE, "physarum distance");
    this.#viewPass = gpu.pass(VIEW, "physarum view");
    this.#sumPass = gpu.pass(SUMS, "physarum sums");
    this.#levelPass = gpu.pass(LEVEL, "physarum level");

    this.#move.bind({ uAgents: this.#agents, uTrail: this.#trail, uEnv: this.#env, uRef: this.#level });
    this.#deposit.bind({ uAgents: this.#agents });
    this.#diffuse.bind({ uTrail: this.#trail, uEnv: this.#env });
    this.#envPass.bind({ uSalt: this.#salt, uSea: this.#sea });
    this.#saltPass.bind({ uSalt: this.#salt });
    this.#distPass.bind({ uDist: this.#dist, uView: this.#view });
    this.#viewPass.bind({ uPrev: this.#view, uTrail: this.#trail, uRef: this.#level });
    this.#sumPass.bind({ uTrail: this.#trail, uEnv: this.#env, uRef: this.#level });
    this.#levelPass.bind({ uSums: this.#sums, uPrev: this.#level });
    this.#levelPass.set({ uBlend: 1 });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = readSettings(this.#knobs, frame);
    if (frame.aspect !== this.#frameAspect) {
      this.#frameAspect = frame.aspect;
      this.#frameGrid = new Grid(frame.aspect);
    }
    const grid = this.#frameGrid;
    const fired = this.#fired(frame.triggers);
    if (fired[1] === true) this.#markUntil = frame.time + MARK_HOLD;
    const mark = settings.mark ?? (frame.time < this.#markUntil ? settings.markNow : undefined);

    if (settings.layout !== this.#layout || settings.seed !== this.#seed) {
      this.#reset(settings, grid, frame.aspect, mark);
    } else {
      if (!grid.same(this.#grid)) {
        this.#stretch(grid);
        if (Math.abs(frame.aspect / this.#layoutAspect - 1) > RELAYOUT) this.#resetIn = RELAYOUT_FRAMES;
      }
      if (this.#resetIn > 0) {
        this.#resetIn -= 1;
        if (this.#resetIn === 0) this.#reset(settings, grid, frame.aspect, mark);
      }
      if (settings.agents !== this.#agentCount) this.#reseedAgents(settings.agents);
      this.#holdMark(mark);
    }
    if (fired[0] === true) this.#food.constellation();
    this.#touch(frame.pointer, frame.aspect, settings.salt);

    const dt = Math.max(0, frame.dt) * clamp(frame.motion, 0, 1);
    const simDt = dt * settings.tempo;
    this.#food.advance(simDt, settings.feedEvery);
    this.#pulse.advance(simDt);
    this.#syncUniforms(settings);
    this.#dissolve(simDt, settings.saltSeconds);
    if (simDt > 0 || this.#envDirty) {
      this.#envPass.run(this.#env);
      this.#envDirty = false;
    }

    this.#stepDebt += simDt * STEPS_PER_SECOND;
    const steps = Math.min(Math.floor(this.#stepDebt), MAX_STEPS);
    this.#stepDebt = Math.min(this.#stepDebt - steps, 1);
    for (let i = 0; i < steps; i++) this.#step();
    this.#grown += steps;
    if (dt > 0) {
      this.#measure(1 - Math.exp(-dt / REF_SECONDS));
      this.#memoryDebt += simDt;
      let remember = 0;
      if (this.#memoryDebt >= MEMORY_EVERY) {
        remember = 1 - Math.exp(-this.#memoryDebt / MEMORY_SECONDS);
        this.#memoryDebt = 0;
      }
      // Smoothed heavily while the view is still crossing over from the sketch, then lightly.
      const settled = Math.min(1, this.#grown / SETTLE_STEPS);
      const smoothing = SETTLE_SECONDS + (VIEW_SECONDS - SETTLE_SECONDS) * settled;
      this.#show(1 - Math.exp(-dt / smoothing), remember);
      this.#trace(DIST_PASSES);
    }

    this.#food.writeTexture(this.#foodData, this.#pulse.phase);
    this.#foodTexture.upload(this.#foodData);
    return [this.#view.texture, this.#dist.texture, this.#foodTexture.texture, this.#env.texture];
  }

  dispose(): void {
    this.#gpu.dispose();
    this.#foodTexture.dispose();
  }

  /** A fresh dish: lay the food, sketch its network, seed the specks along it and let them take it over. */
  #reset(settings: Settings, grid: Grid, aspect: number, mark: number | undefined): void {
    this.#layout = settings.layout;
    this.#seed = settings.seed;
    this.#layoutAspect = aspect;
    this.#resetIn = 0;
    this.#resize(grid, false);
    const map = settings.layout === "cities" ? cityMap(aspect) : undefined;
    this.#rasteriseSea(map);
    this.#food.reset(settings.layout, settings.seed, aspect, map, this.#seaAt, mark);
    this.#markLast = mark;
    this.#markHeld = 0;
    this.#replaceAgents(settings.agents);

    const { points, heart } = this.#food.sketchNodes(grid);
    const rand = mulberry32((Math.imul(settings.seed + 7, 0x85ebca6b) ^ 0x6a09e667) >>> 0);
    const paths = sketchPaths(points, grid, rand);
    const sketch = stampSketch(paths, points, grid, rand);
    const agents = seedAgents(this.#agents, paths, points, grid, rand);
    this.#agents.seed(agents.data);
    // The trail, the view and the measured levels agree: trail / trunk level = sketch / its level.
    const measured = sketchLevel(sketch);
    const raw = new Float32Array(sketch.length);
    const view = new Float32Array(sketch.length * 2);
    for (let i = 0; i < sketch.length; i++) {
      const v = sketch[i] ?? 0;
      raw[i] = v * agents.level;
      view[2 * i] = tone(v / measured.level, measured.share);
      view[2 * i + 1] = view[2 * i] ?? 0;
    }
    this.#trail.seed(raw);
    this.#view.seed(view);
    this.#dist.seed(stampDistance(paths, points, heart, grid));
    this.#level.seed(Float32Array.of(agents.level * measured.level, measured.share));
    this.#salt.clear(0);
    this.#saltLeft = 0;
    this.#stepDebt = 0;
    this.#memoryDebt = 0;
    this.#grown = 0;

    this.#syncUniforms(settings);
    this.#envPass.run(this.#env);
    this.#envDirty = false;
    this.#prewarm();
  }

  /**
   * As many real steps as the budget allows (GPU-synced), the view then crossed over from the sketch
   * by as much as they grew (all the way after SETTLE_STEPS): a fast GPU opens on the mould's own
   * network, a slow one on the sketch, which its mould then grows out of. The first chunk is short:
   * a software rasterizer may only manage a handful.
   */
  #prewarm(): void {
    const gl = this.#gpu.gl;
    const start = performance.now();
    for (let done = 0; done < PREWARM_STEPS; ) {
      const chunk = done === 0 ? 2 : PREWARM_CHUNK;
      for (let i = 0; i < chunk; i++) this.#step();
      done += chunk;
      this.#grown = done;
      this.#measure(0.3);
      this.#trace(1);
      gl.finish();
      if (performance.now() - start > PREWARM_MS) break;
    }
    const settled = Math.min(1, this.#grown / SETTLE_STEPS);
    this.#show(settled, settled);
  }

  #resize(grid: Grid, keep: boolean): void {
    this.#grid = grid;
    this.#trail.resize(grid.width, grid.height, keep);
    this.#view.resize(grid.width, grid.height, keep);
    this.#env.resize(grid.envWidth, grid.envHeight);
    this.#salt.resize(grid.envWidth, grid.envHeight, keep);
    this.#dist.resize(grid.envWidth, grid.envHeight, keep);
    this.#sea.resize(grid.envWidth, grid.envHeight);
    const sums = sumSize(grid);
    this.#sums.resize(sums.width, sums.height);
    this.#envDirty = true;
  }

  /** A resize: every field stretched over the new grid (specks and flakes keep their places). */
  #stretch(grid: Grid): void {
    this.#resize(grid, true);
    this.#rasteriseSea(this.#food.map);
  }

  #rasteriseSea(map: CityMap | undefined): void {
    const cover = seaCover(map, this.#grid);
    this.#seaCover = cover;
    const bytes = new Uint8Array(cover.length);
    for (let i = 0; i < cover.length; i++) bytes[i] = Math.round(clamp(cover[i] ?? 0, 0, 1) * 255);
    this.#sea.seed(bytes);
  }

  readonly #seaAt: SeaSampler = (u, v) => seaAt(this.#seaCover, this.#grid, u, v);

  #replaceAgents(count: number): void {
    if (count === this.#agentCount) return;
    this.#agents.dispose();
    this.#agents = this.#gpu.pingPong({ ...agentShape(count), format: "rgba32f", filter: "nearest" });
    this.#agentCount = count;
    this.#move.bind({ uAgents: this.#agents });
    this.#deposit.bind({ uAgents: this.#agents });
  }

  /** A new population, spread over a sketch of the flakes on the dish now; the trail stays. */
  #reseedAgents(count: number): void {
    this.#replaceAgents(count);
    const { points } = this.#food.sketchNodes(this.#grid);
    const rand = mulberry32((Math.imul(count, 0x9e3779b1) ^ this.#stepCount) >>> 0);
    this.#agents.seed(seedAgents(this.#agents, sketchPaths(points, this.#grid, rand), points, this.#grid, rand).data);
  }

  /** On and off at once; a new size only once the knob has rested, so a slider drag lays one M. */
  #holdMark(mark: number | undefined): void {
    const shown = this.#food.markSize;
    if ((mark === undefined) !== (shown === undefined)) {
      this.#food.setMark(mark);
      this.#markLast = mark;
      this.#markHeld = 0;
      return;
    }
    if (mark === undefined || shown === undefined || Math.abs(mark - shown) < 0.005) {
      this.#markHeld = 0;
      return;
    }
    if (mark !== this.#markLast) {
      this.#markLast = mark;
      this.#markHeld = 0;
      return;
    }
    this.#markHeld += 1;
    if (this.#markHeld >= MARK_SETTLE) {
      this.#food.setMark(mark);
      this.#markHeld = 0;
    }
  }

  /** Click: an oat flake where it landed. Drag: a line of salt along it. */
  #touch(pointer: PointerState, aspect: number, salt: boolean): void {
    this.#paint = false;
    if (pointer.pressed && pointer.inside) {
      this.#press = { x: pointer.x, y: pointer.y, dragging: false };
      this.#saltX = pointer.x;
      this.#saltY = pointer.y;
    }
    const press = this.#press;
    if (press === undefined) return;
    if (!press.dragging && Math.hypot((pointer.x - press.x) * aspect, pointer.y - press.y) > DRAG_START) press.dragging = true;
    if (press.dragging && salt) {
      const grid = this.#grid;
      this.#segment[0] = grid.envX(this.#saltX);
      this.#segment[1] = grid.envY(this.#saltY);
      this.#segment[2] = grid.envX(pointer.x);
      this.#segment[3] = grid.envY(pointer.y);
      this.#saltX = pointer.x;
      this.#saltY = pointer.y;
      this.#paint = true;
    }
    if (pointer.released || !pointer.down) {
      if (!press.dragging && pointer.inside) this.#food.drop(press.x, press.y);
      this.#press = undefined;
    }
  }

  /** Salt dissolves over its lifetime (and is cleared for good after); a drag adds more. */
  #dissolve(simDt: number, seconds: number): void {
    if (this.#paint) this.#saltLeft = Math.max(this.#saltLeft, seconds * SALT_TAIL);
    if (this.#saltLeft <= 0) return;
    this.#saltLeft -= simDt;
    this.#envDirty = true;
    if (this.#saltLeft <= 0) {
      this.#salt.clear(0);
      return;
    }
    const grid = this.#grid;
    this.#saltPass.run(this.#salt, {
      uniforms: {
        uKeep: Math.exp((-3 * simDt) / seconds),
        uPaint: this.#paint ? 1 : 0,
        uSegment: this.#segment,
        uRadius: SALT_RADIUS * grid.perHeight * (grid.envHeight / grid.height),
      },
    });
  }

  /** The flakes, the M, the heart and the knobs, as the passes read them. */
  #syncUniforms(settings: Settings): void {
    const grid = this.#grid;
    const food = this.#food;
    const count = food.writeUniform(this.#foodUniform, grid);
    this.#gridUniform[0] = grid.width;
    this.#gridUniform[1] = grid.height;
    this.#markUniform[0] = grid.domainX(0.5);
    this.#markUniform[1] = grid.domainY(0.5);
    this.#markUniform[2] = food.markHeight * grid.perHeight;
    this.#markUniform[3] = food.markShown;
    const heart = food.heartNode();
    this.#heartUniform[3] = 0;
    if (heart !== undefined && heart.strength > 0.5) {
      this.#heartUniform[0] = grid.domainX(heart.x);
      this.#heartUniform[1] = grid.domainY(heart.y);
      this.#heartUniform[2] = heart.radius * FEED_SCALE * grid.perHeight * (grid.envWidth / grid.width);
      this.#heartUniform[3] = 1;
    }
    this.#stepHeight[0] = grid.width / grid.envWidth / grid.perHeight;
    this.#stepHeight[1] = grid.height / grid.envHeight / grid.perHeight;
    this.#dishUniform[0] = grid.domainX(0.5);
    this.#dishUniform[1] = grid.domainY(0.5);
    this.#dishUniform[2] = grid.dish;
    this.#move.set({
      uGrid: this.#gridUniform,
      uReach: settings.reach,
      uAngle: settings.angle,
      uTurn: Math.max(settings.angle, (TURN_MIN * Math.PI) / 180),
      uLife: LIFE,
      uFood: this.#foodUniform,
      uFoodCount: count,
    });
    this.#deposit.set({ uDeposit: (settings.loss * AGENT_UNIT * REFERENCE_AGENTS) / this.#agentCount });
    this.#diffuse.set({ uKeep: 1 - settings.loss });
    this.#envPass.set({
      uGrid: this.#gridUniform,
      uFood: this.#foodUniform,
      uFoodCount: count,
      uMark: this.#markUniform,
      uLight: 1 - food.markShown,
      uDish: this.#dishUniform,
    });
    this.#distPass.set({ uHeart: this.#heartUniform, uStepH: this.#stepHeight });
  }

  #step(): void {
    this.#move.run(this.#agents, { uniforms: { uStep: this.#stepCount } });
    this.#deposit.run(this.#trail, { count: this.#agents.width * this.#agents.height });
    this.#diffuse.run(this.#trail);
    this.#stepCount = (this.#stepCount + 1) % STEP_WRAP;
  }

  /** Follow the trunk level by `blend`. */
  #measure(blend: number): void {
    this.#sumPass.run(this.#sums);
    this.#levelPass.run(this.#level, { uniforms: { uBlend: blend } });
  }

  #show(blend: number, remember: number): void {
    this.#viewPass.run(this.#view, { uniforms: { uBlend: blend, uRemember: remember } });
  }

  #trace(passes: number): void {
    for (let i = 0; i < passes; i++) {
      this.#stride = this.#stride === 1 ? 2 : 1;
      this.#distPass.run(this.#dist, { uniforms: { uStride: this.#stride } });
    }
  }

  /** Trigger slots stamped since the previous frame. */
  #fired(triggers: readonly number[]): boolean[] {
    const previous = this.#triggers;
    this.#triggers = [...triggers];
    return triggers.map((at, slot) => previous !== undefined && at !== previous[slot] && at > -1e3);
  }
}

/**
 * Without float render targets: the sketched network, still, with its streaming. Knob changes
 * (layout, dish, the M, the frame) sketch it afresh.
 */
class PhysarumStill implements SceneSim {
  readonly #knobs: PhysarumKnobs;
  readonly #food = new FoodBook();
  readonly #pulse = new PulseClock();
  readonly #foodData = new Float32Array(PHYSARUM_MAX_FOOD * 3 * 4);
  readonly #foodTexture: DataTexture;
  readonly #view: DataTexture;
  readonly #dist: DataTexture;
  readonly #env: DataTexture;
  #frameAspect = 0;
  #grid = new Grid(16 / 9);
  #layout: Layout | undefined = undefined;
  #seed = 0;
  #mark: number | undefined = undefined;
  #width = 0;
  #height = 0;

  constructor(gl: WebGL2RenderingContext, knobs: PhysarumKnobs) {
    this.#knobs = knobs;
    this.#foodTexture = new DataTexture(gl, { width: PHYSARUM_MAX_FOOD, height: 3, format: "rgba16f", filter: "nearest" });
    this.#view = new DataTexture(gl, { width: 1, height: 1, format: "rg16f" });
    this.#dist = new DataTexture(gl, { width: 1, height: 1, format: "r16f" });
    this.#env = new DataTexture(gl, { width: 1, height: 1, format: "rgba8" });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const settings = readSettings(this.#knobs, frame);
    if (frame.aspect !== this.#frameAspect) {
      this.#frameAspect = frame.aspect;
      this.#grid = new Grid(frame.aspect);
    }
    const grid = this.#grid;
    if (settings.layout !== this.#layout || settings.seed !== this.#seed || settings.mark !== this.#mark || grid.width !== this.#width || grid.height !== this.#height) {
      this.#build(settings, grid, frame.aspect);
    }
    this.#pulse.advance(Math.max(0, frame.dt) * clamp(frame.motion, 0, 1) * settings.tempo);
    this.#food.writeTexture(this.#foodData, this.#pulse.phase);
    this.#foodTexture.upload(this.#foodData);
    return [this.#view.texture, this.#dist.texture, this.#foodTexture.texture, this.#env.texture];
  }

  dispose(): void {
    this.#foodTexture.dispose();
    this.#view.dispose();
    this.#dist.dispose();
    this.#env.dispose();
  }

  #build(settings: Settings, grid: Grid, aspect: number): void {
    this.#layout = settings.layout;
    this.#seed = settings.seed;
    this.#mark = settings.mark;
    this.#width = grid.width;
    this.#height = grid.height;
    const map = settings.layout === "cities" ? cityMap(aspect) : undefined;
    const cover = seaCover(map, grid);
    this.#food.reset(settings.layout, settings.seed, aspect, map, (u, v) => seaAt(cover, grid, u, v), settings.mark);
    const { points, heart } = this.#food.sketchNodes(grid);
    const rand = mulberry32((Math.imul(settings.seed + 7, 0x85ebca6b) ^ 0x6a09e667) >>> 0);
    const paths = sketchPaths(points, grid, rand);
    const sketch = stampSketch(paths, points, grid, rand);
    const measured = sketchLevel(sketch);
    const view = new Float32Array(sketch.length * 2);
    for (let i = 0; i < sketch.length; i++) {
      view[2 * i] = tone((sketch[i] ?? 0) / measured.level, measured.share);
      view[2 * i + 1] = view[2 * i] ?? 0;
    }
    // Under an M the lights over the sea are out, as in the live dish.
    const light = settings.mark === undefined ? 255 : 0;
    const env = new Uint8Array(cover.length * 4);
    for (let i = 0; i < cover.length; i++) env[4 * i + 3] = Math.round(clamp(cover[i] ?? 0, 0, 1) * light);
    this.#view.resize(grid.width, grid.height);
    this.#view.upload(view);
    this.#dist.resize(grid.envWidth, grid.envHeight);
    this.#dist.upload(stampDistance(paths, points, heart, grid));
    this.#env.resize(grid.envWidth, grid.envHeight);
    this.#env.upload(env);
  }
}

/** The slime mould, for a scene whose `params` carry the knobs `PhysarumKnob` names. */
export function physarumSim(params: readonly ParamDef[]): SimFactory {
  const knobs = new PhysarumKnobs(params);
  return (gl) => {
    const gpu = GpuCompute.create(gl);
    return gpu === undefined ? new PhysarumStill(gl, knobs) : new PhysarumSim(gpu, knobs);
  };
}
