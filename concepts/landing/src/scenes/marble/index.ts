// Paper marbling: ink floating on size, dropped, combed and swirled, as in Turkish ebru and
// Japanese suminagashi. The ink is simulated in sim.ts (Lu et al., "Mathematical Marbling") and
// lit as tray or print in shader.ts.
import { choice, feature, knobValue, range, seed, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { marbleGlsl } from "./shader.ts";
import { MARBLE_PASSAGE, marblePalettes, marblePatterns, marblePracticeChoices, marbleSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("sheet", "pattern", "pattern", marblePatterns.map((label, value) => ({ label, value })), 3, "What the tray is worked into. Stone: left uncombed, the drops packed into veined stones (suminagashi: its rings turned only by breath and a fan). Gel-git: a stylus drawn back and forth across them. Nonpareil: then a fine comb, raising rows of small arches. Bouquet: then a wavy comb back down, fanning them into sprays. Chevron: a comb up and back down between its own tracks."),
  choice("sheet", "palette", "inks", marblePalettes.map((palette, value) => ({ label: palette.label, value })), 0, "Ebru: indigo, ochre, rust, cream and black, on dark size. Suminagashi: sumi and indigo, on clear water over a pale tray. Riso: fluorescent pink, teal, sunflower and blue, on dark size."),
  choice("sheet", "practice", "practice", marblePracticeChoices.map((label, value) => ({ label, value })), 0, "How the ink is laid, whatever the inks and pattern. By inks: the practice the inks belong to (suminagashi for sumi and indigo, ebru for the others). Ebru: a ground colour spreads over the tray, then colours flicked from a brush pack it with stones. Suminagashi: an ink brush and a water brush touch the same spots in turn, each drop pushing the last out into rings; uncombed (stone), breath and a fan turn them. Clicks follow the practice too."),
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
  passage: MARBLE_PASSAGE,
  // Paper, and the pale basin under suminagashi's dark inks, are light: the page copy goes dark on
  // them (the shader's `pagePaper()` follows this).
  theme: paletteTheme(params, "medium", (medium, values) => medium > 0 || marblePalettes[Math.round(knobValue(params, values, "palette"))]?.basin === true),
};
