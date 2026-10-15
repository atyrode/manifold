// A glass petri dish seen from above, on a dark lab bench under a lamp or on a light box, with a
// reaction slowly living in it: a Gray–Scott Turing pattern morphing over minutes between
// fingerprints, coral, worms, dividing spots and mazes, or a Belousov–Zhabotinsky dish of turning
// spirals and target rings. The chemistry is stepped on the GPU in sim.ts; shader.ts draws the
// bench, the glass, the meniscus and the chemistry's colours.
import { choice, feature, knobValue, range, seed, toggle, type ParamDef } from "../../params.ts";
import { grayScottRegimes } from "../../sims/grayscott.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { petriGlsl } from "./shader.ts";
import {
  PETRI_FEED_KILL_UNIT,
  PETRI_PASSAGE,
  petriChemistries,
  petriPalettes,
  petriRegimes,
  petriSim,
} from "./sim.ts";

const [loopStart] = grayScottRegimes;
if (!loopStart) throw new Error("petri: no Gray–Scott regimes");
const regimeHelp = grayScottRegimes
  .map((regime) => `${regime.label[0]?.toUpperCase()}${regime.label.slice(1)}: ${regime.grows}.`)
  .join(" ");

const params: readonly ParamDef[] = [
  choice(
    "chemistry",
    "chemistry",
    "chemistry",
    petriChemistries.map((label, value) => ({ label, value })),
    0,
    "Turing: two chemicals feeding and inhibiting each other (Gray–Scott) grow a living pattern of stripes, coral, worms and dividing spots that slowly turns from one into the next. BZ: the Belousov–Zhabotinsky reaction, waves of blue running through an orange dish as turning spirals and target rings.",
  ),
  choice(
    "chemistry",
    "regime",
    "regime",
    petriRegimes.map((label, value) => ({ label, value })),
    0,
    `Which Turing pattern the dish grows (BZ is unchanged). Wander: it drifts from one kind into the next, a few minutes each, neighbouring kinds sharing the dish. The others hold the whole dish at one of Pearson's classes: ${regimeHelp} A new regime starts a fresh dish, which turns into it within about twenty seconds.`,
  ),
  range(
    "chemistry",
    "tempo",
    "tempo",
    1,
    "How fast the reaction runs: the pattern's growth, or the waves' speed.",
    { min: 0.25, max: 2.5 },
  ),
  range(
    "chemistry",
    "drift",
    "drift",
    0.5,
    "How fast conditions in the dish wander. Turing: the pattern drifts from one kind to the next, a few minutes each; at 0 it settles and holds (a chosen regime, or your own feed and kill, holds whatever the drift). BZ: the spirals' centres wander slowly.",
  ),
  range(
    "chemistry",
    "scale",
    "pattern scale",
    0.5,
    "Size of the pattern: many fine stripes and rings to the left, a few bold ones to the right.",
  ),
  feature(
    "chemistry",
    "drops",
    "drops",
    true,
    "how often",
    0.4,
    "Now and then a drop falls into the dish. Turing: fresh gel washes a disc clean and the pattern grows back into it. BZ: a speck of dust and its bubble become a new centre of rings for a few minutes.",
    { trigger: 0 },
  ),
  seed(
    "chemistry",
    "pattern",
    "pattern",
    "Where the first pattern, spirals and drops fall; re-seed for a fresh dish.",
  ),
  choice(
    "dish",
    "palette",
    "palette",
    petriPalettes.map((label, value) => ({ label, value })),
    0,
    "Stain: coral growth on amber gel, or ferroin's orange and blue. Ink: two tones, chalk on black or indigo on paper. UV: under a blacklight, the growth glows green and the BZ dish glows orange, dark where the waves pass.",
  ),
  range(
    "dish",
    "relief",
    "relief",
    0.6,
    "How much the surface catches the lamp: the raised growth and its wet glints, or the faint bending of light along the BZ waves.",
  ),
  toggle(
    "dish",
    "lightbox",
    "light box",
    false,
    "Set the dish on a light box and see the chemistry by the light shining through it, the way the reaction is usually shown. With the UV palette, a UV transilluminator.",
  ),
  range("dish", "size", "dish size", 0.5, "How large the dish is in the frame.", { steady: true }),
  feature(
    "manifold",
    "mark",
    "etched M",
    false,
    "size",
    0.5,
    "The Manifold M etched into the dish's floor, where the chemistry takes hold. Turing: a ridge of coral grows along its strokes and the stripes around settle parallel to it; 'now' washes the dish around it clean and lets it all grow back. BZ: waves leave it in M-shaped fronts that round into rings.",
    { trigger: 1 },
  ),
  toggle(
    "advanced",
    "custom",
    "own feed & kill",
    false,
    "Turing only: set Gray–Scott's feed and kill by hand instead of a regime, anywhere on Pearson's map. Switching on starts a fresh dish; moving the sliders then changes the living one. Most of the map grows nothing or a solid wash: the patterns live on a narrow band, where the regimes lie. A dish that has died stays bare until reagent is added again: drag in the dish, wait for a drop, or re-seed it.",
  ),
  range(
    "advanced",
    "feed",
    "feed",
    loopStart.feed * PETRI_FEED_KILL_UNIT,
    "How fast fresh substrate flows into the gel, in thousandths (37 = 0.037; the regimes use 29 to 55). At kill 60: up to about 20 nothing grows, 30 spots, 37 stripes, 50 a nearly solid sheet with holes, and from about 70 nothing again.",
    { min: 10, max: 90, step: 0.1, when: "custom" },
  ),
  range(
    "advanced",
    "kill",
    "kill",
    loopStart.kill * PETRI_FEED_KILL_UNIT,
    "How fast the growth dies back, in thousandths (60 = 0.060; the regimes use 57 to 65). At feed 37: up to about 55 a solid wash, 60 stripes, 65 spots, from about 70 bare gel.",
    { min: 45, max: 70, step: 0.1, when: "custom" },
  ),
];

export const petriScene: SceneDef = {
  id: "petri",
  title: "Petri dish",
  blurb:
    "A reaction slowly living in a glass dish: Turing patterns and Belousov–Zhabotinsky spirals.",
  accent: "#4d84f5",
  look: { color: "full", levels: 4 },
  passage: { enter: PETRI_PASSAGE.enter, exit: PETRI_PASSAGE.exit },
  params,
  groups: {
    chemistry: {
      title: "Chemistry",
      blurb:
        "What reacts in the dish and how it lives. Press and drag in the dish to add reagent or spark waves.",
    },
    dish: { title: "Dish", blurb: "How the dish is lit and seen." },
    manifold: {
      title: "Manifold mark",
      blurb: "An M etched into the dish's floor, where the chemistry takes hold.",
    },
    advanced: {
      title: "Advanced",
      blurb: "Gray–Scott's two rates by hand, for exploring Pearson's map (Turing).",
    },
  },
  glsl: petriGlsl,
  entry: "scenePetri",
  sim: petriSim(params),
  // On the light box the page goes light, with dark copy; the UV transilluminator stays dark.
  theme: paletteTheme(
    params,
    "lightbox",
    (box, values) =>
      box === 1 && petriPalettes[Math.round(knobValue(params, values, "palette"))] !== "UV",
  ),
};
