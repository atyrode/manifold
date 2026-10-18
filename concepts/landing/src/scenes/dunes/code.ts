// Dunes's code, loaded the first time the scene is needed (SceneDef.code): assembled from the code
// of every layer its rig offers (composer/code.ts); a feature set holding DUNES_OVERHEAD (the dune
// field's camera at 1, index.ts) is the view from straight above instead, the dunes' own program,
// reading the dune field's two fields where the composed sim puts them for that layer set. It draws
// no layer turns: a layer turned there swaps the program once the setting's is built.
import { composedCode } from "../../composer/code.ts";
import { OUTDOOR_CODE } from "../../composer/outdoor-code.ts";
import { allocate } from "../../composer/sim.ts";
import { DUNES_OVERHEAD } from "./constants.ts";
import { dunesComposed } from "./index.ts";
import { dunesAboveGlsl } from "./shader.ts";

const composed = composedCode(
  dunesComposed,
  OUTDOOR_CODE,
  (features) => features[DUNES_OVERHEAD] === 1,
);

export const { glsl, entry, sim } = composed;

export function glslFor(features: Readonly<Record<string, number>>): string {
  if (features[DUNES_OVERHEAD] !== 1) return composed.glslFor(features);
  const on = new Set(
    Object.entries(dunesComposed.gates)
      .filter(([gate]) => features[gate] === 1)
      .map(([, id]) => id),
  );
  const layers = dunesComposed.place(on).layers.map((placed) => placed.layer);
  return dunesAboveGlsl(allocate(layers).fields["dunes"] ?? []);
}
