// The code of every `outdoor` layer (outdoor.ts), by layer id: its GLSL, the GLSL it shares with its
// scene's other layers, its sim. A composed scene's code module gathers it (composer/code.ts), so it
// loads with the first composed scene's code and never with the registry.
import {
  apiaryGlsl,
  beesSharedGlsl,
  gardenSharedGlsl,
  hillsideGlsl,
  insectsGlsl,
  lawnGlsl,
} from "../scenes/bees/shader.ts";
import { insectsSim } from "../scenes/bees/sim.ts";
import { dandelionsGlsl, downsGlsl, grassGlsl, meadowSharedGlsl } from "../scenes/meadow/shader.ts";
import { dandelionsSim, grassSim } from "../scenes/meadow/sim.ts";
import { wildflowersGlsl, wildflowersSim } from "../scenes/meadow/wildflowers.ts";
import { plantsGlsl } from "../shaders/lib/plants.ts";
import type { LayerCode, SharedGlsl } from "./types.ts";

/** The meadow's constants and per-cell light (shader.ts), held by each of its layers. */
const MEADOW: SharedGlsl = { id: "meadow", glsl: () => meadowSharedGlsl, begin: "meadowBegin" };
/** The garden's layout, light and skyline (bees/shader.ts), held by each of its layers. */
const BEES: SharedGlsl = { id: "bees", glsl: () => beesSharedGlsl, begin: "beesBegin" };
/** The garden's ground, held by the lawn and the apiary: it runs after the backdrop's begin. */
const GARDEN: SharedGlsl = { id: "garden", glsl: () => gardenSharedGlsl, begin: "beesGardenBegin" };
/** The rooted plants component (shaders/lib/plants.ts), once for every layer of plants it grows. */
const PLANTS: SharedGlsl = { id: "plants", glsl: () => plantsGlsl };

export const OUTDOOR_CODE: Readonly<Record<string, LayerCode>> = {
  downs: { glsl: () => downsGlsl, shared: [MEADOW] },
  hillside: { glsl: () => hillsideGlsl, shared: [BEES] },
  lawn: { glsl: () => lawnGlsl, shared: [BEES, GARDEN] },
  apiary: { glsl: () => apiaryGlsl, shared: [BEES, GARDEN] },
  grass: { glsl: () => grassGlsl, shared: [MEADOW], sim: grassSim },
  wildflowers: { glsl: () => wildflowersGlsl, shared: [MEADOW, PLANTS], sim: wildflowersSim },
  dandelions: { glsl: () => dandelionsGlsl, shared: [MEADOW], sim: dandelionsSim },
  insects: { glsl: () => insectsGlsl, shared: [BEES], sim: insectsSim },
};
