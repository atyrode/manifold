import type { ContainerOverlayProps } from "@manifold/plugin/hooks";
import { useEffect, useState, type ReactElement } from "react";
import { PresenceIsland } from "./presence-island.tsx";
import { deriveAttendanceRows, type AttendanceRow } from "./attendance-model.ts";
import { SpotlightChip, useSpotlight } from "./spotlight.tsx";

/**
 * `core.presence`'s chrome, as OVERLAYS — the shape that lets presence keep owning its own
 * presentation without any renderer importing this package.
 *
 * A container renderer declares WHERE presence chrome sits on its own ref by mounting a
 * named slot; this plugin declares WHAT goes in it by registering these components against the
 * same names. Neither names the other, and a ref that mounts no slot simply shows no
 * presence chrome — absence paints nothing, because an inert box floating over a live canvas
 * would be worse than the missing decoration.
 *
 * What is NOT here, deliberately: remote cursors, carry ghosts and selection outlines. Those
 * are painted BY the ref, in the ref's own coordinate space, from the plane mechanism
 * in `@manifold/plugin/hooks` — a peer's pointer position means nothing until something
 * projects it through a viewport transform, and only the renderer holds that transform. A view
 * rendering remote intent as part of its own ref is AGENTS.md invariant 11 working, not a
 * boundary leak; what would be a leak is this package reaching into React Flow.
 */

/** WHO ELSE IS HERE: the avatar stack and its roster popover, over any ref that asks. */
export function AttendanceOverlay({ client, host }: ContainerOverlayProps): ReactElement {
  const [rows, setRows] = useState<readonly AttendanceRow[]>([]);

  useEffect(() => {
    const refresh = (): void => {
      setRows(deriveAttendanceRows(client.attendance.values(), client.self ?? host.principal));
    };
    const off = client.on("attendance_changed", refresh);
    refresh();
    return off;
  }, [client, host.principal]);

  return <PresenceIsland rows={rows} />;
}

/**
 * "LOOK AT THIS", received: the consent ref for `core.presence.focus`. The camera it moves
 * is the host's — whichever container view is mounted registered it — so this component works over a
 * canvas, over a composition, and over any ref that publishes a viewport.
 */
export function SpotlightOverlay({ client, host }: ContainerOverlayProps): ReactElement | null {
  const spotlight = useSpotlight(client, host.viewport);
  return spotlight === null ? null : <SpotlightChip spotlight={spotlight} />;
}
