import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { PluginDatabase } from "@manifold/plugin";
import {
  createFileRequestId,
  FILE_COLLECTION,
  FILE_CREATE,
  FILE_READ,
  FileDescriptorSchema,
  FileRequestSchema,
  FileTransferSchema,
  OpenFileReadResultSchema,
} from "@manifold-plugin/files/contract";
import {
  MAX_BYTE_CHUNK_BYTES,
  RestrictedGrantViewSchema,
  TokenGrantSchema,
  defaultRuntime,
  formatManifoldUri,
} from "@manifold/protocol";
import { invokeAction, readByteChunk, writeByteChunk } from "@manifold/sdk";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { PluginHost } from "../src/plugin-host.ts";

test("a real hardened Files reader survives restart and loses the next chunk when its share is revoked", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-files-byte-http-"));
  const owner = randomBytes(32).toString("hex");
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: owner,
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_HARDENED_PLUGINS: "core.files",
    },
    directory,
  );
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
    const uploader = TokenGrantSchema.parse(
      await action("core.access.mint", {
        principal: { name: "File uploader" },
        caps: ["containers:read"],
      }),
    );
    const reader = TokenGrantSchema.parse(
      await action("core.access.mint", {
        principal: { name: "File reader" },
        caps: ["containers:read"],
      }),
    );
    await action("core.access.grant", {
      principal: { kind: "principal", id: uploader.principal.id },
      node: formatManifoldUri(FILE_COLLECTION),
      caps: [FILE_CREATE],
      effect: "allow",
      reach: "node",
    });
    const bytes = Uint8Array.from({ length: MAX_BYTE_CHUNK_BYTES + 13 }, (_, index) => index % 251);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const upload = FileTransferSchema.parse(
      await action(
        "core.files.beginUpload",
        {
          collection: FILE_COLLECTION,
          requestId: createFileRequestId(),
          name: "private.bin",
          declaredMediaType: "application/octet-stream",
          bytes: bytes.byteLength,
          expectedSha256: digest,
          purpose: "file",
        },
        uploader.token,
      ),
    );
    for (let offset = 0, sequence = 0; offset < bytes.byteLength; sequence++) {
      const data = bytes.subarray(offset, offset + MAX_BYTE_CHUNK_BYTES);
      const receipt = await writeByteChunk(
        connection(uploader.token),
        "core.files",
        "upload",
        {
          transferId: upload.transferId,
          ref: FILE_COLLECTION,
          offset,
          sequence,
          length: data.byteLength,
        },
        data,
      );
      expect(receipt).toEqual({
        offset: offset + data.byteLength,
        sequence,
        acceptedBytes: data.byteLength,
      });
      offset += data.byteLength;
    }
    const { ref } = FileRequestSchema.parse(
      await action(
        "core.files.completeUpload",
        {
          collection: FILE_COLLECTION,
          transferId: upload.transferId,
        },
        uploader.token,
      ),
    );
    const inspected = await Promise.all([
      action("core.files.inspect", { ref }, uploader.token),
      action("core.files.inspect", { ref }, uploader.token),
    ]);
    for (const result of inspected) {
      expect(FileDescriptorSchema.parse(result)).toMatchObject({
        ref,
        bytes: bytes.byteLength,
        sha256: digest,
      });
    }
    for (const [path, body] of [
      [`/api/resolve?uri=${encodeURIComponent(formatManifoldUri(ref))}`, undefined],
      ["/api/actions/core.files.inspect", { ref }],
      ["/api/actions/core.files.list", {}],
    ] as const) {
      const response = await fetch(`${server.publicUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${uploader.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject(
        body === undefined
          ? { exists: true, title: "private.bin" }
          : path.endsWith("inspect")
            ? { ok: true, result: { ref, bytes: bytes.byteLength } }
            : { ok: true, result: { files: [{ ref, bytes: bytes.byteLength }], next: null } },
      );
    }
    const share = RestrictedGrantViewSchema.parse(
      await action(
        "core.files.share",
        {
          ref,
          principalId: reader.principal.id,
          caps: [FILE_READ],
          previousGrantId: null,
        },
        uploader.token,
      ),
    );
    await server.stop();
    server = undefined;
    server = await startServer({ config, logger: silentLogger, announce: false });
    const opened = OpenFileReadResultSchema.parse(
      await action(
        "core.files.openRead",
        {
          ref,
          requestId: createFileRequestId(),
        },
        reader.token,
      ),
    );
    const received = new Uint8Array(bytes.byteLength);
    for (let offset = 0, sequence = 0; offset < received.byteLength; sequence++) {
      const length = Math.min(MAX_BYTE_CHUNK_BYTES, received.byteLength - offset);
      const chunk = await readByteChunk(connection(reader.token), "core.files", "read", {
        transferId: opened.transfer.transferId,
        ref,
        offset,
        sequence,
        length,
      });
      expect(chunk.eof).toBe(offset + length === received.byteLength);
      expect(chunk.data.byteLength).toBe(length);
      received.set(chunk.data, offset);
      offset += length;
    }
    expect(received).toEqual(bytes);
    expect(new Bun.CryptoHasher("sha256").update(received).digest("hex")).toBe(opened.file.sha256);
    const next = OpenFileReadResultSchema.parse(
      await action(
        "core.files.openRead",
        {
          ref,
          requestId: createFileRequestId(),
        },
        reader.token,
      ),
    );
    const first = await readByteChunk(connection(reader.token), "core.files", "read", {
      transferId: next.transfer.transferId,
      ref,
      offset: 0,
      sequence: 0,
      length: MAX_BYTE_CHUNK_BYTES,
    });
    expect(first.data).toEqual(bytes.subarray(0, MAX_BYTE_CHUNK_BYTES));
    await action("core.files.unshare", { ref, grantId: share.grantId }, uploader.token);
    await expect(
      readByteChunk(connection(reader.token), "core.files", "read", {
        transferId: next.transfer.transferId,
        ref,
        offset: MAX_BYTE_CHUNK_BYTES,
        sequence: 1,
        length: 13,
      }),
    ).rejects.toMatchObject({ reason: "unavailable" });
    let refusal: { status: number; headers: Record<string, string>; body: string } | undefined;
    const conditions: readonly Record<string, string>[] = [
      {},
      { range: "bytes=0-12" },
      { "if-none-match": "*" },
      { "if-match": '"private"' },
      { "if-range": '"private"' },
      { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
      { "if-unmodified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
    ];
    for (const target of [ref, { kind: "file" as const, fileId: crypto.randomUUID() }]) {
      for (const condition of conditions) {
        const query = new URLSearchParams({
          transferId: next.transfer.transferId,
          ref: formatManifoldUri(target),
          offset: "0",
          sequence: "0",
          length: "13",
        });
        const response = await fetch(`${server.publicUrl}/api/bytes/core.files/read?${query}`, {
          headers: { authorization: `Bearer ${reader.token}`, ...condition },
        });
        const headers = Object.fromEntries(response.headers);
        delete headers.date;
        const result = { status: response.status, headers, body: await response.text() };
        expect(result.status).toBe(403);
        expect(result.body).toBe('{"error":"unavailable"}');
        expect(headers["cache-control"]).toBe("no-store");
        for (const name of [
          "etag",
          "last-modified",
          "content-range",
          "content-disposition",
          "x-manifold-byte-offset",
        ])
          expect(headers[name]).toBeUndefined();
        if (refusal === undefined) refusal = result;
        else expect(result).toEqual(refusal);
      }
    }
    const slow = FileTransferSchema.parse(
      await action(
        "core.files.beginUpload",
        {
          collection: FILE_COLLECTION,
          requestId: createFileRequestId(),
          name: "slow.bin",
          declaredMediaType: null,
          bytes: 3,
          purpose: "file",
        },
        uploader.token,
      ),
    );
    const query = new URLSearchParams({
      transferId: slow.transferId,
      ref: formatManifoldUri(FILE_COLLECTION),
      offset: "0",
      sequence: "0",
      length: "3",
    });
    const finished = Promise.withResolvers<{ status: number; body: string }>();
    const pending = httpRequest(
      `${server.publicUrl}/api/bytes/core.files/upload?${query}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${uploader.token}`,
          "content-type": "application/octet-stream",
          "transfer-encoding": "chunked",
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on("end", () => finished.resolve({ status: response.statusCode!, body }));
        response.on("error", finished.reject);
      },
    );
    pending.on("error", finished.reject);
    try {
      // This is deliberately a real clock/socket deadline: Bun's own idle timer must not win.
      pending.write(Uint8Array.of(1));
      expect(await finished.promise).toEqual({ status: 409, body: '{"error":"request_timeout"}' });
    } finally {
      pending.destroy();
    }
    expect(
      await writeByteChunk(
        connection(uploader.token),
        "core.files",
        "upload",
        {
          transferId: slow.transferId,
          ref: FILE_COLLECTION,
          offset: 0,
          sequence: 0,
          length: 3,
        },
        Uint8Array.of(1, 2, 3),
      ),
    ).toEqual({ offset: 3, sequence: 0, acceptedBytes: 3 });
    await action(
      "core.files.cancelUpload",
      {
        collection: FILE_COLLECTION,
        transferId: slow.transferId,
      },
      uploader.token,
    );
  } finally {
    try {
      await server?.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 60_000);

test("expired unpublished ready reservations reclaim host-first before replacement admission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-files-ready-admission-"));
  const owner = randomBytes(32).toString("hex");
  let now = Date.now();
  const runtime = { ...defaultRuntime, now: () => now };
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: owner,
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_HARDENED_PLUGINS: "core.files",
    },
    directory,
  );
  let server: RunningServer | undefined;
  let privateDb: Database | undefined;
  let mainDb: Database | undefined;
  let barrier:
    | {
        transferId: string;
        entered: PromiseWithResolvers<void>;
        resume: PromiseWithResolvers<void>;
      }
    | undefined;
  // Delay a real hardened database reply, not the owner implementation or its authority.
  const original = Reflect.get(PluginHost.prototype, "dataLease");
  Reflect.set(PluginHost.prototype, "dataLease", function (this: PluginHost, ...args: unknown[]) {
    const lease = Reflect.apply(original, this, args) as { database?: PluginDatabase };
    if (lease.database !== undefined) {
      const run = lease.database.run.bind(lease.database);
      lease.database.run = async (sql, params) => {
        const result = await run(sql, params);
        if (
          barrier !== undefined &&
          params?.[0] === barrier.transferId &&
          sql.startsWith("UPDATE file_transfers SET state='verifying'")
        ) {
          const waiting = barrier;
          waiting.entered.resolve();
          await waiting.resume.promise;
        }
        return result;
      };
    }
    return lease;
  });
  const connection = (token = owner) => {
    if (server === undefined) throw new Error("fixture server is not running");
    return { origin: server.publicUrl, token, timeoutMs: 15_000 };
  };
  const action = async (name: string, input: unknown, token = owner) => {
    const result = await invokeAction(connection(token), name, input);
    if (!result.outcome.ok) throw new Error(`${name}: ${result.outcome.denial.message}`);
    return result.outcome.result;
  };
  try {
    server = await startServer({ config, runtime, logger: silentLogger, announce: false });
    await action("engine.plugins.setEnabled", { id: "core.files", enabled: true });
    let actor = TokenGrantSchema.parse(
      await action("core.access.mint", {
        principal: { name: "Disposable verifier" },
        caps: ["containers:read"],
      }),
    );
    await action("core.access.grant", {
      principal: { kind: "principal", id: actor.principal.id },
      node: formatManifoldUri(FILE_COLLECTION),
      caps: [FILE_CREATE],
      effect: "allow",
      reach: "node",
    });
    const transfers: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const transfer = FileTransferSchema.parse(
        await action(
          "core.files.beginUpload",
          {
            collection: FILE_COLLECTION,
            requestId: createFileRequestId(now),
            name: "private.bin",
            declaredMediaType: null,
            bytes: 3,
            purpose: "file",
          },
          actor.token,
        ),
      );
      transfers.push(transfer.transferId);
      await writeByteChunk(
        connection(actor.token),
        "core.files",
        "upload",
        {
          transferId: transfer.transferId,
          ref: FILE_COLLECTION,
          offset: 0,
          sequence: 0,
          length: 3,
        },
        Uint8Array.of(1, 2, 3),
      );
      barrier = {
        transferId: transfer.transferId,
        entered: Promise.withResolvers<void>(),
        resume: Promise.withResolvers<void>(),
      };
      const complete = invokeAction(connection(actor.token), "core.files.completeUpload", {
        collection: FILE_COLLECTION,
        transferId: transfer.transferId,
      });
      await Promise.race([
        barrier.entered.promise,
        complete.then(() => {
          throw new Error("verification settled before the barrier");
        }),
      ]);
      await action("core.access.revoke", { principalId: actor.principal.id });
      barrier.resume.resolve();
      barrier = undefined;
      expect((await complete).outcome).toMatchObject({
        ok: false,
        denial: { message: "reference_unavailable" },
      });
      actor = TokenGrantSchema.parse(
        await action("core.access.mint", {
          principalId: actor.principal.id,
          caps: ["containers:read"],
        }),
      );
    }
    privateDb = new Database(join(directory, "data/plugins/core.files/data.db"), {
      readonly: true,
    });
    mainDb = new Database(join(directory, "data/manifold.db"), { readonly: true });
    const reservations = () =>
      privateDb!
        .query("SELECT state,active,charged FROM file_transfers WHERE actor=? ORDER BY id")
        .all(actor.principal.id);
    expect(reservations()).toEqual([
      { state: "ready", active: 1, charged: 3 },
      { state: "ready", active: 1, charged: 3 },
    ]);
    now += 60_001;
    const request = {
      collection: FILE_COLLECTION,
      requestId: createFileRequestId(now),
      name: "replacement.bin",
      declaredMediaType: null,
      bytes: 1,
      purpose: "file",
    };
    const replacement = FileTransferSchema.parse(
      await action("core.files.beginUpload", request, actor.token),
    );
    for (const id of transfers)
      expect(
        privateDb.query("SELECT state,active,charged FROM file_transfers WHERE id=?").get(id),
      ).toEqual({ state: "cancelled", active: 0, charged: 0 });
    const terminal = mainDb
      .query(
        "SELECT state,terminal_at,cleanup_pending FROM reference_publications WHERE actor_principal=? ORDER BY request_id",
      )
      .all(actor.principal.id);
    expect(terminal.filter((row) => row.state === "aborted")).toHaveLength(2);
    expect(terminal.some((row) => row.state === "published")).toBe(false);
    expect(
      mainDb
        .query("SELECT count(*) AS n FROM reference_grant_provenance WHERE principal_id=?")
        .get(actor.principal.id),
    ).toEqual({ n: 0 });
    expect(
      FileTransferSchema.parse(await action("core.files.beginUpload", request, actor.token))
        .transferId,
    ).toBe(replacement.transferId);
    expect(
      mainDb
        .query(
          "SELECT state,terminal_at,cleanup_pending FROM reference_publications WHERE actor_principal=? ORDER BY request_id",
        )
        .all(actor.principal.id),
    ).toEqual(terminal);
  } finally {
    barrier?.resume.resolve();
    Reflect.set(PluginHost.prototype, "dataLease", original);
    privateDb?.close();
    mainDb?.close();
    try {
      await server?.stop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 60_000);
