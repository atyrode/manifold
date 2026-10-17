// A moonlit sea rolling toward the horizon, on the shared water library (its mirror tier).
import { range, toggle } from "../../params.ts";
import { birdKnobs, birdsGroup } from "../../shaders/lib/birds.ts";
import { WATER_TIERS } from "../../shaders/lib/water.ts";
import { atmosphereGroups, skyComponentKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { SWELL_METEOR_TRIGGER, swellGlsl } from "./shader.ts";

export const swellScene: SceneDef = {
  id: "swell",
  title: "Swell",
  blurb: "A moonlit sea rolling toward the horizon.",
  accent: "#4c6ef5",
  look: { color: "full", levels: 4 },
  // The shader reads each knob through its K_<key> define.
  params: [
    range(
      "sea",
      "height",
      "swell",
      0.5,
      "Height of the long swells: the taller, the sharper their crests, until they break white.",
    ),
    range(
      "sea",
      "chop",
      "chop",
      0.5,
      "Small, fast waves on top of the swell. They break the moon's path into glints near by and widen it far out.",
    ),
    range("sky", "moon", "moon", 0.5, "Moon size."),
    range("sky", "stars", "stars", 0.35, "How many stars."),
    ...skyComponentKnobs({ meteors: { trigger: SWELL_METEOR_TRIGGER } }),
    toggle(
      "manifold",
      "mmoon",
      "M on the moon",
      false,
      "The moon's dark seas form the Manifold M.",
    ),
    range(
      "sea",
      "relief",
      "relief",
      0,
      "0: the waves are painted on a flat sea. Higher gives the nearer waves real height: crests hide the troughs behind them and the arriving swell stands up. Far waves stay flat.",
    ),
    ...birdKnobs({
      kind: "gulls",
      help: "Birds crossing over the night sea, gulls by default, pale in the moonlight and dark against the moon, now and then swooping down to skim the crests.",
    }),
  ],
  groups: {
    sea: { title: "Sea", blurb: "The long swells and their surface chop." },
    sky: {
      ...atmosphereGroups.skyNight,
      blurb: "The moon, the stars, and the odd shooting star with its glints in the waves.",
    },
    birds: birdsGroup,
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this night." },
  },
  glsl: swellGlsl,
  entry: "sceneSwell",
  // Enter: the camera rises from just above the water to its height while one long swell rolls in from
  // the far sea. Exit: it sinks toward the waves and tips down into them.
  passage: { enter: 2.8, exit: 1.5 },
  // The sea: long Gerstner swells and the chop (rippleSpectrum) tilting a mirror of the night sky
  // (waterMirror), and the moon's glitter path on it (waterGlint).
  features: { WATER_TIER: WATER_TIERS.mirror },
};
