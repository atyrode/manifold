// A lava lamp late at night: a dark room, a teak sideboard, papered wall, and the lamp glowing on it.
// Wax heats on the coil, swells, draws out a neck and tears free, rises, cools under the cap, pools
// and sinks back to the heap (sim.ts: CPU parcels with temperature, buoyancy, drag and bonds that
// stretch and snap). The shader (shader.ts) draws the wax as a metaball surface through the glass
// and throws the lamp's coloured light about the room.
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { lavaGlsl } from "./shader.ts";
import { LAVA_PASSAGE, lavaSim } from "./sim.ts";

const params: readonly ParamDef[] = [
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
    { trigger: 0 },
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
    "room",
    "spill",
    "lamp light",
    0.6,
    "How much of the lamp's coloured light reaches the room: its glow on the wall with the wax's shadows drifting through it, the pool on the sideboard, the sheen on the record.",
  ),
  range(
    "room",
    "moon",
    "moonlight",
    0.3,
    "Cool light from a window off to the left: a pale pane on the wall, a glint down the glass and the metal.",
  ),
  toggle(
    "room",
    "twin",
    "second lamp",
    false,
    "A smaller lamp further back on the sideboard, in the next colours along, its wax at its own pace.",
  ),
  toggle(
    "room",
    "sleeve",
    "record",
    true,
    "A record sleeve leaning on the wall, its record slid half out, the grooves catching the lamp.",
  ),
  toggle(
    "room",
    "shelf",
    "shelf",
    false,
    "A wall shelf up to the left: a row of books and a trailing plant, lit faintly by the lamp.",
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
    { trigger: 1 },
  ),
];

export const lavaScene: SceneDef = {
  id: "lava",
  title: "Lava lamp",
  blurb: "Wax rising and falling in a glowing lamp on a sideboard, late at night.",
  accent: "#ff4a26",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    lamp: {
      title: "Lamp",
      blurb:
        "Its colours, how hot it runs, how much wax it holds and how that wax flows, and a cold start. Hold the button on the glass to warm the wax.",
    },
    room: {
      title: "Room",
      blurb: "The light the lamp throws about, the moon at the window, and what stands around it.",
    },
    manifold: {
      title: "Manifold mark",
      blurb: "An M etched in the lamp's base, and now and then an M of wax.",
    },
  },
  glsl: lavaGlsl,
  entry: "sceneLava",
  sim: lavaSim(params),
  // Entrance: the wax lies pooled and pale at the bottom, warms, and the first blob tears free and rises.
  // Exit: the coil lets go and the blobs cool, sink and merge back into the pool.
  passage: LAVA_PASSAGE,
};
