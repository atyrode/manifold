export interface RemoteCursor {
  readonly principalId: string;
  readonly connId: string;
  readonly x: number;
  readonly y: number;
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
  cursors.set(remoteCursorSocketId(frame.principalId, frame.connId), {
    principalId: frame.principalId,
    connId: frame.connId,
    x: frame.x,
    y: frame.y,
    tool: frame.tool ?? "pointer",
  });
  return true;
}
