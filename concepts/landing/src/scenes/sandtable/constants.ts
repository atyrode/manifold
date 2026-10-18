// The constants Sand table's definition (index.ts, layers.ts) shares with its code (shader.ts,
// sim.ts), kept apart from that code so that the scene registry loads without it (SceneDef.code).

/** The table, in field units; the shader draws with the same numbers. */
export const SANDTABLE = {
  /** View heights per field unit on a landscape screen (on a portrait one, times its aspect). */
  span: 0.9,
  /** Radius of the sand, out to the rim's inner edge. */
  sand: 0.47,
  /** Width of the rim, and how far it stands above the sand. */
  rim: 0.055,
  rimHeight: 0.018,
  /** Farthest the ball's centre goes from the middle: radius 1 of the theta–rho tracks. */
  track: 0.452,
  /**
   * The steel ball's radius (some 2.9% of the table across; the shader keeps it at least ten cells
   * across on coarse pixels), and the groove it ploughs, about where a ball that size sinking a
   * groove's depth meets the sand.
   */
  ball: 0.015,
  groove: 0.021,
  /** Height-field texels across the field (about a cell and a half each on screen). */
  grid: 320,
  /** The pendulum's funnel: radius of its mouth, and how high it hangs over the table. */
  funnel: 0.026,
  funnelHeight: 0.2,
  /** The straight edge that wipes the slate: its width and height. */
  edge: 0.018,
  edgeHeight: 0.012,
  /** Groove depth at the bottom of the depth knob, and what the whole knob adds. */
  depthMin: 0.0015,
  depthRange: 0.005,
} as const;

export const sandtableMachines = ["ball", "pendulum"] as const;

export const sandtablePatterns = [
  "cycle",
  "spiral",
  "clover",
  "rose",
  "star",
  "waves",
  "loops",
] as const;

export const sandtableFigures = ["cycle", "1:1", "1:2", "2:3", "3:4"] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). The sim runs the entrance on its
 * own clock, which starts once the opening table is laid, so a slow first frame cannot use it up.
 */
export const SANDTABLE_PASSAGE: { enter: number; exit: number } = { enter: 2.6, exit: 1.6 };
