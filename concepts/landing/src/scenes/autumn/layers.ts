// The Autumn park preset's layers (ADR 0062 Phase 2a): their manifests, which load without their code
// (shader.ts, sim.ts). Each is drawn through the park's own rig alone (AUTUMN_RIG): its parts are laid
// out for that pinhole (layout.ts), so another rig is not offered them.
//   parkland  backdrop: the World's sky over the park and three rows of far crowns in haze; the
//             park's air. The land runs to the horizon.
//   parkPath  ground: the lawn and the gravel path, a mottle of finer litter, pools and splashes in
//             rain, the long shadows of what stands in the park; the path clears covers off it.
//   lamp      dressing: the cast-iron lamp post beside the path (its switch the old `lamp` feature, the
//             glow its amount), its warm pool (a light every layer takes) and its halo.
//   maple     dressing, the subject: the great tree (maple, ginkgo or oak) with its canopy, trunk and
//             boughs, the bench on the lawn under it, and its leaves in the air (sim.ts: they let go,
//             flutter and tumble, are pushed by the composer's gusts, and land in the litter).
//   litter    cover: the carpet of fallen leaves on the lawn and the path, and the M of gold leaves
//             the wind sweeps out of it; it lies under the tree, so it needs the maple. It lies where
//             the leaves fall, never thinned by the claims (a gravel path takes leaves, not grass).
//   rake      chore: the agents rake the litter into piles along the path (sim.ts; its switch the old
//             `rake` feature, the reach its amount); the gusts scatter the piles again.
// What each draws is at the top of shader.ts, how the leaves live at the top of sim.ts. Keys kept from
// the scene: species, fall, lamp, rake; `season` is the composer's (LayerDef.season); `parkSeed`
// became the composer's `seed`, autumn's `gusts` the composer's gust field (D4), its M `litterMark`.
import type { Claim, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { AUTUMN_DATA, AUTUMN_RIG } from "./constants.ts";
import { AUTUMN_BENCH, AUTUMN_LAMP, AUTUMN_PATH, AUTUMN_TREE, autumnPathX } from "./layout.ts";

/** The park's own rig, and no other. */
const PARK_RIG = {
  eye: [AUTUMN_RIG.eye, AUTUMN_RIG.eye],
  horizon: [AUTUMN_RIG.horizon, AUTUMN_RIG.horizon],
  focal: [AUTUMN_RIG.focal, AUTUMN_RIG.focal],
  pitch: [AUTUMN_RIG.pitch, AUTUMN_RIG.pitch],
} as const;

/** How far autumn has come: the time of year every park layer shows, the composer's `season`. */
const SEASON = range(
  "sky",
  "season",
  "season progress",
  0.35,
  "How far autumn has come. Early: leaves just turning, some still green, a thin carpet. Middle: a full golden canopy and a growing carpet. Late: browning, the canopy thinning to sky and boughs, the ground deep in leaves.",
  { widget: { kind: "sky", part: "season", year: { span: [0.5, 0.75] } } },
);

/** The gravel path, as far as the carpet reaches: covers keep off it. */
const PATH_CLAIM: Claim = {
  name: "the path",
  kind: "clears",
  shape: {
    kind: "strip",
    points: [3, 6, 9, 12, 15, 20, 25, 30].map((z) => [autumnPathX(z), z] as const),
    half: AUTUMN_PATH.half,
  },
};

export const parklandLayer: LayerDef = {
  id: "parkland",
  title: "Parkland",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: PARK_RIG,
  switch: toggle(
    "layers",
    "parkland",
    "parkland",
    false,
    "The far side of the park: three rows of autumn crowns and a few dark conifers lost in the haze, under the World's sky, with shafts of rain hanging under the deck.",
    { icon: "pine" },
  ),
  params: [],
  season: SEASON,
  groups: {},
  precip: { air: "parklandRainAir" },
  passes: { begin: "parklandBegin", sky: "parklandSky", far: "parklandFar" },
};

export const parkPathLayer: LayerDef = {
  id: "parkPath",
  title: "Park path",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [PATH_CLAIM] },
  camera: PARK_RIG,
  switch: toggle(
    "layers",
    "parkPath",
    "park path",
    false,
    "The park's lawn and a gravel path drifting away to the left, a mottle of fallen leaves thickening with the season; in rain the path darkens, pools gather on the gravel and rings spread in them.",
    { icon: "road" },
  ),
  params: [],
  season: SEASON,
  groups: {},
  passes: { ground: "parkPathGround" },
};

