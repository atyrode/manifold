// The boughs' sim (`boughs`, the maple): the leaves it lets fall. It lends the raking chore its
// affordances (`Boughs`, the sim itself): the leaves lying in a rake's way are swept up.
//
// Leaves fall as flat plates (the shared fluttering-plate model, sims/flutter.ts, as autumn's leaves
// fall), each in its own vertical plane that slowly turns, carried by the wind and the composer's one
// gust field (ADR 0062 D4: its load where each leaf is, its 'now' included). Light leaves flutter,
// swinging from side to side and gliding up at the end of each swing; heavier ones tumble end over
// end. They land on what the gravel says lies there (its affordances; the bare floor without it),
// settle flat, lie a while and fade, or are swept away by the rake. A gust reaching the canopy (its
// load rising past GUST_ONSET) shakes a shower loose and blows lying leaves along the gravel.
//
// The scene's passage plays here too: a sim built while the scene comes in lets a few leaves go from
// the boughs as it arrives; once it leaves, the exit's own gust (sim.ts exitFront's pulse, the
// shader's boughs leaning with it on the same clock) blows a flurry of leaves in from upwind and
// carries off the ones lying on the gravel. Nothing here runs at rest.
//
// Data: a row of the records atlas, four rgba16f texels a leaf (GARDEN_LEAF_SLOTS): (x, y relative to
// the garden's centre, z, alpha; alpha 0 = none), (first in-plane axis, radius), (second in-plane
// axis, kind), (hue, age on the ground 0..1, landed 0..1, 0).
import { gustWind, newGustWind } from "../../composer/gust.ts";
import type { LayerFrame, LayerSim } from "../../composer/types.ts";
import { KnobReader, type ParamDef } from "../../params.ts";
import { FlutterPlates } from "../../sims/flutter.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { mulberry32 } from "../../sims/random.ts";
import { gustPulse, windSign } from "../../sims/wind.ts";
import { GA, OX, OY, TAU } from "./build.ts";
import { GARDEN, GARDEN_PASSAGE, gardenSeasons, type GardenSeason } from "./constants.ts";
import { Gravel } from "./gravel.ts";
import {
  GARDEN_CANOPY,
  GARDEN_GUST_RISE,
  GARDEN_LEAF_KIND,
  GARDEN_LEAF_SLOTS,
  GARDEN_MAPLE_AT,
  GardenView,
  fieldPush,
  metresAcross,
  metresAhead,
} from "./sim.ts";

type LeafKind = (typeof GARDEN_LEAF_KIND)[keyof typeof GARDEN_LEAF_KIND];

interface LeafSpec {
  /** Drawn radius, garden depths. */
  radius: number;
  /** The plate's aerodynamic chord: sets the swing and the speed of descent. */
  chord: number;
  /** Real seconds per model time unit: sets the pace of the swing. */
  pace: number;
  /** Mass per span (the dimensionless moment of inertia I*): flutter below ~0.6, tumble above. */
  flutter: readonly [number, number];
  tumble: readonly [number, number];
  /** Share of leaves that tumble. */
  tumbling: number;
  /** Seconds a leaf lies on the gravel before it fades. */
  life: readonly [number, number];
}

const SPECS: Readonly<Record<LeafKind, LeafSpec>> = {
  [GARDEN_LEAF_KIND.maple]: {
    radius: 0.013,
    chord: 0.046,
    pace: 0.17,
    flutter: [0.2, 0.42],
    tumble: [0.72, 0.9],
    tumbling: 0.15,
    life: [45, 85],
  },
  [GARDEN_LEAF_KIND.petal]: {
    radius: 0.0068,
    chord: 0.024,
    pace: 0.13,
    flutter: [0.12, 0.3],
    tumble: [0.6, 0.75],
    tumbling: 0.08,
    life: [25, 50],
  },
  [GARDEN_LEAF_KIND.green]: {
    radius: 0.0135,
    chord: 0.046,
    pace: 0.17,
    flutter: [0.25, 0.45],
    tumble: [0.72, 0.9],
    tumbling: 0.12,
    life: [45, 85],
  },
  [GARDEN_LEAF_KIND.withered]: {
    radius: 0.0115,
    chord: 0.034,
    pace: 0.15,
    flutter: [0.35, 0.55],
    tumble: [0.7, 0.9],
    tumbling: 0.4,
    life: [60, 100],
  },
};

