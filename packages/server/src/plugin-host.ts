import {
  LIFECYCLE_TIMEOUT_MS,
  composeRoster,
  compareDataVersion,
  enginePluginsActions,
  enginePluginsManifest,
  planDataMigration,
  runHook,
  type Composition,
  type CompositionDelta,
  type CompositionEnv,
  type LifecycleCtx,
  type PluginDef,
  type PluginMigration,
  type PluginStorage,
  type PluginStorageAdmin,
  type PluginStoredData,
} from "@manifold/plugin";
import type {
  ActionOutcome,
  Cap,
  PluginLifecycleState,
  PluginPurgeResult,
  PluginRefusalReason,
  PluginRoster,
  Principal,
  RuntimeDeps,
} from "@manifold/protocol";
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

/**
 * A refused administration attempt. The message ALWAYS begins with a named refusal class
 * from the published vocabulary (`PluginRefusalReason`), so a client can switch on it, and
 * carries the offenders after a colon when there are any to name — which ADR 0013 §5
 * requires of every refusal that replaces a cascade: "the refusal is one round trip, the
 * cascade is other people's surfaces disappearing without their consent."
 */
export interface ActionRefused {
  readonly refused: string;
}

function refused(reason: PluginRefusalReason, names?: readonly string[]): ActionRefused {
  if (names === undefined || names.length === 0) return { refused: reason };
  return { refused: `${reason}: ${names.join(", ")}` };
}

/** Composition administration, as the engine's own builtin doors drive it. */
export interface HostControl {
  setEnabled(
    id: string,
    enabled: boolean,
    changedBy: string,
  ): Promise<ActionRefused | { ok: true }>;
  purge(id: string, purgedBy: string): Promise<ActionRefused | PluginPurgeResult>;
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
   * This plugin's OWN durable storage: namespaced, versioned, migration-ledgered. It is the
   * only place a plugin may keep data of its own — the bespoke tables floor code still owns
   * (terminal names, machine rows) move onto this surface in the conversion batch.
   */
  readonly storage: PluginStorage;
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
 * action's result schema is `{}` or a strict object with no `refused` member, so the two can
 * never be confused; an action whose result genuinely carries a `refused` string would need
 * a different denial signal.
 */
export type ActionHandler = (ctx: ActionCtx, args: never) => Promise<unknown>;

/** A plugin's server half: what it declares, plus a handler per declared action. */
export type ServerPluginDef = PluginDef & {
  readonly handlers: Readonly<Record<string, ActionHandler>>;
};

/** The slice the engine's own doors touch: identity, and the composition they administer. */
interface EngineDoorCtx {
  readonly principal: Principal;
  readonly host: HostControl;
}

/**
 * THE ENGINE'S BUILTIN ROWS. Registered by the host itself rather than through
 * `composition.ts`, because administration of the composition cannot be a member of it: a
 * plugin owning `setEnabled` can be disabled, and then the door that would re-enable it
 * answers `plugin_disabled` to everyone including root.
 *
 * They are otherwise ordinary in every respect a reader can observe — same manifest shape,
 * same published JSON Schemas, same denial ladder, same roster — which is the point.
 * `source: "builtin"` says only "this row has no toggle".
 */
const ENGINE_BUILTIN_DEFS: readonly ServerPluginDef[] = [
  {
    manifest: enginePluginsManifest,
    actions: enginePluginsActions,
    handlers: {
      async setEnabled(
        ctx: EngineDoorCtx,
        args: { id: string; enabled: boolean },
      ): Promise<ActionRefused | Record<string, never>> {
        const outcome = await ctx.host.setEnabled(args.id, args.enabled, ctx.principal.id);
        if ("refused" in outcome) return outcome;
        return {};
      },
      async purge(
        ctx: EngineDoorCtx,
        args: { id: string },
      ): Promise<ActionRefused | PluginPurgeResult> {
        return ctx.host.purge(args.id, ctx.principal.id);
      },
    },
  },
];

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
 *
 * Contract v2 (ADR 0013) adds no rung. Everything it introduced — dependency violations,
 * incompatibility, data downgrades, a purge of running code, a builtin row somebody tried
 * to switch off — is state only the handler can see, so all of it lands on the LAST rung as
 * a named `refused` class. The ladder a client learned still holds.
 */
export class PluginHost {
  private composed: Composition;
  private readonly defs: readonly ServerPluginDef[];
  private readonly handlers = new Map<string, Readonly<Record<string, ActionHandler>>>();
  private readonly storages = new Map<string, PluginStorageAdmin>();
  private readonly rosterListeners = new Set<(roster: PluginRoster) => void>();
  private readonly builtins: ReadonlySet<string>;
  /**
   * The outcome of the last lifecycle fan-out per plugin. In MEMORY, deliberately: it
   * describes this process's attempt to tell a plugin about a transition, not a durable
   * fact about the workspace. A restart clears it because a restart re-runs nothing.
   */
  private readonly lifecycleStates = new Map<string, PluginLifecycleState>();
  private readonly lifecycleTimeoutMs: number;

