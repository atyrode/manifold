import type { MachineSummary } from "@manifold/protocol";
import { Button, Cluster, Input, Select, Stack, Text } from "@manifold/ui";
import { useMemo, useState, type ReactElement } from "react";
import type { HostView, HostViewMember, HostViews } from "./host-views.ts";
import { MACHINES_REMOVE_HOST_VIEW_ACTION, MACHINES_SET_HOST_VIEW_ACTION } from "./names.ts";

interface HostViewEditorProps {
  readonly registry: HostViews;
  readonly machines: readonly MachineSummary[];
  readonly editing: HostView | null;
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
  save,
  remove,
  close,
}: HostViewEditorProps): ReactElement {
  const [revision] = useState(registry.revision);
  const [id] = useState(() => editing?.id ?? crypto.randomUUID());
  const [name, setName] = useState(editing?.name ?? "");
  const [members, setMembers] = useState<readonly HostViewMember[]>(editing?.members ?? []);
  const [addId, setAddId] = useState<string | null>(null);
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
    setMembers((current) =>
      current.map((member) =>
        member.machineId === machineId ? { machineId, accountLabel } : member,
      ),
    );
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
      <Text strong>{editing === null ? "Create host grouping" : "Edit host grouping"}</Text>
      <Text tone="muted" wrap>
        Grouping is display metadata only. Each enrollment remains its own account, credential and
        shell authority.
      </Text>
      <Input label="Host display name" value={name} onChange={setName} disabled={busy} />
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
              setMembers((current) =>
                current.filter((candidate) => candidate.machineId !== member.machineId),
              )
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
        onChange={setAddId}
        disabled={busy || members.length >= 64}
      />
      <Button
        disabled={busy || addId === null || members.length >= 64}
        onClick={() => {
          const machine = addId === null ? undefined : machineById.get(addId);
          if (machine === undefined || assigned.has(machine.id)) return;
          setMembers((current) => [
            ...current,
            { machineId: machine.id, accountLabel: machine.name },
          ]);
          setAddId(null);
        }}
      >
        Add account
      </Button>
      <Cluster gap="0.35rem">
        <Button
          tone="accent"
          data-action={MACHINES_SET_HOST_VIEW_ACTION}
          disabled={busy || !valid}
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
        {editing === null ? null : (
          <Button
            tone="danger"
            data-action={MACHINES_REMOVE_HOST_VIEW_ACTION}
            disabled={busy}
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
