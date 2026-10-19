// The constants Slime mould's definition (index.ts) shares with its code (sim.ts, draw.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

/** Deposits are scaled so the trail's total is the same at any population. */
export const REFERENCE_AGENTS = 40_960;

/**
 * The `specks` knob's choices, by index (the knob's value; URL `specks=0..2`). State textures are
 * 256 wide. In the dish on a 16:9 frame (~270k texels) they occupy ~7.5%, ~15% and ~23% of it:
 * Jones's model knits a reticulated network at a few to ~15% occupancy and condenses into a few
 * thick bands and loops well above it.
 */
export const physarumAgentCounts = [20_480, REFERENCE_AGENTS, 61_440] as const;

/** The `specks` knob's default index. */
export const PHYSARUM_AGENTS_DEFAULT = 1;

/**
 * Seconds the scene's entrance and exit take (SceneDef.passage; the shader reads the entrance's).
 * Entrance: oat flakes land on the dish, then the mould grows out of the heart along its veins, the
 * fine lace following. Exit: the strands thin and draw back into the flakes, leaving a slime track.
 */
export const PHYSARUM_PASSAGE: { enter: number; exit: number } = { enter: 3.2, exit: 1.6 };
