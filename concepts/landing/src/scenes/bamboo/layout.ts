// The bamboo grove's fixed geometry, shared by the layers' manifests (layers.ts), the rig
// (constants.ts), the grove's sim (sim.ts) and the GLSL (shader.ts, which templates these numbers in,
// so they cannot drift). Plain data, loaded with the composer's registry.
//
// The grove is seen side-on through the preset's rig (constants.ts BAMBOO_RIG): a level pinhole
// BAMBOO_EYE metres up, focal one screen height, the horizon at BAMBOO_HORIZON. A point at depth z
// (m) and height y (m) lands at screen y = HORIZON + (y - EYE) / z; its x scales by 1 / z.
//
//   layers   the culms' five depth layers, near to far: a cell grid of `spacing` metres each cell of
//            which may hold one culm of about `diameter`; the nearest holds one big culm framing the
//            left edge
//   clock    the water clock (shishi-odoshi) in the near right corner, in device units: screen
//            heights before the corner's scale (bambooDeviceScale), origin at the frame's
//            bottom-right corner, y up; the stone lantern on the grove floor left of it
//   gust     how hard the composer's gust field (ADR 0062 D4) bows the culms: the field's load times
//            `gain`, so a gust at the composer's default strength crests about as high as the
//            grove's own fronts did

/** Seconds into the entrance at which the spout's first water leaves its lip (the stream starts here). */
export const BAMBOO_STREAM_START = 0.7;

/** The ground's horizon in screen heights, and the eye's height in metres (the rig's). */
export const BAMBOO_HORIZON = 0.4;
export const BAMBOO_EYE = 1.3;

export interface BambooLayer {
  /** Metres from the eye. */
  readonly depth: number;
  /** Grid cell width in metres: each cell may hold one culm. */
  readonly spacing: number;
  /** Culm diameter in metres (each culm varies about it). */
  readonly diameter: number;
}

/**
 * The grove's depth layers, near to far. The nearest holds a single big culm framing the left edge
 * (shader.ts places it); the others are grids of cells, each of which may hold a culm.
 */
export const BAMBOO_LAYERS: readonly BambooLayer[] = [
  { depth: 0.85, spacing: 1.2, diameter: 0.14 },
  { depth: 1.6, spacing: 1.0, diameter: 0.12 },
  { depth: 3.6, spacing: 0.95, diameter: 0.11 },
  { depth: 7, spacing: 0.9, diameter: 0.1 },
  { depth: 13, spacing: 0.85, diameter: 0.1 },
];
/** Grid cells simulated per layer, centred on the view axis (enough for a 2.9:1 frame). */
export const BAMBOO_CELLS = 64;
/** Height (m) at which a culm's deflection is measured; it bends as (height / this)^1.5. */
export const BAMBOO_SWAY_HEIGHT = 8;

/**
 * The gust field's load (composer/gust.ts gustAt) times this is a culm's gust, in units of its sway
 * (windSway, sim.ts): at the composer's default strength the field's crests (its 90th and 95th
 * percentiles, about 0.48 and 0.54) reach about where the grove's own fronts crested (0.69, 0.83).
 */
export const BAMBOO_GUST_GAIN = 1.5;

/**
 * The water clock, in device units: screen heights before the corner's scale (bambooDeviceScale,
 * 1.25 on landscape frames, less on narrow ones), origin at the frame's bottom-right corner, y up.
 * The tube pivots at (x, y); `back` and `front` are its lengths behind and ahead of the pivot, the
 * mouth is cut obliquely over `cut`; it rests mouth up at `rest` (radians) on the striking stone and
 * tips no lower than `low`. At full size the tube spans about a quarter of a 16:9 frame's width.
 */
