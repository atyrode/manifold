// Dunes's code, loaded the first time the scene is needed (SceneDef.code).
import { dunesScene } from "./index.ts";
import { dunesSim } from "./sim.ts";

export { dunesGlsl as glsl } from "./shader.ts";
export const entry = "sceneDunes";
export const sim = dunesSim(dunesScene.params);
