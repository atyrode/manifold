// The knob turns the checks of knob-keyed compile-time features walk (src/shaders/index.test.ts,
// src/features.verify.ts, src/scenes/country/features.verify.ts): derived from a scene's knobs, so
// a knob added to a scene is covered without editing a list.
import type { ParamDef } from "./params.ts";
import type { SceneDef } from "./scenes/types.ts";
import { featureKey, sceneFeatures, shaderValues } from "./shaders/index.ts";

/** A knob turned from its default: a switch flipped, a range to its far end, the next choice. */
export function turned(def: ParamDef): Record<string, number> {
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

/** Each single knob turn of `scene` that changes its program's features, and all of them at once. */
export function gatedTurns(scene: SceneDef): Record<string, number>[] {
  const plain = featureKey(sceneFeatures(scene));
  const turns = scene.params
    .map(turned)
    .filter((knobs) => featureKey(sceneFeatures(scene, shaderValues(scene, knobs))) !== plain);
  return [...turns, Object.assign({}, ...turns) as Record<string, number>];
}
