import { describe, expect, test } from "bun:test";
import { choice, feature, range, toggle, type ParamDef, type SeasonYear } from "../params.ts";
import { sceneDefs } from "../scenes/index.ts";
import {
  gatherAlmanac,
  seasonDef,
  seasonPatch,
  seasonStops,
  seasonText,
  stepSeason,
  yearDistance,
  yearOf,
  type SeasonDef,
} from "./almanac-model.ts";

const sky = (year: SeasonYear) => ({ kind: "sky", part: "season", year }) as const;

function tagged(def: ParamDef): SeasonDef {
  const found = seasonDef([def]);
  if (!found) throw new Error(`${def.key} is not a season knob`);
  return found;
}

/** shanshui's: a "none" that is no time of year, then the four seasons at their middles. */
const scroll = tagged(
  choice(
    "ink",
    "season",
    "season",
    ["none", "spring", "summer", "autumn", "winter"].map((label, value) => ({ label, value })),
    0,
    "help",
    { widget: sky({ at: [null, 0.125, 0.375, 0.625, 0.875] }) },
  ),
);

/** country's: three seasons bunched from summer into autumn. */
const farm = tagged(
  choice(
    "land",
    "season",
    "season",
    ["summer", "harvest", "autumn"].map((label, value) => ({ label, value })),
    1,
    "help",
    { widget: sky({ at: [0.375, 0.47, 0.6] }) },
  ),
);

/** autumn's: a range over one quarter of the year. */
const fall = tagged(
  range("tree", "season", "season progress", 0.35, "help", {
    widget: sky({ span: [0.5, 0.75] }),
  }),
);

/** the plants': a feature whose amount (0.05..1) is the year, high summer while off. */
const plants = tagged(
  feature("plants", "season", "seasons", false, "time of year", 0.35, "help", {
    widget: sky({ span: [0.05, 1], off: 0.35 }),
  }),
);

describe("a choice of seasons", () => {
  test("takes the option nearest the year, the short way round", () => {
    expect(seasonPatch(farm, 0.4)).toEqual({ season: 0 });
    expect(seasonPatch(farm, 0.5)).toEqual({ season: 1 });
    // Mid-winter lies nearer autumn (0.6) than summer (0.375) going back through the year's end.
    expect(seasonPatch(farm, 0.9)).toEqual({ season: 2 });
    // Early spring lies nearer summer going forward.
    expect(seasonPatch(farm, 0.02)).toEqual({ season: 0 });
    expect(seasonPatch(farm, 1.02)).toEqual(seasonPatch(farm, 0.02));
    expect(seasonPatch(scroll, 0.97)).toEqual({ season: 4 });
    expect(seasonPatch(scroll, 0.05)).toEqual({ season: 1 });
  });

  test("never lands on an option that is no time of year", () => {
    for (let i = 0; i < 64; i++) expect(seasonPatch(scroll, i / 64).season).not.toBe(0);
    const none = tagged(
      choice("ink", "wash", "wash", [{ label: "none", value: 0 }], 0, "help", {
        widget: sky({ at: [null] }),
      }),
    );
    expect(seasonPatch(none, 0.3)).toEqual({});
    expect(yearOf(none, {})).toBeUndefined();
  });

  test("reads out its option, with no year for one that is not a season", () => {
    expect(yearOf(scroll, { season: 0 })).toBeUndefined();
    expect(seasonText(scroll, { season: 0 })).toBe("none");
    expect(yearOf(farm, {})).toBe(0.47);
    expect(seasonText(farm, {})).toBe("harvest");
  });

  test("holds the ring half-way to its neighbours, at most an eighth of the year either side", () => {
    const stops = seasonStops(farm).map(({ label, from, to }) => ({ label, from, to }));
    expect(stops.map((stop) => stop.label)).toEqual(["summer", "harvest", "autumn"]);
    const [summer, harvest, autumn] = stops;
    expect(summer?.from).toBeCloseTo(0.25);
    expect(summer?.to).toBeCloseTo(0.4225);
    expect(harvest?.from).toBeCloseTo(0.4225);
    expect(harvest?.to).toBeCloseTo(0.535);
    expect(autumn?.from).toBeCloseTo(0.535);
    expect(autumn?.to).toBeCloseTo(0.725);
    expect(seasonStops(scroll).map((stop) => stop.value)).toEqual([1, 2, 3, 4]);
  });

  test("steps through its seasons round the year, onto them from an option that is not one", () => {
    expect(stepSeason(scroll, { season: 2 }, 1)).toEqual({ season: 3 });
    expect(stepSeason(scroll, { season: 4 }, 1)).toEqual({ season: 1 });
    expect(stepSeason(scroll, { season: 1 }, -1)).toEqual({ season: 4 });
    expect(stepSeason(scroll, { season: 0 }, 1)).toEqual({ season: 1 });
    expect(stepSeason(scroll, { season: 0 }, -1)).toEqual({ season: 4 });
    expect(stepSeason(farm, { season: 2 }, 1)).toEqual({ season: 0 });
  });
});

