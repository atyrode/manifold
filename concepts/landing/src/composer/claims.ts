// Claims on the floor (README "Space"): the outlines' geometry, whether two overlap, what a cover may
// grow at a point, and the GLSL twin compiled into a program from its placement (`claimsGlsl`:
// coverAllowed, casterShadow, shelterAt). Every outline is made of capsules (a disc is one of zero
// length, a strip a chain of them) or a convex polygon (a box with its turn), so the overlap test is
// exact. Outlines that only touch along an edge or at a corner count as overlapping.
import { glslFloat } from "../shaders/glsl.ts";
import { smoothstep } from "../sims/math.ts";
import type { Claim, FloorPoint, PlacedClaim, Shape } from "./types.ts";

/** Covers thin to nothing in a clearing's core and come back over this many metres outside it. */
export const CLEAR_FEATHER = 0.3;

/**
 * A claim's key-light shadow (the apiary's hive model): a soft band from the caster's foot away
 * from the key light, as long as its height times the light's reach but at most its `length`,
 * fading over SHADOW_SOFT metres inside its radius, taking SHADOW_DARK of the key light.
 */
const SHADOW_SOFT = 0.4;
const SHADOW_DARK = 0.85;

type Piece =
  | { readonly kind: "capsule"; readonly a: FloorPoint; readonly b: FloorPoint; readonly r: number }
  | { readonly kind: "polygon"; readonly points: readonly FloorPoint[] };

/** The shape as convex pieces. */
function pieces(shape: Shape): Piece[] {
  switch (shape.kind) {
    case "disc":
      return [{ kind: "capsule", a: shape.at, b: shape.at, r: shape.r }];
    case "box": {
      const [cx, cz] = shape.at;
      const [hx, hz] = shape.half;
      const cos = Math.cos(shape.turn ?? 0);
      const sin = Math.sin(shape.turn ?? 0);
      const corners: FloorPoint[] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ].map(([sx = 0, sz = 0]) => [
        cx + sx * hx * cos - sz * hz * sin,
        cz + sx * hx * sin + sz * hz * cos,
      ]);
      return [{ kind: "polygon", points: corners }];
    }
    case "strip": {
      const [first, ...rest] = shape.points;
      if (first === undefined) return [];
      if (rest.length === 0) return [{ kind: "capsule", a: first, b: first, r: shape.half }];
      return shape.points
        .slice(1)
        .map((b, i): Piece => ({ kind: "capsule", a: shape.points[i] ?? b, b, r: shape.half }));
    }
    default: {
      const unreachable: never = shape;
      throw new Error(`composer: unknown shape ${String(unreachable)}`);
    }
  }
}

/** Distance from p to the segment ab. */
function segmentDistance(p: FloorPoint, a: FloorPoint, b: FloorPoint): number {
  const abx = b[0] - a[0];
  const abz = b[1] - a[1];
  const len2 = abx * abx + abz * abz;
  const t =
    len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - t * abx, p[1] - a[1] - t * abz);
}

const cross = (o: FloorPoint, a: FloorPoint, b: FloorPoint): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Distance between segments ab and cd: 0 where they cross or touch. */
function segmentSegment(a: FloorPoint, b: FloorPoint, c: FloorPoint, d: FloorPoint): number {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(
    segmentDistance(a, c, d),
    segmentDistance(b, c, d),
    segmentDistance(c, a, b),
    segmentDistance(d, a, b),
  );
}

/** Whether p is inside the convex polygon or on its outline (either winding). */
function inside(p: FloorPoint, polygon: readonly FloorPoint[]): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    const c = Math.sign(cross(a, b, p));
    if (c === 0) continue;
    if (sign === 0) sign = c;
    else if (c !== sign) return false;
  }
  return true;
}

function edges(polygon: readonly FloorPoint[]): (readonly [FloorPoint, FloorPoint])[] {
  return polygon.map((a, i) => [a, polygon[(i + 1) % polygon.length] ?? a] as const);
}

/** Distance from the segment ab to the polygon's area: 0 where it reaches it. */
function polygonSegment(polygon: readonly FloorPoint[], a: FloorPoint, b: FloorPoint): number {
  if (inside(a, polygon) || inside(b, polygon)) return 0;
  return Math.min(...edges(polygon).map(([c, d]) => segmentSegment(a, b, c, d)));
}

