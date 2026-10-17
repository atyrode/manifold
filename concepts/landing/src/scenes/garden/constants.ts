// The constants Stone garden's definition (index.ts) shares with its code (sim.ts, build.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

export const gardenPatterns = ["waves", "straight", "circles"] as const;
export type GardenPattern = (typeof gardenPatterns)[number];

export const gardenSeasons = ["spring", "summer", "autumn", "winter"] as const;
export type GardenSeason = (typeof gardenSeasons)[number];

/**
 * When the white gravel is in daylight and the page is a light one: times of day (still clock)
 * from just after sunrise to just before sunset, while the rain falling (its amount; in winter it
 * comes down as snow, src/climate.ts) stays lighter than `rain`; harder rain greys and darkens the
 * garden (index.ts's theme and the shader's ink).
 */
export const GARDEN_PAPER = { from: 0.26, to: 0.745, rain: 0.35 } as const;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage). Entrance: the maple's boughs sway
 * in from the top of the frame and a few leaves drift down and land. Exit: a gust, rising over the
 * whole exit, blows a flurry of leaves across the gravel while the boughs sway up out of the frame.
 */
export const GARDEN_PASSAGE = { enter: 2.8, exit: 1.5 } as const;
