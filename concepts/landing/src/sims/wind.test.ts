import { expect, test } from "bun:test";
import { GustTrain, gustPulse, windNoise } from "./wind.ts";
import { mulberry32 } from "./random.ts";

test("a gust rises to its peak at the rise time, dies away, and is gone outside (0, 12 rise)", () => {
  const rise = 1.6;
  expect(gustPulse(rise, rise)).toBeCloseTo(1, 12);
  for (const age of [-1, 0, 12 * rise, 13 * rise, Number.NaN]) expect(gustPulse(age, rise)).toBe(0);
  let last = 0;
  for (let k = 1; k <= 20; k++) {
    const value = gustPulse((k / 20) * rise, rise);
    expect(value).toBeGreaterThan(last);
    last = value;
  }
  for (let k = 1; k <= 40; k++) {
    const value = gustPulse(rise + (k / 40) * 10 * rise, rise);
    expect(value).toBeLessThan(last);
    last = value;
  }
  // Long before it is cut off at 12 rise, it has all but gone.
  expect(gustPulse(11.9 * rise, rise)).toBeLessThan(1e-6);
});

test("a gust train waits 0.6..1.4 of its mean between gusts, holds while off, and blows with the wind", () => {
  const mean = 30;
  const train = new GustTrain(mulberry32(7), 1.2, 5);
  // Off: the wait holds, however long.
  for (let s = 0; s < 600; s++) expect(train.step(0.1, Infinity, 0.3, 1)).toBe(false);
  expect(train.age).toBe(Infinity);
  // On: the first gust comes once the first wait has run out, then every 0.6..1.4 mean.
  const starts: number[] = [];
  let clock = 0;
  for (let s = 0; s < 20000; s++) {
    clock += 0.05;
    if (train.step(0.05, mean, -0.5, 0.8)) starts.push(clock);
  }
  expect(starts[0]).toBeGreaterThan(5 - 1e-9);
  expect(starts[0]).toBeLessThan(5.05 + 1e-9);
  expect(starts.length).toBeGreaterThan(20);
  for (let k = 1; k < starts.length; k++) {
    const gap = (starts[k] ?? 0) - (starts[k - 1] ?? 0);
    expect(gap).toBeGreaterThanOrEqual(0.6 * mean - 0.05);
    expect(gap).toBeLessThan(1.4 * mean + 0.05);
  }
  // It blows left with a wind set left, at its power, peaking `rise` after it began.
  train.start(-0.5, 0.8, mean);
  train.step(1.2, Infinity, -0.5, 0.8);
  expect(train.sign).toBe(-1);
  expect(train.strength()).toBeCloseTo(-0.8, 9);
  // A front reaching a point half a second later brings it there half a second behind.
  expect(train.strength(0.5)).toBeCloseTo(-0.8 * gustPulse(0.7, 1.2), 12);
  // "Now" with no wind blows right.
  train.start(0, 1, mean);
  expect(train.sign).toBe(1);
});

test("wind noise is smooth, bounded, the same for a salt and different between salts", () => {
  let maxStep = 0;
  let differs = 0;
  for (let k = 0; k < 4000; k++) {
    const t = k * 0.01 - 13;
    const value = windNoise(t, 3);
    expect(Math.abs(value)).toBeLessThanOrEqual(1);
    expect(windNoise(t, 3)).toBe(value);
    maxStep = Math.max(maxStep, Math.abs(windNoise(t + 0.01, 3) - value));
    if (Math.abs(windNoise(t, 4) - value) > 0.05) differs++;
  }
  // Eased between lattice values: a step of 0.01 moves it at most 1.5 · 2 · 0.01.
  expect(maxStep).toBeLessThan(0.031);
  expect(differs).toBeGreaterThan(2000);
});