/** How far apart two pieces are: negative or 0 where their areas meet. */
function separation(p: Piece, q: Piece): number {
  if (p.kind === "capsule")
    return q.kind === "capsule"
      ? segmentSegment(p.a, p.b, q.a, q.b) - p.r - q.r
      : polygonSegment(q.points, p.a, p.b) - p.r;
  if (q.kind === "capsule") return polygonSegment(p.points, q.a, q.b) - q.r;
  return Math.min(...edges(p.points).map(([a, b]) => polygonSegment(q.points, a, b)));
}

/** Whether two shapes share any of the floor (touching counts). */
export function overlaps(a: Shape, b: Shape): boolean {
  const pb = pieces(b);
  return pieces(a).some((p) => pb.some((q) => separation(p, q) <= 0));
}

/** Signed distance from p to the shape's outline: negative inside. */
export function signedDistance(shape: Shape, p: FloorPoint): number {
  let best = Number.POSITIVE_INFINITY;
  for (const piece of pieces(shape)) {
    if (piece.kind === "capsule")
      best = Math.min(best, segmentDistance(p, piece.a, piece.b) - piece.r);
    else {
      const out = Math.min(...edges(piece.points).map(([a, b]) => segmentDistance(p, a, b)));
      best = Math.min(best, inside(p, piece.points) ? -out : out);
    }
  }
  return best;
}

/** The shape moved by `by` (an anchor), or its x scaled by `sx` (a stretched frame). */
export function moveShape(shape: Shape, by: FloorPoint, sx = 1): Shape {
  const move = (p: FloorPoint): FloorPoint => [(p[0] + by[0]) * sx, p[1] + by[1]];
  switch (shape.kind) {
    case "disc":
    case "box":
      return { ...shape, at: move(shape.at) };
    case "strip":
      return { ...shape, points: shape.points.map(move) };
    default: {
      const unreachable: never = shape;
      throw new Error(`composer: unknown shape ${String(unreachable)}`);
    }
  }
}

/** A claim where its layer stands. */
export function placeClaim(claim: Claim, layer: string, at: FloorPoint): PlacedClaim {
  return { ...claim, layer, shape: moveShape(claim.shape, at) };
}

/**
 * What a cover may grow at floor point (x, z), 0..1 (the CPU twin of `coverAllowed`): 0 in
 * exclusive cores and clearing cores, coming back over CLEAR_FEATHER outside a clearing, the
 * cover's `overgrowth` inside shared claims; the least of them all.
 */
export function coverAt(
  claims: readonly PlacedClaim[],
  x: number,
  z: number,
  overgrowth = 1,
): number {
  let allowed = 1;
  for (const claim of claims) {
    const d = signedDistance(claim.shape, [x, z]);
    if (claim.kind === "exclusive" && d < 0) return 0;
    if (claim.kind === "clears") allowed = Math.min(allowed, smoothstep(0, CLEAR_FEATHER, d));
    if (claim.kind === "shared" && d < 0) allowed = Math.min(allowed, overgrowth);
  }
  return allowed;
}

/** Where a shape stands: a disc's or a box's centre, a strip's first point. */
function centre(shape: Shape): FloorPoint {
  return shape.kind === "strip" ? (shape.points[0] ?? [0, 0]) : shape.at;
}

// ---- GLSL ---------------------------------------------------------------------------------------

const vec2 = (p: FloorPoint): string => `vec2(${glslFloat(p[0])}, ${glslFloat(p[1])})`;

