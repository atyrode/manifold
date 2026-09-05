import {
  AssemblyError,
  ENGINE_INSTALLED_EVENT,
  ENGINE_UNINSTALLED_EVENT,
  LIFECYCLE_TIMEOUT_MS,
  assembleRoster,
  compareDataVersion,
  enginePluginsActions,
  enginePluginsManifest,
  planDataMigration,
  runHook,
  settingRefId,
  settingWriteRefusal,
  type Assembly,
  type AssemblyDelta,
  type AssemblyEnv,
  type EmitEvent,
  type LifecycleCtx,
  type PluginDef,
  type PluginInstallRequest,
  type PluginInstallResult,
  type PluginMigration,
  type PluginStorage,
  type PluginStorageAdmin,
  type PluginStoredData,
} from "@manifold/plugin";
import {
  CAPS,
  CORE_NAMESPACE_PREFIX,
  ENGINE_NAMESPACE_PREFIX,
  formatManifoldUri,
  TRACE_AUTHORITY_OPEN,
  TRACE_AUTHORITY_ROOT,
} from "@manifold/protocol";
import type {
  ActionDenialRule,
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
  PluginBundle,
  PluginInstall,
  PluginInstallRefusal,
  PluginLifecycleState,
  PluginPurgeResult,
  PluginRefusalReason,
  PluginRoster,
  Principal,
  PrincipalCredentials,
  RuntimeDeps,
  Share,
  ShareGrant,
  TokenGrant,
  UNTRACED_DENIAL_RULE,
} from "@manifold/protocol";
import { ServiceError } from "./auth.ts";
import type { AuthContext, AuthService, MachineEnrollment, ServiceErrorCode } from "./auth.ts";
import type { EventHub } from "./event-hub.ts";
import type { InstanceDialer } from "./instance-dialer.ts";
import {
  IsolateDenial,
  IsolateLoadError,
  isolateLifecycleState,
  type IsolateRunner,
  type IsolateState,
} from "./isolate/contract.ts";
import { localActionDef } from "./isolate/proxy-def.ts";
import { redactFields, type Logger } from "./log.ts";
import type { PlaceExecutor } from "./placement.ts";
import {
  InstallRefusal,
  installArtifact,
  removeInstall,
  verifyInstalledBundle,
  type InstalledArtifact,
} from "./plugin-installs.ts";
import type { RoomManager } from "./room.ts";
import type { MachineRecord, PluginInstallRow, ServerStore, TraceAttribution } from "./stores.ts";
import type { DrainOutcome, TerminalBroker } from "./terminal-broker.ts";

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
   * WITHDRAWS an enrolled machine's credential, keeping the inventory row. The door ADR 0019
   * §3 names as missing: `rotateMachineToken` above replaces a secret, and nothing could ask
   * for one to simply stop working. Answers how many credentials died — 0 when it was already
   * withdrawn, which is a success and not a refusal.
   */
  revokeMachine(machineId: string): IdentityResult<number>;
  /**
   * Every principal this caller may administer, when it was created, and its live
   * credentials (ADR 0019 §3). `tokens:mint`, narrowed to what this caller could revoke —
   * the read and the write it feeds are graded together, and the reasoning is at the
   * mechanism (`AuthService.listCredentials`).
   */
  listCredentials(): IdentityResult<readonly PrincipalCredentials[]>;
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

/** An install door's refusal: class first, detail after, the same shape `refused` gives. */
function installRefused(reason: PluginInstallRefusal, detail: string): ActionRefused {
  return { refused: `${reason}: ${detail}` };
}

/**
 * THE HIGH-RISK SET a default grant never includes (ADR 0016 §5, R4 = option B): root, the
 * power to mint credentials, and the power to change the roster. A stranger's plugin that
 * declares them gets them only when an installer names them in `grant`.
 */
const UNGRANTED_BY_DEFAULT: Partial<Record<Cap, true>> = {
  "*": true,
  "tokens:mint": true,
  "plugins:manage": true,
};

/** A cap the manifest's ceiling covers: named, or anything but `*` when `*` is declared. */
function withinCeiling(cap: Cap, declared: readonly Cap[]): boolean {
  return declared.includes(cap) || (cap !== "*" && declared.includes("*"));
}

/**
 * The capability set an install consents to: the manifest's declaration minus the high-risk
 * set, widened by whatever the installer named — restricted in both halves to caps that exist
 * and that the manifest actually declared, because a grant is `granted ∩ declared` at the door
 * and publishing a cap the plugin could never exercise would misdescribe the row.
 */
function grantFor(declared: readonly Cap[], widen: readonly Cap[] | undefined): Cap[] {
  const granted = new Set<Cap>();
  for (const cap of declared) {
    if (CAPS.includes(cap) && UNGRANTED_BY_DEFAULT[cap] !== true) granted.add(cap);
  }
  for (const cap of widen ?? []) {
    if (CAPS.includes(cap) && withinCeiling(cap, declared)) granted.add(cap);
  }
  return CAPS.filter((cap) => granted.has(cap));
}

/**
 * The roster row of an install whose bundle failed boot verification: NOTHING from the file is
 * trusted — not its title, not its contributions, not its capability ceiling — so the row is
 * the id the installer consented to, a description that names the refusal, and the DOORS THE
 * ROW REMEMBERS: the summaries the assembly published when the install was admitted, kept on
 * the row since (`PluginInstallRow.actions`). They are published so a dispatch to one is a
 * traced `unavailable` naming the refusal, rather than `unknown_action` — the one rung the
 * ledger does not keep — for a door the roster showed yesterday. The ceiling is the union of
 * what those doors declare, which is a fact from the row, not from the file, and is what lets
 * them compose; the installer's grant still narrows it at rung 4 as it always did.
 *
 * A row admitted before its doors were recorded has `[]` here and composes doorless, which is
 * the shape it always had. Either way a refused row appears (R8 wants the failure seen).
 */
