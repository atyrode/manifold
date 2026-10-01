import type { MachineSummary } from "@manifold/protocol";
import { Button, Cluster, Input, Select, Stack, Text } from "@manifold/ui";
import { useMemo, type ReactElement } from "react";
import type { HostView, HostViewMember, HostViews } from "./host-views.ts";
import { MACHINES_REMOVE_HOST_VIEW_ACTION, MACHINES_SET_HOST_VIEW_ACTION } from "./names.ts";

/** The private draft and its CAS revision survive temporary authority/inventory hiding together. */
export interface HostViewDraft {
  readonly revision: number;
  readonly id: string;
  readonly existing: boolean;
  readonly name: string;
  readonly members: readonly HostViewMember[];
  readonly addId: string | null;
}

interface HostViewEditorProps {
  readonly registry: HostViews;
  readonly machines: readonly MachineSummary[];
  readonly editing: HostViewDraft;
  readonly change: (draft: HostViewDraft) => void;
  readonly busy: boolean;
  readonly save: (host: HostView, expectedRevision: number) => Promise<boolean>;
  readonly remove: (hostId: string, expectedRevision: number) => Promise<boolean>;
  readonly close: () => void;
}

/** The revision and draft belong to this edit, not to a later inventory refresh. */
export function HostViewEditor({
  registry,
  machines,
  editing,
  busy,
  change,
  save,
  remove,
  close,
}: HostViewEditorProps): ReactElement {
  const { revision, id, existing, name, members, addId } = editing;
  const outdated = registry.revision !== revision;
  const current = registry.hosts.find((host) => host.id === id);
  const removed = existing && current === undefined;
  const reload = (): void => {
    if (removed) {
      close();
      return;
    }
    change({
      ...editing,
      revision: registry.revision,
      name: current?.name ?? "",
      members: current?.members ?? [],
      addId: null,
    });
  };
  const machineById = useMemo(() => {
    const byId = new Map<string, MachineSummary>();
    for (const machine of machines) byId.set(machine.id, machine);
    return byId;
  }, [machines]);
  const assigned = new Set<string>();
  for (const host of registry.hosts) {
    if (host.id === id) continue;
    for (const member of host.members) assigned.add(member.machineId);
  }
  for (const member of members) assigned.add(member.machineId);
  const options: { value: string; label: string }[] = [];
  for (const machine of machines) {
    if (!assigned.has(machine.id))
      options.push({ value: machine.id, label: `${machine.name} · ${machine.id}` });
  }
  const updateLabel = (machineId: string, accountLabel: string): void => {
    change({
      ...editing,
      members: members.map((member) =>
        member.machineId === machineId ? { machineId, accountLabel } : member,
      ),
    });
  };
  const valid =
    name.trim().length > 0 &&
    name.trim().length <= 64 &&
    members.length > 0 &&
    members.every(
      (member) => member.accountLabel.trim().length > 0 && member.accountLabel.trim().length <= 64,
    );
  return (
    <Stack gap="0.35rem" data-testid="host-view-editor">
      <Text strong>{existing ? "Edit host grouping" : "Create host grouping"}</Text>
      <Text tone="muted" wrap>
        Grouping is display metadata only. Each enrollment remains its own account, credential and
        shell authority.
      </Text>
      {outdated ? (
        <Stack gap="0.25rem">
          <Text tone="muted" wrap role="status">
            {removed
              ? "This grouping was removed elsewhere. Close this draft before creating a new grouping."
              : "Host groupings changed elsewhere. Reload the current grouping to review it; reloading discards this draft."}
          </Text>
          <Button disabled={busy} onClick={reload}>
            {removed ? "Close removed grouping" : "Reload current grouping"}
          </Button>
        </Stack>
      ) : null}
      <Input
        label="Host display name"
        value={name}
        onChange={(name) => change({ ...editing, name })}
        disabled={busy}
      />
      {members.map((member) => (
        <Stack key={member.machineId} gap="0.15rem">
          <Text tone="muted" wrap>
            Enrollment: {machineById.get(member.machineId)?.name ?? member.machineId}
          </Text>
          <Input
            label={`Account label for ${member.machineId}`}
            value={member.accountLabel}
            onChange={(value) => updateLabel(member.machineId, value)}
            disabled={busy}
          />
          <Button
            disabled={busy}
            onClick={() =>
              change({
                ...editing,
                members: members.filter((candidate) => candidate.machineId !== member.machineId),
              })
            }
          >
            Remove account from draft
          </Button>
        </Stack>
      ))}
      <Select
        label="Existing account enrollment"
        value={addId}
        options={options}
        onChange={(addId) => change({ ...editing, addId })}
        disabled={busy || members.length >= 64}
      />
      <Button
        disabled={busy || addId === null || members.length >= 64}
        onClick={() => {
          const machine = addId === null ? undefined : machineById.get(addId);
          if (machine === undefined || assigned.has(machine.id)) return;
          change({
            ...editing,
            members: [...members, { machineId: machine.id, accountLabel: machine.name }],
            addId: null,
          });
        }}
      >
        Add account
      </Button>
      <Cluster gap="0.35rem">
        <Button
          tone="accent"
          data-action={MACHINES_SET_HOST_VIEW_ACTION}
          disabled={busy || !valid || outdated}
          onClick={() => {
            void save(
              {
                id,
                name: name.trim(),
                members: members.map((member) => ({
                  ...member,
                  accountLabel: member.accountLabel.trim(),
                })),
              },
              revision,
            );
          }}
        >
          Save grouping
        </Button>
        {!existing ? null : (
          <Button
            tone="danger"
            data-action={MACHINES_REMOVE_HOST_VIEW_ACTION}
            disabled={busy || outdated}
            onClick={() => {
              void remove(id, revision);
            }}
          >
            Remove grouping
          </Button>
        )}
        <Button disabled={busy} onClick={close}>
          Cancel
        </Button>
      </Cluster>
    </Stack>
  );
}
