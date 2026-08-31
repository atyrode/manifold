import { z } from "zod";
import { TileEdgeSchema } from "./layout.ts";
import { PlacementItemSchema, PlacementRefSchema } from "./placement.ts";
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
  /**
   * VANTAGE, published: where this principal is standing and what it holds — which tool,
   * what it is editing, which container has its focus, whether its sidebar is collapsed.
   * This is the multiplayer axiom applied to the last private corner of the client — a
   * chrome state only one browser tab could see is a capability no other principal can
   * observe or drive, so it rides presence like everything else that dies with the
   * connection.
   */
  vantage: z
    .strictObject({
      tool: z.string().min(1).max(64).nullish(),
      editingElementId: z.string().min(1).nullish(),
      focusedContainerId: z.string().min(1).nullish(),
      sidebarCollapsed: z.boolean().optional(),
    })
    .optional(),
  /**
   * "Look at this" — a node another principal asked this one to center on, and the
   * principal who asked. SERVER-WRITTEN ONLY, by `core.presence.focus`: the server strips
   * it from every client payload, so a peer cannot forge a request to hijack a viewport
   * and every spotlight carries the authority check the action performed.
   */
  spotlight: z.strictObject({ uri: z.string().min(1).max(512), from: z.string().min(1) }).nullish(),
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

/**
 * What a pointer is HOLDING right now. Motion is the dynamic half of the placement
 * algebra: grabbing anything by its chrome is one `carry`, whatever the item and
 * whatever the renderer, so the ref that will be placed on release is the ref
 * that travels while the gesture is live. Collaborators paint it from this alone.
 *
 * The label is the item's display name at grab time. It rides along because the viewer
 * frequently cannot derive it: a terminal carried in from the index, or a tile carried
 * off a portal, belongs to a room the viewer has not joined.
 */
/**
 * Where a live carry is currently AIMING inside a composition: the resolved drop
 * target a collaborator can re-derive the full split preview from, using the same
 * geometry kernel the producer used. Sent only while an aim is armed; a frame without
 * one means the carry is over no target (viewers drop their preview).
 */
export const CarryAimSchema = z.strictObject({
  /** The composition the aim addresses. */
  containerId: z.string().min(1),
  tileId: z.string().min(1),
  edge: TileEdgeSchema,
  action: z.enum(["place", "swap", "replace"]),
  /** Same-axis seam-band drop: wedge between the target and its neighbor (thirds). */
  between: z.boolean().optional(),
});
export type CarryAim = z.infer<typeof CarryAimSchema>;

export const CarrySchema = z.strictObject({
  ref: PlacementRefSchema,
  /**
   * WHAT the ref names, resolved by the producer at grab time. Required: a ref is
   * an address, and turning an address into an item takes a census of containers,
   * terminals and solo occupancy that only the grabber is guaranteed to hold. A viewer
   * that had to re-resolve it painted a refusal over a legal drag whenever its index poll
   * lagged the drag by a tick — so the answer travels with the question.
   */
  item: PlacementItemSchema,
  label: z.string().min(1).max(120).optional(),
  /** Set while the carry is armed over a tile target; absent means no live aim. */
  aim: CarryAimSchema.optional(),
});
export type Carry = z.infer<typeof CarrySchema>;

/**
 * The gesture family. `move`, `resize` and `draw` say how one placed object's own
 * geometry is changing; `carry` says an item is in flight between placements and names
 * it — the geometry fields then describe where its representation currently renders,
 * which for an object still in its source container is that object's live box.
 */
export const GESTURE_KINDS = ["move", "resize", "draw", "carry"] as const;
export const GestureKindSchema = z.enum(GESTURE_KINDS);
export type GestureKind = z.infer<typeof GestureKindSchema>;

/** Client-side cursor send throttle; server may additionally drop under backpressure. */
export const CURSOR_MIN_INTERVAL_MS = 16;
/** Gesture updates use the same high-frequency cadence as cursor motion. */
export const GESTURE_MIN_INTERVAL_MS = 16;
/** Stale gesture overrides must disappear even when an end frame is dropped. */
export const GESTURE_TTL_MS = 3_000;
/** Viewport updates are presence metadata, not motion — keep them at or under 1 Hz. */
export const VIEWPORT_MIN_INTERVAL_MS = 1000;
