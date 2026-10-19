// Harmonograph's code, loaded the first time the scene is needed (SceneDef.code).
import { harmonographScene } from "./index.ts";
import { harmonographSim } from "./sim.ts";

export { harmonographGlsl as glsl } from "./shader.ts";
export const entry = "sceneHarmonograph";
export const sim = harmonographSim(harmonographScene.params);
