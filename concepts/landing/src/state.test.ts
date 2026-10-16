import { describe, expect, test } from "bun:test";
import { choice, range } from "./params.ts";
import { parsePresets, presets } from "./presets.ts";
import { sceneDefs } from "./scenes/index.ts";
import type { SceneDef } from "./scenes/types.ts";
import { migrateLegacy, paramDefaults, readParams, readState, serialise } from "./state.ts";

/** A setup query as the page reads it back and writes it again: its scene's knobs, minimal. */
function reread(query: string): string {
  const q = new URLSearchParams(query);
  const state = readState(q);
  return serialise(state, readParams(state.scene, q)).toString();
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
        name: "Countryside · lavender rows",
        commit: "6e72cac6",
        query: "scene=country&season=0&crops=0&lavender=100",
        savedAt: "2026-10-14",
      }),
    );
    const committed = presets.find((preset) => preset.name === "Countryside · lavender rows");
    if (!old || !committed) throw new Error("no lavender preset");
    expect(readParams("country", new URLSearchParams(old.query))).toEqual(
      readParams("country", new URLSearchParams(committed.query)),
    );
    expect(readParams("country", new URLSearchParams(committed.query)).date).toBe(0.375);
  });
});
