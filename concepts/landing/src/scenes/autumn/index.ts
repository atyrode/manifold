// A park in autumn, late afternoon: a great maple (or ginkgo, or oak) over a gravel path, a wooden
// bench on the lawn and a cast-iron lamp, the low sun behind the canopy so that the leaves glow and the
// shadows run long across the grass. The leaves let go and fall as the plates they are, fluttering,
// gliding and tumbling and turning to show their paler undersides, and land to thicken the carpet on the
// lawn and the path; a gust shakes a shower loose and often lifts a swirl of them along the path. A
// variant of the `outdoor` composer's baseline (src/composer, README "The outdoor composer"), whose
// lawn underfoot is the park's: the parkland behind for the baseline's downs, the park path, the lamp
// post, the maple with its bench and its leaves, the fallen leaves and the agents' raking (layers.ts).
// The sky, the weather, the birds and the gusts are the World's and the composer's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { AUTUMN_GRADE, AUTUMN_RIG } from "./constants.ts";
import { AUTUMN_PASSAGE } from "./layout.ts";

/** The park over the outdoor's baseline: its tree, path and lamp, its lens, its late afternoon. */
export const autumnVariant: Variant = {
  id: "autumn",
  base: "outdoor",
  title: "Autumn park",
  blurb:
    "A great tree letting go of its leaves over a park path, the low sun glowing through them.",
  accent: "#e8a23a",
  look: { color: "full", levels: 4 },
  // Entrance: the camera lowers from the canopy onto the path as a gust blows a flurry of leaves
  // through the swaying boughs. Exit: a stronger gust whirls the leaves up across the frame as the
  // camera tilts up into the canopy (AUTUMN_RIG's lens shift; the leaves are the maple's sim).
  passage: AUTUMN_PASSAGE,
  planets: { group: "sky", across: [-30, 14, 40], up: [2, 14, 26] },
  theme: (params) => skyTheme(params, { rainBelow: 0.4 }),
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, how far autumn has come, whether the days pass, and the night sky over the park: its stars, the moon's phase, the odd shooting star, and on a clear night the aurora over the far trees.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Clouds drift over, and if you like their shadows sweep across the park. Rain greys the light and darkens the canopy; the path and the leaves turn dark and glossy, pools gather on the gravel and rings spread in them. Fog fades the far trees. The wind leans the leaves as they fall.",
    },
  },
  layers: {
    remove: ["downs"],
    add: ["parkland", "parkPath", "lamp", "maple", "litter", "rake"],
  },
  camera: AUTUMN_RIG,
  grade: AUTUMN_GRADE,
  // Late afternoon under a little fair-weather cloud; the stars over the park at night, the moon's
  // phase keying its light, no Milky Way; birds to switch on.
  world: {
    time: 0.69,
    stars: 0.5,
    clouds: 0.3,
    milkyWay: { on: false },
    birds: {
      kind: "rooks",
      on: false,
      help: "Birds crossing the sky over the park by day, rooks by default; the canopy, the trunk and the far crowns hide any that pass behind them, and few fly in rain or snow.",
    },
  },
  // Shooting stars set out over the far crowns, under the canopy's edge in a 16:9 frame.
  meteors: [-0.5, 0.3, 1.0, 0.14],
  // Flights from 15 m out, higher in the frame than the baseline's and hazed more.
  flyway: { depth: [15, 120], above: 0.08, seed: 2.3, spread: 1.5, ext: 0.016 },
  // The park's own gusts were lighter than the composer's default.
  values: { "gusts-amount": 0.5 },
  // The moon's phase keys the night's light: compiled in at every setting, a full moon's too, as the
  // park always drew it.
  features: { SKY_MOON_PHASE: 1 },
};

/** The park composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const autumnComposed = composeScene(outdoor, variantPreset(outdoor.baseline, autumnVariant));

export const autumnScene: SceneDef = { ...autumnComposed.def, code: () => import("./code.ts") };
