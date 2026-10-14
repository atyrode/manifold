// A moonlit sea rolling toward the horizon.
import { range, toggle } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { swellGlsl } from "./shader.ts";

export const swellScene: SceneDef = {
  id: "swell",
  title: "Swell",
  blurb: "A moonlit sea rolling toward the horizon.",
  accent: "#4c6ef5",
  // The shader reads each knob through its K_<key> define.
  params: [
    range("sea", "height", "swell", 0.5, "Height of the long swells."),
    range("sea", "chop", "chop", 0.5, "Small, fast waves on top of the swell."),
    range("sky", "moon", "moon", 0.5, "Moon size."),
    range("sky", "stars", "stars", 0.35, "How many stars."),
    toggle("manifold", "mmoon", "M on the moon", false, "The moon's dark seas form the Manifold M."),
    range("sea", "relief", "relief", 0, "0: the waves are painted on a flat sea. Higher gives the nearer waves real height: crests hide the troughs behind them and the arriving swell stands up. Far waves stay flat."),
  ],
  groups: {
    sea: { title: "Sea", blurb: "The swell and its surface chop." },
    sky: { title: "Sky", blurb: "Moon and stars." },
    manifold: { title: "Manifold mark", blurb: "Ways the M can live in this night." },
  },
  glsl: swellGlsl,
  entry: "sceneSwell",
  // Enter: the camera rises from just above the water to its height while one long swell rolls in from
  // the far sea. Exit: it sinks toward the waves and tips down into them.
  passage: { enter: 2.8, exit: 1.5 },
};
