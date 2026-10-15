import { expect, test } from "bun:test";
import { Boids, BOIDS_MAX_EXAMINED, type BoidRules, boidRules } from "./boids.ts";
import { Random } from "./random.ts";

/** A flock of n boids scattered uniformly in a box `size` across, at rest or at random velocities `speed`. */
function cloud(n: number, size: { x: number; y: number; z: number }, seed: number, speed = 0): Boids {
  const random = new Random(seed);
  const boids = new Boids(n);
  boids.count = n;
  for (let i = 0; i < n; i++) {
    const a = random.next() * Math.PI * 2;
    const c = random.next() * 2 - 1;
    const s = Math.sqrt(1 - c * c);
    boids.place(i, random.next() * size.x, random.next() * size.y, random.next() * size.z, speed * s * Math.cos(a), speed * s * Math.sin(a), speed * c);
  }
  return boids;
}

/** Rules with every rule off: each test turns on what it checks. */
function bare(): BoidRules {
  const rules = boidRules();
  rules.separation = 0;
  rules.cohesion = 0;
  rules.alignment = 0;
  rules.speedHold = 0;
  return rules;
}

function nearestDistances(boids: Boids): number[] {
  const out: number[] = [];
  for (let i = 0; i < boids.count; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < boids.count; j++) {
      if (j !== i) best = Math.min(best, distance(boids, i, j));
    }
    out.push(best);
  }
  return out.sort((a, b) => a - b);
}

const distance = (boids: Boids, i: number, j: number): number =>
  Math.hypot((boids.x[j] ?? 0) - (boids.x[i] ?? 0), (boids.y[j] ?? 0) - (boids.y[i] ?? 0), (boids.z[j] ?? 0) - (boids.z[i] ?? 0));

/**
 * Local order: how well each boid's heading agrees with its neighbours', averaged over the flock (the
 * length of the mean of its own and its 7 nearest headings): 1 in a stream, about 0.35 every which way.
 */
function localOrder(boids: Boids): number {
  boids.index(1);
  const out = new Int32Array(16);
  let sum = 0;
  for (let i = 0; i < boids.count; i++) {
    const m = boids.nearest(i, 7, out);
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let q = -1; q < m; q++) {
      const j = q < 0 ? i : (out[q] ?? 0);
      const vx = boids.vx[j] ?? 0;
      const vy = boids.vy[j] ?? 0;
      const vz = boids.vz[j] ?? 0;
      const v = Math.hypot(vx, vy, vz) || 1;
      sx += vx / v;
      sy += vy / v;
      sz += vz / v;
    }
    sum += Math.hypot(sx, sy, sz) / (m + 1);
  }
  return sum / boids.count;
}

/** The distances to boid i's k nearest others, nearest first, by looking at every boid. */
function bruteNearest(boids: Boids, i: number, k: number): number[] {
  const best: number[] = [];
  for (let j = 0; j < boids.count; j++) {
    if (j === i) continue;
    const d = distance(boids, i, j);
    if (best.length === k && d >= (best[k - 1] ?? 0)) continue;
    let at = Math.min(best.length, k - 1);
    while (at > 0 && (best[at - 1] ?? 0) > d) {
      best[at] = best[at - 1] ?? 0;
      at--;
    }
    best[at] = d;
  }
  return best;
}

test("the neighbours are exactly each boid's k nearest, nearest first, unless the search's reach or bound cut it short", () => {
  // About 2.5 boids per cell: the seventh nearest lies within a cell of nearly every boid.
  const boids = cloud(1500, { x: 12, y: 10, z: 5 }, 7);
  const out = new Int32Array(16);
  for (const k of [1, 4, 7]) {
    boids.index(1);
    let checked = 0;
    for (let i = 0; i < boids.count; i++) {
      const before = boids.examined;
      const m = boids.nearest(i, k, out);
      const brute = bruteNearest(boids, i, k);
      // Exact only where the k-th lies within the two shells scanned and the search was not capped.
      if ((brute[k - 1] ?? 0) > 2 || boids.examined - before === BOIDS_MAX_EXAMINED) continue;
      checked++;
      expect(m).toBe(k);
      expect(Array.from(out.subarray(0, m)).map((j) => distance(boids, i, j))).toEqual(brute);
    }
    expect(checked).toBeGreaterThan(0.65 * boids.count);
  }
});

