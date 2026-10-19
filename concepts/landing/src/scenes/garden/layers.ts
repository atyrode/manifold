// The Stone garden preset's layers (ADR 0062 Phase 2b): their manifests, which load without their
// code (shader.ts, sim.ts, build.ts). Each is drawn through the veranda's rig alone (GARDEN_RIG): the
// garden is worked out in garden space (garden depths, GARDEN_METRES each) for that pinhole, its
// horizon the frame's top edge, the wall, the woods, the maple and the border standing where that
// eye sees them, so another rig is not offered them, nor they another rig's layers. The plants (the
// woods, the maple's boughs, the border) are layers of their own, on the garden's records.
//   templeWall   backdrop: the haze of the sky just below the horizon over the wall (no open sky
//                shows), under cloud a grey deck drifting with the wind; the earthen wall and its
//                tiled cap, the eaves dripping in rain; the veranda's boards along the bottom of the
//                view, under the eaves (no rain falls in front of them); the garden's air, and its say
//                over the World's rain (the nearest drops would fall under the roof).
//   gravel       ground: the raked gravel (the height field and when each spot was last raked, two
//                field slots) round islands of weathered stones and moss, the pebble drip line and
//                gutter, the slate M laid nearly flush in it; the layout for the pattern, the
//                arrangement (the composer's seed) and the M is laid on the build worker; the
//                grooves slump and weather, fresh gravel dries. Until the overhead composer (ADR
//                Phase 4, `gardenabove`), the view from straight above, a program of the garden's own
//                (its `gravelCamera` knob; index.ts, code.ts).
//   templeWoods  dressing: the temple woods over the wall, two rows of crowns each on a swaying
//                stem (rooted plants on its records), snow on them, rain shafts between.
//   boughs       dressing: the maple's boughs over the wall (cherry blossom in spring), their dappled
//                shade on the gravel and the border, the leaves they let fall (its sim, on its
//                records): fluttering and tumbling plates that land, lie a while and fade, carried by
//                the composer's gusts; and the passage's boughs swinging in and the exit's flurry.
//   border       cover: ferns and mondo grass along the wall's foot (rooted plants on its records),
//                swaying and following the season.
//   raking       chore: the unseen rake keeping the gravel (its default agent), pass after pass along
//                the layout's plan, and every hand dragged on the gravel raking its own lines; it
//                sweeps lying leaves away. It needs the gravel.
// What each draws is at the top of shader.ts, how each lives at the top of sim.ts. Keys kept from
// the scene: pattern, soften, drying, moss, border, dapple; `season` is the composer's (LayerDef
// .season, the garden's choice of four); `stones` became the composer's `seed`, the leaves' "now"
// the composer's gusts (D4), `speed` the raking chore's amount (`raking-amount`), `leaves` the
// boughs' `leafFall`, `growth` the border's `borderGrowth`, `camera` the gravel's `gravelCamera`,
// `mark` the gravel's `gravelMark`.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { plantKnobs } from "../plants.ts";
import { GARDEN_DATA, GARDEN_RIG, gardenPatterns, gardenSeasons } from "./constants.ts";

/** The veranda's own rig, and no other. */
const VERANDA: CameraRange = {
  eye: [GARDEN_RIG.eye, GARDEN_RIG.eye],
  horizon: [GARDEN_RIG.horizon, GARDEN_RIG.horizon],
  focal: [GARDEN_RIG.focal, GARDEN_RIG.focal],
  pitch: [GARDEN_RIG.pitch, GARDEN_RIG.pitch],
};

/** The garden's time of year, the composer's `season`: a choice of four, read by every garden layer. */
const SEASON = choice(
  "sky",
  "season",
  "season",
  gardenSeasons.map((label, value) => ({ label, value })),
  2,
  "Spring: cherry blossom, its petals drifting down. Summer: a deep green maple, a leaf now and then, dappled shade. Autumn: the maple turns red and lets go of its leaves. Winter: bare branches, and snow lying on the stones, the moss and the wall with none falling; rain (Weather) comes down as snow then, while snow (Weather) falls in any season. The border planting follows the season.",
  { widget: { kind: "sky", part: "season", year: { at: [0.125, 0.375, 0.625, 0.875] } } },
);

