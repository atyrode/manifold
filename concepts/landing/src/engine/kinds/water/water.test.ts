import { expect, test } from "bun:test";
import { castDoc } from "../../cast.ts";
import type { EngineDoc, Vec3 } from "../../types.ts";
import {
  WATER_BANK_DROP,
  WATER_KIDNEY,
  WATER_LIFT,
  WATER_SHAPES,
  waterBankSlope,
  waterEdge,
  waterKind,
} from "./index.ts";

const shape = (name: (typeof WATER_SHAPES)[number]) => WATER_SHAPES.indexOf(name);

/** A document holding one body of water at `at`, turned by `yaw`. */
const pond = (options: Record<string, number>, at: Vec3 = [0, 0, 0], yaw = 0): EngineDoc => ({
  v: 1,
  title: "test",
  camera: { at: [0, 2, -10], yaw: 0, pitch: 0, fov: 0.9 },
  world: {},
  objects: [{ id: "pond", kind: "water", at, yaw, scale: 1, options }],
});

/** Where a ray straight down from 5 m over world point (x, z) meets the document, if anywhere. */
const down = (doc: EngineDoc, x: number, z: number) =>
  castDoc(doc, { o: [x, 5, z], d: [0, -1, 0] });

const options = (shapeName: (typeof WATER_SHAPES)[number], width: number, length: number) => ({
  shape: shape(shapeName),
  width,
  length,
  depth: 1,
});

test("each outline holds its known points and leaves out the ones just past it", () => {
  // Round, 10 across: its radius both ways, whatever its length says.
  expect(waterEdge(shape("round"), 5, 5, 4.99, 0)).toBeLessThan(0);
  expect(waterEdge(shape("round"), 5, 5, 0, 5.01)).toBeGreaterThan(0);
  expect(waterEdge(shape("round"), 5, 5, 3, 4)).toBeCloseTo(0, 9);
  // Oval 10 by 6: its half extents on its axes.
  expect(waterEdge(shape("oval"), 5, 3, 4.99, 0)).toBeLessThan(0);
  expect(waterEdge(shape("oval"), 5, 3, 0, 3.01)).toBeGreaterThan(0);
  expect(waterEdge(shape("oval"), 5, 3, 0, 2.99)).toBeLessThan(0);
  // The pool: its sides exactly, its corners rounded off.
  expect(waterEdge(shape("pool"), 5, 3, 4.99, 2.5)).toBeCloseTo(-0.01, 9);
  expect(waterEdge(shape("pool"), 5, 3, 5.01, 0)).toBeCloseTo(0.01, 9);
  expect(waterEdge(shape("pool"), 5, 3, 4.95, 2.95)).toBeGreaterThan(0);
  // The kidney: its middle's band from (lift - half) to (lift + half) of the length, bent.
  const K = WATER_KIDNEY;
  const b = 4;
  const low = (K.bend * K.lift - K.half) * b;
  const high = (K.bend * K.lift + K.half) * b;
  expect(waterEdge(shape("kidney"), 6, b, 0, low + 0.01)).toBeLessThan(0);
  expect(waterEdge(shape("kidney"), 6, b, 0, low - 0.01)).toBeGreaterThan(0);
  expect(waterEdge(shape("kidney"), 6, b, 0, high - 0.01)).toBeLessThan(0);
  expect(waterEdge(shape("kidney"), 6, b, 0, high + 0.01)).toBeGreaterThan(0);
  // Its ends bend toward the dent's side: the middle's lowest point is open water toward the ends.
  expect(waterEdge(shape("kidney"), 6, b, 4, low - 0.3)).toBeLessThan(0);
});

