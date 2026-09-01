/**
 * THE PRESENCE PLANE'S BROWSER MECHANISM — engine floor, and the whole of what the floor
 * knows about presence.
 *
 * Presence is a plane (§The plane rule): state that dies with the connection, relayed by the
 * server without being read. Every party on that plane needs the same three things — a send
 * cadence that does not flood the socket, an interpolator that turns a 16ms frame train into
 * motion, and a per-connection identity so one principal in three tabs is three cursors. None
 * of it is presence POLICY and none of it names a plugin: it is arithmetic over wire payloads,
 * correct for any producer and any renderer.
 *
 * It lives here because its parties may not import each other. A view PAINTS remote intent
 * into its own coordinate space — the canvas projects cursors through React Flow's transform,
 * a composition projects fractions onto its view root, and a future host chrome will do
 * something else again — which is AGENTS.md invariant 11 working rather than a leak: a
 * renderer consuming a peer's frame is the same act as consuming its own normalized input.
 * `core.presence` owns what the floor must not: putting this device's state ON the wire, the
 * `focus` door, and its own chrome (the roster island, the spotlight chip), all of which reach
 * views as registered overlays instead of as imports.
 *
 * The one non-cursor member, {@link projectLocalPresence}, is here for the same reason and is
 * the plainest statement of invariant 11 in the tree: it normalizes THIS principal into the
 * wire shape the poll will report a moment later, so every renderer downstream consumes one
 * producer-agnostic row set and never learns which principal is local.
 */
export {
  clampCursorFraction,
  cursorFraction,
  cursorLabel,
  expireRemoteCursors,
  pruneRemoteCursors,
  recordRemoteCursor,
  remoteCursorSocketId,
  retractRemoteCursor,
  stepRemoteCursors,
  type CursorBox,
  type CursorPoint,
  type RemoteCursor,
} from "./cursor-identity.ts";
export {
  createGestureStream,
  gestureSendIntervalOverride,
  type GestureStream,
  type GestureStreamOptions,
} from "./gesture-stream.ts";
export {
  CURSOR_HALF_LIFE_MS,
  FLOW_SNAP_EPSILON,
  FRACTION_SNAP_EPSILON,
  GESTURE_HALF_LIFE_MS,
  stepToward,
} from "./interpolate.ts";
export { projectLocalPresence } from "./local-projection.ts";
export {
  AIM_TTL_MS,
  applyGestureFrame,
  expireGestures,
  stepGestures,
  type GestureGeometry,
  type GestureOverride,
} from "./remote-gestures.ts";
export {
  REMOTE_CURSOR_FALLBACK_COLOR,
  REMOTE_CURSOR_FALLBACK_LABEL,
  carrierColor,
  useRemoteCursors,
  type CursorSpace,
  type RemoteCursorsView,
} from "./use-remote-cursors.ts";
