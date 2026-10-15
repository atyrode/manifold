import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { firefliesScene } from "./index.ts";
import { FIREFLIES_CELL, FIREFLIES_PROFILE_RES, FIREFLIES_ROOT_PITCH, FIREFLIES_STATE_BANK, FIREFLIES_WATER } from "./sim.ts";

/** A frame at these knobs: a thirtieth of a second at motion 0.6, the pointer away. */
const frameAt = (knobs: Record<string, number>): HeadlessFrame => ({ dt: 1 / 30, motion: 0.6, knobs, pointer: { inside: false } });

/** The bank's fireflies as uSim0 has them after one more frame: how many, and their mean height above the waterline. */
function census(sim: HeadlessSim, knobs: Record<string, number>): { count: number; height: number } {
  const swarm = sim.step(frameAt(knobs)).upload(0);
  let count = 0;
  let height = 0;
  for (let i = 0; i < swarm.width * swarm.height; i++) {
    if ((swarm.data[4 * i] ?? -1) < 0) continue;
    count++;
    height += (Math.floor(i / swarm.width) + 0.5) * FIREFLIES_CELL;
  }
  return { count, height: height / Math.max(count, 1) };
}

/** A sim at these knobs once its opening seconds have run and a few seconds more. */
function settled(knobs: Record<string, number>): HeadlessSim {
  const sim = new HeadlessSim(firefliesScene);
  // Paused frames finish the (time-budgeted) warm-up; then three seconds of swarm.
  for (let f = 0; f < 20; f++) sim.step({ ...frameAt(knobs), dt: 0 });
  for (let f = 0; f < 90; f++) sim.step(frameAt(knobs));
  return sim;
}

test("the open bank holds exactly as many fireflies as the dense crowns, lower over the bank", () => {
  for (const seed of [0, 7]) {
    for (const density of [0.1, 0.4, 0.65, 1]) {
      const crowns = { seed, density, habitat: 0 };
      const open = { seed, density, habitat: 1 };
      const a = census(settled(crowns), crowns);
      const b = census(settled(open), open);
      expect({ seed, density, count: b.count }).toEqual({ seed, density, count: a.count });
      expect(a.count).toBeGreaterThan(0);
      expect(b.height).toBeLessThan(a.height);
    }
  }
});

test("switching the bank keeps the swarm's size and moves it over", () => {
  const crowns = { seed: 3, habitat: 0 };
  const open = { seed: 3, habitat: 1 };
  const sim = settled(crowns);
  const before = census(sim, crowns);
  // Ten seconds: the fireflies leaving fade out (they ease over under a second of swarm time).
  for (let f = 0; f < 300; f++) sim.step(frameAt(open));
  const after = census(sim, open);
  expect(after.count).toBe(before.count);
  expect(after.height).toBeLessThan(before.height);
});

interface Root {
  bin: number;
  side: number;
  apex: [number, number];
  foot: [number, number];
}

/** The prop roots uSim3 holds (records of the plant component after a row of the sim's own): each drawn root's apex and foot. */
function propRoots(sim: HeadlessSim): { first: number; roots: Root[] } {
  const { width, data } = sim.upload(3);
  const first = data[0] ?? 0;
  const bins = data[1] ?? 0;
  const roots: Root[] = [];
  for (let r = 0; r < 2 * bins; r++) {
    const texel = (row: number): number => ((1 + 4 * Math.floor(r / width) + row) * width + (r % width)) * 4;
    const [t0, t1, t2, t3] = [texel(0), texel(1), texel(2), texel(3)];
    if ((data[t3 + 3] ?? 0) <= 0) continue;
    const x = (data[t0] ?? 0) + (data[t0 + 1] ?? 0);
    const y = (data[t0 + 2] ?? 0) + (data[t0 + 3] ?? 0);
    const cos = data[t1] ?? 0;
    const sin = data[t1 + 1] ?? 0;
    // Its turn in the scene's frame (curl in a, plus the bend), as the shader's plantPoint reads it.
    const half = 0.5 * ((data[t2 + 1] ?? 0) + (data[t2] ?? 0));
    const chord = (data[t1 + 2] ?? 0) * (Math.abs(half) < 1e-4 ? 1 : Math.sin(half) / half);
    const foot: [number, number] = [x + chord * (cos * Math.cos(half) - sin * Math.sin(half)), y + chord * (cos * Math.sin(half) + sin * Math.cos(half))];
    roots.push({ bin: Math.floor(r / 2), side: r % 2 === 0 ? -1 : 1, apex: [x, y], foot });
  }
  return { first, roots };
}

