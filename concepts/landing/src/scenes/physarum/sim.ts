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
//     flake sends out a fan of fresh filaments. Each flake has a short halo of smell (about two and
//     a half sensor offsets), flat over the flake and falling off beyond it; hungry specks (half a
//     minute since they ate) smell it more keenly than fed ones. Trunks passing near a flake bend
//     into it and run through it, the lace round it gathers into a fan, and the flakes become the
//     network's junctions; when a flake is eaten its trunks lose their pull and relax back into
//     lace. The smell is kept apart from the trail, so the trail is only ever plasmodium (no
//     glowing pool round a flake), and it is short: a long-range scent pulled the whole population
//     into the flakes' basins and starved the lace.
//   - Each speck's sensor reach is its own (0.6–1.4 × the knob's): the short-sighted knit fine
//     branches and small loops between the trunks the long-sighted lay down.
//   - Salt (dragged across the dish), light (the sea on the Tokyo map, lit in the experiment so
//     the mould would shun it) and the dish's glass wall repel it, block it and kill the trail.
//   - Sensing saturates: where the plasmodium crowds onto a flake every sensor reads the same, so
//     specks cross it in straight lines and leave along the veins instead of circling it forever;
//     and every filament above a third of the trunk level reads alike, so the specks spread over
//     the mesh rather than piling into a few heavy bands.
// Per frame the trail is normalised by its trunk level (Σt³ / Σt² outside the flakes, followed
// over a second or two), so the picture is the same at any population or evaporation and the
// shader can draw trunks bright and the lace dim; smoothed over half a second, so the specks'
// flicker never reaches the dither; and remembered over a minute, so abandoned veins leave a faint
// track of slime. A distance field along the veins from the heart (where the mould began) carries
// the shuttle streaming: a slow brightness wave running out along the veins, easing to a stop and
// running back every minute or so.
//
// The first frame opens on a grown network: a web of one (see "the sketch" below: trunks joining the
// flakes, thinner veins between, a fine lace over the dish, widths by flow) seeds the trail and the
// view, the specks are spread over it, and a GPU prewarm (a fixed count of steps, spread over frames
// on a slow machine) lets the mould take it over. The view crosses over from the sketch to the live
// mould as the steps come in. The web's lace and thin veins stay on as a faint film the trail never
// falls below (see DIFFUSE), so the mould's own trunks form and reorganise over a fine net that does
// not condense away; it fades while an M is laid. Without float render targets the scene shows the
// sketch, still, with its streaming.
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
//   uSim3  rgba at half resolution: R food as the specks smell it (the flakes' halos, the M's
//          strokes), G salt, B feeding (1 in a flake's pool, 0.5 at its rim, a fringe beyond),
//          A light (the lit sea, and everything past the dish's glass wall).
import { MARK_VERTICES, markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { gpuCommonGlsl } from "../../shaders/common.ts";
import { glslFloat } from "../../shaders/glsl.ts";
import { runBudgeted } from "../../sims/clock.ts";
import { GpuCompute, gridSize, type Pass, type PingPong, type RenderTarget, type Scatter } from "../../sims/gpu.ts";
import { clamp, hash31, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { PointerState, SceneSim, SimFactory, SimFrame } from "../types.ts";

export class PhysarumError extends Error {}

const TAU = Math.PI * 2;

// ---- grids ------------------------------------------------------------------------------------

/**
 * Trail texels across the frame's shorter side, and at most along its longer one. Fine enough that
 * the specks occupy only ~15% of the texels (see physarumAgentCounts); the view's blur draws a
 * one-texel filament as a soft line ~2 cells wide.
 */
const TRAIL_SHORT = 400;
const TRAIL_LONG = 960;
/** Trail texels beyond each edge of the frame: the specks bounce off the grid's edge out of sight. */
export const PHYSARUM_MARGIN = 10;
/** Flake slots: the shader's loop and the passes' uniform arrays. */
export const PHYSARUM_MAX_FOOD = 32;
/**
 * The `agents` knob's choices, by index (the knob's value; URL `agents=0..2`). State textures are
 * 256 wide. In the dish on a 16:9 frame (~270k texels) they occupy ~7.5%, ~15% and ~23% of it:
 * Jones's model knits a reticulated network at a few to ~15% occupancy and condenses into a few
 * thick bands and loops well above it.
 */
export const physarumAgentCounts = [20_480, 40_960, 61_440] as const;
/** The `agents` knob's default index. */
export const PHYSARUM_AGENTS_DEFAULT = 1;
/** Deposits are scaled so the trail's total is the same at any population. */
const REFERENCE_AGENTS = 40_960;

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
/**
 * Sensed trail saturates here (× the trunk level): every filament above it smells alike, so specks
 * spread over the mesh instead of piling into a few heavy bands that starve the rest, and a crowd on
 * a flake reads flat, so they cross it.
 */
const SENSE_CAP = 0.3;
/**
 * Food as sensed (× the trunk level) by a fed and by a hungry speck (hungry: under HUNGRY of LIFE
 * left): a halo round each flake, flat over its pool and falling off linearly over HALO_REACH sensor
 * offsets beyond, so trunks passing near a flake bend into it and run through it, and the lace
 * round it gathers into a fan. Flat on top, so specks cross a flake along the trail rather than
 * circling it; weaker than a trunk's trail across one sensor offset, so they leave along trunks.
 */
const FOOD_FED = 0.4;
const FOOD_SENSE = 0.9;
const HUNGRY = 0.5;
const HALO_REACH = 2.5;
/** Each speck's sensor reach is the knob's times its own factor in this range: fine and coarse at once. */
const REACH_LOW = 0.6;
const REACH_HIGH = 1.4;
/** Salt, light and the dish's wall as sensed (× the trunk level). */
const REPEL = 6;
/** The scent laid along the M's strokes (0..1 of a flake's halo, sensed as food), and its half-width in trail texels. */
const MARK_SCENT = 0.8;
const MARK_WIDTH = 10;
/** Trail one speck per texel keeps up at the reference population. */
const AGENT_UNIT = 0.1;
/** A flake feeds out to this many of its radii. */
const FEED_SCALE = 1.3;
/** Evaporation per step at evaporation 0 and 1 (log-spaced between; Jones's ~10% at 0.5). */
const LOSS_MIN = 0.03;
const LOSS_MAX = 0.3;
/** Specks seeded along the sketch's web, along its fans and at the flakes; the rest anywhere on the dish. */
const SEED_EDGES = 0.6;
const SEED_FANS = 0.1;
const SEED_FLAKES = 0.12;

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

/**
 * GPU prewarm at a reset: PREWARM_STEPS real steps in chunks (the first short: a software rasterizer
 * may only manage a handful), GPU-synced after each chunk. A count of steps, never a duration, so the
 * opening picture does not depend on the machine's speed: PREWARM_MS only caps how long one frame may
 * block, and a slower machine finishes the same steps over several frames (the sim holds still till then).
 */
const PREWARM_MS = 130;
const PREWARM_FIRST = 2;
const PREWARM_CHUNK = 8;
/** 320 steps, rounded up to whole chunks. */
const PREWARM_STEPS = PREWARM_FIRST + PREWARM_CHUNK * Math.ceil((320 - PREWARM_FIRST) / PREWARM_CHUNK);

// ---- the sketch -------------------------------------------------------------------------------

/** Tributaries fanning out of each flake: how many, how far (heights), how much they wander. */
const FAN_MIN = 4;
const FAN_MAX = 8;
const FAN_SHORT = 0.03;
const FAN_LONG = 0.08;
const FAN_WANDER = 0.12;
/**
 * The film (stampFilm): the trail never falls below the sketch's lace and thin veins, at FILM_GAIN
 * times their level (× the trunk level). Weak enough that the mould lays its own trunks over it,
 * strong enough that the lace is smelt and the specks ride it. It fades away under the M.
 */
const FILM_GAIN = 1;

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

/** An element the code has just checked is there. */
function item<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new PhysarumError(`physarum: no item ${index} of ${items.length}`);
  return value;
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

const PHYSARUM_KNOBS = ["agents", "angle", "reach", "decay", "tempo", "layout", "feeding", "foodSeed", "salt", "mark"] as const;
type PhysarumKnob = (typeof PHYSARUM_KNOBS)[number];

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

function readSettings(knobs: KnobReader<PhysarumKnob>, frame: SimFrame): Settings {
  const agents = physarumAgentCounts[Math.round(knobs.value(frame, "agents"))] ?? REFERENCE_AGENTS;
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
    const lay = (vx: number, vy: number, kind: FoodKind): FoodNode =>
      this.#plant({
        x: 0.5 + (vx * height) / aspect, y: 0.5 + vy * height,
        radius: kind === "crumb" ? CRUMB_RADIUS * (0.85 + 0.3 * this.#rand()) : FLAKE_RADIUS,
        kind, site: -1, mark: true,
        rot: this.#rand() * TAU, elong: kind === "crumb" ? 0.7 + 0.25 * this.#rand() : 0.55 + 0.25 * this.#rand(), grain: this.#rand(),
      }, now);
    // Corners first, so they take the free slots before the crumbs.
    MARK_VERTICES.forEach(([vx, vy], i) => {
      const node = lay(vx, vy, "flake");
      if (i === 2) this.#heart = node.id;
    });
    for (let s = 0; s + 1 < MARK_VERTICES.length; s++) {
      const [ax, ay] = markVertex(s);
      const [bx, by] = markVertex(s + 1);
      const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / MARK_SPACING));
      for (let k = 1; k < pieces; k++) lay(ax + ((bx - ax) * k) / pieces, ay + ((by - ay) * k) / pieces, "crumb");
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
// What the mould looks like once it has spread, built on the CPU so the first frame (and a machine
// without float targets) shows one. A web of junctions (the flakes, and a jittered scatter of points,
// finer round the flakes and toward the dish's wall) is joined by a Delaunay mesh, and flow is routed
// over it: the flakes' spanning tree from the heart (each link carrying the flakes it feeds), the
// loops of their relative-neighbourhood graph and a few hubs out in the gaps, big links first so that
// the rest merge into the trunks already laid. Veins are drawn by Murray's law, their radius with the
// cube root of their flow: trunks joining the flakes, thinner veins between, and wherever no flow runs
// the mesh is thinned at random into a fine lace of polygonal cells (patchy over the dish, with
// feeders beside the veins). A fan of tributaries leaves each flake. The live mould starts from it,
// and its lace and thin veins stay on as the film (stampFilm).

/** A vein of the sketch, as points ~0.7 texel apart (trail texels). */
interface Path {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /** Texels along it. */
  readonly length: number;
  /** The web node it leaves (the flakes come first), and the one it reaches (-1: a tributary, petering out in the agar). */
  readonly from: number;
  readonly to: number;
  /** Trail level (sketch units) and profile width (texels); a tributary tapers from these to nothing. */
  readonly level: number;
  readonly sigma: number;
}

interface SketchPaths {
  /** The web's junctions in trail texels: the flakes first, in their order, then the lace's. */
  readonly nodes: readonly Point[];
  /** The web's veins between junctions, lace included. */
  readonly edges: readonly Path[];
  /** Tributaries fanning out of each flake. */
  readonly fans: readonly Path[];
}

/** Whether the mould keeps out of a point (trail texels): the lit sea. */
type Blocked = (x: number, y: number) => boolean;

/** A link to route over the mesh: junctions a and b, carrying this much flow (flakes fed). */
interface Link {
  readonly a: number;
  readonly b: number;
  readonly flow: number;
}

/** Junction spacing in open agar (heights), the share of it round flakes and by the wall, and the longest mesh edge (heights). */
const WEB_SPACING = 0.062;
const WEB_FINE = 0.62;
const WEB_LONGEST = 0.2;
/** Hubs: junctions out in the gaps tied in by thin veins: how many, how far apart (heights), and their flows. */
const WEB_HUBS = 10;
const HUB_GAP = 0.16;
const HUB_FLOW = 0.6;
const HUB_LOOP = 0.45;
/** Lace: level (sketch units), the share of the mesh's other edges kept in the open (more in patches and beside veins), and the cap on a feeder's level. */
const LACE_LEVEL = 0.2;
const LACE_KEEP = 0.34;
const FEEDER_MAX = 0.36;
/** A slow drift over the whole web (heights), and how far a vein wanders off its curve (share of its length). */
const WEB_DRIFT = 0.03;
const WEB_WANDER = 0.02;
/** Veins at or above this sketch level are the web's own, to keep or lose; fainter ones are lace. */
const VEIN_LEVEL = 0.4;
/** The film keeps the lace and the veins below this sketch level: the trunks are the mould's to lay. */
const FILM_TRUNK = 0.8;

/** The film's level (× the trunk level) for a path of this sketch level: lace at half of it, thin veins at ~0.4–0.6. */
function filmLevel(level: number): number {
  if (level >= FILM_TRUNK) return 0;
  return level < VEIN_LEVEL ? 0.5 * level : Math.max(0.2, 0.38 + 0.63 * (level - 0.45));
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

/** Prim's tree over the points from `root`: each point's parent (-1 for the root) and the size of its subtree. */
function flowTree(points: readonly Point[], root: number): { parent: Int32Array; size: Float64Array } {
  const n = points.length;
  const parent = new Int32Array(n).fill(-1);
  const size = new Float64Array(n).fill(1);
  const inTree = new Uint8Array(n);
  const best = new Float64Array(n).fill(Infinity);
  const order: number[] = [];
  best[root] = 0;
  for (let round = 0; round < n; round++) {
    let next = -1;
    for (let i = 0; i < n; i++) if (inTree[i] === 0 && (next < 0 || (best[i] ?? Infinity) < (best[next] ?? Infinity))) next = i;
    if (next < 0) break;
    inTree[next] = 1;
    order.push(next);
    const p = item(points, next);
    for (let i = 0; i < n; i++) {
      if (inTree[i] === 1) continue;
      const q = item(points, i);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < (best[i] ?? Infinity)) {
        best[i] = d;
        parent[i] = next;
      }
    }
  }
  for (let k = order.length - 1; k > 0; k--) {
    const i = order[k] ?? 0;
    const up = parent[i] ?? -1;
    if (up >= 0) size[up] = (size[up] ?? 0) + (size[i] ?? 0);
  }
  return { parent, size };
}

/** Value noise 0..1, one lattice cell per `scale` texels. */
function patchNoise(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale;
  const gy = y / scale;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = smoothstep(0, 1, gx - ix);
  const fy = smoothstep(0, 1, gy - iy);
  const top = hash31(ix, iy, seed) * (1 - fx) + hash31(ix + 1, iy, seed) * fx;
  const bottom = hash31(ix, iy + 1, seed) * (1 - fx) + hash31(ix + 1, iy + 1, seed) * fx;
  return top * (1 - fy) + bottom * fy;
}

/**
 * The lace's junctions: dart-thrown points over the dish, at least a spacing apart and from the
 * flakes (the spacing shrinks to WEB_FINE of itself round the flakes and toward the wall, where the
 * mould's fans advance), none in blocked ground.
 */
function scatterLace(flakes: readonly SketchNode[], grid: Grid, blocked: Blocked, rand: () => number): Point[] {
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish - 3;
  const perHeight = grid.perHeight;
  const base = WEB_SPACING * perHeight;
  const cols = Math.ceil(grid.width / base) + 1;
  const rows = Math.ceil(grid.height / base) + 1;
  const cells: number[][] = Array.from({ length: cols * rows }, () => []);
  const all: Point[] = [];
  const put = (p: Point): void => {
    const cell = clamp(Math.floor(p.y / base), 0, rows - 1) * cols + clamp(Math.floor(p.x / base), 0, cols - 1);
    item(cells, cell).push(all.length);
    all.push(p);
  };
  for (const flake of flakes) put({ x: flake.x, y: flake.y });
  const spacing = (x: number, y: number): number => {
    let near = Infinity;
    for (const flake of flakes) near = Math.min(near, Math.hypot(x - flake.x, y - flake.y) - flake.r);
    const round = 1 - smoothstep(0.05 * perHeight, 0.16 * perHeight, near);
    const rim = smoothstep(0.7 * dish, 0.97 * dish, Math.hypot(x - cx, y - cy));
    return base * (1 - (1 - WEB_FINE) * Math.max(round, rim));
  };
  const lace: Point[] = [];
  for (let attempt = 0; attempt < 16000; attempt++) {
    const a = rand() * TAU;
    const r = dish * Math.sqrt(rand());
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (blocked(x, y)) continue;
    const gap = spacing(x, y);
    const ci = clamp(Math.floor(x / base), 0, cols - 1);
    const cj = clamp(Math.floor(y / base), 0, rows - 1);
    let free = true;
    for (let j = Math.max(0, cj - 1); j <= Math.min(rows - 1, cj + 1) && free; j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(cols - 1, ci + 1) && free; i++) {
        for (const q of item(cells, j * cols + i)) {
          const p = item(all, q);
          if (Math.hypot(p.x - x, p.y - y) < gap) {
            free = false;
            break;
          }
        }
      }
    }
    if (!free) continue;
    const p = { x, y };
    put(p);
    lace.push(p);
  }
  return lace;
}

