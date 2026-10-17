// Countryside's code, loaded the first time the scene is needed (SceneDef.code).
import { countryScene } from "./index.ts";
import { countrySim } from "./sim.ts";

export { countryGlsl as glsl } from "./shader.ts";
export const entry = "sceneCountry";
export const sim = countrySim(countryScene.params);
