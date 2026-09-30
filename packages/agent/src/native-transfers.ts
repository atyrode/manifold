import { createHash, randomUUID, verify, type KeyObject } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  readlinkSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  canonicalJobJson,
  canonicalNativeTransferPolicy,
  NATIVE_TRANSFER_MAX_FILE_BYTES,
  NATIVE_TRANSFER_MAX_CHUNK_BYTES,
  NATIVE_TRANSFER_MAX_ACTIVE,
  NATIVE_TRANSFER_MAX_PER_ACTOR,
  NATIVE_TRANSFER_MAX_PRIVATE_BYTES,
  NATIVE_TRANSFER_MAX_RECEIPTS,
  NATIVE_TRANSFER_RECEIPT_RETENTION_MS,
  NATIVE_TRANSFER_IDLE_MS,
  NATIVE_TRANSFER_PERMIT_MS,
  NativeTransferReasonSchema,
  type JobCommand,
  type NativeTransferBinding,
  type NativeTransferResult,
  type NativeTransferReceipt,
  type NativeTransferReason,
  type NativeTransferStatus,
  type MachineLocation,
} from "@manifold/protocol";
import {
  ExclusivePublicationError,
  type HeldDirectory,
  directoryAncestry,
  fileIdentity,
  safeComponent,
} from "./job-files.ts";
import {
  type DirectoryExclusions,
  resolveJobLocation,
  resolveManagedTransferRoot,
} from "./job-locations.ts";
import { type JobJournal, jobDigest } from "./job-journal.ts";
import type { JobOutputStore } from "./job-outputs.ts";
import type { RetainedNativeTransfer } from "./native-transfer-state.ts";
import { stableNativeSnapshot } from "./native-transfer-snapshot.ts";

type TransferCommand = Extract<JobCommand, { type: "native_transfer" }>;
type InstallCommand = Extract<JobCommand, { type: "install" }>;
export interface NativeTransferInstallation {
  command: InstallCommand;
  enabled: boolean;
}
export interface NativeTransferOwnerOptions {
  machineId: string;
  journal: JobJournal;
  admissionKey: KeyObject;
  managedState: HeldDirectory;
  anchors: Readonly<Record<string, HeldDirectory>>;
  exclusions: DirectoryExclusions;
  outputs: JobOutputStore;
  installation(pluginId: string, revision: string): NativeTransferInstallation | undefined;
  anchorDigest(anchor: string): string | undefined;
  seat(): AbortSignal | null;
  seatNonce(): string | null;
  draining(): boolean;
  /** Includes readers: no workload may see a private receiving sibling. */
  assertRootAvailable(fd: number): void;
}
interface LiveTransfer {
  record: RetainedNativeTransfer;
  root: HeldDirectory | undefined;
  fd: number | undefined;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  busy: boolean;
  readFinished: Promise<void> | undefined;
}
const ACTIVE: Record<string, true> = { receiving: true, verifying: true, ready: true };

/** Inline policy artifacts never enter the executable cache or artifact acquisition path. */
export function validateNativeTransferInstallation(command: InstallCommand): void {
  if (
    !command.machine.transferPolicy ||
    Object.keys(command.machine.artifacts).length ||
    Object.keys(command.machine.operations).length ||
    Object.keys(command.machine.tools ?? {}).length ||
    command.artifact ||
    command.toolArtifacts
  )
    throw new Error("native_transfer_artifact_invalid");
  const digest = createHash("sha256")
    .update(canonicalNativeTransferPolicy(command.machine))
    .digest("hex");
  if (digest !== command.artifactSha256) throw new Error("native_transfer_artifact_mismatch");
  for (const id of Object.keys(command.machine.locations))
    if (!id.startsWith(`${command.pluginId}.`))
      throw new Error("native_transfer_location_namespace");
}

/** Held ancestry catches aliases and renames, not merely equal declaration strings. */
export function nativeDirectoriesOverlap(left: number, right: number): boolean {
  const a = directoryAncestry(left);
  const b = directoryAncestry(right);
  return a.includes(b[0]!) || b.includes(a[0]!);
}

function digestFile(fd: number, bytes: number): string {
  if (fstatSync(fd).size !== bytes) throw new Error("native_transfer_length_mismatch");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(NATIVE_TRANSFER_MAX_CHUNK_BYTES, Math.max(1, bytes)));
  let offset = 0;
  while (offset < bytes) {
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - offset), offset);
    if (!n) throw new Error("native_transfer_short_read");
    hash.update(buffer.subarray(0, n));
    offset += n;
  }
  return hash.digest("hex");
}

/** Owner-side state and recovery. No transfer is a job or a bearer-token byte channel. */
export class NativeTransferOwner {
  private readonly live = new Map<string, LiveTransfer>();
  constructor(private readonly options: NativeTransferOwnerOptions) {}

