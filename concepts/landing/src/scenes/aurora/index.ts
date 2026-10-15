// A northern night: a still fjord under slow curtains of aurora, snowy mountains going straight into
// the water, a small red cabin on the far shore with its window lit and a thread of smoke, birches
// on the near bank. The aurora is mirrored in the water (or dimly in the ice), the window and the
// moon draw their paths down it. shader.ts draws everything from smooth functions of the motion
// clock; there is no simulation.
import { choice, feature, range, toggle, type ParamDef } from "../../params.ts";
import { birdKnobs } from "../../shaders/lib/birds.ts";
import { atmosphereGroups, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { auroraGlsl } from "./shader.ts";

const params: readonly ParamDef[] = [
  range("aurora", "glow", "brightness", 0.7, "How bright the curtains burn: a faint arc low in the north to a sky full of light, and the glow it throws on snow, cabin and water."),
  range("aurora", "activity", "activity", 0.5, "How lively the sky is: calm, gently rippling arcs with a single curtain, or deep folds, brightening pulses running along the arcs and a second and third curtain behind."),
  choice(
    "aurora",
    "hue",
    "colour",
    [
      { label: "green", value: 0 },
      { label: "green + violet", value: 1 },
      { label: "red storm", value: 2 },
    ],
    1,
    "The common oxygen green alone, green with a violet fringe along the upper edge, or a storm's green low under a crimson crown.",
  ),
  feature("aurora", "corona", "corona", true, "frequency", 0.35, "Now and then the curtains gather overhead into a corona: rays streaming down from a point high in the sky, for half a minute or so. Now: one at once.", { trigger: 0 }),
  range("water", "ice", "ice", 0, "Open still water, mirroring the whole sky, to the left; to the right the fjord freezes over, first in plates with dark leads between them, then wholly: dull dark ice, hairline cracks, snow lying in patches."),
  range("water", "ripples", "wind ripples", 0, "0: a still fjord, a clear mirror of the sky. Higher lets the wind (under Weather) ruffle the open water: cat's-paws drift downwind and break the reflections into long vertical streaks. Ice stays still."),
  range("night", "stars", "stars", 0.7, "How many stars show: none to the left, a dark northern sky to the right. The aurora outshines the ones behind it."),
  feature("night", "moon", "crescent moon", true, "phase", 0.25, "A moon low over the mountains: a thin crescent to a full disc. It lights the snow and draws a path of glints down the water."),
  toggle("night", "cabin", "cabin", true, "A small red cabin on the far shore with its window lit by the fire, its light drawn down the water, and a thread of smoke leaning with the wind."),
  ...birdKnobs({ group: "night", kind: "geese", help: "Birds crossing the night sky, geese by default, a skein migrating across the curtains: dark against the light, mirrored in the open water, behind the birches on the near bank; few fly in snow." }),
  ...weatherKnobs({ snow: true, fog: true, wind: true }),
  toggle("manifold", "mark", "aurora M", false, "A curtain folds itself into the Manifold M high in the sky, with the same vertical rays as the rest, breathing slowly. It shows within a few seconds of switching it on."),
];

export const auroraScene: SceneDef = {
  id: "aurora",
  title: "Northern lights",
  blurb: "A fjord at night under slow curtains of aurora; a red cabin, birches, snow.",
  accent: "#4cf08c",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    aurora: { title: "Aurora", blurb: "The curtains overhead and in the water: how bright, how lively, which colours, and the corona that gathers now and then." },
    water: { title: "Water", blurb: "Open water that mirrors the sky, or a fjord freezing over." },
    night: { title: "Night", blurb: "The stars, the moon, the cabin on the far shore, and birds crossing the sky." },
    weather: { title: atmosphereGroups.weather.title, blurb: "Snow falls from a closing sky, hiding the aurora and whitening the land; mist lies on the fjord; the wind leans the smoke." },
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: the M, folded into a curtain of the aurora." },
  },
  glsl: auroraGlsl,
  entry: "sceneAurora",
  // Entering, the camera comes down from the stars while the curtains unfurl and the smoke climbs;
  // leaving, the curtains roll up into faint arcs and the camera lifts to the stars.
  passage: { enter: 2.8, exit: 1.4 },
};
