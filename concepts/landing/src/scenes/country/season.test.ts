import { describe, expect, test } from "bun:test";
import { climateCold, seasonKnob, yearAt } from "../../climate.ts";
import { sceneFeatures, sceneFeaturesAll, shaderValues } from "../../shaders/index.ts";
import { PLANET_BODY_GATES_ALL } from "../../shaders/lib/planet.ts";
import { COUNTRY_ALL, countryScene } from "./index.ts";
import { COUNTRY_BALES, COUNTRY_SEASONS } from "./constants.ts";

/** The countryside's compile-time features for raw knobs over its defaults. */
const features = (knobs: Record<string, number>) =>
  sceneFeatures(countryScene, shaderValues(countryScene, knobs));

describe("the countryside's year", () => {
  test("its date is the almanac's season, keyed at the old season choice's dates", () => {
    const date = seasonKnob(countryScene.params);
    if (!date) throw new Error("no season knob");
    expect(date.key).toBe("date");
    for (const key of Object.values(COUNTRY_SEASONS)) expect(yearAt(date, key)).toBe(key);
    expect(date.value).toBe(COUNTRY_SEASONS.harvest);
  });

  test("the bales are compiled in only while the date lies in their stretch, or the year passes", () => {
    expect(features({}).COUNTRY_HAS_BALES).toBe(1);
    expect(features({ date: COUNTRY_SEASONS.summer }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ date: COUNTRY_SEASONS.autumn }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ date: COUNTRY_BALES[0] }).COUNTRY_HAS_BALES).toBe(1);
    expect(features({ date: COUNTRY_BALES[1] }).COUNTRY_HAS_BALES).toBe(0);
    expect(features({ date: 0.9, year: 1 }).COUNTRY_HAS_BALES).toBe(1);
    // Not without crops to bale.
    expect(features({ crops: 0 }).COUNTRY_HAS_BALES).toBe(0);
  });

  test("rain that winter turns to snow compiles the snowfall in, and drops the rain once all of it is snow", () => {
    const rain = { rain: 1, "rain-amount": 0.7 };
    expect(features({ ...rain, date: COUNTRY_SEASONS.summer })).toMatchObject({
      COUNTRY_HAS_RAIN: 1,
      COUNTRY_HAS_SNOW: 0,
    });
    expect(climateCold(0.875)).toBe(1);
    expect(features({ ...rain, date: 0.875 })).toMatchObject({
      COUNTRY_HAS_RAIN: 0,
      COUNTRY_HAS_SNOW: 1,
    });
    // At the turn of winter some falls as each.
    expect(features({ ...rain, date: 0.75 })).toMatchObject({
      COUNTRY_HAS_RAIN: 1,
      COUNTRY_HAS_SNOW: 1,
    });
    // While the year passes, both may come.
    expect(features({ ...rain, date: COUNTRY_SEASONS.summer, year: 1 })).toMatchObject({
      COUNTRY_HAS_RAIN: 1,
      COUNTRY_HAS_SNOW: 1,
    });
    // Winter's own lying snow needs no snowfall compiled in: it is uWeather.y's.
    expect(features({ date: 0.875 })).toMatchObject({ COUNTRY_HAS_RAIN: 0, COUNTRY_HAS_SNOW: 0 });
    // The snow switch falls whatever the season.
    expect(features({ snow: 1, date: COUNTRY_SEASONS.summer }).COUNTRY_HAS_SNOW).toBe(1);
  });

  test("the all-features program covers every date and the passing year", () => {
    const all = sceneFeaturesAll(countryScene) ?? {};
    // COUNTRY_ALL, the shared sky's library gates (its constellations and planets, several of them,
    // every kind with every palette and every piece of dress) and the agents' cursors on.
    expect(all).toEqual({
      ...COUNTRY_ALL,
      SKY_FIGURES: 1,
      SKY_PLANETS: 1,
      SKY_PLANETS_SEVERAL: 1,
      ...PLANET_BODY_GATES_ALL,
      PRINCIPAL_CURSORS: 1,
    });
    for (let date = 0; date < 1; date += 0.005)
      for (const knobs of [{ date }, { date, rain: 1 }, { date, year: 1, snow: 1 }])
        for (const [name, value] of Object.entries(features(knobs)))
          expect(all[name] ?? -Infinity).toBeGreaterThanOrEqual(value);
  });
});
