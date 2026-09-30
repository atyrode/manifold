import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { PortableSectionProps } from "@manifold/plugin";
import type { MachineSummary, UiIcon } from "@manifold/protocol";
import { Button, Cluster, Empty, ItemIcon, Spinner, Stack, Text } from "@manifold/ui";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { MACHINES_FORGET_ACTION, MACHINES_REVOKE_ACTION } from "./names.ts";

/**
 * The Machines section's browser half. Self-contained by construction: it asks the workspace
 * what machines exist through `host.client` and re-asks when the fleet's own node says
 * something happened — a machine enrolled, came online, went offline — so nothing about it
 * depends on which renderer, or whether any renderer, is mounted beside it.
 *
 * ONE SOURCE, BOTH EXECUTION MODES (ADR 0053). It is written against the portable host slice
 * (`PortableSectionProps`) and paints only with the design system's component vocabulary, so
 * the same component renders in the page when this plugin runs in-realm and in its own Worker
 * when it runs hardened, where the host paints the tree it sends through those same
 * components. Nothing here is authority: the capability read only decides which controls to
 * OFFER, and every press goes to a door that checks the live caller itself.
 *
 * The "+" is the one affordance it does not own. A terminal is born INSIDE a container, and
 * only the mounted view knows how its discipline authors one, so the button asks
 * `host.authoring` and is simply absent when nothing on screen can answer — exactly the
 * behaviour the shell had when it passed `onCreateTerminal` down or left it undefined. Its
 * `data-action` names `core.terminals.open`, the door the mounted view's birth dispatches.
 *
 * Withdrawal and forgetting are separate, two-press acts on one control per row: the first
 * press ARMS it, the second acts, and focus leaving an armed control disarms it. A live
 * credential can only be revoked; a revoked row can be forgotten, subject to the server's
 * terminal and drain checks.
 */

/** 14px to match the sidebar's row rhythm; the stroke weight is the vocabulary's own. */
const ROW_ICON_SIZE = 14;
const CREATE_ICON: UiIcon = { family: "control", name: "add", size: ROW_ICON_SIZE };
const REVOKE_ICON: UiIcon = { family: "control", name: "revoke", size: ROW_ICON_SIZE };

function refusalMessage(refusal: NonNullable<MachineSummary["lastRefusal"]>): string {
  const remedy = (() => {
    switch (refusal.code) {
      case 4003:
        return "owner continuity failed; inspect retained terminals before replacing this node";
      case 4401:
        return "authentication failed; re-enroll this node";
      case 4403:
        return "credential expired or was revoked; rotate or re-enroll this node";
      case 4409:
        return "protocol mismatch; update this node to the hub build";
      default: {
        const exhaustive: never = refusal.code;
        return exhaustive;
      }
    }
  })();
  return `Admission refused (${String(refusal.code)}): ${remedy}. Last attempt ${new Date(refusal.at).toLocaleString()}.`;
}