/** Delaunay edges of the points (Bowyer–Watson), as [i, j] with i < j. */
function delaunay(points: readonly Point[]): (readonly [number, number])[] {
  const n = points.length;
  const stride = n + 3;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const span = 40 * Math.max(maxX - minX, maxY - minY, 1);
  const mx = (minX + maxX) / 2;
  const my = (minY + maxY) / 2;
  const xs = new Float64Array(stride);
  const ys = new Float64Array(stride);
  points.forEach((p, i) => {
    xs[i] = p.x;
    ys[i] = p.y;
  });
  xs[n] = mx - span;
  ys[n] = my - span;
  xs[n + 1] = mx + span;
  ys[n + 1] = my - span;
  xs[n + 2] = mx;
  ys[n + 2] = my + span;
  // Triangles: three vertices and the circle through them (centre, squared radius).
  const va: number[] = [];
  const vb: number[] = [];
  const vc: number[] = [];
  const ox: number[] = [];
  const oy: number[] = [];
  const or2: number[] = [];
  const add = (a: number, b: number, c: number): void => {
    const ax = xs[a] ?? 0;
    const ay = ys[a] ?? 0;
    const bx = xs[b] ?? 0;
    const by = ys[b] ?? 0;
    const cx = xs[c] ?? 0;
    const cy = ys[c] ?? 0;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    va.push(a);
    vb.push(b);
    vc.push(c);
    if (Math.abs(d) < 1e-9) {
      // Flat: it contains every point, so the next one removes it.
      ox.push(0);
      oy.push(0);
      or2.push(Infinity);
      return;
    }
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    ox.push(ux);
    oy.push(uy);
    or2.push((ax - ux) * (ax - ux) + (ay - uy) * (ay - uy));
  };
  add(n, n + 1, n + 2);
  const hole = new Map<number, number>();
  const edge = (a: number, b: number): void => {
    const key = Math.min(a, b) * stride + Math.max(a, b);
    hole.set(key, (hole.get(key) ?? 0) + 1);
  };
  for (let p = 0; p < n; p++) {
    const px = xs[p] ?? 0;
    const py = ys[p] ?? 0;
    hole.clear();
    // The triangles whose circle holds the point go; the hole they leave is fanned out from it.
    for (let t = 0; t < va.length; ) {
      const dx = px - (ox[t] ?? 0);
      const dy = py - (oy[t] ?? 0);
      if (dx * dx + dy * dy >= (or2[t] ?? 0)) {
        t++;
        continue;
      }
      edge(va[t] ?? 0, vb[t] ?? 0);
      edge(vb[t] ?? 0, vc[t] ?? 0);
      edge(vc[t] ?? 0, va[t] ?? 0);
      const last = va.length - 1;
      va[t] = va[last] ?? 0;
      vb[t] = vb[last] ?? 0;
      vc[t] = vc[last] ?? 0;
      ox[t] = ox[last] ?? 0;
      oy[t] = oy[last] ?? 0;
      or2[t] = or2[last] ?? 0;
      va.pop();
      vb.pop();
      vc.pop();
      ox.pop();
      oy.pop();
      or2.pop();
    }
    for (const [key, count] of hole) {
      if (count === 1) add(Math.floor(key / stride), key % stride, p);
    }
  }
  const seen = new Set<number>();
  const edges: (readonly [number, number])[] = [];
  const keep = (a: number, b: number): void => {
    if (a >= n || b >= n) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * stride + hi;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push([lo, hi]);
  };
  for (let t = 0; t < va.length; t++) {
    keep(va[t] ?? 0, vb[t] ?? 0);
    keep(vb[t] ?? 0, vc[t] ?? 0);
    keep(vc[t] ?? 0, va[t] ?? 0);
  }
  return edges;
}

