import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import {
  ByteTransferError,
  MAX_BYTE_CHUNK_BYTES,
  type ByteCarrierRequest,
  type ByteDownloadSource,
  type ByteDownloadStatus,
  type ByteReadChunk,
} from "@manifold/protocol";
import {
  createByteDownloadHandle,
  sanitizeDownloadFilename,
  type ByteDownloadHandle,
} from "../src/byte-download.ts";
import type { ByteReadClient } from "../src/byte-read.ts";

const handles: ByteDownloadHandle[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  vi.advanceTimersByTime(60_001);
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function source(bytes: Uint8Array<ArrayBuffer>): Promise<ByteDownloadSource> {
  return {
    pluginId: "example.bytes",
    carrierId: "read",
    transferId: "transfer-one",
    ref: { kind: "file", fileId: "file-one" },
    bytes: bytes.length,
    sha256: Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex"),
  };
}
function clientFor(bytes: Uint8Array): ByteReadClient {
  return {
    status: "open",
    on: () => () => {},
    readByteChunk: async (_plugin, _carrier, request) => ({
      data: bytes.slice(request.offset, request.offset + request.length),
      offset: request.offset,
      eof: request.offset + request.length === bytes.length,
      leaseMs: 15_000,
    }),
  };
}
function observe() {
  const terminal = Promise.withResolvers<ByteDownloadStatus>();
  const statuses: ByteDownloadStatus[] = [];
  const handed: { url: string; filename: string }[] = [];
  return {
    terminal: terminal.promise,
    statuses,
    handed,
    observer: {
      handoff: (url: string, filename: string) => {
        handed.push({ url, filename });
      },
      change: (status: ByteDownloadStatus) => {
        statuses.push(status);
        if (status.state !== "downloading") terminal.resolve(status);
      },
    },
  };
}

test("empty content cannot become a download without authenticated carrier admission", async () => {
  const bytes = new Uint8Array();
  const result = observe();
  const requests: ByteCarrierRequest[] = [];
  handles.push(
    createByteDownloadHandle(
      {
        ...clientFor(bytes),
        readByteChunk: async (_plugin, _carrier, request) => {
          requests.push(request);
          throw new ByteTransferError("unavailable");
        },
      },
      await source(bytes),
      "empty.bin",
      result.observer,
    ),
  );
  expect(await result.terminal).toEqual({ state: "unavailable", reason: "unavailable" });
  expect(requests).toEqual([
    {
      transferId: "transfer-one",
      ref: { kind: "file", fileId: "file-one" },
      offset: 0,
      sequence: 0,
      length: 0,
    },
  ]);
  expect(result.handed).toEqual([]);
});

test("exact chunks and final current-authority continuation precede handoff of verified bytes", async () => {
  const bytes = new Uint8Array(MAX_BYTE_CHUNK_BYTES + 3);
  bytes.set([1, 2, 3], MAX_BYTE_CHUNK_BYTES);
  const original = clientFor(bytes);
  const requests: ByteCarrierRequest[] = [];
  const result = observe();
  const handle = createByteDownloadHandle(
    {
      ...original,
      readByteChunk: async (...args) => {
        requests.push(args[2]);
        return original.readByteChunk(...args);
      },
    },
    await source(bytes),
    "../payload.bin",
    result.observer,
  );
  handles.push(handle);
  expect(await result.terminal).toEqual({ state: "complete" });
  expect(requests.map(({ offset, sequence, length }) => ({ offset, sequence, length }))).toEqual([
    { offset: 0, sequence: 0, length: MAX_BYTE_CHUNK_BYTES },
    { offset: MAX_BYTE_CHUNK_BYTES, sequence: 1, length: 3 },
    { offset: bytes.length, sequence: 2, length: 0 },
  ]);
  expect(result.statuses).toEqual([
    { state: "downloading", received: 0, total: bytes.length },
    { state: "downloading", received: MAX_BYTE_CHUNK_BYTES, total: bytes.length },
    { state: "downloading", received: bytes.length, total: bytes.length },
    { state: "complete" },
  ]);
  const delivery = result.handed[0]!;
  expect(delivery.filename).toBe("_payload.bin");
  // A completed UI unmount cannot revoke the URL in the browser's click task.
  handle.close();
  const response = await fetch(delivery.url);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  vi.advanceTimersByTime(1001);
  await expect(fetch(delivery.url)).rejects.toThrow();
});

test("a digest mismatch or inconsistent EOF never dispatches browser bytes", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const expected = await source(bytes);
  for (const invalid of ["digest", "eof"] as const) {
    const result = observe();
    const client = clientFor(bytes);
    if (invalid === "eof")
      client.readByteChunk = async (...args) => ({
        ...(await clientFor(bytes).readByteChunk(...args)),
        eof: false,
      });
    handles.push(
      createByteDownloadHandle(
        client,
        invalid === "digest" ? { ...expected, sha256: "0".repeat(64) } : expected,
        "data.bin",
        result.observer,
      ),
    );
    expect(await result.terminal).toEqual({
      state: "unavailable",
      reason: invalid === "digest" ? "hash_mismatch" : "invalid",
    });
    expect(result.handed).toEqual([]);
  }
});