/**
 * How far the crowns stand shifted between two uSim1 profiles over the stretch of bank from x0 to x1
 * (screen heights from the middle): the whole number of profile texels the resting canopy's top
 * must slide by to match it best; 0 where the stretch is not all in the profile, or matches as is.
 */
function crownShift(rest: ArrayLike<number>, now: ArrayLike<number>, width: number, x0: number, x1: number): number {
  const dx = FIREFLIES_CELL / FIREFLIES_PROFILE_RES;
  const k0 = Math.floor(Math.min(x0, x1) / dx + width / 2);
  const k1 = Math.ceil(Math.max(x0, x1) / dx + width / 2);
  if (k0 < 8 || k1 > width - 8) return 0;
  let best = 0;
  let least = Infinity;
  for (const s of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6]) {
    let miss = 0;
    for (let k = k0; k < k1; k++) miss += Math.abs((now[4 * k] ?? 0) - (rest[4 * (k - s)] ?? 0));
    if (miss < least - 1e-9) {
      least = miss;
      best = s;
    }
  }
  return best;
}

test("prop roots stand in pairs from an apex in their bin under the crowns, down into the water either side", () => {
  for (const habitat of [0, 1]) {
    const sim = settled({ seed: 0, habitat });
    const { first, roots } = propRoots(sim);
    expect(roots.length).toBeGreaterThan(habitat === 0 ? 100 : 20);
    const byBin = new Map<number, Root[]>();
    for (const root of roots) byBin.set(root.bin, [...(byBin.get(root.bin) ?? []), root]);
    for (const [bin, pair] of byBin) {
      expect(pair.map((root) => root.side)).toEqual([-1, 1]);
      const [left, right] = pair as [Root, Root];
      expect(left.apex).toEqual(right.apex);
      const [x, y] = left.apex;
      expect(x).toBeGreaterThanOrEqual((first + bin) * FIREFLIES_ROOT_PITCH);
      expect(x).toBeLessThanOrEqual((first + bin + 1) * FIREFLIES_ROOT_PITCH);
      expect(y).toBeGreaterThan(FIREFLIES_WATER + 0.004);
      for (const root of pair) {
        expect(Math.abs(root.foot[1] - (FIREFLIES_WATER - 0.003))).toBeLessThan(2e-4);
        expect(Math.sign(root.foot[0] - x)).toBe(root.side);
      }
    }
  }
});

test("a breeze bows the crowns downwind as it crosses, and the bank then stands exactly as laid out", () => {
  for (const seed of [0, 4]) {
    const knobs = { seed };
    const at = (now?: string[]): HeadlessFrame => ({ dt: 1 / 30, motion: 1, knobs, pointer: { inside: false }, ...(now ? { now } : {}) });
    const sim = settled(knobs);
    const profile = sim.upload(1);
    const rest = Float32Array.from(profile.data);
    const restRoots = Float32Array.from(sim.upload(3).data);
    sim.step(at(["unrest"]));
    const bank = 4 * FIREFLIES_STATE_BANK;
    let front = sim.upload(2).data[bank + 1] ?? 0;
    let bow = 0;
    let deepest = 0;
    let downwind = 0;
    let moved = false;
    for (let f = 0; f < 30 * 40; f++) {
      sim.step(at());
      const state = sim.upload(2).data;
      const now = sim.upload(1).data;
      if ((state[bank + 2] ?? 0) > 0.5) {
        // The trees the front has just passed, a little behind it.
        downwind = Math.sign((state[bank + 1] ?? 0) - front);
        front = state[bank + 1] ?? 0;
        const shift = crownShift(rest, now, profile.width, front - 0.05 * downwind, front - 0.25 * downwind);
        bow += shift;
        deepest = Math.max(deepest, shift * downwind);
      }
      moved ||= now.some((v, i) => v !== rest[i]);
    }
    // The crowns bow the way the breeze blows, two texels and more (2.7 cells at 540 rows) at the deepest.
    expect(moved).toBe(true);
    expect(downwind).not.toBe(0);
    expect(Math.sign(bow)).toBe(downwind);
    expect(deepest).toBeGreaterThanOrEqual(2);
    // Long after it has passed: the profile and the roots are the bank's own again, bit for bit.
    expect(sim.upload(1).data).toEqual(rest);
    expect(sim.upload(3).data).toEqual(restRoots);
  }
});

test("between breezes the trees stand still", () => {
  const knobs = { seed: 2, unrest: 0 };
  const sim = settled(knobs);
  const rest = Float32Array.from(sim.upload(1).data);
  const restRoots = Float32Array.from(sim.upload(3).data);
  for (let f = 0; f < 600; f++) sim.step(frameAt(knobs));
  expect(sim.upload(1).data).toEqual(rest);
  expect(sim.upload(3).data).toEqual(restRoots);
});
