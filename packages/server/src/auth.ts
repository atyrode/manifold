import { timingSafeEqual } from "node:crypto";
import {
  BootstrapPrincipalRequestSchema,
  MintShareRequestSchema,
  MintTokenRequestSchema,
  hasCap,
  normalizeInstanceOrigin,
  type BootstrapPrincipalRequest,
  type Cap,
  type MintShareRequest,
  type MintTokenRequest,
  type Principal,
  type RuntimeDeps,
  type Share,
  type ShareGrant,
  type TokenGrant,
} from "@manifold/protocol";
import type {
  MachineAuthRecord,
  MachineRecord,
  ServerStore,
  ShareRecord,
  TokenRecord,
} from "./stores.ts";
import { sha256Hex } from "./stores.ts";

const OWNER_PRINCIPAL_META = "owner_principal_id";
const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"] as const;

/** Principal and attenuated authority computed once when a request/socket authenticates. */
export interface AuthContext {
  principal: Principal;
  caps: readonly Cap[];
  containerScope: string | null;
  isRoot: boolean;
  tokenId: string | null;
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

/** Owns owner bootstrap, bearer hashing, attenuation, enrollment, and revocation fanout. */
export class AuthService {
  readonly ownerPrincipal: Principal;
  private readonly revokedListeners = new Set<
    (principalId: string, containerId: string | null) => void
  >();
  private readonly shareRevokedListeners = new Set<(shareId: string) => void>();

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

  /** Authenticates an owner key or hashed bearer token and rejects durable revocations. */
  authenticate(raw: string): AuthContext {
    if (secretsEqual(raw, this.ownerKey)) {
      return {
        principal: this.ownerPrincipal,
        caps: ["*"],
        containerScope: null,
        isRoot: true,
        tokenId: null,
      };
    }

    const token = this.store.getTokenByHash(sha256Hex(raw));
    if (token === null) throw new ServiceError("unauthorized", "invalid bearer token");
    if (token.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    const principal = this.store.getPrincipal(token.principalId);
    if (principal === null) throw new ServiceError("unauthorized", "invalid bearer token");
    return {
      principal,
      caps: token.caps,
      containerScope: token.containerId,
      isRoot: token.caps.includes("*"),
      tokenId: token.id,
    };
  }

  /** Authenticates a machine secret without interpreting it as a principal bearer. */
  authenticateMachine(raw: string): MachineAuthRecord {
    const machine = this.store.authenticateMachine(sha256Hex(raw));
    if (machine === null) throw new ServiceError("unauthorized", "invalid machine token");
    if (machine.revokedAt !== null) throw new ServiceError("forbidden", "revoked");
    return machine;
  }

  /**
   * Checks a capability and, when supplied, enforces the token's container scope.
   *
   * THE AUTHORITY SEAM. This one call is where the permission waterfall lands (ADR 0011):
   * flat caps plus an optional container scope are the degenerate case of grants on the node
   * tree, so the evaluator replaces this body and every caller — including the action door's
   * declared-cap intersection — keeps asking the same question.
   */
  allows(context: AuthContext, cap: Exclude<Cap, "*">, containerId?: string): boolean {
    if (!hasCap(context.caps, cap)) return false;
    if (
      containerId !== undefined &&
      context.containerScope !== null &&
      context.containerScope !== containerId
    )
      return false;
    return true;
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

  private persistToken(
    principalId: string,
    caps: readonly Cap[],
    containerId: string | null,
    actorId: string | null,
  ): { raw: string; record: TokenRecord } {
    const raw = randomSecret();
    const record: TokenRecord = {
      id: this.runtime.newId(),
      hash: sha256Hex(raw),
      principalId,
      mintedBy: actorId,
      caps: [...caps],
      containerId,
      createdAt: this.runtime.now(),
      revokedAt: null,
    };
    return this.store.transaction(() => {
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

  /** Bootstraps a principal with a root token; callers must already enforce root authority. */
  bootstrapPrincipal(input: BootstrapPrincipalRequest, actor: AuthContext): TokenGrant {
    if (!actor.isRoot) throw new ServiceError("forbidden", "root capability required");
    const principal = this.createPrincipal(input);
    const minted = this.persistToken(principal.id, ["*"], null, actor.principal.id);
    return { token: minted.raw, principal, caps: ["*"], containerId: null };
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

    const minted = this.persistToken(principal.id, parsed.caps, containerId, minter.principal.id);
    return { token: minted.raw, principal, caps: [...parsed.caps], containerId };
  }

  /** Mints the container-scoped agent identity injected into a newly created terminal. */
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
    const minted = this.persistToken(principal.id, caps, containerId, actorId);
    return { token: minted.raw, principal, caps, containerId };
  }

  private persistMachine(name: string, actorId: string): MachineEnrollment {
    return this.store.transaction(() => {
      const machineId = this.runtime.newId();
      const minted = this.persistToken(machineId, [], null, actorId);
      const machine: MachineRecord = {
        id: machineId,
        name,
        tokenId: minted.record.id,
        lastSeen: this.runtime.now(),
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
      if (revoked) {
        this.store.addEvent(null, at, actor, "token_revoked", {
          subjectPrincipalId: machine.id,
          count: 1,
        });
      }
      const minted = this.persistToken(machine.id, [], null, actor);
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
    if (result.revoked) {
      for (const listener of [...this.revokedListeners]) listener(machine.id, null);
    }
    return result.enrollment;
  }

  /** Revokes a server-issued short-lived identity after a failed terminal create. */
  revokeIssuedPrincipal(principalId: string, actorId: string): number {
    const at = this.runtime.now();
    const count = this.store.revokeTokensByPrincipal(principalId, at);
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
    const count =
      containerId === null
        ? this.store.revokeTokensByPrincipal(principalId, at)
        : this.store.revokeTokensByPrincipal(principalId, at, containerId);
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
   * Mints a grant for one container, addressed to one guest origin.
   *
   * The origin is recorded HERE, at mint time, rather than believed later at the handshake.
   * That is what makes a principal's `origin` trustworthy data instead of a claim, and
   * invariant 11 depends on the difference: nothing downstream of arbitration may branch on
   * origin, which is only safe while origin is something this instance decided.
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
    const record: Omit<ShareRecord, "tickets"> = {
      id: this.runtime.newId(),
      hash: sha256Hex(raw),
      containerId,
      caps: [...parsed.caps],
      origin,
      mintedBy: minter.principal.id,
      createdAt: this.runtime.now(),
      revokedAt: null,
    };
    this.store.transaction(() => {
      this.store.createShare(record);
      this.store.addEvent(containerId, record.createdAt, minter.principal.id, "share_minted", {
        shareId: record.id,
        origin,
        caps: [...parsed.caps],
      });
    });
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
    const minted = this.persistToken(principal.id, share.caps, share.containerId, share.mintedBy);
    return {
      token: minted.raw,
      principal,
      caps: [...share.caps],
      containerId: share.containerId,
    };
  }

  /**
   * Cuts the pipe. The share row is marked revoked durably FIRST — so a restart cannot
   * resurrect it — and only then is every identity it minted revoked through the ordinary
   * fence, which is what closes the guest's live session sockets. The count answers how
   * many identities were severed; zero is a success, exactly as it is for `revokePrincipal`.
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
      return this.store.shareTicketPrincipals(shareId);
    });
    let severed = 0;
    for (const principalId of principals) {
      const count = this.store.revokeTokensByPrincipal(principalId, at);
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
