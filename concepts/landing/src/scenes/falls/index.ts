// A waterfall seen level from the edge of its plunge pool: a cliff of basalt flows and rusty ash
// beds with fallen blocks heaped at its foot, the fall pouring from a notch in the lip, spray
// rising from the plunge with a rainbow in it, ferns on the ledges and fireflies over the water at
// dusk. All in the shader; no simulation.
import { feature, range } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { fallsGlsl } from "./shader.ts";

export const fallsScene: SceneDef = {
  id: "falls",
  title: "Waterfall",
  blurb: "A waterfall pouring into its pool: spray, a rainbow, ferns on the wet rock.",
  accent: "#7fdce6",
  // Designed in full colour; in two-tone mode the spray carries the accent.
  look: { color: "full", levels: 4 },
  params: [
    range("falls", "flow", "flow", 0.55, "How much water comes over the lip: a thin ribbon breaking into strands at the left end, a roaring white curtain at the right."),
    range("falls", "mist", "mist", 0.6, "Spray thrown up where the water lands: a low haze over the pool at the left end, clouds billowing up the cliff at the right."),
    feature("falls", "rainbow", "rainbow", true, "strength", 0.7, "A rainbow in the spray, 42° from the point opposite the sun. Like a real one it shows only while the sun is up and only where there is spray to hold it, standing higher the lower the sun."),
    range("life", "greenery", "moss & ferns", 0.6, "Moss on the ledges and the wet rock, ferns and creepers hanging from them, ferns on the near bank."),
    feature("life", "fireflies", "fireflies", true, "amount", 0.5, "Fireflies blinking over the pool from dusk on, each flash doubled in the water."),
    ...skyKnobs({ time: 0.55 }),
    ...weatherKnobs({ rain: true, fog: true, wind: true }),
    feature("manifold", "mark", "carved M", false, "parting", 0.5, "A Manifold M cut into the rock behind the falling water, glimpsed through it where it runs thin. A horn of rock at the lip splits the flow in front of it: more parts the water wider."),
  ],
  groups: {
    falls: { title: "Waterfall", blurb: "How much water pours over, the spray it throws up and the rainbow standing in it." },
    life: { title: "Life", blurb: "Moss and ferns on the wet rock, fireflies over the pool after dark." },
    sky: atmosphereGroups.sky,
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: an M carved into the rock behind the water." },
  },
  glsl: fallsGlsl,
  entry: "sceneFalls",
};
