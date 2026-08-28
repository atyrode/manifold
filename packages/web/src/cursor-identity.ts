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
