// The code of every `outdoor` layer (outdoor.ts), by layer id: its GLSL, the GLSL it shares with its
// scene's other layers, its sim. A composed scene's code module gathers it (composer/code.ts), so it
// loads with the first composed scene's code and never with the registry.
import { apiarySim } from "../scenes/bees/beds.ts";
import { gardeningSim } from "../scenes/bees/gardening.ts";
import {
  bambooSharedGlsl,
  clockGlsl,
  culmsGlsl,
  groveFloorGlsl,
  groveGlsl,
  stoneLanternGlsl,
} from "../scenes/bamboo/shader.ts";
import { clockSim, culmsSim, groveSim } from "../scenes/bamboo/sim.ts";
import {
  autumnFloorGlsl,
  autumnSharedGlsl,
  lampGlsl,
  litterGlsl,
  mapleGlsl,
  parklandGlsl,
  parkPathGlsl,
} from "../scenes/autumn/shader.ts";
import { litterSim, mapleSim, rakeSim } from "../scenes/autumn/sim.ts";
import {
  campfireGlsl,
  campfireSharedGlsl,
  campGlsl,
  clearingGlsl,
  pinesGlsl,
  smokeGlsl,
  sparksGlsl,
} from "../scenes/campfire/shader.ts";
import { campfireSim } from "../scenes/campfire/sim.ts";
import {
  apiaryGlsl,
  beesSharedGlsl,
  gardenSharedGlsl,
  gardeningGlsl,
  hillsideGlsl,
  insectsGlsl,
  lawnGlsl,
} from "../scenes/bees/shader.ts";
import { insectsSim } from "../scenes/bees/sim.ts";
import { desertGlsl, dunesFieldGlsl, dunesSharedGlsl } from "../scenes/dunes/shader.ts";
import { dunesSim } from "../scenes/dunes/sim.ts";
import {
  lanternsGlsl,
  lanternsSharedGlsl,
  riverGlsl,
  templeGlsl,
} from "../scenes/lanterns/shader.ts";
import { lanternsSim } from "../scenes/lanterns/sim.ts";
import {
  cliffGlsl,
  fallsSharedGlsl,
  fallsWaterGlsl,
  greeneryGlsl,
  poolGlsl,
  sprayGlsl,
} from "../scenes/falls/shader.ts";
import { greenerySim } from "../scenes/falls/sim.ts";
import {
  forestFloorGlsl,
  forestSharedGlsl,
  kodamaGlsl,
  shrineGlsl,
  undergrowthGlsl,
  woodsGlsl,
} from "../scenes/forest/shader.ts";
import { kodamaSim } from "../scenes/forest/sim.ts";
import { farShoreGlsl, lakeGlsl, lakeNightGlsl } from "../scenes/lake/shader.ts";
import { farShoreSim, lakeSim } from "../scenes/lake/sim.ts";
import { boughsSim } from "../scenes/garden/boughs.ts";
import { gravelSim } from "../scenes/garden/gravel.ts";
import { borderSim, templeWoodsSim } from "../scenes/garden/planting.ts";
import { rakingSim } from "../scenes/garden/raking.ts";
import {
  borderGlsl,
  boughsGlsl,
  gravelGlsl,
  stoneGardenSharedGlsl,
  templeWallGlsl,
  templeWoodsGlsl,
} from "../scenes/garden/shader.ts";
import {
  creekGlsl,
  firefliesSharedGlsl,
  fireflySwarmGlsl,
  mangrovesGlsl,
} from "../scenes/fireflies/shader.ts";
import { fireflySwarmSim, mangrovesSim } from "../scenes/fireflies/sim.ts";
import { dandelionsGlsl, downsGlsl, grassGlsl, meadowSharedGlsl } from "../scenes/meadow/shader.ts";
import { dandelionsSim, grassSim } from "../scenes/meadow/sim.ts";
import { wildflowersGlsl, wildflowersSim } from "../scenes/meadow/wildflowers.ts";
import {
  beachGlsl,
  cairnsGlsl,
  fishGlsl,
  seaGlsl,
  shoreSharedGlsl,
} from "../scenes/shore/shader.ts";
import { cairnsSim, seaSim } from "../scenes/shore/sim.ts";
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
/** The shore's light, air and surf (shore/shader.ts), set by the sea's begin: held by its layers. */
const SHORE: SharedGlsl = { id: "shore", glsl: () => shoreSharedGlsl };
/** The dune sea's constants, light, camera and air (dunes/shader.ts), held by the desert and the dune field. */
const DUNE_SEA: SharedGlsl = { id: "duneSea", glsl: () => dunesSharedGlsl, begin: "dunesCell" };
/** The park's layout, light, season and leaves (autumn/shader.ts), held by each of its drawing layers. */
const AUTUMN: SharedGlsl = { id: "autumn", glsl: () => autumnSharedGlsl, begin: "autumnBegin" };
/** The park's floor, held by its ground and its litter: it runs after the backdrop's begin. */
const AUTUMN_FLOOR: SharedGlsl = {
  id: "autumnFloor",
  glsl: () => autumnFloorGlsl,
  begin: "autumnFloorBegin",
};
/** The lantern river's constants, light and water (lanterns/shader.ts), held by each of its layers. */
const LANTERNS: SharedGlsl = {
  id: "lanterns",
  glsl: () => lanternsSharedGlsl,
  begin: "lanternsBegin",
};
/** The gorge's constants, light and shapes (falls/shader.ts), held by each of its layers after the plants (its ledge ferns are fronds). */
const FALLS: SharedGlsl = { id: "falls", glsl: () => fallsSharedGlsl, begin: "fallsBegin" };
/** The campfire's layout, light and fire (campfire/shader.ts), held by each of its layers. */
const CAMPFIRE: SharedGlsl = {
  id: "campfire",
  glsl: () => campfireSharedGlsl,
  begin: "campfireBegin",
};
/** The bamboo grove's constants, light and shapes (bamboo/shader.ts), held by each of its layers. */
const BAMBOO: SharedGlsl = { id: "bamboo", glsl: () => bambooSharedGlsl, begin: "bambooBegin" };
/** The forest's constants, light, mist and layout (forest/shader.ts), held by each of its layers. */
const FOREST: SharedGlsl = { id: "forest", glsl: () => forestSharedGlsl, begin: "forestBegin" };
/** The lake's night (lake/shader.ts), set by the far shore's begin: held by the far shore and the lake. */
const LAKE_NIGHT: SharedGlsl = { id: "lakeNight", glsl: () => lakeNightGlsl };
/** The stone garden's constants, light and cell (garden/shader.ts), held by each of its drawing layers after the plants (its woods and border are plant records). */
const STONE_GARDEN: SharedGlsl = {
  id: "stoneGarden",
  glsl: () => stoneGardenSharedGlsl,
  begin: "stoneGardenBegin",
};
/** The mangrove river's constants and per-cell state (fireflies/shader.ts), held by each of its layers after the plants (its prop roots are records). */
const FIREFLIES: SharedGlsl = {
  id: "fireflies",
  glsl: () => firefliesSharedGlsl,
  begin: "firefliesBegin",
};

