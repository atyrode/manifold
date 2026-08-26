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
  /** Every live canvas mirror in Excalidraw's stable scene order. */
  readonly boundElementIds: readonly string[];
  readonly isController: boolean;
  /** Self can terminate directly, or can claim an unbound session before terminating it. */
  readonly canKill: boolean;
}

export interface SessionInventoryInput {
  readonly sessions: readonly SessionInfo[];
  readonly machines: readonly MachineSummary[] | null;
  /** sessionId -> every bound live terminal element id (tombstones excluded by the caller). */
  readonly liveBindings: ReadonlyMap<string, readonly string[]>;
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
  const canWriteTerminals = isRoot || input.selfCaps.includes("terminal:write");
  const rows = input.sessions
    .map((session) => {
      const machine = machineById.get(session.machineId);
      const boundElementIds = [...(input.liveBindings.get(session.id) ?? [])];
      const isController = input.selfId !== null && session.controllerId === input.selfId;
      return {
        id: session.id,
        machineName: machine?.name ?? null,
        machineOnline: machine === undefined ? null : machine.online,
        status: session.status,
        exitCode: session.exitCode,
        orphaned: session.status === "running" && boundElementIds.length === 0,
        boundElementIds,
        isController,
        canKill:
          session.status === "running" &&
          (isController || isRoot || (boundElementIds.length === 0 && canWriteTerminals)),
      } satisfies SessionRow;
    })
    .filter(
      // Once an exited session has no canvas surface, it has no output to reveal,
      // cannot be restarted in place, and has no remaining user action.
      (row) => row.status === "running" || row.boundElementIds.length > 0,
    );
  const statusRank = (row: SessionRow): number =>
    row.status === "running" ? (row.orphaned ? 0 : 1) : 2;
  return rows.sort((left, right) => {
    const byStatus = statusRank(left) - statusRank(right);
    if (byStatus !== 0) return byStatus;
    if (left.orphaned !== right.orphaned) return left.orphaned ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}
