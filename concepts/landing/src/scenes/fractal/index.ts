// Fractals, slowly alive: a Julia set breathing as its c walks the rim of the Mandelbrot set, an
// endless dive into an island of the Mandelbrot set, Apollonian circles flowing round, and Newton's
// method laid out as a dry garden. sim.ts moves them (and carries one into the next); shader.ts
// draws them all in one language of ripples, rays, outlines and gilded orbit traps.
import { choice, feature, range, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { FRACTAL_PASSAGE, fractalModes, fractalPalettes } from "./constants.ts";

const params: readonly ParamDef[] = [
  choice(
    "fractal",
    "kind",
    "fractal",
    fractalModes.map((label, value) => ({ label, value })),
    0,
    "Julia: a Julia set breathing, its c walking the rim of the Mandelbrot set past rabbits, spirals, dendrites and dust. Dive: a slow zoom into an island of the Mandelbrot set that loops forever, since the island is the whole set again. Gasket: Apollonian circles, every gap filled by circles kissing its sides, flowing round. Garden: Newton's method as a dry garden: stones, raked rings, and braided seams where their pulls meet.",
  ),
  range(
    "fractal",
    "pace",
    "pace",
    1,
    "How quickly everything drifts: the walk of c, the dive, the flowing circles, the stones' slow dance.",
    { min: 0.25, max: 2 },
  ),
  range(
    "fractal",
    "breath",
    "breath",
    0.5,
    "How deeply it breathes. Julia: how far c sinks into the Mandelbrot set and rises out of it, until the set shatters into dust. Dive: how much the zoom slows and quickens. Gasket: how far the circles swell and ebb. Garden: how far the raked rings twist into spirals.",
  ),
  feature(
    "fractal",
    "wander",
    "wander",
    true,
    "often",
    0.4,
    "Move on now and then: c walks on along the rim, the dive goes to another island after a loop or three, the circles and stones rearrange. Off: stay in one place, breathing. Now: move on at once.",
    { trigger: 0 },
  ),
  range("fractal", "zoom", "size", 1, "How large the fractal sits on the page.", {
    min: 0.6,
    max: 1.6,
    steady: true,
  }),
  range(
    "fractal",
    "detail",
    "detail",
    0.5,
    "How much fine structure is worked out: more iterations and finer filigree to the right; fewer, calmer and quicker to the left.",
  ),
  choice(
    "ink",
    "palette",
    "palette",
    fractalPalettes.map((palette, value) => ({ label: palette.label, value })),
    0,
    "Moonlit: silver on night blue. Gilt: gold on black lacquer. Sumi: ink on paper with a cinnabar seal. Porcelain: cobalt on white glaze.",
  ),
  range(
    "ink",
    "lines",
    "line weight",
    0.45,
    "The outline drawn along the fractal's edge, from a hairline to a brush stroke; the finer lines follow.",
  ),
  range(
    "ink",
    "glow",
    "glow",
    0.5,
    "The halo around the set, and the tint of the circles and basins.",
  ),
  range(
    "ink",
    "ripples",
    "ripples",
    0.45,
    "Lines of equal level: equipotential rings around the Julia and Mandelbrot sets, growth rings in each circle, raked rings around each stone.",
  ),
  range(
    "ink",
    "rays",
    "rays",
    0.2,
    "The lines crossing the ripples at right angles: field lines streaming from the set, the hyperbolic tiling inside each circle, spokes around each stone.",
  ),
  feature(
    "ink",
    "filigree",
    "filigree",
    true,
    "strength",
    0.85,
    "Orbit traps: wherever the iteration passes a small disc or ring, that shape is drawn there, pulled back through every step: gold beads and lace threaded through the fractal. The gasket gilds the points where its circles kiss.",
  ),
  choice(
    "ink",
    "trap",
    "filigree shape",
    [
      { label: "pearls", value: 0 },
      { label: "lace", value: 1 },
    ],
    0,
    "Pearls: small discs, beaded along the set. Lace: rings, drawn as fine loops.",
    { when: "filigree" },
  ),
  feature(
    "manifold",
    "mark",
    "M trap",
    false,
    "size",
    0.5,
    "An orbit trap shaped like the Manifold M: wherever the iteration passes through it an M is drawn, so Ms circle the set as echoes, stand in every Apollonian circle and nestle in the garden's beads. Now: show it for a while.",
    { trigger: 1 },
  ),
];

export const fractalScene: SceneDef = {
  id: "fractal",
  title: "Fractals",
  blurb: "A Julia set breathing, an endless Mandelbrot dive, Apollonian circles, a Newton garden.",
  accent: "#d4a646",
  look: { color: "full", levels: 5 },
  passage: FRACTAL_PASSAGE,
  params,
  groups: {
    fractal: {
      title: "Fractal",
      blurb:
        "Which fractal, and how it lives. Hover to nudge it, drag to pan (past the frame's edge it pulls back like elastic); let go and it drifts home.",
    },
    ink: {
      title: "Ink & light",
      blurb: "The palette, the outline, and the lines and filigree drawn around the set.",
    },
    manifold: { title: "Manifold mark", blurb: "The M as an orbit trap, woven into the fractal." },
  },
  code: () => import("./code.ts"),
  // Sumi and porcelain are light grounds: the page copy goes dark on them.
  theme: paletteTheme(params, "palette", (palette) => fractalPalettes[palette]?.paper === true),
};
