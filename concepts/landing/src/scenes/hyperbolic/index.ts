// Hyperbolic tiling: the endless plane of constant negative curvature, mapped into a disk as in
// Escher's Circle Limit prints (or a band, or a half-plane) and tiled {p,q}, with strands woven over
// and under from tile to tile. The plane glides on a slow flow, tiles swelling out of the rim and
// shrinking back into it, and follows the pointer's drags. sim.ts holds the geometry and the
// glide; shader.ts folds each pixel into one triangle of the tiling and draws it there.
import { choice, feature, range, type ParamDef } from "../../params.ts";
import { paletteTheme } from "../atmosphere.ts";
import type { SceneDef } from "../types.ts";
import { hyperbolicGlsl } from "./shader.ts";
import {
  HYPERBOLIC_DEFAULTS,
  HYPERBOLIC_FLOWS,
  HYPERBOLIC_MODELS,
  HYPERBOLIC_MOTIFS,
  HYPERBOLIC_PALETTES,
  HYPERBOLIC_PASSAGE,
  HYPERBOLIC_TILINGS,
  hyperbolicSim,
} from "./sim.ts";

const options = (labels: readonly string[]) => labels.map((label, value) => ({ label, value }));

const params: readonly ParamDef[] = [
  choice(
    "tiling",
    "tiling",
    "tiling",
    options(HYPERBOLIC_TILINGS.map((tiling) => tiling.label)),
    0,
    "{p,q}: tiles with p sides, q of them at every corner. Seven-sided tiles three to a corner could never lie flat; here the plane makes room for more and more of them, without end.",
  ),
  choice(
    "tiling",
    "motif",
    "motif",
    options(HYPERBOLIC_MOTIFS),
    0,
    "Weave: strands running on from tile to tile, over and under like basketwork. Star: they reach further across each tile and cross more often (on six sides or more). Rings: a ring round every corner. Lattice: just the tiles' edges, the tiles in two colours where they can alternate.",
  ),
  range(
    "tiling",
    "spread",
    "spread",
    HYPERBOLIC_DEFAULTS.spread,
    "Where the strands cross each tile's edges: in pairs close to the middle of the edge to the left, out toward the corners to the right, where they curl into rings.",
    { min: 0.2, max: 0.8 },
  ),
  range(
    "tiling",
    "weight",
    "line weight",
    HYPERBOLIC_DEFAULTS.weight,
    "How broad the strands (or the lattice's edges) are.",
    { min: 0.2, max: 1 },
  ),
  choice(
    "glide",
    "flow",
    "flow",
    options(HYPERBOLIC_FLOWS),
    0,
    "Glide: the plane slides along a line, tiles rising out of a glow on the rim, swelling through the middle and sinking into the far side. Drift: they loop out of one point of the rim and back into it. Turn: the plane wheels slowly round the middle.",
  ),
  range(
    "glide",
    "speed",
    "speed",
    0.35,
    "How fast the plane moves. Drag the page to move it yourself; let go and it coasts on.",
  ),
  feature(
    "glide",
    "pulse",
    "light pulse",
    true,
    "frequency",
    0.4,
    "Now and then a ring of light leaves the middle and spreads through the plane at a steady pace. On screen it slows as it nears the rim, which it never reaches.",
    { trigger: 0 },
  ),
  choice(
    "view",
    "model",
    "model",
    options(HYPERBOLIC_MODELS),
    0,
    "Three faithful maps of the same endless plane. Disk: all of it inside a circle, as in Escher's Circle Limit. Band: a strip running off both sides of the screen. Half-plane: everything above a horizon the tiles shrink toward.",
  ),
  choice(
    "view",
    "palette",
    "palette",
    options(HYPERBOLIC_PALETTES.map((palette) => palette.label)),
    0,
    "Indigo: ivory strands on night blue. Jade: celadon on deep green. Ember: gold on oxblood. Paper: a woodcut print, pale strands inked on warm paper.",
  ),
  range(
    "view",
    "breath",
    "breathing",
    0.5,
    "The colours drift slowly between neighbouring shades and back, over a minute or so.",
  ),
  feature(
    "manifold",
    "mark",
    "M tile",
    false,
    "glow",
    0.6,
    "One tile carries the Manifold M through the plane. It rides the flow out to the rim and, while this is on, comes back from the far side on another tile. 'Now' sets it in the middle.",
    { trigger: 1 },
  ),
];

export const hyperbolicScene: SceneDef = {
  id: "hyperbolic",
  title: "Hyperbolic weave",
  blurb: "An endless plane, woven tile to tile, gliding through a circle.",
  accent: "#ffb347",
  look: { color: "full", levels: 4 },
  passage: HYPERBOLIC_PASSAGE,
  params,
  groups: {
    tiling: {
      title: "Tiling",
      blurb: "The shape of the tiles and the strands woven through them.",
    },
    glide: {
      title: "Glide",
      blurb: "How the plane moves. Drag the page to glide it; let go and it coasts.",
    },
    view: {
      title: "View",
      blurb: "How the endless plane is mapped onto the screen, and its colours.",
    },
    manifold: {
      title: "Manifold M",
      blurb: "A landmark of its own: one tile carrying the M through the plane.",
    },
  },
  glsl: hyperbolicGlsl,
  entry: "sceneHyperbolic",
  sim: hyperbolicSim(params),
  theme: paletteTheme(params, "palette", (palette) => HYPERBOLIC_PALETTES[palette]?.paper === true),
};
