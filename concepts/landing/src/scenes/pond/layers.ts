// The Pond preset's layers (ADR 0062 Phase 4, the overhead composer): their manifests, which load
// without their code (shader.ts, sim.ts). The pond is drawn in the frame's own units (screen heights
// from its centre, the frame some 3 m tall, a koi half a metre long), so its bed, water, stone and
// border are drawn through the pond's span alone (POND_SPAN); the koi, at any span from a metre to
// the pond's, as the same fish at the frame's scale (smaller fish in a smaller patch).
//   pondBed    bed: the pond's floor, pebbles, river stones, rippled sand, slate or moss, and the
//              weeds on it, seen through the water where the surface bends it
//   pondWater  water: the pond's clear water, the sun over it (its light, caustics and glint), the
//              rings of drops and the current, and what floats on it (lily pads on their stems,
//              petals, the paper boat); its sim lays out the pads and petals once a frame
//   stone      dressing: the Manifold stone, a carved M standing in the water
//   border     cover: the border plants grown round the edges (the plant sheet) and the canopy
//              overhead (its sheet), their shade and the god rays through them, and the breeze
//   koi        life: the koi on their loops, or steered to the pointer (koi.ts), and their shadows
// Keys kept from the scene, every one: the koi count is the koi's switch (`koi-amount`), the stone
// the stone's; `pondBed`, `pondWater` and `border` are new switches.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, counts, feature, range, seed, toggle } from "../../params.ts";
import { plantKnobs } from "../plants.ts";

/** Metres a screen height spans over the pond: a koi 0.11–0.17 of it is a koi of 33–51 cm. */
export const POND_SPAN = 3;

/** The pond's own span, and no other. */
const POND: CameraRange = { span: [POND_SPAN, POND_SPAN] };

/** Fields each layer's sim binds (README "Sims in a composition"): the koi's steering and loops. */
export const KOI_FIELDS = { fish: 0, loops: 1 } as const;
/** The water's layout (pads, their roots, petals) and the border's plant and canopy sheets. */
export const WATER_FIELDS = { layout: 0 } as const;
export const BORDER_FIELDS = { plants: 0, canopy: 1 } as const;

export const pondBedLayer: LayerDef = {
  id: "pondBed",
  title: "Pond floor",
  composers: ["overhead"],
  role: "bed",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: POND,
  switch: toggle(
    "layers",
    "pondBed",
    "pond floor",
    false,
    "The pond's floor seen through the water: small pebbles, big smooth river stones, rippled sand, laid slate or a moss bed, with weed growing on it.",
    { icon: "stone" },
  ),
  params: [
    choice(
      "floor",
      "floorType",
      "bed",
      [
        { label: "pebbles", value: 0 },
        { label: "river", value: 1 },
        { label: "sand", value: 2 },
        { label: "slate", value: 3 },
        { label: "moss", value: 4 },
      ],
      0,
      "What the pond floor is made of: small pebbles, big smooth river stones, rippled sand, laid slate, or a soft moss bed.",
    ),
    range("floor", "grain", "grain", 0.5, "Size of the stones, tiles or sand ripples."),
    range("floor", "floorMoss", "moss", 0.5, "How much moss grows between and over the stones."),
    range(
      "floor",
      "floorTint",
      "tint",
      0,
      "Cooler grey-blue stone to the left, warmer ochre to the right.",
      { min: -1, max: 1 },
    ),
    feature(
      "floor",
      "weeds",
      "water weeds",
      true,
      "amount",
      0.5,
      "Clumps of weed on the floor, swaying and bending with the current.",
    ),
  ],
  groups: { floor: { title: "Floor", blurb: "The bed of the pond, and the weed on it." } },
  passes: { bed: "pondBedFloor", floor: "pondBedWeeds" },
};

