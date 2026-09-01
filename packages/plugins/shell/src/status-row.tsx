import { useWorkspaceShell, type WorkspaceSidebarState } from "@manifold/plugin/hooks";
import type { ReactElement } from "react";

/**
 * `core.shell.status` — the connection and the last save, as a PLAIN row near the foot of the
 * rail. Ambient and visually quiet on purpose: it is the answer to "is this window still
 * talking to the server", which a reader wants available and never wants shouted at.
 *
 * It renders NOTHING in two cases, and both are the row's own judgement rather than the
 * stack's: with no container mounted there is no connection to report, and a rail collapsed
 * to icons has no width for a status line — a dot alone would say "something is happening"
 * without saying what, which is worse than the absence. A plain row that draws nothing is a
 * legitimate row; the stack still holds its seat, so the arrangement and the D4′ placeholder
 * are unaffected either way.
 *
 * The two `data-testid`s are gate contracts (REGISTRY.md §Gate contracts): every browser gate
 * waits on `connection-state` reading "Open" before asserting anything else, which is why the
 * word is a declared attribute and not a class or a position.
 */
function StatusLine({
  status,
  savedAt,
  rev,
}: Pick<WorkspaceSidebarState, "status" | "savedAt" | "rev">): ReactElement {
  const savedLabel = savedAt === null ? "Not saved yet" : new Date(savedAt).toLocaleTimeString();
  const statusLabel = status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <div
      className="sidebar-status"
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

export function StatusRow(): ReactElement | null {
  const { sidebarOpen, workspace } = useWorkspaceShell();
  if (!sidebarOpen || workspace === null) return null;
  return <StatusLine status={workspace.status} savedAt={workspace.savedAt} rev={workspace.rev} />;
}
