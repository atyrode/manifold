// The lava lamp's layers (ADR 0062 Phase 3): their manifests, which load without their code
// (code.ts).
//   papered    backdrop: the shelf of books and a trailing plant on the shell's papered wall (the
//              wall and the moon's pane on it are the shell's: composer/shell.ts); drawn on the
//              lamp's room's frame alone.
//   sideboard  ground: the lamp's cord across the shell's sideboard and the record sleeve leaning on
//              the wall; drawn on the lamp's room's frame alone.
//   lavaLamp   dressing: the lamp (and its twin), drawn from the room's rig: it stands on any room's
//              ledge at its anchor, 0.4 m tall at the room's scale there, and its light reaches the
//              other layers' surfaces (lavaLampLight). Offered to every room.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line (README "The interior
// composer").
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, seed, toggle } from "../../params.ts";
import { ON_THE_SIDEBOARD } from "./constants.ts";

export const paperedLayer: LayerDef = {
  id: "papered",
  title: "Wall shelf",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_SIDEBOARD,
  switch: toggle(
    "layers",
    "papered",
    "wall shelf",
    false,
    "What stands against the papered wall: a shelf of books and a trailing plant up to the left, lit faintly by the lamp.",
  ),
  params: [
    toggle(
      "room",
      "shelf",
      "shelf",
      false,
      "A wall shelf up to the left: a row of books and a trailing plant, lit faintly by the lamp.",
    ),
  ],
  groups: {
    room: {
      title: "Room",
      blurb: "What stands around the lamp.",
    },
  },
  passes: { far: "paperedFar" },
};

export const sideboardLayer: LayerDef = {
  id: "sideboard",
  title: "Cord and record",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_SIDEBOARD,
  switch: toggle(
    "layers",
    "sideboard",
    "cord and record",
    false,
    "The lamp's cord across the sideboard's top and a record sleeve leaning on the wall.",
  ),
  params: [
    toggle(
      "room",
      "sleeve",
      "record",
      true,
      "A record sleeve leaning on the wall, its record slid half out, the grooves catching the lamp.",
    ),
  ],
  groups: {},
  passes: { ground: "sideboardGround" },
};

export const lavaLampLayer: LayerDef = {
  id: "lavaLamp",
  title: "Lava lamp",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: {
    anchors: [
      { name: "right of the middle", at: [0.155, 0] },
      { name: "left of the middle", at: [-0.12, 0] },
    ],
    claims: [
      {
        name: "the lava lamp",
        kind: "exclusive",
        shape: { kind: "box", at: [0, 0], half: [0.06, 0.08] },
      },
    ],
  },
  camera: {},
  switch: toggle(
    "layers",
    "lavaLamp",
    "lava lamp",
    false,
    "A lava lamp glowing on the ledge: wax heats on the coil, swells, tears free, rises, cools under the cap and sinks back. Its coloured light falls on everything round it.",
    { icon: "sparkle" },
  ),
  params: [
    choice(
      "lamp",
      "wax",
      "colours",
      [
        { label: "red in yellow", value: 0 },
        { label: "purple in blue", value: 1 },
        { label: "green in aqua", value: 2 },
        { label: "white in clear", value: 3 },
      ],
      0,
      "The wax and the liquid it floats in: classic red in yellow on a gold base, purple in blue on silver, green in aqua on black, or white in clear on silver, where the room shows through the liquid. The light the lamp throws on the room takes the liquid's colour.",
    ),
    range(
      "lamp",
      "heat",
      "bulb heat",
      0.5,
      "How hot the bulb runs. Left: a lazy lamp, a blob tearing free of the heap on the coil now and then. Right: a busy one, wax rising and falling all the time.",
    ),
    range(
      "lamp",
      "fill",
      "wax",
      0.5,
      "How much wax is in the lamp: a few small blobs to the left, a deep heap and crowded traffic to the right.",
    ),
    range(
      "lamp",
      "viscosity",
      "wax body",
      0.5,
      "How the wax holds together. Left: silky, runny wax that slides through itself, draws out long thin necks before it lets go, trails long tails and merges into smooth blobs. Middle: the classic lamp. Right: chunky, stiff wax that moves in knobbly lumps, tears off short and keeps its shape.",
    ),
    toggle(
      "lamp",
      "cold",
      "cold start",
      false,
      "The lamp has just been switched on: the wax sits in a solid, pale heap on the coil and the liquid is cloudy. Over a minute or so the liquid clears, the heap softens and stirs, and the first blobs tear free and rise. Now: switch it off and on again.",
    ),
    seed(
      "lamp",
      "pour",
      "pour",
      "How the wax was poured: the sizes of its blobs and where they are when the scene opens.",
    ),
    toggle(
      "lamp",
      "hand",
      "warm with your hand",
      true,
      "Hold the button on the glass: your hand warms the wax under it, which softens, swells and starts to rise.",
    ),
    range(
      "lamp",
      "spill",
      "lamp light",
      0.6,
      "How much of the lamp's coloured light reaches the room: its glow on the wall with the wax's shadows drifting through it, the pool on the ledge, the sheen on what stands round it.",
    ),
    toggle(
      "lamp",
      "twin",
      "second lamp",
      false,
      "A smaller lamp further back beside it, in the next colours along, its wax at its own pace.",
    ),
    toggle(
      "manifold",
      "badge",
      "M in the base",
      true,
      "An M etched into the lamp's metal base: a dark groove catching a little of the bulb's warmth.",
    ),
    feature(
      "manifold",
      "mark",
      "M of wax",
      false,
      "how often",
      0.35,
      "Now and then the wax gathers itself into an M in the middle of the glass, glows, holds it for a few breaths, then lets go and flows on. How often: from every few minutes to about once a minute. Now: gather one at once.",
    ),
  ],
  groups: {
    lamp: {
      title: "Lamp",
      blurb:
        "Its colours, how hot it runs, how much wax it holds and how that wax flows, a cold start, the light it throws, a second lamp. Hold the button on the glass to warm the wax.",
    },
    manifold: { title: "Manifold mark", blurb: "The Manifold M: one at a time." },
  },
  triggers: ["cold", "mark"],
  mark: "mark",
  lights: [{ name: "the lava lamp", glsl: "lavaLampLight" }],
  data: { fields: 3 },
  passes: { front: "lavaLampFront" },
};
