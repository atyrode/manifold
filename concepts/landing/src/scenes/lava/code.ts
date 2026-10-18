// Lava lamp's code, loaded the first time the scene is needed (SceneDef.code): assembled from the
// code of every layer its rig offers (composer/code.ts).
import { composedCode } from "../../composer/code.ts";
import { INTERIOR_CODE } from "../../composer/interior-code.ts";
import { lavaComposed } from "./index.ts";

export const { glsl, entry, glslFor, sim } = composedCode(lavaComposed, INTERIOR_CODE);