export const lampLayer: LayerDef = {
  id: "lamp",
  title: "Lamp post",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the lamp post",
        kind: "exclusive",
        shape: { kind: "disc", at: [AUTUMN_LAMP.x, AUTUMN_LAMP.z], r: 0.25 },
      },
    ],
  },
  camera: PARK_RIG,
  switch: feature(
    "layers",
    "lamp",
    "lamp post",
    false,
    "glow",
    0.7,
    "A cast-iron lamp beside the path. It lights as the day fades or a storm darkens it, throwing a warm pool on the leaves and on whatever stands near it, haloed in the air.",
    { icon: "lantern" },
  ),
  params: [],
  groups: {},
  lights: [{ name: "the lamp", glsl: "lampLight" }],
  passes: { middle: "lampMiddle", air: "lampAir" },
};

export const mapleLayer: LayerDef = {
  id: "maple",
  title: "Maple",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["middle", "front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the great tree",
        kind: "exclusive",
        shape: { kind: "disc", at: [AUTUMN_TREE.x, AUTUMN_TREE.z], r: 0.9 },
      },
      {
        name: "the bench",
        kind: "exclusive",
        shape: {
          kind: "box",
          at: [AUTUMN_BENCH.x, AUTUMN_BENCH.z],
          half: [AUTUMN_BENCH.half + 0.05, 0.35],
        },
      },
    ],
  },
  camera: PARK_RIG,
  switch: toggle(
    "layers",
    "maple",
    "great tree",
    false,
    "A great tree over the path, the low sun glowing through its canopy, and a bench on the lawn beneath it. Its leaves let go and fall as the plates they are, fluttering and tumbling, turning to show their paler undersides, and the gusts sway its canopy and carry them.",
    { icon: "tree" },
  ),
  params: [
    choice(
      "tree",
      "species",
      "tree",
      [
        { label: "maple", value: 0 },
        { label: "ginkgo", value: 1 },
        { label: "oak", value: 2 },
      ],
      0,
      "The great tree over the path. A maple: five-pointed leaves from crimson to gold, grey bark. A ginkgo: butter-yellow fans on pale furrowed bark, falling light and steady. An oak: russet and ochre lobes on dark ridged bark, heavier, tumbling more. The fallen leaves and the far crowns are its kind.",
    ),
    range(
      "tree",
      "fall",
      "leaf fall",
      0.5,
      "How often a leaf lets go. Light ones flutter, swinging from side to side and gliding up at the end of each swing; heavier ones tumble end over end, each turning to show its paler underside. They land and add to the carpet, and the oldest ones slowly rot away.",
    ),
  ],
  season: SEASON,
  groups: {
    tree: {
      title: "Tree",
      blurb:
        "Which tree stands over the path, and how often it lets go of a leaf; a gust shakes a shower loose.",
    },
  },
  casters: ["mapleShade"],
  // Its leaves in the air (sim.ts): the composer's falling things, in the tree's palette (shader.ts
  // mapleLeafSpeck).
  falling: { kinds: ["leaf"], leaf: "mapleLeafSpeck" },
  passes: { front: "mapleFront" },
};

export const litterLayer: LayerDef = {
  id: "litter",
  title: "Fallen leaves",
  composers: ["outdoor"],
  role: "cover",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: PARK_RIG,
  switch: toggle(
    "layers",
    "litter",
    "fallen leaves",
    false,
    "A carpet of fallen leaves on the lawn and the path, thickest under the tree and along the path's edges, deepening as the season runs on; a gust lifts a swirl of them off the path and carries it along.",
    { icon: "leaf" },
  ),
  params: [
    feature(
      "manifold",
      "litterMark",
      "leaf M",
      false,
      "amount",
      0.8,
      "The wind sweeps a Manifold M together out of the fallen leaves, gold ones laid out along the path like a road marking; the ground round it is cleared. It gathers over about ten seconds. Now: gather it (even while off), and it scatters again after a while.",
    ),
  ],
  season: SEASON,
  groups: { manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." } },
  triggers: ["litterMark"],
  mark: "litterMark",
  requires: ["maple"],
  data: AUTUMN_DATA.litter,
  passes: { middle: "litterMiddle" },
};

export const rakeLayer: LayerDef = {
  id: "rake",
  title: "Leaf raking",
  composers: ["outdoor"],
  role: "chore",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: PARK_RIG,
  switch: feature(
    "layers",
    "rake",
    "leaf raking",
    false,
    "reach",
    0.5,
    "The agents' chore, while the lab has agents in the scene: they rake the fallen leaves along the path into neat piles, a stroke at a time from up and down the path, coming back to each pile until it is done. A gust scatters the piles again and leaves keep falling on the raked ground. Reach: how far along the path each stroke sets out.",
    { icon: "person" },
  ),
  params: [],
  groups: {},
  requires: ["litter"],
  passes: {},
};
