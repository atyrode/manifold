// Stone garden's code, loaded the first time the scene is needed (SceneDef.code): assembled from the
// code of every layer its rig offers (composer/code.ts); a feature set holding GARDEN_OVERHEAD (the
// gravel's camera at 1, index.ts) is the view from straight above instead, the garden's own program,
// reading the layers' data where the composed sim puts them for that layer set. It draws no layer
// turns: a layer turned there swaps the program once the setting's is built.
import { composedCode } from "../../composer/code.ts";
import { OUTDOOR_CODE } from "../../composer/outdoor-code.ts";
import { allocate } from "../../composer/sim.ts";
import { GARDEN_OVERHEAD } from "./constants.ts";
import { gardenComposed } from "./index.ts";
import { gardenAboveGlsl } from "./shader.ts";

const composed = composedCode(
  gardenComposed,
  OUTDOOR_CODE,
  (features) => features[GARDEN_OVERHEAD] === 1,
);

export const { glsl, entry, sim } = composed;

export function glslFor(features: Readonly<Record<string, number>>): string {
  if (features[GARDEN_OVERHEAD] !== 1) return composed.glslFor(features);
  const on = new Set(
    Object.entries(gardenComposed.gates)
      .filter(([gate]) => features[gate] === 1)
      .map(([, id]) => id),
  );
  return gardenAboveGlsl(allocate(gardenComposed.place(on).layers.map((placed) => placed.layer)));
}
