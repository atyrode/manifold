// What a ray meets in a document, on the CPU (the lab's picking and dragging): every object tested
// in its own frame, first against its bounds, then against its kind's exact shape where the kind
// gives one (KindDef.cast: the ground's height, a sphere), else the bounds themselves. Nearest wins.
import type { Ray } from "./camera.ts";
import { kindById, optionValues } from "./kinds/index.ts";
import { landUnder } from "./land.ts";
import type { Bounds, EngineDoc, Vec3 } from "./types.ts";

/** Where a ray first meets an object: its id, the distance, the point and the unit normal there. */
export interface DocHit {
  readonly id: string;
  readonly t: number;
  readonly at: Vec3;
  readonly normal: Vec3;
}

/**
 * Where the ray ro + rd t is inside `bounds`: from t `near` to `far`, and the normal of the face it
 * comes in through; undefined where it misses.
 */
function slab(
  ro: Vec3,
  rd: Vec3,
  bounds: Bounds,
): { near: number; far: number; normal: Vec3 } | undefined {
  let near = -Infinity;
  let far = Infinity;
  let axis = 0;
  for (let k = 0; k < 3; k++) {
    const o = ro[k] ?? 0;
    const d = rd[k] ?? 0;
    const lo = bounds.min[k] ?? 0;
    const hi = bounds.max[k] ?? 0;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return undefined;
      continue;
    }
    const a = (lo - o) / d;
    const b = (hi - o) / d;
    if (Math.min(a, b) > near) {
      near = Math.min(a, b);
      axis = k;
    }
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return undefined;
  const side = (rd[axis] ?? 0) < 0 ? 1 : -1;
  return {
    near,
    far,
    normal: [axis === 0 ? side : 0, axis === 1 ? side : 0, axis === 2 ? side : 0],
  };
}

/** The nearest object of `doc` along `ray` (but `ignore`), if any. */
export function castDoc(doc: EngineDoc, ray: Ray, ignore?: string): DocHit | undefined {
  let best: DocHit | undefined;
  for (const placed of doc.objects) {
    if (placed.id === ignore) continue;
    const kind = kindById(placed.kind);
    if (kind === undefined) continue;
    const options = optionValues(kind, placed);
    const c = Math.cos(placed.yaw);
    const s = Math.sin(placed.yaw);
    const k = 1 / placed.scale;
    const q: Vec3 = [
      (ray.o[0] - placed.at[0]) * k,
      (ray.o[1] - placed.at[1]) * k,
      (ray.o[2] - placed.at[2]) * k,
    ];
    const ro: Vec3 = [c * q[0] + s * q[2], q[1], c * q[2] - s * q[0]];
    const rd: Vec3 = [c * ray.d[0] + s * ray.d[2], ray.d[1], c * ray.d[2] - s * ray.d[0]];
    const box = slab(ro, rd, kind.bounds(options, landUnder(doc, placed)));
    if (box === undefined) continue;
    const span = [Math.max(box.near, 0), Math.min(box.far, (best?.t ?? Infinity) * k)] as const;
    if (span[0] > span[1]) continue;
    const hit =
      kind.cast === undefined
        ? box.near >= 0
          ? { t: box.near, normal: box.normal }
          : undefined
        : kind.cast(options, ro, rd, span);
    if (hit === undefined) continue;
    const t = hit.t * placed.scale;
    if (best !== undefined && t >= best.t) continue;
    const n = hit.normal;
    best = {
      id: placed.id,
      t,
      at: [ray.o[0] + ray.d[0] * t, ray.o[1] + ray.d[1] * t, ray.o[2] + ray.d[2] * t],
      normal: [c * n[0] - s * n[2], n[1], s * n[0] + c * n[2]],
    };
  }
  return best;
}
