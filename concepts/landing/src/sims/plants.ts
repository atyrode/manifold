// Rooted plants for any scene: the shared plant component. A scene lays out sites (where a plant is
// rooted, which way it grows, how lush and how wet it is there) and picks a species for each; the
// plant grows there and stays. Every plant keeps its root and its structure from frame to frame:
// axes (stems, stalks, vines, stipes, roots) carrying organs (blades, fronds, flowers, tufts) at
// points along them. Each organ bends on a damped spring with the wind and its gusts (wind.ts) or,
// under water, with the current; leaves unfold, age, wither and are replaced on a growth clock; the
// year turns them, sheds them and brings flowers out; and each organ gets a level of detail from its
// projected size. The scene draws the organs itself: per fragment with the GLSL shapes of
// shaders/lib/plants.ts (falls, tide pool), or as sprites rasterised into a sheet by plantsheet.ts
// (the pond's border). Its knobs come from scenes/plants.ts (`plantKnobs`).
//
// Structure. `add(species, site, rand)` runs the species' `build`, which calls `organ(spec)` from the
// root up: an organ hangs on its parent (or the site) a share `at` along it, turned `angle` from the
// parent's direction there (from the scene's x axis on the site), `length` long and `width` wide,
// curled `curl` radians over its length at rest. An organ on the site springs from the site itself,
// or from a point `offset` from it (a tree's prop roots along its crown, a clump's stems). A flexible
// organ bends along its length (an arc), a rigid one turns about its base (a sprite or a stiff
// shape), an upright one stands out of the scene's plane (an anemone's column seen from above) and
// leans as a whole: its deflection is a vector. `a` and `b` are the species' own shape numbers for
// its drawing (a frond's lift and droop), passed through untouched.
//
// Roles: `axis` organs persist; `leaf` organs unfold, age and are replaced on the growth clock, turn
// colour and (the deciduous share) fall in autumn and come back in spring; `bloom` organs open in
// their species' flowering season; `root` organs persist and barely move. A child of a leaf or bloom
// shrinks with it.
//
// Mechanics. Each organ's deflection θ follows θ_eq on a spring of natural frequency `sway.hz` (for
// an organ 0.1 units long; ∝ 1/√length) and damping ratio `sway.damping`, where
//   θ_eq = limit · tanh(give · push⊥ / limit)
// and push⊥ is the push across the organ (positive turns it counterclockwise in the scene's frame):
// in the air the breeze plus eddies plus the gust a front crossing the scene brings to the plant, plus
// any air the scene moves itself (`wind`: a breeze front of its own); under water |u| u for the
// current u (quadratic drag). An upright organ leans by the same law along both axes of the push.
// Small organs (detail tier below full) follow θ_eq at once. The springs (sims/spring.ts, the exact
// step, its coefficients worked out once per organ) step on a FixedStep of STEP (1/60 s), sampling the
// wind at each step's own moment, so a seed sways the same at 60 and 144 Hz; `theta` and `lean` are
// what is drawn, blended between the last two steps by the clock's alpha (a step behind the newest,
// smoothly).
//
// The year: `season` 0..1 from the start of spring (summer 0.25..0.5, autumn 0.5..0.75, winter
// 0.75..1); PLANT_SUMMER (0.35) is high summer, every organ out and green, the picture a scene shows
// while its season knob is off. Phenology per organ: -1..0 young (pale), 0 green, 0..1 turning
// (gold, then brown).
//
// Detail. `cells` (dither cells per scene unit; a site may give its own, a camera's projection) sets
// each organ's tier from its projected length: 2 full at or above `detail.simple` cells, 1
// simplified at or above `detail.min`, 0 hidden.
//
// Output. `PlantTexture` packs organs for the GLSL (shaders/lib/plants.ts, `plantOrgan`): four rgba16f
// texels per record, record r at column r % width, rows rowBase + 4 · floor(r / width) + 0..3:
//   0  x (hi, lo), y (hi, lo)                 the organ's base (splitHalf pairs)
//   1  direction cos, sin, length, width       at the base, as grown; an upright organ's lean instead
//                                              of its direction (radians toward x and y)
//   2  bend θ, a, b, phenology
//   3  form, variant, side, tier               tier 0: nothing to draw
// A scene may reserve rows below the records for its own data (the tide pool's fish and flow), and
// pack two systems into one texture (`pack(a, b)`: the garden's far woods and its border, each in its
// own frame). `writePlantRecords` writes the same records into a texture the scene lays out itself
// (the countryside's records atlas). An organ with a negative slot is never packed: one the scene
// draws its own way (fireflies' crowns, through the bank's profile).
//
// Usage (ferns along a bank, rooted once, swaying every frame):
//   const plants = new RootedPlants(256, seed);
//   for (const site of sites) plants.add(FERN, site, rand);
//   const climate = plantClimate();
//   plants.settle(climate);                    // at rest in the air it starts in
//   // each frame:
//   climate.dt = frame.dt * frame.motion; climate.time = frame.motionTime; climate.air.x = wind;
//   plants.step(climate);
//   records.pack(plants); records.upload();
import { FixedStep } from "./clock.ts";
import { splitHalf } from "./half.ts";
import { clamp, fract, hash31, smoothstep } from "./math.ts";
import { mulberry32 } from "./random.ts";
import { SPRING_COEFFICIENTS, springCoefficients, springStepBy, type Spring } from "./spring.ts";
import { DataTexture } from "./texture.ts";
import { GustTrain, windNoise } from "./wind.ts";

