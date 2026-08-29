import { z } from "zod";
import { PrincipalSchema } from "./principal.ts";

/**
 * Presence is ephemeral by contract: it is never persisted and never enters the event log.
 * Identity fields are stamped server-side from the socket's principal — clients cannot
 * spoof who they are, only what they are doing.
 */
export const PresenceStatusSchema = z.enum([
  "active",
  "idle",
  "working",
  "waiting",
  "needs_attention",
  "done",
]);
export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;

export const CursorSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  tool: z.enum(["pointer", "laser"]).optional(),
});
export type Cursor = z.infer<typeof CursorSchema>;

/** Partial update; omitted fields keep their previous value, `null` clears. */
export const PresencePayloadSchema = z.strictObject({
  cursor: CursorSchema.nullish(),
  selection: z.array(z.string()).max(256).optional(),
  viewport: z
    .strictObject({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive() })
    .optional(),
  focus: z.strictObject({ elementId: z.string().min(1) }).nullish(),
  status: PresenceStatusSchema.optional(),
});
export type PresencePayload = z.infer<typeof PresencePayloadSchema>;

/** Server-stamped presence state for one principal (fanned out to the room). */
export const PresenceStateSchema = z.strictObject({
  principal: PrincipalSchema,
  connections: z.number().int().positive(),
  /**
   * Live session-socket connection ids for this principal, one per open tab. Cursor
   * and gesture traffic is stamped per-connection, so viewers need the exact live set
   * to retire a closed tab's cursor while sibling tabs of the same principal remain.
   */
  connIds: z.array(z.string().min(1)).min(1).max(64),
  payload: PresencePayloadSchema,
});
export type PresenceState = z.infer<typeof PresenceStateSchema>;

/** Client-side cursor send throttle; server may additionally drop under backpressure. */
export const CURSOR_MIN_INTERVAL_MS = 16;
/** Gesture updates use the same high-frequency cadence as cursor motion. */
export const GESTURE_MIN_INTERVAL_MS = 16;
/** Stale gesture overrides must disappear even when an end frame is dropped. */
export const GESTURE_TTL_MS = 3_000;
/** Viewport updates are presence metadata, not motion — keep them at or under 1 Hz. */
export const VIEWPORT_MIN_INTERVAL_MS = 1000;
