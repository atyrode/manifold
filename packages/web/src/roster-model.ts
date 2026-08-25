import type { Principal, PresenceState } from "@manifold/protocol";

export interface RosterRow {
  readonly principal: Principal;
  readonly connections: number;
  readonly status: string;
  readonly isSelf: boolean;
}

/** Self always present (injected if absent from roster) and sorted first; others by name. */
export function deriveRosterRows(entries: Iterable<PresenceState>, self: Principal): RosterRow[] {
  const rows: RosterRow[] = [];
  let hasSelf = false;
  for (const entry of entries) {
    const isSelf = entry.principal.id === self.id;
    hasSelf ||= isSelf;
    rows.push({
      principal: entry.principal,
      connections: entry.connections,
      status: entry.payload.status ?? "active",
      isSelf,
    });
  }
  if (!hasSelf) {
    rows.push({ principal: self, connections: 1, status: "active", isSelf: true });
  }
  rows.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.principal.name.localeCompare(b.principal.name);
  });
  return rows;
}
