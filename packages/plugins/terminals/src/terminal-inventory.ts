import type { MachineSummary, TerminalInfo } from "@manifold/protocol";

/** One row of the terminals janitor panel: a PTY terminal and how it is bound. */
export interface TerminalRow {
  readonly id: string;
  /** Durable user-given terminal name; null falls back to machine labeling. */
  readonly name: string | null;
  readonly machineName: string | null;
  readonly machineOnline: boolean | null;
  readonly status: TerminalInfo["status"];
  readonly exitCode: number | null;
  /** Every live canvas mirror in stable scene order. */
  readonly boundElementIds: readonly string[];
  readonly isController: boolean;
  /**
   * Whether `core.terminals.kill` would ACCEPT this row from this caller — computed from the
   * door's own rule so no affordance offers what the door refuses.
   */
  readonly canKill: boolean;
}

export interface TerminalInventoryInput {
  readonly terminals: readonly TerminalInfo[];
  readonly machines: readonly MachineSummary[] | null;
  /** terminalId -> every bound live terminal element id (tombstones excluded by the caller). */
  readonly liveBindings: ReadonlyMap<string, readonly string[]>;
  readonly selfId: string | null;
  readonly selfCaps: readonly string[];
}

/**
 * Projects wire terminals + canvas bindings into janitor rows. Pure so the binding
 * policy stays unit-testable outside a renderer. A terminal with no container binding is
 * not in this inventory at all: it lives in the workspace terminal pool.
 */
export function buildTerminalRows(input: TerminalInventoryInput): readonly TerminalRow[] {
  const machineById = new Map(
    (input.machines ?? []).map((machine) => [machine.id, machine] as const),
  );
  const isRoot = input.selfCaps.includes("*");
  const canWriteTerminals = isRoot || input.selfCaps.includes("terminals:write");
  const rows = input.terminals
    .map((terminal) => {
      const machine = machineById.get(terminal.machineId);
      const boundElementIds = [...(input.liveBindings.get(terminal.id) ?? [])];
      const isController = input.selfId !== null && terminal.controllerId === input.selfId;
      return {
        id: terminal.id,
        name: terminal.name,
        machineName: machine?.name ?? null,
        machineOnline: machine === undefined ? null : machine.online,
        status: terminal.status,
        exitCode: terminal.exitCode,
        boundElementIds,
        isController,
        /*
          THE SAME RULE `core.terminals.kill` enforces, and only that rule. A RUNNING
          terminal may be killed by the principal holding its lease or by the wildcard —
          pulling a live PTY out from under somebody working in it is not a janitorial act,
          and nobody is locked out because `terminal_take` claims the lease first. An EXITED
          terminal has no controller and nothing left to protect, so dismissing it needs only
          the `terminals:write` the door's ladder already proves (kill and dismiss are one
          verb).

          The "unbound running terminal, any terminal writer" branch that used to sit here is
          GONE. It predated the unification: two doors answered kill and disagreed, and this
          row was computed from the laxer one, so the affordance offered a kill the surviving
          door refuses. An affordance that offers what the door refuses is worse than a
          missing button — invariant 14 leaves exactly one reading, and this is it.
        */
        canKill: terminal.status === "running" ? isController || isRoot : canWriteTerminals,
      } satisfies TerminalRow;
    })
    .filter(
      // Once an exited terminal has no canvas ref, it has no output to reveal,
      // cannot be restarted in place, and has no remaining user action.
      (row) => row.status === "running" || row.boundElementIds.length > 0,
    );
  const statusRank = (row: TerminalRow): number => (row.status === "running" ? 0 : 1);
  return rows.sort((left, right) => {
    const byStatus = statusRank(left) - statusRank(right);
    if (byStatus !== 0) return byStatus;
    return left.id.localeCompare(right.id);
  });
}
