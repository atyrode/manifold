import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentAuthoritySchema,
  AgentGrantAuthoritySchema,
  AgentRunAuthoritySchema,
  AuthorityScopeSchema,
  canonicalizeAuthorityScope,
  scopeAdmits,
  scopeWithin,
  projectLegacyAgent,
  projectLegacyRun,
  projectLegacyCaps,
  projectAgentV2,
  projectRunV2,
  MintTokenV2RequestSchema,
  RegisterAgentV2RequestSchema,
  UpdateAgentV2RequestSchema,
  CreateRunV2RequestSchema,
  CreateChildRunV2RequestSchema,
  type AuthorityScope,
  type GrantNode,
  type MintTokenV2Request,
  type TokenGrantV2,
  type RegisterAgentV2Request,
  type RegisterAgentV2Result,
  type UpdateAgentV2Request,
  type GetAgentV2Result,
  type ListAgentsV2Result,
  type CreateRunV2Request,
  type CreateChildRunV2Request,
  type CreateRunV2Result,
  type RenewAgentRunV2Result,
  type FinishAgentRunV2Result,
  type ReportRunActivityV2Result,
  type AcknowledgeAgentPolicyV2Result,
  type PrincipalCredentialsV2,
  type InspectRunV2Result,
  type ListRunsV2Result,
  type ReportRunActivityResult,
  AgentRunInspectionV2Schema,
  AgentRunInventorySchema,
  projectLegacyCredential,
  RegisterAgentRequestSchema,
  UpdateAgentRequestSchema,
  CreateRunRequestSchema,
  CreateChildRunRequestSchema,
  ReportRunActivityRequestSchema,
  InspectRunRequestSchema,
  type InspectRunRequest,
  type InspectRunResult,
  type AgentAuthority as Agent,
  type AgentGrantAuthority as AgentGrant,
  type Agent as LegacyAgent,
  type AgentRun as LegacyRun,
  type AgentRequest,
  type RegisterAgentRequest,
  type RegisterAgentResult,
  type UpdateAgentRequest,
  type GetAgentResult,
  type ListAgentsResult,
  type CreateRunRequest,
  type CreateChildRunRequest,
  type CreateRunResult,
  type ListRunsRequest,
  type ListRunsResult,
  type ReportRunActivityRequest,
  type SessionRef,
  type HarnessTarget,
  type ActionResultApproval,
  AcknowledgeAgentPolicyRequestSchema,
  AgentRunInspectionSchema,
  FinishAgentRunRequestSchema,
  RenewAgentRunRequestSchema,
  type AgentRunInspection,
  AGENT_RUN_MAX_RENEWALS,
  BootstrapPrincipalRequestSchema,
  CAPS,
  GOVERNED_CAPS,
  ManifoldRefSchema,
  type ManifoldRef,
  CreateGrantRequestSchema,
  MANIFOLD_ROOT_URI,
  MintShareRequestSchema,
  ApproveShareRecipientRequestSchema,
  RemoveShareRecipientRequestSchema,
  PrincipalSchema,
  MintTokenRequestSchema,
  canContain,
  containmentPath,
  formatManifoldUri,
  hasCap,
  isEngineCap,
  parseManifoldUri,
  normalizeInstanceOrigin,
  type AcknowledgeAgentPolicyRequest,
  type AcknowledgeAgentPolicyResult,
  type AgentPolicyChallenge,
  type AgentRunAuthority as AgentRun,
  type AgentRunAuthorityCap as AgentRunCap,
  type AgentRunState,
  type FinishAgentRunRequest,
  type FinishAgentRunResult,
  type GrantReach,
  type ReloadAgentPolicyResult,
  type RenewAgentRunRequest,
  type RenewAgentRunResult,
  type BootstrapPrincipalRequest,
  type AuthoredCap,
  type AskableCap,
  type Cap,
  type CreateGrantRequest,
  type Grant,
  type GrantPrincipal,
  type ListGrantsRequest,
  type MintShareRequest,
  type ApproveShareRecipientRequest,
  type RemoveShareRecipientRequest,
  type ShareRecipient,
  type MintTokenRequest,
  type Principal,
  type MachineRefusal,
  type RuntimeDeps,
  type Share,
  type ShareGrant,
  type PrincipalCredentials,
  type PrincipalAccessPauseRequest,
  type PrincipalAccessPauseResult,
  type PreviewIdentityClaims,
  PrincipalAccessPauseRequestSchema,
  type TokenGrant,
} from "@manifold/protocol";
import type {
  GrantRecord,
  AgentRecord,
  MachineAuthRecord,
  MachineRecord,
  ServerStore,
  ShareRecord,
  TokenRecord,
  AgentRunRecord,
  TokenRevocation,
} from "./stores.ts";
import { sha256Hex } from "./stores.ts";
import { loadAgentPolicy, type AgentPolicySet } from "./agent-runs.ts";
import { normalizeAgentDeclaration } from "./log.ts";

type AgentAuthorityResult = { agent: Agent; canManage: boolean };
type RegisterAgentAuthorityResult = {
  agent: Agent;
  created: boolean;
  credential?: { token: string; expiresAt: number };
};
type CreateRunAuthorityResult = {
  run: AgentRun;
  credential?: { token: string; expiresAt: number };
};
type FinishRunAuthorityResult = {
  run: AgentRun;
  finishedRuns: number;
  revokedCredentials: number;
  revokedGrants: number;
};
type RenewRunAuthorityResult = {
  run: AgentRun;
  credential: { token: string; expiresAt: number };
  revokedCredentials: number;
};
type RegisterAgentAuthorityInput = Omit<RegisterAgentRequest, "grant"> & { grant: AgentGrant };
type UpdateAgentAuthorityInput = Omit<UpdateAgentRequest, "grant"> & {
  grant?: AgentGrant | undefined;
};
type CreateRunAuthorityInput = Omit<CreateRunRequest, "caps"> & {
  caps?: readonly AgentRunCap[] | undefined;
  authorityScope?: AuthorityScope;
  scopedApi?: boolean;
};

function standingScope(grant: AgentGrant): AuthorityScope {
  return (
    grant.authorityScope ??
    grant.targets.map((target) => ({
      target,
      reach: grant.reach,
      caps: [...grant.caps],
    }))
  );
}

function runScope(
  run: Pick<AgentRunRecord, "authorityScope" | "caps" | "target" | "reach">,
): AuthorityScope {
  return run.authorityScope ?? [{ target: run.target, reach: run.reach, caps: [...run.caps] }];
}

function internalGrant(grant: RegisterAgentV2Request["grant"]): AgentGrant {
  const authorityScope = canonicalizeAuthorityScope(grant.scope);
  return {
    caps: [...new Set(authorityScope.flatMap((entry) => entry.caps))] as AgentGrant["caps"],
    targets: [...new Set(authorityScope.map((entry) => entry.target))],
    reach: "subtree",
    authorityScope,
    maxRunLifetimeMs: grant.maxRunLifetimeMs,
    delegation: grant.delegation,
    expiresAt: grant.expiresAt,
    ...(grant.tools === undefined ? {} : { tools: grant.tools }),
  };
}

const OWNER_PRINCIPAL_META = "owner_principal_id";
const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"] as const;

/**
 * Every capability a grant's `*` stands for: the wildcard, expanded once — and the engine's
 * own capabilities are all of it. A plugin's namespaced capability (ADR 0035) is never part of
 * a wildcard's expansion, because the open half has no enumeration that does not depend on
 * which plugins happen to be installed, and an authority answer that moved with the roster
 * would be a denial that depends on bookkeeping.
 */
const CONCRETE_CAPS: readonly Exclude<Cap, "*">[] = CAPS.filter(
  (cap): cap is Exclude<Cap, "*"> => cap !== "*",
);

/**
 * A path step beneath a node that no grant row can name (rows store canonical `manifold://`
 * nodes), so a walk ending here sees exactly the `subtree` rows above it: any child the node may
 * hold that has no rows of its own. Only ever appended beneath a node `canContain` admits.
 */
const BENEATH_ANY_NODE = "\u0000beneath";

/**
 * HOW LONG AN INTERACTIVELY MINTED CREDENTIAL LIVES — fourteen days (ADR 0019 §2).
 *
 * The number is a judgement and therefore has to be argued rather than picked. Two failure
 * modes bound it from opposite sides:
 *
 *   TOO LONG is the hole this closes. There was no expiry at all, so a key pasted into a
 *   browser two months ago still authenticated — and the browser it was pasted into may be a
 *   synced profile on a laptop somebody sold.
 *
 *   TOO SHORT is worse than no expiry, and this is the half a security review usually
 *   misses. Re-bootstrapping means pasting the OWNER KEY into an address bar again. A bound
 *   that fires while somebody is still working therefore trains the one habit docs/CONTRACTS.md §Data and credential boundaries
 *   and issue #56 both exist to discourage, and it trains it on the credential that is root
 *   everywhere. An expiry that makes the root secret travel more often has made the posture
 *   worse while looking like it improved it.
 *
 * Fourteen days sits between them: longer than any plausible gap in a single operator's week
 * (a holiday is the boundary case, and meeting it once a year is a re-bootstrap nobody
 * resents), and short enough that a forgotten browser stops authenticating inside a
 * fortnight rather than never. It is deliberately NOT an idle bound — an idle timer would
 * fire hardest on exactly the careful operator who keeps one tab open and touches it rarely.
 */
