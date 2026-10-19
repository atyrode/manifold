// Soap film's code, loaded the first time the scene is needed (SceneDef.code).
import { filmScene } from "./index.ts";
import { filmSim } from "./sim.ts";

export { filmGlsl as glsl } from "./shader.ts";
export const entry = "sceneFilm";
export const sim = filmSim(filmScene.params);
