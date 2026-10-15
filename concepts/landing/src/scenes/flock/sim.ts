// The murmuration: a few thousand starlings flown on the CPU, splatted into a density field the
// shader inks as the flock. By default the flock is authored (a choreographed sheet, below); with
// the `emergent` control on it flies as genuine topological boids instead (see "Emergent flight").
//
// Seen from the ground, a murmuration is a thin sheet of birds, a few deep and hundreds across,
// that bends, twists and folds as it sweeps over the sky. In projection most of it is a pale,
// translucent veil; it turns dark only where the sheet is edge-on to us or folds back over itself,
// its rim is sharp, and single birds show around it. So the authored flock is flown as such a sheet:
// - Every bird keeps a place on a disc (sheet coordinates a along the flock, b across it, both in
//   -1..1), laid out on a jittered sunflower spiral so the birds are evenly spread, never clumped.
// - The disc is carried through the sky in 3D: stretched into a ribbon and gathered again (its area
//   kept), bowed, cupped across its width, rippled by a bend wave running along it, banked about
//   its long axis with a twist along it, turned into depth, parted into two lobes joined by a few
//   strung-out birds and merged again, and seen with a little perspective. A banked, cupped sheet
//   folds back over itself along one rim; a twisted one goes edge-on across a neck. Every one of
//   these is a slow sum of sines with periods between 3 and 30 seconds, so the shape never stops
//   changing, never repeats exactly and never jumps. The flock roams the sky left over once it
//   fits in its band of sky (shrinking a little when it would not), so it never hugs an edge.
// - Turns travel through the flock (Attanasi et al. 2014, "Information transfer and behavioural
//   inertia in starling flocks", Nature Physics 10): a bird follows the sheet as it was a moment
//   ago, the later the nearer it is to the trailing end, so a turn starts at the head and sweeps
//   along the ribbon.
// - A few birds fly just outside the rim and a handful of stragglers trail a second or two behind:
//   the specks around a real flock.
// - Agitation waves (Procaccini et al. 2011, "Propagating waves in starling flocks under
//   predation", Animal Behaviour 82): a startle runs out over the sheet as a ring; the birds in it
//   roll (show more wing, so they read darker) and lift out of the sheet.
// - The falcon pushes the birds near it aside; each springs back to its place once it has passed.
// - The entrance and exit (FLOCK_PASSAGE) displace the birds only when the density is splatted: they
//   stream in head first from beyond a side edge and fold into the sheet, and at the end pour down
//   head first to roost behind the skyline. The flight itself runs on regardless.
//
// Emergent flight (the `emergent` control above 0, its value the neighbours each bird watches): the
// same birds fly as topological boids (sims/boids.ts: separation, cohesion and alignment with their
// K nearest found through a spatial hash, cruise speed, level flight, a roost) in a world of screen
// heights with z away from the eye. They hold a level plane seen from below at BOIDS_ELEVATION, so
// the flock flattens into a sheet a few birds deep, are pulled back inside the band of sky (the
// roost they wheel over), drift downwind, flee the falcon, and pass startles from bird to bird as a
// wave; nothing else steers them, so the flock's shape, its turns, its splits and its dark knots at
// a turn are its own. The knobs set the rules: cohesion the spacing and pull, chaos the noise and how
// weakly they align, speed the cruise. Drawing, the M, the falcon and the passage are shared with
// the sheet. Switching hands the birds over where they are: to the boids on the level plane flying
// along the sheet, back to the sheet with each bird pushed off its place by where it flew, so the
// falcon's spring brings it home.
//
// Time runs in fixed steps of STEP seconds of simulated time, so the flight depends only on the
// knobs and simulated time, not on the frame rate; positions are interpolated between the last two
// steps for drawing. Every array is allocated up front for the largest flock (the density field
// only grows on resize), so a frame allocates nothing.
//
// A scene flies the flock through a FlockSetup: which of its knobs drives each control (or a value
// that holds it fixed) and the band of sky the flock keeps to; the Murmuration scene's own knobs and
// sky are the default. With no birds (the control at 0, a switch that is off) the flock is idle: it
// steps nothing, paints nothing and hands the shader no textures, and grows afresh when birds return.
// `flockSim` hands the shader the two textures below; a scene that packs them into a texture of its
// own (the countryside's records atlas) flies a `Flock`, which keeps them as arrays.
//
// Textures:
//   uSim0  rg16f, about FIELD_PER_CELL texels per cell (at most FIELD_ROWS rows): R birds per texel
//          (a short exponential trail smooths their motion), G the same weighted by how hard the
//          birds roll. (Flock.field, fieldWidth × fieldHeight.)
//   uSim1  rgba16f 3×1, nearest: texel 0 falcon (uv xy, heading cos, sin); texel 1 falcon (shown,
//          wings open 0..1, wingbeat sin) and, in w, the birds per texel of a sheet at
//          REFERENCE_DENSITY; texel 2 Manifold M (strength 0..1, centre uv xy, height in screen
//          heights). (Flock.state.)
import { markVertex } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { Boids, boidRules } from "../../sims/boids.ts";
import { FixedStep } from "../../sims/clock.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";

/** The flock sizes on offer (the `birds` choice). */
export const FLOCK_SIZES = [1500, 3000, 5000] as const;
const MAX_BIRDS = Math.max(...FLOCK_SIZES);
/** Fixed seed: the flock is the same every time it is grown with the same size. */
const SEED = 0x5ca1ab1e;
const TAU = Math.PI * 2;

/** Simulated seconds per step; frames run as many whole steps as their (motion-scaled) time covers. */
const STEP = 1 / 60;
/** A long hitch drops time instead of catching up step by step. */
const MAX_STEPS = 4;
/** Seconds over which the flock follows a knob change, so turning a knob never makes it jump. */
const KNOB_EASE = 0.8;
/** Choreography seconds per second at speed 0 and 1. */
const RATE_SLOW = 0.55;
const RATE_FAST = 1.45;

// The sheet.
/** Face-on area of the sheet (screen heights²) at cohesion 1 and 0. */
const AREA_TIGHT = 0.055;
const AREA_LOOSE = 0.15;
/** Length over width at cohesion 1 and 0; the sheet stretches to about twice that and gathers to half. */
const ELONGATION_TIGHT = 1.7;
const ELONGATION_LOOSE = 3.6;
/** Half the sheet's depth (screen heights): a few birds deep. */
const THICKNESS = 0.012;
/**
 * Parting into two lobes: the gap opened along the sheet (sheet units), the width of the seam and
 * how it curves, how much the bridge of birds left between the lobes narrows, and how far the lobes
 * shear sideways (sheet widths) and bank apart (radians).
 */
const SPLIT_GAP = 0.5;
const SPLIT_SEAM = 0.09;
const SPLIT_CURVE = 0.35;
const SPLIT_PINCH = 0.55;
const SPLIT_SHEAR = 0.45;
const SPLIT_BANK = 0.5;
/** The bend wave running along the sheet: radians per sheet unit, and seconds per cycle. */
const BEND_WAVENUMBER = 3.4;
const BEND_PERIOD = 4.7;
/** Distance to the flock (screen heights): a little perspective. */
const DISTANCE = 2.2;
/** The Murmuration's band of sky (screen heights; FlockSetup.sky), and the margin from the frame's sides. */
const SKY_LOW = 0.28;
const SKY_HIGH = 0.95;
const SIDE_MARGIN = 0.1;

// The birds on the sheet.
/** Share of the birds flying just outside the rim, and how far out they go (sheet units). */
const RIM_SHARE = 0.035;
const RIM_REACH = 0.35;
/** Share of stragglers, and how far behind the flock they fly (s). */
const STRAY_SHARE = 0.006;
const STRAY_LAG_MIN = 0.8;
const STRAY_LAG_MAX = 2.4;
/** Seconds by which the trailing end of the sheet follows its head. */
const LAG_SPAN = 0.6;
/** Lags come in steps of this many seconds: the sheet's shape is worked out once per step of lag. */
const LAG_LEVEL = 1 / 30;
const LAG_LEVELS = Math.ceil(STRAY_LAG_MAX / LAG_LEVEL) + 1;
/** The sunflower layout's jitter, in bird spacings. */
const LAYOUT_JITTER = 0.6;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Each bird's own slow wobble about its place (sheet units), calm and restless. */
const JITTER_CALM = 0.01;
const JITTER_CHAOS = 0.02;

// The sheet's shape at one lag: SHAPE floats per lag level (see #shapeAt).
const SH_X = 0;
const SH_Y = 1;
const SH_HEADING_COS = 2;
const SH_HEADING_SIN = 3;
const SH_YAW_COS = 4;
const SH_YAW_SIN = 5;
const SH_BANK = 6;
const SH_TWIST = 7;
const SH_LENGTH = 8;
const SH_WIDTH = 9;
const SH_SPLIT = 10;
const SH_BEND = 11;
const SH_BEND_PHASE = 12;
const SH_CUP = 13;
const SH_CURL = 14;
const SH_FIT = 15;
const SHAPE = 16;

