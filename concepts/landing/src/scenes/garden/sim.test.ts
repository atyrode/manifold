import { expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { gardenScene } from "./index.ts";
import { GARDEN_ISLANDS } from "./sim.ts";

// The garden's drying clock goes to the shader in uSim1 (the texel after the islands): fresh gravel's
// damp fades with `clock - when raked`. These run the sim on the headless stand-in and read it there;
// `knobs` are as in the URL (a feature: 1 for on, and `<key>-amount`).

function dryingClock(knobs: Record<string, number>, seconds: number): number {
  const sim = new HeadlessSim(gardenScene);
  for (let n = 0; n < seconds * 60; n++) sim.step({ knobs, pointer: { inside: false } });
  // uSim1: 2 × GARDEN_ISLANDS by 1 + GARDEN_STONES rgba16f texels.
  const clock = sim.upload(1).data[GARDEN_ISLANDS * 4] ?? Number.NaN;
  sim.dispose();
  return clock;
}

test("by default fresh gravel dries on garden time, whatever the weather", () => {
  expect(dryingClock({}, 4)).toBeCloseTo(4, 3);
  expect(dryingClock({ rain: 1, "rain-amount": 0.7, time: 0 }, 4)).toBeCloseTo(4, 3);
});

test("drying with the weather: rain stops it, the night slows it, more weathering hurries it", () => {
  const on = { drying: 1, "drying-amount": 0.5, wind: 0 };
  expect(dryingClock({ ...on, rain: 1, "rain-amount": 0.7 }, 3)).toBe(0);
  const noon = dryingClock({ ...on, time: 0.5 }, 3);
  // A still midday at the weathering knob's default dries at the garden's own pace.
  expect(noon).toBeCloseTo(3, 3);
  expect(dryingClock({ ...on, time: 0 }, 3)).toBeLessThan(0.5 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 1 }, 3)).toBeGreaterThan(2 * noon);
  expect(dryingClock({ ...on, time: 0.5, soften: 0 }, 3)).toBeLessThan(0.5 * noon);
});
