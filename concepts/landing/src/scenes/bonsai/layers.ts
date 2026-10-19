// The bonsai's layers (ADR 0062 Phase 3): their manifests, which load without their code (code.ts).
// Every one is drawn on the bonsai's display (geometry.ts bonsaiPlacement), through its rig alone
// (ON_THE_VERANDA).
//   veranda     backdrop: the room's shell. The wall behind the tree (plaster, shoji or a dark
//               alcove) with the window's patch of sun creeping over it through the day, the paper
//               lamp's warm pool at dusk, the shadows of what stands in the room thrown on it (the
//               room's roomCaster: the tree's, soft by day and big under the lamp; the pot's and the
//               stand's below it), and the veranda's floorboards with the stand's shadow. Its knobs
//               are the wall and the lamp; its light is the World's, through the window behind the
//               eye (the light-only World: no glass in frame).
//   stand       ground: the rosewood stand, slid in and out by the passage, with what falls on it.
//   bonsaiTree  dressing: the tree in its pot on the stand, the moss, the stone with its kintsugi M,
//               the clay figure, the season's leaves in the air and on the moss, the stand and the
//               floor, the World's snow falling and lying; its silhouette is its caster (the
//               shadows on the wall). Its sim owns the year, the snow it lays, the sway, the shoots
//               and everything that falls.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line (README "The interior
// composer").
import type { LayerDef } from "../../composer/types.ts";
import { YEAR_CYCLE_RATE } from "../../climate.ts";
import { choice, feature, range, seed, toggle } from "../../params.ts";
import { ON_THE_VERANDA } from "./constants.ts";

export const verandaLayer: LayerDef = {
  id: "veranda",
  title: "Veranda",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_VERANDA,
  switch: toggle(
    "layers",
    "veranda",
    "veranda",
    false,
    "The wall behind the tree and the veranda's floorboards, the World's sun through the window behind you laying its patch on the wall and creeping over it with the hours, the shadows of what stands in the room thrown on it; a paper lamp lit as the light fails.",
    { icon: "mountain" },
  ),
  params: [
    choice(
      "light",
      "wall",
      "wall",
      [
        { label: "plaster", value: 0 },
        { label: "shoji", value: 1 },
        { label: "dark", value: 2 },
      ],
      0,
      "Behind the tree: warm earthen plaster, a shoji screen of paper and lattice glowing with the day, or a dark alcove.",
    ),
    feature(
      "light",
      "lamp",
      "paper lamp",
      true,
      "glow",
      0.6,
      "A paper lamp off to the left, lit as the light fails: warm light on the tree and its shadow thrown big and soft up the wall.",
    ),
  ],
  groups: {
    light: {
      title: "Light",
      blurb: "What stands behind the tree, and the lamp for the evening.",
    },
  },
  passes: { far: "verandaFar" },
};

export const standLayer: LayerDef = {
  id: "stand",
  title: "Stand",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_VERANDA,
  switch: toggle(
    "layers",
    "stand",
    "stand",
    false,
    "A lacquered rosewood stand on cloud-cut legs, the pot's shadow on its top and the season's leaves lying on it.",
  ),
  params: [],
  groups: {},
  passes: { ground: "standGround" },
};

