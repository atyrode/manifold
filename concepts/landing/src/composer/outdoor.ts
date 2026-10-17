// The `outdoor` composer (ADR 0062): a pinhole on the ground, and its layers in canonical order, the
// order they are placed in and paint in (README "Layers"). The manifests alone: their code is in
// outdoor-code.ts, which a composed scene's code module loads.
//   backdrops  downs (meadow), hillside (bees)
//   ground     lawn (bees)
//   dressing   apiary (bees)
//   covers     grass, wildflowers (meadow)
//   dressing   dandelions (meadow), after the covers: its clocks stand in the grass
//   life       insects (bees)
import { apiaryLayer, hillsideLayer, insectsLayer, lawnLayer } from "../scenes/bees/layers.ts";
import {
  dandelionsLayer,
  downsLayer,
  grassLayer,
  wildflowersLayer,
} from "../scenes/meadow/layers.ts";
import type { Composer } from "./compose.ts";

export const outdoor: Composer = {
  id: "outdoor",
  layers: [
    downsLayer,
    hillsideLayer,
    lawnLayer,
    apiaryLayer,
    grassLayer,
    wildflowersLayer,
    dandelionsLayer,
    insectsLayer,
  ],
};