/** The cheapest chain of mesh edges from `from` to `to` (edge indices; empty if there is none). */
function shortestRoute(adjacent: readonly (readonly number[])[], ends: Int32Array, cost: Float64Array, from: number, to: number): number[] {
  const dist = new Float64Array(adjacent.length).fill(Infinity);
  const via = new Int32Array(adjacent.length).fill(-1);
  // A binary heap of (distance, node), stale entries skipped as they surface.
  const keys: number[] = [0];
  const nodes: number[] = [from];
  dist[from] = 0;
  while (keys.length > 0) {
    const top = nodes[0] ?? 0;
    const topKey = keys[0] ?? 0;
    const lastKey = keys.pop() ?? 0;
    const lastNode = nodes.pop() ?? 0;
    if (keys.length > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= keys.length) break;
        if (c + 1 < keys.length && (keys[c + 1] ?? 0) < (keys[c] ?? 0)) c++;
        if ((keys[c] ?? 0) >= lastKey) break;
        keys[i] = keys[c] ?? 0;
        nodes[i] = nodes[c] ?? 0;
        i = c;
      }
      keys[i] = lastKey;
      nodes[i] = lastNode;
    }
    if (topKey > (dist[top] ?? Infinity)) continue;
    if (top === to) break;
    for (const e of adjacent[top] ?? []) {
      const a = ends[2 * e] ?? 0;
      const other = a === top ? (ends[2 * e + 1] ?? 0) : a;
      const d = topKey + (cost[e] ?? Infinity);
      if (d >= (dist[other] ?? Infinity)) continue;
      dist[other] = d;
      via[other] = e;
      let i = keys.length;
      keys.push(d);
      nodes.push(other);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if ((keys[parent] ?? 0) <= d) break;
        keys[i] = keys[parent] ?? 0;
        nodes[i] = nodes[parent] ?? 0;
        i = parent;
      }
      keys[i] = d;
      nodes[i] = other;
    }
  }
  const route: number[] = [];
  if (!Number.isFinite(dist[to] ?? Infinity)) return route;
  for (let at = to; at !== from; ) {
    const e = via[at] ?? -1;
    route.push(e);
    const a = ends[2 * e] ?? 0;
    at = a === at ? (ends[2 * e + 1] ?? 0) : a;
  }
  return route;
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