export function MachinesSection({ host }: PortableSectionProps): ReactElement {
  const fetchMachines = useCallback(() => host.client.machines(), [host.client]);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    fetchMachines,
    FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
      requiresWorkspaceEvents: true,
    },
  );
  const subscribeAuthority = useCallback(
    (notify: () => void) => host.client.onAuthorityChange(notify),
    [host.client],
  );
  const readWorkspaceCaps = useCallback(() => host.client.workspaceCaps(), [host.client]);
  const caps = useSyncExternalStore(subscribeAuthority, readWorkspaceCaps, readWorkspaceCaps);
  const mayRevoke = caps.includes("*") || caps.includes("machines:mint");
  /**
   * Which row's withdrawal is ARMED — one slot, because arming a second must disarm the
   * first — and which is in flight. The list itself is server-owned: nothing here paints a
   * withdrawal it only hopes happened, it asks the fleet again.
   */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mutationClient, setMutationClient] = useState(host.client);
  if (mutationClient !== host.client) {
    setMutationClient(host.client);
    setPendingId(null);
    setArmedId(null);
    setFailure(null);
  }
  const mutationEpoch = useRef(0);
  useLayoutEffect(() => {
    mutationEpoch.current += 1;
    const off = host.client.onAuthorityChange(() => {
      mutationEpoch.current += 1;
      // Retire pending effects on unknown transport authority without calling it withdrawal.
      if (host.client.status !== "open") return;
      setPendingId(null);
      setArmedId(null);
    });
    return () => {
      mutationEpoch.current += 1;
      off();
    };
  }, [host.client]);
  const authoring = host.authoring;
  const online = machines?.filter((machine) => machine.online).length ?? 0;

  const administer = async (machine: MachineSummary): Promise<void> => {
    const machineId = machine.id;
    const epoch = mutationEpoch.current;
    setPendingId(machineId);
    setFailure(null);
    try {
      const outcome = await host.client.action(
        machine.revoked === true ? MACHINES_FORGET_ACTION : MACHINES_REVOKE_ACTION,
        { machineId },
      );
      if (epoch !== mutationEpoch.current) return;
      if (!outcome.ok) setFailure(outcome.denial.message);
      else refresh();
    } catch (reason: unknown) {
      if (epoch !== mutationEpoch.current) return;
      setFailure(reason instanceof Error ? reason.message : "Could not administer the machine");
    } finally {
      if (epoch === mutationEpoch.current) {
        setPendingId(null);
        setArmedId(null);
      }
    }
  };

  return (
    <Stack gap="0.35rem">
      {/* The count used to live in the section header, which is chrome the shell owns; a
          section now says everything it has to say inside its own body. */}
      <Text tone="muted">
        {online}/{machines?.length ?? 0} online
      </Text>
      {failure === null ? null : (
        <Text tone="danger" wrap role="alert">
          {failure}
        </Text>
      )}
      <Stack gap="0.2rem" data-testid="machines-rail">
        {machines === null ? (
          <Spinner label="Loading machines…" />
        ) : machines.length === 0 ? (
          <Empty>No machines enrolled</Empty>
        ) : (
          machines.map((machine) => {
            const revoked = machine.revoked === true;
            const armed = armedId === machine.id;
            return (
              <Stack key={machine.id} gap="0.15rem">
                <Cluster gap="0.45rem">
                  <ItemIcon kind="machine" size={ROW_ICON_SIZE} />
                  {/* The name takes the row and truncates in place; the full name is its title. */}
                  <Text
                    strong
                    grow
                    tone={machine.online ? undefined : "muted"}
                    title={machine.name}
                  >
                    {machine.name}
                  </Text>
                  {/* `Revoked` outranks liveness in the label because it explains it: a machine
                      whose credential is gone is offline as a CONSEQUENCE, and reading "Offline"
                      would send an operator looking for a network problem. */}
                  <Text tone="muted">
                    {revoked ? "Revoked" : machine.online ? "Online" : "Offline"}
                  </Text>
                  {machine.online &&
                  machine.terminalExecution === "unconfined" &&
                  authoring !== null ? (
                    <Button
                      icon={CREATE_ICON}
                      iconOnly
                      tone="accent"
                      data-action="core.terminals.open"
                      aria-label={`New terminal on ${machine.name}`}
                      title={`New terminal on ${machine.name}`}
                      onClick={() => {
                        /* A refusal is the mounted view's to report; only a failure to ask
                           at all lands here, rather than escaping as an unhandled rejection. */
                        authoring.createTerminal(machine).catch((reason: unknown) => {
                          setFailure(
                            reason instanceof Error ? reason.message : "Could not open a terminal",
                          );
                        });
                      }}
                    >
                      New terminal
                    </Button>
                  ) : null}
                  {mayRevoke ? (
                    <Button
                      icon={revoked ? undefined : REVOKE_ICON}
                      iconOnly={!revoked}
                      tone={armed ? "danger" : "muted"}
                      data-action={revoked ? MACHINES_FORGET_ACTION : MACHINES_REVOKE_ACTION}
                      data-testid={revoked ? "machine-forget" : "machine-revoke"}
                      aria-label={
                        revoked
                          ? `${armed ? "Confirm forgetting" : "Forget"} ${machine.name}`
                          : armed
                            ? `Confirm withdrawing ${machine.name}'s credential`
                            : `Withdraw ${machine.name}'s credential`
                      }
                      title={
                        revoked
                          ? `Forget ${machine.name}; retained terminals or a pending drain must be cleared first`
                          : armed
                            ? `Press again to cut ${machine.name} off; the row stays and re-enrolling brings it back`
                            : `Withdraw ${machine.name}'s credential`
                      }
                      disabled={pendingId !== null}
                      onBlur={() =>
                        setArmedId((current) => (current === machine.id ? null : current))
                      }
                      onClick={() => {
                        if (!armed) {
                          setArmedId(machine.id);
                          return;
                        }
                        void administer(machine);
                      }}
                    >
                      {revoked ? "Forget" : "Withdraw"}
                    </Button>
                  ) : null}
                </Cluster>
                {!machine.online && !revoked && machine.lastRefusal !== undefined ? (
                  <Text tone="danger" wrap role="status">
                    {refusalMessage(machine.lastRefusal)}
                  </Text>
                ) : null}
              </Stack>
            );
          })
        )}
      </Stack>
    </Stack>
  );
}
