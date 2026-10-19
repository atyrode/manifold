// Bumblebees: big, slow and low, lurching from plant to plant. On a foxglove a bumblebee starts at the
// lowest open bells and works its way up the spike, bell by bell (following the spike as the wind
// sways it), and leaves from the top, as bumblebees work Digitalis (Best & Bierzychudek 1982); it
// also works the near poppies and daisies, a spot or two on each head, and the lavender, now and then
// the poppies' drift or the cosmos. It only goes to what the `flowers` knob leaves standing (each
// foxglove and near bloom from its own value, the lush garden's more past 1; the drifts as wide as
// the knob grows them), leaves a plant the knob thins away under it, and with no flowers at all
// there are none. By day, in dry weather; they draw from a stream of their own.
import { clamp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { ARRIVE, CAMERA, type Garden, moving, settle, type Steered, steer, TAU } from "./garden.ts";
import { BEES_BLOOMS_ALL, BEES_CODE, BEES_FOXGLOVES_ALL } from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

export const BEES_MAX_BUMBLEBEES = 6;

const BUMBLEBEE_LENGTH = 0.022;
const BUMBLEBEE_SPEED = 0.5;
const BUMBLEBEE_HOP = 0.32;
/** The drifts a bumblebee works besides the foxgloves and near blooms: lavender, poppies, cosmos (patch indices). */
const BUMBLEBEE_DRIFTS = [0, 1, 4] as const;
/**
 * How often it picks each kind of plant: a foxglove, a near bloom, then each of BUMBLEBEE_DRIFTS
 * (the drifts' share thinned with them below `flowers` 1).
 */
const PLANT_FOXGLOVE = 0.4;
const PLANT_BLOOM = 0.1;
const PLANT_DRIFTS = [0.3, 0.1, 0.1] as const;
/** The open bells of a spike, as shares of its height (shader.ts beesFoxglove: bells from 0.4, buds past 0.9); how far up the next bell is. */
const BELL_LOW = 0.44;
const BELL_TOP = 0.86;
const BELL_STEP = [0.05, 0.11] as const;

type BumblebeeMode = "fly" | "feed";
type BumblebeePlant = "foxglove" | "bloom" | "drift";

interface Bumblebee extends Steered {
  active: boolean;
  /** Leaving the frame (dusk, rain, fewer asked for, no flowers, the scene's exit); inactive once out of it. */
  off: boolean;
  mode: BumblebeeMode;
  hold: number;
  /** The plant it works: a foxglove or a near bloom (its index in BEES_FOXGLOVES_ALL, BEES_BLOOMS_ALL), or a drift (its place in BUMBLEBEE_DRIFTS). */
  on: BumblebeePlant;
  plant: number;
  /** On a foxglove: the bell's height on the spike (a share of it), and which side of it; on a near bloom, the spot on its head (shares of its radius). */
  bell: number;
  side: number;
  /** Flowers left to visit on a near bloom or in a drift. */
  visits: number;
}

function newBumblebee(): Bumblebee {
  return {
    ...moving(),
    t: 0,
    age: 0,
    phase: 0,
    pace: 1,
    active: false,
    off: false,
    mode: "fly",
    hold: 0,
    on: "foxglove",
    plant: 0,
    bell: 0.6,
    side: 1,
    visits: 0,
  };
}

export class Bumblebees {
  readonly list: Bumblebee[] = Array.from({ length: BEES_MAX_BUMBLEBEES }, newBumblebee);
  /** How many are about (the `bumblebees` knob). */
  count = 0;
  readonly #garden: Garden;
  readonly #random = new Random(0xb0b);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** As many as the knob asks for by day while there are flowers: newcomers fly in from the edge (at work where they are as the page opens), the rest fly off. */
  wake(first: boolean): void {
    const garden = this.#garden;
    const day = !garden.roost && !garden.leaving && garden.flowers > 0;
    for (const [i, b] of this.list.entries()) {
      const want = day && i < this.count;
      if (want && !b.active) this.#wake(b, first);
      else if (!want && b.active && !b.off) this.#leave(b);
    }
  }

  /** A new stage width: every X scales with it. */
  restage(ratio: number): void {
    for (const b of this.list) {
      b.x *= ratio;
      b.px *= ratio;
      b.tx *= ratio;
    }
  }

  step(dt: number): void {
    for (const b of this.list) {
      if (!b.active) continue;
      settle(b);
      this.#step(b, dt);
    }
  }

  #leave(b: Bumblebee): void {
    this.#garden.sendOff(b);
    b.mode = "fly";
    b.t = 1;
  }

  #wake(b: Bumblebee, inScene: boolean): void {
    const garden = this.#garden;
    const rand = this.#random;
    b.active = true;
    b.off = false;
    b.phase = rand.next() * TAU;
    b.pace = rand.range(0.85, 1.1);
    b.age = rand.next() * 10;
    b.cx = Number.NaN;
    this.#nextPlant(b);
    if (inScene) {
      // At work on its first plant.
      b.mode = "feed";
      b.hold = rand.range(0.5, 5);
      b.x = b.tx;
      b.z = b.tz;
      b.h = b.th;
    } else {
      garden.edgePoint(b.tx, b.tz, b.th);
      b.x = garden.pt.x;
      b.z = garden.pt.z;
      b.h = clamp(b.th, 0.3, 1);
      b.mode = "fly";
    }
    b.vx = 0;
    b.vz = 0;
    b.vh = 0;
    settle(b);
  }

  /**
   * A new plant that stands: a foxglove (from its lowest open bells), a near poppy or daisy, or a
   * flower in the lavender, less often the poppies' drift or the cosmos. Only while some flowers
   * stand (`flowers` above 0, which every caller sees to).
   */
  #nextPlant(b: Bumblebee): void {
    const garden = this.#garden;
    const rand = this.#random;
    const thin = Math.min(garden.flowers, 1);
    const fox = garden.standing(BEES_FOXGLOVES_ALL) > 0 ? PLANT_FOXGLOVE : 0;
    const bloom = garden.standing(BEES_BLOOMS_ALL) > 0 ? PLANT_BLOOM : 0;
    let pick =
      rand.next() * (fox + bloom + thin * (PLANT_DRIFTS[0] + PLANT_DRIFTS[1] + PLANT_DRIFTS[2]));
    if (pick < fox) {
      b.on = "foxglove";
      b.plant = garden.pickStanding(BEES_FOXGLOVES_ALL, rand);
      b.bell = rand.range(BELL_LOW, BELL_LOW + 0.06);
      b.side = rand.next() < 0.5 ? -1 : 1;
    } else if (pick < fox + bloom) {
      b.on = "bloom";
      b.plant = garden.pickStanding(BEES_BLOOMS_ALL, rand);
      this.#headSpot(b);
      b.visits = 1 + rand.int(3);
    } else {
      pick -= fox + bloom;
      let drift = 0;
      while (drift < PLANT_DRIFTS.length - 1 && pick >= thin * (PLANT_DRIFTS[drift] ?? 0)) {
        pick -= thin * (PLANT_DRIFTS[drift] ?? 0);
        drift++;
      }
      b.on = "drift";
      b.plant = drift;
      garden.flowerPoint(BUMBLEBEE_DRIFTS[drift] ?? 0, rand);
      b.tx = garden.pt.x;
      b.tz = garden.pt.z;
      b.th = garden.pt.h;
      b.visits = 2 + rand.int(4);
    }
    this.#bloomPoint(b);
    b.t = 0;
  }

  /** A spot on a near bloom's head, near its middle and upper petals: into bell (across) and side (up). */
  #headSpot(b: Bumblebee): void {
    const rand = this.#random;
    b.bell = rand.range(-0.45, 0.45);
    b.side = rand.range(0, 0.5);
  }

  /** Whether the plant it works still stands. */
  #stands(b: Bumblebee): boolean {
    const flowers = this.#garden.flowers;
    if (b.on === "drift") return flowers > 0;
    const plant = (b.on === "foxglove" ? BEES_FOXGLOVES_ALL : BEES_BLOOMS_ALL)[b.plant];
    return plant !== undefined && flowers >= plant[3];
  }

  /** Where it feeds: a foxglove's bell or a near bloom's head, which move in the wind, or the flower it picked in a drift. */
  #bloomPoint(b: Bumblebee): void {
    const garden = this.#garden;
    if (b.on === "drift") return;
    if (b.on === "foxglove") garden.bellPoint(b.plant, b.bell, b.side);
    else garden.bloomPoint(b.plant, b.bell, b.side);
    b.tx = garden.pt.x;
    b.tz = garden.pt.z;
    b.th = garden.pt.h;
  }

  #step(b: Bumblebee, dt: number): void {
    const garden = this.#garden;
    const rand = this.#random;
    b.age += dt;
    b.t += dt;
    if (b.off) {
      steer(b, BUMBLEBEE_SPEED * 2 * garden.flit, 0.4, dt);
      if (garden.outside(b.x, b.z, b.h, 0.08)) b.active = false;
      return;
    }
    if (!this.#stands(b)) {
      // Thinned away under it: on to another plant.
      this.#nextPlant(b);
      b.mode = "fly";
    }
    this.#bloomPoint(b);
    if (b.mode === "feed") {
      // Clinging to the bell or the head (swaying with it) or the flower.
      b.x = b.tx;
      b.z = b.tz;
      b.h = b.th;
      b.vx = 0;
      b.vz = 0;
      b.vh = 0;
      b.hold -= dt;
      if (b.hold > 0) return;
      b.mode = "fly";
      if (b.on === "foxglove") {
        // The next bell up the spike, now and then round the other side; off the top, the next plant.
        b.bell += rand.range(BELL_STEP[0], BELL_STEP[1]);
        if (b.bell <= BELL_TOP) {
          if (rand.next() < 0.3) b.side = -b.side;
          this.#bloomPoint(b);
          b.t = 0.5;
          return;
        }
        this.#nextPlant(b);
        return;
      }
      b.visits -= 1;
      if (b.visits > 0) {
        // Another spot on the head, or a flower close by.
        if (b.on === "bloom") {
          this.#headSpot(b);
          this.#bloomPoint(b);
        } else {
          garden.nearFlower(BUMBLEBEE_DRIFTS[b.plant] ?? 0, b.x, b.z, b.h, 0.12, 0.4, rand);
          b.tx = garden.pt.x;
          b.tz = garden.pt.z;
          b.th = garden.pt.h;
        }
        b.t = 0.5;
        return;
      }
      this.#nextPlant(b);
      return;
    }
    const hop = b.t > 0.4 && Math.hypot(b.tx - b.x, b.tz - b.z) < 0.6;
    const dist = steer(b, hop ? BUMBLEBEE_HOP : BUMBLEBEE_SPEED, 0.45, dt);
    // Heavy: a slow lurch up and down on the way.
    b.h = Math.max(
      0.03,
      b.h +
        0.06 * TAU * 1.3 * Math.cos(TAU * 1.3 * b.age + b.phase) * dt * smoothstep(0.1, 0.5, dist),
    );
    if (dist < ARRIVE) {
      b.mode = "feed";
      b.hold = b.on === "drift" ? rand.range(1.5, 4.5) : rand.range(2.5, 6);
    }
  }

  /** A dark speck, bigger than a bee; near, a black body with its yellow band and a glint of wing in flight. */
  paint(p: Painter, alpha: number): void {
    const specks = p.specks;
    const h = specks.height;
    for (const b of this.list) {
      if (!b.active) continue;
      const z = p.project(b, alpha);
      if (z === 0) continue;
      const depth = depthByte(z);
      const n = (BUMBLEBEE_LENGTH * h * CAMERA.focal) / z;
      if (n < 1.7) {
        specks.plot(
          b.cx,
          b.cy,
          n >= 0.8 ? BEES_CODE.bumblebee : n >= 0.5 ? BEES_CODE.beeDim : BEES_CODE.beeFaint,
          depth,
        );
        continue;
      }
      const length = n < 3.2 ? 2 : 3;
      const tall = n < 3.2 ? 1 : 2;
      specks.block(b.cx, b.cy, length, tall, BEES_CODE.bumblebee, depth);
      specks.plot(b.cx + length - 2, b.cy + tall - 1, BEES_CODE.bumblebeeBand, depth);
      if (b.mode === "fly")
        specks.block(b.cx, b.cy + tall, length - 1, 1, BEES_CODE.beeWing, depth);
    }
  }
}
