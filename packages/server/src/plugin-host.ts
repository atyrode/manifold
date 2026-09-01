import {
  LIFECYCLE_TIMEOUT_MS,
  assembleRoster,
  compareDataVersion,
  enginePluginsActions,
  enginePluginsManifest,
  planDataMigration,
  runHook,
  type Assembly,
  type AssemblyDelta,
  type AssemblyEnv,
  type EmitEvent,
  type LifecycleCtx,
  type PluginDef,
  type PluginMigration,
  type PluginStorage,
  type PluginStorageAdmin,
  type PluginStoredData,
} from "@manifold/plugin";
import type {
  ActionOutcome,
  BootstrapPrincipalRequest,
  Cap,
  CreateGrantRequest,
  Dial,
  DialShareRequest,
  DialTicket,
  EventKind,
  EventPayload,
  Grant,
  ListGrantsRequest,
  ManifoldRef,
  MintShareRequest,
  MintTokenRequest,
  PluginLifecycleState,
  PluginPurgeResult,
  PluginRefusalReason,
  PluginRoster,
  Principal,
  RuntimeDeps,
  Share,
  ShareGrant,
  TokenGrant,
} from "@manifold/protocol";
import { ServiceError } from "./auth.ts";
import type { AuthContext, AuthService, MachineEnrollment, ServiceErrorCode } from "./auth.ts";
import type { EventHub } from "./event-hub.ts";
import type { InstanceDialer } from "./instance-dialer.ts";
import type { Logger } from "./log.ts";
import type { PlaceExecutor } from "./placement.ts";
import type { RoomManager } from "./room.ts";
import type { MachineRecord, ServerStore } from "./stores.ts";
import type { TerminalBroker } from "./terminal-broker.ts";

/**
 * The caller's authority as a handler sees it: identity, what the token carries, and the
 * one question the doors ask. Handing plugins a bound `allows` rather than the
 * `AuthService`/`AuthContext` pair keeps the evaluator behind one entry point — the
 * seam ADR 0011's waterfall replaces — and keeps a plugin from reaching into auth internals.
 */
export interface ActionAuth {
  readonly principal: Principal;
  readonly caps: readonly Cap[];
  readonly containerScope: string | null;
  readonly isRoot: boolean;
  allows(cap: Exclude<Cap, "*">, containerId?: string): boolean;
}

/**
 * An identity-mechanism call that the mechanism itself may refuse. `ServiceError` is a
 * floor class a plugin cannot name, so the binding catches it and hands the refusal back as
 * DATA carrying the same code the HTTP boundary maps — which is the broker's
 * `"ok" | "not_found"` vocabulary generalized: a plugin relays the mechanism's answers, it
 * does not invent them, and an expected refusal must never escape as a 500.
 */
export type IdentityResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ServiceErrorCode; readonly message: string };

/**
 * The identity mechanism's ADMINISTRATIVE door, pre-bound to the calling principal
 * exactly as `ActionAuth.allows` is.
 *
 * Binding rather than handing over `AuthService` is the same decision, for the same reason:
 * the caller is not a parameter a plugin may choose, so `core.access` cannot mint "as"
 * somebody else, and `authenticate`/`authenticateMachine` — the credential verifier, and the
 * one place raw secrets are compared — stay unreachable from above the floor. Every
 * attenuation rule (a minted cap set ⊆ the minter's, no widening of container scope,
 * revoking only what you minted) therefore still runs inside the mechanism, on the real
 * caller, where ADR 0011's evaluator will replace it.
 */
