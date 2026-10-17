// Wind over a sand sea. The sand is a live simulation (sim.ts: Werner's slab model on a toroidal
// grid, uploaded as uSim0 heights and uSim1 slopes), so the dunes really form, march downwind and
// heal around a heap you drop on them; the shader ray-marches it low toward the horizon or shows it
// from straight above, under the shared world's sky, weather and birds (scenes/world.ts,
// shaders/lib/world.ts), its fog the desert's dust, which turns into a sandstorm in a hard wind.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";
import { DUNES_LIGHTNING_TRIGGER, DUNES_METEOR_TRIGGER, DUNES_PASSAGE } from "./constants.ts";

const params: readonly ParamDef[] = [
  range(
    "dunes",
    "sand",
    "sand supply",
    0.45,
    "Little sand gathers into lone crescent barchans on bare ground; more links them into wavy barchanoid ridges; plenty buries the ground under long transverse dunes. The field is laid out afresh when you let go.",
  ),
  seed(
    "dunes",
    "seed",
    "arrangement",
    "Another starting field of sand: same wind and supply, different dunes.",
  ),
  range(
    "dunes",
    "ripples",
    "ripples",
    0.7,
    "Fine wind ripples combed across the sand, square to the wind; the slip faces stay smooth.",
  ),
  feature(
    "dunes",
    "drift",
    "blowing sand",
    true,
    "amount",
    0.6,
    "Sand skimming up the windward slopes and streaming off the crests in veils; grows with the wind.",
  ),
  choice(
    "view",
    "camera",
    "view",
    [
      { label: "aerial", value: 0 },
      { label: "overhead", value: 1 },
    ],
    0,
    "Look low across the dune sea to the horizon, or straight down on it like a satellite picture.",
    { steady: true },
  ),
  // The shared world: sunset over the sand, every star of a dark desert sky by night, a buzzard on
  // the thermals by day.
  ...worldKnobs({
    time: 0.74,
    stars: 1,
    meteors: { trigger: DUNES_METEOR_TRIGGER },
    lightning: DUNES_LIGHTNING_TRIGGER,
    birds: {
      kind: "buzzard",
      help: "Birds over the dune sea by day, a buzzard by default circling on the thermals the hot sand sends up; any dune or the M nearer hides them, the dust hazes them, and few fly in rain or snow. Not seen from overhead.",
    },
  }),
  range(
    "weather",
    "heat",
    "heat shimmer",
    0.5,
    "When the sun stands high, hot air wavers over the far dunes and the distance turns to a mirage.",
  ),
  feature(
    "manifold",
    "mark",
    "sandstone M",
    false,
    "size",
    0.5,
    "A lone wind-worn sandstone M standing in the dunes, throwing a long shadow; sand drifts against its legs and trails away in its lee.",
  ),
];

export const dunesScene: SceneDef = {
  id: "dunes",
  title: "Dunes",
  blurb:
    "Wind over a sand sea: real dunes, slowly marching downwind. Click to drop a heap of sand.",
  accent: "#d4913a",
  look: { color: "full", levels: 4 },
  params,
  planets: { group: "sky", across: [-62, -40, 5], up: [0, 7, 14] },
  groups: {
    dunes: {
      title: "Dunes",
      blurb: "How much sand the wind has to work with, and the texture of its surface.",
    },
    view: { title: "View", blurb: "Across the dunes to the horizon, or from high above." },
    sky: worldGroups.sky,
    // The shared heading, with what the weather means out here.
    weather: {
      ...worldGroups.weather,
      blurb:
        "Cloud and its shadows on the sand, rain, snow, wind and lightning: one weather, shared by every outdoor scene. The wind drives the dunes downwind and blows sand off their crests; the fog is desert dust, and with a hard wind it becomes a sandstorm; rain darkens the sand and stills it, snow lies on the slopes, and a high sun on dry sand makes the distance shimmer.",
    },
    birds: worldGroups.birds,
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: a weathered sandstone M out in the dunes.",
    },
  },
  code: () => import("./code.ts"),
  passage: DUNES_PASSAGE,
  // The world's parts only while their knobs can show them (worldFeatures).
  featuresFor: worldFeatures,
  featuresAll: WORLD_ALL,
};
