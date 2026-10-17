// Night train's code, loaded the first time the scene is needed (SceneDef.code).
import { trainScene } from "./index.ts";
import { trainSim } from "./sim.ts";

export { trainGlsl as glsl } from "./shader.ts";
export const entry = "sceneTrain";
export const sim = trainSim(trainScene.params);
