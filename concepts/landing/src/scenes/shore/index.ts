// A beach by moonlight, looking out to sea: surf rolls in, breaks and runs up the sand, and plankton
// (Noctiluca scintillans) flashes electric blue wherever the water is disturbed. By default the moon
// has just risen over the sea, right of ahead, and lays its path across the breakers. By day it is
// an ordinary turquoise seaside. The pointer's wake is tracked on the CPU (sim.ts) and read as uSim0.
// The sky, the weather and the gulls are the shared world's (scenes/world.ts, shaders/lib/world.ts).
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";
import { SHORE_LIGHTNING_TRIGGER, SHORE_METEOR_TRIGGER, SHORE_PASSAGE } from "./constants.ts";

const params: ParamDef[] = [
  range(
    "surf",
    "size",
    "wave size",
    0.5,
    "How tall the breakers stand: small ones spill close in, big ones curl over further out and run higher up the sand.",
  ),
  range(
    "surf",
    "period",
    "wave period",
    8,
    "Seconds between waves: short for a busy surf, long for a slow, deep rhythm.",
    { min: 5, max: 14, step: 0.5 },
  ),
  feature(
    "glow",
    "glow",
    "bioluminescence",
    true,
    "strength",
    0.7,
    "Plankton that flash electric blue wherever the water is disturbed: breaking crests, the edge of the swash, bursting foam. Only visible in the dark.",
  ),
  range(
    "glow",
    "sparkles",
    "sparkles",
    0.5,
    "Foam bubbles bursting on the wet sand as the water drains, each with a spark of light.",
    { when: "glow" },
  ),
  toggle(
    "glow",
    "stir",
    "stir with pointer",
    true,
    "Moving the pointer over the water or the wet sand stirs the plankton into glowing swirls.",
    { when: "glow" },
  ),
  feature(
    "glow",
    "fish",
    "fish",
    false,
    "frequency",
    0.3,
    "Now and then a school of fish darts through the shallows, leaving trails of light behind it at night.",
    { trigger: 0 },
  ),
  // The shared world: 0.82, the evening moon six degrees up, in frame (the shader turns the sky to
  // face moonrise); fair-weather cloud; gulls by day.
  ...worldKnobs({
    time: 0.82,
    meteors: { trigger: SHORE_METEOR_TRIGGER },
    lightning: SHORE_LIGHTNING_TRIGGER,
    birds: {
      kind: "gulls",
      help: "Gulls crossing over the sea by day, now and then swooping down to skim the water, dipping behind the breakers nearer than they are; mirrored in the wet sand a backwash leaves. Few fly in rain or snow.",
    },
  }),
  toggle(
    "manifold",
    "mark",
    "M in the sand",
    false,
    "An M drawn in the wet sand: every wave that washes over it lights it up blue, then it fades until the next.",
  ),
];

export const shoreScene: SceneDef = {
  id: "shore",
  title: "Shore",
  blurb: "Surf on a night beach, flashing blue wherever the water breaks.",
  accent: "#2ee6ff",
  // Designed in full colour; the plankton light is the accent in two-tone mode.
  look: { color: "full", levels: 4 },
  params,
  planets: { group: "sky", across: [-2, 18, 60], up: [0, 7, 14] },
  groups: {
    surf: { title: "Surf", blurb: "The breakers: how big they stand and how often they come in." },
    glow: {
      title: "Bioluminescence",
      blurb: "Plankton that light up when the water is stirred: by the surf, by fish, by you.",
    },
    sky: {
      ...worldGroups.sky,
      blurb:
        "Time of day, whether the days pass, and the night sky over the sea: its stars and the Milky Way, glinting in the wet sand, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows on the sand and the sea, rain, snow, fog, wind and lightning out of a storm bank at sea, all mirrored in the water and the wet sand. Rain greys the sky and hangs in shafts out at sea, rings the water and soaks the beach; snow settles on the dry sand.",
    },
    birds: worldGroups.birds,
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: an M drawn in the sand where the waves reach it.",
    },
  },
  code: () => import("./code.ts"),
  // Entrance: the camera settles from the sand up to the horizon as the surf, stood out to sea, runs
  // in and up the beach, the plankton flashing blue as it comes. Exit: the surf draws back out to sea.
  passage: SHORE_PASSAGE,
  // A sunlit beach is bright sand and sea: the copy needs dark ink on it, from the time the sun is
  // about 12 degrees up (full daylight in the sky library) until it sinks back there. With the day
  // cycle running the light keeps changing, so the page stays on the night theme. The shader's ink
  // follows the page (inkOf).
  theme: skyTheme(params),
  // The sea: wind ripples tilting a mirror of the sky and the moon's glitter (rippleSpectrum,
  // waterMirror, waterGlint); the breakers and the swash are the scene's own. The moon's phase is
  // compiled in at every setting, a full moon's too (where the world leaves it out): the glitter's
  // narrow lobe magnifies the last bits of the moon's direction, which the phase code's presence
  // shifts, so a full moon's own program would not draw byte for byte as the all-features one does.
  features: { WATER_TIER: WATER_TIERS.mirror, SKY_MOON_PHASE: 1 },
  // The world's parts only while their knobs can show them (worldFeatures).
  featuresFor: worldFeatures,
  featuresAll: WORLD_ALL,
};
