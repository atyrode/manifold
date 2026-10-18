// The dunes preset's layers (ADR 0062 Phase 2a): their manifests, which load without their code
// (shader.ts, sim.ts). Both are drawn through the dunes' aerial rig alone (DUNES_RIG, some 80 m over
// the sand): the dune field is a sim in grid cells of 5 m and its sky staging is cut for that height,
// so another rig is not offered them, nor they another rig's layers.
//   desert  backdrop: the World's sky with the desert's dust low on it, the dune sea beyond the field
//           closed by the dust, the desert air (the World's fog taken over as its dust, with a hard
//           wind a sandstorm that dims the sun and drives sheets of dust across the view), the heat
//           shimmer bending every layer's ray and the mirage along the horizon under a high sun.
//   dunes   ground: the live dune field (Werner's slab model, sim.ts, in two field slots) ray-marched
//           out to the dust, its ripples and blowing sand, the sandstone M standing in it, the veil of
//           sand of the scene's passage and the sand poured under every hand; and, until the
//           overhead composer (ADR Phase 4, `dunesabove`), the view from straight above, a program
//           of the dunes' own (its `camera` knob; index.ts, code.ts).
// What each draws is at the top of shader.ts, how the sand lives at the top of sim.ts.
import type { CameraRange, LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { DUNES_RIG } from "./constants.ts";

/** The dunes' own rig, and no other. */
const AERIAL: CameraRange = {
  eye: [DUNES_RIG.eye, DUNES_RIG.eye],
  horizon: [DUNES_RIG.horizon, DUNES_RIG.horizon],
  focal: [DUNES_RIG.focal, DUNES_RIG.focal],
  pitch: [DUNES_RIG.pitch, DUNES_RIG.pitch],
};

export const desertLayer: LayerDef = {
  id: "desert",
  title: "Desert",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: AERIAL,
  switch: toggle(
    "layers",
    "desert",
    "desert",
    false,
    "The sand sea running on to the horizon under the desert's air: never quite clear, ochre dust in fog, a sandstorm in a hard wind; heat shimmer and mirage under a high sun.",
    { icon: "sun" },
  ),
  params: [
    range(
      "desert",
      "heat",
      "heat shimmer",
      0.5,
      "When the sun stands high, hot air wavers over the far dunes and the distance turns to a mirage.",
    ),
  ],
  groups: {
    desert: {
      title: "Desert air",
      blurb:
        "The air over the sand sea: the World's fog is its dust, and with a hard wind it becomes a sandstorm; a high sun on dry sand makes the distance shimmer.",
    },
  },
  // The passes after the dune field and before the World's birds are the middle band's: the mirage
  // over the far sand there, the sandstorm's sheets after the birds.
  passes: {
    begin: "desertBegin",
    sky: "desertSky",
    far: "desertFar",
    middle: "desertMiddle",
    middleVeil: "desertMiddleVeil",
  },
};

export const dunesLayer: LayerDef = {
  id: "dunes",
  title: "Dune field",
  composers: ["outdoor"],
  role: "ground",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: AERIAL,
  switch: toggle(
    "layers",
    "dunes",
    "dune field",
    false,
    "Real dunes on the sand under you, formed and marched downwind by the wind; click to drop a heap of sand.",
    { icon: "dunes" },
  ),
  params: [
    range(
      "dunes",
      "sand",
      "sand supply",
      0.45,
      "Little sand gathers into lone crescent barchans on bare ground; more links them into wavy barchanoid ridges; plenty buries the ground under long transverse dunes. The field is laid out afresh when you let go.",
    ),
    range(
      "dunes",
      "ripples",
      "ripples",
      0.7,
      "Fine wind ripples combed across the sand, square to the wind; the slip faces stay smooth.",
    ),
    feature(
      "dunes",
      "drift",
      "blowing sand",
      true,
      "amount",
      0.6,
      "Sand skimming up the windward slopes and streaming off the crests in veils; grows with the wind.",
    ),
    choice(
      "view",
      "camera",
      "view",
      [
        { label: "aerial", value: 0 },
        { label: "overhead", value: 1 },
      ],
      0,
      "Look low across the dune sea to the horizon, or straight down on it like a satellite picture.",
      { steady: true },
    ),
    feature(
      "manifold",
      "dunesMark",
      "sandstone M",
      false,
      "size",
      0.5,
      "A lone wind-worn sandstone M standing in the dunes, throwing a long shadow; sand drifts against its legs and trails away in its lee.",
    ),
  ],
  groups: {
    dunes: {
      title: "Dunes",
      blurb:
        "How much sand the wind has to work with, and the texture of its surface. The arrangement re-seeds the field.",
    },
    view: { title: "View", blurb: "Across the dunes to the horizon, or from high above." },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: a weathered sandstone M out in the dunes.",
    },
  },
  mark: "dunesMark",
  data: { fields: 2 },
  // The passes after the ground and before the World's birds are the middle band's: the sand blowing
  // off the crests the rays skimmed; then, over the birds, the passage's veil and the poured sand.
  passes: {
    begin: "dunesBegin",
    ground: "dunesGround",
    middle: "dunesMiddle",
    middleVeil: "dunesMiddleVeil",
    shade: "dunesShade",
  },
};
