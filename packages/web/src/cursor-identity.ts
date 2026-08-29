import { CURSOR_HALF_LIFE_MS, stepToward } from "./interpolate";

export interface RemoteCursor {
  readonly principalId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly tool: "pointer" | "laser";
}

interface CursorFrame {
  readonly principalId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
  readonly tool?: "pointer" | "laser" | undefined;
}

/** A socket id remains unique when one principal has several live browser connections. */
export function remoteCursorSocketId(principalId: string, connId: string): string {
  return `${principalId}:${connId}`;
}

/** Records every remote connection, including siblings, while dropping only this socket's echo. */
export function recordRemoteCursor(
  cursors: Map<string, RemoteCursor>,
  frame: CursorFrame,
  selfConnId: string | null,
): boolean {
  if (frame.connId === selfConnId) return false;
  const id = remoteCursorSocketId(frame.principalId, frame.connId);
  const previous = cursors.get(id);
  cursors.set(id, {
    principalId: frame.principalId,
    connId: frame.connId,
    x: previous?.x ?? frame.x,
    y: previous?.y ?? frame.y,
    targetX: frame.x,
    targetY: frame.y,
    tool: frame.tool ?? "pointer",
  });
  return true;
}

interface RosterConnections {
  readonly principal: { readonly id: string };
  readonly connIds: readonly string[];
}

/**
 * Retires cursors whose connection is gone. Cursors are stamped per-connection, but a
 * principal with several tabs stays in the roster until the last one closes — pruning
 * by principal alone left a dead tab's cursor lying on the canvas forever. The roster
 * carries the exact live connection ids, so anything outside that set is a ghost.
 */
export function pruneRemoteCursors(
  cursors: Map<string, RemoteCursor>,
  roster: Iterable<RosterConnections>,
): boolean {
  const live = new Set<string>();
  for (const state of roster) {
    for (const connId of state.connIds) live.add(remoteCursorSocketId(state.principal.id, connId));
  }
  let changed = false;
  for (const id of cursors.keys()) {
    if (live.has(id)) continue;
    cursors.delete(id);
    changed = true;
  }
  return changed;
}

/**
 * Disambiguates sibling tabs of one principal: the roster's live conn ids sort into a
 * shared order, the first keeps the bare name, and later tabs render "name (2)", "name
 * (3)"... Every viewer computes the same label because every viewer holds the same
 * roster. A connId not (yet) in the roster keeps the bare name rather than guessing.
 */
export function cursorLabel(name: string, connId: string, connIds: readonly string[]): string {
  if (connIds.length < 2) return name;
  const ordinal = [...connIds].sort().indexOf(connId);
  return ordinal <= 0 ? name : `${name} (${ordinal + 1})`;
}

export function stepRemoteCursors(cursors: Map<string, RemoteCursor>, dtMs: number): boolean {
  let changed = false;
  for (const [id, cursor] of cursors) {
    const x = stepToward(cursor.x, cursor.targetX, dtMs, CURSOR_HALF_LIFE_MS);
    const y = stepToward(cursor.y, cursor.targetY, dtMs, CURSOR_HALF_LIFE_MS);
    if (x === cursor.x && y === cursor.y) continue;
    cursors.set(id, { ...cursor, x, y });
    changed = true;
  }
  return changed;
}
