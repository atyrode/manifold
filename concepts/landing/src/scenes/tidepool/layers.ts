// The Tide pool preset's layers (ADR 0062 Phase 4, the overhead composer): their manifests, which
// load without their code (shader.ts, sim.ts). The tide pool is drawn in the frame's own units (frame
// heights from its bottom left, the frame 3 m tall) and in the sea's water, so its layers are drawn
// through its span alone (TIDEPOOL_SPAN) and only over salt water: neither the pond's nor the ripple
// tank's layers are offered here (the koi live in fresh water), nor these there.
//   rockPool  bed: the rock platform, laid out per seed (its sim, layout.ts): the reefs, the basin's
//             rim and notch, the bands of lichen, barnacles, mussels and coralline crust, the sea
//             lettuce, sea stars and urchins on it, the pebble M; and the shore's sky, by the time
//             of day and the rain, that lights the patch
//   surge     water: the sea on the GPU (its sim: shallow water over the bed's rock), its surface
//             and the light through it, its white water and night glow, the passage's wash, and the
//             life's records it streams (life.ts); it runs over the bed's rock, so it needs the bed
//   fronds    life: kelp and surfgrass on their holdfasts, streaming in the water's flow
//   anemones  life: the anemones, closing at a surge, a touch, or out of the water
//   fish      life: rock pool fish idling over the basin's floor
// The life is the water's records, so each life layer needs the water. Keys kept from the scene,
// every one: `fronds`, `anemones` and `fish` became their layers' switches; `rockPool` and `surge`
// are new switches. The "now" slot is the water's sets.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, seed, toggle } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import { plantKnobs } from "../plants.ts";

/** Metres a screen height spans over the tide pool: a sea star a hand across, an urchin a fist. */
export const TIDEPOOL_SPAN = 3;

/** The tide pool's own span, over the sea's water, and no other. */
const TIDEPOOL: CameraRange = { span: [TIDEPOOL_SPAN, TIDEPOOL_SPAN], salt: true };

/** The bed's field: the layout (sim.ts). */
export const ROCK_FIELDS = { layout: 0 } as const;
/** The water's fields: its surface, what it carries, the life (sim.ts). */
export const SURGE_FIELDS = { surface: 0, carried: 1, life: 2 } as const;

