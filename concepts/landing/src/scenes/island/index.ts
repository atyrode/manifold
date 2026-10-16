// A small island in a gentle sea, seen from a low three-quarter view with the horizon in frame:
// a sloping sand beach with a wet tideline, driftwood and footprints, a lawn rising to a grassy hill
// with a rocky cliff edge and a cottage, irregular fruit trees, a swaying palm, a pier with a
// lantern, clear turquoise shallows over the sand, swell lines and foam, a seagull, fish shadows
// and now and then a gift balloon. The shared sky and weather light it (lit windows and the lantern
// at night, rain and snow falling through its depth). shader.ts raymarches the island; there is no
// simulation: everything moves on smooth clocks.
import { feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { ISLAND_PASSAGE, islandGlsl } from "./shader.ts";

const params: readonly ParamDef[] = [
  range(
    "island",
    "trees",
    "fruit trees",
    0.65,
    "How many leafy fruit trees stand on the lawn: none to the left, six to the right. Light comes through their crowns, and each bears its own fruit.",
  ),
  range(
    "island",
    "flowers",
    "flowers",
    0.6,
    "Flowers sprinkled over the lawn and the plateau, pink, white, yellow and lilac.",
  ),
  seed(
    "island",
    "isle",
    "island",
    "Another island: a different shore, trees in other places, the cottage on the other hand; re-seed for a new one.",
  ),
  toggle(
    "life",
    "gull",
    "seagull",
    true,
    "A seagull circling the island in a wide, slow loop, its shadow gliding over the sea. It goes home at night and in rain.",
  ),
  toggle(
    "life",
    "fish",
    "fish shadows",
    true,
    "Three fish gliding round the island in the shallows, seen as dark shapes under the water, tails swishing.",
  ),
  feature(
    "life",
    "balloon",
    "gift balloon",
    true,
    "how often",
    0.5,
    "Every minute or two a balloon carrying a little present drifts across the sky, its shadow crossing the island. Now: send one.",
    { trigger: 0 },
  ),
  ...skyKnobs({ time: 0.58, stars: 0.6, constellations: true, planets: true }),
  ...weatherKnobs({ clouds: 0.35, rain: true, snow: true, fog: true, wind: true }),
  feature(
    "manifold",
    "mark",
    "flowerbed M",
    false,
    "size",
    0.9,
    "A flowerbed in the shape of the Manifold M on the front lawn, edged with pale pebbles and full of pink, white and yellow flowers. It is laid out stretched in depth so that, seen from the camera, it reads as a proper M.",
    { min: 0.6, max: 1, step: 0.05 },
  ),
];

export const islandScene: SceneDef = {
  id: "island",
  title: "Tiny island",
  blurb:
    "A small island in a gentle sea: a cottage on a grassy hill, a pier and lantern, a palm, a gull circling, a balloon drifting by.",
  accent: "#ff7ba3",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    island: {
      title: "Island",
      blurb: "The trees and flowers on the lawn, and which island this is.",
    },
    life: { title: "Life", blurb: "The gull, the fish in the shallows and the gift balloon." },
    sky: {
      ...atmosphereGroups.sky,
      blurb:
        "Time of day: the sun climbs over the left shoulder and sets behind you, the cottage window and the pier's lantern light up at dusk, stars come out over the sea at night.",
    },
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "Clouds drift by and their shadows cross the island. Rain greys the sky and the sea, wets the sand, the lawn and the planks, and rings the water; snow settles on the roofs, crowns and beach. Wind carries the clouds and sways the trees and the palm.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: the M as a flowerbed on the lawn.",
    },
  },
  glsl: islandGlsl,
  entry: "sceneIsland",
  // A bright island by day is a light page: dark copy from morning to evening on a still clock, unless steady rain greys it.
  theme: skyTheme(params, { from: 0.31, to: 0.69, rainBelow: 0.3 }),
  // Entrance: the camera swoops down from higher and farther and settles into the framing while the gull
  // glides in and a balloon drifts into frame. Exit: the camera lifts and backs away.
  passage: ISLAND_PASSAGE,
  // The sea: wind ripples tilting a mirror of the sky (rippleSpectrum, waterMirror).
  features: { WATER_TIER: WATER_TIERS.mirror },
};
