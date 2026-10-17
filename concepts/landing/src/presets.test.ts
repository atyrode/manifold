import { describe, expect, test } from "bun:test";
import { canonicalSetup } from "./compare.ts";
import { presets } from "./presets.ts";
import { sceneDefs, type SceneId } from "./scenes/index.ts";
import { encodePlanets, PLANETS_KEY } from "./scenes/planets.ts";
import { defaults, readSetup, readState } from "./state.ts";

// A committed preset is a setup in the form the lab writes it: the Presets view lights the row
// whose query is the setup on screen, and loading a preset puts on screen that query as the page
// reads it back. A knob that changes kind or goes away changes what a query loads without a word
// (a share of 0..100 read by an on/off switch keeps only "on"), so every preset must still read as
// itself.

/**
 * The URL keys a setup of `scene` may set: the lab's settings, its knobs (a feature's amount too)
 * and its planets.
 */
function setupKeys(scene: SceneId): Set<string> {
  const def = sceneDefs[scene];
  const keys = new Set<string>(Object.keys(defaults));
  for (const knob of def.params) {
    keys.add(knob.key);
    if (knob.kind === "feature") keys.add(`${knob.key}-amount`);
  }
  if (def.planets !== undefined) keys.add(PLANETS_KEY);
  return keys;
}

describe("the committed presets", () => {
  test("name only their scene's knobs and the lab's settings", () => {
    const strays = presets.flatMap(({ name, query }) => {
      const q = new URLSearchParams(query);
      const keys = setupKeys(readState(q).scene);
      return [...q.keys()].filter((key) => !keys.has(key)).map((key) => `${name}: ${key}`);
    });
    expect(strays).toEqual([]);
  });

  test("keep every value they set through their knobs' parsing", () => {
    const changed = presets.flatMap(({ name, query }) => {
      const q = new URLSearchParams(query);
      const { state, params, planets } = readSetup(q);
      const spec = sceneDefs[state.scene].planets;
      const read: Record<string, string | number> = {
        ...state,
        ...params,
        ...(spec === undefined ? {} : { [PLANETS_KEY]: encodePlanets(spec, planets) }),
      };
      return [...q].flatMap(([key, value]) => {
        const got = read[key];
        if (got === undefined) return [];
        const kept = typeof got === "number" ? got === Number(value) : got === value;
        return kept ? [] : [`${name}: ${key}=${value} reads as ${got}`];
      });
    });
    expect(changed).toEqual([]);
  });

  test("load back as themselves, so the Presets view lights the one just applied", () => {
    const unlit = presets.flatMap(({ name, query }) => {
      const loads = canonicalSetup(new URLSearchParams(query));
      return loads === query ? [] : [{ name, query, loads }];
    });
    expect(unlit).toEqual([]);
  });
});
