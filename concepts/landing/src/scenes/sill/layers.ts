// The window sill's layers (ADR 0062 Phase 3): their manifests, which load without their code
// (code.ts). Every one is drawn on the sill's frame, through its rig alone (ON_THE_SILL).
//   cityWindow  backdrop: the sash window in the back wall, raised onto the city at dusk; the World's
//               sky and weather cross its glass, the city's windows and the neon M across the street.
//               Its light comes into the room (its daylight).
//   sill        ground: the sill's wooden top in the reading lamp's pool, its nosing, the wall and the
//               radiator under it.
//   props       dressing: the plant, the mug and the books on the sill, the steam off the mug.
//   cat         dressing: the cat on the sill, watching the city.
//   curtain     dressing: the linen curtain at the left of the window.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line (README "The interior
// composer").
import type { LayerDef } from "../../composer/types.ts";
import { feature, range, toggle } from "../../params.ts";
import { ON_THE_SILL } from "./constants.ts";

export const cityWindowLayer: LayerDef = {
  id: "cityWindow",
  title: "Window onto the city",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_SILL,
  window: true,
  switch: toggle(
    "layers",
    "cityWindow",
    "window onto the city",
    false,
    "A sash window raised onto a city at dusk: three rows of skyline with windows switching on and off, a neon M on the roof across the street, the World's sky and weather over it all. Its light comes in onto the room.",
    { icon: "mountain" },
  ),
  params: [
    feature(
      "city",
      "lights",
      "city lights",
      true,
      "lit",
      0.45,
      "Windows across the city, each switching on or off now and then as the evening goes on: how many are lit.",
    ),
    toggle(
      "weather",
      "drops",
      "drops on the glass",
      true,
      "Raindrops beading and running down the panes above the open sash, each holding a tiny upside-down picture of the lit city and catching the lamp along its edge.",
      { when: "rain" },
    ),
    feature(
      "manifold",
      "neon",
      "neon M",
      true,
      "brightness",
      0.8,
      "A neon Manifold M on the roof across the street, humming in a soft glow; now and then one stroke winks out or stutters before it catches again. In the rain it glows in the wet air and shines back from the roof, the ledge and the sill; in snow it tints the snow on its frame. Now: a stutter.",
    ),
  ],
  groups: {
    city: {
      title: "City",
      blurb: "The skyline across the street, its windows lighting up and going dark.",
    },
    manifold: { title: "Manifold sign", blurb: "The Manifold M: one at a time." },
  },
  triggers: ["neon"],
  mark: "neon",
  passes: { far: "cityWindowFar", daylight: "cityWindowDaylight" },
};

export const sillLayer: LayerDef = {
  id: "sill",
  title: "Sill",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_SILL,
  switch: toggle(
    "layers",
    "sill",
    "sill",
    false,
    "The window's wooden sill in the reading lamp's pool, wet by the window when rain blows in, and the old radiator under it.",
  ),
  params: [],
  groups: {},
  passes: { ground: "sillGround" },
};

export const propsLayer: LayerDef = {
  id: "props",
  title: "Mug, books and plant",
  composers: ["interior"],
  role: "dressing",
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the plant",
        kind: "exclusive",
        shape: { kind: "box", at: [-0.33, 0], half: [0.045, 0.06] },
      },
      {
        name: "the mug",
        kind: "exclusive",
        shape: { kind: "box", at: [0.085, 0], half: [0.03, 0.06] },
      },
      {
        name: "the books",
        kind: "exclusive",
        shape: { kind: "box", at: [0.405, 0], half: [0.065, 0.06] },
      },
    ],
  },
  camera: ON_THE_SILL,
  switch: toggle(
    "layers",
    "props",
    "mug, books and plant",
    false,
    "A steaming mug, a short stack of books and a potted plant on the sill.",
  ),
  params: [
    feature(
      "room",
      "steam",
      "steam",
      true,
      "amount",
      0.6,
      "Wisps curling up from the mug, drifting with the wind.",
    ),
    toggle(
      "room",
      "plant",
      "plant",
      true,
      "A potted plant at the end of the sill, its leaves nodding in the breeze.",
    ),
  ],
  groups: {
    room: { title: "Room", blurb: "Inside by the open window: the mug and the plant." },
  },
  passes: { middle: "propsMiddle", frontVeil: "propsFrontVeil" },
};

export const catLayer: LayerDef = {
  id: "cat",
  title: "Cat",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the cat",
        kind: "exclusive",
        shape: { kind: "box", at: [0.26, 0], half: [0.065, 0.08] },
      },
    ],
  },
  camera: ON_THE_SILL,
  switch: feature(
    "cat",
    "cat",
    "cat",
    false,
    "size",
    0.5,
    "A cat on the sill with its back to you, watching the city: breathing, twitching an ear, swinging its tail over the edge. Move the pointer and it turns its head to look. Now: it looks back at you over its shoulder and blinks slowly.",
  ),
  params: [
    range(
      "cat",
      "restless",
      "restlessness",
      0.35,
      "How often it moves: ear twitches, tail flicks, glances around. Low is a cat at peace; high, a cat that heard something.",
    ),
  ],
  groups: {
    cat: {
      title: "Cat",
      blurb: "The cat on the sill: how big, how fidgety, and a look back at you.",
    },
  },
  triggers: ["cat"],
  data: { rows: 1 },
  passes: { front: "catFront" },
};

export const curtainLayer: LayerDef = {
  id: "curtain",
  title: "Curtain",
  composers: ["interior"],
  role: "dressing",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_SILL,
  switch: feature(
    "room",
    "curtain",
    "curtain",
    false,
    "breeze",
    0.5,
    "A linen curtain beside the window, stirring as the air comes in; the wind stirs it more.",
  ),
  params: [],
  groups: {},
  passes: { front: "curtainFront" },
};