test("a search costs a bounded number of candidates, however crowded, and a straggler beyond reach finds none", () => {
  const boids = cloud(2000, { x: 0.05, y: 0.05, z: 0.05 }, 3);
  boids.place(1999, 100, 100, 100, 0, 0, 0);
  boids.index(1);
  const out = new Int32Array(16);
  for (let i = 0; i < 1999; i++) expect(boids.nearest(i, 7, out)).toBe(7);
  expect(boids.examined).toBeLessThanOrEqual(1999 * BOIDS_MAX_EXAMINED);
  expect(boids.nearest(1999, 7, out)).toBe(0);
  // A whole step over the crowd stays within the same bound.
  const rules = boidRules();
  boids.step(1 / 60, rules, new Random(1));
  expect(boids.examined).toBeLessThanOrEqual(2000 * BOIDS_MAX_EXAMINED);
});

test("separation parts boids that crowd in, cohesion closes a scattered flock, and both settle near the spacing", () => {
  const rules = bare();
  rules.spacing = 1;
  rules.separation = 3;
  rules.cohesion = 1.5;
  rules.speed = 0;
  rules.speedHold = 2;
  rules.alignment = 1;
  rules.maxAccel = 20;
  const random = new Random(5);
  // Crushed into a ball a tenth of the spacing across, and scattered four spacings apart.
  const crushed = cloud(400, { x: 0.8, y: 0.8, z: 0.8 }, 11);
  const scattered = cloud(400, { x: 30, y: 30, z: 30 }, 12);
  const crushedBefore = nearestDistances(crushed);
  const scatteredBefore = nearestDistances(scattered);
  for (let s = 0; s < 1200; s++) {
    crushed.step(1 / 60, rules, random);
    scattered.step(1 / 60, rules, random);
  }
  const median = (d: number[]): number => d[d.length >> 1] ?? 0;
  const crushedAfter = nearestDistances(crushed);
  const scatteredAfter = nearestDistances(scattered);
  expect(median(crushedBefore)).toBeLessThan(0.15);
  expect(median(scatteredBefore)).toBeGreaterThan(2);
  for (const after of [crushedAfter, scatteredAfter]) {
    expect(median(after)).toBeGreaterThan(0.6);
    expect(median(after)).toBeLessThan(1);
    // Nobody left sitting on another bird.
    expect(after[0] ?? 0).toBeGreaterThan(0.4);
  }
});

test("alignment turns boids flying every which way into local streams", () => {
  const rules = bare();
  rules.spacing = 1;
  rules.separation = 2;
  rules.cohesion = 0.5;
  rules.alignment = 2;
  rules.speed = 1;
  rules.speedHold = 1;
  const random = new Random(9);
  const aligned = cloud(600, { x: 8, y: 8, z: 8 }, 21, 1);
  expect(localOrder(aligned)).toBeLessThan(0.45);
  for (let s = 0; s < 600; s++) aligned.step(1 / 60, rules, random);
  expect(localOrder(aligned)).toBeGreaterThan(0.95);
  // Without alignment, neighbours keep flying their own ways.
  const loose = cloud(600, { x: 8, y: 8, z: 8 }, 21, 1);
  rules.alignment = 0;
  for (let s = 0; s < 600; s++) loose.step(1 / 60, rules, random);
  expect(localOrder(loose)).toBeLessThan(0.85);
});

test("the same start, rules and seed fly the same flock; another noise seed does not", () => {
  const rules = boidRules();
  rules.spacing = 1;
  rules.noise = 0.5;
  rules.level = 1;
  rules.homePull = 1;
  rules.reach.x = 5;
  rules.reach.y = 5;
  rules.reach.z = 5;
  const fly = (seed: number): Float32Array[] => {
    const boids = cloud(500, { x: 10, y: 10, z: 10 }, 4, 1);
    const random = new Random(seed);
    boids.startle(3);
    for (let s = 0; s < 240; s++) boids.step(1 / 60, rules, random);
    return [boids.x, boids.y, boids.z, boids.vx, boids.alarm];
  };
  expect(fly(1)).toEqual(fly(1));
  expect(fly(2)[0]).not.toEqual(fly(1)[0]);
});

