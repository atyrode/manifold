import type { MachineSummary, SessionInfo } from "@manifold/protocol";

/** One row of the sessions janitor panel: a PTY session and how it is bound. */
export interface SessionRow {
  readonly id: string;
  readonly machineName: string | null;
  readonly machineOnline: boolean | null;
  readonly status: SessionInfo["status"];
  readonly exitCode: number | null;
  /** Running but no live (non-deleted) terminal element references it anymore. */
  readonly orphaned: boolean;
  readonly boundElementId: string | null;
  readonly isController: boolean;
  /** Controller lease held by self, or self holds the wildcard capability. */
  readonly canKill: boolean;
}

export interface SessionInventoryInput {
  readonly sessions: readonly SessionInfo[];
  readonly machines: readonly MachineSummary[] | null;
  /** sessionId -> bound live terminal element id (tombstones excluded by the caller). */
  readonly liveBindings: ReadonlyMap<string, string>;
  readonly selfId: string | null;
  readonly selfCaps: readonly string[];
}

/**
 * Projects wire sessions + canvas bindings into janitor rows. Pure so the
 * orphan-detection policy stays unit-testable outside Excalidraw.
 */
export function buildSessionRows(input: SessionInventoryInput): readonly SessionRow[] {
  const machineById = new Map(
    (input.machines ?? []).map((machine) => [machine.id, machine] as const),
  );
  const isRoot = input.selfCaps.includes("*");
  const rows = input.sessions.map((session) => {
    const machine = machineById.get(session.machineId);
    const boundElementId = input.liveBindings.get(session.id) ?? null;
    const isController = input.selfId !== null && session.controllerId === input.selfId;
    return {
      id: session.id,
      machineName: machine?.name ?? null,
      machineOnline: machine === undefined ? null : machine.online,
      status: session.status,
      exitCode: session.exitCode,
      orphaned: session.status === "running" && boundElementId === null,
      boundElementId,
      isController,
      canKill: session.status === "running" && (isController || isRoot),
    } satisfies SessionRow;
  });
  const statusRank = (row: SessionRow): number =>
    row.status === "running" ? (row.orphaned ? 0 : 1) : 2;
  return rows.sort((left, right) => {
    const byStatus = statusRank(left) - statusRank(right);
    if (byStatus !== 0) return byStatus;
    if (left.orphaned !== right.orphaned) return left.orphaned ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}
