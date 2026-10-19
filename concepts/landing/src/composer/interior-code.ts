// The code of every `interior` layer (interior.ts), by layer id: its GLSL, the GLSL it shares with
// its scene's other layers, its sim. A composed scene's code module gathers it (composer/code.ts), so
// it loads with the scene's code and never with the registry.
import {
  backBarGlsl,
  barSharedGlsl,
  boothGlsl,
  ceilingFanGlsl,
  pendantsGlsl,
  storefrontGlsl,
} from "../scenes/bar/shader.ts";
import { backBarSim } from "../scenes/bar/sim.ts";
import {
  bonsaiSharedGlsl,
  bonsaiTreeGlsl,
  standGlsl,
  verandaGlsl,
} from "../scenes/bonsai/shader.ts";
import { bonsaiTreeSim } from "../scenes/bonsai/sim.ts";
import { frostGlassGlsl, frostSharedGlsl, frostViewGlsl } from "../scenes/frost/shader.ts";
import { frostGlassSim } from "../scenes/frost/sim.ts";
import {
  incenseGlsl,
  incenseSharedGlsl,
  lowTableGlsl,
  shaftWallGlsl,
} from "../scenes/incense/shader.ts";
import { incenseLayerSim } from "../scenes/incense/sim.ts";
import { lavaLampGlsl, lavaSharedGlsl, paperedGlsl, sideboardGlsl } from "../scenes/lava/shader.ts";
import { lavaLampSim } from "../scenes/lava/sim.ts";
import { mobileSharedGlsl, quietRoomGlsl, solarMobileGlsl } from "../scenes/mobile/shader.ts";
import { solarMobileSim } from "../scenes/mobile/sim.ts";
import {
  catGlsl,
  cityWindowGlsl,
  curtainGlsl,
  propsGlsl,
  sillSharedGlsl,
} from "../scenes/sill/shader.ts";
import { catSim } from "../scenes/sill/sim.ts";
import {
  compartmentGlsl,
  nightLineGlsl,
  teaGlassGlsl,
  trainSharedGlsl,
  velvetCurtainGlsl,
} from "../scenes/train/shader.ts";
import { nightLineSim } from "../scenes/train/sim.ts";
import type { LayerCode } from "./types.ts";

export const INTERIOR_CODE: Readonly<Record<string, LayerCode>> = {
  cityWindow: { glsl: () => cityWindowGlsl, shared: [sillSharedGlsl] },
  papered: { glsl: () => paperedGlsl, shared: [lavaSharedGlsl] },
  sideboard: { glsl: () => sideboardGlsl, shared: [lavaSharedGlsl] },
  props: { glsl: () => propsGlsl, shared: [sillSharedGlsl] },
  lavaLamp: { glsl: () => lavaLampGlsl, shared: [lavaSharedGlsl], sim: lavaLampSim },
  cat: { glsl: () => catGlsl, shared: [sillSharedGlsl], sim: catSim },
  curtain: { glsl: () => curtainGlsl, shared: [sillSharedGlsl] },
  veranda: { glsl: () => verandaGlsl, shared: [bonsaiSharedGlsl] },
  stand: { glsl: () => standGlsl, shared: [bonsaiSharedGlsl] },
  bonsaiTree: { glsl: () => bonsaiTreeGlsl, shared: [bonsaiSharedGlsl], sim: bonsaiTreeSim },
  shaftWall: { glsl: () => shaftWallGlsl, shared: [incenseSharedGlsl] },
  lowTable: { glsl: () => lowTableGlsl, shared: [incenseSharedGlsl] },
  incense: { glsl: () => incenseGlsl, shared: [incenseSharedGlsl], sim: incenseLayerSim },
  frostView: { glsl: () => frostViewGlsl, shared: [frostSharedGlsl] },
  frostGlass: { glsl: () => frostGlassGlsl, shared: [frostSharedGlsl], sim: frostGlassSim },
  storefront: { glsl: () => storefrontGlsl, shared: [barSharedGlsl] },
  booth: { glsl: () => boothGlsl, shared: [barSharedGlsl] },
  backBar: { glsl: () => backBarGlsl, shared: [barSharedGlsl], sim: backBarSim },
  pendants: { glsl: () => pendantsGlsl, shared: [barSharedGlsl] },
  ceilingFan: { glsl: () => ceilingFanGlsl, shared: [barSharedGlsl] },
  nightLine: { glsl: () => nightLineGlsl, shared: [trainSharedGlsl], sim: nightLineSim },
  compartment: { glsl: () => compartmentGlsl, shared: [trainSharedGlsl] },
  teaGlass: { glsl: () => teaGlassGlsl, shared: [trainSharedGlsl] },
  velvetCurtain: { glsl: () => velvetCurtainGlsl, shared: [trainSharedGlsl] },
  quietRoom: { glsl: () => quietRoomGlsl, shared: [mobileSharedGlsl] },
  solarMobile: { glsl: () => solarMobileGlsl, shared: [mobileSharedGlsl], sim: solarMobileSim },
};
