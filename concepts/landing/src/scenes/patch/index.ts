// The `overhead` composer's baseline as a scene of its own (ADR 0062 D13): the plainest patch seen
// from above, the pond's floor alone, dry, under the World's afternoon (composer/overhead.ts). The
// pond, the ripple tank, the tide pool, the sand table and the delta are variants of it, stored as
// their differences (composer/overhead-variants.ts); this scene loads the baseline itself to compare
// them against. Lab-only: outside the tour and `[` / `]` (src/lab/gallery-model.ts).
import { composeScene, overheadVariantPreset } from "../../composer/compose.ts";
import { overhead } from "../../composer/overhead.ts";
import type { OverheadVariant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";

/** The baseline's identity alone, a variant with no differences. */
export const patchVariant: OverheadVariant = {
  id: "patch",
  base: "overhead",
  title: "Patch",
  blurb:
    "The scenes seen from above: their baseline, a dry pond floor of pebbles, moss and weeds under the afternoon sun.",
  accent: "#b39a72",
  look: { color: "full", levels: 4 },
};

/** The patch composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const patchComposed = composeScene(
  overhead,
  overheadVariantPreset(overhead.baseline, patchVariant),
);

export const patchScene: SceneDef = { ...patchComposed.def, code: () => import("./code.ts") };
