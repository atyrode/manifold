// The scene families: every scene in exactly one, so the Scenes view reads as a handful of shelves
// instead of fifty cards (and the Presets view shelves the baseline the same way). `satisfies` makes
// a new scene without a family a type error. `sceneOrder` is the Scenes view's order, shelf by
// shelf; `sceneCycle` is that order less the lab-only scenes (`labOnly`: the composers' baselines,
// ADR 0062 D13), which `[` and `]` and the tour follow.
import { sceneIds, type SceneId } from "../scenes/index.ts";
import type { IconName } from "./icons.ts";

export const families = [
  { id: "sky", title: "Sky & space", icon: "stars" },
  { id: "water", title: "Water", icon: "waves" },
  { id: "land", title: "Land", icon: "mountain" },
  { id: "matter", title: "Matter & patterns", icon: "pattern" },
  { id: "life", title: "Rooms & life", icon: "house" },
] as const satisfies readonly { id: string; title: string; icon: IconName }[];

export type FamilyId = (typeof families)[number]["id"];

export const sceneFamily = {
  orbit: "sky",
  clouds: "sky",
  flock: "sky",
  skyward: "sky",
  swell: "water",
  pond: "water",
  falls: "water",
  shore: "water",
  lanterns: "water",
  kelp: "water",
  lake: "water",
  island: "water",
  tidepool: "water",
  country: "land",
  dunes: "land",
  meadow: "land",
  shanshui: "land",
  bamboo: "land",
  garden: "land",
  delta: "land",
  forest: "land",
  campfire: "land",
  autumn: "land",
  marble: "matter",
  frost: "matter",
  prism: "matter",
  ferro: "matter",
  chladni: "matter",
  hyperbolic: "matter",
  pearl: "matter",
  fractal: "matter",
  petri: "matter",
  physarum: "matter",
  film: "matter",
  sandtable: "matter",
  ripple: "matter",
  harmonograph: "matter",
  pendula: "matter",
  sill: "life",
  fireflies: "life",
  dew: "life",
  incense: "life",
  lava: "life",
  bonsai: "life",
  street: "life",
  train: "life",
  bar: "life",
  bees: "life",
  mobile: "life",
  room: "life",
} as const satisfies Record<SceneId, FamilyId>;

/** Every scene in the Scenes view's order: family by family, each in the catalogue's order. */
export const sceneOrder: readonly SceneId[] = families.flatMap((family) =>
  sceneIds.filter((id) => sceneFamily[id] === family.id),
);

/**
 * The scenes shown in the lab alone (ADR 0062 D13): the composers' baselines, loaded to compare
 * their variants against, outside the tour and `[` / `]`.
 */
export const labOnly: Readonly<Partial<Record<SceneId, true>>> = { room: true };

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
