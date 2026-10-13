// Fireflies that fall into step: a mangrove river at night, where thousands of fireflies, each an
// oscillator nudged by the flashes it sees (sim.ts), drift out of their own rhythms into one, the
// way Pteroptyx do along Malaysian rivers. The bank, the mirror of the water, the foreground bokeh
// and the lantern the pointer carries are drawn in shader.ts.
import { counts, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { firefliesGlsl } from "./shader.ts";
import { firefliesSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("swarm", "coupling", "coupling", 0.5, "How strongly each firefly answers the flashes it sees. Low: everyone keeps their own time and the bank twinkles. High: the beat spreads within seconds and the whole forest pulses as one."),
  range("swarm", "density", "fireflies", 0.65, "How many fireflies settle in the mangroves, from a few scattered sparks to crowns full of them.", { min: 0.1, max: 1 }),
  range("swarm", "period", "flash period", 3, "Seconds from one flash to the next. A flash lasts under a second; the rest is dark.", { min: 1.5, max: 6, step: 0.1 }),
  range("swarm", "drift", "drift", 0.35, "How far each firefly wanders about its leaf."),
  feature("swarm", "near", "near fireflies", true, "how many", 8, "Fireflies close to you and out of focus: soft discs of light that pulse with the rest, mirrored in the river.", { options: counts(4, 8, 16) }),
  feature("swarm", "unrest", "breeze", true, "frequency", 0.3, "Now and then a breeze crosses the river: every firefly it passes loses the beat, and behind it the forest falls into step again.", { trigger: 0 }),
  seed("swarm", "seed", "forest", "The trees along the bank and where the fireflies settle; re-seed for another stretch of river, starting out of step."),
  toggle("lantern", "lantern", "lantern", true, "Your pointer carries a small lantern. Fireflies near a light lose the beat, and right beside it they stop flashing; click to flare it and scatter their rhythm."),
  range("river", "reflections", "reflections", 0.75, "How clearly the still river mirrors the trees and their lights."),
  range("river", "mist", "mist", 0.35, "Mist lying on the water and under the trees, glowing green with each pulse."),
  range("river", "stars", "stars", 0.5, "Stars and a faint Milky Way over the trees."),
  feature("manifold", "mark", "M of fireflies", false, "beats", 5, "Now and then the fireflies along the strokes of a Manifold M gather onto them and flash half a beat apart from the forest, so the M lights up alone between the pulses for a few beats, then lets go.", { trigger: 1, options: counts(3, 5, 8) }),
];

export const firefliesScene: SceneDef = {
  id: "fireflies",
  title: "Fireflies",
  blurb: "A mangrove river at night: thousands of fireflies falling into step.",
  accent: "#b6f03c",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    swarm: { title: "Fireflies", blurb: "Each firefly flashes on its own clock and is nudged by the flashes it sees, until the whole bank pulses together. The breeze breaks the beat now and then." },
    lantern: { title: "Lantern", blurb: "The light you carry along the river." },
    river: { title: "River & sky", blurb: "The mirror of the water, the mist and the stars." },
    manifold: { title: "Manifold mark", blurb: "The fireflies themselves draw the M, flashing out of step with the forest." },
  },
  glsl: firefliesGlsl,
  entry: "sceneFireflies",
  sim: firefliesSim(params),
};