/** Leaves let go per second at the leaf-fall knob's full travel, by season. */
const FALL_RATE: Readonly<Record<GardenSeason, number>> = {
  spring: 1.6,
  summer: 0.2,
  autumn: 1.0,
  winter: 0.1,
};
const SEASON_KIND: Readonly<Record<GardenSeason, LeafKind>> = {
  spring: GARDEN_LEAF_KIND.petal,
  summer: GARDEN_LEAF_KIND.green,
  autumn: GARDEN_LEAF_KIND.maple,
  winter: GARDEN_LEAF_KIND.withered,
};

/** Leaf states. */
const FREE = 0;
const FALLING = 1;
const LANDED = 2;
const LEAVING = 3;

/** Wind drift (garden depths per second) at wind = 1; a gust's drift and updraft per unit of its push. */
const WIND_DRIFT = 0.12;
const GUST_DRIFT = 0.22;
const GUST_LIFT = 0.03;
/**
 * A gust begins at the canopy as the field's push there rises past GUST_ONSET and is over once it
 * falls below GUST_CALM; it shakes GUST_SHOWER leaves loose over GUST_SHAKE seconds. A lying leaf
 * is carried off once the push where it lies passes GUST_CARRY_AT.
 */
const GUST_ONSET = 0.35;
const GUST_CALM = 0.15;
const GUST_SHAKE = 1.8;
const GUST_SHOWER = 12;
const GUST_CARRY_AT = 0.7;
/** A landed leaf lies this far above the ground it rests on. */
const LEAF_LIFT = 0.0012;
/** Seconds to settle flat after touching down, to fade in, to fade out, and to be swept away. */
const SETTLE_SECONDS = 0.5;
const FADE_IN = 0.4;
const FADE_OUT = 6;
const SWEEP_SECONDS = 1.6;
/** How far a falling leaf rocks about its chord (radians), on its own slow swing. */
const ROLL = 0.3;
/** Leaves on the gravel when a garden is first laid out, and in the air. */
const PREWARM_LANDED = 9;
const PREWARM_FALLING = 4;
/** Most leaves lying on the gravel at once; past it the oldest fades, leaving slots for the air. */
const LANDED_MAX = 12;
/** The share of lying leaves (the lightest, by hue) a full gust picks up and blows away. */
const GUST_CARRY = 0.4;
/** How far ahead of a rake's tines its board reaches, garden depths (raking.ts LEAD): leaves there are swept. */
const SWEEP_AHEAD = 0.05;

/** Where a passage's leaf lets go (see #spawn). */
type SpawnMode = "entrance" | "flurry";

/**
 * The entrance's leaves: up to this many (fewer in the sparse seasons) let go from the boughs, the
 * first this far into the entrance, the rest this far apart (seconds).
 */
const ENTRANCE_LEAVES = 5;
const ENTRANCE_FIRST = 0.1;
const ENTRANCE_GAP = 0.2;
/** The exit's flurry: this many leaves blown in from upwind over this many seconds of the gust, which pushes them this many times harder than its pulse alone. */
const FLURRY_LEAVES = 14;
const FLURRY_SPAN = 0.6;
const FLURRY_BOOST = 4;

const KNOBS = ["leafFall", "season", "wind", "seed"] as const;
type Knob = (typeof KNOBS)[number];

/** The boughs' knobs as the sim reads them. */
interface Settings {
  season: GardenSeason;
  seed: number;
  /** Leaf-fall knob 0..1. */
  leaves: number;
  wind: number;
  overhead: boolean;
}

