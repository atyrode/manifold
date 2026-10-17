// Fireflies's code, loaded the first time the scene is needed (SceneDef.code).
import { firefliesScene } from "./index.ts";
import { firefliesSim } from "./sim.ts";

export { firefliesGlsl as glsl } from "./shader.ts";
export const entry = "sceneFireflies";
export const sim = firefliesSim(firefliesScene.params);
