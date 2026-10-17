// Sand table's code, loaded the first time the scene is needed (SceneDef.code).
import { sandtableScene } from "./index.ts";
import { sandtableSim } from "./sim.ts";

export { sandtableGlsl as glsl } from "./shader.ts";
export const entry = "sceneSandtable";
export const sim = sandtableSim(sandtableScene.params);
