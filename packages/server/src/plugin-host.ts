import {
  AssemblyError,
  ENGINE_AUTHOR_ACTION,
  ENGINE_DEVELOPER_MODE_EVENT,
  ENGINE_INSTALLED_EVENT,
  ENGINE_UNINSTALLED_EVENT,
  LIFECYCLE_TIMEOUT_MS,
  PluginDatabaseError,
  assembleRoster,
  assertStorageKey,
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
  type AssemblyProblem,
  type JobSettledCtx,
  type LifecycleCtx,
  type HookOutcome,
  type PluginAuthorRequest,
  type PluginAuthorResult,
  type PluginDef,
  type PluginInstallRequest,
  type PluginInstallResult,
  type PluginDatabase,
  type PluginDatabaseAdmin,
  type PluginMigration,
  type PluginStorage,
  type PluginStorageAdmin,
  type PluginStoredData,
  type ServerHarness,
  type PluginNativeTransferContext,
  NativeTransferError,
  type PluginReferenceContext,
  type ReferenceProbeCtx,
  type ByteCarrierContext,
  type ByteCarrierHandler,
} from "@manifold/plugin";
import type { SqlParam, SqlRow, SqlStatement } from "@manifold/plugin";
import type { ServerMigration as GuestMigration } from "@manifold/plugin-kit/server";
import { BundleOrderError, familyOrder, requiredDependencyIds } from "@manifold/plugin-kit/install";
import { ByteRequestPool, byteFailure, serveByteCarrier } from "./byte-transport.ts";
import { readNativeTransferContext } from "./native-transfer-context.ts";
import { elementsMap, readElement, writeElement, SERVER_PLACE_ORIGIN } from "@manifold/scene";
import {
  ActionCallArgsSchema,
  BYTE_REQUEST_TIMEOUT_MS,
  ByteTransferError,
  PluginOwnedRefSchema,
  type ByteCarrierRequest,
  type ByteRefusal,
  AgentToolReplySchema,
  agentToolName,
  type AgentToolRequest,
  type AgentToolReply,
  type AgentToolRefusalCode,
  JsonProjectionError,
  projectJson,
  type ActionProjectedResult,
  GuestMigrationDeclarationsSchema,
  HARDENED_CONTRACT_COMPAT_VERSIONS,
  HARDENED_CONTRACT_MINIMUM,
  HARDENED_CONTRACT_VERSION,
  ISOLATE_MIGRATION_DEADLINE_MS,
  MAX_ACTION_CALL_DEPTH,
  CAPS,
  GOVERNED_CAPS,
  hasCap,
  isEngineCap,
  ManifoldRefSchema,
  CORE_NAMESPACE_PREFIX,
  SceneElementSchema,
  elementPayload,
  ENGINE_NAMESPACE_PREFIX,
  PLUGIN_BUNDLE_SERVER_FILE,
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  type MachineCredentialGrant,
  type MachineEnrollmentOutcome,
  type MachineInventory,
  type TerminalExecution,
  PLUGIN_BUNDLE_STYLES_FILE,
  formatManifoldUri,
  parseManifoldUri,
  canonicalJobJson,
  TRACE_AUTHORITY_OPEN,
  TRACE_AUTHORITY_ROOT,
  SessionRefSchema,
  TerminalRuntimeSchema,
  HarnessTargetSchema,
  ReferenceProbeResultSchema,
  type ReferenceProbeRequest,
  type ReferenceProbeResult,
  LaunchRunResultSchema,
  ListHarnessesResultSchema,
} from "@manifold/protocol";
import { nativeTransferContext } from "./native-transfer-context.ts";
import {
  NativeTransferReasonSchema,
  type NativeTransferTerminalEvidence,
} from "@manifold/protocol";
import type {
  ActionCallRefusal,
  ActionDenialRule,
  ActionOutcome,
  AgentRun,
  HarnessDefinition,
  HarnessTarget,
  SessionRef,
  LaunchRunRequest,
  LaunchRunResult,
  ListHarnessSessionsResult,
  SendRunInputRequest,
  BootstrapPrincipalRequest,
  AcknowledgeAgentPolicyRequest,
  AcknowledgeAgentPolicyResult,
  AgentPolicyChallenge,
  AskableCap,
  AuthoredCap,
  Cap,
  RegisterAgentRequest,
  RegisterAgentResult,
  AgentRequest,
  GetAgentResult,
  ListAgentsResult,
  UpdateAgentRequest,
  CreateRunRequest,
  CreateChildRunRequest,
  CreateRunResult,
  ReportRunActivityRequest,
  CreateGrantRequest,
  Dial,
  DialShareRequest,
  DialTicket,
  EventKind,
  EventPayload,
  Grant,
  ListGrantsRequest,
  FinishAgentRunRequest,
  InspectRunRequest,
  InspectRunResult,
  ListRunsRequest,
  ListRunsResult,
  FinishAgentRunResult,
  ManifoldRef,
  PluginOwnedRef,
  PluginOwnedRefKind,
  ReferenceTerminalReceipt,
  PublishedReferenceIdentity,
  MintShareRequest,
  MintTokenRequest,
  PluginBuildCompatibility,
  PluginBundle,
  PluginId,
  PluginInstall,
  PluginInstallRefusal,
  InstalledPluginStates,
  InstalledPluginsSnapshot,
  PluginLifecycleState,
  PluginPurgeResult,
  PluginRefusalReason,
  ReloadAgentPolicyResult,
  RenewAgentRunRequest,
  RenewAgentRunResult,
  PluginRoster,
  PluginUpdateApplyRequest,
  PluginUpdateApplyResult,
  PluginUpdateReviewResult,
  Principal,
  PrincipalCredentials,
  PrincipalAccessPauseRequest,
  PrincipalAccessPauseResult,
  RuntimeDeps,
  Share,
  ShareGrant,
  TokenGrant,
  UNTRACED_DENIAL_RULE,
} from "@manifold/protocol";
import { isContainerGrantCap, ServiceError } from "./auth.ts";
import type {
  AuthContext,
  AuthService,
  NativeRunAuthority,
  AuthorityRequirement,
  ContainerGrant,
  ContainerGrantCap,
  CredentialReference,
  GovernedAdmissionDecision,
  ServiceErrorCode,
} from "./auth.ts";
import { AuthoredPlugins, type AuthoredPack, type UnpackedRow } from "./authored.ts";
import {
  assertLoadedBinding,
  assertTrustedBinding,
  extractTrustedBuild,
  type TrustedBuild,
} from "./first-party-builds.ts";
import type { EventHub } from "./event-hub.ts";
import type { InstanceDialer } from "./instance-dialer.ts";
import {
  IsolateDenial,
  IsolateLoadError,
  isolateLifecycleState,
  type InstalledPluginRef,
  type IsolateRunner,
} from "./isolate/contract.ts";
import { localActionDef } from "./isolate/proxy-def.ts";
import {
  normalizeAgentDeclaration,
  projectPluginAuthorFacts,
  redactFields,
  type Logger,
} from "./log.ts";
import type { PlaceExecutor } from "./placement.ts";
import {
  openPluginDatabase,
  recoverPluginDatabase,
  recoverPluginDatabases,
  stagePluginDatabase,
  type PluginDatabaseStage,
} from "./plugin-database.ts";
import { RecoveryBudget } from "./recovery-budget.ts";
import { withRecoveryGate } from "./recovery-gate.ts";
import {
  InstallRefusal,
  inspectArtifact,
  installLayout,
  publishArtifact,
  removeInstall,
  verifyInstalledBundle,
  type InstalledArtifact,
  type VerifiedPluginArtifact,
} from "./plugin-installs.ts";
import {
  PluginUpdates,
  pluginBuildCompatibility,
  type PluginUpdateAuthority,
  type PreparedPluginUpdate,
} from "./plugin-updates.ts";
import { exportInstalledPlugins, listInstalledPlugins } from "./installed-plugins.ts";
import type { RoomManager } from "./room.ts";
import type { PluginInstallRow, ServerStore, TraceAttribution } from "./stores.ts";
import type { DrainOutcome, TerminalBroker } from "./terminal-broker.ts";
import type { MachineRepositoryOutcome } from "./machine-ws.ts";
import { StreamService } from "./stream-service.ts";
import type {
  StreamProducer,
  PluginActionContext,
  PluginStreamContext,
  PluginServiceContext,
} from "@manifold/plugin";
import { jobContext, jobDoors, type JobContext } from "./job-doors.ts";
import type { JobService, SettledJobDelivery } from "./job-service.ts";
import { serviceContext, serviceDoors, serviceDoorSchemas } from "./service-doors.ts";
import { machineDoors } from "./machine-doors.ts";
import { jobSettledTimeouts, type JobSettledTimeouts } from "./settled-job-timeouts.ts";
import { ReferenceService, ReferenceRefused, type ReferenceOwner } from "./reference-service.ts";
import { inspectRecoveryCapacity } from "./recovery-budget.ts";
import { sha256Hex } from "./stores.ts";

interface PluginDataLease {
  readonly storage: PluginStorage;
  readonly database?: PluginDatabase;
  check(): void;
  close(): void;
}

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
  /** Root-class authority, asked of `AuthService.holdsRoot` on every read (#411). */
  readonly isRoot: boolean;
  /** One evaluator question: the engine's capabilities, or this plugin's own (ADR 0035). */
  allows(cap: AskableCap, ref?: ManifoldRef): boolean;
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
  registerAgent(input: RegisterAgentRequest): Promise<IdentityResult<RegisterAgentResult>>;
  getAgent(input: AgentRequest): IdentityResult<GetAgentResult>;
  listAgents(): IdentityResult<ListAgentsResult>;
  updateAgent(input: UpdateAgentRequest): Promise<IdentityResult<GetAgentResult>>;
  disableAgent(input: AgentRequest): IdentityResult<GetAgentResult>;
  enableAgent(input: AgentRequest): IdentityResult<GetAgentResult>;
  retireAgent(input: AgentRequest): IdentityResult<GetAgentResult>;
  createRun(input: CreateRunRequest): IdentityResult<CreateRunResult>;
  createChildRun(input: CreateChildRunRequest): IdentityResult<CreateRunResult>;
  inspectRun(input: InspectRunRequest): IdentityResult<InspectRunResult>;
  listRuns(input: ListRunsRequest): IdentityResult<ListRunsResult>;
  reportRunActivity(input: ReportRunActivityRequest): IdentityResult<{ run: AgentRun }>;
  listHarnesses(): IdentityResult<{ harnesses: HarnessDefinition[] }>;
  launchRun(input: LaunchRunRequest): Promise<IdentityResult<LaunchRunResult>>;
  sendRunInput(input: SendRunInputRequest): Promise<IdentityResult<Record<string, never>>>;
  listHarnessSessions(
    harness: string,
    target: HarnessTarget,
  ): Promise<IdentityResult<ListHarnessSessionsResult>>;
  resolveHarnessSession(ref: SessionRef): Promise<IdentityResult<{ session: SessionRef | null }>>;
  /** Returns the exact server-selected policy bytes this run must acknowledge. */
  agentPolicyChallenge(): IdentityResult<AgentPolicyChallenge>;
  /** Activates this run only after every exact policy digest is acknowledged. */
  acknowledgeAgentPolicy(
    input: AcknowledgeAgentPolicyRequest,
  ): IdentityResult<AcknowledgeAgentPolicyResult>;
  /** Replaces a sponsored run credential within its lifetime and renewal ceilings. */
  renewAgentRun(input: RenewAgentRunRequest): IdentityResult<RenewAgentRunResult>;
  /** Settles a run and transitively revokes every descendant credential. */
  finishAgentRun(input: FinishAgentRunRequest): IdentityResult<FinishAgentRunResult>;
  /** Reloads trusted policy sources and suspends runs whose acknowledgement is stale. */
  reloadAgentPolicy(): IdentityResult<ReloadAgentPolicyResult>;
  /** Revokes a principal's tokens the caller is entitled to revoke; answers the count. */
  revokePrincipal(principalId: string): IdentityResult<number>;
  /** Pauses every future authority check without revoking credentials or stopping work. */
  pausePrincipalAccess(
    input: PrincipalAccessPauseRequest,
  ): IdentityResult<PrincipalAccessPauseResult>;
  /** Restores the same credentials and grants without requiring reauthentication. */
  resumePrincipalAccess(
    input: PrincipalAccessPauseRequest,
  ): IdentityResult<PrincipalAccessPauseResult>;
  /*
    THE FLEET'S IDENTITY VERBS (#259). Unlike the rest of this door they are bound to the
    dispatch's NATIVE ceiling as well as its caller: every call restores the caller's live
    credential, narrowed to the capabilities the dispatched door declares (and, for an
    installed row, its grant), and refuses once the dispatch has settled. Machines are named by
    id and re-resolved; answers carry public identity and at most one raw token.
  */
  /**
   * Enrolls by name as ONE find-or-create decision for an unscoped `machines:mint` caller:
   * an existing name answers its identity with no token, a new one answers the only raw token.
   */
  enrollMachine(name: string): IdentityResult<MachineEnrollmentOutcome>;
  /** Re-mints the machine this id names NOW, revoking the credential its row references. */
  rotateMachineToken(machineId: string): IdentityResult<MachineCredentialGrant>;
  /**
   * WITHDRAWS an enrolled machine's credential, keeping the inventory row. The door ADR 0019
   * §3 names as missing: `rotateMachineToken` above replaces a secret, and nothing could ask
   * for one to simply stop working. Answers how many credentials died — 0 when it was already
   * withdrawn, which is a success and not a refusal.
   */
  revokeMachine(machineId: string): IdentityResult<number>;
  forgetMachine(machineId: string): IdentityResult<null>;
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
 * Ordinary high-risk caps require an explicit install grant. Governed caps are excluded
 * from both default and explicit flat install grants: their consent is version-bound and
 * discharged separately by the trusted store port, including for first-party plugins.
 */
const UNGRANTED_BY_DEFAULT: Partial<Record<Cap, true>> = {
  "*": true,
  "tokens:mint": true,
  "plugins:manage": true,
};

/**
 * A cap the manifest's ceiling covers: named, or — for one of the engine's own — anything but
 * `*` when `*` is declared. `hasCap` is the one place that wildcard reach is spelled, and it
 * stops at the engine's vocabulary: a plugin's own capability (ADR 0035) must be DECLARED, so
 * a wildcard ceiling never stands in for a namespaced name nobody wrote down.
 */
function withinCeiling(cap: AuthoredCap, declared: readonly AuthoredCap[]): boolean {
  return cap === "*" ? declared.includes("*") : hasCap(declared, cap);
}

/**
 * The capability set an install consents to: the manifest's declaration minus the high-risk
 * set, widened by whatever the installer named — restricted in both halves to caps that exist
 * and that the manifest actually declared, because a grant is `granted ∩ declared` at the door
 * and publishing a cap the plugin could never exercise would misdescribe the row.
 *
 * A PLUGIN'S OWN CAPABILITY IS GRANTED BY DEFAULT (ADR 0035), which is not a widening of what
 * an installer consents to: the high-risk set exists because `*`, `tokens:mint` and
 * `plugins:manage` hand a stranger's code authority over the WORKSPACE, and a name in the
 * plugin's own namespace confers authority over nothing but that plugin's own doors — whose
 * callers still need a grant row naming it. Withholding one would mean installing a plugin
 * with its own doors dead, which is what the enablement toggle already says out loud.
 */
function grantFor(
  declared: readonly AuthoredCap[],
  widen: readonly AuthoredCap[] | undefined,
): AuthoredCap[] {
  const granted = new Set<AuthoredCap>();
  for (const cap of declared) {
    if (!isEngineCap(cap)) granted.add(cap);
    else if (UNGRANTED_BY_DEFAULT[cap] !== true && !GOVERNED_CAPS.includes(cap)) granted.add(cap);
  }
  for (const cap of widen ?? []) {
    if (!GOVERNED_CAPS.includes(cap) && withinCeiling(cap, declared)) granted.add(cap);
  }
  // The engine's own order first, then the namespaced names sorted: a published grant reads
  // the same however the manifest happened to order its declaration.
  return [
    ...CAPS.filter((cap) => granted.has(cap)),
    ...[...granted].filter((cap) => !isEngineCap(cap)).sort(),
  ];
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
  const capabilities = [
    ...new Set(actions.flatMap((action) => [...action.caps, ...(action.delegates ?? [])])),
  ].sort();
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

/** The web entry's bytes, decoded once at load so the route serves without re-decoding. */
function webModuleOf(bundle: PluginBundle): Uint8Array<ArrayBuffer> | null {
  const name = bundle.manifest.entry.web;
  if (name === undefined) return null;
  const encoded = bundle.files[name];
  return encoded === undefined ? null : Buffer.from(encoded, "base64");
}

/** The declared sheet's bytes, on the same terms; a sheet nobody declared is never served. */
function stylesheetOf(bundle: PluginBundle): Uint8Array<ArrayBuffer> | null {
  if (bundle.manifest.entry.styles !== true) return null;
  const encoded = bundle.files[PLUGIN_BUNDLE_STYLES_FILE];
  return encoded === undefined ? null : Buffer.from(encoded, "base64");
}

/**
 * The declared portable Worker entry (`entry.worker`, contract 9), on the same terms: decoded
 * once, and served only because the manifest declared it — never an arbitrary member.
 */
function workerModuleOf(bundle: PluginBundle): Uint8Array<ArrayBuffer> | null {
  if (bundle.manifest.entry.worker !== true) return null;
  const encoded = bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE];
  return encoded === undefined ? null : Buffer.from(encoded, "base64");
}

/**
 * Whether a bundle's web half CANNOT run hardened. From contract 9 an ordinary `web.js` is
 * compiled against the page's shared module registry, so only a declared portable Worker entry
 * runs in a hardened Worker; a contract-9 hardened installation without one is refused before
 * any of its code is evaluated. Older contracts' `web.js` WAS their Worker module and keeps its
 * original path.
 */
function unportableHardenedWeb(bundle: PluginBundle): boolean {
  return (
    bundle.manifest.entry.web !== undefined &&
    (bundle.hardenedContract ?? 0) >= 9 &&
    bundle.manifest.entry.worker !== true
  );
}

/**
 * The ONE wording every scope violation gives, exported so a plugin's tests and a client's
 * switch both name it instead of retyping it.
 */
export const OUTSIDE_SCOPE_REFUSAL = "outside this token's container";

/**
 * WHY A SIBLING'S DOOR DID NOT OPEN (ADR 0041), as the rejection `ctx.actions.call` throws.
 *
 * A REJECTION rather than a returned union, because the resolved value is the callee door's
 * own result and a handler must be able to use it without unwrapping: the happy path reads
 * `const session = await ctx.actions.call(...)`, and the refusal is the exceptional one.
 *
 * The message is the D5 shape every other plugin refusal already uses — the class, then the
 * offenders after `": "`, caller first — so a handler that lets it escape refuses its own
 * dispatch with a sentence its caller can switch on (`run` settles it `refused`), and a
 * hardened guest gets the identical sentence through the proxy, where a thrown host call
 * arrives as `HostCallError`.
 */
export class ActionCallRefused extends Error {
  readonly refusal: ActionCallRefusal;

  constructor(refusal: ActionCallRefusal, offenders: string) {
    super(`${refusal}: ${offenders}`);
    this.name = "ActionCallRefused";
    this.refusal = refusal;
  }
}

/**
 * The origin a job started from a LIFECYCLE hook carries, where a dispatched one carries its
 * ledger row's id. A hook is not a door: nobody called it, there is no traced row to descend
 * from, and inventing one would put a writer nobody exercised into the ledger. The sentinel
 * reads on the job exactly as `native-services` and `native-input` already do for the other
 * two effects the engine performs on nobody's behalf.
 */
const LIFECYCLE_TRACE = "plugin-lifecycle";

/** Assembly administration, as the engine's own builtin doors drive it. */
export interface HostControl {
  setEnabled(
    id: string,
    enabled: boolean,
    changedBy: string,
  ): Promise<ActionRefused | { ok: true }>;
  purge(
    id: string,
    purgedBy: string,
    traceId?: number | null,
  ): Promise<ActionRefused | PluginPurgeResult>;
  /**
   * `installer` is the credential the ROW will act under at a lifecycle hook (#514), kept
   * beside the principal id the roster publishes because a principal alone can never
   * reconstruct delayed authority. Null only where the writer has none to lend: the rebuild
   * loop's own watch.
   */
  install(
    request: PluginInstallRequest,
    installedBy: string,
    installer: CredentialReference | null,
  ): Promise<ActionRefused | PluginInstallResult>;
  uninstall(
    id: string,
    removedBy: string,
    purge: boolean,
    traceId?: number | null,
  ): Promise<ActionRefused | { ok: true }>;
  listInstalled(): Promise<InstalledPluginStates>;
  exportInstalled(): Promise<InstalledPluginsSnapshot>;
  setDeveloperMode(on: boolean, changedBy: string): Promise<ActionRefused | { ok: true }>;
  author(
    request: PluginAuthorRequest,
    authoredBy: string,
    credential: CredentialReference,
  ): Promise<ActionRefused | PluginAuthorResult>;
  roster(): PluginRoster;
  enabled(id: string): boolean;
  /**
   * The reviewed family update doors (#238). `authority` names the root caller and its
   * credential; the host re-proves both, and the coordinator its bound snapshot, after every
   * await and immediately before the one commit.
   */
  reviewUpdate(
    id: string,
    authority: PluginUpdateAuthority,
  ): Promise<ActionRefused | PluginUpdateReviewResult>;
  applyUpdate(
    request: PluginUpdateApplyRequest,
    authority: PluginUpdateAuthority,
  ): Promise<ActionRefused | PluginUpdateApplyResult>;
}

/**
 * The artifact directory and optional-hardening runner for installed plugins. Absent means
 * this host admits no bundles; the runner is used only for an install hardened by its owner.
 */
export interface IsolateDeps {
  readonly runner: IsolateRunner;
  readonly dataDir: string;
  /** `MANIFOLD_PLUGIN_DEV_PATHS=1`: path sources anywhere, not only under `plugin-uploads/`. */
  readonly devPaths?: boolean;
  /** How an unpacked directory is built; the kit's `packPlugin` unless a test injects one. */
  readonly pack?: AuthoredPack;
}

/**
 * One installed plugin as the host holds it: the row (the installer's consent), the bundle
 * when the stored file re-hashed to the pin, the decoded web modules and sheet the routes
 * serve, and the refusal when it did not.
 */
interface InstalledPlugin {
  readonly row: PluginInstallRow;
  readonly bundle: PluginBundle | null;
  readonly web: Uint8Array<ArrayBuffer> | null;
  /** The declared portable Worker entry, when the bundle carries one. */
  readonly worker: Uint8Array<ArrayBuffer> | null;
  readonly styles: Uint8Array<ArrayBuffer> | null;
  /** The bundle's recorded build against this server, derived once when its bytes verify. */
  readonly compatibility: PluginBuildCompatibility | null;
  readonly refusal?: PluginInstallRefusal;
}

/**
 * A first-party definition this process compiled and runs hardened at the operator's choice
 * (`first-party-builds.ts`): the pin its portable Worker entry is served under, the registered
 * definition every child it starts must bind to, and where that child's code is. There is no
 * install row, installer or grant — the definition's own manifest is its ceiling, exactly as
 * when it runs in-realm.
 */
interface TrustedPlugin {
  readonly sha256: string;
  readonly worker: Uint8Array<ArrayBuffer> | null;
  readonly registered: ServerPluginDef;
  readonly ref: InstalledPluginRef;
}

/** A migration chain staged by `prepareMigrations`, published in phases (see there). */
interface StagedMigration {
  activate(): void;
  commitMetadata(publish?: () => void): void;
  finish(): void;
  discard(): void;
  commit(publish?: () => void): void;
}

/** One member of an installation: exact verified bytes and the consent its row will carry. */
interface InstallCandidate {
  readonly artifact: VerifiedPluginArtifact;
  readonly grantedCaps: readonly AuthoredCap[];
  readonly hardened: boolean;
}

/** Who an installation is attributed to, and what it must keep proving until it commits. */
interface InstallAttribution {
  readonly installedBy: string;
  readonly installer: CredentialReference | null;
  readonly unpacked?: { readonly id: string };
  /** A reviewed update's authority and bound snapshot: asked after every await and at commit. */
  readonly assertCurrent?: () => void;
  /**
   * Told exactly once, synchronously, after the durable commit with every in-memory row final
   * and before the one roster publication; never for a refusal or rollback.
   */
  readonly committed?: () => void;
}

/**
 * One member of an atomic installation from publication to outcome: the row it will write,
 * the candidate it loaded, and everything a rollback restores.
 */
interface GroupMember {
  readonly id: string;
  readonly bundle: PluginBundle;
  readonly artifact: InstalledArtifact;
  /** Derived from the verified bytes before any commit, so nothing after it can throw here. */
  readonly web: Uint8Array<ArrayBuffer> | null;
  readonly worker: Uint8Array<ArrayBuffer> | null;
  readonly styles: Uint8Array<ArrayBuffer> | null;
  readonly compatibility: PluginBuildCompatibility;
  readonly previous: InstalledPlugin | undefined;
  readonly previousDef: ServerPluginDef | undefined;
  readonly previousLifecycle: PluginLifecycleState | undefined;
  /** A verified previous module serving now, told `onDisable` before it is replaced. */
  readonly live: boolean;
  /** A previously loaded hardened module, including disabled but not boot-held children. */
  readonly previousChild: boolean;
  row: PluginInstallRow;
  def: ServerPluginDef | undefined;
  staged: StagedMigration | undefined;
  retired: boolean;
  candidateChild: boolean;
  notified: boolean;
}

/** An update's authority or reviewed snapshot stopped being current; the message is the refusal. */
class InstallAuthorityLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallAuthorityLost";
  }
}

/**
 * The questions the assembly asks the machine socket registry — is this machine connected
 * right now, what its PTY owner holds, close or reopen its terminal admission and hear what
 * it holds (#278), and what repository one of its folders is (#529) — and nothing else. The
 * other services on `ActionCtx` are the real classes because plugins need their breadth;
 * handing over the gateway that authenticates machines, fences superseded sockets and relays
 * PTY frames in order to answer four questions would be authority nobody asked for.
 * `MachineGateway` satisfies this structurally, which is also what lets a test drive
 * liveness, drain and repository facts without a socket.
 */
export interface MachineAdmission {
  isOnline(machineId: string): boolean;
  getTerminalExecution(machineId: string): TerminalExecution | null;
  getPhysicalCoreCount(machineId: string): number | undefined;
  drain(machineId: string, draining: boolean): Promise<DrainOutcome>;
  /**
   * What the enrolled agent says one absolute path on its host is: the resolved git common
   * directory and the normalized `origin`, or the reason there is neither. Bounded, cached
   * on the host, and never a guess made here — a hub that cannot reach the machine answers
   * `ok: false` with the state that stopped it rather than a fact nobody observed.
   */
  repository(machineId: string, path: string): Promise<MachineRepositoryOutcome>;
}

/**
 * What a handler may ask about the fleet: the gateway's live per-machine facts, and the two
 * fleet-bridge reads that answer the whole inventory or move the admission latch (#259). The
 * bridge half re-proves the caller against the dispatch's admitted ceiling at every call, so
 * the same questions are safe to serve to a hardened guest, one round trip each.
 */
export interface ActionMachines extends Pick<
  MachineAdmission,
  "isOnline" | "getTerminalExecution" | "repository"