  recover(): void {
    for (const record of this.options.journal.nativeTransfers()) {
      if (record.binding.request.mode === "read") {
        // Snapshot payloads are anonymous and the old owner/helper descriptions are gone.
        // No pathname publication can be ambiguous for a read.
        if (ACTIVE[record.status.state] || record.reservedBytes > 0)
          this.options.journal.append({
            kind: "native_transfer",
            transfer: {
              ...record,
              reservedBytes: 0,
              updatedAt: Date.now(),
              status: {
                ...record.status,
                state: "cancelled",
                receipt: undefined,
                reason: "native_transfer_owner_restart",
              },
            },
          });
        continue;
      }
      if (!ACTIVE[record.status.state] && record.status.state !== "outcome_unknown") continue;
      const live = this.retain(record);
      try {
        live.root = this.openRoot(record.binding, false);
        if (fileIdentity(live.root.fd) !== record.rootIdentity)
          throw new Error("native_transfer_root_changed");
        if (record.commitPermit) this.reconcileCommit(live);
        else this.finish(live, "cancelled", "native_transfer_owner_restart");
      } catch {
        this.unknown(live, "native_transfer_recovery_unknown");
      }
    }
    this.collect();
  }

  get idle(): boolean {
    return ![...this.live.values()].some((live) => live.busy || ACTIVE[live.record.status.state]);
  }

  /** Called before a job can receive even read-only access to private transfer staging. */
  assertLocationAvailable(fd: number, parentFd?: number): void {
    const directory = fstatSync(fd).isDirectory() ? fd : parentFd;
    if (directory === undefined) throw new Error("native_transfer_location_parent_missing");
    for (const live of this.live.values()) {
      if (
        live.record.binding.request.mode === "put" &&
        live.root &&
        nativeDirectoriesOverlap(live.root.fd, directory)
      )
        throw new Error("native_transfer_location_busy");
    }
  }

  assertCreateAvailable(parentFd: number): void {
    const ancestors = directoryAncestry(parentFd);
    for (const live of this.live.values())
      if (
        live.record.binding.request.mode === "put" &&
        live.record.rootIdentity &&
        ancestors.includes(live.record.rootIdentity)
      )
        throw new Error("native_transfer_location_busy");
  }

  hasUnknown(pluginId: string): boolean {
    for (const record of this.options.journal.nativeTransfers())
      if (record.binding.pluginId === pluginId && record.status.state === "outcome_unknown")
        return true;
    return false;
  }

  invalidate(pluginId?: string): void {
    for (const live of [...this.live.values()])
      if (
        (!pluginId || live.record.binding.pluginId === pluginId) &&
        ACTIVE[live.record.status.state]
      )
        this.finish(live, "cancelled", "native_transfer_authority_changed");
  }

  close(): Promise<void> {
    this.invalidate();
    const finish = () => {
      for (const live of this.live.values()) this.release(live);
      this.live.clear();
    };
    const pending = [...this.live.values()]
      .filter((live) => live.busy)
      .map((live) => live.readFinished!);
    if (pending.length) return Promise.all(pending).then(finish);
    finish();
    return Promise.resolve();
  }

  /** Recheck at the asynchronous owner/channel handoff, not only before doing the work. */
  deliveryRefusal(command: TransferCommand, seat: AbortSignal): NativeTransferReason | null {
    const request = command.request;
    const binding =
      "binding" in request
        ? request.binding
        : this.options.journal.nativeTransfer(request.transferId)?.binding;
    try {
      if (!binding) throw new Error("native_transfer_unknown");
      this.authorize(command, binding, seat);
      const live = this.live.get(binding.transferId);
      if (live && request.method !== "evidence") this.expire(live);
      if (
        request.method === "readChunk" &&
        this.options.journal.nativeTransfer(binding.transferId)?.status.state !== "ready"
      )
        throw new Error("native_transfer_not_readable");
      return null;
    } catch (error) {
      return this.reason(error);
    }
  }

