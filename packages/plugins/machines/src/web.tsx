import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { PortableSectionProps } from "@manifold/plugin";
import type { MachineSummary, UiIcon } from "@manifold/protocol";
import {
  Button,
  Cluster,
  Empty,
  Input,
  ItemIcon,
  Select,
  Spinner,
  Stack,
  Text,
} from "@manifold/ui";
import { MachineEnrollResponseSchema } from "@manifold/protocol";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import {
  MACHINES_ENROLL_ACTION,
  MACHINES_FORGET_ACTION,
  MACHINES_LIST_HOST_VIEWS_ACTION,
  MACHINES_REMOVE_HOST_VIEW_ACTION,
  MACHINES_REVOKE_ACTION,
  MACHINES_SET_HOST_VIEW_ACTION,
} from "./names.ts";
import { HostViewsSchema, type HostView, type HostViews } from "./host-views.ts";
import { HostViewEditor } from "./host-view-editor.tsx";

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

const GOVERNED_SHELL_ADVICE = "Enroll a normal OS account to open ordinary shells.";
const UNKNOWN_SHELL_ADVICE =
  "An owner declaration is required; shell authority cannot be inferred.";

function shellUnavailable(machine: MachineSummary, canPlace: boolean): string | null {
  if (machine.revoked === true)
    return "Credential withdrawn; no new terminals can use this enrollment.";
  if (machine.draining === true)
    return "New terminals paused; existing terminals have not been terminated.";
  if (!machine.online)
    return "Reconnect the account transport; its retained owner is not destroyed by disconnection.";
  if (machine.terminalExecution === "governed") return GOVERNED_SHELL_ADVICE;
  if (machine.terminalExecution !== "unconfined") return UNKNOWN_SHELL_ADVICE;
  if (!canPlace) return "Open a canvas or composition to place a terminal.";
  return null;
}

function ShellSetup(): ReactElement {
  return (
    <Stack gap="0.25rem" data-testid="shell-account-setup">
      <Text strong>Normal OS account setup</Text>
      <Text wrap>
        The OS account running the retained owner determines shell authority, including its home,
        configured shell, groups and profile commands. Enrollment alone does not install or start
        it. No custom plugin, Agent profile or governed runtime is required.
      </Text>
      <Text wrap>
        Linux: install a compatible immutable manifold-agent. Run manifold-agent --terminal-host in
        its own systemd user service with the account's HOME, SHELL, profile PATH and
        MANIFOLD_TERMINAL_HOST_SOCKET. Run the separate transport service with the same socket,
        MANIFOLD_SERVER_URL, the distinct MANIFOLD_MACHINE_NAME and a privately provisioned
        MANIFOLD_MACHINE_TOKEN_FILE.
      </Text>
      <Text wrap>
        Darwin: use two independently loaded launchd user jobs for the same owner and transport. Use
        literal account home, shell and socket paths; launchd does not expand shell variables. Start
        the tokenless retained owner first and give the private token file only to the transport.
      </Text>
      <Text wrap>
        NixOS: enable services.manifold and services.manifold.shell.enable, then explicitly set
        shell.user, machineName, serverUrl, tokenFile and stateDirectory for an already-declared OS
        account. The shell role is opt-in and independent of hub/execution roles; it neither creates
        an account nor enrolls, rotates or repairs its token.
      </Text>
      <Text tone="muted" wrap>
        Full core instructions: https://github.com/atyrode/manifold/blob/main/docs/ENROLL.md and
        docs/SELF-HOST.md#normal-account-shells-nixos. Wait for this inventory to report an online
        ordinary-shell owner before opening a terminal.
      </Text>
    </Stack>
  );
}

