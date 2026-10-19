// Pearl's code, loaded the first time the scene is needed (SceneDef.code).
import { pearlScene } from "./index.ts";
import { pearlSim } from "./sim.ts";

export { pearlGlsl as glsl } from "./shader.ts";
export const entry = "scenePearl";
export const sim = pearlSim(pearlScene.params);
