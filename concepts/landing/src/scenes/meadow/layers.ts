// The meadow's layers (ADR 0062 Phase 1): their manifests, which load without their code (code.ts).
//   downs        backdrop: the golden-hour sky's staging and air, the hills with the mown M, the tree
//                line at 110 m; the land ends there (x.landZ).
//   grass        cover: the sea of grass, the two layers of near grass, the curtains of heavy rain;
//                grows where the claims let covers grow, by `overgrowth` in shared ones; suppresses
//                the lawn's near blades so the front holds one sea of grass.
//   wildflowers  cover: clumps of meadow flowers standing out of the grass (the shared plants).
//   dandelions   dressing: the clocks in the front band and their seeds in the air.
// What stays the meadow's own, and what each draws, is at the top of shader.ts and sim.ts.
import type { LayerDef } from "../../composer/types.ts";
import { counts, feature, range, toggle } from "../../params.ts";
import { MAX_CLOCKS, MEADOW_ROWS } from "./constants.ts";

/** A standing eye on level ground: the meadow's layers are drawn through any such rig. */
const STANDING = { eye: [1, 2.5], pitch: [0, 0] } as const;

export const downsLayer: LayerDef = {
  id: "downs",
  title: "Downs",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: STANDING,
  switch: toggle(
    "layers",
    "downs",
    "downs",
    false,
    "Soft chalk downs in the golden haze beyond a tree line at the meadow's far edge, under the meadow's own overcast in rain, with shafts of rain over the hills.",
    { icon: "mountain" },
  ),
  params: [
    range(
      "downs",
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
    ),
  ],
  groups: {
    downs: {
      title: "Downs",
      blurb: "The hills and the tree line beyond the field, and the golden haze in the low light.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  triggers: ["mown"],
  mark: "mown",
  passes: { begin: "downsBegin", sky: "downsSky", far: "downsFar", middleVeil: "downsMiddleVeil" },
};

export const grassLayer: LayerDef = {
  id: "grass",
  title: "Grass",
  composers: ["outdoor"],
  role: "cover",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: STANDING,
  switch: toggle(
    "layers",
    "grass",
    "tall grass",
    false,
    "Tall grass all around, out to the land's far edge: the gusts sweep across it as waves of light, and the nearest blades and seed heads frame the view. Move over the page to breathe on it.",
    { icon: "leaf" },
  ),
  params: [
    range(
      "grass",
      "grassHeight",
      "grass height",
      0.6,
      "How tall the grass stands around you: low leaves an open view across the field, high rises past the horizon.",
    ),
    range(
      "grass",
      "grassDensity",
      "grass density",
      0.6,
      "How thickly the grass grows, across the field and in the blades and seed heads framing the view. The middle always stays open onto the field.",
    ),
    range(
      "grass",
      "overgrowth",
      "overgrowth",
      0.35,
      "How far the grass grows into the beds and drifts of a garden it overgrows: none keeps them clear, all lets it through. Paths, walls and hives stay clear.",
    ),
  ],
  groups: {
    grass: {
      title: "Grass",
      blurb:
        "The grass around you, its height and how thickly it grows. Move over the page to breathe on it.",
    },
  },
  overgrowth: "overgrowth",
  suppresses: [
    { layer: "lawn", gate: "LAWN_BLADES", why: "the front holds one sea of grass, not two" },
  ],
  data: { rows: MEADOW_ROWS.grass, fields: 1 },
  passes: {
    begin: "grassBegin",
    middle: "grassMiddle",
    middleVeil: "grassMiddleVeil",
    front: "grassFront",
    frontVeil: "grassFrontVeil",
  },
};

export const wildflowersLayer: LayerDef = {
  id: "wildflowers",
  title: "Wildflowers",
  composers: ["outdoor"],
  role: "cover",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: STANDING,
  switch: feature(
    "layers",
    "wildflowers",
    "wildflowers",
    false,
    "how many",
    0.5,
    "Clumps of ox-eye daisies, buttercups, knapweed and field scabious standing up out of the grass. Each gust bows them as it reaches them and they swing back after it, the near grass hiding their feet. The amount is how many clumps; fewer keep some of more.",
    { icon: "flower" },
  ),
  params: [],
  groups: {},
  data: { rows: MEADOW_ROWS.wildflowers },
  passes: { middle: "wildflowersMiddle" },
};

export const dandelionsLayer: LayerDef = {
  id: "dandelions",
  title: "Dandelion clocks",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: STANDING,
  switch: feature(
    "layers",
    "dandelions",
    "dandelion clocks",
    false,
    "clocks",
    3,
    "Seed heads on long stalks. The gusts pull their seeds off one by one and carry them glowing into the light; a bare clock wilts and a new one opens nearby. Click to blow on the nearest one.",
    { options: counts(...Array.from({ length: MAX_CLOCKS }, (_, i) => i + 1)), icon: "sparkle" },
  ),
  params: [],
  groups: {},
  data: { rows: MEADOW_ROWS.dandelions },
  passes: { front: "dandelionsFront" },
};
