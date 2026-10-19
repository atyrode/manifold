// What the kinds built of boards share (the room, the sideboard, the table, the shelf): where a ray
// enters an axis-aligned box, or a box cut by one plane (a cornice's cove, a bracket's brace), on the
// CPU (castBox, for KindDef.cast) and in GLSL (joineryGlsl), and the woods they are made of. The GLSL
// is generated under a kind's prefix, as the kind contract names everything a kind defines with its
// id (src/engine/glsl.ts): joineryGlsl("table") defines tableInv, tableBox, tableCutBox, tableWood
// and tableGrain.
import { glslVec3 } from "../../shaders/glsl.ts";
import type { Vec3 } from "../types.ts";

/** Where a ray enters a solid: its distance and the unit normal of the face it enters by. */
export interface Entry {
  readonly t: number;
  readonly normal: Vec3;
}

/** A plane cutting a box: the solid keeps the points p with dot((x, y, z), p) <= offset. */
export type Cut = readonly [x: number, y: number, z: number, offset: number];

/** The woods by tone: dark walnut at 0, teak at WOOD_TEAK, pale birch at 1. */
const WALNUT = [0.16, 0.09, 0.05] as const;
const TEAK = [0.42, 0.23, 0.12] as const;
const BIRCH = [0.74, 0.6, 0.42] as const;
export const WOOD_TEAK = 0.45;

/**
 * Where ro + rd t enters the box lo..hi (cut by `cut`, if given) with t in [from, to]: undefined where
 * it misses, starts inside, or enters outside that span.
 */
export function castBox(
  lo: Vec3,
  hi: Vec3,
  ro: Vec3,
  rd: Vec3,
  from: number,
  to: number,
  cut?: Cut,
): Entry | undefined {
  let near = -Infinity;
  let far = Infinity;
  let normal: Vec3 = [0, 1, 0];
  for (let k = 0; k < 3; k++) {
    const o = ro[k] ?? 0;
    const d = rd[k] ?? 0;
    const l = lo[k] ?? 0;
    const h = hi[k] ?? 0;
    if (Math.abs(d) < 1e-12) {
      if (o < l || o > h) return undefined;
      continue;
    }
    const a = (l - o) / d;
    const b = (h - o) / d;
    if (Math.min(a, b) > near) {
      near = Math.min(a, b);
      const side = d < 0 ? 1 : -1;
      normal = [k === 0 ? side : 0, k === 1 ? side : 0, k === 2 ? side : 0];
    }
    far = Math.min(far, Math.max(a, b));
  }
  if (cut !== undefined) {
    const [x, y, z, offset] = cut;
    const along = x * rd[0] + y * rd[1] + z * rd[2];
    const room = offset - (x * ro[0] + y * ro[1] + z * ro[2]);
    if (Math.abs(along) < 1e-12) {
      if (room < 0) return undefined;
    } else if (along > 0) far = Math.min(far, room / along);
    else if (room / along > near) {
      near = room / along;
      const size = Math.hypot(x, y, z);
      normal = [x / size, y / size, z / size];
    }
  }
  if (near > far || near < from || near > to) return undefined;
  return { t: near, normal };
}

/** The nearest of the entries offered (`take`), each with the piece it belongs to. */
export class Nearest {
  t: number;
  normal: Vec3 = [0, 1, 0];
  piece = -1;

  constructor(to: number) {
    this.t = to;
  }

  /** Keep `entry` of `piece` if it is nearer than the nearest so far; whether it was. */
  take(entry: Entry | undefined, piece: number): boolean {
    if (entry === undefined || entry.t >= this.t) return false;
    this.t = entry.t;
    this.normal = entry.normal;
    this.piece = piece;
    return true;
  }
}