export const BAMBOO_TUBE = {
  x: -0.31,
  y: 0.22,
  back: 0.15,
  front: 0.22,
  radius: 0.022,
  cut: 0.055,
  rest: 0.38,
  low: -0.4,
} as const;
/** Where the tube's closed end strikes: the top of the stone under it at rest. */
export const BAMBOO_STRIKE = {
  x: BAMBOO_TUBE.x - BAMBOO_TUBE.back * Math.cos(BAMBOO_TUBE.rest),
  top:
    BAMBOO_TUBE.y -
    BAMBOO_TUBE.back * Math.sin(BAMBOO_TUBE.rest) -
    BAMBOO_TUBE.radius * Math.cos(BAMBOO_TUBE.rest),
} as const;
/** The spout (kakei): a thin cane from beyond the right edge to its cut end. */
export const BAMBOO_SPOUT = {
  fromX: 0.05,
  fromY: 0.367,
  toX: -0.135,
  toY: 0.356,
  radius: 0.012,
} as const;
/** The spout's lower lip, where the trickle leaves it: the cane's end, one radius below its axis. */
export const BAMBOO_LIP = (() => {
  const dx = BAMBOO_SPOUT.toX - BAMBOO_SPOUT.fromX;
  const dy = BAMBOO_SPOUT.toY - BAMBOO_SPOUT.fromY;
  const length = Math.hypot(dx, dy);
  // The cane's "up" normal: its direction turned a quarter toward +y.
  const upX = dy / length;
  const upY = -dx / length;
  return {
    x: BAMBOO_SPOUT.toX - BAMBOO_SPOUT.radius * upX,
    y: BAMBOO_SPOUT.toY - BAMBOO_SPOUT.radius * upY,
  } as const;
})();
/** The post the spout is tied to. */
export const BAMBOO_POST_X = -0.035;
/** The basin's water: centre and radii of its ellipse (a circle seen from a little above). */
export const BAMBOO_BASIN = { x: -0.13, y: 0.06, rx: 0.078, ry: 0.02 } as const;
/** The pour leaves the mouth along the tube at `speed` and falls under `gravity` (device units). */
export const BAMBOO_POUR = { speed: 0.12, gravity: 1.2 } as const;
/** How far away the water clock stands (m): its parallax, and the depth of leaves meant for it. */
export const BAMBOO_DEVICE_DEPTH = 1.35;
/** The stone lantern standing on the grove floor left of the water clock: its axis in device units
 *  across, its depth in metres (it stands between the second and third layers of culms). */
export const BAMBOO_LANTERN = { x: -0.64, depth: 3.4 } as const;
/** Ripple events the shader rings at once. */
export const BAMBOO_RIPPLES = 8;
/** Leaves in the air or on the water at once. */
export const BAMBOO_MAX_LEAVES = 12;

/** The corner group (water clock and lantern) is drawn `size` times its device units from this aspect
 *  up, and shrinks with narrower frames down to `smallest` of that, so it never fills a phone's screen. */
export const BAMBOO_CORNER_FIT = { aspect: 1.5, smallest: 0.55, size: 1.25 } as const;

/** The corner group's scale (screen heights per device unit) for a frame of this aspect. */
export function bambooDeviceScale(aspect: number): number {
  return (
    BAMBOO_CORNER_FIT.size *
    Math.min(1, Math.max(BAMBOO_CORNER_FIT.smallest, aspect / BAMBOO_CORNER_FIT.aspect))
  );
}

/**
 * Where the pour meets the water, in device x, for the tube at `angle`: it leaves the mouth's lower
 * lip along the tube and falls in a parabola.
 */
export function bambooPourLanding(angle: number): number {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lipX = BAMBOO_TUBE.x + BAMBOO_TUBE.front * c + BAMBOO_TUBE.radius * s;
  const lipY = BAMBOO_TUBE.y + BAMBOO_TUBE.front * s - BAMBOO_TUBE.radius * c;
  const vx = BAMBOO_POUR.speed * c;
  const vy = BAMBOO_POUR.speed * s;
  const drop = Math.max(lipY - BAMBOO_BASIN.y, 0);
  const g = BAMBOO_POUR.gravity;
  const flight = (vy + Math.sqrt(vy * vy + 2 * g * drop)) / g;
  return lipX + vx * flight;
}

/**
 * A point of the corner group on the floor (m, the rig's frame) at the corner's full size, as the
 * frame BAMBOO_CORNER_FIT.aspect wide lays it out: device x `dx` at depth `z`. The claims stand
 * there (layers.ts); a wider frame carries the group right with its edge.
 */
export function bambooCornerFloor(dx: number, z: number): readonly [number, number] {
  return [(0.5 * BAMBOO_CORNER_FIT.aspect + BAMBOO_CORNER_FIT.size * dx) * z, z];
}
