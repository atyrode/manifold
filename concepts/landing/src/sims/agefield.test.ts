import { expect, test } from "bun:test";
import { DAY_SECONDS, skyNow } from "../world-clock.ts";
import { AGE_REBASE, AgeField, dryingPace } from "./agefield.ts";
import type { DataTexture } from "./texture.ts";

/** Age of the cell holding (x, y) in a field over 0..width × 0..height. */
function ageAt(field: AgeField, width: number, height: number, x: number, y: number): number {
  const i = Math.floor((x / width) * field.cols);
  const j = Math.floor((y / height) * field.rows);
  return field.clock - (field.data[j * field.cols + i] ?? 0);
}

test("a stamp marks the cells along a stroke as disturbed now, and they age with the clock", () => {
  const field = new AgeField(40, 20, 2, 1);
  field.advance(10);
  field.stamp(0.2, 0.5, 1.8, 0.5, 0.06);
  field.advance(7);
  expect(ageAt(field, 2, 1, 1.0, 0.5)).toBe(7);
  expect(ageAt(field, 2, 1, 0.21, 0.52)).toBe(7);
  // Off the stroke, and before it began: long ago.
  expect(ageAt(field, 2, 1, 1.0, 0.8)).toBeGreaterThanOrEqual(AGE_REBASE);
  expect(ageAt(field, 2, 1, 0.05, 0.5)).toBeGreaterThanOrEqual(AGE_REBASE);
});

test("winding the clock back keeps every age, and reset forgets every stamp", () => {
  const field = new AgeField(8, 8, 1, 1);
  field.advance(2 * AGE_REBASE - 50);
  field.stamp(0.5, 0.5, 0.5, 0.5, 0.2);
  field.advance(100);
  expect(field.clock).toBeLessThan(2 * AGE_REBASE);
  expect(ageAt(field, 1, 1, 0.5, 0.5)).toBe(100);
  expect(ageAt(field, 1, 1, 0.05, 0.05)).toBeGreaterThanOrEqual(AGE_REBASE);
  field.reset();
  expect(field.clock).toBe(0);
  expect(ageAt(field, 1, 1, 0.5, 0.5)).toBeGreaterThanOrEqual(AGE_REBASE);
});

test("uploads go out only after a stamp, a rebase or a reset", () => {
  const field = new AgeField(4, 4, 1, 1);
  let sent = 0;
  const texture = { upload: () => sent++ } as unknown as DataTexture;
  expect(field.upload(texture)).toBe(true);
  field.advance(5);
  expect(field.upload(texture)).toBe(false);
  field.stamp(0.5, 0.5, 0.6, 0.5, 0.1);
  expect(field.upload(texture)).toBe(true);
  expect(sent).toBe(2);
});

test("damp dries fastest in a still midday sun, slower at dusk and night, faster in wind, not in rain", () => {
  const at = (time: number) => skyNow({ time, cycle: 0, motionTime: 0 });
  const noon = dryingPace(at(0.5), 0, 0);
  expect(noon).toBeCloseTo(1, 6);
  expect(dryingPace(at(0.735), 0, 0)).toBeLessThan(noon);
  expect(dryingPace(at(0.0), 0, 0)).toBeLessThan(dryingPace(at(0.735), 0, 0));
  expect(dryingPace(at(0.0), 0, 0)).toBeGreaterThan(0);
  expect(dryingPace(at(0.5), -0.6, 0)).toBeGreaterThan(noon);
  expect(dryingPace(at(0.5), 0.6, 0)).toBeCloseTo(dryingPace(at(0.5), -0.6, 0), 9);
  expect(dryingPace(at(0.5), 0, 0.4)).toBe(0);
  // The day cycle carries the hour on: a whole day later it dries as it did.
  const later = skyNow({ time: 0.5, cycle: 1, motionTime: DAY_SECONDS });
  expect(dryingPace(later, 0.3, 0)).toBeCloseTo(dryingPace(at(0.5), 0.3, 0), 9);
  // A dated sky's summer sun stands higher than its winter's, and dries faster.
  const dated = (year: number) => skyNow({ time: 0.5, cycle: 0, motionTime: 0, year, anchor: 0.6 });
  expect(dryingPace(dated(0.25), 0, 0)).toBeGreaterThan(dryingPace(dated(0.75), 0, 0));
});
