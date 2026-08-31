import type { ActionScope, Cap } from "@manifold/protocol";
import type { z } from "zod";

/**
 * An action a plugin declares: one named, cap-guarded, schema'd door into a mutation.
 *
 * `input` and `result` are zod schemas rather than TypeScript types alone because the door
 * validates on the way in and on the way out, and the SAME schemas are published as JSON
 * Schema in the roster — a stranger's agent reads the contract the dispatcher enforces,
 * never a hand-written description of it.
 *
 * `caps` is what invoking this action requires of the CALLER; it must be a subset of the
 * declaring manifest's `capabilities`, so a manifest is a readable ceiling on a plugin's
 * authority (checked by `assembleRoster`, refused loudly if violated).
 */
export interface ActionDef<In = unknown, Out = unknown> {
  /**
   * LOCAL name (`rename`), never the full one: the composition prefixes the owning plugin's
   * id, so a plugin cannot name a door outside its own namespace.
   */
  readonly name: string;
  readonly title: string;
  readonly caps: readonly Cap[];
  readonly input: z.ZodType<In>;
  readonly result: z.ZodType<Out>;
  /**
   * Marks a CLEANUP action: one that removes things and therefore keeps working while the
   * plugin is disabled (D12 — creation and administration die, cleanup survives). The
   * dispatcher skips only the `plugin_disabled` rung for it; caps and schemas still apply.
   */
  readonly cleanup?: boolean;
  /**
   * The authority grade this door is written for; absent ≡ `"workspace"`.
   *
   * `"container"` declares that the action's whole effect is confined to ONE container, which is
   * what lets a container-scoped token through the scope rung. The container is the TOKEN's
   * (`ctx.containerScope`), never an argument — authority that read arguments would force the
   * ladder to validate shape before authority, and a caller would learn a door's schema by
   * knocking on one it may not open. The declared caps are then evaluated AT that container, so
   * the scope narrows authority and can never widen it.
   *
   * It is a CONTRACT on the handler, not a label: with a non-null `ctx.containerScope` the handler
   * MUST refuse anything outside that container. The rung can only prove the caller's caps hold
   * for its own container; whether the thing named in the arguments lives there is a question only
   * the handler can ask.
   */
  readonly scope?: ActionScope;
}

/**
 * An action of unknown shape, as a registry holds it. zod v4 declares `ZodType`'s parameters
 * covariant (`out Output`, `out Input`), so every `ActionDef<In, Out>` assigns to this without
 * a cast and without `any`: a dispatcher that only calls `input.safeParse` / `result.parse`
 * needs no more type than "some schema".
 */
export type AnyActionDef = ActionDef;

/**
 * Identity helper. It exists purely so `In`/`Out` are inferred from the schemas at the
 * definition site — a handler written against `defineAction`'s result gets its argument and
 * return types checked against the same schemas the door enforces at runtime.
 */
export function defineAction<In, Out>(def: ActionDef<In, Out>): ActionDef<In, Out> {
  return def;
}