export const pondWaterLayer: LayerDef = {
  id: "pondWater",
  title: "Pond water",
  composers: ["overhead"],
  role: "water",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: POND,
  switch: toggle(
    "layers",
    "pondWater",
    "pond water",
    false,
    "Clear water over the floor, the sun over it: light rippling across the floor, rings from falling drops, a current, lily pads, petals and now and then a paper boat.",
    { icon: "ripple" },
  ),
  params: [
    range(
      "surface",
      "depth",
      "depth",
      0.5,
      "Deeper water dims the floor, bends it further through the ripples and pushes shadows further from the fish.",
    ),
    feature(
      "light",
      "caustics",
      "caustics",
      true,
      "strength",
      0.6,
      "Light patterns rippling across the pond floor.",
    ),
    range(
      "light",
      "sunPower",
      "intensity",
      0.4,
      "How strong the sunlight is: brighter water and caustics, stronger rays and glare. The World's hour places the sun and lights the pond; this scales it.",
    ),
    feature(
      "surface",
      "lilies",
      "lily pads",
      true,
      "amount",
      0.5,
      "Floating pads, some with a flower.",
    ),
    feature(
      "surface",
      "ripples",
      "ripples",
      true,
      "frequency",
      0.35,
      "Rings spreading from drops landing on the surface.",
    ),
    feature(
      "surface",
      "lilyDrift",
      "pads wander",
      false,
      "speed",
      0.4,
      "Pads wander around their anchor (or across the pond when untethered).",
    ),
    seed(
      "surface",
      "lilySeed",
      "pad placement",
      "Where the lily pads are anchored; re-seed to scatter them anew.",
    ),
    toggle(
      "surface",
      "tether",
      "tethered",
      true,
      "Each pad hangs on a stem rooted in the floor: it leans with the current but cannot drift away. Off: pads are carried along and come back round.",
    ),
    feature(
      "current",
      "current",
      "current",
      false,
      "strength",
      0.35,
      "A flow through the pond: pads lean or travel, weeds bend, light and ripples drift, petals float by.",
    ),
    range(
      "current",
      "currentDir",
      "direction",
      0.1,
      "Which way the water flows, as a turn of the compass.",
      { when: "current", widget: { kind: "compass", strength: "current" } },
    ),
    range("current", "turbulence", "turbulence", 0.4, "Eddies that jostle the pads and petals.", {
      when: "current",
    }),
    feature(
      "current",
      "petals",
      "floating petals",
      true,
      "amount",
      0.5,
      "Petals drifting on the surface, showing how the water moves.",
      { when: "current" },
    ),
    feature(
      "current",
      "boat",
      "paper boat",
      true,
      "frequency",
      0.25,
      "Once in a while a small white origami boat rides the current through: in one side, out the other.",
      { when: "current" },
    ),
  ],
  triggers: ["ripples", "boat"],
  groups: {
    light: {
      title: "Light",
      blurb:
        "Turn the sun up, and let its rays fall through the leaves; the World's hour places it.",
    },
    surface: {
      title: "Surface",
      blurb: "How deep the water is, and what floats and what falls on it.",
    },
    current: {
      title: "Water current",
      blurb: "Make the water flow and watch everything respond to it.",
    },
  },
  passes: {
    begin: "pondWaterBegin",
    water: "pondWaterOver",
    floor: "pondWaterStems",
    cast: "pondWaterCast",
    float: "pondWaterFloat",
    glint: "pondWaterGlint",
    grade: "pondWaterGrade",
  },
  data: { fields: 1 },
  // The World's rain rings it and its wind ruffles it (the overhead composer's K_rain, x.wind); the
  // World's hour places the sun over it and lights the pond, its cloud shades it (x.sun, x.keyGain,
  // x.relight: the preset's painted hour).
  open: true,
  sunlit: true,
};

