// A tide pool on a rock platform, seen from straight above. The sea along the top is shallow water
// simulated on the GPU (sim.ts over sims/shallow.ts): the swell shoals and breaks over the reefs,
// runs up the rock and, in the bigger sets, pours through the notch in the basin's rim. The basin
// keeps what the waves bring; its algae stream and its anemones close in the surge, and the
// caustics come from the water's own surface. The rock is laid out per seed in layout.ts; the
// shader (shader.ts) lights it through the water.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import { plantKnobs } from "../plants.ts";
import type { SceneDef } from "../types.ts";
import { TIDEPOOL_PASSAGE, tidepoolGlsl } from "./shader.ts";
import { tidepoolSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range(
    "sea",
    "tide",
    "tide",
    0,
    "Where the sea stands. Low (left): the pool is cut off and only the biggest waves reach its rim. High (right): the sea runs through the notch and washes over the rim.",
    { min: -1, max: 1 },
  ),
  feature(
    "sea",
    "tideCycle",
    "tide turns",
    false,
    "speed",
    0.3,
    "The tide rises and falls on its own, around the level set above: once in ten minutes at the slow end, in a minute and a half at the quick end.",
  ),
  range(
    "sea",
    "swell",
    "swell",
    0.5,
    "How big the waves rolling in from the sea are: a lap at the rocks to the left, surf breaking over the reefs to the right.",
  ),
  range(
    "sea",
    "period",
    "wave length",
    0.5,
    "Short, quick waves to the left; long, slow swell to the right.",
  ),
  range(
    "sea",
    "heading",
    "direction",
    0.15,
    "Which way the waves come in: from the left, head on, or from the right.",
    { min: -1, max: 1 },
  ),
  feature(
    "sea",
    "sets",
    "sets",
    true,
    "how often",
    0.5,
    "Now and then a set of bigger waves rolls in, surges up the channel and pours over the rim into the pool. Now: a set comes in at once.",
    { trigger: 0 },
  ),
  range("sea", "pace", "pace", 1, "How fast the sea moves, from slow motion to life speed.", {
    min: 0.25,
    max: 1.5,
  }),
  range(
    "sea",
    "foam",
    "foam",
    0.6,
    "How much white water the breaking waves and the surge over the rim leave behind.",
  ),
  feature(
    "light",
    "caustics",
    "caustics",
    true,
    "strength",
    0.7,
    "The net of light the rippled surface focuses on the pool floor: the waves' broad bands and the breeze's fine mesh.",
  ),
  feature(
    "light",
    "glints",
    "glints",
    true,
    "strength",
    0.5,
    "The sun (or the moon) glittering off the ripples turned toward it.",
  ),
  range(
    "light",
    "ripples",
    "breeze",
    0.5,
    "How much the breeze ruffles the water: glassy to the left, a fine chop to the right.",
  ),
  ...skyKnobs({ time: 0.42 }),
  ...weatherKnobs({ rain: true }),
  feature(
    "life",
    "anemones",
    "anemones",
    true,
    "how many",
    0.55,
    "Green anemones on the pool floor and the low rock, tentacles leaning with the water. They close at a strong surge, at a touch, and when the water leaves them.",
  ),
  range(
    "life",
    "shyness",
    "shyness",
    0.5,
    "How easily the anemones close: only at a hard surge or a direct touch to the left, at any stir to the right.",
    { when: "anemones" },
  ),
  feature(
    "life",
    "fronds",
    "kelp",
    true,
    "how many",
    0.5,
    "Brown fronds on the low rock and in the pool, streaming and fluttering in the current.",
  ),
  feature(
    "life",
    "surfgrass",
    "surfgrass",
    true,
    "how much",
    0.7,
    "Bright green surfgrass in the surge channel, combed flat by every wave that runs through.",
  ),
  feature(
    "life",
    "lettuce",
    "sea lettuce",
    true,
    "how much",
    0.4,
    "Thin, bright green sheets on the pool's shallower floor that lift and flutter in a current.",
  ),
  feature(
    "life",
    "seastars",
    "sea stars",
    true,
    "how many",
    0.45,
    "Ochre and purple sea stars on the low rock and the pool's walls.",
  ),
  feature(
    "life",
    "urchins",
    "urchins",
    true,
    "how many",
    0.45,
    "Purple urchins tucked into the deeper hollows of the pool.",
  ),
  range(
    "life",
    "response",
    "sway",
    0.6,
    "How strongly the fronds and anemones answer the water's flow.",
  ),
  choice(
    "rock",
    "rockType",
    "rock",
    [
      { label: "basalt", value: 0 },
      { label: "granite", value: 1 },
      { label: "sandstone", value: 2 },
    ],
    0,
    "What the platform is: dark basalt, speckled granite or warm sandstone.",
  ),
  range(
    "rock",
    "mussels",
    "mussels",
    0.6,
    "How thickly mussels and barnacles crowd their bands of the shore: mussels low, barnacles higher up.",
  ),
  range(
    "rock",
    "coralline",
    "coralline",
    0.6,
    "Pink coralline crust and red turf where the water stays: the pool and the low shore.",
  ),
  range("rock", "poolSize", "pool size", 0.5, "How big the basin is.", { steady: true }),
  seed(
    "rock",
    "rock",
    "arrangement",
    "Which stretch of shore: the reefs, the basin's outline and notch, its boulders and potholes.",
  ),
  feature(
    "night",
    "glow",
    "bioluminescence",
    false,
    "strength",
    0.6,
    "At night the breaking surf, the surge and every touch glow blue with plankton.",
  ),
  feature(
    "manifold",
    "mark",
    "pebble M",
    false,
    "size",
    0.5,
    "A Manifold M of white quartz pebbles laid on the bed, wavering under the water as the surface moves.",
  ),
  range("manifold", "markX", "across", 0.5, "Where the pebbles lie, left to right.", {
    when: "mark",
    steady: true,
    widget: { kind: "position", y: "markY" },
  }),
  range("manifold", "markY", "height", 0.4, "Where the pebbles lie, bottom to top.", {
    when: "mark",
    steady: true,
  }),
  // The life on the shared components (life.ts): fish from sims/fish.ts, the plants' year and growth.
  feature(
    "life",
    "fish",
    "fish",
    false,
    "how many",
    6,
    "Small rock pool fish idling over the basin's floor, darting off from a touch or a hard surge and drifting back.",
    { options: counts(3, 6, 10) },
  ),
  ...plantKnobs({ group: "life", season: 0.35, growth: 0.4 }),
];

