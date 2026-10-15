// Murmuration: a starling flock folding over a dusk sky. The birds fly on the CPU as a thin sheet
// that bends, twists, folds and splits (sim.ts), or, with `emergent` on, as topological boids
// (sims/boids.ts) whose shape is their own; the shader (shader.ts) inks them from a density field,
// pale where the flock is stretched and black where it folds. The sky comes from the shared library.
import { choice, counts, feature, range, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { flockGlsl } from "./shader.ts";
import { FLOCK_PASSAGE, FLOCK_SIZES, flockSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  choice("flock", "birds", "starlings", counts(...FLOCK_SIZES), 3000, "How many starlings. More make a deeper, darker cloud; fewer leave single birds easy to pick out."),
  range("flock", "cohesion", "cohesion", 0.55, "Low: a loose flock that stretches into ribbons, tears and joins up again. High: a tight, dark ball."),
  range("flock", "chaos", "chaos", 0.35, "Calm: the flock sweeps as one smooth sheet. Restless: it folds and splits, and ripples run through it now and then with no falcon in sight."),
  range("flock", "speed", "speed", 0.5, "How fast the flock sweeps across the sky and changes shape."),
  feature("flock", "predator", "falcon", true, "frequency", 0.35, "A peregrine dives through now and then: the birds flash apart around it and dark waves ripple out across the flock.", { trigger: 0 }),
  feature("flock", "emergent", "emergent flight", false, "neighbours", 7, "Off: the flock flies as one choreographed sheet that stretches, banks, folds and parts on cue. On: every starling steers only by its nearest few neighbours, keeping its distance, matching their heading and closing on them, and the flock's shape, its turns and its splits come out of that alone; startles hop from bird to bird. The amount is how many neighbours each bird watches; real starlings watch about seven.", { min: 3, max: 12, step: 1 }),
  choice("skyline", "skyline", "skyline", [{ label: "city", value: 0 }, { label: "reeds", value: 1 }, { label: "sea", value: 2 }], 1, "The low silhouette along the bottom: rooftops, a reed bed on still water, or the sea under a headland. Lights come on as night falls."),
  ...skyKnobs({ time: 0.76, stars: 0.45 }),
  ...weatherKnobs({ wind: true }),
  feature("manifold", "mark", "M formation", false, "frequency", 0.3, "Every so often the flock gathers into the Manifold M, streams along its strokes for a few seconds, then lets go.", { trigger: 1 }),
];

export const flockScene: SceneDef = {
  id: "flock",
  title: "Murmuration",
  blurb: "Starlings at dusk, thousands of birds folding into one shape.",
  accent: "#ff8a3d",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    flock: { title: "Flock", blurb: "How many starlings, how tightly they keep together, how restless they are, the falcon that scatters them, and whether they fly a choreographed sheet or steer by their neighbours." },
    skyline: { title: "Skyline", blurb: "The thin silhouette that grounds the sky." },
    sky: { title: atmosphereGroups.sky.title, blurb: "Time of day, whether the days pass, and the stars that come out over the flock after dusk." },
    weather: { title: atmosphereGroups.weather.title, blurb: "Wind carries the flock downwind, and stirs the reeds and the water." },
    manifold: { title: "Manifold mark", blurb: "The flock itself draws the M, then lets it go." },
  },
  glsl: flockGlsl,
  entry: "sceneFlock",
  sim: flockSim(params),
  passage: FLOCK_PASSAGE,
};
