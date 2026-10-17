// City crossing's code, loaded the first time the scene is needed (SceneDef.code).
import { streetScene } from "./index.ts";
import { streetSim } from "./sim.ts";

export { streetGlsl as glsl } from "./shader.ts";
export const entry = "sceneStreet";
export const sim = streetSim(streetScene.params);
