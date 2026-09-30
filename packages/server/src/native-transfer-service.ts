import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  canonicalJobJson,
  canonicalNativeTransferPolicy,
  jobOwnerSupports,
  NativeTransferBindingSchema,
  NativeTransferStatusSchema,
  NATIVE_TRANSFER_MAX_FILE_BYTES as MAX_BYTES,
  NATIVE_TRANSFER_MAX_CHUNK_BYTES as CHUNK_BYTES,
  NATIVE_TRANSFER_RECEIPT_RETENTION_MS as RECEIPT_MS,
  NativeTransferResultSchema,
  NativeTransferRequestSchema,
  NativeTransferReasonSchema,
  type AuthoredCap,
  type Cap,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type ManifoldRef,
  type NativeTransferBinding,
  type NativeTransferBeginPutArgs,
  type NativeTransferDescription,
  type NativeTransferPermit,
  type NativeTransferRequest,
  type NativeTransferResult,
  type NativeTransferStatus,
  type NativeTransferReason,
  type NativeTransferReadChunkArgs,
  type NativeTransferReadChunkResult,
  type NativeTransferReceiptView,
  type NativeTransferTerminalEvidence,
} from "@manifold/protocol";
import { ServiceError, type AuthContext, type AuthService } from "./auth.ts";
import type { ServerStore } from "./stores.ts";
import type { JobInstallation } from "./job-store.ts";

const ACTIVE: Partial<Record<NativeTransferStatus["state"], true>> = {
  queued: true, receiving: true, verifying: true, ready: true, outcome_unknown: true,
};
const digest = (value: unknown): string => createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const policyDigest = (installation: JobInstallation): string =>
  createHash("sha256").update(canonicalNativeTransferPolicy(installation.machine)).digest("hex");
const refused = (reason: NativeTransferReason): never => { throw new ServiceError("forbidden", reason); };