const TAU = Math.PI * 2;

/** High summer: every organ out, mature and green (a scene's picture while its season knob is off). */
export const PLANT_SUMMER = 0.35;
/** Growth-clock seconds per second at growth amount 1. */
export const PLANT_GROWTH_PACE = 4;
/** The springs' fixed step (s), and the most steps one frame catches up (a hitch drops time). */
const STEP = 1 / 60;
const MAX_STEPS = 8;
/** The share of a leaf's span its node stays bare before the next leaf starts. */
const REST = 0.25;
/** Seconds between gusts at the gust amount's ends, and their peak push. */
const GUST_EVERY = [40, 8] as const;
const GUST_POWER = [0.7, 1.6] as const;
const GUST_RISE = 1.4;

/** What happens to an organ over its life and the year (see the header). */
export const PlantRole = { axis: 0, leaf: 1, bloom: 2, root: 3 } as const;
export type PlantRoleId = (typeof PlantRole)[keyof typeof PlantRole];

/** How an organ moves: bends along its length, turns about its base, or leans out of the plane. */
export const PlantHabit = { flexible: 0, rigid: 1, upright: 2 } as const;
export type PlantHabitId = (typeof PlantHabit)[keyof typeof PlantHabit];

/** Where a plant is rooted, in the scene's own units. */
export interface PlantSite {
  x: number;
  y: number;
  /** The way it grows: radians from the scene's x axis, the rest heading of its first organs. */
  heading: number;
  /** 0..1: how well it does here, from the scene's layout (default 1). */
  lush?: number;
  /** 0 dry ground .. 1 the waterline (default 0.5). */
  moisture?: number;
  /** Under water: the current pushes it, the wind does not. */
  submerged?: boolean;
  /** Dither cells per unit at this site (a camera's projection); default the system's `cells`. */
  cells?: number;
  /** A number of the scene's own the species' build reads (a size class, a clump's index). */
  kind?: number;
  /** The first record slot of the plant's organs, for grid-indexed drawing (default: none). */
  slot?: number;
}

/** How an organ sways (see the header). */
export interface PlantSway {
  /** Natural frequency (Hz) of an organ 0.1 units long; longer organs sway slower (∝ 1/√length). */
  readonly hz: number;
  /** Damping ratio (1: no overshoot). */
  readonly damping: number;
  /** Radians of bend per unit of push across it, before the limit. */
  readonly give: number;
  /** The most it bends (radians). */
  readonly limit: number;
  /** A slow flutter of leaves and blooms of their own (radians per unit of push). */
  readonly flutter?: number;
}

/** What the year does to a species (season 0..1 from the start of spring). */
export interface PlantYear {
  /** The share of its leaves that fall in autumn and come back in spring (0 evergreen .. 1 bare). */
  readonly shed: number;
  /** The season its leaves start to turn. */
  readonly turn: number;
  /** The season its flowers open and close. */
  readonly bloom: readonly [number, number];
}

export interface PlantSpecies {
  readonly id: string;
  /** The moisture it thrives in (0 dry .. 1 the waterline), fading out over 0.25 beyond either end. */
  readonly moisture: readonly [number, number];
  /** Lives under water (the current pushes it, quadratically). */
  readonly aquatic?: boolean;
  readonly sway: PlantSway;
  readonly year: PlantYear;
  /** Growth-clock seconds a leaf takes to unfold, and how long it lives before the next replaces it. */
  readonly life: { readonly unfold: number; readonly span: number };
  /** Projected length (cells) at or above which an organ is drawn in full, or at all. */
  readonly detail: { readonly simple: number; readonly min: number };
  /** Lays out one plant: its organs from the root up (see PlantBuilder). */
  build(plant: PlantBuilder): void;
}

