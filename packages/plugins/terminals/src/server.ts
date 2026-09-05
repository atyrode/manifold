import type {
  ContainerTerminalSummary,
  TerminalEnv,
  TerminalProgram,
  TerminalSummary,
} from "@manifold/protocol";

/** A durable terminal row, as this plugin needs to read it. */
interface StoredTerminal {
  readonly id: string;
  readonly machineId: string;
  /** The composition the terminal lives in. Never null: a terminal is `homed: "eager"`. */
  readonly containerId: string;
  readonly name: string | null;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly createdAt: number;
}

/** The live policy facts a kill is judged by: where it lives, and who is holding it. */
interface LiveTerminal {
  readonly containerId: string;
  readonly status: "running" | "exited";
  readonly controllerId: string | null;
}

/**
 * The slice of the host this plugin touches, declared locally (D1). It is deliberately
 * small and deliberately READ-ONLY except for the two broker verbs: naming and killing are
 * the only mutations terminals own, and everything else here is the state the doors judge
 * by. The broker's own return vocabulary comes with it, because "there is no such terminal"
 * is an answer this plugin has to relay, not one it can invent.
 */
interface TerminalsCtx {
  /** The caller's own container when its token is container-scoped; null for a workspace token. */
  readonly containerScope: string | null;
  /**
   * The engine's own discharge of the containment obligation `scope: "container"` carries. The
   * scope rung proves the caller's caps hold at the caller's OWN container; only a handler can
   * resolve which container the terminal its arguments name actually lives in, and this is
   * where that answer is judged — in one wording, shared by every plugin, so a client can
   * switch on the refusal instead of parsing four variants of it.
   */
  outsideScope(containerId: string | null): { readonly refused: string } | null;
  readonly principal: { readonly id: string };
  readonly auth: { readonly isRoot: boolean };
  readonly store: { listTerminals(): readonly StoredTerminal[] };
  readonly rooms: { censuses(): readonly { readonly references: readonly string[] }[] };
  readonly broker: {
    rename(terminalId: string, name: string): "ok" | "not_found";
    killById(terminalId: string): "ok" | "not_found";
    liveTerminal(terminalId: string): LiveTerminal | null;
  };
}

/** Either the result the action publishes, or a refusal the door turns into a denial. */
type Outcome<T> = { refused: string } | T;

