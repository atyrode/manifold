// A composed scene's code (README "Scene presets and keys"): what its `code.ts` exports, assembled
// from the code of every layer the preset offers (LayerCode, by layer id) and the scene's
// composition (compose.ts). `glslFor(features)` builds the program of the layers that feature set's
// LAYER_<ID> gates hold, placed as the setting places them (glsl.ts); `glsl` is the one at the
// scene's defaults; `sim` the composed sim (sim.ts), which follows the program on screen.
import { effective } from "../params.ts";
import type { SceneCode } from "../scenes/types.ts";
import { WORLD_TRIGGERS, type ComposedScene } from "./compose.ts";
import { COMPOSER_ENTRY, composedGlsl } from "./glsl.ts";
import { allocate, composedSim } from "./sim.ts";
import type { LayerCode } from "./types.ts";

export class ComposedCodeError extends Error {}

/** The scene's code from every offered layer's (by id); throws for a layer left out. */
export function composedCode(
  scene: ComposedScene,
  codes: Readonly<Record<string, LayerCode>>,
): Required<SceneCode> {
  const preset = scene.preset;
  const codeOf = (id: string): LayerCode => {
    const code = codes[id];
    if (code === undefined)
      throw new ComposedCodeError(`scene ${preset.id}: no code for its layer ${id}`);
    return code;
  };
  for (const layer of scene.offered) codeOf(layer.id);
  const gust = { slot: WORLD_TRIGGERS.gusts, shape: preset.rig.passage?.gust };
  const glslFor = (features: Readonly<Record<string, number>>): string => {
    const on = new Set<string>();
    for (const [name, value] of Object.entries(features)) {
      const id = scene.gates[name];
      if (id !== undefined && value === 1) on.add(id);
    }
    const placement = scene.place(on);
    const layers = placement.layers.map((placed) => placed.layer);
    return composedGlsl({
      preset,
      layers: layers.map((def) => ({ def, code: codeOf(def.id) })),
      claims: placement.claims,
      allocation: allocate(layers),
      triggers: scene.triggers,
      gust,
      rewrite: scene.rewrite(layers),
    });
  };
  const params = scene.def.params;
  const defaults = Object.fromEntries(params.map((knob) => [knob.key, effective(knob, {})]));
  return {
    glsl: glslFor(scene.def.featuresFor?.(defaults) ?? {}),
    entry: COMPOSER_ENTRY,
    glslFor,
    sim: composedSim({
      params,
      rig: preset.rig,
      gates: scene.gates,
      placement: scene.placed,
      sims: Object.fromEntries(scene.offered.map((layer) => [layer.id, codes[layer.id]?.sim])),
      shortParams: scene.shortParams,
      gust,
      rigLift: preset.rig.passage?.lift ?? (() => 0),
      offered: scene.offered,
    }),
  };
}