/** One organ as a species' build adds it (see the header). */
export interface OrganSpec {
  /** The organ it grows from: an index `organ` returned, or -1 (default) for the site. */
  parent?: number;
  /** How far along the parent (0 base .. 1 tip), default 1; ignored on the site. */
  at?: number;
  /** Radians from the parent's direction at `at`, or from the scene's x axis on the site. */
  angle: number;
  length: number;
  width?: number;
  /** Rest curl over its length (radians); flexible organs only. */
  curl?: number;
  /** The species' own shape numbers, passed to the drawing. */
  a?: number;
  b?: number;
  /** The drawing's own codes: what it is (a sprite family, a shape) and which one. */
  form: number;
  variant?: number;
  /** Mirror (-1) or not (1, default). */
  side?: number;
  /** Depth layer for sheet drawing (0 back). */
  layer?: number;
  /** Base lightness 0..1 for sheet drawing. */
  shade?: number;
  role?: PlantRoleId;
  /** Default flexible. */
  habit?: PlantHabitId;
  /** Push it takes, as a share of the species' give (default 1). */
  give?: number;
  /** Its record slot, from the site's `slot` on (grid-indexed drawing); default its index; negative: never packed. */
  slot?: number;
  /** For an organ on the site: where it springs from, relative to the site (scene units); default the site. */
  offset?: readonly [number, number];
}

/** What `build` gets: the site, its randomness, and `organ` to add organs. */
export interface PlantBuilder {
  readonly site: Readonly<PlantSite>;
  readonly rand: () => number;
  /** 0..1: the species' fitness here times the site's lushness. */
  readonly vigour: number;
  /** Adds an organ; returns its index (-1 when the system is full: build on, nothing is kept). */
  organ(spec: OrganSpec): number;
}

/** The air plants sway in, in the scene's frame. */
export interface PlantAir {
  /** The steady breeze across the scene (push units: 1 a fresh breeze); gusts blow along it (+x when still). */
  x: number;
  y: number;
  /** Eddies: wandering push as a share of the breeze, plus `calm`, a stir of their own in still air (and, for aquatic plants, still water). */
  eddy: number;
  calm: number;
  /** Gust amount 0..1 (0: none of their own; "now" still sends one), and "now" this frame. */
  gusts: number;
  gustNow: boolean;
  /** How fast a gust's front crosses the scene along the breeze (units per second). */
  front: number;
}

/** What the plants live through this step. */
export interface PlantClimate {
  /** Seconds since the last step (the scene clock times motion; 0 holds everything still). */
  dt: number;
  /** The motion clock, for eddies and flutter. */
  time: number;
  /** Growth amount 0..1: how fast leaves unfold, age and are replaced (0: they hold in their prime). */
  growth: number;
  /** The year, 0..1 from the start of spring. */
  season: number;
  air: PlantAir;
  /** The water's flow at a point (scene units per second) into out[0], out[1], for aquatic species. */
  current?: (x: number, y: number, out: Float32Array) => void;
  /**
   * Air the scene moves itself at a point (push units), added into out[0], out[1] on top of the
   * breeze, its eddies and gusts, for land species: a breeze front of the scene's own crossing it.
   * `plant` is the organ's plant (the index `add` returned), for air that differs from plant to
   * plant (the countryside's verges: the gust bands of the field each clump stands in).
   */
  wind?: (x: number, y: number, out: Float32Array, plant: number) => void;
}

/** A still climate in high summer, for a scene to fill in each frame. */
export function plantClimate(): PlantClimate {
  return {
    dt: 0,
    time: 0,
    growth: 0,
    season: PLANT_SUMMER,
    air: { x: 0, y: 0, eddy: 0, calm: 0, gusts: 0, gustNow: false, front: 1 },
  };
}

/** How well a species does at a moisture: 1 inside its band, 0 beyond 0.25 outside it. */
export function plantFitness(species: PlantSpecies, moisture: number): number {
  const [lo, hi] = species.moisture;
  return clamp(1 - Math.max(lo - moisture, moisture - hi, 0) / 0.25, 0, 1);
}

export class PlantError extends Error {}

/** Persistent rooted plants: structure, state and pose of every organ (see the header). */
export class RootedPlants {
  readonly capacity: number;
  /** Organs and plants in use. */
  count = 0;
  plants = 0;
  /** Organs a build tried to add beyond capacity since the last `clear`. */
  dropped = 0;
  /** Dither cells per scene unit, for organs whose site gives none. */
  cells = 540;

  // Structure, per organ.
  readonly parent: Int32Array;
  readonly plantOf: Int32Array;
  readonly role: Uint8Array;
  readonly habit: Uint8Array;
  readonly at: Float32Array;
  readonly rest: Float32Array;
  readonly length: Float32Array;
  readonly width: Float32Array;
  readonly curl: Float32Array;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly form: Uint16Array;
  readonly variant: Uint16Array;
  readonly side: Int8Array;
  readonly layer: Uint8Array;
  readonly shade: Float32Array;
  readonly slot: Int32Array;
  /** Where an organ on the site springs from, relative to the site (0 for the rest). */
  readonly offsetX: Float64Array;
  readonly offsetY: Float64Array;
  readonly #give: Float32Array;
  /** Each organ's spring step (springCoefficients, SPRING_COEFFICIENTS numbers an organ). */
  readonly #sway: Float64Array;
  readonly #salt: Float32Array;
  // Drawn: the deflection (an upright organ's lean toward x) and an upright organ's lean toward y,
  // blended between the springs' last two steps.
  readonly theta: Float32Array;
  readonly lean: Float32Array;
  // The springs: deflection and lean at the last step and the one before, and their rates.
  readonly #thetaAt: Float32Array;
  readonly #thetaWas: Float32Array;
  readonly #leanAt: Float32Array;
  readonly #leanWas: Float32Array;
  readonly #omega: Float32Array;
  readonly #leanRate: Float32Array;
  // Pose, per organ (scene units): base, direction at the base, turn over the length, grown length.
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly angle: Float32Array;
  readonly turn: Float32Array;
  readonly grown: Float32Array;
  /** 0..1 how much of it is out (growth and the year). */
  readonly size: Float32Array;
  readonly pheno: Float32Array;
  readonly tier: Int8Array;
  /** Leaves replaced since the growth clock started: drawings add it to the variant. */
  readonly cycle: Int32Array;

