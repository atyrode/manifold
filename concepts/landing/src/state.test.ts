import { describe, expect, test } from "bun:test";
import { choice, range } from "./params.ts";
import { parsePresets, presets } from "./presets.ts";
import { sceneDefs } from "./scenes/index.ts";
import { encodePlanets, planetDefaults, readPlanet } from "./scenes/planets.ts";
import type { SceneDef } from "./scenes/types.ts";
import {
  migrateLegacy,
  paramDefaults,
  readParams,
  readPlanets,
  readState,
  serialise,
} from "./state.ts";

/** A setup query as the page reads it back and writes it again: its scene's knobs and planets, minimal. */
function reread(query: string): string {
  const q = new URLSearchParams(query);
  const state = readState(q);
  return serialise(state, readParams(state.scene, q), readPlanets(state.scene, q)).toString();
}

/** A scene that renamed a choice `mode` (0 low, 1 high) to a range `level`. */
const renamed: SceneDef = {
  ...sceneDefs.pond,
  params: [range("look", "level", "level", 0.5, "help")],
  legacy: { mode: { key: "level", values: { 0: 0.2, 1: 0.9 } } },
};

describe("an outgrown key", () => {
  test("sets the knob that replaced it from its value map and is dropped", () => {
    expect(migrateLegacy(renamed, new URLSearchParams("a=1&mode=1")).toString()).toBe(
      "a=1&level=0.9",
    );
    // However the old link wrote the number.
    expect(migrateLegacy(renamed, new URLSearchParams("mode=0.0")).get("level")).toBe("0.2");
  });

  test("leaves the new knob alone where the setup already sets it, or at its default for a value it never had", () => {
    expect(migrateLegacy(renamed, new URLSearchParams("level=0.4&mode=1")).toString()).toBe(
      "level=0.4",
    );
    expect(migrateLegacy(renamed, new URLSearchParams("mode=7")).toString()).toBe("");
    expect(migrateLegacy(renamed, new URLSearchParams("mode=")).toString()).toBe("");
  });

  test("is the scene's own: a scene without one, or another scene's key, passes through", () => {
    const plain: SceneDef = {
      ...sceneDefs.pond,
      params: [choice("look", "mode", "mode", [{ label: "low", value: 0 }], 0, "help")],
    };
    expect(migrateLegacy(plain, new URLSearchParams("mode=0")).toString()).toBe("mode=0");
    expect(migrateLegacy(sceneDefs.pond, new URLSearchParams("season=2")).toString()).toBe(
      "season=2",
    );
  });
});

describe("the countryside's old season", () => {
  test("an old link opens at the season's date and is rewritten with it", () => {
    expect(readParams("country", new URLSearchParams("scene=country&season=0")).date).toBe(0.375);
    expect(readParams("country", new URLSearchParams("scene=country&season=2")).date).toBe(0.6);
    expect(reread("scene=country&season=0&crops=0")).toBe("scene=country&crops=0&date=0.375");
    expect(reread("scene=country&season=2&time=0.64")).toBe("scene=country&time=0.64&date=0.6");
    // The harvest was the default and is again.
    expect(reread("scene=country&season=1")).toBe("scene=country");
    expect(readParams("country", new URLSearchParams("season=1"))).toEqual(
      paramDefaults("country"),
    );
    // A link that names the date keeps it.
    expect(reread("scene=country&season=0&date=0.2")).toBe("scene=country&date=0.2");
  });

  test("no committed preset still carries an outgrown key", () => {
    for (const preset of presets) {
      const q = new URLSearchParams(preset.query);
      const scene = readState(q).scene;
      expect(migrateLegacy(sceneDefs[scene], q).toString()).toBe(q.toString());
    }
  });

  test("a preset saved before the date knob loads at its season, as its rewritten form does", () => {
    const [old] = parsePresets(
      JSON.stringify({
        name: "Countryside · wildwood",
        commit: "defa703a",
        query: "scene=country&time=0.64&season=2&crops=0&woodland-amount=100&pines=0.45",
        savedAt: "2026-10-16",
      }),
    );
    const committed = presets.find((preset) => preset.name === "Countryside · wildwood");
    if (!old || !committed) throw new Error("no wildwood preset");
    expect(readParams("country", new URLSearchParams(old.query))).toEqual(
      readParams("country", new URLSearchParams(committed.query)),
    );
    expect(readParams("country", new URLSearchParams(committed.query)).date).toBe(0.6);
  });
});

