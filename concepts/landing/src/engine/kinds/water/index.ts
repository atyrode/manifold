// Water: a pond, a lake or a pool set into the land. Its outline (round, oval, kidney or a pool's
// rounded rectangle) holds a level surface a few centimetres over its origin, which the lab rests on
// the land: the land stays the ground's all round it and pokes through wherever it stands higher.
// Outside the outline a narrow wet bank falls away from the waterline, so the water never floats
// over land a little lower than it. Its bed (sand, pebbles, silt or tiles) lies below the surface by
// its depth, shallow at the shore, and is seen only through the surface: the code refracts the view
// into it rather than tracing it. The code: src/engine/kinds/water/code.ts.
import { choice, range } from "../../../params.ts";
import type { KindDef, Vec3 } from "../../types.ts";

/** The outlines, in the `shape` option's order. */
export const WATER_SHAPES = ["round", "oval", "kidney", "pool"] as const;
/** The beds, in the `bed` option's order. */
export const WATER_BEDS = ["sand", "pebbles", "silt", "tiles"] as const;
/** When it is frozen, in the `ice` option's order. */
export const WATER_ICE = ["with the cold", "frozen", "open"] as const;

const POOL = WATER_SHAPES.indexOf("pool");
const KIDNEY = WATER_SHAPES.indexOf("kidney");
const ROUND = WATER_SHAPES.indexOf("round");

/**
 * The waterline over the origin, metres: the lab rests the origin on the land, and level land
 * there must lie under the water, not in it.
 */
export const WATER_LIFT = 0.04;
/** How far below the waterline the bank reaches, metres, and how it falls per metre outward. */
export const WATER_BANK_DROP = 0.25;
export const WATER_BANK_SLOPE = { natural: 0.2, pool: 0.5 } as const;
/** The pool's corners, metres (no more than half its narrower side). */
export const WATER_POOL_CORNER = 0.3;
/**
 * The kidney, in its half length b and its half width a: an elliptic band `half` b high either side
 * of a centre line `bend` b (`lift` - (x / a)^2) up, so its ends bend toward the dented side.
 */
export const WATER_KIDNEY = { half: 0.72, bend: 0.7, lift: 0.25 } as const;

/** The bank's slope (it falls this many metres per metre outward) for a shape. */
export function waterBankSlope(shape: number): number {
  return shape === POOL ? WATER_BANK_SLOPE.pool : WATER_BANK_SLOPE.natural;
}

/** The outline's half extents, metres: across (x) and front to back (z). */
function halves(options: Readonly<Record<string, number>>): readonly [number, number] {
  const a = (options["width"] ?? 1) / 2;
  return [a, Math.round(options["shape"] ?? 0) === ROUND ? a : (options["length"] ?? 1) / 2];
}

/** Signed distance to an ellipse of radii (rx, rz), as the shared GLSL's sdEllipse. */
function ellipse(x: number, z: number, rx: number, rz: number): number {
  const k0 = Math.hypot(x / rx, z / rz);
  if (k0 < 1) return (k0 - 1) * Math.min(rx, rz);
  return (k0 * (k0 - 1)) / Math.hypot(x / (rx * rx), z / (rz * rz));
}

/**
 * Signed distance (metres, negative inside) from plan point (x, z) of the water's own frame to its
 * outline: `shape` (WATER_SHAPES), half extents a across and b front to back. The shader's
 * waterEdge, line for line: exact for the round pond and the pool, the ellipse's estimate for the
 * oval, and the kidney's band's normalised by its centre line's slope.
 */
export function waterEdge(shape: number, a: number, b: number, x: number, z: number): number {
  if (shape === ROUND) return Math.hypot(x, z) - a;
  if (shape === POOL) {
    const r = Math.min(WATER_POOL_CORNER, a, b);
    const qx = Math.abs(x) - a + r;
    const qz = Math.abs(z) - b + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
  }
  if (shape === KIDNEY) {
    const K = WATER_KIDNEY;
    const u = x / a;
    const centre = K.bend * b * (K.lift - u * u);
    const lean = (2 * K.bend * b * u) / a;
    return ellipse(x, z - centre, a, K.half * b) / Math.sqrt(1 + lean * lean);
  }
  return ellipse(x, z, a, b);
}

/** How many steps the CPU's march down the bank takes at most. */
const BANK_STEPS = 96;