/** The plants' growth knob (scenes/plants.ts), the border's: off. */
const [GROWTH] = plantKnobs({ group: "border", growth: 0.4 });

export const templeWallLayer: LayerDef = {
  id: "templeWall",
  title: "Temple wall",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle", "front"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: toggle(
    "layers",
    "templeWall",
    "temple wall",
    false,
    "The garden's earthen wall under its tiled cap, the haze of the sky over it, and the veranda's polished boards along the bottom of the view, under the temple's eaves; in rain the eaves drip and a grey deck drifts over the wall.",
    { icon: "fence" },
  ),
  params: [],
  season: SEASON,
  groups: {},
  // The nearest layer of drops would fall under the temple's roof, from the veranda out to the drip
  // line: it is left out (the library's sheltered form).
  precip: { thin: [1, 0] },
  passes: {
    begin: "templeWallBegin",
    sky: "templeWallSky",
    middle: "templeWallMiddle",
    front: "templeWallFront",
  },
};

export const gravelLayer: LayerDef = {
  id: "gravel",
  title: "Raked gravel",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: toggle(
    "layers",
    "gravel",
    "raked gravel",
    false,
    "White gravel raked into lines and rings round islands of weathered stones and moss, a pebble drip line along the veranda and a gutter at the wall's foot; the grooves slump and soften once raked, and fresh gravel is a little darker until it dries.",
    { icon: "ripple" },
  ),
  params: [
    choice(
      "gravel",
      "pattern",
      "raked pattern",
      gardenPatterns.map((label, value) => ({ label, value })),
      0,
      "Waves: parallel lines meandering across the garden like a slow current, five rings round each island. Straight: the still-water lines of the classic gardens, rings round the islands. Circles: rings spreading out from every stone until they meet the next stone's. The garden is laid out afresh; the rake then keeps it.",
    ),
    range(
      "gravel",
      "soften",
      "weathering",
      0.4,
      "How quickly grooves slump and soften once raked: crisp just behind the rake, gentler the longer since it passed. Drying with the weather, fresh gravel dries faster or slower with it too.",
    ),
    feature(
      "gravel",
      "drying",
      "drying with weather",
      false,
      "dampness",
      0.5,
      "Freshly turned gravel dries with the weather instead of over a fixed minute or two: its damp lingers in the groove bottoms while the crests pale first, faster with more weathering, in sun and wind, slower toward dusk and at night, and not at all in the rain. Dampness: how dark the fresh gravel shows. Off: it is evenly a little darker and dries back over a minute or two.",
    ),
    range(
      "gravel",
      "moss",
      "moss",
      0.6,
      "Moss cushions round the stones: none leaves bare stones in smooth gravel; full gives deep green collars, creeping up the stones' feet.",
    ),
    choice(
      "view",
      "gravelCamera",
      "view",
      [
        { label: "veranda", value: 0 },
        { label: "above", value: 1 },
      ],
      0,
      "Sit on the temple veranda looking across the garden to its earthen wall, or look straight down on it like a plan. Drag on the gravel to rake your own lines.",
      { steady: true },
    ),
    feature(
      "manifold",
      "gravelMark",
      "M stone",
      false,
      "size",
      0.5,
      "A low slab of grey-blue slate in the shape of the Manifold M, set nearly flush in the gravel: worn pale at its edges, lichen on it, a fringe of moss round it, and rings raked round it in its own shape, as round the other stones. The garden is laid out afresh round it.",
    ),
  ],
  season: SEASON,
  groups: {
    gravel: {
      title: "Gravel",
      blurb:
        "The raked pattern, how the grooves weather and the gravel dries, and the stones' moss. The arrangement (Layers) sets the stone islands; drag on the gravel to rake your own lines.",
    },
    view: { title: "View", blurb: "From the veranda, or from above." },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: a slate M among the stones, the gravel raked round it.",
    },
  },
  mark: "gravelMark",
  data: GARDEN_DATA.gravel,
  passes: { ground: "gravelGround" },
};