export interface IdentityDoor {
  /** Creates a principal with a root token; refuses a non-root caller (`forbidden`). */
  createPrincipal(input: BootstrapPrincipalRequest): IdentityResult<TokenGrant>;
  /** Mints authority no broader than the caller's own, within the caller's container scope. */
  mintToken(input: MintTokenRequest): IdentityResult<TokenGrant>;
  /** Revokes a principal's tokens the caller is entitled to revoke; answers the count. */
  revokePrincipal(principalId: string): IdentityResult<number>;
  /** Enrolls a machine, refusing a scoped or `machines:mint`-less caller. */
  enrollMachine(name: string): IdentityResult<MachineEnrollment>;
  /** Re-mints an enrolled machine's secret, revoking the previous one. */
  rotateMachineToken(machine: MachineRecord): IdentityResult<MachineEnrollment>;
  /**
   * Mints a share: a token bound to a node, for a named guest instance. Same ladder as
   * `mintToken` — a share IS a token (A5), so it is attenuated by the same rules and
   * refused with the same words.
   */
  mintShare(input: MintShareRequest): IdentityResult<ShareGrant>;
  /** Cuts a share and every guest identity minted under it; answers how many were severed. */
  revokeShare(shareId: string): IdentityResult<number>;
  /** Every share the caller is entitled to see. Never a secret, only its record. */
  listShares(): IdentityResult<readonly Share[]>;
  /**
   * Writes one authority row (ADR 0011). Root-only in the mechanism, which is where the
   * refusal that no deny row may name the workspace owner lives too — a door and a mechanism
   * that disagreed about who may write authority would be two answers to one question.
   */
  grant(input: CreateGrantRequest): IdentityResult<Grant>;
  /** Removes one authority row; answers 1 if a row went and 0 if there was nothing to remove. */
  revokeGrant(grantId: string): IdentityResult<number>;
  /** The rows themselves, optionally narrowed to one node or one principal. */
  listGrants(filter: ListGrantsRequest): IdentityResult<readonly Grant[]>;
}

/**
 * The GUEST end, which is deliberately NOT part of {@link IdentityDoor}.
 *
 * A dial is not the identity mechanism: nothing here mints, hashes or compares a secret
 * this instance issued. It is a store of grants somebody ELSE issued plus an outbound
 * network client, and folding it into the identity door would say the opposite — that this
 * instance is the authority over a share its host owns. Two surfaces, because there are two
 * authorities, and the whole of wave 3 is about not confusing them.
 *
 * Both mutating calls are async because both are round trips to another machine, and a door
 * that pretended otherwise would answer before it knew anything.
 */
export interface DialDoor {
  /** Accepts a share and holds open until the host welcomes it, or refuses with why not. */
  dial(input: DialShareRequest): Promise<IdentityResult<Dial>>;
  /** THIS instance deciding a local principal may use a grant addressed to the instance. */
  open(dialId: string): Promise<IdentityResult<DialTicket>>;
  /** Every dial this instance holds, live status included. */
  list(): IdentityResult<readonly Dial[]>;
}

/** Runs one mechanism call, turning its expected refusal into data and nothing else. */
function identityCall<T>(run: () => T): IdentityResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    if (error instanceof ServiceError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * The same, for a mechanism call that crosses the network. It exists rather than being
 * folded into {@link identityCall} with a union return because a caller must know at the
 * type level whether it is awaiting: "sometimes a promise" is the shape that produces a
 * handler quietly returning an unresolved value as a result.
 */
async function identityCallAsync<T>(run: () => Promise<T>): Promise<IdentityResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ServiceError) {
      return { ok: false, code: error.code, message: error.message };
    }
    throw error;
  }
}

/**
 * A refused administration attempt. The message ALWAYS begins with a named refusal class
 * from the published vocabulary (`PluginRefusalReason`), so a client can switch on it, and
 * carries the offenders after a colon when there are any to name — which ADR 0013 §5
 * requires of every refusal that replaces a cascade: "the refusal is one round trip, the
 * cascade is other people's plugins disappearing without their consent."
 */
export interface ActionRefused {
  readonly refused: string;
}

function refused(reason: PluginRefusalReason, names?: readonly string[]): ActionRefused {
  if (names === undefined || names.length === 0) return { refused: reason };
  return { refused: `${reason}: ${names.join(", ")}` };
}

