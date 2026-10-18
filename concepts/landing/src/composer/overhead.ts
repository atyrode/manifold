// The `overhead` composer (ADR 0062 Phase 4): a patch seen straight down, and its layers in
// canonical order, the order they are placed in and paint in (README "The overhead composer"). The
// manifests alone: their code is in overhead-code.ts, which a composed scene's code module loads.
//   beds       pondBed (pond), tank (ripple), rockPool (tidepool), sandBed (sandtable)
//   waters     pondWater (pond), tankWater (ripple: the wave sim), surge (tidepool: shallow water)
//   dressings  stone (pond), tableLamp, ball, pendulum (sandtable: the lamp, then the machines,
//              whose begins shade it)
//   covers     border (pond)
//   life       koi (pond; offered to the ripple tank too), fronds, anemones, fish (tidepool)
import {
  borderLayer,
  koiLayer,
  pondBedLayer,
  pondWaterLayer,
  stoneLayer,
} from "../scenes/pond/layers.ts";
import { tankLayer, tankWaterLayer } from "../scenes/ripple/layers.ts";
import {
  ballLayer,
  pendulumLayer,
  sandBedLayer,
  tableLampLayer,
} from "../scenes/sandtable/layers.ts";
import {
  anemonesLayer,
  frondsLayer,
  rockPoolLayer,
  surgeLayer,
  tidepoolFishLayer,
} from "../scenes/tidepool/layers.ts";
import type { Composer } from "./compose.ts";

export const overhead: Composer = {
  id: "overhead",
  layers: [
    pondBedLayer,
    tankLayer,
    rockPoolLayer,
    sandBedLayer,
    pondWaterLayer,
    tankWaterLayer,
    surgeLayer,
    stoneLayer,
    tableLampLayer,
    ballLayer,
    pendulumLayer,
    borderLayer,
    koiLayer,
    frondsLayer,
    anemonesLayer,
    tidepoolFishLayer,
  ],
};
