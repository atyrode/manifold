// The constants Ripple tank's definition (index.ts) shares with its code (shader.ts, sim.ts), kept
// apart from that code so that the scene registry loads without it (SceneDef.code).

export const rippleLights = ["sea", "lamp", "safelight", "moon"] as const;

/**
 * The scene's passage (index.ts `passage`): seconds the entrance and the exit take. Both play the
 * tank in time-lapse, since its waves crawl at 0.028 short sides a second: the entrance starts from
 * still water, the dippers swell up over PASSAGE_SWELL beats and the first wavefronts rush out,
 * slowing to the tank's own pace as the entrance ends; the exit stops the dippers over
 * PASSAGE_STOP of a beat and the last waves run out ever faster to the sponges. The water is the
 * same simulation throughout; only how many steps a frame takes (and the dippers' strength) differs.
 */
export const RIPPLE_ENTER = 3;

export const RIPPLE_EXIT = 1.4;
