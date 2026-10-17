// The constants Mobile's definition (index.ts) shares with its code (layout.ts, shader.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** Seconds of the entrance (lowered from above, the Sun lighting up) and the exit (the motor winding down, the Sun cooling, hoisted away). */
export const MOBILE_PASSAGE = { enter: 2.8, exit: 1.5 } as const;

/** The Sun's gold: the accent. */
export const MOBILE_SUN = "#f2a52c";
