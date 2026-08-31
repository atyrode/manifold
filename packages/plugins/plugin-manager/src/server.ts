/**
 * The slice of the host this plugin touches, declared locally (D1): composition
 * administration and nothing else. It never sees the store, the rooms, or the broker,
 * because turning a plugin off is not a mutation of any of them.
 */
interface PluginManagerCtx {
  readonly host: {
    setEnabled(id: string, enabled: boolean): { readonly refused: string } | { readonly ok: true };
  };
}

/** Either the empty result the action publishes, or a refusal the door turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * The refusal the host produces travels back out unchanged — an unknown id, or `essential`
 * for a plugin the workspace cannot render itself without. Translating it here would give
 * the same rule two wordings, and a client that switches on the message would then depend
 * on which door it came through.
 */
export const pluginManagerHandlers = {
  async setEnabled(
    ctx: PluginManagerCtx,
    args: { id: string; enabled: boolean },
  ): Promise<Outcome> {
    const outcome = ctx.host.setEnabled(args.id, args.enabled);
    if ("refused" in outcome) return { refused: outcome.refused };
    return {};
  },
};
