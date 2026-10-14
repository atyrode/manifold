// Bees in the border: a close, low view into a cottage-garden flower border on a golden afternoon.
// Lavender, cosmos, poppies, echinacea and clover sway in the breeze in front of a hedge and trees
// melted into bokeh. Bees fly curved paths from flower to flower, hover, land (the head dips under
// their weight and springs back), crawl and go on; a few butterflies flutter between the flowers and
// now and then settle with their wings slowly opening and closing. The creatures are steered on the
// CPU (sim.ts) and drawn as sprites in the shader (shader.ts); the lens is focused at one depth.
import { choice, counts, feature, range, seed, type ParamDef } from "../../params.ts";
import { atmosphereGroups, skyKnobs, skyTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { beesGlsl } from "./shader.ts";
import { BEES_MARK_TRIGGER, beesSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  feature("border", "bees", "bees", true, "how many", 3, "Bees foraging: each flies a calm curved path to a flower, hovers, lands (the flower dips under its weight and springs back), crawls a while carrying pollen on its legs, then goes on to the next.", { options: counts(1, 2, 3, 4, 6) }),
  feature("border", "butterflies", "butterflies", true, "how many", 2, "A peacock, a cabbage white and a swallowtail, in that order: a lazy erratic flutter with glides between bursts of wingbeats, now and then settling on a flower with the wings slowly opening and closing.", { options: counts(1, 2, 3) }),
  choice("border", "palette", "flower mix", [
    { label: "cottage", value: 0 },
    { label: "warm", value: 1 },
    { label: "cool", value: 2 },
  ], 0, "Which flowers fill the border: a cottage mix of lavender, cosmos, poppies, echinacea and clover; a warm one of poppies, orange cosmos and yellow coneflowers; a cool one of blue, violet and white."),
  range("border", "flowers", "flowers", 0.75, "How full the border is, from a few scattered flowers to a thick bed."),
  seed("border", "gardenSeed", "arrangement", "Where each flower stands, how tall, and of what kind; re-seed for another stretch of border."),
  range("air", "breeze", "breeze", 0.4, "How much the stems sway: a still afternoon to the swell of a gentle breeze, passing along the border."),
  range("lens", "focus", "focus depth", 0.5, "Which depth is sharp: toward the left the flowers close to you, in the middle the middle of the border, toward the right the far flowers. Everything else softens into out-of-focus colour; the hedge is always far out of focus."),
  range("lens", "glow", "golden haze", 0.45, "The low sun's gold scattered through the air, softening the picture around it."),
  ...skyKnobs({ time: 0.7 }),
  feature("manifold", "mark", "M in clematis", false, "bloom", 0.8, "The Manifold M trained over the hedge in violet clematis: a thin vine and a blossom at nineteen places along its strokes, soft out of focus behind the flowers. A pulse of light runs along it now and then; 'Now' sends one at once.", { trigger: BEES_MARK_TRIGGER }),
];

export const beesScene: SceneDef = {
  id: "bees",
  title: "Bees",
  blurb: "A flower border on a golden afternoon: bees foraging, butterflies settling, the hedge soft behind.",
  // The pale gold of afternoon light, and of a bee's pollen.
  accent: "#f2b632",
  look: { color: "full", levels: 4 },
  params,
  groups: {
    border: { title: "The border", blurb: "The flowers, and the bees and butterflies that visit them." },
    air: { title: "Air", blurb: "The breeze that sways the stems." },
    lens: { title: "Lens", blurb: "Where the focus lies, and the haze of low sunlight." },
    sky: atmosphereGroups.sky,
    manifold: { title: "Manifold mark", blurb: "The M in clematis, over the hedge." },
  },
  glsl: beesGlsl,
  entry: "sceneBees",
  sim: beesSim(params),
  // A bright afternoon is a light page: dark copy from morning to evening on a still clock.
  theme: skyTheme(params, { from: 0.31, to: 0.74 }),
};
