// The swarm (BEES_SWARM_TRIGGER, or now and then by itself while the `swarm` knob is on, on a dry day):
// BEES_SWARM_BEES bees of one hive pour out of its entrance over SWARM_POUR seconds, mill in a loose
// ball a few metres across over the garden, each on a loop of its own through it, and drift onto a
// limb of one of the two big apple trees in the middle of the orchard (SWARM_TREES, the BEES_TREES the
// shader draws), where they settle as a cluster hanging in the lower crown, a few scouts flying out
// and back. After a while the cluster breaks up into the ball again, which lifts off and leaves the
// frame. It is stepped on the sim's own steps from the press's motion-clock stamp and drawn from a
// stream seeded by that moment, so a seed and a stamp play the same swarm at any frame rate. A
// pressed swarm plays whatever the hour and the weather (the shader lights it as it lights the
// garden). Each of its specks stands for a knot of bees, drawn as a bee twice its size, and a cell
// where three or more fall is the honey-brown mass of the cluster (BEES_CODE.swarm). The cluster
// keeps to its limb when the frame's aspect changes: the limb is kept, and found again on the new
// stage.
import { glslHash22, lerp, smoothstep } from "../../sims/math.ts";
import { Random } from "../../sims/random.ts";
import { BEE_LENGTH } from "./colony.ts";
import {
  BeesSimError,
  CAMERA,
  chase,
  type Garden,
  type Moving,
  moving,
  settle,
  STEP,
  TAU,
} from "./garden.ts";
import {
  BEES_BOARD_HALF,
  BEES_CODE,
  BEES_DEPTH_STEP,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_TREES,
  BEES_YH,
} from "./layout.ts";
import { depthByte, type Painter } from "./paint.ts";

/** Bees in a swarm. */
export const BEES_SWARM_BEES = 360;

// The swarm: its course in seconds from the start (pouring out until SWARM_POUR, the ball onto the
// branch from SWARM_SETTLE, everyone hanging by SWARM_HANG, off the branch from SWARM_LIFT, away from
// SWARM_LEAVE, gone by SWARM_END at the latest), its ball's radius, how fast it leaves (m/s, reached
// over SWARM_RAMP s) and the gaps between swarms that come by themselves.
const SWARM_POUR = 12;
const SWARM_SETTLE = 46;
const SWARM_HANG = 66;
const SWARM_LIFT = 140;
const SWARM_LEAVE = 148;
const SWARM_END = 220;
const SWARM_RADIUS = 1.3;
const SWARM_GO = 3.2;
const SWARM_RAMP = 6;
const SWARM_FIRST = [25, 75] as const;
const SWARM_GAP = [150, 330] as const;
/**
 * The trees a swarm hangs in: the two big apple trees in the middle of the orchard, whose crowns
 * stand clear of the hives' roofs (BEES_TREES indices).
 */
const SWARM_TREES = [2, 3] as const;
/**
 * Where the cluster hangs on its tree, in the tree's units (shader.ts beesTree, metres × its size):
 * part way out along one of the two limbs from the fork, under it, in the lower crown.
 */
const SWARM_LIMB = 0.6;
const SWARM_BRANCH = 2.55;
/** How far in front of the crown it hangs (m, along the limb's view ray), so the shader draws it over the leaves it hangs from. */
const SWARM_FRONT = 0.4;
/** The cluster's half width, depth and half length (m): it hangs from the branch, widest at the top. */
const CLUSTER = { x: 0.15, z: 0.1, h: 0.24 } as const;
/** Where a swarm bee is: in the hive, flying, hanging in the cluster, gone from the frame. */
const SWARM_HIVE = 0;
const SWARM_FLYING = 1;
const SWARM_HUNG = 2;
const SWARM_GONE = 3;

interface SwarmBee extends Moving {
  /** SWARM_HIVE, SWARM_FLYING, SWARM_HUNG or SWARM_GONE. */
  stage: number;
  /** Seconds into the swarm it leaves the hive, settles in the cluster, and takes off from it again (after SWARM_LIFT). */
  launch: number;
  land: number;
  lift: number;
  /** Its loop through the ball: radius (a share of the ball's), rate (rad/s), start angle and the loop's plane (two unit axes). */
  r: number;
  w: number;
  a0: number;
  e1x: number;
  e1z: number;
  e1h: number;
  e2x: number;
  e2z: number;
  e2h: number;
  /** Its place in the cluster, from the branch (m). */
  sx: number;
  sz: number;
  sh: number;
  /** A scout: flies out and back while the cluster hangs. */
  scout: boolean;
}