test("revocation after acquisition but before handoff refuses, including an empty file", async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array([7])]) {
    const result = observe();
    const client = clientFor(bytes);
    let reads = 0;
    handles.push(
      createByteDownloadHandle(
        {
          ...client,
          readByteChunk: async (...args) => {
            if (++reads === 2) throw new ByteTransferError("unavailable");
            return client.readByteChunk(...args);
          },
        },
        await source(bytes),
        "data.bin",
        result.observer,
      ),
    );
    expect(await result.terminal).toEqual({ state: "unavailable", reason: "unavailable" });
    expect(result.handed).toEqual([]);
  }
});

test("cancel and lifecycle disposal fence an uncooperative late carrier result", async () => {
  const bytes = new Uint8Array([7]);
  const expected = await source(bytes);
  for (const method of ["cancel", "close"] as const) {
    const result = observe();
    const started = Promise.withResolvers<AbortSignal>();
    const read = Promise.withResolvers<ByteReadChunk>();
    const handle = createByteDownloadHandle(
      {
        ...clientFor(bytes),
        readByteChunk: (_plugin, _carrier, _request, signal) => {
          started.resolve(signal!);
          return read.promise;
        },
      },
      expected,
      "data.bin",
      result.observer,
    );
    handles.push(handle);
    const signal = await started.promise;
    handle[method]();
    expect(signal.aborted).toBe(true);
    read.resolve({ data: bytes, offset: 0, eof: true, leaseMs: 15_000 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(result.handed).toEqual([]);
    expect(result.statuses).toEqual([
      { state: "downloading", received: 0, total: 1 },
      ...(method === "cancel" ? [{ state: "unavailable", reason: "cancelled" } as const] : []),
    ]);
  }
});

test("a delayed response cannot mint a fresh lease even before its timer runs", async () => {
  const bytes = new Uint8Array([4]);
  const expected = await source(bytes);
  const clock = Date.now();
  const result = observe();
  handles.push(
    createByteDownloadHandle(
      {
        ...clientFor(bytes),
        readByteChunk: async () => {
          spyOn(Date, "now").mockReturnValue(clock + 5001);
          return { data: bytes, offset: 0, eof: true, leaseMs: 5000 };
        },
      },
      expected,
      "data.bin",
      result.observer,
    ),
  );
  expect(await result.terminal).toEqual({ state: "unavailable", reason: "expired" });
  expect(result.handed).toEqual([]);
});

test("browser handoff failure revokes its URL and never announces completion", async () => {
  const result = observe();
  let attempted = "";
  handles.push(
    createByteDownloadHandle(
      clientFor(new Uint8Array()),
      await source(new Uint8Array()),
      "data.bin",
      {
        ...result.observer,
        handoff: (url) => {
          attempted = url;
          throw new Error("browser unavailable");
        },
      },
    ),
  );
  expect(await result.terminal).toEqual({ state: "unavailable", reason: "download_failed" });
  await expect(fetch(attempted)).rejects.toThrow();
});

test("aggregate active readers refuse excess admission and release on cancellation", async () => {
  const bytes = new Uint8Array();
  const expected = await source(bytes);
  const client = { ...clientFor(bytes), readByteChunk: () => new Promise<ByteReadChunk>(() => {}) };
  for (let count = 0; count < 4; count += 1)
    handles.push(createByteDownloadHandle(client, expected, "empty.bin", observe().observer));
  expect(() => createByteDownloadHandle(client, expected, "empty.bin", observe().observer)).toThrow(
    "busy",
  );
  handles[0]!.cancel();
  const admitted = observe();
  handles.push(
    createByteDownloadHandle(clientFor(bytes), expected, "empty.bin", admitted.observer),
  );
  expect(await admitted.terminal).toEqual({ state: "complete" });
});

test("filenames stay single-component, bounded UTF-8 and cannot spoof paths or device names", () => {
  expect(sanitizeDownloadFilename("../folder\\name\u0000\u202e.txt. ")).toBe("_folder_name__.txt");
  expect(sanitizeDownloadFilename("CON.txt")).toBe("download");
  expect(sanitizeDownloadFilename("... ")).toBe("download");
  const unicode = sanitizeDownloadFilename("😀".repeat(255));
  expect(new TextEncoder().encode(unicode).length).toBeLessThanOrEqual(255);
  expect(unicode).not.toContain("\ufffd");
});
