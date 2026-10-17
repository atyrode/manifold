// Murmuration's code, loaded the first time the scene is needed (SceneDef.code).
import { flockScene } from "./index.ts";
import { flockSim } from "./sim.ts";

export { flockGlsl as glsl } from "./shader.ts";
export const entry = "sceneFlock";
export const sim = flockSim(flockScene.params);
