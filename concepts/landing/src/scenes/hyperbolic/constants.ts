// The constants Hyperbolic weave's definition (index.ts) shares with its code (sim.ts), kept apart
// from that code so that the scene registry loads without it (SceneDef.code).

export interface TilingDef {
  readonly label: string;
  /** Sides of a tile. */
  readonly p: number;
  /** Tiles meeting at each corner (1/p + 1/q < 1/2: hyperbolic). */
  readonly q: number;
}

export const HYPERBOLIC_TILINGS: readonly TilingDef[] = [
  { label: "{7,3}", p: 7, q: 3 },
  { label: "{8,3}", p: 8, q: 3 },
  { label: "{5,4}", p: 5, q: 4 },
  { label: "{6,4}", p: 6, q: 4 },
  { label: "{4,5}", p: 4, q: 5 },
  { label: "{3,8}", p: 3, q: 8 },
];

export const HYPERBOLIC_MOTIFS = ["weave", "star", "rings", "lattice"] as const;

/** Defaults the fallback picture (and the knobs in index.ts) start from. */
export const HYPERBOLIC_DEFAULTS = { spread: 0.5, weight: 0.65 } as const;

export const HYPERBOLIC_MODELS = ["disk", "band", "half-plane"] as const;

export interface HyperbolicPalette {
  readonly label: string;
  /** Light page: the copy goes dark over it. */
  readonly paper: boolean;
  /** The two grounds between the strands, and the second one's breathing shade. */
  readonly ground: string;
  readonly groundAlt: string;
  readonly groundBreath: string;
  /** The strands, and their breathing shade. */
  readonly strand: string;
  readonly strandBreath: string;
  /** Outlines. */
  readonly ink: string;
  /** Beyond the plane's rim, the glow (or shadow) round it, and the rim itself. */
  readonly back: string;
  readonly glow: string;
  readonly rim: string;
  /** The light where tiles come from, and of the pulse. */
  readonly source: string;
  /** The M. */
  readonly mark: string;
  /** Light at the screen's edges, against 1 in its middle. */
  readonly lamp: number;
}

export const HYPERBOLIC_PALETTES: readonly HyperbolicPalette[] = [
  {
    label: "indigo",
    paper: false,
    ground: "#0c1020",
    groundAlt: "#17233d",
    groundBreath: "#12293a",
    strand: "#e0d1ad",
    strandBreath: "#ecc79c",
    ink: "#04050a",
    back: "#030409",
    glow: "#4c6a9e",
    rim: "#93acdc",
    source: "#f2b46e",
    mark: "#ffb347",
    lamp: 0.72,
  },
  {
    label: "jade",
    paper: false,
    ground: "#071311",
    groundAlt: "#0e2622",
    groundBreath: "#0c2229",
    strand: "#b4dcbe",
    strandBreath: "#cfe2ad",
    ink: "#020807",
    back: "#020605",
    glow: "#3f7f72",
    rim: "#8fd0bd",
    source: "#e6e59a",
    mark: "#ff8a6b",
    lamp: 0.72,
  },
  {
    label: "ember",
    paper: false,
    ground: "#160809",
    groundAlt: "#2c110d",
    groundBreath: "#2b0c18",
    strand: "#f3bd6b",
    strandBreath: "#f7a35e",
    ink: "#070203",
    back: "#050102",
    glow: "#8a3a24",
    rim: "#e38f5c",
    source: "#ffd08a",
    mark: "#8fd8ff",
    lamp: 0.72,
  },
  {
    label: "paper",
    paper: true,
    ground: "#e3d8c2",
    groundAlt: "#bcae95",
    groundBreath: "#b7ad9b",
    strand: "#faf6ec",
    strandBreath: "#f6eedb",
    ink: "#1d1b22",
    back: "#eee8db",
    glow: "#a39a8a",
    rim: "#2a2730",
    source: "#c8743e",
    mark: "#c4301f",
    lamp: 0.93,
  },
];

export const HYPERBOLIC_FLOWS = ["glide", "drift", "turn"] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the plane slides in along
 * the flow's own line from `PASSAGE_IN_REACH` hyperbolic units behind (under a tile), slowing to
 * the glide (a tiling looks the same from every tile, so it is simply a faster glide that settles).
 * Exit: it picks up speed and slides on `PASSAGE_OUT_REACH` units in the glide's direction. The
 * reaches are short and the passage speed is not given to the shader's motion blur, so the tiling
 * stays sharp and readable throughout (at most about 1.5 units a second).
 */
export const HYPERBOLIC_PASSAGE: { enter: number; exit: number } = { enter: 2.6, exit: 1.4 };