describe("a span of the year", () => {
  test("maps its range linearly over the span", () => {
    expect(yearOf(fall, { season: 0 })).toBeCloseTo(0.5);
    expect(yearOf(fall, { season: 0.4 })).toBeCloseTo(0.6);
    expect(yearOf(fall, { season: 1 })).toBeCloseTo(0.75);
    expect(seasonPatch(fall, 0.6)).toEqual({ season: 0.4 });
  });

  test("reads its far end as the end of its own stretch, its near end as the start", () => {
    expect(seasonText(fall, { season: 0 })).toBe("early autumn");
    expect(seasonText(fall, { season: 1 })).toBe("late autumn");
    expect(seasonText(plants, { season: 1, "season-amount": 1 })).toBe("late winter");
    expect(seasonText(plants, { season: 1, "season-amount": 0.05 })).toBe("early spring");
  });

  test("past its ends, takes whichever end lies nearer round the year", () => {
    expect(seasonPatch(fall, 0.8)).toEqual({ season: 1 });
    expect(seasonPatch(fall, 0.4)).toEqual({ season: 0 });
    // Spring: 0.35 from the span's end going back through winter, 0.4 from its start.
    expect(seasonPatch(fall, 0.1)).toEqual({ season: 1 });
  });

  test("snaps to the knob's step and never past its maximum", () => {
    const coarse = tagged(
      range("tree", "season", "season", 0.5, "help", { step: 0.05, widget: sky({ span: [0, 1] }) }),
    );
    expect(seasonPatch(coarse, 0.33)).toEqual({ season: 0.35 });
    expect(seasonPatch(coarse, 0.32)).toEqual({ season: 0.3 });
    // 0..1 is 2.5 steps of 0.4: the end rounds up to 1.2 unless held to the maximum.
    const uneven = tagged(
      range("tree", "season", "season", 0.4, "help", {
        step: 0.4,
        widget: sky({ span: [0, 0.5] }),
      }),
    );
    expect(seasonPatch(uneven, 0.5)).toEqual({ season: 1 });
  });

  test("steps by the knob's step, stopping at the ends of a span that does not close the year", () => {
    expect(stepSeason(fall, { season: 0.4 }, 1)).toEqual({ season: 0.45 });
    expect(stepSeason(fall, { season: 1 }, 1)).toEqual({ season: 1 });
    expect(stepSeason(fall, { season: 0 }, -1)).toEqual({ season: 0 });
  });

  test("steps on round the year when the span closes it", () => {
    expect(stepSeason(plants, { season: 1, "season-amount": 1 }, 1)).toEqual({
      season: 1,
      "season-amount": 0.05,
    });
    expect(stepSeason(plants, { season: 1, "season-amount": 0.05 }, -1)).toEqual({
      season: 1,
      "season-amount": 1,
    });
  });
});

describe("a feature season", () => {
  test("stands at its off position while off, at its amount while on", () => {
    expect(yearOf(plants, {})).toBe(0.35);
    expect(yearOf(plants, { season: 0, "season-amount": 0.9 })).toBe(0.35);
    expect(yearOf(plants, { season: 1, "season-amount": 0.9 })).toBeCloseTo(0.9);
    expect(seasonText(plants, {})).toBe("off: high summer");
    const bare = tagged(
      feature("life", "season", "seasons", false, "time of year", 0.5, "help", {
        widget: sky({ span: [0, 1] }),
      }),
    );
    expect(yearOf(bare, {})).toBeUndefined();
    expect(seasonText(bare, {})).toBe("off");
  });

  test("switches on when set or stepped, stepping from its off position", () => {
    expect(seasonPatch(plants, 0.62)).toEqual({ season: 1, "season-amount": 0.6 });
    expect(stepSeason(plants, { season: 0, "season-amount": 0.9 }, 1)).toEqual({
      season: 1,
      "season-amount": 0.4,
    });
  });
});

