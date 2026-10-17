// A river delta from above, as a satellite time-lapse. The water, the sand and silt it carries and
// the plants on the banks are a live simulation on the GPU (sim.ts: shallow water over an eroding,
// silting bed), so channels really split at their mouth bars, wander, silt up and drown, and the
// river now and then breaks out to build a new lobe; the shader (shader.ts) shows it as a satellite
// picture, a false-colour infrared scene or a surveyor's chart.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { DELTA_PASSAGE } from "./constants.ts";

/** In `palette` knob order: the shader's K_palette. */
const PALETTES = ["satellite", "infrared", "chart"] as const;
const CHART = PALETTES.indexOf("chart");

const params: readonly ParamDef[] = [
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
    { trigger: 0 },
  ),
  range("river", "speed", "time-lapse", 1, "How fast the years go by.", {
    min: 0.25,
    max: 3,
    step: 0.05,
  }),
  seed(
    "river",
    "landscape",
    "landscape",
    "Another valley, river course and delta, laid out mature and then left to the water.",
  ),
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
    "view",
    "clouds",
    "clouds",
    false,
    "cover",
    0.3,
    "A few small fair-weather clouds drifting over, their shadows sliding across the land below (satellite and infrared).",
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
];

export const deltaScene: SceneDef = {
  id: "delta",
  title: "Delta",
  blurb: "A river building its delta into the sea, seen from orbit. Drag to dig a new channel.",
  accent: "#3fb8a6",
  look: { color: "full", levels: 4 },
  params,
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
    land: {
      title: "Land",
      blurb: "What grows on the ground the river leaves alone, and what your hand does to it.",
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
  code: () => import("./code.ts"),
  passage: DELTA_PASSAGE,
  // The chart is printed on paper: the page copy goes dark on it.
  theme: paletteTheme(params, "palette", (palette) => palette === CHART),
};
