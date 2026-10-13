// A glass petri dish seen from above, on a dark lab bench under a lamp or on a light box, with a
// reaction slowly living in it: a Gray–Scott Turing pattern morphing over minutes between
// fingerprints, coral, worms, dividing spots and mazes, or a Belousov–Zhabotinsky dish of turning
// spirals and target rings. The chemistry is stepped on the GPU in sim.ts; shader.ts draws the
// bench, the glass, the meniscus and the chemistry's colours.
import { choice, feature, knobValue, range, seed, toggle, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { petriGlsl } from "./shader.ts";
import { petriChemistries, petriPalettes, petriSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("chemistry", "chemistry", "chemistry", petriChemistries.map((label, value) => ({ label, value })), 0, "Turing: two chemicals feeding and inhibiting each other (Gray–Scott) grow a living pattern of stripes, coral, worms and dividing spots that slowly turns from one into the next. BZ: the Belousov–Zhabotinsky reaction, waves of blue running through an orange dish as turning spirals and target rings."),
  range("chemistry", "tempo", "tempo", 1, "How fast the reaction runs: the pattern's growth, or the waves' speed.", { min: 0.25, max: 2.5 }),
  range("chemistry", "drift", "drift", 0.5, "How fast conditions in the dish wander. Turing: the pattern drifts from one kind to the next, a few minutes each; at 0 it settles and holds. BZ: the spirals' centres wander slowly."),
  range("chemistry", "scale", "pattern scale", 0.5, "Size of the pattern: many fine stripes and rings to the left, a few bold ones to the right."),
  feature("chemistry", "drops", "drops", true, "how often", 0.4, "Now and then a drop falls into the dish. Turing: fresh gel washes a disc clean and the pattern grows back into it. BZ: a speck of dust and its bubble become a new centre of rings for a few minutes.", { trigger: 0 }),
  seed("chemistry", "pattern", "pattern", "Where the first pattern, spirals and drops fall; re-seed for a fresh dish."),
  choice("dish", "palette", "palette", petriPalettes.map((label, value) => ({ label, value })), 0, "Stain: coral growth on amber gel, or ferroin's orange and blue. Ink: two tones, chalk on black or indigo on paper. UV: under a blacklight, the growth glows green and the BZ dish glows orange, dark where the waves pass."),
  range("dish", "relief", "relief", 0.6, "How much the surface catches the lamp: the raised growth and its wet glints, or the faint bending of light along the BZ waves."),
  toggle("dish", "lightbox", "light box", false, "Set the dish on a light box and see the chemistry by the light shining through it, the way the reaction is usually shown. With the UV palette, a UV transilluminator."),
  range("dish", "size", "dish size", 0.5, "How large the dish is in the frame.", { steady: true }),
  feature("manifold", "mark", "etched M", false, "size", 0.5, "The Manifold M etched into the dish's floor, where the chemistry takes hold. Turing: a ridge of coral grows along its strokes and the stripes around settle parallel to it; 'now' washes the dish around it clean and lets it all grow back. BZ: waves leave it in M-shaped fronts that round into rings.", { trigger: 1 }),
];

export const petriScene: SceneDef = {
  id: "petri",
  title: "Petri dish",
  blurb: "A reaction slowly living in a glass dish: Turing patterns and Belousov–Zhabotinsky spirals.",
  accent: "#4d84f5",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    chemistry: { title: "Chemistry", blurb: "What reacts in the dish and how it lives. Press and drag in the dish to add reagent or spark waves." },
    dish: { title: "Dish", blurb: "How the dish is lit and seen." },
    manifold: { title: "Manifold mark", blurb: "An M etched into the dish's floor, where the chemistry takes hold." },
  },
  glsl: petriGlsl,
  entry: "scenePetri",
  sim: petriSim(params),
  // On the light box the page goes light, with dark copy; the UV transilluminator stays dark.
  theme: paletteTheme(params, "lightbox", (box, values) => box === 1 && petriPalettes[Math.round(knobValue(params, values, "palette"))] !== "UV"),
};
