// The incense's layers (ADR 0062 Phase 3): their manifests, which load without their code (code.ts).
// Every one is drawn on the incense's frame (the incense at 0.58 of its width), through its rig
// alone (ON_THE_TABLE).
//   shaftWall  backdrop: the room's shell. The dark plaster wall (ink, indigo, umber or washi), the
//              window's light lying on it as a tall pane, crossed by the shadows of what stands in
//              the room (the room's roomCaster: the smoke's and the incense's), the M of lamplight
//              from the next room on it, and the hazy shaft the light crosses the room in (its front
//              veil). Its knobs are the light: the window's, its angle and colour, the walls, the M.
//   lowTable   ground: the low table, the window's light spilling onto its top, the candle and the
//              ember mirrored in it, its front face in shadow.
//   incense    dressing: what burns (a stick in its dish, a cone, a coil on its stand, a backflow
//              mountain), the candle beside it, the smoke and the dust motes in the light; its
//              silhouette, the smoke's and the holder's, is its caster (the shadows on the wall). Its
//              sim owns the fluid, the burner, the doors and the motes, its four textures its fields.
// Space: the room is laid out on the frame, so claims and anchors are in shares of the frame's width
// across (at the rig's minAspect, 1) and metres back from the seat line (README "The interior
// composer").
import type { LayerDef } from "../../composer/types.ts";
import { choice, feature, range, toggle } from "../../params.ts";
import { incenseKinds, ON_THE_TABLE } from "./constants.ts";

export const shaftWallLayer: LayerDef = {
  id: "shaftWall",
  title: "Wall in the light",
  composers: ["interior"],
  role: "backdrop",
  bands: ["far"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_TABLE,
  switch: toggle(
    "layers",
    "shaftWall",
    "wall in the light",
    false,
    "A quiet, dark room: the World's light from a window off to the left (the sun, or the moon at night) crossing it in a hazy shaft and lying on the plaster wall as a tall pane, the shadows of what stands in the room drifting over it.",
    { icon: "mountain" },
  ),
  params: [
    feature(
      "light",
      "window",
      "window light",
      true,
      "brightness",
      0.7,
      "Light from a window off to the left, the World's sun or moon at its hour, falling across the plume onto the wall behind: raking low near sunrise and sunset, steep at noon, gold late in the day, cool by moonlight. The smoke lights up where it drifts through it, brightest in its thinnest wisps, and its shadows curl across the patch of light on the plaster.",
    ),
    choice(
      "light",
      "room",
      "room",
      [
        { label: "ink", value: 0 },
        { label: "indigo", value: 1 },
        { label: "umber", value: 2 },
        { label: "washi", value: 3 },
      ],
      1,
      "The walls: near black, deep indigo, warm umber, or pale washi paper, where the smoke reads like ink.",
    ),
    feature(
      "manifold",
      "mark",
      "M of light",
      false,
      "brightness",
      0.6,
      "Lamplight from the next room falls through an M carved in a transom: a faint M on the wall, and wherever the smoke drifts through the light, it lights up in the M's shape.",
    ),
  ],
  groups: {
    light: {
      title: "Light",
      blurb: "The shaft of light the smoke rises through, and the room around it.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M of lamplight through a carved transom, drawn by the smoke drifting through it.",
    },
  },
  mark: "mark",
  passes: { far: "shaftWallFar", frontVeil: "shaftWallFrontVeil" },
};

export const lowTableLayer: LayerDef = {
  id: "lowTable",
  title: "Low table",
  composers: ["interior"],
  role: "ground",
  bands: ["front"],
  space: { anchors: [], claims: [] },
  camera: ON_THE_TABLE,
  switch: toggle(
    "layers",
    "lowTable",
    "low table",
    false,
    "A low table against the wall, the window's light spilling onto its polished top, the candle's flame mirrored in it.",
  ),
  params: [],
  groups: {},
  passes: { ground: "lowTableGround" },
};

export const incenseLayer: LayerDef = {
  id: "incense",
  title: "Incense",
  composers: ["interior"],
  role: "dressing",
  subject: true,
  bands: ["front"],
  space: {
    anchors: [],
    claims: [
      {
        name: "the incense",
        kind: "exclusive",
        shape: { kind: "box", at: [0.08, 0], half: [0.06, 0.08] },
      },
    ],
  },
  camera: ON_THE_TABLE,
  switch: toggle(
    "layers",
    "incense",
    "incense",
    false,
    "Incense burning on the table: a thread of smoke rising from the ember through the shaft of light, breaking a hand-span up into curls and soft veils.",
    { icon: "sparkle" },
  ),
  params: [
    choice(
      "incense",
      "stick",
      "incense",
      incenseKinds.map((label, value) => ({ label, value })),
      0,
      "Stick: a slim stick in a glazed dish, its ash curling and dropping off. Cone: a small cone, an ember ring creeping down it. Coil: a temple coil on a little stand, the ember travelling round the spiral. Waterfall: a backflow cone on a ceramic mountain, its smoke pouring down the ledges like water.",
    ),
    range(
      "incense",
      "smoke",
      "smoke density",
      0.5,
      "How much smoke rises: a faint thread to the left, a thick, milky plume to the right.",
    ),
    toggle(
      "incense",
      "renew",
      "new incense",
      true,
      "When the incense has burnt down it goes out, the last smoke clears, and a fresh one is set down and lit. Off: the spent one stays cold.",
    ),
    toggle(
      "incense",
      "candle",
      "candle",
      false,
      "A candle beside the incense. Its flame leans and sways in the very drafts that bend the smoke, and its warm light catches the smoke from the side.",
    ),
    range(
      "air",
      "draft",
      "draft",
      0.4,
      "The room's slow, invisible drafts: the thread leans and sways with them, and up under the ceiling the old smoke drifts off to the right. Left: perfectly still air.",
    ),
    range(
      "air",
      "turbulence",
      "turbulence",
      0.4,
      "How soon the laminar thread breaks into curls. Left: it rises smooth and unbroken. Right: it tears into eddies almost as soon as it leaves the ember.",
    ),
    feature(
      "air",
      "vent",
      "ceiling vent",
      false,
      "draw",
      0.5,
      "An extractor high on the right wall, out of view, draws the layered smoke off along the ceiling: the old veils stream away to the right and the room clears sooner. Unlike the draft it stays up under the ceiling and leaves the fresh thread rising from the ember as before. Draw: how hard it pulls.",
    ),
    feature(
      "air",
      "door",
      "door draft",
      true,
      "how often",
      0.3,
      "Now and then a door opens somewhere in the house: a gentle draft sweeps through the room, bends the smoke and tangles it, then the thread finds its way back up.",
    ),
    toggle(
      "air",
      "hand",
      "your hand",
      true,
      "Moving the pointer through the room is a hand moving the air: wave it to bend and tangle the smoke, or fan the ember brighter.",
    ),
    range(
      "air",
      "dust",
      "dust",
      0.3,
      "Dust motes drifting in the shaft of light, carried by the same air as the smoke.",
    ),
  ],
  groups: {
    incense: {
      title: "Incense",
      blurb: "What burns, how much it smokes, a fresh one when it has burnt down, and a candle.",
    },
    air: {
      title: "Air",
      blurb:
        "The drafts and faint currents that bend and curl the smoke, and the dust they carry. Move the pointer to push the air.",
    },
  },
  triggers: ["renew", "door"],
  casters: ["incenseCaster"],
  data: { fields: 4 },
  passes: { front: "incenseFront", frontVeil: "incenseFrontVeil" },
};
