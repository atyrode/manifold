// A small campfire at night, seen from a low seat just across the flames: a ring of stones on a flat
// rocky outcrop, crossed logs over breathing coals, a slow living fire of layered tongues, sparks
// climbing in lazy arcs, a thin smoke column that leans with the wind, a marshmallow toasting on a
// stick, a log bench, an enamel mug, a backpack and a lantern-lit tent at the edge of the light. Beyond
// them dark pines, a giant ringed planet low over them, the Milky Way and a vast starry sky with the
// odd shooting star. A variant of the `outdoor` composer's baseline (src/composer, README "The
// outdoor composer"): the pines and their sky for the baseline's downs, the clearing, the camp, the
// campfire with its light, its smoke and its sparks (layers.ts). The sky, the giant (the first of the
// World's planets), the weather and the birds are the World's.
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { Variant } from "../../composer/types.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import { CAMPFIRE_GRADE, CAMPFIRE_PASSAGE, CAMPFIRE_RIG } from "./constants.ts";

/** The campfire over the outdoor's baseline: its camp and its fire, its low seat, its starry night. */
export const campfireVariant: Variant = {
  id: "campfire",
  base: "outdoor",
  title: "Campfire",
  blurb:
    "A small fire under a vast sky: sparks drifting up, a marshmallow toasting, a giant planet low over the pines.",
  accent: "#ff8a2a",
  look: { color: "full", levels: 4 },
  // Entrance: embers in a dark night, a flame catches and grows, the firelight spreads, sparks start.
  // Exit: the fire dies down to embers and a last curl of smoke, the firelight withdraws.
  passage: CAMPFIRE_PASSAGE,
  // The giant opens the list: a banded planet with a thin ring, low over the far pines to the right,
  // half hidden by them, as the campfire always had it (its size the old giant's area, seen 27 degrees
  // off the view's axis).
  planets: { group: "sky", across: [-40, 27, 40], up: [3, 11, 30], defaults: [{ size: 0.45 }] },
  theme: skyTheme,
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "From dusk to deep night, the stars and the Milky Way, the giant low over the pines and any planets you hang beside it, and shooting stars. Run the day cycle and dawn comes to the clearing.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "The wind leans the flames, bends the smoke, drifts the sparks and sways the pines; fog fades the far pines first. Rain darkens the clearing and glints in the firelight; snow settles on the ground, the tent and the bench, but not near the fire.",
    },
  },
  layers: {
    remove: ["downs"],
    add: ["pines", "clearing", "camp", "campfire", "smoke", "sparks"],
  },
  camera: CAMPFIRE_RIG,
  grade: CAMPFIRE_GRADE,
  floor: "earth",
  // Deep in the evening under a clear sky, the stars thick and the Milky Way out; birds to switch on
  // (at this hour the World's last flights are still about).
  world: {
    time: 0.8,
    stars: 0.8,
    clouds: 0,
    birds: {
      kind: "rooks",
      on: false,
      help: "Birds crossing the sky over the clearing by day, rooks by default; the pines hide any that pass behind them, and few fly in rain or snow.",
    },
  },
  // Shooting stars set out high over the clearing, above the giant.
  meteors: [-0.6, 0.36, 1.2, 0.2],
  // The birds over the clearing, by day: above the pines, the near ones skimming the clearing.
  flyway: { depth: [12, 140], above: 0.1, seed: 4.7, skim: 2.5, spread: 1.5, ext: 0.01 },
  // No moon: the giant is the sky's other light. A shooting star now and then. Nothing in the camp
  // sways in the gusts, so they are off.
  values: { moon: 0, meteors: 1, "meteors-amount": 0.8, gusts: 0 },
};

/** The campfire composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const campfireComposed = composeScene(
  outdoor,
  variantPreset(outdoor.baseline, campfireVariant),
);

export const campfireScene: SceneDef = { ...campfireComposed.def, code: () => import("./code.ts") };
