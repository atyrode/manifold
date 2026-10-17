// Late bar's code, loaded the first time the scene is needed (SceneDef.code).
import { barScene } from "./index.ts";
import { barSim } from "./sim.ts";

export { barGlsl as glsl } from "./shader.ts";
export const entry = "sceneBar";
export const sim = barSim(barScene.params);
