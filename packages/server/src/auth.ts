import { timingSafeEqual } from "node:crypto";
import {
  BootstrapPrincipalRequestSchema,
  CAPS,
  CreateGrantRequestSchema,
  MANIFOLD_ROOT_URI,
  MintShareRequestSchema,
  MintTokenRequestSchema,
  containmentPath,
  formatManifoldUri,
  normalizeInstanceOrigin,
  type BootstrapPrincipalRequest,
  type Cap,
  type CreateGrantRequest,
  type Grant,
  type GrantPrincipal,
  type ListGrantsRequest,
  type MintShareRequest,
  type MintTokenRequest,
  type Principal,
  type RuntimeDeps,
  type Share,
  type ShareGrant,
  type PrincipalCredentials,
  type PreviewIdentityClaims,
  type TokenGrant,
} from "@manifold/protocol";
import type {
  GrantRecord,
  MachineAuthRecord,
  MachineRecord,
  ServerStore,
  ShareRecord,
  TokenRecord,
  TokenRevocation,
} from "./stores.ts";
import { sha256Hex } from "./stores.ts";

const OWNER_PRINCIPAL_META = "owner_principal_id";
const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"] as const;

/** Every capability a grant's `*` stands for: the wildcard, expanded once. */
const CONCRETE_CAPS: readonly Exclude<Cap, "*">[] = CAPS.filter(
  (cap): cap is Exclude<Cap, "*"> => cap !== "*",
);

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
 *   that fires while somebody is still working therefore trains the one habit invariant 6
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
/** Preview-local browser credentials are renewed through production and bound revocation drift. */
export const PREVIEW_IDENTITY_TOKEN_TTL_MS = 15 * 60 * 1000;

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
type TokenExpiry = "interactive" | "automated" | "preview" | "never";

/**
 * Ordinary principals always receive finite credentials. Machine enrollment and internally
 * generated terminal credentials choose their lifecycle exemptions explicitly at the mint.
 */
function expiryFor(kind: Principal["kind"]): TokenExpiry {
  return kind === "human" ? "interactive" : "automated";
}

/**
 * Principal and attenuated authority computed once when a request/socket authenticates.
 *
 * `caps` and `containerScope` are what the credential's MINTER CHOSE, and the mint ladder
 * keeps reading them. `grantId` is the credential's reference to the grant row the EVALUATOR
 * reads (ADR 0011). A null `grantId` belongs to the owner key alone: it authenticates outside
 * the token system entirely, so it has no row to reference and the evaluator synthesizes its
 * root grant instead of storing one anybody could delete.
 */
