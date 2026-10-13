// A beach by moonlight, looking out to sea: surf rolls in, breaks and runs up the sand, and plankton
// (Noctiluca scintillans) flashes electric blue wherever the water is disturbed. By default the moon
// has just risen over the sea, right of ahead, and lays its path across the breakers. By day it is
// an ordinary turquoise seaside. The pointer's wake is tracked on the CPU (sim.ts) and read as uSim0.
import { feature, range, toggle, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { shoreGlsl } from "./shader.ts";
import { shoreSim } from "./sim.ts";

const params: ParamDef[] = [
  range("surf", "size", "wave size", 0.5, "How tall the breakers stand: small ones spill close in, big ones curl over further out and run higher up the sand."),
  range("surf", "period", "wave period", 8, "Seconds between waves: short for a busy surf, long for a slow, deep rhythm.", { min: 5, max: 14, step: 0.5 }),
  feature("glow", "glow", "bioluminescence", true, "strength", 0.7, "Plankton that flash electric blue wherever the water is disturbed: breaking crests, the edge of the swash, bursting foam. Only visible in the dark."),
  range("glow", "sparkles", "sparkles", 0.5, "Foam bubbles bursting on the wet sand as the water drains, each with a spark of light.", { when: "glow" }),
  toggle("glow", "stir", "stir with pointer", true, "Moving the pointer over the water or the wet sand stirs the plankton into glowing swirls.", { when: "glow" }),
  feature("glow", "fish", "fish", false, "frequency", 0.3, "Now and then a school of fish darts through the shallows, leaving trails of light behind it at night.", { trigger: 0 }),
  // 0.82: the evening moon six degrees up, in frame (the shader turns the sky to face moonrise).
  ...skyKnobs({ time: 0.82 }),
  ...weatherKnobs({ rain: true, fog: true, wind: true, lightning: 1 }),
  toggle("manifold", "mark", "M in the sand", false, "An M drawn in the wet sand: every wave that washes over it lights it up blue, then it fades until the next."),
];

export const shoreScene: SceneDef = {
  id: "shore",
  title: "Shore",
  blurb: "Surf on a night beach, flashing blue wherever the water breaks.",
  accent: "#2ee6ff",
  // Designed in full colour; the plankton light is the accent in two-tone mode.
  look: { color: "full", levels: 4 },
  params,
  groups: {
    surf: { title: "Surf", blurb: "The breakers: how big they stand and how often they come in." },
    glow: { title: "Bioluminescence", blurb: "Plankton that light up when the water is stirred: by the surf, by fish, by you." },
    sky: atmosphereGroups.sky,
    weather: atmosphereGroups.weather,
    manifold: { title: "Manifold mark", blurb: "A landmark of its own: an M drawn in the sand where the waves reach it." },
  },
  glsl: shoreGlsl,
  entry: "sceneShore",
  sim: shoreSim,
  // A sunlit beach is bright sand and sea: the copy needs dark ink on it, from the time the sun is
  // about 12 degrees up (full daylight in the sky library) until it sinks back there. With the day
  // cycle running the light keeps changing, so the page stays on the night theme. The shader's ink
  // follows the page (inkOf).
  theme: skyTheme(params),
};
