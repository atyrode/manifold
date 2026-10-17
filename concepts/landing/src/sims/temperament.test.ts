import { expect, test } from "bun:test";
import { atEase, facing, isShy, SHY_TIMING, stepShrink } from "./temperament.ts";

test("shyness is a monotone share: raising it only turns more creatures shy", () => {
  const traits = Array.from({ length: 200 }, (_, i) => (i * 0.61803398875) % 1);
  let previous = new Set<number>();
  for (const shyness of [0, 0.25, 0.5, 0.75, 1]) {
    const shy = new Set(traits.flatMap((trait, i) => (isShy(trait, shyness) ? [i] : [])));
    for (const i of previous) expect(shy.has(i)).toBe(true);
    expect(Math.abs(shy.size / traits.length - shyness)).toBeLessThan(0.02);
    previous = shy;
  }
});

test("curious creatures face the pointer, shy ones face away", () => {
  expect(facing(0.05, 0.1, false)).toBeCloseTo(0.5);
  expect(facing(0.05, 0.1, true)).toBeCloseTo(-0.5);
  expect(facing(-1, 0.1, false)).toBe(-1);
  expect(facing(-1, 0.1, true)).toBe(1);
});

test("a startled creature shrinks away quickly and only comes back out after the calm wait", () => {
  const state = atEase();
  const h = 1 / 60;
  for (let t = 0; t < 4 * SHY_TIMING.hide; t += h) stepShrink(state, h, true);
  expect(state.amount).toBeGreaterThan(0.95);
  expect(state.calm).toBe(0);

  // Still shrunk while the calm wait runs, even though nothing startles it any more.
  for (let t = h; t < SHY_TIMING.wait - 0.1; t += h) stepShrink(state, h, false);
  expect(state.amount).toBeGreaterThan(0.95);

  // Then out again, slowly.
  for (let t = 0; t < 0.1 + SHY_TIMING.recover; t += h) stepShrink(state, h, false);
  expect(state.amount).toBeLessThan(0.6);
  expect(state.amount).toBeGreaterThan(0.2);
  for (let t = 0; t < 6 * SHY_TIMING.recover; t += h) stepShrink(state, h, false);
  expect(state.amount).toBeLessThan(0.01);
});

test("a paused step changes nothing", () => {
  const state = atEase();
  stepShrink(state, 0, true);
  expect(state).toEqual(atEase());
});
