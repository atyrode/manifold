import { randomUUID } from "node:crypto";
import type { PluginReferenceContext } from "@manifold/plugin";
import {
  canonicalJobJson,
  formatManifoldUri,
  parseManifoldUri,
  ReferencePrepareRequestSchema,
  ReferenceAttachmentRequestSchema,
  PluginOwnedRefKindSchema,
  type ReferenceProbeRequest,
  type ReferenceProbeResult,
  ReferenceReceiptRequestSchema,
  ReferenceReadFilterRequestSchema,
  ReferencePublishRequestSchema,
  ReferenceAbortRequestSchema,
  ReferenceRequirePublishedRequestSchema,
  ReferenceUnpublishRequestSchema,
  ReferenceGrantRequestSchema,
  ReferenceRevokeRequestSchema,
  ReferenceAudienceRequestSchema,
  type OwnedReferenceDeclaration,
  type PluginCap,
  type PluginOwnedRef,
  type PluginOwnedRefKind,
  type PublishedReferenceIdentity,
  type ReferenceTerminalReceipt,
  type RestrictedGrantView,
  type RuntimeDeps,
} from "@manifold/protocol";
import {
  ServiceError,
  type AuthContext,
  type AuthService,
  type CredentialReference,
} from "./auth.ts";
import { sha256Hex, type ServerStore } from "./stores.ts";

const MAX_RECORDS = 1_000;
// Admission headroom only; the measured post-write inventory below is the commit authority.
const MUTATION_RESERVATION_BYTES = 128 * 1024;
const PREPARATION_LIFETIME_MS = 15 * 60_000;
const RECEIPT_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const ACK_RETRY_MS = 1_000;
const ACK_BATCH_SIZE = 4;

interface Publication {
  publication_id: string;
  node: string;
  owner_plugin: string;
  preparation_id: string;
  request_id: string;
  actor_principal: string;
  credential_json: string;
  credential_binding: string;
  binding_digest: string;
  policy_digest: string;
  owner_generation: string;
  ready_digest: string | null;
  state: "prepared" | "published" | "aborted" | "deleted" | "quarantined";
  created_at: number;
  expires_at: number;
  terminal_at: number | null;
  terminal_actor: string | null;
  terminal_credential_binding: string | null;
  trace_id: number;
  // For published rows cleanup_pending means the private owner has not acknowledged publication.
  cleanup_pending: number;
}

/** One live definition identity; publication receipts intentionally do not bind process identity. */
export interface ReferenceOwner {
  readonly pluginId: string;
  readonly declaration: OwnedReferenceDeclaration;
  readonly generation: object;
  readonly generationDigest: string;
  probe(input: ReferenceProbeRequest): Promise<ReferenceProbeResult>;
  /** Maintenance must decline rather than interrupt an ordinary guest's effect scope. */
  probeWhenIdle(input: ReferenceProbeRequest): Promise<ReferenceProbeResult>;
  reclaim(receipts: readonly ReferenceTerminalReceipt[]): Promise<void>;
}

export interface ReferenceActionAuthority {
  readonly pluginId: string;
  readonly actor: AuthContext;
  readonly traceId: number;
  /** Checks active dispatch + exact currently declared/admitted cap/ref. No caller-selected ceiling. */
  check(cap: PluginCap, ref: PluginOwnedRef | { kind: "plugin"; pluginId: string }): void;
  /** Checks the owner's exact declared, capability-free terminal-receipt action. */
  checkReceipt(ref: PluginOwnedRef): void;
  /** Checks the exact declared read-filter door and its current installation read ceiling. */
  checkReadable(kind: PluginOwnedRefKind): void;
}

export class ReferenceRefused extends ServiceError {
  constructor(reason = "reference_unavailable") {
    super(reason === "reference_unavailable" ? "forbidden" : "conflict", reason);
    this.name = "ReferenceRefused";
  }
}

/** Lifecycle gate plus ordinary grants. This is not an alternative evaluator or plugin ACL. */
export class ReferenceService {
  private readonly reclaiming = new Set<string>();
  private expiryTimer: NodeJS.Timeout | undefined;
  private expiryDeadline: number | null = null;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recovering = false;
  private recoveryCursor = "";
  private closed = false;

  constructor(
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly runtime: RuntimeDeps,
    private readonly owner: (kind: PluginOwnedRefKind) => ReferenceOwner | null,
    private readonly capacity: (additionalBytes: number) => void,
    private readonly cleanupFailure: (pluginId: string) => void,
  ) {}

  /** Restart never finishes somebody's previous dispatch or re-creates an administrator-revoked row. */
  restart(): void {
    clearTimeout(this.expiryTimer);
    this.expiryDeadline = null;
    this.store.transaction(() => {
      this.store.db
        .query(
          `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
        terminal_actor=actor_principal,terminal_credential_binding=credential_binding
        WHERE state='prepared'`,
        )
        .run(this.runtime.now());
      // Revalidate retained publications too, including receipts written before acknowledgement
      // bookkeeping existed. A temporarily absent owner must remain live-recoverable after boot.
      this.store.db
        .query("UPDATE reference_publications SET cleanup_pending=1 WHERE state='published'")
        .run();
      for (const kind of this.store.referenceKindOwners().keys()) {
        this.store.db
          .query("UPDATE reference_kind_owners SET allocation_state=? WHERE kind=?")
          .run(JSON.stringify({ incarnation: randomUUID(), counter: 0 }), kind);
      }
    });
    this.scheduleRecovery();
  }

