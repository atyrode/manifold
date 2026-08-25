import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "@manifold/sdk";
import type { RosterRow } from "./roster-model.ts";

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

interface StatusIslandProps {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
}

/** Synchronization health as a compact excalidraw-styled pill. */
export function StatusIsland({ status, savedAt, rev }: StatusIslandProps) {
  const savedLabel = savedAt === null ? "—" : new Date(savedAt).toLocaleTimeString();
  return (
    <div className="status-island" role="status" data-testid="connection-status">
      <span className={`status-dot ${status}`} />
      <span data-testid="connection-state">{status}</span>
      <span className="status-meta">rev {rev}</span>
      <span className="status-meta">saved {savedLabel}</span>
    </div>
  );
}

interface PadTopRightProps extends StatusIslandProps {
  readonly isMobile: boolean;
  readonly rows: readonly RosterRow[];
}

/** manifold-owned top-right cluster rendered through excalidraw's renderTopRightUI slot. */
export function PadTopRight({ isMobile, rows, status, savedAt, rev }: PadTopRightProps) {
  return (
    <>
      {isMobile ? null : <StatusIsland status={status} savedAt={savedAt} rev={rev} />}
      <PresenceIsland rows={rows} />
    </>
  );
}
