// The Delta preset's layers (ADR 0062 Phase 4, the overhead composer): their manifests, which load
// without their code (shader.ts, sim.ts). The delta is drawn in its grid's units (the grid
// cover-fitted to the frame, GRID_SHORT cells on its short side), kilometres a frame, so its layers
// are drawn through its span alone (DELTA_SPAN): no bench- or pond-scale layer is offered here, nor
// these there. Its open water is the sea (salt), which the river's fresh water runs into within the
// one water layer, so nothing of a fresh pond's is offered beside it either.
//   deltaBed    bed: the land and the sea's bed, laid out per seed (its sim: a valley between hills,
//               a fan of channels with levees and mouth bars, an older lobe gone to marsh, the shelf
//               under the sea), what grows on it and the fields on the settled ground, the M's rock;
//               the palette and the relief the picture is drawn in. Without the water it lies dry,
//               as it was laid out
//   deltaWater  water: the river and the sea on the GPU (its sim: shallow water over the bed it
//               erodes and silts, its plants holding it), the river's stage and silt, its floods,
//               the sea's level, tide and longshore current, and the hand that digs or banks the
//               land; it runs over the bed's layout, so it needs the bed
//   clouds      cover: fair-weather clouds drifting over and their shadows on the land (satellite
//               and infrared), the delta's own weather until the World is drawn over the patch
// Keys kept from the scene, every one: `clouds` became its layer's switch; `deltaBed` and
// `deltaWater` are new switches. The "now" slot is the water's floods.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, seed, toggle } from "../../params.ts";

/**
 * Metres a screen height spans over the delta: the river some 7 of the grid's 256 cells across
 * (sim.ts layDelta, its half width 3.4 cells), a river half a kilometre wide in a frame 20 km tall.
 */
export const DELTA_SPAN = 20_000;

/** The delta's own span, over the sea, and no other. */
const DELTA: CameraRange = { span: [DELTA_SPAN, DELTA_SPAN], salt: true };

/** In `palette` knob order: the shader's K_palette. */
const PALETTES = ["satellite", "infrared", "chart"] as const;
export const DELTA_CHART = PALETTES.indexOf("chart");

/**
 * Each layer's fields (sim.ts): the shader's two views of the ground, the bed's of its layout as it
 * lies dry, the water's of the live state.
 */
export const DELTA_FIELDS = { ground: 0, surface: 1 } as const;

export const deltaBedLayer: LayerDef = {
  id: "deltaBed",
  title: "Land",
  composers: ["overhead"],
  role: "bed",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: DELTA,
  switch: toggle(
    "layers",
    "deltaBed",
    "land",
    false,
    "The land the river works, seen from orbit: a valley between hills opening onto a fan of channels with levees and mouth bars, an older lobe gone to marsh, the shelf under the sea; plants and fields on the settled ground. Without the water it lies dry, as it was laid out.",
    { icon: "mountain" },
  ),
  params: [
    seed(
      "land",
      "landscape",
      "landscape",
      "Another valley, river course and delta, laid out mature and then left to the water.",
    ),
    feature(
      "land",
      "vegetation",
      "vegetation",
      true,
      "vigour",
      0.5,
      "Plants spread over dry ground the river leaves alone, holding its banks together; the river scours them away where it moves. Off, the ground stays bare and loose.",
    ),
    feature(
      "land",
      "farms",
      "farmland",
      true,
      "amount",
      0.35,
      "A patchwork of fields on the old, settled ground away from the river.",
    ),
    choice(
      "land",
      "tool",
      "drag to",
      [
        { label: "dig", value: 0 },
        { label: "bank", value: 1 },
      ],
      0,
      "What dragging across the land does: dig a ditch the river may take, or throw up a bank it must go around.",
    ),
    choice(
      "view",
      "palette",
      "palette",
      PALETTES.map((label, value) => ({ label, value })),
      0,
      "Satellite: the delta as seen from orbit at dusk. Infrared: a false-colour scene with plants red and silt glowing cyan. Chart: a surveyor's map on paper, the shore lined in ink.",
    ),
    range(
      "view",
      "relief",
      "relief",
      0.5,
      "How strongly the low sun picks out banks, levees and hills.",
    ),
    feature(
      "manifold",
      "mark",
      "rock M",
      false,
      "size",
      0.5,
      "An outcrop of hard rock in the shape of the Manifold M in the middle of the delta: the water cannot wear it down, so the channels split and flow around its legs.",
    ),
  ],
  groups: {
    land: {
      title: "Land",
      blurb:
        "Which valley and delta, what grows on the ground the river leaves alone, and what your hand does to it.",
    },
    view: {
      title: "View",
      blurb: "How the picture is rendered: satellite colour, infrared, or a chart.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: an M of hard rock that the river has to go around.",
    },
  },
  mark: "mark",
  passes: { bed: "deltaBedBed", grade: "deltaBedGrade" },
  data: { fields: 2 },
};

