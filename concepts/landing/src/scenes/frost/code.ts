// Frost's code, loaded the first time the scene is needed (SceneDef.code).
import { frostScene } from "./index.ts";
import { frostSim } from "./sim.ts";

export { frostGlsl as glsl } from "./shader.ts";
export const entry = "sceneFrost";
export const sim = frostSim(frostScene.params);
