// Swell's code, loaded the first time the scene is needed (SceneDef.code): assembled from the code
// of every layer its rig offers (composer/code.ts).
import { composedCode } from "../../composer/code.ts";
import { OUTDOOR_CODE } from "../../composer/outdoor-code.ts";
import { swellComposed } from "./index.ts";

export const { glsl, entry, glslFor, sim } = composedCode(swellComposed, OUTDOOR_CODE);
