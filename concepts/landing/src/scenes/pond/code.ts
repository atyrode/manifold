// Pond's code, loaded the first time the scene is needed (SceneDef.code).
import type { SimFactory } from "../types.ts";
import { pondScene } from "./index.ts";
import { pondSim } from "./sim.ts";

export { pondGlsl as glsl } from "./shader.ts";
export const entry = "scenePond";
export const sim: SimFactory = (gl) => pondSim(gl, pondScene.params);
