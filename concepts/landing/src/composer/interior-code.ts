// The code of every `interior` layer (interior.ts), by layer id: its GLSL, the GLSL it shares with
// its scene's other layers, its sim. A composed scene's code module gathers it (composer/code.ts), so
// it loads with the scene's code and never with the registry.
import { lavaLampGlsl, lavaSharedGlsl, paperedGlsl, sideboardGlsl } from "../scenes/lava/shader.ts";
import { lavaLampSim } from "../scenes/lava/sim.ts";
import {
  catGlsl,
  cityWindowGlsl,
  curtainGlsl,
  propsGlsl,
  sillGroundGlsl,
  sillSharedGlsl,
} from "../scenes/sill/shader.ts";
import { catSim } from "../scenes/sill/sim.ts";
import type { LayerCode } from "./types.ts";

export const INTERIOR_CODE: Readonly<Record<string, LayerCode>> = {
  cityWindow: { glsl: () => cityWindowGlsl, shared: [sillSharedGlsl] },
  papered: { glsl: () => paperedGlsl, shared: [lavaSharedGlsl] },
  sill: { glsl: () => sillGroundGlsl, shared: [sillSharedGlsl] },
  sideboard: { glsl: () => sideboardGlsl, shared: [lavaSharedGlsl] },
  props: { glsl: () => propsGlsl, shared: [sillSharedGlsl] },
  lavaLamp: { glsl: () => lavaLampGlsl, shared: [lavaSharedGlsl], sim: lavaLampSim },
  cat: { glsl: () => catGlsl, shared: [sillSharedGlsl], sim: catSim },
  curtain: { glsl: () => curtainGlsl, shared: [sillSharedGlsl] },
};