/**
 * The ONE wording every scope violation gives, exported so a plugin's tests and a client's
 * switch both name it instead of retyping it.
 */
export const OUTSIDE_SCOPE_REFUSAL = "outside this token's container";

/** Assembly administration, as the engine's own builtin doors drive it. */
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
 * Liveness, and nothing else. The other services on `ActionCtx` are the real classes
 * because plugins need their breadth; the machine socket registry is asked exactly one
 * question by the assembly — is this machine connected right now — and handing over the
 * gateway that authenticates machines, fences superseded sockets and relays PTY frames in
 * order to answer it would be authority nobody asked for. `MachineGateway` satisfies this
 * structurally, which is also what lets a test drive liveness without a socket.
 */
export interface MachineLiveness {
  isOnline(machineId: string): boolean;
}

/**
 * Everything a server-side handler is given. The real services appear here, in the floor;
 * a plugin never names these types. Its `server.ts` declares the MINIMAL structural slice
 * it needs (`{ broker: { rename(id, name): "ok" | "not_found" } }`), and assembling
 * `SERVER_PLUGIN_DEFS` in `assembly.ts` is where that slice is checked against this
 * context by assignment. That is the sandbox shape D1 asks for without a sandbox yet: a
 * plugin's declared slice is exactly what it can touch, and it is verified at build time.
 */
