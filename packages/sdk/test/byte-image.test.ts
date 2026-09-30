import { afterEach, expect, spyOn, test, vi } from "bun:test";
import {
  ByteTransferError,
  type ByteCarrierRequest,
  type ByteReadChunk,
  type ByteImageSource,
  type ByteImageReason,
} from "@manifold/protocol";
import {
  createByteImageReadHandle,
  type ByteImageClient,
  type ByteImageReadHandle,
} from "../src/byte-image.ts";
import { inspectStaticRaster } from "../src/raster.ts";

const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
  ),
);
const handles: ByteImageReadHandle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function source(bytes = PNG): Promise<ByteImageSource> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    pluginId: "example.files",
    carrierId: "read",
    transferId: "read-one",
    ref: { kind: "file", fileId: "file-one" },
    bytes: bytes.length,
    sha256: Buffer.from(hash).toString("hex"),
    mediaType: "image/png",
  };
}
function clientFor(bytes = PNG): ByteImageClient {
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

test("renewal uses the completed next sequence and removes its projection before checking authority", async () => {
  const requests: ByteCarrierRequest[] = [];
  const reads = clientFor();
  const continuation = Promise.withResolvers<never>();
  const client: ByteImageClient = {
    ...reads,
    readByteChunk: async (...args) => {
      requests.push(args[2]);
      return args[2].length === 0 ? continuation.promise : reads.readByteChunk(...args);
    },
  };
  const ready = Promise.withResolvers<string>();
  const refused = Promise.withResolvers<ByteImageReason>();
  const revoked = spyOn(URL, "revokeObjectURL");
  let loading = 0;
  const handle = createByteImageReadHandle(client, await source(), {
    loading: () => {
      loading += 1;
    },
    ready: (url) => ready.resolve(url),
    unavailable: refused.resolve,
  });
  handles.push(handle);
  const first = await ready.promise;
  handle.recheck();
  expect(revoked).toHaveBeenCalledWith(first);
  expect(loading).toBe(2);
  expect(requests.at(-1)).toEqual({
    transferId: "read-one",
    ref: { kind: "file", fileId: "file-one" },
    offset: PNG.length,
    sequence: 1,
    length: 0,
  });
  continuation.reject(new ByteTransferError("unavailable"));
  expect(await refused.promise).toBe("unavailable");
});

test("local expiry retires a stalled renewal and ignores its eventual bytes", async () => {
  vi.useFakeTimers();
  const reads = clientFor();
  const continuation = Promise.withResolvers<ByteReadChunk>();
  const client: ByteImageClient = {
    ...reads,
    readByteChunk: (...args) =>
      args[2].length === 0 ? continuation.promise : reads.readByteChunk(...args),
  };
  const ready = Promise.withResolvers<void>();
  const refused = Promise.withResolvers<ByteImageReason>();
  let rendered = 0;
  handles.push(
    createByteImageReadHandle(client, await source(), {
      loading: () => {},
      ready: () => {
        rendered += 1;
        ready.resolve();
      },
      unavailable: refused.resolve,
    }),
  );
  await ready.promise;
  vi.advanceTimersByTime(15_001);
  expect(await refused.promise).toBe("expired");
  continuation.resolve({ offset: PNG.length, data: new Uint8Array(), eof: true, leaseMs: 15_000 });
  await Promise.resolve();
  await Promise.resolve();
  expect(rendered).toBe(1);
});

test("a digest mismatch never creates a browser URL", async () => {
  const create = spyOn(URL, "createObjectURL");
  const refused = Promise.withResolvers<ByteImageReason>();
  handles.push(
    createByteImageReadHandle(
      clientFor(),
      { ...(await source()), sha256: "0".repeat(64) },
      {
        loading: () => {},
        ready: () => {
          throw new Error("must not project tampered bytes");
        },
        unavailable: refused.resolve,
      },
    ),
  );
  expect(await refused.promise).toBe("hash_mismatch");
  expect(create).not.toHaveBeenCalled();
});

test("disconnect revokes an already-delivered URL without waiting for a file event", async () => {
  const ready = Promise.withResolvers<string>();
  const refused = Promise.withResolvers<ByteImageReason>();
  const revoked = spyOn(URL, "revokeObjectURL");
  let status: (status: ByteImageClient["status"]) => void = () => {};
  handles.push(
    createByteImageReadHandle(
      {
        ...clientFor(),
        on: (_event, listener) => {
          status = listener;
          return () => {};
        },
      },
      await source(),
      { loading: () => {}, ready: ready.resolve, unavailable: refused.resolve },
    ),
  );
  const url = await ready.promise;
  status("reconnecting");
  expect(await refused.promise).toBe("unavailable");
  expect(revoked).toHaveBeenCalledWith(url);
});

test("raster admission refuses animation, contradictory containers and dimension bombs before decode", () => {
  expect(inspectStaticRaster(PNG, "image/png")).toEqual({ width: 1, height: 1 });
  const bomb = new Uint8Array(PNG);
  new DataView(bomb.buffer).setUint32(16, 8192);
  new DataView(bomb.buffer).setUint32(20, 8192);
  expect(() => inspectStaticRaster(bomb, "image/png")).toThrow("unsupported_image");
  const apng = new Uint8Array(PNG.length + 20);
  apng.set(PNG.subarray(0, 33));
  new DataView(apng.buffer).setUint32(33, 8);
  apng.set(new TextEncoder().encode("acTL"), 37);
  apng.set(PNG.subarray(33), 53);
  expect(() => inspectStaticRaster(apng, "image/png")).toThrow("unsupported_image");
  expect(() => inspectStaticRaster(PNG, "image/jpeg")).toThrow("unsupported_image");
  expect(() => inspectStaticRaster(new TextEncoder().encode("<svg></svg>"), "image/png")).toThrow(
    "unsupported_image",
  );
  const trailing = new Uint8Array(PNG.length + 1);
  trailing.set(PNG);
  expect(() => inspectStaticRaster(trailing, "image/png")).toThrow("unsupported_image");
});