export interface AuthContext {
  principal: Principal;
  caps: readonly Cap[];
  containerScope: string | null;
  isRoot: boolean;
  tokenId: string | null;
  grantId: string | null;
  /** Absolute credential expiry; absent for owner, machine, and terminal-lifecycle paths. */
  expiresAt?: number;
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
 * rather than a bare container id (invariant 13) — a grant that named its node any other way
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
 */
function effectiveCapsFrom(
  rows: readonly Grant[],
  path: readonly string[],
  principal: Principal,
): ReadonlySet<Exclude<Cap, "*">> {
  const target = path[path.length - 1];
  const applicable: RankedGrant[] = [];
  for (const row of rows) {
    if (!namesPrincipal(row.principal, principal)) continue;
    const depth = path.indexOf(row.node);
    if (depth === -1) continue;
    if (row.reach === "node" && row.node !== target) continue;
    applicable.push({ row, depth });
  }
  const granted = new Set<Exclude<Cap, "*">>();
  if (applicable.length === 0) return granted;
  for (const cap of CONCRETE_CAPS) {
    let best: RankedGrant | null = null;
    for (const candidate of applicable) {
      const mentions = candidate.row.caps.includes("*") || candidate.row.caps.includes(cap);
      if (!mentions) continue;
      if (best === null || outranks(candidate, best)) best = candidate;
    }
    if (best?.row.effect === "allow") granted.add(cap);
  }
  return granted;
}

/** One credential's memoized verdicts, valid while the grant table has not moved under it. */
interface ContextAuthority {
  readonly epoch: number;
  readonly byNode: Map<string, ReadonlySet<Exclude<Cap, "*">>>;
}

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
  ) {
    const existingId = store.getMeta(OWNER_PRINCIPAL_META);
    const existing = existingId === null ? null : store.getPrincipal(existingId);
    if (existing !== null) {
      this.ownerPrincipal = existing;
      return;
    }

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
        isRoot: true,
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
      throw new ServiceError("forbidden", "expired");
    }
    const principal = this.store.getPrincipal(token.principalId);
    if (principal === null) throw new ServiceError("unauthorized", "invalid bearer token");
    return {
      principal,
      caps: token.caps,
      containerScope: token.containerId,
      isRoot: token.caps.includes("*"),
      tokenId: token.id,
      grantId: token.grantId,
      ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt }),
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
   * thing the workspace must never write down (invariant 6). `window` is on the row so a
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
  allows(context: AuthContext, cap: Exclude<Cap, "*">, containerId?: string): boolean {
    const scope = containerId ?? context.containerScope;
    const node =
      scope === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId: scope });
    return this.effectiveCaps(context, node).has(cap);
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
   */
  effectiveCaps(context: AuthContext, node: string): ReadonlySet<Exclude<Cap, "*">> {
    const cached = this.authorityFor(context);
    const hit = cached.byNode.get(node);
    if (hit !== undefined) return hit;
    const path = containmentPath(node);
    const answer =
      path === null
        ? new Set<Exclude<Cap, "*">>()
        : effectiveCapsFrom(this.applicableRows(context, path), path, context.principal);
    cached.byNode.set(node, answer);
    return answer;
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
   * THE OWNER IS UNDENIABLE, and it is enforced here rather than at the write.
   *
   * `grant` refuses a deny row that NAMES the owner, because an explicit futile write should be
   * refused loudly. But a refusal at the write cannot be the guarantee, because a CLASS row
   * walks around it: the owner is a human, so `any-human deny` would deny the owner at depth
   * without ever naming it — and refusing every human class deny to prevent that would delete
   * "any human in this room may read but not write", which is one of the four sentences ADR 0011
   * exists to make sayable. So class denials are admitted for everybody and dropped for this one
   * subject, which puts the guarantee where it cannot be walked around.
   *
   * That is the same ruling as the synthesized grant below, applied to the other half of the
   * relation: owner authority is a property of the EVALUATOR, not a row that has to win a
   * precedence fight. The owner key authenticates outside the token system so that no
   * administration can lock out its own administrator, and this is that promise made total.
   *
   * The owner key holds no token, so it references no row and the store has none for it. Its
   * root grant is SYNTHESIZED here rather than stored, and that too is a safety property: a
   * stored row is a row `revokeGrant` could delete.
   */
  private applicableRows(context: AuthContext, path: readonly string[]): readonly Grant[] {
    const owner = context.principal.id === this.ownerPrincipal.id;
    const stored = this.store.grantsFor(context.principal, path);
    const mine = stored.filter(
      (row: GrantRecord) =>
        (!row.tokenBound || row.id === context.grantId) && !(owner && row.effect === "deny"),
    );
    /*
      BOTH conditions, and the second one is defence rather than logic. `authenticate` is the
      only producer of an `AuthContext` and it leaves `tokenId` null in the owner-key branch
      alone, so today the two are equivalent — which is exactly why the weaker test is the wrong
      one to write. A future construction site that forgot a token id would inherit the workspace
      root from a check that only asked about the token.
    */
    if (context.tokenId !== null || !owner) return mine;
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
   * channel on one socket — and it already froze the credential's caps and scope at the moment
   * it was created; a live socket whose token is revoked is closed by the revocation fence
   * rather than by re-reading its authority. So memoizing per context adds no staleness that was
   * not already there for exactly as long. What WOULD be new staleness is a grant row written
   * while a socket is open, and the epoch is what refuses it: any grant write bumps the counter
   * and every cached verdict in the process is discarded. A `scenes:write` frame arriving on a
   * hot socket then costs a map lookup, which is what it cost before this ADR landed.
   */
  private authorityFor(context: AuthContext): ContextAuthority {
    const existing = this.authority.get(context);
    if (existing !== undefined && existing.epoch === this.grantsEpoch) return existing;
    const fresh: ContextAuthority = { epoch: this.grantsEpoch, byNode: new Map() };
    this.authority.set(context, fresh);
    return fresh;
  }

  /**
   * Every token revocation settles here. Retiring a token's grant row is a grant write, and
   * the epoch rule admits no exception for the writes revocation makes; the fence and the
   * door keep keying on the TOKEN count, which is the number this hands back.
   */
  private settleRevocation(revocation: TokenRevocation): number {
    if (revocation.grants > 0) this.grantsEpoch += 1;
    return revocation.tokens;
  }

  /** Creates a stable principal with deterministic default color. */
  createPrincipal(input: BootstrapPrincipalRequest): Principal {
    const parsed = BootstrapPrincipalRequestSchema.parse(input);
    const id = this.runtime.newId();
    const principal: Principal = {
      id,
      kind: parsed.kind,
      name: parsed.name,
      color: parsed.color ?? stableColor(id),
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
    caps: readonly Cap[],
    containerId: string | null,
    actorId: string | null,
    expiry: TokenExpiry,
  ): { raw: string; record: TokenRecord } {
    const raw = randomSecret();
    const createdAt = this.runtime.now();
    const tokenId = this.runtime.newId();
    /*
      The bound is computed from the SAME `createdAt` the row carries rather than from a
      second clock read, so a token's life is exactly the declared span and not the span plus
      whatever happened between two calls to `now()`.
    */
    const expiresAt =
      expiry === "never"
        ? null
        : createdAt +
          (expiry === "preview"
            ? PREVIEW_IDENTITY_TOKEN_TTL_MS
            : expiry === "automated"
              ? AUTOMATED_TOKEN_TTL_MS
              : INTERACTIVE_TOKEN_TTL_MS);
    const grant: Grant | null =
      caps.length === 0
        ? null
        : {
            id: this.runtime.newId(),
            principal: { kind: "principal", id: principalId },
            node:
              containerId === null
                ? MANIFOLD_ROOT_URI
                : formatManifoldUri({ kind: "container", containerId }),
            caps: [...caps],
            effect: "allow",
            reach: "subtree",
            createdBy: actorId ?? principalId,
            createdAt,
          };
    const record: TokenRecord = {
      id: tokenId,
      hash: sha256Hex(raw),
      principalId,
      mintedBy: actorId,
      caps: [...caps],
      containerId,
      createdAt,
      revokedAt: null,
      grantId: grant?.id ?? null,
      expiresAt,
    };
    return this.store.transaction(() => {
      if (grant !== null) this.store.createGrant(grant);
      this.store.createToken(record);
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
    if (!actor.isRoot) throw new ServiceError("forbidden", "root capability required");
    const principal = this.createPrincipal(input);
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
    const minted = this.persistToken(principal.id, claims.caps, null, principal.id, "preview");
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

  /** Mints only authority no broader than the minter's caps and optional container scope. */
  mintToken(input: MintTokenRequest, minter: AuthContext): TokenGrant {
    const parsed = MintTokenRequestSchema.parse(input);
    if (!this.allows(minter, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    for (const cap of parsed.caps) {
      if (cap === "*" && !minter.isRoot) {
        throw new ServiceError("forbidden", "only root may mint wildcard authority");
      }
      if (!minter.isRoot && !minter.caps.includes(cap)) {
        throw new ServiceError("forbidden", `cannot mint capability ${cap}`);
      }
    }
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

    let principal: Principal;
    if (parsed.principalId !== undefined) {
      const existing = this.store.getPrincipal(parsed.principalId);
      if (existing === null) throw new ServiceError("not_found", "principal not found");
      principal = existing;
      if (
        !minter.isRoot &&
        existing.id !== minter.principal.id &&
        !this.store.principalMintedBy(existing.id, minter.principal.id)
      ) {
        throw new ServiceError("forbidden", "cannot mint for another principal");
      }
    } else if (parsed.principal !== undefined) {
      principal = this.createPrincipal(parsed.principal);
    } else {
      throw new ServiceError("conflict", "token principal is missing");
    }

    const minted = this.persistToken(
      principal.id,
      parsed.caps,
      containerId,
      minter.principal.id,
      expiryFor(principal.kind),
    );
    return {
      token: minted.raw,
      principal,
      caps: [...parsed.caps],
      containerId,
      ...(minted.record.expiresAt === null ? {} : { expiresAt: minted.record.expiresAt }),
    };
  }

  /**
   * Mints the container-scoped agent identity injected into a newly created terminal.
   *
   * Explicitly terminal-lifecycle-bound, not exempt because the principal is an agent:
   * terminal exit or kill revokes this identity instead of a wall-clock deadline interrupting
   * its PTY. External mints for the same principal still receive the ordinary agent bound.
   */
  mintSessionAgentToken(terminalId: string, containerId: string, actorId: string): TokenGrant {
    const id = this.runtime.newId();
    const principal: Principal = {
      id,
      kind: "agent",
      name: terminalId.slice(0, 64),
      color: stableColor(id),
    };
    this.store.createPrincipal(principal, this.runtime.now());
    const caps: Cap[] = ["containers:read", "scenes:write", "terminals:spawn", "terminals:write"];
    const minted = this.persistToken(principal.id, caps, containerId, actorId, "never");
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
      };
      this.store.createMachine(machine);
      return { machine, machineToken: minted.raw };
    });
  }

  /** Enrolls a machine only for an unscoped principal holding `machines:mint`. */
  enrollMachine(name: string, actor: AuthContext): MachineEnrollment {
    if (!this.allows(actor, "machines:mint") || actor.containerScope !== null) {
      throw new ServiceError("forbidden", "machines:mint capability required");
    }
    return this.persistMachine(name, actor.principal.id);
  }

  /** Enrolls the trusted local daemon as the owner during boot. */
  enrollLocalMachine(name: string): MachineEnrollment {
    return this.persistMachine(name, this.ownerPrincipal.id);
  }

  /**
   * Rotates an existing machine's raw secret: revokes the old token and mints a fresh one.
   * `actorId` attributes the rotation; local-agent boot recovery omits it because that path
   * acts with owner authority by definition.
   */
  rotateMachineToken(machine: MachineRecord, actorId?: string): MachineEnrollment {
    const actor = actorId ?? this.ownerPrincipal.id;
    const result = this.store.transaction(() => {
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
      for (const listener of [...this.revokedListeners]) listener(machine.id, null);
    }
    return result.enrollment;
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
   * credential (invariant 14: one concept, one spelling) — the inventory keeps the row, so an
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
    if (!this.allows(actor, "machines:mint") || actor.containerScope !== null) {
      throw new ServiceError("forbidden", "machines:mint capability required");
    }
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
    if (!this.allows(actor, "machines:mint") || actor.containerScope !== null) {
      throw new ServiceError("forbidden", "machines:mint capability required");
    }
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
   * THE CREDENTIAL LIST (ADR 0019 §3): every principal this caller may administer, when it
   * was created, and the credentials of it that are still alive.
   *
   * AUTHORITY, decided explicitly and recorded here because the ADR leaves it open and it is
   * the one design question in this door. `tokens:mint`, NOT root — and that is a departure
   * from `listGrants`, which ADR 0011 §8 settled as root-only. The two reads are neighbours
   * and are not the same question:
   *
   *   A GRANT ROW is the map of who may do what over this workspace, which is the
   *   reconnaissance a caller performs before deciding whom to impersonate. Root-only.
   *
   *   A CREDENTIAL ROW says an identity exists and holds a live secret. It carries no
   *   authority information a `tokens:mint` holder could not obtain by minting, no secret,
   *   and no hash. Grading it stricter than the WRITE it feeds — `core.access.revoke` is
   *   `tokens:mint` — would publish a revoke door nobody who can open it can aim, which is
   *   how an administrator ends up revoking by guesswork.
   *
   * NARROWED THE WAY THE WRITE IS NARROWED, which is the other half of that argument: a
   * non-root caller sees itself and the principals it minted, which is exactly the set
   * `revokePrincipal` lets it revoke. Root sees everybody, which is what `/api/introspect`
   * already published to root and nothing else. So this door widens the READER of a fact
   * only root could see, without widening what anybody may do about it.
   */
  listCredentials(actor: AuthContext): PrincipalCredentials[] {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const now = this.runtime.now();
    const rows: PrincipalCredentials[] = [];
    for (const { principal, createdAt } of this.store.listPrincipalsWithCreation()) {
      const mine =
        actor.isRoot ||
        principal.id === actor.principal.id ||
        this.store.principalMintedBy(principal.id, actor.principal.id);
      if (!mine) continue;
      const sessions = this.store
        .listTokensByPrincipal(principal.id)
        /*
          LIVE means "would authenticate right now", which is `authenticate`'s two refusals
          read as a predicate. Stating it here rather than in the store is deliberate: the
          rule belongs beside the function that enforces it, so a third answer cannot appear
          in a query somebody writes later.
        */
        .filter((token) => token.revokedAt === null && (token.expiresAt ?? Infinity) > now)
        .map((token) => ({
          id: token.id,
          createdAt: token.createdAt,
          caps: [...token.caps],
          ...(token.mintedBy === null ? {} : { mintedBy: token.mintedBy }),
          ...(token.containerId === null ? {} : { containerId: token.containerId }),
          ...(token.expiresAt === null ? {} : { expiresAt: token.expiresAt }),
        }));
      rows.push({ principal, createdAt, sessions });
    }
    return rows;
  }

  /** Revokes a server-issued short-lived identity after a failed terminal create. */
  revokeIssuedPrincipal(principalId: string, actorId: string): number {
    const at = this.runtime.now();
    const count = this.settleRevocation(this.store.revokeTokensByPrincipal(principalId, at));
    this.store.addEvent(null, at, actorId, "token_revoked", {
      subjectPrincipalId: principalId,
      count,
    });
    if (count > 0) {
      for (const listener of [...this.revokedListeners]) listener(principalId, null);
    }
    return count;
  }

  /** Revokes only identities the actor created (or itself), without widening container scope. */
  revokePrincipal(principalId: string, actor: AuthContext): number {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    if (
      !actor.isRoot &&
      principalId !== actor.principal.id &&
      !this.store.principalMintedBy(principalId, actor.principal.id)
    ) {
      throw new ServiceError("forbidden", "cannot revoke another principal");
    }
    if (actor.isRoot) return this.revokeIssuedPrincipal(principalId, actor.principal.id);

    const containerId = actor.containerScope;
    const at = this.runtime.now();
    const count = this.settleRevocation(
      containerId === null
        ? this.store.revokeTokensByPrincipal(principalId, at)
        : this.store.revokeTokensByPrincipal(principalId, at, containerId),
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

  /** Authenticates a share secret. Never a principal bearer: a share names a pipe, not a self. */
  authenticateShare(raw: string): ShareRecord {
    const share = this.store.getShareByHash(sha256Hex(raw));
    if (share === null) throw new ServiceError("unauthorized", "invalid share token");
    if (share.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    return share;
  }

  /**
   * Mints a share for one container, addressed to one guest origin.
   *
   * The origin is recorded HERE, at mint time, rather than believed later at the handshake.
   * That is what makes a principal's `origin` trustworthy data instead of a claim, and
   * invariant 11 depends on the difference: nothing downstream of arbitration may branch on
   * origin, which is only safe while origin is something this instance decided.
   *
   * A share's caps also become a GRANT ROW at the shared node (ADR 0011: "a share is a token
   * minted against a subtree grant at the shared node"), and the row names the guest INSTANCE
   * rather than any one of its principals. That is the one place ADR 0011's federation form
   * stops being reserved: a ticket's host-side principal carries the share's origin, so it
   * inherits the share's authority through the class match and the host mints no row per guest.
   * The ticket's own token still gets its own row through `persistToken`, which is what makes
   * ticket attenuation ordinary grant subsetting rather than a cross-instance special case.
   */
  mintShare(input: MintShareRequest, minter: AuthContext): ShareGrant {
    const parsed = MintShareRequestSchema.parse(input);
    if (parsed.node.kind !== "container") {
      throw new ServiceError("conflict", "only a container can be shared");
    }
    if (!this.allows(minter, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    for (const cap of parsed.caps) {
      if (cap === "*") {
        throw new ServiceError("forbidden", "wildcard authority cannot be container-scoped");
      }
      if (!minter.isRoot && !minter.caps.includes(cap)) {
        throw new ServiceError("forbidden", `cannot mint capability ${cap}`);
      }
    }
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
      this.store.addEvent(containerId, record.createdAt, minter.principal.id, "share_minted", {
        shareId: record.id,
        origin,
        caps: [...parsed.caps],
      });
    });
    // A new row can change what a live socket may do, so no cached verdict outlives it.
    this.grantsEpoch += 1;
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
  mintShareTicket(share: ShareRecord, guest: Principal): TokenGrant {
    if (share.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    const candidateId = this.runtime.newId();
    const principalId = this.store.claimShareTicket(
      share.id,
      guest.id,
      candidateId,
      this.runtime.now(),
    );
    let principal = this.store.getPrincipal(principalId);
    if (principal === null) {
      principal = {
        id: principalId,
        kind: guest.kind,
        name: guest.name,
        color: guest.color,
        origin: share.origin,
      };
      this.store.createPrincipal(principal, this.runtime.now());
    }
    /*
      A ticket is an ORDINARY credential: human guests receive the interactive bound and
      agent guests receive the automated bound. Federation is not an expiry exemption.
    */
    const minted = this.persistToken(
      principal.id,
      share.caps,
      share.containerId,
      share.mintedBy,
      expiryFor(principal.kind),
    );
    return {
      token: minted.raw,
      principal,
      caps: [...share.caps],
      containerId: share.containerId,
      ...(minted.record.expiresAt === null ? {} : { expiresAt: minted.record.expiresAt }),
    };
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
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const share = this.store.getShare(shareId);
    if (share === null) throw new ServiceError("not_found", "share not found");
    if (!actor.isRoot && share.mintedBy !== actor.principal.id) {
      throw new ServiceError("forbidden", "cannot revoke another principal's share");
    }
    const at = this.runtime.now();
    const principals = this.store.transaction(() => {
      this.store.revokeShare(shareId, at);
      if (share.grantId !== null) this.store.deleteGrant(share.grantId);
      return this.store.shareTicketPrincipals(shareId);
    });
    if (share.grantId !== null) this.grantsEpoch += 1;
    let severed = 0;
    for (const principalId of principals) {
      const count = this.settleRevocation(this.store.revokeTokensByPrincipal(principalId, at));
      if (count === 0) continue;
      severed += 1;
      for (const listener of [...this.revokedListeners]) listener(principalId, null);
    }
    this.store.addEvent(share.containerId, at, actor.principal.id, "share_revoked", {
      shareId,
      origin: share.origin,
      severed,
    });
    for (const listener of [...this.shareRevokedListeners]) listener(shareId);
    return severed;
  }

  /** Every share this instance hands out that the caller is entitled to see. */
  listShares(actor: AuthContext): Share[] {
    return this.store
      .listShares()
      .filter((share) => actor.isRoot || share.mintedBy === actor.principal.id)
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
   * ONE refusal beyond the capability check, and it exists because ADR 0011 states no
   * attenuation rule for a DENY row. A deny beats a shallower allow by the deeper-wins rule, so
   * an unrestricted deny is a way to take authority away from somebody who outranks you —
   * escalation by denial. The door answers most of that by admitting root callers only; what
   * this answers is the residue the door cannot, which is a bootstrapped `*` token naming the
   * OWNER in a deny row. The owner key authenticates outside the token system precisely so that
   * no administration can lock it out of its own workspace, and there would be no credential
   * left able to write the row that undid it.
   *
   * The refusal is deliberately as NARROW as that: it names the owner principal specifically and
   * nothing else. A CLASS deny — `any-human`, `any-agent` — is admitted, because "any human in
   * this room may read but not write" is one of the four sentences ADR 0011 exists to make
   * sayable, and refusing it to protect the owner would delete the feature to fix the footgun.
   * The owner survives a class deny by the precedence relation itself: a principal-specific
   * allow outranks a class row at the same node (specificity above effect, rule 2 above rule 3),
   * so the recovery is a row the owner can always write. Always, and that word is checkable —
   * `grant` asks for `tokens:mint` at the owner's own anchor, which is the workspace root, where
   * the owner's synthesized `*` allow carries the maximum depth-and-specificity a row can have
   * and the only thing that could outrank it is the deny this method refuses.
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
    this.grantsEpoch += 1;
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
   * sockets. One door onto "revoke a credential" (invariant 14).
   */
  revokeGrant(grantId: string, actor: AuthContext): number {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    const existing = this.store.getGrant(grantId);
    if (existing === null) return 0;
    if (existing.tokenBound) {
      throw new ServiceError("forbidden", "a token's own grant is revoked by revoking the token");
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
    if (removed) this.grantsEpoch += 1;
    return removed ? 1 : 0;
  }

  /**
   * The rows, as data. `tokenBound` is dropped on the way out: it is how the EVALUATOR decides
   * which credential a row reaches, not a field of the authority anybody granted, and the
   * published row is ADR 0011's shape exactly.
   */
  listGrants(filter: ListGrantsRequest, actor: AuthContext): Grant[] {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    return this.store.listGrants(filter).map((row) => ({
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
