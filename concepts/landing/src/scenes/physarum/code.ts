// Slime mould's code, loaded the first time the scene is needed (SceneDef.code).
import { physarumScene } from "./index.ts";
import { physarumSim } from "./sim.ts";

export { physarumGlsl as glsl } from "./shader.ts";
export const entry = "scenePhysarum";
export const sim = physarumSim(physarumScene.params);
