import { describe, expect, test } from "bun:test";
import { climateLying, fallingRain, fallingSnow, SNOW_SHARE, WINTER_LYING } from "../climate.ts";
import { feature, range, type ParamDef } from "../params.ts";
import { weatherKnobs, weatherRecipes } from "../scenes/atmosphere.ts";
import { sceneDefs } from "../scenes/index.ts";
import { paramDefaults, type Params } from "../state.ts";
import {
  CLIMATE_MARKS,
  climateMarks,
  precipMarks,
  recipeMark,
  type ClimateMarks,
  type Read,
} from "./climate-hint-model.ts";
import { shownRecipes } from "./recipes-model.ts";

const EPS = 1e-6;

/** Reads `values` over `defaults`, as Knobs.value does. */
const reader =
  (defaults: Params, values: Params = {}): Read =>
  (key) =>
    values[key] ?? defaults[key] ?? 0;

const garden = sceneDefs.garden;
const gardenDefaults = paramDefaults("garden");
const gardenRead = (values: Params) => reader(gardenDefaults, values);

function marksOf(params: readonly ParamDef[]): ClimateMarks {
  const marks = climateMarks(params);
  if (!marks) throw new Error("the scene's season sets no climate");
  return marks;
}

/** Garden's season choice: 0 spring, 1 summer, 2 autumn, 3 winter. */
const SUMMER = 1;
const AUTUMN = 2;
const WINTER = 3;

describe("the marks in a given cold", () => {
  test("say what comes down of the rain: sleet while some of it is snow, snow once all of it is", () => {
    for (let n = 0; n <= 200; n++) {
      const cold = n / 200;
      const rain = fallingRain(1, cold);
      const snow = fallingSnow(1, 0, cold);
      const mark = precipMarks(cold, 0.6, 0).rain?.kind;
      if (rain === 0) expect(mark).toBe("asSnow");
      else if (snow > 0) expect(mark).toBe("sleet");
      else expect(mark).toBeUndefined();
    }
  });

  test("turn at the snow share's ends", () => {
    expect(precipMarks(SNOW_SHARE[0], 0.6, 0).rain).toBeUndefined();
    expect(precipMarks(SNOW_SHARE[0] + EPS, 0.6, 0).rain).toBe(CLIMATE_MARKS.sleet);
    expect(precipMarks(SNOW_SHARE[1] - EPS, 0.6, 0).rain).toBe(CLIMATE_MARKS.sleet);
    expect(precipMarks(SNOW_SHARE[1], 0.6, 0).rain).toBe(CLIMATE_MARKS.asSnow);
    expect(precipMarks(1, 0.6, 0).rain).toBe(CLIMATE_MARKS.asSnow);
  });

  test("mark the snow switch out of season only while it is warm, and only while it is on", () => {
    expect(precipMarks(0, 0, 0.5).snow).toBe(CLIMATE_MARKS.outOfSeason);
    expect(precipMarks(SNOW_SHARE[0] - EPS, 0, 0.5).snow).toBe(CLIMATE_MARKS.outOfSeason);
    expect(precipMarks(SNOW_SHARE[0], 0, 0.5).snow).toBeUndefined();
    expect(precipMarks(0, 0, 0)).toEqual({});
    expect(precipMarks(0, 0.6, 0)).toEqual({});
  });

  test("leave rain that is off unmarked in any cold", () => {
    for (const cold of [0, 0.5, 1]) expect(precipMarks(cold, 0, 0).rain).toBeUndefined();
  });

  test("say snow lies exactly while deep winter lays its own, whether or not snow falls", () => {
    for (let n = 0; n <= 200; n++) {
      const cold = n / 200;
      const lies = climateLying(cold) > 0;
      for (const snow of [0, 0.5])
        expect(precipMarks(cold, 0, snow).snow?.kind === "lies").toBe(lies);
    }
    expect(precipMarks(WINTER_LYING[0], 0, 0).snow).toBeUndefined();
    expect(precipMarks(WINTER_LYING[0] + EPS, 0, 0).snow).toBe(CLIMATE_MARKS.lies);
  });
});

