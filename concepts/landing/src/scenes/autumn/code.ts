// Autumn park's code, loaded the first time the scene is needed (SceneDef.code).
import { autumnScene } from "./index.ts";
import { autumnSim } from "./sim.ts";

export { autumnGlsl as glsl } from "./shader.ts";
export const entry = "sceneAutumn";
export const sim = autumnSim(autumnScene.params);