  constructor(
    defs: readonly ServerPluginDef[],
    private readonly store: ServerStore,
    private readonly authService: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
    options: { readonly lifecycleTimeoutMs?: number } = {},
  ) {
    this.defs = [...ENGINE_BUILTIN_DEFS, ...defs];
    this.builtins = new Set(ENGINE_BUILTIN_DEFS.map((def) => def.manifest.id));
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? LIFECYCLE_TIMEOUT_MS;
    for (const def of this.defs) this.handlers.set(def.manifest.id, def.handlers);
    this.composed = composeRoster(this.defs, store.disabledPlugins(), this.env());
    /*
      Boot, in one pass and no promises: run the migrations composition found owing, stamp
      the declared data version of everything serving, and claim element types for everything
      composed. All three are synchronous because the substrate is — which is what keeps
      process start free of a lifecycle fan-out (`onEnable` is a TRANSITION hook: at boot
      everything enabled is simply live) and keeps the server from answering a request over
      data a pending migration has not touched yet.
    */
    const migrated = this.runPendingMigrations();
    this.stampDeclaredVersions();
    for (const def of this.defs) {
      const types = def.manifest.contributes.elements.map((element) => element.type);
      if (types.length > 0) store.claimElementTypes(def.manifest.id, types);
    }
    if (migrated) this.composed = composeRoster(this.defs, store.disabledPlugins(), this.env());
  }

  /** The durable and runtime facts a composition needs, read fresh on every recompose. */
  private env(): CompositionEnv {
    const dataState = new Map<string, PluginStoredData>();
    for (const def of this.defs) {
      const storage = this.storage(def.manifest.id);
      dataState.set(def.manifest.id, {
        version: storage.dataVersion(),
        applied: storage.appliedMigrations(),
      });
    }
    return {
      builtins: this.builtins,
      elementOwners: this.store.elementOwners(),
      dataState,
      lifecycle: this.lifecycleStates,
      attribution: this.store.pluginAttribution(),
    };
  }

  /**
   * Records the data version of every plugin that is SERVING, so the first byte a plugin
   * writes is already attributable to a version. Without it a fresh store would carry data
   * at no version at all, and the next downgrade would have nothing to refuse against.
   *
   * A disabled plugin is skipped: its data is retained and untouched, and stamping it would
   * be the engine writing into a store whose owner is not running. A major difference is
   * skipped too — that is migration territory, already planned or already refused.
   */
  private stampDeclaredVersions(): void {
    for (const def of this.defs) {
      const declared = def.manifest.dataVersion;
      if (declared === undefined || !this.composed.enabled(def.manifest.id)) continue;
      const storage = this.storage(def.manifest.id);
      const stored = storage.dataVersion();
      if (stored !== null && stored.major !== declared.major) continue;
      if (stored !== null && compareDataVersion(stored, declared) === 0) continue;
      storage.stampDataVersion(declared);
    }
  }

  private storage(pluginId: string): PluginStorageAdmin {
    const existing = this.storages.get(pluginId);
    if (existing !== undefined) return existing;
    const created = this.store.pluginStorage(pluginId);
    this.storages.set(pluginId, created);
    return created;
  }

  /** Applies every migration the current composition found owing. True if any ran. */
  private runPendingMigrations(): boolean {
    let ran = false;
    for (const [pluginId, migrations] of this.composed.pendingMigrations) {
      ran = this.applyMigrations(pluginId, migrations) || ran;
    }
    return ran;
  }

