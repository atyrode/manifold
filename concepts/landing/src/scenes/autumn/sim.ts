// An autumn park: the leaves of the great tree let go, fall as the flat plates they are, and lie.
//
// Falling leaves are rigid plates in a vertical plane (Andersen, Pesavento & Wang, "Unsteady
// aerodynamics of fluttering and tumbling plates", J. Fluid Mech. 541, 2005: the quasi-steady model
// with added mass, circulation lift, quadratic drag and a rotational damping torque, as the garden
// scene integrates it). Light leaves flutter, swinging from side to side and gliding up at the end of
// each swing; heavier ones tumble end over end. Each leaf's plane turns slowly, the leaf rocks about
// its chord and spins in its own plane, and the wind, the gusts and the swirl of a gust carry it. A
// leaf that touches down eases flat (face up or face down, whichever is nearer) and is then handed to
// the carpet.
//
// The carpet is the accumulation (the shared ground-litter lattice, sims/litter.ts): 0.3 m cells over
// the ground in two layers (the second shifted half a cell and lying beneath), each cell holding at
// most one leaf: its offset inside the cell, its angle, its colour, which face is up, and a fade level.
// Landed leaves are written there; a slow sweep over the lattice lets the carpet settle toward the
// season's density (more leaves as the season runs on, more under the tree, fewer on the path) by
// fading leaves in and out; a gust's swirl lifts the leaves lying on top off the path and sets them
// flying again. The Manifold M is leaves swept together into a road-marking M along the path (the cells
// under its strokes fill with gold leaves, the cells round them are cleared).
//
// The scene's passage (layout.ts AUTUMN_PASSAGE) is played here too: as it comes in a gust blows a flurry of
// leaves in from beyond the windward edge of the frame, and as it leaves a stronger gust and a vortex lift
// leaves off the carpet and whirl them up across the frame, with a shower from the canopy. At rest none of
// it runs.
//
// Uploads (all rgba16f, nearest):
//   uSim0  4 x AUTUMN_SLOTS  one row per leaf, four texels:
//          (x, y, radius, alpha)  screen position from the horizon's centre and radius, in screen heights;
//          (tx, ty, sx, sy)       the plate's two in-plane axes projected on the screen (perspective kept),
//                                 so screen offset = radius * (lx * s + ly * t) for leaf-local (lx, ly);
//          (nx, ny, nz, z)        the upward plate normal in the world, and the depth in metres;
//          (hue, seed, 0, 0)
//   uSim1  carpet layer A, uSim2 carpet layer B: AUTUMN_CARPET.cols x rows, one cell per texel:
//          (ox, oz, angle, w): the leaf's offset in cell units, its tip's heading in the ground plane
//          (atan2(dz, dx)), and w = face * (level + 16 * isMark + 0.98 * hue), face +1 top up, -1 top
//          down, level 1..8 (alpha = level / 8), 0 for no leaf.
//   uSim3  2 x 1: (gust, swirl x, swirl z, swirl strength), (M gathered 0..1, 0, 0, 0).
import { markDistance } from "../../mark.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { CLEARED, Litter, PINNED, type LitterItem } from "../../sims/litter.ts";
import { clamp, hash31, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { DataTexture } from "../../sims/texture.ts";
import type { SceneSim, SimFactory, SimFrame } from "../types.ts";
import { AUTUMN_CARPET, AUTUMN_MARK, AUTUMN_PASSAGE, AUTUMN_PATH, AUTUMN_SLOTS, AUTUMN_TREE, AUTUMN_VIEW, AUTUMN_WHIRL, autumnFlurry, autumnPathX } from "./layout.ts";

type Knob = "species" | "fall" | "gusts" | "season" | "wind" | "mark" | "parkSeed";
const KNOBS: readonly Knob[] = ["species", "fall", "gusts", "season", "wind", "mark", "parkSeed"];

const TAU = Math.PI * 2;
const SLOTS = AUTUMN_SLOTS;
const COLS = AUTUMN_CARPET.cols;
const ROWS = AUTUMN_CARPET.rows;
const CELLS = COLS * ROWS;

// ---- the plate model -----------------------------------------------------------------------------

// In units of the plate's chord, the air's density and gravity: C_T = 1.2, C_R = pi, drag A = 1.4,
// B = 1.0, the added masses of a thin ellipse, and a weak damping torque (which lets light plates
// flutter widely and heavy ones tumble).
const PLATE_CT = 1.2;
const PLATE_CR = Math.PI;
const PLATE_A = 1.4;
const PLATE_B = 1.0;
const PLATE_MU = 0.02;
const PLATE_M11 = 0.02;
const PLATE_M22 = Math.PI / 4;
const PLATE_IA = Math.PI / 128;
/** Model time per substep (stable to ~0.06 with the midpoint rule). */
const PLATE_STEP = 0.03;

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

/** Wind drift (m/s) at wind = 1; a gust's added drift, its rise time, how long it stays busy. */
const WIND_DRIFT = 1.2;
const GUST_DRIFT = 2.2;
const GUST_RISE = 1.6;
const GUST_BUSY = 16;
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

const at = (array: Float64Array | Float32Array | Uint8Array | Int8Array, index: number): number => array[index] ?? 0;

/** Smooth value noise in two dimensions, 0..1. */
function noise2(x: number, z: number, salt: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = x - i;
  const fz = z - j;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash31(i, j, salt), hash31(i + 1, j, salt), ux), lerp(hash31(i, j + 1, salt), hash31(i + 1, j + 1, salt), ux), uz);
}

