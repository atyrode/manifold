// The constants Murmuration's definition (index.ts) shares with its code (sim.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/** The flock sizes on offer (the `birds` choice). */
export const FLOCK_SIZES = [1500, 3000, 5000] as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the flock streams in
 * from beyond the nearer side edge, head first, in a loose file that folds into its sheet as the
 * birds slow. Exit: it pours down head first, funnelling together, to roost below the horizon, where
 * the skyline hides it. Both are worked out when the density is splatted, so they follow the frame
 * clock smoothly; at rest (enter 1, exit 0) the birds are exactly where the flight puts them.
 */
export const FLOCK_PASSAGE: { enter: number; exit: number } = { enter: 2.8, exit: 1.5 };
