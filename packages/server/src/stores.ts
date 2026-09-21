import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  DATA_VERSION_KEY,
  MIGRATION_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
  assertStorageKey,
  assertStorageValue,
  formatDataVersion,
  parseDataVersion,
  type PluginAttribution,
  type PluginStorageAdmin,
} from "@manifold/plugin";
import {
  AgentPolicyBundleSchema,
  AgentRunCapSchema,
  AgentRunAuthorizationPathSchema,
  AgentRunStateSchema,
  TRACED_DENIAL_RULES,
  AgentSchema,
  AgentRunAuthorizationCredentialSchema,
  SessionRefSchema,
  RunModelSchema,
  RunActivitySchema,
  type Agent,
  type SessionRef,
  type RunModel,
  type RunActivity,
  ActionSummarySchema,
  AgentRunTraceSummarySchema,
  type AgentRunInspection,
  type InspectRunRequest,
  AuthoredCapSchema,
  MAX_MIGRATION_STORAGE_OPERATIONS,
  BindingOverridesSchema,
  CapSchema,
  GrantNodeSchema,
  GrantReachSchema,
  ContainerDisciplineSchema,
  ContainerSchema,
  GrantSchema,
  JobCredentialSchema,
  IndexEntrySchema,
  PluginSettingValuesSchema,
  PrincipalSchema,
  TerminalCwdSchema,
  TerminalEnvSchema,
  TerminalProgramSchema,
  TerminalRuntimeSchema,
  TileLayoutSchema,
  validateTileLayout,
  type ActionSummary,
  type AgentPolicyBundle,
  type AgentRunCap,
  type AgentRunState,
  type AgentRunAuthorizationPath,
  type AgentRunAuthorizationCredential,
  type GrantReach,
  type BindingOverrides,
  type AuthoredCap,
  type Cap,
  type Container,
  type Grant,
  type IndexEntry,
  type PluginInstallMode,
  type PluginSettingValues,
  type MachineRefusal,
  type Principal,
  type TileLayout,
  type TraceOutcome,
} from "@manifold/protocol";
import { Y } from "@manifold/scene";
import { z } from "zod";
import type { CredentialReference } from "./auth.ts";
import { normalizeAgentDeclaration } from "./log.ts";

export const EVENTS_RETENTION_DAYS = 30;
export const EVENTS_MAX_PER_CONTAINER = 10_000;
/**
 * The container-less bucket's ceiling. It exists because axiom A6 made a rare row family
 * common: a workspace-grade dispatch's trace belongs to no container, and those arrive as fast
 * as a door can be called, so the 30-day window alone stopped being a bound (ADR 0018).
 */
export const EVENTS_MAX_WORKSPACE = 100_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const TRACED_DENIAL_RULES_JSON = JSON.stringify(TRACED_DENIAL_RULES);

/** Workspace-global plugin enablement and per-principal shells live in `meta`. */
const PLUGINS_DISABLED_META = "plugins:disabled";
const PLUGINS_ATTRIBUTION_META = "plugins:attribution";
const ELEMENT_OWNERS_META = "plugins:element-owners";
/** The workspace's developer-mode switch (ADR 0025 §4): `"1"` on, anything else off. */
const DEVELOPER_MODE_META = "plugins:developer-mode";
const DisabledPluginsSchema = z.array(z.string().min(1)).max(256);
const AttributionSchema = z.record(
  z.string().min(1),
  z.strictObject({ by: z.string().min(1), at: z.number().int() }),
);
const ElementOwnersSchema = z.record(z.string().min(1), z.string().min(1));

/**
 * A `meta` row holding JSON, read defensively. Every caller treats an unparseable value as
 * "nothing recorded": the alternative is a workspace that refuses to boot because one row
 * lost its brackets, and none of these facts is worth that.
 */
