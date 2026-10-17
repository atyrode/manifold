// Tide pool's code, loaded the first time the scene is needed (SceneDef.code).
import { tidepoolScene } from "./index.ts";
import { tidepoolSim } from "./sim.ts";

export { tidepoolGlsl as glsl } from "./shader.ts";
export const entry = "sceneTidepool";
export const sim = tidepoolSim(tidepoolScene.params);
