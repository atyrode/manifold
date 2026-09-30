import {
  ByteDownloadSourceSchema,
  ByteTransferError,
  type ByteDownloadReason,
  type ByteDownloadSource,
  type ByteDownloadStatus,
} from "@manifold/protocol";
import { ByteReadLease, reserveByteRead, type ByteReadClient } from "./byte-read.ts";

export interface ByteDownloadObserver {
  /** Host-only synchronous browser handoff. Throw if it cannot be dispatched. */
  handoff(url: string, filename: string): void;
  change(status: ByteDownloadStatus): void;
}
export interface ByteDownloadHandle {
  /** Silent lifecycle disposal. Cannot retract a download already handed to the browser. */
  close(): void;
  cancel(): void;
}

/** A single bounded filename component, never a path or an untrusted MIME hint. */
export function sanitizeDownloadFilename(input: string): string {
  const clean = input
    .slice(0, 255)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  let name = "";
  let bytes = 0;
  for (const char of clean) {
    const point = char.codePointAt(0)!;
    const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + size > 255) break;
    bytes += size;
    name += char;
  }
  name = name.replace(/[. ]+$/, "");
  if (name === "" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return "download";
  return name;
}

/** Authenticated one-shot acquisition. Nothing is cached or published to a library. */
export function createByteDownloadHandle(
  client: ByteReadClient,
  input: ByteDownloadSource,
  filename: string,
  observer: ByteDownloadObserver,
): ByteDownloadHandle {
  const parsed = ByteDownloadSourceSchema.safeParse(input);
  if (!parsed.success || typeof filename !== "string") throw new ByteTransferError("invalid");
  const source = parsed.data;
  const name = sanitizeDownloadFilename(filename);
  const release = reserveByteRead(source.bytes);
  let live = true;
  let url: string | null = null;
  let lease: ByteReadLease;
  const cleanup = (): void => {
    if (url !== null) URL.revokeObjectURL(url);
    url = null;
    release();
  };
  const dispose = (): void => {
    if (!live) return;
    live = false;
    lease.close();
    cleanup();
  };
  const fail = (reason: ByteDownloadReason): void => {
    if (!live) return;
    dispose();
    observer.change({ state: "unavailable", reason });
  };
  try {
    lease = new ByteReadLease(client, source, fail);
  } catch (error) {
    release();
    throw error;
  }
  const load = async (): Promise<void> => {
    const bytes = await lease.acquire((received, total) =>
      observer.change({ state: "downloading", received, total }),
    );
    if (bytes === null) {
      fail("hash_mismatch");
      return;
    }
    // Reauthorize after hashing, including empty files. No timer, focus event, worker
    // turn, or product callback may intervene between this continuation and handoff.
    await lease.read(0);
    lease.current();
    try {
      url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      lease.current();
      observer.handoff(url, name);
    } catch (error) {
      fail(error instanceof ByteTransferError ? error.reason : "download_failed");
      return;
    }
    // The browser owns the dispatched download now. Teardown must not revoke its URL
    // in the click's task; give it a bounded consumption turn, never a retained cache.
    live = false;
    const cleanupDelay = Math.min(1000, Math.max(0, lease.deadline - Date.now()));
    lease.close();
    setTimeout(cleanup, cleanupDelay);
    observer.change({ state: "complete" });
  };
  queueMicrotask(() => {
    if (live)
      void load().catch((error: unknown) =>
        fail(error instanceof ByteTransferError ? error.reason : "invalid"),
      );
  });
  return { close: dispose, cancel: () => fail("cancelled") };
}
