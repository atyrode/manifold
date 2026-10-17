// Bamboo grove's code, loaded the first time the scene is needed (SceneDef.code).
import { bambooScene } from "./index.ts";
import { bambooSim } from "./sim.ts";

export { bambooGlsl as glsl } from "./shader.ts";
export const entry = "sceneBamboo";
export const sim = bambooSim(bambooScene.params);