export const terminalsHandlers = {
  /**
   * CREATION POLICY, and the only door that mutates nothing: the PTY is born on the terminal
   * channel (see the action's own comment), so this answers the question and the transport
   * does the work. What is left for the handler once the ladder has run is the containment
   * obligation — a container-scoped opener may only be born where its token lives.
   *
   * `program` and `env` arrive here judged by shape and otherwise unjudged: no rule about
   * WHICH argv or WHICH keys a principal may name exists yet, and when one does it is a line
   * in this function. It runs before anything is minted or sent — the gateway asks this door
   * and only then hands the same frame to the broker — so a refusal here costs nothing to
   * undo.
   */
  async open(
    ctx: TerminalsCtx,
    args: {
      containerId: string;
      elementId: string;
      cols: number;
      rows: number;
      machineId?: string;
      placement?: "element" | "tile";
      program?: TerminalProgram;
      env?: TerminalEnv;
    },
  ): Promise<Outcome<Record<string, never>>> {
    const outside = ctx.outsideScope(args.containerId);
    if (outside !== null) return outside;
    return {};
  },

  /**
   * Naming, as `PATCH /api/terminals/:id` meant it: a trimmed name, an all-whitespace name
   * refused so a titlebar edit cannot leave a terminal with an invisible label, and a
   * missing terminal refused rather than silently accepted — the route answered 404, and the
   * outcome envelope's equivalent of 404 is a refusal carrying the reason.
   */
  async rename(
    ctx: TerminalsCtx,
    args: { terminalId: string; name: string },
  ): Promise<Outcome<Record<string, never>>> {
    const name = args.name.trim();
    if (name.length === 0) return { refused: "name is empty" };
    const live = ctx.broker.liveTerminal(args.terminalId);
    if (live === null) return { refused: "terminal not found" };
    const outside = ctx.outsideScope(live.containerId);
    if (outside !== null) return outside;
    if (ctx.broker.rename(args.terminalId, name) === "not_found") {
      return { refused: "terminal not found" };
    }
    return {};
  },

  /**
   * THE LEASE RULE, moved off the transport unchanged. The broker's `take` path judged three
   * things before it transferred anything: that the terminal exists, that it is still RUNNING,
   * and that the caller holds `terminals:write` in the channel's container. The third is what
   * the ladder proves — rung by rung, in the published vocabulary, for a socket and an SDK
   * alike — so the broker's own copy of it is gone and this door is where authority is decided
   * (invariant 14). The first two survive here verbatim, in the same order, with the same
   * words: an exited terminal has no lease to take, and a terminal nobody can name has nothing
   * to hand over.
   *
   * There is deliberately no rule about who currently HOLDS the lease. That is the whole point
   * of taking: `kill` refuses a running terminal held by somebody else precisely because this
   * door exists to claim it first, and a take that respected the incumbent lease would close
   * the only way out of that refusal.
   */
  async take(
    ctx: TerminalsCtx,
    args: { terminalId: string },
  ): Promise<Outcome<Record<string, never>>> {
    const live = ctx.broker.liveTerminal(args.terminalId);
    if (live === null) return { refused: "terminal not found" };
    const outside = ctx.outsideScope(live.containerId);
    if (outside !== null) return outside;
    if (live.status !== "running") return { refused: "terminal has exited" };
    return {};
  },

  /**
   * Killing, unified. Two doors used to answer this and they disagreed: the terminal
   * channel's `terminal_kill` demanded the controller lease (or the wildcard) for a LIVE
   * terminal, while `DELETE /api/terminals/:id` demanded neither. One concept, one answer
   * (invariant 14), and the answer keeps the lease where the lease means something:
   *
   * - an EXITED terminal has no controller and nothing left to protect, so dismissing it
   *   needs only the `terminals:write` the ladder already proved. Kill and dismiss are one
   *   verb, and refusing here would leave dead terminals nobody could clear.
   * - a RUNNING terminal may only be killed by the principal holding its lease, or by the
   *   wildcard: pulling a live PTY out from under somebody working in it is not a janitorial
   *   act. Nobody is locked out by this — `terminal_take` claims the lease, and claiming
   *   before destroying is the whole point.
   *
   * The index route this replaced asked for neither, which is precisely the disagreement
   * invariant 14 forbids; the stricter answer is the surviving one, and the browser's own
   * `canKill` is computed from the same rule so no affordance offers what the door refuses.
   *
   * Idempotent by construction: the second kill of the same id refuses `terminal not found`,
   * because by then there is nothing left to name.
   */
  async kill(
    ctx: TerminalsCtx,
    args: { terminalId: string },
  ): Promise<Outcome<Record<string, never>>> {
    const live = ctx.broker.liveTerminal(args.terminalId);
    if (live === null) return { refused: "terminal not found" };
    const outside = ctx.outsideScope(live.containerId);
    if (outside !== null) return outside;
    const heldByAnother = live.status === "running" && live.controllerId !== ctx.principal.id;
    if (heldByAnother && !ctx.auth.isRoot) {
      return { refused: "controller lease or owner capability required" };
    }
    if (ctx.broker.killById(args.terminalId) === "not_found") {
      return { refused: "terminal not found" };
    }
    return {};
  },

  /**
   * THE terminal index: every terminal, with the composition it lives in and whether
   * anything references that composition. `unplaced` is DERIVED from the containment graph
   * on every read rather than stored — the pool's durable position was the last piece of
   * state describing where a terminal was NOT, and the whole point of retiring it is that
   * this question now has exactly one answer and no way to go stale.
   */
  async listAll(
    ctx: TerminalsCtx,
    _args: Record<string, never>,
  ): Promise<{
    terminals: readonly TerminalSummary[];
  }> {
    const referenced = new Set<string>();
    for (const census of ctx.rooms.censuses()) {
      for (const reference of census.references) referenced.add(reference);
    }
    const terminals = ctx.store.listTerminals().map((terminal) => ({
      id: terminal.id,
      machineId: terminal.machineId,
      name: terminal.name,
      createdAt: terminal.createdAt,
      status: terminal.status,
      exitCode: terminal.exitCode,
      homeId: terminal.containerId,
      unplaced: !referenced.has(terminal.containerId),
    }));
    return { terminals };
  },

  /**
   * Per-container terminal rows, for the counts the workspace tree paints. `scope: "container"`
   * carries the filter the replaced route applied by hand: a container-scoped reader sees its own
   * container's terminals and learns nothing about any other.
   *
   * A LISTING is the one place containment filters rather than refuses. Every other door
   * here is asked about one named terminal, so naming somebody else's is a refusal; this door
   * is asked "what is in reach", and the honest answer for a scoped reader is its own
   * container's rows — which is exactly what the route it replaces returned.
   */
  async listByContainer(
    ctx: TerminalsCtx,
    _args: Record<string, never>,
  ): Promise<{ terminals: readonly ContainerTerminalSummary[] }> {
    const terminals: ContainerTerminalSummary[] = [];
    for (const terminal of ctx.store.listTerminals()) {
      if (ctx.outsideScope(terminal.containerId) !== null) continue;
      terminals.push({
        id: terminal.id,
        containerId: terminal.containerId,
        machineId: terminal.machineId,
        createdAt: terminal.createdAt,
        status: terminal.status,
        exitCode: terminal.exitCode,
      });
    }
    return { terminals };
  },
};
