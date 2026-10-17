// Chladni plate's code, loaded the first time the scene is needed (SceneDef.code).
import { chladniScene } from "./index.ts";
import { chladniSim } from "./sim.ts";

export { chladniGlsl as glsl } from "./shader.ts";
export const entry = "sceneChladni";
export const sim = chladniSim(chladniScene.params);
