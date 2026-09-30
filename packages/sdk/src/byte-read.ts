import {
  BYTE_READ_LEASE_MS, BYTE_REQUEST_TIMEOUT_MS, ByteReadChunkSchema, ByteTransferError,
  MAX_BYTE_CHUNK_BYTES, MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILES,
  type ByteCarrierRequest, type ByteDownloadSource, type ByteReadChunk, type ByteRefusal,
} from "@manifold/protocol";

/** Structural session slice: never constructs another client or captures a bearer. */
export interface ByteReadClient {
  readByteChunk(pluginId: string, carrierId: string, request: ByteCarrierRequest, signal?: AbortSignal): Promise<ByteReadChunk>;
  readonly status: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  on(event: "status", listener: (status: ByteReadClient["status"]) => void): () => void;
}

// Shared across all mounts and both projections and downloads. Blob creation may copy
// the admitted buffer once; carrier scratch is at most one chunk per admitted reader.
let retained = 0;
let retainedBytes = 0;
export function reserveByteRead(bytes: number): () => void {
  if (retained >= MAX_LOCAL_FILES || retainedBytes + bytes > MAX_LOCAL_FILES * MAX_LOCAL_FILE_BYTES)
    throw new ByteTransferError("busy");
  retained += 1;
  retainedBytes += bytes;
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    retained -= 1;
    retainedBytes -= bytes;
  };
}

/** One ordered, exact-geometry read and its renewable local authority lease. */
export class ByteReadLease {
  private live = true;
  private offset = 0;
  private sequence = 0;
  private leaseDeadline = 0;
  private acquisitionDeadline = Date.now() + 60_000;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | null = null;
  private readonly lifetime = new AbortController();
  private readonly offStatus: () => void;

  constructor(
    private readonly client: ByteReadClient,
    private readonly source: ByteDownloadSource,
    private readonly unavailable: (reason: ByteRefusal) => void,
  ) {
    this.offStatus = client.on("status", (status) => {
      if (status !== "open") this.fail("unavailable");
    });
    this.armExpiry();
  }

  get deadline(): number { return Math.min(this.leaseDeadline || Infinity, this.acquisitionDeadline); }

  current(): void {
    if (!this.live || this.client.status !== "open") throw new ByteTransferError("unavailable");
    if (Date.now() >= this.deadline) throw new ByteTransferError("expired");
  }

  close(): void {
    if (!this.live) return;
    this.live = false;
    clearTimeout(this.expiry);
    this.request?.abort(new ByteTransferError("cancelled"));
    this.lifetime.abort(new ByteTransferError("cancelled"));
    this.offStatus();
  }

  private fail(reason: ByteRefusal): void {
    if (!this.live) return;
    this.close();
    this.unavailable(reason);
  }

  private armExpiry(): void {
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.fail("expired"), Math.max(0, this.deadline - Date.now()));
  }

  /** Acquisition has a finite total deadline; a mounted image may then renew its lease. */
  finishAcquisition(): void {
    this.current();
    this.acquisitionDeadline = Infinity;
    this.armExpiry();
  }

  private async bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    const stopped = Promise.withResolvers<never>();
    const abort = (): void => stopped.reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    try { return await Promise.race([promise, stopped.promise]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  async read(length: number): Promise<Uint8Array> {
    this.current();
    if (this.request !== null || !Number.isInteger(length) || length < 0 || length > MAX_BYTE_CHUNK_BYTES ||
        length > this.source.bytes - this.offset || (length === 0 && this.offset !== this.source.bytes))
      throw new ByteTransferError("invalid");
    const controller = new AbortController();
    this.request = controller;
    const started = Date.now();
    const requestDeadline = started + BYTE_REQUEST_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(new ByteTransferError("request_timeout")), BYTE_REQUEST_TIMEOUT_MS);
    try {
      const response = ByteReadChunkSchema.parse(await this.bounded(this.client.readByteChunk(
        this.source.pluginId, this.source.carrierId,
        { transferId: this.source.transferId, ref: this.source.ref, offset: this.offset, sequence: this.sequence, length },
        controller.signal,
      ), controller.signal));
      this.current();
      if (controller.signal.aborted) throw new ByteTransferError("cancelled");
      if (Date.now() >= requestDeadline) throw new ByteTransferError("request_timeout");
      if (response.offset !== this.offset || response.data.byteLength !== length ||
          response.eof !== (this.offset + length === this.source.bytes)) throw new ByteTransferError("invalid");
      // Transit and queued delivery consume the lease too; late timers cannot extend it.
      this.leaseDeadline = started + Math.min(response.leaseMs, BYTE_READ_LEASE_MS);
      this.current();
      this.armExpiry();
      this.offset += length;
      if (length !== 0) this.sequence += 1;
      return response.data;
    } finally {
      clearTimeout(timeout);
      if (this.request === controller) this.request = null;
    }
  }

  /** null means a digest mismatch. Empty content still requires an authenticated read. */
  async acquire(progress?: (received: number, total: number) => void): Promise<Uint8Array<ArrayBuffer> | null> {
    this.current();
    const bytes = new Uint8Array(this.source.bytes);
    progress?.(0, this.source.bytes);
    if (bytes.length === 0) await this.read(0);
    while (this.offset < bytes.length) {
      const offset = this.offset;
      const data = await this.read(Math.min(MAX_BYTE_CHUNK_BYTES, bytes.length - offset));
      this.current();
      bytes.set(data, offset);
      progress?.(this.offset, bytes.length);
    }
    this.current();
    const digest = new Uint8Array(await this.bounded(crypto.subtle.digest("SHA-256", bytes), this.lifetime.signal));
    this.current();
    const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return sha256 === this.source.sha256 ? bytes : null;
  }
}