function readJsonMeta(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface PluginKvRow {
  value: string;
}
interface PluginKvKeyRow {
  key: string;
}
interface PluginKvCountRow {
  total: number;
}

interface ContainerRow {
  id: string;
  name: string;
  created_at: number;
  discipline: string;
}
interface IndexRow {
  kind: "container" | "folder";
  id: string;
  name: string;
  created_at: number;
  parent_id: string | null;
  sort_order: number;
  discipline: string;
}
interface TreeRef {
  kind: "container" | "folder";
  id: string;
}

interface PrincipalRow {
  id: string;
  kind: string;
  name: string;
  color: string;
  created_at: number;
  origin: string | null;
}

interface ShareRow {
  id: string;
  hash: string;
  container_id: string;
  caps: string;
  origin: string;
  minted_by: string;
  created_at: number;
  revoked_at: number | null;
  grant_id: string | null;
  tickets: number;
}

interface DialRow {
  id: string;
  origin: string;
  secret: string;
  ref: string | null;
  caps: string;
  title: string | null;
  dialed_at: number;
  revoked_at: number | null;
}

interface TicketRow {
  principal_id: string;
}

interface TokenRow {
  id: string;
  hash: string;
  principal_id: string;
  minted_by: string | null;
  caps: string;
  container_id: string | null;
  created_at: number;
  revoked_at: number | null;
  grant_id: string | null;
  expires_at: number | null;
}

interface AgentRow {
  agent_id: string;
  principal_id: string;
  sponsor_principal_id: string;
  name: string;
  purpose: string;
  harness: string;
  grant_json: string;
  context_json: string;
  policy_revision_acknowledged: string | null;
  status: AgentRecord["status"];
  authorization_path: string;
  authorization_credential: string;
  created_at: number;
  updated_at: number;
}

export interface AgentRecord extends Omit<Agent, "state" | "activeRuns"> {
  readonly status: "enabled" | "disabled" | "retired";
  readonly authorizationPath: AgentRunAuthorizationPath;
  readonly authorizationCredential: AgentRunAuthorizationCredential;
}

interface AgentRunRow {
  id: string;
  principal_id: string;
  agent_id: string;
  session_harness: string | null;
  session_id: string | null;
  session_machine_id: string | null;
  model: string | null;
  activity: string;
  root_run_id: string;
  parent_run_id: string | null;
  authorized_by_principal_id: string;
  authorization_path: string;
  authorizer_token_id: string | null;
  authorizer_grant_id: string | null;
  authorizer_caps: string;
  authorizer_container_scope: string | null;
  authorizer_expires_at: number | null;
  purpose: string;
  task_ref: string | null;
  target: string;
  reach: string;
  caps: string;
  created_at: number;
  expires_at: number;
  renewals: number;
  max_depth: number;
  max_descendants: number;
  depth: number;
  cleanup_owner_principal_id: string;
  state: string;
  policy_revision: string;
  acknowledged_policy_revision: string | null;
  cleanup_revoked_credentials: number;
  cleanup_revoked_grants: number;
  finished_at: number | null;
  cleanup_failure: string | null;
}

interface AgentPolicySnapshotRow {
  run_id: string;
  revision: string;
  bundles: string;
  issued_at: number;
  acknowledged_at: number | null;
}

export interface AgentRunRecord {
  readonly id: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly session: SessionRef | null;
  readonly model?: RunModel;
  readonly activity: RunActivity;
  readonly rootRunId: string;
  readonly parentRunId: string | null;
  readonly authorizedByPrincipalId: string;
  readonly authorizationPath: AgentRunAuthorizationPath;
  readonly authorizationCredential: AgentRunAuthorizationCredential;
  readonly purpose: string;
  readonly taskRef?: string;
  readonly target: string;
  readonly reach: GrantReach;
  readonly caps: readonly AgentRunCap[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly renewals: number;
  readonly maxDepth: number;
  readonly maxDescendants: number;
  readonly depth: number;
  readonly cleanupOwnerPrincipalId: string;
  readonly state: AgentRunState;
  readonly policyRevision: string;
  readonly acknowledgedPolicyRevision?: string;
  readonly cleanupRevokedCredentials: number;
  readonly cleanupRevokedGrants: number;
  readonly finishedAt?: number;
  readonly cleanupFailure?: string;
}

export interface AgentPolicySnapshotRecord {
  readonly runId: string;
  readonly revision: string;
  readonly bundles: readonly AgentPolicyBundle[];
  readonly issuedAt: number;
  readonly acknowledgedAt?: number;
}

interface GrantRow {
  id: string;
  principal_kind: string;
  principal_id: string | null;
  node: string;
  caps: string;
  effect: string;
  reach: string;
  created_by: string;
  created_at: number;
  bound: number;
}

interface DocRow {
  container_id: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}

interface MachineRow {
  id: string;
  name: string;
  token_id: string;
  last_seen: number;
  owner_host_id: string | null;
  draining: number;
  last_refusal_code: number | null;
  last_refusal_at: number | null;
}

interface PluginInstallDbRow {
  plugin_id: string;
  sha256: string;
  source: string;
  granted_caps: string;
  installed_by: string;
  installed_at: number;
  bundle_path: string;
  actions: string;
  hardened: number;
  built_against: string | null;
  mode: string;
  installer_credential: string | null;
}

interface MachineAuthRow extends MachineRow {
  hash: string;
  principal_id: string;
  revoked_at: number | null;
}

interface TerminalDbRow {
  id: string;
  machine_id: string;
  container_id: string | null;
  created_by: string;
  agent_principal_id: string | null;
  name: string | null;
  status: string;
  exit_code: number | null;
  created_at: number;
  cwd: string | null;
  launch_recipe: string | null;
  run_id: string | null;
  session: string | null;
}

interface EventDbRow {
  id: number;
  container_id: string | null;
  ts: number;
  principal_id: string | null;
  type: string;
  payload: string;
  /** NULL on every row that is not a trace, which is every row written before schema 14. */
  door: string | null;
  authority: string | null;
  targets: string | null;
  outcome: string | null;
  session: string | null;
}

interface MetaRow {
  value: string;
}

interface ExistsRow {
  found: number;
}

/**
 * Durable token metadata. The raw bearer secret deliberately has no field here.
 *
 * `grantId` is the token's REFERENCE to the grant row carrying its authority (ADR 0011: "a
 * token's caps array is a set of synthesized root grants"). `caps` and `containerId` stay
 * beside it, and that is not duplication: they are what the minter CHOSE, which the mint
 * ladder keeps checking, while the grant row is where the evaluator reads authority from.
 * A token with no caps to express (an enrolled machine's) references nothing.
 */
export interface TokenRecord {
  id: string;
  hash: string;
  principalId: string;
  mintedBy: string | null;
  caps: readonly Cap[];
  containerId: string | null;
  createdAt: number;
  revokedAt: number | null;
  grantId: string | null;
  /**
   * When this credential stops authenticating, or null for one that never does (ADR 0019 §2).
   *
   * NULL is not "unset": it is the standing answer for every non-interactive credential and
   * for every row written before schema 15. The column is read on the hot path — off the row
   * `authenticate` already fetched by hash — and written exactly once, at the mint.
   */
  expiresAt: number | null;
}

/**
 * What one revocation did: the tokens it marked, and the grant rows that died with them.
 *
 * Two numbers rather than one because they answer different callers. `tokens` is the count
 * the revoke door publishes and the fence keys on; `grants` is what the evaluator's memo has
 * to hear about, and a machine credential — caps `[]`, no row — revokes one token and retires
 * nothing, so the second number is not derivable from the first.
 */
export interface TokenRevocation {
  readonly tokens: number;
  readonly grants: number;
}

/**
 * A stored grant, plus the one fact the protocol row cannot carry: whether some TOKEN
 * references it.
 *
 * That flag is the whole attenuation rule of the evaluator. A token-referenced row is the
 * synthesized authority of ONE credential and applies only to the credential that holds it —
 * otherwise a principal's narrow token would inherit its own broad token's row, which is both
 * a parity break against the flat model and a live attenuation hole. An UNREFERENCED row is
 * administered authority: it applies to every credential of the principal or class it names,
 * which is what makes a grant door's allow widen and its deny bite.
 */
export interface GrantRecord extends Grant {
  readonly tokenBound: boolean;
}

/** Latest canonical Yjs document loaded into a room. */
export interface DocRecord {
  containerId: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}

/** Safe identity logged when a corrupt document row is skipped during fallback loading. */
export interface InvalidDoc {
  epoch: string;
  rev: number;
}

/** Persisted machine identity, its last contact time, and its admission state (#278). */
export interface MachineRecord {
  id: string;
  name: string;
  tokenId: string;
  lastSeen: number;
  /**
   * The `terminalHostId` the last ADMITTED hello named — the process that owns this
   * machine's PTYs — or null when that agent was its own owner (pre-v24, or one that named
   * none). Continuity for a newcomer is judged against this when no live socket is there
   * to judge it against.
   */
  ownerHostId: string | null;
  /** The admission latch `core.machines.drain` sets: while true, no new terminal is admitted. */
  draining: boolean;
  /**
   * The latest identifiable hello refused before admission. Null means either no known
   * refusal or a later hello was admitted; only admission clears this durable diagnostic.
   */
  lastRefusal: MachineRefusal | null;
}

/** Machine identity resulting from a hashed-token lookup. */
export interface MachineAuthRecord extends MachineRecord {
  tokenPrincipalId: string;
  revokedAt: number | null;
}

/**
 * One INSTALLED plugin (ADR 0016 §8 stage 2): the artifact a root principal pinned by hash,
 * where they said it came from, the capability set they granted, where the bytes landed, and
 * the doors the assembly published for it when it was admitted. The manifest is NOT here — it
 * is read from `bundlePath` after the file re-hashes to `sha256`, so nothing about a
 * stranger's plugin is ever described from a copy the engine would then have to trust (R8,
 * fail-closed). `actions` is the one thing kept from the admitted load, and it is kept for the
 * boot that fails that re-hash: the row still publishes its doors, from this record rather
 * than from the file, so a dispatch to one is a traced refusal naming why.
 */
export interface PluginInstallRow {
  readonly pluginId: string;
  readonly sha256: string;
  readonly source: string;
  /** The installer's consent, which may name the plugin's own capabilities too (ADR 0035). */
  readonly grantedCaps: readonly AuthoredCap[];
  readonly installedBy: string;
  readonly installedAt: number;
  readonly bundlePath: string;
  readonly actions: readonly ActionSummary[];
  readonly hardened?: boolean;
  readonly builtAgainst?: Readonly<Record<string, string>>;
  /** Who packed the bytes; absent is `bundle` (ADR 0025 §4). */
  readonly mode?: PluginInstallMode;
  /**
   * The installer's non-secret lineage, kept so a lifecycle hook can act under the authority
   * that consented to this row (#514) — the same thing a job keeps about its own requester,
   * and never published: `PluginInstall` on the roster carries `installedBy` and no more.
   * Absent for a row installed before schema 32 and for one the rebuild loop wrote on nobody's
   * behalf; the hook then simply has no job slice.
   */
  readonly installer?: CredentialReference;
}

/**
 * A SHARE this instance hands out: one container, one capability set, one guest origin.
 * Like `TokenRecord`, the raw secret deliberately has no field here — only its hash — and
 * `tickets` is the count of guest identities minted under it, computed by the read rather
 * than kept as a denormalized counter that could drift from the rows it claims to count.
 *
 * `grantId` references the grant row this share's caps became at mint (ADR 0011: "a share is
 * a token minted against a subtree grant at the shared node"). The row names the guest
 * INSTANCE, not any one of its principals, which is why a ticket needs no grant of its own to
 * inherit the share's authority — its principal carries the origin the row names.
 */
export interface ShareRecord {
  id: string;
  hash: string;
  containerId: string;
  caps: readonly Cap[];
  origin: string;
  mintedBy: string;
  createdAt: number;
  revokedAt: number | null;
  grantId: string | null;
  tickets: number;
}

/**
 * The same relationship from the other end: a grant this instance DIALS OUT with. The
 * secret is here in the clear because dialling requires presenting it, which is exactly
 * what a hash cannot do (db.ts migration 12). `ref` and `caps` are the host's last word on
 * what the share names — cached vocabulary this instance draws a row from while the socket
 * is down, and never an authority it evaluates.
 */
export interface DialRecord {
  id: string;
  origin: string;
  secret: string;
  /** NULL only between `createDial` and the host's first welcome; see db.ts migration 12. */
  ref: string | null;
  caps: readonly Cap[];
  title: string | null;
  dialedAt: number;
  revokedAt: number | null;
}

/** Private launch intent, never minted bearer credentials or signed job admission. */
export const TerminalLaunchRecipeSchema = z.strictObject({
  cols: z.number().int().positive().max(1000),
  rows: z.number().int().positive().max(1000),
  cwd: TerminalCwdSchema.optional(),
  env: TerminalEnvSchema,
  program: TerminalProgramSchema.optional(),
  runtime: TerminalRuntimeSchema.optional(),
  elementId: z.string().optional(),
});
export type TerminalLaunchRecipe = z.infer<typeof TerminalLaunchRecipeSchema>;

/** Durable terminal row; geometry/controller remain live broker state by schema. */
export interface StoredTerminal {
  id: string;
  machineId: string;
  /** The container this terminal lives in. Never null: a terminal is `homed: "eager"`. */
  containerId: string;
  createdBy: string;
  agentPrincipalId: string | null;
  name: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
  cwd?: string;
  session?: SessionRef;
  launchRecipe?: TerminalLaunchRecipe;
  runId?: string;
}

/** Input required to persist a newly created terminal. */
export interface NewStoredTerminal {
  id: string;
  machineId: string;
  containerId: string;
  createdBy: string;
  agentPrincipalId: string | null;
  createdAt: number;
  cwd?: string;
  session?: SessionRef;
  launchRecipe?: TerminalLaunchRecipe;
  runId?: string;
  /** Authenticated creation provenance, never a harness launch or restart binding. */
  createdByRunId?: string;
}

/**
 * One row of the journal, camelCased for the wire — an event, a trace, or (before schema 14)
 * an event that predates the distinction.
 *
 * `containerId` and `principalId` are both nullable because both are genuinely optional facts:
 * a token revocation is workspace-wide and belongs to no container, and a system-initiated
 * record belongs to no principal. `payload` is the JSON text exactly as the writer stored it —
 * parsing it is the reader's decision, and a row whose payload cannot be parsed must still be
 * readable as a row.
 *
 * The five trace fields are NULL together or set together: `door` is the discriminator, and a
 * row carrying one carries all (`TraceRecord`). They are on THIS interface rather than on a
 * second row type because a trace is a row in the same journal read back through the same
 * door — one shape, one reader, one retention (axiom A6, ADR 0018).
 *
 * `targets` is the one machine-written, machine-read list here, so unlike `payload` it is
 * published PARSED. A row whose targets text is unreadable still reads as a row with no
 * targets: the reader's contract is that a corrupt column costs the column, never the row.
 */
export interface StoredEvent {
  id: number;
  containerId: string | null;
  ts: number;
  principalId: string | null;
  type: string;
  payload: string;
  door: string | null;
  authority: string | null;
  targets: readonly string[];
  outcome: string | null;
  session: string | null;
}

/**
 * THE `type` EVERY TRACE ROW CARRIES, so `core.events.list({ kind: "trace" })` is the ledger
 * and nothing else has to be inferred from a NULL check. The door is a column of its own
 * because a reader filtering the ledger asks for the family first and the door second.
 */
export const TRACE_ROW_TYPE = "trace";

/**
 * What the dispatch ladder knows BEFORE it invokes a handler: the whole attribution of an
 * exercise of authority. Everything here is decided by the door and the credential, so none of
 * it can be changed by what the handler then does — which is exactly why it is written first
 * (ADR 0018 §3, write-ahead).
 */
export interface TraceAttribution {
  readonly ts: number;
  /** The acting principal. Never null: a dispatch always has an authenticated actor. */
  readonly actor: string;
  /** The capability set discharged, `root`, or `open` (`TRACE_AUTHORITY_*`). */
  readonly authority: string;
  /** The full action name — the door, as the roster publishes it. */
  readonly door: string;
  /** The container the exercise belongs to, when one is knowable before arguments parse. */
  readonly containerId: string | null;
  /** The arguments as received, redacted and bounded; never a secret, never terminal bytes. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The session channel the dispatch arrived on; null means the HTTP action door. */
  readonly session: string | null;
  /** Credential-specific run attribution; principal identity alone is no longer unique. */
  readonly runId?: string;
  readonly credentialId?: string;
}

/** An attribution plus how it ended: the settled row a reader sees. */
export interface TraceRecord extends TraceAttribution {
  readonly outcome: TraceOutcome | null;
  readonly targets: readonly string[];
}

/** What a caller may narrow the audit trail by. Omitting a field asks for everything. */
export interface EventFilter {
  readonly containerId?: string;
  readonly type?: string;
  readonly limit: number;
}

/**
 * A trace's targets, read defensively. The column has exactly ONE producer — the dispatch
 * ladder, serializing formatted `manifold://` URIs — so unlike `payload` it is published
 * parsed; and because the trail's contract is that a row always reads as a row, a column that
 * cannot be read costs the targets rather than the record of what happened.
 */
function parseTargets(raw: string | null): readonly string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

/** SHA-256 hex encoding used for bearer secrets and document integrity hashes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toToken(row: TokenRow): TokenRecord {
  const caps = parseCaps(row.caps);
  return {
    id: row.id,
    hash: row.hash,
    principalId: row.principal_id,
    mintedBy: row.minted_by,
    caps,
    containerId: row.container_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id,
    expiresAt: row.expires_at,
  };
}

const AGENT_SELECT = `SELECT agent_id,principal_id,sponsor_principal_id,name,purpose,harness,
  grant_json,context_json,policy_revision_acknowledged,status,authorization_path,
  authorization_credential,created_at,updated_at FROM agents`;

const AGENT_RUN_SELECT = `SELECT id,principal_id,agent_id,
  session_harness,session_id,session_machine_id,model,activity,
  root_run_id,parent_run_id,authorized_by_principal_id,
  authorization_path,authorizer_token_id,authorizer_grant_id,authorizer_caps,
  authorizer_container_scope,authorizer_expires_at,purpose,task_ref,target,reach,caps,
  created_at,expires_at,renewals,max_depth,max_descendants,depth,
  cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,
  cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure FROM agent_runs`;

const StoredAgentSchema = AgentSchema.omit({ state: true, activeRuns: true });

function toAgent(row: AgentRow): AgentRecord {
  const agent = StoredAgentSchema.parse({
    agentId: row.agent_id,
    principalId: row.principal_id,
    sponsorPrincipalId: row.sponsor_principal_id,
    name: row.name,
    purpose: row.purpose,
    harness: row.harness,
    grant: JSON.parse(row.grant_json),
    context: JSON.parse(row.context_json),
    ...(row.policy_revision_acknowledged === null
      ? {}
      : { policyRevisionAcknowledged: row.policy_revision_acknowledged }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return {
    ...agent,
    status: row.status,
    authorizationPath: AgentRunAuthorizationPathSchema.parse(row.authorization_path),
    authorizationCredential: AgentRunAuthorizationCredentialSchema.parse(
      JSON.parse(row.authorization_credential),
    ),
  };
}

function toAgentRun(row: AgentRunRow): AgentRunRecord {
  return {
    id: row.id,
    principalId: row.principal_id,
    agentId: row.agent_id,
    session:
      row.session_harness === null && row.session_id === null && row.session_machine_id === null
        ? null
        : SessionRefSchema.parse({
            harness: row.session_harness,
            sessionId: row.session_id,
            machineId: row.session_machine_id,
          }),
    ...(row.model === null ? {} : { model: RunModelSchema.parse(JSON.parse(row.model)) }),
    activity: RunActivitySchema.parse(row.activity),
    rootRunId: row.root_run_id,
    parentRunId: row.parent_run_id,
    authorizedByPrincipalId: row.authorized_by_principal_id,
    authorizationPath: AgentRunAuthorizationPathSchema.parse(row.authorization_path),
    authorizationCredential: {
      tokenId: row.authorizer_token_id,
      grantId: row.authorizer_grant_id,
      caps: CapSchema.array().parse(JSON.parse(row.authorizer_caps)),
      containerScope: row.authorizer_container_scope,
      ...(row.authorizer_expires_at === null ? {} : { expiresAt: row.authorizer_expires_at }),
    },
    purpose: row.purpose,
    ...(row.task_ref === null ? {} : { taskRef: row.task_ref }),
    target: GrantNodeSchema.parse(row.target),
    reach: GrantReachSchema.parse(row.reach),
    caps: AgentRunCapSchema.array().parse(JSON.parse(row.caps)),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    renewals: row.renewals,
    maxDepth: row.max_depth,
    maxDescendants: row.max_descendants,
    depth: row.depth,
    cleanupOwnerPrincipalId: row.cleanup_owner_principal_id,
    state: AgentRunStateSchema.parse(row.state),
    policyRevision: row.policy_revision,
    ...(row.acknowledged_policy_revision === null
      ? {}
      : { acknowledgedPolicyRevision: row.acknowledged_policy_revision }),
    cleanupRevokedCredentials: row.cleanup_revoked_credentials,
    cleanupRevokedGrants: row.cleanup_revoked_grants,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.cleanup_failure === null ? {} : { cleanupFailure: row.cleanup_failure }),
  };
}

function toAgentPolicySnapshot(row: AgentPolicySnapshotRow): AgentPolicySnapshotRecord {
  return {
    runId: row.run_id,
    revision: row.revision,
    bundles: AgentPolicyBundleSchema.array().parse(JSON.parse(row.bundles)),
    issuedAt: row.issued_at,
    ...(row.acknowledged_at === null ? {} : { acknowledgedAt: row.acknowledged_at }),
  };
}

/** A CREDENTIAL's caps: a token, a share and a dial carry the engine's vocabulary only. */
function parseCaps(raw: string): readonly Cap[] {
  const parsed: unknown = JSON.parse(raw);
  return CapSchema.array().parse(parsed);
}

/**
 * An INSTALL's granted caps, which are read over the open vocabulary (ADR 0035): an installer
 * consents to what the manifest declared, and a manifest may declare the plugin's own
 * namespaced capabilities beside the engine's.
 */
function parseAuthoredCaps(raw: string): readonly AuthoredCap[] {
  const parsed: unknown = JSON.parse(raw);
  return AuthoredCapSchema.array().parse(parsed);
}

function parseActions(raw: string): readonly ActionSummary[] {
  const parsed: unknown = JSON.parse(raw);
  return ActionSummarySchema.array().parse(parsed);
}

/**
 * A NULL `origin` column means "this instance", and the wire says that by OMITTING the key
 * rather than by carrying a null: `PrincipalSchema` is strict and there is one
 * representation of local. The database keeps a nullable column because SQL has no third
 * way to say absent, and this function is the one place the two spellings meet.
 */
function toPrincipal(row: PrincipalRow): Principal {
  return PrincipalSchema.parse(
    row.origin === null
      ? { id: row.id, kind: row.kind, name: row.name, color: row.color }
      : { id: row.id, kind: row.kind, name: row.name, color: row.color, origin: row.origin },
  );
}

function toShare(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    hash: row.hash,
    containerId: row.container_id,
    caps: parseCaps(row.caps),
    origin: row.origin,
    mintedBy: row.minted_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id,
    tickets: row.tickets,
  };
}

/**
 * The three-column principal — kind, plus an id whose meaning the kind selects — read back as
 * the discriminated union the protocol defines. A class row carries no id at all, and a bad
 * combination is a THROW rather than a silent narrowing: an authority row this reader could not
 * classify would otherwise be dropped from a walk, which is a denial nobody wrote.
 */
function toGrant(row: GrantRow): GrantRecord {
  const principal =
    row.principal_kind === "instance"
      ? { kind: "instance", origin: row.principal_id }
      : row.principal_kind === "principal"
        ? { kind: "principal", id: row.principal_id }
        : { kind: row.principal_kind };
  return {
    ...GrantSchema.parse({
      id: row.id,
      principal,
      node: row.node,
      caps: JSON.parse(row.caps),
      effect: row.effect,
      reach: row.reach,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }),
    tokenBound: row.bound === 1,
  };
}

/**
 * `bound` is the token reference seen from the grant's side, and it is an EXISTS rather than a
 * join so a row can never be duplicated by the credentials that hold it.
 */
const GRANT_SELECT = `SELECT g.id, g.principal_kind, g.principal_id, g.node, g.caps, g.effect,
          g.reach, g.created_by, g.created_at,
          EXISTS(SELECT 1 FROM tokens t WHERE t.grant_id = g.id) AS bound
   FROM grants g`;

function toDial(row: DialRow): DialRecord {
  return {
    id: row.id,
    origin: row.origin,
    secret: row.secret,
    ref: row.ref,
    caps: parseCaps(row.caps),
    title: row.title,
    dialedAt: row.dialed_at,
    revokedAt: row.revoked_at,
  };
}

const SHARE_SELECT = `SELECT s.id, s.hash, s.container_id, s.caps, s.origin, s.minted_by,
          s.created_at, s.revoked_at, s.grant_id,
          (SELECT COUNT(*) FROM share_tickets t WHERE t.share_id = s.id) AS tickets
   FROM shares s`;

const DIAL_SELECT = `SELECT id, origin, secret, ref, caps, title, dialed_at, revoked_at
   FROM dials`;

function toMachine(row: MachineRow): MachineRecord {
  return {
    id: row.id,
    name: row.name,
    tokenId: row.token_id,
    lastSeen: row.last_seen,
    ownerHostId: row.owner_host_id,
    draining: row.draining !== 0,
    lastRefusal:
      row.last_refusal_code === null || row.last_refusal_at === null
        ? null
        : {
            code: row.last_refusal_code as MachineRefusal["code"],
            at: row.last_refusal_at,
          },
  };
}

const MACHINE_SELECT =
  "SELECT id, name, token_id, last_seen, owner_host_id, draining, last_refusal_code, last_refusal_at FROM machines";

function toPluginInstall(row: PluginInstallDbRow): PluginInstallRow {
  return {
    pluginId: row.plugin_id,
    sha256: row.sha256,
    source: row.source,
    grantedCaps: parseAuthoredCaps(row.granted_caps),
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    bundlePath: row.bundle_path,
    actions: parseActions(row.actions),
    hardened: row.hardened !== 0,
    ...(row.built_against === null
      ? {}
      : { builtAgainst: z.record(z.string(), z.string()).parse(JSON.parse(row.built_against)) }),
    ...(row.mode === "unpacked" ? { mode: "unpacked" as const } : {}),
    ...(row.installer_credential === null
      ? {}
      : { installer: JobCredentialSchema.parse(JSON.parse(row.installer_credential)) }),
  };
}

const PLUGIN_INSTALL_SELECT = `SELECT plugin_id, sha256, source, granted_caps, installed_by,
   installed_at, bundle_path, actions, hardened, built_against, mode, installer_credential
   FROM plugin_installs`;

/**
 * A container row is the whole object: `discipline` names which renderer it asks for.
 * There is no lifecycle flag beside it any more — nothing dissolves under anybody, so
 * there is nothing to mark as provisional and no return address to remember.
 *
 * The discipline is validated for SHAPE and never for membership (#110). It used to be
 * checked against the two-value enum, which meant a row written by a plugin this build no
 * longer composes could not be READ AT ALL — the index throwing rather than the container
 * rendering a placeholder, which is exactly the crash the open roster ruled out. Whether a
 * discipline is one anybody here can render is the live roster's question, answered by a
 * named refusal or an engine-owned placeholder at the surfaces that ask it; the store's
 * question is only whether the row is a legible discipline id.
 */
function toContainer(row: {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly discipline: string;
}): Container {
  const discipline = ContainerDisciplineSchema.safeParse(row.discipline);
  if (!discipline.success) {
    throw new Error(`invalid persisted container discipline: ${row.discipline}`);
  }
  return { id: row.id, name: row.name, createdAt: row.created_at, discipline: discipline.data };
}

function toTerminal(row: TerminalDbRow): StoredTerminal {
  if (row.status !== "running" && row.status !== "exited") {
    throw new Error(`invalid persisted terminal status: ${row.status}`);
  }
  if (row.container_id === null) {
    // Migration 9 gave every terminal a home and nothing since can take it away: a terminal
    // is deleted, never unbound. A null here means a write went around the broker.
    throw new Error(`terminal ${row.id} has no home composition`);
  }
  const session = row.session === null ? undefined : SessionRefSchema.parse(JSON.parse(row.session));
  if (session !== undefined && session.machineId !== row.machine_id)
    throw new Error(`terminal ${row.id} session machine does not match`);
  return {
    id: row.id,
    machineId: row.machine_id,
    containerId: row.container_id,
    createdBy: row.created_by,
    agentPrincipalId: row.agent_principal_id,
    name: row.name,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(session === undefined ? {} : { session }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.launch_recipe === null
      ? {}
      : { launchRecipe: TerminalLaunchRecipeSchema.parse(JSON.parse(row.launch_recipe)) }),
  };
}

/** A private migration draft; publication is synchronous with the caller's native metadata. */
export interface PluginMigrationSession {
  readonly storage: PluginStorageAdmin;
  commit(publish?: () => void): void;
  discard(): void;
}

/** Fingerprints name closed SQLite images, never paths supplied by a plugin. */
export interface PluginDatabaseJournal {
  readonly plugin_id: string;
  readonly phase: "prepared" | "committed";
  readonly previous: string | null;
  readonly next: string | null;
}

/** Synchronous repository over the server-owned SQLite schema. */
export class ServerStore {
  private readonly eventCountByContainer = new Map<string, number>();
  /** Null until first counted; the container-less bucket's size, cached like the others. */
  private workspaceEventCount: number | null = null;
  private readonly commitEffects: Array<() => void> = [];
  private transactionDepth = 0;

  constructor(readonly db: Database) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS events_by_timestamp ON events(ts);
      CREATE INDEX IF NOT EXISTS events_by_container_recency
        ON events(container_id, ts DESC, id DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    const firstEffect = this.commitEffects.length;
    this.transactionDepth++;
    let result: T;
    try {
      result = this.db.transaction(operation)();
    } catch (error) {
      this.commitEffects.length = firstEffect;
      throw error;
    } finally {
      this.transactionDepth--;
    }
    if (this.transactionDepth === 0 && this.commitEffects.length > 0) {
      const effects = this.commitEffects.splice(0);
      for (const effect of effects) effect();
    }
    return result;
  }

  /** Nested transactions may announce committed state only after the outer commit succeeds. */
  afterCommit(effect: () => void): void {
    if (this.transactionDepth > 0) this.commitEffects.push(effect);
    else effect();
  }

  getMeta(key: string): string | null {
    return (
      this.db.query<MetaRow, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ??
      null
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .query<void, [string, string]>("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * Which plugins an administrator turned off, workspace-globally. Stored as the DISABLED
   * set rather than the enabled one so a plugin that ships later is on by default and no
   * write is owed when the assembly grows. A corrupt row reads as "nothing disabled":
   * the alternative is a workspace that boots with every plugin dark because one meta value
   * lost its brackets.
   */
  disabledPlugins(): ReadonlySet<string> {
    const parsed = DisabledPluginsSchema.safeParse(
      readJsonMeta(this.getMeta(PLUGINS_DISABLED_META)),
    );
    return new Set(parsed.success ? parsed.data : []);
  }

  /**
   * Flips one plugin, and records WHO and WHEN. Attribution is workspace-global shared
   * state like the flag itself: "the machines section vanished" is a question every
   * principal in the workspace can now answer without reading a log they cannot see.
   */
  setPluginEnabled(id: string, enabled: boolean, changedBy: string, changedAt: number): void {
    const disabled = new Set(this.disabledPlugins());
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.setMeta(PLUGINS_DISABLED_META, JSON.stringify([...disabled].sort()));
    const attribution = new Map(this.pluginAttribution());
    attribution.set(id, { by: changedBy, at: changedAt });
    this.setMeta(
      PLUGINS_ATTRIBUTION_META,
      JSON.stringify(
        Object.fromEntries([...attribution].sort(([left], [right]) => (left < right ? -1 : 1))),
      ),
    );
  }

  /**
   * Forgets everything the enablement meta knows about one id: its place in the disabled
   * set and its attribution. The uninstall door's hands — the row the switch belonged to is
   * gone, and a later install of the same id is a fresh row, on by default and flipped by
   * nobody, exactly like a first install. Without this an id switched off to be uninstalled
   * came back off, its child spawned for a door that answered `plugin_disabled`.
   */
  clearPluginEnablement(id: string): void {
    const disabled = new Set(this.disabledPlugins());
    const attribution = new Map(this.pluginAttribution());
    const forgotten = disabled.delete(id);
    if (!attribution.delete(id) && !forgotten) return;
    this.setMeta(PLUGINS_DISABLED_META, JSON.stringify([...disabled].sort()));
    this.setMeta(
      PLUGINS_ATTRIBUTION_META,
      JSON.stringify(
        Object.fromEntries([...attribution].sort(([left], [right]) => (left < right ? -1 : 1))),
      ),
    );
  }

  /**
   * The developer-mode switch (ADR 0025 §4), one workspace-global meta row like the disabled
   * set: off until somebody turns it on, and read fresh at every assembly so the roster's
   * `developer_mode_off` marks are always the switch's current word.
   */
  developerMode(): boolean {
    return this.getMeta(DEVELOPER_MODE_META) === "1";
  }

  setDeveloperMode(on: boolean): void {
    this.setMeta(DEVELOPER_MODE_META, on ? "1" : "0");
  }

  /** Who last flipped each plugin, and when. A corrupt row reads as "nobody knows". */
  pluginAttribution(): ReadonlyMap<string, PluginAttribution> {
    const parsed = AttributionSchema.safeParse(
      readJsonMeta(this.getMeta(PLUGINS_ATTRIBUTION_META)),
    );
    return new Map(Object.entries(parsed.success ? parsed.data : {}));
  }

  /**
   * ELEMENT-TYPE RESERVATIONS — wire type → the plugin that claimed it. A tombstone, not a
   * cache: it survives the owner being disabled, going dormant, or leaving the build, because
   * the documents that stored `type: "draw"` survive all three. Assembly refuses a
   * different plugin claiming a reserved type, so a canvas full of one plugin's elements can
   * never be silently reinterpreted by whatever ships next under that name.
   */
  elementOwners(): ReadonlyMap<string, string> {
    const parsed = ElementOwnersSchema.safeParse(readJsonMeta(this.getMeta(ELEMENT_OWNERS_META)));
    return new Map(Object.entries(parsed.success ? parsed.data : {}));
  }

  /** Claims unreserved types for `pluginId`; existing reservations are left alone. */
  claimElementTypes(pluginId: string, types: readonly string[]): void {
    const owners = new Map(this.elementOwners());
    let changed = false;
    for (const type of types) {
      if (owners.has(type)) continue;
      owners.set(type, pluginId);
      changed = true;
    }
    if (!changed) return;
    this.writeElementOwners(owners);
  }

  /** Releases every reservation held by `pluginId` — the purge verb's hands, and only its. */
  releaseElementTypes(pluginId: string): number {
    const owners = new Map(this.elementOwners());
    let released = 0;
    for (const [type, owner] of owners) {
      if (owner !== pluginId) continue;
      owners.delete(type);
      released += 1;
    }
    if (released > 0) this.writeElementOwners(owners);
    return released;
  }

  private writeElementOwners(owners: ReadonlyMap<string, string>): void {
    this.setMeta(
      ELEMENT_OWNERS_META,
      JSON.stringify(
        Object.fromEntries([...owners].sort(([left], [right]) => (left < right ? -1 : 1))),
      ),
    );
  }

  /**
   * PER-PLUGIN STORAGE, bound to one plugin id. The engine hands this to a plugin as
   * `ctx.storage`; the plugin sees a namespaced key-value store and never the database,
   * so two plugins cannot read each other's rows and a purge erases exactly one namespace.
   *
   * Returned as the ADMIN handle. `PluginHost` keeps that and hands plugins the narrower
   * `PluginStorage` view, whose writes refuse the engine's reserved keys — a plugin cannot
   * forge its own data version or a ledger entry saying a migration already ran.
   *
   * Every method is promise-returning (ADR 0016 §4) and synchronous inside: the SQLite call
   * runs before the promise is handed back, so the promise is already settled and a refused
   * key or value is a rejection rather than a throw. No queue, no async driver — the ordering
   * a caller reads off its own statements is the ordering the database saw.
   */
  pluginStorage(pluginId: string): PluginStorageAdmin {
    return this.storageHandle(pluginId);
  }

  pluginDatabaseJournals(): readonly PluginDatabaseJournal[] {
    return this.db
      .query<PluginDatabaseJournal, []>(
        "SELECT plugin_id, phase, previous, next FROM plugin_database_journal ORDER BY plugin_id",
      )
      .all();
  }

  pluginDatabaseJournal(pluginId: string): PluginDatabaseJournal | null {
    return this.db
      .query<PluginDatabaseJournal, [string]>(
        "SELECT plugin_id, phase, previous, next FROM plugin_database_journal WHERE plugin_id = ?",
      )
      .get(pluginId);
  }

  preparePluginDatabase(journal: Omit<PluginDatabaseJournal, "phase">): void {
    this.db
      .query(
        "INSERT INTO plugin_database_journal(plugin_id, phase, previous, next) VALUES (?, 'prepared', ?, ?)",
      )
      .run(journal.plugin_id, journal.previous, journal.next);
  }

  /** Called only inside the KV/ledger/install publication transaction. */
  commitPluginDatabase(pluginId: string): void {
    const result = this.db
      .query(
        "UPDATE plugin_database_journal SET phase = 'committed' WHERE plugin_id = ? AND phase = 'prepared'",
      )
      .run(pluginId);
    if (result.changes !== 1) throw new Error("plugin database has no prepared image");
  }

  forgetPluginDatabase(pluginId: string): void {
    this.db.query("DELETE FROM plugin_database_journal WHERE plugin_id = ?").run(pluginId);
  }

  /**
   * Private bounded KV snapshot. No SQLite transaction survives an await. The host drains
   * this plugin first, then publishes its changes and ledger in one synchronous transaction.
   * A conflict (including a retained old storage handle writing in the meantime) aborts.
   */
  beginPluginMigration(pluginId: string, includeData = true): PluginMigrationSession {
    const snapshot = (): Map<string, string> => {
      const rows = new Map<string, string>();
      let bytes = 0;
      const query = includeData
        ? "SELECT key, value FROM plugin_kv WHERE plugin_id = ? ORDER BY key"
        : "SELECT key, value FROM plugin_kv WHERE plugin_id = ? AND key LIKE '$%' ORDER BY key";
      for (const row of this.db
        .query<{ key: string; value: string }, [string]>(query)
        .iterate(pluginId)) {
        bytes += Buffer.byteLength(row.key) + Buffer.byteLength(row.value);
        if (rows.size >= 4096 || bytes > 16 * 1024 * 1024)
          throw new Error("plugin migration exceeds the 4096 row / 16 MiB staging bound");
        rows.set(row.key, row.value);
      }
      return rows;
    };
    const before = snapshot();
    const rows = new Map(before);
    let open = true;
    let operations = 0;
    let bytes = 0;
    for (const [key, value] of rows) bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    const assertOpen = (): void => {
      if (!open) throw new Error("plugin migration storage is closed");
      if (++operations > MAX_MIGRATION_STORAGE_OPERATIONS) {
        open = false;
        throw new Error("plugin migration exceeded its storage operation budget");
      }
    };
    const draft = {
      rows,
      assertOpen,
      write: (key: string, value: string): void => {
        assertOpen();
        const previous = rows.get(key);
        const nextBytes =
          bytes +
          Buffer.byteLength(value) -
          (previous === undefined ? -Buffer.byteLength(key) : Buffer.byteLength(previous));
        if ((previous === undefined && rows.size >= 4096) || nextBytes > 16 * 1024 * 1024)
          throw new Error("plugin migration exceeds the 4096 row / 16 MiB staging bound");
        rows.set(key, value);
        bytes = nextBytes;
      },
      drop: (key: string): void => {
        assertOpen();
        const previous = rows.get(key);
        if (previous !== undefined) bytes -= Buffer.byteLength(key) + Buffer.byteLength(previous);
        rows.delete(key);
      },
    };
    return {
      storage: this.storageHandle(pluginId, draft),
      discard: () => {
        open = false;
      },
      commit: (publish) => {
        assertOpen();
        open = false;
        this.transaction(() => {
          const current = snapshot();
          if (current.size !== before.size)
            throw new Error("plugin storage changed while migration was staged");
          for (const [key, value] of before)
            if (current.get(key) !== value)
              throw new Error("plugin storage changed while migration was staged");
          const write = this.db.query<void, [string, string, string]>(
            "INSERT OR REPLACE INTO plugin_kv(plugin_id, key, value) VALUES (?, ?, ?)",
          );
          const drop = this.db.query<void, [string, string]>(
            "DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?",
          );
          for (const key of before.keys()) if (!rows.has(key)) drop.run(pluginId, key);
          for (const [key, value] of rows)
            if (before.get(key) !== value) write.run(pluginId, key, value);
          publish?.();
        });
      },
    };
  }

  private storageHandle(
    pluginId: string,
    draft?: {
      readonly rows: Map<string, string>;
      assertOpen(): void;
      write(key: string, value: string): void;
      drop(key: string): void;
    },
  ): PluginStorageAdmin {
    const read = (key: string): string | null => {
      if (draft !== undefined) {
        draft.assertOpen();
        return draft.rows.get(key) ?? null;
      }
      return (
        this.db
          .query<PluginKvRow, [string, string]>(
            "SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?",
          )
          .get(pluginId, key)?.value ?? null
      );
    };
    const write = (key: string, value: string): void => {
      if (draft !== undefined) return draft.write(key, value);
      this.db
        .query<void, [string, string, string]>(
          "INSERT OR REPLACE INTO plugin_kv(plugin_id, key, value) VALUES (?, ?, ?)",
        )
        .run(pluginId, key, value);
    };
    const drop = (key: string): void => {
      if (draft !== undefined) return draft.drop(key);
      this.db
        .query<void, [string, string]>("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?")
        .run(pluginId, key);
    };
    const scan = (prefix: string): readonly string[] => {
      if (draft !== undefined) {
        draft.assertOpen();
        return [...draft.rows.keys()].filter((key) => key.startsWith(prefix)).sort();
      }
      return this.db
        .query<PluginKvKeyRow, [string, string]>(
          "SELECT key FROM plugin_kv WHERE plugin_id = ? AND key LIKE ? || '%' ORDER BY key",
        )
        .all(pluginId, prefix)
        .map((row) => row.key);
    };
    const total = (): number => {
      if (draft !== undefined) {
        draft.assertOpen();
        return draft.rows.size;
      }
      return (
        this.db
          .query<PluginKvCountRow, [string]>(
            "SELECT count(*) AS total FROM plugin_kv WHERE plugin_id = ?",
          )
          .get(pluginId)?.total ?? 0
      );
    };
    return {
      pluginId,
      get: async (key) => read(key),
      set: async (key, value) => {
        assertStorageKey(key);
        assertStorageValue(key, value);
        write(key, value);
      },
      compareAndSet: async (key, expected, value) => {
        assertStorageKey(key);
        if (expected !== null) assertStorageValue(key, expected);
        assertStorageValue(key, value);
        if (draft !== undefined) {
          if (read(key) !== expected) return false;
          write(key, value);
          return true;
        }
        // Each condition and write is one SQLite statement, including competing creators.
        // Never split the comparison from the mutation across awaited storage calls.
        if (expected === null) {
          return (
            this.db
              .query<void, [string, string, string]>(
                "INSERT INTO plugin_kv(plugin_id, key, value) VALUES (?, ?, ?) ON CONFLICT(plugin_id, key) DO NOTHING",
              )
              .run(pluginId, key, value).changes === 1
          );
        }
        return (
          this.db
            .query<void, [string, string, string, string]>(
              "UPDATE plugin_kv SET value = ? WHERE plugin_id = ? AND key = ? AND value = ? COLLATE BINARY",
            )
            .run(value, pluginId, key, expected).changes === 1
        );
      },
      delete: async (key) => {
        assertStorageKey(key);
        drop(key);
      },
      // A plugin's own keys only: the engine's reserved rows are not part of the keyspace it
      // iterates, or every `keys()` consumer would have to learn to skip them.
      keys: async (prefix) =>
        scan(prefix ?? "").filter((key) => !key.startsWith(RESERVED_KEY_PREFIX)),
      dataVersion: async () => {
        const raw = read(DATA_VERSION_KEY);
        return raw === null ? null : parseDataVersion(raw);
      },
      appliedMigrations: async () =>
        scan(MIGRATION_KEY_PREFIX).map((key) => key.slice(MIGRATION_KEY_PREFIX.length)),
      stampDataVersion: async (version) => {
        write(DATA_VERSION_KEY, formatDataVersion(version));
      },
      recordMigration: async (name, applied) => {
        write(`${MIGRATION_KEY_PREFIX}${name}`, String(applied));
      },
      count: async () => total(),
      clear: async () => {
        const removed = total();
        if (draft !== undefined) {
          for (const key of draft.rows.keys()) draft.drop(key);
          return removed;
        }
        this.db.query<void, [string]>("DELETE FROM plugin_kv WHERE plugin_id = ?").run(pluginId);
        return removed;
      },
    };
  }

  /** Every installed plugin, in a stable order: what the host re-verifies and loads at boot. */
  pluginInstalls(): PluginInstallRow[] {
    return this.db
      .query<PluginInstallDbRow, []>(`${PLUGIN_INSTALL_SELECT} ORDER BY plugin_id`)
      .all()
      .map(toPluginInstall);
  }

  /**
   * Records an install, or REPLACES one: an upgrade is the same id at a new hash, and the row is
   * that id's one description, so it is written whole rather than patched column by column.
   */
  putPluginInstall(row: PluginInstallRow): void {
    this.db
      .query<
        void,
        [
          string,
          string,
          string,
          string,
          string,
          number,
          string,
          string,
          number,
          string | null,
          string,
          string | null,
        ]
      >(
        `INSERT OR REPLACE INTO plugin_installs(
           plugin_id, sha256, source, granted_caps, installed_by, installed_at, bundle_path,
           actions, hardened, built_against, mode, installer_credential
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.pluginId,
        row.sha256,
        row.source,
        JSON.stringify(row.grantedCaps),
        row.installedBy,
        row.installedAt,
        row.bundlePath,
        JSON.stringify(row.actions),
        row.hardened === true ? 1 : 0,
        row.builtAgainst === undefined ? null : JSON.stringify(row.builtAgainst),
        row.mode ?? "bundle",
        row.installer === undefined ? null : JSON.stringify(row.installer),
      );
  }

  /** Forgets an install. The plugin's storage namespace is untouched: that is `purge`'s. */
  deletePluginInstall(pluginId: string): boolean {
    return (
      this.db.query<void, [string]>("DELETE FROM plugin_installs WHERE plugin_id = ?").run(pluginId)
        .changes > 0
    );
  }

  /**
   * One principal's workspace tree — the shell itself, as a tile composition. Null means
   * "never written", which the door answers with the default layout; an unreadable or
   * structurally invalid stored tree ALSO reads as null, because a principal whose stored
   * shell went bad must get a working workspace back rather than a blank screen.
   */
  workspaceLayout(principalId: string): TileLayout | null {
    const raw = this.getMeta(`layout:${principalId}`);
    if (raw === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = TileLayoutSchema.safeParse(decoded);
    if (!parsed.success || !validateTileLayout(parsed.data)) return null;
    return parsed.data;
  }

  /** Refuses to persist a tree the reader would then have to reject. */
  setWorkspaceLayout(principalId: string, layout: TileLayout): void {
    const parsed = TileLayoutSchema.parse(layout);
    if (!validateTileLayout(parsed)) {
      throw new Error("workspace layout is not a valid tile tree");
    }
    this.setMeta(`layout:${principalId}`, JSON.stringify(parsed));
  }

  /**
   * One principal's KEY OVERRIDES — the rebindings they have made, as binding id → key. The
   * empty map means "nothing rebound", and so does an unreadable or schema-invalid stored value:
   * a principal whose stored deltas went bad must get their plugins' declared keys back rather
   * than a workspace that refuses to compose (the same recovery reading `workspaceLayout` gives
   * a broken tree).
   *
   * Stored as ONE meta row per principal rather than a row per binding, for the reason the
   * layout is one row: a rebinding is a delta over a table the SERVER cannot see — the key
   * registry is browser-side registration data — so this store keeps the map opaque and the
   * meaning is applied at the one composition seam (`composeBindings`).
   */
  bindingOverrides(principalId: string): BindingOverrides {
    const raw = this.getMeta(`bindings:${principalId}`);
    if (raw === null) return {};
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return {};
    }
    const parsed = BindingOverridesSchema.safeParse(decoded);
    return parsed.success ? parsed.data : {};
  }

  /**
   * Writes one principal's whole override map, validated, with the keys sorted — a stored map
   * whose iteration order depended on write order would make two servers with the same deltas
   * serve two different JSON bodies, and this row is read by an engine that applies overrides in
   * a defined order.
   */
  setBindingOverrides(principalId: string, overrides: BindingOverrides): void {
    const parsed = BindingOverridesSchema.parse(overrides);
    const sorted = Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => (left < right ? -1 : 1)),
    );
    this.setMeta(`bindings:${principalId}`, JSON.stringify(sorted));
  }

  /**
   * One principal's PLUGIN SETTING VALUES — the preferences they have expressed, as setting ref
   * → value. Read exactly as `bindingOverrides` is, degradation included: an unreadable or
   * schema-invalid stored value answers the empty map, because a principal whose stored deltas
   * went bad must get their plugins' shipped defaults back rather than a sidebar that refuses
   * to compose.
   *
   * ONE meta row per principal, for the reason the rebindings are one row: a value is a delta
   * over declarations the STORE cannot see — the manifest vocabulary is the assembly's — so
   * this keeps the map opaque and the meaning is applied at the one composition seam
   * (`composeSettings`).
   */
  pluginSettings(principalId: string): PluginSettingValues {
    const raw = this.getMeta(`settings:${principalId}`);
    if (raw === null) return {};
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return {};
    }
    const parsed = PluginSettingValuesSchema.safeParse(decoded);
    return parsed.success ? parsed.data : {};
  }

  /** Writes one principal's whole value map, validated and key-sorted (`setBindingOverrides`). */
  setPluginSettings(principalId: string, values: PluginSettingValues): void {
    const parsed = PluginSettingValuesSchema.parse(values);
    const sorted = Object.fromEntries(
      Object.entries(parsed).sort(([left], [right]) => (left < right ? -1 : 1)),
    );
    this.setMeta(`settings:${principalId}`, JSON.stringify(sorted));
  }

  /** Workspace settings have one durable row per declared ref, independent of principals. */
  workspacePluginSetting(ref: string): boolean | string | undefined {
    const raw = this.getMeta(`workspace-setting:${ref}`);
    return raw === null ? undefined : (JSON.parse(raw) as boolean | string);
  }

  setWorkspacePluginSetting(ref: string, value: boolean | string | null): void {
    if (value === null)
      this.db.query("DELETE FROM meta WHERE key = ?").run(`workspace-setting:${ref}`);
    else this.setMeta(`workspace-setting:${ref}`, JSON.stringify(value));
  }

  effectivePluginSettings(
    principalId: string,
    workspaceRefs: readonly string[],
  ): PluginSettingValues {
    const values = this.pluginSettings(principalId);
    for (const ref of workspaceRefs) {
      delete values[ref as keyof PluginSettingValues];
      const value = this.workspacePluginSetting(ref);
      if (value !== undefined) values[ref as keyof PluginSettingValues] = value;
    }
    return values;
  }

  listIndex(): IndexEntry[] {
    return this.db
      .query<IndexRow, []>(
        `SELECT kind, id, name, created_at, parent_id, sort_order, discipline
         FROM (
           SELECT 'container' AS kind, id, name, created_at, folder_id AS parent_id, sort_order,
                  discipline
           FROM containers
           UNION ALL
           SELECT 'folder' AS kind, id, name, created_at, parent_folder_id AS parent_id, sort_order,
                  'canvas' AS discipline
           FROM container_folders
         )
         ORDER BY COALESCE(parent_id, ''), sort_order, created_at, id`,
      )
      .all()
      .map((row) =>
        row.kind === "container"
          ? IndexEntrySchema.parse({
              kind: "container",
              container: toContainer(row),
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            })
          : IndexEntrySchema.parse({
              kind: "folder",
              id: row.id,
              name: row.name,
              createdAt: row.created_at,
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            }),
      );
  }

  listContainers(): Container[] {
    return this.listIndex()
      .filter(
        (item): item is Extract<IndexEntry, { kind: "container" }> => item.kind === "container",
      )
      .map((item) => item.container);
  }

  getContainer(id: string): Container | null {
    const row = this.db
      .query<ContainerRow, [string]>(
        "SELECT id, name, created_at, discipline FROM containers WHERE id = ?",
      )
      .get(id);
    return row === null ? null : ContainerSchema.parse(toContainer(row));
  }

  private siblingRefs(parentId: string | null): TreeRef[] {
    return this.db
      .query<TreeRef, [string | null, string | null]>(
        `SELECT 'container' AS kind, id, sort_order FROM containers WHERE folder_id IS ?
         UNION ALL
         SELECT 'folder' AS kind, id, sort_order FROM container_folders
         WHERE parent_folder_id IS ?
         ORDER BY sort_order, kind, id`,
      )
      .all(parentId, parentId)
      .map(({ kind, id }) => ({ kind, id }));
  }

  private setTreePosition(item: TreeRef, parentId: string | null, sortOrder: number): void {
    if (item.kind === "container") {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE containers SET folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    } else {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE container_folders SET parent_folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    }
  }

  private reindexSiblings(parentId: string | null, siblings: readonly TreeRef[]): void {
    siblings.forEach((item, index) => this.setTreePosition(item, parentId, index));
  }

  /** Persists a container at the top level of the index. */
  createContainer(container: Container): void {
    ContainerSchema.parse(container);
    this.db
      .query<void, [string, string, number, number, string]>(
        `INSERT INTO containers(id, name, created_at, sort_order, folder_id, discipline)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        container.id,
        container.name,
        container.createdAt,
        this.siblingRefs(null).length,
        container.discipline,
      );
  }

  createFolder(
    folder: { readonly id: string; readonly name: string; readonly createdAt: number },
    parentId: string | null,
  ): boolean {
    if (
      parentId !== null &&
      this.db
        .query<ExistsRow, [string]>("SELECT 1 AS found FROM container_folders WHERE id = ?")
        .get(parentId) === null
    ) {
      return false;
    }
    const sortOrder = this.siblingRefs(parentId).length;
    this.db
      .query<void, [string, string, number, string | null, number]>(
        `INSERT INTO container_folders(id, name, created_at, parent_folder_id, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(folder.id, folder.name, folder.createdAt, parentId, sortOrder);
    return true;
  }

  renameFolder(id: string, name: string): boolean {
    return (
      this.db
        .query<void, [string, string]>("UPDATE container_folders SET name = ? WHERE id = ?")
        .run(name, id).changes > 0
    );
  }

  deleteFolder(id: string): boolean {
    return this.db.transaction(() => {
      const folder = this.listIndex().find(
        (item): item is Extract<IndexEntry, { kind: "folder" }> =>
          item.kind === "folder" && item.id === id,
      );
      if (folder === undefined) return false;
      const siblings = this.siblingRefs(folder.parentId).filter(
        (item) => !(item.kind === "folder" && item.id === id),
      );
      const children = this.siblingRefs(id);
      const insertionIndex = Math.min(folder.sortOrder, siblings.length);
      siblings.splice(insertionIndex, 0, ...children);
      for (const child of children) this.setTreePosition(child, folder.parentId, 0);
      this.db.query<void, [string]>("DELETE FROM container_folders WHERE id = ?").run(id);
      this.reindexSiblings(folder.parentId, siblings);
      return true;
    })();
  }

  moveIndexEntry(item: TreeRef, parentId: string | null, index: number): boolean {
    return this.db.transaction(() => {
      const tree = this.listIndex();
      const current = tree.find((candidate) =>
        candidate.kind === "container"
          ? item.kind === "container" && candidate.container.id === item.id
          : item.kind === "folder" && candidate.id === item.id,
      );
      if (current === undefined) return false;
      if (parentId !== null) {
        const parent = tree.find(
          (candidate) => candidate.kind === "folder" && candidate.id === parentId,
        );
        if (parent === undefined) return false;
      }
      if (item.kind === "folder") {
        let ancestorId = parentId;
        while (ancestorId !== null) {
          if (ancestorId === item.id) return false;
          const ancestor = tree.find(
            (candidate) => candidate.kind === "folder" && candidate.id === ancestorId,
          );
          ancestorId = ancestor?.parentId ?? null;
        }
      }
      const oldParentId = current.parentId;
      const oldSiblings = this.siblingRefs(oldParentId).filter(
        (candidate) => !(candidate.kind === item.kind && candidate.id === item.id),
      );
      const destination =
        oldParentId === parentId
          ? oldSiblings
          : this.siblingRefs(parentId).filter(
              (candidate) => !(candidate.kind === item.kind && candidate.id === item.id),
            );
      destination.splice(Math.min(index, destination.length), 0, item);
      if (oldParentId !== parentId) this.reindexSiblings(oldParentId, oldSiblings);
      this.reindexSiblings(parentId, destination);
      return true;
    })();
  }

  renameContainer(id: string, name: string): Container | null {
    const result = this.db
      .query<void, [string, string]>("UPDATE containers SET name = ? WHERE id = ?")
      .run(name, id);
    return result.changes === 0 ? null : this.getContainer(id);
  }

  deleteContainer(id: string): boolean {
    this.eventCountByContainer.delete(id);
    return this.db.transaction(() => {
      const current = this.listIndex().find(
        (item): item is Extract<IndexEntry, { kind: "container" }> =>
          item.kind === "container" && item.container.id === id,
      );
      if (current === undefined) return false;
      this.db.query<void, [string]>("DELETE FROM scene_docs WHERE container_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM events WHERE container_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM terminals WHERE container_id = ?").run(id);
      const removed = this.db.query<void, [string]>("DELETE FROM containers WHERE id = ?").run(id);
      if (removed.changes === 0) return false;
      this.reindexSiblings(
        current.parentId,
        this.siblingRefs(current.parentId).filter(
          (item) => !(item.kind === "container" && item.id === id),
        ),
      );
      return true;
    })();
  }

  latestDoc(
    containerId: string,
    onInvalid?: (error: Error, record: InvalidDoc) => void,
  ): DocRecord | null {
    const rows = this.db
      .query<DocRow, [string]>(
        `SELECT container_id, epoch, rev, ts, hash, doc FROM scene_docs
         WHERE container_id = ? ORDER BY ts DESC, rev DESC LIMIT 30`,
      )
      .all(containerId);
    for (const row of rows) {
      try {
        if (sha256Hex(row.doc) !== row.hash) {
          throw new Error(`scene document hash mismatch for container ${containerId}`);
        }
        const probe = new Y.Doc();
        Y.applyUpdate(probe, row.doc);
        probe.destroy();
        return {
          containerId: row.container_id,
          epoch: row.epoch,
          rev: row.rev,
          ts: row.ts,
          hash: row.hash,
          doc: new Uint8Array(row.doc),
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("invalid scene document");
        onInvalid?.(failure, { epoch: row.epoch, rev: row.rev });
      }
    }
    return null;
  }

  saveDoc(containerId: string, epoch: string, rev: number, ts: number, doc: Uint8Array): DocRecord {
    const hash = sha256Hex(doc);
    const save = this.db.transaction(() => {
      this.db
        .query<void, [string, string, number, number, string, Uint8Array]>(
          `INSERT OR REPLACE INTO scene_docs(container_id, epoch, rev, ts, hash, doc)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(containerId, epoch, rev, ts, hash, doc);
      this.db
        .query<void, [string, string]>(
          `DELETE FROM scene_docs
           WHERE container_id = ? AND rowid NOT IN (
             SELECT rowid FROM scene_docs WHERE container_id = ?
             ORDER BY ts DESC, rev DESC LIMIT 30
           )`,
        )
        .run(containerId, containerId);
    });
    save();
    return { containerId, epoch, rev, ts, hash, doc: new Uint8Array(doc) };
  }

  createPrincipal(principal: Principal, createdAt: number): void {
    PrincipalSchema.parse(principal);
    this.db
      .query<void, [string, string, string, string, number, string | null]>(
        `INSERT INTO principals(id, kind, name, color, created_at, origin) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        principal.id,
        principal.kind,
        principal.name,
        principal.color,
        createdAt,
        principal.origin ?? null,
      );
  }

  getPrincipal(id: string): Principal | null {
    const row = this.db
      .query<PrincipalRow, [string]>(
        "SELECT id, kind, name, color, created_at, origin FROM principals WHERE id = ?",
      )
      .get(id);
    return row === null ? null : toPrincipal(row);
  }

  /** Safe service attribution survives replacement while its mint event is retained. */
  getNativeServiceIdentity(principalId: string): { serviceId: string; machineId: string } | null {
    const minted = this.db
      .query<{ serviceId: string; machineId: string }, [string]>(
        `SELECT json_extract(payload,'$.serviceId') AS serviceId,
                json_extract(payload,'$.machineId') AS machineId
         FROM events
         WHERE type='token_minted' AND CASE WHEN json_valid(payload) THEN
           json_extract(payload,'$.subjectPrincipalId')=? AND
           json_type(payload,'$.subjectPrincipalId')='text' AND
           json_type(payload,'$.serviceId')='text' AND json_extract(payload,'$.serviceId')<>'' AND
           json_type(payload,'$.machineId')='text' AND json_extract(payload,'$.machineId')<>''
         END
         ORDER BY id DESC LIMIT 1`,
      )
      .get(principalId);
    if (minted !== null) return minted;
    return this.db
      .query<{ serviceId: string; machineId: string }, [string]>(
        `SELECT service_id AS serviceId, machine_id AS machineId
         FROM native_instance_services
         WHERE CASE WHEN json_valid(credential) THEN
           json_type(credential,'$.principalId')='text' AND
           json_extract(credential,'$.principalId')=?
         END
         ORDER BY service_id LIMIT 1`,
      )
      .get(principalId);
  }

  listPrincipals(): Principal[] {
    return this.db
      .query<PrincipalRow, []>(
        "SELECT id, kind, name, color, created_at, origin FROM principals ORDER BY created_at, id",
      )
      .all()
      .map(toPrincipal);
  }

  /**
   * Every principal WITH the one fact `Principal` does not carry: when it was created.
   *
   * A second read rather than a widened `Principal`, because `created_at` is a fact only
   * administration asks for and `Principal` is the identity attendance, presence and the
   * session hello all pass around (ADR 0019 §3, `PrincipalCredentialsSchema`). Same row,
   * same order, one extra column.
   */
  listPrincipalsWithCreation(): { principal: Principal; createdAt: number }[] {
    return this.db
      .query<PrincipalRow, []>(
        "SELECT id, kind, name, color, created_at, origin FROM principals ORDER BY created_at, id",
      )
      .all()
      .map((row) => ({ principal: toPrincipal(row), createdAt: row.created_at }));
  }
  listPrincipalAccessPauses(): {
    readonly principalId: string;
    readonly pausedAt: number;
    readonly pausedBy: string;
  }[] {
    return this.db
      .query<{ principalId: string; pausedAt: number; pausedBy: string }, []>(
        `SELECT principal_id AS principalId, paused_at AS pausedAt, paused_by AS pausedBy
         FROM principal_access_pauses ORDER BY paused_at, principal_id`,
      )
      .all();
  }

  /** Writes lifecycle state; the AuthService caller owns the surrounding event transaction. */
  pausePrincipalAccess(principalId: string, pausedAt: number, pausedBy: string): boolean {
    return (
      this.db
        .query<void, [string, number, string]>(
          `INSERT OR IGNORE INTO principal_access_pauses(principal_id,paused_at,paused_by)
           VALUES (?,?,?)`,
        )
        .run(principalId, pausedAt, pausedBy).changes > 0
    );
  }

  /** Removes lifecycle state; the AuthService caller owns the surrounding event transaction. */
  resumePrincipalAccess(principalId: string): boolean {
    return (
      this.db
        .query<void, [string]>("DELETE FROM principal_access_pauses WHERE principal_id = ?")
        .run(principalId).changes > 0
    );
  }

  createAgent(record: AgentRecord): void {
    this.db
      .query(
        `INSERT INTO agents(
      agent_id,principal_id,sponsor_principal_id,name,purpose,harness,grant_json,context_json,
      policy_revision_acknowledged,status,authorization_path,authorization_credential,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.agentId,
        record.principalId,
        record.sponsorPrincipalId,
        record.name,
        record.purpose,
        record.harness,
        JSON.stringify(record.grant),
        JSON.stringify(record.context),
        record.policyRevisionAcknowledged ?? null,
        record.status,
        record.authorizationPath,
        JSON.stringify(record.authorizationCredential),
        record.createdAt,
        record.updatedAt,
      );
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.query<AgentRow, [string]>(`${AGENT_SELECT} WHERE agent_id=?`).get(id);
    return row === null ? null : toAgent(row);
  }

  hasRegisteredAgentPrincipal(principalId: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string]>(
          "SELECT 1 AS found FROM agents WHERE principal_id=? LIMIT 1",
        )
        .get(principalId) !== null
    );
  }

  getAgentBySponsorName(sponsorPrincipalId: string, name: string): AgentRecord | null {
    const row = this.db
      .query<AgentRow, [string, string]>(`${AGENT_SELECT} WHERE sponsor_principal_id=? AND name=?`)
      .get(sponsorPrincipalId, name);
    return row === null ? null : toAgent(row);
  }

  listAgents(): AgentRecord[] {
    return this.db
      .query<AgentRow, []>(`${AGENT_SELECT} ORDER BY created_at DESC,agent_id`)
      .all()
      .map(toAgent);
  }

  updateAgent(record: AgentRecord): void {
    this.db
      .query(
        `UPDATE agents SET principal_id=?,sponsor_principal_id=?,name=?,purpose=?,
      harness=?,grant_json=?,context_json=?,policy_revision_acknowledged=?,status=?,
      authorization_path=?,authorization_credential=?,created_at=?,updated_at=? WHERE agent_id=?`,
      )
      .run(
        record.principalId,
        record.sponsorPrincipalId,
        record.name,
        record.purpose,
        record.harness,
        JSON.stringify(record.grant),
        JSON.stringify(record.context),
        record.policyRevisionAcknowledged ?? null,
        record.status,
        record.authorizationPath,
        JSON.stringify(record.authorizationCredential),
        record.createdAt,
        record.updatedAt,
        record.agentId,
      );
  }

  bindAgentRunnerCredential(agentId: string, tokenId: string): void {
    // RETURNING excludes grant-revision trigger writes from the binding's success proof.
    const result = this.db
      .query<{ id: string }, [string, string, string]>(
        `UPDATE tokens SET runner_agent_id=?
      WHERE id=? AND runner_agent_id IS NULL AND run_id IS NULL
        AND principal_id=(SELECT principal_id FROM agents WHERE agent_id=?) RETURNING id`,
      )
      .get(agentId, tokenId, agentId);
    if (result === null) throw new Error("agent runner credential binding failed");
  }

  getAgentByRunnerToken(tokenId: string): AgentRecord | null {
    const row = this.db
      .query<AgentRow, [string]>(
        `${AGENT_SELECT} WHERE agent_id=(SELECT runner_agent_id FROM tokens WHERE id=?)`,
      )
      .get(tokenId);
    return row === null ? null : toAgent(row);
  }

  bindAgentRunCredential(runId: string, tokenId: string): void {
    const result = this.db
      .query<{ id: string }, [string, string, string]>(
        `UPDATE tokens SET run_id=?
      WHERE id=? AND runner_agent_id IS NULL AND run_id IS NULL
        AND principal_id=(SELECT principal_id FROM agent_runs WHERE id=?) RETURNING id`,
      )
      .get(runId, tokenId, runId);
    if (result === null) throw new Error("agent run credential binding failed");
  }

  listAgentRuns(agentId: string): AgentRunRecord[] {
    return this.db
      .query<AgentRunRow, [string]>(
        `${AGENT_RUN_SELECT} WHERE agent_id=? ORDER BY created_at DESC,id DESC`,
      )
      .all(agentId)
      .map(toAgentRun);
  }

  runTraceCounts(runId: string): { actionCount: number; refusalCount: number } {
    return this.db
      .query<{ actionCount: number; refusalCount: number }, [string, string]>(
        `
      SELECT COUNT(*) AS actionCount,
        COALESCE(SUM(outcome IN (SELECT value FROM json_each(?))),0) AS refusalCount
      FROM events WHERE type='trace' AND run_id=?`,
      )
      .get(TRACED_DENIAL_RULES_JSON, runId)!;
  }

  updateAgentRunSession(runId: string, session: SessionRef | null): void {
    const ref = session === null ? null : SessionRefSchema.parse(session);
    this.db
      .query<void, [string | null, string | null, string | null, string]>(
        "UPDATE agent_runs SET session_harness=?,session_id=?,session_machine_id=? WHERE id=?",
      )
      .run(ref?.harness ?? null, ref?.sessionId ?? null, ref?.machineId ?? null, runId);
  }

  updateAgentRunActivity(runId: string, activity: RunActivity): void {
    this.db
      .query<void, [string, string]>("UPDATE agent_runs SET activity=? WHERE id=?")
      .run(RunActivitySchema.parse(activity), runId);
  }

  createAgentRun(record: AgentRunRecord, snapshot: AgentPolicySnapshotRecord): void {
    this.db
      .query(
        `INSERT INTO agent_runs(
           id,principal_id,root_run_id,parent_run_id,authorized_by_principal_id,
           authorization_path,authorizer_token_id,authorizer_grant_id,authorizer_caps,
           authorizer_container_scope,authorizer_expires_at,purpose,task_ref,target,reach,caps,
           created_at,expires_at,renewals,max_depth,max_descendants,depth,
           cleanup_owner_principal_id,state,policy_revision,acknowledged_policy_revision,
           cleanup_revoked_credentials,cleanup_revoked_grants,finished_at,cleanup_failure,
           agent_id,session_harness,session_id,session_machine_id,model,activity
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.principalId,
        record.rootRunId,
        record.parentRunId,
        record.authorizedByPrincipalId,
        record.authorizationPath,
        record.authorizationCredential.tokenId,
        record.authorizationCredential.grantId,
        JSON.stringify(record.authorizationCredential.caps),
        record.authorizationCredential.containerScope,
        record.authorizationCredential.expiresAt ?? null,
        record.purpose,
        record.taskRef ?? null,
        record.target,
        record.reach,
        JSON.stringify(record.caps),
        record.createdAt,
        record.expiresAt,
        record.renewals,
        record.maxDepth,
        record.maxDescendants,
        record.depth,
        record.cleanupOwnerPrincipalId,
        record.state,
        record.policyRevision,
        record.acknowledgedPolicyRevision ?? null,
        record.cleanupRevokedCredentials,
        record.cleanupRevokedGrants,
        record.finishedAt ?? null,
        record.cleanupFailure ?? null,
        record.agentId,
        record.session?.harness ?? null,
        record.session?.sessionId ?? null,
        record.session?.machineId ?? null,
        record.model === undefined ? null : JSON.stringify(record.model),
        record.activity,
      );
    this.issueAgentPolicySnapshot(snapshot);
  }

  issueAgentPolicySnapshot(snapshot: AgentPolicySnapshotRecord): void {
    this.db
      .query(
        `INSERT INTO agent_run_policy_snapshots(
           run_id,revision,bundles,issued_at,acknowledged_at
         ) VALUES (?,?,?,?,?)
         ON CONFLICT(run_id,revision) DO UPDATE SET
           bundles=excluded.bundles,
           issued_at=excluded.issued_at,
           acknowledged_at=excluded.acknowledged_at`,
      )
      .run(
        snapshot.runId,
        snapshot.revision,
        JSON.stringify(snapshot.bundles),
        snapshot.issuedAt,
        snapshot.acknowledgedAt ?? null,
      );
  }

  getAgentRun(id: string): AgentRunRecord | null {
    const row = this.db.query<AgentRunRow, [string]>(`${AGENT_RUN_SELECT} WHERE id=?`).get(id);
    return row === null ? null : toAgentRun(row);
  }

  getAgentRunByToken(tokenId: string): AgentRunRecord | null {
    const row = this.db
      .query<AgentRunRow, [string]>(
        `${AGENT_RUN_SELECT} WHERE id=(SELECT run_id FROM tokens WHERE id=?)`,
      )
      .get(tokenId);
    return row === null ? null : toAgentRun(row);
  }

  listAgentRunTree(rootRunId: string): AgentRunRecord[] {
    return this.db
      .query<AgentRunRow, [string]>(`${AGENT_RUN_SELECT} WHERE root_run_id=? ORDER BY depth,id`)
      .all(rootRunId)
      .map(toAgentRun);
  }

  /** Candidate roots narrow scanning only; AuthService still authorizes every returned run. */
  *agentRunInspectionCandidates(principalId: string, root: boolean): Iterable<AgentRunRecord> {
    // Each consumer owns its cursor: bounded discovery can stop before SQLite exhausts it.
    const statement = this.db.prepare<AgentRunRow, [number, string]>(
      `WITH RECURSIVE sponsored_principals(id) AS (
         SELECT ?2 WHERE ?1=0
         UNION
         SELECT a.principal_id FROM agents a
           JOIN sponsored_principals sponsor ON a.sponsor_principal_id=sponsor.id
       )
       ${AGENT_RUN_SELECT}
       WHERE ?1=1 OR root_run_id IN (
         SELECT root_run_id FROM agent_runs
           WHERE principal_id IN (SELECT id FROM sponsored_principals)
             OR authorized_by_principal_id IN (SELECT id FROM sponsored_principals)
       )
       ORDER BY created_at DESC,id DESC`,
    );
    try {
      for (const row of statement.iterate(root ? 1 : 0, principalId)) yield toAgentRun(row);
    } finally {
      statement.finalize();
    }
  }

  listOpenAgentRuns(now: number): AgentRunRecord[] {
    return this.db
      .query<AgentRunRow, [number]>(
        `${AGENT_RUN_SELECT}
         WHERE state IN ('pending_policy','active','policy_stale') AND expires_at>?
         ORDER BY created_at,id`,
      )
      .all(now)
      .map(toAgentRun);
  }

  listExpiredAgentRuns(now: number): AgentRunRecord[] {
    return this.db
      .query<AgentRunRow, [number]>(
        `${AGENT_RUN_SELECT}
         WHERE state IN ('pending_policy','active','policy_stale') AND expires_at<=?
         ORDER BY depth,created_at,id`,
      )
      .all(now)
      .map(toAgentRun);
  }

  getAgentPolicySnapshot(runId: string, revision: string): AgentPolicySnapshotRecord | null {
    const row = this.db
      .query<AgentPolicySnapshotRow, [string, string]>(
        `SELECT run_id,revision,bundles,issued_at,acknowledged_at
         FROM agent_run_policy_snapshots WHERE run_id=? AND revision=?`,
      )
      .get(runId, revision);
    return row === null ? null : toAgentPolicySnapshot(row);
  }

  acknowledgeAgentPolicy(runId: string, revision: string, at: number): boolean {
    return this.transaction(() => {
      const eligible = this.db
        .query<ExistsRow, [string, string]>(
          `SELECT 1 AS found
        FROM agent_runs r JOIN agent_run_policy_snapshots s ON s.run_id=r.id AND s.revision=r.policy_revision
        WHERE r.id=? AND r.policy_revision=? AND r.state IN ('pending_policy','policy_stale')
          AND s.acknowledged_at IS NULL`,
        )
        .get(runId, revision);
      if (eligible === null) return false;
      this.db
        .query<void, [number, string, string]>(
          `UPDATE agent_run_policy_snapshots
        SET acknowledged_at=? WHERE run_id=? AND revision=?`,
        )
        .run(at, runId, revision);
      this.db
        .query<void, [string, string]>(
          `UPDATE agent_runs
        SET acknowledged_policy_revision=?,state='active' WHERE id=?`,
        )
        .run(revision, runId);
      this.db
        .query<void, [string, number, string]>(
          `UPDATE agents
        SET policy_revision_acknowledged=?,updated_at=?
        WHERE agent_id=(SELECT agent_id FROM agent_runs WHERE id=?)`,
        )
        .run(revision, at, runId);
      return true;
    });
  }

  updateAgentRunPolicy(
    runId: string,
    revision: string,
    state: "pending_policy" | "policy_stale",
  ): void {
    this.db
      .query<void, [string, string, string]>(
        `UPDATE agent_runs SET policy_revision=?,state=? WHERE id=?`,
      )
      .run(revision, state, runId);
  }

  renewAgentRun(
    runId: string,
    expiresAt: number,
    authorizationCredential: AgentRunAuthorizationCredential,
  ): boolean {
    return (
      this.db
        .query<
          void,
          [number, string | null, string | null, string, string | null, number | null, string]
        >(
          `UPDATE agent_runs
           SET expires_at=?,renewals=renewals+1,authorizer_token_id=?,authorizer_grant_id=?,
               authorizer_caps=?,authorizer_container_scope=?,authorizer_expires_at=?
           WHERE id=? AND state='active'`,
        )
        .run(
          expiresAt,
          authorizationCredential.tokenId,
          authorizationCredential.grantId,
          JSON.stringify(authorizationCredential.caps),
          authorizationCredential.containerScope,
          authorizationCredential.expiresAt ?? null,
          runId,
        ).changes === 1
    );
  }

  settleAgentRun(
    runId: string,
    state: AgentRunState,
    at: number,
    revokedCredentials: number,
    revokedGrants: number,
    failure?: string,
  ): void {
    this.db
      .query<void, [string, number, number, number, string | null, string]>(
        `UPDATE agent_runs
         SET state=?,finished_at=?,cleanup_revoked_credentials=?,cleanup_revoked_grants=?,
             cleanup_failure=?
         WHERE id=?`,
      )
      .run(state, at, revokedCredentials, revokedGrants, failure ?? null, runId);
  }

  createToken(record: TokenRecord): void {
    this.db
      .query<
        void,
        [
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          number,
          number | null,
          string | null,
          number | null,
        ]
      >(
        `INSERT INTO tokens(
           id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
           grant_id, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.hash,
        record.principalId,
        record.mintedBy,
        JSON.stringify(record.caps),
        record.containerId,
        record.createdAt,
        record.revokedAt,
        record.grantId,
        record.expiresAt,
      );
  }

  getTokenByHash(hash: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
                grant_id, expires_at
         FROM tokens WHERE hash = ?`,
      )
      .get(hash);
    return row === null ? null : toToken(row);
  }

  getToken(id: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
                grant_id, expires_at
         FROM tokens WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toToken(row);
  }

  /**
   * Every token row for one principal, oldest first — the credential list's substrate
   * (ADR 0019 §3). Revoked and expired rows come back too: what is live is a question about
   * the CLOCK, and a store read that answered it would have to be handed a clock and would
   * then be a second place the liveness rule is written (docs/CONTRACTS.md §One authoritative implementation). The reader filters.
   *
   * A machine's token has the MACHINE's id in `principal_id` and no principal row behind it,
   * so no machine credential is ever reachable through this read: the fleet is
   * `core.machines.list`'s answer, and asking for a machine here returns its rows only if a
   * caller already knows a machine id, which is not a principal.
   */
  listTokensByPrincipal(principalId: string): TokenRecord[] {
    return this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
                grant_id, expires_at
         FROM tokens WHERE principal_id = ? ORDER BY created_at, id`,
      )
      .all(principalId)
      .map(toToken);
  }

  listTokensForAgentRun(runId: string): TokenRecord[] {
    return this.db
      .query<TokenRow, [string]>(
        `SELECT id,hash,principal_id,minted_by,caps,
      container_id,created_at,revoked_at,grant_id,expires_at
      FROM tokens WHERE run_id=? ORDER BY created_at,id`,
      )
      .all(runId)
      .map(toToken);
  }

  revokeTokensByAgentRun(runId: string, at: number): TokenRevocation {
    return this.revokeTokensWhere("run_id = ?", [runId], at);
  }

  /** Checks issuance without loading credential history; liveAt excludes dead credentials. */
  hasIssuedToken(
    principalId: string,
    mintedBy: string,
    containerId: string | null,
    liveAt?: number,
  ): boolean {
    return (
      this.db
        .query<
          { found: number },
          [string, string, string | null, string | null, number | null, number | null]
        >(
          `SELECT 1 AS found FROM tokens
           WHERE principal_id = ? AND minted_by = ?
             AND (? IS NULL OR container_id = ?)
             AND (? IS NULL OR (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)))
           LIMIT 1`,
        )
        .get(principalId, mintedBy, containerId, containerId, liveAt ?? null, liveAt ?? null) !==
      null
    );
  }

  /**
   * Revokes one principal's credentials, optionally narrowed to one container and/or issuer.
   *
   * Issuer is credential provenance, not principal ownership: combining it with the existing
   * container predicate lets a delegate withdraw only the credentials it issued inside its
   * current scope while root and lifecycle callers retain the principal-wide form.
   */
  revokeTokensByPrincipal(
    principalId: string,
    revokedAt: number,
    filter: { readonly containerId?: string; readonly mintedBy?: string } = {},
  ): TokenRevocation {
    const clauses = ["principal_id = ?"];
    const params = [principalId];
    if (filter.containerId !== undefined) {
      clauses.push("container_id = ?");
      params.push(filter.containerId);
    }
    if (filter.mintedBy !== undefined) {
      clauses.push("minted_by = ?");
      params.push(filter.mintedBy);
    }
    return this.revokeTokensWhere(clauses.join(" AND "), params, revokedAt);
  }

  revokeToken(tokenId: string, revokedAt: number): TokenRevocation {
    return this.revokeTokensWhere("id = ?", [tokenId], revokedAt);
  }

  /**
   * Marks every live token the predicate names revoked, and retires the grant row each one
   * references — one transaction, so no instant shows a dead credential standing on live
   * authority or the reverse.
   *
   * A TOKEN'S ROW DIES WITH THE TOKEN. The row is that one credential's synthesized authority
   * and reaches no other (`tokenBound`), so once the token is refused at authentication the row
   * answers no question anybody can ask — it is unexercisable, and without this it was also
   * immortal: `listGrants` and the inspector's authority reading kept printing every principal
   * a gate run had ever minted and revoked (issue #140). Migration 13 materialized revoked
   * tokens on purpose, as "a faithful account of what was issued"; that account is the
   * `tokens` table's job — `caps`, `container_id` and `revoked_at` all survive here — and a
   * grant row is LIVE authority, which is the same ruling `revokeShare` already made for a
   * share's row. Migration 16 applies it to history.
   *
   * The token loses its reference as it loses its row, exactly as `deleteGrant` severs a
   * share's: a reference to a row that no longer exists would be the one dangling edge in the
   * schema. The predicate is written ONCE and the DELETE runs first, because "the tokens this
   * call revokes" is the UPDATE's own `revoked_at IS NULL` set and no second timestamp query
   * can name it after the fact.
   */
  private revokeTokensWhere(
    where: string,
    params: readonly string[],
    revokedAt: number,
  ): TokenRevocation {
    return this.transaction(() => {
      // Bun's run().changes includes trigger writes. SQLite's changes() counts only
      // the direct mutation, without materializing one RETURNING row per credential.
      const changes = this.db.query<{ count: number }, []>("SELECT changes() AS count");
      this.db
        .query<void, string[]>(
          `DELETE FROM grants WHERE id IN (
             SELECT grant_id FROM tokens
             WHERE ${where} AND revoked_at IS NULL AND grant_id IS NOT NULL
           )`,
        )
        .run(...params);
      const grants = changes.get()?.count ?? 0;
      this.db
        .query<void, [number, ...string[]]>(
          `UPDATE tokens SET revoked_at = ?, grant_id = NULL
           WHERE ${where} AND revoked_at IS NULL`,
        )
        .run(revokedAt, ...params);
      const tokens = changes.get()?.count ?? 0;
      return { tokens, grants };
    });
  }

  /*
    GRANTS — authority as rows (ADR 0011). Nothing here is hashed and nothing is a secret: a
    grant is bookkeeping ABOUT authority, so the discipline that governs the tokens table
    ("the raw bearer secret deliberately has no field here") has nothing to say about it. What
    governs this table instead is the shape of the one query the evaluator runs on every
    authority question, which is why every read below goes through `GRANT_SELECT`.
  */

  /** Writes one row. The caller owns the transaction, because a grant rarely lands alone. */
  createGrant(grant: Grant): void {
    GrantSchema.parse(grant);
    const principalId =
      grant.principal.kind === "principal"
        ? grant.principal.id
        : grant.principal.kind === "instance"
          ? grant.principal.origin
          : null;
    this.db
      .query<void, [string, string, string | null, string, string, string, string, string, number]>(
        `INSERT INTO grants(
           id, principal_kind, principal_id, node, caps, effect, reach, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.principal.kind,
        principalId,
        grant.node,
        JSON.stringify(grant.caps),
        grant.effect,
        grant.reach,
        grant.createdBy,
        grant.createdAt,
      );
  }

  getGrant(id: string): GrantRecord | null {
    const row = this.db.query<GrantRow, [string]>(`${GRANT_SELECT} WHERE g.id = ?`).get(id);
    return row === null ? null : toGrant(row);
  }

  /**
   * Removes a row, and with it the authority it carried — immediately and completely.
   *
   * A DELETE rather than a `revoked_at` tombstone, and the asymmetry with tokens and shares is
   * deliberate. Those two are BEARER SECRETS: a secret already handed over cannot be taken
   * back, so the row has to survive to keep refusing what still presents it. A grant presents
   * nothing. There is no holder to refuse, so the absence of the row IS the revocation, and a
   * tombstone would only add a second state the evaluator has to remember to skip.
   *
   * A share that referenced this row loses its reference rather than its own existence: the
   * share row stays exactly as revocable, listable and auditable as it was.
   */
  deleteGrant(id: string): boolean {
    return this.transaction(() => {
      this.db.query<void, [string]>("UPDATE shares SET grant_id = NULL WHERE grant_id = ?").run(id);
      return this.db.query<void, [string]>("DELETE FROM grants WHERE id = ?").run(id).changes > 0;
    });
  }

  /**
   * Every row, or the rows one node or one principal answers for. A read, and the filters narrow
   * it for an administrator's convenience rather than for secrecy — there is no secret here.
   */
  listGrants(
    filter: { node?: string | undefined; principalId?: string | undefined } = {},
  ): GrantRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.node !== undefined) {
      clauses.push("g.node = ?");
      params.push(filter.node);
    }
    if (filter.principalId !== undefined) {
      clauses.push("g.principal_kind = 'principal' AND g.principal_id = ?");
      params.push(filter.principalId);
    }
    const where =
      clauses.length === 0 ? "" : ` WHERE ${clauses.map((one) => `(${one})`).join(" AND ")}`;
    return this.db
      .query<GrantRow, string[]>(`${GRANT_SELECT}${where} ORDER BY g.created_at, g.id`)
      .all(...params)
      .map(toGrant);
  }

  /**
   * THE EVALUATOR'S ONE QUERY: every row on a containment path that could answer for this
   * principal, by id or by class. Called on every authority question, so the narrowing happens
   * in SQL rather than in the walk — a workspace where every token has a root grant would
   * otherwise hand the evaluator the whole table on every request.
   *
   * A principal with no `origin` belongs to this instance, and `principal_id = NULL` matches
   * nothing in SQL, so instance rows sit out a local principal's walk without a branch here.
   */
  grantsFor(principal: Principal, path: readonly string[]): GrantRecord[] {
    if (path.length === 0) return [];
    const placeholders = path.map(() => "?").join(", ");
    return this.db
      .query<GrantRow, (string | null)[]>(
        `${GRANT_SELECT}
         WHERE g.node IN (${placeholders})
           AND ( (g.principal_kind = 'principal' AND g.principal_id = ?)
              OR g.principal_kind = ?
              OR (g.principal_kind = 'instance' AND g.principal_id = ?) )`,
      )
      .all(
        ...path,
        principal.id,
        principal.kind === "human" ? "any-human" : principal.kind === "agent" ? "any-agent" : null,
        principal.origin ?? null,
      )
      .map(toGrant);
  }

  /*
    SHARES — what this instance hands out. Every read below counts its own tickets with a
    correlated subquery rather than keeping a column, because a stale counter beside the
    rows it counts is the kind of lie that only shows up in an audit.
  */

  createShare(record: Omit<ShareRecord, "tickets">): void {
    this.db
      .query<
        void,
        [string, string, string, string, string, string, number, number | null, string | null]
      >(
        `INSERT INTO shares(
           id, hash, container_id, caps, origin, minted_by, created_at, revoked_at, grant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.hash,
        record.containerId,
        JSON.stringify(record.caps),
        record.origin,
        record.mintedBy,
        record.createdAt,
        record.revokedAt,
        record.grantId,
      );
  }

  getShareByHash(hash: string): ShareRecord | null {
    const row = this.db.query<ShareRow, [string]>(`${SHARE_SELECT} WHERE s.hash = ?`).get(hash);
    return row === null ? null : toShare(row);
  }

  getShare(id: string): ShareRecord | null {
    const row = this.db.query<ShareRow, [string]>(`${SHARE_SELECT} WHERE s.id = ?`).get(id);
    return row === null ? null : toShare(row);
  }

  listShares(): ShareRecord[] {
    return this.db
      .query<ShareRow, []>(`${SHARE_SELECT} ORDER BY s.created_at, s.id`)
      .all()
      .map(toShare);
  }

  revokeShare(shareId: string, revokedAt: number): boolean {
    return (
      this.db
        .query<void, [number, string]>(
          "UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, shareId).changes > 0
    );
  }

  /**
   * The host-side principal standing for one of the guest's, minted once and reused. The
   * insert is `OR IGNORE` and the read follows it in the same transaction, so two
   * `ticket_request`s racing on one socket resolve to the SAME principal instead of
   * quietly minting a second identity for the same person.
   */
  claimShareTicket(
    shareId: string,
    guestPrincipalId: string,
    principalId: string,
    createdAt: number,
  ): string {
    return this.transaction(() => {
      this.db
        .query<void, [string, string, string, number]>(
          `INSERT OR IGNORE INTO share_tickets(share_id, guest_principal_id, principal_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(shareId, guestPrincipalId, principalId, createdAt);
      const row = this.db
        .query<TicketRow, [string, string]>(
          "SELECT principal_id FROM share_tickets WHERE share_id = ? AND guest_principal_id = ?",
        )
        .get(shareId, guestPrincipalId);
      return row === null ? principalId : row.principal_id;
    });
  }

  /** Every host-side principal a share has minted — the exact set a revocation must fence. */
  shareTicketPrincipals(shareId: string): string[] {
    return this.db
      .query<TicketRow, [string]>(
        "SELECT principal_id FROM share_tickets WHERE share_id = ? ORDER BY created_at, principal_id",
      )
      .all(shareId)
      .map((row) => row.principal_id);
  }

  /*
    DIALS — what this instance dials out with. The guest half of the same relationship.
  */

  createDial(record: DialRecord): void {
    this.db
      .query<
        void,
        [string, string, string, string | null, string, string | null, number, number | null]
      >(
        `INSERT INTO dials(
           id, origin, secret, ref, caps, title, dialed_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.origin,
        record.secret,
        record.ref,
        JSON.stringify(record.caps),
        record.title,
        record.dialedAt,
        record.revokedAt,
      );
  }

  getDial(id: string): DialRecord | null {
    const row = this.db.query<DialRow, [string]>(`${DIAL_SELECT} WHERE id = ?`).get(id);
    return row === null ? null : toDial(row);
  }

  getDialByOriginSecret(origin: string, secret: string): DialRecord | null {
    const row = this.db
      .query<DialRow, [string, string]>(`${DIAL_SELECT} WHERE origin = ? AND secret = ?`)
      .get(origin, secret);
    return row === null ? null : toDial(row);
  }

  listDials(): DialRecord[] {
    return this.db.query<DialRow, []>(`${DIAL_SELECT} ORDER BY dialed_at, id`).all().map(toDial);
  }

  /**
   * What the host told us this share names, written back after every `welcome`. A dial's
   * cached vocabulary is refreshed by the authority that owns it and by nothing else.
   */
  updateDialGrant(id: string, ref: string, caps: readonly Cap[], title: string | null): void {
    this.db
      .query<void, [string, string, string | null, string]>(
        "UPDATE dials SET ref = ?, caps = ?, title = ? WHERE id = ?",
      )
      .run(ref, JSON.stringify(caps), title, id);
  }

  revokeDial(id: string, revokedAt: number): boolean {
    return (
      this.db
        .query<void, [number, string]>(
          "UPDATE dials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, id).changes > 0
    );
  }

  /**
   * Erases a dial that never completed its handshake. Deliberately a DELETE and not a
   * revocation: nothing was ever granted, so there is no authority to record the end of,
   * and a `revoked` row for a partnership that never existed would be a lie in the one
   * table an operator reads to answer "who can see my work".
   */
  deleteDial(id: string): boolean {
    return this.db.query<void, [string]>("DELETE FROM dials WHERE id = ?").run(id).changes > 0;
  }

  /**
   * ONE JOURNAL, ONE INSERT. Both row families land here — an event through `addEvent`, a
   * trace through `appendTrace` — because retention, the per-container cap and the count cache
   * are properties of the TABLE and a second copy of them would drift the first time either
   * policy changed (docs/CONTRACTS.md §One authoritative implementation).
   *
   * Returns the row's id, which the trace ledger needs and the event path ignores: a trace is
   * written before its outcome is known and settled afterwards by id (ADR 0018 §3).
   */
  private insertJournalRow(
    containerId: string | null,
    ts: number,
    principalId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    trace: {
      readonly door: string;
      readonly authority: string;
      readonly targets: readonly string[];
      readonly outcome: TraceOutcome | null;
      readonly session: string | null;
      readonly runId?: string;
      readonly credentialId?: string;
    } | null,
  ): number {
    const inserted = this.transaction(
      (): {
        readonly id: number;
        readonly retained: number | null;
        readonly workspace?: number;
      } => {
        const id = Number(
          this.db
            .query<
              void,
              [
                string | null,
                number,
                string | null,
                string,
                string,
                string | null,
                string | null,
                string | null,
                string | null,
                string | null,
                string | null,
                string | null,
              ]
            >(
              `INSERT INTO events(container_id, ts, principal_id, type, payload,
                                door, authority, targets, outcome, session, run_id, credential_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              containerId,
              ts,
              principalId,
              type,
              JSON.stringify(payload),
              trace === null ? null : trace.door,
              trace === null ? null : trace.authority,
              trace === null ? null : JSON.stringify(trace.targets),
              trace === null ? null : trace.outcome,
              trace === null ? null : trace.session,
              trace?.runId ?? null,
              trace?.credentialId ?? null,
            ).lastInsertRowid,
        );
        this.db
          .query<void, [number]>("DELETE FROM events WHERE ts < ?")
          .run(ts - EVENTS_RETENTION_DAYS * MILLISECONDS_PER_DAY);
        if (containerId !== null) {
          const cachedCount = this.eventCountByContainer.get(containerId);
          let count =
            cachedCount === undefined
              ? this.db
                  .query<{ count: number }, [string]>(
                    "SELECT COUNT(*) AS count FROM events WHERE container_id = ?",
                  )
                  .get(containerId)!.count
              : cachedCount + 1;
          if (count <= EVENTS_MAX_PER_CONTAINER) return { id, retained: count };
          this.db
            .query<void, [string, number]>(
              `DELETE FROM events
             WHERE id IN (
               SELECT id FROM events WHERE container_id = ?
               ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?
             )`,
            )
            .run(containerId, EVENTS_MAX_PER_CONTAINER);
          count = EVENTS_MAX_PER_CONTAINER;
          return { id, retained: count };
        }
        /*
          THE WORKSPACE BUCKET, capped the same way and for a reason axiom A6 created. A row
          belonging to no container used to be rare — a token minted, a grant revoked — so the
          30-day window was bound enough. A trace of a workspace-grade dispatch lands here too,
          and those arrive as fast as somebody (or some agent, in a loop) can call a door. The
          per-container cap's own mechanism answers it: keep the newest N by the same recency
          order, counted through the same cache so the common insert costs no COUNT.
         */
        const cachedWorkspace = this.workspaceEventCount;
        let workspace =
          cachedWorkspace === null
            ? this.db
                .query<{ count: number }, []>(
                  "SELECT COUNT(*) AS count FROM events WHERE container_id IS NULL",
                )
                .get()!.count
            : cachedWorkspace + 1;
        if (workspace > EVENTS_MAX_WORKSPACE) {
          this.db
            .query<void, [number]>(
              `DELETE FROM events
             WHERE id IN (
               SELECT id FROM events WHERE container_id IS NULL
               ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?
             )`,
            )
            .run(EVENTS_MAX_WORKSPACE);
          workspace = EVENTS_MAX_WORKSPACE;
        }
        return { id, retained: null, workspace };
      },
    );
    if (containerId !== null && inserted.retained !== null) {
      this.eventCountByContainer.set(containerId, inserted.retained);
    }
    if (inserted.workspace !== undefined) this.workspaceEventCount = inserted.workspace;
    return inserted.id;
  }

  addEvent(
    containerId: string | null,
    ts: number,
    principalId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.insertJournalRow(containerId, ts, principalId, type, payload, null);
  }

  /**
   * THE TRACE LEDGER'S WRITE-AHEAD (axiom A6, ADR 0018). One row, carrying the whole
   * attribution of an exercise of authority, and its id back so the outcome can settle onto
   * it.
   *
   * `outcome` is null when the ladder is about to invoke a handler and final when the rung
   * refusing already knows the answer. Writing the attribution BEFORE the handler runs is what
   * makes "no mutation without a trace" a property of the ordering rather than of a hope: by
   * the time a handler can reach this store, its trace is already committed.
   */
  appendTrace(record: TraceRecord): number {
    return this.insertJournalRow(
      record.containerId,
      record.ts,
      record.actor,
      TRACE_ROW_TYPE,
      record.payload,
      {
        door: record.door,
        authority: record.authority,
        targets: record.targets,
        outcome: record.outcome,
        session: record.session,
        ...(record.runId === undefined ? {} : { runId: record.runId }),
        ...(record.credentialId === undefined ? {} : { credentialId: record.credentialId }),
      },
    );
  }

  /**
   * THE SETTLE: the outcome, plus the nodes the door named, written onto a trace exactly once.
   *
   * `WHERE outcome IS NULL` is the whole enforcement of "exactly once" — a second settle
   * changes nothing and reports false, so no rung and no retry can rewrite a recorded answer.
   * It is the only UPDATE the journal accepts, and it is a transition from unsettled to final
   * rather than a rewrite of history: a row left unsettled by a crash says truthfully that the
   * dispatch was in flight when the process died.
   */
  settleTrace(id: number, outcome: TraceOutcome, targets: readonly string[]): boolean {
    return (
      this.db
        .query<void, [string, string, number]>(
          "UPDATE events SET outcome = ?, targets = ? WHERE id = ? AND outcome IS NULL",
        )
        .run(outcome, JSON.stringify(targets), id).changes > 0
    );
  }

  /**
   * THE audit trail, read back. Newest first, and index-backed in both shapes.
   *
   * `insertJournalRow` is the only writer and it has always been append-only — a trace's
   * settle is the one sanctioned exception, and it moves one row's outcome from unsettled to
   * final and nothing else. This is the read that makes the rows reachable by something other
   * than a SQL prompt (`core.events.list`). Two
   * queries rather than one, and the split is the index rather than taste: narrowing by
   * container hits `events_by_container_recency (container_id, ts DESC, id DESC)` — the exact
   * shape of the filter and the ordering together — while the unfiltered read walks
   * `events_by_timestamp (ts)` backwards. A single query with `(?1 IS NULL OR container_id = ?1)`
   * would read better and would defeat both: SQLite cannot plan an index seek through an `OR`
   * on the indexed column, so the workspace-wide read would become a table scan and sort as
   * the trail grows.
   *
   * `type` gets exactly that sentinel treatment, and there it is free: no index covers `type`,
   * so it is a predicate the ordering scan applies either way.
   *
   * `ts DESC, id DESC` is the recency order the retention pruning already uses, so "newest"
   * means the same thing to the reader and to the writer that decides what to drop. The `id`
   * tiebreak matters because `ts` is the caller's clock and two records can share a
   * millisecond.
   *
   * `limit` is required, not optional: an unbounded read of a 10,000-row-per-container trail
   * is a door that can be asked to allocate the whole table, and the bound belongs to the
   * caller's contract rather than to a default buried here.
   */
  listEvents(filter: EventFilter): readonly StoredEvent[] {
    const type = filter.type ?? null;
    const columns = `id, container_id, ts, principal_id, type, payload,
                     door, authority, targets, outcome, session`;
    const rows =
      filter.containerId === undefined
        ? this.db
            .query<EventDbRow, [string | null, number]>(
              `SELECT ${columns}
                 FROM events
                WHERE (?1 IS NULL OR type = ?1)
                ORDER BY ts DESC, id DESC
                LIMIT ?2`,
            )
            .all(type, filter.limit)
        : this.db
            .query<EventDbRow, [string, string | null, number]>(
              `SELECT ${columns}
                 FROM events
                WHERE container_id = ?1 AND (?2 IS NULL OR type = ?2)
                ORDER BY ts DESC, id DESC
                LIMIT ?3`,
            )
            .all(filter.containerId, type, filter.limit);
    return rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ts: row.ts,
      principalId: row.principal_id,
      type: row.type,
      payload: row.payload,
      door: row.door,
      authority: row.authority,
      targets: parseTargets(row.targets),
      outcome: row.outcome,
      session: row.session,
    }));
  }

  /**
   * Payload-free read projection for an ALREADY AUTHORIZED run. Select every field
   * explicitly: neither the journal payload nor a native request/result leaves SQLite.
   * Retention remains insertJournalRow's policy; this method creates no durable state.
   */
  agentRunInspectionFacts(
    runId: string,
    input: InspectRunRequest,
    now: number,
    liveConnectionIds: readonly string[],
  ): Pick<
    AgentRunInspection,
    | "credentials"
    | "connections"
    | "traces"
    | "nextBeforeTraceId"
    | "requestedTrace"
    | "history"
    | "jobs"
    | "terminals"
    | "nativeTruncated"
  > {
    const safeText = (value: string): string => normalizeAgentDeclaration(value) ?? "[redacted]";
    // This known native-id form is safe only as a selected job reference, never free text.
    const safeJobId = (value: string): string =>
      /^schedule-[a-f0-9]{64}$/.test(value) ? value : safeText(value);
    // Migration 36 is the only initializer. Never infer trust from retained rows or
    // repair an absent/corrupt boundary on read or reopen. SQLite's decimal round-trip
    // rejects noncanonical or out-of-INT64-range metadata without JS number coercion.
    const traceRows = this.db
      .query<
        {
          id: string;
          ts: number;
          principal_id: string;
          door: string;
          authority: string;
          targets: string;
          outcome: TraceOutcome | null;
          session: string | null;
          declaration: unknown;
        },
        [string, string | null, string | null, string | null, string | null, number]
      >(
        `WITH declaration_cutover AS (
        SELECT CAST(value AS INTEGER) AS id FROM meta
         WHERE key='agent-runs:declarations-after-event-id'
          AND value=CAST(CAST(value AS INTEGER) AS TEXT) AND CAST(value AS INTEGER)>=0
       )
       SELECT CAST(id AS TEXT) AS id,ts,principal_id,door,authority,targets,outcome,session,
        CASE WHEN id>(SELECT id FROM declaration_cutover) AND json_valid(payload)
          THEN json_extract(payload,'$.agentDeclaration') END AS declaration
       FROM events WHERE type='trace' AND run_id=?
        AND (? IS NULL OR id=?) AND (? IS NULL OR id<?)
       ORDER BY events.id DESC LIMIT ?`,
      )
      .all(
        runId,
        input.traceId ?? null,
        input.traceId ?? null,
        input.beforeTraceId ?? null,
        input.beforeTraceId ?? null,
        input.limit + 1,
      );
    const traces = traceRows.slice(0, input.limit).map((row) => {
      const declaration =
        row.outcome === "invalid_args" || typeof row.declaration !== "string"
          ? null
          : normalizeAgentDeclaration(row.declaration);
      return AgentRunTraceSummarySchema.parse({
        traceId: row.id,
        at: row.ts,
        actor: row.principal_id,
        action: safeText(row.door),
        authority: safeText(row.authority),
        targets: parseTargets(row.targets).slice(0, 128).map(safeText),
        outcome: row.outcome,
        settlement: row.outcome === null ? "pending_or_crashed" : "settled",
        connectionId: row.session,
        origin: row.session === null ? "http" : "connection",
        ...(declaration === null ? {} : { agentDeclaration: declaration }),
      });
    });
    const credentials = this.db
      .query<
        {
          createdAt: number;
          expiresAt: number | null;
          revokedAt: number | null;
          node: string | null;
          caps: string | null;
          reach: GrantReach | null;
          effect: "allow" | "deny" | null;
        },
        [string]
      >(
        `SELECT t.created_at AS createdAt,t.expires_at AS expiresAt,t.revoked_at AS revokedAt,
        g.node,g.caps,g.reach,g.effect FROM tokens t LEFT JOIN grants g ON g.id=t.grant_id
       WHERE t.run_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT 100`,
      )
      .all(runId)
      .map((row): AgentRunInspection["credentials"][number] => ({
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        state:
          row.revokedAt !== null
            ? "revoked"
            : row.expiresAt !== null && row.expiresAt <= now
              ? "expired"
              : "live",
        grant:
          row.node === null || row.caps === null || row.reach === null || row.effect === null
            ? null
            : {
                node: safeText(row.node),
                caps: AuthoredCapSchema.array().parse(JSON.parse(row.caps)),
                reach: row.reach,
                effect: row.effect,
              },
      }));
    const observed = this.db
      .query<
        {
          connectionId: string;
          firstObservedAt: number;
          lastObservedAt: number;
        },
        [string]
      >(
        `SELECT session AS connectionId,MIN(ts) AS firstObservedAt,MAX(ts) AS lastObservedAt
       FROM events WHERE type='trace' AND run_id=? AND session IS NOT NULL
       GROUP BY session ORDER BY MAX(ts) DESC,session LIMIT 100`,
      )
      .all(runId);
    const live = new Set(liveConnectionIds);
    const connections: AgentRunInspection["connections"] = liveConnectionIds
      .slice(0, 100)
      .map((connectionId) => {
        const row = observed.find((entry) => entry.connectionId === connectionId);
        return {
          connectionId,
          state: "live",
          firstObservedAt: row?.firstObservedAt ?? null,
          lastObservedAt: row?.lastObservedAt ?? null,
        };
      });
    for (const row of observed) {
      if (!live.has(row.connectionId) && connections.length < 100) {
        connections.push({ ...row, state: "closed_or_unavailable" });
      }
    }
    const jobRows = this.db
      .query<
        {
          jobId: string;
          machineId: string;
          pluginId: string;
          operationId: string;
          installationRevision: string;
          artifactSha256: string;
          state: AgentRunInspection["jobs"][number]["state"];
          createdAt: number;
          startedAt: number | null;
          finishedAt: number | null;
          exitCode: number | null;
          traceId: string;
          retained: number;
          parentJobId: string | null;
          terminalId: string | null;
          ownerClosed: number;
        },
        [string]
      >(
        // A broker-bound terminal run wins over its sponsor's credential and trace.
        // Otherwise legacy attribution, then the exact credential, owns the projection.
        `WITH candidates AS (
        SELECT job_id,machine_id,plugin_id,request,state,created_at,result,owner_closed
          FROM machine_jobs j WHERE COALESCE(json_extract(j.request,'$.terminal.runId'),j.run_id,
            (SELECT run_id FROM tokens WHERE id=json_extract(j.request,'$.credential.tokenId')),
            (SELECT run_id FROM events WHERE type='trace' AND id=json_extract(j.request,'$.traceId')))=?1
        UNION ALL
        SELECT o.job_id,json_extract(o.request,'$.machineId'),json_extract(o.request,'$.pluginId'),
          o.request,o.state,o.nominal,NULL,0 FROM job_schedule_occurrences o
          WHERE COALESCE(json_extract(o.request,'$.terminal.runId'),o.run_id,
            (SELECT run_id FROM tokens WHERE id=json_extract(o.request,'$.credential.tokenId')),
            (SELECT run_id FROM events WHERE type='trace' AND id=json_extract(o.request,'$.traceId')))=?1
            AND NOT EXISTS(SELECT 1 FROM machine_jobs j WHERE j.job_id=o.job_id)
       )
       SELECT j.job_id AS jobId,j.machine_id AS machineId,j.plugin_id AS pluginId,
        json_extract(j.request,'$.operationId') AS operationId,
        json_extract(j.request,'$.installationRevision') AS installationRevision,
        json_extract(j.request,'$.artifactSha256') AS artifactSha256,
        j.state,j.created_at AS createdAt,json_extract(j.result,'$.startedAt') AS startedAt,
        json_extract(j.result,'$.finishedAt') AS finishedAt,json_extract(j.result,'$.exitCode') AS exitCode,
        json_extract(j.request,'$.traceId') AS traceId,
        EXISTS(SELECT 1 FROM events e WHERE e.type='trace' AND e.id=json_extract(j.request,'$.traceId')
          AND (e.run_id=?1 OR (json_extract(j.request,'$.terminal.runId')=?1
            AND e.principal_id=json_extract(j.request,'$.credential.principalId')))) AS retained,
        json_extract(j.request,'$.parent.parentJobId') AS parentJobId,
        json_extract(j.request,'$.terminal.terminalId') AS terminalId,j.owner_closed AS ownerClosed
       FROM candidates j
       ORDER BY j.created_at DESC,j.job_id DESC LIMIT 101`,
      )
      .all(runId);
    const jobs: AgentRunInspection["jobs"] = jobRows.slice(0, 100).map((row) => ({
      jobId: safeJobId(row.jobId),
      machineId: safeText(row.machineId),
      pluginId: safeText(row.pluginId),
      operationId: safeText(row.operationId),
      installationRevision: safeText(row.installationRevision),
      artifactSha256: row.artifactSha256,
      state: row.state,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      exitCode: row.exitCode,
      traceId: safeText(row.traceId),
      origin: row.retained === 1 && /^[1-9][0-9]*$/.test(row.traceId) ? "retained" : "unavailable",
      parentJobId: row.parentJobId === null ? null : safeJobId(row.parentJobId),
      terminalId: row.terminalId === null ? null : safeText(row.terminalId),
      ownerState: row.ownerClosed === 1 ? "closed" : "unconfirmed",
    }));
    const terminalRows = this.db
      .query<
        {
          terminalId: string;
          machineId: string;
          containerId: string;
          createdAt: number;
          state: "running" | "exited";
          exitCode: number | null;
          traceId: string | null;
        },
        [string]
      >(
        `WITH run_jobs AS (
        SELECT request FROM machine_jobs j
          WHERE COALESCE(json_extract(j.request,'$.terminal.runId'),j.run_id,
            (SELECT run_id FROM tokens WHERE id=json_extract(j.request,'$.credential.tokenId')),
            (SELECT run_id FROM events WHERE type='trace' AND id=json_extract(j.request,'$.traceId')))=?1
       ), native_origins AS (
        SELECT target.value AS uri,MIN(e.id) AS trace_id
        FROM events e JOIN json_each(e.targets) target
        WHERE e.type='trace' AND e.run_id=?1 AND e.door='core.terminals.create' AND e.outcome='ok'
        GROUP BY target.value
       )
       SELECT t.id AS terminalId,t.machine_id AS machineId,t.container_id AS containerId,
        t.created_at AS createdAt,t.status AS state,t.exit_code AS exitCode,
        COALESCE((SELECT CAST(e.id AS TEXT) FROM run_jobs j JOIN events e ON e.id=json_extract(j.request,'$.traceId')
          WHERE e.type='trace' AND (e.run_id=?1 OR (json_extract(j.request,'$.terminal.runId')=?1
            AND e.principal_id=json_extract(j.request,'$.credential.principalId')))
            AND json_extract(j.request,'$.terminal.terminalId')=t.id
          ORDER BY e.id DESC LIMIT 1),CAST(o.trace_id AS TEXT)) AS traceId
       FROM terminals t LEFT JOIN native_origins o ON o.uri='manifold://terminal/'||t.id
       WHERE t.run_id=?1 OR (t.run_id IS NULL AND t.created_by_run_id=?1)
         OR EXISTS(SELECT 1 FROM run_jobs j WHERE json_extract(j.request,'$.terminal.terminalId')=t.id)
       ORDER BY t.created_at DESC,t.id DESC LIMIT 101`,
      )
      .all(runId);
    const terminals: AgentRunInspection["terminals"] = terminalRows.slice(0, 100).map((row) => ({
      terminalId: safeText(row.terminalId),
      machineId: safeText(row.machineId),
      containerId: safeText(row.containerId),
      createdAt: row.createdAt,
      state: row.state,
      exitCode: row.exitCode,
      traceId: row.traceId,
      retention: "retained",
    }));
    return {
      credentials,
      connections,
      traces,
      jobs,
      terminals,
      nextBeforeTraceId: traceRows.length > input.limit ? (traces.at(-1)?.traceId ?? null) : null,
      requestedTrace:
        input.traceId === undefined
          ? "not_requested"
          : traces.length === 0
            ? "unavailable"
            : "available",
      history: "retained_only",
      nativeTruncated: jobRows.length > 100 || terminalRows.length > 100,
    };
  }

  createMachine(machine: MachineRecord): void {
    this.db
      .query<void, [string, string, string, number, string | null, number]>(
        "INSERT INTO machines(id, name, token_id, last_seen, owner_host_id, draining) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        machine.id,
        machine.name,
        machine.tokenId,
        machine.lastSeen,
        machine.ownerHostId,
        machine.draining ? 1 : 0,
      );
  }

  updateMachineToken(machineId: string, tokenId: string, at: number): void {
    this.db
      .query<void, [string, number, string]>(
        "UPDATE machines SET token_id = ?, last_seen = ? WHERE id = ?",
      )
      .run(tokenId, at, machineId);
  }

  getMachine(id: string): MachineRecord | null {
    const row = this.db.query<MachineRow, [string]>(`${MACHINE_SELECT} WHERE id = ?`).get(id);
    return row === null ? null : toMachine(row);
  }

  getMachineByName(name: string): MachineRecord | null {
    const row = this.db.query<MachineRow, [string]>(`${MACHINE_SELECT} WHERE name = ?`).get(name);
    return row === null ? null : toMachine(row);
  }

  listMachines(): MachineRecord[] {
    return this.db
      .query<MachineRow, []>(`${MACHINE_SELECT} ORDER BY name, id`)
      .all()
      .map(toMachine);
  }

  hasMachineTerminals(machineId: string): boolean {
    return (
      this.db
        .query<{ id: string }, [string]>("SELECT id FROM terminals WHERE machine_id = ? LIMIT 1")
        .get(machineId) !== null
    );
  }

  /** Includes old rotated credentials; journal and trace references deliberately survive. */
  deleteMachine(machineId: string): void {
    this.transaction(() => {
      this.db.query("DELETE FROM machines WHERE id = ?").run(machineId);
      this.db.query("DELETE FROM tokens WHERE principal_id = ?").run(machineId);
    });
  }

  /**
   * Sets the admission latch (`core.machines.drain`). Persisted BEFORE the owner is asked,
   * so a hub restart between the two cannot reopen admission by forgetting it was closed.
   */
  setMachineDraining(machineId: string, draining: boolean): void {
    this.db
      .query<void, [number, string]>("UPDATE machines SET draining = ? WHERE id = ?")
      .run(draining ? 1 : 0, machineId);
  }

  /**
   * Which enrolled machines hold a WITHDRAWN credential (`core.machines.revoke`,
   * ADR 0019 §3).
   *
   * A machine row survives its credential — revoking a machine revokes that machine's
   * credential, not the inventory entry — so "revoked" is a fact about the token the row
   * currently references, and this is the one join that decides it. A LEFT join, because a
   * machine whose token row has gone is not authenticating either: a credential that cannot
   * be found cannot be presented, and reporting it live would be the one lie this read could
   * tell.
   *
   * A Set rather than a per-machine question, because the caller is a LIST: asking the
   * database once per row is the N+1 the roster read exists to avoid.
   */
  revokedMachineIds(): ReadonlySet<string> {
    const rows = this.db
      .query<{ id: string }, []>(
        `SELECT m.id AS id
         FROM machines m LEFT JOIN tokens t ON t.id = m.token_id
         WHERE t.id IS NULL OR t.revoked_at IS NOT NULL`,
      )
      .all();
    return new Set(rows.map((row) => row.id));
  }

  authenticateMachine(hash: string): MachineAuthRecord | null {
    const row = this.db
      .query<MachineAuthRow, [string]>(
        `SELECT m.id, m.name, m.token_id, m.last_seen, m.owner_host_id, m.draining,
                m.last_refusal_code, m.last_refusal_at,
                t.hash, t.principal_id, t.revoked_at
         FROM machines m JOIN tokens t ON t.id = m.token_id
         WHERE t.hash = ?`,
      )
      .get(hash);
    if (row === null) return null;
    return {
      ...toMachine(row),
      tokenPrincipalId: row.principal_id,
      revokedAt: row.revoked_at,
    };
  }

  /**
   * Records a parsed hello's refusal only when its presented secret belongs to a durable
   * machine, including a rotated historical secret. Unknown tokens never create roster state.
   */
  recordMachineRefusal(hash: string, code: MachineRefusal["code"], at: number): boolean {
    return (
      this.db
        .query<void, [number, number, string]>(
          `UPDATE machines
              SET last_refusal_code = ?, last_refusal_at = ?
            WHERE id = (SELECT principal_id FROM tokens WHERE hash = ?)`,
        )
        .run(code, at, hash).changes > 0
    );
  }

  /**
   * The one write an ADMITTED hello makes: the name the agent reported, when, and WHO owns
   * its PTYs (#278) — the hello's `terminalHostId`, or null for an agent that is its own
   * owner. Written at admission and nowhere else, so `owner_host_id` always describes a
   * connection the hub actually accepted, which is what a later newcomer is judged against.
   *
   * The name claim is part of the write rather than a preceding lookup: the unique name
   * constraint is an admission decision, not an exception that may escape the socket boundary.
   */
  touchMachine(machineId: string, name: string, at: number, ownerHostId: string | null): boolean {
    return (
      this.db
        .query<void, [string, number, string | null, string, string]>(
          `UPDATE machines
           SET name = ?, last_seen = ?, owner_host_id = ?,
               last_refusal_code = NULL, last_refusal_at = NULL
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM machines AS incumbent
               WHERE incumbent.name = ? AND incumbent.id <> machines.id
             )`,
        )
        .run(name, at, ownerHostId, machineId, name).changes === 1
    );
  }

  createTerminal(terminal: NewStoredTerminal): void {
    const session = terminal.session === undefined ? undefined : SessionRefSchema.parse(terminal.session);
    if (session !== undefined && session.machineId !== terminal.machineId)
      throw new Error("terminal session machine does not match");
    this.db
      .query<
        void,
        [
          string,
          string,
          string,
          string,
          string | null,
          string,
          null,
          number,
          null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO terminals(
           id, machine_id, container_id, created_by, agent_principal_id,
           status, exit_code, created_at, name, cwd, launch_recipe, run_id, created_by_run_id, session
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        terminal.id,
        terminal.machineId,
        terminal.containerId,
        terminal.createdBy,
        terminal.agentPrincipalId,
        "running",
        null,
        terminal.createdAt,
        null,
        terminal.cwd ?? null,
        terminal.launchRecipe === undefined
          ? null
          : JSON.stringify(TerminalLaunchRecipeSchema.parse(terminal.launchRecipe)),
        terminal.runId ?? null,
        terminal.createdByRunId ?? null,
        session === undefined ? null : JSON.stringify(session),
      );
  }

  getTerminal(id: string): StoredTerminal | null {
    const row = this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name, cwd, launch_recipe, run_id, session
         FROM terminals WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toTerminal(row);
  }

  getTerminalForRun(runId: string): StoredTerminal | null {
    const row = this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name, cwd, launch_recipe, run_id, session
         FROM terminals WHERE run_id = ? ORDER BY created_at, id LIMIT 1`,
      )
      .get(runId);
    return row === null ? null : toTerminal(row);
  }

  listTerminals(): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, []>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name, cwd, launch_recipe, run_id, session
         FROM terminals ORDER BY created_at, id`,
      )
      .all()
      .map(toTerminal);
  }

  listRunningTerminalsForMachine(machineId: string): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name, cwd, launch_recipe, run_id, session
         FROM terminals WHERE machine_id = ? AND status = 'running' ORDER BY created_at, id`,
      )
      .all(machineId)
      .map(toTerminal);
  }

  deleteTerminal(id: string): boolean {
    return this.db.query<void, [string]>("DELETE FROM terminals WHERE id = ?").run(id).changes > 0;
  }

  markTerminalExited(id: string, exitCode: number | null): boolean {
    return (
      this.db
        .query<void, [number | null, string]>(
          "UPDATE terminals SET status = 'exited', exit_code = ? WHERE id = ?",
        )
        .run(exitCode, id).changes > 0
    );
  }

  markTerminalRunning(id: string, agentPrincipalId: string | null): void {
    this.db
      .query(
        "UPDATE terminals SET status = 'running', exit_code = NULL, agent_principal_id = ? WHERE id = ?",
      )
      .run(agentPrincipalId, id);
  }

  updateTerminalCwd(id: string, cwd: string): void {
    this.db.query("UPDATE terminals SET cwd = ? WHERE id = ?").run(cwd, id);
  }

  /**
   * Moves a terminal to a different home container. A terminal is never unbound: it is
   * deleted, or it lives somewhere. Which is why this takes no null.
   */
  updateTerminalContainer(id: string, containerId: string): void {
    this.db
      .query<void, [string, string]>("UPDATE terminals SET container_id = ? WHERE id = ?")
      .run(containerId, id);
  }

  /** Sets or clears a terminal's operator-assigned display name. */
  updateTerminalName(id: string, name: string | null): void {
    this.db
      .query<void, [string | null, string]>("UPDATE terminals SET name = ? WHERE id = ?")
      .run(name, id);
  }

  /** Terminals homed in one container, in creation order. */
  listTerminalsForContainer(containerId: string): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name, cwd, launch_recipe, run_id, session
         FROM terminals WHERE container_id = ? ORDER BY created_at, id`,
      )
      .all(containerId)
      .map(toTerminal);
  }
}