/** GLSL for a shape's signed distance at `q`. */
function distanceGlsl(shape: Shape): string {
  switch (shape.kind) {
    case "disc":
      return `length(q - ${vec2(shape.at)}) - ${glslFloat(shape.r)}`;
    case "box": {
      const local = `q - ${vec2(shape.at)}`;
      const turned =
        (shape.turn ?? 0) === 0 ? local : `rotate(${local}, ${glslFloat(-(shape.turn ?? 0))})`;
      return `sdBox(${turned}, ${vec2(shape.half)}, 0.0)`;
    }
    case "strip": {
      const near = pieces(shape)
        .map((piece) =>
          piece.kind === "capsule" ? `segmentDistance(q, ${vec2(piece.a)}, ${vec2(piece.b)})` : "",
        )
        .reduce((all, part) => `min(${all}, ${part})`);
      return `${near} - ${glslFloat(shape.half)}`;
    }
    default: {
      const unreachable: never = shape;
      throw new Error(`composer: unknown shape ${String(unreachable)}`);
    }
  }
}

/**
 * The placement in GLSL (README "Compositing"), every claim a constant:
 *   float coverAllowed(vec2 xz, float stretch, float overgrowth)
 *   float casterShadow(vec2 xz, Ctx x)     0 lit .. SHADOW_DARK shaded, by the claims' shadows
 *   float shelterAt(vec2 xz, Ctx x)        the share of precipitation kept off there
 * `stretched` names the layers whose claims spread with the frame: their x divides by the stretch.
 */
export function claimsGlsl(
  claims: readonly PlacedClaim[],
  stretched: ReadonlySet<string>,
  casters: readonly string[],
): string {
  const local = (claim: PlacedClaim, stretch: string) =>
    stretched.has(claim.layer) ? `vec2(xz.x / ${stretch}, xz.y)` : "xz";
  const cover = claims.map((claim) => {
    const head = `  { vec2 q = ${local(claim, "stretch")}; float d = ${distanceGlsl(claim.shape)};`;
    if (claim.kind === "exclusive") return `${head} if (d < 0.0) return 0.0; }`;
    if (claim.kind === "clears")
      return `${head} allowed = min(allowed, smoothstep(0.0, ${glslFloat(CLEAR_FEATHER)}, d)); }`;
    return `${head} if (d < 0.0) allowed = min(allowed, overgrowth); }`;
  });
  const shadows = claims.flatMap((claim) => {
    const shadow = claim.shadow;
    if (shadow === undefined) return [];
    const [cx, cz] = centre(claim.shape);
    const foot = stretched.has(claim.layer)
      ? `vec2(${glslFloat(cx)} * x.stretch, ${glslFloat(cz)})`
      : vec2([cx, cz]);
    return [
      `  { vec2 foot = ${foot}; float dd = segmentDistance(xz, foot, foot + away * min(${glslFloat(shadow.height)} * reach, ${glslFloat(shadow.length)}));
    s = max(s, (1.0 - smoothstep(${glslFloat(Math.max(0, shadow.radius - SHADOW_SOFT))}, ${glslFloat(shadow.radius)}, dd)) * ${glslFloat(SHADOW_DARK)}); }`,
    ];
  });
  const shelters = claims.flatMap((claim) =>
    (claim.shelter ?? 0) > 0
      ? [
          `  { vec2 q = ${local(claim, "x.stretch")}; if (${distanceGlsl(claim.shape)} < 0.0) kept = max(kept, ${glslFloat(claim.shelter ?? 0)}); }`,
        ]
      : [],
  );
  return `
// ---- the placement (composer/claims.ts): ${claims.length} claim(s) ----
float coverAllowed(vec2 xz, float stretch, float overgrowth) {
${cover.length === 0 ? "  return 1.0;" : `  float allowed = 1.0;\n${cover.join("\n")}\n  return allowed;`}
}

${casters.map((fn) => `float ${fn}(vec2 xz, Ctx x);\n`).join("")}float casterShadow(vec2 xz, Ctx x) {
${
  shadows.length === 0 && casters.length === 0
    ? "  return 0.0;"
    : `  vec2 away = -x.light.keyGround;
  float reach = clamp(1.0 / x.light.keyTan, 0.8, 4.0);
  float s = 0.0;
${[...shadows, ...casters.map((fn) => `  s = max(s, ${fn}(xz, x));`)].join("\n")}
  return s * x.light.keyUp;`
}
}

float shelterAt(vec2 xz, Ctx x) {
${shelters.length === 0 ? "  return 0.0;" : `  float kept = 0.0;\n${shelters.join("\n")}\n  return kept;`}
}
`;
}
