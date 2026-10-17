// The Bees scene's code, loaded the first time the scene is needed (SceneDef.code).
import { beesScene } from "./index.ts";
import { beesSim } from "./sim.ts";

export { beesGlsl as glsl } from "./shader.ts";
export const entry = "sceneBees";
export const sim = beesSim(beesScene.params);