function unverifiedDef(row: PluginInstallRow, refusal: PluginInstallRefusal): ServerPluginDef {
  // The rung is `unavailable` — the runner's own — and the message is the boot verdict.
  const message = `bundle failed verification at boot: ${refusal}`;
  const handlers: Record<string, ActionHandler> = {};
  const actions = row.actions.map((summary) => {
    const action = localActionDef(row.pluginId, summary);
    handlers[action.name] = async () => {
      throw new IsolateDenial("unavailable", message);
    };
    return action;
  });
  const capabilities = [...new Set(actions.flatMap((action) => action.caps))].sort();
  return {
    manifest: {
      id: row.pluginId,
      version: "unverified",
      title: row.pluginId,
      description: `Installed bundle refused at boot (${refusal}); nothing from it was loaded.`,
      capabilities,
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions,
    handlers,
  };
}

/** The worker module's bytes, decoded once at load so the route serves without re-decoding. */
function webModuleOf(bundle: PluginBundle): Uint8Array | null {
  const name = bundle.manifest.entry.web;
  if (name === undefined) return null;
  const encoded = bundle.files[name];
  return encoded === undefined ? null : Buffer.from(encoded, "base64");
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
  install(
    request: PluginInstallRequest,
    installedBy: string,
  ): Promise<ActionRefused | PluginInstallResult>;
  uninstall(id: string, removedBy: string, purge: boolean): Promise<ActionRefused | { ok: true }>;
  roster(): PluginRoster;
  enabled(id: string): boolean;
}

/**
 * What the host needs to run INSTALLED plugins (ADR 0016 §8 stage 2): the runner that holds a
 * child process per plugin, and the data dir the artifacts live under. Absent ≡ this host
 * admits no bundles — the install door refuses, and a unit test composing first-party defs
 * never spawns a process.
 */
export interface IsolateDeps {
  readonly runner: IsolateRunner;
  readonly dataDir: string;
  /** `MANIFOLD_PLUGIN_DEV_PATHS=1`: path sources anywhere, not only under `plugin-uploads/`. */
  readonly devPaths?: boolean;
}

/**
 * One installed plugin as the host holds it: the row (the installer's consent), the bundle
 * when the stored file re-hashed to the pin, the decoded web module the route serves, and the
 * refusal when it did not.
 */
interface InstalledPlugin {
  readonly row: PluginInstallRow;
  readonly bundle: PluginBundle | null;
  readonly web: Uint8Array | null;
  readonly refusal?: PluginInstallRefusal;
}

/**
 * The two questions the assembly asks the machine socket registry — is this machine
 * connected right now, and close or reopen its terminal admission and hear what its owner
 * holds (#278) — and nothing else. The other services on `ActionCtx` are the real classes
 * because plugins need their breadth; handing over the gateway that authenticates machines,
 * fences superseded sockets and relays PTY frames in order to answer two questions would be
 * authority nobody asked for. `MachineGateway` satisfies this structurally, which is also
 * what lets a test drive liveness and drain without a socket.
 */
export interface MachineAdmission {
  isOnline(machineId: string): boolean;
  drain(machineId: string, draining: boolean): Promise<DrainOutcome>;
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
  /** The write-ahead ledger row's id, as returned by `core.events.list`. */
  readonly traceId: number;
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
   * Live machine liveness and admission, straight from the socket registry. Persisted machine
   * rows are a store read like any other; whether a machine is CONNECTED right now, and what
   * its PTY owner holds, is knowledge only the gateway has, and `core.machines.list` and
   * `core.machines.drain` have to answer with it.
   */
  readonly machines: MachineAdmission;
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
   * This plugin's OWN durable storage: namespaced, versioned, migration-ledgered, and
   * promise-returning whether the plugin runs in-realm or isolated (ADR 0016 §4). It is the
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
  /** Names a trace target when an act has no event-plane announcement. */
  target(ref: ManifoldRef): void;
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

/**
 * The slice the engine's own doors touch: identity, the assembly they administer, and — for
 * the one door that writes the CALLER rather than the workspace — the principal-keyed store its
 * value lands in.
 */
interface EngineDoorCtx {
  readonly principal: Principal;
  readonly host: HostControl;
  readonly store: Pick<ServerStore, "pluginSettings" | "setPluginSettings">;
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
      /**
       * The two doors onto a stranger's code (ADR 0016 §8 stage 2). Thin on purpose: every
       * verdict — the artifact, the namespace, the grant, the assembly — is the host's, because
       * the host owns the roster the install changes, and a door that decided any of it here
       * would be a second reading of the same rules.
       */
      async install(
        ctx: EngineDoorCtx,
        args: PluginInstallRequest,
      ): Promise<ActionRefused | PluginInstallResult> {
        return ctx.host.install(args, ctx.principal.id);
      },
      async uninstall(
        ctx: EngineDoorCtx,
        args: { id: string; purge?: boolean },
      ): Promise<ActionRefused | Record<string, never>> {
        const outcome = await ctx.host.uninstall(args.id, ctx.principal.id, args.purge === true);
        if ("refused" in outcome) return outcome;
        return {};
      },
      /**
       * A PREFERENCE, written against the caller's own principal. Two rungs and no more:
       *
       *  1. the declaration must exist, which is the assembly's answer and not the caller's
       *     (`settingWriteRefusal`) — a value nothing declares is a delta nothing would ever
       *     read, and storing it would grow an unbounded map of dead refs;
       *  2. `null` RETRACTS, so the ref leaves the map and the row reads its manifest's
       *     default. Writing the default explicitly is deliberately NOT retraction: "I chose
       *     this" and "I have no opinion" are different sentences, and only the second one
       *     should follow a plugin when it changes what it ships.
       *
       * The whole map is read and rewritten because that is what one meta row means; the store
       * validates and key-sorts it on the way down.
       */
      async setSetting(
        ctx: EngineDoorCtx,
        args: { plugin: string; setting: string; value: boolean | null },
      ): Promise<ActionRefused | Record<string, never>> {
        const refusal = settingWriteRefusal(ctx.host.roster(), args.plugin, args.setting);
        if (refusal !== null) return { refused: refusal };
        const ref = settingRefId(args.plugin, args.setting);
        const current = ctx.store.pluginSettings(ctx.principal.id);
        const next = { ...current };
        if (args.value === null) {
          if (current[ref] === undefined) return {};
          delete next[ref];
        } else {
          if (current[ref] === args.value) return {};
          next[ref] = args.value;
        }
        ctx.store.setPluginSettings(ctx.principal.id, next);
        return {};
      },
    },
  },
];

