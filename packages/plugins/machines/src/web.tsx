import "./styles.css";
import { usePolledResource } from "@manifold/plugin/hooks";
import type { SectionProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { Plus, Server } from "lucide-react";
import { useCallback, type ReactElement } from "react";

/**
 * The Machines section's browser half. Self-contained by construction: it asks the workspace
 * what machines exist through `host.client` and polls at the cadence the shell used to poll
 * for it, so nothing about it depends on which renderer — or whether any renderer — is
 * mounted beside it.
 *
 * The "+" is the one affordance it does not own. A terminal is born INSIDE a container, and
 * only the mounted view knows how its discipline authors one, so the button asks
 * `host.authoring` and is simply absent when nothing on screen can answer — exactly the
 * behaviour the shell had when it passed `onCreateTerminal` down or left it undefined. It
 * carries no `data-action` because it dispatches no action: authoring is document/room
 * traffic this wave, and a `data-action` naming nothing would be a lie the gate would catch.
 */

/** The workspace has no event channel yet; when it does this becomes a subscription. */
const MACHINE_POLL_MS = 5_000;

/** 14px to match the sidebar's row rhythm; 1.75 is the app's one stroke weight. */
const ROW_ICON = { size: 14, strokeWidth: 1.75, absoluteStrokeWidth: true } as const;

export function MachinesSection({ host }: SectionProps): ReactElement {
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    MACHINE_POLL_MS,
    { initial: null },
  );
  const authoring = host.authoring;
  const online = machines?.filter((machine) => machine.online).length ?? 0;

  return (
    <div className="sidebar-section-content workspace-machines">
      {/* The count used to live in the section header, which is chrome the shell owns; a
          section now says everything it has to say inside its own body. */}
      <span className="sidebar-section-count">
        {online}/{machines?.length ?? 0} online
      </span>
      <div className="sidebar-section-list" data-testid="machines-rail">
        {machines === null ? (
          <span className="sidebar-section-empty">Loading machines…</span>
        ) : machines.length === 0 ? (
          <span className="sidebar-section-empty">No machines enrolled</span>
        ) : (
          machines.map((machine) => (
            <div
              className={`sidebar-machine-row${machine.online ? "" : " is-offline"}`}
              key={machine.id}
            >
              {/* The pip is STATUS; the icon says what kind of thing this row is. */}
              <span
                className={`machine-dot${machine.online ? "" : " is-offline"}`}
                aria-hidden="true"
              />
              <span className="sidebar-machine-mark" aria-hidden="true">
                <Server className="mf-icon" focusable="false" {...ROW_ICON} />
              </span>
              <strong>{machine.name}</strong>
              <span>{machine.online ? "Online" : "Offline"}</span>
              {machine.online && authoring !== null ? (
                <button
                  className="sidebar-machine-create"
                  type="button"
                  aria-label={`New terminal on ${machine.name}`}
                  title={`New terminal on ${machine.name}`}
                  onClick={() => authoring.createTerminal(machine)}
                >
                  <Plus className="mf-icon" focusable="false" {...ROW_ICON} />
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