export const tidepoolScene: SceneDef = {
  id: "tidepool",
  title: "Tide pool",
  blurb:
    "A rock pool from above: waves pour over its rim, its anemones and kelp answer the surge, and the light dances on its floor.",
  accent: "#ff6fae",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    sea: {
      title: "Sea",
      blurb:
        "The tide, the swell and the sets that pour into the pool. Tap the water to drop a pebble; drag to trail a finger.",
    },
    light: { title: "Light", blurb: "The light through and on the water." },
    sky: { title: atmosphereGroups.sky.title, blurb: "The time of day over the shore." },
    weather: {
      title: atmosphereGroups.weather.title,
      blurb: "Rain ringing the pool and darkening the rock.",
    },
    life: {
      title: "Life",
      blurb: "What lives in the pool and on the low rock, and how it answers the water.",
    },
    rock: { title: "Rock", blurb: "The platform, its bands of shells and crust, and the pool." },
    night: { title: "Night", blurb: "What glows in the dark water." },
    manifold: {
      title: "Manifold pebbles",
      blurb: "A landmark of its own: an M laid in white pebbles.",
    },
  },
  glsl: tidepoolGlsl,
  entry: "sceneTidepool",
  // Entering: the last of a wave's white water drains back to the sea up the frame and the anemones
  // unfurl; leaving: a wave breaks in from the sea and sweeps down over everything, the anemones
  // snapping shut ahead of it.
  passage: TIDEPOOL_PASSAGE,
  sim: tidepoolSim(params),
  // The water: the sim's surface (sims/shallow.ts) with the breeze's ripples and their caustics on
  // the bed (causticRipples, waterCaustic). Seen from straight above, it mirrors the sky its own way.
  features: { WATER_TIER: WATER_TIERS.caustics },
};
