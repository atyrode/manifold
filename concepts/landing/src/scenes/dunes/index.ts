// Wind over a sand sea. The sand is a live simulation (sim.ts: Werner's slab model on a toroidal
// grid, uploaded as uSim0 heights and uSim1 slopes), so the dunes really form, march downwind and
// heal around a heap you drop on them; the shader ray-marches it low toward the horizon or shows it
// from straight above, under the shared sky, with haze that turns into a sandstorm in a hard wind.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { DUNES_METEOR_TRIGGER, DUNES_PASSAGE, dunesGlsl } from "./shader.ts";
import { dunesSim } from "./sim.ts";

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
  // The sky's own default star density (a dark desert sky, drawn 1.3x bright).
  ...skyKnobs({ time: 0.74, stars: 1, moon: 1, meteors: { trigger: DUNES_METEOR_TRIGGER } }),
  ...weatherKnobs({ wind: true, fog: true, aurora: true }),
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
  groups: {
    dunes: {
      title: "Dunes",
      blurb: "How much sand the wind has to work with, and the texture of its surface.",
    },
    view: { title: "View", blurb: "Across the dunes to the horizon, or from high above." },
    sky: atmosphereGroups.skyNight,
    // The shared heading, with what wind and haze mean out here.
    weather: {
      ...atmosphereGroups.weather,
      blurb:
        "The wind drives the dunes downwind and blows sand off their crests; the haze is desert dust, and with a hard wind it becomes a sandstorm.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: a weathered sandstone M out in the dunes.",
    },
  },
  glsl: dunesGlsl,
  entry: "sceneDunes",
  sim: dunesSim(params),
  passage: DUNES_PASSAGE,
  // The moon takes a phase (K_moon) in the shared sky.
  features: { SKY_MOON_PHASE: 1 },
};
