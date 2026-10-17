// Physarum polycephalum, the slime mould: a living network of golden veins that links its oat
// flakes into an efficient transport network, thickens the good paths and lets the rest go (Tero
// et al.'s Tokyo rail experiment). Tero's adaptive flow network on the CPU (network.ts) lays out
// where the veins run; tens of thousands of specks grown over it on the GPU after Jeff Jones's
// agent model (sim.ts) are the living mould, drawn as plasmodium on agar, a sumi drawing or a
// night rail map (shader.ts).
import { choice, feature, range, seed, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { PHYSARUM_AGENTS_DEFAULT, PHYSARUM_PASSAGE, physarumAgentCounts } from "./constants.ts";

/** In `palette` knob order: the shader's K_palette. */
const PALETTES = ["agar", "ink", "rail"] as const;
const INK = PALETTES.indexOf("ink");

const params: readonly ParamDef[] = [
  choice(
    "mould",
    "specks",
    "plasmodium",
    physarumAgentCounts.map((count, value) => ({ label: `${count / 1024}k`, value })),
    PHYSARUM_AGENTS_DEFAULT,
    "How many specks of plasmodium crawl the dish. Fewer: a sparse, airy mesh, the trunks fine. More: a fuller mesh and thicker trunks, the lace denser round them.",
  ),
  range(
    "mould",
    "angle",
    "sensor angle",
    35,
    "How far to either side each speck smells before it turns (it turns at least 45° at a time), in degrees. Narrow: long filaments in wide, open meshes. Wide: a tighter, curlier lace.",
    { min: 10, max: 80, step: 1 },
  ),
  range(
    "mould",
    "reach",
    "sensor reach",
    9,
    "How far ahead each speck smells, in steps. Short: a fine lace of thin filaments. Long: a few broad, sweeping trunks.",
    { min: 3, max: 20, step: 1 },
  ),
  range(
    "mould",
    "decay",
    "evaporation",
    0.4,
    "How quickly the mould's trail fades and its unused veins wither. Low: a dense lace where many paths survive. High: only the busiest trunks are kept, and abandoned ones vanish fast.",
  ),
  range(
    "mould",
    "tempo",
    "tempo",
    1,
    "How fast the mould crawls, grows and reorganises, and how often its food is eaten and replaced.",
    { min: 0.25, max: 2 },
  ),
  choice(
    "food",
    "layout",
    "food",
    [
      { label: "random", value: 0 },
      { label: "grid", value: 1 },
      { label: "Tokyo", value: 2 },
    ],
    0,
    "Where the oat flakes lie. Random: scattered over the dish. Grid: on a honeycomb, which the mould links into a lattice. Tokyo: at the cities round Tokyo Bay, the sea lit so the mould shuns it, as in Tero et al.'s dish, where it grew a network much like the railways.",
  ),
  feature(
    "food",
    "feeding",
    "new food",
    true,
    "pace",
    0.5,
    "Now and then a flake is eaten away and fresh food appears elsewhere: the veins to the old flake starve and fade, new ones reach out to the new. Pace: how often. The button scatters a constellation of fresh flakes now.",
    { trigger: 0 },
  ),
  seed(
    "food",
    "foodSeed",
    "dish",
    "Where the flakes lie and which come next; re-seed for another dish, grown afresh.",
  ),
  feature(
    "food",
    "salt",
    "salt",
    true,
    "lasts",
    0.5,
    "Drag across the dish to sprinkle a line of salt: the mould recoils from it and reroutes round it, then reclaims the ground as it dissolves. Lasts: from a quarter of a minute to two minutes.",
  ),
  choice(
    "look",
    "palette",
    "palette",
    PALETTES.map((label, value) => ({ label, value })),
    0,
    "Agar: golden plasmodium and oat flakes in a petri dish of warm agar. Ink: a sumi drawing on paper. Rail: a night transit map, its main and minor lines and stations.",
  ),
  feature(
    "look",
    "pulse",
    "streaming",
    true,
    "strength",
    0.6,
    "Shuttle streaming: a slow wave of brightness runs along the veins out from where the mould began, eases to a stop and runs back, every minute or so.",
  ),
  range(
    "look",
    "relief",
    "relief",
    0.5,
    "Light from the upper left across the veins, so they stand out of the agar like tubes and shade it beside them (ink: ink pooling along their edges).",
  ),
  range(
    "look",
    "slime",
    "slime trail",
    0.5,
    "The slime the mould leaves where it has been: abandoned veins linger as faint tracks for a minute or two.",
  ),
  feature(
    "manifold",
    "mark",
    "M of oats",
    false,
    "size",
    0.5,
    "Oat flakes at the five corners of the Manifold M, crumbs along its strokes: the mould leaves the dish's food and grows the M, its streaming pulsing out from the middle. The button lays one for a minute.",
    { trigger: 1 },
  ),
];

export const physarumScene: SceneDef = {
  id: "physarum",
  title: "Slime mould",
  blurb: "A golden network linking its food, thickening good paths and pruning the rest.",
  accent: "#e9b824",
  look: { color: "full", levels: 4 },
  passage: PHYSARUM_PASSAGE,
  params,
  groups: {
    mould: {
      title: "Slime mould",
      blurb:
        "Physarum polycephalum: how it smells its way, bundles into veins and lets unused ones go.",
    },
    food: {
      title: "Food",
      blurb:
        "Oat flakes on the agar, how they come and go, and salt. Click to drop a flake; drag to sprinkle salt.",
    },
    look: { title: "Look", blurb: "How the dish is drawn, and the life in its veins." },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: the mould growing the M between five oat flakes.",
    },
  },
  code: () => import("./code.ts"),
  // Ink is drawn on paper: the page copy goes dark on it.
  theme: paletteTheme(params, "palette", (palette) => palette === INK),
};
