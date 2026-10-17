// A lo-fi evening seen from inside a dark room: a sash window raised onto a city at dusk, a cat on
// the sill watching it, a steaming mug, a plant, books and a stirring curtain; across the street a
// neon Manifold M hums on a rooftop. The shader is ./shader.ts; the cat's gaze is eased on the CPU
// (./sim.ts, uSim0).
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { worldGates } from "../world.ts";
import { SILL_LIGHTNING_TRIGGER, SILL_METEOR_TRIGGER, SILL_PASSAGE } from "./constants.ts";

const params: readonly ParamDef[] = [
  feature(
    "cat",
    "cat",
    "cat",
    true,
    "size",
    0.5,
    "A cat on the sill with its back to you, watching the city: breathing, twitching an ear, swinging its tail over the edge. Move the pointer and it turns its head to look. Now: it looks back at you over its shoulder and blinks slowly.",
    { trigger: 0 },
  ),
  range(
    "cat",
    "restless",
    "restlessness",
    0.35,
    "How often it moves: ear twitches, tail flicks, glances around. Low is a cat at peace; high, a cat that heard something.",
    { when: "cat" },
  ),
  feature(
    "room",
    "steam",
    "steam",
    true,
    "amount",
    0.6,
    "Wisps curling up from the mug, drifting with the wind.",
  ),
  toggle(
    "room",
    "plant",
    "plant",
    true,
    "A potted plant at the end of the sill, its leaves nodding in the breeze.",
  ),
  feature(
    "room",
    "curtain",
    "curtain",
    true,
    "breeze",
    0.5,
    "A linen curtain beside the window, stirring as the air comes in; the wind stirs it more.",
  ),
  feature(
    "city",
    "lights",
    "city lights",
    true,
    "lit",
    0.45,
    "Windows across the city, each switching on or off now and then as the evening goes on: how many are lit.",
  ),
  ...skyKnobs({
    time: 0.8,
    stars: 0.5,
    moon: 1,
    meteors: { trigger: SILL_METEOR_TRIGGER },
    constellations: true,
  }),
  feature(
    "weather",
    "clouds",
    "clouds",
    true,
    "cover",
    0.35,
    "A cloud deck over the city, lit from below by its glow at night. Rain or snow closes it over whatever the cover, lower and darker the heavier they fall.",
  ),
  ...weatherKnobs({
    rain: true,
    snow: true,
    fog: true,
    wind: true,
    lightning: SILL_LIGHTNING_TRIGGER,
    aurora: true,
  }),
  toggle(
    "weather",
    "drops",
    "drops on the glass",
    true,
    "Raindrops beading and running down the panes above the open sash, each holding a tiny upside-down picture of the lit city and catching the lamp along its edge.",
    { when: "rain" },
  ),
  feature(
    "manifold",
    "neon",
    "neon M",
    true,
    "brightness",
    0.8,
    "A neon Manifold M on the roof across the street, humming in a soft glow; now and then one stroke winks out or stutters before it catches again. In the rain it glows in the wet air and shines back from the roof, the ledge and the sill; in snow it tints the snow on its frame. Now: a stutter.",
    { trigger: 2 },
  ),
];

export const sillScene: SceneDef = {
  id: "sill",
  title: "Sill",
  blurb: "A cat on the window sill, watching the city lights.",
  accent: "#ff3d7f",
  look: { color: "full", levels: 4 },
  params,
  planets: { group: "sky", across: [-38, -18, 38], up: [4, 20, 32] },
  groups: {
    cat: {
      title: "Cat",
      blurb: "The cat on the sill: how big, how fidgety, and a look back at you.",
    },
    room: {
      title: "Room",
      blurb: "Inside by the open window: the mug, the plant and the curtain.",
    },
    city: {
      title: "City",
      blurb: "The skyline across the street, its windows lighting up and going dark.",
    },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night over the city: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
    manifold: {
      title: "Manifold sign",
      blurb: "A landmark of its own: a neon M humming on the roof across the street.",
    },
  },
  code: () => import("./code.ts"),
  // Entrance: the cat hops up onto the sill and settles, its tail curling round. Exit: it stretches and hops down out of frame.
  passage: SILL_PASSAGE,
  // The world's sky, every part its knobs can show compiled in: the moon's phase (K_moon), the cloud
  // deck, the stars, the aurora, shooting stars and lightning.
  features: worldGates(params),
};
