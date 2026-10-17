// The constants Fractals's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).
import type { SceneDef } from "../types.ts";

interface FractalPalette {
  label: string;
  /** A light ground: the page takes its paper theme, and ink means dark. */
  paper: boolean;
  /** The ground; the halo round the set (and a disc's or basin's tint); ripples and rays outside. */
  bg: string;
  glow: string;
  line: string;
  /** The outline; inside the set and the stones, dark and lit; ripples and rays inside. */
  edge: string;
  body: string;
  lit: string;
  bodyLine: string;
  /** The filigree, and the M. */
  gild: string;
  seal: string;
}

/** The `palette` knob's values, in order. */
export const fractalPalettes: readonly FractalPalette[] = [
  // Moonlit: silver lines on a night-blue ground, pale gold pearls, a gold M.
  {
    label: "moonlit",
    paper: false,
    bg: "#060a16",
    glow: "#1f335c",
    line: "#7394c2",
    edge: "#dfe9f8",
    body: "#070c18",
    lit: "#1b2d52",
    bodyLine: "#5874a6",
    gild: "#efcd82",
    seal: "#ffd277",
  },
  // Gilt: gold on black lacquer, as maki-e, with a vermilion M.
  {
    label: "gilt",
    paper: false,
    bg: "#070504",
    glow: "#3a2610",
    line: "#9a7434",
    edge: "#f6d98e",
    body: "#050302",
    lit: "#2a1b0a",
    bodyLine: "#8a6a32",
    gild: "#ffe2a0",
    seal: "#d0482c",
  },
  // Sumi: ink on paper, ochre-gold filigree, a cinnabar seal for the M.
  {
    label: "sumi",
    paper: true,
    bg: "#ece6d8",
    glow: "#cfc6b4",
    line: "#8f877a",
    edge: "#1a1918",
    body: "#2b2927",
    lit: "#5a5650",
    bodyLine: "#9d968a",
    gild: "#b08636",
    seal: "#c0392b",
  },
  // Porcelain: cobalt on white glaze, gilded.
  {
    label: "porcelain",
    paper: true,
    bg: "#eef1f5",
    glow: "#c9d6ec",
    line: "#7d95c8",
    edge: "#14307a",
    body: "#1d3b8c",
    lit: "#4a68b8",
    bodyLine: "#a9bbe3",
    gild: "#c49a3c",
    seal: "#a8741e",
  },
];

/** The `mode` knob's values, in order. */
export const fractalModes = ["julia", "dive", "gasket", "garden"] as const;

// The passage: the entrance and exit happen in the world, as a camera. Entering, it rises from a
// point deep in the fractal and settles into the usual framing while the iteration count climbs,
// so the fine detail grows in; leaving, it falls into a point, accelerating. Julia, gasket and
// garden scale their view about a focus (shader.ts, texel 2); the dive spends its own zoom: its
// loop phase runs deeper than usual and back (the self-similarity keeps the framing exact at rest).
/** Seconds the entrance and exit take (SceneDef.passage). */
export const FRACTAL_PASSAGE: NonNullable<SceneDef["passage"]> = { enter: 2.8, exit: 1.4 };
