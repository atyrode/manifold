// The scene families: every scene in exactly one theme. The Scenes view shelves by baseline
// (lab/gallery-model.ts); the families order its standalone shelf, pick a missing thumbnail's
// stand-in (thumbs.ts) and name each scene's family in the README's scenes table. `satisfies` makes
// a new scene without a family a type error; a promoted variant (ADR 0062 D15) is in its source
// room's.
import {
  promotedVariants,
  sourceRoom,
  type FolderVariantId,
  type PromotedId,
} from "../composer/interior-variants.ts";
import type { SceneId } from "../scenes/index.ts";

export const families = [
  { id: "sky", title: "Sky & space" },
  { id: "water", title: "Water" },
  { id: "land", title: "Land" },
  { id: "matter", title: "Matter & patterns" },
  { id: "life", title: "Rooms & life" },
] as const satisfies readonly { id: string; title: string }[];

export type FamilyId = (typeof families)[number]["id"];

/** The families of the rooms in their folders. */
const roomFamily = {
  sill: "life",
  incense: "life",
  lava: "life",
  bonsai: "life",
  train: "life",
  bar: "life",
  mobile: "life",
  room: "life",
  frost: "matter",
} as const satisfies Record<FolderVariantId, FamilyId>;

/** Each promoted variant's family: its source room's. */
const promotedFamily = Object.fromEntries(
  promotedVariants.map((variant) => [variant.id, roomFamily[sourceRoom(variant)]]),
) as Readonly<Record<PromotedId, FamilyId>>;

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
  patch: "water",
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
  land: "land",
  marble: "matter",
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
  fireflies: "life",
  dew: "life",
  street: "life",
  bees: "life",
  ...roomFamily,
  ...promotedFamily,
} as const satisfies Record<SceneId, FamilyId>;