function newSwarmBee(): SwarmBee {
  return {
    ...moving(),
    stage: SWARM_HIVE,
    launch: 0,
    land: 0,
    lift: 0,
    r: 0,
    w: 0,
    a0: 0,
    e1x: 1,
    e1z: 0,
    e1h: 0,
    e2x: 0,
    e2z: 0,
    e2h: 1,
    sx: 0,
    sz: 0,
    sh: 0,
    scout: false,
  };
}

export class Swarm {
  readonly bees: SwarmBee[] = Array.from({ length: BEES_SWARM_BEES }, newSwarmBee);
  /** Whether swarms come by themselves (the `swarm` knob). */
  on = false;
  active = false;
  readonly #garden: Garden;
  /** Seconds since it began. */
  #age = 0;
  /** The board it pours from, the middle of the garden it mills over, the limb it hangs from (its index, #branchPoint) and the branch there (m). */
  readonly #o = { x: 0, z: 0, h: 0 };
  readonly #m = { x: 0, z: 0, h: 0 };
  #limb = 0;
  readonly #k = { x: 0, z: 0, h: 0 };
  /** Which way it leaves (a unit vector), the ball's wander phases, its middle and radius now. */
  readonly #e = { x: 0, z: 0, h: 1 };
  readonly #p = [0, 0, 0];
  readonly #c = { x: 0, z: 0, h: 0 };
  #radius = 0;
  /** Its own draws (re-seeded for each swarm), and the waits between swarms that come by themselves. */
  readonly #random = new Random(0);
  readonly #clock = new Random(0x5a4);
  /** The motion-clock moment a pressed swarm starts at (NaN: none waiting), and seconds until one comes by itself (NaN: not counting). */
  #at = Number.NaN;
  #wait = Number.NaN;
  /** Its specks of a frame, sorted by cell then depth: cell × 256 + depth byte. */
  readonly #keys = new Float64Array(BEES_SWARM_BEES);
  /** The branches it may hang from, in view (SWARM_TREES place × 2 + side). */
  readonly #branches = new Int8Array(SWARM_TREES.length * 2);
  readonly #hash = new Float64Array(2);

  constructor(garden: Garden) {
    this.#garden = garden;
  }

  /** A "now" at motion time `at`: a swarm starts at the first step at least half a step past it, unless one is under way. */
  press(at: number): void {
    if (!this.active) this.#at = at;
  }

  /** A new stage width: the board and the garden's middle scale with it; the cluster finds its limb again, and hangs from it. */
  restage(ratio: number): void {
    this.#o.x *= ratio;
    this.#m.x *= ratio;
    this.#c.x *= ratio;
    if (this.active) {
      this.#branchPoint(this.#limb);
      this.#k.x = this.#garden.pt.x;
    }
    for (const b of this.bees) {
      if (b.stage === SWARM_HUNG) {
        b.x = this.#k.x + b.sx;
        b.px = b.x;
      } else {
        b.x *= ratio;
        b.px *= ratio;
      }
      b.tx *= ratio;
    }
  }

