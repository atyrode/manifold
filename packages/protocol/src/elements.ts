import { z } from "zod";

/**
 * Structural validation only: manifold requires the fields its reconciliation and
 * rendering order depend on, and passes every other Excalidraw element property through
 * opaquely. This keeps the server independent of Excalidraw's element zoo while still
 * rejecting garbage.
 */
export const SceneElementSchema = z.looseObject({
  id: z.string().min(1).max(128),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
  /** Excalidraw fractional index; stored and relayed opaquely, ordering is client-side. */
  index: z.string().max(64).nullish(),
});
export type SceneElement = z.infer<typeof SceneElementSchema>;

/** Terminal elements carry their session binding in customData (set by the opening client). */
export const TerminalCustomDataSchema = z.looseObject({
  kind: z.literal("terminal"),
  sessionId: z.string().min(1),
});
export type TerminalCustomData = z.infer<typeof TerminalCustomDataSchema>;

export const MAX_ELEMENTS_PER_UPDATE = 128;
export const MAX_SESSION_FRAME_BYTES = 1_048_576; // 1 MiB per session-channel frame

/**
 * Canonical render/persist order: fractional index first (missing indices sort first),
 * element id as the deterministic tiebreak. Both sides sort with this comparator
 * (`[...elements].sort(compareElements)`); the server never rewrites indices.
 */
export function compareElements(a: SceneElement, b: SceneElement): number {
  const ai = a.index ?? "";
  const bi = b.index ?? "";
  if (ai !== bi) return ai < bi ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
