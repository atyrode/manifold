// Chladni plate: sand on a metal plate sung at one tone after another, gathering on the lines
// where the plate stands still. The plate's modes and the sand are simulated in sim.ts; shader.ts
// lights the metal, the heaped sand and the hub the plate is driven through.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { chladniGlsl, chladniLamps, chladniMetals, chladniSands } from "./shader.ts";
import { CHLADNI_ENTER, CHLADNI_EXIT, CHLADNI_GRAINS, chladniSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("plate", "shape", "plate", [{ label: "square", value: 0 }, { label: "round", value: 1 }], 0, "Square: Chladni's own plate, its figures stars, diamonds, crosses and rings. Round: rings with petals, spokes and curls."),
  range("plate", "sweep", "mode sweep", 0.5, "How quickly the tone climbs through the plate's modes, and back down: how long each figure holds before the sand flows on into the next. Now: on to the next figure.", { trigger: 0 }),
  range("plate", "vibration", "vibration", 0.5, "How hard the plate is driven. Gentle: the sand settles in wide, soft bands. Strong: it is thrown into thin, sharp lines."),
  choice("plate", "tone", "metal", chladniMetals.map((metal, value) => ({ label: metal.label, value })), 1, "The plate: black anodised, brushed steel, or brass."),
  seed("plate", "plateSeed", "figures", "Which figure the sweep starts from, how the round figures are turned and how the sand first falls; re-seed for another run."),
  choice("sand", "grains", "sand", counts(...CHLADNI_GRAINS), 25000, "How many grains are on the plate: a dusting that draws fine lines, or enough to heap them into ridges."),
  range("sand", "grainSize", "grain size", 0.5, "How coarse the sand is. Left: fine sand, set moving by the least swing and held back by the air: it creeps into thin, crisp lines. Middle: ordinary dry sand. Right: grit, thrown far and quick to arrive, heaping into broad, rough, steep ridges with loose grains scattered round them. A new grain is a fresh batch, strewn over the plate and sung into the figure."),
  choice("sand", "sand", "colour", chladniSands.map((sand, value) => ({ label: sand.label, value })), 0, "Pale quartz, warm desert sand, white salt, or pink coral sand."),
  feature("light", "lamp", "coloured lamp", true, "brightness", 0.6, "One coloured lamp, low on the left: its reflection streaks across the grain of the metal, rakes the ridges of sand and glints in a few grains. Off: a dim, neutral room light."),
  choice("light", "lampHue", "lamp colour", chladniLamps.map((lamp, value) => ({ label: lamp.label, value })), 0, "Amber, sea green, violet, or a cool moonlight.", { when: "lamp" }),
  range("light", "shimmer", "shimmer", 0.35, "Where the plate swings hardest its reflection blurs into a faint glow, so the shape of the tone shows on the bare metal between the lines of sand."),
  feature("manifold", "mark", "M figure", false, "frequency", 0.3, "Now and then the tone finds a mode no plate has: the sand runs into the Manifold M, holds it a while, then flows back out into the next figure.", { trigger: 1 }),
];

export const chladniScene: SceneDef = {
  id: "chladni",
  title: "Chladni plate",
  blurb: "Sand on a singing plate, gathering where it stands still.",
  accent: "#ff9440",
  // Five levels: the dark metal's grain and the lamp's long reflection need the extra steps in the shadows.
  look: { color: "full", levels: 5 },
  params,
  groups: {
    plate: { title: "Plate", blurb: "The plate, the tone it is sung at and how hard. Click the plate to sprinkle sand, drag to pour it." },
    sand: { title: "Sand", blurb: "How much sand, and what it is." },
    light: { title: "Light", blurb: "The lamp over the plate, and the metal's reflection of it." },
    manifold: { title: "Manifold mark", blurb: "A figure in the shape of the M." },
  },
  glsl: chladniGlsl,
  entry: "sceneChladni",
  // Entrance: sand strewn over the still plate, then the plate sings it into its lines. Exit: the plate tilts and the sand slides off.
  passage: { enter: CHLADNI_ENTER, exit: CHLADNI_EXIT },
  sim: chladniSim(params),
};