export function MachinesSection({ host }: PortableSectionProps): ReactElement {
  const [inventoryFailure, setInventoryFailure] = useState<string | null>(null);
  const [groupingFailure, setGroupingFailure] = useState<string | null>(null);
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
      onError: (reason) =>
        setInventoryFailure(
          reason instanceof Error ? reason.message : "Could not read machine inventory",
        ),
      onSuccess: () => setInventoryFailure(null),
    },
  );
  const fetchHostViews = useCallback(async () => {
    const outcome = await host.client.action(MACHINES_LIST_HOST_VIEWS_ACTION, {});
    if (!outcome.ok) throw new Error(outcome.denial.message);
    const parsed = HostViewsSchema.safeParse(outcome.result);
    if (!parsed.success) throw new Error("Could not verify host grouping inventory");
    return parsed.data;
  }, [host.client]);
  const {
    value: hostViews,
    setValue: publishHostViews,
    refresh: refreshHostViews,
  } = usePolledResource<HostViews | null>(fetchHostViews, FALLBACK_POLL_MS, {
    key: MACHINES_LIST_HOST_VIEWS_ACTION,
    initial: null,
    topics: host.topics.machines,
    events: host.client,
    requiresWorkspaceEvents: true,
    onError: (reason) =>
      setGroupingFailure(
        reason instanceof Error ? reason.message : "Could not read host groupings",
      ),
    onSuccess: () => setGroupingFailure(null),
  });
  const subscribeAuthority = useCallback(
    (notify: () => void) => host.client.onAuthorityChange(notify),
    [host.client],
  );
  const readWorkspaceCaps = useCallback(() => host.client.workspaceCaps(), [host.client]);
  const caps = useSyncExternalStore(subscribeAuthority, readWorkspaceCaps, readWorkspaceCaps);
  const mayAdminister = caps.includes("*") || caps.includes("machines:mint");
  const [armedId, setArmedId] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<HostView | null | undefined>(undefined);
  const [chooser, setChooser] = useState<{ hostId: string; machineId: string | null } | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [enrollmentName, setEnrollmentName] = useState("");
  const [enrollmentNotice, setEnrollmentNotice] = useState<string | null>(null);
  const [credential, setCredential] = useState<{
    machineId: string;
    name: string;
    token: string;
  } | null>(null);
  const [binding, setBinding] = useState({ client: host.client, ordinal: 0 });
  // State is owned by this client, not reset by a cascading effect after a successor paints.
  if (binding.client !== host.client) {
    setBinding({ client: host.client, ordinal: binding.ordinal + 1 });
    setArmedId(null);
    setPendingKey(null);
    setFailure(null);
    setCredential(null);
    setEditing(undefined);
    setChooser(null);
    setSetupOpen(false);
    setEnrollmentName("");
    setEnrollmentNotice(null);
    setInventoryFailure(null);
    setGroupingFailure(null);
    setExpanded(new Set());
  }
  const mutationEpoch = useRef(0);
  useLayoutEffect(() => {
    mutationEpoch.current += 1;
    const off = host.client.onAuthorityChange(() => {
      mutationEpoch.current += 1;
      setPendingKey(null);
      setArmedId(null);
      // Temporary unknown authority retires pending results, not a proven administration grant.
      if (host.client.status !== "open") return;
      const current = host.client.workspaceCaps();
      if (!current.includes("*") && !current.includes("machines:mint")) {
        setCredential(null);
        setEditing(undefined);
        setSetupOpen(false);
      }
    });
    return () => {
      mutationEpoch.current += 1;
      off();
    };
  }, [host.client]);
  const inventory = useMemo(() => {
    const byId = new Map<string, MachineSummary>();
    const names = new Set<string>();
    let online = 0;
    let hasShell = false;
    for (const machine of machines ?? []) {
      byId.set(machine.id, machine);
      names.add(machine.name);
      if (machine.online && machine.revoked !== true) online += 1;
      if (machine.terminalExecution === "unconfined") hasShell = true;
    }
    return { byId, names, online, hasShell };
  }, [machines]);
  const groups = groupingFailure === null ? hostViews : null;
  const grouping = useMemo(() => {
    const byId = new Map<string, HostView>();
    const assigned = new Set<string>();
    for (const view of groups?.hosts ?? []) {
      byId.set(view.id, view);
      for (const member of view.members) assigned.add(member.machineId);
    }
    return { byId, assigned };
  }, [groups]);
  const busy = pendingKey !== null;
  const inventoryUsable = machines !== null && inventoryFailure === null;
  const canGroup = mayAdminister && groups !== null && inventoryUsable;
  const authoring = host.authoring;
  const perform = async (
    key: string,
    action: string,
    args: unknown,
    accept?: (result: unknown) => void,
  ): Promise<boolean> => {
    const epoch = mutationEpoch.current;
    setPendingKey(key);
    setFailure(null);
    try {
      const outcome = await host.client.action(action, args);
      if (epoch !== mutationEpoch.current) return false;
      if (!outcome.ok) {
        setFailure(outcome.denial.message);
        return false;
      }
      accept?.(outcome.result);
      refresh();
      refreshHostViews();
      return true;
    } catch (reason: unknown) {
      if (epoch === mutationEpoch.current)
        setFailure(reason instanceof Error ? reason.message : "Could not administer the fleet");
      return false;
    } finally {
      if (epoch === mutationEpoch.current) {
        setPendingKey(null);
        setArmedId(null);
      }
    }
  };
  const acceptGrouping = (result: unknown): void => {
    const parsed = HostViewsSchema.safeParse(result);
    if (!parsed.success) throw new Error("Could not verify the committed grouping");
    publishHostViews(parsed.data);
  };
  const launch = async (machine: MachineSummary): Promise<void> => {
    if (!inventoryUsable || authoring === null || shellUnavailable(machine, true) !== null) return;
    const epoch = mutationEpoch.current;
    setPendingKey(`terminal:${machine.id}`);
    setFailure(null);
    try {
      await authoring.createTerminal(machine);
    } catch (reason: unknown) {
      if (epoch === mutationEpoch.current)
        setFailure(reason instanceof Error ? reason.message : "Could not open a terminal");
    } finally {
      if (epoch === mutationEpoch.current) setPendingKey(null);
    }
  };
  const renderMachine = (machine: MachineSummary, accountLabel?: string): ReactElement => {
    const revoked = machine.revoked === true;
    const armed = armedId === machine.id;
    const unavailable = inventoryUsable
      ? shellUnavailable(machine, authoring !== null)
      : "Machine inventory unavailable; wait for a successful current read.";
    return (
      <Stack key={machine.id} gap="0.15rem">
        <Cluster gap="0.45rem">
          <ItemIcon kind="machine" size={ROW_ICON_SIZE} />
          <Text strong grow tone={machine.online ? undefined : "muted"} title={machine.name}>
            {accountLabel ?? machine.name}
          </Text>
          <Text tone="muted">{machine.online ? "Online" : "Offline"}</Text>
          {revoked ? <Text tone="muted">Revoked</Text> : null}
          <Button
            icon={CREATE_ICON}
            iconOnly
            tone="accent"
            data-action="core.terminals.open"
            aria-label={`New terminal on ${machine.name}`}
            title={unavailable ?? `New terminal on ${machine.name}`}
            disabled={busy || unavailable !== null}
            onClick={() => void launch(machine)}
          >
            New terminal
          </Button>
          {mayAdminister ? (
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
              disabled={busy}
              onBlur={() => setArmedId((current) => (current === machine.id ? null : current))}
              onClick={() => {
                if (!armed) {
                  setArmedId(machine.id);
                  return;
                }
                void perform(
                  machine.id,
                  revoked ? MACHINES_FORGET_ACTION : MACHINES_REVOKE_ACTION,
                  { machineId: machine.id },
                );
              }}
            >
              {revoked ? "Forget" : "Withdraw"}
            </Button>
          ) : null}
        </Cluster>
        {accountLabel === undefined ? null : (
          <Text tone="muted" wrap>
            Enrollment: {machine.name}
          </Text>
        )}
        <Text tone="muted">
          {machine.terminalExecution === "unconfined"
            ? "Ordinary shells"
            : machine.terminalExecution === "governed"
              ? "Governed workloads only"
              : "Shell capability unknown"}
        </Text>
        {!revoked &&
        machine.terminalExecution !== "unconfined" &&
        (!machine.online || machine.draining === true) ? (
          <Text tone="muted" wrap>
            {machine.terminalExecution === "governed"
              ? GOVERNED_SHELL_ADVICE
              : UNKNOWN_SHELL_ADVICE}
          </Text>
        ) : null}
        {unavailable === null ? null : (
          <Text tone="muted" wrap>
            {unavailable}
          </Text>
        )}
        {machine.draining === true && revoked ? (
          <Text tone="muted" wrap>
            New terminals paused; retained terminals remain.
          </Text>
        ) : null}
        {!machine.online && !revoked && machine.draining === true ? (
          <Text tone="muted" wrap>
            Reconnect the account transport; disconnection does not destroy its retained owner.
          </Text>
        ) : null}
        {!machine.online && !revoked && machine.lastRefusal !== undefined ? (
          <Text tone="danger" wrap role="status">
            {refusalMessage(machine.lastRefusal)}
          </Text>
        ) : null}
      </Stack>
    );
  };
  const chosenHost = chooser === null ? undefined : grouping.byId.get(chooser.hostId);
  const selectedMember = chosenHost?.members.find(
    (member) => member.machineId === chooser?.machineId,
  );
  const chosenMachine =
    selectedMember === undefined ? undefined : inventory.byId.get(selectedMember.machineId);
  const name = enrollmentName.trim();
  const alreadyEnrolled = inventory.names.has(name);
  return (
    <Stack gap="0.35rem">
      <Text tone="muted">
        {machines === null
          ? "Machine inventory not yet available"
          : `${inventoryFailure === null ? "" : "Last-known inventory: "}${inventory.online}/${machines.length} online`}
      </Text>
      {inventoryFailure === null ? null : (
        <Text tone="danger" wrap role="alert">
          {inventoryFailure}
        </Text>
      )}
      {failure === null ? null : (
        <Text tone="danger" wrap role="alert">
          {failure}
        </Text>
      )}
      {groupingFailure === null ? null : (
        <Text tone="muted" wrap role="status">
          Host grouping unavailable: {groupingFailure}. Showing individual enrollments.
        </Text>
      )}
      {hostViews === null && groupingFailure === null && machines !== null ? (
        <Text tone="muted">Loading host groupings; individual enrollments remain available.</Text>
      ) : null}
      {authoring === null ? (
        <Text tone="muted" wrap>
          Open a canvas or composition to place a terminal.
        </Text>
      ) : null}
      <Stack gap="0.3rem" data-testid="machines-rail">
        {machines === null ? (
          <Spinner label="Loading machines…" />
        ) : machines.length === 0 && (groups?.hosts.length ?? 0) === 0 ? (
          <Empty>No machines enrolled</Empty>
        ) : (
          <>
            {groups?.hosts.map((view) => {
              let online = 0;
              for (const member of view.members) {
                const machine = inventory.byId.get(member.machineId);
                if (machine?.online === true && machine.revoked !== true) online += 1;
              }
              const open = expanded.has(view.id);
              const singleMachine =
                view.members.length === 1
                  ? inventory.byId.get(view.members[0]!.machineId)
                  : undefined;
              const singleUnavailable =
                view.members.length !== 1
                  ? null
                  : !inventoryUsable
                    ? "Machine inventory unavailable; wait for a successful current read."
                    : singleMachine === undefined
                      ? "Enrollment unavailable in the current inventory."
                      : shellUnavailable(singleMachine, authoring !== null);
              return (
                <Stack key={view.id} gap="0.25rem" data-testid={`host-view-${view.id}`}>
                  <Cluster gap="0.35rem">
                    <Button
                      aria-label={`${open ? "Collapse" : "Expand"} accounts for ${view.name}`}
                      expanded={open}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(view.id)) next.delete(view.id);
                          else next.add(view.id);
                          return next;
                        })
                      }
                    >
                      {view.name}
                    </Button>
                    <Button
                      icon={CREATE_ICON}
                      iconOnly
                      tone="accent"
                      data-action="core.terminals.open"
                      aria-label={`New terminal on host ${view.name}`}
                      title={singleUnavailable ?? `New terminal on host ${view.name}`}
                      disabled={busy || singleUnavailable !== null}
                      onClick={() => {
                        if (view.members.length > 1)
                          setChooser({ hostId: view.id, machineId: null });
                        else if (singleMachine !== undefined) void launch(singleMachine);
                      }}
                    >
                      New terminal
                    </Button>
                    {canGroup ? (
                      <Button disabled={busy} onClick={() => setEditing(view)}>
                        Edit grouping
                      </Button>
                    ) : null}
                  </Cluster>
                  <Text tone="muted">
                    {online} of {view.members.length} accounts online
                  </Text>
                  {!open && singleUnavailable !== null ? (
                    <Text tone="muted" wrap>
                      {singleUnavailable}
                    </Text>
                  ) : null}
                  {open
                    ? view.members.map((member) => {
                        const machine = inventory.byId.get(member.machineId);
                        return machine === undefined ? (
                          <Stack key={member.machineId}>
                            <Text strong>{member.accountLabel}</Text>
                            <Text tone="muted">
                              Enrollment unavailable in the current inventory; no shell can be
                              selected.
                            </Text>
                          </Stack>
                        ) : (
                          renderMachine(machine, member.accountLabel)
                        );
                      })
                    : null}
                </Stack>
              );
            })}
            {machines.map((machine) =>
              grouping.assigned.has(machine.id) ? null : renderMachine(machine),
            )}
          </>
        )}
      </Stack>
      {chosenHost === undefined ? null : (
        <Stack gap="0.3rem" data-testid="host-account-chooser">
          <Text strong>Select an account on {chosenHost.name}</Text>
          <Select
            label="Account for new terminal"
            value={selectedMember?.machineId ?? null}
            options={chosenHost.members.map((member) => {
              const machine = inventory.byId.get(member.machineId);
              return {
                value: member.machineId,
                label: `${member.accountLabel} · ${machine?.name ?? "Enrollment unavailable"}${machine === undefined ? "" : ` · ${shellUnavailable(machine, authoring !== null) ?? "Ordinary shell available"}`}`,
              };
            })}
            onChange={(machineId) => setChooser({ hostId: chosenHost.id, machineId })}
          />
          {chosenMachine === undefined ? (
            <Text tone="muted" wrap>
              Choose an explicit account; unavailable accounts are not substituted.
            </Text>
          ) : (
            <Text tone="muted" wrap>
              {shellUnavailable(chosenMachine, authoring !== null) ??
                `Open an ordinary shell as ${chosenMachine.name}.`}
            </Text>
          )}
          <Cluster gap="0.35rem">
            <Button
              tone="accent"
              data-action="core.terminals.open"
              disabled={
                busy ||
                !inventoryUsable ||
                chosenMachine === undefined ||
                shellUnavailable(chosenMachine, authoring !== null) !== null
              }
              onClick={() => {
                if (chosenMachine !== undefined) {
                  setChooser(null);
                  void launch(chosenMachine);
                }
              }}
            >
              Open selected account
            </Button>
            <Button onClick={() => setChooser(null)}>Cancel account selection</Button>
          </Cluster>
        </Stack>
      )}
      {mayAdminister ? (
        <Cluster gap="0.35rem">
          <Button
            data-action={MACHINES_ENROLL_ACTION}
            expanded={setupOpen}
            disabled={busy}
            onClick={() => setSetupOpen((current) => !current)}
          >
            Enroll shell account
          </Button>
          <Button disabled={busy || !canGroup} onClick={() => setEditing(null)}>
            Create host grouping
          </Button>
        </Cluster>
      ) : null}
      {editing === undefined || !canGroup || groups === null || machines === null ? null : (
        <HostViewEditor
          key={`${binding.ordinal}:${editing?.id ?? "new"}`}
          registry={groups}
          machines={machines}
          editing={editing}
          busy={busy}
          save={(view, expectedRevision) =>
            perform(
              "grouping",
              MACHINES_SET_HOST_VIEW_ACTION,
              { expectedRevision, host: view },
              (result) => {
                acceptGrouping(result);
                setEditing(undefined);
              },
            )
          }
          remove={(hostId, expectedRevision) =>
            perform(
              "grouping",
              MACHINES_REMOVE_HOST_VIEW_ACTION,
              { expectedRevision, hostId },
              (result) => {
                acceptGrouping(result);
                setEditing(undefined);
              },
            )
          }
          close={() => setEditing(undefined)}
        />
      )}
      {setupOpen || (machines !== null && !inventory.hasShell) ? <ShellSetup /> : null}
      {setupOpen && mayAdminister ? (
        <Stack gap="0.3rem">
          <Input
            label="Distinct enrollment name"
            value={enrollmentName}
            onChange={(value) => {
              setEnrollmentName(value);
              setEnrollmentNotice(null);
            }}
            disabled={busy}
          />
          {alreadyEnrolled && enrollmentNotice === null ? (
            <Text role="status" wrap>
              Already enrolled. No credential was rotated. Recovery requires a separately confirmed
              rotation.
            </Text>
          ) : null}
          {enrollmentNotice === null ? null : (
            <Text role="status" wrap>
              {enrollmentNotice}
            </Text>
          )}
          <Button
            tone="accent"
            data-action={MACHINES_ENROLL_ACTION}
            disabled={
              busy || machines === null || name.length === 0 || name.length > 120 || alreadyEnrolled
            }
            onClick={() => {
              setCredential(null);
              void perform("enroll", MACHINES_ENROLL_ACTION, { name }, (result) => {
                const parsed = MachineEnrollResponseSchema.safeParse(result);
                if (!parsed.success) throw new Error("Could not verify the enrollment response");
                if (parsed.data.machineToken === undefined)
                  setEnrollmentNotice(
                    "Already enrolled. No credential was rotated. Recovery requires a separately confirmed rotation.",
                  );
                else {
                  setCredential({
                    machineId: parsed.data.machine.id,
                    name: parsed.data.machine.name,
                    token: parsed.data.machineToken,
                  });
                  setEnrollmentNotice(
                    "Enrolled. Provision the existing account and wait for its positive ordinary-shell declaration.",
                  );
                }
              });
            }}
          >
            Enroll this account
          </Button>
        </Stack>
      ) : null}
      {credential === null || !mayAdminister ? null : (
        <Stack
          key={`${binding.ordinal}:${credential.machineId}`}
          gap="0.3rem"
          data-testid="shell-account-credential"
        >
          <Text strong>One-time credential for {credential.name}</Text>
          <Text mono wrap>
            Machine ID: {credential.machineId}
          </Text>
          <Text wrap>
            Select and copy the credential now into its authorized custodian's private token file.
            It is shown once, kept only in this view, and never inserted into a command or URL. The
            retained owner must not receive the transport token.
          </Text>
          <Input
            label="Machine credential"
            value={credential.token}
            readOnly
            mono
            onChange={() => {}}
          />
          <Button onClick={() => setCredential(null)}>Hide credential</Button>
        </Stack>
      )}
    </Stack>
  );
}
