// A composed scene's code (README "Scene presets and keys"): what its `code.ts` exports, assembled
// from the code of every layer the preset offers (LayerCode, by layer id) and the scene's
// composition (compose.ts). `glslFor(features)` builds the program of the layers that feature set's
// LAYER_<ID> gates hold, placed as the setting places them (glsl.ts), steady or drawing their turns
// as its TURNS_GATE says; `glsl` is the one at the scene's defaults; `sim` the composed sim
// (sim.ts), which follows the program on screen. A scene whose `code.ts` draws some feature sets
// with a program of its own (a view from above) names them (`own`): those draw no layer turns. An
// overhead preset's code is overheadCode's (overhead-glsl.ts), the same assembly over its program.
import { effective } from "../params.ts";
import type { SceneCode } from "../scenes/types.ts";
import { LevelCamera } from "../sims/camera.ts";
import { TURNS_GATE, WORLD_TRIGGERS, type ComposedScene } from "./compose.ts";
import { COMPOSER_ENTRY, composedGlsl } from "./glsl.ts";
import { roomFrame, roomGlsl, type RoomAssembly } from "./room.ts";
import { allocate, composedSim } from "./sim.ts";
import type { LayerCode } from "./types.ts";

export class ComposedCodeError extends Error {}

/**
 * The scene's code from every offered layer's (by id); throws for a layer left out. `own`: the
 * feature sets the scene's `code.ts` draws with a program of its own instead of `glslFor`'s.
 */
export function composedCode(
  scene: ComposedScene,
  codes: Readonly<Record<string, LayerCode>>,
  own: (features: Readonly<Record<string, number>>) => boolean = () => false,
): Required<SceneCode> {
  const preset = scene.preset;
  if (preset.composer === "overhead")
    throw new ComposedCodeError(`scene ${preset.id}: an overhead preset's code is overheadCode's`);
  const codeOf = (id: string): LayerCode => {
    const code = codes[id];
    if (code === undefined)
      throw new ComposedCodeError(`scene ${preset.id}: no code for its layer ${id}`);
    return code;
  };
  for (const layer of scene.offered) codeOf(layer.id);
  const gust = { slot: WORLD_TRIGGERS.gusts, shape: preset.rig.passage?.gust };
  const interior = preset.composer === "interior";
  const glslFor = (features: Readonly<Record<string, number>>): string => {
    const on = new Set<string>();
    for (const [name, value] of Object.entries(features)) {
      const id = scene.gates[name];
      if (id !== undefined && value === 1) on.add(id);
    }
    const placement = scene.place(on);
    const layers = placement.layers.map((placed) => placed.layer);
    const assembly: RoomAssembly = {
      preset,
      layers: layers.map((def) => ({ def, code: codeOf(def.id) })),
      claims: placement.claims,
      placed: placement.layers,
      allocation: allocate(layers),
      triggers: scene.triggers,
      gust,
      rewrite: scene.rewrite(layers),
      turns: features[TURNS_GATE] === 1,
    };
    return interior ? roomGlsl(assembly) : composedGlsl(assembly);
  };
  const params = scene.def.params;
  const defaults = Object.fromEntries(params.map((knob) => [knob.key, effective(knob, {})]));
  return {
    glsl: glslFor(scene.def.featuresFor?.(defaults) ?? {}),
    entry: COMPOSER_ENTRY,
    glslFor,
    sim: composedSim({
      params,
      camera: new LevelCamera({
        horizon: preset.rig.horizon,
        eye: preset.rig.eye,
        focal: preset.rig.focal,
      }),
      minAspect: preset.rig.minAspect,
      gates: scene.gates,
      placement: scene.placed,
      sims: Object.fromEntries(scene.offered.map((layer) => [layer.id, codes[layer.id]?.sim])),
      shortParams: scene.shortParams,
      gust: interior ? undefined : gust,
      rigLift: preset.rig.passage?.lift ?? (() => 0),
      offered: scene.offered,
      drawsTurns: (features) => features[TURNS_GATE] === 1 && !own(features),
      ...(interior ? { room: roomFrame(preset) } : {}),
    }),
  };
}