  private scheduleRecovery(): void {
    if (this.closed || this.recoveryTimer !== undefined || this.recovering) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.recoverAcknowledgements();
    }, ACK_RETRY_MS);
    this.recoveryTimer.unref();
  }

  /** Durable, fair, bounded maintenance; no caller identity or publication replay is involved. */
  private async recoverAcknowledgements(): Promise<void> {
    if (this.closed || this.recovering) return;
    let pending = true;
    this.recovering = true;
    try {
      let rows = this.store.db
        .query<Publication, [string, number]>(
          `SELECT * FROM reference_publications WHERE state='published' AND cleanup_pending=1
         AND publication_id>? ORDER BY publication_id LIMIT ?`,
        )
        .all(this.recoveryCursor, ACK_BATCH_SIZE);
      if (rows.length === 0) {
        this.recoveryCursor = "";
        rows = this.store.db
          .query<Publication, [number]>(
            `SELECT * FROM reference_publications WHERE state='published' AND cleanup_pending=1
           ORDER BY publication_id LIMIT ?`,
          )
          .all(ACK_BATCH_SIZE);
      }
      pending = rows.length !== 0;
      for (const row of rows) {
        if (this.closed) return;
        this.recoveryCursor = row.publication_id;
        const owner = this.owner(this.ref(row).kind);
        if (owner !== null && owner.pluginId === row.owner_plugin)
          await this.acknowledgePublication(row, owner, true);
      }
    } catch {
      for (const pluginId of new Set(this.store.referenceKindOwners().values()))
        this.cleanupFailure(pluginId);
    } finally {
      this.recovering = false;
      if (pending) this.scheduleRecovery();
    }
  }

  private async acknowledgePublication(
    row: Publication,
    owner: ReferenceOwner,
    idle = false,
  ): Promise<void> {
    try {
      this.sameOwner(owner);
      const proof = await (idle
        ? owner.probeWhenIdle(this.probeRequest(row))
        : owner.probe(this.probeRequest(row)));
      this.sameOwner(owner);
      const current = this.preparation(row.preparation_id);
      if (current?.state !== "published" || current.publication_id !== row.publication_id) return;
      if (
        current.policy_digest !== this.policy(owner) ||
        proof === null ||
        proof.preparationId !== row.preparation_id ||
        proof.readyDigest !== row.ready_digest
      ) {
        this.quarantine(current);
        return;
      }
      this.store.db
        .query(
          `UPDATE reference_publications SET cleanup_pending=0
        WHERE publication_id=? AND state='published' AND ready_digest=?`,
        )
        .run(row.publication_id, row.ready_digest);
    } catch {
      // Publication already committed. Only the durable owner acknowledgement remains pending.
      this.cleanupFailure(owner.pluginId);
    }
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.expiryTimer);
    clearTimeout(this.recoveryTimer);
  }

  private scheduleExpiry(deadline: number, pluginId: string): void {
    if (this.closed || (this.expiryDeadline !== null && this.expiryDeadline <= deadline)) return;
    clearTimeout(this.expiryTimer);
    this.expiryDeadline = deadline;
    this.expiryTimer = setTimeout(
      () => {
        this.expiryDeadline = null;
        if (this.closed) return;
        try {
          this.store.transaction(() => this.expire());
          const next = this.store.db
            .query<{ expires_at: number; owner_plugin: string }, []>(
              "SELECT expires_at,owner_plugin FROM reference_publications WHERE state='prepared' ORDER BY expires_at LIMIT 1",
            )
            .get();
          if (next !== null) this.scheduleExpiry(next.expires_at, next.owner_plugin);
          void this.reclaim(pluginId);
        } catch {
          this.cleanupFailure(pluginId);
          // A busy/full image may refuse teardown. It remains unavailable until cleanup commits.
          this.scheduleExpiry(this.runtime.now() + 60_000, pluginId);
        }
      },
      Math.max(1, deadline - this.runtime.now()),
    );
    this.expiryTimer.unref();
  }

  /** Disabling destroys only unpublished intents; retained published nodes keep their grants. */
  abortOwnerPreparations(pluginId: string): void {
    this.store.db
      .query(
        `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
      terminal_actor=actor_principal,terminal_credential_binding=credential_binding
      WHERE owner_plugin=? AND state='prepared'`,
      )
      .run(this.runtime.now(), pluginId);
  }

  /** The maintenance owner has removed the entire private image after committing host deletion. */
  purged(pluginId: string): void {
    this.store.db
      .query(
        `UPDATE reference_publications SET cleanup_pending=0
      WHERE owner_plugin=? AND state IN ('aborted','deleted')`,
      )
      .run(pluginId);
  }

  private unavailable(): never {
    throw new ReferenceRefused();
  }

  private row(ref: PluginOwnedRef): Publication | null {
    return this.store.db
      .query<Publication, [string]>("SELECT * FROM reference_publications WHERE node=?")
      .get(formatManifoldUri(ref));
  }

  private preparation(id: string): Publication | null {
    return this.store.db
      .query<Publication, [string]>("SELECT * FROM reference_publications WHERE preparation_id=?")
      .get(id);
  }

  private ref(row: Publication): PluginOwnedRef {
    const ref = parseManifoldUri(row.node);
    if (ref === null || ref.kind !== "file") return this.unavailable();
    return ref;
  }

  private probeRequest(row: Publication): ReferenceProbeRequest {
    if (row.state !== "prepared" && row.state !== "published") return this.unavailable();
    return {
      ref: this.ref(row),
      preparationId: row.preparation_id,
      requestId: row.request_id,
      bindingDigest: row.binding_digest,
      publication: row.state,
    };
  }

  /** Host-side admission maintenance must precede an owner's private reservation check. */
  async reclaimExpiredPreparations(kind: PluginOwnedRefKind, pluginId: string): Promise<void> {
    await this.expireOwnerPreparations(this.liveOwner(kind, pluginId));
  }

  private async expireOwnerPreparations(owner: ReferenceOwner): Promise<void> {
    const rows = this.store.db
      .query<Publication, [string]>(
        "SELECT * FROM reference_publications WHERE owner_plugin=? AND state='prepared' ORDER BY created_at LIMIT 4",
      )
      .all(owner.pluginId);
    for (const row of rows) {
      const startedAt = this.runtime.now();
      const proof = await owner.probe(this.probeRequest(row));
      this.sameOwner(owner);
      // A deadline that elapsed only while the probe was in flight may have been refreshed
      // by accepted progress after its snapshot. Retire only already-expired preparations.
      if (
        proof === null ||
        proof.preparationId !== row.preparation_id ||
        Math.min(row.expires_at, proof.expiresAt) > startedAt
      )
        continue;
      this.store.transaction(() => {
        this.sameOwner(owner);
        this.store.db
          .query(
            `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
          terminal_actor=actor_principal,terminal_credential_binding=credential_binding
          WHERE publication_id=? AND owner_plugin=? AND preparation_id=? AND state='prepared'`,
          )
          .run(this.runtime.now(), row.publication_id, owner.pluginId, row.preparation_id);
      });
    }
    await this.reclaim(owner.pluginId);
  }

  private policy(owner: ReferenceOwner): string {
    return sha256Hex(canonicalJobJson(owner.declaration));
  }

  private current(actor: AuthContext): AuthContext {
    const current = this.auth.restoreCredential(this.auth.credentialReference(actor));
    if (current === null) return this.unavailable();
    return current;
  }

  private liveOwner(kind: PluginOwnedRefKind, pluginId?: string): ReferenceOwner {
    if (this.closed) return this.unavailable();
    const owner = this.owner(kind);
    if (owner === null || (pluginId !== undefined && owner.pluginId !== pluginId))
      return this.unavailable();
    if (this.store.referenceKindOwners().get(kind) !== owner.pluginId) return this.unavailable();
    return owner;
  }

  private sameOwner(owner: ReferenceOwner): void {
    const current = this.liveOwner(owner.declaration.kind, owner.pluginId);
    if (current.generation !== owner.generation || this.policy(current) !== this.policy(owner))
      return this.unavailable();
  }

  private requireCaps(
    actor: AuthContext,
    owner: ReferenceOwner,
    ref: PluginOwnedRef | { kind: "plugin"; pluginId: string },
    caps: readonly PluginCap[],
    action?: ReferenceActionAuthority,
  ): AuthContext {
    this.sameOwner(owner);
    const current = this.current(actor);
    for (const cap of caps) {
      action?.check(cap, ref);
      if (!this.auth.allowsRef(current, cap, ref)) return this.unavailable();
    }
    return current;
  }

  private bound(row: Publication, action: ReferenceActionAuthority): void {
    if (
      row.owner_plugin !== action.pluginId ||
      row.actor_principal !== action.actor.principal.id ||
      row.credential_binding !== this.auth.credentialBinding(action.actor)
    )
      return this.unavailable();
    const original = this.auth.restoreCredential(
      JSON.parse(row.credential_json) as CredentialReference,
    );
    if (original === null || this.auth.credentialBinding(original) !== row.credential_binding)
      return this.unavailable();
  }

  private identity(row: Publication): PublishedReferenceIdentity {
    if (row.ready_digest === null) return this.unavailable();
    return { ref: this.ref(row), preparationId: row.preparation_id, readyDigest: row.ready_digest };
  }

  private terminal(row: Publication): ReferenceTerminalReceipt {
    if (row.state !== "aborted" && row.state !== "deleted") return this.unavailable();
    return { ref: this.ref(row), preparationId: row.preparation_id, state: row.state };
  }

  private expire(): void {
    const now = this.runtime.now();
    this.store.db
      .query(
        `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
      terminal_actor=actor_principal,terminal_credential_binding=credential_binding
      WHERE state='prepared' AND expires_at<=?`,
      )
      .run(now, now);
    this.store.db
      .query(
        `DELETE FROM reference_publications WHERE state IN ('aborted','deleted')
      AND cleanup_pending=0 AND terminal_at<?`,
      )
      .run(now - RECEIPT_LIFETIME_MS);
  }

  private quarantine(row: Publication): void {
    this.store.transaction(() => {
      this.store.db
        .query(
          "UPDATE reference_publications SET state='quarantined' WHERE publication_id=? AND state='published'",
        )
        .run(row.publication_id);
      this.auth.referenceAuthorityChanged();
    });
  }
  /** Synchronous delivery fence after immutable-ready publication; this never discovers a title. */
  canReadPublished(actor: AuthContext, ref: PluginOwnedRef): boolean {
    try {
      const owner = this.liveOwner(ref.kind);
      this.requireCaps(actor, owner, ref, [owner.declaration.readCapability]);
      const row = this.row(ref);
      return (
        row !== null &&
        row.state === "published" &&
        row.owner_plugin === owner.pluginId &&
        row.policy_digest === this.policy(owner) &&
        row.ready_digest !== null
      );
    } catch {
      return false;
    }
  }

  /** Generic floor/carrier read check. Plugin methods additionally supply their active action fence. */
  async requirePublished(
    actor: AuthContext,
    ref: PluginOwnedRef,
    access: "read" | "share" | "delete" = "read",
    action?: ReferenceActionAuthority,
  ): Promise<PublishedReferenceIdentity> {
    const owner = this.liveOwner(ref.kind, action?.pluginId);
    const caps =
      access === "read"
        ? [owner.declaration.readCapability]
        : access === "delete"
          ? [owner.declaration.deleteCapability]
          : owner.declaration.sharing.prerequisites;
    this.requireCaps(actor, owner, ref, caps, action);
    const before = this.row(ref);
    if (before === null || before.state !== "published" || before.owner_plugin !== owner.pluginId)
      return this.unavailable();
    if (before.policy_digest !== this.policy(owner)) {
      this.quarantine(before);
      return this.unavailable();
    }
    const proof = await owner.probe(this.probeRequest(before));
    this.requireCaps(actor, owner, ref, caps, action);
    const after = this.row(ref);
    if (
      after === null ||
      after.state !== "published" ||
      after.publication_id !== before.publication_id
    )
      return this.unavailable();
    if (
      proof === null ||
      proof.preparationId !== before.preparation_id ||
      proof.readyDigest !== before.ready_digest ||
      after.ready_digest !== before.ready_digest
    ) {
      this.quarantine(after);
      return this.unavailable();
    }
    return this.identity(after);
  }

  context(
    action: ReferenceActionAuthority,
    attach?: PluginReferenceContext["attach"],
  ): PluginReferenceContext {
    return {
      attach: async (input) => {
        if (attach === undefined) return this.unavailable();
        return attach(ReferenceAttachmentRequestSchema.parse(input));
      },
      readable: async (input) => {
        const args = ReferenceReadFilterRequestSchema.parse(input);
        const owner = this.liveOwner(args.kind, action.pluginId);
        if (owner.declaration.listAction === undefined) return this.unavailable();
        action.checkReadable(args.kind);
        this.current(action.actor);
        const readable: PublishedReferenceIdentity[] = [];
        for (const ref of args.refs) {
          action.checkReadable(args.kind);
          this.sameOwner(owner);
          try {
            // The dedicated declaration admits this read-only filter, not arbitrary dynamic
            // action requirements. The ordinary evaluator and publication probe still decide
            // each candidate, before any private metadata may leave the owner.
            const identity = await this.requirePublished(action.actor, ref);
            action.checkReadable(args.kind);
            this.sameOwner(owner);
            readable.push(identity);
          } catch (error) {
            if (!(error instanceof ReferenceRefused)) throw error;
          }
        }
        action.checkReadable(args.kind);
        this.sameOwner(owner);
        const actor = this.current(action.actor);
        const policy = this.policy(owner);
        // An earlier candidate may have been revoked/deleted while a later probe awaited.
        return readable.filter((identity) => {
          const row = this.row(identity.ref);
          return (
            row?.state === "published" &&
            row.owner_plugin === owner.pluginId &&
            row.preparation_id === identity.preparationId &&
            row.ready_digest === identity.readyDigest &&
            row.policy_digest === policy &&
            this.auth.allowsRef(actor, owner.declaration.readCapability, identity.ref)
          );
        });
      },
      prepare: async (input) => {
        const args = ReferencePrepareRequestSchema.parse(input);
        const owner = this.liveOwner(args.kind, action.pluginId);
        const collection = { kind: "plugin" as const, pluginId: owner.pluginId };
        const actor = this.requireCaps(
          action.actor,
          owner,
          collection,
          [owner.declaration.createCapability],
          action,
        );
        await this.expireOwnerPreparations(owner);
        return this.store.transaction(() => {
          this.expire();
          this.requireCaps(
            action.actor,
            owner,
            collection,
            [owner.declaration.createCapability],
            action,
          );
          const binding = this.auth.credentialBinding(action.actor);
          const existing = this.store.db
            .query<Publication, [string, string, string, string]>(
              "SELECT * FROM reference_publications WHERE owner_plugin=? AND actor_principal=? AND credential_binding=? AND request_id=?",
            )
            .get(owner.pluginId, actor.principal.id, binding, args.requestId);
          if (existing !== null) {
            this.bound(existing, action);
            if (
              existing.binding_digest !== args.bindingDigest ||
              existing.policy_digest !== this.policy(owner) ||
              (existing.state !== "prepared" && existing.state !== "published")
            )
              return this.unavailable();
            if (
              existing.state === "published" &&
              !this.auth.allowsRef(actor, owner.declaration.readCapability, this.ref(existing))
            )
              return this.unavailable();
            return {
              ref: this.ref(existing),
              preparationId: existing.preparation_id,
              bindingDigest: existing.binding_digest,
              expiresAt: existing.expires_at,
            };
          }
          const counts = this.store.db
            .query<{ retained: number; active: number; personal: number }, [string, string]>(
              `SELECT count(*) AS retained,coalesce(sum(state='prepared'),0) AS active,
             coalesce(sum(state='prepared' AND actor_principal=?),0) AS personal
             FROM reference_publications WHERE owner_plugin=?`,
            )
            .get(actor.principal.id, owner.pluginId)!;
          if (counts.retained >= MAX_RECORDS || counts.active >= 4 || counts.personal >= 2)
            throw new ReferenceRefused("reference_capacity");
          this.capacity(MUTATION_RESERVATION_BYTES);
          const allocation = this.store.db
            .query<{ allocation_state: string }, [string]>(
              "SELECT allocation_state FROM reference_kind_owners WHERE kind=?",
            )
            .get(args.kind);
          if (allocation === null) return this.unavailable();
          const state = JSON.parse(allocation.allocation_state) as {
            incarnation: string;
            counter: number;
          };
          if (!Number.isSafeInteger(state.counter) || state.counter >= Number.MAX_SAFE_INTEGER)
            throw new ReferenceRefused("reference_capacity");
          state.counter += 1;
          const ref: PluginOwnedRef = {
            kind: "file",
            fileId: `${state.incarnation}-${state.counter}`,
          };
          if (!this.auth.containsReferenceTarget(actor, ref)) return this.unavailable();
          const preparationId = randomUUID();
          const now = this.runtime.now();
          const expiresAt = now + PREPARATION_LIFETIME_MS;
          this.store.db
            .query("UPDATE reference_kind_owners SET allocation_state=? WHERE kind=?")
            .run(JSON.stringify(state), args.kind);
          this.store.db
            .query(
              `INSERT INTO reference_publications(publication_id,node,owner_plugin,preparation_id,
            request_id,actor_principal,credential_json,credential_binding,binding_digest,policy_digest,owner_generation,
            state,created_at,expires_at,trace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`,
            )
            .run(
              randomUUID(),
              formatManifoldUri(ref),
              owner.pluginId,
              preparationId,
              args.requestId,
              actor.principal.id,
              canonicalJobJson(this.auth.credentialReference(action.actor)),
              binding,
              args.bindingDigest,
              this.policy(owner),
              owner.generationDigest,
              now,
              expiresAt,
              action.traceId,
            );
          this.capacity(0);
          this.store.afterCommit(() => this.scheduleExpiry(expiresAt, owner.pluginId));
          return { ref, preparationId, bindingDigest: args.bindingDigest, expiresAt };
        });
      },
      publish: async (input) => {
        const args = ReferencePublishRequestSchema.parse(input);
        const before = this.preparation(args.preparationId);
        if (before === null) return this.unavailable();
        this.bound(before, action);
        const ref = this.ref(before);
        const owner = this.liveOwner(ref.kind, action.pluginId);
        const collection = { kind: "plugin" as const, pluginId: owner.pluginId };
        const caps = [owner.declaration.createCapability];
        this.requireCaps(action.actor, owner, collection, caps, action);
        if (before.state === "published") {
          if (before.ready_digest !== args.readyDigest) return this.unavailable();
          // A lost ACK can return its receipt, never heal a revoked creator grant.
          const identity = await this.requirePublished(action.actor, ref);
          this.requireCaps(action.actor, owner, collection, caps, action);
          this.bound(before, action);
          return identity;
        }
        const deadline = Math.min(before.expires_at, args.expiresAt ?? Number.POSITIVE_INFINITY);
        if (
          before.state !== "prepared" ||
          deadline <= this.runtime.now() ||
          before.policy_digest !== this.policy(owner) ||
          before.owner_generation !== owner.generationDigest
        )
          return this.unavailable();
        const proof = await owner.probe(this.probeRequest(before));
        const probeDeadline = Math.min(deadline, proof?.expiresAt ?? deadline);
        const identity = this.store.transaction(() => {
          const actor = this.requireCaps(action.actor, owner, collection, caps, action);
          const current = this.preparation(args.preparationId);
          if (current === null) return this.unavailable();
          this.bound(current, action);
          if (
            current.state !== "prepared" ||
            Math.min(current.expires_at, probeDeadline) <= this.runtime.now() ||
            current.policy_digest !== this.policy(owner) ||
            current.owner_generation !== owner.generationDigest ||
            !this.auth.containsReferenceTarget(actor, ref) ||
            proof === null ||
            proof.preparationId !== args.preparationId ||
            proof.readyDigest !== args.readyDigest
          )
            return this.unavailable();
          this.capacity(MUTATION_RESERVATION_BYTES);
          this.requireCaps(action.actor, owner, collection, caps, action);
          if (probeDeadline <= this.runtime.now()) return this.unavailable();
          this.store.db
            .query(
              "UPDATE reference_publications SET state='published',ready_digest=?,cleanup_pending=1 WHERE publication_id=? AND state='prepared'",
            )
            .run(args.readyDigest, current.publication_id);
          this.auth.createReferenceGrant(
            {
              publicationId: current.publication_id,
              policyDigest: current.policy_digest,
              role: "creator",
              principalId: actor.principal.id,
              node: current.node,
              caps: owner.declaration.creatorCaps,
              previousGrantId: null,
            },
            actor,
            action.traceId,
          );
          this.capacity(0);
          this.store.afterCommit(() => this.scheduleRecovery());
          return { ref, preparationId: args.preparationId, readyDigest: args.readyDigest };
        });
        // Await the ordinary acknowledgement while the initiating guest is suspended in this
        // reference call. A crash here leaves the same work durably queued for idle maintenance.
        await this.acknowledgePublication(
          { ...before, state: "published", ready_digest: args.readyDigest },
          owner,
        );
        this.requireCaps(action.actor, owner, collection, caps, action);
        this.requireCaps(action.actor, owner, ref, [owner.declaration.readCapability]);
        const committed = this.preparation(args.preparationId);
        if (
          committed?.state !== "published" ||
          committed.ready_digest !== args.readyDigest ||
          committed.policy_digest !== this.policy(owner)
        )
          return this.unavailable();
        this.bound(committed, action);
        return identity;
      },
      abort: async (input) => {
        const { preparationId } = ReferenceAbortRequestSchema.parse(input);
        const receipt = this.store.transaction(() => {
          const row = this.preparation(preparationId);
          if (row === null) return this.unavailable();
          this.bound(row, action);
          const owner = this.liveOwner(this.ref(row).kind, action.pluginId);
          action.check(owner.declaration.createCapability, {
            kind: "plugin",
            pluginId: owner.pluginId,
          });
          if (row.state === "aborted") return this.terminal(row);
          if (row.state !== "prepared") return this.unavailable();
          this.store.db
            .query(
              `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
            terminal_actor=actor_principal,terminal_credential_binding=credential_binding
            WHERE preparation_id=? AND state='prepared'`,
            )
            .run(this.runtime.now(), preparationId);
          return this.terminal({ ...row, state: "aborted" });
        });
        await this.reclaim(action.pluginId);
        return receipt;
      },
      requirePublished: async (input) => {
        const { ref, access } = ReferenceRequirePublishedRequestSchema.parse(input);
        return this.requirePublished(action.actor, ref, access, action);
      },
      unpublish: async (input) => {
        const { ref } = ReferenceUnpublishRequestSchema.parse(input);
        const owner = this.liveOwner(ref.kind, action.pluginId);
        const before = this.row(ref);
        if (before?.state === "deleted") {
          this.requireCaps(action.actor, owner, ref, [owner.declaration.deleteCapability], action);
          return this.terminal(before);
        }
        await this.requirePublished(action.actor, ref, "delete", action);
        const receipt = this.store.transaction(() => {
          this.requireCaps(action.actor, owner, ref, [owner.declaration.deleteCapability], action);
          const row = this.row(ref);
          if (row === null || row.state !== "published") return this.unavailable();
          this.retire(
            row,
            action.actor.principal.id,
            action.traceId,
            this.auth.credentialBinding(action.actor),
          );
          return this.terminal({ ...row, state: "deleted" });
        });
        await this.reclaim(action.pluginId);
        return receipt;
      },
      receipt: async (input) => {
        const { ref } = ReferenceReceiptRequestSchema.parse(input);
        const owner = this.liveOwner(ref.kind, action.pluginId);
        if (owner.declaration.receiptAction === undefined) return this.unavailable();
        action.checkReceipt(ref);
        const current = this.current(action.actor);
        if (!this.auth.containsReferenceTarget(current, ref)) return this.unavailable();
        const row = this.row(ref);
        if (
          row === null ||
          row.owner_plugin !== owner.pluginId ||
          (row.state !== "aborted" && row.state !== "deleted") ||
          row.terminal_actor !== current.principal.id ||
          row.terminal_credential_binding !== this.auth.credentialBinding(current)
        )
          return this.unavailable();
        // This answers only the caller's already-committed operation, not access to the resource.
        return this.terminal(row);
      },
      grant: async (input) => {
        const args = ReferenceGrantRequestSchema.parse(input);
        await this.requirePublished(action.actor, args.ref, "share", action);
        const owner = this.liveOwner(args.ref.kind, action.pluginId);
        return this.store.transaction(() => {
          const actor = this.requireCaps(
            action.actor,
            owner,
            args.ref,
            owner.declaration.sharing.prerequisites,
            action,
          );
          const row = this.row(args.ref);
          if (
            row === null ||
            row.state !== "published" ||
            this.store.getPrincipal(args.principalId) === null ||
            args.caps.some((cap) => !owner.declaration.sharing.grantableCaps.includes(cap))
          )
            return this.unavailable();
          const caps = [...args.caps].sort();
          const existing = this.store.db
            .query<
              { grant_id: string; previous_grant_id: string | null },
              [string, string, string]
            >(
              `SELECT grant_id,previous_grant_id FROM reference_grant_provenance
             WHERE publication_id=? AND role='share' AND principal_id=? AND caps_key=?`,
            )
            .get(row.publication_id, args.principalId, JSON.stringify(caps));
          if (existing !== null) {
            const active = this.store.getGrant(existing.grant_id) !== null;
            if (existing.previous_grant_id === args.previousGrantId && active) {
              return {
                grantId: existing.grant_id,
                principalId: args.principalId,
                caps,
                active: true,
              };
            }
            // An old acknowledgement never heals a revoked decision. A new explicit choice
            // may replace only the exact retired decision the grantor reviewed.
            if (active || args.previousGrantId !== existing.grant_id)
              throw new ReferenceRefused("reference_conflict");
          } else if (args.previousGrantId !== null) {
            throw new ReferenceRefused("reference_conflict");
          }
          this.capacity(MUTATION_RESERVATION_BYTES);
          if (existing !== null) {
            this.store.db
              .query("DELETE FROM reference_grant_provenance WHERE grant_id=?")
              .run(existing.grant_id);
          }
          const grant = this.auth.createReferenceGrant(
            {
              publicationId: row.publication_id,
              policyDigest: row.policy_digest,
              role: "share",
              principalId: args.principalId,
              node: row.node,
              caps,
              previousGrantId: args.previousGrantId,
            },
            actor,
            action.traceId,
          );
          this.capacity(0);
          return { grantId: grant.id, principalId: args.principalId, caps, active: true };
        });
      },
      revoke: async (input) => {
        const args = ReferenceRevokeRequestSchema.parse(input);
        await this.requirePublished(action.actor, args.ref, "share", action);
        const owner = this.liveOwner(args.ref.kind, action.pluginId);
        return this.store.transaction(() => {
          const actor = this.requireCaps(
            action.actor,
            owner,
            args.ref,
            owner.declaration.sharing.prerequisites,
            action,
          );
          const row = this.row(args.ref);
          if (row === null || row.state !== "published") return this.unavailable();
          const share = this.store.db
            .query<{ principal_id: string; grant_id: string }, [string, string, string, string]>(
              `SELECT principal_id,grant_id FROM reference_grant_provenance
             WHERE publication_id=? AND (grant_id=? OR previous_grant_id=?) AND role='share' AND policy_digest=?`,
            )
            .get(row.publication_id, args.grantId, args.grantId, row.policy_digest);
          // Unknown/older-than-retained decisions have no attributable audience. Refuse rather
          // than claim that nobody can read; the grantor must refresh the current audience.
          if (share === null) throw new ReferenceRefused("reference_conflict");
          const changed =
            share.grant_id === args.grantId &&
            this.auth.revokeReferenceGrant(
              row.publication_id,
              args.grantId,
              "share",
              actor.principal.id,
              action.traceId,
            );
          return {
            changed,
            principalReadAllowed: this.auth.referencePrincipalReadAllowed(
              share.principal_id,
              owner.declaration.readCapability,
              row.node,
            ),
            credentialAccess: "not_evaluated" as const,
          };
        });
      },
      audience: async (input) => {
        const args = ReferenceAudienceRequestSchema.parse(input);
        await this.requirePublished(action.actor, args.ref, "share", action);
        const owner = this.liveOwner(args.ref.kind, action.pluginId);
        this.requireCaps(
          action.actor,
          owner,
          args.ref,
          owner.declaration.sharing.prerequisites,
          action,
        );
        const row = this.row(args.ref);
        if (row === null || row.state !== "published") return this.unavailable();
        const limit = args.limit ?? 64;
        const shares = this.store.db
          .query<
            { grant_id: string; principal_id: string; caps_key: string; active: number },
            [string, string, number]
          >(
            `SELECT p.grant_id,p.principal_id,p.caps_key,(g.id IS NOT NULL) AS active
           FROM reference_grant_provenance p LEFT JOIN grants g ON g.id=p.grant_id
           WHERE p.publication_id=? AND p.role='share' AND p.grant_id>?
           ORDER BY p.grant_id LIMIT ?`,
          )
          .all(row.publication_id, args.after ?? "", limit + 1);
        const page: RestrictedGrantView[] = shares.slice(0, limit).map((share) => ({
          grantId: share.grant_id,
          principalId: share.principal_id,
          caps: JSON.parse(share.caps_key) as PluginCap[],
          active: share.active === 1,
        }));
        return {
          shares: page,
          next: shares.length > limit ? page[page.length - 1]!.grantId : null,
        };
      },
    };
  }

  private retire(
    row: Publication,
    actorId: string | null,
    traceId: number | null,
    credentialBinding: string | null = null,
  ): void {
    this.store.db
      .query(
        `UPDATE reference_publications SET state='deleted',terminal_at=?,cleanup_pending=1,
      terminal_actor=?,terminal_credential_binding=? WHERE publication_id=?`,
      )
      .run(
        this.runtime.now(),
        credentialBinding === null ? null : actorId,
        credentialBinding,
        row.publication_id,
      );
    for (;;) {
      const grants = this.store.db
        .query<{ grant_id: string; role: "creator" | "share" }, [string]>(
          `SELECT p.grant_id,p.role FROM reference_grant_provenance p
         JOIN grants g ON g.id=p.grant_id WHERE p.publication_id=? LIMIT 64`,
        )
        .all(row.publication_id);
      if (grants.length === 0) break;
      for (const grant of grants)
        if (
          !this.auth.revokeReferenceGrant(
            row.publication_id,
            grant.grant_id,
            grant.role,
            actorId,
            traceId,
          )
        )
          throw new Error("reference grant provenance is inconsistent");
    }
    // Main-store foreign keys are not enabled; retired receipt provenance is explicit.
    // Published share tombstones remain until this terminal transition, preventing ACK
    // reconciliation from silently recreating an administrator-revoked grant.
    this.store.db
      .query("DELETE FROM reference_grant_provenance WHERE publication_id=?")
      .run(row.publication_id);
    this.auth.referenceAuthorityChanged();
  }

  /** Host-first purge retains kind reservations and receipts; it never reinterprets published data. */
  purge(pluginId: string, actorId: string, traceId: number | null = null): void {
    this.store.transaction(() => {
      const rows = this.store.db
        .query<Publication, [string]>(
          "SELECT * FROM reference_publications WHERE owner_plugin=? AND state IN ('prepared','published','quarantined')",
        )
        .all(pluginId);
      for (const row of rows) {
        if (row.state === "prepared") {
          this.store.db
            .query(
              `UPDATE reference_publications SET state='aborted',terminal_at=?,cleanup_pending=1,
            terminal_actor=actor_principal,terminal_credential_binding=credential_binding WHERE publication_id=?`,
            )
            .run(this.runtime.now(), row.publication_id);
        } else this.retire(row, actorId, traceId);
      }
    });
  }

  /** One bounded private batch. Failed reclaim never turns a committed delete into a failed delete. */
  async reclaim(pluginId: string): Promise<void> {
    if (this.reclaiming.has(pluginId)) return;
    this.reclaiming.add(pluginId);
    try {
      // At most 1,000 retained rows: sixteen bounded private batches drain the complete journal.
      for (let batch = 0; batch < Math.ceil(MAX_RECORDS / 64); batch += 1) {
        const rows = this.store.db
          .query<Publication, [string]>(
            `SELECT * FROM reference_publications WHERE owner_plugin=? AND cleanup_pending=1
           AND state IN ('aborted','deleted') ORDER BY created_at LIMIT 64`,
          )
          .all(pluginId);
        if (rows.length === 0) return;
        const owner = this.owner(this.ref(rows[0]!).kind);
        if (owner === null || owner.pluginId !== pluginId) return;
        await owner.reclaim(rows.map((row) => this.terminal(row)));
        this.sameOwner(owner);
        this.store.transaction(() => {
          for (const row of rows)
            this.store.db
              .query(
                `UPDATE reference_publications SET cleanup_pending=0
            WHERE publication_id=? AND owner_plugin=? AND preparation_id=? AND state IN ('aborted','deleted')`,
              )
              .run(row.publication_id, pluginId, row.preparation_id);
        });
      }
    } catch {
      this.cleanupFailure(pluginId);
    } finally {
      this.reclaiming.delete(pluginId);
    }
  }

  /** Reconcile deadlines and published identities; never publish or insert grants during recovery. */
  async reconcile(): Promise<void> {
    this.expire();
    for (const kind of PluginOwnedRefKindSchema.options) {
      const owner = this.owner(kind);
      if (owner !== null) {
        try {
          await this.expireOwnerPreparations(owner);
        } catch {
          this.cleanupFailure(owner.pluginId);
        }
      }
    }
    const rows = this.store.db
      .query<Publication, []>(
        "SELECT * FROM reference_publications WHERE state='published' ORDER BY created_at LIMIT 1000",
      )
      .all();
    for (const row of rows) {
      const ref = this.ref(row);
      const owner = this.owner(ref.kind);
      if (owner === null || owner.pluginId !== row.owner_plugin) continue;
      await this.acknowledgePublication(row, owner, true);
    }
    for (const pluginId of new Set(this.store.referenceKindOwners().values()))
      await this.reclaim(pluginId);
    this.scheduleRecovery();
  }
}
