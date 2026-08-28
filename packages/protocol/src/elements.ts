import { z } from "zod";

/**
 * One native manifold canvas record. Protocol v5 deliberately supports terminals only:
 * the React Flow prototype has no compatibility reader for legacy drawing elements.
 */
export const SceneElementSchema = z.strictObject({
  id: z.string().min(1).max(128),
  type: z.literal("terminal"),
  sessionId: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  zIndex: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().int().nonnegative(),
  isDeleted: z.boolean(),
});
export type SceneElement = z.infer<typeof SceneElementSchema>;

export const MAX_ELEMENTS_PER_UPDATE = 128;
export const MAX_SESSION_FRAME_BYTES = 1_048_576; // 1 MiB per session-channel frame

/** Canonical paint/persist order: explicit z-index, then id as deterministic tiebreak. */
export function compareElements(a: SceneElement, b: SceneElement): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
