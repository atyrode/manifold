import "./styles.css";
import type { OverlayRegistrations } from "@manifold/plugin/hooks";
import { SpotlightOverlay, TitlebarAttendance } from "./container-overlays.tsx";

/**
 * `core.presence`, browser half — the presence PLANE made visible.
 *
 * Presence is one concept with several faces: who is in the room and what each is holding,
 * where a peer's pointer is, what it is dragging, and "look at this" arriving from somebody
 * who shares the room. All of it dies with the connection and nobody merges it (D6).
 *
 * The split between this package and the engine is a split of ROLE, not of topic, and it is
 * the reason no renderer imports this file any more:
 *
 *   PLANE MECHANISM is engine (`@manifold/plugin/hooks`): send cadence, interpolation,
 *     per-connection cursor identity, gesture stepping, local-presence normalization. It is
 *     arithmetic over wire payloads — correct for any producer, any renderer — and its parties
 *     may not import each other.
 *   PAINTING REMOTE INTENT belongs to whichever ref is on screen. A cursor, a carry ghost
 *     and a selection outline mean nothing until something projects them through a viewport
 *     transform, and only the renderer holds that transform. A view consuming a peer's frame
 *     as part of its own ref is invariant 11, exactly as it consumes its own input.
 *   PRESENCE'S OWN CHROME is this plugin's, and it reaches refs as REGISTERED OVERLAYS
 *     (below) rather than as imports: who is here, and the consent ref for a spotlight.
 *
 * Plus the door itself — `core.presence.focus` (`src/index.ts`, server half `src/server.ts`).
 *
 * `projectLocalPresence` is NOT here and no longer belongs to this package: normalizing this
 * device's own principal into the wire shape the poll will report a moment later is invariant
 * 11's plainest statement, so it is engine mechanism that the shell and every renderer reach
 * through one producer-agnostic function.
 */
export {
  deriveAttendanceRows,
  deriveLocationAttendanceRows,
  type AttendanceRow,
} from "./attendance-model.ts";
export { PresenceIsland } from "./presence-island.tsx";
export { SpotlightChip, useSpotlight, type SpotlightState } from "./spotlight.tsx";
export { SpotlightOverlay, TitlebarAttendance } from "./container-overlays.tsx";

/**
 * What this plugin registers in the browser: the shared titlebar roster and the container
 * spotlight. Roster details live in the same titlebar painter at every mounted depth.
 *
 * Overlays carry no manifest row, exactly as `routes` do not: a slot is not a ref the
 * workspace composes, it is decoration a ref invites. The roster still decides whether
 * this plugin is ENABLED, and a disabled plugin's overlay simply does not paint.
 */
export const presenceWebPlugin = {
  id: "core.presence",
  /*
    `satisfies` rather than a plain literal: the slot names are the closed OverlaySlot
    vocabulary, and a registration that misspells one must fail HERE, in the plugin that
    wrote it, rather than paint nothing over a canvas nobody is watching. The literal type
    survives the check, so the engine still sees exactly which slots this plugin fills.
   */
  overlays: {
    "container-spotlight": SpotlightOverlay,
    titlebar: TitlebarAttendance,
  } satisfies OverlayRegistrations,
};
