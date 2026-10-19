// The interior's variants (ADR 0062 "Baselines and variants", D14, D15): the rooms in their folders,
// each with code of its own, and the promoted ones, saved presets made curated variants, which have
// no code of their own and are written here by `bun concepts/landing/scripts/promote.ts <query>`
// (the lab's Presets view shows the same entry under Promote). A promoted variant is a scene like
// any other (its card, its thumbnail, its links: src/scenes/promoted/), keyed here by its id, which
// is never reused for another picture. It holds its own differences from the baseline, the source
// variant's folded with the preset's query, and `from`, the commit and query it was promoted from;
// of its source's identity it borrows only what an entry cannot spell (`identityOf`).
import { barVariant } from "../scenes/bar/index.ts";
import { bonsaiVariant } from "../scenes/bonsai/index.ts";
import { frostVariant } from "../scenes/frost/index.ts";
import { incenseVariant } from "../scenes/incense/index.ts";
import { lavaVariant } from "../scenes/lava/index.ts";
import { mobileVariant } from "../scenes/mobile/index.ts";
import { roomVariant } from "../scenes/room/index.ts";
import { sillVariant } from "../scenes/sill/index.ts";
import { trainVariant } from "../scenes/train/index.ts";
import type { Variant } from "./types.ts";

/** The rooms in their folders, by scene id: the baseline's own scene (`room`) first. */
export const folderVariants = {
  room: roomVariant,
  sill: sillVariant,
  lava: lavaVariant,
  bonsai: bonsaiVariant,
  incense: incenseVariant,
  frost: frostVariant,
  bar: barVariant,
  train: trainVariant,
  mobile: mobileVariant,
} as const satisfies Readonly<Record<string, Variant>>;

/** A room in its folder. */
export type FolderVariantId = keyof typeof folderVariants;

/**
 * What a promoted variant keeps of its source's identity beyond its look and accent: its page theme,
 * its passage, its planets and its lab headings, code and shared constants an entry cannot spell.
 */
export function identityOf(
  variant: Variant,
): Pick<Variant, "theme" | "passage" | "planets" | "groups"> {
  const { theme, passage, planets, groups } = variant;
  return {
    ...(theme === undefined ? {} : { theme }),
    ...(passage === undefined ? {} : { passage }),
    ...(planets === undefined ? {} : { planets }),
    ...(groups === undefined ? {} : { groups }),
  };
}

/** The promoted variants, by id (D15): written by scripts/promote.ts, newest last. */
export const promotedInteriorVariants = {} satisfies Readonly<Record<string, Variant>>;

/** A promoted variant's id. */
export type PromotedId = keyof typeof promotedInteriorVariants;

/** The promoted variants, newest last. */
export const promotedVariants: readonly Variant[] =
  Object.values<Variant>(promotedInteriorVariants);

/** Every interior variant by scene id: the rooms in their folders, then the promoted ones. */
export const interiorVariants: Readonly<Record<string, Variant>> = {
  ...folderVariants,
  ...promotedInteriorVariants,
};

const folderIds = Object.keys(folderVariants) as FolderVariantId[];

/**
 * The room in its folder a variant stems from: itself, or for a promoted one the variant its `from`
 * query names, followed back through any promoted one between. Throws for one that names no
 * interior variant.
 */
export function sourceRoom(variant: Variant): FolderVariantId {
  let at = variant;
  // A promoted variant names one promoted before it, so the walk takes at most one step a variant.
  for (let step = 0; step <= Object.keys(interiorVariants).length; step += 1) {
    const { from, id } = at;
    if (from === undefined) {
      const folder = folderIds.find((room) => room === id);
      if (folder !== undefined) return folder;
      break;
    }
    const next = interiorVariants[new URLSearchParams(from.query).get("scene") ?? ""];
    if (next === undefined) break;
    at = next;
  }
  throw new Error(`variant ${variant.id} stems from no room in its folder`);
}