describe("every tagged scene's season knob", () => {
  const tagged = Object.entries(sceneDefs).flatMap(([id, scene]) => {
    const def = seasonDef(scene.params);
    return def ? [{ id, def }] : [];
  });

  /** Every value the knob takes, as URL params: each option, or each step of its range. */
  function settings(def: SeasonDef): Record<string, number>[] {
    if (def.kind === "choice") return def.options.map((option) => ({ [def.key]: option.value }));
    if (def.kind !== "range" && def.kind !== "feature") return [];
    const count = Math.round((def.max - def.min) / def.step);
    return Array.from({ length: count + 1 }, (_, index) => {
      const value = Math.min(def.max, def.min + index * def.step);
      return def.kind === "feature"
        ? { [def.key]: 1, [`${def.key}-amount`]: value }
        : { [def.key]: value };
    });
  }

  test("comes back to the year it stands at", () => {
    expect(tagged.length).toBeGreaterThan(0);
    const misses: unknown[] = [];
    for (const { id, def } of tagged)
      for (const params of settings(def)) {
        const year = yearOf(def, params);
        if (year === undefined) continue;
        const back = yearOf(def, seasonPatch(def, year));
        if (back === undefined || yearDistance(back, year) > 1e-9)
          misses.push({ id, params, year, back });
      }
    expect(misses).toEqual([]);
  });

  test("lands as near any year as its values go", () => {
    const misses: unknown[] = [];
    for (const { id, def } of tagged) {
      const years = settings(def).flatMap((params) => yearOf(def, params) ?? []);
      for (let i = 0; i < 96; i++) {
        const year = i / 96;
        const landed = yearOf(def, seasonPatch(def, year));
        const nearest = Math.min(...years.map((at) => yearDistance(at, year)));
        if (landed === undefined || yearDistance(landed, year) - nearest > 1e-9)
          misses.push({ id, year, landed, nearest });
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("gathering the almanac", () => {
  const time = range("sky", "time", "time of day", 0.5, "help", {
    widget: { kind: "sky", part: "time" },
  });
  const cycle = feature("sky", "cycle", "day cycle", false, "speed", 0.5, "help", {
    widget: { kind: "sky", part: "cycle" },
  });
  const crops = toggle("land", "crops", "crops", true, "help");
  const season = choice("land", "season", "season", [{ label: "summer", value: 0 }], 0, "help", {
    widget: sky({ at: [0.375] }),
  });
  const year = feature("seasons", "year", "seasons pass", true, "pace", 3, "help", {
    widget: { kind: "sky", part: "year" },
  });
  const leaves = feature("seasons", "leaves", "leaves", true, "amount", 0.5, "help");

  const groupsOf = (defs: readonly ParamDef[]) => {
    const groups = new Map<string, ParamDef[]>();
    for (const def of defs) groups.set(def.group, [...(groups.get(def.group) ?? []), def]);
    return groups;
  };
  const keys = (groups: Map<string, ParamDef[]>) =>
    [...groups].map(([group, defs]) => [group, defs.map((def) => def.key)]);

  test("moves the season and the year's cycle to the group holding the time of day", () => {
    const groups = groupsOf([crops, season, year, leaves, time, cycle]);
    gatherAlmanac(groups);
    expect(keys(groups)).toEqual([
      ["land", ["crops"]],
      ["seasons", ["leaves"]],
      ["sky", ["time", "cycle", "season", "year"]],
    ]);
  });

  test("drops a group the almanac leaves empty, keeping the others' order", () => {
    const groups = new Map<string, ParamDef[]>([
      ["land", [season]],
      ["sky", [time, cycle]],
      ["fields", [crops]],
    ]);
    gatherAlmanac(groups);
    expect(keys(groups)).toEqual([
      ["sky", ["time", "cycle", "season"]],
      ["fields", ["crops"]],
    ]);
  });

  test("leaves every part in its own group without a time of day", () => {
    const groups = groupsOf([crops, season, year, leaves]);
    gatherAlmanac(groups);
    expect(keys(groups)).toEqual([
      ["land", ["crops", "season"]],
      ["seasons", ["year", "leaves"]],
    ]);
  });
});
