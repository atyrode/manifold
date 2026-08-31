import type { SessionClient } from "@manifold/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  cursorLabel,
  pruneRemoteCursors,
  recordRemoteCursor,
  stepRemoteCursors,
  type RemoteCursor,
} from "./cursor-identity.ts";
import { FLOW_SNAP_EPSILON, FRACTION_SNAP_EPSILON } from "./interpolate.ts";

/**
 * Live remote cursors for one container, independent of how that container is drawn.
 *
 * Cursors are a renderer-level concern, not a canvas one: a room broadcasts the frames,
 * and whichever renderer is mounted on that room decides where they land. The canvas
 * renderer projects them through React Flow's pan/zoom transform; the composition renderer
 * projects fractions onto the view root. Everything before that projection — the
 * per-connection map, the self-echo drop, roster pruning, label/color resolution and the
 * animation-frame easing — is identical, so it lives here once.
 *
 * The coordinate space itself is the room's, not this hook's: `x`/`y` are never
 * interpreted here. The one thing the easing does need is the space's SCALE, so the
 * caller names it — half a pixel and half a fraction are wildly different distances.
 */

/** Painted when the roster has not (yet) got the principal behind a live cursor. */
export const REMOTE_CURSOR_FALLBACK_COLOR = "#868e96";
/** Likewise for the name strip: a cursor is never anonymous on screen. */
export const REMOTE_CURSOR_FALLBACK_LABEL = "Collaborator";

/**
 * A carrier's chosen color, so the ghost of what someone is dragging belongs to the
 * same person as their cursor. It lives beside the fallback it falls back TO, because
 * the two are one rule and each renderer having its own copy is how a presence color
 * quietly starts disagreeing with itself between a cursor and a carry.
 */
export function carrierColor(client: SessionClient | null, principalId: string): string {
  return client?.attendance.get(principalId)?.principal.color ?? REMOTE_CURSOR_FALLBACK_COLOR;
}

export interface RemoteCursorsView {
  /** Every live remote connection's cursor, in the room's own coordinate space. */
  readonly cursors: readonly RemoteCursor[];
  readonly labelFor: (cursor: RemoteCursor) => string;
  /**
   * The principal's chosen color, or null when the roster has not got them. Renderers
   * keep the distinction: `data-cursor-color` stays empty for an unresolved principal
   * while the paint falls back to `REMOTE_CURSOR_FALLBACK_COLOR`.
   */
  readonly colorFor: (cursor: RemoteCursor) => string | null;
}

/**
 * Which space a room's cursor frames are expressed in, decided by the container's
 * discipline: canvas rooms carry React-Flow scene coordinates, composition rooms carry
 * view-root fractions in the unit square.
 */
export type CursorSpace = "flow" | "fraction";

const SNAP_EPSILON: Record<CursorSpace, number> = {
  flow: FLOW_SNAP_EPSILON,
  fraction: FRACTION_SNAP_EPSILON,
};

export function useRemoteCursors(
  client: SessionClient | null,
  space: CursorSpace,
): RemoteCursorsView {
  /**
   * The map is the authority and React state is its published snapshot: cursor frames
   * arrive at the send cadence and are eased every frame, so mutating a ref and
   * publishing an array beats rebuilding a state Map per frame.
   */
  const cursorsRef = useRef(new Map<string, RemoteCursor>());
  const [cursors, setCursors] = useState<readonly RemoteCursor[]>([]);

  useEffect(() => {
    const map = cursorsRef.current;
    const publish = (): void => setCursors([...map.values()]);
    if (client === null) return;
    const offAttendance = client.on("attendance_changed", () => {
      pruneRemoteCursors(map, client.attendance.values());
      // Published unconditionally: labels and colors resolve from the roster at paint
      // time, so a rename, a color change, or a sibling tab joining (which renumbers
      // the "name (2)" ordinals) has to repaint even when no cursor moved.
      publish();
    });
    const offCursor = client.on("cursor", (message) => {
      if (recordRemoteCursor(map, message, client.selfConnId)) publish();
    });
    return () => {
      offAttendance();
      offCursor();
      // A renderer swapping clients must not inherit the previous room's cursors.
      map.clear();
      publish();
    };
  }, [client]);

  useEffect(() => {
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number): void => {
      const elapsed = Math.max(0, now - previous);
      previous = now;
      // Idle rooms cost one comparison per cursor: stepping an unchanged map returns
      // false and never touches React state.
      if (stepRemoteCursors(cursorsRef.current, elapsed, SNAP_EPSILON[space])) {
        setCursors([...cursorsRef.current.values()]);
      }
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [space]);

  const labelFor = useCallback(
    (cursor: RemoteCursor): string => {
      const state = client?.attendance.get(cursor.principalId);
      return state === undefined
        ? REMOTE_CURSOR_FALLBACK_LABEL
        : cursorLabel(state.principal.name, cursor.connId, state.connIds);
    },
    [client],
  );

  const colorFor = useCallback(
    (cursor: RemoteCursor): string | null =>
      client?.attendance.get(cursor.principalId)?.principal.color ?? null,
    [client],
  );

  return { cursors, labelFor, colorFor };
}
