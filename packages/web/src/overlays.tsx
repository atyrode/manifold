import type { Principal } from "@manifold/protocol";
import type { ConnectionStatus, SessionClient } from "@manifold/sdk";

const KIND_MARK: Record<Principal["kind"], string> = {
  human: "⌂",
  agent: "⚙",
};

interface RosterProps {
  readonly client: SessionClient;
  readonly fallbackSelf: Principal;
}

/** Renders the principal-level roster while preserving per-principal connection counts. */
export function Roster({ client, fallbackSelf }: RosterProps) {
  const self = client.self ?? fallbackSelf;
  const entries = [...client.roster.values()];
  const hasSelf = entries.some((entry) => entry.principal.id === self.id);
  const rows = entries.map((entry) => ({
    principal: entry.principal,
    connections: entry.connections,
    status: entry.payload.status ?? "active",
  }));
  if (!hasSelf) {
    rows.push({ principal: self, connections: 1, status: "active" });
  }
  rows.sort((a, b) => {
    const aIsSelf = a.principal.id === self.id;
    const bIsSelf = b.principal.id === self.id;
    if (aIsSelf !== bIsSelf) return aIsSelf ? -1 : 1;
    return a.principal.name.localeCompare(b.principal.name);
  });

  return (
    <aside className="roster-overlay" aria-label="Collaborators">
      {rows.map((row) => {
        const isSelf = row.principal.id === self.id;
        return (
          <div className="roster-row" key={row.principal.id}>
            <span className="roster-dot" style={{ backgroundColor: row.principal.color }} />
            <span className="roster-name">
              {row.principal.name}
              {isSelf ? <span className="you-label">you</span> : null}
            </span>
            <span className={`kind-badge ${row.principal.kind}`} title={row.principal.kind}>
              {KIND_MARK[row.principal.kind]}
            </span>
            <span className="roster-status">{row.status.replaceAll("_", " ")}</span>
            <span className="connection-count" title={`${row.connections} connections`}>
              ×{row.connections}
            </span>
          </div>
        );
      })}
    </aside>
  );
}

interface StatusBarProps {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
}

/** Exposes synchronization health without competing with the canvas UI. */
export function StatusBar({ status, savedAt, rev }: StatusBarProps) {
  const savedLabel = savedAt === null ? "not saved yet" : new Date(savedAt).toLocaleTimeString();
  return (
    <div className="status-bar" role="status">
      <span className={`status-indicator ${status}`} />
      <span>{status}</span>
      <span>rev {rev}</span>
      <span>saved {savedLabel}</span>
    </div>
  );
}
