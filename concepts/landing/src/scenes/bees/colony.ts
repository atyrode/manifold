// The colony: up to two hundred bees working the three hives, each a small state machine stepped at
// the sim's fixed step (the modes are listed in sim.ts's header). Its draws come from the garden's
// stream (Garden.random, which the butterflies share, as they always have); the opening state of the
// bees beyond BEES_FIRST from a stream of their own.
//
// Pollen-drunk (the `silly` knob, 0..1). A drunk bee flies a leg in big, curvy, wobbly loops that
// swell and fade, bouncing up and down as it goes (`#reel`, in place of steer's straight beeline);
// it bumps off what it meant to land on (a flower once or twice, the landing board up to three
// times: up and back, then it tries again), off the hives' fronts and the flower heads in its way,
// and off any bee it comes within BUMP_REACH of (`#knock`). Whether a leg is drunk is the bee's own
// giddiness (fixed, from a stream of its own) against the knob (`pollenDrunk`): at 0 nobody, the
// colony as it always was; from 0 up the heavily loaded foragers flying home first; from 0.5 every
// other leg too, the crowds at the entrances bouncing as they hover; at 1 every bee. Its draws (the
// bumps) come from a stream of its own as well, and it all runs on the sim's fixed step, so it plays
// the same at any frame rate.
import { smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import {
  ARRIVE,
  BeesSimError,
  CAMERA,
  chase,
  depthPace,
  type Garden,
  settle,
  type Steered,
  steer,
  TAU,
} from "./garden.ts";
import {
  BEES_CODE,
  BEES_GROUND_PATCHES,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_PATCHES,
} from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_BEES = 200;
/**
 * The colony's first this many bees take their opening state from the colony's stream, as when it
 * held no more, so a colony of up to this many opens as it always has; the rest from a stream of
 * their own.
 */
const BEES_FIRST = 64;

/** A worker's length (m). */
export const BEE_LENGTH = 0.015;

// Bees (m and m/s). Speeds are scaled by depth (see `depthPace`) so on screen they read the same near and far.
const CRUISE = 0.9;
const HOP = 0.55;
const MILL_SPEED = 0.15;
const ORIENT_RATE = 0.85;
/** Share of foragers that fly a pass close to the lens on their way out, and where (m). */
const PASS_SHARE = 0.12;
const PASS_Z_MIN = 1.8;
const PASS_Z_MAX = 3.2;

// Pollen-drunk: the load from which a forager is heavily loaded; the loops (a push this many m/s at
// the pace of 8 m depth, turning round this many times a second); the bounce (its height in m, and
// hops a second) and the wobble across (m/s); how near (m) one bee knocks into another, how much of
// its speed comes back off a bump, and how far in front of a hive's front (m) it meets it.
const HEAVY = 0.85;
const REEL_LOOP = 2.2;
const REEL_RATE = 0.5;
const REEL_BOUNCE = 0.12;
const REEL_HOPS = 1.4;
const REEL_WOBBLE = 0.3;
const BUMP_REACH = 0.045;
const BUMP_BACK = 0.55;
const FRONT_GAP = 0.05;
/** A hive's front, metres: its half width (with the roof's overhang) and its top, above the ground. */
const HIVE_HALF = (0.5 * BEES_HIVE.width + 0.06) * BEES_HIVE_SCALE;
const HIVE_TOP =
  (BEES_HIVE.stand + BEES_HIVE.boxes * BEES_HIVE.box + BEES_HIVE.roof) * BEES_HIVE_SCALE;

/**
 * Whether a bee of giddiness `giddy` (0..1, its own) flies a leg pollen-drunk at silliness `silly`:
 * a heavily loaded forager on its way home from silly 0 (all of them by 0.5), any other leg from 0.5
 * (all by 1). None at 0, every one at 1.
 */
export function pollenDrunk(silly: number, giddy: number, heavy: boolean): boolean {
  return silly > (heavy ? 0.5 * giddy : 0.5 + 0.5 * giddy);
}

export type BeeMode = "inside" | "mill" | "orient" | "out" | "forage" | "home" | "land";

export interface Bee extends Steered {
  hive: number;
  mode: BeeMode;
  /** Seconds left in this mode (where it has a length), and seconds since it began. */
  hold: number;
  patch: number;
  visits: number;
  load: number;
  newbie: boolean;
  resting: boolean;
  fly: boolean;
  /** On its way out it first flies a pass close to the lens. */
  via: boolean;
  /** Its first time out of the hive (an entrance): straight for the flowers. */
  pour: boolean;
  /** Its giddiness (0..1, pollenDrunk) and which way its drunk loops turn (±1), its own for good. */
  giddy: number;
  spin: number;
  /** Flying this leg pollen-drunk, and how many more times it bumps off where it means to land. */
  drunk: boolean;
  bumps: number;
}

function newBee(hive: number, giddy: number, spin: number): Bee {
  return {
    hive,
    mode: "inside",
    hold: 0,
    t: 0,
    age: 0,
    x: 0,
    z: 10,
    h: 0,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 10,
    th: 0,
    patch: 0,
    visits: 0,
    load: 0,
    phase: 0,
    pace: 1,
    newbie: false,
    resting: false,
    fly: false,
    via: false,
    pour: false,
    giddy,
    spin,
    drunk: false,
    bumps: 0,
    cx: Number.NaN,
    cy: Number.NaN,
    px: 0,
    pz: 10,
    ph: 0,
  };
}

export class Colony {
  readonly bees: Bee[];
  /** How many bees are about (the `bees` knob) and how silly they are (the `silly` knob). */
  count = 0;
  silly = 0;
  readonly #garden: Garden;
  /** The opening state of the bees beyond BEES_FIRST. */
  readonly #reserve = new Random(0x5eed64);
  /** Pollen-drunk draws: the bumps of a drunk leg. */
  readonly #giddy = new Random(0x6199);
  /** Some leg was flown drunk this step: the knocks between bees are looked for. */
  #reeling = false;

  constructor(garden: Garden) {
    this.#garden = garden;
    const giddy = new Random(0x61dd7);
    this.bees = Array.from({ length: BEES_MAX_BEES }, (_, i) =>
      newBee(i % BEES_HIVES.length, giddy.next(), giddy.next() < 0.5 ? -1 : 1),
    );
  }

  /** The very first frame: every bee asleep inside at a scattered time. */
  seed(): void {
    const garden = this.#garden;
    for (const [i, bee] of this.bees.entries()) {
      const from = i < BEES_FIRST ? garden.random : this.#reserve;
      bee.mode = "inside";
      bee.hold = from.range(0.5, 9);
      bee.newbie = from.next() < 0.14;
      bee.pace = from.range(0.9, 1.12);
      bee.phase = from.next() * TAU;
      bee.patch = garden.pickPatch(false, from);
    }
  }

  /** An entrance opens on a colony yet to come out: nearly every bee leaves its hive within the first two seconds, young ones to loop before it. */
  pourOut(): void {
    const rand = this.#garden.random;
    for (const [i, bee] of this.bees.entries()) {
      if (i >= this.count) continue;
      if (bee.newbie) {
        bee.hold = rand.range(0.6, 2.2);
      } else if (rand.next() < 0.85) {
        bee.pour = true;
        bee.hold = rand.range(0.3, 2.2);
      }
    }
  }

  /** The exit begins: foragers and young bees turn for their hive, the crowd at the entrances files in. */
  recall(): void {
    const rand = this.#garden.random;
    for (const bee of this.bees) {
      if (bee.mode === "out" || bee.mode === "forage" || bee.mode === "orient") {
        this.#home(bee);
        bee.t = 1;
      } else if (bee.mode === "mill") {
        bee.hold = Math.min(bee.hold, rand.range(0.1, 0.9));
      }
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const bee of this.bees) {
      bee.x *= ratio;
      bee.px *= ratio;
      bee.tx *= ratio;
    }
  }

  step(dt: number): void {
    this.#reeling = false;
    for (const [i, bee] of this.bees.entries()) {
      settle(bee);
      this.#stepBee(bee, i, dt);
    }
    if (this.#reeling) this.#knock();
  }

  #enter(b: Bee, i: number): void {
    const rand = this.#garden.random;
    b.mode = "inside";
    b.hold = rand.range(1, 4);
    b.fly = false;
    b.load = 0;
    b.vx = 0;
    b.vz = 0;
    b.vh = 0;
    b.drunk = false;
    // Now and then the bee that goes in is a young one when it comes out again.
    if (i < this.count && rand.next() < 0.1) b.newbie = true;
  }

  #begin(b: Bee, mode: BeeMode, hold: number): void {
    b.mode = mode;
    b.hold = hold;
    b.t = 0;
  }

  /** Whether the leg it sets out on is flown drunk, and if so how many times it bumps off its landing (`most` at most). */
  #legDrunk(b: Bee, heavy: boolean, most: number): void {
    b.drunk = !this.#garden.leaving && pollenDrunk(this.silly, b.giddy, heavy);
    b.bumps = b.drunk ? 1 + this.#giddy.int(most) : 0;
  }

  #millTarget(b: Bee): void {
    const garden = this.#garden;
    const rand = garden.random;
    garden.locate(b.hive);
    const g = garden.geo;
    b.tx = g.landX + rand.range(-1, 1) * g.half;
    const hover = rand.next() < 0.45;
    b.tz = g.landZ - (hover ? rand.range(0, 0.2) : 0);
    b.th = g.landH + (hover ? rand.range(0.03, 0.75) : 0);
    b.fly = hover;
    b.phase = rand.next() * TAU;
    b.drunk = pollenDrunk(this.silly, b.giddy, false);
  }

  #depart(b: Bee): void {
    const garden = this.#garden;
    const rand = garden.random;
    // Mostly back to the patch it worked last, unless that was a bed now out of flower.
    if (rand.next() > 0.7 || !garden.blooms(b.patch)) b.patch = garden.pickPatch(false);
    b.fly = true;
    b.resting = false;
    b.via = rand.next() < PASS_SHARE;
    if (b.via) {
      // A pass close to the lens: out toward the viewer, then on to the flowers.
      b.tz = rand.range(PASS_Z_MIN, PASS_Z_MAX);
      b.tx = rand.range(-0.7, 0.7) * garden.stage * b.tz;
      b.th = rand.range(0.6, 1.5);
    } else {
      garden.flowerPoint(b.patch);
      b.tx = garden.pt.x;
      b.tz = garden.pt.z;
      b.th = garden.pt.h;
    }
    this.#begin(b, "out", 0);
    this.#legDrunk(b, false, 2);
  }

  #home(b: Bee): void {
    const garden = this.#garden;
    const rand = garden.random;
    garden.locate(b.hive);
    const g = garden.geo;
    b.tx = g.landX + rand.range(-0.8, 0.8) * g.half;
    b.tz = g.landZ;
    b.th = g.landH;
    b.fly = true;
    b.via = false;
    this.#begin(b, "home", 0);
    this.#legDrunk(b, b.load >= HEAVY, 3);
  }

  #stepBee(b: Bee, i: number, dt: number): void {
    const garden = this.#garden;
    const rand = garden.random;
    b.age += dt;
    b.t += dt;
    switch (b.mode) {
      case "inside": {
        // Shut in at dusk, at night and in the wet: the wait resumes when it is light and dry.
        if (i >= this.count || garden.leaving || !garden.open) break;
        b.hold -= dt;
        if (b.hold > 0) break;
        garden.locate(b.hive);
        const g = garden.geo;
        b.x = g.landX + rand.range(-0.7, 0.7) * g.half;
        b.z = g.landZ;
        b.h = g.landH;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        // Out of the hive: drawn from here, not from where it went in.
        settle(b);
        if (b.newbie) {
          this.#begin(b, "orient", rand.range(9, 16));
          b.fly = true;
          b.phase = rand.next() * TAU;
        } else if (b.pour) {
          b.pour = false;
          this.#depart(b);
          b.t = 0.6;
        } else if (rand.next() < 0.4) {
          this.#begin(b, "mill", rand.range(4, 10));
          this.#millTarget(b);
        } else {
          this.#depart(b);
        }
        break;
      }
      case "mill": {
        b.hold -= dt;
        this.#steerMill(b, dt);
        if (b.age % 1.7 < dt) this.#millTarget(b);
        if (b.hold <= 0) {
          if (garden.leaving || !garden.open) this.#enter(b, i);
          else if (!b.newbie && i < this.count && rand.next() < 0.6) this.#depart(b);
          else this.#enter(b, i);
        }
        break;
      }
      case "orient": {
        b.drunk = false;
        if (!garden.open) {
          // Dusk or rain cuts the lesson short; it is still young tomorrow.
          this.#home(b);
          break;
        }
        garden.locate(b.hive);
        const g = garden.geo;
        const a = ORIENT_RATE * b.t + b.phase;
        b.tx = g.x + 0.9 * BEES_HIVE_SCALE * Math.cos(a);
        b.tz = g.z - 0.9 + 0.7 * Math.sin(a);
        b.th = (BEES_HIVE.stand + 0.1) * BEES_HIVE_SCALE + 0.75 * (0.6 + 0.4 * Math.sin(2 * a));
        chase(b, b.tx, b.tz, b.th, 0.5, 1.4, 1 - Math.exp(-dt / 0.2), dt);
        b.hold -= dt;
        if (b.hold <= 0) {
          b.newbie = false;
          this.#home(b);
        }
        break;
      }
      case "out": {
        if (!garden.open) {
          this.#home(b);
          break;
        }
        const dist = b.drunk
          ? this.#reel(b, CRUISE * garden.rush, true, dt)
          : steer(b, CRUISE * garden.rush, 0.3, dt);
        if (dist < ARRIVE * (b.via ? 4 : 1)) {
          if (b.via) {
            b.via = false;
            garden.flowerPoint(b.patch);
            b.tx = garden.pt.x;
            b.tz = garden.pt.z;
            b.th = garden.pt.h;
            b.t = 0.5;
            break;
          }
          if (b.drunk && b.bumps > 0) {
            this.#bounce(b);
            break;
          }
          b.visits = 3 + rand.int(5);
          b.resting = true;
          b.fly = false;
          this.#begin(b, "forage", rand.range(0.6, 1.6));
        }
        break;
      }
      case "forage": {
        if (!garden.open) {
          this.#home(b);
          break;
        }
        if (b.resting) {
          b.hold -= dt;
          b.vx *= Math.exp(-dt * 6);
          b.vz *= Math.exp(-dt * 6);
          b.vh *= Math.exp(-dt * 6);
          if (b.hold > 0) break;
          if (b.visits <= 0) {
            this.#home(b);
            break;
          }
          this.#nextFlower(b);
          break;
        }
        const dist = b.drunk ? this.#reel(b, HOP, false, dt) : steer(b, HOP, 1.0, dt);
        if (dist < ARRIVE) {
          if (b.drunk && b.bumps > 0) {
            this.#bounce(b);
            break;
          }
          b.visits -= 1;
          b.load = Math.min(1, b.load + 0.22);
          b.resting = true;
          b.fly = false;
          b.hold = rand.range(0.5, 1.8);
        }
        break;
      }
      case "home": {
        const dist = b.drunk
          ? this.#reel(b, CRUISE * garden.rush, true, dt)
          : steer(b, CRUISE * garden.rush, 0.3, dt);
        if (dist < ARRIVE) {
          if (b.drunk && b.bumps > 0) {
            this.#bounce(b);
            break;
          }
          b.fly = false;
          b.drunk = false;
          this.#begin(b, "land", rand.range(0.5, 1.2));
        }
        break;
      }
      case "land": {
        b.hold -= dt;
        if (garden.leaving && b.hold > 0.15) b.hold = 0.15;
        const k = 1 - Math.exp(-dt * 5);
        b.x += (b.tx - b.x) * k;
        b.z += (b.tz - b.z) * k;
        b.h += (b.th - b.h) * k;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        if (b.hold <= 0) {
          if (!garden.leaving && garden.open && rand.next() < 0.65) {
            this.#begin(b, "mill", rand.range(4, 9));
            this.#millTarget(b);
            b.load = 0;
          } else {
            this.#enter(b, i);
          }
        }
        break;
      }
      default: {
        const unreachable: never = b.mode;
        throw new BeesSimError(`unknown bee mode ${String(unreachable)}`);
      }
    }
    if (b.drunk && b.fly) this.#reeling = true;
  }

  /** Walk or hover toward the mill target (bouncing, hovering drunk); returns the distance left. */
  #steerMill(b: Bee, dt: number): number {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const go = MILL_SPEED * b.pace * smoothstep(0, 0.2, dist);
    const k = 1 - Math.exp(-dt / 0.3);
    const bob = b.drunk && b.fly ? this.#bob(b, 1) : 0;
    b.vx += ((dx / dist) * go - b.vx) * k;
    b.vz += ((dz / dist) * go - b.vz) * k;
    b.vh += ((dh / dist) * go + bob - b.vh) * k;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h += b.vh * dt;
    return dist;
  }

  /** The next flower of a foraging bee: a short zig-zag hop within its patch, toward or away from the viewer as often as across. */
  #nextFlower(b: Bee): void {
    const garden = this.#garden;
    const rand = garden.random;
    garden.nearFlower(b.patch, b.x, b.z, b.h, 0.2, 0.55, rand);
    b.tx = garden.pt.x;
    b.tz = garden.pt.z;
    b.th = garden.pt.h;
    b.phase = rand.next() * TAU;
    b.resting = false;
    b.fly = true;
    b.t = 0.5;
    this.#legDrunk(b, false, 2);
  }

  // ---- pollen-drunk ---------------------------------------------------------------------------------

  /** The upward speed (m/s) of a drunk bee's bounce now: down and up again as a ball bounces, sharp at the bottom. */
  #bob(b: Bee, pace: number): number {
    const hop = Math.PI * REEL_HOPS * b.age + b.phase;
    return REEL_BOUNCE * Math.PI * REEL_HOPS * pace * Math.cos(hop) * (Math.sin(hop) < 0 ? -1 : 1);
  }

  /**
   * A drunk leg toward (tx, tz, th) at `speed` m/s: steer's beeline (eased in, slowing as it arrives),
   * with a push turning round through it that swells and fades (loops where it outruns the flight), a
   * fast wobble across and the bounce; it comes off the hives' fronts and, `overFlowers`, the flower
   * heads under it. Returns the distance left.
   */
  #reel(b: Bee, speed: number, overFlowers: boolean, dt: number): number {
    const dx = b.tx - b.x;
    const dz = b.tz - b.z;
    const dh = b.th - b.h;
    const dist = Math.hypot(dx, dz, dh) + 1e-6;
    const flat = Math.hypot(dx, dz) + 1e-6;
    const fx = dx / flat;
    const fz = dz / flat;
    const pace = depthPace(b.z);
    const go =
      speed *
      pace *
      b.pace *
      (0.12 + 0.88 * smoothstep(0, 0.7, dist)) *
      (0.25 + 0.75 * smoothstep(0, 0.9, b.t));
    const far = smoothstep(0.3, 1.4, dist);
    const swing =
      REEL_LOOP * pace * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(TAU * 0.11 * b.age + b.phase))) * far;
    const turn = TAU * REEL_RATE * b.age + 1.3 * b.phase;
    const along = go * (flat / dist) + swing * Math.cos(turn);
    const across =
      b.spin * swing * Math.sin(turn) +
      REEL_WOBBLE * pace * Math.sin(TAU * 1.7 * b.age + b.phase) * far;
    const k = 1 - Math.exp(-dt / 0.22);
    b.vx += (fx * along - fz * across - b.vx) * k;
    b.vz += (fz * along + fx * across - b.vz) * k;
    b.vh += ((dh / dist) * go + this.#bob(b, pace) * far - b.vh) * k;
    const z0 = b.z;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.h = Math.max(0, b.h + b.vh * dt);
    this.#bumpScenery(b, z0, overFlowers);
    return dist;
  }

  /** Off the front of a hive it flew into from in front, and up off the heads of a drift it dipped into. */
  #bumpScenery(b: Bee, z0: number, overFlowers: boolean): void {
    const garden = this.#garden;
    const g = garden.geo;
    for (let i = 0; i < BEES_HIVES.length; i++) {
      garden.locate(i);
      const front = g.z - FRONT_GAP;
      if (z0 >= front || b.z < front) continue;
      if (Math.abs(b.x - g.x) > HIVE_HALF || b.h <= g.landH + 0.05 || b.h > HIVE_TOP) continue;
      b.z = front;
      b.vz = -Math.abs(b.vz) * BUMP_BACK;
      b.vh += 0.3;
    }
    if (!overFlowers || b.vh >= 0) return;
    for (let i = 0; i < BEES_GROUND_PATCHES; i++) {
      const patch = BEES_PATCHES[i];
      if (patch === undefined || b.h > patch.top + 0.04) continue;
      garden.patchCoords(i, b.x, b.z, b.h);
      if (Math.hypot(garden.pc.ex, garden.pc.ey) > 0.85) continue;
      b.vh = -b.vh * BUMP_BACK + 0.3;
      return;
    }
  }

  /** Off what it meant to land on (a flower, the board): up and back the way it came, to try again. */
  #bounce(b: Bee): void {
    const rand = this.#giddy;
    b.bumps -= 1;
    b.vx = -b.vx * BUMP_BACK + rand.range(-0.25, 0.25);
    b.vz = -b.vz * BUMP_BACK - 0.1;
    b.vh = rand.range(0.6, 0.9);
    b.t = 0.3;
  }

  /**
   * Drunk bees knock into any other bee out of the hive that they come within BUMP_REACH of while
   * closing on it: both bounce apart along the line between them, losing some of the speed.
   */
  #knock(): void {
    const bees = this.bees;
    const reach2 = BUMP_REACH * BUMP_REACH;
    for (const a of bees) {
      if (!a.drunk || !a.fly) continue;
      for (const o of bees) {
        if (o === a || o.mode === "inside") continue;
        const dx = o.x - a.x;
        if (Math.abs(dx) >= BUMP_REACH) continue;
        const dz = o.z - a.z;
        const dh = o.h - a.h;
        const d2 = dx * dx + dz * dz + dh * dh;
        if (d2 >= reach2 || d2 === 0) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const nh = dh / d;
        const closing = (a.vx - o.vx) * nx + (a.vz - o.vz) * nz + (a.vh - o.vh) * nh;
        if (closing <= 0) continue;
        const j = 0.5 * (1 + BUMP_BACK) * closing;
        a.vx -= j * nx;
        a.vz -= j * nz;
        a.vh -= j * nh;
        o.vx += j * nx;
        o.vz += j * nz;
        o.vh += j * nh;
        const apart = 0.5 * (BUMP_REACH - d);
        a.x -= nx * apart;
        a.z -= nz * apart;
        a.h = Math.max(0, a.h - nh * apart);
        o.x += nx * apart;
        o.z += nz * apart;
        o.h = Math.max(0, o.h + nh * apart);
      }
    }
  }

  // ---- drawing ------------------------------------------------------------------------------------

  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    const h = specks.height;
    for (const b of this.bees) {
      if (b.mode === "inside") continue;
      const z = p.project(b, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      // Its real size in cells there.
      const n = (BEE_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(
          b.cx,
          b.cy,
          n >= 0.8 ? BEES_CODE.bee : n >= 0.5 ? BEES_CODE.beeDim : BEES_CODE.beeFaint,
          depth,
        );
        continue;
      }
      // Close to the lens: a dark body two or three cells long (two tall when very near), golden at the back with pollen, and a glint of wing above it in flight.
      const length = n < 3.2 ? 2 : 3;
      const tall = n < 3.2 ? 1 : 2;
      specks.block(b.cx, b.cy, length, tall, BEES_CODE.bee, depth);
      if (b.load > 0.5) specks.block(b.cx + length - 1, b.cy, 1, tall, BEES_CODE.beeLoaded, depth);
      if (b.fly) specks.block(b.cx, b.cy + tall, length - 1, 1, BEES_CODE.beeWing, depth);
    }
  }
}
