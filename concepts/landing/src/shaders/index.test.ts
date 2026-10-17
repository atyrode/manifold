import { describe, expect, test } from "bun:test";
import { turned } from "../knob-turns.ts";
import { effective, type ParamDef } from "../params.ts";
import { sceneDefs } from "../scenes/index.ts";
import {
  fragmentSourceFor,
  LIBRARY_GATES,
  PLANETS_GATE,
  sceneFeatures,
  sceneFeaturesAll,
  settingKeyed,
  shaderValues,
} from "./index.ts";

/** Each scene's library gates: the knob that opens each, by gate. */
function gatesOf(params: readonly ParamDef[]): Record<string, string> {
  return Object.fromEntries(
    params.flatMap((def) => {
      const gate = def.widget?.kind === "night" ? LIBRARY_GATES[def.widget.part] : undefined;
      return gate === undefined ? [] : [[gate, def.key]];
    }),
  );
}

describe("library gates", () => {
  test("compile the planets in only while a scene that takes them holds any", () => {
    let takers = 0;
    for (const scene of Object.values(sceneDefs)) {
      if (scene.planets === undefined) {
        expect(sceneFeatures(scene, undefined, 3)[PLANETS_GATE]).toBeUndefined();
        continue;
      }
      takers++;
      expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({ id: scene.id, keyed: true });
      expect(sceneFeatures(scene)[PLANETS_GATE]).toBe(0);
      expect(sceneFeatures(scene, undefined, 1)[PLANETS_GATE]).toBe(1);
      expect(sceneFeaturesAll(scene)?.[PLANETS_GATE]).toBe(1);
      // Its knob gates and own features stay as they are whatever the list holds.
      const withPlanets: Readonly<Record<string, number>> = {
        ...sceneFeatures(scene, undefined, 8),
        [PLANETS_GATE]: 0,
      };
      expect(withPlanets).toEqual(sceneFeatures(scene));
    }
    expect(takers).toBeGreaterThan(0);
  });

  test("make every scene holding one knob-keyed, off at its defaults, on in its all-features set", () => {
    let gated = 0;
    for (const scene of Object.values(sceneDefs)) {
      const gates = gatesOf(scene.params);
      const keyed = Object.keys(gates).length > 0;
      if (!keyed) {
        // A scene without them keeps its feature sets as they were, and no gate.
        expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({
          id: scene.id,
          keyed: scene.featuresFor !== undefined || scene.planets !== undefined,
        });
        for (const gate of Object.values(LIBRARY_GATES))
          expect(sceneFeatures(scene)[gate]).toBeUndefined();
        continue;
      }
      gated++;
      expect({ id: scene.id, keyed: settingKeyed(scene) }).toEqual({ id: scene.id, keyed: true });
      const plain = sceneFeatures(scene);
      const all = sceneFeaturesAll(scene) ?? {};
      for (const [gate, key] of Object.entries(gates)) {
        // Off at the defaults (the knob reads 0 and the default picture compiles none of it), on
        // once its knob is.
        const def = scene.params.find((knob) => knob.key === key);
        expect({
          id: scene.id,
          gate,
          value: def === undefined ? undefined : effective(def, {}),
          plain: plain[gate],
          all: all[gate],
        }).toEqual({ id: scene.id, gate, value: 0, plain: 0, all: 1 });
        const on = sceneFeatures(scene, shaderValues(scene, { [key]: 1 }));
        expect({ id: scene.id, gate, on: on[gate] }).toEqual({ id: scene.id, gate, on: 1 });
      }
      // The defines reach the program ahead of the libraries that test them.
      const source = fragmentSourceFor(scene, all);
      for (const gate of Object.keys(gates))
        expect(source.indexOf(`#define ${gate} 1\n`)).toBeLessThan(
          source.indexOf("// ---- sky ----"),
        );
    }
    expect(gated).toBeGreaterThan(15);
  });

  test("leave each knob-keyed scene's all-features set covering every knob's turn", () => {
    // The same defines, each at least as high (a gate on, a tier at or above): the program the
    // renderer switches to for any change draws it, so the GPU checks need only sample the scenes.
    for (const scene of Object.values(sceneDefs)) {
      const most = sceneFeaturesAll(scene);
      if (most === undefined) continue;
      for (const knob of scene.params) {
        const set = sceneFeatures(scene, shaderValues(scene, turned(knob)));
        for (const [name, value] of Object.entries(set))
          expect({
            id: scene.id,
            knob: knob.key,
            name,
            covered: (most[name] ?? -Infinity) >= value,
          }).toEqual({ id: scene.id, knob: knob.key, name, covered: true });
      }
    }
  });
});
