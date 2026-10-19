// The canvas's code, loaded once the code of every kind its document holds has (index.ts): its
// program assembled for each feature set from the kinds it names (src/engine/program.ts), and its
// sim, which uploads the document on screen to the instance texture whenever it changes.
import { ENGINE_ENTRY } from "../../engine/glsl.ts";
import { InstanceTexture } from "../../engine/instances.ts";
import { engineProgramGlsl } from "../../engine/program.ts";
import { engineStage } from "../../engine/stage.ts";
import type { SimFactory } from "../types.ts";

export const entry = ENGINE_ENTRY;
export const glslFor = engineProgramGlsl;
/** The program of the document on screen as the code loaded (`glslFor` assembles each program). */
export const glsl = engineProgramGlsl(engineStage.features);

export const sim: SimFactory = (gl) => {
  const instances = new InstanceTexture(gl);
  return {
    frame() {
      instances.show(engineStage.doc);
      return [instances.texture];
    },
    dispose() {
      instances.dispose();
    },
  };
};
