// Mobile's code, loaded the first time the scene is needed (SceneDef.code).
import { mobileScene } from "./index.ts";
import { mobileSim } from "./sim.ts";

export { mobileSceneGlsl as glsl } from "./shader.ts";
export const entry = "sceneMobile";
export const sim = mobileSim(mobileScene.params);
