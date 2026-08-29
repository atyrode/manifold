import type { MachineSummary, TerminalPoolEntry } from "@manifold/protocol";

/** Drag payload carrying a parked session id between the sidebar pool, pads, and the canvas. */
export const TERMINAL_DRAG_MIME = "application/x-manifold-terminal";

interface TerminalPoolSectionProps {
  readonly terminals: readonly TerminalPoolEntry[];
  readonly machines: readonly MachineSummary[];
  readonly onKill: (sessionId: string) => void;
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="m19 6-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

/** Workspace-global pool of pad-less terminal sessions; rows drag onto pads and the canvas. */
export function TerminalPoolSection({ terminals, machines, onKill }: TerminalPoolSectionProps) {
  return (
    <details
      className="workspace-sidebar-section workspace-terminals"
      data-testid="terminals-section"
      open
    >
      <summary>
        <span>Terminals</span>
        <span>{terminals.length}</span>
      </summary>
      <div className="workspace-sidebar-section-content">
        <div className="workspace-list" data-testid="terminal-pool-list">
          {terminals.length === 0 ? (
            <span className="terminal-pool-empty">No parked terminals</span>
          ) : (
            terminals.map((entry) => {
              const machineName =
                machines.find((machine) => machine.id === entry.machineId)?.name ?? entry.machineId;
              return (
                <div
                  className={`terminal-pool-row${entry.status === "exited" ? " is-exited" : ""}`}
                  data-session-id={entry.id}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(TERMINAL_DRAG_MIME, entry.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  key={entry.id}
                >
                  <span
                    className={`session-state ${entry.status === "running" ? "is-running" : ""}`}
                    title={entry.status}
                    aria-hidden="true"
                  >
                    {entry.status === "running" ? "●" : "○"}
                  </span>
                  <span className="terminal-pool-label">
                    <strong>{machineName}</strong>
                    <span>
                      {entry.id.slice(0, 8)} · {new Date(entry.createdAt).toLocaleTimeString()}
                    </span>
                  </span>
                  <button
                    className="workspace-action is-remove"
                    type="button"
                    title="Kill parked terminal"
                    aria-label="Kill parked terminal"
                    onClick={() => onKill(entry.id)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </details>
  );
}
