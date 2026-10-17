// Marbling's code, loaded the first time the scene is needed (SceneDef.code).
import { marbleScene } from "./index.ts";
import { marbleSim } from "./sim.ts";

export { marbleGlsl as glsl } from "./shader.ts";
export const entry = "sceneMarble";
export const sim = marbleSim(marbleScene.params);