/** A vein from a leaving along (tax, tay) to b arriving against (tbx, tby): a Hermite curve, wandering a little off it. */
function curve(ax: number, ay: number, bx: number, by: number, tax: number, tay: number, tbx: number, tby: number, amplitude: number, rand: () => number): { xs: Float64Array; ys: Float64Array; length: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const span = Math.max(Math.hypot(dx, dy), 1e-6);
  const bow = (rand() - 0.5) * 1.2 * amplitude;
  const a1 = amplitude * (0.5 + rand());
  const f1 = 1 + rand();
  const p1 = rand() * TAU;
  const n = Math.max(2, Math.ceil(span / 0.7));
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  const m0x = tax * span;
  const m0y = tay * span;
  const m1x = -tbx * span;
  const m1y = -tby * span;
  let length = 0;
  let px = ax;
  let py = ay;
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const side = span * Math.sin(Math.PI * t) * (bow + a1 * Math.sin(TAU * f1 * t + p1));
    const x = h00 * ax + h10 * m0x + h01 * bx + h11 * m1x - (dy / span) * side;
    const y = h00 * ay + h10 * m0y + h01 * by + h11 * m1y + (dx / span) * side;
    length += Math.hypot(x - px, y - py);
    xs[k] = x;
    ys[k] = y;
    px = x;
    py = y;
  }
  return { xs, ys, length };
}

