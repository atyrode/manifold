// A frozen lake far in the north, under the aurora: black ice swept clear by the wind, white
// methane bubbles frozen in layers beneath it, long pressure cracks hanging their fracture planes
// down into it and now and then a new one singing across with a flash, snow lying in wind-carved
// patches and streaming over the ice, and on the far shore a cabin with a lit window. The aurora
// surges overhead every few minutes, mirrored in the ice. sim.ts grows the cracks, drifts the snow
// and paces the substorms; shader.ts draws the night. It comes in with the camera tilting down from
// the aurora onto the ice as a crack sings across, and goes out as a gust of snow streams over the
// ice and the camera tilts back up (LAKE_PASSAGE).
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { atmosphereGroups, skyComponentKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { LAKE_METEOR_TRIGGER, lakeGlsl } from "./shader.ts";
import { LAKE_PASSAGE, lakeSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  ...weatherKnobs({ auroraGroup: "aurora", aurora: true, on: { aurora: true } }),
  choice(
    "aurora",
    "hue",
    "colour",
    [
      { label: "green", value: 0 },
      { label: "teal", value: 1 },
      { label: "storm", value: 2 },
      { label: "crimson", value: 3 },
    ],
    0,
    "The aurora's colours: the common oxygen green with violet above it, teal under blue-violet tops, a storm's green under crimson, or the rare deep red aurora.",
  ),
  feature(
    "aurora",
    "substorm",
    "substorms",
    true,
    "frequency",
    0.4,
    "Every few minutes the quiet arc brightens for a while, then breaks up: the light surges, curtains spread overhead and ripple faster, and over a couple of minutes the sky calms again. Now: start one.",
    { trigger: 0 },
  ),
  range(
    "aurora",
    "mirror",
    "ice mirror",
    0.7,
    "How clearly the black ice mirrors the aurora, the moon and the far shore: low for rough, hazy ice, high for dark glass you could fall into.",
  ),
  feature(
    "ice",
    "cracks",
    "singing ice",
    true,
    "frequency",
    0.45,
    "Now and then the ice sings: a new crack zips across it with a flash, branching off an old one or running in from beyond the frame; later in the night old cracks sing again. Click the ice to knock on it and it answers. Now: one at once.",
    { trigger: 1 },
  ),
  range(
    "ice",
    "fractures",
    "cracks",
    0.5,
    "How cracked the ice is: a few long pressure cracks across a clear sheet, or a web of branches and hairlines. Under each crack its fracture plane hangs down into the black ice.",
  ),
  feature(
    "ice",
    "bubbles",
    "frozen bubbles",
    true,
    "density",
    0.6,
    "Methane bubbles frozen in the ice as it thickened: white discs stacked in columns over the seeps on the lake bed, fainter and bluer deeper down, with clouds of small ones near the surface.",
  ),
  range(
    "ice",
    "cover",
    "snow patches",
    0.35,
    "How much of the ice lies under wind-packed snow. Drag across the ice to sweep it clear; the wind slowly brings loose snow back.",
  ),
  range(
    "ice",
    "fresh",
    "fresh snow",
    0,
    "How recently snow fell on the lake, for the same snow on the same ice. None: old snow, packed hard by the wind and carved into low ridges, greyer where it lies thin, its edges crisp. Higher: more of its surface is fresh powder, smooth and brighter, white even where it lies thin, its edges feathering out into a dusting over the black ice, more crystals glinting in it; freshest where the wind has just laid loose snow down.",
  ),
  feature(
    "ice",
    "drift",
    "drifting snow",
    true,
    "amount",
    0.5,
    "Loose snow lifted by the gusts and blown across the ice in long, thin streamers trailing off every patch, settling again when the wind drops. The wind sets which way and how hard.",
  ),
  seed(
    "ice",
    "iceSeed",
    "lake",
    "Where the cracks run, where the bubbles froze and how the snow lies; re-seed for another lake.",
  ),
  range(
    "night",
    "hour",
    "hour",
    0.75,
    "From the blue hour, the last light glowing low on the left, to the deep of the night.",
  ),
  feature(
    "sky",
    "moon",
    "moon",
    true,
    "phase",
    0.3,
    "A moon low over the mountains on the right, from a thin crescent to full: it lights the snow, draws a path of glints down the ice and drowns the faintest stars.",
  ),
  range(
    "sky",
    "stars",
    "stars",
    0.7,
    "How many stars come out over the lake: none to the left, a dark northern sky to the right. The Milky Way fades with them.",
  ),
  ...skyComponentKnobs({
    milkyWay: { on: true },
    meteors: { trigger: LAKE_METEOR_TRIGGER },
  }),
  toggle(
    "night",
    "cabin",
    "cabin",
    true,
    "A log cabin on the point across the ice: its window lit by the fire, its light drawn down the ice toward you, its smoke rising until it flattens under the cold air above.",
  ),
  ...birdKnobs({
    kind: "geese",
    help: "Birds crossing the night over the lake, geese by default, a skein migrating under the aurora: dark against the sky, mirrored in the black ice, behind the cabin and the trees on the point; few fly in snow.",
  }),
  ...weatherKnobs({ snow: true, fog: true, wind: true }),
  toggle(
    "manifold",
    "mark",
    "singing M",
    false,
    "A crack in the near ice draws the Manifold M and keeps a little of the aurora's green in it. It sings in a moment after you switch it on. Now: it sings again.",
    { trigger: 2 },
  ),
];

export const lakeScene: SceneDef = {
  id: "lake",
  title: "Frozen lake",
  blurb: "Black ice under the aurora: bubbles frozen deep, cracks that sing, snow drifting across.",
  accent: "#4cf08c",
  look: { color: "full", levels: 4 },
  passage: LAKE_PASSAGE,
  params,
  groups: {
    aurora: {
      title: "Aurora",
      blurb:
        "The northern lights over the lake and in its ice: how bright, what colours, and the substorms that set them dancing.",
    },
    ice: {
      title: "Ice",
      blurb:
        "Black ice swept by the wind: its cracks and the singing of new ones, the bubbles frozen in it, the snow lying and drifting on it. Click the ice to knock on it; drag to sweep the snow away.",
    },
    night: {
      title: "Night",
      blurb:
        "The hour, from the last light of the blue hour to the deep of the night, and the cabin on the far shore.",
    },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb:
        "The night sky over the lake: the moon's phase, the stars and the Milky Way, the odd shooting star, all mirrored in the ice.",
    },
    birds: birdsGroup,
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "Snow falls from a closing sky, hiding the aurora and slowly burying the ice; mist settles on the lake; the wind drives the drifting snow and leans the cabin's smoke.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: an M cracked into the near ice.",
    },
  },
  glsl: lakeGlsl,
  entry: "sceneLake",
  sim: lakeSim(params),
};
