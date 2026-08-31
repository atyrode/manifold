/**
 * The slice of the host this plugin touches, declared locally (D1): two broker calls,
 * exactly the two the deleted routes made. The broker's own return vocabulary comes with
 * them, because "there is no such terminal" is an answer this plugin has to relay, not one
 * it can invent.
 */
interface TerminalsCtx {
  readonly broker: {
    rename(sessionId: string, name: string): "ok" | "not_found";
    killById(sessionId: string): "ok" | "not_found";
  };
}

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * These are the bodies of `PATCH /api/terminals/:id` and `DELETE /api/terminals/:id`,
 * moved verbatim in meaning:
 *
 * - a name is trimmed and an all-whitespace name is refused, so a titlebar edit cannot
 *   leave a terminal with an invisible label;
 * - a missing session is refused rather than silently accepted — the route answered 404,
 *   and the outcome envelope's equivalent of 404 is a refusal carrying the reason;
 * - a kill is total and idempotent: killing a terminal that already exited is precisely
 *   what a caller dismissing a dead terminal asked for, which is why both verbs are one
 *   and there is no conflict to report. The second kill of the same id refuses (`terminal
 *   not found`) because by then there is nothing left to name.
 */
export const terminalsHandlers = {
  async rename(ctx: TerminalsCtx, args: { sessionId: string; name: string }): Promise<Outcome> {
    const name = args.name.trim();
    if (name.length === 0) return { refused: "name is empty" };
    if (ctx.broker.rename(args.sessionId, name) === "not_found") {
      return { refused: "terminal not found" };
    }
    return {};
  },

  async kill(ctx: TerminalsCtx, args: { sessionId: string }): Promise<Outcome> {
    if (ctx.broker.killById(args.sessionId) === "not_found") {
      return { refused: "terminal not found" };
    }
    return {};
  },
};
