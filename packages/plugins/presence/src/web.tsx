/**
 * `core.presence`, browser half — the presence PLANE made visible.
 *
 * Presence is one concept with several faces: where a peer's pointer is, what it is dragging,
 * who is in the room and what each is holding, and "look at this" arriving from somebody who
 * shares the room. All of it dies with the connection and nobody merges it (D6), which is why
 * one plugin owns the lot rather than each renderer growing its own copy.
 *
 * This barrel is the package's only browser door. Everything behind it is either a pure
 * projection of wire frames (cursor identity, gesture overrides, roster rows) or a React
 * surface over one (`useRemoteCursors`, `PresenceIsland`, `useSpotlight`). Nothing here reads
 * the DOM of a particular renderer, so a canvas, a composition and any future host chrome all
 * paint the same presence from the same source.
 *
 * The engine floor still CALLS most of this, because the canvas and tiled renderers are
 * themselves floor until `core.canvas` / `core.compositions` (AXIOMS.md §Roadmap). Those
 * imports are the visible remainder of the conversion, not a design: each one is a line wave C
 * deletes when the renderer that owns it becomes a plugin too.
 */
export { projectLocalPresence } from "./presence-projection.ts";
export { deriveRosterRows, type RosterRow } from "./roster-model.ts";
export { PresenceIsland } from "./presence-island.tsx";
export {
  clampCursorFraction,
  cursorFraction,
  remoteCursorSocketId,
  type CursorBox,
  type CursorPoint,
} from "./cursor-identity.ts";
export {
  REMOTE_CURSOR_FALLBACK_COLOR,
  carrierColor,
  useRemoteCursors,
  type CursorSpace,
  type RemoteCursorsView,
} from "./use-remote-cursors.ts";
export {
  createGestureStream,
  gestureSendIntervalOverride,
  type GestureStream,
} from "./gesture-stream.ts";
export {
  applyGestureFrame,
  expireGestures,
  stepGestures,
  type GestureGeometry,
  type GestureOverride,
} from "./remote-gestures.ts";
export { SpotlightChip, useSpotlight, type SpotlightState } from "./spotlight.tsx";