export interface ActionCtx {
  readonly principal: Principal;
  readonly auth: ActionAuth;
  /**
   * The container this dispatch is confined to, or null for a workspace-grade caller.
   *
   * The same value the scope rung judged, promoted to the top of the context because it is a
   * CONTRACT and not a detail: an action declaring `scope: "container"` must keep every
   * effect inside this container while it is non-null, and must refuse anything its
   * arguments name elsewhere. Rung 4 proves the caller's caps hold at this container; only
   * the handler can know whether the row, terminal or element it was asked about lives here.
   *
   * A handler may declare it as its whole slice (`{ containerScope: string | null }`), which
   * is why it sits here rather than only inside `auth` — that object is the authority record
   * the evaluator seam consumes, this field is the question a handler asks.
   */
  readonly containerScope: string | null;
  /**
   * DISCHARGES THE CONTAINMENT OBLIGATION, once, for every plugin.
   *
   * Returns the canonical refusal when this caller's scope excludes `containerId`, and null
   * when the dispatch may proceed. A handler resolves the container of the thing its
   * arguments NAME — from the broker, the room, the store, whatever knows — and hands it here:
   *
   *     const denial = ctx.outsideScope(terminal.containerId);
   *     if (denial !== null) return denial;
   *
   * It exists because the check is identical in every plugin and the WORDING must not be:
   * hand-rolled variants ("scoped tokens can only read their own container", "...rename
   * their own container", ...) are several strings a client cannot switch on for one
   * concept, which is invariant 14 with the seams showing. The target container is
   * deliberately absent from the message — telling a scoped caller the id of a container it
   * may not reach is a disclosure the refusal does not need.
   *
   * A null `containerId` means the handler could not resolve one, which for a scoped caller
   * is refused for the same reason: authority cannot be proven against a container nobody
   * named.
   */
  outsideScope(containerId: string | null): ActionRefused | null;
  readonly store: ServerStore;
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
  /**
   * Live machine liveness, straight from the socket registry. Persisted machine rows are a
   * store read like any other; whether a machine is CONNECTED right now is knowledge only
   * the gateway holds, and `core.machines.list` has to answer both in one row.
   */
  readonly machines: MachineLiveness;
  /**
   * THE placement executor — one door onto every way a thing comes to be somewhere
   * (`core.space.place`). A plugin declares the minimal slice it uses, which for placement
   * is `place(request)`; the algebra, its denials and its failure modes stay in the floor.
   */
  readonly placement: PlaceExecutor;
  readonly host: HostControl;
  /**
   * The identity mechanism's administrative door, bound to THIS caller. Separate from
   * `auth` on purpose: `auth` answers what the caller may do, `identity` is what the caller
   * may hand to somebody else, and only `core.access` (plus machine enrollment) needs the
   * second question.
   */
  readonly identity: IdentityDoor;
  /**
   * The GUEST end of cross-instance sharing: the dials this instance holds and the door
   * that turns one into a ticket for the calling principal. Separate from `identity`
   * because a dial is somebody else's grant — see {@link DialDoor}.
   */
  readonly dials: DialDoor;
  /**
   * This plugin's OWN durable storage: namespaced, versioned, migration-ledgered. It is the
   * only place a plugin may keep data of its own — the bespoke tables floor code still owns
   * (terminal names, machine rows) move onto this storage in the conversion batch.
   */
  readonly storage: PluginStorage;
  /**
   * The server's clock, injected rather than read from `Date`: a plugin enforcing a cadence
   * (a throttle, a cooldown) must be drivable by a deterministic test the same way every
   * other timed plane in the server is.
   */
  now(): number;
  /**
   * Fresh ids from the same seam as the clock, for the same reason: a handler that mints an
   * id must be drivable by a deterministic test, exactly like every other id the server
   * creates.
   */
  newId(): string;
  /**
   * ONE NOTIFICATION, STAGED. The door this handler IS commits the change; this records that
   * it happened, on the `manifold://` node it happened to, under one of the kinds this
   * plugin's manifest declared (`contributes.events`).
   *
   * Staged, not sent: the buffer is flushed only when the dispatch resolves `{ ok: true }`,
   * so a handler that mutates and then refuses — or throws, or fails its own result schema —
   * publishes nothing. That is ADR 0012's "an event is emitted at the commit point" made
   * mechanical instead of left to handler discipline, and it is why a handler may call this
   * before it knows its own verdict.
   *
   * A kind this plugin did not declare is REFUSED at the hub (logged, dropped) rather than
   * fanned out: the declared vocabulary would be unfalsifiable at runtime otherwise.
   */
  readonly emit: EmitEvent;
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

/** The slice the engine's own doors touch: identity, and the assembly they administer. */
interface EngineDoorCtx {
  readonly principal: Principal;
  readonly host: HostControl;
}

/**
 * THE ENGINE'S BUILTIN ROWS. Registered by the host itself rather than through
 * `assembly.ts`, because administration of the assembly cannot be a member of it: a
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
 * The action door's engine: it owns the live assembly, answers dispatches, and is the
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
  private assembled: Assembly;
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
    private readonly placement: PlaceExecutor,
    private readonly machines: MachineLiveness,
    private readonly dialer: InstanceDialer,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
    private readonly events: EventHub,
    options: { readonly lifecycleTimeoutMs?: number } = {},
  ) {
    this.defs = [...ENGINE_BUILTIN_DEFS, ...defs];
    this.builtins = new Set(ENGINE_BUILTIN_DEFS.map((def) => def.manifest.id));
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? LIFECYCLE_TIMEOUT_MS;
    for (const def of this.defs) this.handlers.set(def.manifest.id, def.handlers);
    this.assembled = assembleRoster(this.defs, store.disabledPlugins(), this.env());
    /*
      Boot, in one pass and no promises: run the migrations assembly found owing, stamp
      the declared data version of everything serving, and claim element types for everything
      assembled. All three are synchronous because the substrate is — which is what keeps
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
    if (migrated) this.assembled = assembleRoster(this.defs, store.disabledPlugins(), this.env());
  }

  /** The durable and runtime facts an assembly needs, read fresh on every reassembly. */
  private env(): AssemblyEnv {
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
      if (declared === undefined || !this.assembled.enabled(def.manifest.id)) continue;
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

  /** Applies every migration the current assembly found owing. True if any ran. */
  private runPendingMigrations(): boolean {
    let ran = false;
    for (const [pluginId, migrations] of this.assembled.pendingMigrations) {
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

  assembly(): Assembly {
    return this.assembled;
  }

  roster(): PluginRoster {
    return this.assembled.roster;
  }

  /** Registers a roster listener and returns its removal, mirroring `AuthService.onRevoked`. */
  onRosterChange(listener: (roster: PluginRoster) => void): () => void {
    this.rosterListeners.add(listener);
    return () => {
      this.rosterListeners.delete(listener);
    };
  }

  /**
   * Flips workspace-global enablement, persists it with attribution, reassembles, tells the
   * plugins that survived, and publishes the new roster.
   *
   * Every refusal is DATA the caller's action forwards, and every one names a class from the
   * published vocabulary:
   *
   * - `unknown_plugin` — nothing assembled under that id;
   * - `builtin` — an engine door, which has no toggle because the thing that would toggle it
   *   is itself;
   * - `essential` — a plugin the workspace cannot draw itself without (`core.shell`);
   * - `missing_dependency` — disabling this would strand ENABLED plugins that require it, and
   *   the refusal names them. There is no disable cascade: in a workspace-global setting a
   *   cascade is other principals' plugins vanishing without their consent (ADR 0013 §5.4);
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
    const entry = this.assembled.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (this.assembled.builtin(id)) return refused("builtin", [id]);
    if (entry.enabled === enabled) return { ok: true };

    if (!enabled) {
      if (entry.manifest.essential === true) return refused("essential");
      const stranded = this.assembled.requiredBy(id);
      if (stranded.length > 0) return refused("missing_dependency", stranded);
    } else {
      const missing = this.assembled.unmet(id);
      if (missing.length > 0) return refused("dependency_disabled", missing);
      const clashes = this.assembled.conflicts(id);
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
      this.assembled.roster.filter((row) => row.enabled).map((row) => row.manifest.id),
    );
    this.store.setPluginEnabled(id, enabled, changedBy, this.runtime.now());
    // COMMIT FIRST, then tell people. A lifecycle hook has no vote (ADR 0013 §2): the roster
    // every client will render is already the truth by the time any plugin hears about it.
    this.assembled = assembleRoster(this.defs, this.store.disabledPlugins(), this.env());
    const delta: AssemblyDelta = {
      enabled: this.assembled.order.filter(
        (row) => this.assembled.enabled(row) && !wasEnabled.has(row),
      ),
      disabled: this.assembled.order.filter(
        (row) => !this.assembled.enabled(row) && wasEnabled.has(row),
      ),
    };
    await this.fanOut(delta, wasEnabled);
    this.publish();
    /*
      THE COMMIT POINT, announced. Not staged like a handler's emission: this method IS the
      commit, it has already returned every refusal it can, and it is reached both through
      `core.plugins.setEnabled` and directly by an embedder — so the emission belongs to the
      transition rather than to one of its callers (invariant 14: one door onto "the roster
      changed").

      The topic is `engine.plugins`' OWN node, not the toggled plugin's: a plugin may not be
      the subject of another plugin's emission (`emitterMayEmit`), and enablement is the
      engine's ledger about a plugin rather than the plugin's own news. Which plugin moved is
      the payload.
     */
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      enabled ? "plugin_enabled" : "plugin_disabled",
      changedBy,
      { plugin: id },
    );
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
    const entry = this.assembled.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (this.assembled.builtin(id)) return refused("builtin", [id]);
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
    // Same commit point, same ledger node, same reason as the enablement pair above.
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      "plugin_purged",
      purgedBy,
      { plugin: id, rows: removedRows, types: releasedTypes },
    );
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
      /*
        A lifecycle hook's emission is NOT staged: the transition that called the hook has
        already committed (ADR 0013 §2 — a hook has no vote), so there is no verdict left to
        withhold it for. `actor` is null because a hook runs on the engine's behalf: the
        principal who flipped the toggle is the actor of the `plugin_enabled` event above, not
        of whatever the plugin chooses to announce about its own state afterwards.
       */
      emit: (ref, kind, payload) => {
        this.events.emit(pluginId, ref, kind, null, payload ?? {});
      },
    };
  }

  /**
   * ONE FAN-OUT PER COMMIT, in assembly order, bounded, and unable to change anything.
   *
   * `onEnable` and `onDisable` fire for the plugins the delta names; then every SURVIVOR — a
   * plugin enabled before and after — gets one `onAssemblyChanged(delta)`. Order is the
   * assembly's topological order, which is why that order has to be derived and total
   * rather than incidental.
   *
   * A hook that throws or overruns its bound is NAMED, never obeyed: the roster records
   * `enable_failed` / `disable_failed` and the transition stands. A disable in particular
   * always completes — a plugin must not be able to make itself unremovable by failing on
   * the way out.
   */
  private async fanOut(delta: AssemblyDelta, wasEnabled: ReadonlySet<string>): Promise<void> {
    for (const id of delta.enabled) {
      await this.hook(id, "onEnable", "enable_failed");
    }
    for (const id of delta.disabled) {
      await this.hook(id, "onDisable", "disable_failed");
    }
    const survivors = this.assembled.order.filter(
      (id) => this.assembled.enabled(id) && wasEnabled.has(id) && !delta.enabled.includes(id),
    );
    for (const id of survivors) {
      const changed = this.defs.find((def) => def.manifest.id === id)?.lifecycle?.onAssemblyChanged;
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
        hook: "onAssemblyChanged",
        error: outcome.reason,
      });
    }
    // The states just recorded belong on the roster clients are about to receive, so the
    // assembly is rebuilt once here rather than published stale and corrected later.
    this.assembled = assembleRoster(this.defs, this.store.disabledPlugins(), this.env());
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
    for (const listener of this.rosterListeners) listener(this.assembled.roster);
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
    const entry = this.assembled.actions.get(fullName);
    if (entry === undefined) {
      return {
        ok: false,
        denial: { rule: "unknown_action", message: `unknown action "${fullName}"` },
      };
    }
    const pluginId = entry.plugin.id;
    if (!this.assembled.enabled(pluginId) && entry.def.cleanup !== true) {
      // Cleanup actions (D12) outlive a disable: turning core.terminals off must refuse
      // creation and administration, never the ability to remove what already exists.
      return {
        ok: false,
        denial: { rule: "plugin_disabled", message: `plugin "${pluginId}" is disabled` },
      };
    }
    /*
      RUNG 3 — SCOPE. A token scoped to one container cannot authorize a WORKSPACE-grade
      mutation: the precedent every workspace route already sets (`POST /api/place`), and it
      sits ABOVE the cap check on purpose, so a scoped token carrying the right cap is still
      refused for its scope and the message says which (D11).

      An action may DECLARE itself confined to one container (`scope: "container"`), and then
      a scoped caller falls through — the door's whole effect is inside the container the
      token already holds. That is a narrowing of the refusal, never a hole: rung 4 still
      runs, and for a scoped caller it now asks the caps AT that container rather than in the
      abstract, so a container-scoped token can never reach past its own container. What the
      rung cannot check is whether the thing named in the ARGUMENTS lives in that container —
      arguments are not parsed yet, deliberately — so honouring `ctx.containerScope` is the
      handler's contractual obligation.
    */
    const scope = entry.def.scope ?? "workspace";
    if (auth.containerScope !== null && scope !== "container") {
      return {
        ok: false,
        denial: {
          rule: "forbidden",
          message: "scoped tokens cannot invoke workspace actions",
        },
      };
    }
    for (const cap of entry.def.caps) {
      const held =
        cap === "*"
          ? auth.isRoot
          : this.authService.allows(auth, cap, auth.containerScope ?? undefined);
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
      // An assembled action with no handler is a wiring bug in `assembly.ts`, never a
      // caller's problem: it must be reported as a server failure, not as a denial.
      throw new Error(`action "${fullName}" has no server handler`);
    }
    /*
      THE STAGING BUFFER, one per dispatch. `ctx.emit` appends here and nothing leaves until
      this dispatch has answered `{ ok: true }` — so a handler that mutates and then refuses,
      throws, or fails its own result schema publishes nothing, and "refusals are not events"
      is a property of this function rather than a convention every handler has to remember.

      It is also what makes ONE EMISSION PER COMMIT checkable: whatever a handler stages, the
      flush below runs exactly once per successful dispatch, so a gesture that commits once
      (a drag arriving as one `core.space.place`) can produce one event and not one per frame.
     */
    const staged: { ref: ManifoldRef; kind: EventKind; payload: EventPayload }[] = [];
    const ctx: ActionCtx = {
      principal: auth.principal,
      auth: {
        principal: auth.principal,
        caps: auth.caps,
        containerScope: auth.containerScope,
        isRoot: auth.isRoot,
        allows: (cap, containerId) => this.authService.allows(auth, cap, containerId),
      },
      containerScope: auth.containerScope,
      outsideScope: (containerId) =>
        auth.containerScope !== null && containerId !== auth.containerScope
          ? { refused: OUTSIDE_SCOPE_REFUSAL }
          : null,
      store: this.store,
      rooms: this.rooms,
      broker: this.broker,
      machines: this.machines,
      placement: this.placement,
      host: this,
      identity: {
        createPrincipal: (input) =>
          identityCall(() => this.authService.bootstrapPrincipal(input, auth)),
        mintToken: (input) => identityCall(() => this.authService.mintToken(input, auth)),
        revokePrincipal: (principalId) =>
          identityCall(() => this.authService.revokePrincipal(principalId, auth)),
        enrollMachine: (name) => identityCall(() => this.authService.enrollMachine(name, auth)),
        rotateMachineToken: (machine) =>
          identityCall(() => this.authService.rotateMachineToken(machine, auth.principal.id)),
        mintShare: (input) => identityCall(() => this.authService.mintShare(input, auth)),
        revokeShare: (shareId) => identityCall(() => this.authService.revokeShare(shareId, auth)),
        listShares: () => identityCall(() => this.authService.listShares(auth)),
        grant: (input) => identityCall(() => this.authService.grant(input, auth)),
        revokeGrant: (grantId) => identityCall(() => this.authService.revokeGrant(grantId, auth)),
        listGrants: (filter) => identityCall(() => this.authService.listGrants(filter, auth)),
      },
      /*
        The guest door is bound to the CALLING PRINCIPAL the same way the identity door is,
        and that binding is what makes `openDial` this instance's own decision rather than a
        credential hand-off: the ticket the host mints stands for whoever asked here, and a
        plugin cannot choose somebody else to ask as.
      */
      dials: {
        dial: (input) => identityCallAsync(() => this.dialer.dial(input)),
        open: (dialId) => identityCallAsync(() => this.dialer.open(dialId, auth.principal)),
        list: () => identityCall(() => this.dialer.list()),
      },
      storage: this.storage(pluginId),
      now: () => this.runtime.now(),
      newId: () => this.runtime.newId(),
      emit: (ref, kind, payload) => {
        staged.push({ ref, kind, payload: payload ?? {} });
      },
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
    // It runs BEFORE the flush for the same reason the flush exists: a door that cannot
    // publish its own answer has not committed anything worth announcing.
    const result = entry.def.result.parse(produced);
    for (const event of staged) {
      this.events.emit(pluginId, event.ref, event.kind, auth.principal.id, event.payload);
    }
    return { ok: true, result };
  }

  enabled(id: string): boolean {
    return this.assembled.enabled(id);
  }
}
