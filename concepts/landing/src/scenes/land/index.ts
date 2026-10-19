// The `outdoor` composer's baseline as a scene of its own (ADR 0062 D13): the plainest land, an eye
// standing in an open field, the downs beyond under a fair afternoon sky (composer/outdoor.ts). The
// meadow is a variant of it, stored as its differences, and the other outdoor scenes become variants
// as they are ported; this scene loads the baseline itself to compare them against. Lab-only:
// outside the tour and `[` / `]` (src/lab/gallery-model.ts).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";

/** The baseline's identity alone, a variant with no differences. */
export const landVariant: Variant = {
  id: "land",
  base: "outdoor",
  title: "Land",
  blurb:
    "The outdoor scenes' baseline: chalk downs under a fair afternoon sky, an open field underfoot.",
  accent: "#9cb86a",
  look: { color: "full", levels: 4 },
  // The World's planets over the downs, where the meadow's lens hangs them.
  planets: { group: "sky", across: [-84, -22, -8], up: [0, 14, 26] },
};

/** The land composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const landComposed = composeScene(outdoor, variantPreset(outdoor.baseline, landVariant));

export const landScene: SceneDef = { ...landComposed.def, code: () => import("./code.ts") };
