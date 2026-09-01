import "./styles.css";
import { MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { SectionProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ItemIcon, Stack } from "@manifold/plugin/ui";
import { useCallback, type ReactElement } from "react";

/**
 * The Machines section's browser half. Self-contained by construction: it asks the workspace
 * what machines exist through `host.client` and re-asks when the fleet's own node says
 * something happened — a machine enrolled, came online, went offline — so nothing about it
 * depends on which renderer, or whether any renderer, is mounted beside it.
 *
 * The "+" is the one affordance it does not own. A terminal is born INSIDE a container, and
 * only the mounted view knows how its discipline authors one, so the button asks
 * `host.authoring` and is simply absent when nothing on screen can answer — exactly the
 * behaviour the shell had when it passed `onCreateTerminal` down or left it undefined. It
 * carries no `data-action` because it dispatches no action: authoring is document/room
 * traffic this wave, and a `data-action` naming nothing would be a lie the gate would catch.
 */

/**
 * The FALLBACK cadence (ADR 0012, wave 2). Machine liveness is a subscription on the fleet's
 * collection node; this is what the section falls back to while there is no session channel
 * to carry one, and a live workspace never pays it.
 */
const MACHINE_POLL_MS = 5_000;

/** 14px to match the sidebar's row rhythm; the stroke weight is the vocabulary's own. */
const ROW_ICON_SIZE = 14;

export function MachinesSection({ host }: SectionProps): ReactElement {
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    MACHINE_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
    },
  );
  const authoring = host.authoring;
  const online = machines?.filter((machine) => machine.online).length ?? 0;

  return (
    <Stack className="sidebar-section-content" gap="0.35rem">
      {/* The count used to live in the section header, which is chrome the shell owns; a
          section now says everything it has to say inside its own body. */}
      <span className="sidebar-section-count">
        {online}/{machines?.length ?? 0} online
      </span>
      <Stack gap="0.2rem" data-testid="machines-rail">
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
                <ItemIcon kind="machine" size={ROW_ICON_SIZE} />
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
                  <ControlIcon kind="add" size={ROW_ICON_SIZE} />
                </button>
              ) : null}
            </div>
          ))
        )}
      </Stack>
    </Stack>
  );
}
