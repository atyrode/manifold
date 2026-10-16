import { describe, expect, test } from "bun:test";
import {
  climateCold,
  climateLying,
  WINTER_COVER,
  fallingRain,
  fallingSnow,
  hasClimate,
  seasonKnob,
  yearAt,
  yearNow,
} from "./climate.ts";
import { yearOf } from "./lab/almanac-model.ts";
import { effective } from "./params.ts";
import { sceneDefs } from "./scenes/index.ts";

describe("a scene's year position", () => {
  test("is the one the lab reads from the same knob, for every value of every season knob", () => {
    for (const scene of Object.values(sceneDefs)) {
      const def = seasonKnob(scene.params);
      if (!def) continue;
      const samples: Record<string, number>[] =
        def.kind === "choice"
          ? def.options.map((option) => ({ [def.key]: option.value }))
          : def.kind === "feature"
            ? [
                { [def.key]: 0 },
                ...[0, 0.25, 0.5, 1].map((t) => ({
                  [def.key]: 1,
                  [`${def.key}-amount`]: def.min + t * (def.max - def.min),
                })),
              ]
            : def.kind === "range"
              ? [0, 0.3, 0.7, 1].map((t) => ({ [def.key]: def.min + t * (def.max - def.min) }))
              : [];
      for (const params of samples) {
        const lab = yearOf(def, params);
        const shader = yearAt(def, effective(def, params));
        expect(shader).toBeCloseTo(lab ?? -1, 9);
      }
    }
  });

  test("goes round the whole year at the cycle's minutes per season, and stands while it is off", () => {
    expect(yearNow(0.5, 1, 60)).toBeCloseTo(0.75, 9);
    expect(yearNow(0.5, 2, 240)).toBeCloseTo(0, 9);
    expect(yearNow(0.5, 0, 999)).toBe(0.5);
    expect(yearNow(-1, 1, 60)).toBe(-1);
  });
});

describe("the climate", () => {
  test("is warm from mid-spring to mid-autumn and coldest at midwinter", () => {
    for (const year of [0.125, 0.375, 0.47, 0.6, 0.625]) expect(climateCold(year)).toBe(0);
    expect(climateCold(0.875)).toBe(1);
    expect(climateCold(0.75)).toBeGreaterThan(0);
    expect(climateCold(0.75)).toBeLessThan(1);
    expect(climateCold(0.99)).toBeCloseTo(climateCold(0.76), 9);
    expect(climateCold(-1)).toBe(0);
  });

  test("turns rain to snow as it grows cold, and leaves the snow switch's own snow falling", () => {
    expect([fallingRain(0.6, 0), fallingSnow(0.6, 0, 0)]).toEqual([0.6, 0]);
    expect([fallingRain(0.6, 1), fallingSnow(0.6, 0, 1)]).toEqual([0, 0.6]);
    expect([fallingRain(0, 0), fallingSnow(0, 0.4, 0)]).toEqual([0, 0.4]);
    expect(fallingRain(0.6, 0.5) + fallingSnow(0.6, 0, 0.5)).toBeCloseTo(0.6, 9);
  });

  test("lays snow of its own only in deep winter", () => {
    expect(climateLying(climateCold(0.625))).toBe(0);
    expect(climateLying(climateCold(0.875))).toBe(WINTER_COVER);
  });

  test("leaves every scene it applies to warm at its defaults, so no default picture changes", () => {
    const climates = Object.values(sceneDefs).filter((scene) => hasClimate(scene.params));
    expect(climates.length).toBeGreaterThan(0);
    for (const scene of climates) {
      const def = seasonKnob(scene.params);
      if (!def) throw new Error(`${scene.id} has no season knob`);
      const defaults = Object.fromEntries(scene.params.map((d) => [d.key, effective(d, {})]));
      expect(climateCold(yearAt(def, defaults[def.key] ?? 0))).toBe(0);
    }
  });
});
