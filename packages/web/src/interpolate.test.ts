import { describe, expect, test } from "bun:test";
import { stepToward } from "./interpolate";

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
});
