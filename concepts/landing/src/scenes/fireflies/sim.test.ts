import { expect, test } from "bun:test";
import { HeadlessSim, type HeadlessFrame } from "../../sims/headless.ts";
import { firefliesScene } from "./index.ts";
import { FIREFLIES_CELL } from "./sim.ts";

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
