// Shore's code, loaded the first time the scene is needed (SceneDef.code).
import { shoreScene } from "./index.ts";
import { shoreSim } from "./sim.ts";

export { shoreGlsl as glsl } from "./shader.ts";
export const entry = "sceneShore";
export const sim = shoreSim(shoreScene.params);