/**
 * THE TRACE LEDGER, as the ladder needs it (axiom A6, ADR 0018). Three derivations and a
 * bound, module-level because none of them touches host state and all four are the record's
 * definition rather than the host's behaviour.
 */

/**
 * How much of a door's arguments the ledger keeps. Arguments are CALLER-CONTROLLED, so an
 * unbounded copy of every dispatch's body is a door onto the disk: the bound is what keeps a
 * ledger row the size of a record rather than the size of a request. Over the bound the row
 * keeps the shape — how many bytes, and which keys — because "somebody called this door with
 * something enormous" is the auditable fact, and the bytes themselves were never it.
 */
const TRACE_PAYLOAD_MAX_CHARS = 4_096;

/**
 * The authority the ladder discharged, in one string an auditor can read.
 *
 * `root` when the caller's authority is the wildcard, because that IS what was satisfied — a
 * root caller passes every rung by being root, and recording the door's demand instead would
 * claim a grant that was never consulted. Otherwise the door's declared caps, all of which the
 * rung below discharged against the credential's grants, joined so a multi-cap door reads as
 * one authority rather than as an arbitrary first choice.
 *
 * When ADR 0011's evaluator can answer WHICH grant row decided, this becomes that row's id and
 * the cap list becomes its detail; today `allows` answers a boolean, so the cap name is the
 * most precise honest answer available (ADR 0018 §6).
 */
function traceAuthority(auth: AuthContext, caps: readonly Cap[]): string {
  if (auth.isRoot) return TRACE_AUTHORITY_ROOT;
  if (caps.length === 0) return TRACE_AUTHORITY_OPEN;
  return caps.join("+");
}

/**
 * The container an exercise belongs to, decided from what is knowable BEFORE arguments parse:
 * the token's own scope, then the container the caller named. Both can be wrong in the same
 * way — a scoped token is confined to the container it names, and a bogus `containerId`
 * argument is about to be refused — and neither can be a lie about attribution, because the
 * row records what the caller asked for rather than what the door found.
 *
 * NULL is the honest answer for a workspace-grade exercise, and it puts the row where a
 * workspace-wide read finds it (`core.events.list` with no `containerId`).
 */
function traceContainer(auth: AuthContext, rawArgs: unknown): string | null {
  if (auth.containerScope !== null) return auth.containerScope;
  if (rawArgs === null || typeof rawArgs !== "object") return null;
  const named: unknown = Reflect.get(rawArgs, "containerId");
  return typeof named === "string" && named.length > 0 && named.length <= 128 ? named : null;
}

/**
 * The arguments as the ledger keeps them: redacted by the one field rule the log already
 * applies (`redactFields`), then bounded.
 *
 * A body that is not an object records as empty rather than as itself. Every door's input is a
 * `z.strictObject`, so a non-object body is a malformed request the `invalid_args` rung is
 * about to name — and the ledger's payload column is a map of a door's named arguments, not a
 * place to keep whatever JSON a stranger posted.
 */
function tracePayload(rawArgs: unknown): Readonly<Record<string, unknown>> {
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return {};
  const redacted = redactFields(rawArgs as Record<string, unknown>);
  const text = JSON.stringify(redacted);
  if (text.length <= TRACE_PAYLOAD_MAX_CHARS) return redacted;
  return { oversize: text.length, keys: Object.keys(redacted) };
}

/** Emissions and explicit targets share one canonical, deduplicated address set. */
function traceTargets(targets: readonly ManifoldRef[]): readonly string[] {
  if (targets.length === 0) return [];
  const uris = new Set<string>();
  for (const ref of targets) uris.add(formatManifoldUri(ref));
  return [...uris];
}

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
 *
 * Isolation (ADR 0016) adds one rung and one half-rung, both for INSTALLED rows only: the
 * installer's grant is intersected at rung 4 before the caller's caps are, and a child that
 * is not there to answer is `unavailable`, after `refused` — the runner's rung alone, an
 * in-realm door never says it.
 */
export class PluginHost {
  /*
    Assigned by `boot`, which is the only way to obtain a host: the constructor is private
    and wires nothing that reads storage, so no instance exists that has not assembled.
  */
  private assembled!: Assembly;
  /**
   * The live definition list: the engine's own rows, the first-party defs the composition root
   * handed over, then every INSTALLED plugin's def appended after them (ADR 0016 §8 stage 2).
   * Rebuilt by `syncDefs` whenever an install lands or leaves; the first two parts never move.
   */
  private defs: readonly ServerPluginDef[];
  private readonly firstParty: readonly ServerPluginDef[];
  private readonly handlers = new Map<string, Readonly<Record<string, ActionHandler>>>();
  /** Installed plugins by id: the row, the verified bundle, and the def the runner produced. */
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly installedDefs = new Map<string, ServerPluginDef>();
  private readonly isolates: IsolateDeps | null;
  private readonly storages = new Map<string, PluginStorageAdmin>();
  private readonly rosterListeners = new Set<(roster: PluginRoster) => void>();
  private readonly builtins: ReadonlySet<string>;
  /**
   * The ids the shipped distribution registers, handed in by the composition root because
   * this file may not name a plugin — the same direction `FLOOR_EVENT_OWNERS` travels. It is
   * NOT derived from `defs`: a def list is what the host was given, so deriving the permitted
   * set from it would let any manifest authorize its own `core.` id.
   */
  private readonly distribution: ReadonlySet<string> | undefined;
  /**
   * The outcome of the last lifecycle fan-out per plugin. In MEMORY, deliberately: it
   * describes this process's attempt to tell a plugin about a transition, not a durable
   * fact about the workspace. A restart clears it because a restart re-runs nothing.
   */
  private readonly lifecycleStates = new Map<string, PluginLifecycleState>();
  private readonly lifecycleTimeoutMs: number;

