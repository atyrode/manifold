// The constants Night train's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** Seconds the scene's entrance and exit take (SceneDef.passage; shader.ts reads the same): out of a tunnel, into a tunnel. */
export const TRAIN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The `line` choice, in the order the shader reads K_line: the country line as it always ran, a rural branch line, a mountain line. */
export const TRAIN_LINES = [
  { label: "country", value: 0 },
  { label: "rural", value: 1 },
  { label: "mountain", value: 2 },
] as const;
