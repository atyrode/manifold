// A bamboo grove in the mist, with a water clock (shishi-odoshi) in the near corner: jade culms in
// five depth layers fading into the mist, leafy branches and a canopy of slender leaves, gusts
// sweeping through them as visible fronts, god rays falling through the canopy, leaves letting go, a
// stone lantern; and the tube that fills from the spout, tips into the mossy stone basin and clacks
// back on its stone, the grove's heartbeat. The culms, the tube, the leaves and the basin's rings are
// simulated in sim.ts; shader.ts paints the grove around them.
import { feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { bambooGlsl } from "./shader.ts";
import { bambooSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  feature("clock", "clock", "water clock", true, "seconds", 20, "A bamboo tube on a pivot fills slowly from the spout, lifts off its stone, tips past its balance point to pour into the basin, then swings back and clacks: the grove's heartbeat, about this many seconds apart. Off: the spout runs dry and the tube rests. Now: the spout gushes and it tips at once.", { min: 10, max: 40, step: 1, trigger: 0 }),
  feature("grove", "gusts", "gusts", true, "frequency", 0.4, "Gusts sweep through the grove as visible fronts: the stems bow one after another, the front rows first, sway on after it has passed, and the leaves shiver harder. Now: a gust.", { trigger: 1 }),
  feature("grove", "leaves", "falling leaves", true, "amount", 0.4, "Now and then a leaf lets go and glides down, swinging side to side; more in a gust, and sometimes at the clack. Some land on the basin and float a while. Now: a few let go.", { trigger: 3 }),
  range("grove", "stems", "stems", 0.6, "How thickly the culms stand, from a few scattered stems to a dense grove."),
  range("grove", "mist", "mist", 0.6, "How thick the mist hangs between the stems: the farther culms fade into it first, jade in the depths and green-gold toward the canopy; it drifts in banks, and it is what makes the god rays show."),
  seed("grove", "groveSeed", "grove", "Where the stems stand and how each one sways; re-seed for another stretch of the grove."),
  feature("light", "shafts", "god rays", true, "strength", 0.6, "A few rays of sun, or of the moon at night, falling through gaps in the canopy: narrow where they leave the leaves, widening as they fall, combed by the shadows of stems, dust drifting in them. They gild what they cross and breathe in and out over a couple of minutes."),
  feature("light", "lantern", "lantern", true, "glow", 0.7, "A small stone lantern on its stepping stone beside the water clock, its paper window glowing as the light fails, haloed in the mist and warm on the water."),
  ...skyKnobs({ time: 0.27 }),
  ...weatherKnobs({ rain: true, wind: true }),
  feature("manifold", "mark", "lantern M", false, "glow", 0.8, "The Manifold M shining through the lantern's paper window, as if cut into its screen. Now: it glows for a while, even by day.", { trigger: 2 }),
];

export const bambooScene: SceneDef = {
  id: "bamboo",
  title: "Bamboo grove",
  blurb: "A misty bamboo grove, and a water clock tipping into a stone basin.",
  accent: "#ffa64d",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    clock: { title: "Water clock", blurb: "The shishi-odoshi: a bamboo tube that fills from the spout, tips into the stone basin and clacks back on its stone." },
    grove: { title: "Grove", blurb: "The stems, the mist between them, the gusts and the falling leaves. Brush the stems with the pointer; click to send a gust, or click the basin to ring it." },
    light: { title: "Light", blurb: "God rays through the canopy, and the stone lantern beside the water clock." },
    sky: atmosphereGroups.sky,
    weather: { title: atmosphereGroups.weather.title, blurb: "Rain closes the sky and greys the mist; the canopy shelters the grove but pours through its gaps, the leaves gather water and drip, long after the rain, stems and stones go dark and glossy, pools gather on the floor and rings spread on the basin. The wind sets how hard the grove sways and which way the gusts travel." },
    manifold: { title: "Manifold mark", blurb: "The M glowing in the stone lantern's window." },
  },
  glsl: bambooGlsl,
  entry: "sceneBamboo",
  sim: bambooSim(params),
};
