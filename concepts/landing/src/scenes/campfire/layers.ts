// The Campfire preset's layers (ADR 0062 Phase 2b): their manifests, which load without their code
// (shader.ts, sim.ts). Each is drawn through the low seat's own rig alone (CAMPFIRE_RIG): the camp is
// laid out on that frame as the campfire was painted, so another rig is not offered them.
//   pines     backdrop: the World's sky over the clearing and a faint skyglow along its horizon, two
//             rows of far pines in the haze, the two big pines framing the view; the clearing's air.
//   clearing  ground: the soil and the rocky outcrop round the fire, lit by it; wet in rain, snowed on
//             away from the fire.
//   camp      dressing: the tent with its lantern and the backpack at the edge of the light (its
//             switch the old `camp` toggle).
//   campfire  dressing, the subject: the ring of stones, the coals, the logs (burning down with
//             `fuel`, sim.ts: its row of the records atlas), the flames, the mug, the marshmallow on
//             its stick and the log bench with its M; its light falls on every other layer.
//   smoke     life: the column rising from the flames (its switch the old `smoke` feature).
//   sparks    life: the sparks climbing from them (its switch the old `sparks` feature).
// Smoke and sparks rise from the fire, so they need the campfire. Keys kept from the scene: flame,
// lively, marshmallow, fuel, tend, reach, camp, smoke, sparks; the M is `campfireMark` (bees' apiary
// holds `mark`). The sky's knobs are the World's: `shooting` became its `meteors`, the giant planet
// the first of its planets (its `planet*` knobs that planet's own fields), and the World's fog, rain
// and snow fall on the camp.
import type { LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import {
  CAMPFIRE_EYE,
  CAMPFIRE_FIRE_Z,
  CAMPFIRE_FOCAL,
  CAMPFIRE_HORIZON,
  CAMPFIRE_ROWS,
  campfireDepth,
} from "./constants.ts";

/** The seat's own rig, and no other. */
const SEAT_RIG = {
  eye: [CAMPFIRE_EYE, CAMPFIRE_EYE],
  horizon: [CAMPFIRE_HORIZON, CAMPFIRE_HORIZON],
  focal: [CAMPFIRE_FOCAL, CAMPFIRE_FOCAL],
  pitch: [0, 0],
} as const;

/** Metres across at depth z of a point x screen heights right of the centre. */
const across = (x: number, z: number) => (x * z) / CAMPFIRE_FOCAL;

export const pinesLayer: LayerDef = {
  id: "pines",
  title: "Pines",
  composers: ["outdoor"],
  role: "backdrop",
  bands: ["far", "middle"],
  space: { anchors: [], claims: [] },
  camera: SEAT_RIG,
  switch: toggle(
    "layers",
    "pines",
    "pines",
    false,
    "Dark pines round the clearing: two rows of them fading into the haze, and two big ones framing the view, swaying a little in the wind, under the night sky.",
    { icon: "pine" },
  ),
  params: [],
  groups: {},
  passes: { begin: "pinesBegin", sky: "pinesSky", far: "pinesFar", middle: "pinesMiddle" },
};

export const clearingLayer: LayerDef = {
  id: "clearing",
  title: "Clearing",
  composers: ["outdoor"],
  role: "ground",
  bands: ["middle", "front"],
  space: { anchors: [], claims: [] },
  camera: SEAT_RIG,
  switch: toggle(
    "layers",
    "clearing",
    "clearing",
    false,
    "The bare ground of the clearing, soil and a flat rocky outcrop under the fire, lit by its flames; dark and glossy in the rain, snowed on away from the fire.",
    { icon: "stone" },
  ),
  params: [],
  groups: {},
  passes: { ground: "clearingGround" },
};

export const campLayer: LayerDef = {
  id: "camp",
  title: "Tent & pack",
  composers: ["outdoor"],
  role: "dressing",
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the tent",
        kind: "exclusive",
        shape: {
          kind: "disc",
          at: [across(-0.56, campfireDepth(0.2)), campfireDepth(0.2) + 0.6],
          r: 1,
        },
      },
      {
        name: "the pack",
        kind: "exclusive",
        shape: {
          kind: "disc",
          at: [across(-0.285, campfireDepth(0.06)), campfireDepth(0.06)],
          r: 0.25,
        },
      },
    ],
  },
  camera: SEAT_RIG,
  switch: toggle(
    "layers",
    "camp",
    "tent & pack",
    false,
    "A little tent at the edge of the light with a lantern glowing inside, and a backpack leaning by the stones.",
    { icon: "tent" },
  ),
  params: [],
  groups: {},
  passes: { front: "campFront" },
};