// Agitation waves: rings running out over the sheet.
/** Waves at once, front speed (screen heights/s), front width (heights), life (s), lift out of the sheet (heights). */
const WAVES = 3;
const WAVE_SPEED = 0.45;
const WAVE_WIDTH = 0.03;
const WAVE_LIFE = 2.4;
const WAVE_LIFT = 0.012;
/** Spontaneous waves per second, calm and restless, with no falcon in sight. */
const STARTLE_CALM = 0.015;
const STARTLE_CHAOS = 0.12;

// The falcon.
const FALCON_STOOP = 0.75;
const FALCON_CRUISE = 0.5;
/** Pursuit and pull-out turn rates (rad/s). */
const FALCON_TURN = 2.2;
const FALCON_CLIMB = 1.6;
/** Birds within FEAR (heights) are pushed aside, up to FLEE heights/s² right at the falcon. */
const FEAR_RADIUS = 0.11;
const FLEE = 5;
/** The spring that brings a pushed bird back to its place: natural frequency (rad/s) and damping ratio. */
const SPRING = 3;
const SPRING_DAMPING = 0.9;
/** Wingbeats per second once the falcon pulls out of its dive. */
const FALCON_WINGBEAT = 4.5;
/** Seconds between attacks at frequency 0 and 1 (randomised ±40%). */
const ATTACK_RARE = 75;
const ATTACK_OFTEN = 15;

// The Manifold M: the flock streams along a racetrack around the M's strokes.
/** The mark's height in screen heights. */
const MARK_SIZE = 0.38;
/**
 * Seconds: birds set off for the M over STAGGER, head first, each taking FLY to reach it; they let
 * go from HOLD in the same order, so the M is over at END.
 */
const MARK_STAGGER = 0.8;
const MARK_FLY = 1.1;
const MARK_GATHER = MARK_STAGGER + MARK_FLY;
const MARK_HOLD = 5.6;
const MARK_END = MARK_HOLD + MARK_STAGGER + MARK_FLY;
/** How fast the birds stream along the track (screen heights/s) at speed 0 and 1. */
const MARK_STREAM_SLOW = 0.03;
const MARK_STREAM_FAST = 0.095;
/** Seconds between formations at frequency 0 and 1, and the delay after switching it on. */
const MARK_RARE = 150;
const MARK_OFTEN = 40;
const MARK_FIRST = 4;
/** Columns for the left-to-right ordering that hands out places on the M. */
const MARK_BINS = 128;
/** Lanes either side of a stroke, in mark units: out along one side, back along the other. */
const MARK_LANE = 0.025;
/** How far the birds of a lane spread across it (mark units). */
const MARK_SCATTER = 0.025;

// Emergent flight (the `emergent` knob): the same birds flown as topological boids (sims/boids.ts).
/** The boids' world is the screen's (heights) with z away from the eye; its level plane is seen from below at this slant (rad). */
const BOIDS_ELEVATION = 0.6;
/** Spacing of a flock of BOIDS_REFERENCE_BIRDS at cohesion 0 and 1 (heights); it scales as the cube root of their share. */
const BOIDS_SPACING_LOOSE = 0.019;
const BOIDS_SPACING_TIGHT = 0.011;
const BOIDS_REFERENCE_BIRDS = 3000;
/** Steps a bird keeps the neighbours it found (a third of the flock searches each step). */
const BOIDS_REFRESH = 3;
/** Steering (see BoidRules): separation (heights/s²), cohesion at cohesion 0 and 1 (1/s²), alignment calm and restless (1/s). */
const BOIDS_SEPARATION = 1.2;
const BOIDS_COHESION_LOOSE = 3;
const BOIDS_COHESION_TIGHT = 9;
const BOIDS_ALIGN_CALM = 3;
const BOIDS_ALIGN_CHAOS = 1.2;
/** Each bird's random kicks (heights/s^1.5), calm and restless. */
const BOIDS_NOISE_CALM = 0.01;
const BOIDS_NOISE_CHAOS = 0.05;
/** Cruise speed (heights per second of choreography rate) and how fast a bird returns to it (1/s). */
const BOIDS_CRUISE = 0.13;
const BOIDS_SPEED_HOLD = 1.5;
const BOIDS_MAX_ACCEL = 1.5;
/** Level flight (natural frequency, 1/s), the pull back into the band of sky (1/s²), and its depth either way (heights). */
const BOIDS_LEVEL = 1.2;
const BOIDS_HOME_PULL = 2;
const BOIDS_DEPTH = 0.35;
/** How far the home keeps the birds in from the band's sides and from its top and bottom (heights). */
const BOIDS_INSET_X = 0.22;
const BOIDS_INSET_Y = 0.12;
/** Downwind drift at wind 1 (heights/s); the home holds the flock against it. */
const BOIDS_WIND = 0.04;
/** Flight from the falcon (heights/s²), and the startle relay: seconds to pass on, startled, before it can come again. */
const BOIDS_FLEE = 6;
const BOIDS_RELAY = 0.035;
const BOIDS_STARTLED = 0.4;
const BOIDS_REFRACTORY = 1.6;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the flock streams in
 * from beyond the nearer side edge, head first, in a loose file that folds into its sheet as the
 * birds slow. Exit: it pours down head first, funnelling together, to roost below the horizon, where
 * the skyline hides it. Both are worked out when the density is splatted, so they follow the frame
 * clock smoothly; at rest (enter 1, exit 0) the birds are exactly where the flight puts them.
 */
export const FLOCK_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };
/**
 * Entrance, as shares of its progress: a bird sets off after LEAD plus STAGGER × how far back it
 * flies in the sheet plus up to SCATTER of its own, and takes FLIGHT to arrive (they add up to 1).
 * It starts BEYOND the edge plus up to DEPTH (heights) out, in a file about SPREAD tall following
 * the sheet's height; the file sways by SWAY (heights) with SWAY_WAVE radians per height.
 */
const ENTER_LEAD = 0.04;
const ENTER_STAGGER = 0.26;
const ENTER_SCATTER = 0.08;
const ENTER_FLIGHT = 0.62;
const ENTER_BEYOND = 0.06;
const ENTER_DEPTH = 0.4;
const ENTER_SPREAD = 0.05;
const ENTER_SWAY = 0.07;
const ENTER_SWAY_WAVE = 4;
/**
 * Exit, same shares: the birds fall FALL of it, accelerating, down to a roost between ROOST_LOW and
 * ROOST_LOW + ROOST_SPREAD (heights, under the horizon), closing to FUNNEL of their width about the
 * flock's centre and swooping SWOOP (heights) along its heading on the way.
 */
const EXIT_STAGGER = 0.28;
const EXIT_SCATTER = 0.1;
const EXIT_FALL = 0.62;
const EXIT_POWER = 1.7;
const EXIT_ROOST_LOW = 0.02;
const EXIT_ROOST_SPREAD = 0.05;
const EXIT_FUNNEL = 0.35;
const EXIT_SWOOP = 0.08;

/** A sheet of birds at this density (birds per screen height²) seen face-on is the shader's reference grey. */
const REFERENCE_DENSITY = 30000;
/** Density texels per dither cell, and the most rows the field gets. */
const FIELD_PER_CELL = 0.8;
const FIELD_ROWS = 240;
/** Exponential trail of the density field (s): softens the specks' motion into short streaks. */
const TRAIL = 0.03;

/**
 * The racetrack the birds stream along while they draw the M: up the strokes on one side and back
 * down on the other, each lane offset to the right of its direction of travel so the two streams
 * never meet head-on. Six floats per segment: start xy, end xy, arclength at its start, length.
 */
const MARK_TRACK = (() => {
  const route = [0, 1, 2, 3, 4, 3, 2, 1, 0];
  const track = new Float32Array((route.length - 1) * 6);
  let along = 0;
  for (let k = 0; k + 1 < route.length; k++) {
    const [ax, ay] = markVertex(route[k] ?? 0);
    const [bx, by] = markVertex(route[k + 1] ?? 0);
    const length = Math.hypot(bx - ax, by - ay);
    const rx = ((by - ay) / length) * MARK_LANE;
    const ry = (-(bx - ax) / length) * MARK_LANE;
    track.set([ax + rx, ay + ry, bx + rx, by + ry, along, length], k * 6);
    along += length;
  }
  return track;
})();
const MARK_TRACK_LENGTH =
  (MARK_TRACK[MARK_TRACK.length - 2] ?? 0) + (MARK_TRACK[MARK_TRACK.length - 1] ?? 0);
const MARK_OUTWARD_LENGTH = MARK_TRACK_LENGTH / 2;