  // Per plant.
  readonly #species: PlantSpecies[] = [];
  readonly #site: PlantSite[] = [];
  readonly #plantSalt: number[] = [];

  readonly #gusts: GustTrain;
  readonly #clock = new FixedStep(STEP, MAX_STEPS);
  /** One organ's spring, read from and written back to the arrays around each step. */
  readonly #spring: Spring = { x: 0, v: 0 };
  #growth = 0;
  #building = -1;
  #buildSite: PlantSite = { x: 0, y: 0, heading: 0 };
  #buildRand: () => number = () => 0;
  #buildVigour = 1;
  readonly #builder: PlantBuilder;
  readonly #flow = new Float32Array(2);
  readonly #push = new Float64Array(2);
  readonly #at = new Float64Array(3);

  /** Room for `capacity` organs; `seed` seeds the gusts. */
  constructor(capacity: number, seed = 0) {
    this.capacity = capacity;
    const n = capacity;
    this.parent = new Int32Array(n);
    this.plantOf = new Int32Array(n);
    this.role = new Uint8Array(n);
    this.habit = new Uint8Array(n);
    this.at = new Float32Array(n);
    this.rest = new Float32Array(n);
    this.length = new Float32Array(n);
    this.width = new Float32Array(n);
    this.curl = new Float32Array(n);
    this.a = new Float32Array(n);
    this.b = new Float32Array(n);
    this.form = new Uint16Array(n);
    this.variant = new Uint16Array(n);
    this.side = new Int8Array(n);
    this.layer = new Uint8Array(n);
    this.shade = new Float32Array(n);
    this.slot = new Int32Array(n);
    this.offsetX = new Float64Array(n);
    this.offsetY = new Float64Array(n);
    this.#give = new Float32Array(n);
    this.#sway = new Float64Array(n * SPRING_COEFFICIENTS);
    this.#salt = new Float32Array(n);
    this.theta = new Float32Array(n);
    this.lean = new Float32Array(n);
    this.#thetaAt = new Float32Array(n);
    this.#thetaWas = new Float32Array(n);
    this.#leanAt = new Float32Array(n);
    this.#leanWas = new Float32Array(n);
    this.#omega = new Float32Array(n);
    this.#leanRate = new Float32Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.angle = new Float32Array(n);
    this.turn = new Float32Array(n);
    this.grown = new Float32Array(n);
    this.size = new Float32Array(n);
    this.pheno = new Float32Array(n);
    this.tier = new Int8Array(n);
    this.cycle = new Int32Array(n);
    this.#gusts = new GustTrain(
      mulberry32(Math.imul(seed + 1, 0x9e3779b1) ^ 0x51a7),
      GUST_RISE,
      GUST_EVERY[0] * 0.5,
    );
    const site = () => this.#buildSite;
    const rand = () => this.#buildRand;
    const vigour = () => this.#buildVigour;
    this.#builder = {
      get site() {
        return site();
      },
      get rand() {
        return rand();
      },
      get vigour() {
        return vigour();
      },
      organ: (spec) => this.#organ(spec),
    };
  }

  /** The species of plant p. */
  speciesOf(p: number): PlantSpecies {
    const species = this.#species[p];
    if (species === undefined) throw new PlantError(`plants: no plant ${p}`);
    return species;
  }

  /** The site of plant p. */
  siteOf(p: number): Readonly<PlantSite> {
    const site = this.#site[p];
    if (site === undefined) throw new PlantError(`plants: no plant ${p}`);
    return site;
  }

  /** The growth clock (seconds), from the last `clear`. */
  get growth(): number {
    return this.#growth;
  }

  /** Forget every plant and restart the growth clock and the springs' steps: a new layout follows. */
  clear(): void {
    this.count = 0;
    this.plants = 0;
    this.dropped = 0;
    this.#growth = 0;
    this.#clock.reset();
    this.#species.length = 0;
    this.#site.length = 0;
    this.#plantSalt.length = 0;
  }

  /** Grows one plant of `species` at `site`, drawing its randomness from `rand`; returns its index. */
  add(species: PlantSpecies, site: PlantSite, rand: () => number): number {
    const p = this.plants++;
    this.#species.push(species);
    this.#site.push(site);
    this.#plantSalt.push(hash31(p, 0x504c, 0x414e));
    this.#buildSite = site;
    this.#buildRand = rand;
    this.#buildVigour = plantFitness(species, site.moisture ?? 0.5) * (site.lush ?? 1);
    this.#building = p;
    try {
      species.build(this.#builder);
    } finally {
      this.#building = -1;
    }
    return p;
  }

  #organ(spec: OrganSpec): number {
    const p = this.#building;
    if (p < 0) throw new PlantError("plants: organs are added inside a species' build");
    if (this.count >= this.capacity) {
      this.dropped++;
      return -1;
    }
    const parent = spec.parent ?? -1;
    if (parent >= this.count || (parent >= 0 && this.plantOf[parent] !== p))
      throw new PlantError(`plants: organ parent ${parent} is not an organ of this plant`);
    const species = this.speciesOf(p);
    const i = this.count++;
    const length = Math.max(spec.length, 1e-6);
    const habit = spec.habit ?? PlantHabit.flexible;
    const role = spec.role ?? PlantRole.axis;
    this.parent[i] = parent;
    this.plantOf[i] = p;
    this.role[i] = role;
    this.habit[i] = habit;
    this.at[i] = parent < 0 ? 0 : (spec.at ?? 1);
    this.rest[i] = spec.angle;
    this.length[i] = length;
    this.width[i] = spec.width ?? 0;
    this.curl[i] = habit === PlantHabit.flexible ? (spec.curl ?? 0) : 0;
    this.a[i] = spec.a ?? 0;
    this.b[i] = spec.b ?? 0;
    this.form[i] = spec.form;
    this.variant[i] = spec.variant ?? 0;
    this.side[i] = (spec.side ?? 1) < 0 ? -1 : 1;
    this.layer[i] = spec.layer ?? 0;
    this.shade[i] = spec.shade ?? 0.5;
    this.slot[i] =
      spec.slot === undefined ? i : spec.slot < 0 ? -1 : (this.#buildSite.slot ?? 0) + spec.slot;
    this.offsetX[i] = parent < 0 ? (spec.offset?.[0] ?? 0) : 0;
    this.offsetY[i] = parent < 0 ? (spec.offset?.[1] ?? 0) : 0;
    this.#give[i] = species.sway.give * (spec.give ?? 1) * (role === PlantRole.root ? 0.1 : 1);
    // At most 40 rad/s (6.4 Hz): the exact step needs no bound, but a tiny organ's swing should
    // still flutter rather than buzz between steps 1/60 s apart.
    springCoefficients(
      Math.min(TAU * species.sway.hz * Math.sqrt(0.1 / length), 40),
      species.sway.damping,
      STEP,
      this.#sway,
      i * SPRING_COEFFICIENTS,
    );
    // Salts come from the indices, not from the build's randomness: a species' build owns its
    // sequence, so a scene porting an old layout keeps it draw for draw.
    this.#salt[i] = hash31(i, p, 0x4f52);
    this.#hold(i, 0, 0);
    this.size[i] = 1;
    this.pheno[i] = 0;
    this.cycle[i] = 0;
    this.tier[i] = 2;
    return i;
  }

  /** Where organ o is a share s along its length, and its direction there: out = [x, y, angle]. */
  pointAt(o: number, s: number, out: Float64Array): void {
    const habit = this.habit[o] ?? 0;
    const angle = this.angle[o] ?? 0;
    const turn = habit === PlantHabit.flexible ? (this.turn[o] ?? 0) : 0;
    const length = habit === PlantHabit.upright ? 0 : (this.grown[o] ?? 0);
    const x = this.x[o] ?? 0;
    const y = this.y[o] ?? 0;
    if (Math.abs(turn) < 1e-4) {
      out[0] = x + Math.cos(angle) * length * s;
      out[1] = y + Math.sin(angle) * length * s;
    } else {
      const r = length / turn;
      out[0] = x + r * (Math.sin(angle + turn * s) - Math.sin(angle));
      out[1] = y - r * (Math.cos(angle + turn * s) - Math.cos(angle));
    }
    out[2] = angle + turn * s;
  }

  /** Lays every organ out from the root up with its current deflection and size, and sets its tier. */
  pose(): void {
    const at = this.#at;
    for (let i = 0; i < this.count; i++) {
      const p = this.parent[i] ?? -1;
      const plant = this.plantOf[i] ?? 0;
      const site = this.#site[plant];
      let bx = (site?.x ?? 0) + (this.offsetX[i] ?? 0);
      let by = (site?.y ?? 0) + (this.offsetY[i] ?? 0);
      let ba = this.rest[i] ?? 0;
      if (p >= 0) {
        this.pointAt(p, this.at[i] ?? 1, at);
        bx = at[0] ?? 0;
        by = at[1] ?? 0;
        ba += at[2] ?? 0;
      }
      const theta = this.theta[i] ?? 0;
      const habit = this.habit[i] ?? 0;
      this.x[i] = bx;
      this.y[i] = by;
      this.angle[i] = habit === PlantHabit.rigid ? ba + theta : ba;
      this.turn[i] = habit === PlantHabit.flexible ? (this.curl[i] ?? 0) + theta : 0;
      const grown = (this.length[i] ?? 0) * (this.size[i] ?? 0);
      this.grown[i] = grown;
      const species = this.#species[plant];
      const cells = grown * (site?.cells ?? this.cells);
      this.tier[i] =
        (this.size[i] ?? 0) <= 0 || !species
          ? 0
          : cells >= species.detail.simple
            ? 2
            : cells >= species.detail.min
              ? 1
              : 0;
    }
  }

  /** Every organ at rest in `climate`'s air or water (no swing to settle), posed. */
  settle(climate: PlantClimate): void {
    this.#life(climate.season);
    this.pose();
    for (let i = 0; i < this.count; i++) {
      this.#target(i, climate, 0);
      this.#hold(i, this.#push[0] ?? 0, this.#push[1] ?? 0);
    }
    this.pose();
  }

  /**
   * One frame: growth and the year, then the springs' whole steps due (each with the wind at its own
   * moment), then the drawn deflections between the last two, then the pose.
   */
  step(climate: PlantClimate): void {
    const dt = Math.max(0, climate.dt);
    const air = climate.air;
    const power = GUST_POWER[0] + (GUST_POWER[1] - GUST_POWER[0]) * air.gusts;
    const every = GUST_EVERY[0] + (GUST_EVERY[1] - GUST_EVERY[0]) * air.gusts;
    if (air.gustNow)
      this.#gusts.start(
        1,
        Math.max(power, GUST_POWER[0] + 0.5 * (GUST_POWER[1] - GUST_POWER[0])),
        every,
      );
    if (dt > 0) {
      this.#growth += dt * PLANT_GROWTH_PACE * climate.growth;
      this.#gusts.step(dt, air.gusts > 0 ? every : Infinity, 1, power);
    }
    this.#life(climate.season);
    const clock = this.#clock;
    const steps = clock.advance(dt);
    const push = this.#push;
    const spring = this.#spring;
    const thetaAt = this.#thetaAt;
    const leanAt = this.#leanAt;
    for (let k = 0; k < steps; k++) {
      const late = -clock.lag(k);
      for (let i = 0; i < this.count; i++) {
        this.#target(i, climate, late);
        const target = push[0] ?? 0;
        if ((this.tier[i] ?? 0) < 2) {
          this.#hold(i, target, push[1] ?? 0);
          continue;
        }
        const springAt = i * SPRING_COEFFICIENTS;
        this.#thetaWas[i] = thetaAt[i] ?? 0;
        spring.x = thetaAt[i] ?? 0;
        spring.v = this.#omega[i] ?? 0;
        springStepBy(spring, target, this.#sway, springAt);
        thetaAt[i] = spring.x;
        this.#omega[i] = spring.v;
        if (this.habit[i] === PlantHabit.upright) {
          this.#leanWas[i] = leanAt[i] ?? 0;
          spring.x = leanAt[i] ?? 0;
          spring.v = this.#leanRate[i] ?? 0;
          springStepBy(spring, push[1] ?? 0, this.#sway, springAt);
          leanAt[i] = spring.x;
          this.#leanRate[i] = spring.v;
        }
      }
    }
    const alpha = clock.alpha;
    for (let i = 0; i < this.count; i++) {
      const was = this.#thetaWas[i] ?? 0;
      this.theta[i] = was + ((thetaAt[i] ?? 0) - was) * alpha;
      const leaned = this.#leanWas[i] ?? 0;
      this.lean[i] = leaned + ((leanAt[i] ?? 0) - leaned) * alpha;
    }
    this.pose();
  }

  /** Organ i held still at deflection `theta` and lean `lean`: drawn so, at both steps, no rate. */
  #hold(i: number, theta: number, lean: number): void {
    this.theta[i] = theta;
    this.#thetaAt[i] = theta;
    this.#thetaWas[i] = theta;
    this.#omega[i] = 0;
    this.lean[i] = lean;
    this.#leanAt[i] = lean;
    this.#leanWas[i] = lean;
    this.#leanRate[i] = 0;
  }

  /**
   * Where organ i's deflection is pushed now (`late` ≤ 0 seconds before the frame's end), into
   * #push: [θ_eq, 0], or an upright organ's lean [toward x, toward y].
   */
  #target(i: number, climate: PlantClimate, late: number): void {
    const out = this.#push;
    out[0] = 0;
    out[1] = 0;
    const plant = this.plantOf[i] ?? 0;
    const species = this.#species[plant];
    const site = this.#site[plant];
    const give = this.#give[i] ?? 0;
    if (!species || !site || give === 0) return;
    const habit = this.habit[i] ?? 0;
    const angle = (this.angle[i] ?? 0) + 0.5 * (this.turn[i] ?? 0);
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const grown = habit === PlantHabit.upright ? 0 : (this.grown[i] ?? 0);
    const air = climate.air;
    const salt = this.#plantSalt[plant] ?? 0;
    const pace = (climate.time + late) * (0.18 + 0.1 * salt);
    const wanderX = windNoise(pace, Math.floor(salt * 977));
    const wanderY = windNoise(pace + 31.7, Math.floor(salt * 977) + 5);
    let px = 0;
    let py = 0;
    if (species.aquatic || site.submerged) {
      // Under water: quadratic drag of the current, and the water's own stir (air.calm).
      const flow = this.#flow;
      flow[0] = 0;
      flow[1] = 0;
      climate.current?.(
        (this.x[i] ?? 0) + dx * 0.5 * grown,
        (this.y[i] ?? 0) + dy * 0.5 * grown,
        flow,
      );
      const speed = Math.hypot(flow[0] ?? 0, flow[1] ?? 0);
      px = speed * (flow[0] ?? 0) + air.calm * wanderX;
      py = speed * (flow[1] ?? 0) + air.calm * wanderY;
    } else {
      const breeze = Math.hypot(air.x, air.y);
      const bx = breeze > 1e-6 ? air.x / breeze : 1;
      const by = breeze > 1e-6 ? air.y / breeze : 0;
      const eddy = air.eddy * breeze + air.calm;
      // A front crossing the scene along the breeze reaches this plant `delay` seconds after it set out.
      const delay = air.front > 0 ? (site.x * bx + site.y * by) / air.front + 2 : 0;
      const gust = this.#gusts.strength(delay - late);
      px = air.x + eddy * wanderX + bx * gust;
      py = air.y + eddy * wanderY + by * gust;
      if (climate.wind) {
        // The scene's own air, where the organ's middle is.
        const own = this.#flow;
        own[0] = 0;
        own[1] = 0;
        climate.wind(
          (this.x[i] ?? 0) + dx * 0.5 * grown,
          (this.y[i] ?? 0) + dy * 0.5 * grown,
          own,
          plant,
        );
        px += own[0] ?? 0;
        py += own[1] ?? 0;
      }
    }
    const limit = species.sway.limit;
    if (habit === PlantHabit.upright) {
      out[0] = limit * Math.tanh((give * px) / limit);
      out[1] = limit * Math.tanh((give * py) / limit);
      return;
    }
    let across = dx * py - dy * px;
    const flutter = species.sway.flutter ?? 0;
    if (flutter > 0 && this.role[i] !== PlantRole.axis) {
      const salt = this.#salt[i] ?? 0;
      across +=
        (flutter / give) *
        Math.hypot(px, py) *
        Math.sin((climate.time + late) * (1.1 + 0.8 * salt) + salt * TAU);
    }
    out[0] = limit * Math.tanh((give * across) / limit);
  }

  /** Growth and the year: each organ's size, phenology and replacement count. */
  #life(season: number): void {
    const growth = this.#growth;
    for (let i = 0; i < this.count; i++) {
      const role = this.role[i] ?? 0;
      const species = this.#species[this.plantOf[i] ?? 0];
      if (!species) continue;
      const salt = this.#salt[i] ?? 0;
      let size = 1;
      let pheno = 0;
      let cycle = 0;
      if (role === PlantRole.leaf || role === PlantRole.bloom) {
        // The growth clock: a leaf unfolds (pale), lives, withers (turning) and drops; after a rest
        // its node grows the next. At growth 0 every leaf sits between unfolding and withering.
        const span = species.life.span;
        const run = 0.25 + 0.3 * salt + growth / (span * (1 + REST));
        cycle = Math.floor(run);
        const life = fract(run) * (1 + REST);
        const unfold = Math.min(species.life.unfold / span, 0.25);
        if (life >= 1) size = 0;
        else {
          size = smoothstep(0, unfold, life) * (1 - smoothstep(0.92, 1, life));
          pheno = life < unfold ? -0.7 * (1 - life / unfold) : smoothstep(0.75, 0.95, life);
        }
      }
      if (role === PlantRole.leaf) {
        const year = species.year;
        const turnAt = year.turn + 0.08 * (salt - 0.5);
        const turning =
          smoothstep(turnAt, turnAt + 0.12, season) +
          0.6 * smoothstep(turnAt + 0.12, turnAt + 0.22, season);
        if (fract(salt * 7.31 + 0.13) < year.shed) {
          // Out in spring, down after turning; bare through winter.
          size *=
            smoothstep(0.02 + 0.08 * salt, 0.14 + 0.08 * salt, season) *
            (1 - smoothstep(turnAt + 0.14, turnAt + 0.22, season));
          pheno += turning / 1.6 - 0.6 * (1 - smoothstep(0.08, 0.22, season));
        } else {
          // Evergreen: a dulling through autumn and winter, a flush of young leaves in spring.
          pheno += (0.15 * turning) / 1.6 - 0.35 * (1 - smoothstep(0.06, 0.2, season));
        }
      } else if (role === PlantRole.bloom) {
        const [from, to] = species.year.bloom;
        const jitter = 0.04 * (salt - 0.5);
        size *=
          smoothstep(from + jitter, from + jitter + 0.05, season) *
          (1 - smoothstep(to + jitter - 0.05, to + jitter, season));
        pheno = 0;
      }
      // A child of a leaf or bloom goes with it.
      const parent = this.parent[i] ?? -1;
      if (parent >= 0) {
        const parentRole = this.role[parent] ?? 0;
        if (parentRole === PlantRole.leaf || parentRole === PlantRole.bloom)
          size *= this.size[parent] ?? 1;
      }
      this.size[i] = size;
      this.pheno[i] = clamp(pheno, -1, 1);
      this.cycle[i] = cycle;
    }
  }
}

