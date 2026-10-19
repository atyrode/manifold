// The Scenes view's Library shelves (ADR 0062 D9, again): a shelf per baseline, in the tree's order
// (lab/tree-model.ts), its baseline first, then its curated variants in their registry's order (a
// room's folders, then the promoted ones); then the standalone scenes, a program of their own each
// (D24), on one shelf in their families' order. A baseline is the engine's bare canvas of its
// subject (src/engine/docs.ts), opened in the canvas: the room, the land, the view from above. The
// composer's own render of it (D13) stays a scene of the lab alone, what its variants are composed
// over and compared against, not on a shelf; nor is the canvas scene, the engine's host. The
// standalone scenes stay one shelf: by family they would make three shelves of one or two cards
// (sky, water, land) beside the matter shelf's twelve. What is saved in this browser is not shelved
// here: the view's Saved list holds it (saved-model.ts). `sceneOrder` is the shelves' scenes in
// order, each baseline's render where its canvas stands; `sceneCycle` is that order less the
// lab-only scenes (`labOnly`), which `[` and `]` and the tour step through.
import type { ComposerId } from "../composer/types.ts";
import { landDoc, roomDoc, topDoc } from "../engine/docs.ts";
import type { EngineDoc } from "../engine/types.ts";
import { presets, type Preset } from "../presets.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { baselineScene, presetScene, sceneTree } from "./tree-model.ts";

/** A card on a shelf: a baseline, its subject's bare canvas; or a scene. */
export type GalleryCard =
  | {
      readonly kind: "canvas";
      readonly doc: EngineDoc;
      /** The composer's render of the baseline, its variants' A in a compare. */
      readonly render: SceneId;
    }
  | { readonly kind: "scene"; readonly scene: SceneId };

export interface GalleryShelf {
  /** Its baseline's composer, or undefined for the standalone scenes' shelf. */
  readonly composer: ComposerId | undefined;
  readonly title: string;
  readonly cards: readonly GalleryCard[];
}

/** Each composer's baseline: its subject's bare canvas. */
export const baselineCanvas: Readonly<Record<ComposerId, EngineDoc>> = {
  interior: roomDoc,
  outdoor: landDoc,
  overhead: topDoc,
};

/**
 * The scenes shown in the lab alone (ADR 0062 D13): the composers' renders of their baselines,
 * loaded to compare their variants against, and the engine's canvas (src/engine), off the shelves
 * and outside the tour and `[` / `]`.
 */
export const labOnly: Readonly<Partial<Record<SceneId, true>>> = {
  ...Object.fromEntries(Object.values(baselineScene).map((scene) => [scene, true])),
  canvas: true,
};

/** Each shelf's scenes: a baseline's render and its variants, then the standalone scenes. */
const SHELVES: readonly {
  composer: ComposerId | undefined;
  scenes: readonly SceneId[];
}[] = (() => {
  const tree = sceneTree();
  return [
    ...tree.composers.map(({ composer, baseline, variants }) => ({
      composer,
      scenes: [baseline, ...variants],
    })),
    { composer: undefined, scenes: tree.standalone },
  ];
})();

/** The shelves. */
export const galleryShelves: readonly GalleryShelf[] = SHELVES.map(({ composer, scenes }) => {
  const shown = scenes
    .filter((scene) => labOnly[scene] !== true)
    .map((scene): GalleryCard => ({ kind: "scene", scene }));
  if (composer === undefined) return { composer, title: "Standalone", cards: shown };
  const doc = baselineCanvas[composer];
  const render = baselineScene[composer];
  return { composer, title: doc.title, cards: [{ kind: "canvas", doc, render }, ...shown] };
});

/** Each scene's committed presets (src/presets.ts), in their order. */
export function scenePresets(scene: SceneId, committed: readonly Preset[] = presets): Preset[] {
  return committed.filter((preset) => presetScene(preset) === scene);
}

/**
 * Whether `card` answers the search `query` (an empty one answers every card): a scene by its id or
 * title, or the name of one of its committed presets; a baseline by its title, "canvas", "baseline"
 * or its render's id or title.
 */
export function cardMatches(card: GalleryCard, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const words =
    card.kind === "canvas"
      ? [card.doc.title, "canvas baseline", card.render, sceneDefs[card.render].title]
      : [card.scene, sceneDefs[card.scene].title, ...scenePresets(card.scene).map((p) => p.name)];
  return words.join(" ").toLowerCase().includes(text);
}

/** Every scene in the Scenes view's order: shelf by shelf. */
export const sceneOrder: readonly SceneId[] = SHELVES.flatMap((shelf) => shelf.scenes);

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