export const INTERACTIVE_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** Ordinary automated credentials expire after one hour, including federated tickets (#326). */
export const AUTOMATED_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * HOW OFTEN THE OWNER PATH LEAVES A ROW — once an hour, at most (ADR 0019 §4).
 *
 * `authenticate` runs on EVERY request carrying the key, and a browser painting a workspace
 * makes dozens: a row per authentication would be a denial of service on the reader of the
 * journal the row exists for, which is the failure ADR 0019 §4 names explicitly.
 *
 * The window is the DE-DUPLICATION RULE, and it is a window rather than a session because
 * nothing that reaches this function knows what a session is. `authenticate` takes a raw
 * secret and nothing else — no socket, no request, no connection id — and threading a
 * transport fact into the one function that must stay transport-agnostic to serve HTTP, the
 * session channel and the instance channel alike would buy a sharper row at the cost of the
 * seam. So the row means "at least one owner-key authentication happened in the hour
 * beginning here", and it says so on the row itself (`window` in the payload) rather than
 * letting a reader infer one-row-one-login.
 */
export const OWNER_AUDIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * WHETHER A MINTED CREDENTIAL EXPIRES, decided at the mint and written down (ADR 0019 §2).
 *
 * `never` is the EXEMPTION, and it is a parameter rather than a branch inside `persistToken`
 * so that every mint site states its own answer where a reader of that site can see it. It
 * is deliberately not reachable from any door: `core.access.mint` cannot ask for an
 * unexpiring credential, because an exemption a caller can select is not an exemption, it is
 * an opt-out.
 */
type TokenExpiry = "interactive" | "automated" | "never";

/**
 * Ordinary principals always receive finite credentials. Machine enrollment and internally
 * generated terminal credentials choose their lifecycle exemptions explicitly at the mint.
 */
function expiryFor(kind: Principal["kind"]): TokenExpiry {
  return kind === "human" ? "interactive" : "automated";
}

const TERMINAL_AGENT_RUN_STATES = new Set([
  "completed",
  "failed",
  "cancelled",
  "abandoned",
  "expired",
  "revoked",
  "cleanup_failed",
]);

function runContainsNode(run: Pick<AgentRunRecord, "target" | "reach">, node: string): boolean {
  if (run.reach === "node") return run.target === node;
  const path = containmentPath(node);
  return path !== null && path.includes(run.target);
}

function runContainerScope(target: string): string | null {
  const ref = parseManifoldUri(target);
  return ref !== null && "containerId" in ref ? ref.containerId : null;
}

/**
 * Principal and attenuated authority computed once when a request/socket authenticates.
 *
 * `caps` and `containerScope` are what the credential's MINTER CHOSE, and the mint ladder
 * keeps reading them. `grantId` is the credential's reference to the grant row the EVALUATOR
 * reads (ADR 0011). A null `grantId` belongs to the owner key alone: it authenticates outside
 * the token system entirely, so it has no row to reference and the evaluator synthesizes its
 * root grant instead of storing one anybody could delete.
 *
 * ROOT-CLASS AUTHORITY IS DELIBERATELY NOT A FIELD (#411). Whether a credential may open a
 * declared-`*` door depends on the administered denies in force when it asks, so it is the live
 * question {@link AuthService.holdsRoot}, never a flag frozen at authentication.
 */
export interface AuthContext {
  principal: Principal;
  caps: readonly Cap[];
  containerScope: string | null;
  tokenId: string | null;
  grantId: string | null;
  /** Absolute credential expiry; absent for owner, machine, and terminal-lifecycle paths. */
  expiresAt?: number | undefined;
  /** Present only for credentials issued through the sponsor-bound autonomous-run path. */
  agentRunId?: string | undefined;
  /** A runner credential admits runs for exactly this Agent and cannot invoke ordinary doors. */
  agentRunnerId?: string | undefined;
  /**
   * CONTAINER AUTHORITY CARRIED BY BACKGROUND WORK (ADR 0051). Absent on every credential a
   * client authenticates, and absent means exactly what it always meant. Present only on the
   * native bridge of a dispatch and on the job and schedule credentials restored from it.
   * PRESENCE IS THE CONFINEMENT: a context carrying a list — even an empty one — holds the
   * container capabilities ONLY where a grant in it names them, never through `caps` and never
   * at the root, and is never root-class. `credentialReference` keeps the list on the lineage
   * and `restoreCredential` reads it back, so no refresh can shed it.
   */
  containerGrants?: readonly ContainerGrant[] | undefined;
  /** Immutable correlated credential ceiling; only absence retains legacy authority. */
  authorityScope?: AuthorityScope | undefined;
}

/**
 * The engine capabilities a governed door may hand to the work it starts, bound to the ONE
 * container its requirement names (ADR 0051). Container authority only: `delegates` stay
 * native-only and every other cap keeps the flat ceiling ADR 0041 §2 describes.
 */
export const CONTAINER_GRANT_CAPS = [
  "containers:read",
  "containers:write",
] as const satisfies readonly Cap[];
export type ContainerGrantCap = (typeof CONTAINER_GRANT_CAPS)[number];
export function isContainerGrantCap(cap: AuthoredCap): cap is ContainerGrantCap {
  return (CONTAINER_GRANT_CAPS as readonly string[]).includes(cap);
}
/** Caps a credential holds only at and beneath `manifold://container/<containerId>`. */
export interface ContainerGrant {
  readonly containerId: string;
  readonly caps: readonly ContainerGrantCap[];
}
/** The persisted form, parsed wherever a job or schedule row is read back. */
export const ContainerGrantsSchema = z
  .array(
    z.strictObject({
      containerId: z.string().min(1).max(128),
      caps: z
        .array(z.enum(CONTAINER_GRANT_CAPS))
        .min(1)
        .max(CONTAINER_GRANT_CAPS.length)
        .refine((caps) => new Set(caps).size === caps.length),
    }),
  )
  .max(64);

function withinContainer(node: string, containerId: string): boolean {
  return (
    containmentPath(node)?.includes(formatManifoldUri({ kind: "container", containerId })) === true
  );
}

export interface NativeRunAuthority {
  readonly auth: AuthContext;
  readonly run: AgentRun;
  readonly agent: Agent;
}

function contextContainsNode(context: AuthContext, node: string): boolean {
  if (context.authorityScope !== undefined)
    return context.authorityScope.some(
      ({ target, reach }) =>
        target === node || (reach === "subtree" && containmentPath(node)?.includes(target)),
    );
  if (context.containerScope === null) return true;
  const path = containmentPath(node);
  return (
    path !== null &&
    path.includes(formatManifoldUri({ kind: "container", containerId: context.containerScope }))
  );
}

/**
 * Non-secret lineage; never reconstruct delayed authority from a principal alone.
 *
 * It carries the lineage's container confinement (`containerGrants`, ADR 0051), so every
 * `restoreCredential(credentialReference(context))` refresh answers as confined as the context
 * it came from. The one place it leaves the hub — the `credential` of a signed job request,
 * which a machine's owner parses strictly — takes it apart: the request carries the rest, and
 * the hub keeps the grants beside it (`JobService` `build`, `jobCredential`).
 */
export type CredentialReference = Readonly<
  Pick<
    AuthContext,
    | "tokenId"
    | "grantId"
    | "caps"
    | "containerScope"
    | "expiresAt"
    | "containerGrants"
    | "authorityScope"
  > & {
    principalId: string;
  }
>;
/**
 * One authority question the GOVERNED runtime carries: a capability and the canonical node it
 * is discharged at, persisted with a job and re-asked at every deferred effect (ADR 0033).
 *
 * The engine's own vocabulary, deliberately (ADR 0035). Governed admission binds a capability
 * to an artifact or resource REVISION the engine acquired and pinned, and a plugin's own
 * namespaced capability has no revision to bind: it is discharged at the action door, against
 * the rows at its target node, and never enters a job's admission evidence. An action may hold
 * both kinds — the door asks each at its own target — and only the engine's reach this type.
 */
export interface AuthorityRequirement {
  readonly cap: Exclude<Cap, "*">;
  readonly ref: ManifoldRef;
}
export interface AuthorityEvidence {
  readonly requirement: AuthorityRequirement;
  /** The exact winning row, not a guessed row version or process-local grantsEpoch. */
  readonly winner: Grant | null;
  readonly allowed: boolean;
}
export interface GovernedAdmissionRequest {
  readonly credential: CredentialReference;
  readonly pluginId: string;
  readonly action: string;
  readonly evidence: readonly AuthorityEvidence[];
}
export type GovernedAdmissionDecision =
  | { readonly allowed: false }
  | {
      readonly allowed: true;
      /** Durable store decision committed with policy/consent and credential re-discharge. */
      readonly decisionId: string;
      readonly policyRevision: string;
      readonly consentRevisions: readonly {
        readonly node: string;
        readonly revision: string;
        readonly artifactSha256: string;
      }[];
    };
/** Trusted store port, never supplied by plugin code. Must recheck current credential,
 * ceilings, grants and explicit version-bound consent transactionally before allowing. */
export interface GovernedAdmission {
  decide(request: GovernedAdmissionRequest): GovernedAdmissionDecision;
}

/** Stable service-layer error codes mapped to HTTP and socket policy at boundaries. */
export type ServiceErrorCode = "unauthorized" | "forbidden" | "not_found" | "conflict";

/** Expected auth/domain rejection, distinct from internal persistence failures. */
export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/** Raw one-time machine enrollment result. */
export interface MachineEnrollment {
  machine: MachineRecord;
  machineToken: string;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }
  return COLORS[hash % COLORS.length] ?? "#2563eb";
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/**
 * The durable row as the wire says it. `ref` is the canonical `manifold://` addressing form
 * rather than a bare container id (docs/CONTRACTS.md §Reference nodes) — a grant that named its node any other way
 * would be a second address system, and ADR 0011 widens exactly this field to subtree grants.
 */
function toShare(record: ShareRecord): Share {
  return {
    id: record.id,
    ref: { kind: "container", containerId: record.containerId },
    caps: [...record.caps],
    origin: record.origin,
    createdAt: record.createdAt,
    createdBy: record.mintedBy,
    revokedAt: record.revokedAt,
    tickets: record.tickets,
  };
}

/*
  ───────────────────────────────────────────────────── THE WATERFALL (ADR 0011)

  Authority is a set of rows on the node tree, and evaluating it is a walk from the workspace
  root down to the node in question. Everything below this line is that walk. It is deliberately
  free of `AuthService` state: given rows, a path and a question, the answer is a pure function,
  which is what makes the parity matrix able to replay a fixture and compare byte for byte.

  Precedence is ADR 0011's, in ADR 0011's order, and it resolves PER CAPABILITY rather than per
  row. That is the only reading under which a denial means anything: a deny row naming
  `scenes:write` at a container has to beat a `*` allow at the root for that one capability while
  leaving `containers:read` exactly where it was. So a row participates in the contest for cap
  `c` only if it MENTIONS `c` — a row carrying `*` mentions every capability — and the winner's
  effect is the answer.
*/

/**
 * Rule 2, as a number. Principal-specific beats class-wildcard beats instance-kind, because a
 * row naming one person is a more considered statement than a row naming everybody like them.
 */
function specificity(principal: GrantPrincipal): number {
  switch (principal.kind) {
    case "principal":
      return 3;
    case "any-human":
    case "any-agent":
      return 2;
    case "instance":
      return 1;
    default: {
      const exhaustive: never = principal;
      return exhaustive;
    }
  }
}

/** Whether a row's WHO covers this principal. */
function namesPrincipal(who: GrantPrincipal, subject: Principal): boolean {
  switch (who.kind) {
    case "principal":
      return who.id === subject.id;
    case "any-human":
      return subject.kind === "human";
    case "any-agent":
      return subject.kind === "agent";
    /*
      FEDERATION, and the one field ADR 0011 leaves inert until wave 3 supplies values for it.
      A principal with no origin belongs to THIS instance, and this instance's own origin is a
      configuration fact the evaluator deliberately does not read: authority here is decided by
      the node tree, and a local principal already has rows naming it or its class.
    */
    case "instance":
      return subject.origin !== undefined && subject.origin === who.origin;
    default: {
      const exhaustive: never = who;
      return exhaustive;
    }
  }
}

/**
 * Whether `left` outranks `right` for whichever capability both mention. ADR 0011's four rules
 * in its order — deeper node, then principal specificity, then `deny` over `allow`, then newer
 * `createdAt` — with the row id as a final key.
 *
 * Specificity sits ABOVE effect on purpose, and it is the rule most likely to be got wrong: an
 * `any-human` deny does NOT beat a principal-specific allow at the same node, because the class
 * row loses at rule 2 and never reaches rule 3. "Everyone here is read-only except Ana" is the
 * sentence that ordering makes sayable, and inverting the two would delete it.
 *
 * The id is a tiebreak ADR 0011 does not name, and it is there for the reason ADR 0011 gives for
 * `createdAt`: the relation must be TOTAL, so evaluation is never order-dependent on how SQLite
 * happened to return two rows written in the same millisecond. Both rows at that point carry the
 * same effect, so the key decides which row is cited and never what the answer is.
 */
function outranks(left: RankedGrant, right: RankedGrant): boolean {
  if (left.depth !== right.depth) return left.depth > right.depth;
  const leftSpecificity = specificity(left.row.principal);
  const rightSpecificity = specificity(right.row.principal);
  if (leftSpecificity !== rightSpecificity) return leftSpecificity > rightSpecificity;
  if (left.row.effect !== right.row.effect) return left.row.effect === "deny";
  if (left.row.createdAt !== right.row.createdAt) return left.row.createdAt > right.row.createdAt;
  return left.row.id > right.row.id;
}

/** One applicable row, with the depth its node sits at on the walked path. */
interface RankedGrant {
  readonly row: Grant;
  readonly depth: number;
}

/**
 * The capabilities `rows` leave in force at the END of `path`.
 *
 * `rows` are already narrowed to this principal by the store's query; what happens here is the
 * REACH check and the contest. A `subtree` row applies from its node downward, so being on the
 * path is enough; a `node` row applies at its exact node only, which is what makes element-level
 * authority sayable without granting the container the element lives in.
 *
 * The wildcard is expanded rather than carried, because a set containing `*` cannot express "all
 * of them except the one denied here" — and that sentence is precisely what a deny row at depth
 * beneath a root `*` allow has to mean.
 *
 * WHAT IS CONTESTED is the engine's closed set plus every plugin capability some applicable row
 * NAMES (ADR 0035). The open half cannot be enumerated — there is no list of every capability
 * every installable plugin might declare — but it does not need to be: a capability no row on
 * this path mentions is one nobody granted or denied here, so contesting it could only ever
 * produce the empty answer it already has. The consequence worth stating is that `*` does not
 * reach a plugin capability: a wildcard row mentions every ENGINE cap and nothing else, so a
 * root credential holds a plugin's own capability only where a row names it.
 */
function effectiveCapsFrom(
  rows: readonly Grant[],
  path: readonly string[],
  principal: Principal,
  evidence?: Map<AskableCap, Grant>,
): Set<AskableCap> {
  const target = path[path.length - 1];
  const applicable: RankedGrant[] = [];
  for (const row of rows) {
    if (!namesPrincipal(row.principal, principal)) continue;
    const depth = path.indexOf(row.node);
    if (depth === -1) continue;
    if (row.reach === "node" && row.node !== target) continue;
    applicable.push({ row, depth });
  }
  const granted = new Set<AskableCap>();
  if (applicable.length === 0) return granted;
  const contested = new Set<AskableCap>(CONCRETE_CAPS);
  for (const { row } of applicable) {
    for (const cap of row.caps) if (!isEngineCap(cap)) contested.add(cap);
  }
  for (const cap of contested) {
    let best: RankedGrant | null = null;
    for (const candidate of applicable) {
      const mentions =
        candidate.row.caps.includes(cap) || (isEngineCap(cap) && candidate.row.caps.includes("*"));
      if (!mentions) continue;
      if (best === null || outranks(candidate, best)) best = candidate;
    }
    if (best !== null) evidence?.set(cap, best.row);
    if (best?.row.effect === "allow") granted.add(cap);
  }
  return granted;
}

/**
 * One credential's memoized verdicts, valid while the grant table has not moved under it.
 * `root` is {@link AuthService.holdsRoot}'s deny scan, filled on first ask.
 */
interface ContextAuthority {
  readonly epoch: number;
  readonly byNode: Map<string, ReadonlySet<AskableCap>>;
  readonly active: boolean;
  readonly expiresAt: number | null;
  readonly recipientCaps: readonly Cap[] | null;
  root?: boolean;
}

const NO_CAPABILITIES: ReadonlySet<AskableCap> = new Set();

/** Owns owner bootstrap, bearer hashing, attenuation, enrollment, and revocation fanout. */
export class AuthService {
  readonly ownerPrincipal: Principal;
  private readonly revokedListeners = new Set<
    (principalId: string, containerId: string | null) => void
  >();
  private readonly shareRevokedListeners = new Set<(shareId: string) => void>();
  /**
   * Every live credential's memoized authority, keyed WEAKLY by the context object so a closed
   * socket's verdicts leave with it and no registry has to be told.
   */
  private readonly authority = new WeakMap<AuthContext, ContextAuthority>();
  /** Bumped by every grant write; a cached verdict from an older epoch is discarded unread. */
  private grantsEpoch = 0;
  /** Durable lifecycle pause state mirrored in memory for the authority hot path. */
  private readonly pausedPrincipals = new Map<string, number>();
  private readonly authorityChangedListeners = new Set<() => void>();
  private agentPolicy: AgentPolicySet;
  private liveRunConnections: (runId: string) => readonly string[] = () => [];
  private agentChangeListener: (agentId: string, runId?: string) => void = () => {};
  private accessPauseChangeListener: (
    kind: "principal_access_paused" | "principal_access_resumed",
    principalId: string,
    at: number,
    actorId: string,
  ) => void = () => {};
  private agentProfileValidator: (harness: string, profile: unknown) => void | Promise<void> = (
    harness,
    profile,
  ) => {
    if (
      harness !== "external" ||
      profile === null ||
      typeof profile !== "object" ||
      Array.isArray(profile)
    )
      throw new ServiceError("forbidden", "harness_unavailable");
  };
  private readonly pendingRunLaunches = new Map<
    string,
    { token: string; target?: HarnessTarget }
  >();

  setAgentProfileValidator(
    validator: (harness: string, profile: unknown) => void | Promise<void>,
  ): void {
    this.agentProfileValidator = validator;
  }

  setAgentChangeListener(listener: (agentId: string, runId?: string) => void): void {
    this.agentChangeListener = listener;
  }
  setAccessPauseChangeListener(
    listener: (
      kind: "principal_access_paused" | "principal_access_resumed",
      principalId: string,
      at: number,
      actorId: string,
    ) => void,
  ): void {
    this.accessPauseChangeListener = listener;
  }

  private agentChanged(agentId: string, runId?: string): void {
    this.store.afterCommit(() => this.agentChangeListener(agentId, runId));
  }

  canReadAgentNode(
    actor: AuthContext,
    ref: Extract<ManifoldRef, { kind: "agent" | "run" }>,
  ): boolean {
    const current = this.restoreCredential(this.credentialReference(actor));
    if (current === null) return false;
    if (ref.kind === "agent") {
      const agent = this.store.getAgent(ref.agentId);
      return agent !== null && this.mayViewAgent(current, agent);
    }
    const run = this.store.getAgentRun(ref.runId);
    return run !== null && this.mayInspectAgentRun(current, run);
  }

  /** Runtime-only observation, bound once by the session gateway; never a connection ledger. */
  setRunConnectionReader(reader: (runId: string) => readonly string[]): void {
    this.liveRunConnections = reader;
  }

  /** Notify only after grant mutations commit and cached verdicts are invalidated. */
  private authorityChanged(): void {
    this.grantsEpoch += 1;
    for (const listener of [...this.authorityChangedListeners]) listener();
  }

  onAuthorityChanged(listener: () => void): () => void {
    this.authorityChangedListeners.add(listener);
    return () => {
      this.authorityChangedListeners.delete(listener);
    };
  }
  /**
   * When the owner path last left a row in the journal, or null before it ever has.
   *
   * IN MEMORY, deliberately, and the consequence is stated rather than hidden: a restart
   * writes one extra row on the next owner-key request. That is the right trade — the
   * alternative is a durable read on the hottest path in the server to save one row per
   * process lifetime — and the row it produces is true, which is the only thing the audit
   * promises. What it must never do is write one row per REQUEST, and that is a property of
   * the window rather than of where the window is kept.
   */
  private ownerAuditedAt: number | null = null;

  constructor(
    private readonly store: ServerStore,
    private readonly ownerKey: string,
    private readonly runtime: RuntimeDeps,
    private readonly governedAdmission?: GovernedAdmission,
    private readonly agentPolicyFile?: string,
  ) {
    this.agentPolicy = loadAgentPolicy(agentPolicyFile);
    const existingId = store.getMeta(OWNER_PRINCIPAL_META);
    const existing = existingId === null ? null : store.getPrincipal(existingId);
    if (existing !== null) {
      this.ownerPrincipal = existing;
    } else {
      const id = runtime.newId();
      this.ownerPrincipal = {
        id,
        kind: "human",
        name: "owner",
        color: stableColor(id),
      };
      store.createPrincipal(this.ownerPrincipal, runtime.now());
      store.setMeta(OWNER_PRINCIPAL_META, id);
    }
    for (const pause of store.listPrincipalAccessPauses()) {
      // Break-glass owner authority is evaluator law; stale or corrupt storage cannot suspend it.
      if (pause.principalId !== this.ownerPrincipal.id) {
        this.pausedPrincipals.set(pause.principalId, pause.pausedAt);
      }
    }
    this.expireAgentRuns();
    this.installAgentPolicy(this.agentPolicy, null);
  }

  /**
   * Authenticates an owner key or hashed bearer token and refuses durable revocations,
   * expiries, and — since ADR 0019 — leaves a row behind when the owner path is taken.
   *
   * THE OWNER KEY DOES NOT EXPIRE, and that is a ruling rather than an omission
   * (ADR 0019 §Alternatives rejected): it is the break-glass path, and a break-glass
   * credential that can lock you out is not one. Its refusals are therefore the two it has
   * always had — the secret matches, or it does not.
   */
  authenticate(raw: string): AuthContext {
    if (secretsEqual(raw, this.ownerKey)) {
      this.auditOwnerPath();
      return {
        principal: this.ownerPrincipal,
        caps: ["*"],
        containerScope: null,
        tokenId: null,
        grantId: null,
      };
    }

    const token = this.store.getTokenByHash(sha256Hex(raw));
    if (token === null) throw new ServiceError("unauthorized", "invalid bearer token");
    if (token.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    /*
      THE EXPIRY RUNG, beside the revocation refusal and after it on purpose: a credential
      that was both revoked and expired was revoked, which is the answer a holder can act on
      (stop asking) rather than the one that invites a retry.

      `forbidden` rather than `unauthorized`, matching `revoked`: the secret PRESENTED is
      genuine and the server recognized it, which is what separates both of these from an
      unknown token. The message is a member of `AUTH_REFUSALS` verbatim, because the
      boundaries relay it as the refusal CLASS a lens switches on (`session-ws`, `http`).
     */
    if (token.expiresAt !== null && token.expiresAt <= this.runtime.now()) {
      const run = this.store.getAgentRunByToken(token.id);
      if (run !== null && !TERMINAL_AGENT_RUN_STATES.has(run.state)) {
        this.settleAgentRunSubtree(run, "expired", null);
      }
      throw new ServiceError("forbidden", "expired");
    }
    const principal = this.store.getPrincipal(token.principalId);
    if (principal === null) throw new ServiceError("unauthorized", "invalid bearer token");
    const agentRun = principal.kind === "agent" ? this.store.getAgentRunByToken(token.id) : null;
    const runner = principal.kind === "agent" ? this.store.getAgentByRunnerToken(token.id) : null;
    return {
      principal,
      caps: token.caps,
      containerScope: token.containerId,
      tokenId: token.id,
      grantId: token.grantId,
      ...(token.authorityScope === undefined ? {} : { authorityScope: token.authorityScope }),
      ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt }),
      ...(agentRun === null ? {} : { agentRunId: agentRun.id }),
      ...(runner === null ? {} : { agentRunnerId: runner.agentId }),
    };
  }

  /**
   * ADR 0019 §4's bootstrap audit: the owner path leaves a durable row, at most one per
   * {@link OWNER_AUDIT_WINDOW_MS}.
   *
   * AN EVENT ROW, NOT A TRACE ROW, and the ADR rejects the alternative explicitly. A trace
   * row's `door` is "the full action name — the door, as the roster publishes it"
   * (`TraceAttribution`), and an authentication has no door: synthesizing one would put a
   * name in that column the roster does not publish, which is the lie `verify:trace` T3
   * exists to catch. Widening ADR 0018's one-writer rule instead — `appendTrace` and
   * `settleTrace` are called from the store that defines them and the dispatch ladder that
   * uses them and nowhere else, mechanized by T1 — was rejected for the same reason: a
   * checkable invariant is worth more than a column that does not fit. So the audit rides
   * the journal and its one reader (`core.events.list`), never its writer.
   *
   * THE ROW CARRIES NO SECRET AND NO FRAGMENT OF ONE. What is auditable is that the owner
   * path was taken and when; the key itself is not a fact about the workspace, it is the
   * thing the workspace must never write down (docs/CONTRACTS.md §Data and credential boundaries). `window` is on the row so a
   * reader knows what the row means: at least one owner-key authentication in the window
   * beginning at `ts`, not exactly one.
   */
  private auditOwnerPath(): void {
    const now = this.runtime.now();
    const last = this.ownerAuditedAt;
    if (last !== null && now - last < OWNER_AUDIT_WINDOW_MS) return;
    this.ownerAuditedAt = now;
    this.store.addEvent(null, now, this.ownerPrincipal.id, "owner_authenticated", {
      window: OWNER_AUDIT_WINDOW_MS,
    });
  }

  /** Authenticates a machine secret without interpreting it as a principal bearer. */
  authenticateMachine(raw: string): MachineAuthRecord {
    const machine = this.store.authenticateMachine(sha256Hex(raw));
    if (machine === null) throw new ServiceError("unauthorized", "invalid machine token");
    if (machine.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    return machine;
  }

  /** Records a refusal without exposing machine-token hashing outside the authority boundary. */
  recordMachineRefusal(raw: string, code: MachineRefusal["code"]): boolean {
    return this.store.recordMachineRefusal(sha256Hex(raw), code, this.runtime.now());
  }

  /**
   * THE AUTHORITY SEAM, and now the waterfall behind it (ADR 0011).
   *
   * Every authority question in the server arrives here and nowhere else, which is the point:
   * authority must not be re-derived per feature. What changed beneath this signature is where
   * the answer comes from — a flat cap array plus an optional container scope became a walk over
   * grant rows on the node tree — and not one caller had to learn about it.
   *
   * The NODE is the only thing this function decides. Naming a container asks at that container.
   * Naming nothing asks at the credential's own ANCHOR: the root for an unscoped credential, its
   * own container for a scoped one. That is not a convenience — it is what the question means. A
   * container-scoped agent asking "may I mint" is asking about the only place it can act, and
   * answering at the root instead would refuse a delegated mint that a scoped agent has always
   * been able to perform (`packages/testkit/e2e/auth.test.ts`).
   *
   * The plugin engine's declared-capability intersection (ADR 0010) is unchanged and sits on top
   * of the evaluated set, not beside it.
   */
  allows(context: AuthContext, cap: AskableCap, containerId?: string): boolean {
    const scope = containerId ?? context.containerScope;
    const node =
      scope === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId: scope });
    return this.allowsNode(context, cap, node);
  }

  /**
   * ROOT-CLASS AUTHORITY, asked live: the question every declared-`*` door and every root-only
   * service verb asks (#411, decided 2026-09-22).
   *
   * The raw owner key is the one unconditional answer. It is the break-glass credential
   * (ADR 0019 §1), it authenticates outside the token system, and no row reaches it. Any other
   * credential holds root only through a MINTED `*` token whose engine-wide reach is unattenuated
   * at the moment it asks: the token is live and was minted with `*`, no administered deny that
   * reaches its principal or class decides an engine capability for it anywhere in the
   * workspace, and the evaluated set at the root still holds every engine capability (so an
   * expired or paused credential is refused here too). The TOKEN is read rather than the
   * context's `caps`, exactly as authentication always classified it: the engine's native bridge
   * narrows a context's `caps` to a plugin's ceiling without changing what the credential is.
   *
   * The deny clause is the ruling, and its consequence is chosen rather than incidental: one
   * container's deny withdraws WORKSPACE administration from the bearer, for an already-open
   * socket as much as for a fresh authentication, until the row is removed. Otherwise a
   * root-only door — grant administration included — would step around, or simply retire, the
   * deny that narrowed its caller. A minted bearer on the OWNER principal is held to the same
   * rule; only the raw key is exempt. Ordinary capabilities are untouched: this withdraws the
   * class, and every concrete question is still the waterfall's alone.
   *
   * The token and deny scan is memoized per context under the grant epoch, which every grant
   * write, revocation and pause bumps; expiry is time, so it is asked on every call.
   */
  holdsRoot(context: AuthContext): boolean {
    // Work whose lineage carries container authority was bounded to containers; root is the
    // workspace, so neither the owner key nor a `*` token lends root through it (ADR 0051).
    if (context.containerGrants !== undefined) return false;
    if (context.authorityScope !== undefined) return false;
    if (context.tokenId === null) return this.isOwnerKey(context);
    const cached = this.authorityFor(context);
    if (!cached.active) return false;
    cached.root ??= this.wildcardUnattenuated(context);
    if (!cached.root) return false;
    const anchor = this.effectiveCaps(context, MANIFOLD_ROOT_URI);
    return CONCRETE_CAPS.every((cap) => anchor.has(cap));
  }

  /**
   * Whether no administered deny decides an engine capability for this `*` credential anywhere.
   *
   * A deny can only decide inside its own reach, so each is asked where it stands: at its node,
   * and for a `subtree` row beneath it as well — where a `node`-reach row that outranks it at the
   * node itself no longer applies — but only where the containment algebra admits a beneath. An
   * element or tile has nothing under it, so a leaf's deny is asked at the leaf alone. A row that
   * loses every contest it can enter — a class deny under the principal's own allow at the same
   * node, say — decides nothing and withdraws nothing, and a row naming only a plugin's
   * capability sits outside anything `*` ever reached.
   */
  private wildcardUnattenuated(context: AuthContext): boolean {
    const token = context.tokenId === null ? null : this.store.getToken(context.tokenId);
    if (token === null || token.revokedAt !== null || !token.caps.includes("*")) return false;
    for (const deny of this.store.denyGrantsFor(context.principal)) {
      const denied = deny.caps.includes("*")
        ? CONCRETE_CAPS
        : deny.caps.filter((cap): cap is Exclude<Cap, "*"> => cap !== "*" && isEngineCap(cap));
      const path = containmentPath(deny.node);
      if (denied.length === 0 || path === null) continue;
      const rows = this.applicableRows(context, path);
      const decides = (at: readonly string[]): boolean => {
        const held = effectiveCapsFrom(rows, at, context.principal);
        return denied.some((cap) => !held.has(cap));
      };
      if (
        decides(path) ||
        (deny.reach === "subtree" &&
          canContain(deny.node) === true &&
          decides([...path, BENEATH_ANY_NODE]))
      )
        return false;
    }
    return true;
  }

  /** The raw recovery key: no token, no row, on the owner principal. */
  private isOwnerKey(context: AuthContext): boolean {
    return (
      context.tokenId === null &&
      context.grantId === null &&
      context.principal.id === this.ownerPrincipal.id
    );
  }

  /**
   * The root answer a DELEGATION reads (#411). A minted `*` credential whose root class a deny
   * has withdrawn delegates nothing at all — not even a concrete capability it also carries
   * literally (`["*", "containers:write"]`), because the fresh principal it would mint for is not
   * named by the deny that narrowed the minter, so the authority would come back out from under
   * the deny. Ordinary non-wildcard delegation keeps its literal-subset rule unchanged.
   */
  private delegatingRoot(minter: AuthContext): boolean {
    const root = this.holdsRoot(minter);
    const token = root || minter.tokenId === null ? null : this.store.getToken(minter.tokenId);
    if (token?.caps.includes("*") === true)
      throw new ServiceError("forbidden", "wildcard authority withdrawn by an administered deny");
    return root;
  }

  agentRunPolicyState(
    context: AuthContext,
  ): "active" | "pending_policy" | "policy_stale" | "expired" | null {
    if (context.agentRunId === undefined) return null;
    const run = this.store.getAgentRun(context.agentRunId);
    if (run === null || TERMINAL_AGENT_RUN_STATES.has(run.state)) return null;
    if (run.expiresAt <= this.runtime.now()) {
      this.settleAgentRunSubtree(run, "expired", null);
      return "expired";
    }
    if (
      run.policyRevision !== this.agentPolicy.revision ||
      run.acknowledgedPolicyRevision !== run.policyRevision
    ) {
      return run.state === "pending_policy" ? "pending_policy" : "policy_stale";
    }
    if (run.state === "active") return "active";
    return run.state === "pending_policy" ? "pending_policy" : "policy_stale";
  }

  /**
   * ADR 0011's `effectiveCaps`: what this credential may do AT this node. Public because it is
   * the evaluator itself — `allows` is one question asked of it, and grant administration needs
   * to ask the same question about a node no capability check is currently reaching.
   *
   * An unaddressable node is an EMPTY set rather than a throw. A caller holding a URI this
   * workspace cannot address has named nothing, and "you may do nothing at nowhere" is the only
   * safe answer; refusing loudly would turn a malformed address into a 500 at a door whose job
   * is to answer yes or no.
   *
   * CARRIED CONTAINER AUTHORITY IS CONFINED HERE (ADR 0051), after the waterfall and never in
   * its cache. For a context carrying `containerGrants` — an empty list included — a container
   * capability is answered only at and beneath a container a grant names it for, and removed
   * everywhere else, the root included; neither its flat `caps` nor an absent grant restores
   * the unconfined answer. The waterfall still decides at the container, so a revocation,
   * expiry, pause or deny there ends the carried authority exactly as it ends the presser's
   * own. A credential carrying no list is untouched.
   */
  effectiveCaps(context: AuthContext, node: string): ReadonlySet<AskableCap> {
    const answer = this.evaluatedCaps(context, node);
    const grants = context.containerGrants;
    if (grants === undefined) return answer;
    let confined: Set<AskableCap> | null = null;
    for (const cap of CONTAINER_GRANT_CAPS) {
      if (
        !answer.has(cap) ||
        grants.some((grant) => grant.caps.includes(cap) && withinContainer(node, grant.containerId))
      )
        continue;
      confined ??= new Set(answer);
      confined.delete(cap);
    }
    return confined ?? answer;
  }

  private evaluatedCaps(context: AuthContext, node: string): ReadonlySet<AskableCap> {
    if (
      context.principal.id !== this.ownerPrincipal.id &&
      this.pausedPrincipals.has(context.principal.id)
    )
      return new Set();
    if (context.agentRunnerId !== undefined) {
      const agent = this.store.getAgent(context.agentRunnerId);
      const token = context.tokenId === null ? null : this.store.getToken(context.tokenId);
      return agent !== null &&
        token?.revokedAt === null &&
        token.expiresAt !== null &&
        token.expiresAt > this.runtime.now() &&
        agent.grant.expiresAt > this.runtime.now() &&
        node === formatManifoldUri({ kind: "agent", agentId: agent.agentId })
        ? new Set<AskableCap>(["agents:run"])
        : new Set<AskableCap>();
    }
    if (context.expiresAt !== undefined && context.expiresAt <= this.runtime.now())
      return new Set();
    if (!contextContainsNode(context, node)) return NO_CAPABILITIES;
    const cached = this.authorityFor(context);
    if (!cached.active || (cached.expiresAt !== null && cached.expiresAt <= this.runtime.now()))
      return NO_CAPABILITIES;
    const run =
      context.agentRunId === undefined ? null : this.store.getAgentRun(context.agentRunId);
    if (
      context.agentRunId !== undefined &&
      (run === null ||
        this.agentRunPolicyState(context) !== "active" ||
        (run.authorityScope === undefined && !runContainsNode(run, node)))
    )
      return new Set();
    const sponsorCaps = run === null ? null : this.agentRunSponsorCaps(run, node);
    const hit = cached.byNode.get(node);
    if (hit !== undefined) {
      if (sponsorCaps === null) return hit;
      let narrowed: Set<AskableCap> | null = null;
      for (const cap of hit) {
        if (sponsorCaps.has(cap)) continue;
        narrowed ??= new Set(hit);
        narrowed.delete(cap);
      }
      return narrowed ?? hit;
    }
    const path = containmentPath(node);
    const evaluated =
      path === null
        ? new Set<AskableCap>()
        : effectiveCapsFrom(this.applicableRows(context, path), path, context.principal);
    const scoped =
      context.authorityScope === undefined
        ? evaluated
        : new Set(
            [...evaluated].filter(
              (cap) =>
                scopeAdmits(context.authorityScope!, node, cap) &&
                (!isEngineCap(cap) ||
                  hasCap(context.caps, cap) ||
                  (isContainerGrantCap(cap) &&
                    context.containerGrants?.some(
                      (grant) =>
                        grant.caps.includes(cap) && withinContainer(node, grant.containerId),
                    ))),
            ),
          );
    let answer: Set<AskableCap> =
      run === null
        ? scoped
        : new Set([...scoped].filter((cap) => scopeAdmits(runScope(run), node, cap)));
    if (sponsorCaps !== null) {
      answer = new Set([...answer].filter((cap) => sponsorCaps.has(cap)));
    }
    if (cached.recipientCaps !== null) {
      const ceiling = cached.recipientCaps;
      for (const cap of answer) if (!isEngineCap(cap) || !ceiling.includes(cap)) answer.delete(cap);
    }
    cached.byNode.set(node, answer);
    return answer;
  }
  /**
   * A run's stored cap list is only the coarse ceiling. The authorizer's exact credential
   * waterfall remains the live ceiling at every exercised node, so a node grant or a deeper
   * deny cannot be laundered through a fresh child principal.
   */
  private agentRunSponsorCaps(run: AgentRunRecord, node: string): ReadonlySet<AskableCap> {
    const agent = this.store.getAgent(run.agentId);
    if (
      agent === null ||
      agent.status === "disabled" ||
      agent.grant.expiresAt <= this.runtime.now() ||
      !standingScope(agent.grant).some(({ target, reach }) =>
        runContainsNode({ target, reach }, node),
      )
    )
      return new Set();
    const standingSponsor = this.restoreAgentSponsor(agent);
    if (standingSponsor === null || !contextContainsNode(standingSponsor, node)) return new Set();
    const standingCaps = this.effectiveCaps(standingSponsor, node);
    let sponsor: AuthContext | null = standingSponsor;
    if (run.parentRunId !== null) sponsor = this.restoreRunCredential(run.parentRunId);
    if (sponsor === null || !contextContainsNode(sponsor, node)) return new Set();
    const sponsorCaps =
      sponsor === standingSponsor ? standingCaps : this.effectiveCaps(sponsor, node);
    return new Set(
      agent.grant.caps.filter(
        (cap) =>
          scopeAdmits(standingScope(agent.grant), node, cap) &&
          standingCaps.has(cap) &&
          sponsorCaps.has(cap),
      ),
    );
  }

  private restoreAgentSponsor(agent: AgentRecord): AuthContext | null {
    const tokenId = agent.authorizationCredential.tokenId;
    const sponsorRun = tokenId === null ? null : this.store.getAgentRunByToken(tokenId);
    // Legacy child Agents retain admission attribution, not a lease on the parent's old token.
    // Follow that exact Run through renewal without substituting another Run of its principal.
    if (sponsorRun !== null) {
      return sponsorRun.principalId === agent.sponsorPrincipalId
        ? this.restoreRunCredential(sponsorRun.id)
        : null;
    }
    return this.restoreCredential({
      principalId: agent.sponsorPrincipalId,
      ...agent.authorizationCredential,
    });
  }

  /**
   * Structured node check through the same waterfall, with the immutable container ceiling.
   *
   * THE CALL SITE A MACHINE-SCOPED GRANT REACHES (ADR 0035). `allows` asks at a container or at
   * the credential's anchor, so a row at `manifold://machine/<id>` can only ever be seen by a
   * question that NAMES the node — and this is that question, the one the action door asks for
   * every declared requirement. A plugin whose authority is per machine declares
   * `{ cap: "<its>:<name>", target: [...] }` and the ref in its arguments decides which
   * machine's rows answer.
   */
  allowsRef(context: AuthContext, cap: AskableCap, ref: ManifoldRef): boolean {
    return (
      ManifoldRefSchema.safeParse(ref).success &&
      this.allowsNode(context, cap, formatManifoldUri(ref))
    );
  }

  /** Exact live authority; a node-only permission never proves a whole subtree. */
  allowsNode(
    context: AuthContext,
    cap: AskableCap,
    node: GrantNode,
    reach: GrantReach = "node",
  ): boolean {
    const path = containmentPath(node);
    if (
      path === null ||
      !contextContainsNode(context, node) ||
      !this.effectiveCaps(context, node).has(cap)
    )
      return false;
    if (reach === "node") return true;
    if (!canContain(node)) return false;
    if (
      context.authorityScope !== undefined &&
      !scopeAdmits(context.authorityScope, node, cap, "subtree")
    )
      return false;
    if (
      !effectiveCapsFrom(
        this.applicableRows(context, path),
        [...path, BENEATH_ANY_NODE],
        context.principal,
      ).has(cap)
    )
      return false;
    if (
      context.containerGrants !== undefined &&
      isContainerGrantCap(cap) &&
      !context.containerGrants.some(
        (grant) => grant.caps.includes(cap) && withinContainer(node, grant.containerId),
      )
    )
      return false;
    if (context.agentRunId !== undefined) {
      const run = this.store.getAgentRun(context.agentRunId);
      const agent = run === null ? null : this.store.getAgent(run.agentId);
      const standing = agent === null ? null : this.restoreAgentSponsor(agent);
      const parent =
        run?.parentRunId == null ? standing : this.restoreRunCredential(run.parentRunId);
      if (
        run === null ||
        agent === null ||
        standing === null ||
        parent === null ||
        !scopeAdmits(runScope(run), node, cap, "subtree") ||
        !scopeAdmits(standingScope(agent.grant), node, cap, "subtree") ||
        !this.allowsNode(standing, cap, node, "subtree") ||
        (parent !== standing && !this.allowsNode(parent, cap, node, "subtree"))
      )
        return false;
    }
    return true;
  }
  /** A new human credential cannot delegate a subtree its issuer already denies. */
  private issuanceAdmits(
    context: AuthContext,
    cap: AskableCap,
    node: GrantNode,
    reach: GrantReach,
  ): boolean {
    if (!this.allowsNode(context, cap, node, reach)) return false;
    if (reach === "node") return true;
    for (const deny of this.store.denyGrantsFor(context.principal)) {
      if (!containmentPath(deny.node)?.includes(node)) continue;
      const at = containmentPath(deny.node)!;
      const rows = this.applicableRows(context, at);
      if (!effectiveCapsFrom(rows, at, context.principal).has(cap)) return false;
      if (
        deny.reach === "subtree" &&
        canContain(deny.node) &&
        !effectiveCapsFrom(rows, [...at, BENEATH_ANY_NODE], context.principal).has(cap)
      )
        return false;
    }
    return true;
  }

  /**
   * Whether the credential's CEILING admits `cap` at `ref` (ADR 0051): its flat caps, or — for
   * a context carrying container grants, where the grants are the only ceiling a container
   * capability has — a grant naming it for the container `ref` lies in. The ceiling half only:
   * what the grant rows say at that node is the evaluator's question, asked separately.
   */
  ceilingAdmits(context: AuthContext, cap: AskableCap, ref: ManifoldRef): boolean {
    const node = formatManifoldUri(ref);
    if (context.authorityScope !== undefined && !scopeAdmits(context.authorityScope, node, cap))
      return false;
    const grants = context.containerGrants;
    if (grants === undefined || !isContainerGrantCap(cap)) return hasCap(context.caps, cap);
    return grants.some(
      (grant) => grant.caps.includes(cap) && withinContainer(node, grant.containerId),
    );
  }

  /**
   * What a handler reads as `ctx.auth.caps`: the flat ceiling, and for a context carrying
   * container grants, the container capabilities those grants name in place of any flat ones
   * (ADR 0051). The list says a cap is HELD; only `allows` with a node says where, and for a
   * carried cap the answer is its container alone.
   */
  ceilingCaps(context: AuthContext): readonly Cap[] {
    const ceiling =
      context.authorityScope === undefined
        ? context.caps
        : [
            ...new Set(
              context.authorityScope
                .flatMap((entry) => entry.caps)
                .filter(
                  (cap): cap is Exclude<Cap, "*"> => isEngineCap(cap) && hasCap(context.caps, cap),
                ),
            ),
          ];
    const grants = context.containerGrants;
    if (grants === undefined) return ceiling;
    const caps: Cap[] = ceiling.filter((cap) => !isContainerGrantCap(cap));
    for (const cap of CONTAINER_GRANT_CAPS)
      if (grants.some((grant) => grant.caps.includes(cap))) caps.push(cap);
    return caps;
  }

  /**
   * The containers where a CONTAINER-GRADED door's flat caps are held through carried container
   * authority (ADR 0051), for the ladder to confine the dispatch to. Null when no cap rests on a
   * carried grant — every credential that carries nothing, and every cap held at the
   * credential's own anchor — which is the answer the door always had. Empty when the carried
   * caps name no container in common, so no single container holds the door's authority.
   */
  carriedScope(context: AuthContext, caps: readonly AuthoredCap[]): readonly string[] | null {
    const grants = context.containerGrants;
    if (grants === undefined) return null;
    let scope: string[] | null = null;
    for (const cap of caps) {
      if (!isContainerGrantCap(cap) || this.allows(context, cap)) continue;
      const held = grants
        .filter((grant) => grant.caps.includes(cap) && this.allows(context, cap, grant.containerId))
        .map((grant) => grant.containerId);
      scope = scope === null ? held : scope.filter((containerId) => held.includes(containerId));
    }
    return scope;
  }

  credentialReference(context: AuthContext): CredentialReference {
    return {
      principalId: context.principal.id,
      tokenId: context.tokenId,
      grantId: context.grantId,
      caps: [...context.caps],
      containerScope: context.containerScope,
      ...(context.authorityScope === undefined
        ? {}
        : { authorityScope: canonicalizeAuthorityScope(context.authorityScope) }),
      ...(context.expiresAt === undefined ? {} : { expiresAt: context.expiresAt }),
      ...(context.containerGrants === undefined
        ? {}
        : { containerGrants: context.containerGrants }),
    };
  }

  /**
   * Reconstruct delayed authority from its original credential, never its principal alone.
   *
   * A reference carrying `containerGrants` (ADR 0051) restores exactly as confined, held to the
   * reference's own rule: never wider than the token it rides. A malformed list, a grant naming
   * a cap the reference already carries flat, or one the token does not carry restores nothing
   * at all rather than a narrowed guess. Where a grant is exercised is the evaluator's question,
   * asked live at the container (`effectiveCaps`). A reference without the field restores
   * exactly what it always did.
   */
  restoreCredential(reference: CredentialReference): AuthContext | null {
    const grants =
      reference.containerGrants === undefined
        ? undefined
        : ContainerGrantsSchema.safeParse(reference.containerGrants);
    if (grants?.success === false) return null;
    const scope =
      reference.authorityScope === undefined
        ? undefined
        : AuthorityScopeSchema.safeParse(reference.authorityScope);
    if (scope?.success === false) return null;
    const carried = grants?.data.flatMap((grant) => grant.caps) ?? [];
    if (carried.some((cap) => hasCap(reference.caps, cap))) return null;
    const principal = this.store.getPrincipal(reference.principalId);
    if (!principal) return null;
    if (reference.expiresAt !== undefined && reference.expiresAt <= this.runtime.now()) return null;
    if (reference.tokenId !== null) {
      const token = this.store.getToken(reference.tokenId);
      if (
        !token ||
        token.revokedAt !== null ||
        token.principalId !== reference.principalId ||
        token.grantId !== reference.grantId ||
        token.containerId !== reference.containerScope ||
        (token.expiresAt !== null && token.expiresAt <= this.runtime.now()) ||
        reference.caps.some((c) => !token.caps.includes(c) && !token.caps.includes("*")) ||
        carried.some((c) => !token.caps.includes(c) && !token.caps.includes("*")) ||
        (token.authorityScope === undefined
          ? reference.authorityScope !== undefined
          : reference.authorityScope === undefined ||
            !scopeWithin(reference.authorityScope, token.authorityScope))
      )
        return null;
    } else if (reference.principalId !== this.ownerPrincipal.id) return null;
    return {
      principal,
      caps: [...reference.caps],
      containerScope: reference.containerScope,
      tokenId: reference.tokenId,
      grantId: reference.grantId,
      ...(scope === undefined ? {} : { authorityScope: canonicalizeAuthorityScope(scope.data) }),
      ...(reference.expiresAt === undefined ? {} : { expiresAt: reference.expiresAt }),
      ...(grants === undefined ? {} : { containerGrants: grants.data }),
      ...(reference.tokenId === null || principal.kind !== "agent"
        ? {}
        : (() => {
            const run = this.store.getAgentRunByToken(reference.tokenId);
            const runner = this.store.getAgentByRunnerToken(reference.tokenId);
            return {
              ...(run === null ? {} : { agentRunId: run.id }),
              ...(runner === null ? {} : { agentRunnerId: runner.agentId }),
            };
          })()),
    };
  }

  /**
   * Trusted native registration only. Public token mints synthesize a subtree grant and
   * cannot express several exact runtime nodes. Bind the runtime operation grant to the
   * token and administer the remaining exact nodes through the ordinary waterfall.
   */
  mintNativeServiceCredential(
    serviceId: string,
    machineId: string,
    actor: AuthContext,
    requirements: readonly AuthorityRequirement[],
  ): CredentialReference {
    return this.store.transaction(() => {
      const current = this.restoreCredential(this.credentialReference(actor));
      if (
        current === null ||
        !this.holdsRoot(current) ||
        (!current.caps.includes("*") && !current.caps.includes("services:configure")) ||
        !this.allowsRef(current, "services:configure", { kind: "machine", machineId }) ||
        requirements.length === 0 ||
        !requirements.some(({ ref }) => ref.kind === "operation") ||
        requirements.some(
          ({ cap, ref }) =>
            !CONCRETE_CAPS.includes(cap) ||
            !ManifoldRefSchema.safeParse(ref).success ||
            !["operation", "location", "service"].includes(ref.kind) ||
            !("machineId" in ref) ||
            ref.machineId !== machineId ||
            !this.allowsRef(current, cap, ref),
        )
      )
        throw new ServiceError("forbidden", "native_service_authority_required");
      return this.persistNativeServiceCredential(
        serviceId,
        machineId,
        current.principal.id,
        requirements,
      );
    });
  }

  /** Registry-owned renewal keeps the persisted service authority independent of its sponsor. */
  remintNativeServiceCredential(
    serviceId: string,
    machineId: string,
    actorId: string,
    requirements: readonly AuthorityRequirement[],
  ): CredentialReference {
    return this.store.transaction(() =>
      this.persistNativeServiceCredential(serviceId, machineId, actorId, requirements),
    );
  }

  private persistNativeServiceCredential(
    serviceId: string,
    machineId: string,
    actorId: string,
    requirements: readonly AuthorityRequirement[],
  ): CredentialReference {
    const principal = this.createPrincipal({ kind: "service", name: serviceId.slice(0, 64) });
    const grants = new Map<string, Grant>();
    const createdAt = this.runtime.now();
    for (const { cap, ref } of requirements) {
      const node = formatManifoldUri(ref);
      const existing = grants.get(node);
      if (existing) {
        if (!existing.caps.includes(cap)) existing.caps.push(cap);
      } else {
        grants.set(node, {
          id: this.runtime.newId(),
          principal: { kind: "principal", id: principal.id },
          node,
          caps: [cap],
          effect: "allow",
          reach: "node",
          createdBy: actorId,
          createdAt,
        });
      }
    }
    for (const grant of grants.values()) this.store.createGrant(grant);
    const operation = requirements.find(({ ref }) => ref.kind === "operation")!;
    const grantId = grants.get(formatManifoldUri(operation.ref))!.id;
    const tokenId = this.runtime.newId();
    const caps = [...new Set(requirements.map(({ cap }) => cap))];
    // Instance-service lifecycle, like a terminal's: explicit revocation, not browser expiry.
    // Hash the one-time random bearer at creation; it never leaves this method.
    this.store.createToken({
      id: tokenId,
      hash: sha256Hex(randomSecret()),
      principalId: principal.id,
      mintedBy: actorId,
      caps,
      containerId: null,
      createdAt,
      revokedAt: null,
      grantId,
      expiresAt: null,
    });
    this.store.addEvent(null, createdAt, actorId, "token_minted", {
      tokenId,
      subjectPrincipalId: principal.id,
      caps,
      containerId: null,
      serviceId,
      machineId,
    });
    this.store.afterCommit(() => this.authorityChanged());
    return { principalId: principal.id, tokenId, grantId, caps, containerScope: null };
  }

  /** Trusted registry lifecycle mutation; shares its transaction and post-commit fence. */
  revokeNativeServiceCredential(reference: CredentialReference, actorId: string): void {
    if (reference.tokenId === null || reference.grantId === null)
      throw new ServiceError("forbidden", "native_service_credential_required");
    const tokenId = reference.tokenId;
    this.store.transaction(() => {
      const token = this.store.getToken(tokenId);
      if (
        !token ||
        token.principalId !== reference.principalId ||
        (token.revokedAt === null && token.grantId !== reference.grantId) ||
        token.caps.includes("*")
      )
        throw new ServiceError("forbidden", "native_service_credential_required");
      if (token.revokedAt !== null) return;
      const at = this.runtime.now();
      const revoked = this.store.revokeToken(tokenId, at);
      this.store.addEvent(null, at, actorId, "token_revoked", {
        subjectPrincipalId: reference.principalId,
        count: revoked.tokens,
      });
      this.store.afterCommit(() => {
        this.settleRevocation(revoked);
        if (revoked.tokens > 0)
          for (const listener of [...this.revokedListeners]) listener(reference.principalId, null);
      });
    });
  }

  /** Captures row evidence without presenting cache invalidation as durable policy evidence. */
  explain(context: AuthContext, requirement: AuthorityRequirement): AuthorityEvidence {
    if (!ManifoldRefSchema.safeParse(requirement.ref).success)
      return { requirement, winner: null, allowed: false };
    const path = containmentPath(formatManifoldUri(requirement.ref));
    const winners = new Map<AskableCap, Grant>();
    if (path !== null)
      effectiveCapsFrom(this.applicableRows(context, path), path, context.principal, winners);
    return {
      requirement,
      winner: winners.get(requirement.cap) ?? null,
      allowed: this.allowsRef(context, requirement.cap, requirement.ref),
    };
  }

  admitGoverned(
    context: AuthContext,
    pluginId: string,
    action: string,
    requirements: readonly AuthorityRequirement[],
  ): GovernedAdmissionDecision {
    if (context.tokenId !== null) {
      const token = this.store.getToken(context.tokenId);
      if (
        token === null ||
        token.revokedAt !== null ||
        (token.expiresAt !== null && token.expiresAt <= this.runtime.now()) ||
        token.principalId !== context.principal.id ||
        token.grantId !== context.grantId
      )
        return { allowed: false };
    } else if (context.principal.id !== this.ownerPrincipal.id) return { allowed: false };
    if (requirements.some(({ cap, ref }) => !this.ceilingAdmits(context, cap, ref)))
      return { allowed: false };
    if (
      requirements.length === 0 ||
      !requirements.some((requirement) => GOVERNED_CAPS.includes(requirement.cap))
    )
      return { allowed: false };
    const evidence = requirements.map((requirement) => this.explain(context, requirement));
    if (evidence.some((entry) => !entry.allowed)) return { allowed: false };
    return (
      this.governedAdmission?.decide({
        credential: this.credentialReference(context),
        pluginId,
        action,
        evidence,
      }) ?? { allowed: false }
    );
  }

  /**
   * The rows that may answer for THIS credential on this path.
   *
   * Two kinds of row reach a credential, and the difference between them is the whole
   * attenuation rule. A row some TOKEN references is that credential's own synthesized
   * authority, so it applies to that credential alone — otherwise a principal's narrow token
   * would inherit its own broad token's row, which breaks parity with the flat model and hands
   * back authority a minter deliberately withheld. A row NO token references is ADMINISTERED:
   * somebody wrote it at a node about a principal or a class, and it applies to every credential
   * that principal presents. That is what makes an administered allow widen a live credential
   * and an administered deny bite one, with no re-authentication.
   *
   * THE OWNER KEY IS UNDENIABLE, and it is enforced here rather than at the write.
   *
   * `grant` refuses a deny row that NAMES the owner principal. But a refusal at the write cannot
   * be the guarantee, because a CLASS row walks around it: the owner is a human, so
   * `any-human deny` reaches the owner principal at depth without ever naming it — and refusing
   * every human class deny to prevent that would delete "any human in this room may read but not
   * write", which is one of the four sentences ADR 0011 exists to make sayable. So class denials
   * are admitted for everybody and dropped for the raw owner key alone, which puts the break-glass
   * guarantee where it cannot be walked around.
   *
   * The exemption is the KEY's, not the principal's (#411). A token minted onto the owner
   * principal is an ordinary finite bearer: administered denies bite it like any other, and
   * `holdsRoot` withdraws its root class under them. Only the credential that authenticates
   * outside the token system stays out of reach of administration, so that no administration can
   * lock out its own administrator.
   *
   * The owner key holds no token, so it references no row and the store has none for it. Its
   * root grant is SYNTHESIZED here rather than stored, and that too is a safety property: a
   * stored row is a row `revokeGrant` could delete. It is gated on the whole owner-key shape —
   * no token, no row, the owner principal — rather than on the missing token id alone, so a
   * future construction site that forgot a token id cannot inherit the workspace root.
   */
  private applicableRows(context: AuthContext, path: readonly string[]): readonly Grant[] {
    const ownerKey = this.isOwnerKey(context);
    const stored = this.store.grantsFor(context.principal, path);
    const mine = stored.filter(
      (row: GrantRecord) =>
        !row.shareBound &&
        (!row.tokenBound ||
          (context.tokenId !== null && this.store.tokenOwnsGrant(context.tokenId, row.id))) &&
        !(ownerKey && row.effect === "deny"),
    );
    if (!ownerKey) return mine;
    return [
      {
        id: `owner-${this.ownerPrincipal.id}`,
        principal: { kind: "principal", id: this.ownerPrincipal.id },
        node: MANIFOLD_ROOT_URI,
        caps: ["*"],
        effect: "allow",
        reach: "subtree",
        createdBy: this.ownerPrincipal.id,
        createdAt: 0,
      },
      ...mine,
    ];
  }

  /**
   * One credential's memoized verdicts, invalidated by the grant epoch.
   *
   * ADR 0011 rejects caching authority INTO a composition, because that makes revocation a
   * restart. This is not that. An `AuthContext` is one authentication — one request, or one
   * channel on one socket. The epoch memoizes both exact credential freshness and node
   * verdicts: revocation invalidates suspended handlers as well as fencing their sockets.
   * Expiry remains a time check on every authorization. Recipient-derived credentials also
   * retain their literal cap ceiling, so an independent administered grant cannot widen a
   * narrow share ticket; an unrelated credential on the same principal remains independent.
   * Grant writes, revocation and pause bump the epoch, preserving map-lookup hot-frame cost.
   */
  private authorityFor(context: AuthContext): ContextAuthority {
    const existing = this.authority.get(context);
    if (existing !== undefined && existing.epoch === this.grantsEpoch) return existing;
    const token = context.tokenId === null ? null : this.store.getToken(context.tokenId);
    const active =
      context.tokenId === null
        ? this.isOwnerKey(context)
        : token !== null &&
          token.revokedAt === null &&
          token.principalId === context.principal.id &&
          token.grantId === context.grantId;
    const fresh: ContextAuthority = {
      epoch: this.grantsEpoch,
      byNode: new Map(),
      active,
      expiresAt: token?.expiresAt ?? null,
      recipientCaps:
        active && token !== null && this.store.hasShareRecipientCredential(token.id)
          ? token.caps
          : null,
    };
    this.authority.set(context, fresh);
    return fresh;
  }

  /**
   * Every token revocation settles here. Retiring a token's grant row is a grant write, and
   * the epoch rule admits no exception for the writes revocation makes; the fence and the
   * door keep keying on the TOKEN count, which is the number this hands back.
   */
  private settleRevocation(revocation: TokenRevocation): number {
    if (revocation.tokens > 0 || revocation.grants > 0) this.authorityChanged();
    return revocation.tokens;
  }

  /** Creates a stable principal with deterministic default color. */
  private createPrincipal(input: {
    readonly name: string;
    readonly color?: string | undefined;
    readonly kind: Principal["kind"];
  }): Principal {
    const id = this.runtime.newId();
    const principal: Principal = {
      id,
      kind: input.kind,
      name: input.name,
      color: input.color ?? stableColor(id),
    };
    this.store.createPrincipal(principal, this.runtime.now());
    return principal;
  }

  /**
   * One minted credential, and the grant row its authority lives in — one transaction, because a
   * token whose grant row never landed is a bearer that authenticates and then may do nothing,
   * which is the most confusing failure this file could produce.
   *
   * The row is ADR 0011's reading of the credential taken literally: a `subtree` allow at
   * `manifold://` for an unscoped token, and at `manifold://container/<id>` for a scoped one. A
   * token with NO caps — an enrolled machine's, whose authority is to be a machine rather than to
   * act as a principal — references no row, because a grant granting nothing answers no question.
   */
  private persistToken(
    principalId: string,
    caps: readonly AuthoredCap[],
    containerId: string | null,
    actorId: string | null,
    expiry: TokenExpiry,
    runGrant?: { readonly node: string; readonly reach: GrantReach; readonly expiresAt: number },
    authorityScope?: AuthorityScope,
    sourceTokenId?: string | null,
  ): { raw: string; record: TokenRecord } {
    const raw = randomSecret();
    const createdAt = this.runtime.now();
    const tokenId = this.runtime.newId();
    const expiresAt =
      runGrant?.expiresAt ??
      (expiry === "never"
        ? null
        : createdAt + (expiry === "automated" ? AUTOMATED_TOKEN_TTL_MS : INTERACTIVE_TOKEN_TTL_MS));
    const tokenCaps = caps.filter(isEngineCap);
    const scope =
      authorityScope === undefined ? undefined : canonicalizeAuthorityScope(authorityScope);
    const anchor =
      runGrant?.node ??
      (containerId === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId }));
    const entries =
      scope ??
      (caps.length === 0
        ? []
        : [
            {
              target: anchor,
              reach: runGrant?.reach ?? "subtree",
              caps,
            },
          ]);
    const grants: Grant[] = entries.map((entry) => ({
      id: this.runtime.newId(),
      principal: { kind: "principal", id: principalId },
      node: entry.target,
      caps: [...entry.caps],
      effect: "allow",
      reach: entry.reach,
      createdBy: actorId ?? principalId,
      createdAt,
    }));
    const record: TokenRecord = {
      id: tokenId,
      hash: sha256Hex(raw),
      principalId,
      mintedBy: actorId,
      caps: tokenCaps,
      containerId,
      createdAt,
      revokedAt: null,
      grantId: grants.find((grant) => grant.node === anchor)?.id ?? grants[0]?.id ?? null,
      expiresAt,
      ...(scope === undefined ? {} : { authorityScope: scope }),
    };
    return this.store.transaction(() => {
      for (const grant of grants) this.store.createGrant(grant);
      this.store.createToken(record);
      for (const grant of grants) this.store.bindTokenGrant(record.id, grant.id);
      if (sourceTokenId !== undefined && sourceTokenId !== null) {
        this.store.inheritShareRecipientCredential(record.id, sourceTokenId);
      }
      this.store.addEvent(containerId, this.runtime.now(), actorId, "token_minted", {
        tokenId: record.id,
        subjectPrincipalId: principalId,
        caps: [...caps],
        containerId,
      });
      return { raw, record };
    });
  }

  /**
   * Bootstraps a principal with a root token; callers must already enforce root authority.
   *
   * THE BOOTSTRAP PATH, and therefore the second thing ADR 0019 §4 makes auditable: this is
   * how a browser holding the owner key turns it into an identity of its own, so a row here
   * answers "who was let in, and by what" for the one credential that could let anybody in.
   * `token_minted` records the credential; this records the ACT — and the two are not the
   * same row because `mintToken` also mints and is not a bootstrap.
   */
  bootstrapPrincipal(input: BootstrapPrincipalRequest, actor: AuthContext): TokenGrant {
    if (!this.holdsRoot(actor)) throw new ServiceError("forbidden", "root capability required");
    const parsed = BootstrapPrincipalRequestSchema.parse(input);
    const principal = this.createPrincipal(parsed);
    const minted = this.persistToken(
      principal.id,
      ["*"],
      null,
      actor.principal.id,
      expiryFor(principal.kind),
    );
    this.store.addEvent(null, this.runtime.now(), actor.principal.id, "principal_bootstrapped", {
      subjectPrincipalId: principal.id,
      kind: principal.kind,
      /* WHETHER the owner key itself opened this door, which is the fact the audit is for. */
      byOwnerKey: actor.tokenId === null,
    });
    return {
      token: minted.raw,
      principal,
      caps: ["*"],
      containerId: null,
      ...(minted.record.expiresAt === null ? {} : { expiresAt: minted.record.expiresAt }),
    };
  }

  /**
   * Materializes a verified production identity as a short-lived local browser credential.
   * Signature, issuer, audience and freshness checks belong to the HTTP admission boundary;
   * this method owns only the ordinary principal/grant/token mutation after that proof.
   */
  acceptPreviewIdentity(claims: PreviewIdentityClaims): TokenGrant {
    if (claims.principal.kind !== "human" || claims.containerId !== null) {
      throw new ServiceError("forbidden", "preview identity must be an unscoped human");
    }
    const principalId = `preview-${sha256Hex(`${claims.issuer}\0${claims.principal.id}`).slice(0, 48)}`;
    let principal = this.store.getPrincipal(principalId);
    if (principal === null) {
      principal = {
        id: principalId,
        kind: claims.principal.kind,
        name: claims.principal.name,
        color: claims.principal.color,
        origin: claims.issuer,
      };
      this.store.createPrincipal(principal, this.runtime.now());
    }
    /*
      The SAME lifetime a production browser credential has (ADR 0028): a preview identity is
      that credential re-homed, and a shorter lease only re-ran the production handoff under
      the operator every quarter hour while sockets were fenced mid-work. Production revocation
      still reaches a preview at once when the preview is opened or renewed; an already-open
      one is bounded by this fortnight exactly as production's own browsers are.
     */
    const minted = this.persistToken(principal.id, claims.caps, null, principal.id, "interactive");
    this.store.addEvent(null, this.runtime.now(), principal.id, "preview_identity_accepted", {
      issuer: claims.issuer,
      sourcePrincipalId: claims.principal.id,
      expiresAt: minted.record.expiresAt,
    });
    return {
      token: minted.raw,
      principal,
      caps: [...claims.caps],
      containerId: null,
      ...(minted.record.expiresAt === null ? {} : { expiresAt: minted.record.expiresAt }),
    };
  }

  /** The ordinary mint attenuation rule, shared by shares and their recipient approvals. */
  private requireMintCapabilities(
    caps: readonly Cap[],
    minter: AuthContext,
    containerScoped = false,
    node?: GrantNode,
  ): void {
    const root = this.delegatingRoot(minter);
    for (const cap of caps) {
      if (cap === "*" && containerScoped) {
        throw new ServiceError("forbidden", "wildcard authority cannot be container-scoped");
      }
      if (cap === "*" && !root) {
        throw new ServiceError("forbidden", "only root may mint wildcard authority");
      }
      if (
        node === undefined
          ? !root && !minter.caps.includes(cap)
          : cap !== "*" && !this.issuanceAdmits(minter, cap, node, "subtree")
      ) {
        throw new ServiceError("forbidden", `cannot mint capability ${cap}`);
      }
      if (node === undefined && minter.authorityScope !== undefined)
        throw new ServiceError("forbidden", "scoped_authority_requires_v2");
    }
  }

  /** Mints only authority no broader than the minter's caps and optional container scope. */
  mintToken(input: MintTokenRequest, actor: AuthContext): TokenGrant {
    const minter = this.restoreCredential(this.credentialReference(actor));
    if (minter === null) throw new ServiceError("forbidden", "credential revoked or expired");
    const parsed = MintTokenRequestSchema.parse(input);
    if (!this.allows(minter, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    this.requireMintCapabilities(parsed.caps, minter);
    if (
      minter.containerScope !== null &&
      parsed.containerId !== undefined &&
      parsed.containerId !== minter.containerScope
    ) {
      throw new ServiceError("forbidden", "cannot widen container scope");
    }
    const containerId = minter.containerScope ?? parsed.containerId ?? null;
    if (containerId !== null && parsed.caps.includes("*")) {
      throw new ServiceError("forbidden", "wildcard authority cannot be container-scoped");
    }
    if (containerId !== null && this.store.getContainer(containerId) === null) {
      throw new ServiceError("not_found", "container not found");
    }
    const target =
      containerId === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId });
    if (
      parsed.caps.some((cap) => cap !== "*" && !this.issuanceAdmits(minter, cap, target, "subtree"))
    )
      throw new ServiceError("forbidden", "credential_authority_exceeds_issuer");

    const principal = this.tokenPrincipal(parsed, minter);

    const minted = this.persistToken(
      principal.id,
      parsed.caps,
      containerId,
      minter.principal.id,
      expiryFor(principal.kind),
      undefined,
      undefined,
      minter.tokenId,
    );
    return {
      token: minted.raw,
      principal,
      caps: [...parsed.caps],
      containerId,
      ...(minted.record.expiresAt === null ? {} : { expiresAt: minted.record.expiresAt }),
    };
  }

  mintTokenV2(input: MintTokenV2Request, actor: AuthContext): TokenGrantV2 {
    const parsed = MintTokenV2RequestSchema.parse(input);
    const minter = this.requireCurrentActor(actor);
    if (!this.allows(minter, "tokens:mint"))
      throw new ServiceError("forbidden", "tokens:mint capability required");
    this.delegatingRoot(minter);
    const scope = canonicalizeAuthorityScope(parsed.scope);
    if (
      parsed.expiresAt <= this.runtime.now() ||
      (minter.expiresAt !== undefined && parsed.expiresAt > minter.expiresAt)
    )
      throw new ServiceError("forbidden", "credential_expiry_exceeds_issuer");
    for (const entry of scope) {
      if (
        !this.issuanceAdmits(minter, "tokens:mint", entry.target, entry.reach) ||
        entry.caps.some((cap) => !this.issuanceAdmits(minter, cap, entry.target, entry.reach))
      )
        throw new ServiceError("forbidden", "scoped_authority_exceeds_issuer");
    }
    const containerId = parsed.containerId ?? minter.containerScope;
    if (containerId !== null && this.store.getContainer(containerId) === null)
      throw new ServiceError("not_found", "container not found");
    if (minter.containerScope !== null && containerId !== minter.containerScope)
      throw new ServiceError("forbidden", "cannot widen container context");
    const caps = [
      ...new Set(
        scope
          .flatMap((entry) => entry.caps)
          .filter((cap): cap is Exclude<Cap, "*"> => isEngineCap(cap)),
      ),
    ];
    return this.store.transaction(() => {
      const principal = this.tokenPrincipal(parsed, minter);
      const minted = this.persistToken(
        principal.id,
        caps,
        containerId,
        minter.principal.id,
        expiryFor(principal.kind),
        {
          node:
            containerId === null
              ? MANIFOLD_ROOT_URI
              : formatManifoldUri({ kind: "container", containerId }),
          reach: "subtree",
          expiresAt: parsed.expiresAt,
        },
        scope,
        minter.tokenId,
      );
      return {
        token: minted.raw,
        principal,
        scope,
        caps,
        containerId,
        expiresAt: parsed.expiresAt,
      };
    });
  }

  /** Identity selection is shared by both issuer versions; provenance is not principal ownership. */
  private tokenPrincipal(
    parsed: Pick<MintTokenRequest, "principalId" | "principal">,
    minter: AuthContext,
  ): Principal {
    if (parsed.principalId !== undefined) {
      const existing = this.store.getPrincipal(parsed.principalId);
      if (existing === null) throw new ServiceError("not_found", "principal not found");
      if (existing.kind === "agent")
        throw new ServiceError("forbidden", "agent credentials require renewAgentRun");
      this.refuseManagedServicePrincipal(existing.id);
      if (
        !this.holdsRoot(minter) &&
        existing.id !== minter.principal.id &&
        !this.store.hasIssuedToken(
          existing.id,
          minter.principal.id,
          minter.containerScope,
          this.runtime.now(),
        )
      )
        throw new ServiceError("forbidden", "cannot mint for another principal");
      return existing;
    }
    if (parsed.principal !== undefined) return this.createPrincipal(parsed.principal);
    throw new ServiceError("conflict", "token principal is missing");
  }

  /** Walk verified sponsorship edges, never merely a shared root id or a minted-by token. */
  private inspectionAncestors(run: AgentRunRecord): {
    chain: AgentRunRecord[];
    complete: boolean;
  } {
    const chain = [run];
    const seen = new Set([run.id]);
    let cursor = run;
    while (cursor.parentRunId !== null) {
      const parent = this.store.getAgentRun(cursor.parentRunId);
      if (
        parent === null ||
        seen.has(parent.id) ||
        chain.length > 4 ||
        parent.principalId !== cursor.authorizedByPrincipalId ||
        parent.rootRunId !== cursor.rootRunId ||
        parent.depth + 1 !== cursor.depth
      )
        return { chain, complete: false };
      chain.push(parent);
      seen.add(parent.id);
      cursor = parent;
    }
    return { chain, complete: cursor.id === run.rootRunId };
  }

  private mayInspectAgentRun(actor: AuthContext, run: AgentRunRecord): boolean {
    if (this.holdsRoot(actor)) return true;
    if (actor.agentRunnerId !== undefined) return actor.agentRunnerId === run.agentId;
    if (actor.agentRunId !== undefined) {
      const own = this.store.getAgentRun(actor.agentRunId);
      if (own === null || own.principalId !== actor.principal.id) return false;
      return (
        run.id === own.id ||
        (run.parentRunId === own.id &&
          run.authorizedByPrincipalId === own.principalId &&
          run.rootRunId === own.rootRunId &&
          run.depth === own.depth + 1)
      );
    }
    const agent = this.store.getAgent(run.agentId);
    return agent !== null && this.mayManageAgent(actor, agent);
  }

  /** Bounded discovery through the inspection authority, not credential administration. */
  private listRunsAuthority(
    input: ListRunsRequest,
    actor: AuthContext,
    legacy = false,
  ): ListRunsV2Result {
    const current = this.restoreCredential(this.credentialReference(actor));
    if (current === null) throw new ServiceError("forbidden", "agent run inspection unavailable");
    const observedAt = this.runtime.now();
    const runs: ListRunsV2Result["runs"] = [];
    let truncated = false;
    if (input.agentId !== undefined) this.getAgentAuthority({ agentId: input.agentId }, current);
    for (const run of this.store.agentRunInspectionCandidates(
      current.principal.id,
      this.holdsRoot(current),
    )) {
      if (!this.mayInspectAgentRun(current, run)) continue;
      if (
        input.agentId !== undefined &&
        run.agentId !== input.agentId &&
        !this.inspectionAncestors(run).chain.some((ancestor) => ancestor.agentId === input.agentId)
      )
        continue;
      if (legacy) this.legacyRunResult({ run: this.presentAgentRun(run) });
      if (runs.length === 100) {
        truncated = true;
        break;
      }
      runs.push({
        id: run.id,
        agentId: run.agentId,
        session: run.session,
        activity: run.activity,
        ...(run.model === undefined ? {} : { model: run.model }),
        parentRunId: run.parentRunId,
        ...this.store.runTraceCounts(run.id),
        principalId: run.principalId,
        name:
          normalizeAgentDeclaration(
            this.store.getPrincipal(run.principalId)?.name ?? "Principal unavailable",
          ) ?? "[redacted]",
        purpose: normalizeAgentDeclaration(run.purpose) ?? "[redacted]",
        state:
          !TERMINAL_AGENT_RUN_STATES.has(run.state) && run.expiresAt <= observedAt
            ? "expired"
            : run.state,
        createdAt: run.createdAt,
        expiresAt: run.expiresAt,
        scope: runScope(run),
      });
    }
    return { observedAt, runs, truncated };
  }

  listRunsV2(input: ListRunsRequest, actor: AuthContext): ListRunsV2Result {
    return this.listRunsAuthority(input, actor);
  }

  listRuns(input: ListRunsRequest, actor: AuthContext): ListRunsResult {
    const result = this.listRunsAuthority(input, actor, true);
    return AgentRunInventorySchema.parse({
      ...result,
      runs: result.runs.map(({ scope: _scope, ...run }) => run),
    });
  }

  inspectRun(input: InspectRunRequest, actor: AuthContext): InspectRunResult {
    const result = this.inspectRunV2(input, actor);
    const record = this.store.getAgentRun(input.runId)!;
    const legacy = this.legacyRunResult({ run: this.presentAgentRun(record) }).run;
    const run = { ...result.run, caps: legacy.caps };
    Reflect.deleteProperty(run, "scope");
    return AgentRunInspectionSchema.parse({
      ...result,
      run,
      credentials: result.credentials.map(({ authorityScope: _authorityScope, ...credential }) => ({
        ...credential,
        grant:
          credential.grant === null
            ? null
            : {
                ...credential.grant,
                caps: credential.grant.caps.filter((cap) => cap !== "machines:shell"),
              },
      })),
    });
  }

  inspectRunV2(input: InspectRunRequest, actor: AuthContext): InspectRunV2Result {
    const parsed = InspectRunRequestSchema.parse(input);
    const current = this.restoreCredential(this.credentialReference(actor));
    const unavailable = (): never => {
      throw new ServiceError("forbidden", "agent run inspection unavailable");
    };
    if (current === null) return unavailable();
    const run = this.store.getAgentRun(parsed.runId);
    if (run === null) return unavailable();
    if (!this.mayInspectAgentRun(current, run)) return unavailable();
    const safeText = (value: string): string => normalizeAgentDeclaration(value) ?? "[redacted]";
    const now = this.runtime.now();
    const summarize = (entry: AgentRunRecord): AgentRunInspection["lineage"][number] => ({
      id: entry.id,
      agentId: entry.agentId,
      session: entry.session,
      activity: entry.activity,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      principalId: entry.principalId,
      name: safeText(this.store.getPrincipal(entry.principalId)?.name ?? "Principal unavailable"),
      state:
        !TERMINAL_AGENT_RUN_STATES.has(entry.state) && entry.expiresAt <= now
          ? "expired"
          : entry.state,
    });
    const ancestry = this.inspectionAncestors(run);
    // Filter every link independently: inspecting an ancestor must not reveal siblings.
    const lineage = this.store
      .listAgentRunTree(run.rootRunId)
      .filter((entry) => this.mayInspectAgentRun(current, entry))
      .map(summarize);
    const policy = this.store.getAgentPolicySnapshot(run.id, run.policyRevision);
    return AgentRunInspectionV2Schema.parse({
      availability: "available",
      observedAt: now,
      run: {
        ...summarize(run),
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        sponsorPrincipalId: run.authorizedByPrincipalId,
        authorizationPath: run.authorizationPath,
        purpose: safeText(run.purpose),
        ...(run.taskRef === undefined ? {} : { taskRef: safeText(run.taskRef) }),
        target: safeText(run.target),
        reach: run.reach,
        caps: [...run.caps],
        scope: runScope(run),
        createdAt: run.createdAt,
        expiresAt: run.expiresAt,
        renewals: run.renewals,
        depth: run.depth,
        maxDepth: run.maxDepth,
        maxDescendants: run.maxDescendants,
        policyRevision: run.policyRevision,
        acknowledgedPolicyRevision: run.acknowledgedPolicyRevision ?? null,
        policyAcknowledgedAt: policy?.acknowledgedAt ?? null,
        cleanup: {
          ownerPrincipalId: run.cleanupOwnerPrincipalId,
          revokedCredentials: run.cleanupRevokedCredentials,
          revokedGrants: run.cleanupRevokedGrants,
          finishedAt: run.finishedAt ?? null,
          status:
            run.state === "cleanup_failed"
              ? "failed"
              : run.finishedAt === undefined
                ? "pending"
                : "finished",
        },
      },
      lineage,
      lineageComplete: ancestry.complete,
      ...this.store.agentRunInspectionFacts(run.id, parsed, now, this.liveRunConnections(run.id)),
    });
  }

  async registerAgent(
    input: RegisterAgentRequest,
    actor: AuthContext,
  ): Promise<RegisterAgentResult> {
    return this.legacyAgentResult(
      await this.registerAgentAuthority(RegisterAgentRequestSchema.parse(input), actor),
    );
  }

  async registerAgentV2(
    input: RegisterAgentV2Request,
    actor: AuthContext,
  ): Promise<RegisterAgentV2Result> {
    const parsed = RegisterAgentV2RequestSchema.parse(input);
    const result = await this.registerAgentAuthority(
      { ...parsed, grant: internalGrant(parsed.grant) },
      actor,
    );
    return { ...result, agent: projectAgentV2(result.agent) };
  }

  private async registerAgentAuthority(
    parsed: RegisterAgentAuthorityInput,
    actor: AuthContext,
  ): Promise<RegisterAgentAuthorityResult> {
    let current = this.requireCurrentActor(actor);
    if (!this.mayRegisterAgent(current))
      throw new ServiceError("forbidden", "agent_registration_requires_human");
    const existing = this.store.getAgentBySponsorName(current.principal.id, parsed.name);
    if (existing !== null) return { agent: this.presentAgent(existing, current), created: false };
    this.validateStandingGrant(parsed.grant, current);
    await this.agentProfileValidator(parsed.harness, parsed.context.profile);
    current = this.requireCurrentActor(actor);
    if (!this.mayRegisterAgent(current))
      throw new ServiceError("forbidden", "agent_registration_requires_human");
    // Validation may cross an isolate boundary. Authority and the unique registration
    // must be read again before minting the one-time runner credential.
    this.validateStandingGrant(parsed.grant, current);
    const concurrent = this.store.getAgentBySponsorName(current.principal.id, parsed.name);
    if (concurrent !== null)
      return { agent: this.presentAgent(concurrent, current), created: false };
    const createdAt = this.runtime.now();
    const agentId = this.runtime.newId();
    const principalId = this.runtime.newId();
    const record: AgentRecord = {
      ...parsed,
      agentId,
      principalId,
      sponsorPrincipalId: current.principal.id,
      status: "enabled",
      createdAt,
      updatedAt: createdAt,
      authorizationPath: this.isOwnerKey(current) ? "owner_key" : "principal",
      authorizationCredential: this.agentAuthorizationCredential(current),
    };
    const minted = this.store.transaction(() => {
      this.store.createPrincipal(
        {
          id: principalId,
          kind: "agent",
          name: parsed.name,
          color: stableColor(principalId),
        },
        createdAt,
      );
      this.store.createAgent(record);
      const credential = this.persistToken(
        principalId,
        ["agents:run"],
        null,
        current.principal.id,
        "automated",
        {
          node: formatManifoldUri({ kind: "agent", agentId }),
          reach: "node",
          expiresAt: parsed.grant.expiresAt,
        },
        undefined,
        current.tokenId,
      );
      this.store.bindAgentRunnerCredential(agentId, credential.record.id);
      this.store.addEvent(null, createdAt, current.principal.id, "agent_registered", {
        agentId,
        principalId,
      });
      return credential;
    });
    this.agentChanged(agentId);
    return {
      agent: this.presentAgent(record, current),
      credential: { token: minted.raw, expiresAt: parsed.grant.expiresAt },
      created: true,
    };
  }

  private agentAuthorizationCredential(actor: AuthContext): AgentRun["authorizationCredential"] {
    // An Agent's stored sponsor lineage has no room for carried container confinement, so work
    // carrying it (ADR 0051) never sponsors one: dropping the list would widen it back.
    if (actor.containerGrants !== undefined)
      throw new ServiceError("forbidden", "agent_sponsor_confined");
    const credential = this.credentialReference(actor);
    return {
      tokenId: credential.tokenId,
      grantId: credential.grantId,
      caps: [...credential.caps],
      containerScope: credential.containerScope,
      ...(credential.authorityScope === undefined
        ? {}
        : { authorityScope: credential.authorityScope }),
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    };
  }

  private requireCurrentActor(actor: AuthContext): AuthContext {
    const current = this.restoreCredential(this.credentialReference(actor));
    if (current === null) throw new ServiceError("forbidden", "agent_unavailable");
    return current;
  }

  private validateStandingGrant(grant: AgentGrant, actor: AuthContext): void {
    AgentGrantAuthoritySchema.parse(grant);
    if (grant.expiresAt <= this.runtime.now()) throw new ServiceError("forbidden", "grant_expired");
    if (actor.expiresAt !== undefined && grant.expiresAt > actor.expiresAt)
      throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    for (const { target, reach, caps } of standingScope(grant)) {
      if (
        !this.allowsNode(actor, "agents:delegate", target, reach) ||
        caps.some((cap) => !this.allowsNode(actor, cap, target, reach))
      )
        throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    }
  }

  private mayRegisterAgent(actor: AuthContext): boolean {
    return (
      actor.agentRunId === undefined &&
      actor.agentRunnerId === undefined &&
      actor.principal.kind === "human"
    );
  }

  private mayManageAgent(actor: AuthContext, agent: AgentRecord): boolean {
    if (this.holdsRoot(actor)) return true;
    if (actor.agentRunId !== undefined || actor.agentRunnerId !== undefined) return false;
    const seen = new Set<string>();
    let sponsor = agent.sponsorPrincipalId;
    while (!seen.has(sponsor)) {
      if (sponsor === actor.principal.id) return true;
      seen.add(sponsor);
      const parent = this.store.listAgents().find((candidate) => candidate.principalId === sponsor);
      if (parent === undefined) break;
      sponsor = parent.sponsorPrincipalId;
    }
    return false;
  }

  private mayViewAgent(actor: AuthContext, agent: AgentRecord): boolean {
    if (this.mayManageAgent(actor, agent) || actor.agentRunnerId === agent.agentId) return true;
    return (
      actor.agentRunId !== undefined &&
      this.store.listAgentRuns(agent.agentId).some((run) => this.mayInspectAgentRun(actor, run))
    );
  }

  private presentAgent(record: AgentRecord, actor: AuthContext): Agent {
    const activeRuns = this.store
      .listAgentRuns(record.agentId)
      .filter(
        (run) =>
          !TERMINAL_AGENT_RUN_STATES.has(run.state) &&
          run.expiresAt > this.runtime.now() &&
          this.mayInspectAgentRun(actor, run),
      ).length;
    const grant = { ...record.grant };
    if (grant.tools?.length === 0) delete grant.tools;
    return AgentAuthoritySchema.parse({
      agentId: record.agentId,
      principalId: record.principalId,
      sponsorPrincipalId: record.sponsorPrincipalId,
      name: normalizeAgentDeclaration(record.name) ?? "[redacted]",
      purpose: normalizeAgentDeclaration(record.purpose) ?? "[redacted]",
      harness: record.harness,
      grant,
      context: record.context,
      ...(record.policyRevisionAcknowledged === undefined
        ? {}
        : { policyRevisionAcknowledged: record.policyRevisionAcknowledged }),
      state: record.status === "enabled" ? (activeRuns > 0 ? "running" : "idle") : record.status,
      activeRuns,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  private listAgentsAuthority(actor: AuthContext): {
    agents: Agent[];
    truncated: boolean;
    canRegister: boolean;
  } {
    const current = this.requireCurrentActor(actor);
    const visible = this.store.listAgents().filter((agent) => this.mayViewAgent(current, agent));
    const canRegister =
      this.mayRegisterAgent(current) &&
      (this.allows(current, "agents:delegate") ||
        this.store
          .listGrants()
          .some(
            (grant) =>
              (grant.caps.includes("*") || grant.caps.includes("agents:delegate")) &&
              this.effectiveCaps(current, grant.node).has("agents:delegate"),
          ));
    return {
      agents: visible.slice(0, 100).map((agent) => this.presentAgent(agent, current)),
      truncated: visible.length > 100,
      canRegister,
    };
  }

  listAgents(actor: AuthContext): ListAgentsResult {
    const result = this.listAgentsAuthority(actor);
    return {
      ...result,
      agents: result.agents.map((agent) => this.legacyAgentResult({ agent }).agent),
    };
  }

  listAgentsV2(actor: AuthContext): ListAgentsV2Result {
    const result = this.listAgentsAuthority(actor);
    return { ...result, agents: result.agents.map(projectAgentV2) };
  }

  getAgent(input: AgentRequest, actor: AuthContext): GetAgentResult {
    return this.legacyAgentResult(this.getAgentAuthority(input, actor));
  }

  getAgentV2(input: AgentRequest, actor: AuthContext): GetAgentV2Result {
    const result = this.getAgentAuthority(input, actor);
    return { ...result, agent: projectAgentV2(result.agent) };
  }

  private legacyAgentResult<T extends { agent: Agent }>(
    result: T,
  ): Omit<T, "agent"> & { agent: LegacyAgent } {
    try {
      return { ...result, agent: projectLegacyAgent(result.agent) };
    } catch (error) {
      if (error instanceof Error && error.message === "scoped_authority_requires_v2")
        throw new ServiceError("forbidden", error.message);
      throw error;
    }
  }

  private legacyRunResult<T extends { run: AgentRun }>(
    result: T,
  ): Omit<T, "run"> & { run: LegacyRun } {
    try {
      return { ...result, run: projectLegacyRun(result.run) };
    } catch (error) {
      if (error instanceof Error && error.message === "scoped_authority_requires_v2")
        throw new ServiceError("forbidden", error.message);
      throw error;
    }
  }

  private getAgentAuthority(input: AgentRequest, actor: AuthContext): AgentAuthorityResult {
    const current = this.requireCurrentActor(actor);
    const agent = this.store.getAgent(input.agentId);
    if (agent === null || !this.mayViewAgent(current, agent))
      throw new ServiceError("forbidden", "agent_unavailable");
    return {
      agent: this.presentAgent(agent, current),
      canManage: this.mayManageAgent(current, agent),
    };
  }

  async updateAgent(input: UpdateAgentRequest, actor: AuthContext): Promise<GetAgentResult> {
    const parsed = UpdateAgentRequestSchema.parse(input);
    this.getAgentAuthority(parsed, actor);
    const record = this.store.getAgent(parsed.agentId);
    if (parsed.grant !== undefined && record?.grant.authorityScope !== undefined)
      throw new ServiceError("forbidden", "scoped_authority_requires_v2");
    this.getAgent(parsed, actor);
    return this.legacyAgentResult(await this.updateAgentAuthority(parsed, actor, true));
  }

  async updateAgentV2(input: UpdateAgentV2Request, actor: AuthContext): Promise<GetAgentV2Result> {
    const parsed = UpdateAgentV2RequestSchema.parse(input);
    const result = await this.updateAgentAuthority(
      {
        agentId: parsed.agentId,
        ...(parsed.purpose === undefined ? {} : { purpose: parsed.purpose }),
        ...(parsed.context === undefined ? {} : { context: parsed.context }),
        ...(parsed.grant === undefined ? {} : { grant: internalGrant(parsed.grant) }),
      },
      actor,
    );
    return { ...result, agent: projectAgentV2(result.agent) };
  }

  private async updateAgentAuthority(
    parsed: UpdateAgentAuthorityInput,
    actor: AuthContext,
    legacy = false,
  ): Promise<AgentAuthorityResult> {
    let current = this.requireCurrentActor(actor);
    let agent = this.store.getAgent(parsed.agentId);
    if (agent === null || !this.mayManageAgent(current, agent))
      throw new ServiceError("forbidden", "agent_unavailable");
    if (agent.status === "retired") throw new ServiceError("forbidden", "agent_retired");
    if (parsed.grant !== undefined) this.validateStandingGrant(parsed.grant, current);
    if (parsed.context !== undefined) {
      await this.agentProfileValidator(agent.harness, parsed.context.profile);
      current = this.requireCurrentActor(actor);
      agent = this.store.getAgent(parsed.agentId);
      if (agent === null || !this.mayManageAgent(current, agent))
        throw new ServiceError("forbidden", "agent_unavailable");
      if (agent.status === "retired") throw new ServiceError("forbidden", "agent_retired");
      if (parsed.grant !== undefined) this.validateStandingGrant(parsed.grant, current);
      const sponsor =
        parsed.grant !== undefined && current.principal.id === agent.sponsorPrincipalId
          ? current
          : this.restoreAgentSponsor(agent);
      if (sponsor === null) throw new ServiceError("forbidden", "sponsor_authority_unavailable");
      this.validateStandingGrant(parsed.grant ?? agent.grant, sponsor);
    }
    if (legacy && parsed.grant !== undefined && agent.grant.authorityScope !== undefined)
      throw new ServiceError("forbidden", "scoped_authority_requires_v2");
    const next: AgentRecord = {
      ...agent,
      ...(parsed.purpose === undefined ? {} : { purpose: parsed.purpose }),
      ...(parsed.grant === undefined
        ? {}
        : {
            grant: parsed.grant,
            ...(current.principal.id === agent.sponsorPrincipalId
              ? {
                  authorizationCredential: this.agentAuthorizationCredential(current),
                  authorizationPath: this.isOwnerKey(current)
                    ? ("owner_key" as const)
                    : ("principal" as const),
                }
              : {}),
          }),
      ...(parsed.context === undefined ? {} : { context: parsed.context }),
      updatedAt: this.runtime.now(),
    };
    if (legacy) this.legacyAgentResult({ agent: this.presentAgent(next, current) });
    this.store.updateAgent(next);
    this.authorityChanged();
    this.agentChanged(agent.agentId);
    return { agent: this.presentAgent(next, current), canManage: true };
  }

  private setAgentStatus(
    input: AgentRequest,
    actor: AuthContext,
    status: AgentRecord["status"],
  ): AgentAuthorityResult {
    const current = this.requireCurrentActor(actor);
    const agent = this.store.getAgent(input.agentId);
    if (agent === null || !this.mayManageAgent(current, agent))
      throw new ServiceError("forbidden", "agent_unavailable");
    if (agent.status === "retired" && status !== "retired")
      throw new ServiceError("forbidden", "agent_retired");
    const next = { ...agent, status, updatedAt: this.runtime.now() };
    this.store.transaction(() => {
      this.store.updateAgent(next);
      if (status === "disabled") {
        const fenced = new Set([agent.principalId]);
        for (const candidate of this.store.listAgentRuns(agent.agentId)) {
          const run = this.store.getAgentRun(candidate.id);
          if (run !== null && !TERMINAL_AGENT_RUN_STATES.has(run.state)) {
            for (const descendant of this.agentRunSubtree(run)) fenced.add(descendant.principalId);
            this.settleAgentRunSubtree(
              run,
              "revoked",
              current.principal.id,
              `disabled by ${current.principal.id}`,
              false,
            );
          }
          this.pendingRunLaunches.delete(candidate.id);
        }
        this.store.afterCommit(() => {
          for (const principalId of fenced)
            for (const listener of [...this.revokedListeners]) listener(principalId, null);
        });
      }
      this.store.addEvent(null, next.updatedAt, current.principal.id, `agent_${status}`, {
        agentId: agent.agentId,
      });
      this.store.afterCommit(() => this.authorityChanged());
    });
    this.agentChanged(agent.agentId);
    return { agent: this.presentAgent(next, current), canManage: true };
  }

  disableAgent(input: AgentRequest, actor: AuthContext): GetAgentResult {
    this.getAgent(input, actor);
    return this.legacyAgentResult(this.setAgentStatus(input, actor, "disabled"));
  }
  enableAgent(input: AgentRequest, actor: AuthContext): GetAgentResult {
    this.getAgent(input, actor);
    return this.legacyAgentResult(this.setAgentStatus(input, actor, "enabled"));
  }
  retireAgent(input: AgentRequest, actor: AuthContext): GetAgentResult {
    this.getAgent(input, actor);
    return this.legacyAgentResult(this.setAgentStatus(input, actor, "retired"));
  }

  disableAgentV2(input: AgentRequest, actor: AuthContext): GetAgentV2Result {
    const result = this.setAgentStatus(input, actor, "disabled");
    return { ...result, agent: projectAgentV2(result.agent) };
  }
  enableAgentV2(input: AgentRequest, actor: AuthContext): GetAgentV2Result {
    const result = this.setAgentStatus(input, actor, "enabled");
    return { ...result, agent: projectAgentV2(result.agent) };
  }
  retireAgentV2(input: AgentRequest, actor: AuthContext): GetAgentV2Result {
    const result = this.setAgentStatus(input, actor, "retired");
    return { ...result, agent: projectAgentV2(result.agent) };
  }

  createRun(
    input: CreateRunRequest,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): CreateRunResult {
    const parsed = CreateRunRequestSchema.parse(input);
    const current = this.requireCurrentActor(actor);
    if (current.agentRunId !== undefined)
      throw new ServiceError("forbidden", "use_create_child_run");
    return this.legacyRunResult(this.admitRun(parsed, current, null, beforeEffect));
  }

  createRunV2(
    input: CreateRunV2Request,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): CreateRunV2Result {
    const { scope, ...parsed } = CreateRunV2RequestSchema.parse(input);
    const current = this.requireCurrentActor(actor);
    if (current.agentRunId !== undefined)
      throw new ServiceError("forbidden", "use_create_child_run");
    const result = this.admitRun(
      {
        ...parsed,
        scopedApi: true,
        ...(scope === undefined ? {} : { authorityScope: canonicalizeAuthorityScope(scope) }),
      },
      current,
      null,
      beforeEffect,
    );
    return { ...result, run: projectRunV2(result.run) };
  }

  createChildRun(
    input: CreateChildRunRequest,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): CreateRunResult {
    return this.legacyRunResult(
      this.createChildRunAuthority(CreateChildRunRequestSchema.parse(input), actor, beforeEffect),
    );
  }

  createChildRunV2(
    input: CreateChildRunV2Request,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): CreateRunV2Result {
    const { scope, ...parsed } = CreateChildRunV2RequestSchema.parse(input);
    const result = this.createChildRunAuthority(
      {
        ...parsed,
        scopedApi: true,
        ...(scope === undefined ? {} : { authorityScope: canonicalizeAuthorityScope(scope) }),
      },
      actor,
      beforeEffect,
    );
    return { ...result, run: projectRunV2(result.run) };
  }

  private createChildRunAuthority(
    parsed: Omit<CreateRunAuthorityInput, "agentId"> & {
      runId: string;
      agentId?: CreateChildRunRequest["agentId"];
    },
    actor: AuthContext,
    beforeEffect?: () => void,
  ): CreateRunAuthorityResult {
    const { runId, ...narrowing } = parsed;
    const current = this.requireCurrentActor(actor);
    const parent = this.store.getAgentRun(runId);
    if (
      parent === null ||
      (current.agentRunId !== parent.id &&
        current.agentRunnerId !== parent.agentId &&
        !this.holdsRoot(current))
    )
      throw new ServiceError("forbidden", "agent_unavailable");
    const agentId = parsed.agentId ?? parent.agentId;
    if (
      agentId !== parent.agentId &&
      !this.holdsRoot(current) &&
      !this.effectiveCaps(current, formatManifoldUri({ kind: "agent", agentId })).has("agents:run")
    )
      throw new ServiceError("forbidden", "agent_unavailable");
    return this.admitRun({ ...narrowing, agentId }, current, parent, beforeEffect);
  }

  private admitRun(
    parsed: CreateRunAuthorityInput,
    actor: AuthContext,
    parent: AgentRunRecord | null,
    beforeEffect?: () => void,
  ): CreateRunAuthorityResult {
    const agent = this.store.getAgent(parsed.agentId);
    const runner = actor.agentRunnerId === parsed.agentId;
    if (agent === null || (!runner && parent === null && !this.mayManageAgent(actor, agent)))
      throw new ServiceError("forbidden", "agent_unavailable");
    if (agent.status === "disabled") throw new ServiceError("forbidden", "agent_disabled");
    if (agent.status === "retired") throw new ServiceError("forbidden", "agent_retired");
    const now = this.runtime.now();
    if (agent.grant.expiresAt <= now) throw new ServiceError("forbidden", "grant_expired");
    if (!parsed.scopedApi) {
      this.legacyAgentResult({ agent: this.presentAgent(agent, actor) });
      if (
        parsed.caps !== undefined &&
        (agent.grant.authorityScope !== undefined || parent?.authorityScope !== undefined)
      )
        throw new ServiceError("forbidden", "scoped_authority_requires_v2");
    }
    const target =
      typeof parsed.target === "object"
        ? parsed.scopedApi && parsed.target.containerId !== undefined
          ? formatManifoldUri({ kind: "container", containerId: parsed.target.containerId })
          : formatManifoldUri({ kind: "machine", machineId: parsed.target.machineId })
        : (parsed.target ?? parent?.target ?? agent.grant.targets[0] ?? MANIFOLD_ROOT_URI);
    const authorityScope =
      parsed.authorityScope ??
      (parsed.scopedApi && parent !== null ? runScope(parent) : parent?.authorityScope) ??
      agent.grant.authorityScope ??
      (parsed.scopedApi ? standingScope(agent.grant) : undefined);
    const caps =
      authorityScope === undefined
        ? (parsed.caps ?? parent?.caps ?? agent.grant.caps)
        : ([...new Set(authorityScope.flatMap((entry) => entry.caps))] as AgentRunCap[]);
    const tools: ActionResultApproval[] = (parsed.tools ?? []).map((door) => {
      const approval = agent.grant.tools?.find((entry) => entry.door === door);
      const inherited = parent?.tools?.find((entry) => entry.door === door);
      if (
        approval === undefined ||
        (parent !== null &&
          (inherited === undefined || inherited.contractDigest !== approval.contractDigest))
      )
        throw new ServiceError("forbidden", "tool_exceeds_grant");
      const maxResultBytes = Math.min(
        approval.maxResultBytes ?? Number.POSITIVE_INFINITY,
        inherited?.maxResultBytes ?? Number.POSITIVE_INFINITY,
      );
      return {
        door,
        contractDigest: approval.contractDigest,
        ...(Number.isFinite(maxResultBytes) ? { maxResultBytes } : {}),
      };
    });
    const reach = parsed.reach ?? parent?.reach ?? agent.grant.reach;
    const delegation = parsed.delegation ?? {
      maxDepth: parent?.maxDepth ?? agent.grant.delegation.maxDepth,
      maxDescendants: parent?.maxDescendants ?? agent.grant.delegation.maxDescendants,
    };
    const lifetimeMs =
      parsed.lifetimeMs ??
      Math.min(
        agent.grant.maxRunLifetimeMs,
        agent.grant.expiresAt - now,
        parent === null ? Number.POSITIVE_INFINITY : parent.expiresAt - now,
      );
    if (caps.some((cap) => !agent.grant.caps.includes(cap)))
      throw new ServiceError("forbidden", "cap_exceeds_grant");
    if (authorityScope === undefined) {
      if (
        !agent.grant.targets.some((anchor) =>
          runContainsNode({ target: anchor, reach: agent.grant.reach }, target),
        )
      )
        throw new ServiceError("forbidden", "target_exceeds_grant");
      if (agent.grant.reach === "node" && reach !== "node")
        throw new ServiceError("forbidden", "reach_exceeds_grant");
    } else if (!scopeWithin(authorityScope, standingScope(agent.grant)))
      throw new ServiceError("forbidden", "scope_exceeds_grant");
    if (
      lifetimeMs < 60_000 ||
      lifetimeMs > agent.grant.maxRunLifetimeMs ||
      now + lifetimeMs > agent.grant.expiresAt
    )
      throw new ServiceError("forbidden", "lifetime_exceeds_grant");
    if (
      delegation.maxDepth > agent.grant.delegation.maxDepth ||
      delegation.maxDescendants > agent.grant.delegation.maxDescendants
    )
      throw new ServiceError("forbidden", "delegation_exceeds_grant");
    if (parsed.session !== undefined && parsed.session.harness !== agent.harness)
      throw new ServiceError("forbidden", "session_harness_mismatch");
    if (parsed.session !== undefined && !runner)
      throw new ServiceError("forbidden", "session_binding_untrusted");
    if (parsed.taskRef !== undefined && agent.harness !== "external")
      throw new ServiceError("forbidden", "session_binding_untrusted");
    const sponsor = this.restoreAgentSponsor(agent);
    const requirements = authorityScope ?? [{ target, reach, caps: [...caps] }];
    if (
      sponsor === null ||
      !this.scopeAuthorized(sponsor, requirements) ||
      (!runner && parent === null && !this.scopeAuthorized(actor, requirements))
    )
      throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    let parentActor: AuthContext | null = null;
    if (parent !== null) {
      if (
        parent.state !== "active" ||
        parent.acknowledgedPolicyRevision !== this.agentPolicy.revision ||
        parent.expiresAt <= now ||
        !parent.caps.includes("agents:delegate")
      )
        throw new ServiceError("forbidden", "sponsor_authority_unavailable");
      if (caps.some((cap) => !parent.caps.includes(cap)))
        throw new ServiceError("forbidden", "cap_exceeds_grant");
      if (!scopeWithin(requirements, runScope(parent)))
        throw new ServiceError("forbidden", "scope_exceeds_grant");
      if (now + lifetimeMs > parent.expiresAt)
        throw new ServiceError("forbidden", "lifetime_exceeds_grant");
      if (
        delegation.maxDepth > parent.maxDepth ||
        delegation.maxDescendants > parent.maxDescendants ||
        parent.depth + 1 > delegation.maxDepth
      )
        throw new ServiceError("forbidden", "delegation_exceeds_grant");
      parentActor = this.restoreRunCredential(parent.id);
      if (parentActor === null || !this.scopeAuthorized(parentActor, requirements))
        throw new ServiceError("forbidden", "sponsor_authority_unavailable");
      const tree = this.store.listAgentRunTree(parent.rootRunId);
      for (const ancestor of this.inspectionAncestors(parent).chain) {
        if (this.agentRunSubtree(ancestor, tree, false).length - 1 >= ancestor.maxDescendants)
          throw new ServiceError("forbidden", "delegation_exceeds_grant");
      }
    }
    beforeEffect?.();
    const liveAgent = this.store.getAgent(agent.agentId);
    const liveSponsor = liveAgent === null ? null : this.restoreAgentSponsor(liveAgent);
    const liveParent = parent === null ? null : this.restoreRunCredential(parent.id);
    const liveActor = this.requireCurrentActor(actor);
    if (
      liveAgent === null ||
      liveAgent.status !== "enabled" ||
      liveAgent.grant.expiresAt < now + lifetimeMs ||
      !scopeWithin(requirements, standingScope(liveAgent.grant)) ||
      liveSponsor === null ||
      !this.scopeAuthorized(liveSponsor, requirements) ||
      (parent !== null &&
        (liveParent === null || !this.scopeAuthorized(liveParent, requirements))) ||
      (!runner && parent === null && !this.scopeAuthorized(liveActor, requirements))
    )
      throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    const runId = this.runtime.newId();
    const expiresAt = now + lifetimeMs;
    const record: AgentRunRecord = {
      id: runId,
      agentId: agent.agentId,
      principalId: agent.principalId,
      rootRunId: parent?.rootRunId ?? runId,
      parentRunId: parent?.id ?? null,
      authorizedByPrincipalId: parent?.principalId ?? agent.sponsorPrincipalId,
      authorizationPath: parent === null ? agent.authorizationPath : "principal",
      authorizationCredential:
        parent === null ? agent.authorizationCredential : this.agentAuthorizationCredential(actor),
      purpose: agent.purpose,
      ...(parsed.taskRef === undefined ? {} : { taskRef: parsed.taskRef }),
      target,
      reach,
      caps: [...caps],
      ...(authorityScope === undefined
        ? {}
        : { authorityScope: canonicalizeAuthorityScope(authorityScope) }),
      ...(tools.length === 0 ? {} : { tools }),
      ...(typeof parsed.target === "object" ? { launchTarget: parsed.target } : {}),
      createdAt: now,
      expiresAt,
      renewals: 0,
      maxDepth: delegation.maxDepth,
      maxDescendants: delegation.maxDescendants,
      depth: parent === null ? 0 : parent.depth + 1,
      cleanupOwnerPrincipalId: parent?.principalId ?? agent.sponsorPrincipalId,
      state: "pending_policy",
      policyRevision: this.agentPolicy.revision,
      session: parsed.session ?? null,
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      activity: "unknown",
      cleanupRevokedCredentials: 0,
      cleanupRevokedGrants: 0,
    };
    if (!parsed.scopedApi) this.legacyRunResult({ run: this.presentAgentRun(record) });
    const minted = this.store.transaction(() => {
      this.store.createAgentRun(record, {
        runId,
        revision: this.agentPolicy.revision,
        bundles: this.agentPolicy.bundles,
        issuedAt: now,
      });
      const credential = this.persistToken(
        agent.principalId,
        caps,
        runContainerScope(target),
        record.authorizedByPrincipalId,
        "automated",
        { node: target, reach, expiresAt },
        authorityScope,
        actor.tokenId,
      );
      const sourceTokenId = actor.tokenId;
      if (sponsor.tokenId !== null && sponsor.tokenId !== sourceTokenId)
        this.store.inheritShareRecipientCredential(credential.record.id, sponsor.tokenId);
      if (
        parentActor?.tokenId != null &&
        parentActor.tokenId !== sourceTokenId &&
        parentActor.tokenId !== sponsor.tokenId
      )
        this.store.inheritShareRecipientCredential(credential.record.id, parentActor.tokenId);
      this.store.bindAgentRunCredential(runId, credential.record.id);
      this.store.addEvent(null, now, actor.principal.id, "agent_run_created", {
        runId,
        agentId: agent.agentId,
        parentRunId: record.parentRunId,
      });
      return credential;
    });
    this.agentChanged(agent.agentId, runId);
    if (runner || actor.agentRunId !== undefined)
      return { run: this.presentAgentRun(record), credential: { token: minted.raw, expiresAt } };
    for (const [id] of this.pendingRunLaunches) {
      const pending = this.store.getAgentRun(id);
      if (
        pending === null ||
        pending.expiresAt <= now ||
        TERMINAL_AGENT_RUN_STATES.has(pending.state)
      )
        this.pendingRunLaunches.delete(id);
    }
    this.pendingRunLaunches.set(runId, {
      token: minted.raw,
      ...(typeof parsed.target === "object" ? { target: parsed.target } : {}),
    });
    return { run: this.presentAgentRun(record) };
  }

  private scopeAuthorized(actor: AuthContext, scope: AuthorityScope): boolean {
    return scope.every(
      ({ target, reach, caps }) =>
        this.allowsNode(actor, "agents:delegate", target, reach) &&
        caps.every((cap) => this.allowsNode(actor, cap, target, reach)),
    );
  }

  private runAuthorityCurrent(run: AgentRunRecord): boolean {
    const agent = this.store.getAgent(run.agentId);
    const sponsor = agent === null ? null : this.restoreAgentSponsor(agent);
    const parent = run.parentRunId === null ? null : this.store.getAgentRun(run.parentRunId);
    if (
      agent === null ||
      agent.status === "disabled" ||
      agent.grant.expiresAt <= this.runtime.now() ||
      sponsor === null ||
      !scopeWithin(runScope(run), standingScope(agent.grant)) ||
      !this.scopeAuthorized(sponsor, runScope(run))
    )
      return false;
    if (run.parentRunId === null) return true;
    const parentActor = parent === null ? null : this.restoreRunCredential(parent.id);
    return (
      parent !== null &&
      parent.state === "active" &&
      parent.expiresAt > this.runtime.now() &&
      parent.acknowledgedPolicyRevision === this.agentPolicy.revision &&
      parentActor !== null &&
      scopeWithin(runScope(run), runScope(parent)) &&
      this.scopeAuthorized(parentActor, runScope(run))
    );
  }

  authorizeRunInput(runId: string, actor: AuthContext): { run: AgentRun; agent: Agent } {
    const current = this.requireCurrentActor(actor);
    const run = this.store.getAgentRun(runId);
    const agent = run === null ? null : this.store.getAgent(run.agentId);
    if (
      run === null ||
      agent === null ||
      (!this.mayManageAgent(current, agent) &&
        current.agentRunnerId !== agent.agentId &&
        current.agentRunId !== run.id)
    )
      throw new ServiceError("forbidden", "agent_unavailable");
    if (
      TERMINAL_AGENT_RUN_STATES.has(run.state) ||
      run.expiresAt <= this.runtime.now() ||
      agent.status === "disabled"
    )
      throw new ServiceError("forbidden", "agent_run_unavailable");
    return { run: this.presentAgentRun(run), agent: this.presentAgent(agent, current) };
  }

  private restoreRunCredential(runId: string): AuthContext | null {
    const token = this.store
      .listTokensForAgentRun(runId)
      .findLast(
        (candidate) =>
          candidate.revokedAt === null &&
          candidate.expiresAt !== null &&
          candidate.expiresAt > this.runtime.now(),
      );
    return token === undefined
      ? null
      : this.restoreCredential({
          principalId: token.principalId,
          tokenId: token.id,
          grantId: token.grantId,
          caps: token.caps,
          ...(token.authorityScope === undefined ? {} : { authorityScope: token.authorityScope }),
          containerScope: token.containerId,
          ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt }),
        });
  }

  /** Host admission only. This consumes neither a credential nor the one-use association. */
  prepareNativeRun(
    runId: string,
    target: HarnessTarget,
    actor: AuthContext,
  ): {
    run: AgentRun;
    agent: Agent;
    credential: CredentialReference;
  } {
    const authorized = this.authorizeRunInput(runId, actor);
    const record = this.store.getAgentRun(runId)!;
    const credential = this.restoreRunCredential(runId);
    const ref = parseManifoldUri(record.target);
    if (
      record.nativeJob !== undefined ||
      record.session !== null ||
      this.store.getTerminalForRun(runId) !== null ||
      authorized.agent.state === "retired" ||
      credential === null ||
      !this.runAuthorityCurrent(record) ||
      (record.target !== MANIFOLD_ROOT_URI && ref === null) ||
      (ref !== null && "machineId" in ref && ref.machineId !== target.machineId) ||
      (ref?.kind === "container" && ref.containerId !== target.containerId) ||
      (record.launchTarget !== undefined &&
        (record.launchTarget.machineId !== target.machineId ||
          record.launchTarget.containerId !== target.containerId))
    )
      throw new ServiceError("forbidden", "run_launch_unavailable");
    return { ...authorized, credential: this.credentialReference(credential) };
  }

  bindNativeRun(
    runId: string,
    jobId: string,
    session: SessionRef,
    target: HarnessTarget,
    actor: AuthContext,
  ): void {
    const prepared = this.prepareNativeRun(runId, target, actor);
    if (session.harness !== prepared.agent.harness || session.machineId !== target.machineId)
      throw new ServiceError("forbidden", "session_harness_mismatch");
    this.store.bindAgentRunJob(runId, jobId, session, prepared.credential);
    this.store.afterCommit(() => {
      this.pendingRunLaunches.delete(runId);
      this.agentChanged(prepared.agent.agentId, runId);
    });
  }

  /** Restore the exact bound non-secret lineage on every owner request, never principal authority. */
  nativeRunAuthority(runId: string, jobId: string): NativeRunAuthority {
    const record = this.store.getAgentRun(runId);
    const actor =
      record?.nativeJob?.jobId === jobId
        ? this.restoreCredential(record.nativeJob.credential)
        : null;
    if (record === null || actor === null || actor.agentRunId !== runId)
      throw new ServiceError("forbidden", "agent_run_unavailable");
    this.requireOwnAgentRun(actor);
    const agent = this.store.getAgent(record.agentId);
    if (
      agent === null ||
      agent.status === "disabled" ||
      this.pausedPrincipals.has(actor.principal.id) ||
      !this.runAuthorityCurrent(record)
    )
      throw new ServiceError("forbidden", "agent_run_unavailable");
    return {
      auth: actor,
      run: this.presentAgentRun(record),
      agent: this.presentAgent(agent, actor),
    };
  }

  /** Every selected ancestor ceiling remains live; changing a grant never upgrades a snapshot. */
  agentToolGrantRefusal(
    runId: string,
    door: string,
  ): "tool_ungranted" | "publication_changed" | null {
    const run = this.store.getAgentRun(runId);
    const selected = run?.tools?.find((entry) => entry.door === door);
    if (!run || !selected) return "tool_ungranted";
    const ancestry = this.inspectionAncestors(run);
    if (!ancestry.complete) return "tool_ungranted";
    for (const ancestor of ancestry.chain) {
      const inherited = ancestor.tools?.find((entry) => entry.door === door);
      const current = this.store
        .getAgent(ancestor.agentId)
        ?.grant.tools?.find((entry) => entry.door === door);
      if (!inherited || !current) return "tool_ungranted";
      if (
        inherited.contractDigest !== selected.contractDigest ||
        current.contractDigest !== selected.contractDigest ||
        (selected.maxResultBytes ?? Number.POSITIVE_INFINITY) >
          Math.min(
            inherited.maxResultBytes ?? Number.POSITIVE_INFINITY,
            current.maxResultBytes ?? Number.POSITIVE_INFINITY,
          )
      )
        return "publication_changed";
    }
    return null;
  }

  /** Process settlement withdraws authority; it is not an assertion of consumer-effect durability. */
  settleNativeRun(
    runId: string,
    jobId: string,
    outcome: "completed" | "failed" | "cancelled" | "abandoned",
  ): void {
    const run = this.store.getAgentRun(runId);
    if (run?.nativeJob?.jobId !== jobId || TERMINAL_AGENT_RUN_STATES.has(run.state)) return;
    this.settleAgentRunSubtree(
      run,
      run.expiresAt <= this.runtime.now() ? "expired" : outcome,
      null,
    );
  }

  runHarnessActor(runId: string, actor: AuthContext): AuthContext {
    this.authorizeRunInput(runId, actor);
    if (actor.agentRunnerId === undefined) return actor;
    const run = this.restoreRunCredential(runId);
    if (run === null) throw new ServiceError("forbidden", "agent_run_unavailable");
    return run;
  }

  claimRunLaunch(
    runId: string,
    actor: AuthContext,
  ): { run: AgentRun; agent: Agent; token?: string; target?: HarnessTarget; terminalId?: string } {
    const authorized = this.authorizeRunInput(runId, actor);
    const record = this.store.getAgentRun(runId)!;
    if (record.nativeJob !== undefined)
      throw new ServiceError("forbidden", "run_launch_unavailable");
    if (
      authorized.agent.state === "retired" ||
      this.restoreRunCredential(runId) === null ||
      !this.runAuthorityCurrent(record)
    )
      throw new ServiceError("forbidden", "run_launch_unavailable");
    const pending = this.pendingRunLaunches.get(runId);
    if (pending !== undefined) {
      if (!this.runLaunchCredentialValid(runId, pending.token))
        throw new ServiceError("forbidden", "run_launch_unavailable");
      return { ...authorized, ...pending };
    }
    const terminal = this.store.getTerminalForRun(runId);
    if (
      authorized.run.session === null ||
      terminal === null ||
      terminal.machineId !== authorized.run.session.machineId
    )
      throw new ServiceError("forbidden", "run_launch_unavailable");
    return {
      ...authorized,
      terminalId: terminal.id,
      target: { machineId: terminal.machineId, containerId: terminal.containerId },
    };
  }

  /** Binding may refresh a launch credential, but never changes a Run's session or lease. */
  bindRunSession(runId: string, session: SessionRef, actor: AuthContext): string {
    const { agent, run } = this.claimRunLaunch(runId, actor);
    if (session.harness !== agent.harness)
      throw new ServiceError("forbidden", "session_harness_mismatch");
    if (
      run.session !== null &&
      (run.session.harness !== session.harness ||
        run.session.machineId !== session.machineId ||
        run.session.sessionId !== session.sessionId)
    )
      throw new ServiceError("conflict", "run_session_already_bound");
    const pending = this.pendingRunLaunches.get(runId);
    if (pending !== undefined) {
      this.store.updateAgentRunSession(runId, session);
      this.pendingRunLaunches.delete(runId);
      this.agentChanged(agent.agentId, runId);
      return pending.token;
    }
    const record = this.store.getAgentRun(runId)!;
    return this.store.transaction(() => {
      const credential = this.persistToken(
        record.principalId,
        record.caps,
        runContainerScope(record.target),
        record.authorizedByPrincipalId,
        "automated",
        { node: record.target, reach: record.reach, expiresAt: record.expiresAt },
        record.authorityScope,
        record.authorizationCredential.tokenId,
      );
      this.store.inheritAgentRunShareRecipientCredentials(credential.record.id, runId);
      this.store.bindAgentRunCredential(runId, credential.record.id);
      return credential.raw;
    });
  }

  runLaunchCredentialValid(runId: string, token: string): boolean {
    const credential = this.store.getTokenByHash(sha256Hex(token));
    const run = credential === null ? null : this.store.getAgentRunByToken(credential.id);
    const agent = run === null ? null : this.store.getAgent(run.agentId);
    return (
      credential !== null &&
      credential.revokedAt === null &&
      credential.expiresAt !== null &&
      credential.expiresAt > this.runtime.now() &&
      run?.id === runId &&
      run.expiresAt > this.runtime.now() &&
      !TERMINAL_AGENT_RUN_STATES.has(run.state) &&
      agent !== null &&
      agent.status === "enabled" &&
      agent.grant.expiresAt > this.runtime.now() &&
      this.runAuthorityCurrent(run)
    );
  }

  /** Retires only rejected private launch custody; the incumbent Run and its tokens survive. */
  revokeRunLaunchCredential(runId: string, raw: string, actorId: string): void {
    this.store.transaction(() => {
      const token = this.store.getTokenByHash(sha256Hex(raw));
      if (token === null) return;
      const run = this.store.getAgentRunByToken(token.id);
      if (run?.id !== runId) throw new ServiceError("forbidden", "run_launch_credential_required");
      if (token.revokedAt !== null) return;
      const at = this.runtime.now();
      const revoked = this.store.revokeToken(token.id, at);
      this.store.addEvent(null, at, actorId, "token_revoked", {
        subjectPrincipalId: token.principalId,
        runId,
        tokenId: token.id,
        count: revoked.tokens,
      });
      this.store.afterCommit(() => {
        const pending = this.pendingRunLaunches.get(runId);
        if (pending !== undefined && secretsEqual(pending.token, raw))
          this.pendingRunLaunches.delete(runId);
        if (revoked.tokens > 0 || revoked.grants > 0) this.authorityChanged();
      });
    });
  }

  reportRunActivity(input: ReportRunActivityRequest, actor: AuthContext): ReportRunActivityResult {
    this.legacyRunResult(this.authorizeRunInput(input.runId, actor));
    return this.legacyRunResult(this.reportRunActivityAuthority(input, actor));
  }

  reportRunActivityV2(
    input: ReportRunActivityRequest,
    actor: AuthContext,
  ): ReportRunActivityV2Result {
    const result = this.reportRunActivityAuthority(input, actor);
    return { run: projectRunV2(result.run) };
  }

  private reportRunActivityAuthority(
    input: ReportRunActivityRequest,
    actor: AuthContext,
  ): { run: AgentRun } {
    const parsed = ReportRunActivityRequestSchema.parse(input);
    const current = this.requireCurrentActor(actor);
    const run = this.store.getAgentRun(parsed.runId);
    if (run === null || (current.agentRunId !== run.id && current.agentRunnerId !== run.agentId))
      throw new ServiceError("forbidden", "harness_credential_required");
    this.authorizeRunInput(run.id, current);
    this.store.updateAgentRunActivity(run.id, parsed.activity);
    if (run.activity !== parsed.activity) this.agentChanged(run.agentId, run.id);
    return { run: this.presentAgentRun(this.store.getAgentRun(run.id)!) };
  }

  agentPolicyChallenge(actor: AuthContext): AgentPolicyChallenge {
    const run = this.requireOwnAgentRun(actor);
    const snapshot = this.store.getAgentPolicySnapshot(run.id, run.policyRevision);
    if (snapshot === null) throw new ServiceError("conflict", "agent policy snapshot is missing");
    return {
      runId: run.id,
      revision: snapshot.revision,
      required: [...snapshot.bundles],
      issuedAt: snapshot.issuedAt,
      ...(snapshot.acknowledgedAt === undefined ? {} : { acknowledgedAt: snapshot.acknowledgedAt }),
    };
  }

  acknowledgeAgentPolicy(
    input: AcknowledgeAgentPolicyRequest,
    actor: AuthContext,
  ): AcknowledgeAgentPolicyResult {
    this.legacyRunResult({ run: this.presentAgentRun(this.requireOwnAgentRun(actor)) });
    return this.legacyRunResult(this.acknowledgeAgentPolicyAuthority(input, actor));
  }

  acknowledgeAgentPolicyV2(
    input: AcknowledgeAgentPolicyRequest,
    actor: AuthContext,
  ): AcknowledgeAgentPolicyV2Result {
    const result = this.acknowledgeAgentPolicyAuthority(input, actor);
    return { run: projectRunV2(result.run) };
  }

  private acknowledgeAgentPolicyAuthority(
    input: AcknowledgeAgentPolicyRequest,
    actor: AuthContext,
  ): { run: AgentRun } {
    const parsed = AcknowledgeAgentPolicyRequestSchema.parse(input);
    const run = this.requireOwnAgentRun(actor);
    if (run.expiresAt <= this.runtime.now()) {
      this.settleAgentRunSubtree(run, "expired", null);
      throw new ServiceError("forbidden", "agent run expired");
    }
    if (
      run.policyRevision !== this.agentPolicy.revision ||
      parsed.revision !== run.policyRevision
    ) {
      throw new ServiceError("conflict", "agent policy revision changed");
    }
    const snapshot = this.store.getAgentPolicySnapshot(run.id, parsed.revision);
    if (snapshot === null) throw new ServiceError("conflict", "agent policy snapshot is missing");
    const acknowledgements = new Map(parsed.acknowledgements.map(({ id, digest }) => [id, digest]));
    if (
      acknowledgements.size !== snapshot.bundles.length ||
      snapshot.bundles.some(({ id, digest }) => acknowledgements.get(id) !== digest)
    ) {
      throw new ServiceError("forbidden", "every exact agent policy bundle must be acknowledged");
    }
    if (run.state === "active" && run.acknowledgedPolicyRevision === run.policyRevision) {
      return { run: this.presentAgentRun(run) };
    }
    if (run.state !== "pending_policy" && run.state !== "policy_stale") {
      throw new ServiceError(
        "forbidden",
        "agent run cannot acknowledge policy in its current state",
      );
    }
    const acknowledgedAt = this.runtime.now();
    this.store.transaction(() => {
      if (!this.store.acknowledgeAgentPolicy(run.id, parsed.revision, acknowledgedAt)) {
        throw new ServiceError("conflict", "agent policy acknowledgement raced");
      }
      this.store.addEvent(null, acknowledgedAt, actor.principal.id, "agent_policy_acknowledged", {
        runId: run.id,
        revision: parsed.revision,
        bundleIds: snapshot.bundles.map(({ id }) => id),
      });
    });
    this.agentChanged(run.agentId, run.id);
    this.authorityChanged();
    const acknowledged = this.store.getAgentRun(run.id);
    if (acknowledged === null) throw new ServiceError("conflict", "agent run is missing");
    return { run: this.presentAgentRun(acknowledged) };
  }

  renewAgentRun(
    input: RenewAgentRunRequest,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): RenewAgentRunResult {
    this.legacyRunResult(this.authorizeRunInput(input.runId, actor));
    return this.legacyRunResult(this.renewAgentRunAuthority(input, actor, beforeEffect));
  }

  renewAgentRunV2(
    input: RenewAgentRunRequest,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): RenewAgentRunV2Result {
    const result = this.renewAgentRunAuthority(input, actor, beforeEffect);
    return { ...result, run: projectRunV2(result.run) };
  }

  private renewAgentRunAuthority(
    input: RenewAgentRunRequest,
    actor: AuthContext,
    beforeEffect?: () => void,
  ): RenewRunAuthorityResult {
    const parsed = RenewAgentRunRequestSchema.parse(input);
    const currentActor = this.requireCurrentActor(actor);
    if (currentActor.agentRunId === undefined && currentActor.agentRunnerId === undefined)
      throw new ServiceError("forbidden", "run_renewal_requires_harness");
    const initial = this.store.getAgentRun(parsed.runId);
    const agent = initial === null ? null : this.store.getAgent(initial.agentId);
    if (
      initial === null ||
      agent === null ||
      (currentActor.agentRunId !== initial.id && currentActor.agentRunnerId !== initial.agentId)
    )
      throw new ServiceError("forbidden", "agent_unavailable");
    if (agent.status === "disabled") throw new ServiceError("forbidden", "agent_disabled");
    if (agent.grant.expiresAt <= this.runtime.now())
      throw new ServiceError("forbidden", "grant_expired");
    if (parsed.lifetimeMs > agent.grant.maxRunLifetimeMs)
      throw new ServiceError("forbidden", "lifetime_exceeds_grant");
    if (
      initial.state !== "active" ||
      initial.acknowledgedPolicyRevision !== initial.policyRevision ||
      initial.policyRevision !== this.agentPolicy.revision ||
      initial.expiresAt <= this.runtime.now()
    )
      throw new ServiceError("forbidden", "only an active policy-current run may be renewed");
    if (initial.renewals >= AGENT_RUN_MAX_RENEWALS)
      throw new ServiceError("conflict", "agent run renewal budget exhausted");
    if (!this.runAuthorityCurrent(initial))
      throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    let expiresAt = Math.min(this.runtime.now() + parsed.lifetimeMs, agent.grant.expiresAt);
    if (initial.parentRunId !== null) {
      const parent = this.store.getAgentRun(initial.parentRunId);
      if (
        parent === null ||
        parent.state !== "active" ||
        parent.acknowledgedPolicyRevision !== parent.policyRevision ||
        parent.expiresAt <= this.runtime.now()
      )
        throw new ServiceError("forbidden", "parent run is not active");
      expiresAt = Math.min(expiresAt, parent.expiresAt);
    }
    if (expiresAt <= initial.expiresAt)
      throw new ServiceError("conflict", "agent run renewal must extend its expiry");
    const at = this.runtime.now();
    beforeEffect?.();
    this.requireCurrentActor(actor);
    if (!this.runAuthorityCurrent(initial))
      throw new ServiceError("forbidden", "sponsor_authority_unavailable");
    const result = this.store.transaction(() => {
      const revoked = this.store.revokeTokensByAgentRun(initial.id, at);
      if (!this.store.renewAgentRun(initial.id, expiresAt, initial.authorizationCredential))
        throw new ServiceError("conflict", "agent run renewal failed");
      const minted = this.persistToken(
        initial.principalId,
        initial.caps,
        runContainerScope(initial.target),
        initial.authorizedByPrincipalId,
        "automated",
        { node: initial.target, reach: initial.reach, expiresAt },
        initial.authorityScope,
        initial.authorizationCredential.tokenId,
      );
      this.store.inheritAgentRunShareRecipientCredentials(minted.record.id, initial.id);
      this.store.bindAgentRunCredential(initial.id, minted.record.id);
      this.store.addEvent(null, at, currentActor.principal.id, "agent_run_renewed", {
        runId: initial.id,
        expiresAt,
        renewal: initial.renewals + 1,
        revokedCredentials: revoked.tokens,
      });
      this.store.afterCommit(() => {
        this.authorityChanged();
        for (const listener of [...this.revokedListeners]) listener(initial.principalId, null);
      });
      return { revoked, minted };
    });
    this.agentChanged(initial.agentId, initial.id);
    return {
      run: this.presentAgentRun(this.store.getAgentRun(initial.id)!),
      credential: { token: result.minted.raw, expiresAt },
      revokedCredentials: result.revoked.tokens,
    };
  }

  finishAgentRun(input: FinishAgentRunRequest, actor: AuthContext): FinishAgentRunResult {
    return this.legacyRunResult(this.finishAgentRunAuthority(input, actor, true));
  }

  finishAgentRunV2(input: FinishAgentRunRequest, actor: AuthContext): FinishAgentRunV2Result {
    const result = this.finishAgentRunAuthority(input, actor);
    return { ...result, run: projectRunV2(result.run) };
  }

  private finishAgentRunAuthority(
    input: FinishAgentRunRequest,
    actor: AuthContext,
    legacy = false,
  ): FinishRunAuthorityResult {
    const parsed = FinishAgentRunRequestSchema.parse(input);
    const current = this.requireCurrentActor(actor);
    const run = this.store.getAgentRun(parsed.runId);
    const agent = run === null ? null : this.store.getAgent(run.agentId);
    if (
      run === null ||
      agent === null ||
      (!this.holdsRoot(current) &&
        current.agentRunId !== run.id &&
        current.agentRunId !== run.parentRunId &&
        current.agentRunnerId !== run.agentId &&
        !this.mayManageAgent(current, agent))
    )
      throw new ServiceError("forbidden", "agent_unavailable");
    if (current.authorityScope === undefined && !contextContainsNode(current, run.target))
      throw new ServiceError("forbidden", "cannot widen container scope");
    if (TERMINAL_AGENT_RUN_STATES.has(run.state))
      throw new ServiceError("conflict", "agent run is already finished");
    if (legacy) this.legacyRunResult({ run: this.presentAgentRun(run) });
    return this.settleAgentRunSubtree(
      run,
      run.expiresAt <= this.runtime.now() ? "expired" : parsed.outcome,
      current.principal.id,
    );
  }

  reloadAgentPolicy(actor: AuthContext): ReloadAgentPolicyResult {
    if (!this.holdsRoot(actor)) throw new ServiceError("forbidden", "root capability required");
    const next = loadAgentPolicy(this.agentPolicyFile);
    return {
      revision: next.revision,
      suspendedRuns: this.installAgentPolicy(next, actor.principal.id),
    };
  }

  private presentAgentRun(record: AgentRunRecord): AgentRun {
    const principal = this.store.getPrincipal(record.principalId);
    if (principal === null) throw new ServiceError("conflict", "agent run principal is missing");
    return AgentRunAuthoritySchema.parse({
      id: record.id,
      agentId: record.agentId,
      session: record.session,
      activity: record.activity,
      ...(record.model === undefined ? {} : { model: record.model }),
      principal,
      rootRunId: record.rootRunId,
      parentRunId: record.parentRunId,
      authorizedByPrincipalId: record.authorizedByPrincipalId,
      authorizationPath: record.authorizationPath,
      authorizationCredential: record.authorizationCredential,
      purpose: record.purpose,
      ...(record.taskRef === undefined ? {} : { taskRef: record.taskRef }),
      target: record.target,
      reach: record.reach,
      caps: [...record.caps],
      ...(record.authorityScope === undefined ? {} : { authorityScope: record.authorityScope }),
      ...(record.tools?.length ? { tools: record.tools } : {}),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      renewals: record.renewals,
      maxDepth: record.maxDepth,
      maxDescendants: record.maxDescendants,
      depth: record.depth,
      cleanupOwnerPrincipalId: record.cleanupOwnerPrincipalId,
      state: record.state,
      policyRevision: record.policyRevision,
      ...(record.acknowledgedPolicyRevision === undefined
        ? {}
        : { acknowledgedPolicyRevision: record.acknowledgedPolicyRevision }),
      cleanup: {
        revokedCredentials: record.cleanupRevokedCredentials,
        revokedGrants: record.cleanupRevokedGrants,
        ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
        ...(record.cleanupFailure === undefined ? {} : { failure: record.cleanupFailure }),
      },
    });
  }

  private requireOwnAgentRun(actor: AuthContext): AgentRunRecord {
    if (actor.agentRunId === undefined) {
      throw new ServiceError("forbidden", "agent run credential required");
    }
    const run = this.store.getAgentRun(actor.agentRunId);
    if (run === null || run.principalId !== actor.principal.id) {
      throw new ServiceError("forbidden", "agent run credential required");
    }
    if (TERMINAL_AGENT_RUN_STATES.has(run.state)) {
      throw new ServiceError("forbidden", "agent run is finished");
    }
    if (run.expiresAt <= this.runtime.now()) {
      this.settleAgentRunSubtree(run, "expired", null);
      throw new ServiceError("forbidden", "agent run expired");
    }
    return run;
  }

  private agentRunSubtree(
    target: AgentRunRecord,
    tree = this.store.listAgentRunTree(target.rootRunId),
    openOnly = true,
  ): AgentRunRecord[] {
    const selected = new Set([target.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const run of tree) {
        if (run.parentRunId !== null && selected.has(run.parentRunId) && !selected.has(run.id)) {
          selected.add(run.id);
          changed = true;
        }
      }
    }
    return tree
      .filter(
        (run) => selected.has(run.id) && (!openOnly || !TERMINAL_AGENT_RUN_STATES.has(run.state)),
      )
      .sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id));
  }

  private settleAgentRunSubtree(
    target: AgentRunRecord,
    outcome: AgentRunState,
    actorId: string | null,
    reason?: string,
    notify = true,
  ): FinishRunAuthorityResult {
    const selected = this.agentRunSubtree(target);
    if (selected.length === 0) throw new ServiceError("conflict", "agent run is already finished");
    const at = this.runtime.now();
    const result = this.store.transaction(() => {
      let revokedCredentials = 0;
      let revokedGrants = 0;
      const revokedPrincipals = new Set<string>();
      for (const run of selected) {
        const revoked = this.store.revokeTokensByAgentRun(run.id, at);
        revokedCredentials += revoked.tokens;
        revokedGrants += revoked.grants;
        if (revoked.tokens > 0) revokedPrincipals.add(run.principalId);
        const state = run.id === target.id ? outcome : "revoked";
        this.store.settleAgentRun(run.id, state, at, revoked.tokens, revoked.grants, reason);
        this.pendingRunLaunches.delete(run.id);
        this.agentChanged(run.agentId, run.id);
        this.store.addEvent(null, at, actorId, "agent_run_finished", {
          runId: run.id,
          rootRunId: run.rootRunId,
          parentRunId: run.parentRunId,
          state,
          triggerRunId: target.id,
          ...(reason === undefined ? {} : { reason }),
          revokedCredentials: revoked.tokens,
          revokedGrants: revoked.grants,
        });
      }
      this.store.afterCommit(() => {
        this.authorityChanged();
        for (const principalId of notify ? revokedPrincipals : []) {
          for (const listener of [...this.revokedListeners]) listener(principalId, null);
        }
      });
      return { revokedCredentials, revokedGrants };
    });
    const settled = this.store.getAgentRun(target.id);
    if (settled === null) throw new ServiceError("conflict", "agent run is missing");
    return {
      run: this.presentAgentRun(settled),
      finishedRuns: selected.length,
      revokedCredentials: result.revokedCredentials,
      revokedGrants: result.revokedGrants,
    };
  }

  private installAgentPolicy(next: AgentPolicySet, actorId: string | null): number {
    const at = this.runtime.now();
    const affected = this.store
      .listOpenAgentRuns(at)
      .filter((run) => run.policyRevision !== next.revision);
    if (affected.length === 0) {
      this.agentPolicy = next;
      return 0;
    }
    const suspendedRuns = affected.filter((run) => run.state === "active").length;
    this.store.transaction(() => {
      for (const run of affected) {
        this.store.issueAgentPolicySnapshot({
          runId: run.id,
          revision: next.revision,
          bundles: next.bundles,
          issuedAt: at,
        });
        this.store.updateAgentRunPolicy(
          run.id,
          next.revision,
          run.state === "pending_policy" ? "pending_policy" : "policy_stale",
        );
        this.agentChanged(run.agentId, run.id);
      }
      this.store.addEvent(null, at, actorId, "agent_policy_reloaded", {
        revision: next.revision,
        affectedRuns: affected.length,
        suspendedRuns,
      });
    });
    this.agentPolicy = next;
    this.authorityChanged();
    return suspendedRuns;
  }

  private expireAgentRuns(): void {
    const finished = new Set<string>();
    for (const expired of this.store.listExpiredAgentRuns(this.runtime.now())) {
      if (finished.has(expired.id)) continue;
      const result = this.settleAgentRunSubtree(expired, "expired", null);
      finished.add(result.run.id);
      for (const run of this.store.listAgentRunTree(expired.rootRunId)) {
        if (TERMINAL_AGENT_RUN_STATES.has(run.state)) finished.add(run.id);
      }
    }
  }

  /**
   * Mints the container-scoped agent identity injected into a newly created terminal.
   *
   * Explicitly terminal-lifecycle-bound, not exempt because the principal is an agent:
   * terminal exit or kill revokes this identity instead of a wall-clock deadline interrupting
   * its PTY. External mints for the same principal still receive the ordinary agent bound.
   */
  mintTerminalLifecycleToken(
    terminalId: string,
    containerId: string,
    actorId: string,
    sourceTokenId?: string | null,
  ): TokenGrant {
    const source =
      sourceTokenId === undefined || sourceTokenId === null
        ? null
        : this.store.getToken(sourceTokenId);
    if (sourceTokenId === undefined || sourceTokenId === null) {
      if (this.store.hasShareRecipientPrincipal(actorId)) {
        throw new ServiceError("forbidden", "share_recipient_source_required");
      }
    } else {
      if (
        source === null ||
        source.principalId !== actorId ||
        source.revokedAt !== null ||
        (source.expiresAt !== null && source.expiresAt <= this.runtime.now())
      ) {
        throw new ServiceError("forbidden", "share_recipient_source_refused");
      }
    }
    const shareDerived = source !== null && this.store.hasShareRecipientCredential(source.id);
    if (shareDerived && source.containerId !== null && source.containerId !== containerId) {
      throw new ServiceError("forbidden", "cannot widen container scope");
    }
    const id = this.runtime.newId();
    const principal: Principal = {
      id,
      kind: "agent",
      name: terminalId.slice(0, 64),
      color: stableColor(id),
    };
    this.store.createPrincipal(principal, this.runtime.now());
    const defaults = ["containers:read", "scenes:write", "terminals:write"] satisfies Cap[];
    const caps = shareDerived ? defaults.filter((cap) => source.caps.includes(cap)) : defaults;
    const minted = this.persistToken(
      principal.id,
      caps,
      containerId,
      actorId,
      "never",
      undefined,
      undefined,
      sourceTokenId,
    );
    return { token: minted.raw, principal, caps, containerId };
  }

  private persistMachine(name: string, actorId: string): MachineEnrollment {
    return this.store.transaction(() => {
      const machineId = this.runtime.newId();
      /*
        `never`, and this is ADR 0019 §2's exemption at the site that most needs it: the
        holder is a daemon on another box that provisioned itself once and has no browser to
        re-bootstrap through. A machine token also never reaches `authenticate` — it is
        looked up by `authenticateMachine`, which has no expiry rung — so the exemption is
        made twice and cannot be undone by one of them changing.
      */
      const minted = this.persistToken(machineId, [], null, actorId, "never");
      const machine: MachineRecord = {
        id: machineId,
        name,
        tokenId: minted.record.id,
        lastSeen: this.runtime.now(),
        // Nobody has dialled in yet: no owner identity to remember, and admission open.
        ownerHostId: null,
        draining: false,
        lastRefusal: null,
      };
      this.store.createMachine(machine);
      return { machine, machineToken: minted.raw };
    });
  }

  /** Enrolls a machine only for an unscoped principal holding `machines:mint`. */
  enrollMachine(name: string, actor: AuthContext): MachineEnrollment {
    this.requireMachineAuthority(actor);
    return this.persistMachine(name, actor.principal.id);
  }

  /**
   * ENROLMENT BY NAME, AS ONE DECISION (issue #40, #259). The lookup and the mint happen in one
   * synchronous transaction after the authority check, so two concurrent enrolments of one
   * name cannot both decide "absent": one creates the row and receives the only raw token, the
   * other answers that existing identity with none. A caller composing lookup and mint across
   * two awaited steps would race exactly there, which is why no such pair is exposed.
   */
  findOrEnrollMachine(
    name: string,
    actor: AuthContext,
  ):
    | { readonly created: true; readonly enrollment: MachineEnrollment }
    | { readonly created: false; readonly machine: MachineRecord } {
    this.requireMachineAuthority(actor);
    return this.store.transaction(() => {
      const existing = this.store.getMachineByName(name);
      if (existing !== null) return { created: false, machine: existing };
      return { created: true, enrollment: this.persistMachine(name, actor.principal.id) };
    });
  }

  /** Enrolls the trusted local daemon as the owner during boot. */
  enrollLocalMachine(name: string): MachineEnrollment {
    return this.persistMachine(name, this.ownerPrincipal.id);
  }

  /**
   * Rotates an existing machine's raw secret: revokes the old token and mints a fresh one.
   * `actorId` attributes the rotation; local-agent boot recovery omits it because that path
   * acts with owner authority by definition. NO CALLER CHECK: this is the trusted boot path.
   * A caller-bound rotation goes through {@link rotateEnrolledMachineToken}.
   */
  rotateMachineToken(machine: MachineRecord, actorId?: string): MachineEnrollment {
    return this.rotateMachine(() => machine, actorId ?? this.ownerPrincipal.id);
  }

  /**
   * A CALLER'S rotation, by id: the enrolment authority is asked of the caller first, and the
   * machine is re-resolved inside the rotating transaction, so a stale or forgotten id is
   * `not_found` and the token revoked is always the one the row references NOW — never one a
   * caller described.
   */
  rotateEnrolledMachineToken(machineId: string, actor: AuthContext): MachineEnrollment {
    this.requireMachineAuthority(actor);
    return this.rotateMachine(() => {
      const machine = this.store.getMachine(machineId);
      if (machine === null) throw new ServiceError("not_found", "machine not found");
      return machine;
    }, actor.principal.id);
  }

  private rotateMachine(resolve: () => MachineRecord, actor: string): MachineEnrollment {
    const result = this.store.transaction(() => {
      const machine = resolve();
      const at = this.runtime.now();
      const revoked = this.store.revokeToken(machine.tokenId, at);
      if (revoked.tokens > 0) {
        this.store.addEvent(null, at, actor, "token_revoked", {
          subjectPrincipalId: machine.id,
          count: 1,
        });
      }
      const minted = this.persistToken(machine.id, [], null, actor, "never");
      const lastSeen = this.runtime.now();
      this.store.updateMachineToken(machine.id, minted.record.id, lastSeen);
      return {
        enrollment: {
          machine: { ...machine, tokenId: minted.record.id, lastSeen },
          machineToken: minted.raw,
        },
        revoked,
      };
    });
    if (this.settleRevocation(result.revoked) > 0) {
      for (const listener of [...this.revokedListeners])
        listener(result.enrollment.machine.id, null);
    }
    return result.enrollment;
  }

  /** Minting and withdrawing a machine credential are one unscoped `machines:mint` authority. */
  private requireMachineAuthority(actor: AuthContext): void {
    if (!this.allows(actor, "machines:mint") || actor.containerScope !== null) {
      throw new ServiceError("forbidden", "machines:mint capability required");
    }
  }

  /**
   * WITHDRAWAL AS AN ACT — the mechanism half of the door ADR 0019 §3 names as missing.
   *
   * Everything here already existed one level down: `rotateMachineToken` revokes a machine's
   * token, writes `token_revoked` and fires the fence. What did not exist was revocation
   * WITHOUT a re-mint, so a credential minted for "a process nobody in this workspace can
   * see" could be replaced but never taken away. This is that, and it is deliberately not a
   * rotation with the mint elided: rotation ANSWERS with a fresh secret, and a door whose
   * job is to withdraw authority must not hand one out.
   *
   * THE ROW SURVIVES ITS CREDENTIAL. Revoking a machine is revoking that machine's
   * credential (docs/CONTRACTS.md §One authoritative implementation: one concept, one spelling) — the inventory keeps the row, so an
   * operator can still see the box they just cut off, and re-enrolling by name with
   * `rotateToken: true` is how it comes back. Deleting the row would make withdrawal and
   * forgetting the same verb, which they are not.
   *
   * The same ladder `enrollMachine` runs, and for the same reason: minting and withdrawing a
   * machine credential are the same authority, so `machines:mint` answers both and a
   * container-scoped caller reaches neither. Inventing a `machines:revoke` would be a second
   * answer to "who administers the fleet".
   */
  revokeMachine(machineId: string, actor: AuthContext): number {
    this.requireMachineAuthority(actor);
    const machine = this.store.getMachine(machineId);
    if (machine === null) throw new ServiceError("not_found", "machine not found");
    const revoked = this.store.transaction(() => {
      const at = this.runtime.now();
      const gone = this.store.revokeToken(machine.tokenId, at);
      if (gone.tokens > 0) {
        this.store.addEvent(null, at, actor.principal.id, "token_revoked", {
          subjectPrincipalId: machine.id,
          count: 1,
        });
      }
      return gone;
    });
    /*
      THE SAME FENCE a principal's revocation rides, and it reaches the machine socket
      because `MachineGateway` registered on it with the machine id in the principal slot
      (`machine-ws.ts`). Two revocation paths would have meant two fences to keep in step.
    */
    const count = this.settleRevocation(revoked);
    if (count > 0) {
      for (const listener of [...this.revokedListeners]) listener(machine.id, null);
    }
    return count;
  }

  /** Removes only withdrawn inventory; terminal ownership and history are never torn down. */
  forgetMachine(machineId: string, actor: AuthContext): void {
    this.requireMachineAuthority(actor);
    this.store.transaction(() => {
      const machine = this.store.getMachine(machineId);
      if (machine === null) throw new ServiceError("not_found", "machine not found");
      const token = this.store.getToken(machine.tokenId);
      if (token !== null && token.revokedAt === null) {
        throw new ServiceError("conflict", "not_revoked");
      }
      if (machine.draining) throw new ServiceError("conflict", "drain_pending");
      if (this.store.hasMachineTerminals(machineId)) {
        throw new ServiceError("conflict", "terminals_retained");
      }
      this.store.deleteMachine(machineId);
    });
  }

  /**
   * Credential-administrator inventory: root sees every identity and live credential; a
   * non-root minter sees itself plus only live credentials it issued. Inspection-only viewers
   * use listRuns, whose bounded summaries contain no credential references or raw labels.
   */
  listCredentialsV2(actor: AuthContext): PrincipalCredentialsV2[] {
    // HTTP authentication precedes the awaited body read; restore again at point of use.
    const current = this.restoreCredential(this.credentialReference(actor));
    if (current === null)
      throw new ServiceError("forbidden", "credential inspection authority required");
    if (current.containerScope !== null || !this.allows(current, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const now = this.runtime.now();
    const rows: PrincipalCredentialsV2[] = [];
    for (const { principal, createdAt } of this.store.listPrincipalsWithCreation()) {
      const wholePrincipal =
        this.holdsRoot(current) ||
        principal.id === current.principal.id ||
        (principal.kind === "agent" &&
          this.store.hasIssuedToken(principal.id, current.principal.id, null) &&
          this.store.hasRegisteredAgentPrincipal(principal.id));
      const visible = this.store
        .listTokensByPrincipal(principal.id)
        /*
          LIVE means "would authenticate right now", which is `authenticate`'s two refusals
          read as a predicate. Stating it here rather than in the store is deliberate: the
          rule belongs beside the function that enforces it, so a third answer cannot appear
          in a query somebody writes later.
        */
        .filter(
          (token) =>
            token.revokedAt === null &&
            (token.expiresAt ?? Infinity) > now &&
            (wholePrincipal || token.mintedBy === current.principal.id),
        );
      if (!wholePrincipal && visible.length === 0) continue;
      const sessions = visible.map((token) => ({
        id: token.id,
        createdAt: token.createdAt,
        caps: [...token.caps],
        ...(token.mintedBy === null ? {} : { mintedBy: token.mintedBy }),
        ...(token.containerId === null ? {} : { containerId: token.containerId }),
        ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt }),
        ...(token.authorityScope === undefined ? {} : { authorityScope: token.authorityScope }),
      }));
      const service =
        principal.kind === "service" ? this.store.getNativeServiceIdentity(principal.id) : null;
      const pausedAt = this.pausedPrincipals.get(principal.id);
      rows.push({
        principal,
        createdAt,
        sessions,
        ...(pausedAt === undefined ? {} : { pausedAt }),
        ...service,
      });
    }
    return rows;
  }

  listCredentials(actor: AuthContext): PrincipalCredentials[] {
    try {
      return this.listCredentialsV2(actor).map((row) => ({
        ...row,
        sessions: row.sessions.map(projectLegacyCredential),
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "scoped_authority_requires_v2")
        throw new ServiceError("forbidden", error.message);
      throw error;
    }
  }
  private accessPauseAdministrator(actor: AuthContext): AuthContext {
    const current = this.restoreCredential(this.credentialReference(actor));
    if (
      current === null ||
      current.containerScope !== null ||
      !this.holdsRoot(current) ||
      (current.principal.id !== this.ownerPrincipal.id &&
        this.pausedPrincipals.has(current.principal.id))
    ) {
      throw new ServiceError("forbidden", "root capability required");
    }
    return current;
  }

  /**
   * Suspends future authority checks without revoking credentials, closing connections, or
   * settling work. The lifecycle gate in effectiveCaps dominates every descendant grant.
   */
  pausePrincipalAccess(
    input: PrincipalAccessPauseRequest,
    actor: AuthContext,
  ): PrincipalAccessPauseResult {
    const { principalId } = PrincipalAccessPauseRequestSchema.parse(input);
    const current = this.accessPauseAdministrator(actor);
    if (principalId === this.ownerPrincipal.id) {
      throw new ServiceError("forbidden", "workspace owner access cannot be paused");
    }
    if (this.store.getPrincipal(principalId) === null) {
      throw new ServiceError("not_found", "principal not found");
    }
    const existing = this.pausedPrincipals.get(principalId);
    if (existing !== undefined) return { principalId, pausedAt: existing };
    const pausedAt = this.runtime.now();
    this.store.transaction(() => {
      if (!this.store.pausePrincipalAccess(principalId, pausedAt, current.principal.id)) {
        throw new ServiceError("conflict", "principal access pause raced");
      }
      this.store.afterCommit(() => {
        this.pausedPrincipals.set(principalId, pausedAt);
        this.authorityChanged();
        this.accessPauseChangeListener(
          "principal_access_paused",
          principalId,
          pausedAt,
          current.principal.id,
        );
      });
    });
    return { principalId, pausedAt };
  }

  /** Restores the same credentials and grants without reauthentication or token replacement. */
  resumePrincipalAccess(
    input: PrincipalAccessPauseRequest,
    actor: AuthContext,
  ): PrincipalAccessPauseResult {
    const { principalId } = PrincipalAccessPauseRequestSchema.parse(input);
    const current = this.accessPauseAdministrator(actor);
    if (principalId === this.ownerPrincipal.id) {
      throw new ServiceError("forbidden", "workspace owner access cannot be paused");
    }
    if (this.store.getPrincipal(principalId) === null) {
      throw new ServiceError("not_found", "principal not found");
    }
    const existing = this.pausedPrincipals.get(principalId);
    if (existing === undefined) return { principalId, pausedAt: null };
    const resumedAt = this.runtime.now();
    this.store.transaction(() => {
      if (!this.store.resumePrincipalAccess(principalId)) {
        throw new ServiceError("conflict", "principal access resume raced");
      }
      this.store.afterCommit(() => {
        this.pausedPrincipals.delete(principalId);
        this.authorityChanged();
        this.accessPauseChangeListener(
          "principal_access_resumed",
          principalId,
          resumedAt,
          current.principal.id,
        );
      });
    });
    return { principalId, pausedAt: null };
  }

  /** Revokes a server-issued short-lived identity after a failed terminal create. */
  revokeIssuedPrincipal(principalId: string, actorId: string): number {
    return this.store.transaction(() => {
      let settled = 0;
      const fenced = new Set([principalId]);
      const agent = this.store
        .listAgents()
        .find((candidate) => candidate.principalId === principalId);
      if (agent !== undefined) {
        for (const candidate of this.store.listAgentRuns(agent.agentId)) {
          const run = this.store.getAgentRun(candidate.id);
          if (run !== null && !TERMINAL_AGENT_RUN_STATES.has(run.state)) {
            for (const descendant of this.agentRunSubtree(run)) fenced.add(descendant.principalId);
            settled += this.settleAgentRunSubtree(
              run,
              "revoked",
              actorId,
              undefined,
              false,
            ).revokedCredentials;
          }
        }
      }
      const at = this.runtime.now();
      const revoked = this.store.revokeTokensByPrincipal(principalId, at);
      const count = settled + revoked.tokens;
      this.store.addEvent(null, at, actorId, "token_revoked", {
        subjectPrincipalId: principalId,
        count,
      });
      this.store.afterCommit(() => {
        this.settleRevocation(revoked);
        if (count > 0) {
          for (const affectedPrincipal of fenced)
            for (const listener of [...this.revokedListeners]) listener(affectedPrincipal, null);
        }
      });
      return count;
    });
  }

  private refuseManagedServicePrincipal(principalId: string): void {
    const principal = this.store.getPrincipal(principalId);
    if (principal?.kind !== "service") return;
    const serviceId = this.store.getNativeServiceIdentity(principalId)?.serviceId ?? principal.name;
    throw new ServiceError(
      "forbidden",
      `service_credential_managed_by_service: ${serviceId}; use engine.services.configureInstance with enabled:false, replace, or uninstall the service`,
    );
  }

  /** Issuer-owned withdrawal; registered Agent cutoffs retain their atomic Run lifecycle. */
  revokePrincipal(principalId: string, actor: AuthContext): number {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const agent = this.store
      .listAgents()
      .find((candidate) => candidate.principalId === principalId);
    if (
      !this.holdsRoot(actor) &&
      principalId !== actor.principal.id &&
      !this.store.hasIssuedToken(
        principalId,
        actor.principal.id,
        agent === undefined ? actor.containerScope : null,
      )
    ) {
      throw new ServiceError("forbidden", "cannot revoke another principal");
    }
    this.refuseManagedServicePrincipal(principalId);
    if (agent !== undefined) {
      if (
        this.store
          .listAgentRuns(agent.agentId)
          .some((run) => !contextContainsNode(actor, run.target))
      )
        throw new ServiceError("forbidden", "cannot widen container scope");
      return this.revokeIssuedPrincipal(principalId, actor.principal.id);
    }
    if (this.holdsRoot(actor)) return this.revokeIssuedPrincipal(principalId, actor.principal.id);

    const containerId = actor.containerScope;
    const at = this.runtime.now();
    const count = this.settleRevocation(
      this.store.revokeTokensByPrincipal(principalId, at, {
        ...(containerId === null ? {} : { containerId }),
        ...(principalId === actor.principal.id ? {} : { mintedBy: actor.principal.id }),
      }),
    );
    this.store.addEvent(containerId, at, actor.principal.id, "token_revoked", {
      subjectPrincipalId: principalId,
      count,
    });
    if (count > 0) {
      for (const listener of [...this.revokedListeners]) listener(principalId, containerId);
    }
    return count;
  }

  /*
    SHARES — the same mechanism, pointed at another instance.

    Everything below reuses the ladder above rather than restating it. A share IS a token
    bound to a node (A5), so `mintShare` runs `mintToken`'s attenuation checks in the same
    order and with the same messages, and a ticket minted under a share is an ordinary
    principal holding an ordinary token — which is the entire reason the host's doors, its
    revocation fence and its attendance roster need no cross-instance special case.
  */

  private shareHasAuthority(share: ShareRecord): boolean {
    return (
      share.revokedAt === null &&
      share.grantId !== null &&
      this.store.getGrant(share.grantId) !== null
    );
  }

  /** Authenticates a share secret. Never a principal bearer: a share names a pipe, not a self. */
  authenticateShare(raw: string): ShareRecord {
    const share = this.store.getShareByHash(sha256Hex(raw));
    if (share === null) throw new ServiceError("unauthorized", "invalid share token");
    if (!this.shareHasAuthority(share)) throw new ServiceError("forbidden", "revoked");
    return share;
  }

  /**
   * Mints a share for one container, addressed to one guest origin.
   *
   * The origin is recorded HERE, at mint time, rather than believed later at the handshake.
   * That is what makes a principal's `origin` trustworthy data instead of a claim, and
   * docs/CONTRACTS.md §Producer-neutral behavior depends on the difference: nothing downstream of arbitration may branch on
   * origin, which is only safe while origin is something this instance decided.
   *
   * A share's caps also become an instance GRANT ROW at the shared node. That is the
   * immutable remote ceiling, not consent for every principal at the guest. An approved
   * recipient's ordinary ticket token and its token-bound grant carry only that subset.
   */
  mintShare(input: MintShareRequest, actor: AuthContext): ShareGrant {
    const minter = this.restoreCredential(this.credentialReference(actor));
    if (minter === null) throw new ServiceError("forbidden", "credential revoked or expired");
    const parsed = MintShareRequestSchema.parse(input);
    if (parsed.node.kind !== "container") {
      throw new ServiceError("conflict", "only a container can be shared");
    }
    const node = formatManifoldUri(parsed.node);
    if (!this.issuanceAdmits(minter, "tokens:mint", node, "subtree")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    this.requireMintCapabilities(parsed.caps, minter, true, node);
    const containerId = parsed.node.containerId;
    if (minter.containerScope !== null && containerId !== minter.containerScope) {
      throw new ServiceError("forbidden", "cannot widen container scope");
    }
    if (this.store.getContainer(containerId) === null) {
      throw new ServiceError("not_found", "container not found");
    }
    const origin = normalizeInstanceOrigin(parsed.origin);
    if (origin === null) throw new ServiceError("conflict", "invalid instance origin");

    const raw = randomSecret();
    const createdAt = this.runtime.now();
    const grant: Grant = {
      id: this.runtime.newId(),
      principal: { kind: "instance", origin },
      node: formatManifoldUri({ kind: "container", containerId }),
      caps: [...parsed.caps],
      effect: "allow",
      reach: "subtree",
      createdBy: minter.principal.id,
      createdAt,
    };
    const record: Omit<ShareRecord, "tickets"> = {
      id: this.runtime.newId(),
      hash: sha256Hex(raw),
      containerId,
      caps: [...parsed.caps],
      origin,
      mintedBy: minter.principal.id,
      createdAt,
      revokedAt: null,
      grantId: grant.id,
    };
    this.store.transaction(() => {
      this.store.createGrant(grant);
      this.store.createShare(record);
      if (minter.tokenId !== null) {
        this.store.bindShareRecipientDelegations(record.id, minter.tokenId);
      }
      this.store.addEvent(containerId, record.createdAt, minter.principal.id, "share_minted", {
        shareId: record.id,
        origin,
        caps: [...parsed.caps],
      });
    });
    // A new row can change what a live socket may do, so no cached verdict outlives it.
    this.authorityChanged();
    return { share: toShare({ ...record, tickets: 0 }), token: raw };
  }

  /**
   * The host-side identity standing for one of the guest's principals, and a bearer for it.
   *
   * The principal is claimed once and reused, so a guest who reconnects is the SAME person
   * in the host's roster rather than a new arrival every time. The token is fresh on every
   * call, which is the ordinary bearer discipline: a secret already handed over cannot be
   * handed over twice, and minting another one under the same identity costs a row.
   *
   * The foreign principal's own id is never adopted. It is a string from another instance's
   * namespace, and adopting it would let a guest choose who it is here.
   */
  mintShareTicket(share: ShareRecord, guest: Principal, caps?: readonly Cap[]): TokenGrant {
    const parsedGuest = PrincipalSchema.parse(guest);
    // A pending proposal must commit even though admission is refused. Throw outside the
    // transaction; all admitted paths read current share/approval and mint in the same write.
    const outcome = this.store.transaction<{ refusal: string } | { grant: TokenGrant }>(() => {
      const currentShare = this.store.getShare(share.id);
      if (currentShare === null || !this.shareHasAuthority(currentShare)) {
        return { refusal: "revoked" } as const;
      }
      const previous = this.store.getShareRecipient(currentShare.id, parsedGuest.id);
      const active =
        previous !== null && previous.approvedAt !== null && previous.removedAt === null;
      const requested = caps ?? (active ? previous.caps : currentShare.caps);
      if (
        requested.length === 0 ||
        requested.some((cap) => cap === "*" || !currentShare.caps.includes(cap))
      ) {
        return { refusal: "recipient_caps_refused" } as const;
      }
      const ticketCaps = projectLegacyCaps(requested);
      if (ticketCaps.length !== requested.length)
        return { refusal: "scoped_authority_requires_v2" } as const;
      const recipient = this.store.requestShareRecipient(
        currentShare.id,
        parsedGuest,
        requested,
        this.runtime.now(),
      );
      if (!active) return { refusal: "recipient_unapproved" } as const;
      if (requested.some((cap) => !recipient.caps.includes(cap))) {
        return { refusal: "recipient_caps_refused" } as const;
      }
      const principalId = this.store.claimShareTicket(
        currentShare.id,
        parsedGuest.id,
        this.runtime.newId(),
        this.runtime.now(),
      );
      let principal = this.store.getPrincipal(principalId);
      if (principal === null) {
        principal = {
          id: principalId,
          kind: recipient.guestPrincipal.kind,
          name: recipient.guestPrincipal.name,
          color: recipient.guestPrincipal.color,
          origin: currentShare.origin,
        };
        this.store.createPrincipal(principal, this.runtime.now());
      }
      const minted = this.persistToken(
        principal.id,
        requested,
        currentShare.containerId,
        recipient.approvedBy,
        expiryFor(principal.kind),
      );
      this.store.bindShareTicketCredential(minted.record.id, currentShare.id, parsedGuest.id);
      this.store.inheritShareRecipientDelegations(minted.record.id, currentShare.id);
      const expiresAt = minted.record.expiresAt;
      if (expiresAt === null) throw new Error("share ticket must have a finite expiry");
      return {
        grant: {
          token: minted.raw,
          principal,
          caps: ticketCaps,
          containerId: currentShare.containerId,
          expiresAt,
        },
      };
    });
    if ("refusal" in outcome) throw new ServiceError("forbidden", outcome.refusal);
    return outcome.grant;
  }

  /** Owner/root visibility, live mint authority and scope are the existing share boundary. */
  private shareAdministrator(
    shareId: string,
    actor: AuthContext,
  ): {
    share: ShareRecord;
    actor: AuthContext;
  } {
    const current = this.restoreCredential(this.credentialReference(actor));
    if (current === null) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const share = this.store.getShare(shareId);
    if (share === null) throw new ServiceError("not_found", "share not found");
    if (
      !this.allowsNode(
        current,
        "tokens:mint",
        formatManifoldUri({ kind: "container", containerId: share.containerId }),
      )
    ) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    if (!this.holdsRoot(current) && share.mintedBy !== current.principal.id) {
      throw new ServiceError("forbidden", "cannot administer another principal's share");
    }
    if (current.containerScope !== null && current.containerScope !== share.containerId) {
      throw new ServiceError("forbidden", "cannot widen container scope");
    }
    return { share, actor: current };
  }

  listShareRecipients(shareId: string, actor: AuthContext): readonly ShareRecipient[] {
    this.shareAdministrator(shareId, actor);
    return this.store.listShareRecipients(shareId);
  }

  private retireShareRecipientTickets(
    share: ShareRecord,
    guestPrincipalId: string,
    at: number,
    actorId: string,
  ): ReadonlySet<string> {
    const principals = new Set(
      this.store.shareRecipientCredentialPrincipals(share.id, guestPrincipalId),
    );
    for (const runId of this.store.shareRecipientCredentialRuns(share.id, guestPrincipalId)) {
      const run = this.store.getAgentRun(runId);
      if (run !== null && !TERMINAL_AGENT_RUN_STATES.has(run.state)) {
        for (const descendant of this.agentRunSubtree(run)) principals.add(descendant.principalId);
        this.settleAgentRunSubtree(run, "revoked", actorId, undefined, false);
      }
    }
    for (const delegated of this.store.shareRecipientDelegatedShares(share.id, guestPrincipalId)) {
      this.revokeShareRecord(delegated, actorId);
    }
    const revoked = this.store.revokeShareRecipientTickets(share.id, guestPrincipalId, at);
    this.store.afterCommit(() => {
      this.settleRevocation(revoked);
      for (const principalId of principals) {
        for (const listener of [...this.revokedListeners]) listener(principalId, null);
      }
    });
    return principals;
  }

  approveShareRecipient(input: ApproveShareRecipientRequest, actor: AuthContext): ShareRecipient {
    const parsed = ApproveShareRecipientRequestSchema.parse(input);
    return this.store.transaction(() => {
      const { share, actor: current } = this.shareAdministrator(parsed.shareId, actor);
      if (!this.shareHasAuthority(share)) throw new ServiceError("forbidden", "revoked");
      const recipient = this.store.getShareRecipient(share.id, parsed.guestPrincipalId);
      if (recipient === null) throw new ServiceError("not_found", "share recipient not found");
      this.requireMintCapabilities(
        parsed.caps,
        current,
        true,
        formatManifoldUri({ kind: "container", containerId: share.containerId }),
      );
      if (
        parsed.caps.some(
          (cap) => !share.caps.includes(cap) || !recipient.requestedCaps.includes(cap),
        )
      ) {
        throw new ServiceError("forbidden", "recipient_caps_refused");
      }
      const at = this.runtime.now();
      this.store.approveShareRecipient(
        share.id,
        parsed.guestPrincipalId,
        parsed.caps,
        at,
        current.principal.id,
      );
      if (
        recipient.approvedAt !== null &&
        recipient.removedAt === null &&
        recipient.caps.some((cap) => !parsed.caps.includes(cap))
      ) {
        this.retireShareRecipientTickets(share, parsed.guestPrincipalId, at, current.principal.id);
      }
      const approved = this.store.getShareRecipient(share.id, parsed.guestPrincipalId);
      if (approved === null) throw new Error("approved recipient was not persisted");
      this.store.addEvent(share.containerId, at, current.principal.id, "share_recipient_approved", {
        shareId: share.id,
        origin: share.origin,
        guestPrincipalId: parsed.guestPrincipalId,
        caps: [...parsed.caps],
      });
      return approved;
    });
  }

  removeShareRecipient(input: RemoveShareRecipientRequest, actor: AuthContext): ShareRecipient {
    const parsed = RemoveShareRecipientRequestSchema.parse(input);
    return this.store.transaction(() => {
      const { share, actor: current } = this.shareAdministrator(parsed.shareId, actor);
      const recipient = this.store.getShareRecipient(share.id, parsed.guestPrincipalId);
      if (recipient === null) throw new ServiceError("not_found", "share recipient not found");
      if (recipient.removedAt !== null) return recipient;
      const at = this.runtime.now();
      this.store.removeShareRecipient(share.id, parsed.guestPrincipalId, at, current.principal.id);
      this.retireShareRecipientTickets(share, parsed.guestPrincipalId, at, current.principal.id);
      const removed = this.store.getShareRecipient(share.id, parsed.guestPrincipalId);
      if (removed === null) throw new Error("removed recipient was not persisted");
      this.store.addEvent(share.containerId, at, current.principal.id, "share_recipient_removed", {
        shareId: share.id,
        origin: share.origin,
        guestPrincipalId: parsed.guestPrincipalId,
      });
      return removed;
    });
  }

  resumableShareTicketPrincipals(shareId: string): readonly string[] {
    const share = this.store.getShare(shareId);
    return share === null || !this.shareHasAuthority(share)
      ? []
      : this.store.resumableShareTicketPrincipals(shareId, this.runtime.now());
  }

  /**
   * Cuts the pipe. The share row is marked revoked durably FIRST — so a restart cannot
   * resurrect it — and only then is every identity it minted revoked through the ordinary
   * fence, which is what closes the guest's live session sockets. The count answers how
   * many identities were severed; zero is a success, exactly as it is for `revokePrincipal`.
   *
   * The share's GRANT ROW is deleted in the same breath, and it is removed rather than marked.
   * That asymmetry is the difference between a credential and a bookkeeping row: the share row
   * must survive to keep refusing a secret already handed to another instance, while the grant
   * presents nothing to anybody, so its absence IS its revocation. Leaving it would keep the
   * shared node's authority standing for every principal from that origin after the owner had
   * decided to cut the pipe.
   *
   * A TOKEN'S ROW FOLLOWS THE SAME RULE (issue #140). Until it did, revoking a principal left
   * its token-materialized rows behind: unexercisable, because `tokenBound` reaches only the
   * credential that holds them and that credential is refused at authentication, but immortal,
   * so `listGrants` and the inspector's authority reading printed every principal a gate run
   * had ever minted and revoked. The choice was RETIRE on revoke — the store deletes the row in
   * the same transaction that marks the token (`revokeTokensWhere`) — over teaching the
   * readers to filter rows whose token is dead. Filtering would have left the rows in the table
   * for every reader to remember to skip, including the evaluator's own hot query, which is the
   * second state `deleteGrant`'s comment refuses for a tombstone; deletion loses no fact,
   * because what was issued is the `tokens` row's account (`caps`, `container_id`,
   * `revoked_at`), and the memo hears about it through `settleRevocation`. A row whose token
   * EXPIRED without being revoked stays until the principal is revoked — the same call marks an
   * expired-but-unrevoked token and retires its row — because expiry is a clock predicate with
   * no write to hang a deletion on, and a second retirement rule in the reader is exactly what
   * this ruling declined.
   */
  revokeShare(shareId: string, actor: AuthContext): number {
    return this.store.transaction(() => {
      const { share, actor: current } = this.shareAdministrator(shareId, actor);
      return this.revokeShareRecord(share, current.principal.id);
    });
  }

  /** Already-authorized share withdrawal, also used for authority delegated by a ticket. */
  private revokeShareRecord(share: ShareRecord, actorId: string): number {
    const at = this.runtime.now();
    if (!this.store.revokeShare(share.id, at)) return 0;
    if (share.grantId !== null) {
      this.store.deleteGrant(share.grantId);
      this.store.afterCommit(() => this.authorityChanged());
    }
    const principals = new Set<string>();
    for (const recipient of this.store.listShareRecipients(share.id)) {
      for (const principalId of this.retireShareRecipientTickets(
        share,
        recipient.guestPrincipal.id,
        at,
        actorId,
      )) {
        principals.add(principalId);
      }
    }
    const severed = principals.size;
    this.store.addEvent(share.containerId, at, actorId, "share_revoked", {
      shareId: share.id,
      origin: share.origin,
      severed,
    });
    this.store.afterCommit(() => {
      for (const listener of [...this.shareRevokedListeners]) listener(share.id);
    });
    return severed;
  }

  /** Every share this instance hands out that the caller is entitled to see. */
  listShares(actor: AuthContext): Share[] {
    return this.store
      .listShares()
      .filter((share) => this.holdsRoot(actor) || share.mintedBy === actor.principal.id)
      .map(toShare);
  }

  /*
    GRANT ADMINISTRATION — the verbs that write and retire rows. The DOOR is `core.access`
    (root-only this wave); what lives here is the mechanism, the same division the mint verbs
    already make. The refusals below are the mechanism's own, kept as the belt to the door's
    braces so a second door onto grants could not be opened without them.
  */

  /**
   * Writes one grant row.
   *
   * ONE refusal beyond the capability check: a deny row that NAMES the owner principal. ADR 0011
   * states no attenuation rule for a DENY row — a deny beats a shallower allow by the deeper-wins
   * rule, so an unrestricted deny is a way to take authority away from somebody who outranks you,
   * escalation by denial — and the door answers most of that by admitting root callers only. The
   * raw owner key is beyond every row by evaluation (`applicableRows`), so this refusal is not
   * what keeps the break-glass path open; it remains the explicit write-time boundary on naming
   * the owner in a deny, which the evaluator does not decide.
   *
   * The refusal is deliberately as NARROW as that: it names the owner principal specifically and
   * nothing else. A CLASS deny — `any-human`, `any-agent` — is admitted, because "any human in
   * this room may read but not write" is one of the four sentences ADR 0011 exists to make
   * sayable, and refusing it to protect the owner would delete the feature to fix the footgun.
   * A class deny bites the owner principal's MINTED bearers like any other human's and withdraws
   * their root class (`holdsRoot`); the owner key alone slides off it, and can always retire it.
   *
   * The node is stored CANONICALLY rather than as the caller spelled it, because the evaluator
   * compares a stored node against a path it formatted itself, and a row under an equivalent
   * but differently-escaped URI is a row no walk can ever find.
   */
  grant(input: CreateGrantRequest, actor: AuthContext): Grant {
    const parsed = CreateGrantRequestSchema.parse(input);
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    if (!this.holdsRoot(actor)) {
      throw new ServiceError("forbidden", "root capability required");
    }
    const path = containmentPath(parsed.node);
    if (path === null) throw new ServiceError("conflict", "node is not addressable");
    if (
      parsed.effect === "deny" &&
      parsed.principal.kind === "principal" &&
      parsed.principal.id === this.ownerPrincipal.id
    ) {
      throw new ServiceError("forbidden", "cannot deny the workspace owner");
    }
    const row: Grant = {
      id: this.runtime.newId(),
      principal: parsed.principal,
      node: path[path.length - 1] ?? MANIFOLD_ROOT_URI,
      caps: [...parsed.caps],
      effect: parsed.effect,
      reach: parsed.reach,
      createdBy: actor.principal.id,
      createdAt: this.runtime.now(),
    };
    this.store.transaction(() => {
      this.store.createGrant(row);
      this.store.addEvent(null, row.createdAt, actor.principal.id, "grant_created", {
        grantId: row.id,
        node: row.node,
        caps: [...row.caps],
      });
    });
    this.authorityChanged();
    return row;
  }

  /**
   * Retires one grant row. `0` is a real answer — "there was nothing left to revoke" — and it
   * must not look like the same success as `1`, exactly as it must not for `revokePrincipal`.
   *
   * A row a TOKEN references is refused, and the refusal is a boundary rather than a
   * limitation: that row IS a credential's issued authority, so deleting it would leave a
   * bearer that authenticates and may then do nothing, with no record of why. Taking a token's
   * authority back has a verb already, and it is the one that also closes the token's live
   * sockets. One door onto "revoke a credential" (docs/CONTRACTS.md §One authoritative implementation).
   */
  revokeGrant(grantId: string, actor: AuthContext): number {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    if (!this.holdsRoot(actor)) {
      throw new ServiceError("forbidden", "root capability required");
    }
    const existing = this.store.getGrant(grantId);
    if (existing === null) return 0;
    if (existing.tokenBound) {
      throw new ServiceError("forbidden", "a token's own grant is revoked by revoking the token");
    }
    if (existing.shareBound) {
      throw new ServiceError("forbidden", "a share's own grant is revoked by revoking the share");
    }
    const at = this.runtime.now();
    const removed = this.store.transaction(() => {
      const gone = this.store.deleteGrant(grantId);
      if (gone) {
        this.store.addEvent(null, at, actor.principal.id, "grant_revoked", {
          grantId,
          node: existing.node,
        });
      }
      return gone;
    });
    if (removed) this.authorityChanged();
    return removed ? 1 : 0;
  }

  /**
   * The rows, as data. Credential ownership metadata is dropped on the way out: it is how
   * the EVALUATOR confines rows, not part of the authority anybody granted, and the
   * published row is ADR 0011's shape exactly.
   */
  listGrants(filter: ListGrantsRequest, actor: AuthContext): Grant[] {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    return this.store
      .listGrants(filter)
      .filter((row) => this.holdsRoot(actor) || row.createdBy === actor.principal.id)
      .map((row) => ({
        id: row.id,
        principal: row.principal,
        node: row.node,
        caps: row.caps,
        effect: row.effect,
        reach: row.reach,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
      }));
  }

  /**
   * Registers the instance-channel fence. Separate from `onRevoked` because a share is not
   * a principal: revoking one closes the CONTROL link authenticated by its secret, while the
   * projections it minted are closed by the principal fence above. Two fences, because there
   * are genuinely two credentials.
   */
  onShareRevoked(listener: (shareId: string) => void): () => void {
    this.shareRevokedListeners.add(listener);
    return () => {
      this.shareRevokedListeners.delete(listener);
    };
  }

  /** Registers a synchronous live-socket fence invoked after durable revocation commits. */
  onRevoked(listener: (principalId: string, containerId: string | null) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }
}
