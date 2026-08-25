import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "@manifold/sdk";
import type { MachineSummary } from "@manifold/protocol";
import type { RosterRow } from "./roster-model.ts";
import type { SessionRow } from "./session-inventory.ts";
import { machineColor } from "./machine-visibility.ts";

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

/** Fleet rail: every enrolled machine with its deterministic dot and liveness. */
export function MachinesIsland({ machines }: { machines: readonly MachineSummary[] | null }) {
  if (machines === null || machines.length === 0) return null;
  return (
    <div className="machines-island" data-testid="machines-rail">
      {machines.map((machine) => (
        <div
          className={`machine-row${machine.online ? "" : " is-offline"}`}
          key={machine.id}
          title={`${machine.name} — ${machine.online ? "online" : "offline"}`}
        >
          <span
            className={`machine-dot${machine.online ? "" : " is-offline"}`}
            style={{ backgroundColor: machineColor(machine.id) }}
          />
          <span className="machine-name">{machine.name}</span>
          <span className="machine-state">{machine.online ? "online" : "offline"}</span>
        </div>
      ))}
    </div>
  );
}

interface SessionsIslandProps {
  readonly rows: readonly SessionRow[];
  /** Reveals the bound element on the canvas; null for orphaned sessions. */
  readonly onFocus: (elementId: string) => void;
  readonly onKill: (sessionId: string) => void;
}

/** Terminal janitor: every PTY session in this pad, orphans flagged and prunable. */
export function SessionsIsland({ rows, onFocus, onKill }: SessionsIslandProps) {
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

  if (rows.length === 0) return null;
  const running = rows.filter((row) => row.status === "running").length;
  const orphans = rows.filter((row) => row.orphaned).length;

  return (
    <div className="sessions-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className={`sessions-pill${orphans > 0 ? " has-orphans" : ""}`}
        aria-expanded={open}
        aria-label="Terminal sessions"
        title="Terminal sessions"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sessions-count">{running}</span>
        <span>sessions</span>
        {orphans > 0 ? <span className="sessions-orphan-badge">{orphans}</span> : null}
      </button>
      {open ? (
        <div className="sessions-popover">
          {rows.map((row) => (
            <div
              className={[
                "session-row",
                row.status === "running" ? "is-running" : "is-exited",
                row.orphaned ? "is-orphaned" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              key={row.id}
            >
              <span className="session-state" title={row.status}>
                {row.status === "running" ? (row.orphaned ? "⚠" : "●") : "○"}
              </span>
              <span className="session-label">
                {row.machineName ?? "unknown machine"}
                {row.machineOnline === false ? " (offline)" : ""}
                {row.status === "exited" ? ` — exited ${row.exitCode ?? ""}` : ""}
                {row.isController ? <span className="you-chip">yours</span> : null}
                {row.orphaned ? <span className="orphan-chip">unbound</span> : null}
              </span>
              {row.boundElementId !== null ? (
                <button
                  type="button"
                  className="session-action"
                  title="Reveal terminal element"
                  onClick={() => {
                    onFocus(row.boundElementId ?? "");
                    setOpen(false);
                  }}
                >
                  show
                </button>
              ) : null}
              {row.canKill ? (
                <button
                  type="button"
                  className="session-action is-danger"
                  title="Kill the process on its machine"
                  onClick={() => onKill(row.id)}
                >
                  kill
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PadTopRightProps extends StatusIslandProps {
  readonly isMobile: boolean;
  readonly rows: readonly RosterRow[];
  readonly machines: readonly MachineSummary[] | null;
  readonly sessionRows: readonly SessionRow[];
  readonly onFocusSession: (elementId: string) => void;
  readonly onKillSession: (sessionId: string) => void;
}

/** manifold-owned top-right cluster rendered through excalidraw's renderTopRightUI slot. */
export function PadTopRight({
  isMobile,
  rows,
  machines,
  sessionRows,
  onFocusSession,
  onKillSession,
  status,
  savedAt,
  rev,
}: PadTopRightProps) {
  return (
    <>
      {isMobile ? null : <StatusIsland status={status} savedAt={savedAt} rev={rev} />}
      {isMobile ? null : <MachinesIsland machines={machines} />}
      {isMobile ? null : (
        <SessionsIsland rows={sessionRows} onFocus={onFocusSession} onKill={onKillSession} />
      )}
      <PresenceIsland rows={rows} />
    </>
  );
}
