// The `outdoor` composer (ADR 0062): a pinhole on the ground, and its layers in canonical order, the
// order they are placed in and paint in (README "Layers"). The manifests alone: their code is in
// outdoor-code.ts, which a composed scene's code module loads.
//   backdrops  downs (meadow), hillside (bees), sea (shore), desert (dunes), parkland (autumn),
//              temple (lanterns), cliff (falls), mangroves (fireflies), pines (campfire), grove
//              (bamboo), woods (forest), farShore (lake), templeWall (garden)
//   grounds    lawn (bees), beach (shore), dunes (dunes), parkPath (autumn), river (lanterns),
//              pool (falls), creek (fireflies), clearing (campfire), groveFloor (bamboo),
//              forestFloor (forest), lake (lake), gravel (garden)
//   dressings  apiary (bees), lamp, maple (autumn), falls and spray (falls), camp and campfire
//              (campfire), culms, stoneLantern and clock (bamboo), shrine (forest), templeWoods
//              (garden)
//   covers     grass, wildflowers (meadow), litter (autumn), greenery (falls), undergrowth
//              (forest), border (garden)
//   dressings  dandelions (meadow), boughs (garden), after the covers: they stand or fall on them
//   life       insects (bees), fish (shore), lanterns (lanterns), fireflySwarm (fireflies), smoke
//              and sparks (campfire), kodama (forest)
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
import { creekLayer, fireflySwarmLayer, mangrovesLayer } from "../scenes/fireflies/layers.ts";
import {
  dandelionsLayer,
  downsLayer,
  grassLayer,
  wildflowersLayer,
} from "../scenes/meadow/layers.ts";
import { beachLayer, cairnsLayer, fishLayer, seaLayer } from "../scenes/shore/layers.ts";
import type { Composer } from "./compose.ts";

export const outdoor: Composer = {
  id: "outdoor",
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
    grassLayer,
    wildflowersLayer,
    litterLayer,
    greeneryLayer,
    undergrowthLayer,
    borderLayer,
    dandelionsLayer,
    boughsLayer,
    insectsLayer,
    fishLayer,
    lanternsLayer,
    smokeLayer,
    sparksLayer,
    kodamaLayer,
    fireflySwarmLayer,
    gardeningLayer,
    cairnsLayer,
    rakeLayer,
    rakingLayer,
  ],
};
