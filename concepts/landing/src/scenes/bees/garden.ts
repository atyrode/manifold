// The garden every kind of insect flies in (sim.ts steps them: colony.ts, swarm.ts, butterflies.ts,
// bumblebees.ts, hoverflies.ts, dragonflies.ts, fireflies.ts, glowworms.ts): its eye (CAMERA) and
// stage, the world's hours and weather as the sim last read them, how the scene is passing, the
// `flowers` knob, and the places in the world the kinds fly to, each written into the shared point
// `pt`: a hive's entrance and landing board (`geo`), a flower in a drift, a foxglove's bell, a near
// bloom's head, the path, just past the frame's edge. The flight every kind shares is here too:
// `chase` (ease toward a point) and `steer` (a bee's beeline, weaving).
//
// A perch (a bell, a bloom's head, a landing board, the swarm's branch) is placed in front of what it
// rests on along its view ray (`nearer`), so it is drawn where that thing is and its depth byte
// (BEES_DEPTH_STEP) stays in front of it whatever the rounding: PERCH_FRONT, more than half a step.
import { LevelCamera } from "../../sims/camera.ts";
import { clamp, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { daysAgo, skyState, timeOfDay } from "../../world-clock.ts";
import {
  BEES_ALONG_WALL,
  BEES_BLOOM_HEAD,
  BEES_BLOOMS_ALL,
  BEES_BOARD_HALF,
  BEES_CAM,
  BEES_DEPTH_STEP,
  BEES_FOXGLOVES_ALL,
  BEES_GROUND_PATCHES,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_PATCHES,
  BEES_STAGE_MIN,
  BEES_YH,
  type BeesPlant,
  beesDriftLush,
  beesDriftReach,
} from "./layout.ts";

export const TAU = Math.PI * 2;

/** The garden's eye: everything flies in the world and is drawn where this projects it. */
export const CAMERA = new LevelCamera({ horizon: BEES_YH, eye: BEES_CAM, focal: 1 });

/** How far in front of what it rests on a perch is placed, along its view ray (m): over half a depth step. */
export const PERCH_FRONT = 0.6 / BEES_DEPTH_STEP;

/** The sim's fixed step (s): every kind is stepped on it, and drawn between its last two. */
export const STEP = 1 / 60;

/** How near its target (m) a flier counts as there. */
export const ARRIVE = 0.07;

// The world's hours: daylight (skyState's `day`) below which the hives close and above which they
// open again, and the butterflies' roost the same way; the space between keeps a dusk from flickering.
export const HIVES_SHUT = 0.2;
export const HIVES_OPEN = 0.3;
export const ROOST_FROM = 0.4;
export const ROOST_UNTIL = 0.5;

export class BeesSimError extends Error {}

/** What every insect the map draws has: where it is (m), where it was a step ago, and its drawn cell (NaN: not yet placed). */
export interface Flier {
  x: number;
  z: number;
  h: number;
  px: number;
  pz: number;
  ph: number;
  cx: number;
  cy: number;
}

/** A flier that moves by its velocity toward a target. */
export interface Moving extends Flier {
  vx: number;
  vz: number;
  vh: number;
  tx: number;
  tz: number;
  th: number;
}

/** A flier that steers as a bee does (`steer`): seconds into its leg and alive, its weave's phase and its own pace. */
export interface Steered extends Moving {
  t: number;
  age: number;
  phase: number;
  pace: number;
}

/** A resting flier, nowhere yet: the fields every kind starts from. */
export function moving(): Moving {
  return {
    x: 0,
    z: 8,
    h: 0,
    px: 0,
    pz: 8,
    ph: 0,
    cx: Number.NaN,
    cy: Number.NaN,
    vx: 0,
    vz: 0,
    vh: 0,
    tx: 0,
    tz: 8,
    th: 0,
  };
}

/** Draw a flier from where it is now, as if it had been there a step ago too. */
export function settle(thing: Flier): void {
  thing.px = thing.x;
  thing.pz = thing.z;
  thing.ph = thing.h;
}

/** How fast a thing at depth z moves, as a share of its nominal speed: the same on screen near and far. */
export function depthPace(z: number): number {
  return clamp(z / 8, 0.45, 1.3);
}

/**
 * Ease `b`'s velocity toward (tx, tz, th) at up to `top` m/s, slowing over its last `tau` seconds,
 * by the share `k` of a step, then move it a step. Returns the distance it had left.
 */
export function chase(
  b: Moving,
  tx: number,
  tz: number,
  th: number,
  tau: number,
  top: number,
  k: number,
  dt: number,
): number {
  const dx = tx - b.x;
  const dz = tz - b.z;
  const dh = th - b.h;
  const dist = Math.hypot(dx, dz, dh) + 1e-6;
  const go = Math.min(top, dist / tau);
  b.vx += ((dx / dist) * go - b.vx) * k;
  b.vz += ((dz / dist) * go - b.vz) * k;
  b.vh += ((dh / dist) * go - b.vh) * k;
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  b.h = Math.max(0, b.h + b.vh * dt);
  return dist;
}

/**
 * Steer toward (tx, tz, th) at `speed` m/s: eased in over the first second, slowing as it arrives,
 * with a lateral weave of velocity `weave` (and a little vertical wobble). Returns the distance left.
 */
export function steer(b: Steered, speed: number, weave: number, dt: number): number {
  const dx = b.tx - b.x;
  const dz = b.tz - b.z;
  const dh = b.th - b.h;
  const dist = Math.hypot(dx, dz, dh) + 1e-6;
  const ux = dx / dist;
  const uz = dz / dist;
  const uh = dh / dist;
  const pace = depthPace(b.z);
  const go =
    speed *
    pace *
    b.pace *
    (0.12 + 0.88 * smoothstep(0, 0.7, dist)) *
    (0.25 + 0.75 * smoothstep(0, 0.9, b.t));
  const far = smoothstep(0.3, 1.4, dist);
  const lateral =
    weave *
    pace *
    (0.55 * Math.sin(TAU * 0.37 * b.age + b.phase) +
      0.25 * Math.sin(TAU * 1.3 * b.age + 2 * b.phase)) *
    far;
  const wobble = 0.3 * weave * pace * Math.sin(TAU * 0.53 * b.age + 1.7 * b.phase) * far;
  const flat = Math.hypot(ux, uz) + 1e-6;
  const k = 1 - Math.exp(-dt / 0.22);
  b.vx += (ux * go - (uz / flat) * lateral - b.vx) * k;
  b.vz += (uz * go + (ux / flat) * lateral - b.vz) * k;
  b.vh += (uh * go + wobble - b.vh) * k;
  b.x += b.vx * dt;
  b.z += b.vz * dt;
  b.h = Math.max(0, b.h + b.vh * dt);
  return dist;
}

const PATCH_WEIGHTS: readonly number[] = BEES_PATCHES.map((patch) => patch.weight);
const PATCH_WEIGHT_TOTAL = PATCH_WEIGHTS.reduce((sum, w) => sum + w, 0);
const GROUND_WEIGHT_TOTAL = PATCH_WEIGHTS.slice(0, BEES_GROUND_PATCHES).reduce(
  (sum, w) => sum + w,
  0,
);

export class Garden {
  /** The colony's stream, which the butterflies share, as they always have; every other kind keeps its own. */
  readonly random = new Random(0x5eed);
  /** The last place asked for (m). */
  readonly pt = { x: 0, z: 0, h: 0 };
  /** Where a world point lies in a drift's ellipse (patchCoords). */
  readonly pc = { ex: 0, ey: 0 };
  /** A drift's radii at a point of it (#radii). */
  readonly #r = { x: 0, y: 0 };
  /**
   * The hive last asked about (locate): its entrance (x, z, the hive's own depth), its landing board
   * where a bee stands on it (landX, landZ, landH) and the board's half width there.
   */
  readonly geo = { x: 0, z: 0, landX: 0, landZ: 0, landH: 0, half: 0 };
  /** Half the stage's width (beesStage) and the frame's aspect. */
  stage = BEES_STAGE_MIN;
  aspect = 1;
  /** K_time and K_cycle; the motion clock at the step being taken (the shader's uMotionTime then). */
  time = 0;
  cycle = 0;
  tm = 0;
  /** The daylight and the darkness at the time of day last read (skyState's `day` and `night`). */
  day = 1;
  night = 0;
  /** Rain or snow falling (the larger amount, 0 dry), and the wind (K_wind). */
  wet = 0;
  wind = 0;
  /** Light enough and dry: bees may come out. */
  open = true;
  /** Dusk, night or rain: the butterflies settle and the other day fliers stay away. */
  roost = false;
  /** The sim's first frame fell inside an entrance: the colony opens asleep and pours out of the hives, the butterflies come in from the edges. */
  arriving = false;
  /** The scene is leaving: the foragers fly home, the butterflies bolt for the edge of the frame and nobody comes out. */
  leaving = false;
  /** Speed multipliers (bees on their way out and home, the other insects): 1 at rest, more while the scene arrives or leaves. */
  rush = 1;
  flit = 1;
  /** K_flowers, and how far it has grown the drifts (beesDriftLush, beesDriftReach). */
  flowers = 1;
  /** The days the day cycle has run by the frame's end (its rate phase, SimFrame.phases). */
  days = 0;
  lush = 0;
  reach = 0;
  #tod = Number.NaN;

  /** The flowers knob: which plants stand, and how wide the drifts are. */
  setFlowers(flowers: number): void {
    this.flowers = flowers;
    this.lush = beesDriftLush(flowers);
    this.reach = beesDriftReach(flowers);
  }

  /**
   * The world clock `ago` seconds of the motion clock before the frame's end: the daylight and the
   * darkness, and so whether the hives are open and the day fliers about.
   */
  skyAt(ago: number): void {
    const tod = timeOfDay(this.time, daysAgo(this.days, this.cycle, ago));
    if (tod !== this.#tod) {
      const sky = skyState(tod);
      this.#tod = tod;
      this.day = sky.day;
      this.night = sky.night;
    }
    const wet = this.wet > 0;
    if (this.open ? wet || this.day < HIVES_SHUT : !wet && this.day > HIVES_OPEN)
      this.open = !this.open;
    if (this.roost ? !wet && this.day > ROOST_UNTIL : wet || this.day < ROOST_FROM)
      this.roost = !this.roost;
  }

  // ---- places -------------------------------------------------------------------------------------

  /** Bring `pt` `by` metres nearer the eye along its view ray: drawn where it was, in front of what stands there. */
  nearer(by: number): void {
    const pt = this.pt;
    const k = (pt.z - by) / pt.z;
    pt.x *= k;
    pt.h = BEES_CAM - (BEES_CAM - pt.h) * k;
    pt.z -= by;
  }

  /** Hive `hive`'s entrance and landing board, into `geo`. */
  locate(hive: number): void {
    const def = BEES_HIVES[hive];
    if (def === undefined) throw new BeesSimError(`no hive ${hive}`);
    const g = this.geo;
    g.z = CAMERA.groundDepth(BEES_YH - def.y);
    g.x = CAMERA.worldX(def.f * this.stage, g.z);
    // The board is drawn at the hive's own depth; a bee on it stands in front, on the board's ray.
    const k = (g.z - PERCH_FRONT) / g.z;
    g.landX = g.x * k;
    g.landZ = g.z - PERCH_FRONT;
    g.landH = BEES_CAM - (BEES_CAM - (BEES_HIVE.stand + 0.004) * BEES_HIVE_SCALE) * k;
    g.half = BEES_BOARD_HALF * BEES_HIVE_SCALE * k;
  }

  /** A patch by weight: any, or (for butterflies) only a drift on the ground. */
  pickPatch(groundOnly: boolean, rand: Random = this.random): number {
    let pick = rand.next() * (groundOnly ? GROUND_WEIGHT_TOTAL : PATCH_WEIGHT_TOTAL);
    for (const [i, w] of PATCH_WEIGHTS.entries()) {
      if (groundOnly && i >= BEES_GROUND_PATCHES) break;
      pick -= w;
      if (pick <= 0) return i;
    }
    return 0;
  }

  /**
   * The radii of patch `index`'s ellipse (stage fractions, uv) at its point `ey` of the unit disc, as
   * the flowers knob grows it (shader.ts beesDriftQ): wider past 1, and from 2 a drift on the ground
   * (but the one along the wall) running its near side on down the slope, widening as it comes.
   * Into #r (x the across radius, y the up one).
   */
  #radii(index: number, ey: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const grow = 1 + 0.5 * this.lush;
    let rx = patch.rx * grow;
    let ry = patch.ry * grow;
    if (ey < 0 && index < BEES_GROUND_PATCHES && index !== BEES_ALONG_WALL) {
      ry = lerp(ry, patch.y / 0.55, this.reach);
      rx *= 1 + 0.5 * this.reach * Math.min(-ey, 1);
    }
    this.#r.x = rx;
    this.#r.y = ry;
  }

  /** The world point at (ex, ey) in patch `index`'s ellipse (unit disc), written to pt. */
  patchPoint(index: number, ex: number, ey: number, rand: Random = this.random): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    this.#radii(index, ey);
    const sx = (patch.f + ex * this.#r.x) * this.stage;
    const sy = patch.y + ey * this.#r.y;
    const pt = this.pt;
    if (patch.footY === undefined) {
      // On the ground: the point is the plant's foot at screen row sy, its head a little above it.
      pt.z = CAMERA.groundDepth(BEES_YH - sy);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = patch.top + 0.05 + 0.12 * rand.next();
    } else {
      pt.z = CAMERA.groundDepth(BEES_YH - patch.footY);
      pt.x = CAMERA.worldX(sx, pt.z);
      pt.h = CAMERA.worldY(sy, pt.z);
    }
  }

  /** Where a world point lies in patch `index`'s ellipse (unit disc), written to pc. */
  patchCoords(index: number, x: number, z: number, h: number): void {
    const patch = BEES_PATCHES[index];
    if (patch === undefined) throw new BeesSimError(`no patch ${index}`);
    const sx = CAMERA.screenX(x, z);
    const sy = CAMERA.screenY(patch.footY === undefined ? 0 : h, z);
    // The near side's radius depends on how far down it is, so it is read from the up radius above
    // the middle and below it in turn.
    this.#radii(index, 1);
    let ey = (sy - patch.y) / this.#r.y;
    if (ey < 0) {
      this.#radii(index, -1);
      ey = (sy - patch.y) / this.#r.y;
      this.#radii(index, ey);
    }
    this.pc.ex = (sx / this.stage - patch.f) / this.#r.x;
    this.pc.ey = ey;
  }

  /** A flower in patch `index`: uniform over most of its ellipse, written to pt. */
  flowerPoint(index: number, rand: Random = this.random): void {
    const r = Math.sqrt(rand.next()) * 0.85;
    const a = rand.next() * TAU;
    this.patchPoint(index, r * Math.cos(a), r * Math.sin(a), rand);
  }

  /** A flower of patch `index` a short hop (`near`..`far` m) from (x, z, h), kept inside the drift: into pt. */
  nearFlower(
    index: number,
    x: number,
    z: number,
    h: number,
    near: number,
    far: number,
    rand: Random,
  ): void {
    const a = rand.next() * TAU;
    const r = rand.range(near, far);
    this.patchCoords(
      index,
      x + Math.cos(a) * r,
      z + Math.sin(a) * r,
      h + (rand.next() - 0.5) * 0.15,
    );
    let ex = this.pc.ex;
    let ey = this.pc.ey;
    const e = Math.hypot(ex, ey);
    if (e > 0.9) {
      ex *= 0.9 / e;
      ey *= 0.9 / e;
    }
    this.patchPoint(index, ex, ey, rand);
  }

  /** How many of `plants` (BEES_FOXGLOVES_ALL, BEES_BLOOMS_ALL) stand at this `flowers` value. */
  standing(plants: readonly BeesPlant[]): number {
    let n = 0;
    for (const plant of plants) if (this.flowers >= plant[3]) n++;
    return n;
  }

  /** One of `plants` that stands, at random (its index there), or -1 where none does (drawing nothing). */
  pickStanding(plants: readonly BeesPlant[], rand: Random): number {
    const n = this.standing(plants);
    if (n === 0) return -1;
    let k = rand.int(n);
    for (const [i, plant] of plants.entries()) {
      if (this.flowers < plant[3]) continue;
      if (k === 0) return i;
      k--;
    }
    return -1;
  }

  /**
   * A bell `bell` of the way up foxglove `i` (BEES_FOXGLOVES_ALL), on its `side` (-1, 0, 1) of the
   * spike, where the stem's lean holds it at this step: shader.ts beesFoxglove's bend (K_wind,
   * uMotionTime) in metres, the bell's half width narrowing up the spike. A perch in front of it, into pt.
   */
  bellPoint(i: number, bell: number, side: number): void {
    const fox = BEES_FOXGLOVES_ALL[i];
    if (fox === undefined) throw new BeesSimError(`no foxglove ${i}`);
    const [f, y, height] = fox;
    const z = CAMERA.groundDepth(BEES_YH - y);
    const lean =
      (0.4 + 0.8 * Math.abs(this.wind)) * 0.05 * Math.sin(this.tm * 0.55 + i * 2.1) +
      0.04 * Math.sin(i * 1.9);
    const half = 0.07 * (1 - 0.65 * smoothstep(0.42, 1, bell));
    const pt = this.pt;
    pt.x = CAMERA.worldX(f * this.stage, z) + height * lean * bell * bell + side * 0.6 * half;
    pt.z = z;
    pt.h = bell * height;
    this.nearer(PERCH_FRONT);
  }

  /**
   * A spot on near bloom `i`'s head (BEES_BLOOMS_ALL), `ex` and `eh` of its radius right of and above
   * its middle, where the breeze holds it at this step (shader.ts beesBloomNear): the head is drawn at
   * its row's ground depth. A perch in front of it, into pt.
   */
  bloomPoint(i: number, ex: number, eh: number): void {
    const bloom = BEES_BLOOMS_ALL[i];
    if (bloom === undefined) throw new BeesSimError(`no near bloom ${i}`);
    const [f, y] = bloom;
    const z = CAMERA.groundDepth(BEES_YH - y);
    const sway = 0.004 * (0.5 + Math.abs(this.wind)) * Math.sin(this.tm * 0.5 + i * 2.3);
    const pt = this.pt;
    pt.x = CAMERA.worldX(f * this.stage + sway, z) + ex * BEES_BLOOM_HEAD;
    pt.z = z;
    pt.h = eh * BEES_BLOOM_HEAD;
    this.nearer(PERCH_FRONT);
  }

  /** The middle of shader.ts beesPath at screen row sy, screen heights from the middle of the view. */
  pathX(sy: number): number {
    const w = this.stage;
    return (
      w * (0.05 + 0.3 * smoothstep(0, 0.38, sy)) +
      0.05 * w * Math.sin(sy * 8 + 1) * smoothstep(0.02, 0.2, sy)
    );
  }

  /** A point just past the side of the frame nearest (x, z), a little higher than h: into pt. */
  edgePoint(x: number, z: number, h: number): void {
    const pt = this.pt;
    pt.z = clamp(z * 0.8, 3, 14);
    pt.x = (x < 0 ? -1 : 1) * (0.5 * this.aspect + 0.3) * pt.z;
    pt.h = h + 0.5;
  }

  /** Whether a point is outside the frame by `margin` screen heights. */
  outside(x: number, z: number, h: number, margin: number): boolean {
    if (z < 0.8 || z > 80) return true;
    return (
      Math.abs(CAMERA.screenX(x, z)) > 0.5 * this.aspect + margin ||
      CAMERA.screenY(h, z) > 1 + margin
    );
  }

  /** Head for just past the nearest side of the frame (the day is over, fewer are asked for, the scene leaves). */
  sendOff(b: Moving & { off: boolean }): void {
    b.off = true;
    this.edgePoint(b.x, b.z, b.h);
    b.tx = this.pt.x;
    b.tz = this.pt.z;
    b.th = this.pt.h;
  }
}