  private constructor(
    defs: readonly ServerPluginDef[],
    private readonly store: ServerStore,
    private readonly authService: AuthService,
    private readonly rooms: RoomManager,
    private readonly broker: TerminalBroker,
    private readonly placement: PlaceExecutor,
    private readonly machines: MachineAdmission,
    private readonly dialer: InstanceDialer,
    private readonly runtime: RuntimeDeps,
    private readonly logger: Logger,
    private readonly events: EventHub,
    options: {
      readonly lifecycleTimeoutMs?: number;
      readonly distribution?: ReadonlySet<string>;
      readonly isolates?: IsolateDeps;
    },
  ) {
    this.firstParty = [...ENGINE_BUILTIN_DEFS, ...defs];
    this.defs = this.firstParty;
    this.builtins = new Set(ENGINE_BUILTIN_DEFS.map((def) => def.manifest.id));
    this.distribution = options.distribution;
    this.isolates = options.isolates ?? null;
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? LIFECYCLE_TIMEOUT_MS;
    for (const def of this.defs) this.handlers.set(def.manifest.id, def.handlers);
  }

  /**
   * THE ONE WAY TO A HOST. Boot, in one pass: re-verify and load every installed bundle,
   * assemble, run the migrations assembly found owing, stamp the declared data version of
   * everything serving, and claim element types for everything assembled. Awaited because
   * storage is promise-returning (ADR 0016 §4) — and awaited to completion BEFORE this
   * resolves, which is what keeps process start free of a lifecycle fan-out (`onEnable` is a
   * TRANSITION hook: at boot everything enabled is simply live) and keeps the server from
   * answering a request over data a pending migration has not touched yet: the socket is bound
   * after this returns, never before.
   *
   * Installed plugins load BEFORE the first assembly, because their defs are members of it: a
   * stranger's duplicate action name is an `AssemblyError` at install time (caught and rolled
   * back there), never at boot, so nothing an install admitted can stop a server from
   * starting — except by being what it was when it was admitted.
   */
  static async boot(
    defs: readonly ServerPluginDef[],
    store: ServerStore,
    authService: AuthService,
    rooms: RoomManager,
    broker: TerminalBroker,
    placement: PlaceExecutor,
    machines: MachineAdmission,
    dialer: InstanceDialer,
    runtime: RuntimeDeps,
    logger: Logger,
    events: EventHub,
    options: {
      readonly lifecycleTimeoutMs?: number;
      readonly distribution?: ReadonlySet<string>;
      readonly isolates?: IsolateDeps;
    } = {},
  ): Promise<PluginHost> {
    const host = new PluginHost(
      defs,
      store,
      authService,
      rooms,
      broker,
      placement,
      machines,
      dialer,
      runtime,
      logger,
      events,
      options,
    );
    await host.loadInstalled();
    host.assembled = await host.reassemble();
    const migrated = await host.runPendingMigrations();
    await host.stampDeclaredVersions();
    for (const def of host.defs) {
      const types = def.manifest.contributes.elements.map((element) => element.type);
      if (types.length > 0) store.claimElementTypes(def.manifest.id, types);
    }
    if (migrated) host.assembled = await host.reassemble();
    return host;
  }

  /**
   * BOOT RE-VERIFICATION (R8, fail-closed). Every install row's bundle is re-hashed against
   * its pin and re-extracted; one that no longer matches — or cannot be read, or no longer
   * parses — is put on the roster in `enable_failed` with the refusal on its `install` block,
   * its doors published from the row's own record (`unverifiedDef`) and every one of them
   * answering a traced `unavailable`; NOTHING from the file is loaded. The rest are handed to
   * the runner.
   */
  private async loadInstalled(): Promise<void> {
    if (this.isolates === null) return;
    for (const row of this.store.pluginInstalls()) {
      const verdict = verifyInstalledBundle(row);
      if (!verdict.ok) {
        this.installed.set(row.pluginId, {
          row,
          bundle: null,
          web: null,
          refusal: verdict.refusal,
        });
        this.installedDefs.set(row.pluginId, unverifiedDef(row, verdict.refusal));
        this.lifecycleStates.set(row.pluginId, "enable_failed");
        this.logger.warn("plugin_lifecycle", {
          plugin: row.pluginId,
          hook: "verify",
          error: `${verdict.refusal}: ${verdict.detail}`,
        });
        continue;
      }
      this.installed.set(row.pluginId, {
        row,
        bundle: verdict.bundle,
        web: webModuleOf(verdict.bundle),
      });
      try {
        this.installedDefs.set(row.pluginId, await this.loadIsolated(verdict.bundle, verdict.dir));
      } catch (error) {
        // The bundle is what it was when admitted, so the row keeps its real manifest; only
        // the doors are missing, and the roster says so rather than the boot failing.
        this.installedDefs.set(row.pluginId, {
          manifest: verdict.bundle.manifest,
          actions: [],
          handlers: {},
        });
        this.lifecycleStates.set(row.pluginId, "enable_failed");
        this.logger.error("plugin_lifecycle", {
          plugin: row.pluginId,
          hook: "load",
          error: error instanceof Error ? error.message : "load failed",
        });
      }
    }
    this.syncDefs();
    this.isolates.runner.onState((pluginId, state) => {
      this.onIsolateState(pluginId, state);
    });
  }

