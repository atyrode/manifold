// The Tiny island preset's layers (ADR 0062): their manifests, which load without their code
// (shader.ts). The sky over the sea, the shallows, the gull and the balloon are drawn through the
// island's own camera alone (ISLAND_RIG: pitched over the sea, its lens shifted, backing away on a
// narrow frame), which they are laid out for. The island itself is drawn from the ray, in metres, so
// it also stands out on the open sea's swell (SWELL_RIG), at ISLAND_OFFSHORE.
//   seaSky    backdrop: the island's camera (it hands the World its ray and stages the World's sky in
//             the rig's frame); the World's sky over the sea, the far cumulus drifting along the
//             horizon; the air (the haze off the sky low over the sea, the fog's mist, the rain's air
//             and the drops' light) and the axes the rain and snow are seen through.
//   shallows  ground: the sea, deep blue-green under the World's sky mirrored in its ripples, the sun's,
//             the moon's and the lantern's glitter, swell lines and sparkle, the rain's rings; round
//             the island its turquoise shallows over the sand, the swash and foam, its shadow, and
//             the fish gliding round it (`fish`).
//   island    dressing: the island: its beach, lawn and hill, the fruit trees (`trees`), flowers
//             (`flowers`), the palm, the cottage, the pier and its lantern, driftwood, rocks and
//             bushes, the flowerbed M (`mark`); lit windows and the lantern from dusk.
//   gull      life: the seagull circling the island, its shadow gliding over the sea and the land.
//   balloon   life: a gift balloon drifting across now and then (its switch's amount: how often; its
//             "now": send one), its shadow crossing the island.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { SWELL_RIG } from "../swell/constants.ts";
import { ISLAND_RIG } from "./constants.ts";

/** The island's own camera, and no other. */
const ON_THE_ISLAND: CameraRange = {
  eye: [ISLAND_RIG.eye, ISLAND_RIG.eye],
  horizon: [ISLAND_RIG.horizon, ISLAND_RIG.horizon],
  focal: [ISLAND_RIG.focal, ISLAND_RIG.focal],
  pitch: [ISLAND_RIG.pitch, ISLAND_RIG.pitch],
};

/**
 * The island's own camera and the open sea's (eye 4.14 to 15 m, horizon 0.44 to 0.66, focal 1.2 to
 * 3, pitch 0 to 20 degrees): no other preset's rig falls in these spans. Under a level rig the
 * island is drawn from its ray, standing at ISLAND_OFFSHORE.
 */
const ISLAND_OR_AT_SEA: CameraRange = {
  eye: [ISLAND_RIG.eye, SWELL_RIG.eye],
  horizon: [SWELL_RIG.horizon, ISLAND_RIG.horizon],
  focal: [ISLAND_RIG.focal, SWELL_RIG.focal],
  pitch: [SWELL_RIG.pitch, ISLAND_RIG.pitch],
};

export const seaSkyLayer: LayerDef = {
  id: "seaSky",
  title: "Sky over the sea",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ISLAND,
  switch: toggle(
    "layers",
    "seaSky",
    "sky over the sea",
    false,
    "The sky over a gentle sea, seen from a little way up: toon cumulus drifting along the horizon far behind the island.",
    { icon: "sky" },
  ),
  params: [],
  groups: {},
  // The far rain fuses into the haze, half greyed; the drops' paths close in below the sea.
  precip: { air: "seaSkyRainAir", seen: "seaSkySeen" },
  passes: { begin: "seaSkyBegin", sky: "seaSkySky", middle: "seaSkyMiddle" },
};

export const shallowsLayer: LayerDef = {
  id: "shallows",
  title: "Shallows",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ISLAND,
  switch: toggle(
    "layers",
    "shallows",
    "shallows",
    false,
    "Clear turquoise shallows over the sand round the island, deep blue-green beyond: swell lines rolling in, a soft swash, the sky mirrored in the ripples and the sun's or the moon's glitter on them.",
    { icon: "waves" },
  ),
  params: [
    toggle(
      "shallows",
      "fish",
      "fish shadows",
      true,
      "Three fish gliding round the island in the shallows, seen as dark shapes under the water, tails swishing.",
    ),
  ],
  groups: {
    shallows: { title: "Shallows", blurb: "The fish in the shallows round the island." },
  },
  requires: ["seaSky"],
  passes: { ground: "shallowsGround" },
};

export const islandLayer: LayerDef = {
  id: "island",
  title: "Island",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: ISLAND_OR_AT_SEA,
  switch: toggle(
    "layers",
    "island",
    "island",
    false,
    "A tiny island: a sand beach with driftwood and footprints, a lawn rising to a grassy hill with a cottage, fruit trees and a palm, a pier with a lantern. Its windows and lantern light up at dusk.",
    { icon: "tree" },
  ),
  params: [
    range(
      "island",
      "trees",
      "fruit trees",
      0.65,
      "How many leafy fruit trees stand on the lawn: none to the left, six to the right. Light comes through their crowns, and each bears its own fruit.",
    ),
    range(
      "island",
      "flowers",
      "flowers",
      0.6,
      "Flowers sprinkled over the lawn and the plateau, pink, white, yellow and lilac.",
    ),
    feature(
      "manifold",
      "mark",
      "flowerbed M",
      false,
      "size",
      0.9,
      "A flowerbed in the shape of the Manifold M on the front lawn, edged with pale pebbles and full of pink, white and yellow flowers. It is laid out stretched in depth so that, seen from the island's own camera, it reads as a proper M.",
      { min: 0.6, max: 1, step: 0.05 },
    ),
  ],
  groups: {
    island: {
      title: "Island",
      blurb:
        "The trees and flowers on the lawn; which island it is, its shore, trees and cottage, is the arrangement's (Layers).",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "A landmark of its own: the M as a flowerbed on the lawn.",
    },
  },
  mark: "mark",
  passes: { begin: "islandBegin", middle: "islandMiddle" },
};

export const gullLayer: LayerDef = {
  id: "gull",
  title: "Seagull",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ISLAND,
  switch: toggle(
    "layers",
    "gull",
    "seagull",
    false,
    "A seagull circling the island in a wide, slow loop, its shadow gliding over the sea. It goes home at night and in rain.",
    { icon: "bird" },
  ),
  params: [],
  groups: {},
  passes: { begin: "gullBegin", middle: "gullMiddle" },
};

export const balloonLayer: LayerDef = {
  id: "balloon",
  title: "Gift balloon",
  composers: ["outdoor"],
  role: "life",
  bands: ["middle"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_ISLAND,
  switch: feature(
    "layers",
    "balloon",
    "gift balloon",
    false,
    "how often",
    0.5,
    "Every minute or two a balloon carrying a little present drifts across the sky, its shadow crossing the island. Now: send one.",
    { icon: "balloon" },
  ),
  params: [],
  groups: {},
  triggers: ["balloon"],
  passes: { begin: "balloonBegin", middle: "balloonMiddle" },
};
