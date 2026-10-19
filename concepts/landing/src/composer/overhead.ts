// The `overhead` composer (ADR 0062 Phase 4): a patch seen straight down, its baseline (ADR 0062
// "Baselines and variants": the plain patch every scene seen from above is a variant of) and its
// layers in canonical order, the order they are placed in and paint in (README "The overhead
// composer"). The manifests alone: their code is in overhead-code.ts, which a composed scene's code
// module loads.
//   beds       pondBed (pond), tank (ripple), rockPool (tidepool), sandBed (sandtable), deltaBed
//              (delta)
//   waters     pondWater (pond), tankWater (ripple: the wave sim), surge (tidepool: shallow water),
//              deltaWater (delta: shallow water over the bed it works)
//   dressings  stone (pond), tableLamp, ball, pendulum (sandtable: the lamp, then the machines,
//              whose begins shade it)
//   covers     border (pond), clouds (delta)
//   life       koi (pond; offered to the ripple tank too), fronds, anemones, fish (tidepool)
import { deltaBedLayer, deltaCloudsLayer, deltaWaterLayer } from "../scenes/delta/layers.ts";
import {
  borderLayer,
  koiLayer,
  POND_SPAN,
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
import type { OverheadBaseline } from "./types.ts";

export const overhead: Composer & { readonly baseline: OverheadBaseline } = {
  id: "overhead",
  // The plainest patch open to the sky: the pond's floor alone (`pondBed`), dry, its frame 3 m tall
  // (the pond's span, in fresh water), so the pond's water, stone, border and koi are offered as
  // guests and the World's hour, cloud, rain and wind are its knobs; the World's afternoon at the
  // hour the pond's colours were painted for (0.5825, its sun where the pond's old fixed sun stood),
  // against which the World's light relights them. No values of its own. Its own scene is `patch`,
  // lab-only (D13).
  baseline: {
    composer: "overhead",
    rig: { span: POND_SPAN, minAspect: 1 },
    world: { time: 0.5825 },
    painted: 0.5825,
    layers: ["pondBed"],
    values: {},
  },
  layers: [
    pondBedLayer,
    tankLayer,
    rockPoolLayer,
    sandBedLayer,
    deltaBedLayer,
    pondWaterLayer,
    tankWaterLayer,
    surgeLayer,
    deltaWaterLayer,
    stoneLayer,
    tableLampLayer,
    ballLayer,
    pendulumLayer,
    borderLayer,
    deltaCloudsLayer,
    koiLayer,
    frondsLayer,
    anemonesLayer,
    tidepoolFishLayer,
  ],
};
