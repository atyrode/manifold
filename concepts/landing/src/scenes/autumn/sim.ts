// The Autumn park preset's sims (ADR 0062 Phase 2a): the leaves of the great tree let go, fall as the
// flat plates they are, and lie; the agents rake them into piles. Three layer sims over one park:
//   maple   the Park itself (its LayerSim, and its affordances): the leaves in the air, the carpet,
//           the M, the piles and what the gusts do to them, on one random stream for the seed, so a
//           seed lays out the carpet and the leaves already falling as it always did. Its record row
//           (AUTUMN_DATA.maple) holds the leaves in the air.
//   litter  the carpet's two layers as its fields, and the M's knob: it hands the Park the M's goal
//           and lends the rake the Park (its affordances); it lies under the tree, so it needs the
//           maple.
//   rake    the chore: the plan and the tool. The agents' presses by the path set strokes going and
//           each stroke drags the carpet into a pile through the Park (`rake`); the Park, the host,
//           owns the piles and nature's undo.
//
// Falling leaves are rigid plates in a vertical plane (the shared fluttering-plate model,
// sims/flutter.ts, as the garden's leaves fall). Light leaves flutter, swinging from side to side and
// gliding up at the end of each swing; heavier ones tumble end over end. Each leaf's plane turns
// slowly, the leaf rocks about its chord and spins in its own plane, and the wind, the gusts (the
// composer's one gust field, composer/gust.ts, where the leaf is: ADR 0062 D4) and the swirl of a gust
// carry it. A leaf that touches down eases flat (face up or face down, whichever is nearer) and is
// then handed to the carpet.
//
// A gust is the field's: as one reaches the tree (its load at the canopy rises past GUST_ONSET) a
// shower of leaves is shaken loose and often a swirl sets off up or down the path, lifting the
// leaves lying on top (while the litter is on) and setting them flying; the composer's "now" sends
// one that always swirls. Everything runs on the motion clock: at motion 0 the park stands still.
//
// The carpet is the accumulation (the shared ground-litter lattice, sims/litter.ts): 0.3 m cells over
// the ground in two layers (the second shifted half a cell and lying beneath), each cell holding at
// most one leaf: its offset inside the cell, its angle, its colour, which face is up, and a fade level.
// Landed leaves are written there; a slow sweep over the lattice lets the carpet settle toward the
// season's density (more leaves as the season runs on, more under the tree, fewer on the path) by
// fading leaves in and out. The Manifold M is leaves swept together into a road-marking M along the
// path (the cells under its strokes fill with gold leaves, the cells round them are cleared).
//
// The rake is the agents' chore (the `rake` layer): an agent of the cast that presses on the ground
// by the path draws one stroke of a rake along the path toward a pile there (Litter.rake): the leaves
// in the band it passes over are lifted and laid in the pile, heaped under its top once its cells are
// full, and the raked ground is kept bare. A pile takes six strokes, from up and down the path and
// either side of its middle, so the agents come back to it (`interest`: the piles under way, and a
// fresh station along the path for each agent beyond them). Nature undoes it: a gust lifts the piles'
// leaves and flings them up or down the wind until a pile is blown flat and its ground left to the
// carpet again, and the leaves go on falling on the raked ground. Without agents none of it runs.
//
// The scene's passage (layout.ts AUTUMN_PASSAGE) is played here too: as it comes in a gust blows a flurry of
// leaves in from beyond the windward edge of the frame, and as it leaves a stronger gust and a vortex lift
// leaves off the carpet and whirl them up across the frame, with a shower from the canopy. At rest none of
// it runs.
//
// Data (rgba16f, nearest):
//   the maple's row   AUTUMN_SLOTS leaves of four texels each, leaf i at texels 4i..4i+3:
//          (x, y, radius, alpha)  screen position from the horizon's centre and radius, in screen heights;
//          (tx, ty, sx, sy)       the plate's two in-plane axes projected on the screen (perspective kept),
//                                 so screen offset = radius * (lx * s + ly * t) for leaf-local (lx, ly);
//          (nx, ny, nz, z)        the upward plate normal in the world, and the depth in metres;
//          (hue, seed, 0, 0)
//   the litter's fields 0 and 1   carpet layers A and B: AUTUMN_CARPET.cols x rows, one cell per texel:
//          (ox, oz, angle, w): the leaf's offset in cell units, its tip's heading in the ground plane
//          (atan2(dz, dx)), and w = face * (level + 16 * isMark + 0.98 * hue), face +1 top up, -1 top
//          down, level 1..8 (alpha = level / 8), 0 for no leaf.
import { gustAt, gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { markDistance } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { FlutterPlates } from "../../sims/flutter.ts";
import {
  CLEARED,
  HEAPED,
  Litter,
  PINNED,
  type LitterItem,
  type LitterPile,
} from "../../sims/litter.ts";
import { clamp, hash31, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import { windSign } from "../../sims/wind.ts";
import type { ScenePoint } from "../types.ts";
import {
  AUTUMN_CARPET,
  AUTUMN_GUST,
  AUTUMN_MARK,
  AUTUMN_PASSAGE,
  AUTUMN_PATH,
  AUTUMN_SLOTS,
  AUTUMN_TREE,
  AUTUMN_VIEW,
  AUTUMN_WHIRL,
  AUTUMN_WIDE,
  autumnFlurry,
  autumnPathX,
} from "./layout.ts";

type ParkKnob = "species" | "fall" | "season" | "seed" | "gusts";
const PARK_KNOBS: readonly ParkKnob[] = ["species", "fall", "season", "seed", "gusts"];

const TAU = Math.PI * 2;
const SLOTS = AUTUMN_SLOTS;
const COLS = AUTUMN_CARPET.cols;
const ROWS = AUTUMN_CARPET.rows;
const CELLS = COLS * ROWS;

// ---- the leaves in flight (sims/flutter.ts) -----------------------------------------------------

interface Species {
  /** Drawn radius, metres. */
  radius: number;
  /** The plate's aerodynamic chord, metres: sets the swing and the speed of descent. */
  chord: number;
  /** Share of leaves heavy enough to tumble instead of flutter. */
  tumbling: number;
}

/** Maple, ginkgo, oak. */
const SPECIES: readonly Species[] = [
  { radius: 0.15, chord: 0.4, tumbling: 0.16 },
  { radius: 0.12, chord: 0.32, tumbling: 0.08 },
  { radius: 0.14, chord: 0.38, tumbling: 0.28 },
];
const FLUTTER_MASS: readonly [number, number] = [0.2, 0.42];
const TUMBLE_MASS: readonly [number, number] = [0.72, 0.9];
/** Real seconds per model time unit: the pace of the swing (a leaf drifts down at about 0.8 m/s). */
const PACE = 0.21;
/** How far a falling leaf rocks about its chord (radians). */
const ROLL = 0.3;

// ---- the weather in the air ----------------------------------------------------------------------

/** Wind drift (m/s) at wind = 1; a gust's added drift at a load of 1 (the field's, times AUTUMN_GUST.gain). */
const WIND_DRIFT = 1.2;
const GUST_DRIFT = 2.2;
/** A gust begins as the load at the canopy rises past ONSET and is over once it falls below CALM. */
const GUST_ONSET = 0.3;
const GUST_CALM = 0.15;
/** Seconds after a gust began past which nothing of it is left to time (its shower, its swirl). */
const GUST_SPENT = 22;
const GUST_SHOWER = 9;
const GUST_SHAKE = 2.2;
/** The swirl: how long it lives, how fast it crosses the path, its core radius, peak tangential speed, updraft, reach. */
const SWIRL_LIFE = 15;
const SWIRL_SPEED = 1.1;
const SWIRL_CORE = 1.25;
const SWIRL_TURN = 3.4;
const SWIRL_LIFT = 1.9;
const SWIRL_REACH = 2.4;
const SWIRL_PICKUP = 1.5;
/** Most leaves a swirl lifts at once (of the slots). */
const SWIRL_LEAVES = 14;

// ---- the passage ----

/** The entrance's flurry: leaves blown in from beyond the windward edge, and the gust's drift (m/s) at full strength. */
const FLURRY_LEAVES = 16;
const FLURRY_DRIFT = 5;
/**
 * The exit's whirl: its drift (m/s), a vortex's core radius, peak turn, lift and reach (as the swirl's), an
 * updraft over the whole park, where the vortex starts (metres upwind of the path) and its depth, how fast it
 * crosses (m/s), the radius it lifts leaves from, the attempts per second, most leaves lifted at once.
 */
const WHIRL_DRIFT = 4.5;
const WHIRL_CORE = 2;
const WHIRL_TURN = 4.5;
const WHIRL_LIFT = 3.4;
const WHIRL_REACH = 3.2;
const WHIRL_UPDRAFT = 1.2;
const WHIRL_FROM = 6.5;
const WHIRL_Z = 8.5;
const WHIRL_SPEED = 6.5;
const WHIRL_PICKUP = 3.2;
const WHIRL_RATE = 80;
const WHIRL_LEAVES = 22;
/** The canopy lets go of this many leaves over the first moments of the exit. */
const EXIT_SHOWER = 8;
const EXIT_SHOWER_SECONDS = 0.7;

// ---- leaves -------------------------------------------------------------------------------------

const FREE = 0;
const FALLING = 1;
const SETTLING = 2;
/** A landed leaf lies this far above the ground. */
const LEAF_LIFT = 0.012;
const SETTLE_SECONDS = 0.7;
const FADE_IN = 0.9;
/** Leaves per second at the leaf-fall knob's full travel and the season's busiest. */
const FALL_RATE = 3.4;
/** Ambient leaves leave this many slots for a swirl. */
const AMBIENT_SLOTS = SLOTS - 8;
const PREWARM_FALLING = 12;

// ---- the carpet ----------------------------------------------------------------------------------

/** Level steps from nothing to a whole leaf (alpha = level / LEVELS), and the seconds between steps. */
const LEVELS = 8;
const LEVEL_EVERY = 0.12;
/** Cells visited by the sweep per second, and the chance a visit settles a cell toward its density. */
const SCAN_RATE = 2200;
const ADD_CHANCE = 0.06;
const REMOVE_CHANCE = 0.012;
const HURRY_SECONDS = 10;
const HURRY_CHANCE = 0.3;
/** Seconds the M's cells take to gather, and how long a "now" keeps it. */
const MARK_SECONDS = 8;
const MARK_HOLD = 45;
const UPLOAD_EVERY_MS = 1000 / 24;

// ---- the rake ------------------------------------------------------------------------------------

/** Piles at once; the stations along the path fresh ones are started at (depths, m), each this far from the path's middle, on alternate sides. */
const PILES = 6;
const PILE_STATIONS = [5.6, 7.2, 9.0, 11.0, 13.4, 16.2] as const;
const PILE_SIDE = 0.6;
/** A press within this far (m) of a pile works on it; one farther from the path's middle than its half width and this starts none. */
const PILE_MERGE = 1.6;
const PILE_OFF_PATH = 0.5;
/** A pile's radius (m): to start with, what it grows by with the square root of its leaves, at most. */
const PILE_RADIUS = 0.3;
const PILE_GROW = 0.06;
const PILE_MAX = 0.8;
/**
 * The strokes that rake a pile together, in order: from up the path (+1) or down it (-1), and how far
 * across it from the pile's middle (m) the stroke sets out; each closes in toward the middle.
 */
const STROKES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [1, -0.5],
  [-1, 0.5],
  [1, 0.5],
  [-1, -0.5],
];
/** A stroke's run (s), the half width of its band (m), and how far out it sets off (m) over the knob's travel. */
const STROKE_SECONDS = 1.6;
const STROKE_WIDTH = 0.26;
const REACH_MIN = 1.0;
const REACH_RANGE = 1.6;
/** A gust lifts a pile's leaves while it blows there harder than SCATTER_FROM: SCATTER_RATE a second at a load of 1. */
const SCATTER_FROM = 0.15;
const SCATTER_RATE = 40;

/** A pile raked together on the carpet (Litter.rake's pile): the Park's, with what the rake marks on it. */
export interface Pile extends LitterPile {
  live: boolean;
  /** Leaves raked into it and not yet blown away: they set its size. */
  leaves: number;
  /** A stroke is under way on it (the rake's): the gusts do not blow it flat meanwhile. */
  raking: boolean;
  /** How far out its strokes set off (m, the rake's reach): that much ground round it was raked bare. */
  reach: number;
  /** The gusts' lifts owed it, in leaves. */
  debt: number;
}

const pileRadius = (pile: Pile): number =>
  Math.min(PILE_MAX, PILE_RADIUS + PILE_GROW * Math.sqrt(pile.leaves));

const at = (array: Float64Array | Float32Array | Uint8Array | Int8Array, index: number): number =>
  array[index] ?? 0;

/** Smooth value noise in two dimensions, 0..1. */
function noise2(x: number, z: number, salt: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = x - i;
  const fz = z - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return lerp(
    lerp(hash31(i, j, salt), hash31(i + 1, j, salt), ux),
    lerp(hash31(i, j + 1, salt), hash31(i + 1, j + 1, salt), ux),
    uz,
  );
}

/** How busy the tree is letting go of leaves along the season (0 early, a long peak, a few stragglers at the end). */
function activity(season: number): number {
  return 0.25 + 0.75 * smoothstep(0, 0.25, season) * (1 - 0.7 * smoothstep(0.75, 1, season));
}

/** The carpet's overall density at the season: a few leaves early on, a thick one at the end. */
function carpetBase(season: number): number {
  return 0.2 + 0.9 * Math.pow(clamp(season, 0, 1), 0.7);
}

/**
 * The park's leaves: the maple's sim, and the host the litter and the rake reach through
 * `LayerFrame.host` (its affordances are itself).
 */
export class Park implements LayerSim {
  readonly #knobs: KnobReader<ParkKnob>;

  // The falling leaves, one slot each.
  readonly #state = new Uint8Array(SLOTS);
  readonly #x = new Float64Array(SLOTS);
  readonly #y = new Float64Array(SLOTS);
  readonly #z = new Float64Array(SLOTS);
  /** Each leaf's plate in flight: its plane, pitch, spin, rock, mass, chord, pace and the pitch it lands and rests at. */
  readonly #plates = new FlutterPlates(SLOTS, ROLL);
  readonly #radius = new Float64Array(SLOTS);
  readonly #hue = new Float64Array(SLOTS);
  readonly #seed = new Float64Array(SLOTS);
  readonly #alpha = new Float64Array(SLOTS);
  /** Seconds since touchdown; eddy phase. */
  readonly #lain = new Float64Array(SLOTS);
  readonly #phase = new Float64Array(SLOTS);
  /** 1 for a leaf a swirl lifted off the path. */
  readonly #lifted = new Uint8Array(SLOTS);
  /** The air at a leaf (x, y, z); its position for the plates, (x, z, y); its frame from the plates, (x, z, y) each, written by #orient. */
  readonly #air = new Float64Array(3);
  readonly #pos = new Float64Array(3);
  readonly #frame = new Float64Array(9);
  /** Where a falling leaf touches down: the lawn and the path are level. */
  readonly #floor = (): number => LEAF_LIFT;
  #rand = mulberry32(1);
  #nextLeaf = 1;
  #clock = 0;
  #species = 0;
  #seedKnob = -1;

  // The weather: the composer's gust field as this frame has it, and whether it blows yet (not while
  // the park is laid out: the leaves already falling fell in still air); the gust under way, set off
  // as one reached the tree; the composer's last "now", and whether the next gust swirls for it.
  readonly #gusts = newGustWind();
  #fieldOn = false;
  #tm = 0;
  #gusting = false;
  #nowAge = -1;
  #nowSwirl = false;
  #gustAge = Infinity;
  #gustSign = 1;
  #gustPower = 0.7;
  #swirlOn = false;
  #swirlSign = -1;
  #swirlZ = 0;
  #swirlX = 0;
  #swirlPickup = 0;
  #shower = 0;
  #wind = 0;

  // The passage: whether its first frame has passed, the gust's strength and the way it blows, the whirl's core.
  #entered = false;
  #blow = 0;
  #blowSign = 1;
  #whirl = 0;
  #whirlX = 0;
  #whirlPickup = 0;
  #exiting = false;
  #exitShower = 0;
  #exitSeconds = 0;

  // The carpet (sims/litter.ts): layer 0 the lattice on top, layer 1 the shifted one beneath; the
  // litter's fields. While the litter is off nothing is lifted off it.
  readonly #carpet = new Litter(AUTUMN_CARPET, LEVELS);
  /** Per cell: the shape of the carpet's density. */
  readonly #shape = new Float32Array(CELLS);
  readonly carpetA: DataTexture;
  readonly carpetB: DataTexture;
  #litterOn = false;
  #uploadedAt = -Infinity;
  #fadeClock = 0;
  #scanDebt = 0;
  #season = -1;
  #base = 0;
  #hurry = 0;

  // The M: the litter sets its goal (1 to gather it, 0 to scatter it).
  readonly #strokeCells: number[] = [];
  readonly #marginCells: number[] = [];
  #markShown = 0;
  markGoal = 0;

  /** The piles raked together along the path (the rake's work, the gusts' to undo). */
  readonly piles: readonly Pile[] = Array.from({ length: PILES }, () => ({
    x: 0,
    z: 0,
    under: 0,
    live: false,
    leaves: 0,
    raking: false,
    reach: REACH_MIN,
    debt: 0,
  }));
  /** The cells round a pile (#around): the first column and row, and how many of each. */
  readonly #box = new Int32Array(3);

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("maple", params, PARK_KNOBS);
    this.carpetA = new DataTexture(gl, {
      width: COLS,
      height: ROWS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.carpetB = new DataTexture(gl, {
      width: COLS,
      height: ROWS,
      format: "rgba16f",
      filter: "nearest",
    });
    this.#layOut(
      this.#knobs.initial("seed"),
      this.#knobs.initial("season"),
      this.#knobs.initial("species"),
    );
  }

  get affordances(): Park {
    return this;
  }

  /** The M lies on the path (gathered or gathering). */
  get markShown(): boolean {
    return this.#markShown > 0;
  }

  frame(frame: LayerFrame): void {
    const knobs = this.#knobs;
    const seed = Math.round(knobs.value(frame, "seed"));
    const season = clamp(knobs.value(frame, "season"), 0, 1);
    const species = Math.round(knobs.value(frame, "species"));
    this.#wind = frame.gusts.wind;
    if (seed !== this.#seedKnob) this.#layOut(seed, season, species);
    this.#species = clamp(species, 0, SPECIES.length - 1);
    this.#litterOn = frame.host("litter") !== undefined;
    if (!this.#litterOn) this.markGoal = 0;

    const real = clamp(frame.dt, 0, 0.1);
    const enter = clamp(frame.passage.enter, 0, 1);
    const exit = clamp(frame.passage.exit, 0, 1);
    this.#passage(frame.aspect, enter, exit);
    // A passage plays in real time whatever the motion.
    const dt = real * Math.max(frame.motion, enter < 1 || exit > 0 ? 1 : 0);
    this.#clock += dt;
    this.#weather(frame, dt);
    this.#leaves(dt, knobs.value(frame, "fall"), season);
    this.#scatter(dt);

    if (season !== this.#season) this.#changeSeason(season);
    this.#gather(real);
    this.#sweep(real);
    this.#fade(real);
    this.#pack(frame);
  }

  dispose(): void {
    this.carpetA.dispose();
    this.carpetB.dispose();
  }

  // ---- the park ------------------------------------------------------------------------------------

  /** Lay the park out afresh for a seed: the carpet at the season's density, a few leaves already in the air. */
  #layOut(seed: number, season: number, species: number): void {
    this.#seedKnob = seed;
    this.#species = clamp(species, 0, SPECIES.length - 1);
    this.#rand = mulberry32(Math.imul(seed + 1, 0x9e3779b1) ^ 0x6c656166);
    const rand = this.#rand;

    this.#state.fill(FREE);
    this.#lifted.fill(0);
    this.#carpet.clear();
    for (const pile of this.piles) pile.live = false;
    this.#markShown = 0;
    this.#season = season;
    this.#base = carpetBase(season);

    const A = AUTUMN_CARPET;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const x = A.x0 + (i + 0.5) * A.cell;
        const z = A.z0 + (j + 0.5) * A.cell;
        const path =
          1 -
          smoothstep(AUTUMN_PATH.half * 0.8, AUTUMN_PATH.half * 1.3, Math.abs(x - autumnPathX(z)));
        const dx = x - AUTUMN_TREE.canopyX;
        const dz = z - AUTUMN_TREE.canopyZ;
        const tree = Math.exp(-(dx * dx + dz * dz) / (2 * 5.5 * 5.5));
        const drift = noise2(x * 0.28, z * 0.28, seed + 11);
        // Leaves lie thickest under the tree and gather along the edges of the path.
        const edge = (Math.abs(x - autumnPathX(z)) - AUTUMN_PATH.half) / 0.8;
        this.#shape[j * COLS + i] =
          ((0.75 + 0.9 * tree) * (1 - 0.3 * path) + 0.55 * Math.exp(-edge * edge)) *
          (0.7 + 0.6 * drift);
      }
    }
    for (let cell = 0; cell < CELLS; cell++) {
      for (let layer = 0; layer < 2; layer++) {
        if (this.#wants(cell, layer))
          this.#carpet.place(
            layer * CELLS + cell,
            rand(),
            rand(),
            rand(),
            rand(),
            false,
            LEVELS,
            LEVELS,
            rand,
          );
      }
    }

    // The M: the cells under its strokes and the ring of cells round them, in a seeded order.
    this.#strokeCells.length = 0;
    this.#marginCells.length = 0;
    const unitX = AUTUMN_MARK.width / 0.94;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const x = A.x0 + (i + 0.5) * A.cell;
        const z = A.z0 + (j + 0.5) * A.cell;
        const d = markDistance(
          (x - AUTUMN_MARK.x) / unitX,
          (z - AUTUMN_MARK.z) / AUTUMN_MARK.depth,
        );
        if (d < AUTUMN_MARK.stroke) this.#strokeCells.push(j * COLS + i);
        else if (d < AUTUMN_MARK.margin) this.#marginCells.push(j * COLS + i);
      }
    }
    for (let k = this.#strokeCells.length - 1; k > 0; k--) {
      const m = Math.floor(rand() * (k + 1));
      const a = this.#strokeCells[k] ?? 0;
      this.#strokeCells[k] = this.#strokeCells[m] ?? 0;
      this.#strokeCells[m] = a;
    }
    this.#uploadedAt = -Infinity;

    // Leaves already on their way down, caught in their swing, in still air.
    const fieldOn = this.#fieldOn;
    this.#fieldOn = false;
    for (let n = 0; n < PREWARM_FALLING; n++) {
      const i = this.#spawn(false);
      if (i < 0) break;
      this.#alpha[i] = 1;
      const seconds = 1.5 + 3.5 * rand();
      for (let t = 0; t < seconds && this.#state[i] === FALLING; t += 0.05) this.#fall(i, 0.05);
    }
    this.#fieldOn = fieldOn;
    this.#nextLeaf = 0.5 + 1.5 * rand();
  }

  /** Whether the carpet, in its sweep, wants a leaf in this layer's cell at the season's density. */
  readonly #wants = (cell: number, layer: number): boolean => {
    const density = Math.min(0.95, at(this.#shape, cell) * this.#base) * (layer === 0 ? 1 : 0.65);
    return hash31(cell, layer, this.#seedKnob) < density;
  };

  #changeSeason(season: number): void {
    this.#season = season;
    this.#base = carpetBase(season);
    this.#hurry = HURRY_SECONDS;
  }

  // ---- the passage ---------------------------------------------------------------------------------

  /**
   * The scene's entrance and exit, from the simulation's side: a flurry of leaves blown through from beyond
   * the windward edge as the scene comes in, a whirl lifting the leaves off the ground as it goes out. Both
   * are zero at rest, and nothing here draws on the random stream then.
   */
  #passage(aspect: number, enter: number, exit: number): void {
    this.#blowSign = windSign(this.#wind);
    if (!this.#entered) {
      this.#entered = true;
      if (enter < 1) this.#startFlurry(aspect > 0 ? aspect : 16 / 9);
    }
    this.#blow = enter < 1 ? autumnFlurry(enter * AUTUMN_PASSAGE.enter) : 0;
    this.#whirl = exit > 0 ? smoothstep(0, AUTUMN_WHIRL.rise, exit) : 0;
    if (exit > 0) {
      this.#exitSeconds = exit * AUTUMN_PASSAGE.exit;
      this.#whirlX =
        autumnPathX(WHIRL_Z) + this.#blowSign * (WHIRL_SPEED * this.#exitSeconds - WHIRL_FROM);
      if (!this.#exiting) {
        this.#exiting = true;
        this.#exitShower = EXIT_SHOWER;
      }
    }
  }

  /** Leaves already streaming in: spread beyond the windward edge of the frame, at depths through the canopy, each arriving as the gust reaches it. */
  #startFlurry(aspect: number): void {
    const kind = SPECIES[this.#species] ?? SPECIES[0];
    if (kind === undefined) return;
    const { horizon, eye, focal } = AUTUMN_VIEW;
    const half = 0.5 * Math.max(aspect, AUTUMN_WIDE);
    const rand = this.#rand;
    for (let n = 0; n < FLURRY_LEAVES; n++) {
      const i = this.#freeSlot();
      if (i < 0) return;
      const z = 3.6 + 6.4 * Math.pow(rand(), 1.2);
      const sx = -this.#blowSign * (half + 0.2 + 1.4 * rand());
      const sy = 0.42 + 0.7 * rand();
      this.#x[i] = (sx * z) / focal;
      this.#y[i] = eye + ((sy - horizon) * z) / focal;
      this.#z[i] = z;
      this.#begin(i, kind, false);
      // Off the frame already: no dissolve in.
      this.#alpha[i] = 1;
    }
  }

  // ---- gusts -----------------------------------------------------------------------------------

  /**
   * The composer's gust field this frame, and the gust it brings the tree: one begins as the load at
   * the canopy rises past GUST_ONSET (a "now" lets the next one swirl, and lets one begin at once if
   * the tree is already in a gust); then the swirl's way up or down the path.
   */
  #weather(frame: LayerFrame, dt: number): void {
    const g = frame.gusts;
    gustWind(this.#gusts, g.wind, g.gusts, g.rate, g.nowAge, g.pass, g.shape);
    this.#tm = frame.motionTime;
    this.#fieldOn = true;
    if (g.nowAge >= 0 && (this.#nowAge < 0 || g.nowAge < this.#nowAge)) {
      this.#nowSwirl = true;
      this.#gusting = false;
    }
    this.#nowAge = g.nowAge;
    if (dt > 0) {
      const tree =
        AUTUMN_GUST.gain *
        gustAt(this.#gusts, AUTUMN_TREE.canopyX, AUTUMN_TREE.canopyZ, this.#tm, 0);
      if (!this.#gusting && tree > GUST_ONSET) {
        this.#gusting = true;
        this.#startGust(this.#nowSwirl || this.#rand() < 0.6, this.#knobs.amount(frame, "gusts"));
        this.#nowSwirl = false;
      } else if (this.#gusting && tree < GUST_CALM) {
        this.#gusting = false;
      }
    }
    if (this.#gustAge < GUST_SPENT) this.#gustAge += dt;
    this.#swirlOn = this.#swirlOn && this.#gustAge < SWIRL_LIFE;
    if (this.#swirlOn) {
      this.#swirlZ += this.#swirlSign * SWIRL_SPEED * dt;
      this.#swirlX = autumnPathX(this.#swirlZ) + 0.6 * Math.sin(0.5 * this.#gustAge);
    }
  }

  /** A gust reaches the tree: a shower from it and (often) a swirl up the path, as strong as the gusts are set. */
  #startGust(swirl: boolean, amount: number): void {
    const rand = this.#rand;
    this.#gustAge = 0;
    this.#gustSign = this.#gusts.dirX < 0 ? -1 : 1;
    this.#gustPower = 0.55 + 0.45 * clamp(amount, 0, 1);
    this.#shower = GUST_SHOWER;
    this.#swirlOn = swirl;
    this.#swirlPickup = 0;
    if (swirl) {
      this.#swirlSign = rand() < 0.6 ? -1 : 1;
      this.#swirlZ = this.#swirlSign < 0 ? 17 : 6.5;
      this.#swirlX = autumnPathX(this.#swirlZ);
    }
  }

  /** The gust field's push at floor point (x, z), the way it blows: 0 in still air (while the park is laid out). */
  #gustAt(x: number, z: number): number {
    if (!this.#fieldOn) return 0;
    const sign = this.#gusts.dirX < 0 ? -1 : 1;
    return sign * AUTUMN_GUST.gain * gustAt(this.#gusts, x, z, this.#tm, 0);
  }

  /** The air at (x, y, z) for leaf i: the wind, the gust field, slow eddies and the swirl, written to #air. */
  #airAt(i: number, x: number, y: number, z: number): void {
    const phase = at(this.#phase, i);
    const gust = this.#gustAt(x, z);
    let vx =
      this.#wind * WIND_DRIFT + gust * GUST_DRIFT + 0.3 * Math.sin(0.9 * this.#clock + phase);
    let vy = 0.12 * Math.sin(0.7 * this.#clock + 1.7 * phase);
    let vz = 0.2 * Math.sin(0.6 * this.#clock + 2.3 * phase) - 0.15 * Math.abs(gust);
    if (this.#swirlOn) {
      const strength =
        smoothstep(0, 2, this.#gustAge) *
        (1 - smoothstep(SWIRL_LIFE - 4, SWIRL_LIFE, this.#gustAge)) *
        this.#gustPower;
      const dx = x - this.#swirlX;
      const dz = z - this.#swirlZ;
      const r = Math.hypot(dx, dz) + 1e-6;
      if (r < 4 * SWIRL_CORE) {
        const q = r / SWIRL_CORE;
        // A vortex: tangential speed peaking at the core radius, a little inflow, an updraft in the
        // core that fades with height so that the leaves rise a couple of metres and spiral down.
        const turn = ((SWIRL_TURN * 2 * q) / (1 + q * q)) * strength;
        vx += (-dz / r) * turn - (dx / r) * 0.25 * turn;
        vz += (dx / r) * turn - (dz / r) * 0.25 * turn;
        vy +=
          SWIRL_LIFT *
          strength *
          Math.exp(-(r * r) / (SWIRL_REACH * SWIRL_REACH)) *
          (1 - smoothstep(1.2, 3.2, y));
      }
    }
    if (this.#blow > 0) {
      // The entrance's gust: a strong push along the wind, buffeting a little.
      vx +=
        this.#blowSign *
        FLURRY_DRIFT *
        this.#blow *
        (0.8 + 0.2 * Math.sin(1.7 * phase + 2 * this.#clock));
      vy += 0.5 * this.#blow * Math.sin(1.3 * this.#clock + 2.1 * phase);
      vz += 0.4 * this.#blow * Math.sin(0.9 * this.#clock + 3.1 * phase);
    }
    if (this.#whirl > 0) {
      // The exit's gust: a harder push, an updraft over the park, and a vortex crossing the path that
      // turns the leaves round its core and throws them up.
      vx +=
        this.#blowSign *
        WHIRL_DRIFT *
        this.#whirl *
        (0.75 + 0.25 * Math.sin(1.7 * phase + 2 * this.#clock));
      vy += WHIRL_UPDRAFT * this.#whirl * (1 - smoothstep(3, 7, y));
      const dx = x - this.#whirlX;
      const dz = z - WHIRL_Z;
      const r = Math.hypot(dx, dz) + 1e-6;
      if (r < 4 * WHIRL_CORE) {
        const q = r / WHIRL_CORE;
        const turn = ((WHIRL_TURN * 2 * q) / (1 + q * q)) * this.#whirl;
        vx += (-dz / r) * turn - (dx / r) * 0.25 * turn;
        vz += (dx / r) * turn - (dz / r) * 0.25 * turn;
        vy +=
          WHIRL_LIFT *
          this.#whirl *
          Math.exp(-(r * r) / (WHIRL_REACH * WHIRL_REACH)) *
          (1 - smoothstep(2.5, 6.5, y));
      }
    }
    this.#air[0] = vx;
    this.#air[1] = vy;
    this.#air[2] = vz;
  }

  // ---- leaves ----------------------------------------------------------------------------------

  #leaves(dt: number, fall: number, season: number): void {
    if (!(dt > 0)) return;
    const rand = this.#rand;
    let inUse = 0;
    let airborne = 0;
    for (let i = 0; i < SLOTS; i++) {
      if (this.#state[i] !== FREE) inUse++;
      if (this.#state[i] === FALLING) airborne++;
    }

    // Let go: at the knob's pace (a Poisson clock), and a gust's shower over its first moments.
    const rate = fall * FALL_RATE * activity(season);
    if (rate > 0 && inUse < AMBIENT_SLOTS) {
      this.#nextLeaf -= dt;
      // There are always a few in the air: when fewer than six are falling, the next lets go soon.
      if (airborne < 6 && this.#nextLeaf > 0.45) this.#nextLeaf = 0.45;
      if (this.#nextLeaf <= 0) {
        this.#spawn(false);
        this.#nextLeaf = -Math.log(1 - 0.999 * rand()) / rate;
      }
    }
    if (this.#shower > 0 && this.#gustAge < GUST_SHAKE + 2 && inUse < AMBIENT_SLOTS) {
      const due =
        this.#gustAge < GUST_SHAKE ? Math.ceil(GUST_SHOWER * (1 - this.#gustAge / GUST_SHAKE)) : 0;
      while (this.#shower > due && this.#spawn(false) >= 0) this.#shower--;
    }
    if (this.#swirlOn && this.#litterOn) this.#pickUp(dt);
    if (this.#exitShower > 0 && inUse < AMBIENT_SLOTS) {
      const due = Math.ceil(
        EXIT_SHOWER * (1 - Math.min(1, this.#exitSeconds / EXIT_SHOWER_SECONDS)),
      );
      while (this.#exitShower > due && this.#spawn(false) >= 0) this.#exitShower--;
    }
    if (this.#whirl > 0 && this.#litterOn) this.#whirlUp(dt);

    for (let i = 0; i < SLOTS; i++) {
      const state = this.#state[i];
      if (state === FALLING) {
        this.#alpha[i] = Math.min(1, at(this.#alpha, i) + dt / FADE_IN);
        this.#fall(i, dt);
      } else if (state === SETTLING) {
        this.#settle(i, dt);
      }
    }
  }

  #freeSlot(): number {
    for (let i = 0; i < SLOTS; i++) if (this.#state[i] === FREE) return i;
    return -1;
  }

  /** A leaf lets go inside the canopy: in screen terms somewhere across its lower reaches, at a depth between the nearest bough and the far side. */
  #spawn(lifted: boolean): number {
    const i = this.#freeSlot();
    if (i < 0) return -1;
    const rand = this.#rand;
    const kind = SPECIES[this.#species] ?? SPECIES[0];
    if (kind === undefined) return -1;
    const { horizon, eye, focal } = AUTUMN_VIEW;
    // A fifth let go close to the viewer, above the frame, and come into it large; the rest higher in
    // the canopy, a little way behind the nearest boughs.
    const z = rand() < 0.22 ? 2.6 + 1.6 * rand() : 4.4 + 6.6 * Math.pow(rand(), 1.2);
    const sx = -1.15 + 2.3 * rand();
    const sy = z < 4.3 ? 1.0 + 0.3 * rand() : 0.64 + 0.45 * rand();
    this.#x[i] = (sx * z) / focal - this.#wind * 1.5;
    this.#y[i] = eye + ((sy - horizon) * z) / focal;
    this.#z[i] = z;
    this.#begin(i, kind, lifted);
    return i;
  }

  /** Fresh plate state for slot i at its position. */
  #begin(i: number, kind: Species, lifted: boolean): void {
    const rand = this.#rand;
    const p = this.#plates;
    this.#state[i] = FALLING;
    this.#lifted[i] = lifted ? 1 : 0;
    const range = rand() < kind.tumbling ? TUMBLE_MASS : FLUTTER_MASS;
    p.mass[i] = lerp(range[0], range[1], rand());
    p.chord[i] = kind.chord * (0.85 + 0.3 * rand());
    p.pace[i] = PACE * (0.9 + 0.2 * rand());
    this.#hue[i] = rand();
    this.#radius[i] =
      kind.radius *
      (0.9 + 0.2 * ((this.#hue[i] ?? 0) * 7.3 - Math.floor((this.#hue[i] ?? 0) * 7.3)));
    this.#seed[i] = rand();
    p.psi[i] = rand() * TAU;
    p.dpsi[i] = (rand() - 0.5) * 0.5;
    p.start(i);
    p.th[i] = (rand() - 0.5) * 1.2;
    p.sigma[i] = rand() * TAU;
    p.dsigma[i] = (rand() - 0.5) * 0.9;
    p.roll[i] = rand() * TAU;
    p.rollRate[i] = 1.0 + 1.4 * rand();
    this.#phase[i] = rand() * TAU;
    this.#lain[i] = 0;
    p.rest[i] = (rand() - 0.5) * 0.1;
    this.#alpha[i] = lifted ? 1 : 0;
  }

  /** Flutter or tumble down: the plate in its plane, the plane turning, the air where it starts the step carrying it. */
  #fall(i: number, dt: number): void {
    this.#airAt(i, at(this.#x, i), at(this.#y, i), at(this.#z, i));
    const air = this.#air;
    const pos = this.#pos;
    pos[0] = at(this.#x, i);
    pos[1] = at(this.#z, i);
    pos[2] = at(this.#y, i);
    const landed = this.#plates.fly(i, dt, pos, air[0] ?? 0, air[2] ?? 0, air[1] ?? 0, this.#floor);
    const x = pos[0] ?? 0;
    const z = pos[1] ?? 0;
    this.#x[i] = x;
    this.#y[i] = Math.min(pos[2] ?? 0, 12);
    this.#z[i] = z;
    if (x < -40 || x > 40 || z < 1.5 || z > 60) {
      this.#state[i] = FREE;
      return;
    }
    if (landed) {
      this.#state[i] = SETTLING;
      this.#plates.touchDown(i);
      this.#lain[i] = 0;
    }
  }

  /** Down: ease flat (face up or face down, whichever is nearer), then lie in the carpet. */
  #settle(i: number, dt: number): void {
    const p = this.#plates;
    const lain = at(this.#lain, i) + dt;
    this.#lain[i] = lain;
    const k = smoothstep(0, SETTLE_SECONDS, lain);
    p.settle(i, k);
    p.sigma[i] = at(p.sigma, i) + at(p.dsigma, i) * dt * (1 - k);
    this.#y[i] = LEAF_LIFT;
    if (lain < SETTLE_SECONDS) return;
    this.#orient(i);
    const f = this.#frame;
    this.#carpet.deposit(
      at(this.#x, i),
      at(this.#z, i),
      Math.atan2(f[1] ?? 0, f[0] ?? 1),
      at(this.#hue, i),
      (f[8] ?? 1) >= 0 ? 1 : -1,
      this.#rand,
    );
    this.#state[i] = FREE;
  }

  /**
   * Leaf i's frame into #frame (FlutterPlates.orient, each axis (x, z, y)): its chord axis (0..2), its
   * span axis (3..5) and the upward plate normal (6..8), its rock fading as it settles.
   */
  #orient(i: number): void {
    const settle =
      this.#state[i] === SETTLING ? 1 - smoothstep(0, SETTLE_SECONDS, at(this.#lain, i)) : 1;
    this.#plates.orient(i, settle, this.#frame);
  }

  /** A swirl passing over the path lifts leaves off it: plates stood up from the carpet, in the pose they lay in. */
  #pickUp(dt: number): void {
    this.#swirlPickup += dt * 30;
    let lifted = 0;
    for (let i = 0; i < SLOTS; i++) if (this.#lifted[i] === 1 && this.#state[i] !== FREE) lifted++;
    const rand = this.#rand;
    const strength =
      smoothstep(0, 2, this.#gustAge) *
      (1 - smoothstep(SWIRL_LIFE - 5, SWIRL_LIFE - 2, this.#gustAge));
    while (this.#swirlPickup >= 1) {
      this.#swirlPickup -= 1;
      if (lifted >= SWIRL_LEAVES || strength <= 0.1) continue;
      const r = SWIRL_PICKUP * Math.sqrt(rand());
      const a = rand() * TAU;
      const x = this.#swirlX + r * Math.cos(a);
      const z = this.#swirlZ + r * Math.sin(a);
      const found = this.#carpet.take(x, z);
      if (found === undefined) continue;
      if (!this.#launch(found)) return;
      lifted++;
    }
  }

  /** The exit's whirl lifts leaves off the carpet round its core, as the swirl does but harder and wider. */
  #whirlUp(dt: number): void {
    this.#whirlPickup += dt * WHIRL_RATE;
    let lifted = 0;
    for (let i = 0; i < SLOTS; i++) if (this.#lifted[i] === 1 && this.#state[i] !== FREE) lifted++;
    const rand = this.#rand;
    while (this.#whirlPickup >= 1) {
      this.#whirlPickup -= 1;
      if (lifted >= WHIRL_LEAVES || this.#whirl <= 0.15) continue;
      const r = WHIRL_PICKUP * Math.sqrt(rand());
      const a = rand() * TAU;
      const found = this.#carpet.take(this.#whirlX + r * Math.cos(a), WHIRL_Z + r * Math.sin(a));
      if (found === undefined) continue;
      if (!this.#launch(found)) return;
      lifted++;
    }
  }

  /** Stand a leaf taken off the carpet up as a plate in a free slot, in the pose it lay in: the chord axis along its heading, the face as it lay. False when no slot is free. */
  #launch(found: LitterItem): boolean {
    const rand = this.#rand;
    const slot = this.#freeSlot();
    if (slot < 0) return false;
    const kind = SPECIES[this.#species] ?? SPECIES[0];
    if (kind === undefined) return false;
    this.#x[slot] = found.x;
    this.#y[slot] = LEAF_LIFT + 0.02;
    this.#z[slot] = found.z;
    this.#begin(slot, kind, true);
    this.#hue[slot] = found.hue;
    this.#radius[slot] =
      kind.radius * (0.9 + 0.2 * (found.hue * 7.3 - Math.floor(found.hue * 7.3)));
    const p = this.#plates;
    const down = found.face < 0;
    p.th[slot] = down ? Math.PI : 0;
    p.psi[slot] = rand() * TAU;
    p.sigma[slot] = down ? at(p.psi, slot) + Math.PI - found.angle : found.angle - at(p.psi, slot);
    p.roll[slot] = 0;
    p.rollRate[slot] = 1.4 + 1.4 * rand();
    return true;
  }

  // ---- the piles (the rake's host) ----------------------------------------------------------------

  /** The live pile within PILE_MERGE of (x, z), if any. */
  pileNear(x: number, z: number): Pile | undefined {
    for (const pile of this.piles)
      if (pile.live && Math.hypot(pile.x - x, pile.z - z) < PILE_MERGE) return pile;
    return undefined;
  }

  /** A fresh pile at ground point (x, z) by the path, in a free slot; none off the path or with every slot in use. */
  startPile(x: number, z: number): Pile | undefined {
    if (Math.abs(x - autumnPathX(z)) > AUTUMN_PATH.half + PILE_OFF_PATH) return undefined;
    const pile = this.piles.find((free) => !free.live);
    if (pile === undefined) return undefined;
    pile.live = true;
    pile.x = x;
    pile.z = z;
    pile.under = 0;
    pile.leaves = 0;
    pile.raking = false;
    pile.debt = 0;
    return pile;
  }

  /** Drag the rake from (ax, az) to (bx, bz) (m): the band it passes over raked into `pile`. */
  rake(pile: Pile, ax: number, az: number, bx: number, bz: number): void {
    const radius = pileRadius(pile);
    pile.leaves += this.#carpet.rake(ax, az, bx, bz, STROKE_WIDTH, pile, radius, this.#rand);
  }

  /**
   * Nature's undoing, `dt` seconds of it: where a gust blows over a pile its leaves are lifted, flung
   * up as plates while slots are free and the rest blown down the wind onto the carpet; what lies under
   * a pile rises in place of its top, and a pile blown flat is gone, its ground left to the carpet.
   */
  #scatter(dt: number): void {
    let flying = 0;
    for (let i = 0; i < SLOTS; i++) if (this.#lifted[i] === 1 && this.#state[i] !== FREE) flying++;
    const rand = this.#rand;
    for (const pile of this.piles) {
      if (!pile.live) continue;
      const gust = Math.abs(this.#gustAt(pile.x, pile.z));
      if (gust > SCATTER_FROM && dt > 0) pile.debt += dt * SCATTER_RATE * gust;
      else pile.debt = 0;
      const lifts = Math.floor(pile.debt);
      pile.debt -= lifts;
      const radius = pileRadius(pile);
      for (let n = 0; n < lifts; n++) {
        const found = this.#liftFromPile(pile, radius);
        if (found === undefined) break;
        pile.leaves = Math.max(0, pile.leaves - 1);
        if (flying < SWIRL_LEAVES && this.#launch(found)) {
          flying++;
          continue;
        }
        const blown = this.#gustSign * (0.6 + 2.4 * rand());
        const z = found.z + (rand() - 0.5) * 1.4;
        this.#carpet.deposit(found.x + blown, z, found.angle, found.hue, found.face, rand);
      }
      this.#carpet.heap(pile, radius, rand);
      if (lifts > 0 && !pile.raking && this.#flat(pile, radius)) this.#drop(pile);
    }
  }

  /** The cells round a pile, within about `radius` of its middle, into #box. */
  #around(pile: Pile, radius: number): void {
    const A = AUTUMN_CARPET;
    const reach = Math.ceil(radius / A.cell) + 1;
    this.#box[0] = Math.floor((pile.x - A.x0) / A.cell) - reach;
    this.#box[1] = Math.floor((pile.z - A.z0) / A.cell) - reach;
    this.#box[2] = 2 * reach + 1;
  }

  /** Lift a whole leaf off a pile, from a cell picked at random among its own; undefined when it has none. */
  #liftFromPile(pile: Pile, radius: number): LitterItem | undefined {
    this.#around(pile, radius);
    const [i0 = 0, j0 = 0, side = 0] = this.#box;
    const slots = 2 * side * side;
    const start = Math.floor(this.#rand() * slots);
    for (let k = 0; k < slots; k++) {
      const n = (start + k) % slots;
      const i = i0 + ((n >> 1) % side);
      const j = j0 + Math.floor((n >> 1) / side);
      if (i < 0 || j < 0 || i >= COLS || j >= ROWS) continue;
      const cell = j * COLS + i;
      if (this.#carpet.protect[cell] !== HEAPED) continue;
      const found = this.#carpet.lift((n & 1) * CELLS + cell);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Nothing left of a pile: none heaped under it and no leaf on its cells. */
  #flat(pile: Pile, radius: number): boolean {
    if (pile.under > 0) return false;
    this.#around(pile, radius);
    const [i0 = 0, j0 = 0, side = 0] = this.#box;
    for (let j = Math.max(0, j0); j < Math.min(ROWS, j0 + side); j++)
      for (let i = Math.max(0, i0); i < Math.min(COLS, i0 + side); i++) {
        const cell = j * COLS + i;
        if (this.#carpet.protect[cell] !== HEAPED) continue;
        const goal = this.#carpet.goal;
        if (at(goal, cell) > 0 || at(goal, CELLS + cell) > 0) return false;
      }
    return true;
  }

  /**
   * A pile is gone: its cells and the ground its strokes kept bare go back to the carpet, but for the
   * M's while it lies there and the cells of the piles still standing.
   */
  #drop(pile: Pile): void {
    pile.live = false;
    this.#around(pile, pile.reach + STROKE_WIDTH + 0.5);
    const [i0 = 0, j0 = 0, side = 0] = this.#box;
    const carpet = this.#carpet;
    const A = AUTUMN_CARPET;
    for (let j = Math.max(0, j0); j < Math.min(ROWS, j0 + side); j++)
      for (let i = Math.max(0, i0); i < Math.min(COLS, i0 + side); i++) {
        const cell = j * COLS + i;
        const protect = carpet.protect[cell];
        if (protect === CLEARED) {
          const mark = this.#strokeCells.includes(cell) || this.#marginCells.includes(cell);
          if (!(this.#markShown > 0 && mark)) carpet.protect[cell] = 0;
        } else if (protect === HEAPED) {
          const x = A.x0 + (i + 0.5) * A.cell;
          const z = A.z0 + (j + 0.5) * A.cell;
          let held = false;
          for (const other of this.piles)
            if (other.live && Math.hypot(other.x - x, other.z - z) < pileRadius(other) + A.cell)
              held = true;
          if (!held) carpet.protect[cell] = 0;
        }
      }
  }

  // ---- the carpet --------------------------------------------------------------------------------

  /** The sweep: visit cells in turn and let the carpet drift toward the season's density, a leaf fading in or out now and then. */
  #sweep(real: number): void {
    this.#hurry = Math.max(0, this.#hurry - real);
    this.#scanDebt += real * SCAN_RATE;
    const visits = Math.min(Math.floor(this.#scanDebt), 4000);
    this.#scanDebt -= visits;
    const add = this.#hurry > 0 ? HURRY_CHANCE : ADD_CHANCE;
    const remove = this.#hurry > 0 ? HURRY_CHANCE : REMOVE_CHANCE;
    this.#carpet.tend(visits, add, remove, this.#wants, this.#rand);
  }

  /** Step the fading leaves a level toward their goals every LEVEL_EVERY seconds. */
  #fade(real: number): void {
    this.#fadeClock += real;
    if (this.#fadeClock < LEVEL_EVERY) return;
    this.#fadeClock = 0;
    this.#carpet.fade();
  }

  /** The M: gold leaves swept together cell by cell under its strokes, the cells round it cleared; or scattered again. */
  #gather(real: number): void {
    const total = this.#strokeCells.length;
    const target = this.markGoal * total;
    const step = (total / MARK_SECONDS) * real;
    const before = this.#markShown;
    this.#markShown =
      target > before ? Math.min(target, before + step) : Math.max(target, before - step);
    const from = Math.floor(before);
    const to = Math.floor(this.#markShown);
    const starting = before === 0 && this.#markShown > 0;
    const ending = before > 0 && this.#markShown === 0;
    if (to === from && !starting && !ending) return;
    const rand = this.#rand;
    const carpet = this.#carpet;
    if (starting) {
      // Sweeping starts: the ring round the M is cleared, and kept clear.
      for (const cell of this.#marginCells) {
        carpet.protect[cell] = CLEARED;
        for (let layer = 0; layer < 2; layer++) {
          const idx = layer * CELLS + cell;
          if (at(carpet.goal, idx) > 0) carpet.release(idx);
        }
      }
    }
    for (let k = from; k < to; k++) {
      const cell = this.#strokeCells[k];
      if (cell === undefined) continue;
      carpet.protect[cell] = PINNED;
      for (let layer = 0; layer < 2; layer++)
        carpet.place(layer * CELLS + cell, rand(), rand(), rand(), 0, true, 0, LEVELS, rand);
    }
    for (let k = from - 1; k >= to; k--) {
      const cell = this.#strokeCells[k];
      if (cell === undefined) continue;
      carpet.protect[cell] = CLEARED;
      for (let layer = 0; layer < 2; layer++) carpet.release(layer * CELLS + cell);
    }
    if (this.#markShown === 0) {
      for (const cell of this.#marginCells) carpet.protect[cell] = 0;
      for (const cell of this.#strokeCells) carpet.protect[cell] = 0;
    }
  }

  // ---- upload ------------------------------------------------------------------------------------

  /** The leaves into the maple's row, and the carpet up (at most UPLOAD_EVERY_MS apart on the frame's wall clock). */
  #pack(frame: LayerFrame): void {
    const { horizon, eye, focal } = AUTUMN_VIEW;
    const data = frame.records.data;
    for (let i = 0; i < SLOTS; i++) {
      const o = i * 16;
      if (this.#state[i] === FREE) {
        data.fill(0, o, o + 16);
        continue;
      }
      this.#orient(i);
      const f = this.#frame;
      const x = at(this.#x, i);
      const y = at(this.#y, i);
      const z = at(this.#z, i);
      const scale = focal / z;
      const wx = x / z;
      const wy = (y - eye) / z;
      data[o] = x * scale;
      data[o + 1] = horizon + (y - eye) * scale;
      data[o + 2] = at(this.#radius, i) * scale;
      data[o + 3] = at(this.#alpha, i);
      // The axes with the view's perspective folded in: a point `a` along an axis moves its screen
      // image by (ax - wx az, ay - wy az) times the scale. The frame's axes are (x, z, y).
      data[o + 4] = (f[0] ?? 0) - wx * (f[1] ?? 0);
      data[o + 5] = (f[2] ?? 0) - wy * (f[1] ?? 0);
      data[o + 6] = (f[3] ?? 0) - wx * (f[4] ?? 0);
      data[o + 7] = (f[5] ?? 0) - wy * (f[4] ?? 0);
      data[o + 8] = f[6] ?? 0;
      data[o + 9] = f[8] ?? 1;
      data[o + 10] = f[7] ?? 0;
      data[o + 11] = z;
      data[o + 12] = at(this.#hue, i);
      data[o + 13] = at(this.#seed, i);
      data[o + 14] = 0;
      data[o + 15] = 0;
    }
    frame.records.touch();

    if (this.#carpet.dirty && frame.now - this.#uploadedAt >= UPLOAD_EVERY_MS) {
      this.carpetA.upload(this.#carpet.layers[0]);
      this.carpetB.upload(this.#carpet.layers[1]);
      this.#carpet.dirty = false;
      this.#uploadedAt = frame.now;
    }
  }
}

/** The litter: the Park's carpet as its two fields, the M's goal handed to the Park, the Park lent to the rake. */
class LitterSim implements LayerSim {
  readonly #knobs: KnobReader<"litterMark">;
  readonly #markSlot: number;
  /** Seconds a "now" keeps the M gathered yet. */
  #hold = 0;
  /** The Park under it (the maple's), once seen: what the rake works through. */
  affordances?: Park;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("litter", params, ["litterMark"]);
    this.#markSlot = this.#knobs.trigger("litterMark");
  }

  frame(frame: LayerFrame): void {
    const park = frame.host("maple");
    if (!(park instanceof Park)) return;
    this.affordances = park;
    if (frame.fired[this.#markSlot]) this.#hold = MARK_HOLD;
    this.#hold = Math.max(0, this.#hold - clamp(frame.dt, 0, 0.1));
    park.markGoal = this.#knobs.value(frame, "litterMark") > 0 || this.#hold > 0 ? 1 : 0;
    const [a, b] = frame.fields;
    if (a !== undefined) a.texture = park.carpetA.texture;
    if (b !== undefined) b.texture = park.carpetB.texture;
  }

  dispose(): void {}
}

/** The rake's plan for one of the Park's piles: strokes begun (of STROKES), and the one under way. */
interface Plan {
  strokes: number;
  /** Seconds into the stroke under way; below 0 while none is. */
  t: number;
  /** Where the rake's head was at the end of the last frame (m). */
  headX: number;
  headZ: number;
}

/** The rake, the agents' chore: their presses by the path set strokes going, each raking into a pile. */
class RakeSim implements LayerSim {
  readonly #knobs: KnobReader<"rake">;
  readonly #plans: readonly Plan[] = Array.from({ length: PILES }, () => ({
    strokes: 0,
    t: -1,
    headX: 0,
    headZ: 0,
  }));
  readonly #interest: ScenePoint[] = [];
  readonly #points: { x: number; y: number }[] = Array.from({ length: PILES + 3 }, () => ({
    x: 0,
    y: 0,
  }));
  /** A ground point (x, z), m, written by #groundAt and #strokeHead. */
  readonly #hit = new Float64Array(2);
  #park: Park | undefined;
  /** How far out the strokes set off (m), and the agents there last frame. */
  #reach = REACH_MIN;
  #agents = 0;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("rake", params, ["rake"]);
  }

  frame(frame: LayerFrame): void {
    const park = frame.host("litter");
    if (!(park instanceof Park)) return;
    this.#park = park;
    this.#reach = REACH_MIN + REACH_RANGE * this.#knobs.value(frame, "rake");
    this.#agents = 0;
    for (const hand of frame.principals) if (hand.kind === "agent") this.#agents++;
    if (frame.passage.enter >= 1 && frame.passage.exit <= 0) this.#presses(frame, park);
    this.#rake(clamp(frame.dt, 0, 0.1) * frame.motion, park);
  }

  /**
   * Where the agents go to work, in screen uv: the piles under way, and a fresh station along the path
   * for each agent beyond them (none while the M lies there), so each pile is finished before the
   * next is begun.
   */
  interest(aspect: number): readonly ScenePoint[] {
    const points = this.#interest;
    points.length = 0;
    const park = this.#park;
    if (park === undefined) return points;
    park.piles.forEach((pile, k) => {
      if (pile.live && (this.#plans[k]?.strokes ?? 0) < STROKES.length)
        this.#point(pile.x, pile.z, aspect);
    });
    if (park.markShown) return points;
    let fresh = Math.max(1, this.#agents) - points.length;
    for (let k = 0; k < PILE_STATIONS.length && fresh > 0; k++) {
      const z = PILE_STATIONS[k] ?? 0;
      const x = autumnPathX(z) + (k % 2 === 0 ? PILE_SIDE : -PILE_SIDE);
      if (park.pileNear(x, z) !== undefined) continue;
      this.#point(x, z, aspect);
      fresh--;
    }
    return points;
  }

  /** Taken off, the rake leaves no stroke under way. */
  dispose(): void {
    for (const pile of this.#park?.piles ?? []) pile.raking = false;
  }

  /** Ground point (x, z) (m) as the screen sees it at rest, onto the interest list. */
  #point(x: number, z: number, aspect: number): void {
    const point = this.#points[this.#interest.length];
    if (point === undefined) return;
    const { horizon, eye, focal } = AUTUMN_VIEW;
    point.x = 0.5 + (x * focal) / (z * Math.max(aspect, AUTUMN_WIDE));
    point.y = horizon - (eye * focal) / z;
    this.#interest.push(point);
  }

  /** Where screen point (u, v) meets the ground at rest, into #hit: false above the horizon or off the carpet. */
  #groundAt(u: number, v: number, aspect: number): boolean {
    const { horizon, eye, focal } = AUTUMN_VIEW;
    const drop = horizon - v;
    if (!(drop > 1e-3)) return false;
    const z = (eye * focal) / drop;
    const x = ((u - 0.5) * Math.max(aspect, AUTUMN_WIDE) * z) / focal;
    const A = AUTUMN_CARPET;
    if (x < A.x0 || z < A.z0 || x >= A.x0 + COLS * A.cell || z >= A.z0 + ROWS * A.cell)
      return false;
    this.#hit[0] = x;
    this.#hit[1] = z;
    return true;
  }

  /** The agents' presses on the ground by the path: each sets the next stroke of the pile there going, or starts a pile. */
  #presses(frame: LayerFrame, park: Park): void {
    for (const hand of frame.principals) {
      if (hand.kind !== "agent" || !hand.inside || !hand.pressed) continue;
      if (!this.#groundAt(hand.x, hand.y, frame.aspect)) continue;
      const x = this.#hit[0] ?? 0;
      const z = this.#hit[1] ?? 0;
      let pile = park.pileNear(x, z);
      if (pile === undefined) {
        pile = park.startPile(x, z);
        if (pile === undefined) continue;
        const fresh = this.#plans[park.piles.indexOf(pile)];
        if (fresh !== undefined) {
          fresh.strokes = 0;
          fresh.t = -1;
        }
      }
      const plan = this.#plans[park.piles.indexOf(pile)];
      if (plan === undefined || plan.t >= 0 || plan.strokes >= STROKES.length) continue;
      plan.strokes++;
      plan.t = 0;
      pile.raking = true;
      pile.reach = this.#reach;
      this.#strokeHead(pile, plan, 0);
      plan.headX = this.#hit[0] ?? 0;
      plan.headZ = this.#hit[1] ?? 0;
    }
  }

  /**
   * The head of `pile`'s stroke under way, `e` (0..1) of the way along its run, into #hit: from the
   * stroke's reach up or down the path (and its offset across) in to the pile's edge, closing in on
   * its middle.
   */
  #strokeHead(pile: Pile, plan: Plan, e: number): void {
    const [side, across] = STROKES[plan.strokes - 1] ?? [1, 0];
    // The path's way at the pile, along (ax, az) and across (az, -ax).
    const slope = autumnPathX(pile.z + 0.5) - autumnPathX(pile.z - 0.5);
    const length = Math.hypot(slope, 1);
    const ax = slope / length;
    const az = 1 / length;
    const along = side * lerp(pile.reach, pileRadius(pile), e);
    const off = across * (1 - 0.6 * e);
    this.#hit[0] = pile.x + ax * along + az * off;
    this.#hit[1] = pile.z + az * along - ax * off;
  }

  /** The strokes under way, `dt` seconds on: each head moves on, raking the band it passes over into its pile. */
  #rake(dt: number, park: Park): void {
    if (!(dt > 0)) return;
    park.piles.forEach((pile, k) => {
      const plan = this.#plans[k];
      if (!pile.live || plan === undefined || plan.t < 0) return;
      plan.t = Math.min(STROKE_SECONDS, plan.t + dt);
      const u = plan.t / STROKE_SECONDS;
      this.#strokeHead(pile, plan, u * u * (3 - 2 * u));
      const x = this.#hit[0] ?? 0;
      const z = this.#hit[1] ?? 0;
      park.rake(pile, plan.headX, plan.headZ, x, z);
      plan.headX = x;
      plan.headZ = z;
      if (plan.t >= STROKE_SECONDS) {
        plan.t = -1;
        pile.raking = false;
      }
    });
  }
}

/** The maple's sim: the Park. */
export function mapleSim(gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new Park(gl, params);
}

/** The litter's sim. */
export function litterSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new LitterSim(params);
}

/** The rake's sim. */
export function rakeSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new RakeSim(params);
}
