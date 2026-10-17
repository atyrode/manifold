// The garden's layout, shared by its simulation (sim.ts and the kinds it steps) and its shader
// (shader.ts): the eye and the stage, where the hives, the flower drifts, the foxgloves, the near
// blooms and the orchard's trees stand, how the `flowers` knob grows the drifts and which plants it
// stands, and the speck map's codes and depth. Places on screen are fractions of the stage half width
// (`f`) and uv heights (`y`); sim.ts's header says how they become places in the world.

/** Horizon of the garden plane (uv height), the eye's height above it (m) and the narrowest stage half width. */
export const BEES_YH = 0.47;
export const BEES_CAM = 1.6;
export const BEES_STAGE_MIN = 0.62;

/** Seconds the scene's entrance and its exit take (SceneDef.passage; the shader reads the same). */
export const BEES_PASSAGE = { enter: 2.8, exit: 1.6 } as const;

/** Half the width of the stage, screen heights: fractions `f` below are of this. */
export function beesStage(aspect: number): number {
  return Math.max(0.5 * aspect, BEES_STAGE_MIN);
}

/** A box hive on its stand, metres: stand height, one box, boxes, roof, width, slot height, board thickness. */
export const BEES_HIVE = {
  stand: 0.3,
  box: 0.3,
  boxes: 2,
  roof: 0.1,
  width: 0.52,
  slot: 0.04,
  board: 0.02,
} as const;
/** Half the landing board's width, metres. */
export const BEES_BOARD_HALF = 0.17;
/** Hives are built this many times larger than the metres above, so the entrances read. */
export const BEES_HIVE_SCALE = 1.5;

export interface BeesHive {
  /** x as a fraction of the stage half width, and the y of the hive's feet (uv). */
  f: number;
  y: number;
}

/** The three hives, left to right: white, powder blue and butter yellow, the M on the middle one. */
export const BEES_HIVES: readonly BeesHive[] = [
  { f: -0.3, y: 0.32 },
  { f: -0.09, y: 0.298 },
  { f: 0.14, y: 0.33 },
];

/**
 * A plant of the foreground: x (fraction of the stage), a y (uv), a size or a kind, and the `flowers`
 * value it stands from (thinned away below it).
 */
export type BeesPlant = readonly [f: number, y: number, size: number, show: number];

/**
 * Foxgloves in the foreground: x (fraction of the stage), the y of their feet, height (m), and the
 * `flowers` value they stand from (all at 1; thinned away below it, by 0 every one gone).
 */
export const BEES_FOXGLOVES: readonly BeesPlant[] = [
  [-0.92, 0.035, 1.2, 0.35],
  [-0.8, 0.075, 1.0, 0.6],
  [0.83, 0.04, 1.15, 0.45],
  [0.93, 0.09, 1.0, 0.75],
  [0.5, 0.28, 1.0, 0.25],
  [0.45, 0.3, 0.9, 0.5],
];

/**
 * More foxgloves for a lush garden, each from its own `flowers` value past 1, clear of the path and
 * drawn after those above.
 */
export const BEES_FOXGLOVES_LUSH: readonly BeesPlant[] = [
  [-0.68, 0.06, 1.05, 1.5],
  [0.72, 0.075, 1.1, 1.75],
  [-0.99, 0.14, 0.9, 2.0],
  [0.6, 0.27, 0.95, 2.25],
  [0.56, 0.31, 0.85, 2.5],
];

/**
 * Foreground blooms with their petals drawn: x, the y of the head, kind (0 poppy, 1 daisy), and the
 * `flowers` value they stand from, as the foxgloves.
 */
export const BEES_BLOOMS: readonly BeesPlant[] = [
  [-0.5, 0.11, 0, 0.3],
  [-0.33, 0.06, 1, 0.55],
  [0.55, 0.07, 0, 0.4],
];

/** More near blooms for a lush garden, as BEES_FOXGLOVES_LUSH. */
export const BEES_BLOOMS_LUSH: readonly BeesPlant[] = [
  [0.42, 0.05, 1, 1.5],
  [-0.58, 0.09, 0, 1.6],
  [0.75, 0.12, 1, 1.8],
  [-0.22, 0.035, 0, 2.0],
  [0.88, 0.06, 0, 2.25],
  [-0.88, 0.05, 1, 2.5],
];

/** Every foxglove and near bloom a garden may stand, in the order the shader draws (and indexes) them. */
export const BEES_FOXGLOVES_ALL: readonly BeesPlant[] = [...BEES_FOXGLOVES, ...BEES_FOXGLOVES_LUSH];
export const BEES_BLOOMS_ALL: readonly BeesPlant[] = [...BEES_BLOOMS, ...BEES_BLOOMS_LUSH];

/** The `flowers` value from which the first of the lush near blooms and foxgloves stands (BEES_LUSH). */
export const BEES_LUSH_FROM = Math.min(
  ...[...BEES_FOXGLOVES_LUSH, ...BEES_BLOOMS_LUSH].map((plant) => plant[3]),
);

/** The radius of a near bloom's head (m), shader.ts beesBloomNear's R. */
export const BEES_BLOOM_HEAD = 0.13;

