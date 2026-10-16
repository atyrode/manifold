import { describe, expect, test } from "bun:test";
import { choice, counts, feature, range, toggle, type ParamDef } from "../params.ts";
import { sceneDefs } from "../scenes/index.ts";
import { defaultsFor, paramDefaults } from "../state.ts";
import { knobKeys } from "./knobs.ts";
import {
  changedCounts,
  changedKnobs,
  changedSettings,
  groupShows,
  itemShows,
  titleHolds,
  type LensGroup,
  type LensQuery,
} from "./lens-model.ts";

const defs: ParamDef[] = [
  range("terrain", "relief", "relief", 0.5, "help"),
  feature("weather", "rain", "rain", false, "amount", 0.5, "help"),
  toggle("weather", "shadows", "shadows", true, "help"),
  choice("view", "camera", "camera", counts(0, 1, 2), 1, "help"),
];
const defaults = { relief: 0.5, rain: 0, "rain-amount": 0.5, shadows: 1, camera: 1 };

describe("changedKnobs", () => {
  test("an unset knob, or one set to its default, has not changed", () => {
    expect(changedKnobs(defs, {}, defaults)).toEqual(new Set());
    expect(changedKnobs(defs, { ...defaults }, defaults)).toEqual(new Set());
  });

  test("each key that differs counts, a feature's switch and amount apart", () => {
    expect(changedKnobs(defs, { relief: 0.8 }, defaults)).toEqual(new Set(["relief"]));
    expect(changedKnobs(defs, { rain: 1 }, defaults)).toEqual(new Set(["rain"]));
    expect(changedKnobs(defs, { "rain-amount": 0.9 }, defaults)).toEqual(new Set(["rain-amount"]));
    expect(changedKnobs(defs, { shadows: 0, camera: 2 }, defaults)).toEqual(
      new Set(["shadows", "camera"]),
    );
  });

  test("keys of no knob are not the lens's", () => {
    expect(changedKnobs(defs, { elsewhere: 3 }, defaults)).toEqual(new Set());
  });
});

describe("changedSettings", () => {
  const base = defaultsFor("country");

  test("a setting differs from the scene's own default, not the global one", () => {
    expect(changedSettings(["view", "color", "levels"], { ...base }, base)).toEqual(new Set());
    expect(changedSettings(["view", "dim"], { ...base, view: "source", dim: 0.4 }, base)).toEqual(
      new Set(["view", "dim"]),
    );
  });

  test("only the settings asked about", () => {
    const split = { ...base, view: "split" as const };
    expect(changedSettings(["dither"], split, base)).toEqual(new Set());
  });
});

describe("changedCounts", () => {
  const groups: LensGroup[] = [
    { id: "terrain", knobs: [["relief"]] },
    { id: "weather", knobs: [["rain", "rain-amount"], ["shadows"]] },
    { id: "view", knobs: [["camera"]] },
  ];

  test("a knob counts once however many of its keys changed; a group with none is left out", () => {
    expect(changedCounts(groups, new Set(["rain", "rain-amount"]))).toEqual(
      new Map([["weather", 1]]),
    );
    expect(changedCounts(groups, new Set(["rain-amount", "shadows", "relief"]))).toEqual(
      new Map([
        ["terrain", 1],
        ["weather", 2],
      ]),
    );
    expect(changedCounts(groups, new Set())).toEqual(new Map());
  });

  test("country with its relief and rain changed: one in Lie of the land, one in Weather", () => {
    const scene = sceneDefs.country.params;
    const byGroup = new Map<string, string[][]>();
    for (const def of scene)
      byGroup.set(def.group, [...(byGroup.get(def.group) ?? []), knobKeys(def)]);
    const changed = changedKnobs(scene, { relief: 0.8, rain: 1 }, paramDefaults("country"));
    const counted = changedCounts(
      [...byGroup].map(([id, knobs]) => ({ id, knobs })),
      changed,
    );
    expect(counted).toEqual(
      new Map([
        ["weather", 1],
        ["terrain", 1],
      ]),
    );
  });
});

describe("the lens and the search together", () => {
  const changed = new Set(["rain", "relief"]);
  const query = (text: string, lens: boolean): LensQuery => ({ text, lens, changed });
  const rain = { search: "rain how hard it rains", keys: ["rain", "rain-amount"], held: false };
  const snow = { search: "snow how hard it snows", keys: ["snow", "snow-amount"], held: false };
  const clock = { search: "clock freeze time", keys: [], held: false };

  test("nothing narrows: every control and group shows", () => {
    for (const item of [rain, snow, clock])
      expect(itemShows(item, false, query("", false))).toBe(true);
    expect(groupShows(0, false, query("", false))).toBe(true);
  });

  test("the search alone: a control's words or its group's title", () => {
    expect(itemShows(rain, false, query("rain", false))).toBe(true);
    expect(itemShows(snow, false, query("rain", false))).toBe(false);
    const titleHit = titleHolds("weather", query("weath", false));
    expect(itemShows(snow, titleHit, query("weath", false))).toBe(true);
    expect(groupShows(0, titleHit, query("weath", false))).toBe(true);
    expect(groupShows(0, false, query("weath", false))).toBe(false);
    expect(titleHolds("weather", query("", false))).toBe(false);
  });

  test("the lens alone: a control with a changed knob, or the one in hand", () => {
    expect(itemShows(rain, false, query("", true))).toBe(true);
    expect(itemShows(snow, false, query("", true))).toBe(false);
    expect(itemShows({ ...snow, held: true }, false, query("", true))).toBe(true);
    expect(itemShows(clock, false, query("", true))).toBe(false);
  });

  test("under the lens a group needs a control to show, its title alone is not enough", () => {
    const titleHit = titleHolds("weather", query("weather", true));
    expect(groupShows(0, titleHit, query("weather", true))).toBe(false);
    expect(groupShows(0, false, query("", true))).toBe(false);
    expect(groupShows(1, false, query("", true))).toBe(true);
  });

  test("both: a control must match the words and have changed", () => {
    expect(itemShows(rain, false, query("rain", true))).toBe(true);
    expect(itemShows(rain, false, query("snow", true))).toBe(false);
    expect(itemShows(snow, false, query("snow", true))).toBe(false);
    expect(itemShows({ ...snow, held: true }, false, query("rain", true))).toBe(false);
    expect(itemShows(snow, true, query("weather", true))).toBe(false);
    expect(itemShows(rain, true, query("weather", true))).toBe(true);
  });
});
