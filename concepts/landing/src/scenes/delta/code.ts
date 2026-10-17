// Delta's code, loaded the first time the scene is needed (SceneDef.code).
import { deltaScene } from "./index.ts";
import { deltaSim } from "./sim.ts";

export { deltaGlsl as glsl } from "./shader.ts";
export const entry = "sceneDelta";
export const sim = deltaSim(deltaScene.params);