  /**
   * The def an installed bundle serves through. A server half is the runner's: it spawns the
   * child and reports the doors the child announced. A web-only bundle has no child and no
   * doors — its def is its manifest, so the row composes and the worker route can find it.
   */
  private async loadIsolated(bundle: PluginBundle, dir: string): Promise<ServerPluginDef> {
    if (this.isolates === null) throw new Error("this host runs no isolates");
    if (bundle.manifest.entry.server !== true) {
      return { manifest: bundle.manifest, actions: [], handlers: {} };
    }
    const loaded = await this.isolates.runner.load({
      pluginId: bundle.manifest.id,
      manifest: bundle.manifest,
      dir,
    });
    return { ...loaded.def, lifecycle: loaded.lifecycle };
  }

  /** Rebuilds the live def list and the handler index after an install lands or leaves. */
  private syncDefs(): void {
    this.defs = [...this.firstParty, ...this.installedDefs.values()];
    this.handlers.clear();
    for (const def of this.defs) this.handlers.set(def.manifest.id, def.handlers);
  }

  /**
   * THE RUNNER'S STATE, MIRRORED ONTO THE ROSTER (ADR 0016 §6): a child being spawned or one
   * that crashed past its budget is a lifecycle every principal reads, not a log line. A run
   * state that maps to no lifecycle clears only an isolate state — a hook's own
   * `enable_failed` is a different report and stands until the next transition.
   */
  private onIsolateState(pluginId: string, state: IsolateState): void {
    const lifecycle = isolateLifecycleState(state);
    if (lifecycle !== undefined) {
      this.lifecycleStates.set(pluginId, lifecycle);
    } else {
      const current = this.lifecycleStates.get(pluginId);
      if (current !== "isolate_starting" && current !== "isolate_crashed") return;
      this.lifecycleStates.delete(pluginId);
    }
    this.reassemble().then(
      (assembly) => {
        this.assembled = assembly;
        this.publish();
      },
      (error: unknown) => {
        this.logger.error("plugin_lifecycle", {
          plugin: pluginId,
          hook: "state",
          error: error instanceof Error ? error.message : "reassembly failed",
        });
      },
    );
  }

  /** One composition over the store's current enablement and the facts `env` reads fresh. */
  private async reassemble(): Promise<Assembly> {
    return assembleRoster(this.defs, this.store.disabledPlugins(), await this.env());
  }