test("a ray meets the surface at the waterline within the outline, and passes beyond it", () => {
  const doc = pond(options("round", 10, 10), [2, 1, 3]);
  const middle = down(doc, 2, 3);
  expect(middle?.id).toBe("pond");
  expect(middle?.at[1]).toBeCloseTo(1 + WATER_LIFT, 9);
  expect(middle?.normal).toEqual([0, 1, 0]);
  expect(down(doc, 2 + 4.99, 3)?.at[1]).toBeCloseTo(1 + WATER_LIFT, 9);
  // Past the bank's reach there is nothing of it.
  const reach = WATER_BANK_DROP / waterBankSlope(shape("round"));
  expect(down(doc, 2 + 5 + reach + 0.01, 3)).toBeUndefined();
  // A slanted ray from the shore: where it crosses the waterline.
  const slant: Vec3 = [0, -0.6, 0.8];
  const across = castDoc(doc, { o: [2, 3, -3], d: slant });
  const t = (1 + WATER_LIFT - 3) / slant[1];
  expect(across?.t).toBeCloseTo(t, 9);
  expect(across?.at[2]).toBeCloseTo(-3 + 0.8 * t, 9);
  // Rising, or from under the waterline, it meets none of it.
  expect(castDoc(doc, { o: [2, 0.5, 3], d: [0, -1, 0] })).toBeUndefined();
  expect(castDoc(doc, { o: [2, 3, -8], d: [0, 0.6, 0.8] })).toBeUndefined();
});

test("past the outline the bank falls from the waterline, leaning outward", () => {
  const doc = pond(options("round", 10, 10));
  const slope = waterBankSlope(shape("round"));
  const hit = down(doc, 5.4, 0);
  expect(hit?.id).toBe("pond");
  expect(hit?.at[1]).toBeCloseTo(WATER_LIFT - slope * 0.4, 3);
  const n = hit?.normal ?? [0, 0, 0];
  expect(n[0]).toBeCloseTo(slope / Math.hypot(slope, 1), 3);
  expect(n[1]).toBeCloseTo(1 / Math.hypot(slope, 1), 3);
  // A grazing ray down onto the bank from beyond it, toward the water.
  const d: Vec3 = [-Math.cos(0.1), -Math.sin(0.1), 0];
  const grazing = castDoc(doc, { o: [8, WATER_LIFT + 0.3, 0], d });
  expect(grazing?.id).toBe("pond");
  const x = grazing?.at[0] ?? 0;
  expect(x).toBeGreaterThan(5);
  expect(grazing?.at[1]).toBeCloseTo(WATER_LIFT - slope * (x - 5), 3);
});

test("a turned pool is met along its length and passed beside it", () => {
  // 12 long and 4 wide, turned a quarter: its length along the world's x.
  const doc = pond(options("pool", 4, 12), [0, 0, 0], Math.PI / 2);
  expect(down(doc, 5.9, 0)?.at[1]).toBeCloseTo(WATER_LIFT, 9);
  expect(down(doc, 0, 1.9)?.at[1]).toBeCloseTo(WATER_LIFT, 9);
  const reach = WATER_BANK_DROP / waterBankSlope(shape("pool"));
  expect(down(doc, 0, 2 + reach + 0.01)).toBeUndefined();
  expect(down(doc, 6 + reach + 0.01, 0)).toBeUndefined();
});

test("its bounds hold its surface and bank, whatever its shape", () => {
  for (const name of WATER_SHAPES) {
    const values = { ...options(name, 9, 7), bed: 0, clarity: 0.5, tint: 0.5, ice: 0 };
    const box = waterKind.bounds(values);
    const reach = WATER_BANK_DROP / waterBankSlope(shape(name));
    const b = name === "round" ? 4.5 : 3.5;
    // Every point of the outline (sampled round its box) lies inside the bounds' plan.
    for (let x = -4.5; x <= 4.5; x += 0.25)
      for (let z = -b; z <= b; z += 0.25)
        if (waterEdge(shape(name), 4.5, b, x, z) <= reach) {
          expect(Math.abs(x)).toBeLessThanOrEqual(box.max[0]);
          expect(Math.abs(z)).toBeLessThanOrEqual(box.max[2]);
        }
    expect(box.max[1]).toBeGreaterThan(WATER_LIFT);
    expect(box.min[1]).toBeLessThanOrEqual(WATER_LIFT - WATER_BANK_DROP);
  }
});
