import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "@manifold/sdk";
import type { MachineSummary } from "@manifold/protocol";
import type { RosterRow } from "./roster-model.ts";
import type { SessionRow } from "./session-inventory.ts";

const MAX_AVATARS = 4;

function initials(name: string): string {
  const first = [...name][0];
  return first === undefined ? "?" : first.toUpperCase();
}

/** One presence surface: avatar stack collapsing into a roster popover. */
export function PresenceIsland({ rows }: { rows: readonly RosterRow[] }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper !== null && event.target instanceof Node && !wrapper.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const visible = rows.slice(0, MAX_AVATARS);
  const overflow = rows.length - visible.length;

  return (
    <div className="presence-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className="presence-stack"
        aria-expanded={open}
        aria-label="Collaborators"
        onClick={() => setOpen((value) => !value)}
      >
        {visible.map((row) => (
          <div
            key={row.principal.id}
            className={`presence-avatar${row.principal.kind === "agent" ? " is-agent" : ""}${row.isSelf ? " is-self" : ""}`}
            style={{ backgroundColor: row.principal.color }}
            title={`${row.principal.name} (${row.principal.kind})`}
          >
            {initials(row.principal.name)}
          </div>
        ))}
        {overflow > 0 ? <div className="presence-avatar presence-overflow">+{overflow}</div> : null}
      </button>
      {open ? (
        <div className="presence-popover">
          {rows.map((row) => (
            <div className="presence-row" key={row.principal.id}>
              <span className="presence-dot" style={{ backgroundColor: row.principal.color }} />
              <span className="presence-name">
                {row.principal.name}
                {row.isSelf ? <span className="you-chip">you</span> : null}
                {row.principal.kind === "agent" ? <span className="agent-chip">agent</span> : null}
              </span>
              {/* What that peer is HOLDING, from their published view state: the observable
                  half of A2 — a tool choice used to be private to one tab. */}
              {row.tool === null ? null : <span className="presence-tool-chip">{row.tool}</span>}
              <span className="presence-status">{row.status.replaceAll("_", " ")}</span>
              {row.connections > 1 ? (
                <span className="presence-connections" title={`${row.connections} connections`}>
                  ×{row.connections}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface WorkspaceSidebarState {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
  readonly rows: readonly SessionRow[];
  readonly onCreateTerminal: (machine?: MachineSummary) => void;
}

/** Ambient connection and persistence state; intentionally compact and visually quiet. */
export function WorkspaceStatus({
  status,
  savedAt,
  rev,
}: Pick<WorkspaceSidebarState, "status" | "savedAt" | "rev">) {
  const savedLabel = savedAt === null ? "Not saved yet" : new Date(savedAt).toLocaleTimeString();
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <div
      className="workspace-status"
      title={`Connection ${status} · ${savedLabel} · revision ${rev}`}
      role="status"
      data-testid="connection-status"
    >
      <span className={`status-dot ${status}`} aria-hidden="true" />
      <span>
        <strong data-testid="connection-state">{statusLabel}</strong>
        <small>
          {savedAt === null ? "Not saved" : `Saved ${savedLabel}`} · rev {rev}
        </small>
      </span>
    </div>
  );
}
