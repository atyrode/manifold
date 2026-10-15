// Bees on the hillside: a painted summer landscape, eye level and warm, with the insects as tiny
// moving specks you know by their motion. Cumulus towers over hazy hills (a farmhouse, a windmill),
// an old orchard behind a dry-stone wall, a path and three pastel hives in a garden of lavender
// rows, poppies, daisies and foxgloves, the wind running through the grass and the shadows of clouds
// drifting over it all. Dozens of bees work the hives (sim.ts): foragers beeline to a flower drift,
// hop from flower to flower and fly home loaded with pollen; a crowd mills at each entrance and young
// bees fly orientation loops before it. A few butterflies flutter between the flowers and settle.
import { counts, feature, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme, weatherKnobs } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { BEES_METEOR_TRIGGER, beesGlsl } from "./shader.ts";
import { BEES_PASSAGE, beesSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  feature("life", "bees", "bees", true, "colony", 48, "How many bees are about, each flying in the garden's space at its real size (a speck of a cell at the hives, a little bigger close to you): foragers leave the hives for the flowers in a nearly straight line, now and then passing close by, hop from flower to flower, and fly home loaded with pollen; some mill at the entrances, and young bees fly orientation loops in front of their hive.", { options: counts(16, 32, 48, 64) }),
  feature("life", "butterflies", "butterflies", true, "how many", 5, "Orange, white and blue butterflies: a lazy, bobbing flutter with the odd glide, the wingbeat seen as the size of the speck, now and then settling on a flower with the wings slowly opening and closing.", { options: counts(3, 4, 5, 6) }),
  seed("scenery", "scenerySeed", "landscape", "The shape of the hills and their fields, the clouds, and the flowers in the drifts; re-seed for another view of the valley."),
  ...weatherKnobs({ group: "air", wind: true, clouds: 0.55, aurora: true }),
  ...skyKnobs({ time: 0.64, stars: 0.6, moon: 1, meteors: { trigger: BEES_METEOR_TRIGGER } }),
  feature("manifold", "mark", "M on the hive", false, "boldness", 0.8, "The Manifold M painted on the front of the middle hive, in ochre on its powder-blue boxes.", {}),
];

export const beesScene: SceneDef = {
  id: "bees",
  title: "Bees",
  blurb: "A summer hillside at an orchard's edge: bees and butterflies at work among the hives and flowers.",
  // The gold of afternoon light, and of pollen.
  accent: "#f2b632",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    life: { title: "Bees & butterflies", blurb: "The insects: a colony working three hives and a few butterflies." },
    scenery: { title: "Landscape", blurb: "Which valley you are looking over." },
    air: { title: "Air", blurb: "The wind through the grass and the cumulus building over the hills; on a clear night, the aurora over them." },
    sky: atmosphereGroups.skyNight,
    manifold: { title: "Manifold mark", blurb: "The M, painted on a hive." },
  },
  glsl: beesGlsl,
  entry: "sceneBees",
  sim: beesSim(params),
  // The cumulus drift into place, the bees pour out of the hives and fan out to the flowers, butterflies
  // flutter in from the edges and the near stalks and grass spring up; leaving, the bees stream home and
  // the butterflies flutter off.
  passage: BEES_PASSAGE,
  // A bright afternoon is a light page: dark copy from morning to evening on a still clock.
  theme: skyTheme(params, { from: 0.31, to: 0.74 }),
  // The moon takes a phase (K_moon) in the shared sky.
  features: { SKY_MOON_PHASE: 1 },
};
