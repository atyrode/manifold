// The countryside's camera: where the shared viewRay (shaders/lib/sky.ts) puts the horizon on the
// screen and how wide it looks, and the focal length that gives. The shader marches the land along
// viewRay's rays and places its sprites, figures, herds and verge clumps through the same pinhole
// (a screen point over the focal length), and the verges bin their clumps on the CPU by it
// (verges.ts): one number all three read, so nothing drawn through the pinhole stands off the
// ground the march found under it.

/** Vertical field of view, radians: a little long, so the middle distance reads at the dither. */
const FOV = 0.78;

/**
 * horizon: screen height (0 bottom, 1 top) of the level horizon; fov: the vertical field of view;
 * focal: viewRay's image plane at that field, in screen heights, 0.5 / tan(fov / 2).
 */
export const COUNTRY_CAMERA = { horizon: 0.63, fov: FOV, focal: 0.5 / Math.tan(FOV / 2) } as const;
