import { expect, test } from "bun:test";
import { TrailField } from "./trail.ts";

const ASPECT = 16 / 9;
/** A 128 × 72 field, as kelp's; ROW_Y is the middle of a row of texels. */
const W = 128;
const H = 72;
const ROW_Y = (36 + 0.5) / H;

/** The most each texel of the middle column held while a pointer swept across at `speed` frame heights a second. */
function sweep(hz: number, speed: number, strength: number, halfLife: number): number {
  const trail = new TrailField(W, H);
  const dt = 1 / hz;
  const at = Math.floor(H / 2) * W + W / 2;
  let most = 0;
  for (let x = 0.1; x < 0.9; x += (speed / ASPECT) * dt) {
    trail.stroke(x, ROW_Y, 0.035, strength, ASPECT);
    if (halfLife > 0) trail.decay(dt, halfLife);
    most = Math.max(most, (trail.data[at] ?? 0) / 255);
  }
  return most;
}

test("a sweep leaves the same mark at 60 and 144 Hz, slow or fast", () => {
  for (const speed of [0.2, 1, 3]) {
    for (const strength of [0.3, 0.5]) {
      expect(
        Math.abs(sweep(60, speed, strength, 1.4) - sweep(144, speed, strength, 1.4)),
      ).toBeLessThan(0.02);
    }
  }
});

test("a pass leaves its strength along its middle, however fast it went", () => {
  for (const [hz, speed] of [
    [60, 0.2],
    [60, 3],
    [144, 3],
  ] as const) {
    expect(Math.abs(sweep(hz, speed, 0.5, 0) - 0.5)).toBeLessThan(0.025);
  }
});

test("held still, a hold lays the same at 60 and 144 Hz; a stroke lays nothing", () => {
  const held = (hz: number): number => {
    const trail = new TrailField(W, H);
    for (let t = 0; t < 0.25 - 1e-9; t += 1 / hz) {
      trail.stroke(0.5 + 0.5 / W, ROW_Y, 0.035, 0.5, ASPECT);
      trail.hold(0.5 + 0.5 / W, ROW_Y, 0.035, 2 / hz, ASPECT);
    }
    return (trail.data[36 * W + W / 2] ?? 0) / 255;
  };
  expect(held(60)).toBeCloseTo(0.5, 2);
  expect(held(144)).toBeCloseTo(0.5, 2);
  const still = new TrailField(W, H);
  for (let f = 0; f < 30; f++) still.stroke(0.5, ROW_Y, 0.035, 0.5, ASPECT);
  expect(still.data.every((v) => v === 0)).toBe(true);
});

test("a lifted stroke starts afresh where it is put down, not joined to where it was lifted", () => {
  const trail = new TrailField(W, H);
  trail.stroke(0.2, ROW_Y, 0.035, 0.5, ASPECT);
  trail.stroke(0.25, ROW_Y, 0.035, 0.5, ASPECT);
  trail.lift();
  trail.stroke(0.7, ROW_Y, 0.035, 0.5, ASPECT);
  trail.stroke(0.75, ROW_Y, 0.035, 0.5, ASPECT);
  const at = (x: number): number => trail.data[36 * W + Math.floor(x * W)] ?? 0;
  expect(at(0.225)).toBeGreaterThan(0);
  expect(at(0.725)).toBeGreaterThan(0);
  // Nothing between where it was lifted and where it went down again.
  expect(at(0.5)).toBe(0);
});
