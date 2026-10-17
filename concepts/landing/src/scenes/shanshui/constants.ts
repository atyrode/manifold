// The constants Shan shui's definition (index.ts) shares with its code (shader.ts), kept apart from
// that code so that the scene registry loads without it (SceneDef.code).

/**
 * Seconds of the scroll's entrance (it is drawn open from its roll, the painting riding in behind
 * its roller) and exit (it is wound up again) (SceneDef.passage).
 */
export const SHANSHUI_PASSAGE = { enter: 3, exit: 1.4 } as const;
