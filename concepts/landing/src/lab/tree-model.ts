// The scenes' tree (ADR 0062 D9 as amended, "Baselines and variants"): a shelf per composer,
// each its baseline's own scene (D13), then its curated variants in their registry's order (a room's
// folders, then the promoted ones), the scenes stored over it. The scenes neither a baseline nor a
// variant (a program of their own, D24) stand on a shelf apart, in their families' order (lab/families.ts). A scene's
// composer is the one whose layers hold every layer it offers. The Scenes view shelves the same way
// (lab/gallery-model.ts).
import type { Composer } from "../composer/compose.ts";
import { interior } from "../composer/interior.ts";
import { interiorVariants } from "../composer/interior-variants.ts";
import { outdoor } from "../composer/outdoor.ts";
import { outdoorVariants } from "../composer/outdoor-variants.ts";
import { overhead } from "../composer/overhead.ts";
import { overheadVariants } from "../composer/overhead-variants.ts";
import type { ComposerId, OverheadVariant, Variant } from "../composer/types.ts";
import { defaults } from "../state.ts";
import type { Preset } from "../presets.ts";
import { sceneDefs, sceneIds, type SceneId } from "../scenes/index.ts";
import { families, sceneFamily } from "./families.ts";

/** A composer's shelf. */
export interface ComposerShelf {
  readonly composer: ComposerId;
  /** Its baseline's own scene. */
  readonly baseline: SceneId;
  /** Its curated variants (over its baseline), in their registry's order. */
  readonly variants: readonly SceneId[];
}

export interface SceneTree {
  readonly composers: readonly ComposerShelf[];
  /** The scenes neither a baseline nor a variant, in their families' order. */
  readonly standalone: readonly SceneId[];
}

/** The composers in the tree's order: the interior first, the first with a baseline. */
const COMPOSERS: readonly Composer[] = [interior, outdoor, overhead];

/** Each composer's baseline as a scene of its own (D13). */
export const baselineScene: Readonly<Record<ComposerId, SceneId>> = {
  interior: "room",
  outdoor: "land",
  overhead: "patch",
};

/** Each composer's variants by scene id, its baseline's own scene among them. */
const VARIANTS: Readonly<
  Record<ComposerId, Readonly<Record<string, Variant>> | Readonly<Record<string, OverheadVariant>>>
> = {
  interior: interiorVariants,
  outdoor: outdoorVariants,
  overhead: overheadVariants,
};

/** The composer whose layers hold every layer `scene` offers, or undefined for a standalone one. */
export function sceneComposer(scene: SceneId): ComposerId | undefined {
  const offered = sceneDefs[scene].layers?.offered;
  if (offered === undefined) return undefined;
  return COMPOSERS.find((composer) =>
    offered.every((layer) => composer.layers.some((own) => own.id === layer.id)),
  )?.id;
}

/**
 * The baseline's own scene `scene` is a curated variant over, or undefined for a baseline and a
 * standalone scene.
 */
export function variantBaseline(scene: SceneId): SceneId | undefined {
  const composer = sceneComposer(scene);
  if (composer === undefined) return undefined;
  const baseline = baselineScene[composer];
  return scene !== baseline && VARIANTS[composer][scene] !== undefined ? baseline : undefined;
}

/** The baseline's own scene `scene` is, or is a curated variant over; undefined if standalone. */
export function sceneBaseline(scene: SceneId): SceneId | undefined {
  const composer = sceneComposer(scene);
  if (composer !== undefined && baselineScene[composer] === scene) return scene;
  return variantBaseline(scene);
}

/** Whether two scenes are the same baseline's: the baseline and its variants, any two of them. */
export function shareBaseline(a: SceneId, b: SceneId): boolean {
  const baseline = sceneBaseline(a);
  return baseline !== undefined && baseline === sceneBaseline(b);
}

/** The scene a preset's query names, or undefined for one this build does not have. */
export function presetScene(preset: Preset): SceneId | undefined {
  const named = new URLSearchParams(preset.query).get("scene") ?? defaults.scene;
  return sceneIds.find((id) => id === named);
}

/** The tree (see the header). */
export function sceneTree(): SceneTree {
  const composers = COMPOSERS.map(({ id }): ComposerShelf => {
    const baseline = baselineScene[id];
    return {
      composer: id,
      baseline,
      variants: Object.keys(VARIANTS[id])
        .flatMap((key) => sceneIds.filter((scene) => scene === key))
        .filter((scene) => variantBaseline(scene) === baseline),
    };
  });
  const baselines: readonly SceneId[] = Object.values(baselineScene);
  return {
    composers,
    standalone: families
      .flatMap((family) => sceneIds.filter((scene) => sceneFamily[scene] === family.id))
      .filter((scene) => !baselines.includes(scene) && variantBaseline(scene) === undefined),
  };
}
