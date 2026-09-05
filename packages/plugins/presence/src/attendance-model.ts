import {
  locationPathContains,
  type LocationPath,
  type Principal,
  type PresencePayload,
  type PresenceState,
} from "@manifold/protocol";

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
  injectSelf = true,
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
  if (injectSelf && !hasSelf) {
    rows.push({ principal: self, connections: 1, status: "active", tool: null, isSelf: true });
  }
  rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.principal.name.localeCompare(b.principal.name);
  });
  return rows;
}

/**
 * A titlebar shows principals with a live connection inside its mounted prefix. The local
 * connection uses the same published vantage immediately; sibling tabs keep their own paths.
 * Missing connection data is unknown, never permission to infer ancestry from room attendance.
 */
export function deriveLocationAttendanceRows(
  entries: Iterable<PresenceState>,
  self: Principal,
  selfConnId: string | null,
  localVantage: PresencePayload["vantage"],
  locationPath: LocationPath,
): AttendanceRow[] {
  const located: PresenceState[] = [];
  const localMatches =
    selfConnId !== null && locationPathContains(localVantage?.locationPath, locationPath);
  let hasSelf = false;
  for (const entry of entries) {
    const isSelf = entry.principal.id === self.id;
    hasSelf ||= isSelf;
    let connections = isSelf && localMatches ? 1 : 0;
    for (const location of entry.connectionLocations ?? []) {
      if (!entry.connIds.includes(location.connId)) continue;
      if (isSelf && location.connId === selfConnId) continue;
      if (locationPathContains(location.locationPath, locationPath)) connections++;
    }
    if (connections === 0) continue;
    located.push({
      ...entry,
      connections,
      payload:
        isSelf && localMatches && localVantage !== undefined
          ? { ...entry.payload, vantage: localVantage }
          : entry.payload,
    });
  }
  if (!hasSelf && localMatches && selfConnId !== null) {
    located.push({
      principal: self,
      connections: 1,
      connIds: [selfConnId],
      payload: localVantage === undefined ? {} : { vantage: localVantage },
    });
  }
  return deriveAttendanceRows(located, self, false);
}
