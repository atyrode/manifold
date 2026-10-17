// Bonsai's code, loaded the first time the scene is needed (SceneDef.code).
import { bonsaiScene } from "./index.ts";
import { bonsaiSim } from "./sim.ts";

export { bonsaiGlsl as glsl } from "./shader.ts";
export const entry = "sceneBonsai";
export const sim = bonsaiSim(bonsaiScene.params);
