// The `overhead` composer (ADR 0062 Phase 4): a patch seen straight down, and its layers in
// canonical order, the order they are placed in and paint in (README "The overhead composer"). The
// manifests alone: their code is in overhead-code.ts, which a composed scene's code module loads.
//   beds       pondBed (pond), tank (ripple)
//   waters     pondWater (pond), tankWater (ripple: the wave sim)
//   dressings  stone (pond)
//   covers     border (pond)
//   life       koi (pond; offered to the ripple tank too)
import {
  borderLayer,
  koiLayer,
  pondBedLayer,
  pondWaterLayer,
  stoneLayer,
} from "../scenes/pond/layers.ts";
import { tankLayer, tankWaterLayer } from "../scenes/ripple/layers.ts";
import type { Composer } from "./compose.ts";

export const overhead: Composer = {
  id: "overhead",
  layers: [
    pondBedLayer,
    tankLayer,
    pondWaterLayer,
    tankWaterLayer,
    stoneLayer,
    borderLayer,
    koiLayer,
  ],
};
