import { expect, test } from "bun:test";
import { marchHeight, sampleRepeat, type HeightMarch, type RayHit } from "./heightray.ts";

const MARCH: HeightMarch = { top: 16, far: 900, slope: 0.75, minStep: 0.02, relStep: 0.01, steps: 48, refine: 5 };

function unit(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
}

test("a ray meets level ground where the plane says, and a plateau at its face, not the level behind it", () => {
  const hit: RayHit = { t: 0, x: 0, y: 0, z: 0 };
  const [dx, dy, dz] = unit(0, -0.05, 1);
  expect(marchHeight(() => 0, 0, 10, 0, dx, dy, dz, { ...MARCH, refine: 30 }, hit)).toBe(true);
  expect(hit.z).toBeCloseTo(200, 3);
  expect(hit.y).toBeCloseTo(0, 3);

  // Ground rising to 12 from z = 60 on: the ray, still 7 above the level there, meets the face.
  const plateau = (_x: number, z: number): number => (z >= 60 ? 12 : 0);
  expect(marchHeight(plateau, 0, 10, 0, dx, dy, dz, MARCH, hit)).toBe(true);
  expect(Math.abs(hit.z - 60)).toBeLessThan(1);
});

test("rays leaving upward, starting above the top, or running past far behave as the shader's march", () => {
  const hit: RayHit = { t: 0, x: 0, y: 0, z: 0 };
  const [ux, uy, uz] = unit(0, 0.1, 1);
  expect(marchHeight(() => 0, 0, 10, 0, ux, uy, uz, MARCH, hit)).toBe(false);
  // From above the top coming down, the march starts where the ray crosses the top.
  const [dx, dy, dz] = unit(0, -1, 1);
  expect(marchHeight(() => 0, 0, 40, 0, dx, dy, dz, { ...MARCH, refine: 30 }, hit)).toBe(true);
  expect(hit.z).toBeCloseTo(40, 3);
  const [fx, fy, fz] = unit(0, -0.001, 1);
  expect(marchHeight(() => 0, 0, 10, 0, fx, fy, fz, { ...MARCH, far: 300 }, hit)).toBe(false);
  // Out of steps while still above the ground: called there, in the air, as the shader does.
  expect(marchHeight(() => 0, 0, 10, 0, fx, fy, fz, { ...MARCH, steps: 3 }, hit)).toBe(true);
  expect(hit.y).toBeGreaterThan(0);
});

test("sampleRepeat reads a grid as a linear, repeating texture: texel centres at i + 0.5, wrapping both ways", () => {
  // 4 × 2, rows bottom to top.
  const data = Float32Array.of(0, 1, 2, 3, 10, 11, 12, 13);
  expect(sampleRepeat(data, 4, 2, 0.5, 0.5)).toBe(0);
  expect(sampleRepeat(data, 4, 2, 2.5, 1.5)).toBe(12);
  expect(sampleRepeat(data, 4, 2, 1, 0.5)).toBeCloseTo(0.5, 6);
  // Between the last texel and the first, across the seam, and a whole period away.
  expect(sampleRepeat(data, 4, 2, 0, 0.5)).toBeCloseTo(1.5, 6);
  expect(sampleRepeat(data, 4, 2, 4, 0.5)).toBeCloseTo(1.5, 6);
  expect(sampleRepeat(data, 4, 2, -3.5, 0.5)).toBeCloseTo(0, 6);
  expect(sampleRepeat(data, 4, 2, 0.5, 0)).toBeCloseTo(5, 6);
});
