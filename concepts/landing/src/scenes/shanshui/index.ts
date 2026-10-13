// Shan shui, "mountain and water": an ink-wash handscroll unrolling endlessly. As a handscroll is
// read from right to left, new scenery enters at the left edge and the painting drifts right.
// The landscape is a pure function of the position along the scroll (shader.ts): layered peaks with
// texture strokes, pines, thread waterfalls, pavilions and a boatman, with mist left as bare paper.
// The scroll's clock, the geese, the seal and the pointer's breath over the mist live in sim.ts.
import { choice, feature, range, seed, toggle, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { shanshuiGlsl } from "./shader.ts";
import { shanshuiSim } from "./sim.ts";

const params: readonly ParamDef[] = [
  range("scroll", "speed", "scroll speed", 0.25, "How quickly the scroll unrolls. A handscroll is read from right to left, so new scenery enters at the left edge and drifts slowly right. Zero holds the scroll still."),
  seed("scroll", "seed", "scroll", "Another scroll: a different run of mountains, waters, pavilions and boats."),
  range("scroll", "detail", "detail", 0.55, "How much the painter puts in. Left: a few contours, sparse dots and a great deal of bare paper, as in Ni Zan. Right: dense texture strokes, moss dots and pines, as in Fan Kuan."),
  choice("ink", "palette", "palette", [{ label: "ink", value: 0 }, { label: "blue-green", value: 1 }], 0, "Ink: sumi alone, in graded greys. Blue-green (qinglü): mineral azurite and malachite washed over the peaks, with ochre on the lower slopes, as in the court landscapes of the Tang and Song."),
  range("ink", "density", "ink density", 0.55, "How heavy the ink is: pale, airy washes to the left; dark, bold strokes and deep shadows to the right."),
  range("ink", "wetness", "wetness", 0.35, "Dry brush to the left: crisp contours broken by streaks of 'flying white' where the brush ran dry. Wet to the right: soft edges bleeding into the paper, with pale tide lines where the wash dried."),
  choice("ink", "cun", "texture strokes", [{ label: "hemp-fibre", value: 0 }, { label: "axe-cut", value: 1 }, { label: "both", value: 2 }], 2, "The cun strokes that model the rock. Hemp-fibre: long, soft, wavering lines running down rounded earthen hills. Axe-cut: hard, angular side-brush wedges on sheer cliffs. Both: each mountain in its own manner."),
  range("ink", "age", "paper age", 0.35, "Fresh pale paper to the left; old tea-coloured paper with foxing and darker joins between its sheets to the right."),
  range("mist", "mist", "mist", 0.55, "How much of the landscape is lost in cloud. In shan shui the mist is the unpainted paper itself: more mist, more bare paper between the mountains. Move the pointer over the page to blow it aside."),
  range("mist", "drift", "mist drift", 0.3, "How quickly the bands of cloud drift along the scroll and reshape, apart from the scroll itself."),
  feature("life", "birds", "wild geese", true, "how often", 0.5, "Now and then a skein of wild geese crosses the sky in a loose line, wings beating slowly. Now: a skein sets off.", { trigger: 0 }),
  toggle("life", "boats", "boatman", true, "A fisherman in a small boat on the open water, drifting and poling between the banks."),
  toggle("life", "dwellings", "pavilions", true, "Pavilions under the pines on the river banks, now and then with a scholar sitting in one, looking out over the water."),
  toggle("life", "falls", "waterfalls", true, "Thread waterfalls dropping down the clefts of the tall peaks, left as bare paper between dark rock."),
  toggle("life", "inscription", "inscriptions", true, "Now and then a sheet carries a few columns of calligraphy in its empty sky, faint and grey, as poets and owners wrote on scrolls."),
  feature("manifold", "seal", "seals", true, "size", 0.45, "Cinnabar seals carved with the Manifold M in seal script. The painter's own, cut in relief, sits high in the sky of every stretch of the scroll (beneath the inscription where there is one), so one is always in view; a collector's, cut into the stone, rides each join of the paper sheets. Click the page to press one where you like. Now: a fresh impression on the sky.", { trigger: 1 }),
];

export const shanshuiScene: SceneDef = {
  id: "shanshui",
  title: "Shan shui",
  blurb: "An ink-wash handscroll of mountains and water, unrolling without end.",
  accent: "#c23b22",
  // Graded ink wants a fifth tone; in two-tone mode the cinnabar seal carries the accent.
  look: { color: "full", levels: 5 },
  params,
  groups: {
    scroll: { title: "Scroll", blurb: "How fast the handscroll unrolls, which scroll it is, and how much the painter puts in." },
    ink: { title: "Ink and paper", blurb: "The palette, how heavy and how wet the brush, the strokes that model the rock, and the paper's age." },
    mist: { title: "Mist", blurb: "The clouds between the mountains, left as bare paper. Move the pointer to blow them aside." },
    life: { title: "Life", blurb: "Geese, a boatman, pavilions, waterfalls and inscriptions along the way." },
    manifold: { title: "Manifold mark", blurb: "Red seals with the M in seal script: the painter's in the sky, collectors' on the joins of the paper. Click to press one." },
  },
  glsl: shanshuiGlsl,
  entry: "sceneShanshui",
  sim: shanshuiSim(params),
  theme: () => "paper",
};
