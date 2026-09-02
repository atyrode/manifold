import { bindingRebindRefusal } from "@manifold/plugin";
import { MAX_BINDING_OVERRIDES, type BindingOverrides } from "@manifold/protocol";

/**
 * `core.keys`, server half: the two doors that write one principal's key overrides.
 *
 * The slice of the host it touches, declared locally (D1): a principal id to write under and
 * two store calls. `packages/server/src/assembly.ts` checks this shape against the real
 * `ActionCtx` by assignment, so the ref this plugin declares is the ref it gets — a plugin
 * never imports the server's types.
 *
 * NO EMIT. A rebinding changes what ONE principal's own keyboard does; no other socket has a
 * reading of it to refresh, and the durable record of the change is the trace the dispatch
 * ladder already wrote (axiom A6). An event here would be a notification with no audience.
 */
interface KeysCtx {
  readonly principal: { readonly id: string };
  readonly store: {
    bindingOverrides(principalId: string): BindingOverrides;
    setBindingOverrides(principalId: string, overrides: BindingOverrides): void;
  };
}

/** Either the empty result both doors publish, or a refusal the ladder turns into a denial. */
type Outcome = { refused: string } | Record<string, never>;

/**
 * WHAT THE SERVER CAN SEE, and what it therefore refuses.
 *
 * A key table is browser-side registration data: plugins register their rows in their web
 * halves, so no server has ever held the list of declared keys, and a door that pretended to
 * would be inventing a second key registry the browser would then have to agree with
 * (invariant 14). What this door CAN see is the caller's own stored overrides — so it refuses
 * the collision it can prove, in the ENGINE's wording (`bindingRebindRefusal`, the same
 * function the editor calls with the whole effective table in hand), and the composition seam
 * drops any override a declaration has since claimed.
 *
 * That split is the honest one: the loud refusal a reader meets is raised where the whole table
 * is known, and the door's job is that nothing unrepresentable, unbounded or self-contradictory
 * reaches the store.
 */
export const keysHandlers = {
  async setBinding(ctx: KeysCtx, args: { binding: string; key: string }): Promise<Outcome> {
    const current = ctx.store.bindingOverrides(ctx.principal.id);
    const rows = Object.entries(current).map(([id, key]) => ({ id, key }));
    const collision = bindingRebindRefusal(rows, args.binding, args.key);
    if (collision !== null) return { refused: collision };
    if (
      current[args.binding] === undefined &&
      Object.keys(current).length >= MAX_BINDING_OVERRIDES
    ) {
      return {
        refused: `at most ${MAX_BINDING_OVERRIDES} rebound keys per principal; reset one before binding another`,
      };
    }
    ctx.store.setBindingOverrides(ctx.principal.id, { ...current, [args.binding]: args.key });
    return {};
  },

  /**
   * `binding: null` drops every override — the global reset — and a named binding drops one.
   * Resetting a row that was never rebound is a SUCCESS rather than a refusal: the door's
   * postcondition is "this row answers its declared key", and that already held.
   */
  async resetBinding(ctx: KeysCtx, args: { binding: string | null }): Promise<Outcome> {
    if (args.binding === null) {
      ctx.store.setBindingOverrides(ctx.principal.id, {});
      return {};
    }
    const current = ctx.store.bindingOverrides(ctx.principal.id);
    if (current[args.binding] === undefined) return {};
    const next = { ...current };
    delete next[args.binding];
    ctx.store.setBindingOverrides(ctx.principal.id, next);
    return {};
  },
};
