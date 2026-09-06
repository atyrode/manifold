import "./styles.css";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { SectionProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ItemIcon, Stack } from "@manifold/ui";
import { useCallback, useState, type ReactElement } from "react";
import { MACHINES_FORGET_ACTION, MACHINES_REVOKE_ACTION } from "./index.ts";

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
 *
 * Withdrawal and forgetting are separate, two-press acts: a live credential can only be
 * revoked; a revoked row can be forgotten, subject to the server's terminal and drain checks.
 */

/** 14px to match the sidebar's row rhythm; the stroke weight is the vocabulary's own. */
const ROW_ICON_SIZE = 14;

export function MachinesSection({ host }: SectionProps): ReactElement {
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
    },
  );
  const caps = host.client.selfCaps();
  const mayRevoke = caps.includes("*") || caps.includes("machines:mint");
  /**
   * Which row's withdrawal is ARMED — one slot, because arming a second must disarm the
   * first — and which is in flight. The list itself is server-owned: nothing here paints a
   * withdrawal it only hopes happened, it asks the fleet again.
   */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const authoring = host.authoring;
  const online = machines?.filter((machine) => machine.online).length ?? 0;

  const administer = async (machine: MachineSummary): Promise<void> => {
    const machineId = machine.id;
    setPendingId(machineId);
    setFailure(null);
    try {
      const outcome = await host.client.action(
        machine.revoked === true ? MACHINES_FORGET_ACTION : MACHINES_REVOKE_ACTION,
        { machineId },
      );
      if (!outcome.ok) setFailure(outcome.denial.message);
      else refresh();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not administer the machine");
    } finally {
      setPendingId(null);
      setArmedId(null);
    }
  };

  return (
    <Stack className="sidebar-section-content" gap="0.35rem">
      {/* The count used to live in the section header, which is chrome the shell owns; a
          section now says everything it has to say inside its own body. */}
      <span className="sidebar-section-count">
        {online}/{machines?.length ?? 0} online
      </span>
      {failure === null ? null : <span className="machine-failure">{failure}</span>}
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
              {/* `Revoked` outranks liveness in the label because it explains it: a machine
                  whose credential is gone is offline as a CONSEQUENCE, and reading "Offline"
                  would send an operator looking for a network problem. */}
              <span className="machine-state">
                {machine.revoked === true ? "Revoked" : machine.online ? "Online" : "Offline"}
              </span>
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
              {mayRevoke ? (
                <button
                  className="machine-revoke"
                  type="button"
                  data-action={
                    machine.revoked === true ? MACHINES_FORGET_ACTION : MACHINES_REVOKE_ACTION
                  }
                  data-testid={machine.revoked === true ? "machine-forget" : "machine-revoke"}
                  data-confirming={armedId === machine.id}
                  aria-label={
                    machine.revoked === true
                      ? `${armedId === machine.id ? "Confirm forgetting" : "Forget"} ${machine.name}`
                      : armedId === machine.id
                        ? `Confirm withdrawing ${machine.name}'s credential`
                        : `Withdraw ${machine.name}'s credential`
                  }
                  title={
                    machine.revoked === true
                      ? `Forget ${machine.name}; retained terminals or a pending drain must be cleared first`
                      : armedId === machine.id
                        ? `Press again to cut ${machine.name} off; the row stays and re-enrolling brings it back`
                        : `Withdraw ${machine.name}'s credential`
                  }
                  disabled={pendingId !== null}
                  onBlur={() => {
                    if (armedId === machine.id) setArmedId(null);
                  }}
                  onClick={() => {
                    if (armedId !== machine.id) {
                      setArmedId(machine.id);
                      return;
                    }
                    void administer(machine);
                  }}
                >
                  {machine.revoked === true ? (
                    "Forget"
                  ) : (
                    <ControlIcon kind="revoke" size={ROW_ICON_SIZE} />
                  )}
                </button>
              ) : null}
            </div>
          ))
        )}
      </Stack>
    </Stack>
  );
}
