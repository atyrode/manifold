// The `outdoor` composer (ADR 0062): a pinhole on the ground, and its layers in canonical order, the
// order they are placed in and paint in (README "Layers"). The manifests alone: their code is in
// outdoor-code.ts, which a composed scene's code module loads.
//   backdrops  downs (meadow), hillside (bees), sea (shore), desert (dunes), parkland (autumn),
//              temple (lanterns), cliff (falls)
//   grounds    lawn (bees), beach (shore), dunes (dunes), parkPath (autumn), river (lanterns),
//              pool (falls)
//   dressings  apiary (bees), lamp, maple (autumn), falls and spray (falls)
//   covers     grass, wildflowers (meadow), litter (autumn), greenery (falls)
//   dressing   dandelions (meadow), after the covers: its clocks stand in the grass
//   life       insects (bees), fish (shore), lanterns (lanterns)
//   chores     gardening (bees: on the apiary's beds), cairns (shore), rake (autumn)
import {
  apiaryLayer,
  gardeningLayer,
  hillsideLayer,
  insectsLayer,
  lawnLayer,
} from "../scenes/bees/layers.ts";
import { desertLayer, dunesLayer } from "../scenes/dunes/layers.ts";
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
    lawnLayer,
    beachLayer,
    dunesLayer,
    parkPathLayer,
    riverLayer,
    poolLayer,
    apiaryLayer,
    lampLayer,
    mapleLayer,
    fallsLayer,
    sprayLayer,
    grassLayer,
    wildflowersLayer,
    litterLayer,
    greeneryLayer,
    dandelionsLayer,
    insectsLayer,
    fishLayer,
    lanternsLayer,
    gardeningLayer,
    cairnsLayer,
    rakeLayer,
  ],
};
