// campfire's code, loaded the first time the scene is needed (SceneDef.code).
import { campfireScene } from "./index.ts";
import { campfireSim } from "./sim.ts";

export { campfireGlsl as glsl } from "./shader.ts";
export const entry = "sceneCampfire";
export const sim = campfireSim(campfireScene.params);
