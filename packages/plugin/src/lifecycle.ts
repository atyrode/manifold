import type { PluginId } from "@manifold/protocol";
import type { PluginStorage } from "./storage.ts";

/**
 * THE LIFECYCLE — four hooks, one bound, no veto.
 *
 * A plugin gets told when it starts serving, when it stops, when the composition around it
 * moved, and when its data is being destroyed. What it never gets is a vote: no hook can
 * refuse or delay the transition that fired it. Enablement is workspace-global shared state
 * (D4), so a hook that could block one would let one plugin hold a whole workspace's
 * composition hostage — the failure mode every surveyed platform that allows it eventually
 * grows a timeout to escape.
 *
 * The bound is 2 seconds per hook (`LIFECYCLE_TIMEOUT_MS`). Past it the engine stops
 * WAITING; it cannot stop the hook, and pretending otherwise would be a lie in the type. The
 * roster records what happened (`lifecycle: "enable_failed" | "disable_failed"`) so a failed
 * hook is visible rather than swallowed, and a DISABLE always completes regardless: the
 * remedy for a plugin misbehaving on the way out must not be that plugin.
 */
export const LIFECYCLE_TIMEOUT_MS = 2_000;

/**
 * What a hook is handed: its own identity, its own storage, and the server's clock. Nothing
 * else — deliberately. A lifecycle hook exists to put a plugin's OWN durable state in order;
 * anything that touches the workspace is a mutation, and every mutation goes through an
 * action door where it can be authorized, validated, logged and observed (invariant 13).
 *
 * The parameter is contravariant, so a plugin may declare the minimal slice it actually uses
 * (`(ctx: { storage: PluginStorage }) => void`) and still satisfy the hook type. That is the
 * same sandbox shape the server's action handlers use, checked at the registration site.
 */
export interface LifecycleCtx {
  readonly pluginId: string;
  readonly storage: PluginStorage;
  now(): number;
}

/**
 * What changed in one roster commit, as the surviving plugins are told. Both lists are in
 * composition (topological) order, so a plugin reading them sees dependencies before
 * dependents, exactly as the fan-out itself is ordered.
 */
export interface CompositionDelta {
  readonly enabled: readonly PluginId[];
  readonly disabled: readonly PluginId[];
}

export type LifecycleHook = (ctx: LifecycleCtx) => void | Promise<void>;
export type CompositionChangedHook = (
  ctx: LifecycleCtx,
  delta: CompositionDelta,
) => void | Promise<void>;

/**
 * The hooks a plugin may declare. Every one is optional and most plugins declare none: a
 * plugin whose whole state lives in the documents, the roster and its actions has nothing to
 * do at a transition, and the engine must not invent work for it.
 *
 * `onEnable` and `onDisable` are TRANSITION hooks, not boot activation. At boot everything
 * enabled is simply live — there was no transition, so no hook fires and no lifecycle state
 * is inferred. This keeps process start free of a fan-out whose failures nobody asked for,
 * and keeps "the hook ran" meaning "somebody changed something".
 *
 * `onPurge` fires from the purge door only — never from a disable. A disable RETAINS data
 * (the residual mechanism is `retain`; there is no erase-on-disable), and destruction is a
 * separate, explicitly named verb.
 */
export interface PluginLifecycle {
  readonly onEnable?: LifecycleHook;
  readonly onDisable?: LifecycleHook;
  readonly onCompositionChanged?: CompositionChangedHook;
  readonly onPurge?: LifecycleHook;
}

/** Whether a hook settled inside its bound, and why not when it did not. */
export type HookOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Runs one hook under the bound. A throw, a rejection and an overrun are the SAME outcome to
 * the caller — the transition proceeds and the failure is named — because the engine's
 * obligation is to complete the transition, not to diagnose the plugin.
 *
 * A timed-out hook keeps running: there is no way to cancel someone else's promise, and the
 * honest report is that the engine stopped waiting.
 */
export async function runHook(
  invoke: () => void | Promise<void>,
  timeoutMs: number = LIFECYCLE_TIMEOUT_MS,
): Promise<HookOutcome> {
  // A cancellation CLOSURE rather than a handle: the same trick `RoomTimers` uses, so this
  // module never names a platform-specific timer type.
  let cancel = (): void => {};
  try {
    const settled = await Promise.race([
      (async () => {
        await invoke();
        return "settled" as const;
      })(),
      new Promise<"timeout">((resolve) => {
        const handle = setTimeout(() => resolve("timeout"), timeoutMs);
        cancel = (): void => {
          clearTimeout(handle);
        };
      }),
    ]);
    if (settled === "timeout") {
      return { ok: false, reason: `did not settle within ${String(timeoutMs)}ms` };
    }
    return { ok: true };
  } catch (reason) {
    return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
  } finally {
    cancel();
  }
}
