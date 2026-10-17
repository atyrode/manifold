import { describe, expect, test } from "bun:test";
import { HeadlessSim } from "../../sims/headless.ts";
import { beesScene } from "./index.ts";
import { BEES_CODE } from "./layout.ts";

/** Everything off but what a test is about. */
const QUIET = {
  bees: 0,
  butterflies: 0,
  bumblebees: 0,
  hoverflies: 0,
  dragonflies: 0,
  glowworms: 0,
  fireflies: 0,
};
const GLOWWORM_CODES: readonly number[] = [BEES_CODE.glowworm, BEES_CODE.glowwormGlow];
const FIREFLY_CODES: readonly number[] = [BEES_CODE.firefly, BEES_CODE.fireflyGlow];

/** The fewest and the most cells holding one of `codes` at any tenth of a second over the next `seconds`, in frames 270 cells high. */
function census(
  sim: HeadlessSim,
  knobs: Readonly<Record<string, number>>,
  seconds: number,
  codes: readonly number[],
): { least: number; most: number } {
  let least = Number.POSITIVE_INFINITY;
  let most = 0;
  for (let f = 0; f < seconds * 60; f++) {
    sim.step({ knobs, height: 270 });
    if (f % 6 !== 0) continue;
    const { data } = sim.upload(0);
    let n = 0;
    for (let at = 0; at < data.length; at += 2) if (codes.includes(data[at] ?? 0)) n++;
    least = Math.min(least, n);
    most = Math.max(most, n);
  }
  return { least, most };
}

describe("glow-worms", () => {
  test("glow a steady green in the grass at night, and none by day", () => {
    const at = (time: number): { least: number; most: number } => {
      const sim = new HeadlessSim(beesScene);
      const seen = census(sim, { ...QUIET, glowworms: 1, time }, 6, GLOWWORM_CODES);
      sim.dispose();
      return seen;
    };
    expect(at(0.64).most).toBe(0);
    const night = at(0.9);
    expect(night.least).toBeGreaterThan(5);
    // Steady: no blinking, the same lights all the while.
    expect(night.most).toBe(night.least);
  });

  test("go dark in the rain and light up again once it is dry", () => {
    const sim = new HeadlessSim(beesScene);
    const dry = { ...QUIET, glowworms: 1, time: 0.9 };
    const wet = { ...dry, rain: 1, "rain-amount": 0.4 };
    expect(census(sim, dry, 2, GLOWWORM_CODES).least).toBeGreaterThan(5);
    census(sim, wet, 20, GLOWWORM_CODES);
    expect(census(sim, wet, 5, GLOWWORM_CODES).most).toBe(0);
    census(sim, dry, 20, GLOWWORM_CODES);
    expect(census(sim, dry, 5, GLOWWORM_CODES).least).toBeGreaterThan(5);
    sim.dispose();
  }, 30_000);
});

describe("fireflies", () => {
  test("sink into the grass in the rain and rise again once it is dry", () => {
    const sim = new HeadlessSim(beesScene);
    const dry = { ...QUIET, fireflies: 1, time: 0.9 };
    const wet = { ...dry, rain: 1, "rain-amount": 0.4 };
    expect(census(sim, dry, 10, FIREFLY_CODES).most).toBeGreaterThan(3);
    census(sim, wet, 20, FIREFLY_CODES);
    expect(census(sim, wet, 10, FIREFLY_CODES).most).toBe(0);
    census(sim, dry, 20, FIREFLY_CODES);
    expect(census(sim, dry, 10, FIREFLY_CODES).most).toBeGreaterThan(3);
    sim.dispose();
  }, 30_000);
});
