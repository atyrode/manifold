// The landscape model's choices and limits that a scene's knobs offer (terrain.ts builds with
// them), apart from the model so that a scene's definition reads them without loading it.

/** Most farms a build places among the fields. */
export const TERRAIN_MAX_FARMS = 8;

/** Most cottages the village holds round its church. */
export const TERRAIN_MAX_COTTAGES = 30;

/**
 * The relief the map starts from, the river's axis across the vantage's view in each: a valley
 * between hills; a coast, the valley opening downstream into a bay of the sea (water level 0); a
 * plateau, a high table the river has cut a steep-sided gorge into; rolling hills all round.
 */
export const TERRAIN_BASES = ["valley", "coast", "plateau", "hills"] as const;

export type TerrainBase = (typeof TERRAIN_BASES)[number];
