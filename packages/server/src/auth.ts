import { timingSafeEqual } from "node:crypto";
import {
  BootstrapPrincipalRequestSchema,
  MintTokenRequestSchema,
  hasCap,
  type BootstrapPrincipalRequest,
  type Cap,
  type MintTokenRequest,
  type Principal,
  type RuntimeDeps,
  type TokenGrant,
} from "@manifold/protocol";
import type { MachineAuthRecord, MachineRecord, ServerStore, TokenRecord } from "./stores.ts";
import { sha256Hex } from "./stores.ts";

const OWNER_PRINCIPAL_META = "owner_principal_id";
const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777"] as const;

/** Principal and attenuated authority computed once when a request/socket authenticates. */
export interface AuthContext {
  principal: Principal;
  caps: readonly Cap[];
  padScope: string | null;
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

/** Owns owner bootstrap, bearer hashing, attenuation, enrollment, and revocation fanout. */
export class AuthService {
  readonly ownerPrincipal: Principal;
  private readonly revokedListeners = new Set<(principalId: string) => void>();

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
        padScope: null,
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
      padScope: token.padId,
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

  /** Checks a capability and, when supplied, enforces the token's pad scope. */
  allows(context: AuthContext, cap: Exclude<Cap, "*">, padId?: string): boolean {
    if (!hasCap(context.caps, cap)) return false;
    if (padId !== undefined && context.padScope !== null && context.padScope !== padId)
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
    padId: string | null,
    actorId: string | null,
  ): { raw: string; record: TokenRecord } {
    const raw = randomSecret();
    const record: TokenRecord = {
      id: this.runtime.newId(),
      hash: sha256Hex(raw),
      principalId,
      caps: [...caps],
      padId,
      createdAt: this.runtime.now(),
      revokedAt: null,
    };
    this.store.createToken(record);
    this.store.addEvent(padId, this.runtime.now(), actorId, "token_minted", {
      tokenId: record.id,
      subjectPrincipalId: principalId,
      caps: [...caps],
      padId,
    });
    return { raw, record };
  }

  /** Bootstraps a principal with a root token; callers must already enforce root authority. */
  bootstrapPrincipal(input: BootstrapPrincipalRequest, actor: AuthContext): TokenGrant {
    if (!actor.isRoot) throw new ServiceError("forbidden", "root capability required");
    const principal = this.createPrincipal(input);
    const minted = this.persistToken(principal.id, ["*"], null, actor.principal.id);
    return { token: minted.raw, principal, caps: ["*"], padId: null };
  }

  /** Mints only authority no broader than the minter's caps and optional pad scope. */
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
      minter.padScope !== null &&
      parsed.padId !== undefined &&
      parsed.padId !== minter.padScope
    ) {
      throw new ServiceError("forbidden", "cannot widen pad scope");
    }
    const padId = minter.padScope ?? parsed.padId ?? null;
    if (padId !== null && parsed.caps.includes("*")) {
      throw new ServiceError("forbidden", "wildcard authority cannot be pad-scoped");
    }
    if (padId !== null && this.store.getPad(padId) === null) {
      throw new ServiceError("not_found", "pad not found");
    }

    let principal: Principal;
    if (parsed.principalId !== undefined) {
      const existing = this.store.getPrincipal(parsed.principalId);
      if (existing === null) throw new ServiceError("not_found", "principal not found");
      principal = existing;
    } else if (parsed.principal !== undefined) {
      principal = this.createPrincipal(parsed.principal);
    } else {
      throw new ServiceError("conflict", "token principal is missing");
    }

    const minted = this.persistToken(principal.id, parsed.caps, padId, minter.principal.id);
    return { token: minted.raw, principal, caps: [...parsed.caps], padId };
  }

  /** Mints the pad-scoped agent identity injected into a newly created terminal. */
  mintSessionAgentToken(sessionId: string, padId: string, actorId: string): TokenGrant {
    const id = this.runtime.newId();
    const principal: Principal = {
      id,
      kind: "agent",
      name: sessionId.slice(0, 64),
      color: stableColor(id),
    };
    this.store.createPrincipal(principal, this.runtime.now());
    const caps: Cap[] = ["pads:read", "scene:write", "terminal:spawn", "terminal:write"];
    const minted = this.persistToken(principal.id, caps, padId, actorId);
    return { token: minted.raw, principal, caps, padId };
  }

  private persistMachine(name: string, actorId: string): MachineEnrollment {
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
  }

  /** Enrolls a machine only for an unscoped principal holding `machines:mint`. */
  enrollMachine(name: string, actor: AuthContext): MachineEnrollment {
    if (!this.allows(actor, "machines:mint") || actor.padScope !== null) {
      throw new ServiceError("forbidden", "machines:mint capability required");
    }
    return this.persistMachine(name, actor.principal.id);
  }

  /** Enrolls the trusted local daemon as the owner during boot. */
  enrollLocalMachine(name: string): MachineEnrollment {
    return this.persistMachine(name, this.ownerPrincipal.id);
  }

  /** Rotates an existing machine's unavailable raw secret for local-agent recovery. */
  rotateMachineToken(machine: MachineRecord): MachineEnrollment {
    const at = this.runtime.now();
    if (this.store.revokeToken(machine.tokenId, at)) {
      this.store.addEvent(null, at, this.ownerPrincipal.id, "token_revoked", {
        subjectPrincipalId: machine.id,
        count: 1,
      });
      for (const listener of [...this.revokedListeners]) listener(machine.id);
    }
    const minted = this.persistToken(machine.id, [], null, this.ownerPrincipal.id);
    const lastSeen = this.runtime.now();
    this.store.updateMachineToken(machine.id, minted.record.id, lastSeen);
    return {
      machine: { ...machine, tokenId: minted.record.id, lastSeen },
      machineToken: minted.raw,
    };
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
      for (const listener of [...this.revokedListeners]) listener(principalId);
    }
    return count;
  }

  /** Revokes every token for a principal and synchronously fences its live sockets. */
  revokePrincipal(principalId: string, actor: AuthContext): number {
    if (!this.allows(actor, "tokens:mint")) {
      throw new ServiceError("forbidden", "tokens:mint capability required");
    }
    return this.revokeIssuedPrincipal(principalId, actor.principal.id);
  }

  /** Registers a synchronous live-socket fence invoked after durable revocation commits. */
  onRevoked(listener: (principalId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }
}
