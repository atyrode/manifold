// The code of every `overhead` layer (overhead.ts), by layer id: its GLSL, the GLSL it shares with
// its scene's other layers, its sim. A composed scene's code module gathers it
// (composer/overhead-glsl.ts overheadCode), so it loads with the first overhead scene's code and
// never with the registry.
import {
  deltaBedGlsl,
  deltaCloudsGlsl,
  deltaSharedGlsl,
  deltaWaterGlsl,
} from "../scenes/delta/shader.ts";
import { deltaBedSim, deltaWaterSim } from "../scenes/delta/sim.ts";
import {
  borderGlsl,
  koiGlsl,
  pondBedGlsl,
  pondSharedGlsl,
  pondWaterGlsl,
  stoneGlsl,
} from "../scenes/pond/shader.ts";
import { borderSim, koiSim, pondWaterSim } from "../scenes/pond/sim.ts";
import { rippleSharedGlsl, tankGlsl, tankWaterGlsl } from "../scenes/ripple/shader.ts";
import { tankWaterSim } from "../scenes/ripple/sim.ts";
import {
  ballGlsl,
  pendulumGlsl,
  sandBedGlsl,
  sandtableSharedGlsl,
  tableLampGlsl,
} from "../scenes/sandtable/shader.ts";
import { ballSim, pendulumSim, sandBedSim } from "../scenes/sandtable/sim.ts";
import {
  anemonesGlsl,
  frondsGlsl,
  rockPoolGlsl,
  surgeGlsl,
  tidepoolFishGlsl,
  tidepoolSharedGlsl,
} from "../scenes/tidepool/shader.ts";
import { rockPoolSim, surgeSim } from "../scenes/tidepool/sim.ts";
import type { OverheadCode } from "./overhead-glsl.ts";

export const OVERHEAD_CODE: Readonly<Record<string, OverheadCode>> = {
  pondBed: { glsl: () => pondBedGlsl },
  tank: { glsl: () => tankGlsl, shared: [rippleSharedGlsl] },
  pondWater: { glsl: () => pondWaterGlsl, shared: [pondSharedGlsl], sim: pondWaterSim },
  tankWater: { glsl: () => tankWaterGlsl, shared: [rippleSharedGlsl], sim: tankWaterSim },
  stone: { glsl: () => stoneGlsl },
  border: { glsl: () => borderGlsl, shared: [pondSharedGlsl], sim: borderSim },
  koi: { glsl: () => koiGlsl, shared: [pondSharedGlsl], sim: koiSim },
  rockPool: { glsl: () => rockPoolGlsl, shared: [tidepoolSharedGlsl], sim: rockPoolSim },
  surge: { glsl: () => surgeGlsl, shared: [tidepoolSharedGlsl], sim: surgeSim },
  fronds: { glsl: () => frondsGlsl, shared: [tidepoolSharedGlsl] },
  anemones: { glsl: () => anemonesGlsl, shared: [tidepoolSharedGlsl] },
  fish: { glsl: () => tidepoolFishGlsl, shared: [tidepoolSharedGlsl] },
  sandBed: { glsl: () => sandBedGlsl, shared: [sandtableSharedGlsl], sim: sandBedSim },
  tableLamp: { glsl: () => tableLampGlsl, shared: [sandtableSharedGlsl] },
  ball: { glsl: () => ballGlsl, shared: [sandtableSharedGlsl], sim: ballSim },
  pendulum: { glsl: () => pendulumGlsl, shared: [sandtableSharedGlsl], sim: pendulumSim },
  deltaBed: { glsl: () => deltaBedGlsl, shared: [deltaSharedGlsl], sim: deltaBedSim },
  deltaWater: { glsl: () => deltaWaterGlsl, shared: [deltaSharedGlsl], sim: deltaWaterSim },
  clouds: { glsl: () => deltaCloudsGlsl, shared: [deltaSharedGlsl] },
};