  async execute(command: TransferCommand): Promise<NativeTransferResult> {
    const request = command.request;
    const id = "binding" in request ? request.binding.transferId : request.transferId;
    const seat = this.options.seat();
    let visible: RetainedNativeTransfer | undefined;
    let authenticated = false;
    try {
      if (request.method !== "evidence") this.collect();
      const binding =
        "binding" in request ? request.binding : this.options.journal.nativeTransfer(id)?.binding;
      if (!binding) throw new Error("native_transfer_unknown");
      this.authorize(command, binding, seat);
      visible = this.options.journal.nativeTransfer(id);
      if (visible && "binding" in request && jobDigest(visible.binding) !== jobDigest(binding))
        throw new Error("native_transfer_identity_changed");
      authenticated = true;
      // A signed observation can read only the exact retained journal. It neither reopens
      // staging nor expires/cancels/retries a publication after its effect authority is gone.
      if (request.method === "evidence") return { ok: true, status: visible!.status };
      if (
        visible &&
        visible.ownerGeneration !== this.options.journal.generation &&
        request.method !== "status" &&
        request.method !== "cancel"
      )
        throw new Error("native_transfer_owner_fenced");
      const retained = this.live.get(id);
      const expired = retained ? this.expire(retained) : false;
      if ("binding" in request) {
        if (visible) {
          if (retained && ACTIVE[retained.record.status.state]) this.assertRoot(retained);
          return {
            ok: true,
            status: this.publicStatus(
              retained?.record.status ?? this.options.journal.nativeTransfer(id)!.status,
            ),
          };
        }
        const live = this.begin(binding);
        if (binding.request.mode === "read") {
          live.busy = true;
          const finished = Promise.withResolvers<void>();
          live.readFinished = finished.promise;
          let source = -1;
          let snapshot: number | undefined;
          let parent: HeldDirectory | undefined;
          const abort = () => live.controller.abort();
          seat!.addEventListener("abort", abort, { once: true });
          try {
            parent = live.root!.reopen();
            for (const part of binding.request.relativePath.slice(0, -1)) {
              const next: HeldDirectory = parent.openChild(part);
              parent.close();
              parent = next;
            }
            source = parent.openFile(binding.request.relativePath.at(-1)!);
            const bytes = fstatSync(source).size;
            if (bytes > NATIVE_TRANSFER_MAX_FILE_BYTES)
              throw new Error("native_transfer_file_limit");
            this.reserve(live, bytes);
            snapshot = await stableNativeSnapshot(source, bytes, live.controller.signal);
            this.authorize(command, binding, seat);
            if (this.expire(live)) throw new Error("native_transfer_expired");
            if (!ACTIVE[live.record.status.state]) throw new Error("native_transfer_cancelled");
            this.assertRoot(live);
            const length = fstatSync(snapshot).size;
            if (length !== bytes) throw new Error("native_source_changed");
            const sha256 = digestFile(snapshot, bytes);
            this.progress(live, {
              status: {
                ...live.record.status,
                state: "ready",
                bytes,
                sha256,
                receipt: this.receipt(live, { bytes, sha256 }),
              },
            });
            live.fd = snapshot;
            snapshot = undefined;
          } catch (error) {
            if (ACTIVE[live.record.status.state]) {
              const reason = this.reason(error);
              this.finish(
                live,
                reason === "storage_capacity" ||
                  reason === "native_transfer_io_failed" ||
                  reason === "native_snapshot_failed" ||
                  reason === "native_transfer_failed" ||
                  reason === "native_snapshot_timeout"
                  ? "failed"
                  : "refused",
                reason,
              );
            }
            throw error;
          } finally {
            seat!.removeEventListener("abort", abort);
            live.busy = false;
            try {
              if (source >= 0) closeSync(source);
              if (snapshot !== undefined) closeSync(snapshot);
              parent?.close();
              if (
                !ACTIVE[live.record.status.state] &&
                live.record.status.state !== "outcome_unknown"
              ) {
                this.save(live, { reservedBytes: 0 });
                this.release(live);
                this.live.delete(id);
              }
            } finally {
              finished.resolve();
            }
          }
        }
        return { ok: true, status: this.publicStatus(live.record.status) };
      }
      const live = retained;
      if (request.method === "status") {
        if (live?.record.commitPermit && live.record.status.state === "outcome_unknown")
          this.reconcileCommit(live);
        else if (live && ACTIVE[live.record.status.state]) this.assertRoot(live);
        return {
          ok: true,
          status: this.publicStatus(
            live?.record.status ?? this.options.journal.nativeTransfer(id)!.status,
          ),
        };
      }
      if (request.method === "cancel") {
        if (live && ACTIVE[live.record.status.state])
          this.finish(live, "cancelled", "native_transfer_cancelled");
        return {
          ok: true,
          status: this.publicStatus(
            live?.record.status ?? this.options.journal.nativeTransfer(id)!.status,
          ),
        };
      }
      if (visible?.status.state === "committed" && request.method === "commitPut")
        return { ok: true, status: this.publicStatus(visible.status) };
      if (!live || !ACTIVE[live.record.status.state])
        throw new Error(expired ? "native_transfer_expired" : "native_transfer_not_active");
      if (live.busy) throw new Error("native_transfer_busy");
      this.assertRoot(live);
      switch (request.method) {
        case "putChunk": {
          if (
            binding.request.mode !== "put" ||
            live.record.status.state !== "receiving" ||
            live.fd === undefined
          )
            throw new Error("native_transfer_not_receiving");
          const data = Buffer.from(request.data, "base64");
          if (!data.length || data.length > NATIVE_TRANSFER_MAX_CHUNK_BYTES)
            throw new Error("native_transfer_chunk_limit");
          const sha256 = createHash("sha256").update(data).digest("hex");
          if (request.seq !== live.record.nextSeq || request.offset !== live.record.status.bytes) {
            const receipt = live.record.chunks.find((chunk) => chunk.seq === request.seq);
            if (
              !receipt ||
              receipt.offset !== request.offset ||
              receipt.bytes !== data.length ||
              receipt.sha256 !== sha256
            )
              throw new Error("native_transfer_chunk_sequence_mismatch");
            return { ok: true, status: this.publicStatus(live.record.status) };
          }
          if (request.offset + data.length > binding.request.source.bytes)
            throw new Error("native_transfer_length_mismatch");
          try {
            let written = 0;
            while (written < data.length) {
              const n = writeSync(
                live.fd,
                data,
                written,
                data.length - written,
                request.offset + written,
              );
              if (!n) throw new Error("native_transfer_short_write");
              written += n;
            }
            fsyncSync(live.fd);
            this.progress(live, {
              nextSeq: request.seq + 1,
              chunks: [
                ...live.record.chunks.slice(-3),
                { seq: request.seq, offset: request.offset, bytes: data.length, sha256 },
              ],
              status: { ...live.record.status, bytes: request.offset + data.length },
            });
          } catch (error) {
            if (ACTIVE[live.record.status.state]) this.finish(live, "failed", this.reason(error));
            throw error;
          }
          break;
        }
        case "preparePut": {
          if (binding.request.mode !== "put" || live.fd === undefined)
            throw new Error("native_transfer_not_put");
          if (live.record.status.state === "verifying") break;
          if (live.record.status.state !== "receiving")
            throw new Error("native_transfer_not_receiving");
          try {
            const source = binding.request.source;
            if (live.record.status.bytes !== source.bytes)
              throw new Error("native_transfer_length_mismatch");
            fsyncSync(live.fd);
            if (digestFile(live.fd, source.bytes) !== source.sha256)
              throw new Error("native_transfer_hash_mismatch");
            fchmodSync(live.fd, 0o400);
            fsyncSync(live.fd);
            this.progress(live, {
              prepared: {
                identity: fileIdentity(live.fd),
                bytes: source.bytes,
                sha256: source.sha256,
              },
              status: { ...live.record.status, state: "verifying", sha256: source.sha256 },
            });
          } catch (error) {
            if (ACTIVE[live.record.status.state]) this.finish(live, "failed", this.reason(error));
            throw error;
          }
          break;
        }
        case "commitPut": {
          if (
            binding.request.mode !== "put" ||
            live.record.status.state !== "verifying" ||
            !live.record.prepared
          )
            throw new Error("native_transfer_not_prepared");
          if (live.record.commitPermit) throw new Error("native_transfer_permit_consumed");
          for (const record of this.options.journal.nativeTransfers())
            if (record.commitPermit?.permitId === command.permit.body.permitId)
              throw new Error("native_transfer_permit_consumed");
          this.assertPrepared(live);
          if (this.expire(live)) throw new Error("native_transfer_expired");
          // The signed commit is the host's post-verification decision. Journal its consumption
          // and exact prepared inode before rename, with no await or authority gap in between.
          this.save(live, {
            commitPermit: {
              permitId: command.permit.body.permitId,
              commandDigest: command.permit.body.commandDigest,
            },
          });
          try {
            this.assertRoot(live);
            this.assertPrepared(live, false);
            this.authorize(command, binding, seat);
          } catch (error) {
            this.finish(live, "refused", this.reason(error));
            throw error;
          }
          let committed = false;
          try {
            live.root!.publish(live.record.temporary!, binding.request.filename, true);
            const receipt = this.receipt(live);
            this.save(live, {
              reservedBytes: 0,
              status: { ...live.record.status, state: "committed", receipt },
            });
            committed = true;
          } catch (error) {
            if (error instanceof ExclusivePublicationError)
              this.finish(live, error.code === "EEXIST" ? "refused" : "failed", this.reason(error));
            else this.unknown(live, "native_transfer_publication_unknown");
          }
          if (committed) {
            this.release(live);
            this.live.delete(id);
          }
          break;
        }
        case "readChunk": {
          if (
            binding.request.mode !== "read" ||
            live.record.status.state !== "ready" ||
            live.fd === undefined
          )
            throw new Error("native_transfer_not_readable");
          if (
            request.offset > live.record.status.bytes ||
            request.maxBytes < 1 ||
            request.maxBytes > NATIVE_TRANSFER_MAX_CHUNK_BYTES
          )
            throw new Error("native_transfer_read_range");
          const length = Math.min(request.maxBytes, live.record.status.bytes - request.offset);
          const data = Buffer.allocUnsafe(length);
          let read = 0;
          while (read < length) {
            const n = readSync(live.fd, data, read, length - read, request.offset + read);
            if (!n) throw new Error("native_transfer_short_read");
            read += n;
          }
          this.authorize(command, binding, seat);
          if (this.expire(live)) throw new Error("native_transfer_expired");
          const end = request.offset + length;
          if (length > 0 && end > live.record.readHighWaterOffset)
            this.progress(live, { readHighWaterOffset: end });
          return {
            ok: true,
            status: this.publicStatus(live.record.status),
            data: data.toString("base64"),
            offset: request.offset,
            eof: request.offset + length === live.record.status.bytes,
          };
        }
      }
      return { ok: true, status: this.publicStatus(live.record.status) };
    } catch (error) {
      const status = authenticated
        ? (this.live.get(id)?.record.status ?? this.options.journal.nativeTransfer(id)?.status)
        : undefined;
      return {
        ok: false,
        reason: this.reason(error),
        ...(status ? { status: this.publicStatus(status) } : {}),
      };
    }
  }

