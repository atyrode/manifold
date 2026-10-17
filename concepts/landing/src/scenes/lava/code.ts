// Lava lamp's code, loaded the first time the scene is needed (SceneDef.code).
import { lavaScene } from "./index.ts";
import { lavaSim } from "./sim.ts";

export { lavaGlsl as glsl } from "./shader.ts";
export const entry = "sceneLava";
export const sim = lavaSim(lavaScene.params);
