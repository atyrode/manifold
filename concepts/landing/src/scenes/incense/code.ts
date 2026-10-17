// Incense's code, loaded the first time the scene is needed (SceneDef.code).
import { incenseScene } from "./index.ts";
import { incenseSim } from "./sim.ts";

export { incenseGlsl as glsl } from "./shader.ts";
export const entry = "sceneIncense";
export const sim = incenseSim(incenseScene.params);
