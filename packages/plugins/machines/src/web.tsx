import "./styles.css";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { SectionProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ItemIcon, Stack } from "@manifold/plugin/ui";
import { useCallback, useState, type ReactElement } from "react";
import { MACHINES_REVOKE_ACTION } from "./index.ts";

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
 * WITHDRAWAL is the one affordance here that spends authority (ADR 0019 §3), and it is the
 * fleet's half of the credential question `core.access`' Sessions section answers for people.
 * It lives here rather than there because the concept is this plugin's: a machine is what it
 * enrolls, so a machine's credential is what it withdraws. Two-press, because it cuts a box
 * off the canvas; and it does NOT remove the row, because withdrawing a credential and
 * forgetting a machine are different verbs — a withdrawn machine stays listed as `Revoked`
 * and comes back through an `enroll { rotateToken: true }` re-provision.
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

  const revoke = async (machineId: string): Promise<void> => {
    setPendingId(machineId);
    setFailure(null);
    try {
      const outcome = await host.client.action(MACHINES_REVOKE_ACTION, { machineId });
      if (!outcome.ok) setFailure(outcome.denial.message);
      else refresh();
    } catch (reason: unknown) {
      setFailure(reason instanceof Error ? reason.message : "Could not withdraw the credential");
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
              {/* Absent once withdrawn rather than disabled: "press this to do nothing" is
                  not an affordance, and the row already says `Revoked`. */}
              {mayRevoke && machine.revoked !== true ? (
                <button
                  className="machine-revoke"
                  type="button"
                  data-action={MACHINES_REVOKE_ACTION}
                  data-testid="machine-revoke"
                  data-confirming={armedId === machine.id}
                  aria-label={
                    armedId === machine.id
                      ? `Confirm withdrawing ${machine.name}'s credential`
                      : `Withdraw ${machine.name}'s credential`
                  }
                  title={
                    armedId === machine.id
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
                    void revoke(machine.id);
                  }}
                >
                  <ControlIcon kind="revoke" size={ROW_ICON_SIZE} />
                </button>
              ) : null}
            </div>
          ))
        )}
      </Stack>
    </Stack>
  );
}