  /** A swarm pressed for, or one due by itself; one at a time. `dt` a step of the sim's, at its moment (Garden.tm). */
  tend(dt: number): void {
    const garden = this.#garden;
    if (!this.active && garden.tm >= this.#at + STEP / 2) {
      this.#begin(garden.tm - this.#at);
      this.#at = Number.NaN;
    }
    if (!this.on) this.#wait = Number.NaN;
    else if (!this.active) {
      // Now and then by itself, on a fine day.
      if (Number.isNaN(this.#wait)) this.#wait = this.#clock.range(SWARM_FIRST[0], SWARM_FIRST[1]);
      if (garden.open && !garden.leaving) {
        this.#wait -= dt;
        if (this.#wait <= 0) this.#begin(0);
      }
    }
    if (this.active) this.#step(dt);
  }

  /** A swarm sets out, `age` seconds ago (a step or so): its hive, its branch, its path, and every bee's part in it. */
  #begin(age: number): void {
    const garden = this.#garden;
    const rand = this.#random;
    rand.seed(Math.imul(Math.round(garden.tm / STEP) + 1, 0x9e3779b1) ^ 0x5a4e7);
    this.active = true;
    this.#age = age;
    garden.locate(rand.int(BEES_HIVES.length));
    const g = garden.geo;
    const o = this.#o;
    const m = this.#m;
    const k = this.#k;
    o.x = g.landX;
    o.z = g.landZ;
    o.h = g.landH;
    this.#pickBranch(rand);
    k.x = garden.pt.x;
    k.z = garden.pt.z;
    k.h = garden.pt.h;
    m.x = lerp(o.x, k.x, 0.45) + rand.range(-0.8, 0.8);
    m.z = lerp(o.z, k.z, 0.4) + rand.range(-0.5, 0.5);
    m.h = rand.range(2.3, 3);
    // Away over the side its tree stands on, climbing.
    const side = k.x < 0 ? -1 : 1;
    const ex = side * 0.75;
    const ez = rand.range(0.1, 0.35);
    const eh = 0.62;
    const e = Math.hypot(ex, ez, eh);
    this.#e.x = ex / e;
    this.#e.z = ez / e;
    this.#e.h = eh / e;
    this.#p[0] = rand.next() * TAU;
    this.#p[1] = rand.next() * TAU;
    this.#p[2] = rand.next() * TAU;
    this.#centre();
    for (const b of this.bees) {
      b.stage = SWARM_HIVE;
      // A thick stream at first, thinning out.
      b.launch = SWARM_POUR * rand.next() ** 1.6;
      b.r = Math.cbrt(rand.next());
      b.w = (rand.next() < 0.5 ? -1 : 1) * rand.range(0.9, 2.3);
      b.a0 = rand.next() * TAU;
      // Its loop's plane: a random normal and two axes across it.
      const nh = 2 * rand.next() - 1;
      const around = rand.next() * TAU;
      const flat = Math.sqrt(1 - nh * nh);
      const nx = flat * Math.cos(around);
      const nz = flat * Math.sin(around);
      // a × n with a the up axis (0, 0, 1), or across (1, 0, 0) where the normal is nearly up.
      let ax = 0;
      let ah = 1;
      if (Math.abs(nh) > 0.9) {
        ax = 1;
        ah = 0;
      }
      let e1x = -ah * nz;
      let e1z = ah * nx - ax * nh;
      let e1h = ax * nz;
      const e1 = Math.hypot(e1x, e1z, e1h);
      e1x /= e1;
      e1z /= e1;
      e1h /= e1;
      b.e1x = e1x;
      b.e1z = e1z;
      b.e1h = e1h;
      b.e2x = nz * e1h - nh * e1z;
      b.e2z = nh * e1x - nx * e1h;
      b.e2h = nx * e1z - nz * e1x;
      b.land = SWARM_SETTLE + 6 + 14 * rand.next();
      b.lift = 8 * rand.next();
      // Its place in the cluster: an egg hanging from the branch, narrowing toward its foot.
      const c = 2 * rand.next() - 1;
      const spin = rand.next() * TAU;
      const reach = Math.cbrt(rand.next());
      const across = Math.sqrt(1 - c * c) * reach;
      const taper = 0.55 + 0.45 * (c * reach + 1) * 0.5;
      b.sx = CLUSTER.x * across * Math.cos(spin) * taper;
      b.sz = CLUSTER.z * across * Math.sin(spin) * taper;
      b.sh = -CLUSTER.h + CLUSTER.h * c * reach;
      b.scout = rand.next() < 0.05;
      b.vx = 0;
      b.vz = 0;
      b.vh = 0;
      b.cx = Number.NaN;
    }
  }

  /** One of the limbs of SWARM_TREES in view to hang from (the one nearest the middle if none is): kept in #limb, its branch into the garden's pt. */
  #pickBranch(rand: Random): void {
    const garden = this.#garden;
    const half = 0.5 * garden.aspect - 0.06;
    let count = 0;
    let nearest = 0;
    let nearestX = Number.POSITIVE_INFINITY;
    for (let k = 0; k < this.#branches.length; k++) {
      this.#branchPoint(k);
      const sx = Math.abs(CAMERA.screenX(garden.pt.x, garden.pt.z));
      if (sx < nearestX) {
        nearestX = sx;
        nearest = k;
      }
      if (sx <= half) this.#branches[count++] = k;
    }
    this.#limb = count > 0 ? (this.#branches[rand.int(count)] ?? nearest) : nearest;
    this.#branchPoint(this.#limb);
  }

  /**
   * Branch k (SWARM_TREES[k >> 1], its left limb for even k): out along the limb shader.ts beesTree
   * draws from the fork (its tip hashed from the tree's seed as the shader hashes it), under it, a
   * little in front of the leaves. Into the garden's pt.
   */
  #branchPoint(k: number): void {
    const garden = this.#garden;
    const tree = BEES_TREES[SWARM_TREES[k >> 1] ?? 0];
    if (tree === undefined) throw new BeesSimError(`no swarm tree ${k >> 1}`);
    const [f, y, size, seed] = tree;
    const z = CAMERA.groundDepth(BEES_YH - y);
    glslHash22(seed, 2, this.#hash);
    const limb = k % 2 === 0 ? -1.4 - 0.9 * (this.#hash[0] ?? 0) : 1.5 + 0.8 * (this.#hash[1] ?? 0);
    const pt = garden.pt;
    pt.x = CAMERA.worldX(f * garden.stage, z) + SWARM_LIMB * limb * size;
    pt.z = z;
    pt.h = SWARM_BRANCH * size;
    garden.nearer(SWARM_FRONT);
  }

  /** The ball's middle and radius at its age: out of the hive to the middle of the garden, milling, onto the branch, off it and away. */
  #centre(): void {
    const a = this.#age;
    const o = this.#o;
    const m = this.#m;
    const k = this.#k;
    const [p1 = 0, p2 = 0, p3 = 0] = this.#p;
    const go = smoothstep(0, SWARM_POUR + 6, a);
    let x = lerp(o.x, m.x, go) + 0.7 * Math.sin(0.29 * a + p1) * go;
    let z = lerp(o.z - 0.3, m.z, go) + 0.45 * Math.sin(0.21 * a + p2) * go;
    let h = lerp(o.h + 0.5, m.h, go) + 0.3 * Math.sin(0.37 * a + p3) * go;
    const onto = smoothstep(SWARM_SETTLE, SWARM_SETTLE + 14, a);
    x = lerp(x, k.x, onto);
    z = lerp(z, k.z, onto);
    h = lerp(h, k.h - CLUSTER.h, onto);
    const run = Math.max(0, a - SWARM_LEAVE);
    const away =
      run < SWARM_RAMP
        ? (SWARM_GO * run * run) / (2 * SWARM_RAMP)
        : SWARM_GO * (run - SWARM_RAMP / 2);
    const c = this.#c;
    c.x = x + this.#e.x * away;
    c.z = z + this.#e.z * away;
    c.h = h + 0.8 * smoothstep(SWARM_LIFT, SWARM_LEAVE, a) + this.#e.h * away;
    let radius =
      lerp(0.45, SWARM_RADIUS, smoothstep(0, 16, a)) * (1 + 0.08 * Math.sin(0.5 * a + p2));
    radius = lerp(radius, 0.18, onto);
    this.#radius =
      lerp(radius, 1.1 * SWARM_RADIUS, smoothstep(SWARM_LIFT, SWARM_LEAVE + 4, a)) + 0.04 * run;
  }

  #step(dt: number): void {
    const garden = this.#garden;
    this.#age += dt;
    this.#centre();
    const a = this.#age;
    const o = this.#o;
    const k = this.#k;
    const c = this.#c;
    const kk = 1 - Math.exp(-dt / 0.3);
    const top = a > SWARM_LIFT ? 4.5 : 2.8;
    const half = BEES_BOARD_HALF * BEES_HIVE_SCALE * 0.8;
    let gone = 0;
    for (const b of this.bees) {
      if (b.stage === SWARM_GONE) {
        gone++;
        continue;
      }
      if (b.stage === SWARM_HIVE) {
        if (a < b.launch) continue;
        // Out of the entrance and up, into the stream.
        b.x = o.x + half * Math.sin(b.a0);
        b.z = o.z;
        b.h = o.h;
        b.vx = 0.3 * Math.cos(b.a0);
        b.vz = -0.6;
        b.vh = 0.9;
        b.cx = Number.NaN;
        b.stage = SWARM_FLYING;
      }
      settle(b);
      const hangs = a >= b.land - 4 && a < SWARM_LIFT + b.lift;
      const scouting =
        b.scout && a > SWARM_HANG && a < SWARM_LIFT && Math.sin(0.5 * a + b.a0) > 0.55;
      if (b.stage === SWARM_HUNG) {
        if (!scouting && a < SWARM_LIFT + b.lift) continue;
        b.stage = SWARM_FLYING;
      }
      // Its loop through the ball (a scout's wider, round the cluster), drawn in to its place there as it settles.
      const theta = b.a0 + b.w * a;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      const r = scouting ? 0.8 : b.r * this.#radius;
      let tx = c.x + r * (b.e1x * cos + b.e2x * sin);
      let tz = c.z + r * (b.e1z * cos + b.e2z * sin);
      let th = c.h + r * (b.e1h * cos + b.e2h * sin);
      let w = 0;
      if (hangs && !scouting) {
        w = smoothstep(b.land - 4, b.land, a);
        tx = lerp(tx, k.x + b.sx, w);
        tz = lerp(tz, k.z + b.sz, w);
        th = lerp(th, k.h + b.sh, w);
      }
      const dist = chase(b, tx, tz, th, 0.35, top, kk, dt);
      if (w >= 1 && dist < 0.04) {
        b.x = k.x + b.sx;
        b.z = k.z + b.sz;
        b.h = k.h + b.sh;
        b.vx = 0;
        b.vz = 0;
        b.vh = 0;
        b.stage = SWARM_HUNG;
      } else if (a > SWARM_LEAVE && garden.outside(b.x, b.z, b.h, 0.1)) {
        b.stage = SWARM_GONE;
        gone++;
      }
    }
    if (gone === this.bees.length || a > SWARM_END) this.#end();
  }

