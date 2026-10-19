// Shan shui's code, loaded the first time the scene is needed (SceneDef.code).
import { shanshuiScene } from "./index.ts";
import { shanshuiSim } from "./sim.ts";

export { shanshuiGlsl as glsl } from "./shader.ts";
export const entry = "sceneShanshui";
export const sim = shanshuiSim(shanshuiScene.params);