export const templeWoodsLayer: LayerDef = {
  id: "templeWoods",
  title: "Temple woods",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: toggle(
    "layers",
    "templeWoods",
    "temple woods",
    false,
    "The woods of the temple grounds over the wall: two rows of rounded crowns, the farther paler in the haze, each tree swaying on its stem in the wind and bowing as a gust crosses; snow lies on them in winter and rain hangs in grey shafts between.",
    { icon: "pine" },
  ),
  params: [],
  season: SEASON,
  groups: {},
  requires: ["templeWall"],
  data: GARDEN_DATA.templeWoods,
  passes: { far: "templeWoodsFar" },
};

export const boughsLayer: LayerDef = {
  id: "boughs",
  title: "Maple boughs",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: toggle(
    "layers",
    "boughs",
    "maple boughs",
    false,
    "A maple's boughs reaching over the wall from beyond it, their shade dappling the gravel; they let their leaves go (petals in spring), which flutter and tumble down, lie on the gravel a while and fade or are raked away. The gusts sway the boughs and carry the leaves.",
    { icon: "leaf" },
  ),
  params: [
    range(
      "maple",
      "leafFall",
      "leaf fall",
      0.5,
      "How often a leaf lets go. Light ones flutter, swinging from side to side and gliding up at the end of each swing; heavier ones tumble end over end. They lie on the gravel a while, then fade or are raked away; a gust (Wind) shakes a shower loose and blows lying leaves along the gravel.",
    ),
    range(
      "maple",
      "dapple",
      "dappled shade",
      0.6,
      "The maple's shadow on the gravel, pierced by round flecks of sun; it shows when the sun stands high enough to throw it into the garden.",
    ),
  ],
  season: SEASON,
  groups: {
    maple: { title: "Maple", blurb: "The leaves it lets fall on the gravel, and its shade." },
  },
  data: GARDEN_DATA.boughs,
  passes: { middle: "boughsMiddle" },
};

export const borderLayer: LayerDef = {
  id: "border",
  title: "Border planting",
  composers: ["outdoor"],
  role: "cover",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: feature(
    "layers",
    "border",
    "border planting",
    false,
    "fullness",
    0.6,
    "Ferns and tufts of mondo grass planted along the foot of the wall, in the gutter of dark pebbles: they sway in the wind, bow one after another as a gust crosses, and follow the season (pale young fronds in spring, ferns turning gold in autumn and half of them gone in winter, the evergreen grass dulling). Fullness: how much of the gutter is planted, from a clump here and there to an unbroken border.",
    { icon: "sprout" },
  ),
  params: GROWTH === undefined ? [] : [{ ...GROWTH, key: "borderGrowth" }],
  season: SEASON,
  groups: {
    border: {
      title: "Border",
      blurb: "Whether the border's plants keep growing, replacing their fronds and blades.",
    },
  },
  requires: ["templeWall"],
  data: GARDEN_DATA.border,
  passes: { middle: "borderMiddle" },
};

export const rakingLayer: LayerDef = {
  id: "raking",
  title: "Raking",
  composers: ["outdoor"],
  role: "chore",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: VERANDA,
  switch: feature(
    "layers",
    "raking",
    "raking",
    false,
    "pace",
    0.4,
    "The garden's chore, kept by an unseen hand: a board levels the old pattern just ahead of five tines cutting the new, pass after pass, then lap after lap round the stones, sweeping lying leaves away; and every hand dragged on the gravel (yours, the lab's agents') rakes its own lines. Pace: how fast the unseen rake works its way round; at 0 it rests.",
    { icon: "person" },
  ),
  params: [],
  groups: {},
  requires: ["gravel"],
  passes: {},
};