/** The orchard, far to near: x (fraction of the stage), the y of the trunk's foot, size, seed. */
export const BEES_TREES: readonly (readonly [number, number, number, number])[] = [
  [-0.74, 0.389, 0.65, 3.1],
  [0.62, 0.388, 0.75, 19.4],
  [-0.22, 0.385, 1.0, 7.7],
  [0.2, 0.383, 0.85, 12.3],
];

/** Kinds of flower patch (shader.ts paints each; the bees only care where they are). */
export const BEES_LAVENDER = 0;
export const BEES_POPPY = 1;
export const BEES_DAISY = 2;
export const BEES_WILD = 3;
export const BEES_COSMOS = 4;
/** Apple blossom in the orchard's crowns, and a meadow on the hill beyond the wall: flowers the foragers fly up to (the shader paints them as part of the trees and the hill). */
export const BEES_BLOSSOM = 5;
export const BEES_HILL = 6;

export interface BeesPatch {
  f: number;
  y: number;
  /** Radii: a fraction of the stage half width, and uv height. */
  rx: number;
  ry: number;
  kind: number;
  /** How often a forager (or butterfly, for the first BEES_GROUND_PATCHES) picks it. */
  weight: number;
  /** Height of the flower heads above the ground (m) for a drift on the ground. */
  top: number;
  /**
   * For flowers in the air (a crown, a hill): the uv y of the ground they stand over, which sets their
   * depth; the ellipse's y is then where they are on screen, and their height follows from the two.
   */
  footY?: number;
}

/** The first this many patches are drifts on the garden's ground; butterflies keep to them. */
export const BEES_GROUND_PATCHES = 5;

export const BEES_PATCHES: readonly BeesPatch[] = [
  { f: -0.62, y: 0.17, rx: 0.32, ry: 0.1, kind: BEES_LAVENDER, weight: 0.3, top: 0.32 },
  { f: 0.6, y: 0.15, rx: 0.32, ry: 0.09, kind: BEES_POPPY, weight: 0.2, top: 0.5 },
  { f: 0.0, y: 0.095, rx: 0.26, ry: 0.06, kind: BEES_DAISY, weight: 0.12, top: 0.3 },
  { f: -0.55, y: 0.348, rx: 0.4, ry: 0.022, kind: BEES_WILD, weight: 0.06, top: 0.3 },
  { f: 0.72, y: 0.285, rx: 0.22, ry: 0.05, kind: BEES_COSMOS, weight: 0.08, top: 0.6 },
  { f: -0.22, y: 0.56, rx: 0.12, ry: 0.045, kind: BEES_BLOSSOM, weight: 0.1, top: 0, footY: 0.378 },
  { f: 0.2, y: 0.54, rx: 0.1, ry: 0.04, kind: BEES_BLOSSOM, weight: 0.08, top: 0, footY: 0.378 },
  { f: 0.45, y: 0.47, rx: 0.3, ry: 0.025, kind: BEES_HILL, weight: 0.08, top: 0, footY: 0.4 },
];

/**
 * The drift of wild flowers along the wall's foot (a BEES_PATCHES index): drawn in front of the wall
 * and the orchard, and the one drift on the ground that never runs down the slope to the lens.
 */
export const BEES_ALONG_WALL = 3;

/**
 * How far the drifts have grown lusher at a `flowers` value (0 up to 1, 1 by 3: wider by half), and
 * from 2 on how far their near sides reach down the slope (1 by 3): shader.ts sceneBees' beesLush and
 * beesReach, which beesDriftQ grows the drifts by.
 */
export function beesDriftLush(flowers: number): number {
  return Math.min(1, Math.max(0, 0.5 * (flowers - 1)));
}
export function beesDriftReach(flowers: number): number {
  const t = Math.min(1, Math.max(0, flowers - 2));
  return t * t * (3 - 2 * t);
}

/** What a texel of uSim0's red channel means (the byte value; 0 is nothing). */
export const BEES_CODE = {
  bee: 1,
  beeWing: 2,
  beeLoaded: 3,
  butterflyBody: 4,
  orange: 5,
  white: 6,
  blue: 7,
  orangeDim: 8,
  whiteDim: 9,
  blueDim: 10,
  /** A bee a little farther off, and one far off: a fainter dark. */
  beeDim: 11,
  beeFaint: 12,
  /** Three or more of a swarm's specks in one cell: the honey-brown mass of a cluster of bees. */
  swarm: 13,
  /** A bumblebee's black fur, and its yellow band (close by). */
  bumblebee: 14,
  bumblebeeBand: 15,
  /** A hoverfly, amber and black. */
  hoverfly: 16,
  /** A dragonfly's blue body, and its wing catching the light. */
  dragonfly: 17,
  dragonflyWing: 18,
  /** A firefly's flash, and its glow (round a near flash, and the flash fading). */
  firefly: 19,
  fireflyGlow: 20,
  /** A glow-worm's steady green light, and its glow (round a near one, and the light coming on or going out). */
  glowworm: 21,
  glowwormGlow: 22,
} as const;

/** Bytes of depth per metre in the map's second channel. */
export const BEES_DEPTH_STEP = 4;
