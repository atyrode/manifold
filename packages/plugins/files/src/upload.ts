import type { PortableHostServices } from "@manifold/plugin";
import {
  ByteTransferError,
  type LocalFileDescriptor,
  type PluginOwnedRef,
} from "@manifold/protocol";
import {
  BeginFileUploadInputSchema,
  createFileRequestId,
  FILE_CHUNK_BYTES,
  FILE_COLLECTION,
  FILES_ID,
  FileDescriptorSchema,
  FileRequestSchema,
  FileTransferSchema,
  type BeginFileUploadInput,
  type FileDescriptor,
  type FileTransfer,
} from "./contract.ts";
import { fileAction, fileFailure, FilesActionError } from "./browser-actions.ts";

export interface UploadSnapshot {
  readonly phase:
    | "pending"
    | "uploading"
    | "publishing"
    | "paused"
    | "saved"
    | "refused"
    | "cancelled"
    | "outcome_unknown";
  readonly requestId: string;
  readonly selection: LocalFileDescriptor;
  readonly transfer: FileTransfer | null;
  readonly savedRef: PluginOwnedRef | null;
  readonly file: FileDescriptor | null;
  readonly reason: string | null;
  readonly busy: boolean;
}

/** One mounted local selection, one immutable intent, and at most one unacknowledged chunk. */
export class FileUploadController {
  private readonly input: BeginFileUploadInput;
  private snapshot: UploadSnapshot;
  private readonly listeners = new Set<() => void>();
  private running: Promise<FileDescriptor | null> | null = null;
  private aborter: AbortController | null = null;
  private cancelRequested = false;
  private disposed = false;
  private suspended = false;
  private mountGeneration = 0;
  private released = false;
  private begun = false;

  constructor(
    private readonly host: PortableHostServices,
    selection: LocalFileDescriptor,
    purpose: "file" | "image",
  ) {
    this.input = BeginFileUploadInputSchema.parse({
      collection: FILE_COLLECTION,
      requestId: createFileRequestId(),
      name: selection.name || "file",
      declaredMediaType: selection.mediaType || null,
      bytes: selection.bytes,
      purpose,
    });
    this.snapshot = {
      phase: "pending",
      requestId: this.input.requestId,
      selection,
      transfer: null,
      savedRef: null,
      file: null,
      reason: null,
      busy: false,
    };
  }

  getSnapshot = (): UploadSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Acquire this controller for one committed React mount. */
  mount(): () => void {
    const generation = ++this.mountGeneration;
    this.suspended = false;
    return () => {
      if (this.mountGeneration !== generation) return;
      // Stop entry points and notifications in cleanup, before any promise can settle.
      this.suspended = true;
      this.aborter?.abort();
      if (
        this.begun ||
        this.snapshot.busy ||
        this.cancelRequested ||
        this.snapshot.phase !== "pending"
      ) {
        this.dispose();
        return;
      }
      // Only pristine custody can survive same-commit StrictMode effect replay.
      // Work that has started is never resurrected, even if React reacquires the mount.
      queueMicrotask(() => {
        if (this.mountGeneration === generation) this.dispose();
      });
    };
  }

  private update(patch: Partial<UploadSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (!this.disposed && !this.suspended) for (const listener of this.listeners) listener();
  }

  private check(): void {
    if (this.disposed || this.suspended || this.cancelRequested || this.aborter?.signal.aborted) {
      throw new FilesActionError(
        "Stopped locally; server cancellation is not yet confirmed.",
        true,
      );
    }
  }

  private async release(): Promise<void> {
    if (this.released) return;
    await this.host.localFiles.release(this.snapshot.selection.handle);
    this.released = true;
  }

  private async descriptor(): Promise<FileDescriptor | null> {
    const ref = this.snapshot.savedRef;
    if (!ref) return null;
    const file = await fileAction(this.host, "inspect", { ref }, FileDescriptorSchema);
    this.update({ phase: "saved", file, reason: null });
    return file;
  }

