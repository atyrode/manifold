// Ripple tank's code, loaded the first time the scene is needed (SceneDef.code).
import { rippleScene } from "./index.ts";
import { rippleSim } from "./sim.ts";

export { rippleGlsl as glsl } from "./shader.ts";
export const entry = "sceneRipple";
export const sim = rippleSim(rippleScene.params);
