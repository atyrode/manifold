// The `outdoor` composer (ADR 0062): a pinhole on the ground, its baseline (ADR 0062 "Baselines and
// variants": the plain land every outdoor scene is to be a variant of) and its layers in canonical
// order, the order they are placed in and paint in (README "Layers"). The manifests alone: their
// code is in outdoor-code.ts, which a composed scene's code module loads.
//   backdrops  downs (meadow), hillside (bees), sea (shore), desert (dunes), parkland (autumn),
//              temple (lanterns), cliff (falls), pines (campfire), grove (bamboo), woods (forest),
//              farShore (lake), templeWall (garden), mangroves (fireflies), crossroads (skyward),
//              city (street), openSea (swell), seaSky (island), bokeh (dew), roost (flock), valley
//              (country)
//   grounds    lawn (bees), beach (shore), dunes (dunes), parkPath (autumn), river (lanterns),
//              pool (falls), clearing (campfire), groveFloor (bamboo), forestFloor (forest), lake
//              (lake), gravel (garden), creek (fireflies), crossing (street), swell (swell),
//              shallows (island), farmland (country)
//   dressings  apiary (bees), lamp, maple (autumn), falls and spray (falls), camp and campfire
//              (campfire), culms, stoneLantern and clock (bamboo), shrine (forest), templeWoods
//              (garden), streetTree and tramway (skyward), kerbside (street), lighthouse and boats
//              (swell), island (island), web (dew), waterway and settlements (country)
//   covers     grass, wildflowers (meadow), litter (autumn), greenery (falls), undergrowth
//              (forest), border (garden), verges (country)
//   dressings  dandelions (meadow), boughs (garden), after the covers: they stand or fall on them
//   life       insects (bees), fish (shore), lanterns (lanterns), smoke and sparks (campfire),
//              kodama (forest), fireflySwarm (fireflies), streetLife (street), murmuration (flock),
//              herds, travellers and starlings (country), gull and balloon (island)
//   chores     gardening (bees: on the apiary's beds), cairns (shore), rake (autumn), raking (garden)
import {
  apiaryLayer,
  gardeningLayer,
  hillsideLayer,
  insectsLayer,
  lawnLayer,
} from "../scenes/bees/layers.ts";
import {
  clockLayer,
  culmsLayer,
  groveFloorLayer,
  groveLayer,
  stoneLanternLayer,
} from "../scenes/bamboo/layers.ts";
import { desertLayer, dunesLayer } from "../scenes/dunes/layers.ts";
import {
  campfireLayer,
  campLayer,
  clearingLayer,
  pinesLayer,
  smokeLayer,
  sparksLayer,
} from "../scenes/campfire/layers.ts";
import { bokehLayer, webLayer } from "../scenes/dew/layers.ts";
import {
  lampLayer,
  litterLayer,
  mapleLayer,
  parklandLayer,
  parkPathLayer,
  rakeLayer,
} from "../scenes/autumn/layers.ts";
import { lanternsLayer, riverLayer, templeLayer } from "../scenes/lanterns/layers.ts";
import {
  cliffLayer,
  fallsLayer,
  greeneryLayer,
  poolLayer,
  sprayLayer,
} from "../scenes/falls/layers.ts";
import { farShoreLayer, lakeLayer } from "../scenes/lake/layers.ts";
import {
  forestFloorLayer,
  kodamaLayer,
  shrineLayer,
  undergrowthLayer,
  woodsLayer,
} from "../scenes/forest/layers.ts";
import {
  borderLayer,
  boughsLayer,
  gravelLayer,
  rakingLayer,
  templeWallLayer,
  templeWoodsLayer,
} from "../scenes/garden/layers.ts";
import {
  farmlandLayer,
  herdsLayer,
  settlementsLayer,
  starlingsLayer,
  travellersLayer,
  valleyLayer,
  vergesLayer,
  waterwayLayer,
} from "../scenes/country/layers.ts";
import { creekLayer, fireflySwarmLayer, mangrovesLayer } from "../scenes/fireflies/layers.ts";
import { murmurationLayer, roostLayer } from "../scenes/flock/layers.ts";
import {
  balloonLayer,
  gullLayer,
  islandLayer,
  seaSkyLayer,
  shallowsLayer,
} from "../scenes/island/layers.ts";
import {
  dandelionsLayer,
  downsLayer,
  grassLayer,
  wildflowersLayer,
} from "../scenes/meadow/layers.ts";
import { beachLayer, cairnsLayer, fishLayer, seaLayer } from "../scenes/shore/layers.ts";
import { crossroadsLayer, streetTreeLayer, tramwayLayer } from "../scenes/skyward/layers.ts";
import {
  cityLayer,
  crossingLayer,
  kerbsideLayer,
  streetLifeLayer,
} from "../scenes/street/layers.ts";
import { boatsLayer, lighthouseLayer, openSeaLayer, swellLayer } from "../scenes/swell/layers.ts";
import type { Composer } from "./compose.ts";
import type { Baseline } from "./types.ts";

