// The Scenes view's shelves (ADR 0062 D9, again): a shelf per baseline, in the Presets view's tree's
// order (lab/tree-model.ts), its baseline's own scene (D13) first, then its curated variants in
// their registry's order (a room's folders, then the promoted ones), then a "custom" card for each
// setup saved in this browser over any of them, in the order saved; then the standalone scenes, a
// program of their own each (D24), on one shelf in their families' order, with the setups saved
// over them. The standalone scenes stay one shelf: by family they would make three shelves of one
// or two cards (sky, water, land) beside the matter shelf's twelve. `sceneOrder` is the shelves'
// scenes in order; `sceneCycle` is that order less the lab-only scenes (`labOnly`: the baselines,
// D13), which `[` and `]` and the tour step through.
import type { ComposerId } from "../composer/types.ts";
import type { Preset } from "../presets.ts";
import { sceneDefs, type SceneId } from "../scenes/index.ts";
import { baselineScene, presetScene, presetTree } from "./tree-model.ts";

/** A card on a shelf: a scene's, or a setup saved in this browser over one (`custom`). */
export type GalleryCard =
  | { readonly kind: "scene"; readonly scene: SceneId; readonly baseline: boolean }
  | {
      readonly kind: "custom";
      readonly scene: SceneId;
      readonly preset: Preset;
      /** Its index among the setups saved in this browser. */
      readonly local: number;
    };

export interface GalleryShelf {
  /** Its baseline's composer, or undefined for the standalone scenes' shelf. */
  readonly composer: ComposerId | undefined;
  /** Its baseline's own scene, or undefined for the standalone scenes' shelf. */
  readonly baseline: SceneId | undefined;
  /** Its scenes' cards, then its custom ones. */
  readonly cards: readonly GalleryCard[];
}

/** Each shelf's scenes: a baseline's own scene and its variants, then the standalone scenes. */
const SHELVES: readonly {
  composer: ComposerId | undefined;
  baseline: SceneId | undefined;
  scenes: readonly SceneId[];
}[] = (() => {
  const tree = presetTree([], []);
  return [
    ...tree.composers.map(({ composer, baseline, variants }) => ({
      composer,
      baseline: baseline.scene,
      scenes: [baseline.scene, ...variants.map((node) => node.scene)],
    })),
    { composer: undefined, baseline: undefined, scenes: tree.standalone.map((node) => node.scene) },
  ];
})();

/** The shelves, with a custom card for each of the `local` setups (saved in this browser). */
export function galleryShelves(local: readonly Preset[]): readonly GalleryShelf[] {
  return SHELVES.map(({ composer, baseline, scenes }) => ({
    composer,
    baseline,
    cards: [
      ...scenes.map((scene): GalleryCard => ({
        kind: "scene",
        scene,
        baseline: scene === baseline,
      })),
      ...local.flatMap((preset, index): GalleryCard[] => {
        const scene = presetScene(preset);
        return scene !== undefined && scenes.includes(scene)
          ? [{ kind: "custom", scene, preset, local: index }]
          : [];
      }),
    ],
  }));
}

/**
 * Whether `card` answers the search `query` (an empty one answers every card): by its scene's id or
 * title, and a custom card by its name too.
 */
export function cardMatches(card: GalleryCard, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const scene = `${card.scene} ${sceneDefs[card.scene].title}`;
  const words = card.kind === "custom" ? `${scene} ${card.preset.name}` : scene;
  return words.toLowerCase().includes(text);
}

/** Every scene in the Scenes view's order: shelf by shelf. */
export const sceneOrder: readonly SceneId[] = SHELVES.flatMap((shelf) => shelf.scenes);

/**
 * The scenes shown in the lab alone (ADR 0062 D13): the composers' baselines, loaded to compare
 * their variants against, outside the tour and `[` / `]`.
 */
export const labOnly: Readonly<Partial<Record<SceneId, true>>> = Object.fromEntries(
  Object.values(baselineScene).map((scene) => [scene, true]),
);

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
