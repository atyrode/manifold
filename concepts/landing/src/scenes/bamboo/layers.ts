// The Bamboo grove preset's layers (ADR 0062 Phase 2b): their manifests, which load without their
// code (shader.ts, sim.ts). The grove is painted side-on through its own rig alone (BAMBOO_RIG): its
// culms stand in depth layers laid out for that eye, and the water clock and the lantern keep to the
// frame's corner, so another rig is not offered them. Every one stands in the grove (`requires`).
//   grove         backdrop: the mist between the stems (jade in the depths, green-gold toward the
//                 canopy, lit by the sky), the far canopy breathing with the stems' sway and the
//                 World's sky in its gaps, the god rays falling through them, the drips off the leaves
//                 while they are wet; the grove's air; the canopy keeps half the rain and snow off
//                 (its shelter claim) and thins the drops so they never bury the stems. Its sim moves
//                 everything with weight (sim.ts): the culms, the leaves, the tube and the rings.
//   groveFloor    ground: leaf litter and moss strewn with fallen leaves, gold in a ray, warm in the
//                 lantern's pool, pooled in the rain.
//   culms         dressing: five depth layers of culms (one big near culm framing the left edge) with
//                 leafy branches and canopy sprays, swaying in the composer's gust field (D4), and the
//                 leaves letting go of them.
//   stoneLantern  dressing: the stone lantern on its stepping stone, its window lit as the light
//                 fails (its switch the old `lantern` feature, the glow its amount), its halo in the
//                 mist and its light on every other layer; the M in its window.
//   clock         dressing, the subject: the water clock in the near right corner (its switch the old
//                 `clock` feature, its period the amount): the tube, the spout, the posts, the mossy
//                 basin and its water.
// What each draws is at the top of shader.ts, how the grove moves at the top of sim.ts. Keys kept from
// the scene: clock, knock, stems, leaves; `groveSeed` became the composer's `seed`, the grove's
// `gusts` the composer's gust field, `mist` `groveMist` (the lantern river's river holds `mist`),
// `shafts` `groveShafts` (the forest's), `lantern` the stone lantern's switch `stoneLantern` (bees'
// apiary holds `lantern`), its M `stoneLanternMark`.
import type { Claim, LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { BAMBOO_DATA, BAMBOO_RIG } from "./constants.ts";
import { BAMBOO_DEVICE_DEPTH, BAMBOO_LANTERN, bambooCornerFloor } from "./layout.ts";

/** The grove's own rig, and no other. */
const GROVE_RIG = {
  eye: [BAMBOO_RIG.eye, BAMBOO_RIG.eye],
  horizon: [BAMBOO_RIG.horizon, BAMBOO_RIG.horizon],
  focal: [BAMBOO_RIG.focal, BAMBOO_RIG.focal],
  pitch: [BAMBOO_RIG.pitch, BAMBOO_RIG.pitch],
} as const;

const NO_SPACE = { anchors: [], claims: [] } as const;

/**
 * The canopy over the grove, out to where the mist has swallowed everything: it keeps half the
 * rain and snow off what stands under it (the open sky in its gaps takes them all), and covers grow
 * under its shade by their overgrowth.
 */
const CANOPY_CLAIM: Claim = {
  name: "the canopy",
  kind: "shared",
  shape: { kind: "box", at: [0, 30], half: [40, 30] },
  shelter: 0.5,
};

/** The water clock's footprint, its stones and its basin, at the corner's full size. */
const CLOCK_CLAIM: Claim = (() => {
  const [left] = bambooCornerFloor(-0.56, BAMBOO_DEVICE_DEPTH);
  const [right] = bambooCornerFloor(0, BAMBOO_DEVICE_DEPTH);
  return {
    name: "the water clock",
    kind: "exclusive",
    shape: {
      kind: "box",
      at: [0.5 * (left + right), BAMBOO_DEVICE_DEPTH],
      half: [0.5 * (right - left), 0.25],
    },
  };
})();

/** The stone lantern on its stepping stone. */
const LANTERN_CLAIM: Claim = {
  name: "the stone lantern",
  kind: "exclusive",
  shape: { kind: "disc", at: bambooCornerFloor(BAMBOO_LANTERN.x, BAMBOO_LANTERN.depth), r: 0.35 },
};

export const groveLayer: LayerDef = {
  id: "grove",
  title: "Grove",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "front"],
  space: { anchors: [], claims: [CANOPY_CLAIM] },
  camera: GROVE_RIG,
  switch: toggle(
    "layers",
    "grove",
    "grove",
    false,
    "A bamboo grove in the mist: the far canopy overhead breathing as the stems sway, the sky in its gaps, a few god rays falling through them; the mist hangs between the stems, jade in the depths and green-gold toward the canopy. Rain closes the sky and greys the mist; the canopy shelters the grove but pours through its gaps, and the leaves drip long after.",
    { icon: "rays" },
  ),
  params: [
    range(
      "grove",
      "groveMist",
      "mist",
      0.6,
      "How thick the mist hangs between the stems: the farther culms fade into it first, jade in the depths and green-gold toward the canopy; it drifts in banks, and it is what makes the god rays show.",
    ),
    feature(
      "grove",
      "groveShafts",
      "god rays",
      true,
      "strength",
      0.6,
      "A few rays of sun, or of the moon at night, falling through gaps in the canopy: narrow where they leave the leaves, widening as they fall, combed by the shadows of stems, dust drifting in them. They gild what they cross and breathe in and out over a couple of minutes.",
    ),
  ],
  groups: {
    grove: {
      title: "Grove",
      blurb:
        "The mist between the stems and the god rays falling through the canopy's gaps. Click among the stems to send a breath of wind through them.",
    },
  },
  // The drops are thinned (0.9 far, 0.55 for the near ones) so the rain never buries the grove.
  precip: { thin: [0.9, 0.55] },
  data: BAMBOO_DATA.grove,
  passes: { begin: "groveBegin", sky: "groveSky", far: "groveFar", frontVeil: "groveFrontVeil" },
};

