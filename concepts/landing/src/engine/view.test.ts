import { expect, test } from "bun:test";
import { cameraRay, projectPoint } from "./camera.ts";
import { groundHeight } from "./kinds/ground/height.ts";
import { EngineStage } from "./stage.ts";
import type { EngineDoc, Placed, Vec3 } from "./types.ts";
import { createEngineView } from "./view.ts";

const GRID = { width: 200, height: 100 };
/** The cell at the middle of the grid: the camera's forward ray. */
const MIDDLE = [100, 50] as const;

const placed = (
  id: string,
  kind: string,
  at: Vec3,
  options: Record<string, number>,
  yaw = 0,
  scale = 1,
): Placed => ({ id, kind, at, yaw, scale, options });

const doc = (objects: Placed[], camera: Partial<EngineDoc["camera"]> = {}): EngineDoc => ({
  v: 1,
  title: "test",
  camera: { at: [0, 1, 0], yaw: 0, pitch: 0, fov: 0.9, ...camera },
  world: {},
  objects,
});

function viewOf(shown: EngineDoc) {
  const view = createEngineView(
    { grid: GRID, refresh: () => undefined },
    () => undefined,
    new EngineStage(shown),
  );
  view.setDoc(shown);
  return view;
}

const near = (a: Vec3 | undefined, b: Vec3, within = 1e-6) =>
  a !== undefined && a.every((x, k) => Math.abs(x - (b[k] ?? 0)) <= within);
test("picks the nearest object under a cell, by its exact shape", () => {
  const view = viewOf(
    doc([
      placed("far", "block", [0, 0, 20], { width: 8, height: 6, depth: 1 }),
      placed("ball", "sphere", [0, 0, 8], { radius: 1 }),
    ]),
  );
  expect(view.pick(...MIDDLE)).toBe("ball");
  // Through the ball's bounds by their corner, past the ball itself: its shape decides, not its box.
  const corner = projectPoint(view.doc.camera, [0.95, 1.95, 7], GRID.width, GRID.height);
  expect(corner).toBeDefined();
  if (corner !== undefined) expect(view.pick(corner[0], corner[1])).toBe("far");
  expect(view.pick(MIDDLE[0], GRID.height - 0.5)).toBeUndefined();
});

test("the surface under a cell: a sphere's, a turned and scaled block's, the ground's", () => {
  const sphere = viewOf(doc([placed("ball", "sphere", [0, 0, 8], { radius: 1 })]));
  const hit = sphere.surface(...MIDDLE);
  expect(near(hit?.at, [0, 1, 7])).toBe(true);
  expect(near(hit?.normal, [0, 0, -1])).toBe(true);

  // A wall turned a quarter about +y and doubled: its 0.2 m depth now lies along x, its face at
  // x = -0.2 faces -x; the eye looks along +x (yaw -π/2).
  const wall = viewOf(
    doc([placed("wall", "block", [5, 0, 0], { width: 3, height: 2, depth: 0.2 }, Math.PI / 2, 2)], {
      yaw: -Math.PI / 2,
    }),
  );
  const face = wall.surface(...MIDDLE);
  expect(near(face?.at, [4.8, 1, 0], 1e-9)).toBe(true);
  expect(near(face?.normal, [-1, 0, 0], 1e-9)).toBe(true);

  // Rolling ground seen from 1.65 m, looking down: the point lies on the land, its normal up-ish.
  const relief = 12;
  const spread = 320;
  const land = viewOf(
    doc([placed("ground", "ground", [0, 0, 0], { relief, spread })], {
      at: [0, 1.65, 0],
      pitch: -0.3,
    }),
  );
  const cells: readonly (readonly [number, number])[] = [MIDDLE, [30, 20], [180, 40]];
  for (const cell of cells) {
    const at = land.surface(...cell)?.at;
    expect(at).toBeDefined();
    if (at === undefined) continue;
    expect(Math.abs(at[1] - groundHeight(at[0], at[2], relief, spread))).toBeLessThan(0.01);
    const ray = cameraRay(land.doc.camera, cell[0], cell[1], GRID.width, GRID.height);
    const along =
      (at[0] - ray.o[0]) * ray.d[0] + (at[1] - ray.o[1]) * ray.d[1] + (at[2] - ray.o[2]) * ray.d[2];
    expect(
      near(
        at,
        [ray.o[0] + ray.d[0] * along, ray.o[1] + ray.d[1] * along, ray.o[2] + ray.d[2] * along],
        1e-6,
      ),
    ).toBe(true);
    expect(land.pick(...cell)).toBe("ground");
  }
});

test("a surface ignores the object it was asked to, finding what lies behind", () => {
  const view = viewOf(
    doc(
      [
        placed("ground", "ground", [0, 0, 0], { relief: 0 }),
        placed("box", "block", [0, 0, 4], { width: 1, height: 1, depth: 1 }),
      ],
      { at: [0, 2, 0], pitch: -0.3 },
    ),
  );
  expect(view.pick(...MIDDLE)).toBe("box");
  const behind = view.surface(MIDDLE[0], MIDDLE[1], "box");
  expect(near(behind?.normal, [0, 1, 0])).toBe(true);
  expect(Math.abs(behind?.at[1] ?? 1)).toBeLessThan(1e-6);
  expect(near(behind?.at, [0, 0, 2 / Math.tan(0.3)], 1e-6)).toBe(true);
});
