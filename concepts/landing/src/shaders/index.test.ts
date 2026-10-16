import { describe, expect, test } from "bun:test";
import type { ParamDef } from "../params.ts";
import { sceneDefs } from "../scenes/index.ts";
import {
  fragmentSourceFor,
  knobKeyed,
  LIBRARY_GATES,
  sceneFeatures,
  sceneFeaturesAll,
  shaderValues,
} from "./index.ts";

/** A knob turned from its default: a switch flipped, a range to its far end, the next choice. */
function turned(def: ParamDef): Record<string, number> {
  switch (def.kind) {
    case "toggle":
      return { [def.key]: def.value > 0.5 ? 0 : 1 };
    case "feature":
      return { [def.key]: def.on ? 0 : 1 };
    case "range":
      return { [def.key]: def.value >= def.max ? def.min : def.max };
    case "choice": {
      const at = def.options.findIndex((option) => option.value === def.value);
      return { [def.key]: def.options[(at + 1) % def.options.length]?.value ?? def.value };
    }
    case "seed":
      return { [def.key]: def.value + 1 };
    default: {
      const unreachable: never = def;
      throw new Error(`unknown knob ${String(unreachable)}`);
    }
  }
}

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
  test("gate the constellations and the giant planet", () => {
    expect(LIBRARY_GATES).toEqual({ constellations: "SKY_FIGURES", giant: "SKY_GIANT" });
  });

  test("make every scene holding one knob-keyed, off at its defaults, on in its all-features set", () => {
    let gated = 0;
    for (const scene of Object.values(sceneDefs)) {
      const gates = gatesOf(scene.params);
      const keyed = Object.keys(gates).length > 0;
      if (!keyed) {
        // A scene without them keeps its feature sets as they were, and no gate.
        expect({ id: scene.id, keyed: knobKeyed(scene) }).toEqual({
          id: scene.id,
          keyed: scene.featuresFor !== undefined,
        });
        for (const gate of Object.values(LIBRARY_GATES))
          expect(sceneFeatures(scene)[gate]).toBeUndefined();
        continue;
      }
      gated++;
      expect({ id: scene.id, keyed: knobKeyed(scene) }).toEqual({ id: scene.id, keyed: true });
      const plain = sceneFeatures(scene);
      const all = sceneFeaturesAll(scene) ?? {};
      for (const [gate, key] of Object.entries(gates)) {
        // Off at the defaults (the default picture compiles none of it), on once its knob is.
        expect({ id: scene.id, gate, plain: plain[gate], all: all[gate] }).toEqual({
          id: scene.id,
          gate,
          plain: 0,
          all: 1,
        });
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
