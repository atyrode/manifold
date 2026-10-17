// The constants Harmonograph's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

export const harmonographFigures = ["random", "1:2", "2:3", "3:4", "4:5", "3:5"] as const;

export const harmonographInks = ["sepia", "indigo", "vermilion"] as const;

export const harmonographPapers = ["cream", "vellum", "kraft"] as const;