export const campfireLayer: LayerDef = {
  id: "campfire",
  title: "Campfire",
  composers: ["outdoor"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the campfire",
        kind: "exclusive",
        shape: { kind: "disc", at: [0, CAMPFIRE_FIRE_Z], r: 0.85 },
      },
      {
        name: "the campfire's clearing",
        kind: "clears",
        shape: { kind: "disc", at: [0, CAMPFIRE_FIRE_Z], r: 1.2 },
      },
      {
        name: "the log bench",
        kind: "exclusive",
        shape: {
          kind: "box",
          at: [across(0.75, campfireDepth(0.027)), campfireDepth(0.027) + 0.2],
          half: [1, 0.25],
        },
      },
    ],
  },
  camera: SEAT_RIG,
  switch: toggle(
    "layers",
    "campfire",
    "campfire",
    false,
    "A small fire in a ring of stones: crossed logs over breathing coals, a slow living fire of layered tongues, a marshmallow toasting on a stick from the log bench, a mug by the stones. Its light falls warm on everything near it.",
    { icon: "flame" },
  ),
  params: [
    range(
      "fire",
      "flame",
      "fire size",
      0.5,
      "How big the fire burns: a small, low blaze on the left, a tall, roaring one to the right. The firelight on the stones, logs and ground grows with it.",
    ),
    range(
      "fire",
      "lively",
      "liveliness",
      0.4,
      "How much the tongues of flame lick and lean: left, a steady candle-like fire; right, tongues that rise and fall and sway more widely. Always slow.",
    ),
    toggle(
      "fire",
      "marshmallow",
      "marshmallow",
      true,
      "A marshmallow on a stick resting over the fire from the bench, slowly toasting from pale to golden to brown and back as it is lifted away and lowered again, over a couple of minutes.",
    ),
    feature(
      "fire",
      "fuel",
      "burning down",
      false,
      "minutes a log lasts",
      6,
      "The logs burn down: they catch and flare, their bark chars black and crazes with glowing cracks, they thin where the flames are hottest and slump into the coals with a shower of sparks, then crumble into a growing bed of embers that slowly greys to ash. Off: the fire stays just as it is.",
      { min: 2, max: 20, step: 1 },
    ),
    toggle(
      "fire",
      "tend",
      "tend the fire",
      true,
      "Someone lays a fresh log on whenever one has burnt away: it smokes until it catches, then flares. Off: the fire burns down to embers and goes out. Now: lay a log on at once.",
      { when: "fuel" },
    ),
    range(
      "fire",
      "reach",
      "firelight reach",
      0.5,
      "How far the firelight carries: a tight pool on the stones, or a warm glow reaching the tent, the bench and the pack.",
    ),
    feature(
      "manifold",
      "campfireMark",
      "carved M",
      false,
      "glow",
      0.7,
      "The Manifold M carved into the log bench, its grooves glowing like embers in the firelight and breathing slowly with the coals.",
    ),
  ],
  groups: {
    fire: {
      title: "Fire",
      blurb:
        "How big and lively the flames are, how far their light carries, a marshmallow toasting over them, and the logs burning down if you let them.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M carved in the log bench, glowing in the firelight.",
    },
  },
  triggers: ["tend"],
  mark: "campfireMark",
  lights: [{ name: "the fire", glsl: "campfireLightAt" }],
  data: { rows: CAMPFIRE_ROWS },
  passes: { front: "campfireFront" },
};

export const smokeLayer: LayerDef = {
  id: "smoke",
  title: "Smoke",
  composers: ["outdoor"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: SEAT_RIG,
  switch: feature(
    "layers",
    "smoke",
    "smoke",
    false,
    "amount",
    0.5,
    "A thin column of smoke rising from the flames, curling and thinning as it climbs; the wind bends it. Lit warm from below, grey-blue above.",
    { icon: "steam" },
  ),
  params: [],
  groups: {},
  requires: ["campfire"],
  passes: { frontVeil: "smokeFrontVeil" },
};

export const sparksLayer: LayerDef = {
  id: "sparks",
  title: "Sparks",
  composers: ["outdoor"],
  role: "life",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: SEAT_RIG,
  switch: feature(
    "layers",
    "sparks",
    "sparks",
    false,
    "amount",
    0.5,
    "Sparks lifting off the flames and drifting up in lazy arcs, glowing yellow then red, and winking out one by one. More: a livelier, crackling fire.",
    { icon: "sparkle" },
  ),
  params: [],
  groups: {},
  requires: ["campfire"],
  passes: { front: "sparksFront" },
};
