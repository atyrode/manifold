// Meadow in the wind (honami): standing in tall grass at golden hour, the low sun ahead, gusts
// rolling across the field as travelling waves of paler light. A preset of the `outdoor` composer
// (src/composer, README "Composers"): the downs behind (layers.ts), the grass all around and the
// dandelion clocks in it, wildflowers to switch on; the composer's one gust field bows the near
// blades, rocks the clocks, pulls their seeds off one by one and carries them glowing up and away.
// The sky, the weather and the birds are the World's.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { MEADOW_PASSAGE, MEADOW_RIG } from "./constants.ts";

const preset: ScenePreset = {
  id: "meadow",
  composer: "outdoor",
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
  rig: MEADOW_RIG,
  grade: { ink: { gain: 1.3, gamma: 1 } },
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
  flyway: {
    depth: [12, 100],
    above: 0.04,
    top: 0.92,
    seed: 5.1,
    skim: 1.6,
    spread: 1.5,
    ext: 0.004,
  },
  floor: "earth",
  layers: ["downs", "grass", "dandelions"],
  values: {},
  groups: {
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows, and the weather: a grey drizzle misting the distance, steady rain hanging in shafts over the hills, a downpour driven across the field in curtains by the gusts; snow settling on the grass and the hills; fog filling the distance; lightning behind the hills. The grass darkens, glistens and bows, beads and drips; the clocks close and hold their seeds.",
    },
  },
};

/** The meadow composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const meadowComposed = composeScene(outdoor, preset);

export const meadowScene: SceneDef = { ...meadowComposed.def, code: () => import("./code.ts") };
