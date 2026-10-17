import { expect, test } from "bun:test";
import { grayScottAlong, grayScottRegimes } from "../../sims/grayscott.ts";
import { petriFeedKill } from "./sim.ts";

const feedKill = (
  drift: number,
  hold: { feed: number; kill: number } | undefined,
  arrived: number,
): number[] => {
  const out = new Float32Array(4);
  petriFeedKill(out, drift, hold, arrived);
  return Array.from(out);
};

test("wandering, the dish spreads either side of the drift along the loop and moves with it", () => {
  const early = feedKill(0, undefined, 1);
  const later = feedKill(2.5, undefined, 1);
  // Regions behind and ahead of the drift differ: neighbouring classes share the dish.
  expect(early[0]).not.toBe(early[2]);
  expect(later).not.toEqual(early);
  // The drift sits between them on the loop.
  const centre = new Float32Array(2);
  grayScottAlong(2.5, centre, 0);
  expect(centre[0]).toBeGreaterThanOrEqual(Math.min(later[0] ?? 0, later[2] ?? 0));
  expect(centre[0]).toBeLessThanOrEqual(Math.max(later[0] ?? 0, later[2] ?? 0));
});

test("a held regime, or the Advanced feed and kill, holds the whole dish at one point whatever the drift", () => {
  const holds = [...grayScottRegimes, { feed: 0.0421, kill: 0.0587 }];
  for (const hold of holds) {
    for (const drift of [0, 0.35, 3.9, 120]) {
      const [feedBehind, killBehind, feedAhead, killAhead] = feedKill(drift, hold, 1);
      expect(feedBehind).toBeCloseTo(hold.feed, 7);
      expect(feedAhead).toBeCloseTo(hold.feed, 7);
      expect(killBehind).toBeCloseTo(hold.kill, 7);
      expect(killAhead).toBeCloseTo(hold.kill, 7);
    }
  }
});

test("a fresh held dish starts where its seed settled, on the loop, and is eased over to the hold", () => {
  const wander = feedKill(0, undefined, 1);
  for (const hold of grayScottRegimes.slice(1)) {
    expect(feedKill(0, hold, 0)).toEqual(wander);
    const half = feedKill(0, hold, 0.5);
    for (let i = 0; i < 4; i++) {
      const target = i % 2 === 0 ? hold.feed : hold.kill;
      const from = wander[i] ?? 0;
      const share = ((half[i] ?? 0) - from) / (target - from);
      if (Math.abs(target - from) > 1e-6) {
        expect(share).toBeGreaterThan(0.2);
        expect(share).toBeLessThan(0.8);
      }
    }
    expect(feedKill(0, hold, 2)).toEqual(feedKill(0, hold, 1));
  }
});
