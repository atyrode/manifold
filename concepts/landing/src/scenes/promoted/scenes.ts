// The promoted variants as scenes (ADR 0062 D15): each entry of composer/interior-variants.ts
// composed over the interior's baseline, as a room in its folder is, its code assembled from its
// layers' (code.ts) the first time it is needed. No folder of their own: a promoted variant is
// data; its card, thumbnail (thumbs/<id>.webp) and family are a scene's like any other (its family
// its source room's: src/lab/families.ts).
import { composeScene, variantPreset, type ComposedScene } from "../../composer/compose.ts";
import { interior } from "../../composer/interior.ts";
import { promotedVariants, type PromotedId } from "../../composer/interior-variants.ts";
import type { ScenePreset } from "../../composer/types.ts";
import type { SceneDef } from "../types.ts";

/** Each promoted variant composed (composer/compose.ts), by id. */
export const promotedComposed: Readonly<Record<string, ComposedScene<ScenePreset>>> =
  Object.fromEntries(
    promotedVariants.map((variant) => [
      variant.id,
      composeScene(interior, variantPreset(interior.baseline, variant)),
    ]),
  );

/** Each promoted variant's scene, by id. */
export const promotedScenes = Object.fromEntries(
  Object.entries(promotedComposed).map(([id, composed]): [string, SceneDef] => [
    id,
    { ...composed.def, code: () => import("./code.ts").then((code) => code.promotedCode(id)) },
  ]),
) as Readonly<Record<PromotedId, SceneDef>>;
