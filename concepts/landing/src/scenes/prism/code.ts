// Prism's code, loaded the first time the scene is needed (SceneDef.code).
import { prismScene } from "./index.ts";
import { prismSim } from "./sim.ts";

export { prismGlsl as glsl } from "./shader.ts";
export const entry = "scenePrism";
export const sim = prismSim(prismScene.params);