  private authorize(
    command: TransferCommand,
    binding: NativeTransferBinding,
    seat: AbortSignal | null,
  ): void {
    const body = command.permit.body;
    const now = Date.now();
    if (!seat || seat.aborted || seat !== this.options.seat())
      throw new Error("native_transfer_seat_changed");
    if (!this.options.seatNonce() || body.seatNonce !== this.options.seatNonce())
      throw new Error("native_transfer_seat_changed");
    if (process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))
      throw new Error("native_transfer_platform_unsupported");
    if (
      body.transferId !== binding.transferId ||
      body.pluginId !== binding.pluginId ||
      body.actorId !== binding.actorId ||
      body.credentialBinding !== binding.credentialBinding ||
      body.machineId !== this.options.machineId ||
      binding.request.machineId !== this.options.machineId ||
      body.ownerId !== this.options.journal.ownerId ||
      body.ownerGeneration !== this.options.journal.generation ||
      body.commandDigest !== jobDigest(command.request)
    )
      throw new Error("native_transfer_permit_binding_mismatch");
    if (
      body.issuedAt > now ||
      body.expiresAt <= now ||
      body.expiresAt - body.issuedAt > NATIVE_TRANSFER_PERMIT_MS
    )
      throw new Error("native_transfer_permit_expired");
    if (
      !verify(
        null,
        Buffer.from(canonicalJobJson(body)),
        this.options.admissionKey,
        Buffer.from(command.permit.signature, "base64"),
      )
    )
      throw new Error("native_transfer_permit_invalid");
    if (command.request.method === "evidence") {
      const record = this.options.journal.nativeTransfer(binding.transferId);
      if (
        !record ||
        command.request.bindingDigest !== jobDigest(record.binding) ||
        command.request.ownerGeneration !== record.ownerGeneration ||
        record.ownerId !== this.options.journal.ownerId
      )
        throw new Error("native_transfer_identity_changed");
      return;
    }
    this.declaration(binding, true);
    if (
      this.options.draining() &&
      command.request.method !== "status" &&
      command.request.method !== "cancel"
    )
      throw new Error("native_transfer_owner_draining");
  }

  private declaration(binding: NativeTransferBinding, enabled: boolean): MachineLocation {
    const installed = this.options.installation(
      binding.pluginId,
      binding.request.installationRevision,
    );
    if (
      !installed ||
      (enabled && !installed.enabled) ||
      installed.command.artifactSha256 !== binding.request.artifactSha256
    )
      throw new Error("native_transfer_installation_changed");
    const machine = installed.command.machine;
    const declaration = machine.locations[binding.request.locationId];
    const rights = machine.transferPolicy?.locations[binding.request.locationId];
    if (
      !declaration ||
      declaration.revision !== binding.request.locationRevision ||
      !rights?.includes(binding.request.mode === "put" ? "create-child" : "read")
    )
      throw new Error("native_transfer_location_changed");
    if (!declaration.managed) {
      const expected = installed.command.resourceBindings?.anchors[declaration.anchor];
      if (!expected || this.options.anchorDigest(declaration.anchor) !== expected)
        throw new Error("native_transfer_anchor_changed");
    }
    return declaration;
  }

  private openRoot(binding: NativeTransferBinding, create: boolean): HeldDirectory {
    const declaration = this.declaration(binding, false);
    if (declaration.kind !== "directory" || declaration.temporary)
      throw new Error("native_transfer_location_invalid");
    if (declaration.managed)
      return resolveManagedTransferRoot(
        this.options.managedState,
        binding.pluginId,
        declaration,
        (fd) => this.options.outputs.assertCreateAllowed(fd),
        create && binding.request.mode === "put",
      );
    if (binding.request.mode === "put") throw new Error("native_transfer_managed_root_required");
    const anchor = this.options.anchors[declaration.anchor];
    if (!anchor) throw new Error("native_transfer_anchor_unavailable");
    const location = resolveJobLocation(
      anchor,
      binding.request.locationId,
      declaration,
      "read",
      this.options.exclusions,
    );
    if (!location.directory) {
      location.close();
      throw new Error("native_transfer_directory_required");
    }
    return location.directory;
  }

  private begin(binding: NativeTransferBinding): LiveTransfer {
    this.collect();
    const now = Date.now();
    if (binding.createdAt > now || binding.expiresAt <= now)
      throw new Error("native_transfer_expired");
    let count = 0;
    let active = 0;
    let actor = 0;
    for (const record of this.options.journal.nativeTransfers()) {
      count++;
      if (
        record.binding.pluginId === binding.pluginId &&
        record.binding.actorId === binding.actorId &&
        record.binding.request.requestId === binding.request.requestId
      )
        throw new Error("native_transfer_request_conflict");
      if (
        ACTIVE[record.status.state] ||
        record.status.state === "outcome_unknown" ||
        this.live.get(record.binding.transferId)?.busy
      ) {
        active++;
        if (record.binding.actorId === binding.actorId) actor++;
      }
    }
    if (count >= NATIVE_TRANSFER_MAX_RECEIPTS) throw new Error("native_transfer_receipt_capacity");
    if (active >= NATIVE_TRANSFER_MAX_ACTIVE || actor >= NATIVE_TRANSFER_MAX_PER_ACTOR)
      throw new Error("native_transfer_active_limit");
    const root = this.openRoot(binding, true);
    let live: LiveTransfer | undefined;
    try {
      this.options.assertRootAvailable(root.fd);
      this.options.outputs.assertCreateAllowed(root.fd);
      this.assertLocationAvailable(root.fd);
      const temporary =
        binding.request.mode === "put" ? `.native-transfer-${randomUUID()}` : undefined;
      const record: RetainedNativeTransfer = {
        binding,
        ownerId: this.options.journal.ownerId,
        ownerGeneration: this.options.journal.generation,
        status: {
          transferId: binding.transferId,
          mode: binding.request.mode,
          state: binding.request.mode === "put" ? "receiving" : "verifying",
          bytes: 0,
        },
        updatedAt: now,
        lastProgressAt: now,
        readHighWaterOffset: 0,
        nextSeq: 0,
        chunks: [],
        reservedBytes: 0,
        rootIdentity: fileIdentity(root.fd),
        ...(temporary ? { temporary } : {}),
      };
      live = this.retain(record);
      live.root = root;
      this.reserve(live, binding.request.mode === "put" ? binding.request.source.bytes : 0);
      if (temporary) {
        safeComponent(binding.request.mode === "put" ? binding.request.filename : "");
        live.fd = root.createFile(temporary);
        this.save(live, { temporaryIdentity: fileIdentity(live.fd) });
        root.sync();
      }
      this.schedule(live);
      return live;
    } catch (error) {
      if (live) {
        if (this.options.journal.nativeTransfer(binding.transferId)) {
          const reason = this.reason(error);
          this.finish(
            live,
            reason === "storage_capacity" ||
              reason === "native_transfer_io_failed" ||
              reason === "native_transfer_failed"
              ? "failed"
              : "refused",
            reason,
          );
        } else {
          this.release(live);
          this.live.delete(binding.transferId);
        }
      } else root.close();
      throw error;
    }
  }

  private reserve(live: LiveTransfer, bytes: number): void {
    let retained = 0;
    for (const record of this.options.journal.nativeTransfers())
      if (record.binding.transferId !== live.record.binding.transferId)
        retained += record.reservedBytes;
    if (
      bytes > NATIVE_TRANSFER_MAX_FILE_BYTES ||
      retained + bytes > NATIVE_TRANSFER_MAX_PRIVATE_BYTES
    )
      throw new Error("native_transfer_private_capacity");
    this.save(live, { reservedBytes: bytes });
  }

  private retain(record: RetainedNativeTransfer): LiveTransfer {
    const live: LiveTransfer = {
      record,
      root: undefined,
      fd: undefined,
      controller: new AbortController(),
      timer: undefined,
      busy: false,
      readFinished: undefined,
    };
    this.live.set(record.binding.transferId, live);
    return live;
  }

  private save(live: LiveTransfer, patch: Partial<RetainedNativeTransfer>): void {
    const record = { ...live.record, ...patch, updatedAt: Date.now() };
    this.options.journal.append({ kind: "native_transfer", transfer: record });
    live.record = record;
  }

  private progress(live: LiveTransfer, patch: Partial<RetainedNativeTransfer>): void {
    if (this.expire(live)) throw new Error("native_transfer_expired");
    this.save(live, { ...patch, lastProgressAt: Date.now() });
    this.schedule(live);
  }

  private assertRoot(live: LiveTransfer): void {
    if (!live.root) throw new Error("native_transfer_root_unavailable");
    const current = this.openRoot(live.record.binding, false);
    try {
      if (
        fileIdentity(current.fd) !== live.record.rootIdentity ||
        fileIdentity(live.root.fd) !== live.record.rootIdentity
      )
        throw new Error("native_transfer_root_changed");
      this.options.assertRootAvailable(current.fd);
      this.options.outputs.assertCreateAllowed(current.fd);
    } finally {
      current.close();
    }
  }

  private assertPrepared(live: LiveTransfer, verifyBytes = true): void {
    const prepared = live.record.prepared;
    if (!live.root || !prepared || !live.record.temporary)
      throw new Error("native_transfer_not_prepared");
    const fd = live.root.openFile(live.record.temporary);
    try {
      if (
        fileIdentity(fd) !== prepared.identity ||
        fstatSync(fd).size !== prepared.bytes ||
        (verifyBytes && digestFile(fd, prepared.bytes) !== prepared.sha256)
      )
        throw new Error("native_transfer_prepared_changed");
    } finally {
      closeSync(fd);
    }
  }

  private receipt(
    live: LiveTransfer,
    snapshot?: { bytes: number; sha256: string },
  ): NativeTransferReceipt {
    const { binding } = live.record;
    const prepared = snapshot ?? live.record.prepared;
    if (!prepared || !live.root) throw new Error("native_transfer_not_prepared");
    const rootPath = readlinkSync(live.root.procPath);
    const path = `${rootPath}/${binding.request.mode === "put" ? binding.request.filename : binding.request.relativePath.join("/")}`;
    if (
      !rootPath.startsWith("/") ||
      rootPath.endsWith(" (deleted)") ||
      Buffer.byteLength(path) > 4096
    )
      throw new Error("native_transfer_receipt_path_unavailable");
    return {
      transferId: binding.transferId,
      mode: binding.request.mode,
      requestId: binding.request.requestId,
      machineId: binding.request.machineId,
      installationRevision: binding.request.installationRevision,
      artifactSha256: binding.request.artifactSha256,
      locationId: binding.request.locationId,
      locationRevision: binding.request.locationRevision,
      pluginId: binding.pluginId,
      actorId: binding.actorId,
      credentialBinding: binding.credentialBinding,
      ownerId: live.record.ownerId,
      ownerGeneration: live.record.ownerGeneration,
      path,
      bytes: prepared.bytes,
      sha256: prepared.sha256,
      committedAt: Date.now(),
    };
  }

  private reconcileCommit(live: LiveTransfer): void {
    const record = live.record;
    if (!record.commitPermit || !record.prepared || record.binding.request.mode !== "put") return;
    try {
      this.assertRoot(live);
      const fd = live.root!.openFile(record.binding.request.filename);
      try {
        if (
          fileIdentity(fd) !== record.prepared.identity ||
          fstatSync(fd).size !== record.prepared.bytes ||
          digestFile(fd, record.prepared.bytes) !== record.prepared.sha256
        )
          throw new Error("native_transfer_publication_unknown");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      live.root!.sync();
      const receipt = this.receipt(live);
      this.save(live, {
        reservedBytes: 0,
        status: { ...record.status, state: "committed", reason: undefined, receipt },
      });
    } catch {
      this.unknown(live, "native_transfer_publication_unknown");
      return;
    }
    this.release(live);
    this.live.delete(record.binding.transferId);
  }

  private finish(
    live: LiveTransfer,
    state: "cancelled" | "refused" | "failed" | "expired",
    reason: NativeTransferReason,
  ): void {
    live.controller.abort();
    clearTimeout(live.timer);
    if (live.busy && live.record.binding.request.mode === "read") {
      // Cancellation does not free quota while a killed helper still owns its private memfd.
      // The beginRead finally block releases the charge only after child exit was observed.
      this.save(live, { status: { ...live.record.status, state, reason, receipt: undefined } });
      return;
    }
    try {
      if (live.record.temporary) {
        if (!live.root || fileIdentity(live.root.fd) !== live.record.rootIdentity)
          throw new Error("native_transfer_cleanup_unknown");
        let fd: number | undefined;
        try {
          fd = live.root.openFile(live.record.temporary);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (fd !== undefined) {
          try {
            if (fileIdentity(fd) !== live.record.temporaryIdentity)
              throw new Error("native_transfer_cleanup_unknown");
            live.root.unlink(live.record.temporary);
            live.root.sync();
          } finally {
            closeSync(fd);
          }
        }
      }
      // Unlinking does not reclaim an open receiving inode. Release our last payload
      // descriptor before appending the terminal journal record on the same full disk.
      if (live.fd !== undefined) {
        closeSync(live.fd);
        live.fd = undefined;
      }
      this.save(live, {
        reservedBytes: 0,
        status: { ...live.record.status, state, reason, receipt: undefined },
      });
    } catch {
      this.unknown(live, "native_transfer_cleanup_unknown");
      return;
    }
    this.release(live);
    this.live.delete(live.record.binding.transferId);
  }

  private unknown(live: LiveTransfer, reason: NativeTransferReason): void {
    live.controller.abort();
    clearTimeout(live.timer);
    if (live.fd !== undefined) {
      closeSync(live.fd);
      live.fd = undefined;
    }
    if (live.record.status.state !== "outcome_unknown" || live.record.status.reason !== reason) {
      const status: NativeTransferStatus = {
        ...live.record.status,
        state: "outcome_unknown",
        reason,
        receipt: undefined,
      };
      try {
        this.save(live, { status });
      } catch (error) {
        // Consumption was already durable. Even a failed result append cannot reopen commit
        // in this process; restart reconciles that consumed record against the prepared inode.
        live.record = { ...live.record, status };
        throw error;
      }
    }
  }

  private release(live: LiveTransfer): void {
    live.controller.abort();
    clearTimeout(live.timer);
    if (live.fd !== undefined) {
      closeSync(live.fd);
      live.fd = undefined;
    }
    live.root?.close();
    live.root = undefined;
  }

  private expire(live: LiveTransfer): boolean {
    if (
      ACTIVE[live.record.status.state] &&
      Date.now() >=
        Math.min(
          live.record.binding.expiresAt,
          live.record.lastProgressAt + NATIVE_TRANSFER_IDLE_MS,
        )
    ) {
      this.finish(live, "expired", "native_transfer_expired");
      return true;
    }
    return false;
  }

  private schedule(live: LiveTransfer): void {
    clearTimeout(live.timer);
    const remaining =
      Math.min(
        live.record.binding.expiresAt,
        live.record.lastProgressAt + NATIVE_TRANSFER_IDLE_MS,
      ) - Date.now();
    live.timer = setTimeout(
      () => {
        try {
          if (ACTIVE[live.record.status.state])
            this.finish(live, "expired", "native_transfer_expired");
        } catch {
          live.controller.abort();
        }
      },
      Math.max(0, remaining),
    );
    live.timer.unref();
  }

  private collect(): void {
    const before = Date.now() - NATIVE_TRANSFER_RECEIPT_RETENTION_MS;
    for (const record of this.options.journal.nativeTransfers())
      if (
        !ACTIVE[record.status.state] &&
        record.status.state !== "outcome_unknown" &&
        record.reservedBytes === 0 &&
        !this.live.get(record.binding.transferId)?.busy &&
        record.updatedAt <= before
      )
        this.options.journal.append({
          kind: "native_transfer_forget",
          transferId: record.binding.transferId,
        });
  }

  private publicStatus(status: NativeTransferStatus): NativeTransferStatus {
    return status.state === "outcome_unknown" ? { ...status, reason: "outcome_unknown" } : status;
  }

  private reason(error: unknown): NativeTransferReason {
    const message = error instanceof Error ? error.message : "";
    const named = NativeTransferReasonSchema.safeParse(message);
    if (named.success) return named.data;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return "native_transfer_source_missing";
    if (code === "EEXIST") return "destination_exists";
    if (code === "ENOSPC" || code === "EDQUOT") return "storage_capacity";
    if (code === "EFBIG") return "native_transfer_file_limit";
    if (code === "EIO" || code === "EROFS") return "native_transfer_io_failed";
    if (code === "EAGAIN" || code === "EWOULDBLOCK") return "native_source_writer_active";
    if (message === "create_location_writer_active") return "native_transfer_job_location_busy";
    if (
      message === "unsafe_file_identity" ||
      message === "unsafe_file_component" ||
      message === "mount_escape" ||
      message === "private_owner_source_overlap" ||
      message === "invalid_transfer_location" ||
      message === "transfer_root_not_private" ||
      code === "ELOOP" ||
      code === "ENOTDIR" ||
      code === "EACCES"
    )
      return "native_transfer_location_invalid";
    return "native_transfer_failed";
  }
}
