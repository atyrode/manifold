// The canvas's code, loaded once the code of every kind its document holds has (index.ts): its
// program assembled for each feature set from the kinds it names (src/engine/program.ts), and its
// sim, which uploads the document on screen to the instance texture whenever it changes (uSim0)
// and runs its objects' sims on the motion clock into the state texture (uSim1,
// src/engine/state.ts).
import { ENGINE_ENTRY } from "../../engine/glsl.ts";
import { InstanceTexture } from "../../engine/instances.ts";
import { engineProgramGlsl } from "../../engine/program.ts";
import { engineStage } from "../../engine/stage.ts";
import { StateTexture } from "../../engine/state.ts";
import type { SimFactory } from "../types.ts";

export const entry = ENGINE_ENTRY;
export const glslFor = engineProgramGlsl;
/** The program of the document on screen as the code loaded (`glslFor` assembles each program). */
export const glsl = engineProgramGlsl(engineStage.features);

export const sim: SimFactory = (gl) => {
  const instances = new InstanceTexture(gl);
  const states = new StateTexture(gl);
  return {
    frame(frame) {
      instances.show(engineStage.doc);
      states.show(engineStage.doc, Math.max(0, frame.dt) * frame.motion, frame.budget);
      return [instances.texture, states.texture];
    },
    dispose() {
      instances.dispose();
      states.dispose();
    },
  };
};