/** A gust's strength `age` seconds after it began: rises over GUST_RISE, then dies away (the shader reads it from uSim3). */
function gustAt(age: number): number {
  if (!(age > 0 && age < 12 * GUST_RISE)) return 0;
  const a = age / GUST_RISE;
  return a * a * Math.exp(2 * (1 - a));
}

/** How busy the tree is letting go of leaves along the season (0 early, a long peak, a few stragglers at the end). */
function activity(season: number): number {
  return 0.25 + 0.75 * smoothstep(0, 0.25, season) * (1 - 0.7 * smoothstep(0.75, 1, season));
}

/** The carpet's overall density at the season: a few leaves early on, a thick one at the end. */
function carpetBase(season: number): number {
  return 0.2 + 0.9 * Math.pow(clamp(season, 0, 1), 0.7);
}

class AutumnSim implements SceneSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #gustSlot: number;
  readonly #markSlot: number;

  // The falling leaves, one slot each.
  readonly #state = new Uint8Array(SLOTS);
  readonly #x = new Float64Array(SLOTS);
  readonly #y = new Float64Array(SLOTS);
  readonly #z = new Float64Array(SLOTS);
  /** The plane's azimuth and its slow turn per second. */
  readonly #psi = new Float64Array(SLOTS);
  readonly #dpsi = new Float64Array(SLOTS);
  /** Body-frame velocity along the chord and normal to it, the pitch rate (model units), the pitch. */
  readonly #u = new Float64Array(SLOTS);
  readonly #v = new Float64Array(SLOTS);
  readonly #w = new Float64Array(SLOTS);
  readonly #th = new Float64Array(SLOTS);
  /** The leaf's turn in its own plane and its rate; the rock about the chord and its rate. */
  readonly #sigma = new Float64Array(SLOTS);
  readonly #dsigma = new Float64Array(SLOTS);
  readonly #roll = new Float64Array(SLOTS);
  readonly #rollRate = new Float64Array(SLOTS);
  readonly #mass = new Float64Array(SLOTS);
  readonly #chord = new Float64Array(SLOTS);
  readonly #pace = new Float64Array(SLOTS);
  readonly #radius = new Float64Array(SLOTS);
  readonly #hue = new Float64Array(SLOTS);
  readonly #seed = new Float64Array(SLOTS);
  readonly #alpha = new Float64Array(SLOTS);
  /** Model time not yet stepped; seconds since touchdown; pitch at touchdown; the pitch it rests at; eddy phase. */
  readonly #debt = new Float64Array(SLOTS);
  readonly #lain = new Float64Array(SLOTS);
  readonly #touch = new Float64Array(SLOTS);
  readonly #rest = new Float64Array(SLOTS);
  readonly #phase = new Float64Array(SLOTS);
  /** 1 for a leaf a swirl lifted off the path. */
  readonly #lifted = new Uint8Array(SLOTS);
  readonly #rates = new Float64Array(3);
  /** The air at a leaf (x, y, z) and the plate's frame (t, s, n) written by #orient. */
  readonly #air = new Float64Array(3);
  readonly #frame = new Float64Array(9);
  #rand = mulberry32(1);
  #nextLeaf = 1;
  #clock = 0;
  #species = 0;
  #seedKnob = -1;

  // The weather.
  #gustAge = Infinity;
  #gustSign = 1;
  #gustPower = 0.7;
  #swirlOn = false;
  #swirlSign = -1;
  #swirlZ = 0;
  #swirlX = 0;
  #swirlPickup = 0;
  #shower = 0;
  #nextGust = 25;
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

  // The carpet (sims/litter.ts): layer 0 the lattice on top, layer 1 the shifted one beneath.
  readonly #carpet = new Litter(AUTUMN_CARPET, LEVELS);
  /** Per cell: the shape of the carpet's density. */
  readonly #shape = new Float32Array(CELLS);
  readonly #carpetA: DataTexture;
  readonly #carpetB: DataTexture;
  #uploadedAt = -Infinity;
  #fadeClock = 0;
  #scanDebt = 0;
  #season = -1;
  #base = 0;
  #hurry = 0;

  // The M.
  readonly #strokeCells: number[] = [];
  readonly #marginCells: number[] = [];
  #markShown = 0;
  #markHold = 0;
  #markGoal = 0;

  readonly #leafData = new Float32Array(SLOTS * 4 * 4);
  readonly #leafTexture: DataTexture;
  readonly #stateData = new Float32Array(2 * 4);
  readonly #stateTexture: DataTexture;
  readonly #textures: readonly (WebGLTexture | undefined)[];

  constructor(gl: WebGL2RenderingContext, params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("autumn", params, KNOBS);
    this.#gustSlot = this.#knobs.trigger("gusts");
    this.#markSlot = this.#knobs.trigger("mark");
    this.#leafTexture = new DataTexture(gl, { width: 4, height: SLOTS, format: "rgba16f", filter: "nearest" });
    this.#carpetA = new DataTexture(gl, { width: COLS, height: ROWS, format: "rgba16f", filter: "nearest" });
    this.#carpetB = new DataTexture(gl, { width: COLS, height: ROWS, format: "rgba16f", filter: "nearest" });
    this.#stateTexture = new DataTexture(gl, { width: 2, height: 1, format: "rgba16f", filter: "nearest" });
    this.#textures = [this.#leafTexture.texture, this.#carpetA.texture, this.#carpetB.texture, this.#stateTexture.texture];
    this.#layOut(this.#knobs.initial("parkSeed"), this.#knobs.initial("season"), this.#knobs.initial("species"));
  }

  frame(frame: SimFrame): readonly (WebGLTexture | undefined)[] {
    const knobs = this.#knobs;
    const seed = Math.round(knobs.value(frame, "parkSeed"));
    const season = clamp(knobs.value(frame, "season"), 0, 1);
    const species = Math.round(knobs.value(frame, "species"));
    this.#wind = knobs.value(frame, "wind");
    if (seed !== this.#seedKnob) this.#layOut(seed, season, species);
    this.#species = clamp(species, 0, SPECIES.length - 1);

    const real = clamp(frame.dt, 0, 0.1);
    const enter = clamp(frame.passage.enter, 0, 1);
    const exit = clamp(frame.passage.exit, 0, 1);
    this.#passage(frame.aspect, enter, exit);
    if (frame.fired[this.#gustSlot]) this.#startGust(true, knobs.amount(frame, "gusts"));
    if (frame.fired[this.#markSlot]) this.#markHold = MARK_HOLD;
    const busy = this.#gustAge < GUST_BUSY;
    // A passage plays in real time whatever the motion, like a gust.
    const dt = real * Math.max(frame.motion, busy || enter < 1 || exit > 0 ? 1 : 0);
    this.#clock += dt;

    // Gusts come now and then on their own while the feature is on: the busier, the oftener.
    const gusts = knobs.value(frame, "gusts");
    if (gusts > 0 && dt > 0) {
      this.#nextGust -= dt;
      if (this.#nextGust <= 0) this.#startGust(this.#rand() < 0.6, gusts);
    }
    if (this.#gustAge < GUST_BUSY + 6) this.#gustAge += dt;
    this.#swirlOn = this.#swirlOn && this.#gustAge < SWIRL_LIFE;
    if (this.#swirlOn) {
      this.#swirlZ += this.#swirlSign * SWIRL_SPEED * dt;
      this.#swirlX = autumnPathX(this.#swirlZ) + 0.6 * Math.sin(0.5 * this.#gustAge);
    }

    this.#leaves(dt, knobs.value(frame, "fall"), season);

    if (season !== this.#season) this.#changeSeason(season);
    this.#markHold = Math.max(0, this.#markHold - real);
    this.#markGoal = knobs.value(frame, "mark") > 0 || this.#markHold > 0 ? 1 : 0;
    this.#gather(real);
    this.#sweep(real);
    this.#fade(real);
    this.#pack();
    return this.#textures;
  }

  dispose(): void {
    this.#leafTexture.dispose();
    this.#carpetA.dispose();
    this.#carpetB.dispose();
    this.#stateTexture.dispose();
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
    this.#markShown = 0;
    this.#season = season;
    this.#base = carpetBase(season);

    const A = AUTUMN_CARPET;
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const x = A.x0 + (i + 0.5) * A.cell;
        const z = A.z0 + (j + 0.5) * A.cell;
        const path = 1 - smoothstep(AUTUMN_PATH.half * 0.8, AUTUMN_PATH.half * 1.3, Math.abs(x - autumnPathX(z)));
        const dx = x - AUTUMN_TREE.canopyX;
        const dz = z - AUTUMN_TREE.canopyZ;
        const tree = Math.exp(-(dx * dx + dz * dz) / (2 * 5.5 * 5.5));
        const drift = noise2(x * 0.28, z * 0.28, seed + 11);
        // Leaves lie thickest under the tree and gather along the edges of the path.
        const edge = (Math.abs(x - autumnPathX(z)) - AUTUMN_PATH.half) / 0.8;
        this.#shape[j * COLS + i] = ((0.75 + 0.9 * tree) * (1 - 0.3 * path) + 0.55 * Math.exp(-edge * edge)) * (0.7 + 0.6 * drift);
      }
    }
    for (let cell = 0; cell < CELLS; cell++) {
      for (let layer = 0; layer < 2; layer++) {
        if (this.#wants(cell, layer)) this.#carpet.place(layer * CELLS + cell, rand(), rand(), rand(), rand(), false, LEVELS, LEVELS, rand);
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
        const d = markDistance((x - AUTUMN_MARK.x) / unitX, (z - AUTUMN_MARK.z) / AUTUMN_MARK.depth);
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

    // Leaves already on their way down, caught in their swing.
    for (let n = 0; n < PREWARM_FALLING; n++) {
      const i = this.#spawn(false);
      if (i < 0) break;
      this.#alpha[i] = 1;
      const seconds = 1.5 + 3.5 * rand();
      for (let t = 0; t < seconds && this.#state[i] === FALLING; t += 0.05) this.#fall(i, 0.05);
    }
    this.#nextLeaf = 0.5 + 1.5 * rand();
    this.#nextGust = 20 + 15 * rand();
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
    this.#blowSign = this.#wind < -0.05 ? -1 : 1;
    if (!this.#entered) {
      this.#entered = true;
      if (enter < 1) this.#startFlurry(aspect > 0 ? aspect : 16 / 9);
    }
    this.#blow = enter < 1 ? autumnFlurry(enter * AUTUMN_PASSAGE.enter) : 0;
    this.#whirl = exit > 0 ? smoothstep(0, AUTUMN_WHIRL.rise, exit) : 0;
    if (exit > 0) {
      this.#exitSeconds = exit * AUTUMN_PASSAGE.exit;
      this.#whirlX = autumnPathX(WHIRL_Z) + this.#blowSign * (WHIRL_SPEED * this.#exitSeconds - WHIRL_FROM);
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
    const half = 0.5 * Math.max(aspect, 1.45);
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

  /** A gust begins: a push along the wind, a shower from the tree and (often) a swirl up the path. */
  #startGust(swirl: boolean, amount: number): void {
    const rand = this.#rand;
    this.#gustAge = 0;
    this.#gustSign = this.#wind < -0.05 ? -1 : 1;
    this.#gustPower = 0.55 + 0.45 * clamp(amount, 0, 1);
    this.#shower = GUST_SHOWER;
    this.#nextGust = (45 / (0.4 + 1.2 * clamp(amount, 0, 1))) * (0.6 + 0.8 * rand());
    this.#swirlOn = swirl;
    this.#swirlPickup = 0;
    if (swirl) {
      this.#swirlSign = rand() < 0.6 ? -1 : 1;
      this.#swirlZ = this.#swirlSign < 0 ? 17 : 6.5;
      this.#swirlX = autumnPathX(this.#swirlZ);
    }
  }

  /** The air at (x, y, z) for leaf i: the wind, a gust, slow eddies and the swirl, written to #air. */
  #airAt(i: number, x: number, y: number, z: number): void {
    const phase = at(this.#phase, i);
    const gust = gustAt(this.#gustAge) * this.#gustPower * this.#gustSign;
    let vx = this.#wind * WIND_DRIFT + gust * GUST_DRIFT + 0.3 * Math.sin(0.9 * this.#clock + phase);
    let vy = 0.12 * Math.sin(0.7 * this.#clock + 1.7 * phase);
    let vz = 0.2 * Math.sin(0.6 * this.#clock + 2.3 * phase) - 0.15 * Math.abs(gust);
    if (this.#swirlOn) {
      const strength = smoothstep(0, 2, this.#gustAge) * (1 - smoothstep(SWIRL_LIFE - 4, SWIRL_LIFE, this.#gustAge)) * this.#gustPower;
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
        vy += SWIRL_LIFT * strength * Math.exp(-(r * r) / (SWIRL_REACH * SWIRL_REACH)) * (1 - smoothstep(1.2, 3.2, y));
      }
    }
    if (this.#blow > 0) {
      // The entrance's gust: a strong push along the wind, buffeting a little.
      vx += this.#blowSign * FLURRY_DRIFT * this.#blow * (0.8 + 0.2 * Math.sin(1.7 * phase + 2 * this.#clock));
      vy += 0.5 * this.#blow * Math.sin(1.3 * this.#clock + 2.1 * phase);
      vz += 0.4 * this.#blow * Math.sin(0.9 * this.#clock + 3.1 * phase);
    }
    if (this.#whirl > 0) {
      // The exit's gust: a harder push, an updraft over the park, and a vortex crossing the path that
      // turns the leaves round its core and throws them up.
      vx += this.#blowSign * WHIRL_DRIFT * this.#whirl * (0.75 + 0.25 * Math.sin(1.7 * phase + 2 * this.#clock));
      vy += WHIRL_UPDRAFT * this.#whirl * (1 - smoothstep(3, 7, y));
      const dx = x - this.#whirlX;
      const dz = z - WHIRL_Z;
      const r = Math.hypot(dx, dz) + 1e-6;
      if (r < 4 * WHIRL_CORE) {
        const q = r / WHIRL_CORE;
        const turn = ((WHIRL_TURN * 2 * q) / (1 + q * q)) * this.#whirl;
        vx += (-dz / r) * turn - (dx / r) * 0.25 * turn;
        vz += (dx / r) * turn - (dz / r) * 0.25 * turn;
        vy += WHIRL_LIFT * this.#whirl * Math.exp(-(r * r) / (WHIRL_REACH * WHIRL_REACH)) * (1 - smoothstep(2.5, 6.5, y));
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
      const due = this.#gustAge < GUST_SHAKE ? Math.ceil(GUST_SHOWER * (1 - this.#gustAge / GUST_SHAKE)) : 0;
      while (this.#shower > due && this.#spawn(false) >= 0) this.#shower--;
    }
    if (this.#swirlOn) this.#pickUp(dt);
    if (this.#exitShower > 0 && inUse < AMBIENT_SLOTS) {
      const due = Math.ceil(EXIT_SHOWER * (1 - Math.min(1, this.#exitSeconds / EXIT_SHOWER_SECONDS)));
      while (this.#exitShower > due && this.#spawn(false) >= 0) this.#exitShower--;
    }
    if (this.#whirl > 0) this.#whirlUp(dt);

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
    this.#state[i] = FALLING;
    this.#lifted[i] = lifted ? 1 : 0;
    const range = rand() < kind.tumbling ? TUMBLE_MASS : FLUTTER_MASS;
    this.#mass[i] = lerp(range[0], range[1], rand());
    this.#chord[i] = kind.chord * (0.85 + 0.3 * rand());
    this.#pace[i] = PACE * (0.9 + 0.2 * rand());
    this.#hue[i] = rand();
    this.#radius[i] = kind.radius * (0.9 + 0.2 * ((this.#hue[i] ?? 0) * 7.3 - Math.floor((this.#hue[i] ?? 0) * 7.3)));
    this.#seed[i] = rand();
    this.#psi[i] = rand() * TAU;
    this.#dpsi[i] = (rand() - 0.5) * 0.5;
    this.#u[i] = 0;
    this.#v[i] = 0;
    this.#w[i] = 0;
    this.#th[i] = (rand() - 0.5) * 1.2;
    this.#sigma[i] = rand() * TAU;
    this.#dsigma[i] = (rand() - 0.5) * 0.9;
    this.#roll[i] = rand() * TAU;
    this.#rollRate[i] = 1.0 + 1.4 * rand();
    this.#phase[i] = rand() * TAU;
    this.#debt[i] = 0;
    this.#lain[i] = 0;
    this.#rest[i] = (rand() - 0.5) * 0.1;
    this.#alpha[i] = lifted ? 1 : 0;
  }

  /** The plate's rates of change (into #rates): the body-frame velocity along the chord (u) and normal to it (v), and the pitch rate (w). */
  #plate(m: number, inertia: number, u: number, v: number, w: number, th: number): void {
    const speed = Math.hypot(u, v) + 1e-9;
    // Circulation lifts across the flow, drag opposes it, the added masses couple u, v and w.
    const gamma = -0.5 * PLATE_CT * ((u * v) / speed) + 0.5 * PLATE_CR * w;
    const drag = 0.5 * (PLATE_A - (PLATE_B * (u * u - v * v)) / (speed * speed)) * speed;
    const torque = PLATE_MU * (1 + Math.abs(w)) * w;
    const out = this.#rates;
    out[0] = ((m + PLATE_M22) * v * w - gamma * v - m * Math.sin(th) - drag * u) / (m + PLATE_M11);
    out[1] = (-(m + PLATE_M11) * u * w + gamma * u - m * Math.cos(th) - drag * v) / (m + PLATE_M22);
    out[2] = ((PLATE_M11 - PLATE_M22) * u * v - torque) / inertia;
  }

  /** Flutter or tumble down: the plate in its plane, the plane turning, the air carrying it. */
  #fall(i: number, dt: number): void {
    const m = at(this.#mass, i);
    const chord = at(this.#chord, i);
    const pace = at(this.#pace, i);
    const inertia = m / 12 + PLATE_IA;
    let u = at(this.#u, i);
    let v = at(this.#v, i);
    let w = at(this.#w, i);
    let th = at(this.#th, i);
    let x = at(this.#x, i);
    let y = at(this.#y, i);
    let z = at(this.#z, i);
    let psi = at(this.#psi, i);
    let debt = at(this.#debt, i) + dt / pace;
    const real = PLATE_STEP * pace;
    const dpsi = at(this.#dpsi, i);
    const rates = this.#rates;
    const h = 0.5 * PLATE_STEP;
    let landed = false;
    let guard = 0;
    this.#airAt(i, x, y, z);
    const air = this.#air;
    const ax = air[0] ?? 0;
    const ay = air[1] ?? 0;
    const az = air[2] ?? 0;
    while (debt >= PLATE_STEP && guard++ < 64) {
      debt -= PLATE_STEP;
      // The midpoint rule.
      this.#plate(m, inertia, u, v, w, th);
      const uMid = u + h * (rates[0] ?? 0);
      const vMid = v + h * (rates[1] ?? 0);
      const wMid = w + h * (rates[2] ?? 0);
      const thMid = th + h * w;
      this.#plate(m, inertia, uMid, vMid, wMid, thMid);
      u += PLATE_STEP * (rates[0] ?? 0);
      v += PLATE_STEP * (rates[1] ?? 0);
      w += PLATE_STEP * (rates[2] ?? 0);
      th += PLATE_STEP * wMid;
      // Motion in the plane, in chords, from the midpoint state; then into the park.
      const ct = Math.cos(thMid);
      const st = Math.sin(thMid);
      const along = (uMid * ct - vMid * st) * PLATE_STEP * chord;
      const rise = (uMid * st + vMid * ct) * PLATE_STEP * chord;
      x += along * Math.cos(psi) + ax * real;
      z += along * Math.sin(psi) + az * real;
      y += rise + ay * real;
      psi += dpsi * real;
      if (y <= LEAF_LIFT) {
        landed = true;
        y = LEAF_LIFT;
        break;
      }
    }
    this.#debt[i] = Math.min(debt, 2 * PLATE_STEP);
    this.#sigma[i] = at(this.#sigma, i) + at(this.#dsigma, i) * dt;
    this.#roll[i] = at(this.#roll, i) + at(this.#rollRate, i) * dt;
    this.#u[i] = u;
    this.#v[i] = v;
    this.#w[i] = w;
    this.#th[i] = th;
    this.#x[i] = x;
    this.#y[i] = Math.min(y, 12);
    this.#z[i] = z;
    this.#psi[i] = psi;
    if (x < -40 || x > 40 || z < 1.5 || z > 60) {
      this.#state[i] = FREE;
      return;
    }
    if (landed) {
      this.#state[i] = SETTLING;
      this.#touch[i] = Math.atan2(Math.sin(th), Math.cos(th));
      this.#lain[i] = 0;
    }
  }

  /** Down: ease flat (face up or face down, whichever is nearer), then lie in the carpet. */
  #settle(i: number, dt: number): void {
    const lain = at(this.#lain, i) + dt;
    this.#lain[i] = lain;
    const k = smoothstep(0, SETTLE_SECONDS, lain);
    const touch = at(this.#touch, i);
    const rest = at(this.#rest, i);
    const target = Math.abs(touch) > Math.PI / 2 ? Math.sign(touch) * Math.PI + rest : rest;
    this.#th[i] = lerp(touch, target, k);
    this.#sigma[i] = at(this.#sigma, i) + at(this.#dsigma, i) * dt * (1 - k);
    this.#y[i] = LEAF_LIFT;
    if (lain < SETTLE_SECONDS) return;
    this.#orient(i);
    const f = this.#frame;
    this.#carpet.deposit(at(this.#x, i), at(this.#z, i), Math.atan2(f[2] ?? 0, f[0] ?? 1), at(this.#hue, i), (f[7] ?? 1) >= 0 ? 1 : -1, this.#rand);
    this.#state[i] = FREE;
  }

  /**
   * Leaf i's frame in the world into #frame: its chord axis t (0..2), its span axis s (3..5) and the
   * upward plate normal n (6..8). The plate pitches in its vertical plane (azimuth psi), rocks about its
   * chord, then spins about its normal.
   */
  #orient(i: number): void {
    const psi = at(this.#psi, i);
    const th = at(this.#th, i);
    const ce = Math.cos(psi);
    const se = Math.sin(psi);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const settle = this.#state[i] === SETTLING ? 1 - smoothstep(0, SETTLE_SECONDS, at(this.#lain, i)) : 1;
    const rho = ROLL * Math.sin(at(this.#roll, i)) * settle;
    const cr = Math.cos(rho);
    const sr = Math.sin(rho);
    const cs = Math.cos(at(this.#sigma, i));
    const ss = Math.sin(at(this.#sigma, i));
    // Chord axis, the horizontal axis across the plane, the plate's normal in its own plane.
    const tx = ct * ce;
    const ty = st;
    const tz = ct * se;
    const bx = -se;
    const bz = ce;
    const nx = -st * ce;
    const ny = ct;
    const nz = -st * se;
    // The span axis rocked toward the normal, the normal with it.
    const sx = bx * cr + nx * sr;
    const sy = ny * sr;
    const sz = bz * cr + nz * sr;
    const mx = nx * cr - bx * sr;
    const my = ny * cr;
    const mz = nz * cr - bz * sr;
    const f = this.#frame;
    f[0] = cs * tx + ss * sx;
    f[1] = cs * ty + ss * sy;
    f[2] = cs * tz + ss * sz;
    f[3] = -ss * tx + cs * sx;
    f[4] = -ss * ty + cs * sy;
    f[5] = -ss * tz + cs * sz;
    f[6] = mx;
    f[7] = my;
    f[8] = mz;
  }

  /** A swirl passing over the path lifts leaves off it: plates stood up from the carpet, in the pose they lay in. */
  #pickUp(dt: number): void {
    this.#swirlPickup += dt * 30;
    let lifted = 0;
    for (let i = 0; i < SLOTS; i++) if (this.#lifted[i] === 1 && this.#state[i] !== FREE) lifted++;
    const rand = this.#rand;
    const strength = smoothstep(0, 2, this.#gustAge) * (1 - smoothstep(SWIRL_LIFE - 5, SWIRL_LIFE - 2, this.#gustAge));
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
    this.#radius[slot] = kind.radius * (0.9 + 0.2 * (found.hue * 7.3 - Math.floor(found.hue * 7.3)));
    const down = found.face < 0;
    this.#th[slot] = down ? Math.PI : 0;
    this.#psi[slot] = rand() * TAU;
    this.#sigma[slot] = down ? at(this.#psi, slot) + Math.PI - found.angle : found.angle - at(this.#psi, slot);
    this.#roll[slot] = 0;
    this.#rollRate[slot] = 1.4 + 1.4 * rand();
    return true;
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
    const target = this.#markGoal * total;
    const step = (total / MARK_SECONDS) * real;
    const before = this.#markShown;
    this.#markShown = target > before ? Math.min(target, before + step) : Math.max(target, before - step);
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
      for (let layer = 0; layer < 2; layer++) carpet.place(layer * CELLS + cell, rand(), rand(), rand(), 0, true, 0, LEVELS, rand);
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

  #pack(): void {
    const { horizon, eye, focal } = AUTUMN_VIEW;
    const data = this.#leafData;
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
      // image by (ax - wx az, ay - wy az) times the scale.
      data[o + 4] = (f[0] ?? 0) - wx * (f[2] ?? 0);
      data[o + 5] = (f[1] ?? 0) - wy * (f[2] ?? 0);
      data[o + 6] = (f[3] ?? 0) - wx * (f[5] ?? 0);
      data[o + 7] = (f[4] ?? 0) - wy * (f[5] ?? 0);
      data[o + 8] = f[6] ?? 0;
      data[o + 9] = f[7] ?? 1;
      data[o + 10] = f[8] ?? 0;
      data[o + 11] = z;
      data[o + 12] = at(this.#hue, i);
      data[o + 13] = at(this.#seed, i);
      data[o + 14] = 0;
      data[o + 15] = 0;
    }
    this.#leafTexture.upload(data);

    const now = performance.now();
    if (this.#carpet.dirty && now - this.#uploadedAt >= UPLOAD_EVERY_MS) {
      this.#carpetA.upload(this.#carpet.layers[0]);
      this.#carpetB.upload(this.#carpet.layers[1]);
      this.#carpet.dirty = false;
      this.#uploadedAt = now;
    }

    const state = this.#stateData;
    state[0] = gustAt(this.#gustAge) * this.#gustPower * this.#gustSign;
    state[1] = this.#swirlX;
    state[2] = this.#swirlZ;
    state[3] = this.#swirlOn ? smoothstep(0, 2, this.#gustAge) * (1 - smoothstep(SWIRL_LIFE - 4, SWIRL_LIFE, this.#gustAge)) * this.#gustPower : 0;
    state[4] = this.#strokeCells.length > 0 ? this.#markShown / this.#strokeCells.length : 0;
    this.#stateTexture.upload(state);
  }
}

/** The park's leaves, for a scene whose `params` carry the knobs `Knob` names. */
export function autumnSim(params: readonly ParamDef[]): SimFactory {
  return (gl) => new AutumnSim(gl, params);
}
