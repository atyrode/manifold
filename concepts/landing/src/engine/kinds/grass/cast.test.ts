import { expect, test } from "bun:test";
import type { Vec3 } from "../../types.ts";
import { grassKind } from "./index.ts";

const options = { width: 6, depth: 4, height: 0.4, density: 0.75, flowers: 0.15, dry: 0.15 };
const cast = (ro: Vec3, rd: Vec3, span: readonly [number, number] = [0, 1e3]) => {
  if (grassKind.cast === undefined) throw new Error("the grass has no cast");
  return grassKind.cast(options, ro, rd, span);
};

test("the grass is picked by its floor, not its blades' tips, within its patch alone", () => {
  const down = Math.SQRT1_2;
  const hit = cast([0, 2, -2], [0, -down, down]);
  expect(hit?.t).toBeCloseTo(2 / down, 9);
  expect(hit?.normal).toEqual([0, 1, 0]);
  // Past its depth (z = 2.5 > 2), and level rays, meet nothing.
  expect(cast([0, 2.5, 0], [0, -down, down])).toBeUndefined();
  expect(cast([-5, 0.2, 0], [1, 0, 0])).toBeUndefined();
});
