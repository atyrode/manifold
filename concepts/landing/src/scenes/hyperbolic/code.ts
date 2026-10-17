// Hyperbolic weave's code, loaded the first time the scene is needed (SceneDef.code).
import { hyperbolicScene } from "./index.ts";
import { hyperbolicSim } from "./sim.ts";

export { hyperbolicGlsl as glsl } from "./shader.ts";
export const entry = "sceneHyperbolic";
export const sim = hyperbolicSim(hyperbolicScene.params);