type KnobKey = "birds" | "cohesion" | "chaos" | "speed" | "predator" | "wind" | "mark" | "emergent";

/**
 * How a scene flies the flock: for each control, the key of the scene knob that drives it (as the
 * shader reads it) or a number that holds it there (a fixed control never fires a "now" press); and
 * the band of sky the flock keeps to, in screen heights from the bottom of the frame. `emergent` may
 * be left out: the flock then always flies its authored sheet; above 0, it flies as boids watching
 * that many neighbours.
 */
export interface FlockSetup {
  readonly knobs: Readonly<
    Record<Exclude<KnobKey, "emergent">, string | number> & { emergent?: string | number }
  >;
  readonly sky: Readonly<{ low: number; high: number }>;
}

/** The Murmuration scene: every control a knob of its own name, the sky above its skyline. */
const MURMURATION: FlockSetup = {
  knobs: {
    birds: "birds",
    cohesion: "cohesion",
    chaos: "chaos",
    speed: "speed",
    predator: "predator",
    wind: "wind",
    mark: "mark",
    emergent: "emergent",
  },
  sky: { low: SKY_LOW, high: SKY_HIGH },
};

/** What an idle flock hands the renderer: no textures. */
const IDLE: readonly (WebGLTexture | undefined)[] = [];

/** One slow swing of the choreography: a sine of the clock with the given period (s) and phase. */
const swing = (clock: number, period: number, phase: number): number =>
  Math.sin((clock / period) * TAU + phase);

/**
 * The flock without textures (see the header): flown and painted each frame into `field` and
 * `state`, the two textures' data, for a scene that uploads them itself.
 */
