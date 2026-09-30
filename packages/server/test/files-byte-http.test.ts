import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileRequestId, FILE_COLLECTION, FILE_CREATE, FILE_READ,
  FileDescriptorSchema, FileRequestSchema, FileTransferSchema, OpenFileReadResultSchema,
} from "@manifold-plugin/files/contract";
import {
  MAX_BYTE_CHUNK_BYTES, RestrictedGrantViewSchema, TokenGrantSchema, formatManifoldUri,
} from "@manifold/protocol";
import { invokeAction, readByteChunk, writeByteChunk } from "@manifold/sdk";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";

test("a real hardened Files reader survives restart and loses the next chunk when its share is revoked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-files-byte-http-"));
  const owner = randomBytes(32).toString("hex");
  const config = loadConfig({
    MANIFOLD_PORT: "0", MANIFOLD_DATA_DIR: "data", MANIFOLD_OWNER_KEY: owner,
    MANIFOLD_SPAWN_AGENT: "0", MANIFOLD_HARDENED_PLUGINS: "core.files",
  }, directory);
  let server: RunningServer | undefined;
  const connection = (token: string) => {
    if (!server) throw new Error("fixture server is not running");
    return { origin: server.publicUrl, token, timeoutMs: 15_000 };
  };
  const action = async (name: string, input: unknown, token = owner): Promise<unknown> => {
    const { outcome } = await invokeAction(connection(token), name, input);
    if (!outcome.ok) throw new Error(`${name}: ${outcome.denial.rule}: ${outcome.denial.message}`);
    return outcome.result;
  };
  try {
    server = await startServer({ config, logger: silentLogger, announce: false });
    await action("engine.plugins.setEnabled", { id: "core.files", enabled: true });
    const uploader = TokenGrantSchema.parse(await action("core.access.mint", {
      principal: { name: "File uploader" }, caps: ["containers:read"],
    }));
    const reader = TokenGrantSchema.parse(await action("core.access.mint", {
      principal: { name: "File reader" }, caps: ["containers:read"],
    }));
    await action("core.access.grant", {
      principal: { kind: "principal", id: uploader.principal.id },
      node: formatManifoldUri(FILE_COLLECTION), caps: [FILE_CREATE], effect: "allow", reach: "node",
    });
    const bytes = Uint8Array.from({ length: MAX_BYTE_CHUNK_BYTES + 13 }, (_, index) => index % 251);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const upload = FileTransferSchema.parse(await action("core.files.beginUpload", {
      collection: FILE_COLLECTION, requestId: createFileRequestId(), name: "private.bin",
      declaredMediaType: "application/octet-stream", bytes: bytes.byteLength,
      expectedSha256: digest, purpose: "file",
    }, uploader.token));
    for (let offset = 0, sequence = 0; offset < bytes.byteLength; sequence++) {
      const data = bytes.subarray(offset, offset + MAX_BYTE_CHUNK_BYTES);
      const receipt = await writeByteChunk(connection(uploader.token), "core.files", "upload", {
        transferId: upload.transferId, ref: FILE_COLLECTION, offset, sequence, length: data.byteLength,
      }, data);
      expect(receipt).toEqual({ offset: offset + data.byteLength, sequence, acceptedBytes: data.byteLength });
      offset += data.byteLength;
    }
    const { ref } = FileRequestSchema.parse(await action("core.files.completeUpload", {
      collection: FILE_COLLECTION, transferId: upload.transferId,
    }, uploader.token));
    const inspected = await Promise.all([
      action("core.files.inspect", { ref }, uploader.token),
      action("core.files.inspect", { ref }, uploader.token),
    ]);
    for (const result of inspected) {
      expect(FileDescriptorSchema.parse(result)).toMatchObject({
        ref, bytes: bytes.byteLength, sha256: digest,
      });
    }
    const share = RestrictedGrantViewSchema.parse(await action("core.files.share", {
      ref, principalId: reader.principal.id, caps: [FILE_READ], previousGrantId: null,
    }, uploader.token));
    await server.stop();
    server = undefined;
    server = await startServer({ config, logger: silentLogger, announce: false });
    const opened = OpenFileReadResultSchema.parse(await action("core.files.openRead", {
      ref, requestId: createFileRequestId(),
    }, reader.token));
    const received = new Uint8Array(bytes.byteLength);
    for (let offset = 0, sequence = 0; offset < received.byteLength; sequence++) {
      const length = Math.min(MAX_BYTE_CHUNK_BYTES, received.byteLength - offset);
      const chunk = await readByteChunk(connection(reader.token), "core.files", "read", {
        transferId: opened.transfer.transferId, ref, offset, sequence, length,
      });
      expect(chunk.eof).toBe(offset + length === received.byteLength);
      expect(chunk.data.byteLength).toBe(length);
      received.set(chunk.data, offset);
      offset += length;
    }
    expect(received).toEqual(bytes);
    expect(new Bun.CryptoHasher("sha256").update(received).digest("hex")).toBe(opened.file.sha256);
    const next = OpenFileReadResultSchema.parse(await action("core.files.openRead", {
      ref, requestId: createFileRequestId(),
    }, reader.token));
    const first = await readByteChunk(connection(reader.token), "core.files", "read", {
      transferId: next.transfer.transferId, ref, offset: 0, sequence: 0, length: MAX_BYTE_CHUNK_BYTES,
    });
    expect(first.data).toEqual(bytes.subarray(0, MAX_BYTE_CHUNK_BYTES));
    await action("core.files.unshare", { ref, grantId: share.grantId }, uploader.token);
    await expect(readByteChunk(connection(reader.token), "core.files", "read", {
      transferId: next.transfer.transferId, ref, offset: MAX_BYTE_CHUNK_BYTES, sequence: 1, length: 13,
    })).rejects.toMatchObject({ reason: "unavailable" });
  } finally {
    try { await server?.stop(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}, 60_000);
