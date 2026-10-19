// The Scenes view's Library shelves (ADR 0062 D9, again): a shelf per baseline, in the tree's order
// (lab/tree-model.ts), its baseline's own scene (D13) first, then its curated variants in their
// registry's order (a room's folders, then the promoted ones); then the standalone scenes, a program
// of their own each (D24), on one shelf in their families' order. The standalone scenes stay one
// shelf: by family they would make three shelves of one or two cards (sky, water, land) beside the
// matter shelf's twelve. Ahead of them all stands the Canvas shelf of the engine's shipped documents.
// What is saved in this browser is not shelved here: the view's Saved list holds it (saved-model.ts).
// `sceneOrder` is the shelves' scenes in order; `sceneCycle` is that order less the lab-only scenes
// (`labOnly`: the baselines, D13), which `[` and `]` and the tour step through.
import type { ComposerId } from "../composer/types.ts";
import { presets, type Preset } from "../presets.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import type { SavedDoc } from "./canvas-docs.ts";
import { baselineScene, presetScene, sceneTree } from "./tree-model.ts";

/** A scene's card on a shelf, and whether it is its baseline's own. */
export interface GalleryCard {
  readonly scene: SceneId;
  readonly baseline: boolean;
}

export interface GalleryShelf {
  /** Its baseline's composer, or undefined for the standalone scenes' shelf. */
  readonly composer: ComposerId | undefined;
  /** Its baseline's own scene, or undefined for the standalone scenes' shelf. */
  readonly baseline: SceneId | undefined;
  readonly cards: readonly GalleryCard[];
}

/** Each shelf's scenes: a baseline's own scene and its variants, then the standalone scenes. */
const SHELVES: readonly {
  composer: ComposerId | undefined;
  baseline: SceneId | undefined;
  scenes: readonly SceneId[];
}[] = (() => {
  const tree = sceneTree();
  return [
    ...tree.composers.map(({ composer, baseline, variants }) => ({
      composer,
      baseline,
      scenes: [baseline, ...variants],
    })),
    { composer: undefined, baseline: undefined, scenes: tree.standalone },
  ];
})();

/** The shelves. */
export const galleryShelves: readonly GalleryShelf[] = SHELVES.map(
  ({ composer, baseline, scenes }) => ({
    composer,
    baseline,
    cards: scenes.map((scene) => ({ scene, baseline: scene === baseline })),
  }),
);

/** Each scene's committed presets (src/presets.ts), in their order. */
export function scenePresets(scene: SceneId, committed: readonly Preset[] = presets): Preset[] {
  return committed.filter((preset) => presetScene(preset) === scene);
}

/**
 * Whether `card` answers the search `query` (an empty one answers every card): by its scene's id or
 * title, or the name of one of its committed presets.
 */
export function cardMatches(card: GalleryCard, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const names = scenePresets(card.scene).map((preset) => preset.name);
  return [card.scene, sceneDefs[card.scene].title, ...names].join(" ").toLowerCase().includes(text);
}

/**
 * Whether a saved document's card answers the search `query` (an empty one answers every card): by
 * its name, its title, or the kinds of the objects it holds.
 */
export function docMatches(saved: SavedDoc, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const kinds = saved.doc.objects.map((object) => object.kind).join(" ");
  return `canvas ${saved.name} ${saved.doc.title} ${kinds}`.toLowerCase().includes(text);
}

/** Every scene in the Scenes view's order: shelf by shelf. */
export const sceneOrder: readonly SceneId[] = SHELVES.flatMap((shelf) => shelf.scenes);

/**
 * The scenes shown in the lab alone (ADR 0062 D13): the composers' baselines, loaded to compare
 * their variants against, and the engine's canvas (src/engine), outside the tour and `[` / `]`.
 */
export const labOnly: Readonly<Partial<Record<SceneId, true>>> = {
  ...Object.fromEntries(Object.values(baselineScene).map((scene) => [scene, true])),
  canvas: true,
};

/** The Scenes view's order less the lab-only scenes: what `[`, `]` and the tour step through. */
export const sceneCycle: readonly SceneId[] = sceneOrder.filter((id) => labOnly[id] !== true);

/**
 * The scene `by` places from `scene` in the cycle (`sceneCycle`), round from the last to the first;
 * from a lab-only scene, from where it stands in the Scenes view's order.
 */
export function sceneStep(scene: SceneId, by: number): SceneId {
  const count = sceneCycle.length;
  const at = sceneCycle.indexOf(scene);
  // A lab-only scene stands just before the first of the cycle's scenes after it in the Scenes
  // view's order: one step on is that scene, one step back the one before.
  const next =
    at >= 0
      ? at
      : sceneCycle.filter((id) => sceneOrder.indexOf(id) < sceneOrder.indexOf(scene)).length;
  const to = next + by - (at < 0 && by > 0 ? 1 : 0);
  return sceneCycle[((to % count) + count) % count] ?? scene;
}
