// Frozen lake's code, loaded the first time the scene is needed (SceneDef.code).
import { lakeScene } from "./index.ts";
import { lakeSim } from "./sim.ts";

export { lakeGlsl as glsl } from "./shader.ts";
export const entry = "sceneLake";
export const sim = lakeSim(lakeScene.params);
