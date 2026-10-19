// A bamboo grove in the mist, with a water clock (shishi-odoshi) in the near corner: jade culms in
// five depth layers fading into the mist, leafy branches and a canopy of slender leaves, gusts
// sweeping through them as visible fronts, god rays falling through the canopy, leaves letting go, a
// stone lantern; and the tube that fills from the spout, tips into the mossy stone basin and clacks
// back on its stone, the grove's heartbeat. A variant of the `outdoor` composer's baseline
// (src/composer, README "The outdoor composer"): the grove's air and canopy for the baseline's downs,
// its floor, the culms, the stone lantern and the water clock (layers.ts). The sky in the canopy's
// gaps, the weather and the gusts are the World's and the composer's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { BAMBOO_GRADE, BAMBOO_PASSAGE, BAMBOO_RIG } from "./constants.ts";

/** The grove over the outdoor's baseline: its culms and water clock, its lens, its sunrise in the mist. */
export const bambooVariant: Variant = {
  id: "bamboo",
  base: "outdoor",
  title: "Bamboo grove",
  blurb: "A misty bamboo grove, and a water clock tipping into a stone basin.",
  accent: "#ffa64d",
  look: { color: "full", levels: 4 },
  // The culms sway in from the frame edges and the spout starts to run; on leaving, the tube brims,
  // tips and clacks while a gust bows the grove.
  passage: BAMBOO_PASSAGE,
  // The World's planets hang in the canopy's gaps: high in the frame (its lens is a radian tall,
  // the gaps open from about 22 degrees up to its top edge's 33), over the rays' middle gap first.
  planets: { group: "sky", across: [-35, -2, 35], up: [22, 30, 33] },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky in the canopy's gaps: its stars and the moon in its phase, whose rays fall through the gaps at night.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Rain closes the sky and greys the mist; the canopy shelters the grove but pours through its gaps, the leaves gather water and drip, long after the rain, stems and stones go dark and glossy, pools gather on the floor and rings spread on the basin. The wind sets how hard the grove sways and which way the gusts travel.",
    },
  },
  layers: { remove: ["downs"], add: ["grove", "groveFloor", "culms", "stoneLantern", "clock"] },
  camera: BAMBOO_RIG,
  grade: BAMBOO_GRADE,
  // Bare earth wherever the grove floor is switched off.
  floor: "earth",
  // Just after sunrise; the stars and the moon in its phase in the canopy's gaps at night. The gaps
  // show the clear sky (no fair-weather cloud, no Milky Way in a strip that narrow); birds to switch
  // on.
  world: {
    time: 0.27,
    stars: 0.5,
    clouds: 0,
    milkyWay: { on: false },
    birds: {
      kind: "swifts",
      on: false,
      help: "Birds crossing the sky over the grove by day, swifts by default, seen only in the gaps of the canopy, and few fly in the rain.",
    },
  },
  // Shooting stars set out in the band of sky the canopy's gaps open, high in the frame.
  meteors: [-0.5, 0.4, 1.0, 0.15],
  // Birds crossing above the canopy (14 m off at its underside), so the gaps alone show them.
  flyway: {
    depth: [16, 60],
    above: 0.4,
    top: 1,
    seed: 4.1,
    skim: 6,
    spread: 1.5,
    ext: 0.02,
  },
  // The moon takes a phase (K_moon) in the shared sky: in the gaps, and in its rays at night;
  // compiled in at every setting, a full moon's too, as the grove always drew it.
  features: { SKY_MOON_PHASE: 1 },
};

/** The grove composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const bambooComposed = composeScene(outdoor, variantPreset(outdoor.baseline, bambooVariant));

export const bambooScene: SceneDef = { ...bambooComposed.def, code: () => import("./code.ts") };