> {
  /** Every machine's public metadata in one answer; never a token or a private id. */
  inventory(): IdentityResult<MachineInventory>;
  /** An unknown machine is refused before the latch is touched; otherwise the gateway's. */
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
  readonly pluginId: string;
  /**
   * The verified immediate plugin opening this door, or null for a human, HTTP, session or
   * host entry. Host-owned lineage, never parsed from args; attribution is not a grant.
   */
  readonly callerPlugin: PluginId | null;
  readonly principal: Principal;
  /** Trusted authenticated Run identity; never populated from action arguments. */
  readonly agentRun: Readonly<{ runId: string; agentId: string }> | null;
  readonly auth: ActionAuth;
  /** Host-bound lineage and durable admission evidence; never caller supplied. */
  readonly credential: CredentialReference;
  /** Non-secret lineage equality key. It never supplies authority. */
  readonly credentialBinding: string;
  readonly references: PluginReferenceContext;
  readonly admission: GovernedAdmissionDecision | null;
  /** Host-only continuation after the isolate's real input parse; not a guest ctx slice. */
  readonly admitPrepared?: (targets: readonly unknown[]) => void;
  readonly streams: PluginStreamContext;
  readonly jobs: JobContext;
  readonly nativeTransfers: PluginNativeTransferContext;
  readonly services: PluginServiceContext;
  /**
   * THE ONE VERB ONTO A SIBLING (ADR 0041). `call({ plugin, action, input })` opens a door of
   * a plugin this one's manifest declared as a `required` or `optional` dependency, under THE
   * PRINCIPAL OF THE REQUEST THIS HANDLER IS SERVING — the callee's rungs grade that principal
   * exactly as they grade a client's, so no plugin gains authority by calling another. The
   * calling plugin is recorded as the origin on the callee's trace, and the only checks this
   * side adds are the declared edge, the cycle and the depth.
   */
  readonly actions: PluginActionContext;
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
   * concept, which is docs/CONTRACTS.md §One authoritative implementation with the seams showing. The target container is
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
   * Live machine liveness and admission, straight from the socket registry, plus the fleet
   * bridge's inventory and drain. Whether a machine is CONNECTED right now, and what its PTY
   * owner holds, is knowledge only the gateway has, and `core.machines.list` and
   * `core.machines.drain` have to answer with it.
   */
  readonly machines: ActionMachines;
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
   * THIS PLUGIN'S OWN TABLES (ADR 0034), present exactly when its manifest declares
   * `database`. A plugin that declared none has no slice here — the member is absent, and
   * through the isolate proxy the same absence answers `slice_unavailable` — so the file
   * exists only for plugins that asked for one. It is promise-returning for the same reason
   * storage is, it is the plugin's alone (one file per manifest id), and `batch` is its
   * transaction: there is no open handle a plugin could hold across its own awaits.
   */
  readonly database?: PluginDatabase;
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
  readonly byteCarriers?: Readonly<Record<string, ByteCarrierHandler>>;
  readonly harness?: ServerHarness<ActionCtx>;
  readonly probeReady?: (
    ctx: ReferenceProbeCtx,
    input: ReferenceProbeRequest,
  ) => Promise<ReferenceProbeResult>;
  /** Isolate bridge only: the same private probe, admitted only with a drained guest. */
  readonly probeReadyWhenIdle?: (
    ctx: ReferenceProbeCtx,
    input: ReferenceProbeRequest,
  ) => Promise<ReferenceProbeResult>;
  readonly reclaimReferences?: (
    ctx: ReferenceProbeCtx,
    receipts: readonly ReferenceTerminalReceipt[],
  ) => Promise<void>;
  /** Private own-data reconciliation; cannot publish, acquire bytes, or borrow caller authority. */
  readonly reconcileNativeTransfers?: (
    ctx: ReferenceProbeCtx,
    receipts: readonly NativeTransferTerminalEvidence[],
  ) => Promise<void>;
  /** Set only by the isolate bridge: real parsing precedes the host admission continuation. */
  readonly inputValidation?: "guest";
};

class ActionAdmissionDenial extends Error {
  constructor(
    readonly rule: Exclude<ActionDenialRule, typeof UNTRACED_DENIAL_RULE>,
    message: string,
  ) {
    super(message);
    this.name = "ActionAdmissionDenial";
  }
}

/**
 * The slice the engine's own doors touch: identity, the credential the two admitting doors
 * record on the row they write, the assembly they administer, and — for the one door that
 * writes the CALLER rather than the workspace — the principal-keyed store its value lands in.
 */
interface EngineDoorCtx {
  readonly traceId: number;
  readonly principal: Principal;
  readonly credential: CredentialReference;
  readonly host: HostControl;
  readonly store: Pick<
    ServerStore,
    "pluginSettings" | "setPluginSettings" | "workspacePluginSetting" | "setWorkspacePluginSetting"
  >;
  readonly auth: ActionAuth;
  readonly emit: EmitEvent;
}

/**
 * The refusal a reviewed update answers once its caller no longer holds root, whether the
 * door's live read or the host's credential restore noticed first.
 */
