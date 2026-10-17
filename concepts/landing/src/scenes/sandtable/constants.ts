// The constants Sand table's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

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
