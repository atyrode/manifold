// The constants Incense's definition (index.ts) shares with its code (sim.ts), kept apart from that
// code so that the scene registry loads without it (SceneDef.code).

/** What burns, in `stick` knob order. */
export const incenseKinds = ["stick", "cone", "coil", "waterfall"] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage), both played by the simulation.
 * Entrance: the room starts empty, the ember takes light, and the smoke thread climbs out of it
 * (Plume.#rise draws its head up, the fluid carries it on) until it frays into the veils under the
 * ceiling. Exit: a draught sweeps through the room from the left (Plume.#blow), shears the thread
 * through above the ember and carries the veils off to the right.
 */
export const INCENSE_PASSAGE: { enter: number; exit: number } = { enter: 3, exit: 1.5 };