export const deltaWaterLayer: LayerDef = {
  id: "deltaWater",
  title: "River and sea",
  composers: ["overhead"],
  role: "water",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: DELTA,
  switch: toggle(
    "layers",
    "deltaWater",
    "river and sea",
    false,
    "The river coming down its valley into the sea, a live simulation: it carries sand and silt, cuts and builds its bed, splits at its mouth bars, floods and switches course, while the sea rises and falls along the coast and drifts its plumes away. Drag across the land to dig a channel.",
    { icon: "waves" },
  ),
  params: [
    range(
      "river",
      "discharge",
      "discharge",
      0.5,
      "How much water the river brings down: a quiet stream that keeps to its channels, or a full river spilling over its banks into the marshes.",
    ),
    range(
      "river",
      "sediment",
      "sediment",
      0.5,
      "How much sand and silt the river carries: a clear river cuts into its bed; a muddy one builds its delta fast, throws out wide plumes and keeps switching course.",
    ),
    range(
      "river",
      "erosion",
      "erosion",
      0.5,
      "How readily the water moves its bed: firm ground keeps the channels where they are; loose ground lets them wander, split and silt up quickly.",
    ),
    feature(
      "river",
      "floods",
      "floods",
      true,
      "strength",
      0.5,
      "Every season or so the river rises, overflows into the marshes and pushes a cloud of mud far out to sea, then falls back over the next minute.",
    ),
    range("river", "speed", "time-lapse", 1, "How fast the years go by.", {
      min: 0.25,
      max: 3,
      step: 0.05,
    }),
    range(
      "coast",
      "seaLevel",
      "sea level",
      0.5,
      "Lower: the delta stands high and dry and its channels cut down to the sea. Higher: the sea floods in over the marshes and the river starts building further inland.",
    ),
    range(
      "coast",
      "current",
      "longshore current",
      0.35,
      "The sea drifting along the coast, to the right (to the left below the middle), trailing the silt plumes downstream.",
      { min: -1, max: 1, widget: { kind: "direction" } },
    ),
    feature(
      "coast",
      "tide",
      "tide",
      true,
      "range",
      0.4,
      "The sea rises and falls: mud flats and sand bars appear and drown again along the delta front.",
    ),
  ],
  triggers: ["floods"],
  groups: {
    river: {
      title: "River",
      blurb:
        "What the river brings down and how hard it works its bed. Drag across the land to dig a channel or bank one up.",
    },
    coast: {
      title: "Coast",
      blurb: "The sea the delta grows into: its level, tides and longshore current.",
    },
  },
  passes: { begin: "deltaWaterBegin", water: "deltaWaterWater" },
  data: { fields: 2 },
  requires: ["deltaBed"],
};

export const deltaCloudsLayer: LayerDef = {
  id: "clouds",
  title: "Clouds",
  composers: ["overhead"],
  role: "cover",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: DELTA,
  switch: feature(
    "weather",
    "clouds",
    "clouds",
    false,
    "cover",
    0.3,
    "A few small fair-weather clouds drifting over, their shadows sliding across the land below (satellite and infrared).",
  ),
  params: [],
  groups: {
    weather: { title: "Weather", blurb: "Fair-weather cloud drifting over the delta." },
  },
  passes: { cover: "cloudsCover", over: "cloudsOver" },
};
