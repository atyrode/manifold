import { describe, expect, test } from "bun:test";
import { smoothstep } from "../../sims/math.ts";
import { CAMERA, Garden } from "./garden.ts";
import {
  BEES_BLOOMS_ALL,
  BEES_CAM,
  BEES_DEPTH_STEP,
  BEES_FOXGLOVES_ALL,
  BEES_HIVE,
  BEES_HIVE_SCALE,
  BEES_HIVES,
  BEES_PATCHES,
  BEES_YH,
  beesStage,
} from "./layout.ts";
import { depthByte } from "./paint.ts";

/** The depth the shader gives a plant standing at row y (beesZ: the ground's depth there). */
const standsAt = (y: number): number => BEES_CAM / (BEES_YH - y);
/** The depth the shader reads back from a speck's depth byte. */
const drawnAt = (z: number): number => depthByte(z) / BEES_DEPTH_STEP;

function garden(tm: number, wind: number): Garden {
  const g = new Garden();
  g.stage = beesStage(16 / 9);
  g.aspect = 16 / 9;
  g.tm = tm;
  g.wind = wind;
  return g;
}

describe("perches", () => {
  test("an insect on a foxglove's bell is drawn on the bell, in front of the spike", () => {
    for (const [tm, wind] of [
      [0, 0],
      [7.3, 0.8],
    ] as const) {
      const g = garden(tm, wind);
      for (const [i, [f, y, height]] of BEES_FOXGLOVES_ALL.entries()) {
        const S = (BEES_YH - y) / BEES_CAM;
        const bend =
          (0.4 + 0.8 * Math.abs(wind)) * 0.05 * height * S * Math.sin(tm * 0.55 + i * 2.1) +
          0.04 * height * S * Math.sin(i * 1.9);
        for (const bell of [0.44, 0.6, 0.86, 1]) {
          // The bell's half width there (shader.ts beesFoxglove, its narrowest scallop).
          const half = 0.07 * S * (1 - 0.65 * smoothstep(0.42, 1, bell)) * 0.78;
          for (const side of [-1, 0, 1]) {
            g.bellPoint(i, bell, side);
            const { x, z, h } = g.pt;
            expect(drawnAt(z)).toBeLessThan(standsAt(y));
            expect(CAMERA.screenY(h, z)).toBeCloseTo(y + bell * height * S, 9);
            expect(
              Math.abs(CAMERA.screenX(x, z) - (f * g.stage + bend * bell * bell)),
            ).toBeLessThanOrEqual(half);
          }
        }
      }
    }
  });

  test("a bee on a landing board is drawn on the board, in front of its hive", () => {
    const g = garden(0, 0);
    for (const [i, hive] of BEES_HIVES.entries()) {
      g.locate(i);
      const { landX, landZ, landH } = g.geo;
      const S = (BEES_YH - hive.y) / BEES_CAM;
      expect(drawnAt(landZ)).toBeLessThan(standsAt(hive.y));
      expect(CAMERA.screenX(landX, landZ)).toBeCloseTo(hive.f * g.stage, 9);
      expect(CAMERA.screenY(landH, landZ)).toBeCloseTo(
        hive.y + (BEES_HIVE.stand + 0.004) * BEES_HIVE_SCALE * S,
        9,
      );
    }
  });

  test("an insect on a near bloom's head is drawn on the head, in front of the bloom", () => {
    const g = garden(3.1, 0.4);
    for (const [i, [f, y]] of BEES_BLOOMS_ALL.entries()) {
      g.bloomPoint(i, 0, 0);
      const { x, z, h } = g.pt;
      const sway = 0.004 * (0.5 + 0.4) * Math.sin(3.1 * 0.5 + i * 2.3);
      expect(drawnAt(z)).toBeLessThan(standsAt(y));
      expect(CAMERA.screenY(h, z)).toBeCloseTo(y, 9);
      expect(CAMERA.screenX(x, z)).toBeCloseTo(f * g.stage + sway, 9);
    }
  });
});

describe("the drifts as the flowers knob grows them", () => {
  test("a point of a drift's ellipse is found again where it lies", () => {
    const g = garden(0, 0);
    for (const flowers of [1, 1.6, 2.4, 3]) {
      g.setFlowers(flowers);
      for (const index of BEES_PATCHES.keys()) {
        for (const [ex, ey] of [
          [0.3, 0.4],
          [-0.7, -0.5],
          [0.1, -0.95],
        ] as const) {
          g.patchPoint(index, ex, ey);
          g.patchCoords(index, g.pt.x, g.pt.z, g.pt.h);
          expect(g.pc.ex).toBeCloseTo(ex, 9);
          expect(g.pc.ey).toBeCloseTo(ey, 9);
        }
      }
    }
  });

  test("past 2 a drift's near side runs down toward the lens", () => {
    const g = garden(0, 0);
    g.patchPoint(1, 0, -1);
    const near = g.pt.z;
    g.setFlowers(3);
    g.patchPoint(1, 0, -1);
    expect(g.pt.z).toBeLessThan(near * 0.8);
  });
});
