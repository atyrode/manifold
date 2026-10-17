// Meadow's code, loaded the first time the scene is needed (SceneDef.code).
import { meadowScene } from "./index.ts";
import { meadowSim } from "./sim.ts";
import { meadowFlowersSim } from "./wildflowers.ts";

export { meadowGlsl as glsl } from "./shader.ts";
export const entry = "sceneMeadow";
export const sim = meadowFlowersSim(meadowSim(meadowScene.params), meadowScene.params);
