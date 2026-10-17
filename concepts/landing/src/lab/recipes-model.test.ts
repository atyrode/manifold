import { describe, expect, test } from "bun:test";
import { choice, counts, feature, MAX_SEED, range, seed, type Recipe } from "../params.ts";
import { skyKnobs, skyRecipes, weatherKnobs, weatherRecipes } from "../scenes/atmosphere.ts";
import { sceneDefs } from "../scenes/index.ts";
import { recipeLit, recipePatch, shownRecipes, type Read } from "./recipes-model.ts";

const recipe = (set: Recipe["set"], needs?: readonly string[]): Recipe => ({
  label: "test",
  help: "test help",
  set,
  ...(needs === undefined ? {} : { needs }),
});

/** A sky, and weather with rain, wind and a cloud cover range. */
const outdoors = [
  ...skyKnobs({ time: 0.5 }),
  ...weatherKnobs({ clouds: 0.25, rain: true, wind: true }),
];
/** Cloud cover as a feature, as sill and train have it. */
const cloudSwitch = feature("sky", "clouds", "clouds", true, "cover", 0.35, "help");

const reader =
  (values: Record<string, number>): Read =>
  (key) =>
    values[key] ?? 0;

describe("which recipes a scene shows", () => {
  test("only where the scene has every key the recipe needs", () => {
    expect(recipePatch(recipe({ snow: 1, rain: 0 }, ["snow"]), outdoors)).toBeUndefined();
    expect(recipePatch(recipe({ rain: 1 }, ["rain", "wind"]), outdoors)).toEqual({ rain: 1 });
    expect(recipePatch(recipe({ rain: 1 }, ["rain-amount"]), outdoors)).toEqual({ rain: 1 });
  });

  test("only where it sets a key the scene has", () => {
    expect(
      recipePatch(recipe({ snow: 1, "snow-amount": 0.4, fog: 0.5 }), outdoors),
    ).toBeUndefined();
    const shown = shownRecipes(
      [recipe({ snow: 1 }), recipe({ rain: 0 }), recipe({ lightning: 1 }, [])],
      outdoors,
    );
    expect(shown.map(({ patch }) => patch)).toEqual([{ rain: 0 }]);
  });
});

describe("the patch a recipe makes", () => {
  test("takes the keys the scene has, from any of its groups, and drops the rest", () => {
    expect(recipePatch(recipe({ time: 0, rain: 0, snow: 0, fog: 0 }), outdoors)).toEqual({
      time: 0,
      rain: 0,
    });
  });

  test("turns a switch on for any value above zero, so a cover turns a cloud feature on", () => {
    const cover = recipe({ clouds: 0.3, "clouds-amount": 0.3 });
    expect(recipePatch(cover, [cloudSwitch])).toEqual({ clouds: 1, "clouds-amount": 0.3 });
    expect(recipePatch(cover, outdoors)).toEqual({ clouds: 0.3 });
    expect(recipePatch(recipe({ clouds: 0, "clouds-amount": 0.3 }), [cloudSwitch])).toEqual({
      clouds: 0,
    });
  });

  test("sets a feature's amount only beside the same recipe switching it on", () => {
    expect(recipePatch(recipe({ rain: 1, "rain-amount": 0.8 }), outdoors)).toEqual({
      rain: 1,
      "rain-amount": 0.8,
    });
    expect(recipePatch(recipe({ rain: 0, "rain-amount": 0.8 }), outdoors)).toEqual({ rain: 0 });
    expect(recipePatch(recipe({ "rain-amount": 0.8 }), outdoors)).toBeUndefined();
  });

  test("clamps and snaps values to their knob; a choice or segments take only their options", () => {
    const defs = [
      range("weather", "wind", "wind", 0.2, "help", { min: -1, max: 1 }),
      feature("weather", "rain", "rain", false, "amount", 0.5, "help"),
      feature("flock", "flight", "flight", true, "birds", 8, "help", { options: counts(4, 8) }),
      choice("sky", "kind", "kind", counts(0, 1), 0, "help"),
      seed("dunes", "dunes", "dunes", "help"),
    ];
    expect(recipePatch(recipe({ wind: 1.7, rain: 1, "rain-amount": 3 }), defs)).toEqual({
      wind: 1,
      rain: 1,
      "rain-amount": 1,
    });
    expect(recipePatch(recipe({ wind: 0.123, rain: 1, "rain-amount": 0 }), defs)).toEqual({
      wind: 0.1,
      rain: 1,
      "rain-amount": 0.05,
    });
    expect(recipePatch(recipe({ flight: 1, "flight-amount": 6, kind: 2 }), defs)).toEqual({
      flight: 1,
    });
    expect(recipePatch(recipe({ "flight-amount": 4, flight: 1, kind: 1 }), defs)).toEqual({
      "flight-amount": 4,
      flight: 1,
      kind: 1,
    });
    expect(recipePatch(recipe({ kind: 2 }), defs)).toBeUndefined();
    expect(recipePatch(recipe({ dunes: 1200 }), defs)).toEqual({ dunes: MAX_SEED });
    expect(recipePatch(recipe({ dunes: 12.6 }), defs)).toEqual({ dunes: 13 });
  });
});

describe("a lit recipe", () => {
  const storm = recipe({ clouds: 1, rain: 1, "rain-amount": 0.8, snow: 0 });
  const patch = recipePatch(storm, outdoors) ?? {};

  test("is lit while every key it takes holds its value", () => {
    expect(recipeLit(patch, reader({ clouds: 1, rain: 1, "rain-amount": 0.8, wind: -0.6 }))).toBe(
      true,
    );
    expect(recipeLit(patch, reader({ clouds: 0.95, rain: 1, "rain-amount": 0.8 }))).toBe(false);
  });

  test("counts a feature's amount only while the recipe has it on", () => {
    expect(recipeLit(patch, reader({ clouds: 1, rain: 1, "rain-amount": 0.5 }))).toBe(false);
    expect(recipeLit(patch, reader({ clouds: 1, rain: 0, "rain-amount": 0.8 }))).toBe(false);
    const dry = recipePatch(recipe({ rain: 0, "rain-amount": 0.8 }), outdoors) ?? {};
    expect(recipeLit(dry, reader({ rain: 0, "rain-amount": 0.3 }))).toBe(true);
  });
});

test("the shared recipes are written in their knobs' own values: a world scene takes each as is", () => {
  // A world scene has every key they set but a cloud feature's amount: its cover is a range.
  const defs = sceneDefs.meadow.params;
  for (const shared of [...skyRecipes, ...weatherRecipes]) {
    const written = Object.entries(shared.set).filter(([key]) => key !== "clouds-amount");
    expect({ label: shared.label, patch: recipePatch(shared, defs) }).toEqual({
      label: shared.label,
      patch: Object.fromEntries(written),
    });
  }
});
