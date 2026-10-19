// The land on the CPU: the twin of the GLSL's engineLand and engineLandOver (the header of
// src/engine/glsl.ts, THE LAND). The document's land is the one object whose kind gives KindDef.land
// (the exclusive group `ground` allows one); where it holds none, the land is level at y = 0, and
// under an object its own base plane. A kind that sits on the land reads it here, never the ground
// kind's own height, and is handed it under itself by KindDef.bounds.
import { kindById, optionValues } from "./kinds/index.ts";
import type { EngineDoc, KindDef, Land, Placed } from "./types.ts";

/** The document's land: its object, its kind's height and the options it reads. */
interface Ground {
  readonly placed: Placed;
  readonly land: NonNullable<KindDef["land"]>;
  readonly options: Readonly<Record<string, number>>;
}

function groundOf(doc: EngineDoc): Ground | undefined {
  for (const placed of doc.objects) {
    const kind = kindById(placed.kind);
    if (kind?.land !== undefined)
      return { placed, land: kind.land, options: optionValues(kind, placed) };
  }
  return undefined;
}

/** The height (world y, metres) of `ground`'s land at world plan point (x, z). */
function heightOf(ground: Ground, x: number, z: number): number {
  const { at, yaw, scale } = ground.placed;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const qx = (x - at[0]) / scale;
  const qz = (z - at[2]) / scale;
  return at[1] + scale * ground.land(ground.options, c * qx + s * qz, c * qz - s * qx);
}

/** The land's height (world y, metres) at world plan point (x, z) of `doc`: 0 where it holds none. */
export function engineLand(doc: EngineDoc, x: number, z: number): number {
  const ground = groundOf(doc);
  return ground === undefined ? 0 : heightOf(ground, x, z);
}

/**
 * The land under `placed` as it measures it (Land: its height over the object's origin at plan
 * point (x, z) of its own frame, metres at scale 1): its own base plane where `doc` holds no land.
 */
export function landUnder(doc: EngineDoc, placed: Placed): Land {
  const ground = groundOf(doc);
  if (ground === undefined) return () => 0;
  const { at, yaw, scale } = placed;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return (x, z) =>
    (heightOf(ground, at[0] + scale * (c * x - s * z), at[2] + scale * (s * x + c * z)) - at[1]) /
    scale;
}