/** The web: junctions (the flakes first) and the veins and lace between them. */
function buildWeb(flakes: readonly SketchNode[], heart: number, grid: Grid, blocked: Blocked, seed: number): { nodes: Point[]; edges: Path[] } {
  const rand = mulberry32(seed);
  const perHeight = grid.perHeight;
  const n = flakes.length;
  const lace = scatterLace(flakes, grid, blocked, rand);
  const nodes: Point[] = [...flakes.map((flake): Point => ({ x: flake.x, y: flake.y })), ...lace];
  const total = nodes.length;
  // The mesh: Delaunay edges that are not overlong and keep out of blocked ground.
  const ea: number[] = [];
  const eb: number[] = [];
  const lengths: number[] = [];
  for (const [i, j] of delaunay(nodes)) {
    const a = item(nodes, i);
    const b = item(nodes, j);
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    if (length > WEB_LONGEST * perHeight) continue;
    if (blocked((a.x + b.x) / 2, (a.y + b.y) / 2) || blocked(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25) || blocked(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75)) continue;
    ea.push(i);
    eb.push(j);
    lengths.push(length);
  }
  const count = ea.length;
  const ends = new Int32Array(count * 2);
  const adjacent: number[][] = Array.from({ length: total }, () => []);
  const base = new Float64Array(count);
  for (let e = 0; e < count; e++) {
    ends[2 * e] = ea[e] ?? 0;
    ends[2 * e + 1] = eb[e] ?? 0;
    item(adjacent, ea[e] ?? 0).push(e);
    item(adjacent, eb[e] ?? 0).push(e);
    base[e] = (lengths[e] ?? 0) * (0.85 + 0.3 * rand());
  }
  const cost = Float64Array.from(base);
  // Links to route: the flakes' spanning tree from the heart (a link feeds every flake beyond it),
  // the loops of their neighbourhood graph, and hubs in the gaps tied to their two nearest.
  const links: Link[] = [];
  if (n >= 2) {
    const { parent, size } = flowTree(flakes, heart >= 0 && heart < n ? heart : 0);
    const inTree = new Set<number>();
    for (let i = 0; i < n; i++) {
      const up = parent[i] ?? -1;
      if (up < 0) continue;
      inTree.add(Math.min(up, i) * 64 + Math.max(up, i));
      links.push({ a: up, b: i, flow: size[i] ?? 1 });
    }
    for (const [i, j] of neighbourhood(flakes)) {
      if (inTree.has(i * 64 + j)) continue;
      links.push({ a: i, b: j, flow: clamp(0.35 * Math.min(size[i] ?? 1, size[j] ?? 1), 0.8, 4) });
    }
  }
  if (n >= 1) {
    const candidates: number[] = [];
    for (let i = n; i < total; i++) {
      const p = item(nodes, i);
      let near = Infinity;
      for (const flake of flakes) near = Math.min(near, Math.hypot(p.x - flake.x, p.y - flake.y));
      if (near > 0.09 * perHeight) candidates.push(i);
    }
    for (let k = candidates.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      const swap = candidates[k] ?? 0;
      candidates[k] = candidates[j] ?? 0;
      candidates[j] = swap;
    }
    const tied: number[] = flakes.map((_, i) => i);
    let hubs = 0;
    for (const c of candidates) {
      if (hubs >= WEB_HUBS) break;
      const p = item(nodes, c);
      const ranked = tied.map((t) => ({ t, d: Math.hypot(item(nodes, t).x - p.x, item(nodes, t).y - p.y) })).sort((x, y) => x.d - y.d);
      if (ranked.some((r) => r.t >= n && r.d < HUB_GAP * perHeight)) continue;
      const first = ranked[0];
      const second = ranked[1];
      if (first === undefined) continue;
      links.push({ a: first.t, b: c, flow: HUB_FLOW });
      if (second !== undefined && second.d < 0.3 * perHeight) links.push({ a: second.t, b: c, flow: HUB_LOOP });
      tied.push(c);
      hubs++;
    }
  }
  // Big links first: the rest find the trunks laid cheaper to follow and merge into them.
  links.sort((x, y) => y.flow - x.flow);
  const flow = new Float64Array(count);
  for (const link of links) {
    for (const e of shortestRoute(adjacent, ends, cost, link.a, link.b)) {
      flow[e] = (flow[e] ?? 0) + link.flow;
      cost[e] = (base[e] ?? 0) * (1 - 0.3 * Math.min(1, (flow[e] ?? 0) / 4));
    }
  }
  // Junctions the veins pass (hop 0), and those beside them (1): their lace thickens into feeders.
  const hop = new Int32Array(total).fill(9);
  let thickest = 1;
  for (let e = 0; e < count; e++) {
    if ((flow[e] ?? 0) <= 0) continue;
    thickest = Math.max(thickest, Math.cbrt(flow[e] ?? 0));
    hop[ea[e] ?? 0] = 0;
    hop[eb[e] ?? 0] = 0;
  }
  for (let e = 0; e < count; e++) {
    const a = ea[e] ?? 0;
    const b = eb[e] ?? 0;
    if ((hop[a] ?? 9) === 0 && (hop[b] ?? 9) > 1) hop[b] = 1;
    if ((hop[b] ?? 9) === 0 && (hop[a] ?? 9) > 1) hop[a] = 1;
  }
  // Widths. Murray's law: radius with the cube root of the flow, from the thinnest vein to the
  // thickest trunk; lace where none runs, kept at random.
  const noiseSeed = seed & 0xffff;
  const kept = new Uint8Array(count);
  const level = new Float64Array(count);
  const sigma = new Float64Array(count);
  for (let e = 0; e < count; e++) {
    const f = flow[e] ?? 0;
    if (f > 0) {
      const share = clamp((Math.cbrt(f) - 0.8) / Math.max(thickest - 0.8, 0.5), 0, 1);
      kept[e] = 1;
      level[e] = 0.45 + 0.9 * Math.pow(share, 0.9);
      sigma[e] = 0.8 + 0.55 * share;
      continue;
    }
    const a = item(nodes, ea[e] ?? 0);
    const b = item(nodes, eb[e] ?? 0);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const patch = patchNoise(mx, my, 0.3 * perHeight, noiseSeed) * 0.6 + patchNoise(mx, my, 0.11 * perHeight, noiseSeed + 5) * 0.4;
    const near = Math.min(hop[ea[e] ?? 0] ?? 9, hop[eb[e] ?? 0] ?? 9);
    const keep = LACE_KEEP + 0.35 * smoothstep(0.3, 0.7, patch) + (near === 0 ? 0.25 : near === 1 ? 0.1 : 0);
    if (rand() > keep) continue;
    kept[e] = 1;
    level[e] = Math.min(FEEDER_MAX, LACE_LEVEL * (0.75 + 0.5 * rand()) * (0.6 + 0.6 * patch) * (near === 0 ? 1.7 : near === 1 ? 1.3 : 1));
    sigma[e] = 0.6;
  }
  // Straighten the veins: a junction with just two veins through it moves toward the middle of their
  // far ends; then a slow drift bends the whole web together, so no vein wanders on its own.
  const spot = nodes.map((p): Point => ({ x: p.x, y: p.y }));
  const through: number[][] = Array.from({ length: total }, () => []);
  for (let e = 0; e < count; e++) {
    if ((flow[e] ?? 0) <= 0) continue;
    item(through, ea[e] ?? 0).push(e);
    item(through, eb[e] ?? 0).push(e);
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let v = n; v < total; v++) {
      const pair = item(through, v);
      if (pair.length !== 2) continue;
      const far = pair.map((e) => item(spot, (ea[e] ?? 0) === v ? (eb[e] ?? 0) : (ea[e] ?? 0)));
      const p = item(spot, v);
      const f0 = item(far, 0);
      const f1 = item(far, 1);
      p.x += 0.5 * ((f0.x + f1.x) / 2 - p.x);
      p.y += 0.5 * ((f0.y + f1.y) / 2 - p.y);
    }
  }
  for (let v = n; v < total; v++) {
    const p = item(spot, v);
    p.x += (patchNoise(p.x, p.y, 0.4 * perHeight, noiseSeed + 11) - 0.5) * 2 * WEB_DRIFT * perHeight;
    p.y += (patchNoise(p.x, p.y, 0.4 * perHeight, noiseSeed + 23) - 0.5) * 2 * WEB_DRIFT * perHeight;
  }
  for (let e = 0; e < count; e++) {
    const a = item(spot, ea[e] ?? 0);
    const b = item(spot, eb[e] ?? 0);
    lengths[e] = Math.hypot(a.x - b.x, a.y - b.y);
  }
  // Tangents: at each junction the two strongest veins run on through it, the rest leave at an angle.
  const incident: number[][] = Array.from({ length: total }, () => []);
  const chord = new Float64Array(count * 2);
  for (let e = 0; e < count; e++) {
    if (kept[e] === 0) continue;
    const a = item(spot, ea[e] ?? 0);
    const b = item(spot, eb[e] ?? 0);
    const length = Math.max(lengths[e] ?? 1, 1e-6);
    chord[2 * e] = (b.x - a.x) / length;
    chord[2 * e + 1] = (b.y - a.y) / length;
    item(incident, ea[e] ?? 0).push(e);
    item(incident, eb[e] ?? 0).push(e);
  }
  // Per edge: the unit tangent leaving its first junction (x, y), then leaving its second (x, y).
  const tangent = new Float64Array(count * 4);
  for (let e = 0; e < count; e++) {
    tangent[4 * e] = chord[2 * e] ?? 0;
    tangent[4 * e + 1] = chord[2 * e + 1] ?? 0;
    tangent[4 * e + 2] = -(chord[2 * e] ?? 0);
    tangent[4 * e + 3] = -(chord[2 * e + 1] ?? 0);
  }
  const outward = (e: number, v: number): [number, number] => {
    const sign = (ea[e] ?? 0) === v ? 1 : -1;
    return [sign * (chord[2 * e] ?? 0), sign * (chord[2 * e + 1] ?? 0)];
  };
  const leave = (e: number, v: number, x: number, y: number): void => {
    const at = (ea[e] ?? 0) === v ? 4 * e : 4 * e + 2;
    tangent[at] = x;
    tangent[at + 1] = y;
  };
  for (let v = 0; v < total; v++) {
    const around = [...item(incident, v)].sort((x, y) => (level[y] ?? 0) - (level[x] ?? 0));
    const first = around[0];
    if (first === undefined || around.length < 2) continue;
    const [u1x, u1y] = outward(first, v);
    let second = -1;
    let bestScore = -Infinity;
    for (const e of around.slice(1)) {
      const [ux, uy] = outward(e, v);
      const score = -(u1x * ux + u1y * uy) + 0.5 * ((level[e] ?? 0) / Math.max(level[first] ?? 1, 1e-6));
      if (score > bestScore) {
        bestScore = score;
        second = e;
      }
    }
    if (second < 0) continue;
    const [u2x, u2y] = outward(second, v);
    const spread = Math.hypot(u1x - u2x, u1y - u2y);
    if (spread < 1e-6) continue;
    const tx = (u1x - u2x) / spread;
    const ty = (u1y - u2y) / spread;
    const o1x = 0.5 * u1x + 0.5 * tx;
    const o1y = 0.5 * u1y + 0.5 * ty;
    const o2x = 0.5 * u2x - 0.5 * tx;
    const o2y = 0.5 * u2y - 0.5 * ty;
    const l1 = Math.max(Math.hypot(o1x, o1y), 1e-6);
    const l2 = Math.max(Math.hypot(o2x, o2y), 1e-6);
    leave(first, v, o1x / l1, o1y / l1);
    leave(second, v, o2x / l2, o2y / l2);
  }
  const edges: Path[] = [];
  for (let e = 0; e < count; e++) {
    if (kept[e] === 0) continue;
    const a = item(spot, ea[e] ?? 0);
    const b = item(spot, eb[e] ?? 0);
    const line = curve(a.x, a.y, b.x, b.y, tangent[4 * e] ?? 0, tangent[4 * e + 1] ?? 0, tangent[4 * e + 2] ?? 0, tangent[4 * e + 3] ?? 0, (flow[e] ?? 0) > 0 ? WEB_WANDER : 0.6 * WEB_WANDER, rand);
    edges.push({ ...line, from: ea[e] ?? 0, to: eb[e] ?? 0, level: level[e] ?? 0, sigma: sigma[e] ?? 0.6 });
  }
  return { nodes: spot, edges };
}