/**
 * Writes each drawable organ of `plants` at its record slot into `data`, the rgba texels of a
 * texture `width` wide, the records from row `rowBase` (PlantTexture's layout, see the header); a
 * slot at or past `records` is left out. For a scene that packs the records into a texture of its
 * own rather than a PlantTexture's (the countryside's records atlas).
 */
export function writePlantRecords(
  plants: RootedPlants,
  data: Float32Array,
  width: number,
  rowBase: number,
  records: number,
): void {
  for (let i = 0; i < plants.count; i++) {
    const tier = plants.tier[i] ?? 0;
    const r = plants.slot[i] ?? i;
    if (tier <= 0 || r < 0 || r >= records) continue;
    const t0 = ((rowBase + 4 * Math.floor(r / width)) * width + (r % width)) * 4;
    const t1 = t0 + width * 4;
    const t2 = t1 + width * 4;
    const t3 = t2 + width * 4;
    splitHalf(data, t0, plants.x[i] ?? 0);
    splitHalf(data, t0 + 2, plants.y[i] ?? 0);
    if (plants.habit[i] === PlantHabit.upright) {
      data[t1] = plants.theta[i] ?? 0;
      data[t1 + 1] = plants.lean[i] ?? 0;
    } else {
      const angle = plants.angle[i] ?? 0;
      data[t1] = Math.cos(angle);
      data[t1 + 1] = Math.sin(angle);
    }
    data[t1 + 2] = plants.grown[i] ?? 0;
    data[t1 + 3] = (plants.width[i] ?? 0) * (plants.size[i] ?? 0);
    data[t2] = plants.theta[i] ?? 0;
    data[t2 + 1] = plants.a[i] ?? 0;
    data[t2 + 2] = plants.b[i] ?? 0;
    data[t2 + 3] = plants.pheno[i] ?? 0;
    data[t3] = plants.form[i] ?? 0;
    data[t3 + 1] = (plants.variant[i] ?? 0) + (plants.cycle[i] ?? 0);
    data[t3 + 2] = plants.side[i] ?? 1;
    data[t3 + 3] = tier;
  }
}

