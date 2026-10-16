import { describe, expect, test } from "bun:test";
import {
  choice,
  counts,
  feature,
  MAX_SEED,
  range,
  seed,
  toggle,
  type ParamDef,
} from "../params.ts";
import { sceneDefs, sceneIds } from "../scenes/index.ts";
import { rollPatch, type Random } from "./roll-model.ts";

const defs: ParamDef[] = [
  range("view", "planetX", "across", 0.5, "help", { steady: true }),
  range("sky", "stars", "stars", 0.6, "help", { min: 0.2, max: 0.9, step: 0.1 }),
  toggle("sky", "lights", "lights", true, "help"),
  choice("view", "camera", "camera", counts(0, 1, 2), 1, "help"),
  seed("dunes", "dunes", "dunes", "help"),
  feature("weather", "rain", "rain", false, "amount", 0.5, "help"),
  feature("flock", "flight", "flight", true, "birds", 8, "help", { options: counts(4, 8, 16) }),
];

const always =
  (value: number): Random =>
  () =>
    value;

/** mulberry32: a repeatable sequence. */
function random(seedValue: number): Random {
  let a = seedValue;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a roll", () => {
  test("leaves steady knobs alone and gives every other knob a value of its kind", () => {
    const next = random(1082);
    for (let round = 0; round < 200; round++) {
      const patch = rollPatch(defs, next);
      expect(Object.keys(patch).sort()).toEqual(
        [
          "stars",
          "lights",
          "camera",
          "dunes",
          "rain",
          "rain-amount",
          "flight",
          "flight-amount",
        ].sort(),
      );
      const stars = patch.stars ?? Number.NaN;
      expect(stars).toBeGreaterThanOrEqual(0.2);
      expect(stars).toBeLessThanOrEqual(0.9);
      expect(Math.abs(stars * 10 - Math.round(stars * 10))).toBeLessThan(1e-9);
      expect([0, 1]).toContain(patch.lights ?? Number.NaN);
      expect([0, 1, 2]).toContain(patch.camera ?? Number.NaN);
      expect(Number.isInteger(patch.dunes)).toBe(true);
      expect([0, 1]).toContain(patch.rain ?? Number.NaN);
      const rain = patch["rain-amount"] ?? Number.NaN;
      expect(rain).toBeGreaterThanOrEqual(0.05);
      expect(rain).toBeLessThanOrEqual(1);
      expect([4, 8, 16]).toContain(patch["flight-amount"] ?? Number.NaN);
    }
  });

  test("reaches both ends of every knob", () => {
    expect(rollPatch(defs, always(0))).toEqual({
      stars: 0.2,
      lights: 1,
      camera: 0,
      dunes: 0,
      rain: 1,
      "rain-amount": 0.05,
      flight: 1,
      "flight-amount": 4,
    });
    expect(rollPatch(defs, always(1 - 1e-9))).toEqual({
      stars: 0.9,
      lights: 0,
      camera: 2,
      dunes: MAX_SEED,
      rain: 0,
      "rain-amount": 1,
      flight: 0,
      "flight-amount": 16,
    });
  });

  test("switches a toggle on below 0.45 of its draw and a feature below 0.55", () => {
    const [toggled, featured] = [defs[2], defs[5]];
    if (!toggled || !featured) throw new Error("no switches");
    expect(rollPatch([toggled], always(0.449)).lights).toBe(1);
    expect(rollPatch([toggled], always(0.45)).lights).toBe(0);
    expect(rollPatch([featured], always(0.549)).rain).toBe(1);
    expect(rollPatch([featured], always(0.55)).rain).toBe(0);
  });
});

/** The transport's shuffle as lab.ts wrote it before the rule moved here, transcribed. */
function shuffleBefore(params: readonly ParamDef[], next: Random): Record<string, number> {
  const patch: Record<string, number> = {};
  const pickOne = <T>(list: readonly T[]): T | undefined => list[Math.floor(next() * list.length)];
  const within = (min: number, max: number, step: number) =>
    Math.round((min + next() * (max - min)) / step) * step;
  for (const def of params) {
    if (def.steady) continue;
    switch (def.kind) {
      case "range":
        patch[def.key] = Number(within(def.min, def.max, def.step).toFixed(4));
        break;
      case "toggle":
        patch[def.key] = next() < 0.45 ? 1 : 0;
        break;
      case "choice":
        patch[def.key] = pickOne(def.options)?.value ?? def.value;
        break;
      case "seed":
        patch[def.key] = Math.floor(next() * (MAX_SEED + 1));
        break;
      case "feature":
        patch[def.key] = next() < 0.55 ? 1 : 0;
        patch[`${def.key}-amount`] = def.options
          ? (pickOne(def.options)?.value ?? def.value)
          : Number(within(def.min, def.max, def.step).toFixed(4));
        break;
      default: {
        const unreachable: never = def;
        throw new Error(`unknown knob ${String(unreachable)}`);
      }
    }
  }
  return patch;
}

test("the transport's shuffle of every scene rolls exactly as it did before", () => {
  for (const [index, id] of sceneIds.entries()) {
    const params = sceneDefs[id].params;
    expect(rollPatch(params, random(1082 + index))).toEqual(
      shuffleBefore(params, random(1082 + index)),
    );
  }
});