const UPDATE_AUTHORITY_REFUSAL = "forbidden: root authority required";

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
  jobDoors,
  serviceDoors,
  machineDoors,
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
        return ctx.host.purge(args.id, ctx.principal.id, ctx.traceId);
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
        return ctx.host.install(args, ctx.principal.id, ctx.credential);
      },
      /**
       * The reviewed update pair (#238). As thin as the install pair: the coordinator owns the
       * review and its digest, the host owns the one atomic replacement. Authority is the
       * caller's own and is asked again live, never frozen at dispatch.
       */
      async reviewUpdate(
        ctx: EngineDoorCtx,
        args: { id: string },
      ): Promise<ActionRefused | PluginUpdateReviewResult> {
        return ctx.host.reviewUpdate(args.id, {
          principalId: ctx.principal.id,
          credential: ctx.credential,
          assertCurrent: () => {
            if (!ctx.auth.isRoot) throw new Error(UPDATE_AUTHORITY_REFUSAL);
          },
        });
      },
      async applyUpdate(
        ctx: EngineDoorCtx,
        args: PluginUpdateApplyRequest,
      ): Promise<ActionRefused | PluginUpdateApplyResult> {
        return ctx.host.applyUpdate(args, {
          principalId: ctx.principal.id,
          credential: ctx.credential,
          assertCurrent: () => {
            if (!ctx.auth.isRoot) throw new Error(UPDATE_AUTHORITY_REFUSAL);
          },
        });
      },
      async listInstalled(ctx: EngineDoorCtx): Promise<InstalledPluginStates> {
        return ctx.host.listInstalled();
      },
      async exportInstalled(ctx: EngineDoorCtx): Promise<InstalledPluginsSnapshot> {
        return ctx.host.exportInstalled();
      },
      async uninstall(
        ctx: EngineDoorCtx,
        args: { id: string; purge?: boolean },
      ): Promise<ActionRefused | Record<string, never>> {
        const outcome = await ctx.host.uninstall(
          args.id,
          ctx.principal.id,
          args.purge === true,
          ctx.traceId,
        );
        if ("refused" in outcome) return outcome;
        return {};
      },
      /**
       * The two doors onto code written ON THIS INSTANCE (ADR 0025 §4). As thin as the install
       * pair, for the same reason: the switch, the directory, the build and the row are the
       * host's verdicts, and the door only names who asked.
       */
      async setDeveloperMode(
        ctx: EngineDoorCtx,
        args: { on: boolean },
      ): Promise<ActionRefused | Record<string, never>> {
        const outcome = await ctx.host.setDeveloperMode(args.on, ctx.principal.id);
        if ("refused" in outcome) return outcome;
        return {};
      },
      async author(
        ctx: EngineDoorCtx,
        args: PluginAuthorRequest,
      ): Promise<ActionRefused | PluginAuthorResult> {
        return ctx.host.author(args, ctx.principal.id, ctx.credential);
      },
      /** The single settings door: declaration, authority, value, then durable write. */
      async setSetting(
        ctx: EngineDoorCtx,
        args: { plugin: string; setting: string; value: boolean | string | null },
      ): Promise<ActionRefused | Record<string, never>> {
        const refusal = settingWriteRefusal(ctx.host.roster(), args.plugin, args.setting);
        if (refusal !== null) return { refused: refusal };
        const ref = settingRefId(args.plugin, args.setting);
        const setting = ctx.host
          .roster()
          .find((entry) => entry.manifest.id === args.plugin)!
          .manifest.contributes.settings!.find((setting) => setting.id === args.setting)!;
        if (setting.scope === "workspace" && !ctx.auth.allows("plugins:manage"))
          return { refused: "plugins:manage capability required" };
        if (
          args.value !== null &&
          !(setting.kind === "boolean"
            ? typeof args.value === "boolean"
            : setting.values.some((value) => value.id === args.value))
        )
          return { refused: `invalid_setting_value: ${ref}` };
        if (setting.scope === "workspace") {
          if ((ctx.store.workspacePluginSetting(ref) ?? null) === args.value) return {};
          ctx.store.setWorkspacePluginSetting(ref, args.value);
          ctx.emit(
            { kind: "plugin", pluginId: enginePluginsManifest.id },
            "plugin_setting_changed",
            { plugin: args.plugin, setting: args.setting },
          );
          return {};
        }
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
 * keeps a deterministic shape summary. Prefixes are capped independently as well as by the
 * serialized row bound, so an early value cannot consume the entire audit record.
 */
const TRACE_PAYLOAD_MAX_CHARS = 4_096;
const TRACE_PREFIX_MAX_CHARS = 256;

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
function traceAuthority(root: boolean, caps: readonly AuthoredCap[]): string {
  if (root) return TRACE_AUTHORITY_ROOT;
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
 * The ledger's provenance names come from host dispatch state, never door arguments.
 * `traceOrigin` owns plugin lineage (ADR 0041 §5); admission owns the Agent declaration.
 */
const RESERVED_TRACE_KEYS = ["origin", "parentTrace", "agentDeclaration"] as const;

interface TraceStringSummary {
  prefix: string;
  length: number;
  truncated: boolean;
}

interface TraceIndexedStringSummary extends TraceStringSummary {
  index: number;
}

interface TerminalOpenTraceSummary extends Record<string, unknown> {
  oversize: number;
  program?: {
    argv0: TraceStringSummary;
    args: TraceIndexedStringSummary[];
    itemCount: number;
    argsTruncated: boolean;
  };
  cwd?: TraceStringSummary;
}

interface GenericTraceSummary extends Record<string, unknown> {
  oversize: number;
  keys: TraceStringSummary[];
  keyCount: number;
  keysTruncated: boolean;
}

function tracePayloadFits(payload: Readonly<Record<string, unknown>>): boolean {
  return JSON.stringify(payload).length <= TRACE_PAYLOAD_MAX_CHARS;
}

function tracePrefix(value: string, requestedLength: number): string {
  let end = Math.min(requestedLength, value.length);
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function minimumTracePrefixLength(value: string): number {
  if (value.length === 0) return 0;
  return tracePrefix(value, 1).length === 0 ? 2 : 1;
}

/**
 * Admit the longest prefix which keeps the complete serialized summary in bounds. JSON escaping
 * makes source length an inaccurate proxy, so every admission decision measures the actual row.
 */
function admitTracePrefix(
  payload: Readonly<Record<string, unknown>>,
  value: string,
  setPrefix: (prefix: string) => void,
  minimum: number,
): void {
  let low = minimum;
  let high = Math.min(value.length, TRACE_PREFIX_MAX_CHARS);
  setPrefix(tracePrefix(value, low));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    setPrefix(tracePrefix(value, middle));
    if (tracePayloadFits(payload)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  setPrefix(tracePrefix(value, low));
}

function terminalOpenTraceSummary(
  redacted: Readonly<Record<string, unknown>>,
  oversize: number,
): TerminalOpenTraceSummary {
  const summary: TerminalOpenTraceSummary = { oversize };

  const cwd = Object.hasOwn(redacted, "cwd") ? redacted.cwd : undefined;
  if (typeof cwd === "string") {
    const prefix = tracePrefix(cwd, minimumTracePrefixLength(cwd));
    summary.cwd = {
      prefix,
      length: cwd.length,
      truncated: prefix.length < cwd.length,
    };
  }

  const program = Object.hasOwn(redacted, "program") ? redacted.program : undefined;
  const argvValue =
    program !== null &&
    typeof program === "object" &&
    !Array.isArray(program) &&
    Object.hasOwn(program, "argv")
      ? Reflect.get(program, "argv")
      : undefined;
  const argv =
    Array.isArray(argvValue) &&
    argvValue.every((value): value is string => typeof value === "string")
      ? argvValue
      : [];
  if (argv.length > 0) {
    const argv0 = argv[0];
    if (argv0 === undefined) throw new Error("terminal argv unexpectedly empty");
    const prefix = tracePrefix(argv0, minimumTracePrefixLength(argv0));
    summary.program = {
      argv0: { prefix, length: argv0.length, truncated: prefix.length < argv0.length },
      args: [],
      itemCount: argv.length,
      argsTruncated: argv.length > 1,
    };
    admitTracePrefix(
      summary,
      argv0,
      (prefix) => {
        if (summary.program === undefined) return;
        summary.program.argv0.prefix = prefix;
        summary.program.argv0.truncated = prefix.length < argv0.length;
      },
      minimumTracePrefixLength(argv0),
    );
    if (summary.cwd !== undefined && typeof cwd === "string") {
      admitTracePrefix(
        summary,
        cwd,
        (prefix) => {
          if (summary.cwd === undefined) return;
          summary.cwd.prefix = prefix;
          summary.cwd.truncated = prefix.length < cwd.length;
        },
        minimumTracePrefixLength(cwd),
      );
    }
    for (let index = 1; index < argv.length; index += 1) {
      const value = argv[index];
      if (value === undefined) break;
      const prefix = tracePrefix(value, minimumTracePrefixLength(value));
      const item: TraceIndexedStringSummary = {
        index,
        prefix,
        length: value.length,
        truncated: prefix.length < value.length,
      };
      summary.program.args.push(item);
      summary.program.argsTruncated = index + 1 < argv.length;
      if (!tracePayloadFits(summary)) {
        summary.program.args.pop();
        summary.program.argsTruncated = true;
        break;
      }
    }

    for (const item of summary.program.args) {
      const value = argv[item.index];
      if (value === undefined) continue;
      admitTracePrefix(
        summary,
        value,
        (prefix) => {
          item.prefix = prefix;
          item.truncated = prefix.length < value.length;
        },
        minimumTracePrefixLength(value),
      );
    }
  }

  if (argv.length === 0 && summary.cwd !== undefined && typeof cwd === "string") {
    admitTracePrefix(
      summary,
      cwd,
      (prefix) => {
        if (summary.cwd === undefined) return;
        summary.cwd.prefix = prefix;
        summary.cwd.truncated = prefix.length < cwd.length;
      },
      minimumTracePrefixLength(cwd),
    );
  }
  return summary;
}

function genericTraceSummary(
  redacted: Readonly<Record<string, unknown>>,
  oversize: number,
): GenericTraceSummary {
  const names = Object.keys(redacted);
  const summary: GenericTraceSummary = {
    oversize,
    keys: [],
    keyCount: names.length,
    keysTruncated: names.length > 0,
  };
  for (const name of names) {
    const key: TraceStringSummary = {
      prefix: "",
      length: name.length,
      truncated: name.length > 0,
    };
    summary.keys.push(key);
    summary.keysTruncated = summary.keys.length < names.length;
    if (!tracePayloadFits(summary)) {
      summary.keys.pop();
      summary.keysTruncated = true;
      break;
    }
  }
  for (let index = 0; index < summary.keys.length; index += 1) {
    const key = summary.keys[index];
    const name = names[index];
    if (key === undefined || name === undefined) continue;
    admitTracePrefix(
      summary,
      name,
      (prefix) => {
        key.prefix = prefix;
        key.truncated = prefix.length < name.length;
      },
      0,
    );
  }
  return summary;
}

/**
 * The arguments as the ledger keeps them. The authoring door is projected to bounded audit
 * facts before anything durable sees it: its `files` values are executable source, not audit
 * data. Every other door retains the shared recursive secret/terminal field redaction, reserved
 * provenance stripping, and oversize shaping.
 *
 * A body that is not an object records as empty rather than as itself. Every door's input is a
 * `z.strictObject`, so a non-object body is a malformed request the `invalid_args` rung is
 * about to name — and the ledger's payload column is a map of a door's named arguments, not a
 * place to keep whatever JSON a stranger posted.
 */
function tracePayload(door: string, rawArgs: unknown): Record<string, unknown> {
  if (door === ENGINE_AUTHOR_ACTION) return projectPluginAuthorFacts(rawArgs);
  if (rawArgs === null || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return {};
  // From this point onward summaries inspect only this fresh, recursively redacted copy.
  const redacted = redactFields(rawArgs as Record<string, unknown>);
  for (const reserved of RESERVED_TRACE_KEYS) delete redacted[reserved];
  const text = JSON.stringify(redacted);
  if (text.length <= TRACE_PAYLOAD_MAX_CHARS) return redacted;
  if (door !== "core.terminals.open" && door !== "core.terminals.create")
    return genericTraceSummary(redacted, text.length);
  const terminal = terminalOpenTraceSummary(redacted, text.length);
  return terminal.program === undefined && terminal.cwd === undefined
    ? genericTraceSummary(redacted, text.length)
    : terminal;
}

/** Emissions and explicit targets share one canonical, deduplicated address set. */
function traceTargets(targets: readonly ManifoldRef[]): readonly string[] {
  if (targets.length === 0) return [];
  const uris = new Set<string>();
  for (const ref of targets) uris.add(formatManifoldUri(ref));
  return [...uris];
}

/**
 * THE CALLING PLUGIN, when a dispatch was opened by a server handler rather than by a client
 * (ADR 0041). Written by `actionCalls` from the host's own knowledge of the dispatch already
 * in flight, so it is attribution the caller cannot forge: a handler hands over a plugin id,
 * an action and an input, and nothing else.
 *
 * `parentTrace` is the ledger row of the dispatch the caller is serving, or the
 * `LIFECYCLE_TRACE` sentinel when the caller is a hook — the same two cases `ctx.jobs`
 * already distinguishes. `stack` is every plugin frame on this trace, caller last.
 */
interface DispatchOrigin {
  readonly plugin: string;
  readonly parentTrace: number | string;
  readonly stack: readonly string[];
}

/** What a caller may say about a dispatch beyond the four arguments every dispatch has. */
interface DispatchOptions {
  agentJustification?: string;
  resultProjectionDigest?: string;
  onTrace?: (traceId: number) => void;
  /** Host-only late admission fence, including after isolated argument preparation. */
  admissionFence?: () => AuthContext | null;
  /** Settled caller lease after awaits; unlike admissionFence, it applies to non-Agent credentials. */
  beforeAdmission?: () => void;
  onAdmitted?: () => void;
  /** Never a field a request carries: only `actionCalls` sets it. */
  origin?: DispatchOrigin;
}

/**
 * The two keys a plugin-originated dispatch adds to its ledger row's payload, and their ONE
 * writer. They are attribution rather than arguments: {@link RESERVED_TRACE_KEYS} keeps them
 * out of every redacted body, so neither a client nor a calling handler can make the ledger
 * say a plugin opened a door it did not.
 */
function traceOrigin(origin: DispatchOrigin | undefined): Readonly<Record<string, unknown>> {
  if (origin === undefined) return {};
  return { origin: origin.plugin, parentTrace: origin.parentTrace };
}

/**
 * The action door's engine: it owns the live assembly, answers dispatches, and is the
 * only writer of workspace-global enablement.
 *
 * Context-targeted doors check scope and caps before parsing arguments. Resource-targeted
 * doors retain the early enablement/scope/install checks, then validate declared references
 * and discharge their caps through the same evaluator. Governed requirements additionally
 * need explicit version-bound store admission, never inferred from a flat install grant.
 *
 * Contract v2 (ADR 0013) adds no rung. Everything it introduced — dependency violations,
 * incompatibility, data downgrades, a purge of running code, a builtin row somebody tried
 * to switch off — is state only the handler can see, so all of it lands on the LAST rung as
 * a named `refused` class. The ladder a client learned still holds.
 *
 * Every install's grant is intersected at rung 4 before the caller's caps. Optional hardening
 * (ADR 0016) adds `unavailable` for a child that cannot answer, after `refused`; ordinary
 * in-realm handlers keep the same ladder as the distribution's handlers.
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
   * Rebuilt by `syncDefs` whenever an install lands or leaves; the first two parts never move
   * after boot, where a trusted hardened build may replace a first-party def with its proxy.
   */
  private defs: readonly ServerPluginDef[];
  private firstParty: readonly ServerPluginDef[];
  /** First-party definitions running hardened by the operator's choice, by id. */
  private readonly trusted = new Map<string, TrustedPlugin>();
  /** Trusted builds whose child an assembly hold retired; started again once released. */
  private readonly retiredTrusted = new Set<string>();
  private readonly handlers = new Map<string, Readonly<Record<string, ActionHandler>>>();
  private readonly byteDefinitions = new Map<string, ServerPluginDef>();
  private readonly bytePool = new ByteRequestPool();
  private readonly byteRequests = new Map<string, Set<() => void>>();
  private readonly guestInputPlugins = new Set<string>();
  /** Installed plugins by id: the row, the verified bundle, and the def the runner produced. */
  private readonly installed = new Map<string, InstalledPlugin>();
  private readonly installedDefs = new Map<string, ServerPluginDef>();
  /** Verified bundles not imported because their declarations were held at boot. */
  private readonly heldUnloaded = new Set<string>();
  /** Assembly mutations share the runner's one-child-per-id and data-commit boundary. */
  private assemblyChange: Promise<void> = Promise.resolve();
  /**
   * THE REPLACEMENT FENCE: every id whose module, row or data is mid-change. One member or a
   * whole family is fenced together, so no door, tool, harness or isolate report reaches a
   * member while its siblings are half replaced.
   */
  private readonly replacing = new Set<string>();
  private readonly activeDispatches = new Map<string, Set<Promise<void>>>();
  private readonly isolates: IsolateDeps | null;
  /**
   * The unpacked directory's hands (ADR 0025 §4): present exactly when this host admits
   * bundles, because an unpacked row IS an installed row and lands through the same door.
   */
  private readonly authored: AuthoredPlugins | null;
  /**
   * The reviewed release coordinator (#238), present exactly when this host admits bundles.
   * Its observations decorate every roster this host answers or publishes.
   */
  private readonly updates: PluginUpdates | null;
  private readonly storages = new Map<string, PluginStorageAdmin>();
  /**
   * One open handle per plugin that has touched its file, closed by a disable, a purge and
   * the shutdown. Keyed like `storages` and for the same reason: the handle is bound to one
   * manifest id, so two plugins cannot reach each other's rows even by naming the same table.
   */
  private readonly databases = new Map<string, PluginDatabaseAdmin>();
  /**
   * The discard of every migration chain staged right now. Its image and draft are not in
   * `databases`, so shutdown discards them here, and a discarded chain can never be published.
   */
  private readonly stagedMigrations = new Set<() => void>();
  /**
   * Aborted by `close`: every lease refuses, no plugin file is opened or recovered again, an
   * artifact fetch or write in flight is cancelled, and no assembly change starts, commits,
   * deletes an install's files, publishes a roster or answers.
   */
  private readonly lifetime = new AbortController();
  private get closed(): boolean {
    return this.lifetime.signal.aborted;
  }
  /**
   * Where `plugins/<id>/data.db` lives (ADR 0034 §1) — `config.dataDir`, the same directory
   * the isolate runner extracts bundles into. Null for a host assembled without one, which is
   * a unit fixture: no directory, no file, and `ctx.database` is absent for every plugin.
   */
  private readonly dataDir: string | null;
  private readonly rosterListeners = new Set<
    (roster: PluginRoster, developerMode: boolean) => void
  >();
  private readonly builtins: ReadonlySet<string>;
  /**
   * The ids the shipped distribution registers, handed in by the composition root because
   * this file may not name a plugin — the same direction `FLOOR_EVENT_OWNERS` travels. It is
   * NOT derived from `defs`: a def list is what the host was given, so deriving the permitted
   * set from it would let any manifest authorize its own `core.` id.
   */
  private readonly distribution: ReadonlySet<string> | undefined;
  private readonly referenceKindReservations: ReadonlyMap<PluginOwnedRefKind, string>;
  private readonly referenceService: ReferenceService;
  private readonly installationGenerations = new Map<
    string,
    {
      definition: ServerPluginDef | undefined;
      generation: object;
    }
  >();
  /**
   * The outcome of the last lifecycle fan-out per plugin. In MEMORY, deliberately: it
   * describes this process's attempt to tell a plugin about a transition, not a durable
   * fact about the workspace. A restart clears it because a restart re-runs nothing.
   */
  private readonly lifecycleStates = new Map<string, PluginLifecycleState>();
  private readonly lifecycleTimeoutMs: number;
  private readonly jobSettledTimeouts: ReadonlyMap<string, number>;
  private readonly settlementEpochs = new Map<string, number>();
  readonly streams = new StreamService(
    () => this.assembled,
    (plugin, node) => this.ownsStreamNode(plugin, node),
  );
  private jobs: JobService | null = null;

  /** Binary continuation of a declared lifecycle, with no action/grant mutation context. */
  async serveBytes(
    actor: AuthContext,
    pluginId: string,
    carrierId: string,
    input: ByteCarrierRequest,
    request: Request,
  ): Promise<Response> {
    const definition = this.byteDefinitions.get(pluginId);
    const declaration = definition?.manifest.contributes.byteCarriers?.find(
      (candidate) => candidate.id === carrierId,
    );
    const handler = definition?.byteCarriers?.[carrierId];
    if (
      definition === undefined ||
      declaration === undefined ||
      handler === undefined ||
      handler.direction !== declaration.direction ||
      request.method !== (declaration.direction === "incoming" ? "POST" : "GET") ||
      !declaration.refKinds.includes(input.ref.kind)
    )
      return byteFailure("unavailable");
    const credential = this.authService.credentialReference(actor);
    const generation = this.installationGeneration(pluginId);
    const target = formatManifoldUri(input.ref);
    const owned = PluginOwnedRefSchema.safeParse(input.ref);
    const controller = new AbortController();
    const failed = Promise.withResolvers<Response>();
    const settled = Promise.withResolvers<void>();
    let open = true;
    let current = actor;
    let lease: ReturnType<PluginHost["dataLease"]> | undefined;
    let releasePool: (() => void) | undefined;
    let removeAuthority: (() => void) | undefined;
    let removeRevocation: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let deadlineAt = this.runtime.now() + BYTE_REQUEST_TIMEOUT_MS;
    let deadlineReason: ByteRefusal = "request_timeout";
    const release = (): void => {
      if (!open) return;
      open = false;
      if (timeout !== undefined) clearTimeout(timeout);
      removeAuthority?.();
      removeRevocation?.();
      request.signal.removeEventListener("abort", requestAborted);
      this.lifetime.signal.removeEventListener("abort", hostAborted);
      lease?.close();
      releasePool?.();
      this.byteRequests.get(pluginId)?.delete(hostAborted);
      if (this.byteRequests.get(pluginId)?.size === 0) this.byteRequests.delete(pluginId);
      this.activeDispatches.get(pluginId)?.delete(settled.promise);
      if (this.activeDispatches.get(pluginId)?.size === 0) this.activeDispatches.delete(pluginId);
      controller.abort(new ByteTransferError("cancelled"));
      settled.resolve();
    };
    const abort = (reason: ByteRefusal): void => {
      if (!open) return;
      controller.abort(new ByteTransferError(reason));
      failed.resolve(byteFailure(reason));
      release();
    };
    const requestAborted = (): void => abort("cancelled");
    const hostAborted = (): void => abort("unavailable");
    const restrictDeadline = (expiresAt: number, reason: ByteRefusal): void => {
      if (expiresAt > deadlineAt) return;
      deadlineAt = expiresAt;
      deadlineReason = reason;
      if (timeout !== undefined) clearTimeout(timeout);
      const remaining = deadlineAt - this.runtime.now();
      if (remaining <= 0) {
        abort(reason);
        return;
      }
      timeout = setTimeout(() => abort(reason), remaining);
      timeout.unref();
    };
    const assertCurrent = (): void => {
      if (this.runtime.now() >= deadlineAt) abort(deadlineReason);
      if (controller.signal.aborted) {
        const reason: unknown = controller.signal.reason;
        throw reason instanceof ByteTransferError ? reason : new ByteTransferError("unavailable");
      }
      const restored = this.authService.restoreCredential(credential);
      const installed = this.installed.get(pluginId);
      if (
        !open ||
        this.closed ||
        this.replacing.has(pluginId) ||
        this.byteDefinitions.get(pluginId) !== definition ||
        this.installationGenerations.get(pluginId)?.generation !== generation ||
        !this.assembled.enabled(pluginId) ||
        restored === null ||
        !this.authService.allowsRef(restored, declaration.capability, input.ref) ||
        (installed !== undefined &&
          !GOVERNED_CAPS.includes(declaration.capability) &&
          !withinCeiling(declaration.capability, installed.row.grantedCaps)) ||
        (declaration.direction === "outgoing" &&
          owned.success &&
          !this.canReadPublishedReference(restored, owned.data))
      )
        throw new ByteTransferError("unavailable");
      current = restored;
    };
    try {
      if (request.signal.aborted) throw new ByteTransferError("cancelled");
      assertCurrent();
      releasePool = this.bytePool.acquire(actor.principal.id, pluginId, input.transferId);
      const pending = this.activeDispatches.get(pluginId) ?? new Set<Promise<void>>();
      pending.add(settled.promise);
      this.activeDispatches.set(pluginId, pending);
      const requests = this.byteRequests.get(pluginId) ?? new Set<() => void>();
      requests.add(hostAborted);
      this.byteRequests.set(pluginId, requests);
      lease = this.dataLease(pluginId, undefined, undefined, 256, assertCurrent);
      const authorityChanged = (): void => {
        try {
          assertCurrent();
        } catch {
          abort("unavailable");
        }
      };
      removeAuthority = this.authService.onAuthorityChanged(authorityChanged);
      removeRevocation = this.authService.onRevoked((principalId) => {
        if (principalId === actor.principal.id) authorityChanged();
      });
      request.signal.addEventListener("abort", requestAborted, { once: true });
      this.lifetime.signal.addEventListener("abort", hostAborted, { once: true });
      restrictDeadline(deadlineAt, "request_timeout");
      if (credential.expiresAt !== undefined) restrictDeadline(credential.expiresAt, "unavailable");
      const requireCapability = (cap: AuthoredCap, ref: ManifoldRef): void => {
        assertCurrent();
        if (cap !== declaration.capability || formatManifoldUri(ref) !== target)
          throw new ByteTransferError("unavailable");
      };
      const context: ByteCarrierContext = {
        pluginId,
        principal: actor.principal,
        credentialBinding: this.authService.credentialBinding(actor),
        signal: controller.signal,
        ...(lease.database === undefined ? {} : { database: lease.database }),
        now: () => this.runtime.now(),
        assertCurrent,
        requirePublished: async (ref) => {
          const owner = this.assembled.referenceKinds.get(ref.kind);
          if (owner === undefined) throw new ByteTransferError("unavailable");
          requireCapability(owner.declaration.readCapability, ref);
          const identity = await this.requirePublishedReference(current, ref);
          assertCurrent();
          return identity;
        },
        nativeTransfers: readNativeTransferContext(
          () => {
            if (this.jobs === null) throw new ByteTransferError("unavailable");
            return this.jobs.nativeTransfers;
          },
          actor,
          pluginId,
          {
            assertCurrent,
            remainingMs: () =>
              Math.max(
                0,
                Math.min(
                  deadlineAt - this.runtime.now(),
                  this.isolates?.runner.remainingHostCallMs() ?? Number.POSITIVE_INFINITY,
                ),
              ),
            signal: controller.signal,
            require: requireCapability,
            requireSource: async () => {
              throw new ByteTransferError("unavailable");
            },
          },
        ),
      };
      return await Promise.race([
        serveByteCarrier({
          request,
          input,
          context,
          handler,
          release,
          report: (evt) => this.logger.error(evt, { pluginId }),
          restrictDeadline: (expiresAt) => restrictDeadline(expiresAt, "expired"),
          ...(definition.manifest.database?.recovery === undefined
            ? {}
            : {
                admitIncoming: async () => {
                  assertCurrent();
                  if (lease?.database === undefined) throw new ByteTransferError("unavailable");
                  return lease.database.admitRecovery();
                },
              }),
        }),
        failed.promise,
      ]);
    } catch (error) {
      release();
      if (error instanceof ByteTransferError) return byteFailure(error.reason);
      this.logger.error("byte_request_failed", { pluginId });
      return byteFailure("unavailable");
    }
  }

  /** Activation identity fences even a disable/re-enable of the same compiled definition. */
  private installationGeneration(pluginId: string): object {
    const definition = this.defs.find((candidate) => candidate.manifest.id === pluginId);
    const current = this.installationGenerations.get(pluginId);
    if (current !== undefined && current.definition === definition) return current.generation;
    const generation = {};
    this.installationGenerations.set(pluginId, { definition, generation });
    return generation;
  }

  private referenceOwner(kind: PluginOwnedRefKind): ReferenceOwner | null {
    const registered = this.assembled?.referenceKinds.get(kind);
    if (
      registered === undefined ||
      !this.assembled.enabled(registered.plugin) ||
      this.closed ||
      this.replacing.has(registered.plugin)
    )
      return null;
    const def = this.defs.find((candidate) => candidate.manifest.id === registered.plugin);
    if (def?.probeReady === undefined || def.reclaimReferences === undefined) return null;
    const probeReady = def.probeReady;
    const reclaimReferences = def.reclaimReferences;
    const pluginId = registered.plugin;
    return {
      pluginId,
      declaration: registered.declaration,
      generation: this.installationGeneration(pluginId),
      generationDigest: sha256Hex(
        canonicalJobJson({
          manifest: def.manifest,
          artifact: this.installed.get(pluginId)?.row.sha256 ?? null,
        }),
      ),
      probe: async (input) => {
        const result = await this.referenceDataCall(pluginId, (ctx) => probeReady(ctx, input));
        return ReferenceProbeResultSchema.parse(result);
      },
      probeWhenIdle: async (input) => {
        if ((this.activeDispatches.get(pluginId)?.size ?? 0) !== 0) throw new ReferenceRefused();
        // The supervisor repeats exclusive admission after ensureRunning, closing races with
        // dispatch, hooks, harnesses and producer callbacks that a host-side idle snapshot misses.
        const idleProbe = def.probeReadyWhenIdle ?? probeReady;
        const result = await this.referenceDataCall(pluginId, (ctx) => idleProbe(ctx, input));
        return ReferenceProbeResultSchema.parse(result);
      },
      reclaim: (receipts) =>
        this.referenceDataCall(pluginId, (ctx) => reclaimReferences(ctx, receipts)),
    };
  }

  /** A private bounded owner-data lease, not a dispatch or borrowed lifecycle authority. */
  private async referenceDataCall<T>(
    pluginId: string,
    invoke: (ctx: ReferenceProbeCtx) => Promise<T>,
  ): Promise<T> {
    const lease = this.dataLease(
      pluginId,
      this.storage(pluginId),
      this.databaseSlice(pluginId) ?? null,
      256,
    );
    const settled = Promise.withResolvers<void>();
    let active = this.activeDispatches.get(pluginId);
    if (active === undefined) this.activeDispatches.set(pluginId, (active = new Set()));
    active.add(settled.promise);
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          lease.close();
          reject(new ReferenceRefused());
        }, 2_000);
      });
      return await Promise.race([
        invoke({
          storage: lease.storage,
          ...(lease.database ? { database: lease.database } : {}),
          now: () => this.runtime.now(),
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      lease.close();
      settled.resolve();
      active.delete(settled.promise);
      if (active.size === 0) this.activeDispatches.delete(pluginId);
    }
  }

  requirePublishedReference(
    actor: AuthContext,
    ref: PluginOwnedRef,
  ): Promise<PublishedReferenceIdentity> {
    return this.referenceService.requirePublished(actor, ref);
  }

  canReadPublishedReference(actor: AuthContext, ref: PluginOwnedRef): boolean {
    return this.referenceService.canReadPublished(actor, ref);
  }

  async resolveOwnedReference(
    actor: AuthContext,
    ref: PluginOwnedRef,
  ): Promise<{ exists: boolean; title: string | null }> {
    const unavailable = { exists: false, title: null };
    try {
      const owner = this.referenceOwner(ref.kind);
      if (owner === null) return unavailable;
      const before = await this.referenceService.requirePublished(actor, ref);
      const result = await this.dispatch(
        actor,
        `${owner.pluginId}.${owner.declaration.resolveAction}`,
        { ref },
      );
      const after = await this.referenceService.requirePublished(actor, ref);
      if (
        !result.ok ||
        before.preparationId !== after.preparationId ||
        before.readyDigest !== after.readyDigest ||
        this.referenceOwner(ref.kind)?.generation !== owner.generation ||
        result.result === null ||
        typeof result.result !== "object"
      )
        return unavailable;
      const title: unknown = Reflect.get(result.result, "title");
      const exists: unknown = Reflect.get(result.result, "exists");
      if (exists === false) return unavailable;
      if (title === null && exists === true) return { exists: true, title: null };
      if (typeof title !== "string" || title.length > 512) return unavailable;
      return { exists: true, title };
    } catch {
      // Missing, denied, disabled and corrupt identity have the same non-disclosing projection.
      return unavailable;
    }
  }

  private harnessProblems(defs: readonly ServerPluginDef[]): readonly AssemblyProblem[] {
    const problems: AssemblyProblem[] = [];
    for (const def of defs) {
      const declaration = def.manifest.contributes?.harness;
      if (!declaration) {
        if (def.harness)
          problems.push({
            reason: `${def.manifest.id}: undeclared harness`,
            plugins: [def.manifest.id],
          });
        continue;
      }
      if (
        def.harness &&
        (typeof def.harness.profileSchema?.safeParse !== "function" ||
          typeof def.harness.launch !== "function" ||
          typeof def.harness.sessions !== "function" ||
          typeof def.harness.resolveSession !== "function" ||
          typeof def.harness.send !== "function")
      )
        problems.push({
          reason: `${def.manifest.id}: invalid harness implementation`,
          plugins: [def.manifest.id],
        });
    }
    return problems;
  }

  private harnessDefinition(id: string): ServerPluginDef & { harness: ServerHarness<ActionCtx> } {
    const def = this.defs.find(
      (def) =>
        this.assembled.enabled(def.manifest.id) && def.manifest.contributes.harness?.id === id,
    );
    if (
      !def?.harness ||
      !this.assembled.enabled(def.manifest.id) ||
      this.replacing.has(def.manifest.id)
    )
      throw new ServiceError("forbidden", "harness unavailable");
    return { ...def, harness: def.harness };
  }

  private async validateAgentProfile(harness: string, profile: unknown): Promise<void> {
    // External is explicit bring-your-own inventory, not an executable installed adapter.
    if (harness === "external") return;
    const definition = this.harnessDefinition(harness);
    if (!(await definition.harness.profileSchema.safeParseAsync(profile)).success)
      throw new ServiceError("forbidden", "harness profile invalid");
    if (this.harnessDefinition(harness).harness !== definition.harness)
      throw new ServiceError("forbidden", "harness changed during profile validation");
  }

  /** Borrow the dispatch's identity and trace, but bind native resources to the owning plugin. */
  private async withHarness<T>(
    base: ActionCtx,
    actor: AuthContext,
    id: string,
    session: string | null,
    stack: readonly string[],
    invoke: (harness: ServerHarness<ActionCtx>, ctx: ActionCtx, pluginId: string) => Promise<T>,
  ): Promise<T> {
    const def = this.harnessDefinition(id);
    const pluginId = def.manifest.id;
    const install = this.installed.get(pluginId);
    const current = this.authService.restoreCredential(this.authService.credentialReference(actor));
    if (!current) throw new ServiceError("forbidden", "harness caller unavailable");
    const nativeAuth = {
      ...current,
      caps: CAPS.filter(
        (cap) =>
          withinCeiling(cap, current.caps) &&
          withinCeiling(cap, def.manifest.capabilities) &&
          (!install || GOVERNED_CAPS.includes(cap) || withinCeiling(cap, install.row.grantedCaps)),
      ),
    };
    const lease = this.dataLease(pluginId);
    const settled = Promise.withResolvers<void>();
    let active = this.activeDispatches.get(pluginId);
    if (!active) this.activeDispatches.set(pluginId, (active = new Set()));
    active.add(settled.promise);
    const service = () => {
      if (!this.jobs) throw new ServiceError("forbidden", "job service unavailable");
      return this.jobs;
    };
    const shared = { ...base };
    delete shared.database;
    try {
      return await invoke(
        def.harness,
        {
          ...shared,
          pluginId,
          // The host invokes a harness; the door's own caller did not call this plugin.
          callerPlugin: null,
          actions: this.actionCalls(pluginId, current, session, base.traceId, [...stack, pluginId]),
          credential: this.authService.credentialReference(nativeAuth),
          credentialBinding: this.authService.credentialBinding(nativeAuth),
          references: this.referenceService.context({
            pluginId,
            actor: current,
            traceId: base.traceId,
            check: () => {
              throw new ReferenceRefused();
            },
            checkReceipt: () => {
              throw new ReferenceRefused();
            },
            checkReadable: () => {
              throw new ReferenceRefused();
            },
          }),
          jobs: jobContext(service, nativeAuth, pluginId, base.traceId),
          get nativeTransfers(): PluginNativeTransferContext {
            throw new ServiceError("forbidden", "transfer_action_unavailable");
          },
          services: serviceContext(
            service,
            nativeAuth,
            pluginId,
            base.traceId,
            withinCeiling("services:invoke", nativeAuth.caps) ? "invoke" : "read",
          ),
          storage: lease.storage,
          ...(lease.database ? { database: lease.database } : {}),
        },
        pluginId,
      );
    } finally {
      lease.close();
      settled.resolve();
      active.delete(settled.promise);
      if (active.size === 0) this.activeDispatches.delete(pluginId);
    }
  }

  private readonly launchingRuns = new Set<string>();

  private async launchHarnessRun(
    base: ActionCtx,
    actor: AuthContext,
    input: LaunchRunRequest,
    session: string | null,
    stack: readonly string[],
  ): Promise<LaunchRunResult> {
    if (this.launchingRuns.has(input.runId))
      throw new ServiceError("conflict", "run launch already in progress");
    this.launchingRuns.add(input.runId);
    try {
      let claim = this.authService.claimRunLaunch(input.runId, actor);
      const target = HarnessTargetSchema.safeParse(input.target ?? claim.target);
      if (!target.success) throw new ServiceError("forbidden", "harness launch target required");
      const declaredTarget = parseManifoldUri(claim.run.target);
      if (
        (declaredTarget &&
          "machineId" in declaredTarget &&
          declaredTarget.machineId !== target.data.machineId) ||
        (declaredTarget?.kind === "container" &&
          declaredTarget.containerId !== target.data.containerId) ||
        (claim.target?.containerId !== undefined &&
          claim.target.containerId !== target.data.containerId)
      )
        throw new ServiceError("forbidden", "harness launch target changed");
      if (!this.jobs) throw new ServiceError("forbidden", "run_launch_owner_unavailable");
      this.jobs.assertRunLaunchSupported(target.data.machineId);
      const validatedHarness = this.harnessDefinition(claim.agent.harness).harness;
      await this.validateAgentProfile(claim.agent.harness, claim.agent.context.profile);
      const current = this.authService.claimRunLaunch(input.runId, actor);
      if (
        current.agent.harness !== claim.agent.harness ||
        canonicalJobJson(current.agent.context) !== canonicalJobJson(claim.agent.context) ||
        this.harnessDefinition(current.agent.harness).harness !== validatedHarness
      )
        throw new ServiceError("forbidden", "harness context changed during profile validation");
      claim = current;
      return await this.withHarness(
        base,
        actor,
        claim.agent.harness,
        session,
        stack,
        async (harness, ctx, pluginId) => {
          const prepared = await harness.launch(ctx, claim.run, claim.agent, target.data);
          const runtime = TerminalRuntimeSchema.parse(prepared.runtime);
          const session = SessionRefSchema.parse(prepared.session);
          if (
            runtime.pluginId !== pluginId ||
            runtime.machineId !== target.data.machineId ||
            session.machineId !== target.data.machineId ||
            session.harness !== claim.agent.harness
          )
            throw new ServiceError("forbidden", "harness launch destination mismatch");
          const descriptor = LaunchRunResultSchema.parse({
            runtime,
            session,
            reviewDigest: prepared.reviewDigest,
            destination: { machineId: target.data.machineId },
          });
          this.harnessDefinition(claim.agent.harness);
          this.jobs!.assertRunLaunchSupported(target.data.machineId);
          const token = this.authService.bindRunSession(input.runId, session, actor);
          return {
            ...descriptor,
            runtime: this.broker.bindRunLaunch(
              runtime,
              claim.run,
              token,
              actor,
              target.data.containerId,
              claim.terminalId,
            ),
          };
        },
      );
    } finally {
      this.launchingRuns.delete(input.runId);
    }
  }

  /** Trusted runtime composition; registered doors refuse until the durable service is ready. */
  setJobs(jobs: JobService): void {
    jobs.setLifecycleRecorder((record) => this.store.appendTrace(record));
    jobs.setAgentTools({
      harnessPlugin: (agent) => {
        // One-shot jobs consume their separately reviewed native inputs, not the
        // Agent's interactive profile. Parse profiles at registration, update and
        // harness launch; synchronous native fences resolve the live owner only.
        return this.harnessDefinition(agent.harness).manifest.id;
      },
      call: (restore, request, signal, admitted) =>
        this.agentToolCall(restore, request, signal, admitted),
    });
    jobs.setManifestResolver((pluginId) => {
      if (!this.assembled.enabled(pluginId)) return null;
      return (
        this.assembled.roster.find((entry) => entry.manifest.id === pluginId)?.manifest.machine ??
        null
      );
    });
    jobs.setBundleResolver((pluginId) => this.installed.get(pluginId)?.bundle ?? null);
    jobs.setSettledListener((delivery) => {
      void this.jobSettled(delivery);
    });
    this.jobs = jobs;
    jobs.nativeTransfers.setEvidenceSink(async (pluginId, receipts) => {
      if (this.closed || this.replacing.has(pluginId)) return false;
      const def = this.defs.find((candidate) => candidate.manifest.id === pluginId);
      if (!def) return false;
      if (!def.reconcileNativeTransfers) return true;
      await this.referenceDataCall(pluginId, (ctx) => def.reconcileNativeTransfers!(ctx, receipts));
      return true;
    });
    void jobs.nativeTransfers.reconcile();
    jobs.setHeldPlugins(
      this.assembled.roster
        .filter((entry) => entry.held !== undefined)
        .map((entry) => entry.manifest.id),
    );
    this.streams.reconcile();
  }

  private async selectedAgentTool(authority: NativeRunAuthority, door: string) {
    const approval = authority.run.tools?.find((entry) => entry.door === door);
    const refuse = (reason: AgentToolRefusalCode) => ({ ok: false as const, reason });
    if (!approval) return refuse("tool_ungranted");
    const grantRefusal = this.authService.agentToolGrantRefusal(authority.run.id, door);
    if (grantRefusal !== null) return refuse(grantRefusal);
    const entry = this.assembled.actions.get(door);
    const row = entry && this.assembled.roster.find((row) => row.manifest.id === entry.plugin.id);
    const summary = row?.actions.find((action) => action.name === door);
    if (
      !entry ||
      !summary ||
      row?.source !== "plugin" ||
      entry.def.runAccess !== undefined ||
      !this.assembled.enabled(entry.plugin.id) ||
      this.replacing.has(entry.plugin.id) ||
      !this.handlers.get(entry.plugin.id)?.[entry.def.name] ||
      !entry.resultProjection
    )
      return refuse("tool_unavailable");
    if (
      this.guestInputPlugins.has(entry.plugin.id) &&
      (this.installed.get(entry.plugin.id)?.bundle?.hardenedContract ?? 0) < 6
    )
      return refuse("unsupported_feature");
    if ((await entry.resultProjection.digest) !== approval.contractDigest)
      return refuse("publication_changed");
    let name: string;
    try {
      name = agentToolName(door);
    } catch {
      return refuse("unsupported_feature");
    }
    if (
      summary.title.length > 1024 ||
      Buffer.byteLength(JSON.stringify(summary.input), "utf8") > 16_384
    )
      return refuse("unsupported_feature");
    return {
      ok: true as const,
      approval,
      entry,
      description: {
        door,
        name,
        title: summary.title,
        parameters: summary.input,
        contractDigest: approval.contractDigest,
      },
    };
  }

  private async agentToolCall(
    restore: () => NativeRunAuthority,
    request: AgentToolRequest,
    signal: AbortSignal,
    admitted: () => void,
  ): Promise<AgentToolReply> {
    const authority = restore();
    if (request.type === "describe") {
      const tools: Extract<AgentToolReply, { type: "description" }>["tools"] = [];
      const unavailable: Extract<AgentToolReply, { type: "description" }>["unavailable"] = [];
      const names = new Set<string>();
      for (const approval of authority.run.tools ?? []) {
        const selected = await this.selectedAgentTool(restore(), approval.door);
        if (!selected.ok) unavailable.push({ door: approval.door, reason: selected.reason });
        else if (names.has(selected.description.name))
          unavailable.push({ door: approval.door, reason: "unsupported_feature" });
        else {
          names.add(selected.description.name);
          tools.push(selected.description);
        }
      }
      restore();
      return AgentToolReplySchema.parse({
        type: "description",
        runId: authority.run.id,
        agentId: authority.run.agentId,
        target: authority.run.target,
        tools,
        unavailable,
      });
    }
    if (request.type === "policy")
      return { type: "policy", policy: this.authService.agentPolicyChallenge(restore().auth) };
    const selected =
      request.type === "invoke" ? await this.selectedAgentTool(authority, request.door) : null;
    if (selected && !selected.ok) return { type: "refused", code: selected.reason, traceId: null };
    const approval = selected?.ok ? selected.approval : undefined;
    const entry = selected?.ok ? selected.entry : undefined;
    const door = request.type === "ack" ? "core.access.acknowledgeAgentPolicy" : request.door;
    let traceId: number | null = null;
    let began = false;
    const fence = (): AuthContext | null => {
      if (signal.aborted) return null;
      try {
        const current = restore();
        if (approval) {
          if (
            this.authService.agentToolGrantRefusal(current.run.id, door) !== null ||
            this.assembled.actions.get(door) !== entry
          )
            return null;
        }
        return current.auth;
      } catch {
        return null;
      }
    };
    const actor = fence();
    if (actor === null)
      return {
        type: "refused",
        code: signal.aborted ? "cancelled" : "authority_unavailable",
        traceId,
      };
    try {
      const outcome = await this.dispatch(
        actor,
        door,
        request.type === "ack" ? request.policy : request.args,
        null,
        {
          ...(request.type === "invoke" && request.justification !== undefined
            ? { agentJustification: request.justification }
            : {}),
          ...(approval ? { resultProjectionDigest: approval.contractDigest } : {}),
          admissionFence: fence,
          onAdmitted: () => {
            admitted();
            began = true;
          },
          onTrace: (id) => {
            traceId = id;
          },
        },
      );
      if (traceId === null) return { type: "unknown", reason: "missing_trace", traceId };
      let projection = outcome.ok ? outcome.projection : undefined;
      if (
        projection?.ok &&
        approval?.maxResultBytes !== undefined &&
        Buffer.byteLength(JSON.stringify(projection.data), "utf8") > approval.maxResultBytes
      )
        projection = {
          ok: false,
          contractDigest: approval.contractDigest,
          code: "projection_limit",
        };
      if (projection && approval && fence() === null)
        projection = {
          ok: false,
          contractDigest: approval.contractDigest,
          code: "projection_invalid",
        };
      return AgentToolReplySchema.parse({
        type: "result",
        door,
        traceId,
        outcome: outcome.ok ? { ok: true } : { ok: false, denial: { rule: outcome.denial.rule } },
        ...(projection ? { projection: { ...projection, trust: "untrusted" } } : {}),
      });
    } catch {
      return began
        ? { type: "unknown", reason: "interrupted", traceId }
        : {
            type: "refused",
            code: signal.aborted ? "cancelled" : "authority_unavailable",
            traceId,
          };
    }
  }

  canReadGoverned(auth: AuthContext, node: ManifoldRef): boolean {
    if (node.kind === "file") return this.canReadPublishedReference(auth, node);
    if (
      node.kind !== "operation" &&
      node.kind !== "location" &&
      node.kind !== "job" &&
      node.kind !== "output" &&
      node.kind !== "service"
    )
      return true;
    return this.jobs?.canReadGoverned(auth, node) ?? false;
  }

  private ownsStreamNode(plugin: string, node: ManifoldRef): boolean {
    if (node.kind === "file")
      return this.assembled.referenceKinds.get(node.kind)?.plugin === plugin;
    if (node.kind === "plugin") {
      return (
        node.pluginId === plugin && this.assembled.roster.some((row) => row.manifest.id === plugin)
      );
    }
    if (node.kind === "element") {
      const element = this.rooms.get(node.containerId)?.element(node.elementId);
      return (
        element !== undefined &&
        element !== null &&
        this.store.elementOwners().get(element.type) === plugin
      );
    }
    return this.jobs?.ownsNode(plugin, node) ?? false;
  }

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
      readonly jobSettledTimeouts?: JobSettledTimeouts;
      readonly distribution?: ReadonlySet<string>;
      readonly referenceKindOwners?: ReadonlyMap<PluginOwnedRefKind, string>;
      readonly isolates?: IsolateDeps;
      readonly dataDir?: string;
    },
  ) {
    this.firstParty = [...ENGINE_BUILTIN_DEFS, ...defs];
    this.defs = this.firstParty;
    this.builtins = new Set(ENGINE_BUILTIN_DEFS.map((def) => def.manifest.id));
    this.distribution = options.distribution;
    this.isolates = options.isolates ?? null;
    this.dataDir = options.dataDir ?? options.isolates?.dataDir ?? null;
    this.referenceKindReservations = options.referenceKindOwners ?? new Map();
    for (const [kind, pluginId] of this.referenceKindReservations)
      store.claimReferenceKinds(pluginId, [kind]);
    this.referenceService = new ReferenceService(
      store,
      authService,
      runtime,
      (kind) => this.referenceOwner(kind),
      (additionalBytes) => {
        if (this.dataDir === null) return; // In-memory hosts have no recoverable filesystem image.
        const admission = inspectRecoveryCapacity(this.dataDir, store.db, { additionalBytes });
        if (!admission.ok) throw new ReferenceRefused(admission.reason);
      },
      (pluginId) => this.logger.warn("reference_cleanup_pending", { plugin: pluginId }),
    );
    this.referenceService.restart();
    this.authored =
      this.isolates === null
        ? null
        : new AuthoredPlugins(
            this.isolates.dataDir,
            {
              installUnpacked: (id, source, sha256, installedBy, installer) =>
                this.installUnpacked(id, source, sha256, installedBy, installer),
              unpackedRow: (id) => this.unpackedRow(id),
              developerMode: () => this.store.developerMode(),
            },
            logger,
            this.isolates.pack,
          );
    this.updates =
      this.isolates === null
        ? null
        : new PluginUpdates({
            store,
            dataDir: this.isolates.dataDir,
            signal: this.lifetime.signal,
            now: () => this.runtime.now(),
            host: {
              installed: () => this.installed,
              // Raw: the coordinator decorates this, so it must never read its own decoration.
              roster: () => this.assembled.roster,
              serialize: (run) => this.changeAssembly(run),
              // Invoked by the coordinator INSIDE `serialize`, so it never queues again.
              apply: (members, authority) => this.applyUpdateNow(members, authority),
              publish: () => {
                this.publish();
              },
              nativeSnapshot: (ids) => {
                const wanted = new Set(ids);
                return canonicalJobJson(
                  this.jobs?.jobs
                    .installations()
                    .filter((installation) => wanted.has(installation.pluginId)) ?? [],
                );
              },
            },
          });
    this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? LIFECYCLE_TIMEOUT_MS;
    this.jobSettledTimeouts = jobSettledTimeouts(options.jobSettledTimeouts);
    this.syncDefs();
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
   * Installed declarations are assembled before importing their modules. A manifest that
   * drifted against the shipped distribution remains visible as held, but none of its
   * contributions, migrations or lifecycle hooks run.
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
      readonly jobSettledTimeouts?: JobSettledTimeouts;
      readonly distribution?: ReadonlySet<string>;
      readonly referenceKindOwners?: ReadonlyMap<PluginOwnedRefKind, string>;
      readonly isolates?: IsolateDeps;
      /**
       * Where a plugin's own SQLite file lives (ADR 0034 §1): `<dataDir>/plugins/<id>/data.db`.
       * `isolates.dataDir` is the same directory, so a host that admits bundles need not
       * repeat it; absent entirely means no plugin gets a `ctx.database`.
       */
      readonly dataDir?: string;
      /**
       * First-party definitions the composition root compiled for hardened execution
       * (`compileTrustedBuilds`). Each must bind to a registered first-party def; it runs under
       * the same runner, proxy, ladder and lifecycle as a hardened installation, with no install
       * row. Empty or absent is the default in-realm distribution.
       */
      readonly trusted?: readonly TrustedBuild[];
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
    const initialize = async (): Promise<void> => {
      if (host.dataDir !== null) recoverPluginDatabases(host.dataDir, store);
      await host.loadTrusted(options.trusted ?? []);
      await host.loadInstalled();
      host.assembled = await host.reassemble();
      const migrated = await host.runPendingMigrations();
      await host.stampDeclaredVersions();
      for (const [type, element] of host.assembled.elements)
        store.claimElementTypes(element.plugin, [type]);
      if (migrated) host.assembled = await host.reassemble();
      await host.referenceService.reconcile();
    };
    if (host.dataDir === null) await initialize();
    else await withRecoveryGate(host.dataDir, initialize);
    authService.setAgentProfileValidator((harness, profile) =>
      host.validateAgentProfile(harness, profile),
    );
    authService.setAgentChangeListener((agentId, runId) => {
      events.emit("core.access", { kind: "agent", agentId }, "agent_changed", null, {});
      if (runId !== undefined)
        events.emit("core.access", { kind: "run", runId }, "run_changed", null, {});
    });
    authService.setAccessPauseChangeListener((kind, principalId, at, actorId) => {
      events.emit("core.access", { kind: "plugin", pluginId: "core.access" }, kind, actorId, {
        principalId,
        at,
      });
    });
    return host;
  }

  /**
   * TRUSTED FIRST-PARTY HARDENING (ADR 0053 §7). Each build replaces its registered first-party
   * def with the child's proxy BEFORE the first assembly, so nothing ever composes or serves the
   * in-realm module for it. The binding is re-proved here — a build this host cannot tie to a
   * registered, non-builtin first-party definition by manifest and published doors never
   * loads — and any failure fails the boot by name rather than running the plugin in-realm.
   */
  private async loadTrusted(builds: readonly TrustedBuild[]): Promise<void> {
    if (builds.length === 0) return;
    const isolates = this.isolates;
    if (isolates === null)
      throw new Error("hardened first-party plugins require the isolate runner");
    for (const build of builds) {
      const id = build.bundle.manifest.id;
      const registered = this.builtins.has(id)
        ? undefined
        : this.firstParty.find((def) => def.manifest.id === id);
      if (registered === undefined || this.trusted.has(id))
        throw new Error(`${id}: hardened build names no registered first-party plugin`);
      assertTrustedBinding(registered, build);
      this.trusted.set(id, {
        sha256: build.sha256,
        worker: workerModuleOf(build.bundle),
        registered,
        ref: {
          pluginId: id,
          manifest: registered.manifest,
          dir: extractTrustedBuild(isolates.dataDir, build),
          hardenedContract: HARDENED_CONTRACT_VERSION,
        },
      });
      await this.startTrusted(id);
    }
  }

  /**
   * Starts a trusted build's child and serves its proxy in place of the registered def — at
   * boot, and again when an assembly that held the plugin (and so retired its child, exactly as
   * it retires an installed hardened child) releases it. The child must publish the registered
   * doors every time, or it is unloaded and the start fails.
   */
  private async startTrusted(id: string): Promise<void> {
    const trusted = this.trusted.get(id);
    if (this.isolates === null || trusted === undefined) throw new Error(`${id}: no trusted build`);
    const loaded = await this.isolates.runner.load(trusted.ref);
    const def: ServerPluginDef = {
      ...loaded.def,
      lifecycle: loaded.lifecycle,
      ...(trusted.registered.elements === undefined
        ? {}
        : { elements: trusted.registered.elements }),
    };
    try {
      assertLoadedBinding(trusted.registered, def);
    } catch (error) {
      await this.isolates.runner.unload(id);
      throw error;
    }
    this.firstParty = this.firstParty.map((existing) =>
      existing.manifest.id === id ? def : existing,
    );
    this.retiredTrusted.delete(id);
    this.syncDefs();
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
          worker: null,
          styles: null,
          compatibility: null,
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
        worker: workerModuleOf(verdict.bundle),
        styles: stylesheetOf(verdict.bundle),
        compatibility: pluginBuildCompatibility(verdict.bundle),
      });
      this.installedDefs.set(row.pluginId, this.dormantDef(row, verdict.bundle));
      this.heldUnloaded.add(row.pluginId);
    }
    this.syncDefs();
    // Admission from inert declarations precedes importing code or starting children.
    this.assembled = await this.reassemble(true);
    for (const id of this.assembled.order) {
      const installed = this.installed.get(id);
      if (installed === undefined || installed.bundle === null) continue;
      if (
        this.assembled.roster.some((entry) => entry.manifest.id === id && entry.held !== undefined)
      ) {
        continue;
      }
      const row = installed.row;
      if (row.hardened !== true && !this.assembled.enabled(id)) {
        this.heldUnloaded.delete(id);
        continue;
      }
      await this.loadInstalledDefinition(installed);
      this.heldUnloaded.delete(id);
      this.syncDefs();
      this.assembled = await this.reassemble(true);
    }
    this.syncDefs();
    this.isolates.runner.onState((pluginId) => {
      this.onIsolateState(pluginId);
    });
  }

  /** Rehydrate one verified installation; module failures retain the existing unavailable row. */
  private async loadInstalledDefinition(installed: InstalledPlugin): Promise<void> {
    if (this.isolates === null || installed.bundle === null) return;
    const { row, bundle } = installed;
    try {
      this.installedDefs.set(
        row.pluginId,
        await this.loadBundle(
          bundle,
          installLayout(this.isolates.dataDir, row.pluginId, row.sha256).dir,
          row.hardened === true,
        ),
      );
    } catch (error) {
      this.installedDefs.set(row.pluginId, {
        manifest: bundle.manifest,
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

  /** Keeps the roster's doors without retaining any executable code while disabled. */
  private dormantDef(row: PluginInstallRow, bundle: PluginBundle): ServerPluginDef {
    return {
      manifest: bundle.manifest,
      actions: row.actions.map((action) => localActionDef(row.pluginId, action)),
      handlers: {},
    };
  }

  /** A plain module import by default; only the installer's consent selects a child. */
  private async loadBundle(
    bundle: PluginBundle,
    dir: string,
    hardened: boolean,
  ): Promise<ServerPluginDef> {
    if (this.isolates === null) throw new Error("this host admits no bundles");
    if (
      bundle.hardenedContract === undefined ||
      !HARDENED_CONTRACT_COMPAT_VERSIONS.has(bundle.hardenedContract)
    )
      throw new IsolateLoadError(
        `${bundle.manifest.id}: repack_required; repack with plugin-kit hardened contract ${String(HARDENED_CONTRACT_MINIMUM)} or a newer accepted contract`,
      );
    if (hardened && unportableHardenedWeb(bundle))
      throw new IsolateLoadError(
        `${bundle.manifest.id}: its hardened contract ${String(bundle.hardenedContract)} web half declares no portable Worker entry; repack with entry.worker or install in-realm`,
      );
    if (bundle.manifest.entry.server !== true) {
      return { manifest: bundle.manifest, actions: [], handlers: {} };
    }
    if (!hardened) {
      const source = bundle.files[PLUGIN_BUNDLE_SERVER_FILE];
      if (source === undefined) throw new IsolateLoadError("bundle has no server module");
      const url = URL.createObjectURL(
        new Blob([Buffer.from(source, "base64")], {
          type: "text/javascript",
        }),
      );
      try {
        // Runtime-selected pinned bytes; Blob identity forces a fresh module on each enable.
        const { default: def } = await import(url);
        if (
          def === null ||
          typeof def !== "object" ||
          !Array.isArray(def.actions) ||
          def.handlers === null ||
          typeof def.handlers !== "object"
        ) {
          throw new Error("server module must default-export a ServerPluginDef");
        }
        const migrations: readonly GuestMigration[] = def.migrations ?? [];
        const declarations = GuestMigrationDeclarationsSchema.parse({
          dataVersion: bundle.manifest.dataVersion,
          migrations: migrations.map(({ name, to }) => ({ name, to })),
        });
        const adapted = declarations.migrations.map((metadata, index): PluginMigration => {
          const migration = migrations[index];
          if (migration === undefined || typeof migration.migrate !== "function")
            throw new Error(`migration "${metadata.name}" has no callback`);
          const invoke = migration.migrate.bind(migration);
          return {
            ...metadata,
            migrate: (storage, database) =>
              invoke(
                {
                  pluginId: storage.pluginId,
                  get: async (key) => {
                    assertStorageKey(key);
                    return storage.get(key);
                  },
                  set: storage.set,
                  compareAndSet: storage.compareAndSet,
                  delete: storage.delete,
                  keys: storage.keys,
                },
                database,
              ),
          };
        });
        return { ...def, manifest: bundle.manifest, migrations: adapted };
      } catch (error) {
        throw new IsolateLoadError(error instanceof Error ? error.message : "server import failed");
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const loaded = await this.isolates.runner.load({
      pluginId: bundle.manifest.id,
      manifest: bundle.manifest,
      dir,
      hardenedContract: bundle.hardenedContract,
    });
    return { ...loaded.def, lifecycle: loaded.lifecycle };
  }

  /** Rebuilds the live def list and the handler index after an install lands or leaves. */
  private syncDefs(): void {
    this.defs = [...this.firstParty, ...this.installedDefs.values()];
    this.handlers.clear();
    this.byteDefinitions.clear();
    this.guestInputPlugins.clear();
    for (const def of this.defs) {
      this.handlers.set(def.manifest.id, def.handlers);
      if ((def.manifest.contributes.byteCarriers?.length ?? 0) > 0)
        this.byteDefinitions.set(def.manifest.id, def);
      if (def.inputValidation === "guest") this.guestInputPlugins.add(def.manifest.id);
    }
  }

  /**
   * THE RUNNER'S STATE, MIRRORED ONTO THE ROSTER (ADR 0016 §6): a child being spawned or one
   * that crashed past its budget is a lifecycle every principal reads, not a log line. A run
   * state that maps to no lifecycle clears only an isolate state — a hook's own
   * `enable_failed` is a different report and stands until the next transition.
   */
  private reconcileIsolateState(pluginId: string): boolean {
    const installed = this.installed.get(pluginId);
    if (
      this.isolates === null ||
      (!this.trusted.has(pluginId) &&
        (installed?.row.hardened !== true || installed.bundle?.manifest.entry.server !== true))
    )
      return false;
    // Notifications can belong to a retired child. Only the runner's current child for
    // this verified installation owns a roster state; in-realm modules and failed repairs do not.
    const state = this.isolates.runner.state(pluginId);
    const lifecycle = isolateLifecycleState(state);
    const current = this.lifecycleStates.get(pluginId);
    if (lifecycle === current) return false;
    if (lifecycle !== undefined) {
      this.lifecycleStates.set(pluginId, lifecycle);
    } else {
      if (current !== "isolate_starting" && current !== "isolate_crashed") return false;
      this.lifecycleStates.delete(pluginId);
    }
    return true;
  }

  private onIsolateState(pluginId: string): void {
    // A candidate child is not the published installation. Leaving replacement reconciles
    // the surviving child, including terminal transitions that arrive during admission.
    if (this.replacing.has(pluginId) || !this.reconcileIsolateState(pluginId)) return;
    this.changeAssembly(async () => {
      this.assembled = await this.reassemble();
      this.publish();
    }).catch((error: unknown) => {
      this.logger.error("plugin_lifecycle", {
        plugin: pluginId,
        hook: "state",
        error: error instanceof Error ? error.message : "reassembly failed",
      });
    });
  }

  /**
   * Executable-contract holds, asked before any module loads: an SDK contract this build no
   * longer accepts, or recorded build metadata KNOWN to disagree with this server's protocol or
   * shared React. Unknown legacy metadata is a visible warning on the roster, never a hold.
   * `except` names candidates whose old bytes are being replaced and so owe nothing.
   */
  private bundleProblems(except?: ReadonlySet<string>): AssemblyProblem[] {
    const problems: AssemblyProblem[] = [];
    for (const [id, { bundle, compatibility }] of this.installed) {
      if (
        except?.has(id) !== true &&
        bundle !== null &&
        (bundle.hardenedContract === undefined ||
          !HARDENED_CONTRACT_COMPAT_VERSIONS.has(bundle.hardenedContract) ||
          compatibility?.status === "incompatible")
      )
        problems.push({
          reason: "repack_required",
          plugins: [id],
          minimum: HARDENED_CONTRACT_MINIMUM,
        });
    }
    return problems;
  }

  /** One composition over the store's current enablement and the facts `env` reads fresh. */
  private async reassemble(declarationsOnly = false): Promise<Assembly> {
    this.store.initializePluginEnablement(this.defs.map((def) => def.manifest));
    const env = await this.env();
    const dataState = new Map(env.dataState);
    // A dormant declaration has no migration code yet. Check its stored data after loading.
    for (const id of this.heldUnloaded) dataState.delete(id);
    const assembly = assembleRoster(this.defs, this.store.disabledPlugins(), {
      ...env,
      dataState,
      problemPolicy: "hold",
      problems: [...this.bundleProblems(), ...this.harnessProblems(this.defs)],
    });
    if (!declarationsOnly) {
      for (const id of assembly.order) {
        if (!assembly.enabled(id) || !this.heldUnloaded.has(id)) continue;
        const installed = this.installed.get(id);
        if (installed === undefined) continue;
        await this.loadInstalledDefinition(installed);
        this.heldUnloaded.delete(id);
        this.syncDefs();
        return this.reassemble();
      }
      /*
        A trusted build an earlier hold retired starts again once no hold names it — enabled or
        not, as at boot, so a disabled plugin's cleanup doors keep a child to answer them. A
        start that fails leaves the proxy refusing `unavailable` and the roster `enable_failed`
        until the next process start, never the in-realm module.
      */
      for (const id of this.retiredTrusted) {
        if (assembly.roster.some((entry) => entry.manifest.id === id && entry.held !== undefined))
          continue;
        try {
          await this.startTrusted(id);
        } catch (error) {
          this.retiredTrusted.delete(id);
          this.lifecycleStates.set(id, "enable_failed");
          this.logger.error("plugin_lifecycle", {
            plugin: id,
            hook: "load",
            error: error instanceof Error ? error.message : "load failed",
          });
          continue;
        }
        return this.reassemble();
      }
    }
    this.jobs?.setHeldPlugins(
      assembly.roster.filter((entry) => entry.held !== undefined).map((entry) => entry.manifest.id),
    );
    for (const entry of assembly.roster) {
      if (entry.held === undefined) continue;
      const id = entry.manifest.id;
      this.handlers.delete(id);
      this.guestInputPlugins.delete(id);
      this.retireDatabase(id);
      if (this.installed.get(id)?.row.hardened === true) await this.isolates?.runner.unload(id);
      else if (this.trusted.has(id) && !this.retiredTrusted.has(id)) {
        this.retiredTrusted.add(id);
        await this.isolates?.runner.unload(id);
      }
    }
    for (const entry of assembly.roster) {
      if (entry.held !== undefined) continue;
      this.store.claimReferenceKinds(
        entry.manifest.id,
        (entry.manifest.contributes.references ?? []).map((declaration) => declaration.kind),
      );
    }
    return assembly;
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
        hardened: entry.row.hardened === true,
        ...(entry.row.builtAgainst === undefined ? {} : { builtAgainst: entry.row.builtAgainst }),
        ...(entry.row.mode === "unpacked" ? { mode: "unpacked" as const } : {}),
        ...(entry.refusal === undefined ? {} : { refusal: entry.refusal }),
      });
    }
    return {
      builtins: this.builtins,
      ...(this.distribution === undefined ? {} : { distribution: this.distribution }),
      elementOwners: this.store.elementOwners(),
      referenceKindOwners: this.store.referenceKindOwners(),
      dataState,
      lifecycle: this.lifecycleStates,
      attribution: this.store.pluginAttribution(),
      installs,
      developerMode: this.store.developerMode(),
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

  /** Request-scoped durable authority; settlement, timeout, retirement and shutdown revoke it. */
  private dataLease(
    pluginId: string,
    storage: PluginStorage = this.storage(pluginId),
    database: PluginDatabase | null = this.databaseSlice(pluginId) ?? null,
    maxCalls = Number.POSITIVE_INFINITY,
    assertCurrent?: () => void,
  ): PluginDataLease {
    let open = true;
    let calls = 0;
    const check = (): void => {
      if (++calls > maxCalls) throw new Error("plugin data request budget exhausted");
      if (!open || this.closed) throw new Error("plugin data request is closed");
      assertCurrent?.();
    };
    const live = database !== null && this.databases.get(pluginId) === database;
    const checkDatabase = (): void => {
      if (++calls > maxCalls) throw new PluginDatabaseError("plugin data request budget exhausted");
      if (!open || this.closed) throw new PluginDatabaseError("plugin database request is closed");
      if (live && this.databases.get(pluginId) !== database)
        throw new PluginDatabaseError("plugin database request belongs to a retired handle");
      assertCurrent?.();
    };
    return {
      check,
      close: () => {
        open = false;
      },
      ...(database === null
        ? {}
        : {
            database: {
              pluginId,
              admitRecovery: async () => {
                checkDatabase();
                return database.admitRecovery();
              },
              query: async <Row extends SqlRow>(sql: string, params?: readonly SqlParam[]) => {
                checkDatabase();
                return database.query<Row>(sql, params);
              },
              run: async (sql: string, params?: readonly SqlParam[]) => {
                checkDatabase();
                return database.run(sql, params);
              },
              batch: async (statements: readonly SqlStatement[]) => {
                checkDatabase();
                return database.batch(statements);
              },
            },
          }),
      storage: {
        pluginId,
        get: async (key) => {
          check();
          return storage.get(key);
        },
        set: async (key, value) => {
          check();
          await storage.set(key, value);
        },
        compareAndSet: async (key, expected, value) => {
          check();
          return storage.compareAndSet(key, expected, value);
        },
        delete: async (key) => {
          check();
          await storage.delete(key);
        },
        keys: async (prefix) => {
          check();
          return storage.keys(prefix);
        },
        dataVersion: async () => {
          check();
          return storage.dataVersion();
        },
        appliedMigrations: async () => {
          check();
          return storage.appliedMigrations();
        },
      },
    };
  }

  /**
   * Resolves once every dispatch already in flight has settled, across all plugins — the
   * quiesce step of a graceful stop (#318), so a handler that started before admission closed
   * commits before the writer seals. The caller bounds the wait: a dispatch that outlives it
   * meets a sealed database and fails instead of committing behind the successor.
   */
  async settleDispatches(): Promise<void> {
    await Promise.all([...this.activeDispatches.values()].flatMap((pending) => [...pending]));
  }

  private async drainDispatches(pluginId: string): Promise<void> {
    const pending = this.activeDispatches.get(pluginId);
    if (pending === undefined || pending.size === 0) return;
    const outcome = await runHook(async () => {
      await Promise.all(pending);
    }, ISOLATE_MIGRATION_DEADLINE_MS);
    if (!outcome.ok)
      throw new InstallRefusal(
        "artifact_invalid",
        `plugin "${pluginId}" has active dispatches: ${outcome.reason}`,
      );
  }

  /**
   * ONE FILE PER PLUGIN, opened lazily and kept (ADR 0034 §1). Null when this host has no
   * data directory — a unit fixture — because a path is the whole of what makes the file this
   * plugin's and nobody else's, and inventing one under the process's cwd would put a
   * workspace's rows somewhere no backup looks.
   *
   * The handle exists whether or not the manifest DECLARES a database: the purge verb and the
   * uninstall guard have to answer for a file a plugin wrote before its manifest stopped
   * asking for one, and opening is lazy, so a plugin that never touches SQL never creates a
   * file. What the declaration decides is whether `ctx.database` is handed out, which is
   * `slice(...)` below.
   */
  private database(pluginId: string): PluginDatabaseAdmin | null {
    if (this.dataDir === null) return null;
    // A closed host never reopens or recovers a file: its successor may already own it.
    if (this.closed) throw new PluginDatabaseError("the plugin host is closed");
    const existing = this.databases.get(pluginId);
    if (existing !== undefined) return existing;
    const journal = this.store.pluginDatabaseJournal(pluginId);
    if (journal !== null) recoverPluginDatabase(this.dataDir, this.store, journal);
    const declared = this.defs.find((def) => def.manifest.id === pluginId)?.manifest.database;
    const recoveryBudget = new RecoveryBudget(this.dataDir, this.store.db);
    const allocated = recoveryBudget.allocation(pluginId);
    const recovery =
      declared?.recovery ??
      (allocated === null ? undefined : { profile: "bounded-wal-v1" as const });
    const created = openPluginDatabase({
      dataDir: this.dataDir,
      pluginId,
      ...((declared?.maxBytes ?? allocated) == null
        ? {}
        : { maxBytes: declared?.maxBytes ?? allocated! }),
      ...(recovery === undefined ? {} : { recovery }),
      recoveryBudget,
      now: () => this.runtime.now(),
    });
    this.databases.set(pluginId, created);
    return created;
  }

  private revokeSettlements(pluginId: string): void {
    this.settlementEpochs.set(pluginId, (this.settlementEpochs.get(pluginId) ?? 0) + 1);
  }

  private retireDatabase(pluginId: string): void {
    this.revokeSettlements(pluginId);
    const pending = this.byteRequests.get(pluginId);
    if (pending !== undefined) for (const cancel of pending) cancel();
    const database = this.databases.get(pluginId);
    this.databases.delete(pluginId);
    database?.close();
  }

  /**
   * The database slice a CONTEXT carries: present exactly when the manifest declared one
   * (ADR 0034 §6), so a plugin that asked for no file cannot reach one by accident and the
   * proxy answers `slice_unavailable` for the same reason on the other side of the boundary.
   */
  private databaseSlice(pluginId: string): PluginDatabase | undefined {
    const declared = this.defs.find((def) => def.manifest.id === pluginId)?.manifest.database;
    if (declared === undefined) return undefined;
    return this.database(pluginId) ?? undefined;
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
   * Stage the entire chain, including the native ledger/version, on private plugin storage.
   * No data is published on failure, timeout, shutdown or process loss; late work sees a
   * closed handle.
   *
   * Publication is PHASED so several chains can land as one installation (#238): `activate`
   * swaps every private database image in under a durable prepared journal BEFORE the caller's
   * one SQL transaction, `commitMetadata` runs INSIDE it (KV, ledger, the caller's rows, the
   * image's committed marker), `finish` removes the old backup only after that transaction
   * committed, and `discard` recovers the prepared image and drops the draft on any failure.
   * `commit` is the single-session convenience of the same phases for enable and boot. It is
   * never itself wrapped in an outer transaction: its `finish` would delete the old image
   * before the outer commit was durable.
   *
   * Managed SQLite files activate under prepared recovery journals. Their committed markers
   * join the metadata transaction; old images are released only after its durable commit.
   */
  private async prepareMigrations(
    pluginId: string,
    migrations: readonly PluginMigration[],
    manifest = this.defs.find((def) => def.manifest.id === pluginId)?.manifest,
  ): Promise<StagedMigration> {
    this.assertOpen();
    // Revoke the live admin before snapshotting, including when the candidate removed its
    // declaration. A replacement's page budget must never come from the installed def.
    this.retireDatabase(pluginId);
    const staged = this.store.beginPluginMigration(pluginId, migrations.length > 0);
    const admin = staged.storage;
    let image: PluginDatabaseStage | undefined;
    let closeActiveLease = (): void => {};
    // Once only: shutdown may discard first, and a later discard must not remove, by path, a
    // stage image the next host has created since.
    const discard = (): void => {
      if (!this.stagedMigrations.delete(discard)) return;
      staged.discard();
      image?.discard();
    };
    this.stagedMigrations.add(discard);
    try {
      if (this.dataDir !== null && manifest?.database !== undefined) {
        const recoveryBudget = new RecoveryBudget(this.dataDir, this.store.db);
        const allocated = recoveryBudget.allocation(pluginId);
        const maxBytes = manifest.database.maxBytes ?? allocated;
        const options = {
          dataDir: this.dataDir,
          pluginId,
          ...(maxBytes === null ? {} : { maxBytes }),
          ...(manifest.database.recovery === undefined
            ? allocated === null
              ? {}
              : { recovery: { profile: "bounded-wal-v1" as const } }
            : { recovery: manifest.database.recovery }),
          recoveryBudget,
          now: () => this.runtime.now(),
        };
        if (migrations.length > 0) {
          image = stagePluginDatabase(options, this.store);
        } else {
          // A replacement's smaller cap is part of admission even when no data migration is
          // owing. Read the existing image under that cap without creating a fresh lazy file.
          const candidate = openPluginDatabase(options);
          try {
            await candidate.pageCount();
          } finally {
            candidate.close();
          }
        }
      }
      const outcome = await runHook(async () => {
        for (const migration of migrations) {
          // A callback's handles expire before the next migration starts. Explicit database
          // absence must not default to the installed manifest's live file.
          const lease = this.dataLease(pluginId, admin, image?.database ?? null);
          closeActiveLease = lease.close;
          try {
            await migration.migrate(lease.storage, lease.database);
          } finally {
            lease.close();
            if (closeActiveLease === lease.close) closeActiveLease = (): void => {};
          }
          await admin.recordMigration(migration.name, this.runtime.now());
        }
        if (manifest?.dataVersion !== undefined) await admin.stampDataVersion(manifest.dataVersion);
      }, ISOLATE_MIGRATION_DEADLINE_MS);
      // `runHook` cannot cancel an in-realm promise. Expire its authority when the engine
      // stops waiting, rather than when that promise eventually settles.
      closeActiveLease();
      if (!outcome.ok) throw new Error(`plugin migration failed: ${outcome.reason}`);
      // Every phase finds the chain still registered: shutdown discards what is staged, and a
      // discarded chain can never be published. Registration ends only at the final outcome.
      const activate = (): void => {
        if (!this.stagedMigrations.has(discard))
          throw new Error("plugin migration was discarded before it committed");
        image?.activate();
      };
      const commitMetadata = (publish?: () => void): void => {
        if (!this.stagedMigrations.has(discard))
          throw new Error("plugin migration was discarded before it committed");
        staged.commit(() => {
          publish?.();
          image?.committed();
        });
      };
      const finish = (): void => {
        if (!this.stagedMigrations.delete(discard)) return;
        // Metadata is committed: cleanup may be retried, but never roll it back. A failed
        // cleanup keeps the journal, and database() must recover it before admitting SQL.
        try {
          image?.finish();
        } catch (error) {
          this.logger.error("plugin_database_recovery", {
            plugin: pluginId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };
      return {
        activate,
        commitMetadata,
        finish,
        discard,
        commit: (publish) => {
          try {
            activate();
            commitMetadata(publish);
          } catch (error) {
            discard();
            throw error;
          }
          finish();
        },
      };
    } catch (error) {
      closeActiveLease();
      discard();
      throw error;
    }
  }

  private async applyMigrations(
    pluginId: string,
    migrations: readonly PluginMigration[],
    manifest = this.defs.find((def) => def.manifest.id === pluginId)?.manifest,
  ): Promise<boolean> {
    if (migrations.length === 0) return false;
    const staged = await this.prepareMigrations(pluginId, migrations, manifest);
    staged.commit(() => {
      const types = manifest?.contributes.elements.map((element) => element.type) ?? [];
      if (types.length > 0) this.store.claimElementTypes(pluginId, types);
    });
    for (const migration of migrations)
      this.logger.info("plugin_migration", { plugin: pluginId, migration: migration.name });
    return true;
  }

  assembly(): Assembly {
    return this.assembled;
  }

  /**
   * The roster every reader is answered: the assembly's, with the coordinator's observations
   * and each row's EFFECTIVE execution. `hardened: true` means this host runs the plugin's
   * server half in the supervisor and serves its browser half for a Worker, whether the
   * installer chose that (`install.hardened`, which stays the persisted choice) or the operator
   * selected a trusted first-party build. Absent is in-realm.
   */
  roster(): PluginRoster {
    const roster = this.updates?.roster(this.assembled.roster) ?? this.assembled.roster;
    return roster.map((entry) =>
      this.trusted.has(entry.manifest.id) ||
      this.installed.get(entry.manifest.id)?.row.hardened === true
        ? { ...entry, hardened: true }
        : entry,
    );
  }

  /** Serialize installed hashes and configured intent with installation and enablement changes. */
  async listInstalled(): Promise<InstalledPluginStates> {
    return this.changeAssembly(async () => listInstalledPlugins(this.store));
  }

  /** Serialize with install/uninstall so rows and their exact bytes describe one inventory. */
  async exportInstalled(): Promise<InstalledPluginsSnapshot> {
    return this.changeAssembly(async () => exportInstalledPlugins(this.store, this.dataDir));
  }

  /** The workspace's developer-mode switch (ADR 0025 §4), published beside every roster. */
  developerMode(): boolean {
    return this.store.developerMode();
  }

  /**
   * Registers a roster listener and returns its removal, mirroring `AuthService.onRevoked`.
   * The listener hears the developer-mode switch with every roster, because the two ride one
   * frame: a flip republishes the roster (its `developer_mode_off` marks moved) and nothing
   * else, so there is exactly one "the plugins changed" signal (docs/CONTRACTS.md §One authoritative implementation).
   */
  onRosterChange(listener: (roster: PluginRoster, developerMode: boolean) => void): () => void {
    this.rosterListeners.add(listener);
    return () => {
      this.rosterListeners.delete(listener);
    };
  }

  /**
   * THE WATCH on `<data>/authored/` (ADR 0025 §4): started by the composition root once the
   * socket is bound, so a rebuild found at start never delays the first request. Returns the
   * stop; a host that admits no bundles has nothing to watch and returns a no-op.
   */
  watchAuthored(): () => void {
    return this.authored?.watch() ?? (() => {});
  }

  /**
   * THE RELEASE POLL (#238), started by the composition root beside `watchAuthored`: hourly,
   * sequential observations the roster carries, never an install. Returns the stop; a host
   * that admits no bundles has nothing to poll and returns a no-op.
   */
  watchUpdates(): () => void {
    return this.updates?.startPolling() ?? (() => {});
  }

  private async changeAssembly<T>(change: () => Promise<T>): Promise<T> {
    const preceding = this.assemblyChange;
    let release!: () => void;
    this.assemblyChange = new Promise<void>((resolve) => {
      release = resolve;
    });
    await preceding;
    try {
      // Queued behind a shutdown, a change never starts; outliving one, it never answers.
      this.assertOpen();
      const result =
        this.dataDir === null ? await change() : await withRecoveryGate(this.dataDir, change);
      this.assertOpen();
      return result;
    } finally {
      release();
    }
  }

  /**
   * Asked by every assembly commit point after its last await (#318). Once closed, the rows,
   * switches, files and roster a change would touch are the successor's.
   */
  private assertOpen(): void {
    if (this.closed) throw new Error("the plugin host is closed");
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
    return this.changeAssembly(async () => {
      if (!enabled || this.assembled.enabled(id) || this.assembled.builtin(id))
        return this.setEnabledNow(id, enabled, changedBy);
      this.replacing.add(id);
      this.revokeSettlements(id);
      try {
        await this.drainDispatches(id);
        // The enable re-extracts the installed bundle into a directory a successor may own.
        this.assertOpen();
        return await this.setEnabledNow(id, enabled, changedBy);
      } catch (error) {
        if (error instanceof InstallRefusal || error instanceof PluginDatabaseError)
          return { refused: error.message };
        throw error;
      } finally {
        this.replacing.delete(id);
      }
    });
  }

  private async setEnabledNow(
    id: string,
    enabled: boolean,
    changedBy: string,
  ): Promise<ActionRefused | { ok: true }> {
    const entry = this.assembled.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (entry.held !== undefined && enabled) return { refused: entry.held.reason };
    if (this.assembled.builtin(id)) return refused("builtin", [id]);
    if (
      entry.enabled === enabled &&
      (entry.held === undefined || this.store.disabledPlugins().has(id))
    )
      return { ok: true };

    if (!enabled) {
      if (entry.manifest.essential === true) return refused("essential");
      const stranded = this.assembled.requiredBy(id);
      if (stranded.length > 0) return refused("missing_dependency", stranded);
    } else {
      const missing = this.assembled.unmet(id);
      if (missing.length > 0) return refused("dependency_disabled", missing);
      const clashes = this.assembled.conflicts(id);
      if (clashes.length > 0) return refused("incompatible_dependency", clashes);
      const installed = this.installed.get(id);
      // The directory is admitted only behind the switch (ADR 0025 §4): off, by name.
      if (installed?.row.mode === "unpacked" && !this.store.developerMode()) {
        return refused("developer_mode_off", [id]);
      }
      if (installed !== undefined && installed.row.hardened !== true) {
        const verdict = verifyInstalledBundle(installed.row);
        // The sheet's rule is the toggle's own class (ADR 0025 §7): an author reads a selector.
        if (!verdict.ok && verdict.refusal === "stylesheet_unscoped") {
          return refused("stylesheet_unscoped", [verdict.detail]);
        }
        if (!verdict.ok) return installRefused(verdict.refusal, verdict.detail);
        try {
          this.installedDefs.set(id, await this.loadBundle(verdict.bundle, verdict.dir, false));
          this.heldUnloaded.delete(id);
          this.syncDefs();
        } catch (error) {
          if (error instanceof IsolateLoadError)
            return installRefused("artifact_invalid", error.message);
          throw error;
        }
      }
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
      if (plan.kind === "refused") {
        if (
          installed !== undefined &&
          installed.row.hardened !== true &&
          installed.bundle !== null
        ) {
          this.installedDefs.set(id, this.dormantDef(installed.row, installed.bundle));
          this.syncDefs();
        }
        return { refused: `${plan.reason}: ${plan.detail}` };
      }
      // The staged no-op path still checks a retained file against the candidate page budget.
      if (plan.kind === "migrate") {
        await this.applyMigrations(id, plan.run);
      } else {
        const staged = await this.prepareMigrations(id, [], entry.manifest);
        staged.commit();
      }
    }

    this.assertOpen();
    const wasEnabled = new Set(
      this.assembled.roster.filter((row) => row.enabled).map((row) => row.manifest.id),
    );
    this.store.setPluginEnabled(id, enabled, changedBy, this.runtime.now());
    if (!enabled) this.revokeSettlements(id);
    this.installationGenerations.delete(id);
    if (!enabled) this.referenceService.abortOwnerPreparations(id);
    if (!enabled) this.jobs?.disablePlugin(id);
    // COMMIT FIRST, then tell people. A lifecycle hook has no vote (ADR 0013 §2): the roster
    // every client will render is already the truth by the time any plugin hears about it.
    this.assembled = await this.reassemble();
    if (enabled) await this.referenceService.reconcile();
    if (enabled) await this.jobs?.nativeTransfers.reconcile();
    this.streams.reconcile();
    const delta: AssemblyDelta = {
      enabled: this.assembled.order.filter(
        (row) => this.assembled.enabled(row) && !wasEnabled.has(row),
      ),
      disabled: this.assembled.order.filter(
        (row) => !this.assembled.enabled(row) && wasEnabled.has(row),
      ),
    };
    await this.fanOut(delta, wasEnabled);
    /*
      A DISABLE RETAINS AND RELEASES: the file stays exactly as the plugin left it (the
      residual mechanism is `retain`), and the engine's handle onto it does not — after
      `onDisable` has had its turn, so a hook may still write its parting row. The next enable
      opens the same file again, which is what makes "re-enabling restores it in place" true of
      rows as well as keys.
    */
    if (!enabled) this.retireDatabase(id);
    const installed = this.installed.get(id);
    if (
      !enabled &&
      installed !== undefined &&
      installed.row.hardened !== true &&
      installed.bundle !== null
    ) {
      this.installedDefs.set(id, this.dormantDef(installed.row, installed.bundle));
      this.syncDefs();
      this.assembled = await this.reassemble();
    }
    this.publish();
    /*
      THE COMMIT POINT, announced. Not staged like a handler's emission: this method IS the
      commit, it has already returned every refusal it can, and it is reached both through
      `core.plugins.setEnabled` and directly by an embedder — so the emission belongs to the
      transition rather than to one of its callers (docs/CONTRACTS.md §One authoritative implementation: one door onto "the roster
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
   * What goes: its storage namespace (rows, data-version stamp, migration ledger), its own
   * SQLite file with its journal, and its element-type reservations. What does not: documents.
   * A canvas's `draw` elements are the workspace's data, not the plugin's, and they keep
   * rendering as named placeholders — the purge released the reservation, so a replacement may
   * now claim the type deliberately.
   */
  async purge(
    id: string,
    purgedBy: string,
    traceId: number | null = null,
  ): Promise<ActionRefused | PluginPurgeResult> {
    return this.changeAssembly(() => this.purgeNow(id, purgedBy, traceId));
  }

  private async purgeNow(
    id: string,
    purgedBy: string,
    traceId: number | null = null,
  ): Promise<ActionRefused | PluginPurgeResult> {
    const entry = this.assembled.roster.find((candidate) => candidate.manifest.id === id);
    if (entry === undefined) return refused("unknown_plugin", [id]);
    if (this.assembled.builtin(id)) return refused("builtin", [id]);
    if (entry.enabled) return refused("still_enabled", [id]);
    try {
      this.jobs?.purgePlugin(id);
    } catch (error) {
      if (
        error instanceof ServiceError &&
        (error.message === "outcome_unknown" || error.message === "active_native_transfers")
      )
        return { refused: error.message };
      if (error instanceof ServiceError) return { refused: `${error.code}: job purge refused` };
      throw error;
    }
    this.streams.reconcile();
    this.installationGenerations.delete(id);
    // Remove host visibility and only provenance-owned grants before any owner bytes disappear.
    this.referenceService.purge(id, purgedBy, traceId);

    const def = this.defs.find((candidate) => candidate.manifest.id === id);
    const onPurge = entry.held === undefined ? def?.lifecycle?.onPurge : undefined;
    if (onPurge !== undefined) {
      const outcome = await this.runLifecycle(id, onPurge);
      if (!outcome.ok) {
        this.logger.error("plugin_lifecycle", {
          plugin: id,
          hook: "onPurge",
          error: outcome.reason,
        });
      }
    }
    this.assertOpen();

    const storage = this.storage(id);
    const removedRows = await storage.clear();
    /*
      The file goes the way the rows do, and by the same verb (ADR 0034 §5): `clear` closes
      the handle first — an open SQLite connection to a deleted file is a handle onto nothing
      — then deletes `data.db` with its `-wal` and `-shm`, and reports the bytes that went.
      The cache entry goes with it, so the next open of this id starts from no file at all.
    */
    const removedBytes = (await this.database(id)?.clear()) ?? 0;
    this.referenceService.purged(id);
    this.databases.delete(id);
    const releasedTypes = this.store.releaseElementTypes(id);
    this.logger.info("plugin_purge", {
      plugin: id,
      principal: purgedBy,
      rows: removedRows,
      databaseBytes: removedBytes,
      types: releasedTypes,
    });
    // Same commit point, same ledger node, same reason as the enablement pair above.
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      "plugin_purged",
      purgedBy,
      { plugin: id, rows: removedRows, databaseBytes: removedBytes, types: releasedTypes },
    );
    return {
      id,
      removed: {
        storage: removedRows,
        elements: entry.manifest.contributes.elements.length,
        ownership: releasedTypes,
      },
      databaseBytes: removedBytes,
    };
  }

  private nativeReplacementRefusal(manifest: ServerPluginDef["manifest"]): InstallRefusal | null {
    if (this.jobs === null) return null;
    const candidate = canonicalJobJson(manifest.machine ?? null);
    const incompatible = this.jobs.jobs
      .installations()
      .some(
        (installation) =>
          installation.pluginId === manifest.id &&
          installation.enabled &&
          canonicalJobJson(installation.machine) !== candidate,
      );
    return incompatible
      ? new InstallRefusal(
          "still_enabled",
          `"${manifest.id}" has an enabled native installation with a different declaration; ` +
            "the existing runtime is unchanged. Plan an explicit disable and native review before replacing it",
        )
      : null;
  }

  /**
   * The install and replacement door. Artifact integrity, assembly and data compatibility
   * are preflighted before committing an installation. A replacement preserves the durable
   * enablement switch, including an intentionally disabled row, and never toggles dependents.
   *
   * Enabled modules use the same lifecycle as an authored edit: old onDisable, new onEnable.
   * These are module notifications, NOT an operator disable of native authority. Unchanged
   * machine declarations retain the exact installations, consents and running service jobs;
   * a changed declaration refuses before retirement while a native installation is enabled.
   *
   * A failed candidate restores the old module or boot-unverified placeholder, reloading only
   * a prior hardened child. Migrations and their ledger commit with the install row or roll
   * back together. Lifecycle hooks retain their no-veto contract: failures are roster-visible.
   * The door is a one-member `installGroup`, the same installer a reviewed family update uses.
   */
  async install(
    request: PluginInstallRequest,
    installedBy: string,
    installer: CredentialReference | null,
    unpacked?: { readonly id: string },
  ): Promise<ActionRefused | PluginInstallResult> {
    return this.changeAssembly(async () => {
      const isolates = this.isolates;
      if (isolates === null) {
        return installRefused("artifact_unreadable", "this server admits no bundles");
      }
      if (unpacked !== undefined && !this.store.developerMode())
        return refused("developer_mode_off", [unpacked.id]);
      let artifact: VerifiedPluginArtifact;
      try {
        artifact = await inspectArtifact({
          source: request.source,
          sha256: request.sha256.toLowerCase(),
          dataDir: isolates.dataDir,
          signal: this.lifetime.signal,
          ...(isolates.devPaths === undefined ? {} : { devPaths: isolates.devPaths }),
          admit: (bundle) => this.admissionRefusal(bundle, request.replace === true, unpacked),
        });
      } catch (error) {
        if (error instanceof InstallRefusal) return { refused: error.message };
        throw error;
      }
      const outcome = await this.installGroup(
        [
          {
            artifact,
            grantedCaps: grantFor(artifact.bundle.manifest.capabilities, request.grant),
            hardened: request.hardened === true,
          },
        ],
        { installedBy, installer, ...(unpacked === undefined ? {} : { unpacked }) },
      );
      return "refused" in outcome ? outcome : outcome[0]!;
    });
  }

  /**
   * The door's own verdicts on verified bytes, asked before anything is written: a namespace
   * squat, an authored directory's id, an id already installed, an enabled native installation
   * a changed declaration would strand, and recorded build metadata KNOWN not to run on this
   * server. Unknown legacy metadata is admitted exactly as before; the roster shows it.
   */
  private admissionRefusal(
    bundle: PluginBundle,
    replace: boolean,
    unpacked?: { readonly id: string },
  ): InstallRefusal | null {
    const id = bundle.manifest.id;
    if (id.startsWith(ENGINE_NAMESPACE_PREFIX) || id.startsWith(CORE_NAMESPACE_PREFIX)) {
      return new InstallRefusal(
        "namespace_reserved",
        `"${id}" claims a namespace only this build may use`,
      );
    }
    if (unpacked !== undefined && unpacked.id !== id) {
      return new InstallRefusal(
        "artifact_invalid",
        `manifest id "${id}" is not the directory it was authored in, "${unpacked.id}"`,
      );
    }
    const existing = this.installed.get(id);
    if (existing !== undefined) {
      if (!replace) {
        return new InstallRefusal(
          "already_installed",
          `"${id}" is installed at ${existing.row.sha256}; pass replace to upgrade it`,
        );
      }
      const native = this.nativeReplacementRefusal(bundle.manifest);
      if (native !== null) return native;
    }
    const compatibility = pluginBuildCompatibility(bundle);
    if (compatibility.status !== "incompatible") return null;
    const mismatches = compatibility.issues
      .filter((issue) => issue.kind === "incompatible")
      .map(
        (issue) =>
          `${issue.component} built against ${issue.built ?? "an unrecorded version"}, this server runs ${issue.current}`,
      );
    return new InstallRefusal(
      "artifact_invalid",
      `${id}: repack_required; ${mismatches.join("; ")}`,
    );
  }

  /**
   * THE INSTALLER — one bundle or a whole family (#238), always inside the assembly mutex.
   *
   * Every member's exact verified bytes are published; every member is fenced and drained;
   * the prospective assembly is admitted with every candidate at once; every candidate is
   * loaded and every migration chain staged. Then ONE synchronous commit writes every row,
   * ledger and database marker, and ONE roster is published after the lifecycle fan-out.
   * Until that commit the assembly every reader is answered is the committed old one.
   * Any failure before it restores every member's previous module, row, data and lifecycle
   * state, and publishes that roster instead. `attribution.assertCurrent` is asked after
   * every await and immediately before the commit; its refusal is answered verbatim.
   */
  private async installGroup(
    candidates: readonly InstallCandidate[],
    attribution: InstallAttribution,
  ): Promise<ActionRefused | readonly PluginInstallResult[]> {
    const isolates = this.isolates;
    if (isolates === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    let ordered: InstallCandidate[];
    try {
      // Namespace parents and supplied required dependencies first: every load, hook and
      // commit below follows this order.
      ordered = familyOrder(
        candidates.map((candidate) => ({
          id: candidate.artifact.bundle.manifest.id,
          requiredDependencies: requiredDependencyIds(candidate.artifact.bundle.manifest),
          candidate,
        })),
      ).map(({ candidate }) => candidate);
    } catch (error) {
      if (error instanceof BundleOrderError)
        return installRefused("artifact_invalid", error.message);
      throw error;
    }
    const current = (): void => {
      try {
        attribution.assertCurrent?.();
      } catch (error) {
        throw new InstallAuthorityLost(
          error instanceof Error ? error.message : UPDATE_AUTHORITY_REFUSAL,
        );
      }
    };
    const wasEnabled = new Set(
      this.assembled.roster.filter((entry) => entry.enabled).map((entry) => entry.manifest.id),
    );
    const installedAt = this.runtime.now();
    const members: GroupMember[] = [];
    try {
      for (const candidate of ordered) {
        const { bundle } = candidate.artifact;
        const id = bundle.manifest.id;
        const previous = this.installed.get(id);
        const artifact = publishArtifact(
          candidate.artifact,
          isolates.dataDir,
          this.lifetime.signal,
        );
        members.push({
          id,
          bundle,
          artifact,
          web: webModuleOf(bundle),
          worker: workerModuleOf(bundle),
          styles: stylesheetOf(bundle),
          compatibility: pluginBuildCompatibility(bundle),
          previous,
          previousDef: this.installedDefs.get(id),
          previousLifecycle: this.lifecycleStates.get(id),
          live: previous !== undefined && previous.bundle !== null && wasEnabled.has(id),
          previousChild:
            previous?.row.hardened === true &&
            previous.bundle?.manifest.entry.server === true &&
            !this.heldUnloaded.has(id),
          row: {
            pluginId: id,
            sha256: artifact.sha256,
            source: candidate.artifact.source,
            grantedCaps: [...candidate.grantedCaps],
            installedBy: attribution.installedBy,
            installedAt,
            bundlePath: artifact.bundlePath,
            actions: [],
            hardened: candidate.hardened,
            ...(bundle.builtAgainst === undefined ? {} : { builtAgainst: bundle.builtAgainst }),
            ...(attribution.unpacked === undefined ? {} : { mode: "unpacked" as const }),
            ...(attribution.installer === null ? {} : { installer: attribution.installer }),
          },
          def: undefined,
          staged: undefined,
          retired: false,
          candidateChild: false,
          notified: false,
        });
      }
    } catch (error) {
      // A closed host deletes nothing: the files may already be its successor's.
      if (!this.closed) {
        for (const member of members) {
          if (member.previous?.row.sha256 !== member.artifact.sha256)
            removeInstall(member.artifact);
        }
      }
      if (error instanceof InstallRefusal) return { refused: error.message };
      throw error;
    }
    // Declarations only until a member's module is loaded, so admission never runs code early.
    const candidateDefs = (): Map<string, ServerPluginDef> =>
      new Map(
        members.map((member) => [
          member.id,
          member.def ?? { manifest: member.bundle.manifest, actions: [], handlers: {} },
        ]),
      );
    for (const member of members) this.replacing.add(member.id);
    for (const member of members) this.revokeSettlements(member.id);
    try {
      let prospective!: Assembly;
      try {
        // Refuse new dispatches above, and finish admitted old handlers before any hook,
        // runner replacement or snapshot. Other plugins remain independently serviceable.
        await Promise.all(members.map((member) => this.drainDispatches(member.id)));
        // Re-extraction below writes the previous installs' directories.
        this.assertOpen();
        current();
        // Only a verified hardened module has a child to restore. A boot-unverified row keeps
        // its fail-closed def on rollback; unreadable old bytes must not prevent its repair.
        for (const member of members) {
          if (!member.previousChild || member.previous === undefined) continue;
          const verdict = verifyInstalledBundle(member.previous.row);
          if (!verdict.ok) throw new InstallRefusal(verdict.refusal, verdict.detail);
        }
        const env = await this.env();
        current();
        // Manifest/dependency preflight needs no module. Each module supplies its candidate's
        // actions and migrations, which are checked once it is loaded.
        const declared = new Map(env.dataState);
        for (const member of members) declared.delete(member.id);
        this.preflightGroup(candidateDefs(), { ...env, dataState: declared });
        // In-realm candidates load beside the modules still serving.
        for (const member of members) {
          if (member.row.hardened === true) continue;
          member.def = await this.loadBundle(member.bundle, member.artifact.dir, false);
          current();
        }
        if (members.some((member) => member.row.hardened !== true)) {
          const loaded = await this.env();
          current();
          const dataState = new Map(loaded.dataState);
          for (const member of members) if (member.def === undefined) dataState.delete(member.id);
          this.preflightGroup(candidateDefs(), { ...loaded, dataState });
        }
        // One child owns one id: a hardened candidate starts only once its predecessor retired.
        // A failed candidate reloads only an actual prior child.
        for (const member of members) {
          if (member.row.hardened !== true) continue;
          if (member.live) {
            await this.hook(member.id, "onDisable", "disable_failed");
            member.notified = true;
            current();
          }
          if (member.previousChild) {
            member.retired = true;
            await isolates.runner.unload(member.id);
            current();
          }
          member.candidateChild = true;
          member.def = await this.loadBundle(member.bundle, member.artifact.dir, true);
          current();
        }
        prospective = this.preflightGroup(candidateDefs(), await this.env());
        current();
        for (const member of members) {
          if (member.candidateChild && isolates.runner.state(member.id) === "crashed")
            throw new IsolateLoadError(`${member.id}: candidate child crashed during admission`);
        }
        for (const member of members) {
          if (member.live && !member.notified) {
            await this.hook(member.id, "onDisable", "disable_failed");
            member.notified = true;
            current();
          }
          if (member.previousChild && !member.retired) {
            member.retired = true;
            await isolates.runner.unload(member.id);
            current();
          }
        }
        for (const member of members) {
          member.row = {
            ...member.row,
            actions:
              prospective.roster.find((entry) => entry.manifest.id === member.id)?.actions ?? [],
          };
          if (!prospective.enabled(member.id)) {
            this.retireDatabase(member.id);
            continue;
          }
          try {
            member.staged = await this.prepareMigrations(
              member.id,
              prospective.pendingMigrations.get(member.id) ?? [],
              member.bundle.manifest,
            );
          } catch (error) {
            if (error instanceof InstallRefusal) throw error;
            throw new InstallRefusal(
              "artifact_invalid",
              error instanceof Error ? error.message : "migration failed",
            );
          }
          current();
        }
        /*
          THE COMMIT, synchronous from here: nothing separates the last authority, snapshot and
          native checks from the rows they admit. Every private image is swapped in under its
          prepared journal first, ONE transaction then publishes every ledger, row and image
          marker, and only after it committed are the old images released.
        */
        this.assertOpen();
        current();
        for (const member of members) {
          // Native admission can occur while candidate loading or migration awaits.
          const nativeRefusal = this.nativeReplacementRefusal(member.bundle.manifest);
          if (nativeRefusal !== null) throw nativeRefusal;
        }
        try {
          for (const member of members) member.staged?.activate();
          this.store.transaction(() => {
            for (const member of members) {
              const publish = (): void => {
                this.store.putPluginInstall(member.row);
                const types = member.bundle.manifest.contributes.elements.map(
                  (element) => element.type,
                );
                if (types.length > 0) this.store.claimElementTypes(member.id, types);
              };
              if (member.staged === undefined) publish();
              else member.staged.commitMetadata(publish);
            }
          });
        } catch (error) {
          if (error instanceof InstallRefusal) throw error;
          throw new InstallRefusal(
            "artifact_invalid",
            error instanceof Error ? error.message : "migration failed",
          );
        }
      } catch (error) {
        try {
          for (const member of members) member.staged?.discard();
          for (const member of [...members].reverse()) await this.rollbackMember(member);
          this.syncDefs();
          for (const member of members) {
            if (member.previousLifecycle === undefined) this.lifecycleStates.delete(member.id);
            else this.lifecycleStates.set(member.id, member.previousLifecycle);
          }
          for (const member of members) {
            if (member.notified) await this.hook(member.id, "onEnable", "enable_failed");
          }
          for (const member of members) this.replacing.delete(member.id);
          for (const member of members) this.reconcileIsolateState(member.id);
          this.assembled = await this.reassemble();
          this.publish();
        } catch (rollbackError) {
          // A closed host rolls nothing back: what it would restore or delete is the successor's.
          this.assertOpen();
          for (const member of members) this.lifecycleStates.set(member.id, "enable_failed");
          this.assembled = await this.reassemble();
          this.publish();
          throw new AggregateError(
            [error, rollbackError],
            `replacement and rollback failed for ${members.map((member) => member.id).join(", ")}`,
          );
        }
        if (error instanceof InstallRefusal || error instanceof InstallAuthorityLost)
          return { refused: error.message };
        if (error instanceof AssemblyError)
          return installRefused("artifact_invalid", error.problems.join("; "));
        if (error instanceof IsolateLoadError)
          return installRefused("artifact_invalid", error.message);
        throw error;
      }
      // COMMITTED: nothing below may roll it back. The old images go only now.
      for (const member of members) member.staged?.finish();
      for (const member of members) {
        this.installed.set(member.id, {
          row: member.row,
          bundle: member.bundle,
          web: member.web,
          worker: member.worker,
          styles: member.styles,
          compatibility: member.compatibility,
        });
        this.installedDefs.set(
          member.id,
          !prospective.enabled(member.id) && member.row.hardened !== true
            ? this.dormantDef(member.row, member.bundle)
            : member.def!,
        );
        this.lifecycleStates.delete(member.id);
        this.heldUnloaded.delete(member.id);
      }
      this.syncDefs();
      this.assembled = await this.reassemble();
      if (await this.runPendingMigrations()) this.assembled = await this.reassemble();
      await this.stampDeclaredVersions();
      // Past the commit, the replaced bundles are the only files left to delete, and a
      // successor may have booted from them.
      this.assertOpen();
      for (const member of members) {
        const { previous } = member;
        if (previous === undefined) continue;
        if (
          previous.bundle === null ||
          canonicalJobJson(previous.bundle.manifest.machine ?? null) !==
            canonicalJobJson(member.bundle.manifest.machine ?? null)
        ) {
          // No consent is copied or granted. The reviewed deployment door alone can admit
          // the changed native declaration, artifact and resources.
          this.jobs?.disablePlugin(member.id);
        }
        if (previous.row.sha256 !== member.row.sha256) removeInstall(previous.row);
        wasEnabled.delete(member.id);
      }
      const delta: AssemblyDelta = {
        enabled: this.assembled.order.filter(
          (pluginId) => this.assembled.enabled(pluginId) && !wasEnabled.has(pluginId),
        ),
        disabled: [],
      };
      if (delta.enabled.length > 0) await this.fanOut(delta, wasEnabled);
      for (const member of members) this.replacing.delete(member.id);
      let reconciled = false;
      for (const member of members)
        reconciled = this.reconcileIsolateState(member.id) || reconciled;
      if (reconciled) this.assembled = await this.reassemble();
      // Finalize the review only after migration, native and lifecycle metadata settle.
      // No asynchronous work separates this snapshot from the one roster publication.
      this.assertOpen();
      try {
        attribution.committed?.();
      } catch (error) {
        this.logger.error("plugin_lifecycle", {
          plugin: members.map((member) => member.id).join(","),
          hook: "update_committed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // One roster for the whole family: no member was ever published half replaced.
      this.publish();
      for (const member of members) {
        this.logger.info("plugin_installed", {
          plugin: member.id,
          version: member.bundle.manifest.version,
          sha256: member.row.sha256,
          principal: attribution.installedBy,
          caps: member.row.grantedCaps,
          replaced: member.previous !== undefined,
          ...(attribution.unpacked === undefined ? {} : { mode: "unpacked" }),
        });
        // The commit point, on the engine's own node, for the reason `setEnabled` gives.
        this.events.emit(
          enginePluginsManifest.id,
          { kind: "plugin", pluginId: enginePluginsManifest.id },
          ENGINE_INSTALLED_EVENT,
          attribution.installedBy,
          { plugin: member.id, version: member.bundle.manifest.version, sha256: member.row.sha256 },
        );
      }
      return members.map((member) => ({
        id: member.id,
        version: member.bundle.manifest.version,
        grantedCaps: [...member.row.grantedCaps],
      }));
    } finally {
      for (const member of members) this.replacing.delete(member.id);
    }
  }

  /** Assemble every candidate at once, never exposing their bundles or handlers to native resolvers. */
  private preflightGroup(
    candidates: ReadonlyMap<string, ServerPluginDef>,
    env: AssemblyEnv,
  ): Assembly {
    const defs = new Map(this.installedDefs);
    for (const [id, candidate] of candidates) defs.set(id, candidate);
    const prospective = [...this.firstParty, ...defs.values()];
    const dataState = new Map(env.dataState);
    for (const heldId of this.heldUnloaded) if (!candidates.has(heldId)) dataState.delete(heldId);
    const assembly = assembleRoster(
      prospective,
      this.store.disabledPlugins(prospective.map((def) => def.manifest)),
      {
        ...env,
        dataState,
        problemPolicy: "hold",
        problems: [
          ...this.bundleProblems(new Set(candidates.keys())),
          ...this.harnessProblems(prospective),
        ],
      },
    );
    // Existing, unrelated holds cannot make a compatible repair impossible. Every candidate
    // and every previously admitted definition must nevertheless pass strict admission.
    const previouslyHeld = new Set(
      this.assembled.roster.filter((row) => row.held !== undefined).map((row) => row.manifest.id),
    );
    const problems = assembly.roster
      .filter(
        (row) =>
          row.held !== undefined &&
          (candidates.has(row.manifest.id) || !previouslyHeld.has(row.manifest.id)),
      )
      .map((row) => row.held!.reason);
    if (problems.length > 0) throw new AssemblyError(problems);
    for (const row of assembly.roster) {
      if (!row.enabled) continue;
      const pluginId = row.manifest.id;
      const missing = assembly.unmet(pluginId);
      const clashes = assembly.conflicts(pluginId);
      if (missing.length > 0 || clashes.length > 0)
        throw new AssemblyError([
          `${pluginId}: ${missing.length > 0 ? "dependency_disabled" : "incompatible_dependency"}: ${[...missing, ...clashes].join(", ")}`,
        ]);
    }
    return assembly;
  }

  /**
   * The rebuild loop's knock on the door above (ADR 0025 §4): an unpacked replace of the
   * artifact the hub packed, pinned at the hash of the bytes it wrote. Answers the row as the
   * authoring door promises it — the install result plus that pin.
   */
  private async installUnpacked(
    id: string,
    source: string,
    sha256: string,
    installedBy: string,
    installer: CredentialReference | null,
  ): Promise<ActionRefused | PluginAuthorResult> {
    const outcome = await this.install({ source, sha256, replace: true }, installedBy, installer, {
      id,
    });
    if ("refused" in outcome) return outcome;
    return { ...outcome, sha256 };
  }

  /** The unpacked row of record for `id` as the loop reads it, or null for anything else. */
  private unpackedRow(id: string): UnpackedRow | null {
    const entry = this.installed.get(id);
    if (entry === undefined || entry.row.mode !== "unpacked" || entry.bundle === null) return null;
    return {
      id,
      version: entry.bundle.manifest.version,
      grantedCaps: [...entry.row.grantedCaps],
      sha256: entry.row.sha256,
      installedBy: entry.row.installedBy,
      installer: entry.row.installer ?? null,
    };
  }

  /**
   * THE DEVELOPER-MODE SWITCH (ADR 0025 §4): one workspace-global meta row, flipped by root
   * and published beside every roster. OFF disables every enabled unpacked row FIRST — each
   * through `setEnabled`, the one door, traced and attributed to whoever flipped the switch —
   * so no unpacked code is running once the switch reads off; a refusal on the way stops the
   * flip with that refusal. ON changes no row: the rows stay off as they were left, their
   * `developer_mode_off` marks lift, and the next save or authoring call builds again.
   */
  async setDeveloperMode(on: boolean, changedBy: string): Promise<ActionRefused | { ok: true }> {
    return this.changeAssembly(() => this.setDeveloperModeNow(on, changedBy));
  }

  private async setDeveloperModeNow(
    on: boolean,
    changedBy: string,
  ): Promise<ActionRefused | { ok: true }> {
    if (this.authored === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    if (this.store.developerMode() === on) return { ok: true };
    if (!on) {
      for (const [id, entry] of this.installed) {
        if (entry.row.mode !== "unpacked" || !this.assembled.enabled(id)) continue;
        const outcome = await this.setEnabledNow(id, false, changedBy);
        if ("refused" in outcome) return outcome;
      }
    }
    this.assertOpen();
    this.store.setDeveloperMode(on);
    this.assembled = await this.reassemble();
    this.publish();
    this.logger.info("developer_mode_changed", { on, principal: changedBy });
    this.events.emit(
      enginePluginsManifest.id,
      { kind: "plugin", pluginId: enginePluginsManifest.id },
      ENGINE_DEVELOPER_MODE_EVENT,
      changedBy,
      { on },
    );
    return { ok: true };
  }

  /** THE AUTHORING DOOR (ADR 0025 §4): the directory's hands, then the install path above. */
  async author(
    request: PluginAuthorRequest,
    authoredBy: string,
    credential: CredentialReference,
  ): Promise<ActionRefused | PluginAuthorResult> {
    this.assertOpen();
    if (this.authored === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    return this.authored.author(request, authoredBy, credential);
  }

  /**
   * Retire only this member's candidate and restore its exact old installation, never native
   * jobs. The caller rebuilds the def index once every member is restored.
   */
  private async rollbackMember(member: GroupMember): Promise<void> {
    const { id, previous, previousDef } = member;
    if (this.isolates !== null && member.candidateChild) await this.isolates.runner.unload(id);
    this.assertOpen();
    if (previous?.row.sha256 !== member.artifact.sha256) removeInstall(member.artifact);
    if (previous === undefined || previousDef === undefined) {
      this.installed.delete(id);
      this.installedDefs.delete(id);
    } else {
      this.installed.set(id, previous);
      if (member.retired) {
        const verdict = verifyInstalledBundle(previous.row);
        if (!verdict.ok) throw new InstallRefusal(verdict.refusal, verdict.detail);
        this.installedDefs.set(id, await this.loadBundle(verdict.bundle, verdict.dir, true));
      } else {
        // Keep dormant, never-loaded incumbents dormant, and reuse in-realm definitions.
        this.installedDefs.set(id, previousDef);
      }
    }
  }

  /** THE REVIEW DOOR (#238): the coordinator's verified comparison, under re-proved root. */
  async reviewUpdate(
    id: string,
    authority: PluginUpdateAuthority,
  ): Promise<ActionRefused | PluginUpdateReviewResult> {
    if (this.updates === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    return this.updates.review(id, this.rootAuthority(authority));
  }

  /**
   * THE APPLY DOOR (#238): the coordinator binds the exact reviewed digest and consent, then
   * hands the whole family to `applyUpdateNow` inside the assembly mutex.
   */
  async applyUpdate(
    request: PluginUpdateApplyRequest,
    authority: PluginUpdateAuthority,
  ): Promise<ActionRefused | PluginUpdateApplyResult> {
    if (this.updates === null) {
      return installRefused("artifact_unreadable", "this server admits no bundles");
    }
    return this.updates.apply(request, this.rootAuthority(authority));
  }

  /**
   * The door's live root read, plus the credential itself restored afresh on every question:
   * a revoked, expired or re-scoped token, a removed principal or a deny landing mid-update
   * refuses the update even when the dispatch context was admitted as root.
   */
  private rootAuthority(authority: PluginUpdateAuthority): PluginUpdateAuthority {
    return {
      ...authority,
      assertCurrent: () => {
        authority.assertCurrent();
        const restored = this.authService.restoreCredential(authority.credential);
        if (
          restored === null ||
          restored.principal.id !== authority.principalId ||
          !this.authService.holdsRoot(restored)
        )
          throw new Error(UPDATE_AUTHORITY_REFUSAL);
      },
    };
  }

  /**
   * The coordinator's apply, already inside `serialize`. Every reviewed member is admitted
   * again against the live installation; an unpacked row belongs to its source tree and is
   * never taken over. Members whose pin, hardening and grant are all unchanged keep their
   * running module and row untouched; the rest are ONE group through the one installer.
   */
  private async applyUpdateNow(
    members: readonly PreparedPluginUpdate[],
    authority: PluginUpdateAuthority,
  ): Promise<ActionRefused | readonly PluginInstallResult[]> {
    const changed: PreparedPluginUpdate[] = [];
    for (const member of members) {
      const { bundle } = member.artifact;
      const id = bundle.manifest.id;
      const existing = this.installed.get(id)?.row;
      if (existing?.mode === "unpacked") {
        return installRefused(
          "artifact_invalid",
          `"${id}" is built from this instance's authored directory, which alone updates it`,
        );
      }
      const refusal = this.admissionRefusal(bundle, true);
      if (refusal !== null) return { refused: refusal.message };
      if (
        existing === undefined ||
        existing.sha256 !== member.artifact.sha256 ||
        (existing.hardened === true) !== member.hardened ||
        existing.grantedCaps.length !== member.grantedCaps.length ||
        member.grantedCaps.some((cap) => !existing.grantedCaps.includes(cap))
      )
        changed.push(member);
    }
    let installed: readonly PluginInstallResult[] = [];
    if (changed.length > 0) {
      const outcome = await this.installGroup(changed, {
        installedBy: authority.principalId,
        installer: authority.credential,
        // Called through `authority`, whatever shape the coordinator gives its callbacks.
        assertCurrent: () => {
          authority.assertCurrent();
        },
        ...(authority.committed === undefined
          ? {}
          : {
              committed: () => {
                authority.committed?.();
              },
            }),
      });
      if ("refused" in outcome) return outcome;
      installed = outcome;
    } else {
      // Nothing to replace: the reviewed family is already the committed one.
      try {
        authority.assertCurrent();
      } catch (error) {
        return { refused: error instanceof Error ? error.message : UPDATE_AUTHORITY_REFUSAL };
      }
      authority.committed?.();
      this.publish();
    }
    return members.map((member) => {
      const id = member.artifact.bundle.manifest.id;
      return (
        installed.find((result) => result.id === id) ?? {
          id,
          version: member.artifact.bundle.manifest.version,
          grantedCaps: [...(this.installed.get(id)?.row.grantedCaps ?? member.grantedCaps)],
        }
      );
    });
  }

  /**
   * THE UNINSTALL DOOR. Refused unless the row is off (`still_enabled`, the rule `purge` has
   * and for the same reason: removing running code is not a state anybody asked for). It
   * retires the child, deletes the files and the row, forgets the row's switch, and
   * reassembles.
   *
   * The plugin's storage is never destroyed by this door on its own, and never stranded by it
   * either (#233): while the namespace holds keys or its own file holds pages the door refuses
   * `storage_retained` naming both counts, and `purge: true` is consent to run the purge verb
   * FIRST — the same path and
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
    traceId: number | null = null,
  ): Promise<ActionRefused | { ok: true }> {
    return this.changeAssembly(() => this.uninstallNow(id, removedBy, purge, traceId));
  }

  private async uninstallNow(
    id: string,
    removedBy: string,
    purge: boolean,
    traceId: number | null,
  ): Promise<ActionRefused | { ok: true }> {
    const entry = this.installed.get(id);
    if (entry === undefined || this.isolates === null) {
      return installRefused("not_installed", `"${id}" was not installed here`);
    }
    if (this.assembled.enabled(id)) {
      return installRefused("still_enabled", `disable "${id}" before uninstalling it`);
    }
    if (purge) {
      const purged = await this.purgeNow(id, removedBy, traceId);
      if ("refused" in purged) return purged;
    } else {
      /*
        RETAINED IS RETAINED, whatever shape the data has (#233, ADR 0034 §5): keys in the
        namespace and pages in the file are both "this plugin still holds something", so the
        guard counts them together and the sentence names each. A plugin whose data is rows
        must not be uninstallable in silence when one whose data is keys is not.
      */
      const keys = await this.storage(id).count();
      const pages = (await this.database(id)?.pageCount()) ?? 0;
      if (keys > 0 || pages > 0) {
        return installRefused(
          "storage_retained",
          `${String(keys)} keys and ${String(pages)} database pages; purge first or pass purge: true`,
        );
      }
    }
    this.assertOpen();
    // Removing a held plugin is an explicit revocation, not recovery from its runtime hold.
    // Revoke native intent before reassembly can remove that hold's disable projection.
    this.jobs?.disablePlugin(id);
    if (entry.row.hardened === true) await this.isolates.runner.unload(id);
    this.assertOpen();
    removeInstall(entry.row);
    this.store.deletePluginInstall(id);
    this.store.clearPluginEnablement(id);
    this.installed.delete(id);
    this.installedDefs.delete(id);
    this.heldUnloaded.delete(id);
    this.lifecycleStates.delete(id);
    // The row is gone, so the handle onto its file is too. The BYTES stay unless a purge took
    // them — an uninstall never destroys data — and the next install of this id opens afresh.
    this.retireDatabase(id);
    this.syncDefs();
    this.assembled = await this.reassemble();
    this.assertOpen();
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
   * The module `GET /api/plugins/:id/web.js` serves: the bytes of `files[entry.web]` for an
   * installed, verified, ENABLED plugin, with the pin the response tags them with. Null for
   * everything else, which the route answers as 404 — a disabled plugin's code is not fetched
   * by anyone, a refused bundle's never is, and neither is a contract-9 web half an installer
   * hardened without its portable Worker entry: that module was built for the page's registry
   * and is refused before any of it is evaluated.
   */
  webModule(
    id: string,
  ): { readonly sha256: string; readonly bytes: Uint8Array<ArrayBuffer> } | null {
    const entry = this.installed.get(id);
    if (entry === undefined || entry.web === null || !this.assembled.enabled(id)) return null;
    const unportable =
      entry.row.hardened === true && entry.bundle !== null && unportableHardenedWeb(entry.bundle);
    return unportable ? null : { sha256: entry.row.sha256, bytes: entry.web };
  }

  /**
   * The portable React Worker entry `GET /api/plugins/:id/web.worker.js` serves (ADR 0053):
   * the declared `web.worker.js` of an installed, verified, ENABLED plugin under its install
   * pin, or of an enabled trusted first-party build under the pin of the artifact this process
   * compiled. Only the declared member, never another file, and nothing while disabled.
   */
  webWorkerModule(
    id: string,
  ): { readonly sha256: string; readonly bytes: Uint8Array<ArrayBuffer> } | null {
    if (!this.assembled.enabled(id)) return null;
    const trusted = this.trusted.get(id);
    if (trusted !== undefined)
      return trusted.worker === null ? null : { sha256: trusted.sha256, bytes: trusted.worker };
    const entry = this.installed.get(id);
    if (entry === undefined || entry.worker === null) return null;
    return { sha256: entry.row.sha256, bytes: entry.worker };
  }

  /**
   * The sheet `GET /api/plugins/:id/styles.css` serves, on exactly the module's terms (ADR
   * 0025 §7): the declared `styles.css` of an installed, verified, ENABLED plugin — admitted
   * under the root-class rule when it was installed and again when it was verified — tagged
   * with the same pin. Null for everything else.
   */
  stylesheet(
    id: string,
  ): { readonly sha256: string; readonly bytes: Uint8Array<ArrayBuffer> } | null {
    const entry = this.installed.get(id);
    if (entry === undefined || entry.styles === null || !this.assembled.enabled(id)) return null;
    return { sha256: entry.row.sha256, bytes: entry.styles };
  }

  /**
   * THE HOOK'S CTX: own data plus credential-bound jobs, dependency actions and metadata.
   *
   * A plugin that owns a cadence has to be able to register it when it is turned ON (#514) —
   * the first dispatch or settlement may never come for a half nobody opens. The authority is
   * the INSTALLER's, restored from the row's stored lineage at every fan-out rather than kept
   * live, so a revoked or expired installer simply stops lending it: the slice is ABSENT, the
   * hook still runs, and a guest's `jobs.*` call is refused by name (`proxy-def.ts`). It is
   * never the enabling administrator's and never ambient, which is what keeps "a plugin can do
   * what its installer consented to" true at a hook as it already is at a door.
   *
   * A first-party row nobody installed, and a row written before schema 32, have no lineage to
   * restore and so have no slice — exactly what they could do before.
   */
  private lifecycleCtx(
    pluginId: string,
    lease: PluginDataLease,
    authority?: AuthContext,
  ): LifecycleCtx {
    const { storage, database } = lease;
    const installed = this.installed.get(pluginId);
    const installer = installed?.row.installer;
    const auth =
      authority ?? (installer === undefined ? null : this.authService.restoreCredential(installer));
    const manifest = this.defs.find((def) => def.manifest.id === pluginId)?.manifest;
    const credential = auth === null ? null : this.authService.credentialReference(auth);
    const metadataAuthority = (cap: "containers:read" | "services:read"): AuthContext => {
      lease.check();
      const currentInstall = this.installed.get(pluginId);
      const currentManifest = this.defs.find((def) => def.manifest.id === pluginId)?.manifest;
      if (
        credential === null ||
        manifest === undefined ||
        currentManifest !== manifest ||
        currentInstall?.row.sha256 !== installed?.row.sha256 ||
        !withinCeiling(cap, currentManifest.capabilities) ||
        (currentInstall !== undefined && !withinCeiling(cap, currentInstall.row.grantedCaps))
      )
        throw new ServiceError("forbidden", "plugin metadata authority unavailable");
      const current = this.authService.restoreCredential(credential);
      if (
        current === null ||
        !withinCeiling(cap, current.caps) ||
        (cap === "containers:read" && !this.authService.allows(current, cap))
      )
        throw new ServiceError("forbidden", `${cap} capability required`);
      return current;
    };
    return {
      pluginId,
      storage,
      // Present exactly for a plugin whose manifest declared a file; absent, not empty, for
      // every other plugin — the same rule the dispatch context and the proxy both apply.
      ...(database === undefined ? {} : { database }),
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
      ...(auth === null
        ? {}
        : {
            host: {
              roster: () => {
                metadataAuthority("containers:read");
                return structuredClone(this.roster());
              },
              enabled: (id) => {
                metadataAuthority("containers:read");
                return this.assembled.enabled(id);
              },
            },
            machines: {
              inventory: () =>
                identityCall(() => {
                  metadataAuthority("containers:read");
                  return this.machineInventory();
                }),
            },
            services: {
              listInstances: (args) => {
                serviceDoorSchemas.listInstances.parse(args);
                const current = metadataAuthority("services:read");
                if (this.jobs === null)
                  throw new ServiceError("forbidden", "service authority unavailable");
                // Even an owner installer is narrowed to the admitted metadata cap. The
                // shared listing still grades each service ref and never returns secrets.
                return this.jobs.listInstanceServices(current, ["services:read"]);
              },
            },
            jobs: jobContext(
              () => {
                if (this.jobs === null)
                  throw new ServiceError("forbidden", "job service unavailable");
                return this.jobs;
              },
              auth,
              pluginId,
              LIFECYCLE_TRACE,
            ),
            /*
              The sibling verb rides the SAME restored credential, so a half that composes on
              a dependency can ask it something at the transition it owns (ADR 0041). One
              plugin frame on the stack — this one — because a hook is where a chain begins;
              nobody dispatched it, which is also why the parent is the sentinel rather than a
              row id.
            */
            actions: this.actionCalls(pluginId, auth, null, LIFECYCLE_TRACE, [pluginId]),
          }),
    };
  }

  private async runLifecycle(
    pluginId: string,
    invoke: (ctx: LifecycleCtx) => void | Promise<void>,
  ): Promise<HookOutcome> {
    let active: PluginDataLease | undefined;
    try {
      return await runHook(async () => {
        const lease = this.dataLease(pluginId);
        active = lease;
        try {
          await invoke(this.lifecycleCtx(pluginId, lease));
        } finally {
          lease.close();
          if (active === lease) active = undefined;
        }
      }, this.lifecycleTimeoutMs);
    } finally {
      // `runHook` stops waiting at the deadline; the callback may still be live.
      active?.close();
    }
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
      const outcome = await this.runLifecycle(id, (ctx) => changed(ctx, delta));
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
    const outcome = await this.runLifecycle(id, invoke);
    if (outcome.ok) {
      this.lifecycleStates.delete(id);
      return;
    }
    this.lifecycleStates.set(id, failure);
    this.logger.error("plugin_lifecycle", { plugin: id, hook: name, error: outcome.reason });
  }
  /**
   * One settled job, delivered to the half that started it and to nobody else.
   *
   * It rides `runHook`'s bound, with an optional per-plugin settlement-only override.
   * The job is already over, so a slow or throwing consumer delays nothing and earns a
   * log line rather than a retry or a lifecycle state — a failure here is not an enable or a
   * disable that went wrong. A disabled plugin is skipped: its jobs were cancelled on the way
   * out, and waking a half that is not serving would be creation while disabled (D12).
   */
  private async jobSettled(delivery: SettledJobDelivery): Promise<void> {
    const id = delivery.settled.pluginId;
    if (this.closed || !this.assembled.enabled(id) || this.store.disabledPlugins().has(id)) return;
    const invoke = this.defs.find((def) => def.manifest.id === id)?.lifecycle?.onJobSettled;
    if (invoke === undefined) return;
    const auth = delivery.auth;
    if (auth === null) {
      this.logger.warn("plugin_lifecycle", {
        plugin: id,
        hook: "onJobSettled",
        error: "the job's credential is revoked or expired",
      });
      return;
    }
    // Keep the originating job's authority for every use of the retained context. Neither
    // an installer nor a later module/enablement may revive an expired settlement.
    const credential = this.authService.credentialReference(auth);
    const manifest = this.defs.find((def) => def.manifest.id === id)?.manifest;
    const installed = this.installed.get(id);
    const epoch = this.settlementEpochs.get(id) ?? 0;
    const checkCurrent = (): void => {
      if (
        !this.assembled.enabled(id) ||
        (this.settlementEpochs.get(id) ?? 0) !== epoch ||
        this.replacing.has(id) ||
        this.defs.find((def) => def.manifest.id === id)?.manifest !== manifest ||
        this.installed.get(id) !== installed ||
        this.authService.restoreCredential(credential) === null
      )
        throw new ServiceError("forbidden", "settled job authority unavailable");
    };
    // The lease also guards jobs and actions, not merely durable data: a retained hook
    // context cannot admit NEW work after return, expiry, disable, retirement or shutdown.
    const lease = this.dataLease(id, undefined, undefined, Number.POSITIVE_INFINITY, checkCurrent);
    const lifecycle = this.lifecycleCtx(id, lease, auth);
    const ctx: JobSettledCtx = {
      ...lifecycle,
      emit: (ref, kind, payload) => {
        lease.check();
        lifecycle.emit(ref, kind, payload);
      },
      jobs: jobContext(
        () => {
          lease.check();
          if (this.jobs === null) throw new ServiceError("forbidden", "job service unavailable");
          return this.jobs;
        },
        auth,
        id,
        delivery.traceId,
      ),
      // Both slices are the SETTLED JOB'S credential, not the installer's: the wake belongs
      // to that run, so what it may ask a dependency is what that run could ask.
      actions: this.actionCalls(id, auth, null, delivery.traceId, [id], lease.check),
    };
    let outcome: HookOutcome;
    try {
      outcome = await runHook(
        () => {
          try {
            const result = invoke(ctx, delivery.settled);
            if (result === undefined) {
              lease.close();
              return;
            }
            // Close at the hook's own completion, not a later Promise.race continuation.
            return Promise.resolve(result).finally(lease.close);
          } catch (error) {
            lease.close();
            throw error;
          }
        },
        this.jobSettledTimeouts.get(id) ?? this.lifecycleTimeoutMs,
      );
    } finally {
      lease.close();
    }
    if (outcome.ok) return;
    this.logger.error("plugin_lifecycle", {
      plugin: id,
      hook: "onJobSettled",
      error: outcome.reason,
    });
  }

  private publish(): void {
    if (this.closed) return;
    this.streams.reconcile();
    const developerMode = this.store.developerMode();
    const roster = this.roster();
    for (const listener of this.rosterListeners) listener(roster, developerMode);
  }

  /**
   * The CALLER, when a dispatch was opened by another plugin's handler rather than by a
   * client (ADR 0041). Everything in it is the host's own knowledge of the dispatch already
   * in flight — never anything the calling handler passed — which is what lets the callee's
   * ledger row name an origin the caller could not have forged.
   *
   * `stack` is the plugin frames this trace already carries, caller LAST, and it is the whole
   * mechanism behind both bounds: a callee already on it is a cycle, and a stack at
   * `MAX_ACTION_CALL_DEPTH` is as deep as one trace goes.
   *
   * ONE AUTHORITY, always the caller's own `auth` (§2). An engine BUILTIN is never a callee at
   * all — the check below refuses it — so there is no second context to choose between.
   */
  private actionCalls(
    caller: string,
    auth: AuthContext,
    session: string | null,
    parentTrace: number | string,
    stack: readonly string[],
    beforeCall?: () => void,
  ): PluginActionContext {
    return {
      call: async (args) => {
        beforeCall?.();
        // Parsed here, as every native slice parses (`jobContext`): the frame a hardened
        // guest sends and the object an in-realm handler passes meet the same schema.
        const request = ActionCallArgsSchema.parse(args);
        const callee = request.plugin;
        const door = `${callee}.${request.action}`;
        const edge = `${caller} -> ${callee}`;
        /*
          THE TWO BOUNDS ON THE TRACE, asked before anything about the roster.

          A cycle is first because it is the one refusal a manifest cannot answer: composition
          refuses a self-dependency and a dependency cycle outright (ADR 0013 §5.3, §5.6), so
          telling a plugin reaching for its own door that it never DECLARED itself would be
          advice it cannot take. It is also why the stack, rather than a self-comparison, is
          the mechanism: the declared-edge graph is acyclic today, and A -> B -> A is refused
          by this same line one frame later for any caller of this verb.
        */
        const chain = [...stack, callee].join(" -> ");
        if (stack.includes(callee)) throw new ActionCallRefused("dispatch_cycle", chain);
        if (stack.length >= MAX_ACTION_CALL_DEPTH) {
          throw new ActionCallRefused("dispatch_depth", chain);
        }
        /*
          A BUILTIN ROW IS NOT A PLUGIN IN THE DEPENDENCY MODEL (ADR 0023 `:189`), so it is not
          a callee here however a manifest names it — and the reason is mechanical rather than
          tidy. The engine's own doors (`engine.jobs`, `engine.services`, `engine.machines`,
          `engine.plugins`) declare no caps of their own and resolve authority from the CONTEXT
          they are handed, including the plugin identity `jobContext` pins to the dispatching
          plugin (`job-doors.ts`) — which through this verb would be `engine.jobs`'s own, with
          the `pluginId` argument caller-chosen. A plugin would then read and cancel another
          plugin's jobs by asking the engine's door for them, which `ctx.jobs` refuses by
          construction. The native slices ARE the way to those mechanisms: `ctx.jobs`,
          `ctx.services` and `ctx.machines`, each bound to this plugin and its declared ceiling.
        */
        if (this.assembled.builtin(callee)) {
          throw new ActionCallRefused(
            "undeclared_dependency",
            `${edge} (a builtin row is not a plugin in the dependency model; reach the engine's doors through ctx.jobs, ctx.services or ctx.machines)`,
          );
        }
        /*
          THE DECLARED EDGE, and it is the only thing this side decides about authority.
          `dependencies` is the manifest's own statement of what it composes on (ADR 0013 §5),
          so an `incompatible` entry — or no entry at all — is not an edge: a plugin cannot
          discover a sibling at runtime and start using it, which is what keeps the dependency
          graph a reader can see in the manifests the same graph the hub actually runs.
        */
        const callerRow = this.assembled.roster.find((entry) => entry.manifest.id === caller);
        const declared = callerRow?.manifest.dependencies?.[callee];
        if (declared === undefined || declared.type === "incompatible") {
          throw new ActionCallRefused("undeclared_dependency", edge);
        }
        /*
          `enabled` is false for a disabled row AND for an id nothing assembled, which is
          exactly the pair this class covers. Only an `optional` edge can reach it — a
          `required` dependency absent or off is a composition refusal, and the toggle door
          refuses the disable naming this caller (ADR 0013 §5.1/§5.4) — and the caller stays
          enabled either way: there is no cascade.
        */
        if (!this.assembled.enabled(callee)) {
          throw new ActionCallRefused("dependency_unavailable", edge);
        }
        /*
          THE CALLER'S OWN CEILING, as the operator ruled on 2026-09-14 (ADR 0041 §3): the
          callee door's declared capabilities must also lie inside what the CALLING plugin
          could have declared for itself — `granted ∩ declared`, the same ceiling rung 4's
          first half applies to the caller's own doors. A plugin never does through a sibling
          what it could not have asked for on its own manifest: a row whose installer withheld
          `terminals:write` does not get it by depending on a plugin whose door demands it and
          waiting for a caller who holds it.

          It is a SECOND bound and not a narrowing of the principal: the grade at the callee is
          still the caller's request principal (§2), and both have to pass. Declared `caps`
          only — a `delegates` entry is a ceiling the callee spends with its OWN consented
          authority, which the caller never borrows. A door nobody published has no caps to
          check and falls through to `unknown_action` at the dispatch below, which is the
          order the vocabulary publishes.

          ENGINE caps only. A plugin's OWN capability (ADR 0035) is namespaced to the plugin
          that declared it, and a manifest may name only its own namespace — so demanding it
          of a caller's ceiling would make every door guarded by one unreachable, which is
          `atyrode.code.runSession`'s exact shape. A namespaced cap is the callee's own gate
          and it is graded where it belongs: against the PRINCIPAL, at the callee.

          A GOVERNED cap is dropped from an installed caller's ceiling rather than admitted by
          its grant, which is rung 4's first half read the other way round: a flat install
          grant never consents to governed authority (its consent is version-bound and
          discharged per artifact revision), so an edge must not be able to carry one.
        */
        const granted = this.installed.get(caller)?.row.grantedCaps;
        const ceiling = (callerRow?.manifest.capabilities ?? []).filter(
          (cap) =>
            granted === undefined || (!GOVERNED_CAPS.includes(cap) && withinCeiling(cap, granted)),
        );
        for (const cap of this.assembled.actions.get(door)?.def.caps ?? []) {
          if (!isEngineCap(cap) || withinCeiling(cap, ceiling)) continue;
          throw new ActionCallRefused("caller_ceiling", `${caller} -> ${door} (${cap})`);
        }
        /*
          THE CALLEE'S OWN LADDER, unchanged and whole: the same method a client's dispatch
          walks. Its trace, its capability checks, its declared limits, its staged emissions
          flushing on ITS success — all of it is the existing path, which is why this verb adds
          no rung and cannot be a second denial ladder.

          Always under the caller's own `auth` (§2): a builtin callee was refused above, so
          there is no second authority to choose between here.
        */
        let outcome: ActionOutcome;
        try {
          outcome = await this.dispatch(auth, door, request.input, session, {
            origin: { plugin: caller, parentTrace, stack },
            ...(beforeCall === undefined ? {} : { beforeAdmission: beforeCall }),
          });
        } catch {
          /*
            A BROKEN CALLEE IS NOT A REFUSAL, and its error text is not the caller's to
            publish. The callee's own row already settled `failed` and the host already logged
            the throw with its message; what crosses the edge is the edge and the outcome, so a
            SQLite constraint or a stack sentence from another plugin's internals can never
            reach this caller's client — in realm or through the proxy, which is the whole
            reason this is caught here rather than left to the two boundaries.
          */
          throw new ActionCallRefused("refused", `${caller} -> ${door} (failed)`);
        }
        if (outcome.ok) return outcome.result;
        const { rule, message } = outcome.denial;
        if (rule === "unknown_action") throw new ActionCallRefused("unknown_action", door);
        // Refused AT the callee, and named for what the caller can act on: the principal it is
        // serving does not hold what that door demands. The callee's own sentence is the detail.
        if (rule === "forbidden") {
          throw new ActionCallRefused("capability", `${caller} -> ${door} (${message})`);
        }
        // A row that went off between the check above and the dispatch: the same class, because
        // the fact a caller acts on is that the dependency was not there to answer.
        if (rule === "plugin_disabled") throw new ActionCallRefused("dependency_unavailable", edge);
        throw new ActionCallRefused(
          "refused",
          rule === "refused"
            ? `${caller} -> ${door} (${message})`
            : `${caller} -> ${door} (${rule}: ${message})`,
        );
      },
    };
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
    options: DispatchOptions = {},
  ): Promise<ActionOutcome> {
    const pluginId = this.assembled.actions.get(fullName)?.plugin.id;
    const settled = Promise.withResolvers<void>();
    let active: Set<Promise<void>> | undefined;
    if (pluginId !== undefined) {
      active = this.activeDispatches.get(pluginId);
      if (active === undefined) {
        active = new Set();
        this.activeDispatches.set(pluginId, active);
      }
      active.add(settled.promise);
    }
    let outcome: ActionOutcome;
    try {
      try {
        outcome = await this.run(auth, fullName, rawArgs, session, options);
      } finally {
        settled.resolve();
        active?.delete(settled.promise);
        if (pluginId !== undefined && active?.size === 0) this.activeDispatches.delete(pluginId);
      }
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

  /** The public live fleet projection shared by dispatches and read-only lifecycle callbacks. */
  private machineInventory(includeTopology = true): MachineInventory {
    // One read of the withdrawn set for the whole roster, never a question per row.
    const withdrawn = this.store.revokedMachineIds();
    return {
      machines: this.store.listMachines().map((machine) => {
        const online = this.machines.isOnline(machine.id);
        const revoked = withdrawn.has(machine.id);
        const physicalCoreCount =
          includeTopology && online && !revoked
            ? this.machines.getPhysicalCoreCount(machine.id)
            : undefined;
        return {
          id: machine.id,
          name: machine.name,
          online,
          revoked,
          draining: machine.draining,
          terminalExecution: this.machines.getTerminalExecution(machine.id),
          lastRefusal: machine.lastRefusal,
          ...(physicalCoreCount === undefined ? {} : { physicalCoreCount }),
        };
      }),
    };
  }

  /**
   * THE FLEET BRIDGE (#259): the machine and identity verbs a handler may reach — one object
   * for an in-realm handler and for the proxy serving a hardened guest (`serveCtxCall`).
   * `authority` is the dispatch's live, ceiling-bound caller (`run`); every verb asks it at the
   * moment of use and resolves machines by id against current state, so no stale record,
   * token id or store handle is ever accepted or answered: only public identity, a count, the
   * latch's report, at most one raw token, or a refusal as data.
   *
   * Withdrawal and forgetting name the machine as the trace's target before they are graded,
   * so a refused attempt is as attributable as a committed one.
   */
  private machineBridge(
    authority: (
      cap: "containers:read" | "machines:mint" | "machines:read",
      workspace: boolean,
      node?: ManifoldRef,
    ) => AuthContext,
    target: (machineId: string) => void,
    includeTopology: boolean,
  ): {
    readonly machines: Pick<ActionMachines, "inventory" | "drain" | "repository">;
    readonly identity: Pick<
      IdentityDoor,
      "enrollMachine" | "rotateMachineToken" | "revokeMachine" | "forgetMachine"
    >;
  } {
    return {
      machines: {
        repository: async (machineId, path) => {
          const allowed = identityCall(() =>
            authority("machines:read", false, { kind: "machine", machineId }),
          );
          if (!allowed.ok) return { ok: false, reason: allowed.message };
          return this.machines.repository(machineId, path);
        },
        inventory: () =>
          identityCall(() => {
            authority("containers:read", false);
            return this.machineInventory(includeTopology);
          }),
        drain: async (machineId, draining) => {
          const allowed = identityCall(() => authority("machines:mint", true));
          if (!allowed.ok) return { ok: false, reason: allowed.message };
          if (this.store.getMachine(machineId) === null)
            return { ok: false, reason: "unknown machine" };
          return this.machines.drain(machineId, draining);
        },
      },
      identity: {
        enrollMachine: (name) =>
          identityCall((): MachineEnrollmentOutcome => {
            const actor = authority("machines:mint", true);
            const found = this.authService.findOrEnrollMachine(name, actor);
            // The public identity only: the record's token id and owner stay on the host.
            if (!found.created) {
              const { id, name: enrolled } = found.machine;
              return { created: false, machine: { id, name: enrolled } };
            }
            const { machine, machineToken } = found.enrollment;
            return { created: true, machine: { id: machine.id, name: machine.name }, machineToken };
          }),
        rotateMachineToken: (machineId) =>
          identityCall((): MachineCredentialGrant => {
            const actor = authority("machines:mint", true);
            const rotated = this.authService.rotateEnrolledMachineToken(machineId, actor);
            return {
              machine: { id: rotated.machine.id, name: rotated.machine.name },
              machineToken: rotated.machineToken,
            };
          }),
        revokeMachine: (machineId) => {
          target(machineId);
          return identityCall(() =>
            this.authService.revokeMachine(machineId, authority("machines:mint", true)),
          );
        },
        forgetMachine: (machineId) => {
          target(machineId);
          return identityCall(() => {
            const actor = authority("machines:mint", true);
            this.authService.forgetMachine(machineId, actor);
            this.logger.info("machine_forgotten", { machineId, principal: actor.principal.id });
            return null;
          });
        },
      },
    };
  }

  private async run(
    auth: AuthContext,
    fullName: string,
    rawArgs: unknown,
    session: string | null,
    options: DispatchOptions,
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
    const opaque =
      entry.def.trace === "opaque" ||
      entry.def.caps.some((cap) => GOVERNED_CAPS.includes(cap)) ||
      entry.def.delegates?.some((cap) => GOVERNED_CAPS.includes(cap)) === true;
    const payload: Record<string, unknown> = {
      ...(opaque ? {} : tracePayload(fullName, rawArgs)),
      ...traceOrigin(options.origin),
    };
    const attribution: TraceAttribution = {
      ts: this.runtime.now(),
      actor: auth.principal.id,
      authority: traceAuthority(this.authService.holdsRoot(auth), entry.def.caps),
      door: fullName,
      containerId: opaque ? auth.containerScope : traceContainer(auth, rawArgs),
      payload,
      session,
      ...(auth.agentRunId === undefined ? {} : { runId: auth.agentRunId }),
      ...(auth.tokenId === null ? {} : { credentialId: auth.tokenId }),
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
      const traceId = this.store.appendTrace({ ...attribution, outcome: rule, targets: [] });
      options.onTrace?.(traceId);
      return { ok: false, denial: { rule, message } };
    };
    const pluginId = entry.plugin.id;
    const runAccess = pluginId === "core.access" ? entry.def.runAccess : undefined;
    if (
      auth.agentRunnerId !== undefined &&
      runAccess !== "runner" &&
      runAccess !== "inspect" &&
      runAccess !== "teardown" &&
      runAccess !== "delegate"
    ) {
      return refuse("forbidden", "agent runner credentials cannot invoke ordinary actions");
    }
    const runPolicyState = this.authService.agentRunPolicyState(auth);
    const declaration = options?.agentJustification;
    const activeRun = auth.agentRunId !== undefined && runPolicyState === "active";
    const normalizedDeclaration =
      activeRun && typeof declaration === "string" ? normalizeAgentDeclaration(declaration) : null;
    if (normalizedDeclaration !== null) payload.agentDeclaration = normalizedDeclaration;
    const declarationDenial = !activeRun
      ? null
      : declaration === undefined
        ? entry.def.agentJustification === "required"
          ? new ActionAdmissionDenial("justification_required", "agent declaration required")
          : null
        : normalizedDeclaration === null
          ? new ActionAdmissionDenial("invalid_justification", "agent declaration is invalid")
          : null;
    const enforceDeclaration = (): void => {
      if (declarationDenial !== null) throw declarationDenial;
    };
    const guestInput = this.guestInputPlugins.has(pluginId);
    const nativeEffectAdmission =
      fullName === "core.access.createRun" ||
      fullName === "core.access.createChildRun" ||
      fullName === "core.access.renewAgentRun" ||
      fullName === "engine.jobs.execute" ||
      fullName === "engine.jobs.schedule";
    if (runPolicyState === "expired") {
      return refuse("forbidden", "agent run expired");
    }
    if (
      runPolicyState === "pending_policy" &&
      runAccess !== "policy" &&
      runAccess !== "teardown" &&
      runAccess !== "inspect"
    ) {
      return refuse("policy_required", "agent policy acknowledgement required");
    }
    if (
      runPolicyState === "policy_stale" &&
      runAccess !== "policy" &&
      runAccess !== "teardown" &&
      runAccess !== "inspect"
    ) {
      return refuse("policy_stale", "agent policy changed; acknowledgement required");
    }
    if (!this.assembled.enabled(pluginId) && entry.def.cleanup !== true) {
      // Cleanup actions (D12) outlive a disable: turning core.terminals off must refuse
      // creation and administration, never the ability to remove what already exists.
      return refuse("plugin_disabled", `plugin "${pluginId}" is disabled`);
    }
    if (this.replacing.has(pluginId)) {
      return refuse("unavailable", `plugin "${pluginId}" is being replaced`);
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
    if (auth.containerScope !== null && scope !== "container" && runAccess === undefined) {
      return refuse("forbidden", "scoped tokens cannot invoke workspace actions");
    }
    /*
      RUNG 4, FIRST HALF — THE INSTALLER'S GRANT (ADR 0016 §5). For a row somebody installed,
      the plugin's effective caps are `granted ∩ declared`, and the intersection is asked
      BEFORE the caller's own caps so the refusal names the plugin's grant: a caller holding
      the cap is still refused when the installer withheld it, and the message says which. A
      first-party row has no grant and skips this half unchanged.
    */
    const nativeCaps = [...entry.def.caps, ...(entry.def.delegates ?? [])];
    const install = this.installed.get(pluginId);
    if (install !== undefined) {
      for (const cap of nativeCaps) {
        // Governed consent is checked separately against exact resource/artifact revisions.
        if (GOVERNED_CAPS.includes(cap) || withinCeiling(cap, install.row.grantedCaps)) continue;
        return refuse("forbidden", `${cap} not granted to plugin ${pluginId}`);
      }
    }
    /*
      CARRIED CONTAINER AUTHORITY (ADR 0051) answers a CONTAINER-graded door at its container
      and nowhere else. The evaluator removes a carried cap at the credential's anchor, so the
      flat question below refuses it there; for a `scope: "container"` door — whose whole effect
      is confined to one container by contract — the ladder asks instead which container the
      credential carries every one of the door's container caps at. Exactly one, or the door does
      not open: the dispatch then runs SCOPED to that container, so every scope consumer —
      `ctx.containerScope`, `ctx.auth.containerScope`, `ctx.outsideScope`, `ctx.auth.allows`
      without a node — reads it exactly as it would a container-scoped token's. A
      workspace-graded door is never opened by carried authority, and a credential carrying
      none has no carried container here.
    */
    let carriedContainer: string | null = null;
    if (entry.def.requirements === undefined) {
      const carriedScope =
        scope === "container" ? this.authService.carriedScope(auth, entry.def.caps) : null;
      if (carriedScope?.length === 1) carriedContainer = carriedScope[0] ?? null;
      for (const cap of entry.def.caps) {
        if (
          cap === "agents:delegate" &&
          (fullName === "core.access.createRun" ||
            fullName === "core.access.createChildRun" ||
            fullName === "core.access.renewAgentRun")
        )
          continue;
        if (GOVERNED_CAPS.includes(cap))
          return refuse(
            "forbidden",
            "governed actions require resource targets and explicit consent",
          );
        const held =
          cap === "*"
            ? this.authService.holdsRoot(auth)
            : this.authService.allows(auth, cap) ||
              (isContainerGrantCap(cap) && carriedContainer !== null);
        if (!held) return refuse("forbidden", `${cap} capability required`);
      }
    }
    // What the handler reads as its container scope: the token's own, or the carried one.
    const handlerScope = auth.containerScope ?? carriedContainer;
    const parsed = entry.def.input.safeParse(rawArgs);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"} ${issue.message}`)
        .join("; ");
      return refuse("invalid_args", detail);
    }
    let admission: GovernedAdmissionDecision | null = null;
    const governed = entry.def.caps.some((cap) => GOVERNED_CAPS.includes(cap));
    // What this dispatch's admission discharged at containers, for its native bridge (ADR 0051).
    let carried: readonly ContainerGrant[] | undefined;
    let transferRequirements: readonly { cap: AskableCap; ref: ManifoldRef }[] = [];
    const referenceRequirements: { cap: AuthoredCap; ref: ManifoldRef }[] = [];
    const admitInput = (
      args: unknown,
      preparedTargets?: readonly unknown[],
    ): ActionAdmissionDenial | null => {
      try {
        options.beforeAdmission?.();
      } catch {
        return new ActionAdmissionDenial("forbidden", "settled job authority unavailable");
      }
      if (options.admissionFence) {
        const current = options.admissionFence();
        if (current === null)
          return new ActionAdmissionDenial("forbidden", "admission unavailable");
        auth = current;
        const state = this.authService.agentRunPolicyState(auth);
        if (state !== "active" && runAccess !== "policy")
          return new ActionAdmissionDenial(
            state === "pending_policy"
              ? "policy_required"
              : state === "policy_stale"
                ? "policy_stale"
                : "forbidden",
            "agent authority unavailable",
          );
        if (
          this.assembled.actions.get(fullName) !== entry ||
          !this.assembled.enabled(pluginId) ||
          this.replacing.has(pluginId)
        )
          return new ActionAdmissionDenial("unavailable", "action unavailable");
        if (auth.containerScope !== null && scope !== "container" && runAccess === undefined)
          return new ActionAdmissionDenial("forbidden", "scope unavailable");
        const installed = this.installed.get(pluginId);
        if (
          installed &&
          nativeCaps.some(
            (cap) => !GOVERNED_CAPS.includes(cap) && !withinCeiling(cap, installed.row.grantedCaps),
          )
        )
          return new ActionAdmissionDenial("forbidden", "plugin authority unavailable");
        if (
          entry.def.requirements === undefined &&
          entry.def.caps.some((cap) =>
            cap === "*" ? !this.authService.holdsRoot(auth) : !this.authService.allows(auth, cap),
          )
        )
          return new ActionAdmissionDenial("forbidden", "caller authority unavailable");
      }
      const declaredRequirements = entry.def.requirements ?? [];
      if (preparedTargets !== undefined && preparedTargets.length !== declaredRequirements.length)
        return new ActionAdmissionDenial("invalid_args", "invalid authority targets");
      const requirements: AuthorityRequirement[] = [];
      const admittedReferences: { cap: AuthoredCap; ref: ManifoldRef }[] = [];
      const carrying: { readonly containerId: string; readonly caps: ContainerGrantCap[] }[] = [];
      const transferTargets: { cap: AskableCap; ref: ManifoldRef }[] = [];
      for (const [index, declared] of declaredRequirements.entries()) {
        let value: unknown = args;
        if (preparedTargets === undefined) {
          for (const segment of declared.target) {
            value =
              value !== null && typeof value === "object" && Object.hasOwn(value, segment)
                ? Reflect.get(value, segment)
                : undefined;
          }
        } else {
          value = preparedTargets[index];
        }
        const ref = ManifoldRefSchema.safeParse(value);
        if (!ref.success)
          return new ActionAdmissionDenial("invalid_args", "invalid authority target");
        /*
          A GOVERNED door's container authority is discharged at ONE CONTAINER and carried, bound
          to it, by the work this dispatch starts (ADR 0051). Anything but a container names no
          container to bind it to, so it is refused here rather than carried somewhere wider.
        */
        if (governed && isContainerGrantCap(declared.cap)) {
          if (ref.data.kind !== "container")
            return new ActionAdmissionDenial(
              "invalid_args",
              `${declared.cap} requires a container target`,
            );
          const { containerId } = ref.data;
          const grant = carrying.find((entry) => entry.containerId === containerId);
          if (grant === undefined) carrying.push({ containerId, caps: [declared.cap] });
          else if (!grant.caps.includes(declared.cap)) grant.caps.push(declared.cap);
        }
        if (!this.authService.allowsRef(auth, declared.cap, ref.data))
          return new ActionAdmissionDenial(
            "forbidden",
            `${declared.cap} capability required at target`,
          );
        admittedReferences.push({ cap: declared.cap, ref: ref.data });
        // Only engine capabilities have native revision-bound admission evidence.
        transferTargets.push({ cap: declared.cap, ref: ref.data });
        if (isEngineCap(declared.cap)) requirements.push({ cap: declared.cap, ref: ref.data });
      }
      if (governed) {
        admission = this.authService.admitGoverned(auth, pluginId, fullName, requirements);
        if (!admission.allowed)
          return new ActionAdmissionDenial("forbidden", "explicit version-bound consent required");
        if (carrying.length > 0) carried = carrying;
      }
      transferRequirements = transferTargets;
      referenceRequirements.splice(0, referenceRequirements.length, ...admittedReferences);
      return null;
    };
    const projection =
      options.resultProjectionDigest === undefined ? undefined : entry.resultProjection;
    const projectionDigest = projection === undefined ? undefined : await projection.digest;
    const projectionDenial =
      options.resultProjectionDigest !== undefined &&
      (entry.def.runAccess !== undefined ||
        projectionDigest === undefined ||
        projectionDigest !== options.resultProjectionDigest)
        ? new ActionAdmissionDenial("invalid_args", "result projection request is unavailable")
        : null;
    if (!guestInput) {
      const denial = admitInput(parsed.data);
      if (denial !== null) return refuse(denial.rule, denial.message);
      if (!nativeEffectAdmission && declarationDenial !== null)
        return refuse(declarationDenial.rule, declarationDenial.message);
      if (projectionDenial !== null) return refuse(projectionDenial.rule, projectionDenial.message);
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
    options.onTrace?.(traceId);
    const handler = this.handlers.get(pluginId)?.[entry.def.name];
    if (handler === undefined) {
      // An assembled door is accountable even when its handler is broken or absent.
      this.store.settleTrace(traceId, "failed", []);
      throw new Error(`action "${fullName}" has no server handler`);
    }
    const targets: ManifoldRef[] = [];
    let streamAdmissionOpen = true;
    const openedStreams: StreamProducer[] = [];
    // Attenuate only the native bridge, retaining the original token, grant, scope and
    // expiry. Jobs persist this cap ceiling and recheck it at every deferred effect.
    // The engine's native doors resolve their own authority; they are not orchestrators.
    //
    // Container authority never enters that flat ceiling for work under ADR 0051. A governed
    // door's container caps ride only as the grants its admission discharged, bound to their
    // containers. Any other door opened under a confined lineage lends that lineage's grants
    // read through the same intersection — only the caps the door declares, and only at the
    // container it was admitted at when it was admitted on carried authority — so a door that
    // declares none lends an EMPTY list: confined, carrying nothing, never regaining the
    // unconfined or root-class answer the lineage gave up.
    const lent = auth.containerGrants?.flatMap((grant) => {
      if (carriedContainer !== null && grant.containerId !== carriedContainer) return [];
      const caps = grant.caps.filter((cap) => withinCeiling(cap, entry.def.caps));
      return caps.length === 0 ? [] : [{ containerId: grant.containerId, caps }];
    });
    const nativeAuth: AuthContext =
      pluginId === "engine.jobs" || pluginId === "engine.services"
        ? auth
        : {
            ...auth,
            caps: CAPS.filter(
              (cap) =>
                withinCeiling(cap, auth.caps) &&
                withinCeiling(cap, nativeCaps) &&
                !(governed && isContainerGrantCap(cap)),
            ),
            // Read at use: an isolated guest is admitted only after this bridge is built.
            get containerGrants() {
              return carried ?? lent;
            },
          };
    let lease: PluginDataLease;
    try {
      lease = this.dataLease(pluginId);
    } catch (error) {
      this.store.settleTrace(traceId, "failed", []);
      throw error;
    }
    const database = lease.database;
    let guestAdmitted = false;
    const actionStack = [...(options.origin?.stack ?? []), pluginId];
    // Any older packed consumer in the trusted call chain constrains the producer, even
    // through current intermediaries. Builtins and unpacked source definitions stay current.
    const includeMachineTopology = actionStack.every(
      (id) => (this.installed.get(id)?.bundle?.hardenedContract ?? HARDENED_CONTRACT_VERSION) >= 10,
    );
    /*
      THE FLEET BRIDGE'S AUTHORITY (#259, #897), asked at every inventory, repository, drain and
      machine-credential call rather than frozen here: this dispatch is still open and its door
      still assembled, enabled (or a cleanup carve-out) and not being replaced; the capability
      is inside this door's NATIVE ceiling — its declared caps and the current installation grant —
      not merely the caller's; and the caller's credential is live and still holds it here.
      `ctx.auth.allows` answers the caller's question alone and is NOT that ceiling, so a handler
      whose door declares nothing reaches no machine however much its caller holds.
    */
    let machineBridgeOpen = true;
    const nativeTransferGeneration = this.installationGeneration(pluginId);
    const referenceGeneration = this.installationGeneration(pluginId);
    const referenceDispatchCurrent = (): void => {
      if (
        !machineBridgeOpen ||
        this.closed ||
        this.replacing.has(pluginId) ||
        this.assembled.actions.get(fullName)?.def !== entry.def ||
        this.installationGeneration(pluginId) !== referenceGeneration ||
        !this.assembled.enabled(pluginId) ||
        (guestInput && !guestAdmitted)
      )
        throw new ReferenceRefused();
    };
    const nativeTransferCredential = this.authService.credentialReference(auth);
    const machineAuthority = (
      cap: "containers:read" | "machines:mint" | "machines:read",
      workspace: boolean,
      node?: ManifoldRef,
    ): AuthContext => {
      if (
        !machineBridgeOpen ||
        this.closed ||
        this.assembled.actions.get(fullName)?.def !== entry.def ||
        this.replacing.has(pluginId) ||
        (!this.assembled.enabled(pluginId) && entry.def.cleanup !== true)
      )
        throw new ServiceError("forbidden", "plugin authority unavailable");
      const grant = this.installed.get(pluginId)?.row.grantedCaps;
      const live =
        withinCeiling(cap, nativeCaps) && (grant === undefined || withinCeiling(cap, grant))
          ? this.authService.restoreCredential(this.authService.credentialReference(nativeAuth))
          : null;
      // Graded where `ctx.auth.allows` grades a dispatch admitted on carried authority.
      const graded =
        live !== null && carriedContainer !== null && isContainerGrantCap(cap)
          ? { ...live, containerScope: carriedContainer }
          : live;
      // Administered grants can widen a live caller beyond its issued token caps.
      // The independent door and installation ceilings were checked above.
      if (
        live === null ||
        graded === null ||
        !(node === undefined
          ? this.authService.allows(graded, cap)
          : this.authService.allowsRef(graded, cap, node)) ||
        (workspace && live.containerScope !== null)
      )
        throw new ServiceError("forbidden", `${cap} capability required`);
      return live;
    };
    const machineBridge = this.machineBridge(
      machineAuthority,
      (machineId) => {
        if (!opaque) targets.push({ kind: "machine", machineId });
      },
      includeMachineTopology,
    );
    const authService = this.authService;
    const ctx: ActionCtx = {
      traceId,
      pluginId,
      get callerPlugin() {
        return options.origin?.plugin ?? null;
      },
      agentRun:
        auth.agentRunId === undefined
          ? null
          : (() => {
              const run = this.store.getAgentRun(auth.agentRunId);
              return run === null ? null : Object.freeze({ runId: run.id, agentId: run.agentId });
            })(),
      credential: this.authService.credentialReference(auth),
      credentialBinding: this.authService.credentialBinding(auth),
      references: this.referenceService.context(
        {
          pluginId,
          actor: auth,
          traceId,
          check: (cap, ref) => {
            referenceDispatchCurrent();
            if (
              !referenceRequirements.some(
                (required) =>
                  required.cap === cap &&
                  formatManifoldUri(required.ref) === formatManifoldUri(ref),
              )
            )
              throw new ReferenceRefused();
          },
          checkReceipt: (ref) => {
            referenceDispatchCurrent();
            const owner = this.assembled.referenceKinds.get(ref.kind);
            if (
              owner?.plugin !== pluginId ||
              owner.declaration.receiptAction === undefined ||
              fullName !== `${pluginId}.${owner.declaration.receiptAction}`
            )
              throw new ReferenceRefused();
          },
          checkReadable: (kind) => {
            referenceDispatchCurrent();
            const owner = this.assembled.referenceKinds.get(kind);
            const grant = this.installed.get(pluginId)?.row.grantedCaps;
            if (
              owner?.plugin !== pluginId ||
              owner.declaration.listAction === undefined ||
              fullName !== `${pluginId}.${owner.declaration.listAction}` ||
              (grant !== undefined && !withinCeiling(owner.declaration.readCapability, grant))
            ) {
              throw new ReferenceRefused();
            }
          },
        },
        async (input) => {
          const referenceOwner = this.assembled.referenceKinds.get(input.ref.kind);
          const elementOwner = this.assembled.elements.get(input.element.type);
          const assertAttachmentAuthority = (): AuthContext => {
            referenceDispatchCurrent();
            enforceDeclaration();
            const current = this.authService.restoreCredential(nativeTransferCredential);
            if (
              current === null ||
              entry.def.trace !== "opaque" ||
              !referenceRequirements.some(
                (required) =>
                  required.cap === "scenes:write" &&
                  formatManifoldUri(required.ref) === formatManifoldUri(input.target),
              ) ||
              !this.authService.allowsRef(current, "scenes:write", input.target) ||
              (install !== undefined &&
                !withinCeiling(
                  "scenes:write",
                  this.installed.get(pluginId)?.row.grantedCaps ?? [],
                )) ||
              referenceOwner === undefined ||
              (referenceOwner.plugin !== pluginId &&
                entry.plugin.dependencies?.[referenceOwner.plugin] === undefined) ||
              this.assembled.referenceKinds.get(input.ref.kind)?.plugin !== referenceOwner.plugin ||
              elementOwner?.plugin !== pluginId ||
              this.assembled.elements.get(input.element.type)?.plugin !== pluginId ||
              this.store.getContainer(input.target.containerId)?.discipline !== input.discipline
            )
              throw new ReferenceRefused();
            return current;
          };
          const actor = assertAttachmentAuthority();
          await this.referenceService.requirePublished(actor, input.ref);
          const current = assertAttachmentAuthority();
          if (!this.referenceService.canReadPublished(current, input.ref))
            throw new ReferenceRefused();
          const reference = formatManifoldUri(input.ref);
          const element = SceneElementSchema.parse({
            ...input.element,
            [input.referenceProperty]: reference,
            lastEditedBy: current.principal.id,
            lastEditedAt: this.runtime.now(),
          });
          const payload = this.assembled.elements.get(element.type)?.payload;
          if (
            payload === undefined ||
            payload === null ||
            !payload.safeParse(elementPayload(element)).success
          )
            throw new ReferenceRefused("reference_conflict");
          const room = this.rooms.get(input.target.containerId);
          if (room === null) throw new ReferenceRefused();
          const existing = readElement(room.doc, element.id);
          if (existing !== null) {
            if (existing.type !== element.type || existing[input.referenceProperty] !== reference)
              throw new ReferenceRefused("reference_conflict");
            return {
              ref: {
                kind: "element" as const,
                containerId: input.target.containerId,
                elementId: element.id,
              },
              created: false,
            };
          }
          if (elementsMap(room.doc).has(element.id))
            throw new ReferenceRefused("reference_conflict");
          // Capacity staging may consume time; fence authority at the actual canonical commit.
          if (
            !room.transactDoc(
              (doc) => writeElement(doc, element, SERVER_PLACE_ORIGIN),
              SERVER_PLACE_ORIGIN,
              () => {
                const committing = assertAttachmentAuthority();
                if (!this.referenceService.canReadPublished(committing, input.ref))
                  throw new ReferenceRefused();
                if (elementsMap(room.doc).has(element.id))
                  throw new ReferenceRefused("reference_conflict");
              },
            )
          )
            throw new ReferenceRefused("reference_capacity");
          return {
            ref: {
              kind: "element" as const,
              containerId: input.target.containerId,
              elementId: element.id,
            },
            created: true,
          };
        },
      ),
      get admission() {
        return admission;
      },
      ...(guestInput
        ? {
            admitPrepared: (targets: readonly unknown[]): void => {
              if (guestAdmitted) throw new IsolateDenial("unavailable", "isolate admitted twice");
              const denial = admitInput(undefined, targets);
              if (denial !== null) throw denial;
              enforceDeclaration();
              if (projectionDenial !== null) throw projectionDenial;
              guestAdmitted = true;
              options.onAdmitted?.();
            },
          }
        : {}),
      jobs: jobContext(
        () => {
          if (this.jobs === null) throw new ServiceError("forbidden", "job service unavailable");
          return this.jobs;
        },
        nativeAuth,
        pluginId,
        traceId,
        nativeEffectAdmission ? enforceDeclaration : undefined,
      ),
      nativeTransfers: nativeTransferContext(
        () => {
          if (this.jobs === null)
            throw new ServiceError("forbidden", "native_transfer_unavailable");
          return this.jobs.nativeTransfers;
        },
        auth,
        pluginId,
        {
          remainingMs: () =>
            this.isolates?.runner.remainingHostCallMs() ?? Number.POSITIVE_INFINITY,
          assertCurrent: () => {
            if (
              !machineBridgeOpen ||
              this.closed ||
              this.replacing.has(pluginId) ||
              this.assembled.actions.get(fullName)?.def !== entry.def ||
              this.installationGeneration(pluginId) !== nativeTransferGeneration ||
              !this.assembled.enabled(pluginId) ||
              (guestInput && !guestAdmitted)
            )
              throw new ServiceError("forbidden", "transfer_action_unavailable");
            enforceDeclaration();
            const current = this.authService.restoreCredential(nativeTransferCredential);
            if (current === null)
              throw new ServiceError("forbidden", "credential_revoked_or_expired");
            const grant = this.installed.get(pluginId)?.row.grantedCaps;
            for (const { cap, ref } of transferRequirements) {
              if (
                (grant !== undefined &&
                  !(isEngineCap(cap) && GOVERNED_CAPS.includes(cap)) &&
                  !withinCeiling(cap, grant)) ||
                !this.authService.allowsRef(current, cap, ref)
              )
                throw new ServiceError("forbidden", "transfer_authority_refused");
            }
          },
          require: (cap, ref) => {
            if (cap === "*") throw new ServiceError("forbidden", "transfer_authority_refused");
            if (
              !transferRequirements.some(
                (requirement) =>
                  requirement.cap === cap &&
                  formatManifoldUri(requirement.ref) === formatManifoldUri(ref),
              )
            )
              throw new ServiceError("forbidden", "transfer_requirement_undeclared");
            const grant = this.installed.get(pluginId)?.row.grantedCaps;
            if (
              grant !== undefined &&
              !(isEngineCap(cap) && GOVERNED_CAPS.includes(cap)) &&
              !withinCeiling(cap, grant)
            )
              throw new ServiceError("forbidden", "transfer_authority_refused");
            const current = this.authService.restoreCredential(nativeTransferCredential);
            if (!current || !this.authService.allowsRef(current, cap, ref))
              throw new ServiceError("forbidden", "transfer_authority_refused");
          },
          requireSource: async (source) => {
            try {
              const identity = await ctx.references.requirePublished({
                ref: PluginOwnedRefSchema.parse(source.ref),
                access: "read",
              });
              return identity.readyDigest;
            } catch (error) {
              if (error instanceof ReferenceRefused)
                throw new NativeTransferError("transfer_source_unavailable");
              throw error;
            }
          },
        },
      ),
      services: serviceContext(
        () => {
          if (this.jobs === null)
            throw new ServiceError("forbidden", "service authority unavailable");
          return this.jobs;
        },
        nativeAuth,
        pluginId,
        traceId,
        (pluginId === "engine.services" && entry.def.name === "invoke") ||
          withinCeiling("services:invoke", nativeCaps)
          ? "invoke"
          : "read",
      ),
      /*
        THE SIBLING VERB, bound to the CALLER'S OWN `auth` rather than to `nativeAuth` (ADR
        0041). The attenuation above exists for the engine's native bridges, where a plugin
        spends its own declared ceiling; a call on a declared dependency spends nothing of the
        plugin's — the callee grades the PRINCIPAL, and narrowing the principal's caps here
        would refuse a client its own authority at a door it may open directly. The engine's
        own rows are not callees at all (`actionCalls` refuses a builtin), so this verb never
        reaches a door that would have resolved authority from the context instead.

        The stack is this trace's frames plus this plugin, so a callee already on it is a
        cycle and a chain that never repeats an id still stops at the depth bound.
      */
      actions: this.actionCalls(pluginId, auth, session, traceId, actionStack),
      streams: {
        open: (kind, node) => {
          if (!streamAdmissionOpen) throw new Error("stream open requires an active action");
          const descriptor = this.assembled.streams.get(kind)?.descriptor;
          if (
            descriptor === undefined ||
            !this.authService.allowsRef(auth, descriptor.readCapability, node) ||
            !this.canReadGoverned(auth, node)
          )
            throw new Error("stream producer authority refused");
          const uri = formatManifoldUri(node);
          // Retain scalar attribution only, never handler-owned node/argument graphs.
          const {
            actor,
            authority,
            door,
            containerId,
            runId,
            credentialId,
            session: streamSession,
          } = attribution;
          const producer = this.streams.open(pluginId, kind, node, (phase, epoch) => {
            this.store.appendTrace({
              actor,
              authority,
              door,
              containerId,
              session: streamSession,
              ...(runId === undefined ? {} : { runId }),
              ...(credentialId === undefined ? {} : { credentialId }),
              ts: this.runtime.now(),
              payload: { streamLifecycle: phase, parentTrace: traceId, kind, epoch },
              outcome: "ok",
              targets: opaque ? [] : [uri],
            });
          });
          openedStreams.push(producer);
          return producer;
        },
      },
      principal: auth.principal,
      auth: {
        principal: auth.principal,
        // Carried container caps are HELD, so they are listed; `allows` says where (ADR 0051).
        caps: this.authService.ceilingCaps(auth),
        containerScope: handlerScope,
        // Asked when read, never frozen at dispatch: a deny landing mid-handler withdraws it.
        get isRoot(): boolean {
          return authService.holdsRoot(auth);
        },
        // A dispatch admitted on carried authority answers CONTAINER questions as if scoped to
        // its container — a container capability, or any node inside a container — so nothing
        // in another container answers (ADR 0051). Every other question (a machine, operation,
        // job or service node; a non-container capability at the anchor) answers from the flat
        // caps and the grant rows exactly as it did before this door was opened.
        allows: (cap, ref) => {
          const graded =
            carriedContainer !== null &&
            (isContainerGrantCap(cap) || (ref !== undefined && "containerId" in ref))
              ? { ...auth, containerScope: carriedContainer }
              : auth;
          return ref === undefined
            ? this.authService.allows(graded, cap)
            : this.authService.allowsRef(graded, cap, ref);
        },
      },
      containerScope: handlerScope,
      outsideScope: (containerId) =>
        handlerScope !== null && containerId !== handlerScope
          ? { refused: OUTSIDE_SCOPE_REFUSAL }
          : null,
      store: this.store,
      rooms: this.rooms,
      broker: this.broker,
      machines: {
        isOnline: (machineId) => this.machines.isOnline(machineId),
        getTerminalExecution: (machineId) => this.machines.getTerminalExecution(machineId),
        ...machineBridge.machines,
      },
      placement: this.placement,
      host: this,
      identity: {
        listHarnesses: () =>
          identityCall(() =>
            ListHarnessesResultSchema.parse({
              harnesses: [
                {
                  id: "external",
                  title: "External",
                  profileSchema: { type: "object" },
                  sessionRef: "typed",
                },
                ...this.defs.flatMap((def) =>
                  def.harness &&
                  this.assembled.enabled(def.manifest.id) &&
                  !this.replacing.has(def.manifest.id) &&
                  def.manifest.contributes.harness
                    ? [def.manifest.contributes.harness]
                    : [],
                ),
              ],
            }),
          ),
        launchRun: (input) =>
          identityCallAsync(() => this.launchHarnessRun(ctx, auth, input, session, actionStack)),
        sendRunInput: (input) =>
          identityCallAsync(async () => {
            const { run, agent } = this.authService.authorizeRunInput(input.runId, auth);
            const actor = this.authService.runHarnessActor(input.runId, auth);
            await this.withHarness(
              ctx,
              actor,
              agent.harness,
              session,
              actionStack,
              (harness, bound) => harness.send(bound, run, input.input),
            );
            return {};
          }),
        listHarnessSessions: (id, target) =>
          identityCallAsync(() =>
            this.withHarness(ctx, auth, id, session, actionStack, async (harness, bound) => {
              const sessions = await harness.sessions(bound, HarnessTargetSchema.parse(target));
              return {
                sessions: sessions.slice(0, 100).map((value) => {
                  const ref = SessionRefSchema.parse(value);
                  if (ref.harness !== id || ref.machineId !== target.machineId)
                    throw new ServiceError("forbidden", "harness session destination mismatch");
                  return ref;
                }),
                truncated: sessions.length > 100,
              };
            }),
          ),
        resolveHarnessSession: (ref) =>
          identityCallAsync(async () => ({
            session: await this.withHarness(
              ctx,
              auth,
              ref.harness,
              session,
              actionStack,
              async (harness, bound) => {
                const session = await harness.resolveSession(bound, SessionRefSchema.parse(ref));
                if (session === null) return null;
                const resolved = SessionRefSchema.parse(session);
                if (
                  resolved.harness !== ref.harness ||
                  resolved.machineId !== ref.machineId ||
                  resolved.sessionId !== ref.sessionId
                )
                  throw new ServiceError("forbidden", "harness session reference mismatch");
                return resolved;
              },
            ),
          })),
        createPrincipal: (input) =>
          identityCall(() => this.authService.bootstrapPrincipal(input, auth)),
        mintToken: (input) => identityCall(() => this.authService.mintToken(input, auth)),
        registerAgent: (input) =>
          identityCallAsync(() => this.authService.registerAgent(input, auth)),
        getAgent: (input) => identityCall(() => this.authService.getAgent(input, auth)),
        listAgents: () => identityCall(() => this.authService.listAgents(auth)),
        updateAgent: (input) => identityCallAsync(() => this.authService.updateAgent(input, auth)),
        disableAgent: (input) => identityCall(() => this.authService.disableAgent(input, auth)),
        enableAgent: (input) => identityCall(() => this.authService.enableAgent(input, auth)),
        retireAgent: (input) => identityCall(() => this.authService.retireAgent(input, auth)),
        createRun: (input) =>
          identityCall(() => this.authService.createRun(input, auth, enforceDeclaration)),
        createChildRun: (input) =>
          identityCall(() => this.authService.createChildRun(input, auth, enforceDeclaration)),
        inspectRun: (input) => identityCall(() => this.authService.inspectRun(input, auth)),
        listRuns: (input) => identityCall(() => this.authService.listRuns(input, auth)),
        reportRunActivity: (input) =>
          identityCall(() => this.authService.reportRunActivity(input, auth)),
        agentPolicyChallenge: () => identityCall(() => this.authService.agentPolicyChallenge(auth)),
        acknowledgeAgentPolicy: (input) =>
          identityCall(() => this.authService.acknowledgeAgentPolicy(input, auth)),
        renewAgentRun: (input) =>
          identityCall(() => this.authService.renewAgentRun(input, auth, enforceDeclaration)),
        finishAgentRun: (input) => identityCall(() => this.authService.finishAgentRun(input, auth)),
        reloadAgentPolicy: () => identityCall(() => this.authService.reloadAgentPolicy(auth)),
        revokePrincipal: (principalId) =>
          identityCall(() => this.authService.revokePrincipal(principalId, auth)),
        pausePrincipalAccess: (input) =>
          identityCall(() => this.authService.pausePrincipalAccess(input, auth)),
        resumePrincipalAccess: (input) =>
          identityCall(() => this.authService.resumePrincipalAccess(input, auth)),
        ...machineBridge.identity,
        mintShare: (input) => identityCall(() => this.authService.mintShare(input, auth)),
        revokeShare: (shareId) => identityCall(() => this.authService.revokeShare(shareId, auth)),
        listShares: () => identityCall(() => this.authService.listShares(auth)),
        grant: (input) => identityCall(() => this.authService.grant(input, auth)),
        revokeGrant: (grantId) => identityCall(() => this.authService.revokeGrant(grantId, auth)),
        listGrants: (filter) => identityCall(() => this.authService.listGrants(filter, auth)),
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
      storage: lease.storage,
      // Spread rather than assigned: a plugin that declared no database has NO member here,
      // which is what makes "the slice is absent" (ADR 0034 §6) true of the object and not
      // only of its type — and what the isolate proxy answers `slice_unavailable` for.
      ...(database === undefined ? {} : { database }),
      now: () => this.runtime.now(),
      newId: () => this.runtime.newId(),
      target: (ref) => {
        if (!opaque) targets.push(ref);
      },
      emit: (ref, kind, payload) => {
        staged.push({ ref, kind, payload: payload ?? {} });
        if (!opaque) targets.push(ref);
      },
    };
    let produced: unknown;
    const admitted = async (): Promise<unknown> => {
      try {
        // A private ready row can still be an unpublished reservation. Reclaim only from
        // host terminal evidence, before the owner's own capacity check can block prepare.
        for (const declaration of entry.plugin.contributes.references ?? []) {
          if (entry.def.caps.includes(declaration.createCapability))
            await this.referenceService.reclaimExpiredPreparations(declaration.kind, pluginId);
        }
        const handler = this.handlers.get(pluginId)?.[entry.def.name];
        if (handler === undefined) throw new Error(`action "${fullName}" has no server handler`);
        const invoke = handler as (ctx: ActionCtx, args: unknown) => Promise<unknown>;
        if (!guestInput) {
          if (options.admissionFence) {
            const denial = admitInput(parsed.data);
            if (denial !== null) throw denial;
          }
          options.onAdmitted?.();
        }
        const answer = await invoke(ctx, parsed.data);
        if (guestInput && !guestAdmitted)
          throw new IsolateDenial("unavailable", "isolate returned before admission");
        // Shutdown revoked this dispatch: nothing it staged may be announced as committed.
        if (this.closed) throw new Error("plugin host closed before the action settled");
        return answer;
      } finally {
        lease.close();
        machineBridgeOpen = false;
      }
    };
    try {
      produced = await admitted();
    } catch (error) {
      streamAdmissionOpen = false;
      for (const producer of openedStreams) producer.close();
      if (error instanceof ReferenceRefused) {
        this.store.settleTrace(traceId, "refused", traceTargets(targets));
        return { ok: false, denial: { rule: "refused", message: error.message } };
      }
      if (error instanceof IsolateDenial || error instanceof ActionAdmissionDenial) {
        // Guest parsing, host post-parse admission, and native pre-effect declarations all
        // settle the existing write-ahead trace as refusals, never as handler failures.
        this.store.settleTrace(traceId, error.rule, traceTargets(targets));
        return { ok: false, denial: { rule: error.rule, message: error.message } };
      }
      if (error instanceof NativeTransferError) {
        this.store.settleTrace(traceId, "refused", traceTargets(targets));
        const reason = NativeTransferReasonSchema.safeParse(error.reason);
        return {
          ok: false,
          denial: {
            rule: "refused",
            message: reason.success ? reason.data : "native_transfer_unavailable",
          },
        };
      }
      if (error instanceof ActionCallRefused) {
        /*
          A SIBLING'S REFUSAL, PROPAGATED (ADR 0041). The handler called a declared
          dependency, the dependency (or this side's edge, cycle or depth check) refused, and
          the handler did not catch it. That is an ANSWER about the composition rather than a
          broken door: this dispatch refuses with the class and the plugins the refusal names,
          so the client learns which edge failed instead of `failed`, and nothing this handler
          staged goes out.
        */
        this.store.settleTrace(traceId, "refused", traceTargets(targets));
        return { ok: false, denial: { rule: "refused", message: error.message } };
      }
      // A broken door is still an exercise of authority: somebody opened it and it failed
      // half-way. The row settles `failed` and the throw continues to `dispatch`, which logs
      // it with the same word.
      this.store.settleTrace(traceId, "failed", traceTargets(targets));
      throw error;
    }
    streamAdmissionOpen = false;
    if (produced !== null && typeof produced === "object") {
      const denial = Reflect.get(produced, "refused");
      if (typeof denial === "string") {
        for (const producer of openedStreams) producer.close();
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
      for (const producer of openedStreams) producer.close();
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
    if (projection === undefined || projectionDigest === undefined) return { ok: true, result };
    let projected: ActionProjectedResult;
    try {
      // Guests have already crossed JSON. Normalize only the in-realm opt-in view so
      // omitted optional values and toJSON leaves publish identically in both modes.
      const source: unknown = guestInput ? result : JSON.parse(JSON.stringify(result));
      const data = projectJson(source, projection.compiled, projection.policy.maxArrayItems);
      const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
      projected =
        bytes > projection.policy.maxResultBytes
          ? { ok: false, contractDigest: projectionDigest, code: "projection_limit" }
          : { ok: true, contractDigest: projectionDigest, data };
    } catch (error) {
      // The effect and event settlement have succeeded. Publication failure must not
      // turn that truth into an invocation failure or disclose any rejected bytes.
      projected = {
        ok: false,
        contractDigest: projectionDigest,
        code:
          error instanceof JsonProjectionError && error.code === "limit"
            ? "projection_limit"
            : "projection_invalid",
      };
    }
    return { ok: true, result, projection: projected };
  }

  enabled(id: string): boolean {
    return this.assembled.enabled(id);
  }

  /**
   * SHUTDOWN. Every SQLite handle this host opened on a plugin's behalf is closed, so the
   * process leaves no `-wal` mid-checkpoint behind and a restart opens clean files. It is the
   * host's counterpart to `store.close()` and belongs to the same stop sequence — after the
   * sockets, so no dispatch in flight finds its database gone. It also revokes every
   * outstanding lease and discards every migration chain still staged: a handler, hook or
   * migration that resumes afterwards finds its data refused and nothing it can publish, and
   * no plugin file is opened or recovered again. An install, replacement or uninstall that
   * resumes finds its artifact fetch cancelled and every write, row, deletion, roster and
   * answer refused, and the authored loop builds nothing further (#318).
   */
  close(): void {
    this.lifetime.abort(new Error("the plugin host is closed"));
    this.referenceService.close();
    this.updates?.close();
    this.authored?.close();
    this.broker.clearRunLaunches();
    for (const discard of this.stagedMigrations) discard();
    for (const database of this.databases.values()) database.close();
    this.databases.clear();
  }
}
