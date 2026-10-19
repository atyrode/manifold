// Patch's code, loaded the first time the scene is needed (SceneDef.code): assembled from the code
// of every layer its rig offers (composer/overhead-glsl.ts).
import { OVERHEAD_CODE } from "../../composer/overhead-code.ts";
import { overheadCode } from "../../composer/overhead-glsl.ts";
import { patchComposed } from "./index.ts";

export const { glsl, entry, glslFor, sim } = overheadCode(patchComposed, OVERHEAD_CODE);
