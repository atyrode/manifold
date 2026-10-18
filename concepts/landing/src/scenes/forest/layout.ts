// The mystic forest's layout: plain data the layers' manifests (layers.ts, constants.ts), their GLSL
// (shader.ts) and the life (build.ts) share, without loading any of them.

/**
 * Side-on camera: the horizon's screen height and the eye's height (m). A point at depth z and
 * height y (metres) lands at screen y = FOREST_HORIZON + (y - FOREST_EYE) / z, and at screen x =
 * (world x) / z, in screen heights from the centre.
 */
export const FOREST_HORIZON = 0.36;
export const FOREST_EYE = 1.15;
/** Frames narrower than this are laid out as if this wide: the features anchored to the edges are cropped rather than crowded into the middle. */
export const FOREST_MIN_ASPECT = 1.3;

export function forestLayoutAspect(aspect: number): number {
  return Math.max(aspect, FOREST_MIN_ASPECT);
}

/** Screen y of a point `height` metres up at depth z (m). */
export function forestScreenY(height: number, z: number): number {
  return FOREST_HORIZON + (height - FOREST_EYE) / z;
}

/** The stream: its centre line x = centre - swing sin((z - from) rate) (m) and half-width half + widen z (m). */
export const FOREST_STREAM = {
  centre: 0.6,
  swing: 1.5,
  rate: 0.2,
  from: 3,
  half: 0.6,
  widen: 0.012,
} as const;

export function forestStreamX(z: number): number {
  return (
    FOREST_STREAM.centre -
    FOREST_STREAM.swing * Math.sin((z - FOREST_STREAM.from) * FOREST_STREAM.rate)
  );
}

export function forestStreamHalf(z: number): number {
  return FOREST_STREAM.half + FOREST_STREAM.widen * z;
}

/**
 * The great cedar on the left, its axis `edge` screen heights in from the left edge so the whole bole
 * shows: its radius (m), how much wider its buttressed foot is (a share), over how many metres up that
 * flare fades, and its lean (m across per m up).
 */
export const FOREST_HERO = {
  edge: 0.33,
  z: 3.8,
  radius: 0.95,
  flare: 0.8,
  flareHeight: 0.7,
  lean: 0.04,
} as const;
/** The old beech on the right, its axis `edge` in from the right edge; it puts out the branch. */
export const FOREST_ELDER = {
  edge: 0.17,
  z: 7,
  radius: 0.85,
  flare: 0.8,
  flareHeight: 0.6,
  lean: -0.02,
} as const;
/**
 * The beech's branch, in metres at its depth: it leaves the trunk `root` radii left of the axis at
 * `height`; along s = 0..1 of its `length` its centre line rises by rise s - sag s^2 and its radius
 * narrows from `radius` to `tip`.
 */
export const FOREST_BRANCH = {
  height: 3.05,
  length: 3.3,
  rise: 0.75,
  sag: 0.45,
  radius: 0.17,
  tip: 0.07,
  root: 0.55,
} as const;
/** Moss beards hang from the branch in lanes this far apart (m); the drips fall from their tips. */
export const FOREST_BEARD_SPACING = 0.2;
/** Mossy boulders: centre `edge` screen heights in from the left / right edge, depth, radii across and up (m), centre height (m). */
export const FOREST_ROCK_LEFT = { edge: 0.62, z: 3, rx: 0.62, ry: 0.5, centre: 0.1 } as const;
export const FOREST_ROCK_RIGHT = { edge: 0.31, z: 4.4, rx: 0.6, ry: 0.44, centre: -0.02 } as const;
/** The fallen log, lying across from world x `from` to `to` (m) at depth z, its radius (m). */
export const FOREST_LOG = { from: 0.95, to: 5.8, z: 8.5, radius: 0.34 } as const;
/**
 * The torii over the stream, centred on it: pillars `span` m either side, the top beam from `height`
 * up `beam` m, overhanging the pillars by `overhang`; leaning `lean` rad to the left about its right
 * foot, the left foot sunk in a mound of moss.
 */
export const FOREST_TORII = {
  z: 13,
  span: 1.55,
  height: 3.05,
  beam: 0.25,
  overhang: 0.75,
  lean: 0.05,
} as const;
/** A cluster of mushrooms on the moss mound swallowing the torii's left foot, in the torii's own frame (m). */
export const FOREST_GATE_SHROOMS = { x: -1.15, y: 0.42 } as const;
/** Stepping stones across the stream: depth, offset from the stream's centre, radius, height above the water (m). */
export const FOREST_STONES = [
  { z: 5.2, offset: -0.42, radius: 0.24, height: 0.14 },
  { z: 5.7, offset: 0.06, radius: 0.27, height: 0.17 },
  { z: 6.2, offset: 0.5, radius: 0.22, height: 0.13 },
] as const;
/** The Manifold M of roots on the near boulder's face: its centre `lift` x ry above the boulder's centre, its height `size` x ry; its top corners meet the root across the face. */
export const FOREST_MARK = { lift: 0.36, size: 0.58 } as const;
/** The stag's path: its depth (m), and how far apart the lights it leaves behind bloom (m). */
export const FOREST_STAG = { z: 18, stride: 0.7 } as const;
/** Spirit slots: the kodama's records before the stag's (sim.ts). */
export const FOREST_SPIRITS = 12;
/** Mote bins: this many to the screen height, square. */
export const FOREST_MOTE_ROWS = 30;
/** The mist field's grid over the screen. */
export const FOREST_FOG = { width: 64, height: 36 } as const;

/** The passage's dolly (FOREST_RIG): metres the camera starts back, seconds its dolly takes, metres it drifts back on the way out. */
export const FOREST_DOLLY = { back: 2.6, settle: 2.0, drift: 1.4 } as const;

/** Height (m, in the torii's own frame) of the top of its top beam at x (m from its centre): the ends sweep up. */
export function forestKasagiTop(x: number): number {
  const k = (Math.abs(x) / (FOREST_TORII.span + FOREST_TORII.overhang)) ** 4;
  return FOREST_TORII.height + FOREST_TORII.beam + 0.18 * k;
}
