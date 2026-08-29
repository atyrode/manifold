import { describe, expect, test } from "bun:test";
import { FRACTION_SNAP_EPSILON, stepToward } from "./interpolate";

describe("stepToward", () => {
  test("moves halfway to the target in one half-life", () => {
    expect(stepToward(0, 100, 60, 60)).toBe(50);
    expect(stepToward(100, 0, 60, 60)).toBe(50);
  });

  test("is stable across equivalent time subdivisions", () => {
    const oneStep = stepToward(0, 100, 80, 80);
    const twoSteps = stepToward(stepToward(0, 100, 40, 80), 100, 40, 80);
    expect(twoSteps).toBeCloseTo(oneStep, 10);
  });

  test("snaps differences below half a scene unit", () => {
    expect(stepToward(9.6, 10, 1, 80)).toBe(10);
    expect(stepToward(9.5, 10, 0, 80)).toBe(9.5);
  });

  test("a caller in unit-square space eases where the scene default would snap", () => {
    // 0.2 apart is a fifth of a view root, yet under the default half-a-pixel epsilon.
    expect(stepToward(0.2, 0.4, 60, 60)).toBe(0.4);
    expect(stepToward(0.2, 0.4, 60, 60, FRACTION_SNAP_EPSILON)).toBeCloseTo(0.3, 10);
    // And it still terminates once the remainder is invisible.
    expect(stepToward(0.2, 0.2004, 60, 60, FRACTION_SNAP_EPSILON)).toBe(0.2004);
  });
});
