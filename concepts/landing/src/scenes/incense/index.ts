// Incense smoke in a quiet, dark room: a thread rising from the ember through a shaft of window
// light, breaking a hand-span up into curls and soft veils. The smoke is a fluid simulated on the
// GPU and the incense burns down on the CPU (sim.ts); the room, the light and the smoke are drawn
// in shader.ts.
import { choice, feature, range, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { incenseGlsl } from "./shader.ts";
import { incenseKinds, incenseSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("incense", "stick", "incense", incenseKinds.map((label, value) => ({ label, value })), 0, "Stick: a slim stick in a glazed dish, its ash curling and dropping off. Cone: a small cone, an ember ring creeping down it. Coil: a temple coil on a little stand, the ember travelling round the spiral. Waterfall: a backflow cone on a ceramic mountain, its smoke pouring down the ledges like water."),
  range("incense", "smoke", "smoke density", 0.5, "How much smoke rises: a faint thread to the left, a thick, milky plume to the right."),
  toggle("incense", "renew", "new incense", true, "When the incense has burnt down it goes out, the last smoke clears, and a fresh one is set down and lit. Off: the spent one stays cold.", { trigger: 1 }),
  range("air", "draft", "draft", 0.4, "The room's slow, invisible drafts: the thread leans and sways with them. Left: perfectly still air."),
  range("air", "turbulence", "turbulence", 0.4, "How soon the laminar thread breaks into curls. Left: it rises smooth and unbroken. Right: it tears into eddies almost as soon as it leaves the ember."),
  feature("air", "door", "door draft", true, "how often", 0.3, "Now and then a door opens somewhere in the house: a gentle draft sweeps through the room, bends the smoke and tangles it, then the thread finds its way back up.", { trigger: 0 }),
  toggle("air", "hand", "your hand", true, "Moving the pointer through the room is a hand moving the air: wave it to bend and tangle the smoke, or fan the ember brighter."),
  feature("light", "window", "window light", true, "brightness", 0.7, "A shaft of light from a window off to the left. The smoke glows where it drifts through it, brightest in its thinnest wisps, and casts soft shadows down the shaft."),
  range("light", "angle", "light angle", 0.4, "Where the light comes from: low and raking from the left, or steep from high up.", { when: "window" }),
  choice("light", "tint", "light colour", [{ label: "moon", value: 0 }, { label: "morning", value: 1 }, { label: "late sun", value: 2 }], 0, "Cool moonlight, a pale morning, or the low gold of a late afternoon.", { when: "window" }),
  choice("light", "room", "room", [{ label: "ink", value: 0 }, { label: "indigo", value: 1 }, { label: "umber", value: 2 }, { label: "washi", value: 3 }], 1, "The walls: near black, deep indigo, warm umber, or pale washi paper, where the smoke reads like ink."),
  range("light", "dust", "dust", 0.3, "Dust motes drifting in the shaft of light, carried by the same air as the smoke."),
  toggle("light", "candle", "candle", false, "A candle beside the incense. Its flame leans and sways in the very drafts that bend the smoke, and its warm light catches the smoke from the side."),
  feature("manifold", "mark", "M of light", false, "brightness", 0.6, "Lamplight from the next room falls through an M carved in a transom: a faint M on the wall, and wherever the smoke drifts through the light, it lights up in the M's shape."),
];

export const incenseScene: SceneDef = {
  id: "incense",
  title: "Incense",
  blurb: "A thread of smoke rising through a shaft of light, curling into veils.",
  accent: "#ff6a1f",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    incense: { title: "Incense", blurb: "What burns, how much it smokes, and a fresh one when it has burnt down." },
    air: { title: "Air", blurb: "The drafts and faint currents that bend and curl the smoke. Move the pointer to push the air." },
    light: { title: "Light", blurb: "The shaft of light the smoke rises through, the room around it, and a candle." },
    manifold: { title: "Manifold mark", blurb: "An M of lamplight through a carved transom, drawn by the smoke drifting through it." },
  },
  glsl: incenseGlsl,
  entry: "sceneIncense",
  sim: incenseSim(params),
  // Washi walls are pale: the page copy goes dark on them.
  theme: (values) => ((values.room ?? params.find((def) => def.key === "room")?.value ?? 1) > 2.5 ? "paper" : "night"),
};
