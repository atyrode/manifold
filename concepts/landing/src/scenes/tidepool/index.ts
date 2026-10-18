// A tide pool on a rock platform, seen from straight above. A preset of the `overhead` composer
// (src/composer, README "The overhead composer"): the rock (rockPool, laid out per seed in
// layout.ts, under the shore's sky), the sea over it (surge: shallow water simulated on the GPU,
// sim.ts over sims/shallow.ts: the swell shoals and breaks over the reefs, runs up the rock and, in
// the bigger sets, pours through the notch in the basin's rim), and the life the water streams
// (fronds, anemones, fish: life.ts) (layers.ts). The basin keeps what the waves bring; its algae
// stream and its anemones close in the surge, and the caustics come from the water's own surface.
// shader.ts lights the rock through the water.
import { composeScene } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadPreset } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import type { SceneDef } from "../types.ts";
import { TIDEPOOL_PASSAGE } from "./constants.ts";
import { TIDEPOOL_SPAN } from "./layers.ts";

const preset: OverheadPreset = {
  id: "tidepool",
  composer: "overhead",
  title: "Tide pool",
  blurb:
    "A rock pool from above: waves pour over its rim, its anemones and kelp answer the surge, and the light dances on its floor.",
  accent: "#ff6fae",
  look: { color: "full", levels: 4 },
  // Entering: the last of a wave's white water drains back to the sea up the frame and the anemones
  // unfurl; leaving: a wave breaks in from the sea and sweeps down over everything, the anemones
  // snapping shut ahead of it.
  passage: TIDEPOOL_PASSAGE,
  rig: { span: TIDEPOOL_SPAN, minAspect: 1, salt: true },
  // The fish are offered, not home: the `fish` switch brings them.
  layers: ["rockPool", "surge", "fronds", "anemones"],
  values: {},
  // The water: the sim's surface (sims/shallow.ts) with the breeze's ripples and their caustics on
  // the bed (causticRipples, waterCaustic). Seen from straight above, it mirrors the sky its own way.
  features: { WATER_TIER: WATER_TIERS.caustics },
};

/** The tide pool composed (composer/compose.ts): its definition, and what its code is built from. */
export const tidepoolComposed = composeScene(overhead, preset);

export const tidepoolScene: SceneDef = {
  ...tidepoolComposed.def,
  code: () => import("./code.ts"),
};
