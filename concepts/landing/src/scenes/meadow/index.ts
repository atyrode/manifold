// Meadow in the wind (honami): standing in tall grass at golden hour, the low sun ahead, gusts
// rolling across the field as travelling waves of paler light. A variant of the `outdoor`
// composer's baseline (src/composer, README "The outdoor composer"), whose plain land under the
// downs is the meadow's backdrop: the downs behind (layers.ts) are the baseline's, the grass all
// around and the dandelion clocks in it the meadow's own, wildflowers to switch on; the composer's
// one gust field bows the near blades, rocks the clocks, pulls their seeds off one by one and
// carries them glowing up and away. The sky, the weather and the birds are the World's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { MEADOW_PASSAGE, MEADOW_RIG } from "./constants.ts";

/** The meadow over the outdoor's baseline: its grass and clocks, its eye in the grass, its golden hour. */
export const meadowVariant: Variant = {
  id: "meadow",
  base: "outdoor",
  title: "Meadow",
  blurb:
    "Tall grass at golden hour, gusts running across it as waves of light, dandelion seeds adrift.",
  // The low sun's gold, on the seeds and the clocks.
  accent: "#f2b65a",
  look: { color: "full", levels: 4 },
  // Arriving, the eye lowers into the grass and a first gust lifts the seeds; leaving, a strong gust
  // carries a burst of them and the eye rises over the grass (MEADOW_RIG's passage).
  passage: MEADOW_PASSAGE,
  planets: { group: "sky", across: [-84, -22, -8], up: [0, 14, 26] },
  groups: {
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows, and the weather: a grey drizzle misting the distance, steady rain hanging in shafts over the hills, a downpour driven across the field in curtains by the gusts; snow settling on the grass and the hills; fog filling the distance; lightning behind the hills. The grass darkens, glistens and bows, beads and drips; the clocks close and hold their seeds.",
    },
  },
  layers: { add: ["grass", "dandelions"] },
  camera: MEADOW_RIG,
  // Bare earth between the tufts, where the grass is off.
  floor: "earth",
  // Golden hour, the meadow's own light fair-weather cloud, swallows by day.
  world: {
    time: 0.72,
    clouds: 0.2,
    birds: {
      kind: "swallows",
      help: "Birds crossing over the field by day, swallows by default, now and then swooping down to skim the grass tops; the grass hides any that dip behind it, and few fly in rain or snow.",
    },
  },
  // Shooting stars set out high over the hills.
  meteors: [-0.55, 0.28, 1.1, 0.1],
  // Nearer and lower than the baseline's: swallows skim the grass tops.
  flyway: { depth: [12, 100], top: 0.92, seed: 5.1, skim: 1.6, spread: 1.5 },
};

/** The meadow composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const meadowComposed = composeScene(outdoor, variantPreset(outdoor.baseline, meadowVariant));

export const meadowScene: SceneDef = { ...meadowComposed.def, code: () => import("./code.ts") };
