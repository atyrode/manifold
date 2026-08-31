import { composeRoster, type Composition, type PluginDef } from "@manifold/plugin";
import type { ActionOutcome, Cap, PluginRoster, Principal, RuntimeDeps } from "@manifold/protocol";
import type { AuthContext, AuthService } from "./auth.ts";
import type { Logger } from "./log.ts";
import type { RoomManager } from "./room.ts";
import type { ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

/**
 * The caller's authority as a handler sees it: identity, what the token carries, and the
 * one question the doors ask. Handing plugins a bound `allows` rather than the
 * `AuthService`/`AuthContext` pair keeps the evaluator behind a single call surface — the
 * seam ADR 0011's waterfall replaces — and keeps a plugin from reaching into auth internals.
 */
export interface ActionAuth {
  readonly principal: Principal;
  readonly caps: readonly Cap[];
  readonly padScope: string | null;
  readonly isRoot: boolean;
  allows(cap: Exclude<Cap, "*">, padId?: string): boolean;
}

/** Composition administration, as a handler may drive it (`core.plugins.setEnabled`). */
export interface HostControl {
  setEnabled(id: string, enabled: boolean): { readonly refused: string } | { readonly ok: true };
  roster(): PluginRoster;
  enabled(id: string): boolean;
}

/**
 * Everything a server-side handler is given. The real services appear here, in the floor;
 * a plugin never names these types. Its `server.ts` declares the MINIMAL structural slice
 * it needs (`{ broker: { rename(id, name): "ok" | "not_found" } }`), and assembling
 * `SERVER_PLUGIN_DEFS` in `composition.ts` is where that slice is checked against this
 * context by assignment. That is the sandbox shape D1 asks for without a sandbox yet: a
 * plugin's declared surface is exactly what it can touch, and it is verified at build time.
 */
export interface ActionCtx {
  readonly principal: Principal;
  readonly auth: ActionAuth;
  readonly store: ServerStore;
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
  readonly host: HostControl;
  /**
   * The server's clock, injected rather than read from `Date`: a plugin enforcing a cadence
   * (a throttle, a cooldown) must be drivable by a deterministic test the same way every
   * other timed plane in the server is.
   */
  now(): number;
}

/**
 * One action's implementation.
 *
 * `args` is typed `never` so a handler may declare the exact input its schema parses — the
 * door has already validated by the time it is called — while the registry can hold every
 * handler in one map. `ctx` is typed as the full context for the opposite reason: a
 * narrower parameter is legal (that IS the structural slice), an unrelated one is not.
 *
 * Resolving `{ refused: string }` denies the dispatch with rule `refused`. Every wave-1
 * action's result schema is `{}`, so the two can never be confused; an action whose result
 * genuinely carries a `refused` string would need a different denial signal.
 */
export type ActionHandler = (ctx: ActionCtx, args: never) => Promise<unknown>;

/** A plugin's server half: what it declares, plus a handler per declared action. */
export type ServerPluginDef = PluginDef & {
  readonly handlers: Readonly<Record<string, ActionHandler>>;
};

/**
 * The action door's engine: it owns the live composition, answers dispatches, and is the
 * only writer of workspace-global enablement.
 *
 * The denial ladder is MONOTONIC and evaluated in one fixed order — unknown action, then
 * disabled plugin, then scoped-token refusal, then declared caps, then argument shape, then
 * the handler's own refusal. Order is contract, not implementation detail: each rung
 * answers a question the next rung would otherwise leak. A caller must not learn an
 * action's argument shape by probing a door it may not open, and a disabled plugin's
 * actions must report `plugin_disabled` rather than `unknown_action`, because those are
 * different truths a client acts on differently.
 */
export class PluginHost {
  private composed: Composition;
  private readonly handlers = new Map<string, Readonly<Record<string, ActionHandler>>>();
  private readonly rosterListeners = new Set<(roster: PluginRoster) => void>();

  constructor(
    private readonly defs: readonly ServerPluginDef[],
    private readonly store: ServerStore,
    private readonly authService: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
  ) {
    for (const def of defs) this.handlers.set(def.manifest.id, def.handlers);
    this.composed = composeRoster(defs, store.disabledPlugins());
  }

  composition(): Composition {
    return this.composed;
  }

  roster(): PluginRoster {
    return this.composed.roster;
  }

  /** Registers a roster listener and returns its removal, mirroring `AuthService.onRevoked`. */
  onRosterChange(listener: (roster: PluginRoster) => void): () => void {
    this.rosterListeners.add(listener);
    return () => {
      this.rosterListeners.delete(listener);
    };
  }

  /**
   * Flips workspace-global enablement, persists it, recomposes, and publishes the new
   * roster. Refusals are DATA the caller's action forwards: an unknown id, or an
   * `essential` manifest, which no administrator may switch off — a workspace whose shell
   * can be disabled is a workspace that can be bricked from the plugin list (D4).
   */
  setEnabled(id: string, enabled: boolean): { readonly refused: string } | { readonly ok: true } {
    const entry = this.composed.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return { refused: `unknown plugin "${id}"` };
    if (!enabled && entry.manifest.essential === true) return { refused: "essential" };
    if (entry.enabled === enabled) return { ok: true };
    this.store.setPluginEnabled(id, enabled);
    this.composed = composeRoster(this.defs, this.store.disabledPlugins());
    for (const listener of this.rosterListeners) listener(this.composed.roster);
    return { ok: true };
  }

  /**
   * One dispatch, one log line — whether it succeeded, was denied, or threw. A denial is
   * an ANSWER, so it logs at info with the rung that refused; only a broken handler or a
   * result that fails its own schema is an error.
   */
  async dispatch(auth: AuthContext, fullName: string, rawArgs: unknown): Promise<ActionOutcome> {
    let outcome: ActionOutcome;
    try {
      outcome = await this.run(auth, fullName, rawArgs);
    } catch (error) {
      this.logger.error("action", {
        name: fullName,
        principal: auth.principal.id,
        outcome: "failed",
        error: error instanceof Error ? error.message : "unknown failure",
      });
      throw error;
    }
    this.logger.info("action", {
      name: fullName,
      principal: auth.principal.id,
      outcome: outcome.ok ? "ok" : outcome.denial.rule,
    });
    return outcome;
  }

  private async run(
    auth: AuthContext,
    fullName: string,
    rawArgs: unknown,
  ): Promise<ActionOutcome> {
    const entry = this.composed.actions.get(fullName);
    if (entry === undefined) {
      return {
        ok: false,
        denial: { rule: "unknown_action", message: `unknown action "${fullName}"` },
      };
    }
    const pluginId = entry.plugin.id;
    if (!this.composed.enabled(pluginId)) {
      return {
        ok: false,
        denial: { rule: "plugin_disabled", message: `plugin "${pluginId}" is disabled` },
      };
    }
    if (auth.padScope !== null) {
      // The precedent every workspace route already sets (`POST /api/place`): a token
      // scoped to one container cannot authorize a workspace-grade mutation. This rung sits
      // ABOVE the cap check on purpose — a scoped token carrying the right cap is still
      // refused for its scope, and the message says which (D11).
      return {
        ok: false,
        denial: {
          rule: "forbidden",
          message: "scoped tokens cannot invoke workspace actions",
        },
      };
    }
    for (const cap of entry.def.caps) {
      const held = cap === "*" ? auth.isRoot : this.authService.allows(auth, cap);
      if (held) continue;
      return {
        ok: false,
        denial: { rule: "forbidden", message: `${cap} capability required` },
      };
    }
    const parsed = entry.def.input.safeParse(rawArgs);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      return { ok: false, denial: { rule: "invalid_args", message: detail } };
    }
    const handler = this.handlers.get(pluginId)?.[entry.def.name];
    if (handler === undefined) {
      // A composed action with no handler is a wiring bug in `composition.ts`, never a
      // caller's problem: it must surface as a server failure, not as a denial.
      throw new Error(`action "${fullName}" has no server handler`);
    }
    const ctx: ActionCtx = {
      principal: auth.principal,
      auth: {
        principal: auth.principal,
        caps: auth.caps,
        padScope: auth.padScope,
        isRoot: auth.isRoot,
        allows: (cap, padId) => this.authService.allows(auth, cap, padId),
      },
      store: this.store,
      rooms: this.rooms,
      broker: this.broker,
      host: this,
      now: () => this.runtime.now(),
    };
    const invoke = handler as (ctx: ActionCtx, args: unknown) => Promise<unknown>;
    const produced = await invoke(ctx, parsed.data);
    if (produced !== null && typeof produced === "object") {
      const refused = Reflect.get(produced, "refused");
      if (typeof refused === "string") {
        return { ok: false, denial: { rule: "refused", message: refused } };
      }
    }
    // A result that fails its published schema is a broken door, not a refused request:
    // the roster promised this shape to every reader, so the failure belongs in the logs.
    return { ok: true, result: entry.def.result.parse(produced) };
  }

  enabled(id: string): boolean {
    return this.composed.enabled(id);
  }
}
