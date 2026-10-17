// A waterfall seen level from the edge of its plunge pool: a cliff of basalt flows and rusty ash
// beds (or sandstone ledges, or a pale limestone slot) with fallen blocks heaped at its foot, the
// fall pouring from a notch in the lip, spray rising from the plunge with a rainbow in it, ferns on
// the ledges and fireflies over the water at dusk. All in the shader but the near bank's ferns,
// rooted plants of the shared plant component (sim.ts) that sway with the wind and turn with the year.
import { choice, feature, range } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import { plantKnobs } from "../plants.ts";
import type { SceneDef } from "../types.ts";
import { worldGates } from "../world.ts";
import { FALLS_METEOR_TRIGGER, FALLS_PASSAGE, fallsGlsl } from "./shader.ts";
import { fallsSim } from "./sim.ts";

// The sky's and the weather's knobs over the gorge: the world's sky draws every part they can show.
const skyAndWeather = [
  ...skyKnobs({
    time: 0.55,
    stars: 0.45,
    moon: 1,
    meteors: { trigger: FALLS_METEOR_TRIGGER },
    constellations: true,
  }),
  ...weatherKnobs({ rain: true, fog: true, wind: true, aurora: true }),
];

export const fallsScene: SceneDef = {
  id: "falls",
  title: "Waterfall",
  blurb: "A waterfall pouring into its pool: spray, a rainbow, ferns on the wet rock.",
  accent: "#7fdce6",
  // Designed in full colour; in two-tone mode the spray carries the accent.
  look: { color: "full", levels: 4 },
  params: [
    range(
      "falls",
      "flow",
      "flow",
      0.55,
      "How much water comes over the lip: a thin ribbon breaking into strands at the left end, a roaring white curtain at the right.",
    ),
    range(
      "falls",
      "mist",
      "mist",
      0.6,
      "Spray thrown up where the water lands: a low haze over the pool at the left end, clouds billowing up the cliff at the right.",
    ),
    feature(
      "falls",
      "rainbow",
      "rainbow",
      true,
      "strength",
      0.7,
      "A rainbow in the spray, 42° from the point opposite the sun. Like a real one it shows only while the sun is up and only where there is spray to hold it, standing higher the lower the sun.",
    ),
    choice(
      "falls",
      "gorge",
      "gorge",
      [
        { label: "basalt", value: 0 },
        { label: "sandstone", value: 1 },
        { label: "limestone slot", value: 2 },
      ],
      0,
      "The rock the river has cut through. Basalt: dark lava flows stacked on rusty ash, dipping and folded, standing out as ledges. Sandstone: thin, level beds of buff and red stone stepped into ledges over soft shale, cross-bedded. Limestone slot: a narrow gorge of pale, massive limestone, its walls closing in on both sides and leaving a strip of sky, fluted by runnels, streaked dark under the lips and crusted with tufa where the water runs.",
    ),
    range(
      "life",
      "greenery",
      "moss & ferns",
      0.6,
      "Moss on the ledges and the wet rock, ferns and creepers hanging from them, ferns on the near bank.",
    ),
    feature(
      "life",
      "fireflies",
      "fireflies",
      true,
      "amount",
      0.5,
      "Fireflies blinking over the pool from dusk on, each flash doubled in the water.",
    ),
    ...birdKnobs({
      kind: "swifts",
      help: "Birds crossing the gorge by day, swifts by default, sailing past the cliff and now and then swooping low over the pool; the rock, the trees on the rim and the spray hide them, and few fly in the rain.",
    }),
    ...skyAndWeather,
    feature(
      "manifold",
      "mark",
      "carved M",
      false,
      "parting",
      0.5,
      "A Manifold M cut into the rock behind the falling water, glimpsed through it where it runs thin. A horn of rock at the lip splits the flow in front of it: more parts the water wider.",
    ),
    // The bank ferns' year, growth and gusts (scenes/plants.ts), all off; the gusts' "now" on
    // slot 1 (0 is the shooting stars').
    ...plantKnobs({
      group: "life",
      season: 0.35,
      growth: 0.4,
      gusts: { trigger: 1, group: "weather" },
    }),
  ],
  // In the sky's frame, which the view faces half turned from (fallsWorld: straight ahead is
  // 180): the strip over the rim, 40 degrees to either side, from the treetops (about 21 degrees up
  // at the frame's sides, 27 in its middle) to the frame's top (32).
  planets: { group: "sky", across: [140, 166, 220], up: [20, 29, 33] },
  groups: {
    falls: {
      title: "Waterfall",
      blurb:
        "How much water pours over, the spray it throws up, the rainbow standing in it, and the rock it has cut through.",
    },
    life: {
      title: "Life",
      blurb: "Moss and ferns on the wet rock, fireflies over the pool after dark.",
    },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "Time of day, whether the days pass, and the night sky over the gorge: its stars, the moon's phase, the odd shooting star and the aurora.",
    },
    weather: atmosphereGroups.weather,
    birds: birdsGroup,
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: an M carved into the rock behind the water.",
    },
  },
  glsl: fallsGlsl,
  entry: "sceneFalls",
  // The camera starts up at the lip and tilts down the fall to the pool as the ferns spring up on
  // the bank and the spray rises, the rainbow forming in it; on the way out it tilts back up the
  // fall into a surge of spray.
  passage: FALLS_PASSAGE,
  // The world's sky, every part its sky and weather knobs can show compiled in: the moon's phase
  // (K_moon), the cloud deck, the stars, the aurora and shooting stars, the rain. The birds are the
  // gorge's own.
  features: worldGates(skyAndWeather),
  sim: (gl) => fallsSim(gl, fallsScene.params),
};