describe("the night sky's planets", () => {
  const frost = sceneDefs.frost.planets;
  if (frost === undefined) throw new Error("frost takes no planets");

  test("ride in one key after the knobs, read back as they were written", () => {
    const planets = [
      readPlanet(frost, { kind: 3, size: 0.8, across: 12 }),
      readPlanet(frost, { orbit: 1, "orbit-amount": 6 }),
    ];
    const query = serialise(
      readState(new URLSearchParams("scene=frost")),
      paramDefaults("frost"),
      planets,
    );
    expect(query.toString()).toBe(`scene=frost&planets=${encodePlanets(frost, planets)}`);
    expect(readPlanets("frost", query)).toEqual(planets);
    expect(reread(query.toString())).toBe(query.toString());
    // None: no key at all.
    expect(reread("scene=frost&planets=")).toBe("scene=frost");
  });

  test("a link from before the list opens with its giant as the first planet, rewritten", () => {
    const old =
      "scene=frost&time=0&planet=1&planet-amount=0.7&planetX=10&planetY=30&planetPalette=2&planetRing=0&planetMoons=1&planetMoons-amount=3&planetEclipses=0&planetAurora=1&planetAurora-amount=0.5&planetAuroraSize=0.6&planetLights=1&planetLightsTwinkle=0.4&planetDaycycle=1&planetDaycycle-amount=0.45";
    const giant = readPlanet(frost, {
      size: 0.7,
      across: 10,
      up: 30,
      palette: 2,
      ring: 0,
      moons: 1,
      "moons-amount": 3,
      eclipses: 0,
      aurora: 1,
      "aurora-amount": 0.5,
      auroraSize: 0.6,
      lights: 1,
      twinkle: 0.4,
      daycycle: 1,
      "daycycle-amount": 0.45,
    });
    expect(readPlanets("frost", new URLSearchParams(old))).toEqual([giant]);
    expect(reread(old)).toBe(`scene=frost&time=0&planets=${encodePlanets(frost, [giant])}`);
    // The giant as it started: the first planet at its defaults, where the giant stood.
    expect(readPlanets("frost", new URLSearchParams("scene=frost&planet=1"))).toEqual([
      planetDefaults(frost),
    ]);
    // Out of range, clamped as the knobs were.
    expect(readPlanets("frost", new URLSearchParams("planet=1&planetX=999"))[0]?.["across"]).toBe(
      frost.across[2],
    );
  });

  test("a giant that was off brings none, and the list wins over the old keys", () => {
    expect(reread("scene=frost&planet=0&planetX=10&planetMoons=1")).toBe("scene=frost");
    expect(reread("scene=frost&planetX=10")).toBe("scene=frost");
    expect(readPlanets("frost", new URLSearchParams("planet=1&planets="))).toEqual([]);
  });

  test("belong to the scenes that take them: campfire keeps its own giant's keys, mobile its knob", () => {
    expect(reread("scene=campfire&planet=0&planetMoons=1")).toBe(
      "scene=campfire&planet=0&planetMoons=1",
    );
    expect(readPlanets("campfire", new URLSearchParams("planet=1&planets=AQEA"))).toEqual([]);
    expect(reread("scene=pond&planets=AQEA")).toBe("");
    expect(reread("scene=mobile&planets=2")).toBe("scene=mobile&planets=2");
  });
});
