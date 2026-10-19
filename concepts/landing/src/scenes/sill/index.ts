// A lo-fi evening seen from inside a dark room: a sash window raised onto a city at dusk, a cat on
// the sill watching it, a steaming mug, a plant, books and a stirring curtain; across the street a
// neon Manifold M hums on a rooftop. A variant of the `interior` composer's baseline (src/composer,
// README "The interior composer"), whose empty room at dusk is the sill's: the window onto the city
// behind (layers.ts) and the sill in front are the baseline's, the cat and the things on it the
// sill's own; the World's sky and weather cross the window's glass. A lava lamp may stand on the sill
// (the lava lamp's layer, offered to every room).
import { composeScene, variantPreset } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { Variant } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { atmosphereGroups } from "../atmosphere.ts";
import { CITY_PLANETS, SILL_PASSAGE } from "./constants.ts";

/** The sill over the interior's baseline: the things on its sill, its ink and its vignette. */
export const sillVariant: Variant = {
  id: "sill",
  base: "interior",
  title: "Sill",
  blurb: "A cat on the window sill, watching the city lights.",
  accent: "#ff3d7f",
  look: { color: "full", levels: 4 },
  // Entrance: the cat hops up onto the sill and settles, its tail curling round. Exit: it stretches
  // and hops down out of frame.
  passage: SILL_PASSAGE,
  planets: CITY_PLANETS,
  groups: {
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night over the city: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
  },
  layers: { add: ["props", "cat", "curtain"] },
  // shadeOf's ink, and a soft vignette pulling the corners into the room's dark.
  grade: { ink: { gain: 1.15, gamma: 0.8 }, vignette: 0.28 },
};

/** The sill composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const sillComposed = composeScene(interior, variantPreset(interior.baseline, sillVariant));

export const sillScene: SceneDef = { ...sillComposed.def, code: () => import("./code.ts") };
