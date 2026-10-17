import { describe, expect, test } from "bun:test";
import { YEAR_CYCLE_RATE } from "./climate.ts";
import { feature, range, type ParamDef } from "./params.ts";
import { MAX_PHASES, phaseDefines, RatePhases, ratedKnobs, rateOf } from "./rate-phase.ts";
import { sceneDefs } from "./scenes/index.ts";
import { DAY_CYCLE_RATE } from "./world-clock.ts";

const STEP = 1 / 60;

/** A drift (a speed), a swing's length (a period) and a day cycle that switches. */
const day = feature("sky", "day", "day cycle", false, "speed", 0.3, "help", {
  rate: DAY_CYCLE_RATE,
});
const params: readonly ParamDef[] = [
  range("sky", "time", "time", 0.5, "help"),
  range("sky", "drift", "drift", 0.5, "help", { rate: { per: 1 } }),
  range("wave", "cycle", "cycle", 100, "help", {
    min: 40,
    max: 240,
    rate: { per: 1, inverse: true },
  }),
  day,
];

/** The phases by key after `frames` frames of STEP with the knobs at `values`. */
function run(
  phases: RatePhases,
  values: readonly number[],
  frames: number,
): Record<string, number> {
  for (let i = 0; i < frames; i++) phases.step(values, STEP);
  return { ...phases.byKey };
}

describe("a rate knob's phase", () => {
  test("carries on from where it stands when the knob is turned mid-run: no jump", () => {
    const phases = new RatePhases(params);
    const before = run(phases, [0.5, 0.5, 100, 0.3], 600);
    const turned = run(phases, [0.5, 1, 60, 1], 1);
    // The frame the knobs moved on adds one frame at the new pace, not ten seconds' worth of the
    // difference, as `knob × the motion clock` would.
    expect((turned["drift"] ?? 0) - (before["drift"] ?? 0)).toBeCloseTo(1 * STEP, 12);
    expect((turned["cycle"] ?? 0) - (before["cycle"] ?? 0)).toBeCloseTo(STEP / 60, 12);
    expect((turned["day"] ?? 0) - (before["day"] ?? 0)).toBeCloseTo((1 * STEP) / 240, 12);
    // And the whole run is the sum of its two paces.
    const end = run(phases, [0.5, 1, 60, 1], 599);
    expect(end["drift"]).toBeCloseTo(0.5 * 10 + 1 * 10, 9);
    expect(end["cycle"]).toBeCloseTo(10 / 100 + 10 / 60, 9);
    expect(end["day"]).toBeCloseTo((0.3 * 10 + 1 * 10) / 240, 9);
    // The shader reads the same phases.
    expect(phases.upload[0]).toBe(Math.fround(end["drift"] ?? Number.NaN));
  });

  test("of a feature stands at 0 while it is off and starts there as it is switched on", () => {
    const phases = new RatePhases(params);
    expect(run(phases, [0.5, 0.5, 100, 0.3], 120)["day"]).toBeGreaterThan(0);
    expect(run(phases, [0.5, 0.5, 100, 0], 1)["day"]).toBe(0);
    expect(run(phases, [0.5, 0.5, 100, 0.3], 1)["day"]).toBeCloseTo((0.3 * STEP) / 240, 15);
  });

  test("wraps at its period and stands still while the motion clock does", () => {
    const spin = new RatePhases([
      range("s", "spin", "spin", 1, "help", { rate: { per: 1, period: 1 } }),
    ]);
    for (let i = 0; i < 150; i++) {
      spin.step([1], STEP);
      expect(spin.byKey["spin"]).toBeGreaterThanOrEqual(0);
      expect(spin.byKey["spin"]).toBeLessThan(1);
    }
    expect(spin.byKey["spin"]).toBeCloseTo(0.5, 9);
    spin.step([1], 0);
    expect(spin.byKey["spin"]).toBeCloseTo(0.5, 9);
    // A period at or below 0 runs nothing, rather than infinitely fast.
    expect(rateOf({ per: 1, inverse: true }, 0)).toBe(0);
  });

  test("goes on where another scene's stood for the same knob", () => {
    const from = new RatePhases(params);
    run(from, [0.5, 0.5, 100, 0.3], 60);
    const next = new RatePhases([day]);
    next.adopt(from);
    expect(next.byKey["day"]).toBe(from.byKey["day"]);
    expect(next.upload[0]).toBe(from.upload[2]);
  });
});

describe("every scene's rate knobs", () => {
  test("fit the shader's row, and its day and year cycles run at the world clock's rates", () => {
    const wrong: string[] = [];
    for (const scene of Object.values(sceneDefs)) {
      expect(ratedKnobs(scene.params).length).toBeLessThanOrEqual(MAX_PHASES);
      for (const def of scene.params) {
        if (def.widget?.kind !== "sky") continue;
        if (def.widget.part === "cycle" && def.rate !== DAY_CYCLE_RATE)
          wrong.push(`${scene.id} ${def.key}`);
        if (def.widget.part === "year" && def.rate !== YEAR_CYCLE_RATE)
          wrong.push(`${scene.id} ${def.key}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("are what the scenes' shaders read as phases", () => {
    const missing: string[] = [];
    for (const scene of Object.values(sceneDefs)) {
      const defined = phaseDefines(scene);
      for (const [, key] of scene.glsl.matchAll(/\bPHASE_([A-Za-z0-9]+)/g))
        if (!defined.includes(`#define PHASE_${key} `)) missing.push(`${scene.id} PHASE_${key}`);
    }
    expect(missing).toEqual([]);
  });
});
