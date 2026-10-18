// A small island in a gentle sea, seen from a low three-quarter view with the horizon in frame: a
// sloping sand beach with a wet tideline, driftwood and footprints, a lawn rising to a grassy hill
// with a rocky cliff edge and a cottage, irregular fruit trees, a swaying palm, a pier with a
// lantern, clear turquoise shallows over the sand, swell lines and foam, a seagull, fish shadows and
// now and then a gift balloon. A preset of the `outdoor` composer (src/composer, README
// "Composers"): the sky over the sea (the island's camera, the far cumulus, the air), the shallows,
// the island itself, the gull and the balloon (layers.ts). The sky and the weather are the World's
// (lit windows and the lantern at night, rain and snow falling through its depth). shader.ts
// raymarches the island; there is no simulation: everything moves on smooth clocks.
import { composeScene } from "../../composer/compose.ts";
import { outdoor } from "../../composer/outdoor.ts";
import type { ScenePreset } from "../../composer/types.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGroups } from "../world.ts";
import {
  ISLAND_FLYWAY,
  ISLAND_GRADE,
  ISLAND_METEORS,
  ISLAND_PASSAGE,
  ISLAND_RIG,
} from "./constants.ts";

const preset: ScenePreset = {
  id: "island",
  composer: "outdoor",
  title: "Tiny island",
  blurb:
    "A small island in a gentle sea: a cottage on a grassy hill, a pier and lantern, a palm, a gull circling, a balloon drifting by.",
  accent: "#ff7ba3",
  look: { color: "full", levels: 4 },
  // Entrance: the camera swoops down from higher and farther and settles into the framing while the
  // gull glides in and a balloon drifts into frame. Exit: the camera lifts and backs away.
  passage: ISLAND_PASSAGE,
  planets: { group: "sky", across: [-33, -14, 33], up: [0, 6, 12] },
  // A bright island by day is a light page: dark copy from morning to evening on a still clock,
  // unless steady rain greys it.
  theme: (params) => skyTheme(params, { from: 0.31, to: 0.69, rainBelow: 0.3 }),
  rig: ISLAND_RIG,
  grade: ISLAND_GRADE,
  // An afternoon with fair-weather cloud; the island's own gull circles it, so the World's birds
  // start off, and its night has no Milky Way.
  world: {
    time: 0.58,
    clouds: 0.35,
    milkyWay: { on: false },
    birds: {
      kind: "gulls",
      on: false,
      help: "Gulls crossing over the sea by day. Few fly in rain or snow.",
    },
  },
  meteors: ISLAND_METEORS,
  flyway: ISLAND_FLYWAY,
  floor: "water",
  layers: ["seaSky", "shallows", "island", "gull", "balloon"],
  // The trees and the palm sway on their own clocks in the wind, not in the gusts: they are off.
  values: { gusts: 0 },
  // The sea: wind ripples tilting a mirror of the sky (rippleSpectrum, waterMirror).
  features: { WATER_TIER: WATER_TIERS.mirror },
  groups: {
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day: the sun climbs over the left shoulder and sets behind you, the cottage window and the pier's lantern light up at dusk, stars come out over the sea at night.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Clouds drift by and their shadows cross the island. Rain greys the sky and the sea, wets the sand, the lawn and the planks, and rings the water; snow settles on the roofs, crowns and beach. Wind carries the clouds and sways the trees and the palm.",
    },
  },
};

/** The island composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const islandComposed = composeScene(outdoor, preset);

export const islandScene: SceneDef = { ...islandComposed.def, code: () => import("./code.ts") };
