// Stone garden's code, loaded the first time the scene is needed (SceneDef.code).
import { gardenScene } from "./index.ts";
import { gardenSim } from "./sim.ts";

export { gardenGlsl as glsl } from "./shader.ts";
export const entry = "sceneGarden";
export const sim = gardenSim(gardenScene.params);