  private recordFailure(error: unknown): void {
    const uncertain =
      error instanceof FilesActionError ? error.uncertain : !(error instanceof ByteTransferError);
    this.update({
      phase: this.snapshot.savedRef ? "saved" : uncertain ? "outcome_unknown" : "refused",
      reason: fileFailure(error),
    });
  }

  /** An explicit Save/Retry gesture. Never creates a replacement request or transfer. */
  save(): Promise<FileDescriptor | null> {
    if (this.running) return this.running;
    if (
      this.disposed ||
      this.suspended ||
      this.cancelRequested ||
      this.snapshot.busy ||
      this.snapshot.phase === "cancelled"
    )
      return Promise.resolve(null);
    this.aborter = new AbortController();
    this.update({ busy: true, reason: null });
    this.running = this.run()
      .catch((error: unknown) => {
        this.recordFailure(error);
        return null;
      })
      .finally(() => {
        this.running = null;
        this.aborter = null;
        this.update({ busy: false });
      });
    return this.running;
  }

  private async run(): Promise<FileDescriptor | null> {
    if (this.snapshot.savedRef) return this.descriptor();
    this.check();
    this.update({ phase: "uploading" });
    this.begun = true;
    let transfer = this.snapshot.transfer
      ? await fileAction(
          this.host,
          "inspectUpload",
          { collection: FILE_COLLECTION, transferId: this.snapshot.transfer.transferId },
          FileTransferSchema,
        )
      : await fileAction(this.host, "beginUpload", this.input, FileTransferSchema);
    this.update({ transfer });
    this.check();
    if (transfer.kind !== "upload" || transfer.bytes !== this.input.bytes)
      throw new FilesActionError("Invalid upload receipt.", true);
    if (!["receiving", "verifying", "ready"].includes(transfer.state)) {
      throw new FilesActionError(
        transfer.reason ??
          `Upload is ${transfer.state}; it has not been published by this response.`,
      );
    }
    while (transfer.state === "receiving" && transfer.offset < transfer.bytes) {
      this.check();
      if (Date.now() >= transfer.expiresAt) throw new FilesActionError("expired");
      const length = Math.min(FILE_CHUNK_BYTES, transfer.bytes - transfer.offset);
      if (transfer.offset !== transfer.sequence * FILE_CHUNK_BYTES)
        throw new FilesActionError("Invalid upload geometry.", true);
      const data = await this.host.localFiles.read(
        this.snapshot.selection.handle,
        transfer.offset,
        length,
        { signal: this.aborter!.signal },
      );
      this.check();
      if (data.byteLength !== length)
        throw new FilesActionError("Local file selection is unavailable or changed.");
      const receipt = await this.host.client.writeByteChunk(
        FILES_ID,
        "upload",
        {
          transferId: transfer.transferId,
          ref: FILE_COLLECTION,
          offset: transfer.offset,
          sequence: transfer.sequence,
          length,
        },
        data,
        this.aborter!.signal,
      );
      if (
        receipt.offset !== transfer.offset + length ||
        receipt.sequence !== transfer.sequence ||
        receipt.acceptedBytes !== length
      ) {
        throw new FilesActionError("Upload acknowledgement could not be verified.", true);
      }
      transfer = { ...transfer, offset: receipt.offset, sequence: transfer.sequence + 1 };
      this.update({ transfer });
      // Refresh the accepted-progress deadline from the authoritative row, not the local clock.
      transfer = await fileAction(
        this.host,
        "inspectUpload",
        { collection: FILE_COLLECTION, transferId: transfer.transferId },
        FileTransferSchema,
      );
      this.update({ transfer });
    }
    this.check();
    if (
      transfer.offset !== transfer.bytes ||
      !["receiving", "verifying", "ready"].includes(transfer.state)
    ) {
      throw new FilesActionError(
        transfer.reason ?? `Upload is ${transfer.state}; publication was not requested.`,
      );
    }
    this.update({ phase: "publishing" });
    const { ref } = await fileAction(
      this.host,
      "completeUpload",
      { collection: FILE_COLLECTION, transferId: transfer.transferId },
      FileRequestSchema,
    );
    // Publication is confirmed even if a subsequent metadata read loses authority.
    this.update({ phase: "saved", savedRef: ref });
    await this.release();
    if (this.disposed || this.suspended) return null;
    return this.descriptor();
  }

