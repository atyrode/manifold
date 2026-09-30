import {
  ByteImageSourceSchema, ByteTransferError, type ByteImageReason, type ByteImageSource,
} from "@manifold/protocol";
import { inspectStaticRaster } from "./raster.ts";
import { ByteReadLease, reserveByteRead, type ByteReadClient } from "./byte-read.ts";

/** Structural SessionHandle slice. This helper never constructs a client or holds a token. */
export interface ByteImageClient extends ByteReadClient {}
export interface ByteImageObserver {
  loading(): void;
  ready(url: string, expiresAt: number): void;
  unavailable(reason: ByteImageReason): void;
}
export interface ByteImageReadHandle {
  /** Clears the current projection BEFORE reacquiring authority. */
  recheck(): void;
  /** Revoke the URL and synchronously notify loading so decoded DOM is removed too. */
  close(): void;
  /** A host decoder may retire a structurally admitted but undecodable image. */
  refuse(reason: ByteImageReason): void;
}

export function createByteImageReadHandle(
  client: ByteImageClient,
  input: ByteImageSource,
  observer: ByteImageObserver,
): ByteImageReadHandle {
  const parsed = ByteImageSourceSchema.safeParse(input);
  if (!parsed.success) throw new ByteTransferError("invalid");
  const source = parsed.data;
  const release = reserveByteRead(source.bytes);
  let live = true;
  let blob: Blob | null = null;
  let url: string | null = null;

  let lease: ByteReadLease;
  const clearProjection = (): void => {
    if (url !== null) URL.revokeObjectURL(url);
    url = null;
    observer.loading();
  };
  const dispose = (): void => {
    live = false;
    clearTimeout(renewal);
    lease.close();
    blob = null;
    release();
    clearProjection();
  };
  const fail = (reason: ByteImageReason): void => {
    if (!live) return;
    dispose();
    observer.unavailable(reason);
  };
  try { lease = new ByteReadLease(client, source, fail); }
  catch (error) { release(); throw error; }
  let renewal: ReturnType<typeof setTimeout> | undefined;
  const reasonOf = (error: unknown): ByteImageReason =>
    error instanceof ByteTransferError ? error.reason : "invalid";
  const project = (): void => {
    lease.current();
    if (blob === null) throw new ByteTransferError("unavailable");
    url = URL.createObjectURL(blob);
    observer.ready(url, lease.deadline);
    clearTimeout(renewal);
    renewal = setTimeout(recheck, Math.max(1, Math.floor((lease.deadline - Date.now()) / 2)));
  };
  let checking = false;
  let recheckAfterLoad = false;
  const recheck = (): void => {
    if (!live || checking) return;
    if (blob === null) { recheckAfterLoad = true; return; }
    clearTimeout(renewal);
    clearProjection();
    checking = true;
    // Completion's retained receipt permits this exact zero-payload continuation. It does
    // not reopen a read, refresh progress or silently replay its audited lifecycle action.
    void lease.read(0).then(() => { if (live) project(); }).catch((error: unknown) => {
      fail(reasonOf(error));
    }).finally(() => { checking = false; });
  };
  const load = async (): Promise<void> => {
    observer.loading();
    const bytes = await lease.acquire();
    if (bytes === null) { fail("hash_mismatch"); return; }
    try { inspectStaticRaster(bytes, source.mediaType); }
    catch { fail("unsupported_image"); return; }
    lease.current();
    if (recheckAfterLoad) await lease.read(0);
    lease.current();
    blob = new Blob([bytes], { type: source.mediaType });
    lease.finishAcquisition();
    project();
  };
  queueMicrotask(() => { if (live) void load().catch((error: unknown) => fail(reasonOf(error))); });
  return {
    recheck,
    close() { if (live) dispose(); },
    refuse: fail,
  };
}