  /**
   * One plugin's migration chain, in order, each recorded by NAME before the next runs. The
   * ledger entry is what makes a migration at-most-once across restarts, and the version
   * stamp is what makes the next boot's plan a no-op.
   *
   * A throwing migration is fatal by design: the alternative is serving requests over data
   * a plugin declared it cannot read. There is no half-migrated state to reason about
   * because there is no catch here.
   */
  private applyMigrations(pluginId: string, migrations: readonly PluginMigration[]): boolean {
    if (migrations.length === 0) return false;
    const storage = this.storage(pluginId);
    for (const migration of migrations) {
      migration.migrate(storage);
      storage.recordMigration(migration.name, this.runtime.now());
      this.logger.info("plugin_migration", { plugin: pluginId, migration: migration.name });
    }
    const declared = this.defs.find((def) => def.manifest.id === pluginId)?.manifest.dataVersion;
    if (declared !== undefined) storage.stampDataVersion(declared);
    return true;
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
   * Flips workspace-global enablement, persists it with attribution, recomposes, tells the
   * plugins that survived, and publishes the new roster.
   *
   * Every refusal is DATA the caller's action forwards, and every one names a class from the
   * published vocabulary:
   *
   * - `unknown_plugin` — nothing composed under that id;
   * - `builtin` — an engine door, which has no toggle because the thing that would toggle it
   *   is itself;
   * - `essential` — a plugin the workspace cannot draw itself without (`core.shell`);
   * - `missing_dependency` — disabling this would strand ENABLED plugins that require it, and
   *   the refusal names them. There is no disable cascade: in a workspace-global setting a
   *   cascade is other principals' surfaces vanishing without their consent (ADR 0013 §5.4);
   * - `dependency_disabled` — enabling this needs plugins that are off, and names them. No
   *   enable cascade either: one toggle, one plugin, one visible consequence (§5.5);
   * - `incompatible_dependency` — an enabled plugin declares this one incompatible;
   * - `data_downgrade` / `data_migration_missing` — this plugin's stored data cannot be
   *   safely read by its code, and no migration bridges the gap.
   */
  async setEnabled(
    id: string,
    enabled: boolean,
    changedBy: string,
  ): Promise<ActionRefused | { ok: true }> {
    const entry = this.composed.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (this.composed.builtin(id)) return refused("builtin", [id]);
    if (entry.enabled === enabled) return { ok: true };

    if (!enabled) {
      if (entry.manifest.essential === true) return refused("essential");
      const stranded = this.composed.requiredBy(id);
      if (stranded.length > 0) return refused("missing_dependency", stranded);
    } else {
      const missing = this.composed.unmet(id);
      if (missing.length > 0) return refused("dependency_disabled", missing);
      const clashes = this.composed.conflicts(id);
      if (clashes.length > 0) return refused("incompatible_dependency", clashes);
      /*
        Data is checked at the door as well as at boot, because a disabled plugin's data is
        RETAINED and untouched (the residual mechanism is `retain`; there is no
        erase-on-disable) — so the first moment its version matters again is the moment
        somebody asks it to serve. Refusing here is what keeps that refusal attributable to
        an actor instead of surfacing as a boot that will not come up.
      */
      const storage = this.storage(id);
      const plan = planDataMigration({
        pluginId: id,
        declared: entry.manifest.dataVersion,
        stored: storage.dataVersion(),
        applied: new Set(storage.appliedMigrations()),
        migrations: this.defs.find((def) => def.manifest.id === id)?.migrations ?? [],
      });
      if (plan.kind === "refused") return { refused: `${plan.reason}: ${plan.detail}` };
      // `migrate` stamps the declared version itself, once its chain has actually run.
      if (plan.kind === "migrate") this.applyMigrations(id, plan.run);
      else if (plan.stamp !== null) storage.stampDataVersion(plan.stamp);
    }

    const wasEnabled = new Set(
      this.composed.roster.filter((row) => row.enabled).map((row) => row.manifest.id),
    );
    this.store.setPluginEnabled(id, enabled, changedBy, this.runtime.now());
    // COMMIT FIRST, then tell people. A lifecycle hook has no vote (ADR 0013 §2): the roster
    // every client will render is already the truth by the time any plugin hears about it.
    this.composed = composeRoster(this.defs, this.store.disabledPlugins(), this.env());
    const delta: CompositionDelta = {
      enabled: this.composed.order.filter(
        (row) => this.composed.enabled(row) && !wasEnabled.has(row),
      ),
      disabled: this.composed.order.filter(
        (row) => !this.composed.enabled(row) && wasEnabled.has(row),
      ),
    };
    await this.fanOut(delta, wasEnabled);
    this.publish();
    return { ok: true };
  }

  /**
   * THE PURGE VERB — the only destructive one, and the reason a disable is not.
   *
   * A disable retains everything. Destroying a plugin's data is a separate, explicitly named
   * act, refused while that plugin is still enabled (`still_enabled`) because erasing the
   * state of running code is not something anybody meant to ask for. The plugin is told
   * through `onPurge` — under the same 2-second bound, and its failure does not stop the
   * purge, because the remedy for a plugin that will not clean up cannot be that plugin.
   *
   * What goes: its storage namespace (rows, data-version stamp, migration ledger) and its
   * element-type reservations. What does not: documents. A canvas's `draw` elements are the
   * workspace's data, not the plugin's, and they keep rendering as named placeholders — the
   * purge released the reservation, so a replacement may now claim the type deliberately.
   */
  async purge(id: string, purgedBy: string): Promise<ActionRefused | PluginPurgeResult> {
    const entry = this.composed.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (this.composed.builtin(id)) return refused("builtin", [id]);
    if (entry.enabled) return refused("still_enabled", [id]);

    const def = this.defs.find((candidate) => candidate.manifest.id === id);
    const onPurge = def?.lifecycle?.onPurge;
    if (onPurge !== undefined) {
      const outcome = await runHook(() => onPurge(this.lifecycleCtx(id)), this.lifecycleTimeoutMs);
      if (!outcome.ok) {
        this.logger.error("plugin_lifecycle", {
          plugin: id,
          hook: "onPurge",
          error: outcome.reason,
        });
      }
    }

    const storage = this.storage(id);
    const removedRows = storage.clear();
    const releasedTypes = this.store.releaseElementTypes(id);
    this.logger.info("plugin_purge", {
      plugin: id,
      principal: purgedBy,
      rows: removedRows,
      types: releasedTypes,
    });
    return {
      id,
      removed: {
        storage: removedRows,
        elements: entry.manifest.contributes.elements.length,
        ownership: releasedTypes,
      },
    };
  }

  private lifecycleCtx(pluginId: string): LifecycleCtx {
    return {
      pluginId,
      storage: this.storage(pluginId),
      now: () => this.runtime.now(),
    };
  }

  /**
   * ONE FAN-OUT PER COMMIT, in composition order, bounded, and unable to change anything.
   *
   * `onEnable` and `onDisable` fire for the plugins the delta names; then every SURVIVOR — a
   * plugin enabled before and after — gets one `onCompositionChanged(delta)`. Order is the
   * composition's topological order, which is why that order has to be derived and total
   * rather than incidental.
   *
   * A hook that throws or overruns its bound is NAMED, never obeyed: the roster records
   * `enable_failed` / `disable_failed` and the transition stands. A disable in particular
   * always completes — a plugin must not be able to make itself unremovable by failing on
   * the way out.
   */
  private async fanOut(delta: CompositionDelta, wasEnabled: ReadonlySet<string>): Promise<void> {
    for (const id of delta.enabled) {
      await this.hook(id, "onEnable", "enable_failed");
    }
    for (const id of delta.disabled) {
      await this.hook(id, "onDisable", "disable_failed");
    }
    const survivors = this.composed.order.filter(
      (id) => this.composed.enabled(id) && wasEnabled.has(id) && !delta.enabled.includes(id),
    );
    for (const id of survivors) {
      const changed = this.defs.find((def) => def.manifest.id === id)?.lifecycle
        ?.onCompositionChanged;
      if (changed === undefined) continue;
      const outcome = await runHook(
        () => changed(this.lifecycleCtx(id), delta),
        this.lifecycleTimeoutMs,
      );
      if (outcome.ok) continue;
      // No lifecycle CLASS for this one, and deliberately none: the plugin's own enablement
      // did not move, so there is no state about it to correct — only a report to make.
      this.logger.error("plugin_lifecycle", {
        plugin: id,
        hook: "onCompositionChanged",
        error: outcome.reason,
      });
    }
    // The states just recorded belong on the roster clients are about to receive, so the
    // composition is rebuilt once here rather than published stale and corrected later.
    this.composed = composeRoster(this.defs, this.store.disabledPlugins(), this.env());
  }

  private async hook(
    id: string,
    name: "onEnable" | "onDisable",
    failure: PluginLifecycleState,
  ): Promise<void> {
    const invoke = this.defs.find((def) => def.manifest.id === id)?.lifecycle?.[name];
    if (invoke === undefined) {
      this.lifecycleStates.delete(id);
      return;
    }
    const outcome = await runHook(() => invoke(this.lifecycleCtx(id)), this.lifecycleTimeoutMs);
    if (outcome.ok) {
      this.lifecycleStates.delete(id);
      return;
    }
    this.lifecycleStates.set(id, failure);
    this.logger.error("plugin_lifecycle", { plugin: id, hook: name, error: outcome.reason });
  }

  private publish(): void {
    for (const listener of this.rosterListeners) listener(this.composed.roster);
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

  private async run(auth: AuthContext, fullName: string, rawArgs: unknown): Promise<ActionOutcome> {
    const entry = this.composed.actions.get(fullName);
    if (entry === undefined) {
      return {
        ok: false,
        denial: { rule: "unknown_action", message: `unknown action "${fullName}"` },
      };
    }
    const pluginId = entry.plugin.id;
    if (!this.composed.enabled(pluginId) && entry.def.cleanup !== true) {
      // Cleanup actions (D12) outlive a disable: turning core.terminals off must refuse
      // creation and administration, never the ability to remove what already exists.
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
      storage: this.storage(pluginId),
      now: () => this.runtime.now(),
    };
    const invoke = handler as (ctx: ActionCtx, args: unknown) => Promise<unknown>;
    const produced = await invoke(ctx, parsed.data);
    if (produced !== null && typeof produced === "object") {
      const denial = Reflect.get(produced, "refused");
      if (typeof denial === "string") {
        return { ok: false, denial: { rule: "refused", message: denial } };
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
