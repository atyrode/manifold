// The Presets view's tree (ADR 0062 D9 as amended, "Baselines and variants"): a shelf per composer,
// each its baseline's own scene (D13) and then its curated variants, the scenes over it, each with
// its committed presets and then the ones saved in this browser; a composer without a baseline yet
// (outdoor until step 5, overhead until step 6) shelves its scenes at the top. The scenes no
// composer draws (a program of their own, D24) stand on a shelf apart. A scene's composer is the
// one whose layers hold every layer it offers.
import type { Composer } from "../composer/compose.ts";
import { interior } from "../composer/interior.ts";
import { outdoor } from "../composer/outdoor.ts";
import { overhead } from "../composer/overhead.ts";
import type { ComposerId } from "../composer/types.ts";
import { defaults } from "../state.ts";
import type { Preset } from "../presets.ts";
import { sceneDefs, sceneIds, type SceneId } from "../scenes/index.ts";
import { sceneOrder } from "./families.ts";

/** A preset in the tree, and where it is kept: committed (undefined) or its local index. */
export interface TreePreset {
  readonly preset: Preset;
  readonly local: number | undefined;
}

/** A scene in the tree with its presets: the committed ones, then the ones saved here. */
export interface TreeScene {
  readonly scene: SceneId;
  readonly presets: readonly TreePreset[];
}

/** A composer's shelf. */
export interface ComposerShelf {
  readonly composer: ComposerId;
  /** Its baseline's own scene, or undefined while it has no baseline. */
  readonly baseline: TreeScene | undefined;
  /** Its curated variants (over a baseline), or its scenes (without one), in the Scenes view's order. */
  readonly variants: readonly TreeScene[];
}

export interface PresetTree {
  readonly composers: readonly ComposerShelf[];
  /** The scenes of no composer, in the Scenes view's order. */
  readonly standalone: readonly TreeScene[];
}

/** The composers in the tree's order: the interior first, the first with a baseline. */
const COMPOSERS: readonly Composer[] = [interior, outdoor, overhead];

/** Each composer's baseline as a scene of its own (D13): the outdoor's and the overhead's to come. */
export const baselineScene: Readonly<Partial<Record<ComposerId, SceneId>>> = { interior: "room" };

/** The composer whose layers hold every layer `scene` offers, or undefined for a standalone one. */
export function sceneComposer(scene: SceneId): ComposerId | undefined {
  const offered = sceneDefs[scene].layers?.offered;
  if (offered === undefined) return undefined;
  return COMPOSERS.find((composer) =>
    offered.every((layer) => composer.layers.some((own) => own.id === layer.id)),
  )?.id;
}

/** The scene a preset's query names, or undefined for one this build does not have. */
export function presetScene(preset: Preset): SceneId | undefined {
  const named = new URLSearchParams(preset.query).get("scene") ?? defaults.scene;
  return sceneIds.find((id) => id === named);
}

/** The tree of `committed` and `local` presets (see the header). */
export function presetTree(committed: readonly Preset[], local: readonly Preset[]): PresetTree {
  const all: TreePreset[] = [
    ...committed.map((preset) => ({ preset, local: undefined })),
    ...local.map((preset, index) => ({ preset, local: index })),
  ];
  const node = (scene: SceneId): TreeScene => ({
    scene,
    presets: all.filter((entry) => presetScene(entry.preset) === scene),
  });
  const composers = COMPOSERS.map(({ id }): ComposerShelf => {
    const baseline = baselineScene[id];
    return {
      composer: id,
      baseline: baseline === undefined ? undefined : node(baseline),
      variants: sceneOrder
        .filter((scene) => scene !== baseline && sceneComposer(scene) === id)
        .map(node),
    };
  });
  return {
    composers,
    standalone: sceneOrder.filter((scene) => sceneComposer(scene) === undefined).map(node),
  };
}