export const OUTDOOR_CODE: Readonly<Record<string, LayerCode>> = {
  downs: { glsl: () => downsGlsl, shared: [MEADOW] },
  hillside: { glsl: () => hillsideGlsl, shared: [BEES] },
  desert: { glsl: () => desertGlsl, shared: [DUNE_SEA] },
  parkland: { glsl: () => parklandGlsl, shared: [AUTUMN] },
  temple: { glsl: () => templeGlsl, shared: [LANTERNS] },
  cliff: { glsl: () => cliffGlsl, shared: [PLANTS, FALLS] },
  farShore: { glsl: () => farShoreGlsl, shared: [LAKE_NIGHT], sim: farShoreSim },
  mangroves: { glsl: () => mangrovesGlsl, shared: [PLANTS, FIREFLIES], sim: mangrovesSim },
  lawn: { glsl: () => lawnGlsl, shared: [BEES, GARDEN] },
  apiary: { glsl: () => apiaryGlsl, shared: [BEES, GARDEN], sim: apiarySim },
  dunes: { glsl: () => dunesFieldGlsl, shared: [DUNE_SEA], sim: dunesSim },
  parkPath: { glsl: () => parkPathGlsl, shared: [AUTUMN, AUTUMN_FLOOR] },
  lamp: { glsl: () => lampGlsl, shared: [AUTUMN] },
  maple: { glsl: () => mapleGlsl, shared: [AUTUMN], sim: mapleSim },
  river: { glsl: () => riverGlsl, shared: [LANTERNS] },
  pool: { glsl: () => poolGlsl, shared: [PLANTS, FALLS] },
  lake: { glsl: () => lakeGlsl, shared: [LAKE_NIGHT], sim: lakeSim },
  creek: { glsl: () => creekGlsl, shared: [FIREFLIES] },
  falls: { glsl: () => fallsWaterGlsl, shared: [PLANTS, FALLS] },
  spray: { glsl: () => sprayGlsl, shared: [PLANTS, FALLS] },
  grass: { glsl: () => grassGlsl, shared: [MEADOW], sim: grassSim },
  wildflowers: { glsl: () => wildflowersGlsl, shared: [MEADOW, PLANTS], sim: wildflowersSim },
  litter: { glsl: () => litterGlsl, shared: [AUTUMN, AUTUMN_FLOOR], sim: litterSim },
  greenery: { glsl: () => greeneryGlsl, shared: [PLANTS, FALLS], sim: greenerySim },
  dandelions: { glsl: () => dandelionsGlsl, shared: [MEADOW], sim: dandelionsSim },
  insects: { glsl: () => insectsGlsl, shared: [BEES], sim: insectsSim },
  gardening: { glsl: () => gardeningGlsl, shared: [BEES, GARDEN], sim: gardeningSim },
  sea: { glsl: () => seaGlsl, shared: [SHORE], sim: seaSim },
  beach: { glsl: () => beachGlsl, shared: [SHORE] },
  fish: { glsl: () => fishGlsl, shared: [SHORE] },
  cairns: { glsl: () => cairnsGlsl, shared: [SHORE], sim: cairnsSim },
  rake: { glsl: () => "", sim: rakeSim },
  lanterns: { glsl: () => lanternsGlsl, shared: [LANTERNS], sim: lanternsSim },
  pines: { glsl: () => pinesGlsl, shared: [CAMPFIRE] },
  clearing: { glsl: () => clearingGlsl, shared: [CAMPFIRE] },
  camp: { glsl: () => campGlsl, shared: [CAMPFIRE] },
  campfire: { glsl: () => campfireGlsl, shared: [CAMPFIRE], sim: campfireSim },
  smoke: { glsl: () => smokeGlsl, shared: [CAMPFIRE] },
  sparks: { glsl: () => sparksGlsl, shared: [CAMPFIRE] },
  grove: { glsl: () => groveGlsl, shared: [BAMBOO], sim: groveSim },
  groveFloor: { glsl: () => groveFloorGlsl, shared: [BAMBOO] },
  culms: { glsl: () => culmsGlsl, shared: [BAMBOO], sim: culmsSim },
  stoneLantern: { glsl: () => stoneLanternGlsl, shared: [BAMBOO] },
  clock: { glsl: () => clockGlsl, shared: [BAMBOO], sim: clockSim },
  woods: { glsl: () => woodsGlsl, shared: [FOREST] },
  forestFloor: { glsl: () => forestFloorGlsl, shared: [FOREST] },
  shrine: { glsl: () => shrineGlsl, shared: [FOREST] },
  undergrowth: { glsl: () => undergrowthGlsl, shared: [FOREST] },
  kodama: { glsl: () => kodamaGlsl, shared: [FOREST], sim: kodamaSim },
  templeWall: { glsl: () => templeWallGlsl, shared: [PLANTS, STONE_GARDEN] },
  gravel: { glsl: () => gravelGlsl, shared: [PLANTS, STONE_GARDEN], sim: gravelSim },
  templeWoods: { glsl: () => templeWoodsGlsl, shared: [PLANTS, STONE_GARDEN], sim: templeWoodsSim },
  boughs: { glsl: () => boughsGlsl, shared: [PLANTS, STONE_GARDEN], sim: boughsSim },
  border: { glsl: () => borderGlsl, shared: [PLANTS, STONE_GARDEN], sim: borderSim },
  raking: { glsl: () => "", sim: rakingSim },
  fireflySwarm: { glsl: () => fireflySwarmGlsl, shared: [FIREFLIES], sim: fireflySwarmSim },
};
