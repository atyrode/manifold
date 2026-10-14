// A harmonograph seen from above on a dark wooden desk under a warm lamp: two damped pendulums swing
// a pen across a sheet of cream paper, slowly drawing a Lissajous figure that dies away to a point.
// Then the sheet slides off, a fresh one slides in, and the pendulums are set swinging again with new
// frequency ratios near small integers. sim.ts integrates the pendulums and rasterises the ink;
// shader.ts paints the desk, the paper and the pen.
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import type { SceneDef } from "../types.ts";
import { harmonographFigures, harmonographInks, harmonographPapers, harmonographSim } from "./sim.ts";
import { harmonographGlsl } from "./shader.ts";

const params: readonly ParamDef[] = [
  choice("drawing", "figure", "pendulums", harmonographFigures.map((label, value) => ({ label, value })), 0, "How the two pendulums' swings beat against each other: 1:2 draws figure-eights, 2:3 and 3:4 knotted rosettes, 4:5 and 3:5 fine lace. Every ratio is a hair off the whole numbers, so the figure slowly turns as it is drawn. Random: a different one on each sheet."),
  range("drawing", "lasting", "damping", 0.4, "How long a drawing lasts. Left: the swing dies away within a couple of minutes, a looser nest of loops. Right: it rings on for several minutes, a dense lace of hundreds of loops spiralling in.", { step: 0.01 }),
  range("drawing", "swing", "swing speed", 1, "How fast the pendulums swing; the whole drawing runs at this pace.", { min: 0.4, max: 1.5, step: 0.05 }),
  feature("drawing", "rotary", "rotary pendulum", true, "swing", 0.5, "A third pendulum that turns the pen round in a circle as well, tangling the figure into rosettes and spirograph loops. Its swing dies faster than the others'.", { min: 0.1, max: 0.8 }),
  feature("drawing", "renew", "next sheet", true, "pause", 0.3, "When the swing has died, rest a while (up to 40 seconds), then slide the sheet off, slide a fresh one in and swing the pendulums again. Off: the finished drawing stays. Now: change the sheet at once.", { trigger: 0 }),
  seed("drawing", "drawings", "drawings", "The run of drawings: their frequencies, phases, damping and how each sheet lies on the desk. Re-seed for another run; the first sheet restarts at once."),
  choice("paper", "ink", "ink", harmonographInks.map((label, value) => ({ label, value })), 0, "Sepia, deep indigo or vermilion pigment. Fresh ink goes on dark; as the pen runs dry the line lightens, and where lines cross it pools darker."),
  choice("paper", "paper", "paper", harmonographPapers.map((label, value) => ({ label, value })), 0, "Warm cream, cool vellum or brown kraft paper."),
  range("paper", "nib", "nib", 0.5, "The width of the pen's line, from a hair to a broad nib."),
  range("paper", "lamp", "lamp", 0.55, "How brightly the desk lamp burns. Its pool of light sits upper left; the desk falls away into the dark beyond it."),
  feature("manifold", "mark", "M signature", false, "size", 0.5, "Switch on, or press now, and the pendulums are stilled: the pen lifts, crosses to the sheet's lower corner and is led along the Manifold M in one stroke, signing the drawing in vermilion. While on, it signs every sheet once its drawing is done.", { trigger: 1 }),
];

export const harmonographScene: SceneDef = {
  id: "harmonograph",
  title: "Harmonograph",
  blurb: "Two swinging pendulums draw a slowly dying figure in ink on paper.",
  accent: "#e2553a",
  look: { color: "full", levels: 4 },
  passage: { enter: 5, exit: 2.4 },
  params,
  groups: {
    drawing: { title: "Pendulums", blurb: "The swings that guide the pen, how long they last, and how the sheets follow one another." },
    paper: { title: "Paper and ink", blurb: "The sheet, the pigment, the nib and the lamp over the desk." },
    manifold: { title: "Manifold M", blurb: "A landmark of its own: the M, signed on the drawing by the pen." },
  },
  glsl: harmonographGlsl,
  entry: "sceneHarmonograph",
  sim: harmonographSim(params),
};