describe("a scene's marks", () => {
  test("only where its season sets its climate", () => {
    expect(climateMarks(garden.params)).toBeDefined();
    expect(climateMarks(sceneDefs.pond.params)).toBeUndefined();
    // A room's date is the World's (ADR 0062 D20), so its rain falls as snow in winter as outdoors.
    expect(climateMarks(sceneDefs.bonsai.params)).toBeDefined();
    // A room that lists no World has no date, and no climate.
    expect(climateMarks(sceneDefs.bar.params)).toBeUndefined();
  });

  test("follow the season knob: snow in summer is out of season, rain in winter falls as snow", () => {
    const marks = marksOf(garden.params);
    expect(marks(gardenRead({ season: SUMMER, snow: 1 }))).toEqual({
      snow: CLIMATE_MARKS.outOfSeason,
    });
    expect(marks(gardenRead({ season: SUMMER }))).toEqual({});
    expect(marks(gardenRead({ season: WINTER, rain: 1 }))).toEqual({
      rain: CLIMATE_MARKS.asSnow,
      snow: CLIMATE_MARKS.lies,
    });
    expect(marks(gardenRead({ season: WINTER }))).toEqual({ snow: CLIMATE_MARKS.lies });
    expect(marks(gardenRead({ season: AUTUMN, rain: 1, "rain-amount": 0.9 }))).toEqual({});
    // The defaults: autumn, dry.
    expect(marks(gardenRead({}))).toEqual({});
  });

  test("read a switch as the shader does: off is off whatever its amount", () => {
    const marks = marksOf(garden.params);
    expect(marks(gardenRead({ season: SUMMER, snow: 0, "snow-amount": 0.8 }))).toEqual({});
    expect(marks(gardenRead({ season: WINTER, rain: 0, "rain-amount": 0.8 }))).toEqual({
      snow: CLIMATE_MARKS.lies,
    });
  });

  test("take the season knob's year, not the passing year's", () => {
    const params: readonly ParamDef[] = [
      range("sky", "date", "time of year", 0.47, "help", {
        min: 0,
        max: 1,
        step: 0.005,
        widget: { kind: "sky", part: "season", year: { span: [0, 1] } },
      }),
      feature("sky", "year", "the year passes", false, "minutes per season", 2, "help", {
        min: 0.5,
        max: 10,
        step: 0.5,
        widget: { kind: "sky", part: "year" },
      }),
      ...weatherKnobs({ rain: true, snow: true }),
    ];
    const defaults: Params = Object.fromEntries(
      params.flatMap((def) =>
        def.kind === "feature"
          ? [
              [def.key, def.on ? 1 : 0],
              [`${def.key}-amount`, def.value],
            ]
          : [[def.key, def.value]],
      ),
    );
    const marks = marksOf(params);
    // The turn of winter: some of the rain is snow.
    const turn = { date: 0.75, rain: 1 };
    expect(marks(reader(defaults, turn))).toEqual({ rain: CLIMATE_MARKS.sleet });
    expect(marks(reader(defaults, { ...turn, year: 1, "year-amount": 0.5 }))).toEqual({
      rain: CLIMATE_MARKS.sleet,
    });
    expect(marks(reader(defaults, { date: 0.875, rain: 1 }))).toEqual({
      rain: CLIMATE_MARKS.asSnow,
      snow: CLIMATE_MARKS.lies,
    });
  });
});

describe("a weather recipe's mark", () => {
  const shown = shownRecipes(weatherRecipes, garden.params);
  const patchOf = (label: string): Params => {
    const found = shown.find((each) => each.recipe.label === label);
    if (!found) throw new Error(`garden shows no ${label} recipe`);
    return found.patch;
  };
  const marks = marksOf(garden.params);
  const markOf = (label: string, values: Params) =>
    recipeMark(marks, patchOf(label), gardenRead(values))?.kind;

  test("says what the season makes of the rain or snow the recipe brings", () => {
    expect(markOf("Snowfall", { season: SUMMER })).toBe("outOfSeason");
    expect(markOf("Blizzard", { season: SUMMER })).toBe("outOfSeason");
    expect(markOf("Downpour", { season: WINTER })).toBe("asSnow");
    expect(markOf("Drizzle", { season: WINTER })).toBe("asSnow");
    expect(markOf("Downpour", { season: SUMMER })).toBeUndefined();
  });

  test("is not the setup's: winter's lying snow and the rain already falling are not the recipe's doing", () => {
    expect(markOf("Snowfall", { season: WINTER })).toBeUndefined();
    expect(markOf("Clear", { season: WINTER, rain: 1 })).toBeUndefined();
    expect(markOf("Clear", { season: SUMMER, snow: 1 })).toBeUndefined();
  });
});
