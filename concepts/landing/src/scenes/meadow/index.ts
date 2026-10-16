// Meadow in the wind (honami): standing in tall grass at golden hour, the low sun ahead, gusts
// rolling across the field as travelling waves of paler light. One deterministic gust field, shared
// by the shader (shader.ts) and the simulation (sim.ts), bows the near blades, rocks the dandelion
// clocks, pulls their seeds off one by one and carries them glowing up and away; switched on, it
// bows clumps of wildflowers too (wildflowers.ts, the shared plant component). The sky, the weather
// and the birds are the shared world's (scenes/world.ts, shaders/lib/world.ts).
import { counts, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { WORLD_ALL, worldFeatures, worldGroups, worldKnobs } from "../world.ts";
import { MEADOW_LIGHTNING_TRIGGER, MEADOW_METEOR_TRIGGER, meadowGlsl } from "./shader.ts";
import { GUST_TRIGGER, MARK_TRIGGER, MAX_CLOCKS, MEADOW_PASSAGE, meadowSim } from "./sim.ts";
import { meadowFlowersSim } from "./wildflowers.ts";

const params: readonly ParamDef[] = [
  range(
    "meadow",
    "grassHeight",
    "grass height",
    0.6,
    "How tall the grass stands around you: low leaves an open view across the field, high rises past the horizon.",
  ),
  range(
    "meadow",
    "grassDensity",
    "grass density",
    0.6,
    "How thickly the grass grows, across the field and in the blades and seed heads framing the view. The middle always stays open onto the field.",
  ),
  feature(
    "meadow",
    "dandelions",
    "dandelion clocks",
    true,
    "clocks",
    3,
    "Seed heads on long stalks. The gusts pull their seeds off one by one and carry them glowing into the light; a bare clock wilts and a new one opens nearby. Click to blow on the nearest one.",
    { options: counts(...Array.from({ length: MAX_CLOCKS }, (_, i) => i + 1)) },
  ),
  feature(
    "meadow",
    "wildflowers",
    "wildflowers",
    false,
    "how many",
    0.5,
    "Clumps of ox-eye daisies, buttercups, knapweed and field scabious standing up out of the grass. Each gust bows them as it reaches them and they swing back after it, the near grass hiding their feet. The amount is how many clumps; fewer keep some of more.",
  ),
  seed(
    "meadow",
    "meadowSeed",
    "arrangement",
    "Where the clocks stand, the lie of the grass and how the seeds let go; re-seed for another meadow.",
  ),
  // The shared world: golden hour, the meadow's own light fair-weather cloud, swallows by day.
  ...worldKnobs({
    time: 0.72,
    clouds: 0.2,
    meteors: { trigger: MEADOW_METEOR_TRIGGER },
    giant: { across: [-84, -22, -8], up: [0, 14, 26] },
    lightning: MEADOW_LIGHTNING_TRIGGER,
    birds: {
      kind: "swallows",
      help: "Birds crossing over the field by day, swallows by default, now and then swooping down to skim the grass tops; the grass hides any that dip behind it, and few fly in rain or snow.",
    },
    groups: { wind: "wind" },
  }),
  feature(
    "wind",
    "gusts",
    "gusts",
    true,
    "strength",
    0.7,
    "Gusts sweeping across the field: the grass bows and shows its paler side, so each one travels as a broad wave of light. 'Now' sends a big one across the whole field, through the grass around you.",
    { trigger: GUST_TRIGGER, widget: { kind: "gusts" } },
  ),
  range(
    "wind",
    "gustRate",
    "gust frequency",
    0.45,
    "How often a gust comes through: now and then to the left, one after another to the right.",
  ),
  range(
    "weather",
    "haze",
    "haze",
    0.45,
    "Golden dust and pollen in the low light: the distance softens into warm haze and the air glows around the sun.",
  ),
  feature(
    "manifold",
    "mown",
    "mown M",
    false,
    "visibility",
    0.7,
    "The Manifold M mown into the down beyond the trees, a path of pale stubble. 'Now' brings it out for a while and the low sun glints along it.",
    { trigger: MARK_TRIGGER },
  ),
];

export const meadowScene: SceneDef = {
  id: "meadow",
  title: "Meadow",
  blurb:
    "Tall grass at golden hour, gusts running across it as waves of light, dandelion seeds adrift.",
  // The low sun's gold, on the seeds and the clocks.
  accent: "#f2b65a",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    meadow: {
      title: "Meadow",
      blurb:
        "The grass around you and the dandelion clocks in it. Move over the page to breathe on the grass; click to blow seeds off a clock.",
    },
    wind: {
      title: "Wind",
      shelf: "world",
      blurb: "Which way the wind blows, and the gusts it sends rolling across the field.",
    },
    sky: worldGroups.sky,
    weather: {
      ...worldGroups.weather,
      title: "Air",
      blurb:
        "Golden haze, cloud and its shadows, and the weather: a grey drizzle misting the distance, steady rain hanging in shafts over the hills, a downpour driven across the field in curtains by the gusts; snow settling on the grass and the hills; fog filling the distance; lightning behind the hills. The grass darkens, glistens and bows, beads and drips; the clocks close and hold their seeds.",
    },
    birds: worldGroups.birds,
    manifold: { title: "Manifold mark", blurb: "The M mown into a far hillside." },
  },
  glsl: meadowGlsl,
  // Arriving, the camera lowers into the grass and a first gust lifts the seeds; leaving, a strong gust carries a burst of them and the camera rises over the grass.
  passage: MEADOW_PASSAGE,
  entry: "sceneMeadow",
  sim: meadowFlowersSim(meadowSim(params), params),
  // The world's parts only while their knobs can show them (worldFeatures), the wildflowers' code
  // only while they are on (wildflowers.ts).
  featuresFor: (values) => ({
    ...worldFeatures(values),
    MEADOW_HAS_WILDFLOWERS: (values.wildflowers ?? 0) > 0 ? 1 : 0,
  }),
  featuresAll: { ...WORLD_ALL, MEADOW_HAS_WILDFLOWERS: 1 },
};
