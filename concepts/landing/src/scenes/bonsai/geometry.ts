// The bonsai display's fixed geometry and texture layout, shared by sim.ts (growth, raster, falling
// leaves, hit tests) and shader.ts (which templates these numbers into GLSL).
//
// Display units (TU): one unit is a screen height at full scale. World x right, y up, z away from the
// viewer (toward the wall); the pot rim's centre is the origin. The camera looks a little down on the
// display, orthographically: a world point lands at display (x, y + BONSAI_TILT * z).

/** Screen y per unit of depth: how far the camera looks down on the display. */
export const BONSAI_TILT = 0.14;

/** Where the display sits in the frame: rim centre `right` screen heights right of centre on wide
 *  frames, at screen height `rimY`; narrower than `fitAspect` it shrinks and rises by `lift`. */
export const BONSAI_FRAME = {
  right: 0.17,
  wideAspect: 1.78,
  fitAspect: 1.35,
  rimY: 0.3,
  lift: 0.22,
} as const;

export interface BonsaiPlacement {
  x: number;
  y: number;
  scale: number;
}

/** The display's placement for a frame of this aspect: display point d lands at screen (x, y) + d * scale. */
export function bonsaiPlacement(aspect: number): BonsaiPlacement {
  const scale = Math.min(1, aspect / BONSAI_FRAME.fitAspect);
  const wide = Math.min(1, Math.max(0, (aspect - 1) / (BONSAI_FRAME.wideAspect - 1)));
  return {
    x: BONSAI_FRAME.right * wide,
    y: BONSAI_FRAME.rimY + (1 - scale) * BONSAI_FRAME.lift,
    scale,
  };
}

/** The pot: half width a and half depth b at the rim, height (rim to base), feet, lip, taper at the base. */
export const BONSAI_POT = {
  a: 0.235,
  b: 0.15,
  height: 0.072,
  foot: 0.011,
  lip: 0.01,
  taper: 0.02,
} as const;
/** The soil surface inside the pot, below the rim. */
export const BONSAI_SOIL_Y = -0.008;
/** The moss mound round the trunk's foot: height and radius. */
export const BONSAI_MOUND = { height: 0.016, radius: 0.13 } as const;
/** The stand: top surface height, half width and depth, slab thickness, apron, leg width. */
export const BONSAI_STAND = {
  top: -0.083,
  halfWidth: 0.37,
  halfDepth: 0.165,
  slab: 0.022,
  apron: 0.017,
  leg: 0.03,
} as const;
/** The veranda floor and the wall behind. */
export const BONSAI_FLOOR_Y = -0.235;
export const BONSAI_WALL_Z = 0.36;
/** The trunk's foot on the soil. */
export const BONSAI_TRUNK = { x: -0.035, z: 0.015 } as const;
/** The stone on the moss (centre and half size) and the clay figure (centre, height). */
export const BONSAI_STONE = { x: 0.105, z: -0.07, rx: 0.036, ry: 0.022 } as const;
export const BONSAI_FIGURE = { x: -0.155, z: -0.06, height: 0.04 } as const;

/** The tree maps (uSim0 wood, uSim1 foliage) cover this display rectangle. */
export const BONSAI_REGION = { x0: -0.62, y0: -0.04, x1: 0.62, y1: 0.71 } as const;
export const BONSAI_MAP = { width: 640, height: 388 } as const;
/** Map texels per display unit. */
export const BONSAI_PER_UNIT = BONSAI_MAP.width / (BONSAI_REGION.x1 - BONSAI_REGION.x0);

/** The atlas (uSim2): the litter on the moss, stand and floor, then two sprites of cut twigs. */
export const BONSAI_LITTER = { x0: -0.62, y0: -0.345, width: 640, height: 192 } as const;
export const BONSAI_SPRITE = { size: 128, span: 128 / BONSAI_PER_UNIT } as const;
export const BONSAI_ATLAS = {
  width: BONSAI_LITTER.width + 2 * BONSAI_SPRITE.size,
  height: BONSAI_LITTER.height,
} as const;

/** The data texture (uSim3): rows of the low-res field (sway, silhouettes), then tables. */
export const BONSAI_FIELD = {
  width: BONSAI_MAP.width / 4,
  height: Math.round(BONSAI_MAP.height / 4),
} as const;
export const BONSAI_MAX_TUFTS = 960;
export const BONSAI_MAX_SHOOTS = 48;
export const BONSAI_MAX_MOTES = 24;
export const BONSAI_LITTER_SLOTS = 256;
/** The shoot grid: cells of this size over the map region, up to four shoots listed per cell. */
export const BONSAI_GRID_CELL = 0.04;
export const BONSAI_GRID = {
  width: Math.ceil((BONSAI_REGION.x1 - BONSAI_REGION.x0) / BONSAI_GRID_CELL),
  height: Math.ceil((BONSAI_REGION.y1 - BONSAI_REGION.y0) / BONSAI_GRID_CELL),
} as const;
const W = BONSAI_FIELD.width;
export const BONSAI_ROWS = (() => {
  const tufts = BONSAI_FIELD.height;
  const shoots = tufts + Math.ceil((2 * BONSAI_MAX_TUFTS) / W);
  const motes = shoots + Math.ceil((2 * BONSAI_MAX_SHOOTS) / W);
  const litter = motes + Math.ceil((2 * BONSAI_MAX_MOTES) / W);
  const state = litter + Math.ceil(BONSAI_LITTER_SLOTS / 4 / W);
  const grid = state + 1;
  const total = grid + Math.ceil((BONSAI_GRID.width * BONSAI_GRID.height) / W);
  return { tufts, shoots, motes, litter, state, grid, total };
})();

/** Species: the knob's values. */
export const BONSAI_PINE = 0;
export const BONSAI_MAPLE = 1;
export const BONSAI_SAKURA = 2;

/** The moss's height above the soil at (x, z). */
export function bonsaiMound(x: number, z: number): number {
  const dx = x - BONSAI_TRUNK.x;
  const dz = (z - BONSAI_TRUNK.z) * 1.4;
  return (
    BONSAI_MOUND.height *
    Math.exp(-(dx * dx + dz * dz) / (BONSAI_MOUND.radius * BONSAI_MOUND.radius))
  );
}

/** The first surface below a falling thing at (x, z): moss, pot rim, stand top or floor. */
export function bonsaiSurface(x: number, z: number): number {
  const a = BONSAI_POT.a;
  const b = BONSAI_POT.b;
  const e = (x * x) / (a * a) + (z * z) / (b * b);
  const ia = a - BONSAI_POT.lip;
  const ib = b - BONSAI_POT.lip;
  if ((x * x) / (ia * ia) + (z * z) / (ib * ib) < 1) return BONSAI_SOIL_Y + bonsaiMound(x, z);
  if (e < 1) return 0;
  if (Math.abs(x) < BONSAI_STAND.halfWidth && Math.abs(z) < BONSAI_STAND.halfDepth)
    return BONSAI_STAND.top;
  return BONSAI_FLOOR_Y;
}
