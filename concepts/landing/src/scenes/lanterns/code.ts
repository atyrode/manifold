// Lantern river's code, loaded the first time the scene is needed (SceneDef.code).
import { lanternsScene } from "./index.ts";
import { lanternsSim } from "./sim.ts";

export { lanternsGlsl as glsl } from "./shader.ts";
export const entry = "sceneLanterns";
export const sim = lanternsSim(lanternsScene.params);
