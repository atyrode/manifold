// Kelp forest's code, loaded the first time the scene is needed (SceneDef.code).
import { kelpScene } from "./index.ts";
import { kelpSim } from "./sim.ts";

export { kelpGlsl as glsl } from "./shader.ts";
export const entry = "sceneKelp";
export const sim = kelpSim(kelpScene.params);