export const bonsaiTreeLayer: LayerDef = {
  id: "bonsaiTree",
  title: "Bonsai",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the pot",
        kind: "exclusive",
        shape: { kind: "box", at: [0.135, 0], half: [0.235, 0.15] },
      },
    ],
  },
  camera: ON_THE_VERANDA,
  switch: toggle(
    "layers",
    "bonsaiTree",
    "bonsai",
    false,
    "A bonsai in its pot on the stand, living through the year: leaves open, colour and fall, snow settles in winter, new shoots reach out each spring and are trimmed back.",
    { icon: "sparkle" },
  ),
  params: [
    choice(
      "tree",
      "species",
      "tree",
      [
        { label: "pine", value: 0 },
        { label: "maple", value: 1 },
        { label: "cherry", value: 2 },
      ],
      1,
      "A Japanese black pine (evergreen: its new candles rise each spring and are pinched back), a Japanese maple (red new leaves, green summer, crimson autumn, bare winter), or a flowering cherry (a cloud of blossom in early spring, petals drifting down).",
    ),
    seed(
      "tree",
      "treeSeed",
      "tree",
      "How this tree was grown and styled: the line of its trunk, its roots, where the branches leave and how the pads sit. Re-seed for another tree.",
    ),
    choice(
      "tree",
      "pot",
      "pot",
      [
        { label: "unglazed", value: 0 },
        { label: "celadon", value: 1 },
        { label: "cobalt", value: 2 },
        { label: "cream", value: 3 },
      ],
      2,
      "The pot: an unglazed red-brown rectangle with the potter's seal, or an oval in crackled celadon, cobalt blue breaking brown at the rim, or speckled cream.",
    ),
    toggle(
      "tree",
      "figure",
      "clay figure",
      true,
      "A little glazed clay sage in a straw hat, sitting on the moss under the tree.",
    ),
    feature(
      "tree",
      "breeze",
      "breeze",
      true,
      "strength",
      0.35,
      "Air moving through the foliage pads, each swaying at its own pace; now and then a gust that shakes leaves loose in autumn. Off, the air is still and the pads hang still until something moves them: your hover, a snip, or a gust. Hover over the tree to stir the pads. Now: a gust, breeze or no breeze.",
    ),
    toggle(
      "tree",
      "growth",
      "new shoots",
      true,
      "Each spring new shoots reach out beyond the pads (candles on the pine), and an unseen gardener trims them back through the summer to keep the shape. Click a shoot or a twig to snip it yourself; it falls and lies with the leaves, and grows back next spring. Now: a snip.",
    ),
    feature(
      "seasons",
      "year",
      "seasons pass",
      true,
      "minutes per season",
      3,
      "The year turns at this pace: buds and new leaves, full summer pads, autumn colour and leaf fall, bare branches and snow.",
      {
        min: 0.5,
        max: 10,
        step: 0.5,
        widget: { kind: "sky", part: "year" },
        rate: YEAR_CYCLE_RATE,
      },
    ),
    feature(
      "seasons",
      "leaves",
      "falling leaves",
      true,
      "amount",
      0.5,
      "How much comes down when its time comes: maple and cherry leaves in autumn, cherry petals in spring, old pine needles; they settle on the moss, the stand and the floor and rot away through the season. Now: a few let go.",
    ),
    feature(
      "manifold",
      "mark",
      "kintsugi M",
      false,
      "glow",
      0.7,
      "The stone on the moss carries a Manifold M mended into it in gold lacquer, kintsugi style; it catches the sun and the lamp. Now: it gleams.",
    ),
  ],
  // The year it shows is the room's date (the World's, ADR 0062 D20): the composer lists it once.
  season: range(
    "seasons",
    "season",
    "season",
    0.58,
    "Where the year stands: spring at the left end, then summer, autumn and winter. It is the World's date too: the sun through the window stands higher and longer by summer, lower and shorter by winter.",
    { steady: true, widget: { kind: "sky", part: "season", year: { span: [0, 1] } } },
  ),
  groups: {
    tree: {
      title: "Tree",
      blurb:
        "The tree, its pot and stand-mates, the breeze, and the gardener's hand. Hover to stir the pads; click to snip.",
    },
    seasons: {
      title: "Seasons",
      blurb:
        "The year turning on the tree: leaves out, colour and leaf fall; the World's snow lies on it in winter.",
    },
    manifold: { title: "Manifold mark", blurb: "A gold M mended into the stone on the moss." },
  },
  triggers: ["breeze", "growth", "leaves", "mark"],
  mark: "mark",
  casters: ["bonsaiTreeCaster"],
  data: { fields: 4 },
  passes: { front: "bonsaiTreeFront", frontVeil: "bonsaiTreeFrontVeil" },
};