  /** Read-only reconciliation. A ready private payload is not a publication acknowledgement. */
  async reconcile(): Promise<FileDescriptor | null> {
    if (this.running || this.snapshot.busy || this.disposed || this.suspended) return null;
    this.update({ busy: true, reason: null });
    try {
      if (this.snapshot.savedRef) return await this.descriptor();
      if (!this.snapshot.transfer) {
        this.update({
          reason:
            "No transfer acknowledgement. Retry the exact save request to recover it; no new intent is generated.",
        });
        return null;
      }
      const transfer = await fileAction(
        this.host,
        "inspectUpload",
        { collection: FILE_COLLECTION, transferId: this.snapshot.transfer.transferId },
        FileTransferSchema,
      );
      this.update({
        transfer,
        phase:
          transfer.state === "cancelled"
            ? "cancelled"
            : ["failed", "expired", "deleted"].includes(transfer.state)
              ? "refused"
              : "paused",
        reason:
          transfer.reason ??
          (transfer.state === "ready"
            ? "Bytes are ready; publication is unconfirmed. Retry the exact Save to reconcile publication."
            : `Upload is ${transfer.state}.`),
      });
      if (["cancelled", "expired", "deleted"].includes(transfer.state)) await this.release();
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.update({ busy: false });
    }
    return null;
  }

  /** Stops local work immediately, then asks the original server operation to cancel. */
  async cancel(): Promise<void> {
    if (this.cancelRequested || this.disposed || this.suspended) return;
    this.cancelRequested = true;
    this.aborter?.abort();
    await this.running;
    this.update({ busy: true });
    try {
      if (!this.snapshot.savedRef && !this.snapshot.transfer && this.begun) {
        // Recover the same begin acknowledgement solely to cancel; never send or publish bytes.
        const transfer = await fileAction(this.host, "beginUpload", this.input, FileTransferSchema);
        this.update({ transfer });
      }
      if (this.snapshot.savedRef) {
        this.update({
          phase: "saved",
          reason:
            "Already saved. Cancellation cannot delete a published file; use the separate logical deletion control.",
        });
      } else if (this.snapshot.transfer) {
        const transfer = await fileAction(
          this.host,
          "cancelUpload",
          { collection: FILE_COLLECTION, transferId: this.snapshot.transfer.transferId },
          FileTransferSchema,
        );
        this.update({
          transfer,
          phase: ["cancelled", "failed", "expired", "deleted"].includes(transfer.state)
            ? "cancelled"
            : "outcome_unknown",
          reason: ["cancelled", "failed", "expired", "deleted"].includes(transfer.state)
            ? "Incomplete upload closed; no logical file deletion requested."
            : "Cancellation is unconfirmed. Reconcile the original transfer.",
        });
      } else
        this.update({
          phase: "cancelled",
          reason: "Local selection discarded; nothing was uploaded.",
        });
      if (this.snapshot.phase === "cancelled" || this.snapshot.savedRef) await this.release();
    } catch (error) {
      this.recordFailure(error);
    } finally {
      this.cancelRequested = false;
      this.update({ busy: false });
    }
  }

  /** Unmount closes local custody only; it never silently publishes or deletes a server file. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.aborter?.abort();
    this.listeners.clear();
    void this.release().catch(() => {
      /* The host also closes all mount-owned handles on teardown. */
    });
  }
}
