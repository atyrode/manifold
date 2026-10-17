// Dew's code, loaded the first time the scene is needed (SceneDef.code).
import { dewScene } from "./index.ts";
import { dewSim } from "./sim.ts";

export { dewGlsl as glsl } from "./shader.ts";
export const entry = "sceneDew";
export const sim = dewSim(dewScene.params);
