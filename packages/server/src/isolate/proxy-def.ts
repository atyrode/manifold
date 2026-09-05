import type { AnyActionDef, AssemblyDelta, LifecycleCtx, PluginLifecycle } from "@manifold/plugin";
import {
  CapSchema,
  LocalNameSchema,
  PlaceRequestSchema,
  type IsolateChildFrame,
  type IsolateCtxMethod,
  type IsolateHook,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import type { ActionCtx, ActionHandler } from "../plugin-host.ts";
import { IsolateDenial, IsolateLoadError, type IsolateLoadResult } from "./contract.ts";

/**
 * THE TWO DIRECTIONS OF PROXYING, both pure over a transport. Outbound: the child's `loaded`
 * report becomes a `ServerPluginDef` whose handlers and hooks are round trips. Inbound: a
 * child's `call` is served from the ctx of the request it belongs to. Neither direction
 * knows about processes, budgets or deadlines — that is the supervisor's — which is what
 * lets this file be checked against a scripted transport with no child at all.
 */

type LoadedFrame = Extract<IsolateChildFrame, { t: "loaded" }>;
export type IsolateDispatchOutcome = Extract<IsolateChildFrame, { t: "dispatched" }>["outcome"];

/**
 * One round trip into the child, as a proxy asks for it. `dispatch` answers with the child's
 * own verdict; both reject with {@link IsolateDenial} `unavailable` when the child is not
 * there to answer — crashed, evicted and failing to respawn, or silent past the deadline.
 */
export interface IsolateTransport {
  dispatch(action: string, args: unknown, ctx: ActionCtx): Promise<IsolateDispatchOutcome>;
  hook(hook: IsolateHook, ctx: LifecycleCtx, delta?: AssemblyDelta): Promise<void>;
}

/**
 * The def the host assembles for an installed row, built from what the child reported.
 *
 * `input` and `result` are `z.unknown()`: the arguments are graded in the child against the
 * action's own zod (the schema lives where the code lives, and an `invalid_args` from there
 * is thrown back through {@link IsolateDenial} for the ladder to trace). The child's JSON
 * Schema rides on as zod metadata, so `assembleRoster`'s `z.toJSONSchema` publishes exactly
 * what the child said and a reader of `GET /api/plugins` sees the same shape it would for an
 * in-realm door. Names arrive fully qualified (`ActionSummary`) and are made local here; a
 * name outside the plugin's own namespace fails the load rather than the roster.
 */
export function buildIsolateDef(
  manifest: PluginManifest,
  loaded: LoadedFrame,
  transport: IsolateTransport,
): IsolateLoadResult {
  const prefix = `${manifest.id}.`;
  const actions: AnyActionDef[] = [];
  const handlers: Record<string, ActionHandler> = {};
  for (const summary of loaded.actions) {
    const local = summary.name.startsWith(prefix)
      ? LocalNameSchema.safeParse(summary.name.slice(prefix.length))
      : null;
    if (local === null || !local.success) {
      throw new IsolateLoadError(
        `action "${summary.name}" is not a local name under plugin "${manifest.id}"`,
      );
    }
    const name = local.data;
    actions.push({
      name,
      title: summary.title,
      caps: summary.caps,
      scope: summary.scope,
      ...(summary.cleanup === true ? { cleanup: true } : {}),
      input: z.unknown().meta({ ...summary.input }),
      result: z.unknown().meta({ ...summary.result }),
    });
    handlers[name] = async (ctx: ActionCtx, args: unknown): Promise<unknown> => {
      const outcome = await transport.dispatch(name, args, ctx);
      if (!outcome.ok) {
        if (outcome.rule === "invalid_args") throw new IsolateDenial("invalid_args", outcome.message);
        // The handler's own domain refusal: data, exactly as an in-realm handler returns it.
        return { refused: outcome.message };
      }
      // Re-staged, never sent: the host's buffer flushes after the ledger settles (A6).
      for (const event of outcome.emits) ctx.emit(event.ref, event.kind, event.payload);
      return outcome.result;
    };
  }
  /*
    Only the hooks the child declared exist on the proxy, so the host fans out exactly what
    it would for an in-realm plugin that left a hook undefined — a round trip to say "nothing
    to do" would still count against the 2 s bound.
   */
  const lifecycle: PluginLifecycle = {
    ...(loaded.hooks.onEnable ? { onEnable: (ctx) => transport.hook("onEnable", ctx) } : {}),
    ...(loaded.hooks.onDisable ? { onDisable: (ctx) => transport.hook("onDisable", ctx) } : {}),
    ...(loaded.hooks.onAssemblyChanged
      ? { onAssemblyChanged: (ctx, delta) => transport.hook("onAssemblyChanged", ctx, delta) }
      : {}),
  };
  return { def: { manifest, actions, handlers, lifecycle }, lifecycle };
}

/**
 * The request a child's `call` belongs to. A dispatch serves the whole `ISOLATE_CTX_METHODS`
 * list from the caller's `ActionCtx`; a lifecycle hook has only its `LifecycleCtx`, so it
 * serves storage and answers `slice_unavailable` for the rest — the same word the guest
 * runtime uses for a slice stage 1 does not carry.
 */
export type ServedCtx =
  | { readonly kind: "dispatch"; readonly ctx: ActionCtx }
  | { readonly kind: "hook"; readonly ctx: LifecycleCtx };

/** The positional argument at `index`, which the served method needs to be a string. */
function stringArg(args: readonly unknown[], index: number, method: IsolateCtxMethod): string {
  const value = args[index];
  if (typeof value !== "string") {
    throw new Error(`${method}: argument ${String(index)} must be a string`);
  }
  return value;
}

/**
 * Serves one `call`. Every branch forwards to the SAME object an in-realm handler would
 * touch — `ctx.storage` is the plugin's own namespace, `ctx.auth.allows` grades the
 * dispatching caller, `ctx.placement.place` is the one executor — so an isolated plugin
 * reaches nothing an in-realm one could not (ADR 0016 §2). Arguments are narrowed here
 * because the frame schema bounds their count and nothing else; a wrong shape throws, and
 * the supervisor answers the throw as `{ ok: false, error }`.
 */
export async function serveCtxCall(
  method: IsolateCtxMethod,
  args: readonly unknown[],
  served: ServedCtx,
): Promise<unknown> {
  switch (method) {
    case "storage.get":
      return served.ctx.storage.get(stringArg(args, 0, method));
    case "storage.set":
      return served.ctx.storage.set(stringArg(args, 0, method), stringArg(args, 1, method));
    case "storage.delete":
      return served.ctx.storage.delete(stringArg(args, 0, method));
    case "storage.keys":
      return served.ctx.storage.keys(args[0] === undefined ? undefined : stringArg(args, 0, method));
    case "auth.allows":
    case "outsideScope":
    case "newId":
    case "machines.isOnline":
    case "placement.place":
    case "host.roster":
    case "host.enabled":
      break;
  }
  if (served.kind !== "dispatch") throw new Error(`slice_unavailable: ${method}`);
  const ctx = served.ctx;
  switch (method) {
    case "auth.allows": {
      const cap = CapSchema.safeParse(args[0]);
      if (!cap.success || cap.data === "*") {
        throw new Error(`${method}: argument 0 must be a capability other than "*"`);
      }
      const containerId = args[1];
      if (containerId !== undefined && typeof containerId !== "string") {
        throw new Error(`${method}: argument 1 must be a container id`);
      }
      return ctx.auth.allows(cap.data, containerId);
    }
    case "outsideScope": {
      const containerId = args[0];
      if (containerId !== null && typeof containerId !== "string") {
        throw new Error(`${method}: argument 0 must be a container id or null`);
      }
      return ctx.outsideScope(containerId);
    }
    case "newId":
      return ctx.newId();
    case "machines.isOnline":
      return ctx.machines.isOnline(stringArg(args, 0, method));
    case "placement.place": {
      const request = PlaceRequestSchema.safeParse(args[0]);
      if (!request.success) throw new Error(`${method}: argument 0 is not a placement request`);
      return ctx.placement.place(request.data);
    }
    case "host.roster":
      return ctx.host.roster();
    case "host.enabled":
      return ctx.host.enabled(stringArg(args, 0, method));
    default: {
      const exhaustive: never = method;
      throw new Error(`unserved ctx method ${String(exhaustive)}`);
    }
  }
}
