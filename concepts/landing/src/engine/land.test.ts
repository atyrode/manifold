import { describe, expect, test } from "bun:test";
import { groveDoc } from "./docs.ts";
import { groundHeight } from "./kinds/ground/height.ts";
import { grassKind, GRASS_TOP } from "./kinds/grass/index.ts";
import { kinds, optionValues } from "./kinds/index.ts";
import { engineLand, landUnder } from "./land.ts";
import type { EngineDoc, Placed } from "./types.ts";

const relief = 7;
const spread = 180;
const ground: Placed = {
  id: "ground",
  kind: "ground",
  at: [4, 1.5, -6],
  yaw: 0.7,
  scale: 1.25,
  options: { relief, spread },
};
const doc: EngineDoc = {
  v: 1,
  title: "land",
  camera: groveDoc.camera,
  world: {},
  objects: [ground],
};
const bare: EngineDoc = { ...doc, objects: [] };
/** Plan points a few hundred metres round the origin. */
const points = Array.from({ length: 40 }, (_, k) => [
  210 * Math.sin(k * 1.7) + 3 * k,
  190 * Math.cos(k * 2.3) - 2 * k,
]);

describe("the land on the CPU", () => {
  test("is the ground's height, through its place, turn and size", () => {
    const c = Math.cos(ground.yaw);
    const s = Math.sin(ground.yaw);
    for (const [x = 0, z = 0] of points) {
      // The world's plan point in the ground's own frame, written out apart from land.ts.
      const qx = (x - ground.at[0]) / ground.scale;
      const qz = (z - ground.at[2]) / ground.scale;
      const own = groundHeight(c * qx + s * qz, c * qz - s * qx, relief, spread);
      expect(engineLand(doc, x, z)).toBeCloseTo(ground.at[1] + ground.scale * own, 9);
    }
    // The ground's origin lies on its land.
    expect(engineLand(doc, ground.at[0], ground.at[2])).toBeCloseTo(ground.at[1], 9);
  });

  test("is level at y = 0, and every object's own base plane, where the document holds none", () => {
    for (const [x = 0, z = 0] of points) {
      expect(engineLand(bare, x, z)).toBe(0);
      expect(landUnder(bare, { ...ground, kind: "grass" })(x, z)).toBe(0);
    }
  });

  test("under an object is the land as the object measures it", () => {
    const patch: Placed = {
      id: "patch",
      kind: "grass",
      at: [-12, 3, 20],
      yaw: -1.1,
      scale: 0.8,
      options: {},
    };
    const under = landUnder(doc, patch);
    const c = Math.cos(patch.yaw);
    const s = Math.sin(patch.yaw);
    for (const [x = 0, z = 0] of points.map(([x = 0, z = 0]) => [x / 20, z / 20])) {
      const wx = patch.at[0] + patch.scale * (c * x - s * z);
      const wz = patch.at[2] + patch.scale * (s * x + c * z);
      expect(under(x, z)).toBeCloseTo((engineLand(doc, wx, wz) - patch.at[1]) / patch.scale, 9);
    }
  });

  test("is given by one kind alone, of the exclusive group ground", () => {
    const landKinds = kinds.filter((kind) => kind.land !== undefined);
    expect(landKinds.map((kind) => kind.id)).toEqual(["ground"]);
    for (const kind of landKinds) expect(kind.exclusive).toBe("ground");
  });
});

describe("a grass patch's bounds on the land", () => {
  test("hold the land under it and its tallest blades over it, and no more than they need", () => {
    for (const placed of groveDoc.objects.filter((object) => object.kind === "grass")) {
      const options = optionValues(grassKind, placed);
      const land = landUnder(groveDoc, placed);
      const box = grassKind.bounds(options, land);
      const w = (options["width"] ?? 0) / 2;
      const d = (options["depth"] ?? 0) / 2;
      let lo = Infinity;
      let hi = -Infinity;
      for (let x = -w; x <= w; x += 0.1) {
        for (let z = -d; z <= d; z += 0.1) {
          const y = land(x, z);
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
          expect(y).toBeGreaterThanOrEqual(box.min[1]);
          expect(y + (options["height"] ?? 0) * GRASS_TOP).toBeLessThanOrEqual(box.max[1]);
        }
      }
      // Fitted to the land: far tighter than bounds blind to it.
      const blind = grassKind.bounds(options);
      expect(box.max[1] - box.min[1]).toBeLessThan(blind.max[1] - blind.min[1]);
      expect(lo - box.min[1]).toBeLessThan(0.3);
      expect(box.max[1] - hi - (options["height"] ?? 0) * GRASS_TOP).toBeLessThan(0.3);
    }
  });
});
