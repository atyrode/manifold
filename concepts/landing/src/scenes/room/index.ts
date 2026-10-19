// The `interior` composer's baseline as a scene of its own (ADR 0062 D13): an empty room at dusk at
// the sill's rest pose, the window onto the city over the bare sill, the plum wall and the reading
// lamp out of frame (composer/interior.ts). Every room is a variant of it (sill, lava, bonsai,
// incense, frost, bar, train, mobile), stored as its differences; this scene loads the baseline
// itself to compare them against. Lab-only: outside the tour and `[` / `]` (src/lab/families.ts).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { CITY_PLANETS } from "../sill/constants.ts";

/** The baseline's identity alone, a variant with no differences: its window's planets the sill's. */
export const roomVariant: Variant = {
  id: "room",
  base: "interior",
  title: "Room",
  blurb: "The rooms' baseline: an empty room at dusk, a window onto the city over a bare sill.",
  accent: "#9b7fd4",
  look: { color: "full", levels: 4 },
  planets: CITY_PLANETS,
};

/** The room composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const roomComposed = composeScene(interior, variantPreset(interior.baseline, roomVariant));

export const roomScene: SceneDef = { ...roomComposed.def, code: () => import("./code.ts") };
