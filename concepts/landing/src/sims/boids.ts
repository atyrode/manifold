// Topological boids in 3D, for flocks and schools of a few thousand: each boid steers by its K
// nearest neighbours, however near or far they are (Ballerini et al. 2008, "Interaction ruling
// animal collective behavior depends on topological rather than metric distance", PNAS 105:
// starlings track about seven), found through a spatial hash rebuilt every step, so a step costs
// about n × (cells scanned + candidates examined), never n².
//
// The rules (Reynolds 1987, "Flocks, herds, and schools", SIGGRAPH; weighted much as in the
// StarDisplay model, Hildenbrandt, Carere & Hemelrijk 2010, "Self-organized aerial displays of
// thousands of starlings: a model", Behavioral Ecology 21), all in the caller's units and seconds:
// - separation: each neighbour nearer than `spacing` pushes the boid away, by `separation` times
//   how far it has come inside that distance (0..1 of it);
// - cohesion: toward the centroid of its neighbours, `cohesion` per second² per unit off it (a boid
//   on the rim, whose neighbours all lie inward, is pulled in hardest);
// - alignment: toward its neighbours' mean velocity, at `alignment` per second;
// - cruise: its speed relaxes toward `speed` at `speedHold` per second;
// - level flight: held to the home's level along `up` by a critically damped spring of natural
//   frequency `level` (0: free in 3D), so the flock flattens into a sheet a few boids deep;
// - home: outside the ellipsoid of half-axes `reach` about `home`, pulled back by `homePull` per
//   second² per unit beyond it (the roost a flock wheels over, the water a school keeps to);
// - threat: within `threatRadius` of `threat`, it flees at up to `flee` (0 radius: no threat) and
//   is startled;
// - noise: a random kick each step, a Wiener increment of `noise` units/s^1.5, so its effect does
//   not depend on the step;
// - wind carries every boid: it is added to the boid's position, not to its air speed.
// The steering (everything but noise and wind) is clamped to `maxAccel`: boids turn, never jump.
//
// Startle waves (Procaccini et al. 2011, "Propagating waves in starling flocks under predation",
// Animal Behaviour 82) relay through the same neighbours, as an excitable medium: a boid at rest that
// sees a neighbour startled at least `relay` and less than `startled` seconds ago is startled
// itself; it stays startled for `startled` seconds and cannot be startled again by its neighbours
// until `refractory` seconds have passed, so a startle runs out through the flock once, as a ring,
// at about a neighbour's distance per relay. `alarm[i]` is the seconds since boid i was startled
// (Infinity: never); the caller decides what it looks like (the murmuration's birds roll).
//
// Bounded cost: the hash's cells are CELL_PER_SPACING × `spacing` across, about where a flock at its
// spacing has its seventh nearest. A boid scans the 27 cells about it, nearest cells first; when its
// K-th nearest so far may lie beyond what it scanned, it scans the next shell of cells, out to
// MAX_RING shells, and it never examines more than BOIDS_MAX_EXAMINED candidates. Within that reach
// its neighbours are exactly the K nearest; a straggler beyond it keeps the few it found (with none,
// only home, cruise, level and noise steer it, back toward the flock's roost), and in a crush the
// bound leaves it the nearest of the candidates from the nearest cells all round. A boid keeps the
// neighbours it found for `refresh` steps (topological neighbours change slowly), steering by where
// they are now: the boids take turns, 1 in `refresh` searching each step, so the cost is spread
// evenly; a change of K or of the count, or a boid placed anew, has all of them search at once.
//
// Determinism: boids are visited in index order, every rule reads the state as it was at the start
// of the step (all steering is worked out before any boid moves), the search turns follow the steps
// taken, and the noise comes from the caller's Random, so the same start, rules and seed fly the
// same flock.
//
// Usage (see scenes/flock/sim.ts):
//   const boids = new Boids(5000);
//   const rules = boidRules();                       // mutable: set its fields every step, no allocation
//   boids.count = n;
//   for (let i = 0; i < n; i++) boids.place(i, x, y, z, vx, vy, vz);
//   rules.spacing = 0.02; rules.home.x = 0.9; ...
//   boids.step(1 / 60, rules, random);              // then read boids.x[i], .y, .z, .vx, ..., .alarm
//   boids.startle(i);                                // a startle that will relay outward
//   boids.index(cell); boids.nearest(i, k, out);     // the topological neighbours on their own
import type { Random } from "./random.ts";

