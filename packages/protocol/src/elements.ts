import { z } from "zod";

const baseFields = {
  id: z.string().min(1).max(128),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  zIndex: z.number().int(),
};

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_STROKE_POINT_VALUES = 8_192;
export const MAX_GESTURE_POINT_VALUES = 4_096;
export const MAX_DOC_UPDATE_BYTES = 524_288;
export const MAX_SESSION_FRAME_BYTES = 1_048_576;

/**
 * A canvas holds FURNITURE and REFERENCES, never a composition-homed item directly.
 * A terminal lives in a composition of its own — solo from birth — and a canvas shows it
 * through a portal onto that composition. So there is no `terminal` element kind: the
 * element that used to carry a session id now carries the id of the container the session
 * lives in, which is the same reference a canvas already used for every other container.
 */
export const SceneElementSchema = z.discriminatedUnion("type", [
  /**
   * A container rendered inside a canvas: live at depth <= 2, a navigable card deeper.
   * Reference cycles are legal because portals navigate, never recurse. A portal onto a
   * SOLO composition IS the item wearing the container's clothes, which is why the
   * renderer gives it the item's own chrome instead of a widget frame.
   */
  z.strictObject({
    ...baseFields,
    type: z.literal("portal"),
    containerId: z.string().min(1),
  }),
  z.strictObject({
    ...baseFields,
    type: z.literal("text"),
    text: z.string().max(MAX_TEXT_LENGTH),
    fontSize: z.number().finite().positive(),
    color: z.string().regex(HEX_COLOR),
  }),
  z.strictObject({
    ...baseFields,
    type: z.literal("draw"),
    points: z.array(z.number().finite()).min(4).max(MAX_STROKE_POINT_VALUES),
    strokeWidth: z.number().finite().positive(),
    color: z.string().regex(HEX_COLOR),
  }),
]);
export type SceneElement = z.infer<typeof SceneElementSchema>;

/** Canonical paint/persist order: explicit z-index, then id as deterministic tiebreak. */
export function compareElements(a: SceneElement, b: SceneElement): number {
  if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
