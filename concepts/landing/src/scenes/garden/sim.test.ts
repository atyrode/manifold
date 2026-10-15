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

// uSim2: 4 × GARDEN_LEAF_SLOTS rgba16f, a row per leaf: (x, y, z, alpha), (chord axis, radius),
// (span axis, kind), (hue, age on the ground 0..1, landed 0..1, 0); alpha 0: no leaf.
interface Leaf {
  x: number;
  chordUp: number;
  spanUp: number;
  hue: number;
  age: number;
  landed: boolean;
}

function leaves(sim: HeadlessSim): Leaf[] {
  const data = sim.upload(2).data;
  const out: Leaf[] = [];
  for (let o = 0; o + 16 <= data.length; o += 16) {
    if (!((data[o + 3] ?? 0) > 0)) continue;
    out.push({ x: data[o] ?? 0, chordUp: data[o + 6] ?? 0, spanUp: data[o + 10] ?? 0, hue: data[o + 12] ?? 0, age: data[o + 13] ?? 0, landed: data[o + 14] === 1 });
  }
  return out;
}

test("leaves lying on the gravel lie flat, face up or face down", () => {
  const sim = new HeadlessSim(gardenScene);
  // Long enough down to have settled (age is the share of a life of at least 45 s).
  const settled = leaves(sim.step({ pointer: { inside: false } })).filter((leaf) => leaf.landed && leaf.age > 0.02);
  sim.dispose();
  expect(settled.length).toBeGreaterThanOrEqual(5);
  // Within the few degrees a leaf rests off flat (its rest pitch is within ±0.07 rad).
  for (const leaf of settled) {
    expect(Math.abs(leaf.chordUp)).toBeLessThan(0.0701);
    expect(Math.abs(leaf.spanUp)).toBeLessThan(0.0701);
  }
});

test("a 'now' gust blows the leaves lying on the gravel the way the wind is set", () => {
  // The same garden with and without the gust: each leaf lying there from the start (known by its
  // hue) ends up downwind of where it lies in the calm garden.
  const drift = (wind: number): number[] => {
    const calm = new HeadlessSim(gardenScene);
    const blown = new HeadlessSim(gardenScene);
    const knobs = { wind, leaves: 0 };
    const lying = leaves(calm.step({ knobs, pointer: { inside: false } })).filter((leaf) => leaf.landed).map((leaf) => leaf.hue);
    blown.step({ knobs, pointer: { inside: false } });
    for (let n = 1; n < 3 * 60; n++) {
      calm.step({ knobs, pointer: { inside: false } });
      blown.step({ knobs, pointer: { inside: false }, now: n === 1 ? ["leaves"] : [] });
    }
    const still = leaves(calm);
    const moved = leaves(blown);
    calm.dispose();
    blown.dispose();
    return lying.flatMap((hue) => {
      const a = still.find((leaf) => leaf.hue === hue);
      const b = moved.find((leaf) => leaf.hue === hue);
      return a && b ? [b.x - a.x] : [];
    });
  };
  const left = drift(-0.7);
  expect(left.length).toBeGreaterThanOrEqual(5);
  for (const dx of left) expect(dx).toBeLessThan(0);
  const right = drift(0.7);
  expect(right.length).toBeGreaterThanOrEqual(5);
  for (const dx of right) expect(dx).toBeGreaterThan(0);
});
