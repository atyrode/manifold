import { describe, expect, test } from "bun:test";
import { climateCold, seasonKnob, yearAt } from "../../climate.ts";
import { sceneFeatures, sceneFeaturesAll, shaderValues } from "../../shaders/index.ts";
import { countryScene } from "./index.ts";
import { COUNTRY_BALES, COUNTRY_SEASONS } from "./constants.ts";
import { valleyLayer } from "./layers.ts";

/** The countryside's compile-time features for raw knobs over its defaults. */
const features = (knobs: Record<string, number>) =>
  sceneFeatures(countryScene, shaderValues(countryScene, knobs));

describe("the countryside's year", () => {
  test("its date is the composer's season, keyed at the old season choice's dates", () => {
    const date = seasonKnob(countryScene.params);
    if (!date) throw new Error("no season knob");
    expect(date.key).toBe("season");
    for (const key of Object.values(COUNTRY_SEASONS)) expect(yearAt(date, key)).toBe(key);
    expect(date.value).toBe(COUNTRY_SEASONS.harvest);
  });

  test("the bales are compiled in only while the date lies in their stretch, or the year passes", () => {
    expect(features({}).COUNTRY_HAS_BALES).toBe(1);
    expect(features({ season: COUNTRY_SEASONS.summer }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ season: COUNTRY_SEASONS.autumn }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ season: COUNTRY_BALES[0] }).COUNTRY_HAS_BALES).toBe(1);
    expect(features({ season: COUNTRY_BALES[1] }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ season: 0.9, year: 1 }).COUNTRY_HAS_BALES).toBe(1);
    // Not without crops to bale, nor with the farmland off.
    expect(features({ crops: 0 }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ farmland: 0 }).COUNTRY_HAS_BALES).toBe(0);
  });

  test("the season sets the World's climate: rain compiles the snowfall in, whatever the date", () => {
    const rain = { rain: 1, "rain-amount": 0.7 };
    expect(climateCold(0.875)).toBe(1);
    for (const season of [COUNTRY_SEASONS.summer, 0.75, 0.875])
      expect(features({ ...rain, season })).toMatchObject({ WORLD_RAIN: 1, WORLD_SNOW: 1 });
    // Winter's own lying snow needs no snowfall compiled in: it is uWeather.y's.
    expect(features({ season: 0.875 })).toMatchObject({ WORLD_RAIN: 0, WORLD_SNOW: 0 });
    // The snow switch falls whatever the season.
    expect(features({ snow: 1, season: COUNTRY_SEASONS.summer }).WORLD_SNOW).toBe(1);
  });

  test("the all-features program covers every date and the passing year", () => {
    const all = sceneFeaturesAll(countryScene) ?? {};
    expect(all).toMatchObject(valleyLayer.featuresAll ?? {});
    for (let season = 0; season < 1; season += 0.005)
      for (const knobs of [{ season }, { season, rain: 1 }, { season, year: 1, snow: 1 }])
        for (const [name, value] of Object.entries(features(knobs)))
          expect(all[name] ?? -Infinity).toBeGreaterThanOrEqual(value);
  });
});
