import { describe, expect, test } from "bun:test";
import type { Vec3 } from "../../types.ts";
import { TREE_ROOT, TREE_SPECIES, treeEnvelope, treeKind, type TreeSpecies } from "./index.ts";

const optionsOf = (species: TreeSpecies, height = 8, spread = 6) => ({
  species: TREE_SPECIES.indexOf(species),
  height,
  spread,
  seed: 0,
  season: 0.3,
});
const cast = (
  options: Record<string, number>,
  ro: Vec3,
  rd: Vec3,
  span: readonly [number, number] = [0, 1e3],
) => {
  if (treeKind.cast === undefined) throw new Error("the tree has no cast");
  return treeKind.cast(options, ro, rd, span);
};

describe("the tree's cast", () => {
  test("a level ray meets the trunk's side at its radius", () => {
    const options = optionsOf("oak");
    const { trunk } = treeEnvelope("oak", 8, 6);
    const hit = cast(options, [-10, 1, 0], [1, 0, 0]);
    expect(hit?.t).toBeCloseTo(10 - trunk, 9);
    expect(hit?.normal[0]).toBeCloseTo(-1, 9);
    expect(hit?.normal[1]).toBeCloseTo(0, 9);
  });

  test("a ray down through the crown meets its top, under the tree's bounds", () => {
    for (const species of TREE_SPECIES) {
      const options = optionsOf(species, 10, 7);
      const { centre, radii } = treeEnvelope(species, 10, 7);
      const hit = cast(options, [centre[0], 50, centre[2]], [0, -1, 0]);
      expect(hit?.t).toBeCloseTo(50 - centre[1] - radii[1], 9);
      expect(hit?.normal[1]).toBeCloseTo(1, 9);
      const bounds = treeKind.bounds(options);
      expect(centre[1] + radii[1]).toBeLessThanOrEqual(bounds.max[1]);
      expect(centre[0] + radii[0]).toBeLessThanOrEqual(bounds.max[0]);
      expect(centre[0] - radii[0]).toBeGreaterThanOrEqual(bounds.min[0]);
      expect(bounds.min[1]).toBe(-TREE_ROOT);
    }
  });

  test("a ray past the tree, or a hit outside the span, meets nothing", () => {
    const options = optionsOf("birch");
    expect(cast(options, [-10, 1, 5], [1, 0, 0])).toBeUndefined();
    expect(cast(options, [-10, 1, 0], [1, 0, 0], [0, 5])).toBeUndefined();
    // The trunk stops at the fork: above it, in the crown's gap, a level ray meets the crown.
    const oak = treeEnvelope("oak", 8, 6);
    const high = cast(optionsOf("oak"), [-20, oak.centre[1], 0], [1, 0, 0]);
    expect(high?.t).toBeCloseTo(20 - oak.radii[0], 9);
  });
});
