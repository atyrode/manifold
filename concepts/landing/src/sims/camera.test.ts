import { expect, test } from "bun:test";
import { LevelCamera } from "./camera.ts";
import { mulberry32 } from "./random.ts";

// The views of two scenes on the camera: bees (focal 1) and lake (a 1.08 rad field of view).
const BEES = { horizon: 0.47, eye: 1.6, focal: 1 };
const LAKE = { horizon: 0.4, eye: 1.6, focal: 0.5 / Math.tan(1.08 / 2) };

test("the ground's drop below the horizon and its depth undo each other and agree with the projection", () => {
  for (const view of [BEES, LAKE]) {
    const camera = new LevelCamera(view);
    for (const z of [0.9, 4, 37, 160]) {
      const drop = camera.groundDrop(z);
      expect(camera.horizon - camera.screenY(0, z)).toBeCloseTo(drop, 12);
      expect(camera.groundDepth(drop)).toBeCloseTo(z, 9);
      expect(camera.worldY(camera.horizon - drop, z)).toBeCloseTo(0, 12);
    }
    // Farther ground shows closer under the horizon, and a nearer eye sees it closer still.
    expect(camera.groundDrop(40)).toBeLessThan(camera.groundDrop(4));
    expect(new LevelCamera({ ...view, eye: 0.5 * view.eye }).groundDrop(4)).toBeCloseTo(
      0.5 * camera.groundDrop(4),
      12,
    );
  }
});

test("the camera computes the formulas bees, lake and fireflies used to inline, bit for bit", () => {
  const rand = mulberry32(0x63616d);
  const bees = new LevelCamera(BEES);
  const lake = new LevelCamera(LAKE);
  const fireflies = { horizon: 0.34 + (1.2 / 60) * 1.2, eye: 1.2, focal: 1.2 };
  const fly = new LevelCamera(fireflies);
  for (let i = 0; i < 2000; i++) {
    const sy = 0.46 * rand();
    const sx = 2 * rand() - 1;
    const z = 0.8 + 60 * rand();
    const h = 3 * rand();
    // bees (sim.ts): ground and world targets, and the projection of a flying bee.
    expect(bees.groundDepth(BEES.horizon - sy)).toBe(BEES.eye / (BEES.horizon - sy));
    expect(bees.worldX(sx, z)).toBe(sx * z);
    expect(bees.worldY(sy, z)).toBe(BEES.eye - (BEES.horizon - sy) * z);
    expect(bees.screenX(sx, z)).toBe(sx / z);
    expect(bees.screenY(h, z)).toBe(BEES.horizon - (BEES.eye - h) / z);
    expect(bees.screenY(0, z)).toBe(BEES.horizon - BEES.eye / z);
    // lake (sim.ts): the crack and snow fields.
    expect(lake.screenX(sx, z)).toBe((sx * LAKE.focal) / z);
    expect(lake.groundDrop(z)).toBe((LAKE.eye * LAKE.focal) / z);
    expect(lake.groundDepth(sy)).toBe((LAKE.eye * LAKE.focal) / sy);
    expect(lake.worldX(0.01, z)).toBe(0.01 * (z / LAKE.focal));
    // fireflies (sim.ts): the lights nearer than the bank.
    expect(fly.screenY(h, z)).toBe(fireflies.horizon + ((h - fireflies.eye) * fireflies.focal) / z);
  }
});
