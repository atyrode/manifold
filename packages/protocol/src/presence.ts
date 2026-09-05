import { z } from "zod";
import { TileEdgeSchema } from "./layout.ts";
import { PlacementItemSchema, PlacementRefSchema } from "./placement.ts";
import { PrincipalSchema } from "./principal.ts";
import { ManifoldRefSchema, formatManifoldUri } from "./uri.ts";

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

/** Mounted ancestry, including element/tile placements, in the existing canonical address space. */
export const MAX_LOCATION_PATH_LENGTH = 32;
export const LocationPathSchema = z.array(ManifoldRefSchema).min(1).max(MAX_LOCATION_PATH_LENGTH);
export type LocationPath = z.infer<typeof LocationPathSchema>;

/** Unknown paths never match, including the empty prefix. No canonical-parent inference. */
export function locationPathContains(
  path: LocationPath | null | undefined,
  prefix: LocationPath | null | undefined,
): boolean {
  return (
    path != null &&
    prefix != null &&
    prefix.length > 0 &&
    prefix.length <= path.length &&
    prefix.every((ref, index) => formatManifoldUri(ref) === formatManifoldUri(path[index]!))
  );
}

export function locationPathsEqual(
  left: LocationPath | null | undefined,
  right: LocationPath | null | undefined,
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.length === right.length &&
      locationPathContains(left, right))
  );
}

/** Server-stamped connection identity; a null path means this connection declared no location. */
export const ConnectionLocationSchema = z.strictObject({
  connId: z.string().min(1),
  locationPath: LocationPathSchema.nullable(),
});
export type ConnectionLocation = z.infer<typeof ConnectionLocationSchema>;

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
   * what it is editing, which container has its focus, whether its sidebar is collapsed,
   * and whether it is ARRANGING (F8: the workspace stops being interactive and the parts of
   * ONE arrangement become grabbable) and which arrangement that is. This is the multiplayer
   * axiom applied to the last private corner of the client — a chrome state only one browser
   * tab could see is a capability no other principal can observe or drive, so it rides
   * presence like everything else that dies with the connection.
   *
   * `arranging` is here for the same reason `sidebarCollapsed` is, and it is the reason a
   * mode is legible at all: a collaborator who can see that you are rearranging knows why
   * your terminals stopped taking clicks, and an agent can watch the mode it is driving.
   *
   * `arrangeScope` says WHICH ARRANGEMENT is live, because arranging is nested: a workspace
   * holds panels, and a panel may hold an arrangement of its own. It names the panel ref
   * whose OWN children are grabbable right now. ABSENT ≡ the root scope, where the grabbable
   * things are the workspace's panels — which is exactly what every frame written before this
   * field existed says, so a pre-change producer keeps its pre-change meaning and arming the
   * mode still needs to publish nothing but `arranging`.
   *
   * It is a REF, not a kind: the floor never learns the vocabulary of inner arrangements, and
   * a panel that offers one declares it in its manifest (`contributes.panels[].arranges`).
   * Reading a scope therefore means resolving the ref against the assembly, exactly as a
   * `panel` tile leaf is resolved — one address space, not a second enumeration.
   */
  vantage: z
    .strictObject({
      tool: z.string().min(1).max(64).nullish(),
      editingElementId: z.string().min(1).nullish(),
      focusedContainerId: z.string().min(1).nullish(),
      /** Ordered mounted ancestry; omitted means undeclared, null explicitly clears. */
      locationPath: LocationPathSchema.nullish(),
      sidebarCollapsed: z.boolean().optional(),
      arranging: z.boolean().optional(),
      /** Bounded exactly as a `panel` tile ref is (`TileRefSchema`): it is the same string. */
      arrangeScope: z.string().min(1).max(96).nullish(),
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
  /** Per-connection locations prevent one tab's path from being attributed to its siblings. */
  connectionLocations: z.array(ConnectionLocationSchema).max(64).optional(),
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
  /**
   * The producer's LAYOUT REVISION: a content hash of the tile tree the aim was resolved
   * against, which every peer derives from its own copy of that tree rather than from a
   * counter anybody has to keep. An aim names a `tileId` and nothing else, so a viewer one
   * Yjs update behind (or ahead) re-derives a DIFFERENT prospect from the same bytes and
   * has no way to notice: a vanished tile degrades gracefully to no preview, but a RESHAPED
   * tree yields a confidently wrong one. Stamped, the skew is detectable and the viewer
   * simply withholds the preview until the trees agree — one update later.
   *
   * Optional because it is derived from a tree: a portal whose socket has not delivered its
   * layout has none to hash, and absence means "unverifiable", which is exactly the
   * pre-stamp behavior of trusting the tile id alone.
   */
  revision: z.number().int().nonnegative().optional(),
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
/**
 * How long a remote cursor survives with no frame behind it. A departing pointer says so
 * explicitly — leaving the surface or hiding the tab publishes `cursor: null` — so this is
 * the backstop for the goodbye that never arrives: a socket cut mid-motion, a tab killed
 * before it can speak. It sits an order of magnitude above `GESTURE_TTL_MS` because the two
 * silences mean different things. A gesture is motion by definition, so silence means it
 * ended; a cursor emits frames only while it MOVES, so silence is the ordinary state of a
 * pointer resting on the canvas. The bound has to outlast a reading pause, not a send
 * interval, or peers would watch a present pointer blink out.
 */
export const CURSOR_TTL_MS = 30_000;
/** Gesture updates use the same high-frequency cadence as cursor motion. */
export const GESTURE_MIN_INTERVAL_MS = 16;
/** Stale gesture overrides must disappear even when an end frame is dropped. */
export const GESTURE_TTL_MS = 3_000;
/** Viewport updates are presence metadata, not motion — keep them at or under 1 Hz. */
export const VIEWPORT_MIN_INTERVAL_MS = 1000;