export const waterKind: KindDef = {
  id: "water",
  title: "Water",
  blurb:
    "A pond, a lake or a pool set into the land: waves from the wind, the sky in it, its bed through it, rain rings and ice.",
  family: "water",
  options: [
    choice(
      "water",
      "shape",
      "shape",
      WATER_SHAPES.map((label, value) => ({ label, value })),
      2,
      "Its outline: a round pond, an oval, a kidney, or a pool's rounded rectangle.",
    ),
    range("water", "width", "width", 14, "Across, metres (the round pond's diameter).", {
      min: 1,
      max: 400,
      step: 0.5,
    }),
    range("water", "length", "length", 10, "Front to back, metres (not the round pond's).", {
      min: 1,
      max: 400,
      step: 0.5,
    }),
    range("water", "depth", "depth", 1.5, "At its deepest, metres; a pool is as deep all over.", {
      min: 0.1,
      max: 20,
      step: 0.05,
    }),
    choice(
      "water",
      "bed",
      "bed",
      WATER_BEDS.map((label, value) => ({ label, value })),
      0,
      "What lies on its bed and on its bank: sand, pebbles, dark silt, or a pool's tiles and stone.",
    ),
    range(
      "water",
      "clarity",
      "clarity",
      0.55,
      "How far the eye sees into it: a murky pond at 0, a clear spring at 1.",
    ),
    range(
      "water",
      "tint",
      "tint",
      0.45,
      "Its colour in depth: peaty brown at 0, green at the middle, blue at 1.",
    ),
    choice(
      "water",
      "ice",
      "ice",
      WATER_ICE.map((label, value) => ({ label, value })),
      0,
      "Frozen with the World's cold (ice creeps in from the shore as the cold sets in and snow lies), always, or never.",
    ),
  ],
  compiled: ["bed", "ice"],
  bounds(options) {
    const [a, b] = halves(options);
    const reach = WATER_BANK_DROP / waterBankSlope(Math.round(options["shape"] ?? 0));
    const depth = Math.max(options["depth"] ?? 1, WATER_BANK_DROP);
    // A margin over the waterline, so a ray down onto the surface is still inside the box there.
    return {
      min: [-a - reach, WATER_LIFT - depth, -b - reach],
      max: [a + reach, WATER_LIFT + 0.02, b + reach],
    };
  },
  max: 8,
  rests: "surface",
  cast(options, ro, rd, span) {
    const shape = Math.round(options["shape"] ?? 0);
    const [a, b] = halves(options);
    // Every surface of it lies at or below the waterline: an eye under it, or a ray rising, meets none.
    if (ro[1] < WATER_LIFT || rd[1] >= 0) return undefined;
    const level = (WATER_LIFT - ro[1]) / rd[1];
    if (level > span[1]) return undefined;
    const at = (t: number): Vec3 => [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t];
    const edge = (p: Vec3) => waterEdge(shape, a, b, p[0], p[2]);
    if (level >= span[0] && edge(at(level)) <= 0) return { t: level, normal: [0, 1, 0] };
    // Past the outline at the waterline: down the bank, a cone falling `slope` per metre outward
    // from the outline, marched in steps that cannot overshoot it (the outline's distance changes
    // by at most a metre a metre), to within a millimetre of it.
    const slope = waterBankSlope(shape);
    const reach = WATER_BANK_DROP / slope;
    const lean = -rd[1] + slope * Math.hypot(rd[0], rd[2]);
    const bottom = Math.min(span[1], (WATER_LIFT - WATER_BANK_DROP - ro[1]) / rd[1]);
    let t = Math.max(level, span[0]);
    for (let i = 0; i < BANK_STEPS && t <= bottom; i++) {
      const p = at(t);
      const d = p[1] - WATER_LIFT + slope * Math.max(edge(p), 0);
      if (d < 1e-4) {
        const s = edge(p);
        if (s > reach) return undefined;
        // The bank's normal: up, leaning outward along the outline's gradient.
        const e = 1e-3;
        const gx = (edge([p[0] + e, 0, p[2]]) - edge([p[0] - e, 0, p[2]])) / (2 * e);
        const gz = (edge([p[0], 0, p[2] + e]) - edge([p[0], 0, p[2] - e])) / (2 * e);
        const n: Vec3 = [slope * gx, 1, slope * gz];
        const length = Math.hypot(n[0], n[1], n[2]);
        return { t, normal: [n[0] / length, n[1] / length, n[2] / length] };
      }
      t += d / lean;
    }
    return undefined;
  },
  code: () => import("./code.ts"),
};
