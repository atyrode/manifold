// A tide pool on a rock platform, seen from straight above. A variant of the `overhead` composer's
// baseline (src/composer, README "The overhead composer"), at its span but in the sea's water: the
// rock (rockPool, laid out per seed in layout.ts, under the shore's sky) in the baseline's pond
// floor's place, the sea over it (surge: shallow water simulated on the GPU, sim.ts over
// sims/shallow.ts: the swell shoals and breaks over the reefs, runs up the rock and, in the bigger
// sets, pours through the notch in the basin's rim), and the life the water streams (fronds,
// anemones, fish: life.ts) (layers.ts). The basin keeps what the waves bring; its algae stream and
// its anemones close in the surge, and the caustics come from the water's own surface. shader.ts
// lights the rock through the water.
import { composeScene, overheadVariantPreset } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadVariant } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import type { SceneDef } from "../types.ts";
import { TIDEPOOL_PASSAGE } from "./constants.ts";
import { TIDEPOOL_SPAN } from "./layers.ts";

/** The tide pool over the overhead's baseline: its rock, its sea and its life, lit by the World. */
export const tidepoolVariant: OverheadVariant = {
  id: "tidepool",
  base: "overhead",
  title: "Tide pool",
  blurb:
    "A rock pool from above: waves pour over its rim, its anemones and kelp answer the surge, and the light dances on its floor.",
  accent: "#ff6fae",
  look: { color: "full", levels: 4 },
  // Entering: the last of a wave's white water drains back to the sea up the frame and the anemones
  // unfurl; leaving: a wave breaks in from the sea and sweeps down over everything, the anemones
  // snapping shut ahead of it.
  passage: TIDEPOOL_PASSAGE,
  // The fish are offered, not home: the `fish` switch brings them.
  layers: { remove: ["pondBed"], add: ["rockPool", "surge", "fronds", "anemones"] },
  camera: { span: TIDEPOOL_SPAN, minAspect: 1, salt: true },
  // Still air over the pool, as it always stood (the World's wind is 0.2 by default); the World's
  // hour at the bed's own (`time` 0.42), and a clear sky in its water as it always mirrored (the
  // World's fair-weather cloud is 0.25).
  values: { wind: 0, time: 0.42, clouds: 0 },
  // Its layers light themselves with the World's light: nothing painted for an hour.
  painted: false,
  // The water: the sim's surface (sims/shallow.ts) with the breeze's ripples and their caustics on
  // the bed (causticRipples, waterCaustic). Seen from straight above, it mirrors the sky its own way.
  features: { WATER_TIER: WATER_TIERS.caustics },
};

/** The tide pool composed (composer/compose.ts): its definition, and what its code is built from. */
export const tidepoolComposed = composeScene(
  overhead,
  overheadVariantPreset(overhead.baseline, tidepoolVariant),
);

export const tidepoolScene: SceneDef = {
  ...tidepoolComposed.def,
  code: () => import("./code.ts"),
};
