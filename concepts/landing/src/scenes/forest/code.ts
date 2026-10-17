// Mystic forest's code, loaded the first time the scene is needed (SceneDef.code).
import { forestScene } from "./index.ts";
import { forestSim } from "./sim.ts";

export { forestGlsl as glsl } from "./shader.ts";
export const entry = "sceneForest";
export const sim = forestSim(forestScene.params);