test("a startle relays along the neighbours once, as a front at one hop per relay", () => {
  // A still line of boids a unit apart, each seeing the two beside it.
  const n = 40;
  const boids = new Boids(n);
  boids.count = n;
  for (let i = 0; i < n; i++) boids.place(i, i, 0, 0, 0, 0, 0);
  const rules = bare();
  rules.neighbours = 2;
  rules.spacing = 1.5;
  rules.speed = 0;
  rules.relay = 0.04;
  rules.startled = 0.3;
  rules.refractory = 2;
  const random = new Random(1);
  const step = 1 / 60;
  const startledAt: number[][] = Array.from({ length: n }, () => []);
  boids.startle(0);
  let previous = Array.from(boids.alarm);
  for (let s = 1; s <= 600; s++) {
    boids.step(step, rules, random);
    for (let i = 0; i < n; i++) if ((boids.alarm[i] ?? 0) < (previous[i] ?? 0)) startledAt[i]?.push(s);
    previous = Array.from(boids.alarm);
  }
  // Each boid after the first once, in order along the line: it catches the startle on the step its
  // neighbour has been startled `relay` (rounded up to whole steps), so one hop every hop steps. The
  // last boid's two nearest both lie behind it: it catches it from the one two back, with its neighbour.
  const hop = Math.ceil(rules.relay / step) + 1;
  expect(startledAt[0]).toEqual([]);
  for (let i = 1; i < n - 1; i++) expect(startledAt[i]).toEqual([i * hop]);
  expect(startledAt[n - 1]).toEqual([(n - 2) * hop]);
});

test("a threat scatters the boids within its reach and startles them; the rest fly on", () => {
  const rules = bare();
  rules.speed = 0;
  rules.threatRadius = 1;
  rules.flee = 4;
  rules.threat.x = 0;
  const boids = new Boids(3);
  boids.count = 3;
  boids.place(0, 0.3, 0, 0, 0, 0, 0);
  boids.place(1, -0.5, 0.2, 0, 0, 0, 0);
  boids.place(2, 3, 0, 0, 0, 0, 0);
  boids.step(1 / 60, rules, new Random(1));
  expect(boids.vx[0] ?? 0).toBeGreaterThan(0);
  expect(boids.vx[1] ?? 0).toBeLessThan(0);
  expect(boids.vy[1] ?? 0).toBeGreaterThan(0);
  expect(boids.alarm[0]).toBe(0);
  expect(boids.alarm[1]).toBe(0);
  expect([boids.x[2], boids.vx[2], boids.alarm[2]]).toEqual([3, 0, Number.POSITIVE_INFINITY]);
});

test("level flight flattens the flock across its up axis, and home brings strays back", () => {
  const rules = boidRules();
  rules.spacing = 1;
  rules.level = 1.5;
  rules.up.x = 0;
  rules.up.y = Math.cos(0.6);
  rules.up.z = Math.sin(0.6);
  rules.homePull = 2;
  rules.home.x = 10;
  rules.home.y = 10;
  rules.home.z = 10;
  rules.reach.x = 12;
  rules.reach.y = 12;
  rules.reach.z = 12;
  const boids = cloud(800, { x: 20, y: 20, z: 20 }, 31, 1);
  boids.place(0, 80, 10, 10, 1, 0, 0);
  const random = new Random(3);
  const spread = (): number => {
    let sum = 0;
    let sum2 = 0;
    for (let i = 1; i < boids.count; i++) {
      const h = (boids.y[i] ?? 0) * rules.up.y + (boids.z[i] ?? 0) * rules.up.z;
      sum += h;
      sum2 += h * h;
    }
    const mean = sum / (boids.count - 1);
    return Math.sqrt(sum2 / (boids.count - 1) - mean * mean);
  };
  const before = spread();
  for (let s = 0; s < 900; s++) boids.step(1 / 60, rules, random);
  expect(spread()).toBeLessThan(0.5 * before);
  const ox = ((boids.x[0] ?? 0) - 10) / 12;
  const oy = ((boids.y[0] ?? 0) - 10) / 12;
  const oz = ((boids.z[0] ?? 0) - 10) / 12;
  expect(Math.hypot(ox, oy, oz)).toBeLessThan(1.5);
});
