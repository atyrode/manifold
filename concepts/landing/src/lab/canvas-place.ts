// Where the lab's canvas mode sets an object down in the world, asking the engine view what lies
// under a cell (EngineView.surface) or along a ray (EngineView.cast): a new object where the ray
// through the picture's centre meets a surface within DROP_REACH, else on whatever lies below a point
// DROP_AHEAD ahead of the eye (or at that point, over nothing). A drag holds the point where the
// object was grabbed: the object moves across the level plane through that point as the pointer's
// ray crosses it, so it never jumps, however tall it is or wherever it was grabbed. It then rests on
// the highest surface below its top (never itself); one that rests anywhere in the air (KindDef.rests
// "free") keeps its height.
import type { EngineView, KindDef, Placed, Vec3 } from "../engine/types.ts";
import { add, cameraBasis, planeHit, scale, sub } from "./canvas-camera.ts";

/** How far ahead of the eye a new object stands when the centre's ray meets nothing near (metres). */
export const DROP_AHEAD = 3;
/** The farthest a new object is set down along the centre's ray (metres): a level eye meets the ground far off. */
export const DROP_REACH = 8;

/** Where a new object stands: see the header. */
export function dropPoint(view: EngineView, centre: readonly [number, number] | undefined): Vec3 {
  const { camera } = view.doc;
  const hit = centre && view.surface(centre[0], centre[1]);
  if (hit && Math.hypot(...sub(hit.at, camera.at)) <= DROP_REACH) return hit.at;
  const ahead = add(camera.at, scale(cameraBasis(camera).forward, DROP_AHEAD));
  return view.cast(ahead, [0, -1, 0])?.at ?? ahead;
}

/** A drag's hold on an object: the point grabbed, and where the object stood then. */
export interface Grip {
  readonly from: Vec3;
  readonly base: Vec3;
}

/** The hold of a press on `placed` along pointer ray `ray`: what the ray meets first, the object. */
export function grip(view: EngineView, placed: Placed, ray: Vec3): Grip {
  const eye = view.doc.camera.at;
  const from = view.cast(eye, ray)?.at ?? planeHit(eye, ray, placed.at[1]) ?? placed.at;
  return { from, base: placed.at };
}

/** How far above an object's top the search for what it rests on starts (metres). */
const REST_ABOVE = 0.25;

/**
 * Where a drag with `held` puts `placed` with the pointer's ray `ray`: moved by how far the ray's
 * crossing of the grabbed point's level plane has moved, then on the highest surface below its top,
 * or at its height for a free one; undefined where the ray does not cross the plane ahead (the object
 * stays where it was).
 */
export function dragPoint(
  view: EngineView,
  placed: Placed,
  kind: KindDef,
  ray: Vec3,
  held: Grip,
): Vec3 | undefined {
  const crossing = planeHit(view.doc.camera.at, ray, held.from[1]);
  if (!crossing) return undefined;
  const x = held.base[0] + crossing[0] - held.from[0];
  const z = held.base[2] + crossing[2] - held.from[2];
  if (kind.rests === "free") return [x, held.base[1], z];
  const top = held.base[1] + kind.bounds(placed.options).max[1] * placed.scale + REST_ABOVE;
  const rest = view.cast([x, Math.max(top, held.from[1]), z], [0, -1, 0], placed.id);
  return [x, rest?.at[1] ?? held.base[1], z];
}
