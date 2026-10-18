// A lo-fi evening seen from inside a dark room: a sash window raised onto a city at dusk, a cat on
// the sill watching it, a steaming mug, a plant, books and a stirring curtain; across the street a
// neon Manifold M hums on a rooftop. A preset of the `interior` composer (src/composer, README "The
// interior composer"): the window onto the city behind (layers.ts), the sill in front, the cat and
// the things on it; the World's sky and weather cross the window's glass. A lava lamp may stand on
// the sill (the lava lamp's layer, offered to every room).
import { composeScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";
import { atmosphereGroups } from "../atmosphere.ts";
import { SILL_PASSAGE, SILL_RIG, SILL_ROOM } from "./constants.ts";

const preset: ScenePreset = {
  id: "sill",
  composer: "interior",
  title: "Sill",
  blurb: "A cat on the window sill, watching the city lights.",
  accent: "#ff3d7f",
  look: { color: "full", levels: 4 },
  // Entrance: the cat hops up onto the sill and settles, its tail curling round. Exit: it stretches
  // and hops down out of frame.
  passage: SILL_PASSAGE,
  planets: { group: "sky", across: [-38, -18, 38], up: [4, 20, 32] },
  rig: SILL_RIG,
  room: SILL_ROOM,
  // shadeOf's ink, and a soft vignette pulling the corners into the room's dark.
  grade: { ink: { gain: 1.15, gamma: 0.8 }, vignette: 0.28 },
  // Dusk over the city, its stars thinner in the city's glow, a cloud deck lit from below at night,
  // no Milky Way over the city. A room lists no birds (compose.ts): `birds` names the World's only
  // to satisfy its options.
  world: {
    time: 0.8,
    stars: 0.5,
    clouds: 0.35,
    milkyWay: { on: false },
    birds: { kind: "pigeons", help: "" },
  },
  meteors: [-0.5, 0.3, 1, 0.12],
  flyway: { depth: [16, 120], above: 0.04, top: 0.9, seed: 3.1, skim: 10, spread: 1, ext: 0.004 },
  floor: "earth",
  layers: ["cityWindow", "sill", "props", "cat", "curtain"],
  values: {},
  groups: {
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night over the city: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
  },
};

/** The sill composed (composer/compose.ts): its definition, and what its code is assembled from. */
export const sillComposed = composeScene(interior, preset);

export const sillScene: SceneDef = { ...sillComposed.def, code: () => import("./code.ts") };
