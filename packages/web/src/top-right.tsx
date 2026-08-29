import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "@manifold/sdk";
import type { MachineSummary } from "@manifold/protocol";
import type { RosterRow } from "./roster-model.ts";
import type { SessionRow } from "./session-inventory.ts";
import { ControlIcon, ItemIcon } from "./icons.tsx";
import { machineColor } from "./machine-visibility.ts";

const MAX_AVATARS = 4;

function initials(name: string): string {
  const first = [...name][0];
  return first === undefined ? "?" : first.toUpperCase();
}

/**
 * A dead terminal reports the code it died with, or nothing. "Code unknown" was noise
 * dressed as information: the absence of a number already says the shell never gave one.
 */
function exitedLabel(exitCode: number | null): string {
  return exitCode === null ? "Exited" : `Exited ${String(exitCode)}`;
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

export interface WorkspaceSidebarState {
  readonly status: ConnectionStatus;
  readonly savedAt: number | null;
  readonly rev: number;
  readonly machines: readonly MachineSummary[] | null;
  readonly rows: readonly SessionRow[];
  readonly onCreateTerminal: (machine?: MachineSummary) => void;
  readonly onFocus: (elementId: string) => void;
  readonly onKill: (sessionId: string) => void;
  readonly onRemoveCopy: (sessionId: string, elementId: string) => void;
  readonly onRemoveAllCopies: (sessionId: string) => void;
  readonly onHighlight: (elementId: string | null) => void;
}

interface WorkspaceSessionRowProps {
  readonly row: SessionRow;
  readonly onFocus: (elementId: string) => void;
  readonly onKill: (sessionId: string) => void;
  readonly onRemoveCopy: (sessionId: string, elementId: string) => void;
  readonly onRemoveAllCopies: (sessionId: string) => void;
  readonly onHighlight: (elementId: string | null) => void;
}

export function WorkspaceSessionRow({
  row,
  onFocus,
  onKill,
  onRemoveCopy,
  onRemoveAllCopies,
  onHighlight,
}: WorkspaceSessionRowProps) {
  const [copiesOpen, setCopiesOpen] = useState(false);
  const boundElementId = row.boundElementIds[0] ?? null;
  const copyCount = row.boundElementIds.length;
  const hasMultipleCopies = copyCount > 1;
  const locationLabel =
    row.status === "exited"
      ? exitedLabel(row.exitCode)
      : row.machineOnline === false
        ? "Machine offline"
        : "Bound to canvas";
  const detailLabel = hasMultipleCopies ? `${locationLabel} · ${copyCount} copies` : locationLabel;
  const removeAllLabel = `Remove all ${copyCount} canvas copies`;

  return (
    <div className="workspace-session-group">
      <div className={`workspace-session-row${row.status === "exited" ? " is-exited" : ""}`}>
        <span
          className={`session-state ${row.status === "running" ? "is-running" : ""}`}
          title={row.status}
        >
          <ItemIcon kind="terminal" size={13} />
        </span>
        <span className="workspace-session-label">
          <strong>{row.name ?? row.machineName ?? "Unknown machine"}</strong>
          <span>{detailLabel}</span>
        </span>
        <span className="workspace-session-actions">
          {hasMultipleCopies ? (
            <button
              className="workspace-action workspace-copies-toggle"
              onClick={() => setCopiesOpen((value) => !value)}
              aria-pressed={copiesOpen}
              aria-expanded={copiesOpen}
              aria-label={`${copiesOpen ? "Hide" : "Show"} ${copyCount} terminal copies`}
              title={`${copiesOpen ? "Hide" : "Show"} individual terminal copies`}
            >
              <span>{copyCount}</span>
              <span className="workspace-copy-chevron" aria-hidden="true" />
            </button>
          ) : boundElementId !== null ? (
            <button
              className="workspace-action is-reveal"
              onPointerEnter={() => onHighlight(boundElementId)}
              onPointerLeave={() => onHighlight(null)}
              onClick={() => {
                onHighlight(null);
                onFocus(boundElementId);
              }}
              title="Reveal terminal on canvas"
              aria-label="Reveal terminal on canvas"
            >
              <ControlIcon kind="reveal" size={13} />
            </button>
          ) : null}
          {hasMultipleCopies && row.status === "exited" ? (
            <button
              className="workspace-action is-remove"
              onClick={() => {
                setCopiesOpen(false);
                onHighlight(null);
                onRemoveAllCopies(row.id);
              }}
              title={removeAllLabel}
              aria-label={removeAllLabel}
            >
              <ControlIcon kind="discard" size={13} />
            </button>
          ) : !hasMultipleCopies && row.status === "exited" && boundElementId !== null ? (
            <button
              className="workspace-action is-remove"
              onClick={() => onRemoveCopy(row.id, boundElementId)}
              title="Remove exited terminal"
              aria-label="Remove exited terminal"
            >
              <ControlIcon kind="discard" size={13} />
            </button>
          ) : null}
          {row.canKill ? (
            <button
              className="workspace-action is-end-session"
              onClick={() => onKill(row.id)}
              title="End shared session — all terminal copies will exit"
              aria-label="End shared terminal session"
            >
              <ControlIcon kind="endSession" size={13} />
            </button>
          ) : null}
        </span>
      </div>
      {hasMultipleCopies && copiesOpen ? (
        <div className="workspace-copy-list">
          {row.boundElementIds.map((elementId, index) => {
            const copyLabel = `Copy ${index + 1} of ${copyCount}`;
            return (
              <div className="workspace-copy-row" key={elementId}>
                <span className="workspace-copy-branch" aria-hidden="true" />
                <span className="workspace-copy-label" title={elementId}>
                  {copyLabel}
                </span>
                <span className="workspace-session-actions">
                  <button
                    className="workspace-action is-reveal"
                    onPointerEnter={() => onHighlight(elementId)}
                    onPointerLeave={() => onHighlight(null)}
                    onClick={() => {
                      onHighlight(null);
                      onFocus(elementId);
                    }}
                    title={`Reveal ${copyLabel.toLowerCase()} on canvas`}
                    aria-label={`Reveal ${copyLabel.toLowerCase()} on canvas`}
                  >
                    <ControlIcon kind="reveal" size={13} />
                  </button>
                  <button
                    className="workspace-action is-remove"
                    onClick={() => onRemoveCopy(row.id, elementId)}
                    onPointerEnter={() => onHighlight(null)}
                    title={`Remove ${copyLabel.toLowerCase()} from canvas`}
                    aria-label={`Remove ${copyLabel.toLowerCase()} from canvas`}
                  >
                    <ControlIcon kind="discard" size={13} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Machine inventory body. The collapsible section shell around it is supplied by the sidebar's
 * uniform `SidebarSection`, so this renders rows only.
 */
export function MachinesSection({
  machines,
  onCreateTerminal,
}: Pick<WorkspaceSidebarState, "machines"> & {
  /** Absent on surfaces without a canvas to author into (tiled routes, workspace root). */
  readonly onCreateTerminal?: WorkspaceSidebarState["onCreateTerminal"] | undefined;
}) {
  return (
    <div className="workspace-list" data-testid="machines-rail">
      {machines === null ? (
        <span className="workspace-empty">Loading machines…</span>
      ) : machines.length === 0 ? (
        <span className="workspace-empty">No machines enrolled</span>
      ) : (
        machines.map((machine) => (
          <div
            className={`workspace-machine-row${machine.online ? "" : " is-offline"}`}
            key={machine.id}
          >
            {/* Two marks, two jobs: the coloured pip is STATUS (and the machine's identity
                colour, which an icon cannot carry), the icon says what kind of thing this
                row is — the same `machine` mark the rest of the app uses. */}
            <span
              className={`machine-dot${machine.online ? "" : " is-offline"}`}
              style={{ backgroundColor: machineColor(machine.id) }}
            />
            <span className="workspace-machine-mark" aria-hidden="true">
              <ItemIcon kind="machine" size={14} />
            </span>
            <strong>{machine.name}</strong>
            <span>{machine.online ? "Online" : "Offline"}</span>
            {machine.online && onCreateTerminal !== undefined ? (
              <button
                className="workspace-machine-create"
                aria-label={`New terminal on ${machine.name}`}
                title={`New terminal on ${machine.name}`}
                onClick={() => onCreateTerminal(machine)}
              >
                <ControlIcon kind="add" size={13} />
              </button>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
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