/** The sketch's web and the fans of tributaries leaving each flake; `seed` fixes the web, `rand` the fans. */
function sketchPaths(points: readonly SketchNode[], heart: number, grid: Grid, blocked: Blocked, seed: number, rand: () => number): SketchPaths {
  const web = buildWeb(points, heart, grid, blocked, seed);
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
  return { nodes: web.nodes, edges: web.edges, fans };
}

/** The lit sea is closed to the sketch (not once an M has put the lights out). */
function seaBlocked(cover: Float32Array, grid: Grid, lit: boolean): Blocked {
  if (!lit) return () => false;
  return (x, y) => seaAt(cover, grid, (x - PHYSARUM_MARGIN) / grid.frameWidth, (y - PHYSARUM_MARGIN) / grid.frameHeight) > 0.15;
}

/** The random numbers for a sketch of the dish with this seed: one number fixing the web, a stream for the rest. */
function sketchSeeds(seed: number): { web: number; rand: () => number } {
  const web = (Math.imul(seed + 7, 0x85ebca6b) ^ 0x6a09e667) >>> 0;
  return { web, rand: mulberry32(web ^ 0x5bd1e995) };
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

/** Nothing grows past the dish's wall. */
function clipToDish(field: Float32Array, grid: Grid): void {
  const cx = grid.trailX(0.5);
  const cy = grid.trailY(0.5);
  const dish = grid.dish;
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > dish) field[y * grid.width + x] = 0;
  }
}

/**
 * The sketch as trail, in sketch units (lace ≤ 0.2, feeders and fans ~0.35, thin veins ~0.5, trunks
 * to ~1.35, the crowd on a flake 1, with a faint pad of plasmodium round it).
 */
function stampSketch(paths: SketchPaths, points: readonly SketchNode[], grid: Grid): Float32Array {
  const field = new Float32Array(grid.width * grid.height);
  for (const path of paths.edges) stampPath(field, grid, path, false);
  for (const path of paths.fans) stampPath(field, grid, path, true);
  for (const p of points) {
    splat(field, grid, p.x, p.y, 1, Math.max(1, 0.7 * p.r));
    splat(field, grid, p.x, p.y, 0.3, 1.6 * p.r);
  }
  clipToDish(field, grid);
  return field;
}

/**
 * The film: the sketch's lace, feeders, tributaries and thin veins as the level (× the trunk level)
 * the trail never falls below (DIFFUSE). The specks ride it, so the mould's own trunks form and
 * reorganise over a fine net that does not condense away.
 */
