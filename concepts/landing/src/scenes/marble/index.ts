// Paper marbling: ink floating on size, dropped, combed and swirled, as in Turkish ebru and
// Japanese suminagashi. The ink is simulated in sim.ts (Lu et al., "Mathematical Marbling") and
// lit as tray or print in shader.ts.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { marbleGlsl } from "./shader.ts";
import { marblePalettes, marblePatterns, marbleSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("sheet", "pattern", "pattern", marblePatterns.map((label, value) => ({ label, value })), 3, "What the tray is worked into. Stone: drops alone, packed into veined stones. Gel-git: a stylus drawn back and forth across them. Nonpareil: then a fine comb, raising rows of small arches. Bouquet: then a wavy comb back down, fanning them into sprays. Chevron: a comb up and back down between its own tracks."),
  choice("sheet", "palette", "inks", marblePalettes.map((palette, value) => ({ label: palette.label, value })), 0, "Ebru: indigo, ochre, rust, cream and black. Suminagashi: sumi and indigo in rings, each pushed out by a drop of clear water. Riso: fluorescent pink, teal, sunflower and blue."),
  range("sheet", "tempo", "tempo", 1, "How quickly the drops fall and the stylus and combs travel.", { min: 0.25, max: 2 }),
  range("sheet", "scale", "scale", 0.5, "Size of the drops and spacing of the combs: small and fine to the left, large and bold to the right."),
  feature("sheet", "renew", "new sheet", true, "rest", 0.4, "When the pattern is done it rests a while, then the sheet is lifted off with the ink and a fresh tray begins. Off: the finished pattern stays.", { trigger: 0 }),
  seed("sheet", "sheetSeed", "drops", "Where the drops fall and the combs start; re-seed for another run of sheets."),
  choice("surface", "medium", "view", [{ label: "tray", value: 0 }, { label: "print", value: 1 }], 0, "Tray: the ink floating on the size, in a dim studio. Print: the paper laid on and lifted, the pattern taken into its fibres."),
  feature("surface", "ripples", "ripples", true, "strength", 0.4, "Long, slow swells on the size, gently bending the studio window mirrored in it (tray)."),
  range("surface", "sheen", "sheen", 0.5, "The studio window mirrored in the wet surface (tray)."),
  range("surface", "fibre", "paper fibre", 0.5, "Mottling and fibres of the paper, showing through the ink (print)."),
  range("surface", "edges", "edges", 0.5, "Left: soft ink bleeding into its neighbours. Right: crisp edges with a fine dark rim where colours meet."),
  feature("manifold", "stylus", "M stylus", false, "size", 0.5, "At the end of each sheet a stylus writes the Manifold M through the ink: four strokes combed into the pattern.", { trigger: 1 }),
];

export const marbleScene: SceneDef = {
  id: "marble",
  title: "Marbling",
  blurb: "Ink floating on water, dropped and combed: ebru and suminagashi.",
  accent: "#4f5fc7",
  look: { color: "full", levels: 5 },
  params,
  groups: {
    sheet: { title: "Marbling", blurb: "The pattern, the inks and the pace of the work. Click the page to drop ink, drag to comb it." },
    surface: { title: "Surface", blurb: "The tray of size or the finished print, and how light and paper show." },
    manifold: { title: "Manifold mark", blurb: "The M written into the ink with a stylus." },
  },
  glsl: marbleGlsl,
  entry: "sceneMarble",
  sim: marbleSim(params),
  // Paper, and suminagashi's pale basin, are light: the page copy goes dark on them.
  theme: (values) => {
    const print = (values.medium ?? params.find((def) => def.key === "medium")?.value ?? 0) > 0.5;
    const palette = values.palette ?? params.find((def) => def.key === "palette")?.value ?? 0;
    const rings = marblePalettes[Math.round(palette)]?.rings === true;
    return print || rings ? "paper" : "night";
  },
};