/** The maple's leaves, and the affordances it lends the rake (see the header). */
export class Boughs implements LayerSim {
  readonly #knobs: KnobReader<Knob>;
  readonly #current: Settings = {
    season: "autumn",
    seed: 0,
    leaves: 0,
    wind: 0,
    overhead: false,
  };
  /** The veranda's view, while there is no gravel to lend the garden's. */
  readonly #veranda = new GardenView();
  #view: GardenView = this.#veranda;
  #gravel: Gravel | undefined = undefined;
  /** The leaves have been strewn about a laid garden (or a bare floor) for the first frame. */
  #strewnAbout = false;

  readonly #state = new Uint8Array(GARDEN_LEAF_SLOTS);
  readonly #kind = new Uint8Array(GARDEN_LEAF_SLOTS);
  readonly #x = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #y = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #z = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Each leaf's plate in flight: its plane, pitch, spin, rock, mass, chord, pace and the pitch it lands and rests at. */
  readonly #plates = new FlutterPlates(GARDEN_LEAF_SLOTS, ROLL);
  /** A leaf's position for the plates (x, y, z), and its frame from them (#packLeaves). */
  readonly #pos = new Float64Array(3);
  readonly #frame = new Float64Array(9);
  /** Where a falling leaf touches down: on what the gravel says lies there, as it lies there. */
  readonly #floor = (x: number, y: number): number => this.#groundAt(x, y) + LEAF_LIFT;
  readonly #radius = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #hue = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Seconds since it landed. */
  readonly #lain = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #life = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #alpha = new Float64Array(GARDEN_LEAF_SLOTS);
  /** Slide velocity on the gravel (swept by the rake or skittering in a gust). */
  readonly #vx = new Float64Array(GARDEN_LEAF_SLOTS);
  readonly #vy = new Float64Array(GARDEN_LEAF_SLOTS);
  #leafRand = mulberry32(1);
  #nextLeaf = 0;
  #season: GardenSeason = "autumn";

  // Gusts: the composer's field now, a gust at the canopy and its shower, the way it blows.
  readonly #wind = newGustWind();
  #fieldTime = 0;
  #gusting = false;
  #shakeAge = Infinity;
  #shower = 0;
  #gustSign = 1;
  // The scene's passage (see GARDEN_PASSAGE): the leaves it adds draw from their own sequence.
  readonly #passageRand = mulberry32(0x70617373);
  /** Whether this sim was built while the scene came in; undefined until its first frame. */
  #arriving: boolean | undefined = undefined;
  /** Entrance leaves let go so far, and flurry leaves. */
  #strewn = 0;
  #flurried = 0;
  /** The exit's gust now (its pulse, signed the way it blows), 0 at rest. */
  #exitGust = 0;
  #leaving = false;

  constructor(params: readonly ParamDef[]) {
    this.#knobs = new KnobReader("garden boughs", params, KNOBS);
  }

  get affordances(): Boughs {
    return this;
  }

  frame(frame: LayerFrame): void {
    const settings = this.#settings(frame);
    const host = frame.host("gravel");
    this.#gravel = host instanceof Gravel ? host : undefined;
    this.#view = this.#gravel?.view ?? this.#veranda;
    if (frame.aspect > 0 && Number.isFinite(frame.aspect)) this.#veranda.aspect = frame.aspect;
    settings.overhead = this.#view.overhead;
    const dt = Math.min(Math.max(frame.dt, 0), 0.1);
    const g = frame.gusts;
    gustWind(this.#wind, g.wind, g.gusts, g.rate, g.nowAge, g.pass, g.shape);
    this.#fieldTime = frame.motionTime;

    // The first frame on a laid garden (or on a bare floor) shows leaves already lying about, and a
    // few on their way down.
    if (!this.#strewnAbout) {
      if (this.#gravel !== undefined && !this.#gravel.laid) {
        this.#pack(frame.records.data);
        frame.records.touch();
        return;
      }
      this.#strewnAbout = true;
      this.#season = settings.season;
      this.#prewarmLeaves(settings);
    }
    if (settings.season !== this.#season) this.#reskin(settings.season);
    this.#passage(frame, settings);
    // The exit's gust plays in real time whatever the motion.
    const air = dt * Math.max(frame.motion, this.#leaving ? 1 : 0);
    this.#watchGust(air, settings);
    this.#leaves(air, settings);
    this.#pack(frame.records.data);
    frame.records.touch();
  }

  /** Ready once the leaves lie about the first garden. */
  ready(): boolean {
    return this.#strewnAbout;
  }

  // Records only: nothing of its own to release.
  dispose(): void {}

  /** Leaves lying in a rake's way (at (x, y), heading (dx, dy), `half` wide) are swept up. */
  sweep(x: number, y: number, dx: number, dy: number, half: number, speed: number): void {
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] !== LANDED) continue;
      const px = (this.#x[i] ?? 0) - x;
      const py = (this.#y[i] ?? 0) - y;
      const along = px * dx + py * dy;
      const across = Math.abs(px * dy - py * dx);
      if (across > half || along < -0.01 || along > SWEEP_AHEAD) continue;
      this.#state[i] = LEAVING;
      const push = 1.5 * speed + 0.03;
      this.#vx[i] = dx * push;
      this.#vy[i] = dy * push;
    }
  }

  #settings(frame: LayerFrame): Settings {
    const knobs = this.#knobs;
    const s = this.#current;
    s.season = gardenSeasons[Math.round(knobs.value(frame, "season"))] ?? "autumn";
    s.seed = Math.max(0, Math.round(knobs.value(frame, "seed")));
    s.leaves = clamp(knobs.value(frame, "leafFall"), 0, 1);
    s.wind = clamp(knobs.value(frame, "wind"), -1, 1);
    return s;
  }

  /** What a leaf rests on at (x, y): the gravel's ground, or the bare floor. */
  #groundAt(x: number, y: number): number {
    return this.#gravel?.groundAt(x, y) ?? 0;
  }

  /**
   * The composer's gust field's push at garden point (x, y), or the exit's gust while it is stronger
   * (pushing FLURRY_BOOST times its pulse): a signed push the way it blows.
   */
  #gustAt(x: number, y: number): number {
    const field = fieldPush(this.#wind, metresAcross(x), metresAhead(y), this.#fieldTime);
    const exit = FLURRY_BOOST * this.#exitGust;
    return Math.abs(exit) > Math.abs(field) ? exit : field;
  }

  /** A gust reaching the canopy shakes a shower loose (see the header). */
  #watchGust(dt: number, settings: Settings): void {
    const load = fieldPush(this.#wind, GARDEN_MAPLE_AT[0], GARDEN_MAPLE_AT[1], this.#fieldTime);
    if (!this.#gusting && Math.abs(load) > GUST_ONSET) {
      this.#gusting = true;
      this.#gustSign = load < 0 ? -1 : 1;
      this.#shakeAge = 0;
      this.#shower = GUST_SHOWER;
    } else if (this.#gusting && Math.abs(load) < GUST_CALM) {
      this.#gusting = false;
    }
    // The shower comes down over the gust's first moments, as slots free up (the gust blows some
    // lying leaves away).
    if (this.#shower > 0 && this.#shakeAge < GUST_SHAKE + 3) {
      const due =
        this.#shakeAge < GUST_SHAKE
          ? Math.ceil(GUST_SHOWER * (1 - this.#shakeAge / GUST_SHAKE))
          : 0;
      while (this.#shower > due && this.#spawn(settings, true) !== undefined) this.#shower--;
    }
    if (this.#shakeAge < GUST_SHAKE + 3) this.#shakeAge += dt;
  }

  /**
   * The scene's passage. A sim built while the scene comes in lets a few leaves go from the boughs
   * as it arrives; once it leaves, the exit's gust (its rise drawn out over the whole exit so it is at
   * its strongest as the scene goes; the shader's boughs lean with it on the same clock) blows a
   * flurry of leaves in from upwind and carries off the ones lying on the gravel. Nothing here runs
   * at rest.
   */
  #passage(frame: LayerFrame, settings: Settings): void {
    const { enter, exit } = frame.passage;
    if (this.#arriving === undefined) this.#arriving = enter < 1;
    if (this.#arriving) {
      if (enter >= 1) {
        this.#arriving = false;
      } else {
        const total =
          settings.leaves > 0
            ? Math.round(ENTRANCE_LEAVES * Math.min(1, 2 * FALL_RATE[settings.season]))
            : 0;
        const seconds = enter * GARDEN_PASSAGE.enter;
        while (this.#strewn < total && seconds >= ENTRANCE_FIRST + ENTRANCE_GAP * this.#strewn) {
          this.#strewn++;
          this.#spawn(settings, false, this.#passageRand, "entrance");
        }
      }
    }
    if (exit > 0) {
      const seconds = exit * GARDEN_PASSAGE.exit;
      if (!this.#leaving) {
        this.#leaving = true;
        this.#gustSign = windSign(settings.wind);
      }
      this.#exitGust = this.#gustSign * gustPulse(exit * GARDEN_GUST_RISE, GARDEN_GUST_RISE);
      while (
        this.#flurried < FLURRY_LEAVES &&
        seconds >= (FLURRY_SPAN * this.#flurried) / FLURRY_LEAVES
      ) {
        this.#flurried++;
        this.#spawn(settings, false, this.#passageRand, "flurry");
      }
    } else if (this.#leaving) {
      this.#leaving = false;
      this.#exitGust = 0;
    }
  }

  /** Give the leaves on the ground (and in the air) the new season's colours. */
  #reskin(season: GardenSeason): void {
    this.#season = season;
    const kind = SEASON_KIND[season];
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] === FREE) continue;
      this.#kind[i] = kind;
      this.#radius[i] = SPECS[kind].radius * (0.85 + 0.3 * this.#leafRand());
    }
  }

  #leaves(dt: number, settings: Settings): void {
    if (!(dt > 0)) return;
    const rand = this.#leafRand;
    // Let go: leaves at the knob's pace.
    const rate = settings.leaves * FALL_RATE[settings.season];
    if (rate > 0) {
      this.#nextLeaf -= dt;
      if (this.#nextLeaf <= 0) {
        this.#spawn(settings, false);
        this.#nextLeaf = -Math.log(1 - 0.999 * rand()) / rate;
      }
    }
    // Keep room in the air: past LANDED_MAX on the ground, the oldest starts to fade.
    let landed = 0;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++)
      if (this.#state[i] === LANDED && (this.#lain[i] ?? 0) < (this.#life[i] ?? 0)) landed++;
    if (landed > LANDED_MAX) this.#retireOldest();

    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      const state = this.#state[i];
      if (state === FALLING) {
        this.#alpha[i] = Math.min(1, (this.#alpha[i] ?? 0) + dt / FADE_IN);
        const gust = this.#gustAt(this.#x[i] ?? 0, this.#y[i] ?? 0);
        this.#fall(
          i,
          dt,
          settings.wind * WIND_DRIFT + gust * GUST_DRIFT,
          Math.abs(gust) * GUST_LIFT,
        );
      } else if (state === LANDED) {
        this.#lie(i, dt, this.#gustAt(this.#x[i] ?? 0, this.#y[i] ?? 0));
      } else if (state === LEAVING) {
        this.#leave(i, dt);
      }
    }
  }

  /** A free slot; when there is none, the oldest leaf lying on the gravel is made to fade. */
  #slot(): number | undefined {
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) if (this.#state[i] === FREE) return i;
    this.#retireOldest();
    return undefined;
  }

  /** Start the oldest lying leaf fading, unless one already is. */
  #retireOldest(): void {
    let oldest = -1;
    let oldestAge = -1;
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      if (this.#state[i] !== LANDED) continue;
      const lain = this.#lain[i] ?? 0;
      if (lain >= (this.#life[i] ?? 0)) return;
      if (lain > oldestAge) {
        oldestAge = lain;
        oldest = i;
      }
    }
    if (oldest >= 0) this.#life[oldest] = oldestAge;
  }

  /**
   * A leaf lets go: from the maple's foliage, or (on the veranda) from the boughs overhead, out of
   * frame; a gust also brings some in from upwind. The passage's leaves (`mode`) draw from their
   * own `rand`, so the garden's leaf sequence is the same with or without a passage: an entrance's
   * let go from the boughs over the gravel's left half, an exit's are blown in low, from upwind.
   * Returns its slot, if one was free.
   */
  #spawn(
    settings: Settings,
    gust: boolean,
    rand: () => number = this.#leafRand,
    mode?: SpawnMode,
  ): number | undefined {
    const i = this.#slot();
    if (i === undefined) return undefined;
    const aspect = this.#view.aspect;
    const kind = SEASON_KIND[settings.season];
    const spec = SPECS[kind];
    const zone = rand();
    if (mode === "entrance" && !settings.overhead) {
      // Over the gravel's left, under the boughs swinging in, above the veranda's frame.
      const y = 0.08 + 0.4 * rand();
      const half = (0.5 * aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX + half * (1.5 * rand() - 1);
      this.#y[i] = y;
      this.#z[i] = GARDEN.eyeHeight + 0.03 + 0.03 * (y - GARDEN.eyeY) + 0.05 * rand();
    } else if (mode === "flurry") {
      // Past the frame's upwind edge, low: the gust carries it across.
      const y = 0.12 + 0.6 * rand();
      const half = settings.overhead
        ? 0.5 * aspect * GARDEN.span
        : (0.5 * aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX - this.#gustSign * (half + 0.02 + 0.2 * rand());
      this.#y[i] = y;
      this.#z[i] = 0.08 + 0.2 * rand();
    } else if (!settings.overhead && zone < 0.55) {
      // Overhead boughs, above the veranda's frame.
      const y = 0.06 + 0.42 * rand();
      this.#x[i] = OX + (rand() - 0.5) * 1.1 * (y - GARDEN.eyeY) * 1.4;
      this.#y[i] = y;
      this.#z[i] = GARDEN.eyeHeight + 0.03 + 0.03 * (y - GARDEN.eyeY) + 0.05 * rand();
    } else if (gust && zone > 0.7) {
      // Blown in from upwind, past the frame's edge.
      const y = 0.25 + 0.6 * rand();
      const half = settings.overhead
        ? 0.5 * aspect * GARDEN.span
        : (0.5 * aspect * (y - GARDEN.eyeY)) / GARDEN.focal;
      this.#x[i] = OX - this.#gustSign * (half + 0.05);
      this.#y[i] = y;
      this.#z[i] = 0.12 + 0.12 * rand();
    } else {
      // From inside a clump of the maple, on the garden's side of the wall.
      const [cx, cy, cz, r] =
        GARDEN_CANOPY[Math.floor(rand() * GARDEN_CANOPY.length)] ?? ([0.5, 1, 0.2, 0.08] as const);
      const a = rand() * TAU;
      const d = 0.6 * r * Math.sqrt(rand());
      this.#x[i] = cx + Math.cos(a) * d;
      this.#y[i] = Math.min(cy + Math.sin(a) * d, 0.99);
      this.#z[i] = cz - 0.3 * r * rand();
    }
    const p = this.#plates;
    this.#state[i] = FALLING;
    this.#kind[i] = kind;
    const tumbles = rand() < spec.tumbling;
    const range = tumbles ? spec.tumble : spec.flutter;
    p.mass[i] = lerp(range[0], range[1], rand());
    p.chord[i] = spec.chord * (0.85 + 0.3 * rand());
    p.pace[i] = spec.pace * (0.9 + 0.2 * rand());
    this.#radius[i] = spec.radius * (0.85 + 0.3 * rand());
    p.psi[i] = rand() * TAU;
    p.dpsi[i] = (rand() - 0.5) * 0.6;
    p.start(i);
    p.th[i] = (rand() - 0.5) * 1.2;
    p.sigma[i] = rand() * TAU;
    p.dsigma[i] = (rand() - 0.5) * 0.9;
    p.roll[i] = rand() * TAU;
    p.rollRate[i] = 1.2 + 1.6 * rand();
    this.#hue[i] = rand();
    this.#lain[i] = 0;
    this.#life[i] = lerp(spec.life[0], spec.life[1], rand());
    this.#alpha[i] = 0;
    this.#vx[i] = 0;
    this.#vy[i] = 0;
    p.rest[i] = (rand() - 0.5) * 0.14;
    return i;
  }

  /** Flutter or tumble down: the plate in the leaf's plane, the plane turning, the wind carrying it. */
  #fall(i: number, dt: number, windX: number, lift: number): void {
    const pos = this.#pos;
    pos[0] = this.#x[i] ?? 0;
    pos[1] = this.#y[i] ?? 0;
    pos[2] = this.#z[i] ?? 0;
    const landed = this.#plates.fly(i, dt, pos, windX, 0, lift, this.#floor);
    const x = pos[0] ?? 0;
    const y = pos[1] ?? 0;
    this.#x[i] = x;
    this.#y[i] = y;
    this.#z[i] = Math.min(pos[2] ?? 0, 0.8);
    if (x < -0.3 || x > GA + 0.3 || y < -0.25 || y > 1.4) {
      this.#state[i] = FREE;
      return;
    }
    if (landed) this.#land(i);
  }

  /** Touch down: rest on what lies there, or vanish if nobody would see it lie. */
  #land(i: number): void {
    const x = this.#x[i] ?? 0;
    const y = this.#y[i] ?? 0;
    const seen = this.#view.project(x, y, 0);
    const offGravel = y < 0 || y > GARDEN.wallY - 0.01;
    if (
      seen === undefined ||
      offGravel ||
      seen.u < -0.05 ||
      seen.u > 1.05 ||
      seen.v < -0.05 ||
      seen.v > 1.05
    ) {
      this.#state[i] = FREE;
      return;
    }
    this.#state[i] = LANDED;
    this.#z[i] = this.#groundAt(x, y) + LEAF_LIFT;
    this.#plates.touchDown(i);
    this.#lain[i] = 0;
  }

  /** On the gravel: settle flat, skitter in a gust (`gust` its push here), fade at the end. */
  #lie(i: number, dt: number, gust: number): void {
    const lain = (this.#lain[i] ?? 0) + dt;
    this.#lain[i] = lain;
    // Face up or face down, whichever is nearer.
    const p = this.#plates;
    p.settle(i, smoothstep(0, SETTLE_SECONDS, lain));
    if (Math.abs(gust) > 0.05) {
      // Skitter downwind a little, turning, each leaf by its own share; at the gust's height the
      // lightest are carried off along the gravel.
      const share = 0.15 + 0.35 * (this.#hue[i] ?? 0);
      this.#x[i] = (this.#x[i] ?? 0) + gust * GUST_DRIFT * share * dt;
      p.sigma[i] = (p.sigma[i] ?? 0) + gust * share * 2.5 * dt;
      this.#z[i] = this.#groundAt(this.#x[i] ?? 0, this.#y[i] ?? 0) + LEAF_LIFT;
      if (Math.abs(gust) > GUST_CARRY_AT && (this.#hue[i] ?? 0) > 1 - GUST_CARRY) {
        this.#state[i] = LEAVING;
        this.#vx[i] = gust * GUST_DRIFT * 2 * share;
        this.#vy[i] = 0;
      }
    }
    if (lain > (this.#life[i] ?? 60)) {
      this.#alpha[i] = Math.max(0, (this.#alpha[i] ?? 0) - dt / FADE_OUT);
      if ((this.#alpha[i] ?? 0) <= 0) this.#state[i] = FREE;
    }
  }

  /** Swept away by a rake or a gust: slide on ahead of it and fade. */
  #leave(i: number, dt: number): void {
    this.#x[i] = (this.#x[i] ?? 0) + (this.#vx[i] ?? 0) * dt;
    this.#y[i] = (this.#y[i] ?? 0) + (this.#vy[i] ?? 0) * dt;
    this.#vx[i] = (this.#vx[i] ?? 0) * Math.exp(-1.5 * dt);
    this.#vy[i] = (this.#vy[i] ?? 0) * Math.exp(-1.5 * dt);
    const p = this.#plates;
    p.sigma[i] = (p.sigma[i] ?? 0) + (p.dsigma[i] ?? 0) * 2 * dt;
    this.#alpha[i] = Math.max(0, (this.#alpha[i] ?? 0) - dt / SWEEP_SECONDS);
    if ((this.#alpha[i] ?? 0) <= 0) this.#state[i] = FREE;
  }

  /** The first frame shows leaves already lying about, and a few on their way down in plain view. */
  #prewarmLeaves(settings: Settings): void {
    this.#leafRand = mulberry32(0x6c656166 ^ settings.seed);
    const rand = this.#leafRand;
    for (let n = 0; n < PREWARM_FALLING; n++) {
      const i = this.#spawn(settings, false);
      if (i === undefined) break;
      // In the air over the gravel, between the top of the veranda's frame and half way down it.
      const y = 0.12 + 0.5 * rand();
      const depth = y - GARDEN.eyeY;
      this.#x[i] = OX + (2 * rand() - 1) * 0.5 * depth;
      this.#y[i] = y;
      this.#z[i] = Math.max(
        0.1,
        GARDEN.eyeHeight + ((0.72 + 0.26 * rand() - GARDEN.horizon) * depth) / GARDEN.focal,
      );
      // Let it fall a moment, so it is in its swing.
      const seconds = 0.5 + 0.8 * rand();
      for (let t = 0; t < seconds && this.#state[i] === FALLING; t += 0.05)
        this.#fall(i, 0.05, settings.wind * WIND_DRIFT, 0);
      this.#alpha[i] = 1;
    }
    for (let n = 0; n < PREWARM_LANDED; n++) {
      const i = this.#spawn(settings, false);
      if (i === undefined) break;
      // Somewhere both views see, off the stones.
      let x = OX;
      let y = 0.5;
      for (let tries = 0; tries < 20; tries++) {
        y = 0.12 + 0.72 * rand();
        x = OX + (2 * rand() - 1) * (Math.min(0.6 * (y - GARDEN.eyeY), 0.85) - 0.05);
        if (!(this.#gravel?.onStone(x, y) ?? false)) break;
      }
      this.#x[i] = x;
      this.#y[i] = y;
      this.#plates.th[i] = (this.#plates.rest[i] ?? 0) + (rand() < 0.3 ? Math.PI : 0);
      this.#land(i);
      if (this.#state[i] !== LANDED) continue;
      this.#lain[i] = (this.#life[i] ?? 60) * rand();
      this.#alpha[i] = 1;
    }
    this.#nextLeaf = 1 + 2 * rand();
  }

  /** The boughs' row of the records atlas (see the header). */
  #pack(data: Float32Array): void {
    for (let i = 0; i < GARDEN_LEAF_SLOTS; i++) {
      const o = i * 16;
      const state = this.#state[i] ?? FREE;
      if (state === FREE) {
        data.fill(0, o, o + 16);
        continue;
      }
      // The plate's chord and span axes (x, y, z), its rock about the chord fading as it settles.
      const settle = state === FALLING ? 1 : 1 - smoothstep(0, SETTLE_SECONDS, this.#lain[i] ?? 0);
      const f = this.#frame;
      this.#plates.orient(i, settle, f);
      data[o] = (this.#x[i] ?? 0) - OX;
      data[o + 1] = (this.#y[i] ?? 0) - OY;
      data[o + 2] = this.#z[i] ?? 0;
      data[o + 3] = this.#alpha[i] ?? 0;
      data[o + 4] = f[0] ?? 0;
      data[o + 5] = f[1] ?? 0;
      data[o + 6] = f[2] ?? 0;
      data[o + 7] = this.#radius[i] ?? 0.01;
      data[o + 8] = f[3] ?? 0;
      data[o + 9] = f[4] ?? 0;
      data[o + 10] = f[5] ?? 0;
      data[o + 11] = this.#kind[i] ?? 0;
      data[o + 12] = this.#hue[i] ?? 0;
      data[o + 13] =
        state === FALLING
          ? 0
          : clamp((this.#lain[i] ?? 0) / Math.max(this.#life[i] ?? 60, 1), 0, 1);
      data[o + 14] = state === FALLING ? 0 : 1;
      data[o + 15] = 0;
    }
  }
}

/** The boughs layer's sim (LayerCode.sim): its leaves on its records. */
export function boughsSim(_gl: WebGL2RenderingContext, params: readonly ParamDef[]): LayerSim {
  return new Boughs(params);
}