  /** The swarm has gone: its bees are no more to be drawn, and the next one by itself is a while off. */
  #end(): void {
    this.active = false;
    for (const b of this.bees) b.stage = SWARM_HIVE;
    this.#wait = this.on ? this.#clock.range(SWARM_GAP[0], SWARM_GAP[1]) : Number.NaN;
  }

  /**
   * Cell by cell: a speck stands for a knot of bees, drawn as a bee twice its size; two in a cell are
   * a dark speck and three or more the mass of the cluster (BEES_CODE.swarm), at the nearest one's
   * depth.
   */
  paint(p: Painter, alpha: number): void {
    if (!this.active) return;
    const specks = p.specks;
    const h = specks.height;
    const w = specks.width;
    const keys = this.#keys;
    let n = 0;
    for (const b of this.bees) {
      if (b.stage !== SWARM_FLYING && b.stage !== SWARM_HUNG) continue;
      const z = p.project(b, alpha);
      if (z === 0 || b.cx < 0 || b.cx >= w || b.cy < 0 || b.cy >= h) continue;
      keys[n++] = (b.cy * w + b.cx) * 256 + depthByte(z);
    }
    keys.fill(Number.POSITIVE_INFINITY, n);
    keys.sort();
    for (let i = 0; i < n;) {
      const key = keys[i] ?? 0;
      const at = Math.floor(key / 256);
      let j = i + 1;
      while (j < n && Math.floor((keys[j] ?? 0) / 256) === at) j++;
      const depth = key - at * 256;
      const size = (2 * BEE_LENGTH * h * CAMERA.focal) / Math.max(0.8, depth / BEES_DEPTH_STEP);
      const many = j - i;
      const code =
        many >= 3
          ? BEES_CODE.swarm
          : many === 2 || size >= 0.8
            ? BEES_CODE.bee
            : size >= 0.5
              ? BEES_CODE.beeDim
              : BEES_CODE.beeFaint;
      const cy = Math.floor(at / w);
      specks.plot(at - cy * w, cy, code, depth);
      i = j;
    }
  }
}
