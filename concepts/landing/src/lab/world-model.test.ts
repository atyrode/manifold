import { describe, expect, test } from "bun:test";
import { choice, feature, range, type ParamDef, type SeasonYear } from "../params.ts";
import type { Params } from "../state.ts";
import { carryWorld, shelves, type WorldScene } from "./world-model.ts";

/** A scene of these knobs, the groups named in `world` on the World shelf. */
function scene(params: readonly ParamDef[], ...world: string[]): WorldScene {
  const groups = Object.fromEntries(
    params.map((def) => [
      def.group,
      world.includes(def.group)
        ? { title: def.group, shelf: "world" as const, blurb: "" }
        : { title: def.group, blurb: "" },
    ]),
  );
  return { params, groups };
}

/** Each knob's default, keyed as readParams keys them. */
function defaultsOf({ params }: WorldScene): Params {
  return Object.fromEntries(
    params.flatMap((def) =>
      def.kind === "feature"
        ? [
            [def.key, def.on ? 1 : 0],
            [`${def.key}-amount`, def.value],
          ]
        : [[def.key, def.value]],
    ),
  );
}

/** `to` at its defaults under the world of `from` set to `fromParams` over its defaults. */
function carry(from: WorldScene, fromParams: Params, to: WorldScene): Params {
  return carryWorld(from, { ...defaultsOf(from), ...fromParams }, to, defaultsOf(to));
}

const season = (year: SeasonYear) => ({ widget: { kind: "sky", part: "season", year } }) as const;
const FOUR_SEASONS = [
  { label: "spring", value: 0 },
  { label: "summer", value: 1 },
  { label: "autumn", value: 2 },
  { label: "winter", value: 3 },
];
const farmYear = choice(
  "land",
  "season",
  "season",
  [
    { label: "summer", value: 0 },
    { label: "harvest", value: 1 },
    { label: "autumn", value: 2 },
  ],
  0,
  "",
  season({ at: [0.375, 0.47, 0.6] }),
);
const plantYear = feature("life", "season", "seasons", false, "time of year", 0.35, "", {
  min: 0,
  max: 1,
  ...season({ span: [0, 1], off: 0.375 }),
});
const treeYear = range("seasons", "season", "season", 0.4, "", season({ span: [0, 1] }));
const gardenYear = choice(
  "maple",
  "season",
  "season",
  FOUR_SEASONS,
  1,
  "",
  season({ at: [0.125, 0.375, 0.625, 0.875] }),
);

describe("shelves", () => {
  test("world groups lead as sky, weather, wind, birds; the scene's own keep their knob order", () => {
    const params = [
      range("birds", "birds", "birds", 0.3, ""),
      range("land", "crops", "crops", 0.5, ""),
      range("weather", "fog", "fog", 0, ""),
      range("night", "hour", "hour", 0.7, ""),
      range("sky", "time", "time", 0.5, ""),
      range("water", "river", "river", 0.5, ""),
      range("haze", "haze", "haze", 0, ""),
      range("wind", "wind", "wind", 0.2, ""),
    ];
    expect(shelves(scene(params, "birds", "weather", "sky", "haze", "wind"))).toEqual({
      world: ["sky", "weather", "wind", "birds", "haze"],
      own: ["land", "night", "water"],
    });
  });

  test("a group is the world's by its heading alone, whatever its name", () => {
    const params = [range("sky", "time", "time", 0.5, ""), range("air", "wind", "wind", 0.2, "")];
    expect(shelves(scene(params, "air"))).toEqual({ world: ["air"], own: ["sky"] });
    expect(shelves({ params, groups: {} })).toEqual({ world: [], own: ["sky", "air"] });
  });
});

