// Petri dish's code, loaded the first time the scene is needed (SceneDef.code).
import { petriScene } from "./index.ts";
import { petriSim } from "./sim.ts";

export { petriGlsl as glsl } from "./shader.ts";
export const entry = "scenePetri";
export const sim = petriSim(petriScene.params);