export const outdoor: Composer & { readonly baseline: Baseline } = {
  id: "outdoor",
  // The plainest land: an eye standing 1.65 m over the plain floor of lawn, level, the downs
  // beyond (`downs`, its tree line at 110 m) through the meadow's lens (the horizon at 0.4, focal
  // 1.18: about 46° high), facing the staged sky's ahead; a fair-weather World mid-afternoon (the
  // World's own cloud, rooks by day), no tint, no vignette and the meadow's ink; the
  // shooting stars from where most presets set them out, a generic flyway. No light elements (a
  // link's `elements=` places lamps, candles, neon or fires on the land: composer/glsl.ts
  // `elementsGlsl`; no window, no shadowing one). The rig admits the meadow's layers and the
  // murmuration, offered as guests. Its own scene is `land`, lab-only (D13).
  baseline: {
    composer: "outdoor",
    rig: { horizon: 0.4, focal: 1.18, eye: 1.65, turn: 0, pitch: 0, minAspect: 1 },
    grade: { ink: { gain: 1.3, gamma: 1 } },
    world: {
      time: 0.62,
      birds: {
        kind: "rooks",
        help: "Birds crossing over the land by day, rooks by default, rowing in loose parties over the downs; few fly in rain or snow.",
      },
    },
    meteors: [-0.5, 0.3, 1, 0.1],
    flyway: { depth: [12, 120], above: 0.04, top: 0.95, seed: 3.1, skim: 2, spread: 1, ext: 0.004 },
    floor: "lawn",
    layers: ["downs"],
    values: {},
    elements: [],
  },
  layers: [
    downsLayer,
    hillsideLayer,
    seaLayer,
    desertLayer,
    parklandLayer,
    templeLayer,
    cliffLayer,
    pinesLayer,
    groveLayer,
    woodsLayer,
    farShoreLayer,
    templeWallLayer,
    mangrovesLayer,
    crossroadsLayer,
    cityLayer,
    openSeaLayer,
    seaSkyLayer,
    bokehLayer,
    roostLayer,
    valleyLayer,
    lawnLayer,
    beachLayer,
    dunesLayer,
    parkPathLayer,
    riverLayer,
    poolLayer,
    clearingLayer,
    groveFloorLayer,
    forestFloorLayer,
    lakeLayer,
    gravelLayer,
    creekLayer,
    crossingLayer,
    swellLayer,
    shallowsLayer,
    farmlandLayer,
    apiaryLayer,
    lampLayer,
    mapleLayer,
    fallsLayer,
    sprayLayer,
    campLayer,
    campfireLayer,
    culmsLayer,
    stoneLanternLayer,
    clockLayer,
    shrineLayer,
    templeWoodsLayer,
    streetTreeLayer,
    tramwayLayer,
    kerbsideLayer,
    lighthouseLayer,
    boatsLayer,
    islandLayer,
    webLayer,
    waterwayLayer,
    settlementsLayer,
    grassLayer,
    wildflowersLayer,
    litterLayer,
    greeneryLayer,
    undergrowthLayer,
    borderLayer,
    vergesLayer,
    dandelionsLayer,
    boughsLayer,
    insectsLayer,
    fishLayer,
    lanternsLayer,
    smokeLayer,
    sparksLayer,
    kodamaLayer,
    fireflySwarmLayer,
    streetLifeLayer,
    murmurationLayer,
    herdsLayer,
    travellersLayer,
    starlingsLayer,
    gullLayer,
    balloonLayer,
    gardeningLayer,
    cairnsLayer,
    rakeLayer,
    rakingLayer,
  ],
};