/** Most neighbours a boid can track (BoidRules.neighbours is clamped to 1..this). */
export const BOIDS_MAX_NEIGHBOURS = 16;
/** Most candidates one neighbour search examines. */
export const BOIDS_MAX_EXAMINED = 96;
/** Shells of cells a search may scan beyond the boid's own (the cube it covers is 2 × MAX_RING + 1 cells wide). */
const MAX_RING = 2;
/** The hash's cell size in spacings. */
const CELL_PER_SPACING = 1.25;

/**
 * The cells a search scans, as (dx, dy, dz) offsets from the boid's own, ring by ring (the 27 about
 * it, then each further shell) and nearest first within a ring, so a search the bound cuts short has
 * scanned the nearest cells all round rather than one side. RING_END[r]: where ring r's offsets end.
 */
const { OFFSETS, RING_END } = (() => {
  const ring = (dx: number, dy: number, dz: number): number =>
    Math.max(1, Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const cells: [number, number, number][] = [];
  for (let dz = -MAX_RING; dz <= MAX_RING; dz++) {
    for (let dy = -MAX_RING; dy <= MAX_RING; dy++) {
      for (let dx = -MAX_RING; dx <= MAX_RING; dx++) cells.push([dx, dy, dz]);
    }
  }
  cells.sort(
    (a, b) =>
      ring(...a) - ring(...b) ||
      a[0] * a[0] + a[1] * a[1] + a[2] * a[2] - (b[0] * b[0] + b[1] * b[1] + b[2] * b[2]),
  );
  const ends = new Int32Array(MAX_RING + 1);
  cells.forEach((cell, o) => {
    ends[ring(...cell)] = o + 1;
  });
  return { OFFSETS: Int8Array.from(cells.flat()), RING_END: ends };
})();

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** How the boids fly; see the file header for each rule. */
export interface BoidRules {
  /** Topological neighbours tracked (K). */
  neighbours: number;
  /** Steps between a boid's neighbour searches (1: every step); the boids take turns. */
  refresh: number;
  /** Separation distance; the hash's cells are CELL_PER_SPACING of it. */
  spacing: number;
  separation: number;
  cohesion: number;
  alignment: number;
  speed: number;
  speedHold: number;
  maxAccel: number;
  noise: number;
  level: number;
  /** Unit vector: the axis level flight holds still. */
  readonly up: Vec3;
  readonly home: Vec3;
  /** Half-axes of the home ellipsoid. */
  readonly reach: Vec3;
  homePull: number;
  readonly wind: Vec3;
  readonly threat: Vec3;
  threatRadius: number;
  flee: number;
  /** Startle relay: seconds before a startled boid passes it on, seconds it lasts, seconds until it can come again. */
  relay: number;
  startled: number;
  refractory: number;
}

export class BoidsError extends Error {}

/** Neutral rules in unit spacing: seven neighbours, cruise 1 unit/s, no home, level flight, threat, wind or noise. */
export function boidRules(): BoidRules {
  return {
    neighbours: 7,
    refresh: 1,
    spacing: 1,
    separation: 2,
    cohesion: 1,
    alignment: 1,
    speed: 1,
    speedHold: 1,
    maxAccel: 10,
    noise: 0,
    level: 0,
    up: { x: 0, y: 1, z: 0 },
    home: { x: 0, y: 0, z: 0 },
    reach: { x: 1, y: 1, z: 1 },
    homePull: 0,
    wind: { x: 0, y: 0, z: 0 },
    threat: { x: 0, y: 0, z: 0 },
    threatRadius: 0,
    flee: 0,
    relay: 0.05,
    startled: 0.4,
    refractory: 1.5,
  };
}

/** A lattice cell's bucket in a table of mask + 1 buckets. */
const bucketOf = (cx: number, cy: number, cz: number, mask: number): number =>
  (Math.imul(cx, 0x8da6b343) ^ Math.imul(cy, 0xd8163841) ^ Math.imul(cz, 0xcb1ab31f)) & mask;

export class Boids {
  readonly capacity: number;
  /** Boids in flight: indices 0..count-1. */
  count = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  /** Seconds since each boid was startled; Infinity: never. */
  readonly alarm: Float32Array;
  /** Candidates examined by the neighbour searches of the last step (or the nearest() calls since the last index()). */
  examined = 0;

  // Steering worked out in the first pass of a step, applied in the second.
  readonly #ax: Float32Array;
  readonly #ay: Float32Array;
  readonly #az: Float32Array;
  readonly #caught: Uint8Array;

  // Each boid's neighbours as last searched (BOIDS_MAX_NEIGHBOURS slots a boid), how many, and the
  // k and count the lists were found for (0: stale, all search on the next step).
  readonly #lists: Int32Array;
  readonly #listed: Uint8Array;
  #listK = 0;
  #listCount = 0;
  #steps = 0;

  // The spatial hash: each boid's cell, the boids sorted by bucket and where each bucket starts.
  readonly #mask: number;
  readonly #start: Int32Array;
  readonly #order: Int32Array;
  readonly #bucket: Int32Array;
  readonly #cellX: Int32Array;
  readonly #cellY: Int32Array;
  readonly #cellZ: Int32Array;
  /** Bucket last visited by search #now: a bucket two cells share is scanned once per search. */
  readonly #stamp: Int32Array;
  #now = 0;
  #cell = 1;
  #indexed = false;

  // The search in progress: its nearest so far, nearest first (squared distances).
  readonly #bestD = new Float64Array(BOIDS_MAX_NEIGHBOURS);
  readonly #bestJ = new Int32Array(BOIDS_MAX_NEIGHBOURS);

  constructor(capacity: number) {
    if (!(Number.isInteger(capacity) && capacity > 0))
      throw new BoidsError(`boids: capacity must be a positive whole number, got ${capacity}`);
    this.capacity = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.vz = new Float32Array(capacity);
    this.alarm = new Float32Array(capacity).fill(Number.POSITIVE_INFINITY);
    this.#ax = new Float32Array(capacity);
    this.#ay = new Float32Array(capacity);
    this.#az = new Float32Array(capacity);
    this.#caught = new Uint8Array(capacity);
    this.#lists = new Int32Array(capacity * BOIDS_MAX_NEIGHBOURS);
    this.#listed = new Uint8Array(capacity);
    let buckets = 64;
    while (buckets < 2 * capacity) buckets *= 2;
    this.#mask = buckets - 1;
    this.#start = new Int32Array(buckets + 1);
    this.#order = new Int32Array(capacity);
    this.#bucket = new Int32Array(capacity);
    this.#cellX = new Int32Array(capacity);
    this.#cellY = new Int32Array(capacity);
    this.#cellZ = new Int32Array(capacity);
    this.#stamp = new Int32Array(buckets);
  }

  /** Put boid i at (x, y, z) flying at (vx, vy, vz), not startled. */
  place(i: number, x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.alarm[i] = Number.POSITIVE_INFINITY;
    this.#indexed = false;
    this.#listK = 0;
  }

  /** Boid i is startled now; the startle relays to its neighbours as the boids fly on. */
  startle(i: number): void {
    if (i >= 0 && i < this.count) this.alarm[i] = 0;
  }

  /** Hash the boids as they are now into cells `cell` across, for nearest() (step() does this itself). */
  index(cell: number): void {
    if (!(cell > 0)) throw new BoidsError(`boids: cell must be positive, got ${cell}`);
    const n = this.count;
    const inv = 1 / cell;
    const start = this.#start;
    const mask = this.#mask;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor((this.x[i] ?? 0) * inv);
      const cy = Math.floor((this.y[i] ?? 0) * inv);
      const cz = Math.floor((this.z[i] ?? 0) * inv);
      this.#cellX[i] = cx;
      this.#cellY[i] = cy;
      this.#cellZ[i] = cz;
      const b = bucketOf(cx, cy, cz, mask);
      this.#bucket[i] = b;
      start[b] = (start[b] ?? 0) + 1;
    }
    // Ends of the buckets, then filled from the back so each bucket lists its boids in index order
    // and start[b] ends up where bucket b begins (start[b + 1] where it ends).
    for (let b = 1; b <= mask; b++) start[b] = (start[b] ?? 0) + (start[b - 1] ?? 0);
    start[mask + 1] = n;
    for (let i = n - 1; i >= 0; i--) {
      const b = this.#bucket[i] ?? 0;
      const at = (start[b] ?? 0) - 1;
      start[b] = at;
      this.#order[at] = i;
    }
    this.#cell = cell;
    this.#indexed = true;
    this.examined = 0;
  }

  /**
   * Boid i's k nearest others (k clamped to 1..BOIDS_MAX_NEIGHBOURS), nearest first, into `out`;
   * returns how many it found (fewer only for a straggler beyond the search's reach, or a flock of
   * fewer than k + 1). Reads the hash of the last index() or step().
   */
  nearest(i: number, k: number, out: Int32Array): number {
    if (!this.#indexed)
      throw new BoidsError("boids: index() the boids before asking for neighbours");
    const m = this.#search(i, k);
    for (let q = 0; q < m; q++) out[q] = this.#bestJ[q] ?? 0;
    return m;
  }

  /** One step of dt seconds under `rules`; noise draws from `random`. */
  step(dt: number, rules: BoidRules, random: Random): void {
    const n = this.count;
    if (n === 0 || !(dt > 0)) return;
    this.index(rules.spacing * CELL_PER_SPACING);
    const k = Math.max(1, Math.min(BOIDS_MAX_NEIGHBOURS, Math.round(rules.neighbours)));
    const { x, y, z, vx, vy, vz, alarm } = this;
    const ax = this.#ax;
    const ay = this.#ay;
    const az = this.#az;
    const caught = this.#caught;
    const bestJ = this.#bestJ;
    const lists = this.#lists;
    const listed = this.#listed;
    // Boids take turns searching: each step 1 in `refresh` of them, all of them when the lists are stale.
    const refresh = Math.max(1, Math.round(rules.refresh));
    const turn = this.#steps++ % refresh;
    const stale = k !== this.#listK || n !== this.#listCount;
    this.#listK = k;
    this.#listCount = n;
    const {
      spacing,
      separation,
      cohesion,
      alignment,
      speed,
      speedHold,
      maxAccel,
      level,
      homePull,
      threatRadius,
      flee,
      relay,
      startled,
      refractory,
    } = rules;
    const { up, home, reach, threat } = rules;
    const levelK = level * level;
    const levelC = 2 * level;
    const homeUp = home.x * up.x + home.y * up.y + home.z * up.z;

    for (let i = 0; i < n; i++) {
      const xi = x[i] ?? 0;
      const yi = y[i] ?? 0;
      const zi = z[i] ?? 0;
      const vxi = vx[i] ?? 0;
      const vyi = vy[i] ?? 0;
      const vzi = vz[i] ?? 0;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      let calm = 1;
      const at = i * BOIDS_MAX_NEIGHBOURS;
      let m = listed[i] ?? 0;
      if (stale || i % refresh === turn) {
        m = this.#search(i, k);
        for (let q = 0; q < m; q++) lists[at + q] = bestJ[q] ?? 0;
        listed[i] = m;
      }
      if (m > 0) {
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cx = 0;
        let cy = 0;
        let cz = 0;
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (let q = 0; q < m; q++) {
          const j = lists[at + q] ?? 0;
          const dx = (x[j] ?? 0) - xi;
          const dy = (y[j] ?? 0) - yi;
          const dz = (z[j] ?? 0) - zi;
          cx += dx;
          cy += dy;
          cz += dz;
          mx += vx[j] ?? 0;
          my += vy[j] ?? 0;
          mz += vz[j] ?? 0;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < spacing && d > 1e-9) {
            const push = (1 - d / spacing) / d;
            sx -= dx * push;
            sy -= dy * push;
            sz -= dz * push;
          }
          const aj = alarm[j] ?? Number.POSITIVE_INFINITY;
          if (aj >= relay && aj < startled) calm = 0;
        }
        const inv = 1 / m;
        fx += separation * sx + cohesion * cx * inv + alignment * (mx * inv - vxi);
        fy += separation * sy + cohesion * cy * inv + alignment * (my * inv - vyi);
        fz += separation * sz + cohesion * cz * inv + alignment * (mz * inv - vzi);
      }
      // Cruise.
      const v = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi);
      if (v > 1e-9) {
        const hold = (speedHold * (speed - v)) / v;
        fx += vxi * hold;
        fy += vyi * hold;
        fz += vzi * hold;
      }
      // Level flight about the home's level.
      if (level > 0) {
        const h = xi * up.x + yi * up.y + zi * up.z - homeUp;
        const vh = vxi * up.x + vyi * up.y + vzi * up.z;
        const f = -(levelK * h + levelC * vh);
        fx += up.x * f;
        fy += up.y * f;
        fz += up.z * f;
      }
      // Home.
      if (homePull > 0) {
        const ox = xi - home.x;
        const oy = yi - home.y;
        const oz = zi - home.z;
        const qx = ox / reach.x;
        const qy = oy / reach.y;
        const qz = oz / reach.z;
        const out = Math.sqrt(qx * qx + qy * qy + qz * qz);
        if (out > 1) {
          const f = -homePull * (1 - 1 / out);
          fx += ox * f;
          fy += oy * f;
          fz += oz * f;
        }
      }
      // Threat.
      if (threatRadius > 0) {
        const dx = xi - threat.x;
        const dy = yi - threat.y;
        const dz = zi - threat.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < threatRadius) {
          calm = 0;
          if (d > 1e-9) {
            const near = 1 - d / threatRadius;
            const f = (flee * near * near) / d;
            fx += dx * f;
            fy += dy * f;
            fz += dz * f;
          }
        }
      }
      const f = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (f > maxAccel) {
        const s = maxAccel / f;
        fx *= s;
        fy *= s;
        fz *= s;
      }
      ax[i] = fx;
      ay[i] = fy;
      az[i] = fz;
      caught[i] = calm === 0 && (alarm[i] ?? 0) >= refractory ? 1 : 0;
    }

    const kick = rules.noise * Math.sqrt(dt);
    const { wind } = rules;
    for (let i = 0; i < n; i++) {
      let ux = (vx[i] ?? 0) + (ax[i] ?? 0) * dt;
      let uy = (vy[i] ?? 0) + (ay[i] ?? 0) * dt;
      let uz = (vz[i] ?? 0) + (az[i] ?? 0) * dt;
      if (kick > 0) {
        ux += kick * (2 * random.next() - 1);
        uy += kick * (2 * random.next() - 1);
        uz += kick * (2 * random.next() - 1);
      }
      vx[i] = ux;
      vy[i] = uy;
      vz[i] = uz;
      x[i] = (x[i] ?? 0) + (ux + wind.x) * dt;
      y[i] = (y[i] ?? 0) + (uy + wind.y) * dt;
      z[i] = (z[i] ?? 0) + (uz + wind.z) * dt;
      alarm[i] = caught[i] === 1 ? 0 : (alarm[i] ?? 0) + dt;
    }
    // The hash now describes where the boids were.
    this.#indexed = false;
  }

  /** Boid i's k nearest into #bestJ / #bestD; returns how many (see nearest). */
  #search(i: number, kWanted: number): number {
    const k = Math.max(1, Math.min(BOIDS_MAX_NEIGHBOURS, Math.round(kWanted)));
    const x = this.x;
    const y = this.y;
    const z = this.z;
    const start = this.#start;
    const order = this.#order;
    const stamp = this.#stamp;
    const mask = this.#mask;
    const bestD = this.#bestD;
    const bestJ = this.#bestJ;
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    const zi = z[i] ?? 0;
    const ci = this.#cellX[i] ?? 0;
    const cj = this.#cellY[i] ?? 0;
    const ck = this.#cellZ[i] ?? 0;
    if (++this.#now > 0x3fffffff) {
      stamp.fill(0);
      this.#now = 1;
    }
    const now = this.#now;
    let m = 0;
    let examined = 0;
    let o = 0;
    search: for (let r = 1; r <= MAX_RING; r++) {
      for (const ringEnd = RING_END[r] ?? 0; o < ringEnd; o++) {
        const b = bucketOf(
          ci + (OFFSETS[3 * o] ?? 0),
          cj + (OFFSETS[3 * o + 1] ?? 0),
          ck + (OFFSETS[3 * o + 2] ?? 0),
          mask,
        );
        if (stamp[b] === now) continue;
        stamp[b] = now;
        const end = start[b + 1] ?? 0;
        for (let s = start[b] ?? 0; s < end; s++) {
          const j = order[s] ?? 0;
          if (j === i) continue;
          if (examined === BOIDS_MAX_EXAMINED) break search;
          examined++;
          const ex = (x[j] ?? 0) - xi;
          const ey = (y[j] ?? 0) - yi;
          const ez = (z[j] ?? 0) - zi;
          const d2 = ex * ex + ey * ey + ez * ez;
          let at: number;
          if (m < k) at = m++;
          else if (d2 < (bestD[k - 1] ?? 0)) at = k - 1;
          else continue;
          while (at > 0 && (bestD[at - 1] ?? 0) > d2) {
            bestD[at] = bestD[at - 1] ?? 0;
            bestJ[at] = bestJ[at - 1] ?? 0;
            at--;
          }
          bestD[at] = d2;
          bestJ[at] = j;
        }
      }
      // Every boid not yet scanned is more than r cells away along some axis: done once the k-th is nearer.
      const reach = r * this.#cell;
      if (m === k && (bestD[k - 1] ?? 0) <= reach * reach) break;
    }
    this.examined += examined;
    return m;
  }
}