describe("carryWorld", () => {
  test("a world knob takes the value of the one with its key and kind, within its own range", () => {
    const from = scene(
      [
        range("sky", "time", "time", 0.6, ""),
        range("weather", "wind", "wind", 0.2, "", { min: -1, max: 1 }),
      ],
      "sky",
      "weather",
    );
    const to = scene(
      [
        range("sky", "time", "time", 0.3, ""),
        range("weather", "wind", "wind", 0.2, ""),
        range("dunes", "sand", "sand", 0.5, ""),
      ],
      "sky",
      "weather",
    );
    expect(carry(from, { time: 0.9, wind: -0.8 }, to)).toEqual({ time: 0.9, wind: 0, sand: 0.5 });
    expect(carry(from, { wind: 0.7 }, to)).toEqual({ time: 0.6, wind: 0.7, sand: 0.5 });
  });

  test("another kind under the key, or a knob off the World shelf on either side, stays put", () => {
    const from = scene(
      [
        feature("weather", "clouds", "clouds", true, "cover", 0.7, ""),
        range("river", "stars", "stars", 0.9, ""),
        range("sky", "moon", "moon", 0.9, ""),
      ],
      "weather",
      "sky",
    );
    const to = scene(
      [
        range("weather", "clouds", "clouds", 0.25, ""),
        range("sky", "stars", "stars", 0.6, ""),
        range("room", "moon", "moon", 0.5, ""),
      ],
      "weather",
      "sky",
    );
    expect(carry(from, {}, to)).toEqual(defaultsOf(to));
  });

  test("a feature carries its switch and its amount, a segmented amount only where offered", () => {
    const from = scene(
      [
        feature("weather", "rain", "rain", false, "amount", 0.5, ""),
        feature("sky", "aurora", "aurora", true, "strength", 0.6, ""),
        feature("sky", "meteors", "shooting stars", false, "frequency", 0.3, ""),
      ],
      "weather",
      "sky",
    );
    const to = scene(
      [
        feature("weather", "rain", "rain", false, "amount", 0.5, "", { max: 0.8 }),
        feature("sky", "aurora", "aurora", true, "strength", 0.4, ""),
        feature("sky", "meteors", "shooting stars", false, "frequency", 0.25, "", {
          options: [
            { label: "few", value: 0.25 },
            { label: "many", value: 0.5 },
          ],
        }),
      ],
      "weather",
      "sky",
    );
    expect(
      carry(
        from,
        { rain: 1, "rain-amount": 0.9, aurora: 0, meteors: 1, "meteors-amount": 0.3 },
        to,
      ),
    ).toEqual({
      rain: 1,
      "rain-amount": 0.8,
      aurora: 0,
      "aurora-amount": 0.6,
      meteors: 1,
      "meteors-amount": 0.25,
    });
    expect(carry(from, { meteors: 1, "meteors-amount": 0.5 }, to)).toMatchObject({
      meteors: 1,
      "meteors-amount": 0.5,
    });
  });

  test("a choice carries only an option the next scene offers", () => {
    const kinds = (count: number) =>
      choice(
        "birds",
        "birdKind",
        "kind",
        Array.from({ length: count }, (_, value) => ({ label: String(value), value })),
        0,
        "",
      );
    const from = scene([kinds(4)], "birds");
    const to = scene([kinds(2)], "birds");
    expect(carry(from, { birdKind: 1 }, to)).toEqual({ birdKind: 1 });
    expect(carry(from, { birdKind: 3 }, to)).toEqual({ birdKind: 0 });
  });

  test("the season goes over through the year, between a choice and a span either way", () => {
    const tree = scene([treeYear]);
    const garden = scene([gardenYear]);
    expect(carry(scene([farmYear]), { season: 2 }, tree)).toEqual({ season: 0.6 });
    expect(carry(tree, { season: 0.1 }, garden)).toEqual({ season: 0 });
    expect(carry(tree, { season: 0.95 }, garden)).toEqual({ season: 3 });
    // A winter's year position, 0.875, as near as the range's 0.05 steps go.
    expect(carry(garden, { season: 3 }, tree)).toEqual({ season: 0.9 });
  });

  test("a time of year the next scene already shows stays as it is; another switches it on", () => {
    const farm = scene([farmYear]);
    const pool = scene([plantYear]);
    expect(carry(farm, { season: 0 }, pool)).toEqual(defaultsOf(pool));
    expect(carry(farm, { season: 2 }, pool)).toEqual({ season: 1, "season-amount": 0.6 });
  });

  test("no season goes over without one on each side, or from a choice outside the year", () => {
    const tree = scene([treeYear]);
    const ink = scene([
      choice(
        "ink",
        "season",
        "season",
        [
          { label: "none", value: 0 },
          ...FOUR_SEASONS.map(({ label, value }) => ({ label, value: value + 1 })),
        ],
        0,
        "",
        season({ at: [null, 0.125, 0.375, 0.625, 0.875] }),
      ),
    ]);
    const plain = scene([range("sky", "time", "time", 0.5, "")], "sky");
    expect(carry(plain, {}, tree)).toEqual(defaultsOf(tree));
    expect(carry(ink, { season: 0 }, tree)).toEqual(defaultsOf(tree));
    expect(carry(ink, { season: 1 }, tree)).toEqual({ season: 0.15 });
    expect(carry(tree, { season: 0.9 }, plain)).toEqual(defaultsOf(plain));
  });
});
