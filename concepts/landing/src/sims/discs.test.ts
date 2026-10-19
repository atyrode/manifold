import { expect, test } from "bun:test";
import { type Disc, separateDiscs } from "./discs.ts";

const disc = (x: number, z: number, radius = 0.5, alive = true): Disc => ({ x, z, radius, alive });

test("coincident discs part along a fixed direction, a limited step at a time, until their floor", () => {
  const run = (): Disc[] => {
    const discs = [disc(1, 2), disc(1, 2)];
    for (let k = 0; k < 3; k++) separateDiscs(discs, { give: 0.2, limit: 0.1 });
    return discs;
  };
  const [a, b] = run();
  if (!a || !b) throw new Error("missing discs");
  // Three calls of at most 0.1 each, half to either side, about the shared centre.
  expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(0.3, 9);
  expect((a.x + b.x) / 2).toBeCloseTo(1, 9);
  expect((a.z + b.z) / 2).toBeCloseTo(2, 9);
  expect(run()).toEqual([a, b]);
  const discs = [a, b];
  for (let k = 0; k < 20; k++) separateDiscs(discs, { give: 0.2, limit: 0.1 });
  // Moved apart only to (1 - give) of touching: the rest is left to the sim's own contact forces.
  expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(0.8, 9);
});

test("contact within the give, and discs out of play, are left where they are", () => {
  const discs = [disc(0, 0), disc(0.85, 0), disc(0.2, 0.1, 0.5, false)];
  separateDiscs(discs, { give: 0.2, limit: 1 });
  expect(discs.map((d) => [d.x, d.z])).toEqual([
    [0, 0],
    [0.85, 0],
    [0.2, 0.1],
  ]);
});