export const stoneLayer: LayerDef = {
  id: "stone",
  title: "Manifold stone",
  composers: ["overhead"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: POND,
  switch: feature(
    "manifold",
    "stone",
    "manifold stone",
    false,
    "size",
    0.45,
    "A carved stone M rising from the water, with moss on top and water lapping at its edges.",
  ),
  params: [
    range("manifold", "stoneX", "across", 0.45, "Where the stone stands, left to right.", {
      min: -1,
      max: 1,
      steady: true,
      widget: { kind: "position", y: "stoneY" },
    }),
    range("manifold", "stoneY", "height", -0.2, "Where the stone stands, bottom to top.", {
      min: -1,
      max: 1,
      steady: true,
    }),
    range("manifold", "moss", "moss", 0.5, "How much moss has grown over the stone."),
  ],
  groups: {
    manifold: {
      title: "Manifold stone",
      blurb: "A landmark of its own: a carved stone M standing in the water.",
    },
  },
  passes: { stand: "stoneStand" },
};

export const borderLayer: LayerDef = {
  id: "border",
  title: "Border plants",
  composers: ["overhead"],
  role: "cover",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: POND,
  switch: toggle(
    "layers",
    "border",
    "border plants",
    false,
    "Foliage round the pond's edges and a canopy overhead, their dappled shade on the water and the sun's rays breaking through them.",
    { icon: "leaf" },
  ),
  params: [
    feature(
      "light",
      "rays",
      "god rays",
      true,
      "strength",
      0.5,
      "Beams of light from the sun; leaves and canopy break them into shafts.",
    ),
    feature(
      "plants",
      "plants",
      "border plants",
      true,
      "reach",
      0.45,
      "Plants around the pond's edges, each grown its own way: monstera climbing on stalked leaves, ferns and banana fanning from crowns.",
    ),
    choice(
      "plants",
      "plantStyle",
      "show",
      [
        { label: "both", value: 0 },
        { label: "leaves", value: 1 },
        { label: "shadows", value: 2 },
      ],
      0,
      "Leaves: the plants themselves. Shadows: only the shade they cast. Both: leaves with their shadows on the water.",
      { when: "plants" },
    ),
    range(
      "edges",
      "lushTop",
      "top",
      0.6,
      "How much grows along the top edge, in the frame and overhead; 0 leaves it bare and open to the sky.",
      { steady: true },
    ),
    range(
      "edges",
      "lushRight",
      "right",
      0.6,
      "How much grows along the right edge, in the frame and overhead; 0 leaves it bare and open to the sky.",
      { steady: true },
    ),
    range(
      "edges",
      "lushBottom",
      "bottom",
      0.6,
      "How much grows along the bottom edge, in the frame and overhead; 0 leaves it bare and open to the sky.",
      { steady: true },
    ),
    range(
      "edges",
      "lushLeft",
      "left",
      0.6,
      "How much grows along the left edge, in the frame and overhead; 0 leaves it bare and open to the sky.",
      { steady: true },
    ),
    range(
      "plants",
      "bushiness",
      "bushiness",
      0.55,
      "Low: a few distinct plants, each standing on its own. High: packed, overlapping foliage with a dark understory of young leaves.",
      { when: "plants" },
    ),
    toggle(
      "plants",
      "monstera",
      "monstera",
      true,
      "Split leaves on long stalks along a climbing stem.",
      { when: "plants" },
    ),
    toggle(
      "plants",
      "ferns",
      "ferns",
      true,
      "Arching fronds of small leaflets, fanning from a crown.",
      { when: "plants" },
    ),
    toggle(
      "plants",
      "banana",
      "banana leaves",
      true,
      "Long blades torn by the wind, fanning from the top of the stem.",
      { when: "plants" },
    ),
    feature(
      "plants",
      "vines",
      "vines",
      true,
      "amount",
      0.4,
      "Pothos vines trailing in from the edges, heart-shaped leaves along them, curling at the tips.",
      { when: "plants" },
    ),
    feature(
      "plants",
      "flowers",
      "flowers",
      true,
      "amount",
      0.35,
      "Hibiscus and frangipani blooming among the leaves.",
      { when: "plants" },
    ),
    feature(
      "plants",
      "grass",
      "grass",
      true,
      "amount",
      0.4,
      "Tufts of grass along the waterline, blades arching every way.",
      { when: "plants" },
    ),
    seed(
      "plants",
      "plantSeed",
      "arrangement",
      "Which arrangement of plants; re-seed for another.",
      {
        when: "plants",
      },
    ),
    feature(
      "canopy",
      "canopy",
      "canopy overhead",
      false,
      "coverage",
      0.45,
      "Foliage above the camera, never seen directly: only its dappled shadow falls across the pond.",
    ),
    range(
      "canopy",
      "canopySoft",
      "softness",
      0.5,
      "How soft the canopy's shadow is: higher means leaves further above the water.",
      { when: "canopy" },
    ),
    seed("canopy", "canopySeed", "arrangement", "Which canopy; re-seed for another.", {
      when: "canopy",
    }),
    // The plant component's own: the year, growth and gusts (scenes/plants.ts), all off.
    ...plantKnobs({
      group: "plants",
      when: "plants",
      season: 0.35,
      growth: 0.4,
      gusts: { trigger: 0, group: "air" },
    }),
  ],
  triggers: ["gusts"],
  groups: {
    plants: {
      title: "Border plants",
      blurb:
        "Foliage around the edges, each plant grown its own way, with vines, flowers and grass.",
    },
    edges: {
      title: "Edges",
      blurb: "How lush each side is. The border plants and the canopy overhead both follow it.",
    },
    canopy: {
      title: "Canopy",
      blurb: "Leaves above the camera, out of sight, casting dappled shade over everything.",
    },
    air: {
      title: "Breeze",
      blurb:
        "The gusts that cross the pond and stir the plants and the canopy; the wind they blow in is the World's (Weather).",
    },
  },
  passes: { begin: "borderBegin", cover: "borderCover", over: "borderOver" },
  data: { fields: 2 },
  // Its plants and canopy stir in the World's wind (K_wind, the breeze's strength either way).
  open: true,
};

export const koiLayer: LayerDef = {
  id: "koi",
  title: "Koi",
  composers: ["overhead"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: { span: [1, POND_SPAN] },
  switch: feature("koi", "koi", "koi", true, "count", 5, "Koi gliding beneath the surface.", {
    options: counts(3, 5, 8),
  }),
  params: [
    range("koi", "swim", "swim speed", 0.4, "How fast the koi swim."),
    toggle(
      "koi",
      "follow",
      "drawn to mouse",
      false,
      "The koi notice the pointer moving over the water and swim over one after another, milling about it noses in rather than piling up; when it rests a while or leaves, they drift back to their own loops.",
    ),
    range(
      "koi",
      "spacing",
      "personal space",
      0.5,
      "How much room each koi keeps while they crowd round the pointer: 0 lets them slide over one another, 1 keeps them about a body length or more apart.",
      { when: "follow" },
    ),
    range(
      "koi",
      "eager",
      "eagerness",
      0.5,
      "How far off the koi notice the pointer, how quickly they come, and how long they wait once it stops moving.",
      { when: "follow" },
    ),
  ],
  groups: {
    koi: { title: "Koi", blurb: "How many fish, how they swim, and whether they follow you." },
  },
  passes: { begin: "koiBegin", cast: "koiCast", swim: "koiSwim" },
  data: { fields: 2 },
};
