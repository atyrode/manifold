// A document's program (src/engine/README.md "Programs"): which kinds it holds, each kind's instance
// count rounded up to a bucket, and the values its instances hold of each compiled option, as
// compile-time features (`engineFeatures`: `ENGINE_<KIND>` its bucket, `ENGINE_<KIND>_<OPTION>` the
// bitmask of its values). They join the World's gates in the canvas scene's feature set, so the
// renderer's program cache keys, builds and keeps engine programs as it does every scene's; moving,
// turning, scaling or tuning an object changes none of them. `engineProgramGlsl` assembles the
// program's GLSL from them: the World, the gusts, the engine's ray, the air, then the core and each
// kind's code (src/engine/glsl.ts).
import { WORLD_TRIGGERS } from "../composer/compose.ts";
import { gustGlsl } from "../composer/gust.ts";
import { featureKey, SceneShaderError } from "../shaders/index.ts";
import { worldGlsl } from "../shaders/lib/world.ts";
import { engineAirGlsl } from "./air.ts";
import { engineGlsl, engineTypesGlsl, type KindPlan } from "./glsl.ts";
import { BUCKETS } from "./instances.ts";
import { kindById, kindCode, kindRow, kinds, optionValues } from "./kinds/index.ts";
import type { EngineDoc, KindDef } from "./types.ts";

/** A kind's feature: its bucket. */
function kindFeature(kind: KindDef): string {
  return `ENGINE_${kind.id.toUpperCase()}`;
}

/** A compiled option's feature: the bitmask of the values the kind's instances hold. */
function optionFeature(kind: KindDef, key: string): string {
  return `${kindFeature(kind)}_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
}

/** The smallest bucket that holds `count` instances; throws past the largest. */
export function bucketOf(count: number): number {
  const bucket = BUCKETS.find((size) => size >= count);
  if (bucket === undefined)
    throw new RangeError(`engine: ${count} instances of a kind, at most ${BUCKETS.at(-1)}`);
  return bucket;
}

/** The compile-time features of `doc`'s program (see the header). Throws for an unknown kind. */
export function engineFeatures(doc: EngineDoc): Record<string, number> {
  const counts = new Map<KindDef, number>();
  const masks: Record<string, number> = {};
  for (const placed of doc.objects) {
    const kind = kindById(placed.kind);
    if (kind === undefined) throw new RangeError(`engine: no kind "${placed.kind}"`);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const values = optionValues(kind, placed);
    for (const key of kind.compiled ?? []) {
      const name = optionFeature(kind, key);
      masks[name] = (masks[name] ?? 0) | (1 << Math.round(values[key] ?? 0));
    }
  }
  return {
    ...Object.fromEntries([...counts].map(([kind, count]) => [kindFeature(kind), bucketOf(count)])),
    ...masks,
  };
}

/** The identity of `doc`'s program as far as the document decides it (the World's gates aside). */
export function engineProgramKey(doc: EngineDoc): string {
  return featureKey(engineFeatures(doc));
}

/**
 * What a program of these features draws of each kind, in row order. Throws SceneShaderError for a
 * kind whose code has not loaded (src/engine/kinds/index.ts `loadKindCode`).
 */
export function enginePlans(features: Readonly<Record<string, number>>): KindPlan[] {
  return kinds.flatMap((kind) => {
    const bucket = features[kindFeature(kind)] ?? 0;
    if (bucket <= 0) return [];
    const code = kindCode(kind.id);
    if (code === undefined)
      throw new SceneShaderError(`engine: the code of kind ${kind.id} has not loaded`);
    const compiled = Object.fromEntries(
      (kind.compiled ?? []).map((key) => [key, features[optionFeature(kind, key)] ?? 0]),
    );
    return [{ kind, code, row: kindRow(kind), bucket, compiled }];
  });
}

/** The canvas scene's GLSL for a program of these features (SceneCode.glslFor). */
export function engineProgramGlsl(features: Readonly<Record<string, number>>): string {
  const plans = enginePlans(features);
  const mirror = plans.some((plan) => plan.code.mirror?.(plan.compiled) === true);
  return `${worldGlsl}${gustGlsl(WORLD_TRIGGERS.gusts, undefined)}${engineTypesGlsl}${engineAirGlsl}${engineGlsl(plans, mirror)}`;
}
