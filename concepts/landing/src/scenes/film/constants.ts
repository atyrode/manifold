// The constants Soap film's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** What the film is seen against, in `backdrop` knob order. */
export const filmBackdrops = ["black", "midnight", "plum"] as const;

/** What holds the film, in `shape` knob order. */
export const filmShapes = ["frame", "loop", "bubble"] as const;

/**
 * The scene's passage, seconds: the entrance draws a fresh film up from the bottom wire (a bubble is
 * blown) in as long, and the exit pops the film.
 */
export const FILM_PASSAGE = { enter: 3, exit: 1.6 } as const;