/** Every method is bound to one still-active action or explicitly admitted byte carrier. */
export interface NativeTransferGuard {
  assertCurrent(): void;
  /** Current original action/request budget, never renewed by a continuation or queue. */
  remainingMs(): number;
  readonly signal?: AbortSignal;
  require(cap: AuthoredCap, ref: ManifoldRef): void;
  /** Readiness identity through the reference owner's current read declaration. Product code binds content metadata. */
  requireSource(source: NativeTransferBeginPutArgs["source"]): Promise<string>;
}
export interface NativeTransferChannel {
  machineId: string;
  send(message: { type: "job_command"; command: JobCommand }): boolean;
}
interface NativeOwner {
  owner: JobOwner;
  channel: NativeTransferChannel;
  seatNonce: string;
}
export interface NativeTransferHost {
  owner(machineId: string): NativeOwner | null;
  installation(machineId: string, pluginId: string): JobInstallation | null;
  held(pluginId: string): boolean;
  consent(installation: JobInstallation, ref: ManifoldRef, cap: Cap): string | null;
  sign(body: NativeTransferPermit["body"]): string;
}
const recordSchema = z.strictObject({
  binding: NativeTransferBindingSchema,
  ownerId: z.string(),
  ownerGeneration: z.number().int().nonnegative(),
  consentRevision: z.string(),
  ownerPublicKey: z.string().optional(),
  evidenceDelivered: z.boolean().optional(),
  status: NativeTransferStatusSchema,
  /** Last accepted progress, not an observation or request timestamp. */
  touchedAt: z.number().int().nonnegative(),
  readHighWater: z.number().int().nonnegative(),
  commitDecision: z.string().optional(),
  sourceReadyDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
type TransferRecord = z.infer<typeof recordSchema>;
interface Caller { auth: AuthContext; pluginId: string; guard: NativeTransferGuard }
interface Pending {
  channel: NativeTransferChannel;
  ownerId: string;
  ownerGeneration: number;
  transferId: string;
  finish(result: NativeTransferResult | Error): void;
}

/** A bounded typed channel coordinator; no byte content is retained in the hub authority journal. */
export class NativeTransferService {
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Set<string>();
  private evidenceSink: ((pluginId: string, receipts: readonly NativeTransferTerminalEvidence[]) => Promise<boolean>) | undefined;
  private readonly reconciling = new Map<string, Promise<void>>();
  private delivering: Promise<void> | undefined;
  private deliveryQueued: Promise<void> | undefined;
  private reconciliationFailed = false;
  constructor(
    private readonly store: ServerStore,
    private readonly auth: AuthService,
    private readonly host: NativeTransferHost,
    private readonly now: () => number,
  ) {}

  setEvidenceSink(sink: (pluginId: string, receipts: readonly NativeTransferTerminalEvidence[]) => Promise<boolean>): void {
    this.evidenceSink = sink;
  }

  /** One bounded pass per startup/owner proof/explicit inspection, never a polling loop. */
  async reconcile(machineId?: string): Promise<void> {
    try {
      const records = this.store.db.query<{ record: string }, []>(
        "SELECT record FROM native_transfers ORDER BY id LIMIT 1000",
      ).all().map((row) => recordSchema.parse(JSON.parse(row.record)));
      for (const record of records) {
        if (machineId !== undefined && record.binding.request.machineId !== machineId) continue;
        if (record.status.state === "outcome_unknown" ||
            (record.commitDecision !== undefined && ACTIVE[record.status.state]))
          await this.acquireEvidence(record);
      }
      await this.deliverEvidence();
      this.reconciliationFailed = false;
    } catch {
      // Startup/owner-proof callers have no user promise. Keep a named purge refusal rather
      // than an unhandled rejection or an apparent successful cleanup after a journal error.
      this.reconciliationFailed = true;
    }
  }

  private retained(transferId: string): TransferRecord | null {
    const row = this.store.db.query<{ record: string }, [string]>(
      "SELECT record FROM native_transfers WHERE id=?",
    ).get(transferId);
    return row ? recordSchema.parse(JSON.parse(row.record)) : null;
  }

  private async acquireEvidence(record: TransferRecord, guard?: NativeTransferGuard): Promise<void> {
    const id = record.binding.transferId;
    const existing = this.reconciling.get(id);
    // An action cannot inherit a background observation's independent 15-second lifetime.
    // Its retained unknown receipt is honest while that already-running observation settles.
    if (existing) return guard ? undefined : existing;
    const work = this.acquireRetainedEvidence(record, guard);
    this.reconciling.set(id, work);
    try { await work; } finally { this.reconciling.delete(id); }
  }

  private async acquireRetainedEvidence(record: TransferRecord, guard?: NativeTransferGuard): Promise<void> {
    const transferId = record.binding.transferId;
    if (!ACTIVE[record.status.state] || this.busy.has(transferId) || this.pending.size >= 4) return;
    const live = this.host.owner(record.binding.request.machineId);
    if (!live || !jobOwnerSupports(live.owner.protocolVersion, "nativeTransfers") ||
        live.owner.ownerId !== record.ownerId || live.owner.generation < record.ownerGeneration ||
        (record.ownerPublicKey !== undefined && live.owner.publicKey !== record.ownerPublicKey)) return;
    const request: NativeTransferRequest = { method: "evidence", transferId,
      bindingDigest: digest(record.binding), ownerGeneration: record.ownerGeneration };
    const body: NativeTransferPermit["body"] = { permitId: randomUUID(), commandDigest: digest(request), transferId,
      pluginId: record.binding.pluginId, actorId: record.binding.actorId, credentialBinding: record.binding.credentialBinding,
      machineId: record.binding.request.machineId, ownerId: live.owner.ownerId, ownerGeneration: live.owner.generation,
      seatNonce: live.seatNonce, issuedAt: this.now(), expiresAt: this.now() + 5000 };
    this.busy.add(transferId);
    try {
      const result = await this.send(live, request, { body, signature: this.host.sign(body) }, guard);
      // Even a proved owner cannot use an observation response to carry bytes. Active,
      // missing and cleanup-unknown answers are not proof of a terminal publication.
      if (!result.ok || result.data !== undefined) return;
      this.validateStatus(record, result.status);
      if (ACTIVE[result.status.state]) {
        if (result.status.state === "outcome_unknown" &&
            record.status.state === "outcome_unknown" &&
            record.status.reason !== result.status.reason) {
          record.status = result.status;
          this.save(record);
        }
        return;
      }
      const current = this.retained(transferId);
      if (!current || !ACTIVE[current.status.state] || digest(current.binding) !== digest(record.binding)) return;
      current.status = result.status;
      current.evidenceDelivered = false;
      this.save(current);
    } catch {
      // Absence, disconnect, invalid evidence or a failed journal write preserves uncertainty.
    } finally { this.busy.delete(transferId); }
  }

  private async deliverEvidence(): Promise<void> {
    if (this.delivering) {
      // At most one coalesced next pass. A terminal result arriving during a callback await
      // must not be stranded behind the earlier pass's already-read snapshot.
      this.deliveryQueued ??= this.delivering.catch(() => {}).then(() => {
        this.deliveryQueued = undefined;
        return this.deliverEvidence();
      });
      return this.deliveryQueued;
    }
    const work = this.deliverRetainedEvidence();
    this.delivering = work;
    try { await work; } finally { this.delivering = undefined; }
  }

  private async deliverRetainedEvidence(): Promise<void> {
    const sink = this.evidenceSink;
    if (!sink) return;
    const groups = new Map<string, TransferRecord[]>();
    for (const row of this.store.db.query<{ record: string }, []>(
      "SELECT record FROM native_transfers ORDER BY id LIMIT 1000",
    ).all()) {
      const record = recordSchema.parse(JSON.parse(row.record));
      if (ACTIVE[record.status.state] || record.evidenceDelivered) continue;
      const group = groups.get(record.binding.pluginId) ?? [];
      group.push(record);
      groups.set(record.binding.pluginId, group);
    }
    for (const [pluginId, records] of groups) {
      for (let offset = 0; offset < records.length; offset += 64) {
        const batch = records.slice(offset, offset + 64);
        const evidence = batch.map((record): NativeTransferTerminalEvidence => ({
          kind: "terminal",
          transferId: record.binding.transferId, requestId: record.binding.request.requestId,
          actorId: record.binding.actorId, credentialBinding: record.binding.credentialBinding,
          mode: record.binding.request.mode,
          state: record.status.state as Extract<NativeTransferTerminalEvidence, { kind: "terminal" }>["state"],
          ...(record.status.reason ? { reason: record.status.reason } : {}),
        }));
        try {
          if (!await sink(pluginId, evidence)) continue;
          for (const record of batch) {
            const current = this.retained(record.binding.transferId);
            if (!current || canonicalJobJson(current.status) !== canonicalJobJson(record.status)) continue;
            current.evidenceDelivered = true;
            // Delivery acknowledgement does not refresh the terminal retention clock.
            this.store.db.query("UPDATE native_transfers SET record=? WHERE id=?")
              .run(canonicalJobJson(current), current.binding.transferId);
          }
        } catch {
          // Keep the actual evidence until a later bounded pass can release product charges.
        }
      }
    }
  }

  async receipt(caller: Caller, transferId: string): Promise<NativeTransferReceiptView> {
    const record = this.load(caller, transferId);
    await this.acquireEvidence(record, caller.guard);
    await this.deliverEvidence();
    // Acquisition is private. Disclosure still needs the exact live credential and request,
    // but not deleted-source or revised effect consent authority; no private metadata escapes.
    this.current(caller);
    const current = this.load(caller, transferId);
    if (ACTIVE[current.status.state] && current.status.state !== "outcome_unknown")
      return refused("transfer_unavailable");
    return { transferId, state: current.status.state as NativeTransferReceiptView["state"],
      ...(current.status.reason ? { reason: current.status.reason } : {}) };
  }

  /** Purge must not destroy product receipts while a native outcome still needs reconciliation. */
  assertPurgeable(pluginId: string): void {
    if (this.reconciliationFailed) throw new ServiceError("conflict", "native_transfer_cleanup_unknown");
    this.prune();
    let active = false;
    for (const row of this.store.db.query<{ record: string }, [string]>(
      "SELECT record FROM native_transfers WHERE plugin_id=?",
    ).all(pluginId)) {
      const record = recordSchema.parse(JSON.parse(row.record));
      if (record.status.state === "outcome_unknown")
        throw new ServiceError("conflict", "outcome_unknown");
      if (ACTIVE[record.status.state]) active = true;
      if (!ACTIVE[record.status.state] && this.evidenceSink && !record.evidenceDelivered)
        throw new ServiceError("conflict", "native_transfer_cleanup_unknown");
    }
    if (active) throw new ServiceError("conflict", "active_native_transfers");
  }

  private current(caller: Caller): AuthContext {
    caller.guard.assertCurrent();
    const current = this.auth.restoreCredential(this.auth.credentialReference(caller.auth));
    if (!current) return refused("credential_revoked_or_expired");
    if (this.host.held(caller.pluginId) || this.store.disabledPlugins().has(caller.pluginId))
      return refused("installation_changed");
    return current;
  }
  private credentialBinding(auth: AuthContext): string {
    return this.auth.credentialBinding(auth);
  }
  private load(caller: Caller, transferId: string): TransferRecord {
    // Match original host lineage before checking live authority. A revoked matching caller
    // may learn only uncertainty; another actor, credential or plugin learns no record state.
    const credentialBinding = this.credentialBinding(caller.auth);
    const row = this.store.db.query<{ record: string }, [string, string, string, string]>(
      "SELECT record FROM native_transfers WHERE id=? AND plugin_id=? AND actor_id=? AND credential_binding=?",
    ).get(transferId, caller.pluginId, caller.auth.principal.id, credentialBinding);
    if (!row) return refused("transfer_unavailable");
    const record = recordSchema.parse(JSON.parse(row.record));
    if (record.binding.transferId !== transferId || record.binding.pluginId !== caller.pluginId ||
        record.binding.actorId !== caller.auth.principal.id || record.binding.credentialBinding !== credentialBinding)
      return refused("transfer_unavailable");
    return record;
  }
  private save(record: TransferRecord): void {
    this.store.db.query("UPDATE native_transfers SET record=?,updated_at=? WHERE id=?").run(
      canonicalJobJson(record), this.now(), record.binding.transferId,
    );
  }
  private location(binding: NativeTransferBinding): Extract<ManifoldRef, { kind: "location" }> {
    return { kind: "location", machineId: binding.request.machineId, locationId: binding.request.locationId };
  }
  private authorize(caller: Caller, record: TransferRecord, reconcile = false): NativeOwner {
    const current = this.current(caller);
    const binding = record.binding;
    const request = binding.request;
    if (binding.pluginId !== caller.pluginId || binding.actorId !== current.principal.id ||
        binding.credentialBinding !== this.credentialBinding(caller.auth))
      return refused("transfer_unavailable");
    const cap = request.mode === "put" ? "locations:create-child" : "locations:read";
    const ref = this.location(binding);
    caller.guard.require(cap, ref);
    if (!this.auth.allowsRef(current, cap, ref)) return refused("transfer_authority_refused");
    const machine = this.store.getMachine(request.machineId);
    const token = machine ? this.store.getToken(machine.tokenId) : null;
    if (!machine || !token || token.revokedAt !== null ||
        (token.expiresAt !== null && token.expiresAt <= this.now())) return refused("machine_unavailable");
    if (machine.draining && !reconcile) return refused("owner_draining");
    const installation = this.host.installation(request.machineId, binding.pluginId);
    if (!installation?.enabled || !installation.ready || installation.purgeRequested ||
        installation.revision !== request.installationRevision || installation.artifact !== request.artifactSha256 ||
        !installation.machine.transferPolicy || policyDigest(installation) !== request.artifactSha256)
      return refused("installation_changed");
    const declaration = installation.machine.locations[request.locationId];
    if (!declaration || declaration.revision !== request.locationRevision ||
        !installation.machine.transferPolicy.locations[request.locationId]?.includes(request.mode === "put" ? "create-child" : "read"))
      return refused("location_changed");
    const consent = this.host.consent(installation, ref, cap);
    if (consent === null || consent !== record.consentRevision) return refused("consent_changed");
    const live = this.host.owner(request.machineId);
    if (!live || !jobOwnerSupports(live.owner.protocolVersion, "nativeTransfers") ||
        !live.owner.platforms.some((platform) => platform === "linux-x64" || platform === "linux-arm64"))
      return refused("native_transfer_unsupported");
    if (!declaration.managed && (
        installation.resourceBindings?.anchors[declaration.anchor] === undefined ||
        installation.resourceBindings.anchors[declaration.anchor] !== live.owner.resources?.anchors[declaration.anchor]))
      return refused("location_changed");
    if (live.owner.ownerId !== record.ownerId ||
        (reconcile ? live.owner.generation < record.ownerGeneration : live.owner.generation !== record.ownerGeneration))
      return refused("owner_fenced");
    return live;
  }
  private async source(caller: Caller, record: TransferRecord): Promise<void> {
    if (record.binding.request.mode !== "put") return;
    const readyDigest = await caller.guard.requireSource(record.binding.request.source);
    if (!/^[a-f0-9]{64}$/.test(readyDigest) ||
        (record.sourceReadyDigest !== undefined && record.sourceReadyDigest !== readyDigest))
      return refused("transfer_source_changed");
    record.sourceReadyDigest = readyDigest;
  }

  async describe(caller: Caller, machineId: string): Promise<NativeTransferDescription> {
    const current = this.current(caller);
    const ref: ManifoldRef = { kind: "machine", machineId };
    caller.guard.require("machines:read", ref);
    if (!this.auth.allowsRef(current, "machines:read", ref)) return refused("transfer_authority_refused");
    const machine = this.store.getMachine(machineId);
    const token = machine ? this.store.getToken(machine.tokenId) : null;
    if (!machine || !token || token.revokedAt !== null ||
        (token.expiresAt !== null && token.expiresAt <= this.now())) return refused("machine_unavailable");
    const installation = this.host.installation(machineId, caller.pluginId);
    const live = this.host.owner(machineId);
    if (!installation?.enabled || installation.purgeRequested || !installation.machine.transferPolicy ||
        policyDigest(installation) !== installation.artifact)
      return refused("installation_changed");
    if (!live || !jobOwnerSupports(live.owner.protocolVersion, "nativeTransfers") ||
        !live.owner.platforms.some((platform) => platform === "linux-x64" || platform === "linux-arm64"))
      return refused("native_transfer_unsupported");
    const locations = Object.entries(installation.machine.transferPolicy.locations).flatMap(([locationId, access]) => {
      const declaration = installation.machine.locations[locationId]!;
      const location: ManifoldRef = { kind: "location", machineId, locationId };
      const rights = access.filter((right) => {
        const cap = right === "read" ? "locations:read" : "locations:create-child";
        return this.auth.allowsRef(current, cap, location) && this.host.consent(installation, location, cap) !== null;
      });
      const available = installation.ready && !machine.draining &&
        (declaration.managed === true ||
          (installation.resourceBindings?.anchors[declaration.anchor] !== undefined &&
           installation.resourceBindings.anchors[declaration.anchor] === live.owner.resources?.anchors[declaration.anchor]));
      return rights.length ? [{ locationId, locationRevision: declaration.revision, access: rights, available,
        ...(available ? {} : { reason: "native_transfer_unavailable" as const }) }] : [];
    });
    return { machineId, installationRevision: installation.revision, artifactSha256: installation.artifact,
      ownerId: live.owner.ownerId, ownerGeneration: live.owner.generation, locations };
  }

  async begin(caller: Caller, request: NativeTransferBinding["request"]): Promise<NativeTransferStatus> {
    try {
      return await this.admit(caller, request);
    } catch (error) {
      // The product reserves before entering this authority boundary. A refusal before
      // the host journal admits the exact request cannot have dispatched native work.
      // Retire only that queued reservation; an admitted request must reconcile its owner.
      const credentialBinding = this.credentialBinding(caller.auth);
      const admitted = this.store.db.query<{ id: string }, [string, string, string, string]>(
        "SELECT id FROM native_transfers WHERE plugin_id=? AND actor_id=? AND credential_binding=? AND request_id=?",
      ).get(caller.pluginId, caller.auth.principal.id, credentialBinding, request.requestId);
      if (!admitted && this.evidenceSink) {
        const reason = NativeTransferReasonSchema.safeParse(error instanceof ServiceError ? error.message : "");
        let delivered = false;
        try {
          delivered = await this.evidenceSink(caller.pluginId, [{
            kind: "admission-refused", requestId: request.requestId,
            actorId: caller.auth.principal.id, credentialBinding, mode: request.mode,
            attemptedAt: this.now(), reason: reason.success ? reason.data : "native_transfer_unavailable",
          }]);
        } catch {
          // No native effect exists, but the product's reservation may still need cleanup.
        }
        if (!delivered) throw new ServiceError("conflict", "native_transfer_cleanup_unknown");
      }
      throw error;
    }
  }

  private async admit(caller: Caller, request: NativeTransferBinding["request"]): Promise<NativeTransferStatus> {
    const current = this.current(caller);
    const credentialBinding = this.credentialBinding(caller.auth);
    const existing = this.store.db.query<{ record: string }, [string, string, string, string]>(
      "SELECT record FROM native_transfers WHERE plugin_id=? AND actor_id=? AND credential_binding=? AND request_id=?",
    ).get(caller.pluginId, current.principal.id, credentialBinding, request.requestId);
    if (existing) {
      const prior = recordSchema.parse(JSON.parse(existing.record));
      if (digest(prior.binding.request) !== digest(request)) return refused("transfer_request_conflict");
      return this.status(caller, prior.binding.transferId);
    }
    const live = this.host.owner(request.machineId);
    const installation = this.host.installation(request.machineId, caller.pluginId);
    if (!live || !installation) return refused("native_transfer_unavailable");
    const cap = request.mode === "put" ? "locations:create-child" : "locations:read";
    const consentRevision = this.host.consent(installation,
      { kind: "location", machineId: request.machineId, locationId: request.locationId }, cap);
    if (!consentRevision) return refused("consent_changed");
    const binding = NativeTransferBindingSchema.parse({ transferId: randomUUID(), pluginId: caller.pluginId,
      actorId: current.principal.id, credentialBinding, request, createdAt: this.now(), expiresAt: this.now() + 15 * 60 * 1000 });
    const record: TransferRecord = { binding, ownerId: live.owner.ownerId, ownerGeneration: live.owner.generation,
      ownerPublicKey: live.owner.publicKey, consentRevision,
      status: { transferId: binding.transferId, mode: request.mode, state: "queued", bytes: 0 },
      touchedAt: this.now(), readHighWater: 0 };
    await this.source(caller, record);
    const duplicateId = this.store.transaction(() => {
      this.authorize(caller, record);
      const raced = this.store.db.query<{ record: string }, [string, string, string, string]>(
        "SELECT record FROM native_transfers WHERE plugin_id=? AND actor_id=? AND credential_binding=? AND request_id=?",
      ).get(caller.pluginId, current.principal.id, credentialBinding, request.requestId);
      if (raced) {
        const prior = recordSchema.parse(JSON.parse(raced.record));
        if (digest(prior.binding.request) !== digest(request)) return refused("transfer_request_conflict");
        return prior.binding.transferId;
      }
      this.prune();
      const rows = this.store.db.query<{ record: string }, []>("SELECT record FROM native_transfers").all();
      if (rows.length >= 1000) return refused("transfer_receipt_limit");
      const active = rows.map((row) => recordSchema.parse(JSON.parse(row.record))).filter((value) => ACTIVE[value.status.state]);
      if (active.length >= 4 || active.filter((value) => value.binding.actorId === binding.actorId).length >= 2)
        return refused("transfer_concurrency_limit");
      const bytes = active.reduce((sum, value) => sum + (value.binding.request.mode === "put" ? value.binding.request.source.bytes : MAX_BYTES), 0);
      if (bytes + (request.mode === "put" ? request.source.bytes : MAX_BYTES) > 32 * 1024 * 1024)
        return refused("transfer_capacity");
      this.store.db.query("INSERT INTO native_transfers(id,plugin_id,actor_id,credential_binding,request_id,record,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(binding.transferId, binding.pluginId, binding.actorId, binding.credentialBinding, request.requestId, canonicalJobJson(record), this.now());
      return null;
    });
    if (duplicateId !== null) return this.status(caller, duplicateId);
    return (await this.exchange(caller, record, NativeTransferRequestSchema.parse({
      method: request.mode === "put" ? "beginPut" : "beginRead", binding,
    }))).status;
  }

  async putChunk(caller: Caller, args: { transferId: string; seq: number; offset: number; data: Uint8Array }): Promise<NativeTransferStatus> {
    if (!(args.data instanceof Uint8Array) || args.data.byteLength > CHUNK_BYTES) return refused("transfer_chunk_limit");
    const record = this.load(caller, args.transferId);
    if (record.binding.request.mode !== "put") return refused("transfer_mode_mismatch");
    return (await this.exchange(caller, record, { method: "putChunk", transferId: args.transferId, seq: args.seq, offset: args.offset,
      data: Buffer.from(args.data.buffer, args.data.byteOffset, args.data.byteLength).toString("base64") })).status;
  }
  async commitPut(caller: Caller, transferId: string): Promise<NativeTransferStatus> {
    let record = this.load(caller, transferId);
    if (record.binding.request.mode !== "put") return refused("transfer_mode_mismatch");
    if (record.commitDecision !== undefined || record.status.state === "committed")
      return this.status(caller, transferId);
    await this.exchange(caller, record, { method: "preparePut", transferId });
    record = this.load(caller, transferId);
    return (await this.exchange(caller, record, { method: "commitPut", transferId })).status;
  }
  async readChunk(caller: Caller, args: NativeTransferReadChunkArgs): Promise<NativeTransferReadChunkResult> {
    const record = this.load(caller, args.transferId);
    if (record.binding.request.mode !== "read") return refused("transfer_mode_mismatch");
    const result = await this.exchange(caller, record, { method: "readChunk", ...args });
    const bytes = Buffer.from(result.data!, "base64");
    return { status: result.status, data: bytes, offset: result.offset!, eof: result.eof! };
  }
  async cancel(caller: Caller, transferId: string): Promise<NativeTransferStatus> {
    const record = this.load(caller, transferId);
    if (record.commitDecision !== undefined) return this.status(caller, transferId);
    return (await this.exchange(caller, record, { method: "cancel", transferId })).status;
  }
  async status(caller: Caller, transferId: string): Promise<NativeTransferStatus> {
    let record = this.load(caller, transferId);
    if (record.commitDecision !== undefined) {
      await this.acquireEvidence(record, caller.guard);
      await this.deliverEvidence();
      record = this.load(caller, transferId);
      try {
        await this.source(caller, record);
        this.authorize(caller, record, true);
      } catch { throw new ServiceError("conflict", "outcome_unknown"); }
      return record.status;
    }
    return (await this.exchange(caller, record, { method: "status", transferId })).status;
  }

  private async exchange(caller: Caller, record: TransferRecord, raw: NativeTransferRequest): Promise<Extract<NativeTransferResult, { ok: true }>> {
    const transferId = record.binding.transferId;
    let acquired = false;
    try {
      const request = NativeTransferRequestSchema.parse(raw);
      if (this.busy.has(transferId) || this.pending.size >= 4) return refused("transfer_backpressure");
      this.busy.add(transferId);
      acquired = true;
      if (record.commitDecision !== undefined && request.method !== "status")
        return refused("outcome_unknown");
      await this.source(caller, record);
      const reconcile = request.method === "status" || request.method === "cancel";
      const { live, permit } = this.store.transaction(() => {
        const live = this.authorize(caller, record, reconcile);
        this.waitBudget(caller.guard);
        if (!reconcile && (this.now() >= record.binding.expiresAt || this.now() - record.touchedAt >= 60_000))
          return refused("transfer_expired");
        const body: NativeTransferPermit["body"] = { permitId: randomUUID(), commandDigest: digest(request), transferId,
          pluginId: record.binding.pluginId, actorId: record.binding.actorId, credentialBinding: record.binding.credentialBinding,
          machineId: record.binding.request.machineId, ownerId: live.owner.ownerId, ownerGeneration: live.owner.generation,
          seatNonce: live.seatNonce, issuedAt: this.now(), expiresAt: this.now() + 5000 };
        const permit = { body, signature: this.host.sign(body) };
        // This is the durable current-authority publish decision, never a reusable retry permit.
        if (request.method === "commitPut") {
          record.commitDecision = body.permitId;
          record.status = { ...record.status, state: "outcome_unknown", reason: "outcome_unknown" };
          record.touchedAt = this.now();
          this.save(record);
        }
        return { live, permit };
      });
      let result = await this.send(live, request, permit, caller.guard);
      let readEnd: number | undefined;
      if (request.method === "readChunk" && result.ok) {
        if (result.data === undefined || result.offset !== request.offset || result.eof === undefined)
          return refused("transfer_reply_invalid");
        const bytes = Buffer.byteLength(result.data, "base64");
        if (bytes > request.maxBytes || bytes > CHUNK_BYTES || result.offset + bytes > result.status.bytes)
          return refused("transfer_reply_invalid");
        if (bytes > 0) readEnd = result.offset + bytes;
      }
      if (result.status) {
        let status = result.status;
        this.validateStatus(record, result.status);
        if (record.commitDecision !== undefined && ACTIVE[result.status.state] &&
            result.status.state !== "outcome_unknown") {
          // A pre-consumption status cannot prove that an already dispatched permit will never
          // arrive. Only the owner's terminal receipt or proved cancellation resolves it.
          status = record.status.state === "committed" ? record.status : {
            transferId, mode: record.binding.request.mode, state: "outcome_unknown",
            bytes: record.status.bytes, reason: "outcome_unknown",
          };
        }
        result = { ...result, status };
        const progressed = result.ok && request.method !== "status" &&
          (status.state !== record.status.state ||
           (request.method === "putChunk" && status.bytes > record.status.bytes) ||
           (readEnd !== undefined && readEnd > record.readHighWater));
        const changed = canonicalJobJson(record.status) !== canonicalJobJson(status);
        if (progressed) {
          record.touchedAt = this.now();
          if (readEnd !== undefined) record.readHighWater = Math.max(record.readHighWater, readEnd);
        }
        record.status = status;
        // Observations cannot renew idle time or the seven-day terminal receipt retention.
        if (changed && !ACTIVE[status.state]) record.evidenceDelivered = false;
        if (changed || progressed) this.save(record);
      }
      // Receipt persistence is independent of disclosure: a post-commit revocation cannot erase it.
      if (!ACTIVE[record.status.state]) await this.deliverEvidence();
      await this.source(caller, record);
      this.authorize(caller, record, reconcile);
      if (!result.ok) return refused(result.reason);
      return result;
    } catch (error) {
      // Include loading/current-authority failures in retries and reconciliation, and a
      // concurrent durable decision made since this call loaded its record. Never convert
      // a known publication decision into a retry-looking pre-publication refusal.
      if (record.commitDecision !== undefined || this.load(caller, transferId).commitDecision !== undefined)
        throw new ServiceError("conflict", "outcome_unknown");
      throw error;
    } finally { if (acquired) this.busy.delete(transferId); }
  }
  /** Leave 250ms inside the original outer deadline for the result to cross the guest boundary. */
  private waitBudget(guard?: NativeTransferGuard): number {
    const remaining = guard ? guard.remainingMs() - 250 : 15_000;
    if (guard?.signal?.aborted || !(remaining > 0)) return refused("transfer_action_unavailable");
    return Math.min(remaining, 15_000);
  }

  private send(live: NativeOwner, request: NativeTransferRequest, permit: NativeTransferPermit,
    guard?: NativeTransferGuard): Promise<NativeTransferResult> {
    const budget = this.waitBudget(guard);
    return new Promise<NativeTransferResult>((resolve, reject) => {
      const rpcId = randomUUID();
      const finish = (value: NativeTransferResult | Error): void => {
        if (!this.pending.has(rpcId)) return;
        this.pending.delete(rpcId);
        clearTimeout(timer);
        guard?.signal?.removeEventListener("abort", abort);
        if (value instanceof Error) reject(value); else resolve(value);
      };
      const abort = (): void => finish(new ServiceError("conflict",
        request.method === "commitPut" ? "outcome_unknown" : "transfer_action_unavailable"));
      const timer = setTimeout(() => finish(new ServiceError("conflict",
        request.method === "commitPut" ? "outcome_unknown" : "transfer_disconnected")), budget);
      this.pending.set(rpcId, { channel: live.channel, ownerId: live.owner.ownerId,
        ownerGeneration: live.owner.generation, transferId: permit.body.transferId, finish });
      guard?.signal?.addEventListener("abort", abort, { once: true });
      if (guard?.signal?.aborted) { abort(); return; }
      if (!live.channel.send({ type: "job_command", command: { type: "native_transfer", rpcId, request, permit } }))
        finish(new ServiceError("conflict", request.method === "commitPut" ? "outcome_unknown" : "transfer_disconnected"));
    });
  }
  private validateStatus(record: TransferRecord, status: NativeTransferStatus): void {
    if (status.transferId !== record.binding.transferId || status.mode !== record.binding.request.mode)
      return refused("transfer_reply_invalid");
    const receipt = status.receipt;
    if (!receipt) return;
    const { binding } = record;
    const request = binding.request;
    if (receipt.transferId !== binding.transferId || receipt.mode !== request.mode || receipt.requestId !== request.requestId ||
        receipt.machineId !== request.machineId || receipt.installationRevision !== request.installationRevision ||
        receipt.artifactSha256 !== request.artifactSha256 || receipt.locationId !== request.locationId ||
        receipt.locationRevision !== request.locationRevision || receipt.pluginId !== binding.pluginId ||
        receipt.actorId !== binding.actorId || receipt.credentialBinding !== binding.credentialBinding ||
        receipt.ownerId !== record.ownerId || receipt.ownerGeneration !== record.ownerGeneration ||
        (request.mode === "put" && (receipt.bytes !== request.source.bytes || receipt.sha256 !== request.source.sha256)))
      return refused("transfer_reply_invalid");
  }
  event(channel: NativeTransferChannel, event: Extract<JobEvent, { type: "native_transfer_result" }>): void {
    const pending = this.pending.get(event.rpcId);
    if (!pending || pending.channel !== channel || pending.ownerId !== event.ownerId || pending.ownerGeneration !== event.ownerGeneration) return;
    const result = NativeTransferResultSchema.safeParse(event.result);
    pending.finish(result.success ? result.data : new ServiceError("conflict", "transfer_reply_invalid"));
  }
  disconnect(channel: NativeTransferChannel): void {
    for (const pending of [...this.pending.values()]) if (pending.channel === channel)
      pending.finish(new ServiceError("conflict", "transfer_disconnected"));
  }
  private prune(): void {
    for (const row of this.store.db.query<{ id: string; record: string; updated_at: number }, []>("SELECT id,record,updated_at FROM native_transfers").all()) {
      const record = recordSchema.parse(JSON.parse(row.record));
      if (ACTIVE[record.status.state] && record.status.state !== "outcome_unknown" &&
          record.commitDecision === undefined &&
          (this.now() >= record.binding.expiresAt || this.now() - record.touchedAt >= 60_000)) {
        record.status = { transferId: record.binding.transferId, mode: record.binding.request.mode,
          state: "expired", bytes: record.status.bytes, reason: "transfer_expired" };
        this.save(record);
      }
      if (!ACTIVE[record.status.state] && (!this.evidenceSink || record.evidenceDelivered) && this.now() - row.updated_at > RECEIPT_MS)
        this.store.db.query("DELETE FROM native_transfers WHERE id=?").run(row.id);
    }
  }
}
