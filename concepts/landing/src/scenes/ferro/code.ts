// Ferrofluid's code, loaded the first time the scene is needed (SceneDef.code).
import { ferroScene } from "./index.ts";
import { ferroSim } from "./sim.ts";

export { ferroGlsl as glsl } from "./shader.ts";
export const entry = "sceneFerro";
export const sim = ferroSim(ferroScene.params);