/** The GLSL twin of castBox and the woods, its names prefixed with `id` (see the header). */
export function joineryGlsl(id: string): string {
  return `
// ---- ${id}'s joinery (src/engine/kinds/joinery.ts) ----
// The reciprocal of a ray's direction, never infinite: what ${id}Box takes for it.
vec3 ${id}Inv(vec3 rd) {
  return vec3(rd.x < 0.0 ? -1.0 : 1.0, rd.y < 0.0 ? -1.0 : 1.0, rd.z < 0.0 ? -1.0 : 1.0) / max(abs(rd), vec3(1e-9));
}

// Where the ray ro + rd t (inv: ${id}Inv(rd)) enters box lo..hi with t in [from, t): t becomes it, n
// its face's normal; false where it misses, starts inside or enters outside that span.
bool ${id}Box(vec3 ro, vec3 inv, vec3 lo, vec3 hi, float from, inout float t, inout vec3 n) {
  vec3 a = (lo - ro) * inv;
  vec3 b = (hi - ro) * inv;
  vec3 near = min(a, b);
  vec3 far = max(a, b);
  float enter = max(max(near.x, near.y), near.z);
  if (enter > min(min(far.x, far.y), far.z) || enter < from || enter >= t) return false;
  t = enter;
  n = enter == near.x ? vec3(-sign(inv.x), 0.0, 0.0) : enter == near.y ? vec3(0.0, -sign(inv.y), 0.0) : vec3(0.0, 0.0, -sign(inv.z));
  return true;
}

// ${id}Box for the box cut by a plane: the solid keeps the points p with dot(cut.xyz, p) <= cut.w.
bool ${id}CutBox(vec3 ro, vec3 rd, vec3 inv, vec3 lo, vec3 hi, vec4 cut, float from, inout float t, inout vec3 n) {
  vec3 a = (lo - ro) * inv;
  vec3 b = (hi - ro) * inv;
  vec3 near = min(a, b);
  vec3 far = max(a, b);
  float enter = max(max(near.x, near.y), near.z);
  float leave = min(min(far.x, far.y), far.z);
  vec3 face = enter == near.x ? vec3(-sign(inv.x), 0.0, 0.0) : enter == near.y ? vec3(0.0, -sign(inv.y), 0.0) : vec3(0.0, 0.0, -sign(inv.z));
  float along = dot(cut.xyz, rd);
  float room = cut.w - dot(cut.xyz, ro);
  if (abs(along) < 1e-12) {
    if (room < 0.0) return false;
  } else if (along > 0.0) {
    leave = min(leave, room / along);
  } else if (room / along > enter) {
    enter = room / along;
    face = normalize(cut.xyz);
  }
  if (enter > leave || enter < from || enter >= t) return false;
  t = enter;
  n = face;
  return true;
}

// Wood of tone 0 (dark walnut) .. ${WOOD_TEAK} (teak) .. 1 (pale birch).
vec3 ${id}Wood(float tone) {
  return tone < ${WOOD_TEAK} ? mix(${glslVec3(WALNUT)}, ${glslVec3(TEAK)}, tone / ${WOOD_TEAK}) : mix(${glslVec3(TEAK)}, ${glslVec3(BIRCH)}, (tone - ${WOOD_TEAK}) / ${1 - WOOD_TEAK});
}

// Its figure on a face at q (metres, the grain along x) seen through a cell foot metres across, a
// board's seed apart from the next: about 0.8 .. 1.2 round 1. The soft rings of a flat-sawn board,
// its fine streaks, each gone to its mean once a cell spans it.
float ${id}Grain(vec2 q, float foot, float seed) {
  float wave = vnoise(vec2(q.x * 0.9 + seed * 5.3, q.y * 6.0 + seed));
  float rings = sin(q.y * 55.0 + wave * 5.0 + seed * 7.0);
  float streak = vnoise(vec2(q.x * 2.0, q.y * 140.0 + seed * 13.0));
  float fine = 1.0 - smoothstep(0.003, 0.012, foot);
  float coarse = 1.0 - smoothstep(0.01, 0.04, foot);
  return 1.0 + 0.09 * rings * coarse + 0.16 * (streak - 0.5) * fine + 0.12 * (wave - 0.5);
}
`;
}
