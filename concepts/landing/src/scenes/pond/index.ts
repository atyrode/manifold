// A koi pond seen from above: clear water, a stone or sand floor, light through border plants and
// an overhead canopy. A variant of the `overhead` composer's baseline (src/composer, README "The
// overhead composer"), whose dry pond floor (pondBed) is the pond's: the water over it (pondWater),
// the border plants and canopy (border) and the koi (koi) are the pond's own, with the Manifold
// stone to switch on (layers.ts). The border plants are grown by the shared plant component and
// drawn each frame into the border's field (sim.ts, plants.ts); the canopy is painted on the CPU
// into its other; while the koi are drawn to the pointer they are steered fish (koi.ts,
// sims/fish.ts).
import { composeScene, overheadVariantPreset } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadVariant } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import type { SceneDef } from "../types.ts";
import { POND_PASSAGE } from "./constants.ts";

/** The pond over the overhead's baseline: its water, its border and canopy, its koi, its breeze. */
export const pondVariant: OverheadVariant = {
  id: "pond",
  base: "overhead",
  title: "Pond",
  blurb: "A koi pond from above, light through clear water.",
  accent: "#ff7a2f",
  // Designed in full colour.
  look: { color: "full", levels: 4 },
  // The border plants and canopy move in from beyond the frame edges as the koi swim in; on leaving
  // they part outward again, the koi glide off and a breeze crosses the water.
  passage: POND_PASSAGE,
  // The baseline's span, its afternoon (its sun where the pond's own stood: `sunX`, `sunY` at 0.15,
  // 1.15 on a 16:10 frame) and its painted hour are the pond's.
  layers: { add: ["pondWater", "border", "koi"] },
  // The World's wind over the patch at the pond's own breeze (the border's `wind` before the World
  // was over the patch).
  values: { wind: 0.4 },
  // The floor's caustics: the shared water's cellular net (causticCells), carried by the current
  // (waterDrift); the sun's glint on the rings (waterGlint).
  features: { WATER_TIER: WATER_TIERS.caustics },
};

/** The pond composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const pondComposed = composeScene(
  overhead,
  overheadVariantPreset(overhead.baseline, pondVariant),
);

export const pondScene: SceneDef = { ...pondComposed.def, code: () => import("./code.ts") };
