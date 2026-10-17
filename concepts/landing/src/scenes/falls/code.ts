// Waterfall's code, loaded the first time the scene is needed (SceneDef.code).
import type { SimFactory } from "../types.ts";
import { fallsScene } from "./index.ts";
import { fallsSim } from "./sim.ts";

export { fallsGlsl as glsl } from "./shader.ts";
export const entry = "sceneFalls";
export const sim: SimFactory = (gl) => fallsSim(gl, fallsScene.params);
