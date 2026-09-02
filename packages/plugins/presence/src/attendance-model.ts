import type { Principal, PresenceState } from "@manifold/protocol";

export interface AttendanceRow {
  readonly principal: Principal;
  readonly connections: number;
  readonly status: string;
  /**
   * The tool this peer is holding, from its published view state (A2). Null when the peer
   * has published none — a fresh socket, or a ref with no tool strip at all.
   */
  readonly tool: string | null;
  readonly isSelf: boolean;
}

/** Self always present (injected if absent from roster) and sorted first; others by name. */
export function deriveAttendanceRows(
  entries: Iterable<PresenceState>,
  self: Principal,
): AttendanceRow[] {
  const rows: AttendanceRow[] = [];
  let hasSelf = false;
  for (const entry of entries) {
    const isSelf = entry.principal.id === self.id;
    hasSelf ||= isSelf;
    rows.push({
      principal: entry.principal,
      connections: entry.connections,
      status: entry.payload.status ?? "active",
      tool: entry.payload.vantage?.tool ?? null,
      isSelf,
    });
  }
  if (!hasSelf) {
    rows.push({ principal: self, connections: 1, status: "active", tool: null, isSelf: true });
  }
  rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.principal.name.localeCompare(b.principal.name);
  });
  return rows;
}