  /** The durable and runtime facts an assembly needs, read fresh on every reassembly. */
  private async env(): Promise<AssemblyEnv> {
    const dataState = new Map<string, PluginStoredData>();
    for (const def of this.defs) {
      const storage = this.storage(def.manifest.id);
      dataState.set(def.manifest.id, {
        version: await storage.dataVersion(),
        applied: await storage.appliedMigrations(),
      });
    }
    const installs = new Map<string, PluginInstall>();
    for (const [id, entry] of this.installed) {
      installs.set(id, {
        sha256: entry.row.sha256,
        source: entry.row.source,
        grantedCaps: [...entry.row.grantedCaps],
        installedBy: entry.row.installedBy,
        installedAt: entry.row.installedAt,
        ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
      });
    }
    return {
      builtins: this.builtins,
      ...(this.distribution === undefined ? {} : { distribution: this.distribution }),
      elementOwners: this.store.elementOwners(),
      dataState,
      lifecycle: this.lifecycleStates,
      attribution: this.store.pluginAttribution(),
      installs,
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
  private async stampDeclaredVersions(): Promise<void> {
    for (const def of this.defs) {
      const declared = def.manifest.dataVersion;
      if (declared === undefined || !this.assembled.enabled(def.manifest.id)) continue;
      const storage = this.storage(def.manifest.id);
      const stored = await storage.dataVersion();
      if (stored !== null && stored.major !== declared.major) continue;
      if (stored !== null && compareDataVersion(stored, declared) === 0) continue;
      await storage.stampDataVersion(declared);
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
  private async runPendingMigrations(): Promise<boolean> {
    let ran = false;
    for (const [pluginId, migrations] of this.assembled.pendingMigrations) {
      ran = (await this.applyMigrations(pluginId, migrations)) || ran;
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
   * because there is no catch here — and no interleaving to reason about either, because the
   * storage every await here resolves against settles synchronously (`PluginMigration`).
   */
  private async applyMigrations(
    pluginId: string,
    migrations: readonly PluginMigration[],
  ): Promise<boolean> {
    if (migrations.length === 0) return false;
    const storage = this.storage(pluginId);
    for (const migration of migrations) {
      await migration.migrate(storage);
      await storage.recordMigration(migration.name, this.runtime.now());
      this.logger.info("plugin_migration", { plugin: pluginId, migration: migration.name });
    }
    const declared = this.defs.find((def) => def.manifest.id === pluginId)?.manifest.dataVersion;
    if (declared !== undefined) await storage.stampDataVersion(declared);
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
        stored: await storage.dataVersion(),
        applied: new Set(await storage.appliedMigrations()),
        migrations: this.defs.find((def) => def.manifest.id === id)?.migrations ?? [],
      });
      if (plan.kind === "refused") return { refused: `${plan.reason}: ${plan.detail}` };
      // `migrate` stamps the declared version itself, once its chain has actually run.
      if (plan.kind === "migrate") await this.applyMigrations(id, plan.run);
      else if (plan.stamp !== null) await storage.stampDataVersion(plan.stamp);
    }

    const wasEnabled = new Set(
      this.assembled.roster.filter((row) => row.enabled).map((row) => row.manifest.id),
    );
    this.store.setPluginEnabled(id, enabled, changedBy, this.runtime.now());
    // COMMIT FIRST, then tell people. A lifecycle hook has no vote (ADR 0013 §2): the roster
    // every client will render is already the truth by the time any plugin hears about it.
    this.assembled = await this.reassemble();
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
    const removedRows = await storage.clear();
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

  /**
   * THE INSTALL DOOR (ADR 0016 §8 stage 2). In order, and the order is the contract:
   *
   *  1. the artifact is read, pinned and parsed, and NOTHING is written until the bundle is
   *     admitted (`plugin-installs.ts`): a `hash_mismatch` or a refused manifest leaves no
   *     file behind;
   *  2. admission is the host's verdict — `namespace_reserved` for `engine.` / `core.`,
   *     `already_installed` unless `replace`, `still_enabled` for a replace of a running row;
   *  3. the runner spawns the child and the assembly is rebuilt with the new def. A load
   *     failure or an `AssemblyError` (a duplicate id, a colliding action name) ROLLS BACK —
   *     files, child, the host's index — and answers `artifact_invalid` naming the problem, so
   *     a stranger's bundle is refused at the door rather than surfacing as a boot that will
   *     not come up;
   *  4. the row is persisted, once, with the grant (`grantFor`: declared minus the high-risk
   *     set, widened by `grant`) and the doors the assembly just published — the record a boot
   *     that cannot re-verify the bundle puts on the roster in the file's place.
   *
   * Then the transition is announced exactly as a toggle is: hooks fan out (an install of an
   * enabled row IS an enable), the roster is published, one log line, one event.
   */
  async install(
    request: PluginInstallRequest,
    installedBy: string,
  ): Promise<ActionRefused | PluginInstallResult> {
    const isolates = this.isolates;
    if (isolates === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    const sha256 = request.sha256.toLowerCase();
    let artifact: InstalledArtifact;
    try {
      artifact = await installArtifact({
        source: request.source,
        sha256,
        dataDir: isolates.dataDir,
        ...(isolates.devPaths === undefined ? {} : { devPaths: isolates.devPaths }),
        admit: (bundle) => {
          const id = bundle.manifest.id;
          if (id.startsWith(ENGINE_NAMESPACE_PREFIX) || id.startsWith(CORE_NAMESPACE_PREFIX)) {
            return new InstallRefusal(
              "namespace_reserved",
              `"${id}" claims a namespace only this build may use`,
            );
          }
          const existing = this.installed.get(id);
          if (existing === undefined) return null;
          if (request.replace !== true) {
            return new InstallRefusal(
              "already_installed",
              `"${id}" is installed at ${existing.row.sha256}; pass replace to upgrade it`,
            );
          }
          if (this.assembled.enabled(id)) {
            return new InstallRefusal("still_enabled", `disable "${id}" before replacing it`);
          }
          return null;
        },
      });
    } catch (error) {
      if (error instanceof InstallRefusal) return { refused: error.message };
      throw error;
    }
    const { bundle } = artifact;
    const id = bundle.manifest.id;
    const previous = this.installed.get(id);
    const previousDef = this.installedDefs.get(id);
    const consent: PluginInstallRow = {
      pluginId: id,
      sha256,
      source: request.source,
      grantedCaps: grantFor(bundle.manifest.capabilities, request.grant),
      installedBy,
      installedAt: this.runtime.now(),
      bundlePath: artifact.bundlePath,
      actions: [],
    };
    const web = webModuleOf(bundle);
    const wasEnabled = new Set(
      this.assembled.roster.filter((entry) => entry.enabled).map((entry) => entry.manifest.id),
    );
    // A replace retires the running child first: two children for one id is two doors.
    if (previous !== undefined) await isolates.runner.unload(id);
    this.installed.set(id, { row: consent, bundle, web });
    this.lifecycleStates.delete(id);
    try {
      this.installedDefs.set(id, await this.loadIsolated(bundle, artifact.dir));
      this.syncDefs();
      this.assembled = await this.reassemble();
    } catch (error) {
      await this.rollbackInstall(id, artifact, previous, previousDef);
      if (error instanceof IsolateLoadError)
        return installRefused("artifact_invalid", error.message);
      if (error instanceof AssemblyError) {
        return installRefused("artifact_invalid", error.problems.join("; "));
      }
      throw error;
    }
    const row: PluginInstallRow = {
      ...consent,
      actions: this.assembled.roster.find((entry) => entry.manifest.id === id)?.actions ?? [],
    };
    this.store.putPluginInstall(row);
    this.installed.set(id, { row, bundle, web });
    if (previous !== undefined && previous.row.sha256 !== sha256) removeInstall(previous.row);
    const types = bundle.manifest.contributes.elements.map((element) => element.type);
    if (types.length > 0) this.store.claimElementTypes(id, types);
    await this.stampDeclaredVersions();
    const delta: AssemblyDelta = {
      enabled: this.assembled.enabled(id) && !wasEnabled.has(id) ? [id] : [],
      disabled: [],
    };
    if (delta.enabled.length > 0) await this.fanOut(delta, wasEnabled);
    this.publish();
    this.logger.info("plugin_installed", {
      plugin: id,
      version: bundle.manifest.version,
      sha256,
      principal: installedBy,
      caps: row.grantedCaps,
      replaced: previous !== undefined,
    });
    // The commit point, on the engine's own node, for the reason `setEnabled` gives.
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      ENGINE_INSTALLED_EVENT,
      installedBy,
      { plugin: id, version: bundle.manifest.version, sha256 },
    );
    return { id, version: bundle.manifest.version, grantedCaps: [...row.grantedCaps] };
  }

  /**
   * Undoes everything `install` did before the failure: the child, the files of THIS artifact
   * (never a replaced install's, which are still the row of record), and the host's index —
   * restored to the previous install when this was a replace, dropped when it was not. The
   * store needs no undoing: the row lands only after the assembly has taken the def.
   */
  private async rollbackInstall(
    id: string,
    artifact: InstalledArtifact,
    previous: InstalledPlugin | undefined,
    previousDef: ServerPluginDef | undefined,
  ): Promise<void> {
    if (this.isolates !== null) {
      try {
        await this.isolates.runner.unload(id);
      } catch (error) {
        this.logger.error("plugin_lifecycle", {
          plugin: id,
          hook: "unload",
          error: error instanceof Error ? error.message : "unload failed",
        });
      }
    }
    if (previous === undefined || previous.row.sha256 !== artifact.sha256) {
      removeInstall(artifact);
    }
    if (previous === undefined || previousDef === undefined) {
      this.installed.delete(id);
      this.installedDefs.delete(id);
    } else {
      this.installed.set(id, previous);
      this.installedDefs.set(id, previousDef);
    }
    this.syncDefs();
  }

  /**
   * THE UNINSTALL DOOR. Refused unless the row is off (`still_enabled`, the rule `purge` has
   * and for the same reason: removing running code is not a state anybody asked for). It
   * retires the child, deletes the files and the row, forgets the row's switch, and
   * reassembles.
   *
   * The plugin's storage is never destroyed by this door on its own, and never stranded by it
   * either (#233): while the namespace holds rows the door refuses `storage_retained` naming
   * the count, and `purge: true` is consent to run the purge verb FIRST — the same path and
   * the same `plugin_purged` event `engine.plugins.purge` gives — and uninstall second. There
   * is no order in which data becomes unreachable: the row an uninstalled id's purge would
   * resolve against is gone, so the purge has to come before.
   *
   * The switch goes with the row. Disabling was the precondition, and a set that remembered it
   * would hand the next install of the same id a row that is off — its child spawned for a
   * door answering `plugin_disabled`. A fresh install is a fresh row, on by default.
   */
  async uninstall(
    id: string,
    removedBy: string,
    purge: boolean,
  ): Promise<ActionRefused | { ok: true }> {
    const entry = this.installed.get(id);
    if (entry === undefined || this.isolates === null) {
      return installRefused("not_installed", `"${id}" was not installed here`);
    }
    if (this.assembled.enabled(id)) {
      return installRefused("still_enabled", `disable "${id}" before uninstalling it`);
    }
    if (purge) {
      const purged = await this.purge(id, removedBy);
      if ("refused" in purged) return purged;
    } else {
      const retained = await this.storage(id).count();
      if (retained > 0) {
        return installRefused(
          "storage_retained",
          `${String(retained)} keys; purge first or pass purge: true`,
        );
      }
    }
    await this.isolates.runner.unload(id);
    removeInstall(entry.row);
    this.store.deletePluginInstall(id);
    this.store.clearPluginEnablement(id);
    this.installed.delete(id);
    this.installedDefs.delete(id);
    this.lifecycleStates.delete(id);
    this.syncDefs();
    this.assembled = await this.reassemble();
    this.publish();
    this.logger.info("plugin_uninstalled", {
      plugin: id,
      sha256: entry.row.sha256,
      principal: removedBy,
    });
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      ENGINE_UNINSTALLED_EVENT,
      removedBy,
      { plugin: id, sha256: entry.row.sha256 },
    );
    return { ok: true };
  }

  /**
   * The worker module `GET /api/plugins/:id/web.js` serves: the bytes of `files[entry.web]`
   * for an installed, verified, ENABLED plugin, with the pin the response tags them with.
   * Null for everything else, which the route answers as 404 — a disabled plugin's code is not
   * fetched by anyone, and a refused bundle's never is.
   */
  webModule(id: string): { readonly sha256: string; readonly bytes: Uint8Array } | null {
    const entry = this.installed.get(id);
    if (entry === undefined || entry.web === null || !this.assembled.enabled(id)) return null;
    return { sha256: entry.row.sha256, bytes: entry.web };
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
    this.assembled = await this.reassemble();
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
   * One dispatch, one log line, one ledger row — whether it succeeded, was denied, or threw. A
   * denial is an ANSWER, so it logs at info with the rung that refused; only a broken handler
   * or a result that fails its own schema is an error.
   *
   * `session` is the socket the dispatch arrived on, and null means it came through the HTTP
   * action door — a distinction the ledger keeps rather than infers (axiom A6, ADR 0018 §2).
   * It is a parameter rather than a field on `AuthContext` because a credential is not a
   * connection: the same token dispatches over HTTP and over a socket, and only the caller
   * knows which door it walked through.
   */
  async dispatch(
    auth: AuthContext,
    fullName: string,
    rawArgs: unknown,
    session: string | null = null,
  ): Promise<ActionOutcome> {
    let outcome: ActionOutcome;
    try {
      outcome = await this.run(auth, fullName, rawArgs, session);
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
    session: string | null,
  ): Promise<ActionOutcome> {
    const entry = this.assembled.actions.get(fullName);
    if (entry === undefined) {
      /*
        THE ONE UNTRACED RUNG, and it is a ruling rather than an oversight (ADR 0018 §4).
        There is no door here: nothing was registered under this name, no capability was
        declared, nothing was exercised and there is nothing to attribute. The name is also
        CALLER-CHOSEN and unbounded, so tracing it would hand every client a writer into the
        ledger, with a `door` column full of words no roster ever published. It stays
        observable exactly where every dispatch already is — the structured `action` log line
        above, at `outcome: "unknown_action"`.
      */
      return {
        ok: false,
        denial: { rule: "unknown_action", message: `unknown action "${fullName}"` },
      };
    }
    /*
      THE ATTRIBUTION, decided once, here — after the door is known and before any rung can
      answer. Everything in it is a fact about the CALLER and the DOOR, so nothing a handler
      does can change it, which is what lets the row be written before the handler runs.
    */
    const attribution: TraceAttribution = {
      ts: this.runtime.now(),
      actor: auth.principal.id,
      authority: traceAuthority(auth, entry.def.caps),
      door: fullName,
      containerId: traceContainer(auth, rawArgs),
      payload: tracePayload(rawArgs),
      session,
    };
    /*
      EVERY REFUSAL BELOW THIS LINE GOES THROUGH HERE — one constructor for the traced rungs,
      which is what makes "a mutating door cannot be added without a trace" a property of this
      function rather than of a reviewer's attention. A rung that returned its own
      `{ ok: false }` literal would be an untraced denial, and `verify:trace` counts the
      literals in this method for exactly that reason.

      The rungs above the handler know their outcome already, so their row is written settled:
      one INSERT, atomic on its own, durable before the caller is told anything.
    */
    const refuse = (
      rule: Exclude<ActionDenialRule, typeof UNTRACED_DENIAL_RULE>,
      message: string,
    ): ActionOutcome => {
      this.store.appendTrace({ ...attribution, outcome: rule, targets: [] });
      return { ok: false, denial: { rule, message } };
    };
    const pluginId = entry.plugin.id;
    if (!this.assembled.enabled(pluginId) && entry.def.cleanup !== true) {
      // Cleanup actions (D12) outlive a disable: turning core.terminals off must refuse
      // creation and administration, never the ability to remove what already exists.
      return refuse("plugin_disabled", `plugin "${pluginId}" is disabled`);
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
      return refuse("forbidden", "scoped tokens cannot invoke workspace actions");
    }
    /*
      RUNG 4, FIRST HALF — THE INSTALLER'S GRANT (ADR 0016 §5). For a row somebody installed,
      the plugin's effective caps are `granted ∩ declared`, and the intersection is asked
      BEFORE the caller's own caps so the refusal names the plugin's grant: a caller holding
      the cap is still refused when the installer withheld it, and the message says which. A
      first-party row has no grant and skips this half unchanged.
    */
    const install = this.installed.get(pluginId);
    if (install !== undefined) {
      for (const cap of entry.def.caps) {
        if (withinCeiling(cap, install.row.grantedCaps)) continue;
        return refuse("forbidden", `${cap} not granted to plugin ${pluginId}`);
      }
    }
    for (const cap of entry.def.caps) {
      const held =
        cap === "*"
          ? auth.isRoot
          : this.authService.allows(auth, cap, auth.containerScope ?? undefined);
      if (held) continue;
      return refuse("forbidden", `${cap} capability required`);
    }
    const parsed = entry.def.input.safeParse(rawArgs);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      return refuse("invalid_args", detail);
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
    /*
      THE WRITE-AHEAD (ADR 0018 §3). The attribution commits BEFORE the handler is invoked, so
      by the time a handler can reach the store its own trace is already durable: a committed
      mutation with no trace is not a race this ladder can lose, because the trace does not
      wait on the mutation. The outcome is the one thing that cannot be known yet, so it is
      the one thing the settle writes.

      This is deliberately NOT one transaction with the handler's mutation, and the reason is
      A6's own text rather than a limitation: a trace that rolled back with the mutation would
      lose exactly the rows the axiom insists on — the refusal, and the door that mutated and
      then threw. Wrapping an awaited handler in a SQLite transaction would also mean holding
      the connection's write lock across a machine round-trip, which stalls every other
      writer in the workspace behind one slow door. Ordering, not atomicity, is what makes the
      ledger complete; §7 of the ADR carries the per-door-class table.
     */
    const traceId = this.store.appendTrace({ ...attribution, outcome: null, targets: [] });
    const targets: ManifoldRef[] = [];
    const ctx: ActionCtx = {
      traceId,
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
        revokeMachine: (machineId) =>
          identityCall(() => this.authService.revokeMachine(machineId, auth)),
        listCredentials: () => identityCall(() => this.authService.listCredentials(auth)),
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
      target: (ref) => {
        targets.push(ref);
      },
      emit: (ref, kind, payload) => {
        staged.push({ ref, kind, payload: payload ?? {} });
        targets.push(ref);
      },
    };
    const invoke = handler as (ctx: ActionCtx, args: unknown) => Promise<unknown>;
    let produced: unknown;
    try {
      produced = await invoke(ctx, parsed.data);
    } catch (error) {
      if (error instanceof IsolateDenial) {
        /*
          THE CHILD'S OWN RUNGS (ADR 0016 §6). An isolated handler grades `invalid_args`
          itself — its zod schema lives where its code lives — and the supervisor answers
          `unavailable` for a child that is not running or did not answer in time. Both arrive
          as a throw from the proxy and are settled here as the rung they name, traced exactly
          as an in-realm rung is; they are answers, never failures.
        */
        this.store.settleTrace(traceId, error.rule, traceTargets(targets));
        return { ok: false, denial: { rule: error.rule, message: error.message } };
      }
      // A broken door is still an exercise of authority: somebody opened it and it failed
      // half-way. The row settles `failed` and the throw continues to `dispatch`, which logs
      // it with the same word.
      this.store.settleTrace(traceId, "failed", traceTargets(targets));
      throw error;
    }
    if (produced !== null && typeof produced === "object") {
      const denial = Reflect.get(produced, "refused");
      if (typeof denial === "string") {
        this.store.settleTrace(traceId, "refused", traceTargets(targets));
        return { ok: false, denial: { rule: "refused", message: denial } };
      }
    }
    // A result that fails its published schema is a broken door, not a refused request:
    // the roster promised this shape to every reader, so the failure belongs in the logs.
    // It runs BEFORE the flush for the same reason the flush exists: a door that cannot
    // publish its own answer has not committed anything worth announcing.
    let result: unknown;
    try {
      result = entry.def.result.parse(produced);
    } catch (error) {
      this.store.settleTrace(traceId, "failed", traceTargets(targets));
      throw error;
    }
    /*
      THE LEDGER SETTLES BEFORE ANYBODY IS TOLD. The outcome is durable first, then the staged
      emissions go out: no subscriber can observe news of a commit whose trace is still
      unsettled, and the flush cannot un-write what the ledger already says.
     */
    this.store.settleTrace(traceId, "ok", traceTargets(targets));
    for (const event of staged) {
      this.events.emit(pluginId, event.ref, event.kind, auth.principal.id, event.payload);
    }
    return { ok: true, result };
  }

  enabled(id: string): boolean {
    return this.assembled.enabled(id);
  }
}