export const groveFloorLayer: LayerDef = {
  id: "groveFloor",
  title: "Grove floor",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: NO_SPACE,
  camera: GROVE_RIG,
  switch: toggle(
    "layers",
    "groveFloor",
    "grove floor",
    false,
    "The grove's floor: leaf litter and moss strewn with fallen leaves, gold where a ray reaches it and warm in the lantern's pool; in the rain it darkens and pools gather in its hollows, mirroring the bright mist.",
    { icon: "leaf" },
  ),
  params: [],
  groups: {},
  requires: ["grove"],
  passes: { ground: "groveFloorGround" },
};

export const culmsLayer: LayerDef = {
  id: "culms",
  title: "Culms",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle", "front"],
  space: NO_SPACE,
  camera: GROVE_RIG,
  switch: toggle(
    "layers",
    "culms",
    "culms",
    false,
    "Jade culms in five depth layers fading into the mist, one big stem framing the left edge, leafy branches and sprays of slender leaves. The gusts sweep through them as visible fronts: the stems bow one after another, the front rows first, sway on after it has passed, and the leaves shiver harder.",
    { icon: "sprout" },
  ),
  params: [
    range(
      "culms",
      "stems",
      "stems",
      0.6,
      "How thickly the culms stand, from a few scattered stems to a dense grove.",
    ),
    feature(
      "culms",
      "leaves",
      "falling leaves",
      true,
      "amount",
      0.4,
      "Now and then a leaf lets go and glides down, swinging side to side; more in a gust, and sometimes at the water clock's clack. Some land on the basin and float a while. Now: a few let go.",
    ),
  ],
  groups: {
    culms: {
      title: "Culms",
      blurb:
        "How thickly the stems stand, and the leaves letting go of them. Brush the stems with the pointer.",
    },
  },
  triggers: ["leaves"],
  requires: ["grove"],
  data: BAMBOO_DATA.culms,
  passes: { middle: "culmsMiddle", front: "culmsFront" },
};

export const stoneLanternLayer: LayerDef = {
  id: "stoneLantern",
  title: "Stone lantern",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["middle"],
  space: { anchors: [], claims: [LANTERN_CLAIM] },
  camera: GROVE_RIG,
  switch: feature(
    "layers",
    "stoneLantern",
    "stone lantern",
    false,
    "glow",
    0.7,
    "A small stone lantern on its stepping stone beside the water clock, its paper window glowing as the light fails, haloed in the mist and warm on the water and the stems.",
    { icon: "lantern" },
  ),
  params: [
    feature(
      "manifold",
      "stoneLanternMark",
      "lantern M",
      false,
      "glow",
      0.8,
      "The Manifold M shining through the lantern's paper window, as if cut into its screen. Now: it glows for a while, even by day.",
    ),
  ],
  groups: {
    manifold: { title: "Manifold mark", blurb: "The M glowing in the stone lantern's window." },
  },
  triggers: ["stoneLanternMark"],
  mark: "stoneLanternMark",
  requires: ["grove"],
  lights: [{ name: "the stone lantern", glsl: "stoneLanternLight" }],
  passes: { begin: "stoneLanternBegin", middle: "stoneLanternMiddle" },
};

export const clockLayer: LayerDef = {
  id: "clock",
  title: "Water clock",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: { anchors: [], claims: [CLOCK_CLAIM] },
  camera: GROVE_RIG,
  switch: feature(
    "layers",
    "clock",
    "water clock",
    false,
    "seconds",
    20,
    "A bamboo tube on a pivot fills slowly from the spout, lifts off its stone, tips past its balance point to pour into the basin, then swings back and clacks: the grove's heartbeat, about this many seconds apart. Now: the spout gushes and it tips at once.",
    { min: 10, max: 40, step: 1, icon: "drop" },
  ),
  params: [
    range(
      "clock",
      "knock",
      "knock",
      1,
      "How hard the tube comes down on its stone. Right: bare stone and a sharp clack: the tube bounces, drops leap from its mouth, a ring runs across the basin and a full knock can startle a leaf from the canopy. Left: a quiet clock: a pad of moss on the stone takes up the end of the swing, so the tube settles with a soft knock, no bounce and no drops, the water barely stirs and no leaf is startled.",
    ),
  ],
  groups: {
    clock: {
      title: "Water clock",
      blurb:
        "The shishi-odoshi: a bamboo tube that fills from the spout, tips into the stone basin and knocks back on its stone, sharply or softly. Click the basin to ring it.",
    },
  },
  triggers: ["clock"],
  requires: ["grove"],
  data: BAMBOO_DATA.clock,
  passes: { front: "clockFront" },
};