function stampFilm(paths: SketchPaths, grid: Grid): Float32Array {
  const field = new Float32Array(grid.width * grid.height);
  for (const path of paths.edges) {
    const level = filmLevel(path.level);
    if (level > 0) stampPath(field, grid, { ...path, level }, false);
  }
  for (const path of paths.fans) stampPath(field, grid, { ...path, level: filmLevel(path.level) }, true);
  clipToDish(field, grid);
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

/** Distance along the sketch's veins from the heart (screen heights) at half resolution; PHYSARUM_FAR elsewhere. */
function stampDistance(paths: SketchPaths, points: readonly SketchNode[], heart: number, grid: Grid): Float32Array {
  const ew = grid.envWidth;
  const eh = grid.envHeight;
  const field = new Float32Array(ew * eh).fill(PHYSARUM_FAR);
  if (heart < 0 || heart >= points.length) return field;
  const sx = ew / grid.width;
  const sy = eh / grid.height;
  const unitX = 1 / (sx * grid.perHeight);
  const unitY = 1 / (sy * grid.perHeight);
  // Dijkstra over the veins (not the lace), in heights along them.
  const veins = paths.edges.filter((path) => path.level >= VEIN_LEVEL);
  const n = paths.nodes.length;
  const joined: Path[][] = Array.from({ length: n }, () => []);
  for (const path of veins) {
    item(joined, path.from).push(path);
    item(joined, path.to).push(path);
  }
  const along = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  along[heart] = 0;
  for (;;) {
    let next = -1;
    for (let i = 0; i < n; i++) if (done[i] === 0 && Number.isFinite(along[i] ?? Infinity) && (next < 0 || (along[i] ?? 0) < (along[next] ?? 0))) next = i;
    if (next < 0) break;
    done[next] = 1;
    for (const path of item(joined, next)) {
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
  for (const path of [...veins, ...paths.fans]) {
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
 * The specks for a sketch: SEED_EDGES laid along its web, in proportion to each vein's length and
 * level, heading either way, SEED_FANS out along its tributaries, SEED_FLAKES at the flakes heading
 * out, the rest anywhere on the dish, any way; ages spread so they do not all starve at once. Also
 * returns the trail level (raw units per sketch unit) they will keep up, to scale the seeded trail by.
 */
function seedAgents(shape: { width: number; height: number }, paths: SketchPaths, points: readonly SketchNode[], grid: Grid, rand: () => number): { data: Float32Array; level: number } {
  const total = shape.width * shape.height;
  const data = new Float32Array(total * 4);
  const edges = paths.edges;
  const fans = paths.fans;
  let mass = 0;
  const ends = new Float64Array(edges.length);
  edges.forEach((path, i) => {
    mass += path.length * path.level;
    ends[i] = mass;
  });
  const onEdges = mass > 0 ? Math.floor(total * SEED_EDGES) : 0;
  const onFans = onEdges + (fans.length > 0 ? Math.floor(total * SEED_FANS) : 0);
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
      if (i < onEdges) {
        const pick = rand() * mass;
        let lo = 0;
        let hi = edges.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((ends[mid] ?? 0) < pick) lo = mid + 1;
          else hi = mid;
        }
        path = item(edges, lo);
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
  // Specks per texel along a vein of level 1, each keeping up AGENT_UNIT × REF / N over about three texels' width.
  const level = mass > 0 ? (AGENT_UNIT * REFERENCE_AGENTS * onEdges) / (total * 3 * mass) : AGENT_UNIT;
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
// What a sensor smells: the trail (saturating), food (the flakes' halos and the M's strokes, more
// keenly when hungry), less salt, light and the dish's wall.
float physarumSense(vec2 at, float cap, float food, float repel) {
  vec4 env = texture(uEnv, at);
  return min(texture(uTrail, at).r, cap) + food * env.r - repel * (env.g + env.a);
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
  float cap = ${glslFloat(SENSE_CAP)} * ref;
  float food = (agent.w < ${glslFloat(HUNGRY)} * uLife ? ${glslFloat(FOOD_SENSE)} : ${glslFloat(FOOD_FED)}) * ref;
  float repel = ${glslFloat(REPEL)} * ref;
  // This speck's own reach, fixed by its slot: short-sighted ones knit fine branches, long-sighted ones trunks.
  uint id = uint(texel.y) * uint(uSize.x) + uint(texel.x);
  float reach = uReach * mix(${glslFloat(REACH_LOW)}, ${glslFloat(REACH_HIGH)}, float(physarumHash(id ^ 0x9e3779b9u) >> 8u) * (1.0 / 16777216.0));
  float heading = agent.z;
  float front = physarumSense(agent.xy + reach * vec2(cos(heading), sin(heading)) * unit, cap, food, repel);
  float left = physarumSense(agent.xy + reach * vec2(cos(heading + uAngle), sin(heading + uAngle)) * unit, cap, food, repel);
  float right = physarumSense(agent.xy + reach * vec2(cos(heading - uAngle), sin(heading - uAngle)) * unit, cap, food, repel);
  float coin = physarumRandom(state);
  if (front < left && front < right) heading += coin < 0.5 ? uTurn : -uTurn;
  else if (front <= max(left, right)) heading += left > right ? uTurn : (right > left ? -uTurn : 0.0);
  heading += (physarumRandom(state) - 0.5) * ${glslFloat(WANDER)};
  vec2 next = agent.xy + vec2(cos(heading), sin(heading)) * unit * ${glslFloat(SPEED)};
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

/**
 * The trail spreads and evaporates, but never falls below the film (the sketch's lace and thin veins,
 * in trunk levels, uFilm; the gain fades it under the M); salt, light and the dish's wall kill it.
 */
const DIFFUSE = `
uniform sampler2D uTrail;
uniform sampler2D uEnv;
uniform sampler2D uFilm;
uniform sampler2D uRef;
uniform float uKeep;
uniform float uFilmGain;
void main() {
  float sum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) sum += texture(uTrail, vUv + vec2(float(x), float(y)) * uTexel).r;
  }
  vec4 env = texture(uEnv, vUv);
  float trail = uKeep * sum / 9.0;
  trail = max(trail, uFilmGain * texelFetch(uRef, ivec2(0), 0).r * texture(uFilm, vUv).r);
  trail *= 1.0 - clamp(1.6 * (env.g + env.a), 0.0, 1.0);
  fragColor = vec4(trail, 0.0, 0.0, 1.0);
}
`;

/**
 * The agar's state at half resolution: R food as the specks smell it (0..1: each flake's halo, flat
 * over its pool and falling off over uHalo texels beyond, the largest where they overlap; the M's
 * strokes), G salt, A light (the lit sea, and everything past the dish's glass wall), B feeding:
 * 1 in a flake's pool, 0.5 at its rim (specks feed above 0.5), then a fringe out to 2.6 radii that
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
uniform float uHalo;  // the food halo's fall-off beyond a flake's pool, trail texels
${gpuCommonGlsl}
void main() {
  vec2 p = vUv * uGrid;
  float scent = 0.0;
  float feed = 0.0;
  for (int i = 0; i < ${PHYSARUM_MAX_FOOD}; i++) {
    if (i >= uFoodCount) break;
    vec4 food = uFood[i];
    float dist = length(p - food.xy * uGrid);
    float pool = 1.0 - smoothstep(0.8 * food.z, 1.2 * food.z, dist);
    float fringe = 1.0 - smoothstep(1.2 * food.z, 2.6 * food.z, dist);
    feed = max(feed, food.w * 0.5 * (pool + fringe));
    scent = max(scent, food.w * clamp(1.0 - (dist - food.z) / uHalo, 0.0, 1.0));
  }
  if (uMark.w > 0.0 && uMark.z > 0.0) {
    float m = markDistance((p - uMark.xy * uGrid) / uMark.z) * uMark.z;
    scent = max(scent, uMark.w * ${glslFloat(MARK_SCENT)} * exp(-m * m / ${glslFloat(MARK_WIDTH * MARK_WIDTH)}));
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
  return 1.0 + ${glslFloat(COST_OFF)} * (1.0 - smoothstep(0.35, 0.6, texture(uView, at).r));
}
void main() {
  vec2 toHeart = (vUv - uHeart.xy) * uSize;
  if (uHeart.w > 0.5 && length(toHeart) < uHeart.z) {
    fragColor = vec4(length(toHeart * uStepH), 0.0, 0.0, 1.0);
    return;
  }
  float here = physarumCost(vUv);
  float best = ${glslFloat(PHYSARUM_FAR)};
  for (int k = 0; k < 8; k++) {
    vec2 o = PHYSARUM_RING[k] * uStride;
    vec2 at = vUv + o * uTexel;
    float cost = length(o * uStepH) * 0.5 * (here + physarumCost(at));
    best = min(best, texture(uDist, at).r + cost);
  }
  fragColor = vec4(min(best, ${glslFloat(PHYSARUM_FAR)}), 0.0, 0.0, 1.0);
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
  float gamma = clamp(log(${glslFloat(LACE_TONE)}) / log(clamp(ref.y, ${glslFloat(SHARE_MIN)}, ${glslFloat(SHARE_MAX)})), ${glslFloat(GAMMA_MIN)}, ${glslFloat(GAMMA_MAX)});
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
  float haze = ${glslFloat(FILAMENT_FLOOR)} * texelFetch(uRef, ivec2(0), 0).r;
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
  readonly #knobs: KnobReader<PhysarumKnob>;
  readonly #feedSlot: number;
  readonly #markSlot: number;
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
  readonly #film: RenderTarget;
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
  /** Prewarm steps taken since the last reset; the sim holds still until all PREWARM_STEPS are done. */
  #warmed = PREWARM_STEPS;
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

  constructor(gpu: GpuCompute, knobs: KnobReader<PhysarumKnob>) {
    this.#gpu = gpu;
    this.#knobs = knobs;
    this.#feedSlot = knobs.trigger("feeding");
    this.#markSlot = knobs.trigger("mark");
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
    this.#film = gpu.target({ ...field, format: "r16f" });
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
    this.#diffuse.bind({ uTrail: this.#trail, uEnv: this.#env, uFilm: this.#film, uRef: this.#level });
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
    const fired = frame.fired;
    if (fired[this.#markSlot] === true) this.#markUntil = frame.time + MARK_HOLD;
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
    if (fired[this.#feedSlot] === true) this.#food.constellation();
    this.#touch(frame.pointer, frame.aspect, settings.salt);
    if (this.#warmed < PREWARM_STEPS) {
      this.#warm();
      if (this.#warmed < PREWARM_STEPS) return this.#textures();
    }

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

    return this.#textures();
  }

  /** The flakes uploaded, with the textures the shader reads. */
  #textures(): readonly (WebGLTexture | undefined)[] {
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
    const seeds = sketchSeeds(settings.seed);
    const paths = sketchPaths(points, heart, grid, seaBlocked(this.#seaCover, grid, mark === undefined), seeds.web, seeds.rand);
    const sketch = stampSketch(paths, points, grid);
    const agents = seedAgents(this.#agents, paths, points, grid, seeds.rand);
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
    this.#film.seed(stampFilm(paths, grid));
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
    this.#warmed = 0;
  }

  /**
   * The prewarm: PREWARM_STEPS real steps (the first chunk short), the trunk level followed and the
   * distances relaxed after each chunk, GPU-synced; then the view crossed over from the sketch by as
   * much as the mould grew (all the way after SETTLE_STEPS). Steps are counted, so every machine runs
   * the same ones in the same order; a slow one only takes more frames (frame() holds still until
   * #warmed reaches PREWARM_STEPS).
   */
  #warm(): void {
    const gl = this.#gpu.gl;
    this.#warmed = runBudgeted(
      (i) => {
        this.#step();
        const done = i + 1;
        if ((done - PREWARM_FIRST) % PREWARM_CHUNK !== 0) return;
        this.#grown = done;
        this.#measure(0.3);
        this.#trace(1);
        gl.finish();
      },
      PREWARM_MS,
      PREWARM_STEPS,
      this.#warmed,
      PREWARM_CHUNK,
    );
    if (this.#warmed < PREWARM_STEPS) return;
    const settled = Math.min(1, this.#grown / SETTLE_STEPS);
    this.#show(settled, settled);
  }

  #resize(grid: Grid, keep: boolean): void {
    this.#grid = grid;
    this.#trail.resize(grid.width, grid.height, keep);
    this.#film.resize(grid.width, grid.height, keep);
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
    const { points, heart } = this.#food.sketchNodes(this.#grid);
    const seeds = sketchSeeds(this.#seed);
    const rand = mulberry32((Math.imul(count, 0x9e3779b1) ^ this.#stepCount) >>> 0);
    const paths = sketchPaths(points, heart, this.#grid, seaBlocked(this.#seaCover, this.#grid, this.#food.markSize === undefined), seeds.web, seeds.rand);
    this.#agents.seed(seedAgents(this.#agents, paths, points, this.#grid, rand).data);
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
    this.#diffuse.set({ uKeep: 1 - settings.loss, uFilmGain: FILM_GAIN * (1 - food.markShown) });
    this.#envPass.set({
      uGrid: this.#gridUniform,
      uFood: this.#foodUniform,
      uFoodCount: count,
      uMark: this.#markUniform,
      uLight: 1 - food.markShown,
      uDish: this.#dishUniform,
      uHalo: HALO_REACH * settings.reach,
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
}

/**
 * Without float render targets: the sketched network, still, with its streaming. Knob changes
 * (layout, dish, the M, the frame) sketch it afresh.
 */
class PhysarumStill implements SceneSim {
  readonly #knobs: KnobReader<PhysarumKnob>;
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

  constructor(gl: WebGL2RenderingContext, knobs: KnobReader<PhysarumKnob>) {
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
    const seeds = sketchSeeds(settings.seed);
    const paths = sketchPaths(points, heart, grid, seaBlocked(cover, grid, settings.mark === undefined), seeds.web, seeds.rand);
    const sketch = stampSketch(paths, points, grid);
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
  const knobs = new KnobReader<PhysarumKnob>("physarum", params, PHYSARUM_KNOBS);
  return (gl) => {
    const gpu = GpuCompute.create(gl);
    return gpu === undefined ? new PhysarumStill(gl, knobs) : new PhysarumSim(gpu, knobs);
  };
}