export const rockPoolLayer: LayerDef = {
  id: "rockPool",
  title: "Rock pool",
  composers: ["overhead"],
  role: "bed",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TIDEPOOL,
  switch: toggle(
    "layers",
    "rockPool",
    "rock pool",
    false,
    "A rock platform by the sea seen from above: reefs running out under the waves, a basin walled by its rim with a notch to the sea, the bands of lichen, barnacles, mussels and pink crust, sea stars and urchins, under the shore's sky.",
    { icon: "stone" },
  ),
  params: [
    ...skyKnobs({ time: 0.42 }),
    ...weatherKnobs({ rain: true }),
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
    feature(
      "rockLife",
      "lettuce",
      "sea lettuce",
      true,
      "how much",
      0.4,
      "Thin, bright green sheets on the pool's shallower floor that lift and flutter in a current.",
    ),
    feature(
      "rockLife",
      "seastars",
      "sea stars",
      true,
      "how many",
      0.45,
      "Ochre and purple sea stars on the low rock and the pool's walls.",
    ),
    feature(
      "rockLife",
      "urchins",
      "urchins",
      true,
      "how many",
      0.45,
      "Purple urchins tucked into the deeper hollows of the pool.",
    ),
    range("rock", "poolSize", "pool size", 0.5, "How big the basin is.", { steady: true }),
    seed(
      "rock",
      "rock",
      "arrangement",
      "Which stretch of shore: the reefs, the basin's outline and notch, its boulders and potholes.",
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
  ],
  groups: {
    sky: { ...atmosphereGroups.sky, blurb: "The time of day over the shore." },
    weather: {
      ...atmosphereGroups.weather,
      blurb: "Rain ringing the pool and darkening the rock.",
    },
    rock: { title: "Rock", blurb: "The platform, its bands of shells and crust, and the pool." },
    rockLife: {
      title: "On the rock",
      blurb: "What lies on the rock and the pool's floor: sea lettuce, sea stars, urchins.",
    },
    manifold: {
      title: "Manifold pebbles",
      blurb: "A landmark of its own: an M laid in white pebbles.",
    },
  },
  mark: "mark",
  passes: { begin: "rockPoolBegin", bed: "rockPoolBed", grade: "rockPoolGrade" },
  data: { fields: 1 },
};

export const surgeLayer: LayerDef = {
  id: "surge",
  title: "Surge",
  composers: ["overhead"],
  role: "water",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TIDEPOOL,
  switch: toggle(
    "layers",
    "surge",
    "surge",
    false,
    "The sea over the rock: the swell shoaling and breaking over the reefs, running up the rock and pouring through the notch into the pool, its white water and the light it bends onto the floor. Tap the water to drop a pebble; drag to trail a finger.",
    { icon: "waves" },
  ),
  params: [
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
    range(
      "life",
      "response",
      "sway",
      0.6,
      "How strongly the fronds and anemones answer the water's flow.",
    ),
    ...plantKnobs({ group: "life", season: 0.35, growth: 0.4 }),
    feature(
      "night",
      "glow",
      "bioluminescence",
      false,
      "strength",
      0.6,
      "At night the breaking surf, the surge and every touch glow blue with plankton.",
    ),
  ],
  triggers: ["sets"],
  groups: {
    sea: {
      title: "Sea",
      blurb:
        "The tide, the swell and the sets that pour into the pool. Tap the water to drop a pebble; drag to trail a finger.",
    },
    light: { title: "Light", blurb: "The light through and on the water." },
    life: {
      title: "Life",
      blurb: "How the pool's life answers the water, and the year its plants go through.",
    },
    night: { title: "Night", blurb: "What glows in the dark water." },
  },
  passes: { begin: "surgeBegin", float: "surgeFloat", over: "surgeOver" },
  data: { fields: 3 },
  requires: ["rockPool"],
};

export const frondsLayer: LayerDef = {
  id: "fronds",
  title: "Kelp",
  composers: ["overhead"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TIDEPOOL,
  switch: feature(
    "kelp",
    "fronds",
    "kelp",
    true,
    "how many",
    0.5,
    "Brown fronds on the low rock and in the pool, streaming and fluttering in the current.",
  ),
  params: [
    feature(
      "kelp",
      "surfgrass",
      "surfgrass",
      true,
      "how much",
      0.7,
      "Bright green surfgrass in the surge channel, combed flat by every wave that runs through.",
    ),
  ],
  groups: {
    kelp: { title: "Kelp", blurb: "The fronds rooted on the rock, streaming in the water." },
  },
  passes: { floor: "frondsFloor" },
  requires: ["surge"],
};

export const anemonesLayer: LayerDef = {
  id: "anemones",
  title: "Anemones",
  composers: ["overhead"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TIDEPOOL,
  switch: feature(
    "anemones",
    "anemones",
    "anemones",
    true,
    "how many",
    0.55,
    "Green anemones on the pool floor and the low rock, tentacles leaning with the water. They close at a strong surge, at a touch, and when the water leaves them.",
  ),
  params: [
    range(
      "anemones",
      "shyness",
      "shyness",
      0.5,
      "How easily the anemones close: only at a hard surge or a direct touch to the left, at any stir to the right.",
    ),
  ],
  groups: {
    anemones: { title: "Anemones", blurb: "How many open on the rock, and how easily they close." },
  },
  passes: { floor: "anemonesFloor" },
  requires: ["surge"],
};

export const tidepoolFishLayer: LayerDef = {
  id: "fish",
  title: "Rock pool fish",
  composers: ["overhead"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: TIDEPOOL,
  switch: feature(
    "fish",
    "fish",
    "fish",
    false,
    "how many",
    6,
    "Small rock pool fish idling over the basin's floor, darting off from a touch or a hard surge and drifting back.",
    { options: counts(3, 6, 10) },
  ),
  params: [],
  groups: {},
  passes: { floor: "fishFloor" },
  requires: ["surge"],
};
