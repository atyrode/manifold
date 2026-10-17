// Fractals's code, loaded the first time the scene is needed (SceneDef.code).
import { fractalScene } from "./index.ts";
import { fractalSim } from "./sim.ts";

export { fractalGlsl as glsl } from "./shader.ts";
export const entry = "sceneFractal";
export const sim = fractalSim(fractalScene.params);