export class Flock {
  readonly #stateData = new Float32Array(12);
  readonly #setup: FlockSetup;
  readonly #knobs: KnobReader<string>;
  readonly #attackSlot: number;
  readonly #markSlot: number;
  readonly #knob: Record<KnobKey, number> = {
    birds: 3000,
    cohesion: 0.55,
    chaos: 0.35,
    speed: 0.5,
    predator: 0,
    wind: 0,
    mark: 0,
    emergent: 0,
  };
  readonly #random = new Random();
  // Emergent flight: the birds as boids, the rules the knobs set for them, and their noise.
  readonly #boids = new Boids(MAX_BIRDS);
  readonly #rules = boidRules();
  readonly #boidRandom = new Random();

  // Fixed per bird: its place on the sheet (a along, b across, depth through it, -1..1), its lag
  // level, weight, slow wobble, and place on the M's racetrack (mark units of arclength).
  readonly #sheetA = new Float32Array(MAX_BIRDS);
  readonly #sheetB = new Float32Array(MAX_BIRDS);
  readonly #depth = new Float32Array(MAX_BIRDS);
  readonly #lag = new Uint8Array(MAX_BIRDS);
  readonly #weight = new Float32Array(MAX_BIRDS);
  readonly #phaseA = new Float32Array(MAX_BIRDS);
  readonly #phaseB = new Float32Array(MAX_BIRDS);
  readonly #rateA = new Float32Array(MAX_BIRDS);
  readonly #rateB = new Float32Array(MAX_BIRDS);
  readonly #markPlace = new Float32Array(MAX_BIRDS);
  // Per bird: position at the latest step and the one before (swapped each step), the falcon's
  // push and its velocity, how much ink the bird puts down (bigger when nearer), and its roll.
  #x = new Float32Array(MAX_BIRDS);
  #y = new Float32Array(MAX_BIRDS);
  #x2 = new Float32Array(MAX_BIRDS);
  #y2 = new Float32Array(MAX_BIRDS);
  readonly #pushX = new Float32Array(MAX_BIRDS);
  readonly #pushY = new Float32Array(MAX_BIRDS);
  readonly #pushVX = new Float32Array(MAX_BIRDS);
  readonly #pushVY = new Float32Array(MAX_BIRDS);
  readonly #ink = new Float32Array(MAX_BIRDS);
  readonly #roll = new Float32Array(MAX_BIRDS);
  #n = 0;

  /** The sheet's shape at every lag level, SHAPE floats each. */
  readonly #shapes = new Float64Array(LAG_LEVELS * SHAPE);
  /** Agitation waves: where on the sheet each started, and its age (WAVE_LIFE or more: idle). */
  readonly #waveA = new Float64Array(WAVES);
  readonly #waveB = new Float64Array(WAVES);
  readonly #waveAge = new Float64Array(WAVES).fill(WAVE_LIFE);

  readonly #binStart = new Int32Array(MARK_BINS + 1);
  readonly #binCursor = new Int32Array(MARK_BINS);
  readonly #trackPoint = new Float32Array(4);

  // Density field (rg, rows bottom to top).
  #field = new Float32Array(2);
  #fieldW = 0;
  #fieldH = 0;

  #aspect = 16 / 9;
  #time = 0;
  readonly #steps = new FixedStep(STEP, MAX_STEPS);
  #dirty = true;
  #centreX = 0;
  #centreY = 0;
  // The knobs as the flock follows them, and the choreography's own clock (it runs at the speed knob).
  #chaos = 0;
  #cohesion = 0;
  #wind = 0;
  #rate = 1;
  #clock = 0;

  #attackNow = false;
  #markNow = false;

  #falcon = false;
  #falconX = 0;
  #falconY = 0;
  #falconPrevX = 0;
  #falconPrevY = 0;
  #falconVX = 0;
  #falconVY = 0;
  #falconAge = 0;
  #falconStoop = false;
  #falconPrey = 0;
  #wingOpen = 0;
  #wingbeat = 0;
  #nextAttack = Number.POSITIVE_INFINITY;

  #mark = false;
  #markAge = 0;
  #markRun = 0;
  #markX = 0;
  #markY = 0;
  #markStrength = 0;
  #nextMark = Number.POSITIVE_INFINITY;

  // How far the passage has come (see FLOCK_PASSAGE), and the side edge the flock enters from (-1 left, 1 right).
  #enter = 1;
  #exit = 0;
  #entrySide = 1;
  // Flying as boids (else the sheet); the sheet taking the birds back from wherever the boids left
  // them on its next step; the boids' mean heading across the screen (cos); a pulled bird's place.
  #flying = false;
  #catchUp = false;
  #headingX = 1;
  readonly #pulled = new Float64Array(2);
  /** The latest frame repainted the field and the state. */
  #painted = false;

  constructor(params: readonly ParamDef[], setup: FlockSetup) {
    this.#setup = setup;
    const keys = Object.values(setup.knobs).filter(
      (source): source is string => typeof source === "string",
    );
    this.#knobs = new KnobReader<string>("flock", params, keys);
    this.#attackSlot = this.#triggerOf("predator");
    this.#markSlot = this.#triggerOf("mark");
    // The boids' rules the knobs leave alone (#flyBoids sets the rest every step).
    const rules = this.#rules;
    rules.refresh = BOIDS_REFRESH;
    rules.separation = BOIDS_SEPARATION;
    rules.speedHold = BOIDS_SPEED_HOLD;
    rules.maxAccel = BOIDS_MAX_ACCEL;
    rules.level = BOIDS_LEVEL;
    rules.up.x = 0;
    rules.up.y = Math.cos(BOIDS_ELEVATION);
    rules.up.z = Math.sin(BOIDS_ELEVATION);
    rules.home.z = 0;
    rules.reach.z = BOIDS_DEPTH;
    rules.homePull = BOIDS_HOME_PULL;
    rules.flee = BOIDS_FLEE;
    rules.relay = BOIDS_RELAY;
    rules.startled = BOIDS_STARTLED;
    rules.refractory = BOIDS_REFRACTORY;
  }

  /** The birds per texel and their roll (rg), fieldWidth × fieldHeight texels, rows bottom to top. */
  get field(): Float32Array {
    return this.#field;
  }

  get fieldWidth(): number {
    return this.#fieldW;
  }

  get fieldHeight(): number {
    return this.#fieldH;
  }

  /** The state texels: falcon, falcon and reference density, M (3 × rgba). */
  get state(): Float32Array {
    return this.#stateData;
  }

  /** Whether the latest frame repainted `field` and `state` (they then need uploading). */
  get painted(): boolean {
    return this.#painted;
  }

  /** Flies the flock for this frame; false while it is idle (no birds), when it paints nothing. */
  frame(frame: SimFrame): boolean {
    const knob = this.#knob;
    knob.birds = this.#read(frame, "birds");
    this.#painted = false;
    // No birds: idle, and grow a fresh flock when they return.
    if (knob.birds < 1) {
      this.#n = 0;
      return false;
    }
    knob.cohesion = this.#read(frame, "cohesion");
    knob.chaos = this.#read(frame, "chaos");
    knob.speed = this.#read(frame, "speed");
    knob.predator = this.#read(frame, "predator");
    knob.wind = this.#read(frame, "wind");
    knob.mark = this.#read(frame, "mark");
    knob.emergent = this.#read(frame, "emergent");
    if (frame.aspect > 0) this.#aspect = frame.aspect;
    this.#fitField(frame.width, frame.height);
    const n = Math.min(MAX_BIRDS, Math.max(1, Math.round(knob.birds)));
    if (n !== this.#n) this.#reset(n);
    // Switching flight hands the birds over where they are, so the flock never jumps.
    const emergent = knob.emergent > 0;
    if (emergent !== this.#flying) {
      if (emergent) this.#toBoids();
      else this.#toSheet();
    }
    // The "now" buttons: one frame of `fired` after a press (a fixed control has no slot: -1).
    if (frame.fired[this.#attackSlot]) this.#attackNow = true;
    if (frame.fired[this.#markSlot]) this.#markNow = true;

    // Motion scales the flight; an event fired with "now" plays even while motion is 0, and so does
    // the entrance and the exit.
    this.#enter = clamp(frame.passage.enter, 0, 1);
    this.#exit = clamp(frame.passage.exit, 0, 1);
    const passing = this.#enter < 1 || this.#exit > 0;
    const busy = this.#falcon || this.#mark || this.#attackNow || this.#markNow || passing;
    const advance = Math.max(0, frame.dt) * Math.max(frame.motion, busy ? 1 : 0);
    const steps = this.#steps.advance(advance);
    for (let i = 0; i < steps; i++) this.#step();
    if (advance > 0 || this.#dirty) {
      this.#paint(this.#dirty ? 0 : Math.exp(-advance / TRAIL), this.#steps.alpha);
      this.#painted = true;
      this.#dirty = false;
    }
    return true;
  }

  /** A control as the shader reads its knob, or its fixed value (0 for a control the setup leaves out). */
  #read(frame: SimFrame, control: KnobKey): number {
    const source = this.#setup.knobs[control];
    return typeof source === "string" ? this.#knobs.value(frame, source) : (source ?? 0);
  }

  /** The trigger slot of a control's knob ("now"); -1, which never fires, for a fixed control. */
  #triggerOf(control: KnobKey): number {
    const source = this.#setup.knobs[control];
    return typeof source === "string" ? this.#knobs.trigger(source) : -1;
  }

  #fitField(width: number, height: number): void {
    const h = Math.max(8, Math.min(FIELD_ROWS, Math.round(height * FIELD_PER_CELL)));
    const w = Math.max(8, Math.round((h * width) / Math.max(1, height)));
    if (w === this.#fieldW && h === this.#fieldH) return;
    this.#fieldW = w;
    this.#fieldH = h;
    this.#field = new Float32Array(w * h * 2);
    this.#dirty = true;
  }

  /**
   * Grow a fresh flock of n birds: lay them out on the sheet and place them on its first shape, from
   * where emergent flight takes them over (frame).
   */
  #reset(n: number): void {
    const random = this.#random;
    random.seed(SEED + n);
    const knob = this.#knob;
    this.#n = n;
    this.#time = 0;
    this.#clock = 0;
    this.#steps.reset();
    this.#chaos = knob.chaos;
    this.#cohesion = knob.cohesion;
    this.#wind = knob.wind;
    this.#rate = RATE_SLOW + (RATE_FAST - RATE_SLOW) * knob.speed;
    this.#falcon = false;
    this.#mark = false;
    this.#markStrength = 0;
    this.#attackNow = false;
    this.#markNow = false;
    this.#nextAttack = Number.POSITIVE_INFINITY;
    this.#nextMark = Number.POSITIVE_INFINITY;
    this.#waveAge.fill(WAVE_LIFE);
    this.#flying = false;
    this.#catchUp = false;

    const rim = Math.round(n * RIM_SHARE);
    const strays = Math.round(n * STRAY_SHARE);
    const body = Math.max(1, n - rim - strays);
    const spacing = Math.sqrt(Math.PI / body);
    for (let i = 0; i < n; i++) {
      let a: number;
      let b: number;
      let lag: number;
      if (i < body) {
        // A jittered sunflower spiral spreads the body evenly over the disc.
        const r = Math.sqrt((i + 0.5) / body);
        const angle = i * GOLDEN_ANGLE;
        a = r * Math.cos(angle) + (random.next() - 0.5) * LAYOUT_JITTER * spacing;
        b = r * Math.sin(angle) + (random.next() - 0.5) * LAYOUT_JITTER * spacing;
        lag = 0.5 * LAG_SPAN * (1 - clamp(a, -1, 1));
      } else {
        // Outside the rim, thinning outward; stragglers anywhere, well behind.
        const stray = i >= body + rim;
        const r = stray ? 1.2 * Math.sqrt(random.next()) : 1 + RIM_REACH * random.next() ** 2;
        const angle = random.next() * TAU;
        a = r * Math.cos(angle);
        b = r * Math.sin(angle);
        lag = stray
          ? STRAY_LAG_MIN + (STRAY_LAG_MAX - STRAY_LAG_MIN) * random.next()
          : 0.5 * LAG_SPAN * (1 - clamp(a, -1, 1)) + 0.15 * random.next();
      }
      this.#sheetA[i] = a;
      this.#sheetB[i] = b;
      this.#lag[i] = Math.min(LAG_LEVELS - 1, Math.round(lag / LAG_LEVEL));
      this.#depth[i] = random.next() * 2 - 1;
      // Some birds are bigger or nearer than others: their specks are darker.
      this.#weight[i] = 0.75 + 0.5 * random.next();
      this.#phaseA[i] = random.next() * TAU;
      this.#phaseB[i] = random.next() * TAU;
      this.#rateA[i] = 0.5 + 0.9 * random.next();
      this.#rateB[i] = 0.5 + 0.9 * random.next();
      this.#pushX[i] = 0;
      this.#pushY[i] = 0;
      this.#pushVX[i] = 0;
      this.#pushVY[i] = 0;
    }
    this.#step();
    this.#entrySide = this.#centreX < this.#aspect / 2 ? -1 : 1;
    this.#x2.set(this.#x);
    this.#y2.set(this.#y);
    this.#dirty = true;
  }

  /**
   * The sheet's shape at choreography time `clock`, written to #shapes at `at`. Lengths are in
   * screen heights, already shrunk by the fit; the bend, cup and curl are their full displacements.
   */
  #shapeAt(clock: number, at: number): void {
    const shapes = this.#shapes;
    const chaos = this.#chaos;
    const loose = 1 - this.#cohesion;
    const aspect = this.#aspect;
    // It stretches into a ribbon and gathers again, keeping its area (and breathing a little).
    const area =
      (AREA_TIGHT + (AREA_LOOSE - AREA_TIGHT) * loose) * (1 + 0.1 * swing(clock, 8.1, 0.6));
    const elongation =
      (ELONGATION_TIGHT + (ELONGATION_LOOSE - ELONGATION_TIGHT) * loose) *
      Math.exp(0.55 * swing(clock, 10.3, 2.2) + 0.2 * swing(clock, 4.3, 0.9));
    const length = Math.sqrt((area * elongation) / Math.PI);
    const width = Math.sqrt(area / (Math.PI * elongation));
    // Every quarter minute it parts into two lobes for a few seconds, readily when loose or restless.
    const split =
      smoothstep(0.2, 0.85, swing(clock, 15, -3.04)) *
      Math.min(1, 0.45 + 0.7 * loose + 0.3 * chaos);
    // Banked about its long axis and twisted along it: where it turns edge-on it reads dark.
    const bank = 0.6 + (0.4 + 0.25 * chaos) * swing(clock, 13, 0.3) + 0.2 * swing(clock, 5.3, 4.1);
    const twist = (0.55 + 1.1 * chaos) * swing(clock, 11, 1.9) + 0.2 * swing(clock, 4.7, 0.5);
    // Its length turns into depth and back.
    const yaw = (0.45 + 0.35 * chaos) * swing(clock, 16.5, 5) + 0.18 * swing(clock, 6.1, 2.6);
    // A bend wave runs along it; it cups across its width (banked, one rim folds back over itself)
    // and bows in its own plane.
    const bend = (0.1 + 0.3 * chaos) * (0.75 + 0.25 * swing(clock, 8.9, 1.2));
    const cup = (0.6 + 0.9 * chaos) * (0.75 + 0.25 * swing(clock, 14.3, 0.8));
    const curl = 0.28 * swing(clock, 12.5, 3.7) + 0.12 * swing(clock, 5.9, 0.2);
    // Which way its long axis lies on screen.
    const heading =
      0.45 * swing(clock, 17, 1.1) + 0.22 * swing(clock, 6.7, 3.3) + 0.08 * swing(clock, 3.1, 5.2);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const cosHeading = Math.cos(heading);
    const sinHeading = Math.sin(heading);

    // Fit it into its band of sky (its outline is about an ellipse with these half-axes), then let it
    // roam the room left over.
    const along = length * (1 + SPLIT_GAP * split);
    const across =
      width * (1 + SPLIT_SHEAR * split + cup) + (0.67 * Math.abs(curl) + bend) * length + THICKNESS;
    const seen = Math.hypot(along * cosYaw, across * sinYaw);
    const reachX = 1.1 * Math.hypot(seen * cosHeading, across * sinHeading);
    const reachY = 1.1 * Math.hypot(seen * sinHeading, across * cosHeading);
    const roomX = Math.max(0.05, aspect / 2 - SIDE_MARGIN);
    const sky = this.#setup.sky;
    const roomY = (sky.high - sky.low) / 2;
    const fit = Math.min(1, roomX / reachX, roomY / reachY);
    const wind = this.#wind;
    const roamX =
      (0.7 * swing(clock, 27, 2.5) + 0.3 * swing(clock, 9.7, 0.4) + 0.45 * wind) /
      (1 + 0.45 * Math.abs(wind));
    const roamY = 0.6 * swing(clock, 19, 4.4) + 0.4 * swing(clock, 7.3, 1.5);

    shapes[at + SH_X] = aspect / 2 + Math.max(0, roomX - reachX * fit) * roamX;
    shapes[at + SH_Y] = (sky.low + sky.high) / 2 + Math.max(0, roomY - reachY * fit) * roamY;
    shapes[at + SH_HEADING_COS] = cosHeading;
    shapes[at + SH_HEADING_SIN] = sinHeading;
    shapes[at + SH_YAW_COS] = cosYaw;
    shapes[at + SH_YAW_SIN] = sinYaw;
    shapes[at + SH_BANK] = bank;
    shapes[at + SH_TWIST] = twist;
    shapes[at + SH_LENGTH] = length * fit;
    shapes[at + SH_WIDTH] = width * fit;
    shapes[at + SH_SPLIT] = split;
    shapes[at + SH_BEND] = bend * length * fit;
    shapes[at + SH_BEND_PHASE] = (clock / BEND_PERIOD) * TAU;
    shapes[at + SH_CUP] = cup * width * fit;
    shapes[at + SH_CURL] = curl * length * fit;
    shapes[at + SH_FIT] = fit;
  }

  /** One fixed step of simulated time. */
  #step(): void {
    const knob = this.#knob;
    this.#time += STEP;
    const t = this.#time;
    // The flock follows the knobs over a moment, so turning one reshapes it smoothly.
    const ease = 1 - Math.exp(-STEP / KNOB_EASE);
    this.#chaos += (knob.chaos - this.#chaos) * ease;
    this.#cohesion += (knob.cohesion - this.#cohesion) * ease;
    this.#wind += (knob.wind - this.#wind) * ease;
    this.#rate += (RATE_SLOW + (RATE_FAST - RATE_SLOW) * knob.speed - this.#rate) * ease;
    this.#clock += STEP * this.#rate;
    for (let k = 0; k < LAG_LEVELS; k++)
      this.#shapeAt(this.#clock - k * LAG_LEVEL * this.#rate, k * SHAPE);
    this.#events(t);
    this.#fidget();
    const waveAge = this.#waveAge;
    for (let k = 0; k < WAVES; k++) waveAge[k] = (waveAge[k] ?? WAVE_LIFE) + STEP;
    if (this.#flying) this.#flyBoids();
    else this.#flySheet(t);
  }

  /** The authored flight: every bird to its place on the sheet's shapes, pushed by the falcon, pulled to the M. */
  #flySheet(t: number): void {
    const n = this.#n;
    const waveA = this.#waveA;
    const waveB = this.#waveB;
    const waveAge = this.#waveAge;
    const shapes = this.#shapes;
    const jitter = JITTER_CALM + (JITTER_CHAOS - JITTER_CALM) * this.#chaos;
    const springK = SPRING * SPRING;
    const springC = 2 * SPRING_DAMPING * SPRING;
    const falcon = this.#falcon;
    const fx = this.#falconX;
    const fy = this.#falconY;
    const mark = this.#mark;
    const pulled = this.#pulled;
    const catchUp = this.#catchUp;
    this.#catchUp = false;

    const sheetA = this.#sheetA;
    const sheetB = this.#sheetB;
    const depth = this.#depth;
    const lag = this.#lag;
    const weight = this.#weight;
    const phaseA = this.#phaseA;
    const phaseB = this.#phaseB;
    const rateA = this.#rateA;
    const rateB = this.#rateB;
    const pushX = this.#pushX;
    const pushY = this.#pushY;
    const pushVX = this.#pushVX;
    const pushVY = this.#pushVY;
    const ink = this.#ink;
    const roll = this.#roll;
    const cx = this.#x;
    const cy = this.#y;
    const nx = this.#x2;
    const ny = this.#y2;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
      const o = (lag[i] ?? 0) * SHAPE;
      const length = shapes[o + SH_LENGTH] ?? 0;
      const width = shapes[o + SH_WIDTH] ?? 0;
      const split = shapes[o + SH_SPLIT] ?? 0;
      const fit = shapes[o + SH_FIT] ?? 1;
      // The bird's place on the sheet, wobbling a little.
      const a = (sheetA[i] ?? 0) + jitter * Math.sin((rateA[i] ?? 1) * t + (phaseA[i] ?? 0));
      const b = (sheetB[i] ?? 0) + jitter * Math.sin((rateB[i] ?? 1) * t + (phaseB[i] ?? 0));

      // Agitation: how hard a passing ring has startled the bird.
      let startle = 0;
      for (let k = 0; k < WAVES; k++) {
        const age = waveAge[k] ?? WAVE_LIFE;
        if (age >= WAVE_LIFE) continue;
        const da = (a - (waveA[k] ?? 0)) * length;
        const db = (b - (waveB[k] ?? 0)) * width;
        const front = (Math.sqrt(da * da + db * db) - WAVE_SPEED * age) / WAVE_WIDTH;
        if (front * front < 9)
          startle = Math.max(
            startle,
            Math.exp(-front * front) * (1 - smoothstep(0.6 * WAVE_LIFE, WAVE_LIFE, age)),
          );
      }

      // On the sheet: parted across a curved seam (the birds near it string out into a sparse
      // bridge between the lobes), bowed in its plane, bent, cupped, and a few birds deep.
      const seam = Math.tanh((a - SPLIT_CURVE * b * b) / SPLIT_SEAM);
      const u = length * (a + SPLIT_GAP * split * seam);
      const v =
        width * (b * (1 - SPLIT_PINCH * split * (1 - seam * seam)) + SPLIT_SHEAR * split * seam) +
        (shapes[o + SH_CURL] ?? 0) * (a * a - 1 / 3);
      const w =
        (shapes[o + SH_BEND] ?? 0) *
          Math.sin(BEND_WAVENUMBER * a - (shapes[o + SH_BEND_PHASE] ?? 0)) +
        (shapes[o + SH_CUP] ?? 0) * (b * b - 1 / 3) +
        ((depth[i] ?? 0) * THICKNESS + startle * WAVE_LIFT) * fit;
      // Banked about the long axis (twisting along it, the lobes apart), then turned into depth.
      const bank =
        (shapes[o + SH_BANK] ?? 0) + (shapes[o + SH_TWIST] ?? 0) * a + SPLIT_BANK * split * seam;
      const cosBank = Math.cos(bank);
      const sinBank = Math.sin(bank);
      const y1 = v * cosBank - w * sinBank;
      const z1 = v * sinBank + w * cosBank;
      const cosYaw = shapes[o + SH_YAW_COS] ?? 1;
      const sinYaw = shapes[o + SH_YAW_SIN] ?? 0;
      const x2 = u * cosYaw + z1 * sinYaw;
      const near = DISTANCE / (DISTANCE + z1 * cosYaw - u * sinYaw);
      // Laid on the screen along the heading, around the flock's centre.
      const cosHeading = shapes[o + SH_HEADING_COS] ?? 1;
      const sinHeading = shapes[o + SH_HEADING_SIN] ?? 0;
      let px = (shapes[o + SH_X] ?? 0) + (x2 * cosHeading - y1 * sinHeading) * near;
      let py = (shapes[o + SH_Y] ?? 0) + (x2 * sinHeading + y1 * cosHeading) * near;

      // The falcon pushes the bird aside; a spring brings it back to its place. Taken back from the
      // boids, a bird starts pushed off to where it flew, at the speed it flew, and springs home.
      let ox = pushX[i] ?? 0;
      let oy = pushY[i] ?? 0;
      let vx = pushVX[i] ?? 0;
      let vy = pushVY[i] ?? 0;
      if (catchUp) {
        ox = (cx[i] ?? 0) - px;
        oy = (cy[i] ?? 0) - py;
        vx = ((cx[i] ?? 0) - (nx[i] ?? 0)) / STEP;
        vy = ((cy[i] ?? 0) - (ny[i] ?? 0)) / STEP;
      }
      let ax = -springK * ox - springC * vx;
      let ay = -springK * oy - springC * vy;
      let panic = 0;
      if (falcon) {
        const dx = px + ox - fx;
        const dy = py + oy - fy;
        const d = Math.hypot(dx, dy) + 1e-6;
        if (d < FEAR_RADIUS) {
          panic = 1 - d / FEAR_RADIUS;
          const flee = (FLEE * panic * panic) / d;
          ax += dx * flee;
          ay += dy * flee;
        }
      }
      vx += ax * STEP;
      vy += ay * STEP;
      ox += vx * STEP;
      oy += vy * STEP;
      pushX[i] = ox;
      pushY[i] = oy;
      pushVX[i] = vx;
      pushVY[i] = vy;
      px += ox;
      py += oy;

      if (mark) {
        this.#towardMark(i, px, py);
        px = pulled[0] ?? px;
        py = pulled[1] ?? py;
      }

      nx[i] = px;
      ny[i] = py;
      // A nearer bird looks bigger; a flock shrunk to fit is farther away, its birds smaller.
      const scale = near * fit;
      ink[i] = (weight[i] ?? 1) * scale * scale;
      // A startled or fleeing bird rolls and shows more wing.
      roll[i] = Math.max(startle, panic);
      sumX += px;
      sumY += py;
    }
    this.#centreX = sumX / n;
    this.#centreY = sumY / n;

    // Swap: the new positions become the current ones; the old are kept for drawing in between.
    this.#x2 = this.#x;
    this.#y2 = this.#y;
    this.#x = nx;
    this.#y = ny;
  }

  /**
   * The emergent flight: the birds fly as topological boids (sims/boids.ts) under rules the knobs
   * set, over the band of sky, and are seen from the ground with the sheet's perspective; the M
   * pulls them as it pulls the sheet's birds.
   */
  #flyBoids(): void {
    const n = this.#n;
    const boids = this.#boids;
    const rules = this.#rules;
    const aspect = this.#aspect;
    const sky = this.#setup.sky;
    const tight = this.#cohesion;
    const chaos = this.#chaos;
    rules.neighbours = this.#knob.emergent;
    // A bigger flock packs closer: it reads darker, as the sheet's does.
    rules.spacing =
      lerp(BOIDS_SPACING_LOOSE, BOIDS_SPACING_TIGHT, tight) * Math.cbrt(BOIDS_REFERENCE_BIRDS / n);
    rules.cohesion = lerp(BOIDS_COHESION_LOOSE, BOIDS_COHESION_TIGHT, tight);
    rules.alignment = lerp(BOIDS_ALIGN_CALM, BOIDS_ALIGN_CHAOS, chaos);
    rules.noise = lerp(BOIDS_NOISE_CALM, BOIDS_NOISE_CHAOS, chaos);
    rules.speed = BOIDS_CRUISE * this.#rate;
    rules.home.x = aspect / 2;
    rules.home.y = (sky.low + sky.high) / 2;
    rules.reach.x = Math.max(0.05, aspect / 2 - SIDE_MARGIN - BOIDS_INSET_X);
    rules.reach.y = Math.max(0.05, (sky.high - sky.low) / 2 - BOIDS_INSET_Y);
    rules.wind.x = BOIDS_WIND * this.#wind;
    rules.threatRadius = this.#falcon ? FEAR_RADIUS : 0;
    rules.threat.x = this.#falconX;
    rules.threat.y = this.#falconY;
    boids.step(STEP, rules, this.#boidRandom);

    const { x, y, z, vx, vy, alarm } = boids;
    const weight = this.#weight;
    const ink = this.#ink;
    const roll = this.#roll;
    const mark = this.#mark;
    const pulled = this.#pulled;
    const nx = this.#x2;
    const ny = this.#y2;
    const eyeX = aspect / 2;
    let sumX = 0;
    let sumY = 0;
    let headX = 0;
    let headY = 0;
    for (let i = 0; i < n; i++) {
      // Seen from the ground: a little perspective about the middle of the frame.
      const near = DISTANCE / Math.max(0.2, DISTANCE + (z[i] ?? 0));
      let px = eyeX + ((x[i] ?? 0) - eyeX) * near;
      let py = 0.5 + ((y[i] ?? 0) - 0.5) * near;
      if (mark) {
        this.#towardMark(i, px, py);
        px = pulled[0] ?? px;
        py = pulled[1] ?? py;
      }
      nx[i] = px;
      ny[i] = py;
      ink[i] = (weight[i] ?? 1) * near * near;
      // A startled bird rolls and shows more wing, most as the startle reaches it.
      const startled = alarm[i] ?? Number.POSITIVE_INFINITY;
      roll[i] = startled < BOIDS_STARTLED ? 1 - startled / BOIDS_STARTLED : 0;
      sumX += px;
      sumY += py;
      headX += vx[i] ?? 0;
      headY += vy[i] ?? 0;
    }
    this.#centreX = sumX / n;
    this.#centreY = sumY / n;
    this.#headingX = headX / (Math.hypot(headX, headY) || 1);

    this.#x2 = this.#x;
    this.#y2 = this.#y;
    this.#x = nx;
    this.#y = ny;
  }

  /**
   * Hand the birds to the boids where they are drawn: each where its line of sight meets the level
   * plane the boids fly in (a few birds deep), flying along the sheet's long axis as the sheet moved
   * it, kept level.
   */
  #toBoids(): void {
    const n = this.#n;
    const boids = this.#boids;
    const up = this.#rules.up;
    const sky = this.#setup.sky;
    const homeY = (sky.low + sky.high) / 2;
    const eyeX = this.#aspect / 2;
    const cosHeading = this.#shapes[SH_HEADING_COS] ?? 1;
    const sinHeading = this.#shapes[SH_HEADING_SIN] ?? 0;
    const cruise = BOIDS_CRUISE * this.#rate;
    const x = this.#x;
    const y = this.#y;
    const x2 = this.#x2;
    const y2 = this.#y2;
    this.#boidRandom.seed(Math.imul(SEED + n, 0x9e3779b1));
    boids.count = n;
    for (let i = 0; i < n; i++) {
      const sx = x[i] ?? 0;
      const sy = y[i] ?? 0;
      const plane = ((homeY - sy) * up.y) / (up.z + ((sy - 0.5) * up.y) / DISTANCE);
      const z = clamp(plane + (this.#depth[i] ?? 0) * THICKNESS, -BOIDS_DEPTH, BOIDS_DEPTH);
      const far = (DISTANCE + z) / DISTANCE;
      let vx = cruise * cosHeading + (sx - (x2[i] ?? sx)) / STEP;
      let vy = cruise * sinHeading + (sy - (y2[i] ?? sy)) / STEP;
      const climb = vx * up.x + vy * up.y;
      vx -= up.x * climb;
      vy -= up.y * climb;
      boids.place(i, eyeX + (sx - eyeX) * far, 0.5 + (sy - 0.5) * far, z, vx, vy, -up.z * climb);
      this.#pushX[i] = 0;
      this.#pushY[i] = 0;
      this.#pushVX[i] = 0;
      this.#pushVY[i] = 0;
    }
    this.#flying = true;
    this.#catchUp = false;
  }

  /** Hand the birds back to the sheet: on its next step each springs from where it flew to its place. */
  #toSheet(): void {
    this.#flying = false;
    this.#catchUp = true;
  }

  /** Bird i's drawn place (px, py) pulled toward its place on the M's racetrack, into #pulled. */
  #towardMark(i: number, px: number, py: number): void {
    const pulled = this.#pulled;
    pulled[0] = px;
    pulled[1] = py;
    // Birds leave for the M head first and let go of it in the same order.
    const markAge = this.#markAge;
    const delay = MARK_STAGGER * clamp(0.5 * (1 - (this.#sheetA[i] ?? 0)), 0, 1);
    const pull =
      smoothstep(delay, delay + MARK_FLY, markAge) *
      (1 - smoothstep(MARK_HOLD + delay, MARK_HOLD + delay + MARK_FLY, markAge));
    if (pull > 0) {
      const track = this.#trackPoint;
      markTrackAt((this.#markPlace[i] ?? 0) + this.#markRun, track);
      const spread = (this.#sheetB[i] ?? 0) * MARK_SCATTER;
      const tx = this.#markX + ((track[0] ?? 0) + (track[3] ?? 0) * spread) * MARK_SIZE;
      const ty = this.#markY + ((track[1] ?? 0) - (track[2] ?? 0) * spread) * MARK_SIZE;
      pulled[0] = px + (tx - px) * pull;
      pulled[1] = py + (ty - py) * pull;
    }
  }

  /** A startle setting out from bird i: a ring over the sheet from its place, or a relay through the boids. */
  #startle(i: number): void {
    if (this.#flying) this.#boids.startle(i);
    else this.#launchWave(this.#sheetA[i] ?? 0, this.#sheetB[i] ?? 0);
  }

  /** The bird drawn nearest the flock's centre. */
  #centralBird(): number {
    let best = 0;
    let nearest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.#n; i++) {
      const d = ((this.#x[i] ?? 0) - this.#centreX) ** 2 + ((this.#y[i] ?? 0) - this.#centreY) ** 2;
      if (d < nearest) {
        nearest = d;
        best = i;
      }
    }
    return best;
  }

  /** Start an agitation wave running out over the sheet from (a, b), in place of the oldest one. */
  #launchWave(a: number, b: number): void {
    const age = this.#waveAge;
    let slot = 0;
    for (let k = 1; k < WAVES; k++) if ((age[k] ?? 0) > (age[slot] ?? 0)) slot = k;
    this.#waveA[slot] = a;
    this.#waveB[slot] = b;
    age[slot] = 0;
  }

  /** Now and then a ripple starts somewhere in the flock for no visible reason. */
  #fidget(): void {
    const random = this.#random;
    if (random.next() < (STARTLE_CALM + (STARTLE_CHAOS - STARTLE_CALM) * this.#chaos) * STEP) {
      const i = Math.min(this.#n - 1, Math.floor(random.next() * this.#n));
      this.#startle(i);
    }
  }

  /** Schedule and fly the falcon; schedule and time the M. */
  #events(t: number): void {
    const knob = this.#knob;
    const random = this.#random;

    if (knob.predator > 0) {
      const interval = ATTACK_RARE + (ATTACK_OFTEN - ATTACK_RARE) * knob.predator;
      if (!Number.isFinite(this.#nextAttack))
        this.#nextAttack = t + interval * (0.3 + 0.3 * random.next());
      else if (t >= this.#nextAttack && !this.#falcon) {
        this.#attackNow = true;
        this.#nextAttack = t + interval * (0.6 + 0.8 * random.next());
      }
    } else this.#nextAttack = Number.POSITIVE_INFINITY;
    if (this.#attackNow) {
      this.#attackNow = false;
      this.#launchFalcon();
    }
    if (this.#falcon) this.#flyFalcon();

    if (knob.mark > 0) {
      if (!Number.isFinite(this.#nextMark)) this.#nextMark = t + MARK_FIRST;
      else if (t >= this.#nextMark && !this.#mark) {
        this.#markNow = true;
        this.#nextMark =
          t + (MARK_RARE + (MARK_OFTEN - MARK_RARE) * knob.mark) * (0.7 + 0.6 * random.next());
      }
    } else this.#nextMark = Number.POSITIVE_INFINITY;
    if (this.#markNow) {
      this.#markNow = false;
      this.#formMark();
    }
    if (this.#mark) {
      const age = (this.#markAge += STEP);
      this.#markRun +=
        (STEP * (MARK_STREAM_SLOW + (MARK_STREAM_FAST - MARK_STREAM_SLOW) * knob.speed)) /
        MARK_SIZE;
      this.#markStrength =
        smoothstep(0, MARK_GATHER, age) * (1 - smoothstep(MARK_HOLD, MARK_END, age));
      // Letting go: a ripple runs out from the middle of the flock as the birds scatter.
      if (age - STEP < MARK_HOLD && age >= MARK_HOLD) {
        if (this.#flying) this.#boids.startle(this.#centralBird());
        else this.#launchWave(0, 0);
      }
      if (age >= MARK_END) {
        this.#mark = false;
        this.#markStrength = 0;
      }
    }
  }

  /** A peregrine stoops from above the frame at a bird in the thick of the flock. */
  #launchFalcon(): void {
    const random = this.#random;
    // The prey: of a few birds picked at random, the one nearest the flock's centre.
    let prey = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < 8; k++) {
      const i = Math.min(this.#n - 1, Math.floor(random.next() * this.#n));
      const d = Math.hypot((this.#x[i] ?? 0) - this.#centreX, (this.#y[i] ?? 0) - this.#centreY);
      if (d < best) {
        best = d;
        prey = i;
      }
    }
    const px = this.#x[prey] ?? 0;
    const py = this.#y[prey] ?? 0;
    const side = random.next() < 0.5 ? -1 : 1;
    this.#falcon = true;
    this.#falconPrey = prey;
    this.#falconX = px + side * (0.35 + 0.3 * random.next());
    this.#falconY = 1.12;
    this.#falconPrevX = this.#falconX;
    this.#falconPrevY = this.#falconY;
    const dx = px - this.#falconX;
    const dy = py - this.#falconY;
    const d = Math.hypot(dx, dy) + 1e-6;
    this.#falconVX = (dx / d) * FALCON_STOOP;
    this.#falconVY = (dy / d) * FALCON_STOOP;
    this.#falconAge = 0;
    this.#falconStoop = true;
    this.#wingOpen = 0.1;
    this.#wingbeat = 0;
  }

  /**
   * Pursue the prey in a stoop; once past it (a startle runs out from where it struck), pull out,
   * open the wings, climb away and leave.
   */
  #flyFalcon(): void {
    this.#falconAge += STEP;
    this.#falconPrevX = this.#falconX;
    this.#falconPrevY = this.#falconY;
    const vx = this.#falconVX;
    const vy = this.#falconVY;
    const speed = Math.hypot(vx, vy) + 1e-6;
    let angle = Math.atan2(vy, vx);
    let goal: number;
    let rate: number;
    let cruise: number;
    if (this.#falconStoop) {
      const prey = this.#falconPrey;
      const dx = (this.#x[prey] ?? 0) - this.#falconX;
      const dy = (this.#y[prey] ?? 0) - this.#falconY;
      goal = Math.atan2(dy, dx);
      rate = FALCON_TURN;
      cruise = FALCON_STOOP;
      if (Math.hypot(dx, dy) < 0.025 || dx * vx + dy * vy < 0) {
        this.#falconStoop = false;
        this.#startle(prey);
      }
    } else {
      goal = vx >= 0 ? 0.5 : Math.PI - 0.5;
      rate = FALCON_CLIMB;
      cruise = FALCON_CRUISE;
      this.#wingbeat += STEP * FALCON_WINGBEAT * Math.PI * 2;
    }
    let delta = goal - angle;
    delta -= Math.round(delta / (Math.PI * 2)) * Math.PI * 2;
    angle += Math.max(-rate * STEP, Math.min(rate * STEP, delta));
    const v = speed + (cruise - speed) * (1 - Math.exp(-STEP / 0.6));
    this.#falconVX = Math.cos(angle) * v;
    this.#falconVY = Math.sin(angle) * v;
    this.#falconX += this.#falconVX * STEP;
    this.#falconY += this.#falconVY * STEP;
    this.#wingOpen +=
      ((this.#falconStoop ? 0.1 : 1) - this.#wingOpen) * (1 - Math.exp(-STEP / 0.25));
    const out =
      this.#falconX < -0.15 ||
      this.#falconX > this.#aspect + 0.15 ||
      this.#falconY < -0.15 ||
      this.#falconY > 1.2;
    if ((out && this.#falconAge > 0.6) || this.#falconAge > 9) this.#falcon = false;
  }

  /**
   * Hand every bird a place on the M's racetrack, left to right as the birds already are, so the
   * flock flows into the letter instead of criss-crossing the sky; centre the M on the flock.
   */
  #formMark(): void {
    const n = this.#n;
    const x = this.#x;
    const a = this.#aspect;
    // Centre the M on the flock, kept clear of the frame's sides.
    const left = Math.max(a * 0.3, 0.47 * MARK_SIZE + 0.05);
    const right = Math.max(left, Math.min(a * 0.7, a - 0.47 * MARK_SIZE - 0.05));
    this.#markX = Math.min(right, Math.max(left, this.#centreX));
    this.#markY = Math.min(0.64, Math.max(0.5, this.#centreY));
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      lo = Math.min(lo, x[i] ?? 0);
      hi = Math.max(hi, x[i] ?? 0);
    }
    // Counting sort into columns gives each bird its rank from the left.
    const bins = this.#binStart;
    const cursor = this.#binCursor;
    const scale = (MARK_BINS - 1e-3) / Math.max(hi - lo, 1e-6);
    bins.fill(0);
    for (let i = 0; i < n; i++) {
      const b = Math.floor(((x[i] ?? 0) - lo) * scale);
      bins[b + 1] = (bins[b + 1] ?? 0) + 1;
    }
    for (let b = 1; b <= MARK_BINS; b++) bins[b] = (bins[b] ?? 0) + (bins[b - 1] ?? 0);
    for (let b = 0; b < MARK_BINS; b++) cursor[b] = bins[b] ?? 0;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(((x[i] ?? 0) - lo) * scale);
      const rank = cursor[b] ?? 0;
      cursor[b] = rank + 1;
      const across = (rank + 0.5) / n;
      // Alternate birds take the outward lane (left to right) and the return lane (right to left).
      this.#markPlace[i] =
        (i & 1) === 0
          ? across * MARK_OUTWARD_LENGTH
          : MARK_TRACK_LENGTH - across * MARK_OUTWARD_LENGTH;
    }
    this.#mark = true;
    this.#markAge = 0;
    this.#markRun = 0;
  }

  /**
   * Splat the birds into the density field (cloud-in-cell: each bird shares its ink bilinearly
   * among the four nearest texels; Hockney & Eastwood, "Computer Simulation Using Particles"),
   * blended over the last frame's field as a short trail. `keep` is how much of the old field
   * survives; `between` how far the clock is from the previous step to the latest one.
   */
  #paint(keep: number, between: number): void {
    const field = this.#field;
    const w = this.#fieldW;
    const h = this.#fieldH;
    const n = this.#n;
    for (let k = 0; k < field.length; k++) field[k] = (field[k] ?? 0) * keep;
    const gain = 1 - keep;
    const sx = w / this.#aspect;
    const sy = h;
    const f = clamp(between, 0, 1);
    const enter = this.#enter;
    const exit = this.#exit;
    const arriving = enter < 1;
    const leaving = exit > 0;
    const side = this.#entrySide;
    const aspect = this.#aspect;
    const shapes = this.#shapes;
    // The boids have no sheet: the passage follows the flock's own middle and heading.
    const flying = this.#flying;
    const lag = this.#lag;
    const sheetA = this.#sheetA;
    const sheetB = this.#sheetB;
    const phaseA = this.#phaseA;
    const phaseB = this.#phaseB;
    const x = this.#x;
    const y = this.#y;
    const px = this.#x2;
    const py = this.#y2;
    const ink = this.#ink;
    const roll = this.#roll;
    for (let i = 0; i < n; i++) {
      let xi = (px[i] ?? 0) + ((x[i] ?? 0) - (px[i] ?? 0)) * f;
      let yi = (py[i] ?? 0) + ((y[i] ?? 0) - (py[i] ?? 0)) * f;
      if (arriving || leaving) {
        const o = (lag[i] ?? 0) * SHAPE;
        // Head first: 0 at the leading end of the sheet, 1 at the trailing end; two fixed random shares.
        const back = clamp(0.5 * (1 - (sheetA[i] ?? 0)), 0, 1);
        const luck = (phaseA[i] ?? 0) / TAU;
        const other = (phaseB[i] ?? 0) / TAU;
        if (arriving) {
          // From a file beyond the edge to its place in the sheet, slowing as it folds in.
          const q = clamp(
            (enter - (ENTER_LEAD + ENTER_STAGGER * back + ENTER_SCATTER * luck)) / ENTER_FLIGHT,
            0,
            1,
          );
          if (q < 1) {
            const e = q * (2 - q);
            const startX =
              side < 0
                ? -(ENTER_BEYOND + ENTER_DEPTH * other)
                : aspect + ENTER_BEYOND + ENTER_DEPTH * other;
            const sheetY = flying ? this.#centreY : (shapes[o + SH_Y] ?? 0);
            const startY = sheetY + 0.5 * (yi - sheetY) + (sheetB[i] ?? 0) * ENTER_SPREAD;
            const flyX = startX + (xi - startX) * e;
            const flyY = startY + (yi - startY) * e;
            xi = flyX;
            yi = flyY + ENTER_SWAY * (1 - e) * Math.sin(ENTER_SWAY_WAVE * flyX + 1.3);
          }
        }
        if (leaving) {
          // Down to the roost behind the skyline, closing up about the flock's centre.
          const q = clamp((exit - (EXIT_STAGGER * back + EXIT_SCATTER * luck)) / EXIT_FALL, 0, 1);
          if (q > 0) {
            const centre = flying ? this.#centreX : (shapes[o + SH_X] ?? 0);
            const heading = flying ? this.#headingX : (shapes[o + SH_HEADING_COS] ?? 1);
            const gather = smoothstep(0, 0.85, q);
            const roost = EXIT_ROOST_LOW + EXIT_ROOST_SPREAD * other;
            xi +=
              (centre + (xi - centre) * EXIT_FUNNEL - xi) * gather +
              EXIT_SWOOP * heading * Math.sin(Math.PI * q);
            yi += (roost - yi) * q ** EXIT_POWER;
          }
        }
      }
      const gx = xi * sx - 0.5;
      const gy = yi * sy - 0.5;
      const i0 = Math.floor(gx);
      const j0 = Math.floor(gy);
      if (i0 < -1 || j0 < -1 || i0 >= w || j0 >= h) continue;
      const ax = gx - i0;
      const ay = gy - j0;
      const mass = gain * (ink[i] ?? 1);
      const dark = mass * (roll[i] ?? 0);
      for (let dj = 0; dj < 2; dj++) {
        const j = j0 + dj;
        if (j < 0 || j >= h) continue;
        const wy = dj === 0 ? 1 - ay : ay;
        for (let di = 0; di < 2; di++) {
          const col = i0 + di;
          if (col < 0 || col >= w) continue;
          const share = wy * (di === 0 ? 1 - ax : ax);
          const k = (j * w + col) * 2;
          field[k] = (field[k] ?? 0) + mass * share;
          field[k + 1] = (field[k + 1] ?? 0) + dark * share;
        }
      }
    }

    const d = this.#stateData;
    const a = this.#aspect;
    const speed = Math.hypot(this.#falconVX, this.#falconVY) + 1e-6;
    d[0] = (this.#falconPrevX + (this.#falconX - this.#falconPrevX) * f) / a;
    d[1] = this.#falconPrevY + (this.#falconY - this.#falconPrevY) * f;
    d[2] = this.#falconVX / speed;
    d[3] = this.#falconVY / speed;
    d[4] = this.#falcon ? 1 : 0;
    d[5] = this.#wingOpen;
    d[6] = Math.sin(this.#wingbeat);
    // Birds per texel of a sheet at the reference density: the shader's unit of grey.
    d[7] = (REFERENCE_DENSITY * a) / (w * h);
    d[8] = this.#markStrength;
    d[9] = this.#markX / a;
    d[10] = this.#markY;
    d[11] = MARK_SIZE;
  }
}

/** A point on the M's racetrack at arclength u (wrapping): out[0..1] position, out[2..3] direction, mark units. */
function markTrackAt(u: number, out: Float32Array): void {
  const along = u - Math.floor(u / MARK_TRACK_LENGTH) * MARK_TRACK_LENGTH;
  const segments = MARK_TRACK.length / 6;
  let k = 0;
  while (k + 1 < segments && along >= (MARK_TRACK[(k + 1) * 6 + 4] ?? 0)) k++;
  const o = k * 6;
  const ax = MARK_TRACK[o] ?? 0;
  const ay = MARK_TRACK[o + 1] ?? 0;
  const bx = MARK_TRACK[o + 2] ?? 0;
  const by = MARK_TRACK[o + 3] ?? 0;
  const length = MARK_TRACK[o + 5] ?? 1;
  const f = clamp((along - (MARK_TRACK[o + 4] ?? 0)) / length, 0, 1);
  out[0] = ax + (bx - ax) * f;
  out[1] = ay + (by - ay) * f;
  out[2] = (bx - ax) / length;
  out[3] = (by - ay) / length;
}

/** A Flock with its two textures (uSim0, uSim1), uploaded whenever it repaints them. */
class FlockSim implements SceneSim {
  readonly #flock: Flock;
  readonly #density: DataTexture;
  readonly #state: DataTexture;

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[], setup: FlockSetup) {
    this.#flock = new Flock(params, setup);
    this.#density = new DataTexture(gl, { width: 1, height: 1, format: "rg16f" });
    this.#state = new DataTexture(gl, {
      width: 3,
      height: 1,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const flock = this.#flock;
    if (!flock.frame(frame)) return IDLE;
    if (flock.painted) {
      this.#density.resize(flock.fieldWidth, flock.fieldHeight);
      this.#density.upload(flock.field);
      this.#state.upload(flock.state);
    }
    return [this.#density.texture, this.#state.texture];
  }

  dispose(): void {
    this.#density.dispose();
    this.#state.dispose();
  }
}

/** The murmuration's simulation for a scene whose knobs are `params` (looked up by key), flown as `setup` says. */
export function flockSim(params: readonly ParamDef[], setup: FlockSetup = MURMURATION): SimFactory {
  return (gl) => new FlockSim(gl, params, setup);
}