/** Organ records for the GLSL (see the header): `records` of them, `width` a row, after `rowBase` rows of the scene's own. */
export class PlantTexture {
  readonly records: number;
  readonly width: number;
  readonly rowBase: number;
  /** The whole texture's data: the scene's own rows first (rowBase · width texels), then the records. */
  readonly data: Float32Array;
  readonly #texture: DataTexture;

  constructor(
    gl: WebGL2RenderingContext,
    records: number,
    options: { width?: number; rowBase?: number } = {},
  ) {
    this.records = records;
    this.width = options.width ?? Math.min(512, Math.max(1, records));
    this.rowBase = options.rowBase ?? 0;
    const height = this.rowBase + 4 * Math.ceil(records / this.width);
    this.data = new Float32Array(this.width * height * 4);
    this.#texture = new DataTexture(gl, {
      width: this.width,
      height,
      format: "rgba16f",
      filter: "nearest",
    });
  }

  get texture(): WebGLTexture {
    return this.#texture.texture;
  }

  /** Every record hidden, then each drawable organ of `plants` (and of `also`, another system) written at its slot. */
  pack(plants: RootedPlants, also?: RootedPlants): void {
    this.data.fill(0, this.rowBase * this.width * 4);
    writePlantRecords(plants, this.data, this.width, this.rowBase, this.records);
    if (also) writePlantRecords(also, this.data, this.width, this.rowBase, this.records);
  }

  upload(): void {
    this.#texture.upload(this.data);
  }

  dispose(): void {
    this.#texture.dispose();
  }
}
