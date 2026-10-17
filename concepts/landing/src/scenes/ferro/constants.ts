// The constants Ferrofluid's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** The studio light colours a gel can give the right-hand panel; the first is a plain studio. */
export const ferroGels = [
  { label: "white", color: "#eef1ff" },
  { label: "ember", color: "#ff6a2b" },
  { label: "cyan", color: "#3fc8ff" },
  { label: "violet", color: "#9a63ff" },
] as const;

/** Seconds the entrance and the exit take (SceneDef.passage; the shader reads the exit's for its ripple). */
export const FERRO_PASSAGE = { enter: 3, exit: 1.7 } as const;
