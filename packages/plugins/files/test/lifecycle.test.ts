import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  NativeTransferError,
  type ByteCarrierContext,
  type PluginDatabase,
  type PluginNativeTransferContext,
  type PluginReferenceContext,
  type SqlParam,
  type SqlRow,
} from "@manifold/plugin";
import {
  ByteTransferError,
  type ByteCarrierRequest,
  type DatabaseRecoveryAdmission,
  type PluginOwnedRef,
  type PublishedReferenceIdentity,
  type ReferencePreparation,
  type ReferenceTerminalReceipt,
} from "@manifold/protocol";
import {
  createFileRequestId,
  FILE_CHUNK_BYTES,
  FILE_COLLECTION,
  FILE_IDLE_MS,
  FILE_LIFETIME_MS,
  FILE_RECEIPT_MS,
  MAX_FILE_BYTES,
  type FileTransfer,
} from "../src/contract.ts";
import {
  filesByteCarriers,
  filesHandlers,
  filesProbeReady,
  filesReclaimReferences,
  type FilesContext,
} from "../src/server.ts";
import { filesReconcileNativeTransfers } from "../src/native.ts";

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function accepted<T>(value: T | { refused: string }): T {
  if (typeof value === "object" && value !== null && "refused" in value)
    throw new Error(`Unexpected refusal: ${value.refused}`);
  return value as T;
}
function fixture() {
  const sqlite = new Database(":memory:", { strict: true, safeIntegers: true });
  databases.push(sqlite);
  let now = 1_900_000_000_000;
  let recovery: DatabaseRecoveryAdmission = { ok: true };
  type Bindings = Exclude<SqlParam, boolean>[];
  const params = (input: readonly SqlParam[] = []): Bindings =>
    input.map((value) => (typeof value === "boolean" ? Number(value) : value));
  const db: PluginDatabase = {
    pluginId: "core.files",
    admitRecovery: async () => recovery,
    async query<Row extends SqlRow>(sql: string, values?: readonly SqlParam[]) {
      return sqlite.query<Row, Bindings>(sql).all(...params(values));
    },
    async run(sql, values) {
      const result = sqlite.query(sql).run(...params(values));
      return { changes: result.changes, lastInsertRowid: BigInt(result.lastInsertRowid) };
    },
    async batch(statements) {
      return sqlite.transaction(() =>
        statements.map(({ sql, params: values }) =>
          sqlite.query<SqlRow, Bindings>(sql).all(...params(values)),
        ),
      )();
    },
  };
  interface Publication {
    preparation: ReferencePreparation;
    requestId: string;
    actor: string;
    credential: string;
    published: PublishedReferenceIdentity | null;
    terminal: ReferenceTerminalReceipt | null;
    readers: Set<string>;
  }
  const probe = (row: Publication) =>
    filesProbeReady(
      { database: db, now: () => now },
      {
        ref: row.preparation.ref,
        preparationId: row.preparation.preparationId,
        requestId: row.requestId,
        bindingDigest: row.preparation.bindingDigest,
        publication: row.published === null ? "prepared" : "published",
      },
    );
  const publications = new Map<string, Publication>();
  const intents = new Map<string, Publication>();
  let publicationCut: "none" | "before" | "after" = "none";
  let deletionObservedBytes = -1n;
  const unavailable = (): never => {
    throw new Error("reference_unavailable");
  };
  const unsupported = async (): Promise<never> => {
    throw new NativeTransferError("native_transfer_unavailable");
  };
  const nativeTransfers: PluginNativeTransferContext = {
    describe: unsupported,
    beginPut: unsupported,
    putChunk: unsupported,
    commitPut: unsupported,
    beginRead: unsupported,
    readChunk: unsupported,
    cancel: unsupported,
    status: unsupported,
    receipt: unsupported,
  };
  function context(actor = "owner", credential = "a".repeat(64)): FilesContext {
    const references: PluginReferenceContext = {
      attach: async () => unavailable(),
      async prepare(input) {
        const prior = intents.get(input.requestId);
        if (prior) {
          if (
            prior.actor !== actor ||
            prior.credential !== credential ||
            prior.preparation.bindingDigest !== input.bindingDigest ||
            prior.terminal
          )
            return unavailable();
          return prior.preparation;
        }
        const ref: PluginOwnedRef = {
          kind: "file",
          fileId: `f${String(publications.size).padStart(4, "0")}`,
        };
        const preparation = {
          ref,
          preparationId: randomUUID(),
          bindingDigest: input.bindingDigest,
          expiresAt: now + FILE_LIFETIME_MS,
        };
        const row: Publication = {
          preparation,
          requestId: input.requestId,
          actor,
          credential,
          published: null,
          terminal: null,
          readers: new Set(),
        };
        publications.set(ref.fileId, row);
        intents.set(input.requestId, row);
        return preparation;
      },
      async publish(input) {
        const row = [...publications.values()].find(
          (entry) => entry.preparation.preparationId === input.preparationId,
        );
        if (!row || row.actor !== actor || row.credential !== credential || row.terminal)
          return unavailable();
        if (row.published) {
          if (!row.readers.has(actor) || row.published.readyDigest !== input.readyDigest)
            return unavailable();
          return row.published;
        }
        if (publicationCut === "before") throw new ByteTransferError("outcome_unknown");
        const proof = await probe(row);
        if (!proof || proof.readyDigest === null || proof.readyDigest !== input.readyDigest)
          return unavailable();
        row.published = {
          ref: row.preparation.ref,
          preparationId: proof.preparationId,
          readyDigest: proof.readyDigest,
        };
        row.readers.add(actor);
        if (publicationCut === "after") throw new ByteTransferError("outcome_unknown");
        return row.published;
      },
      async abort(input) {
        const row = [...publications.values()].find(
          (entry) => entry.preparation.preparationId === input.preparationId,
        );
        if (!row || row.published) return unavailable();
        row.terminal ??= {
          ref: row.preparation.ref,
          preparationId: input.preparationId,
          state: "aborted",
        };
        return row.terminal;
      },
      async requirePublished({ ref }) {
        const row = publications.get(ref.fileId);
        if (!row?.published || row.terminal || !row.readers.has(actor)) return unavailable();
        return row.published;
      },
      async unpublish({ ref }) {
        const row = publications.get(ref.fileId);
        if (!row?.published || row.actor !== actor) return unavailable();
        deletionObservedBytes = sqlite
          .query<{ bytes: bigint }, []>(
            "SELECT COALESCE(sum(length(data)),0) AS bytes FROM file_chunks",
          )
          .get()!.bytes;
        row.terminal = { ref, preparationId: row.preparation.preparationId, state: "deleted" };
        row.readers.clear();
        return row.terminal;
      },
      async receipt({ ref }) {
        const row = publications.get(ref.fileId);
        if (!row?.terminal || row.actor !== actor || row.credential !== credential)
          return unavailable();
        return row.terminal;
      },
      async readable({ refs }) {
        return refs.flatMap((ref) => {
          const row = publications.get(ref.fileId);
          return row?.published && !row.terminal && row.readers.has(actor) ? [row.published] : [];
        });
      },
      grant: async () => unavailable(),
      revoke: async () => unavailable(),
      audience: async () => unavailable(),
    };
    return {
      database: db,
      principal: { id: actor },
      credentialBinding: credential,
      references,
      nativeTransfers,
      now: () => now,
      newId: randomUUID,
    };
  }
  function carrier(ctx: FilesContext): ByteCarrierContext {
    return {
      pluginId: "core.files",
      principal: { id: ctx.principal.id, kind: "human", name: ctx.principal.id, color: "#112233" },
      credentialBinding: ctx.credentialBinding,
      signal: new AbortController().signal,
      database: db,
      nativeTransfers: ctx.nativeTransfers,
      now: () => now,
      assertCurrent() {},
      requirePublished: (ref) => ctx.references.requirePublished({ ref, access: "read" }),
    };
  }
  async function begin(
    ctx = context(),
    bytes = 0,
    purpose: "file" | "image" = "file",
    requestId = createFileRequestId(now),
  ) {
    return accepted(
      await filesHandlers.beginUpload(ctx, {
        collection: FILE_COLLECTION,
        requestId,
        name: "private.bin",
        declaredMediaType: null,
        bytes,
        purpose,
      }),
    );
  }
  async function write(ctx: FilesContext, upload: FileTransfer, bytes: Uint8Array, offset = 0) {
    const handler = filesByteCarriers.upload!;
    if (handler.direction !== "incoming") throw new Error("incoming required");
    return handler.write(
      carrier(ctx),
      {
        transferId: upload.transferId,
        ref: FILE_COLLECTION,
        offset,
        sequence: offset / FILE_CHUNK_BYTES,
        length: bytes.byteLength,
      },
      bytes,
    );
  }
  async function read(ctx: FilesContext, request: ByteCarrierRequest) {
    const handler = filesByteCarriers.read!;
    if (handler.direction !== "outgoing") throw new Error("outgoing required");
    return handler.read(carrier(ctx), request);
  }
  async function save(bytes = new Uint8Array(0), ctx = context()) {
    const upload = await begin(ctx, bytes.byteLength);
    for (let offset = 0; offset < bytes.byteLength; offset += FILE_CHUNK_BYTES)
      await write(ctx, upload, bytes.subarray(offset, offset + FILE_CHUNK_BYTES), offset);
    return accepted(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: upload.transferId,
      }),
    ).ref;
  }
  return {
    sqlite,
    db,
    context,
    carrier,
    begin,
    write,
    read,
    save,
    probe,
    publications,
    nativeTransfers,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setRecovery: (value: typeof recovery) => {
      recovery = value;
    },
    cutPublication: (value: typeof publicationCut) => {
      publicationCut = value;
    },
    deletionObservedBytes: () => deletionObservedBytes,
  };
}

describe("durable Files product transitions", () => {
  test("canonical chunk retries retain high-water without extending idle lifetime", async () => {
    const f = fixture();
    const ctx = f.context();
    const bytes = new Uint8Array(FILE_CHUNK_BYTES).fill(41);
    const upload = await f.begin(ctx, FILE_CHUNK_BYTES + 1);
    await expect(f.write(ctx, upload, new Uint8Array([1]), FILE_CHUNK_BYTES)).rejects.toMatchObject(
      { reason: "conflict" },
    );
    const first = await f.write(ctx, upload, bytes);
    expect(first).toEqual({
      offset: FILE_CHUNK_BYTES,
      sequence: 0,
      acceptedBytes: FILE_CHUNK_BYTES,
    });
    f.advance(FILE_IDLE_MS - 1);
    expect(await f.write(ctx, upload, bytes)).toEqual(first);
    await expect(
      f.write(ctx, upload, new Uint8Array(FILE_CHUNK_BYTES).fill(42)),
    ).rejects.toMatchObject({ reason: "conflict" });
    f.advance(1);
    await expect(f.write(ctx, upload, new Uint8Array([3]), FILE_CHUNK_BYTES)).rejects.toMatchObject(
      { reason: "expired" },
    );
    expect(
      accepted(
        await filesHandlers.inspectUpload(ctx, {
          collection: FILE_COLLECTION,
          transferId: upload.transferId,
        }),
      ).state,
    ).toBe("expired");
    expect(
      f.sqlite
        .query<{ charged: bigint }, []>("SELECT sum(charged) AS charged FROM file_transfers")
        .get()!.charged,
    ).toBe(0n);
  });

  test("metadata and byte continuation bind the original credential and live publication", async () => {
    const f = fixture();
    const owner = f.context();
    const bytes = new Uint8Array([3, 1, 4, 1, 5]);
    const ref = await f.save(bytes);
    const reader = f.context("reader", "b".repeat(64));
    expect(await filesHandlers.inspect(reader, { ref })).toEqual({
      refused: "reference_unavailable",
    });
    expect(await filesHandlers.list(reader, { limit: 32 })).toEqual({ files: [], next: null });
    f.publications.get(ref.fileId)!.readers.add("reader");
    const open = accepted(
      await filesHandlers.openRead(reader, { ref, requestId: createFileRequestId(f.now()) }),
    );
    expect(open.file.sha256).toBe(hash(bytes));
    const request = {
      ref,
      transferId: open.transfer.transferId,
      offset: 0,
      sequence: 0,
      length: bytes.length,
    };
    await expect(f.read(f.context("reader", "c".repeat(64)), request)).rejects.toMatchObject({
      reason: "unavailable",
    });
    expect((await f.read(reader, request)).data).toEqual(bytes);
    f.advance(FILE_LIFETIME_MS + 1);
    const renewal = { ...request, offset: bytes.length, sequence: 1, length: 0 };
    expect(await f.read(reader, renewal)).toMatchObject({
      data: new Uint8Array(0),
      eof: true,
      leaseMs: 15_000,
    });
    await expect(f.read(reader, request)).rejects.toMatchObject({ reason: "expired" });
    const before = f.sqlite
      .query("SELECT progress,terminal FROM file_transfers WHERE id=?")
      .get(open.transfer.transferId);
    f.advance(15_000);
    await f.read(reader, renewal);
    expect(
      f.sqlite
        .query("SELECT progress,terminal FROM file_transfers WHERE id=?")
        .get(open.transfer.transferId),
    ).toEqual(before);
    f.publications.get(ref.fileId)!.readers.delete("reader");
    await expect(f.read(reader, renewal)).rejects.toMatchObject({ reason: "unavailable" });
    expect(accepted(await filesHandlers.inspect(owner, { ref })).sha256).toBe(hash(bytes));
  });

  test("a post-publication lost acknowledgement reconciles without restoring revoked creator read", async () => {
    const f = fixture();
    const ctx = f.context();
    const upload = await f.begin(ctx, 1);
    await f.write(ctx, upload, new Uint8Array([7]));
    f.cutPublication("after");
    expect(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: upload.transferId,
      }),
    ).toEqual({ refused: "outcome_unknown" });
    const publication = [...f.publications.values()][0]!;
    publication.readers.clear();
    f.cutPublication("none");
    expect(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: upload.transferId,
      }),
    ).toEqual({ refused: "reference_unavailable" });
    expect(await filesHandlers.list(ctx, { limit: 32 })).toEqual({ files: [], next: null });
    const second = await f.begin(ctx);
    f.cutPublication("after");
    expect(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: second.transferId,
      }),
    ).toEqual({ refused: "outcome_unknown" });
    for (const retained of f.publications.values()) retained.readers.clear();
    await expect(f.begin(ctx)).rejects.toThrow("busy");
    // The host's private published-phase callback needs no surviving creator/read credential.
    for (const retained of f.publications.values()) await f.probe(retained);
    const replacement = await f.begin(f.context("owner", "c".repeat(64)));
    expect(replacement.state).toBe("receiving");
    expect(await filesHandlers.list(ctx, { limit: 32 })).toEqual({ files: [], next: null });
    f.cutPublication("none");
    publication.readers.add("owner");
    expect(
      accepted(
        await filesHandlers.completeUpload(ctx, {
          collection: FILE_COLLECTION,
          transferId: upload.transferId,
        }),
      ).ref,
    ).toEqual(publication.preparation.ref);
    expect(
      accepted(await filesHandlers.inspect(ctx, { ref: publication.preparation.ref })).sha256,
    ).toBe(hash(new Uint8Array([7])));
  });

  test("restart abort reclaims only its exact prepared ready identity and never publishes", async () => {
    const f = fixture();
    const ctx = f.context();
    const kept = await f.save(new Uint8Array([7]));
    const upload = await f.begin(ctx, 1);
    await f.write(ctx, upload, new Uint8Array([9]));
    f.cutPublication("before");
    expect(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: upload.transferId,
      }),
    ).toEqual({ refused: "outcome_unknown" });
    const pending = [...f.publications.values()].find((row) => row.published === null)!;
    await filesReclaimReferences(ctx, [
      { ref: pending.preparation.ref, preparationId: "wrong", state: "aborted" },
    ]);
    expect((await f.probe(pending))?.readyDigest).not.toBeNull();
    const receipt = await ctx.references.abort({
      preparationId: pending.preparation.preparationId,
    });
    await filesReclaimReferences(ctx, [receipt]);
    expect((await f.probe(pending))?.readyDigest).toBeNull();
    expect(
      accepted(await filesHandlers.list(ctx, { limit: 32 })).files.map((file) => file.ref),
    ).toEqual([kept]);
    expect(
      f.sqlite
        .query<{ bytes: bigint }, []>("SELECT sum(length(data)) AS bytes FROM file_chunks")
        .get()!.bytes,
    ).toBe(1n);
  });

  test("empty opaque files publish, empty images fail without implicit opaque fallback", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save();
    expect(accepted(await filesHandlers.inspect(ctx, { ref })).sha256).toBe(
      hash(new Uint8Array(0)),
    );
    const image = await f.begin(ctx, 0, "image");
    expect(
      await filesHandlers.completeUpload(ctx, {
        collection: FILE_COLLECTION,
        transferId: image.transferId,
      }),
    ).toEqual({ refused: "invalid_image" });
    expect(
      accepted(await filesHandlers.list(ctx, { limit: 32 })).files.map((file) => file.ref),
    ).toEqual([ref]);
  });

  test("main-first deletion works without new recovery margin and retains a fresh terminal receipt", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save(new Uint8Array([1, 2]));
    f.advance(FILE_RECEIPT_MS - 1);
    f.setRecovery({ ok: false, reason: "backup_capacity" });
    const receipt = accepted(await filesHandlers.delete(ctx, { ref }));
    expect(f.deletionObservedBytes()).toBe(2n);
    expect(
      f.sqlite.query<{ count: bigint }, []>("SELECT count(*) AS count FROM file_chunks").get()!
        .count,
    ).toBe(0n);
    f.advance(2);
    expect(await filesHandlers.receipt(ctx, { ref })).toEqual(receipt);
    expect(await filesHandlers.inspect(ctx, { ref })).toEqual({ refused: "reference_unavailable" });
    expect(
      f.sqlite
        .query<{ terminal: bigint }, []>("SELECT terminal FROM file_transfers WHERE kind='upload'")
        .get()!.terminal,
    ).toBe(BigInt(f.now() - 2));
  });

  test("atomic reservations prevent competing uploads from spending the same logical bytes", async () => {
    const f = fixture();
    const first = f.context("first");
    const second = f.context("second", "b".repeat(64));
    const uploads = await Promise.all([
      f.begin(first, MAX_FILE_BYTES),
      f.begin(second, MAX_FILE_BYTES),
    ]);
    expect(
      f.sqlite
        .query<{ bytes: bigint }, []>("SELECT sum(charged) AS bytes FROM file_transfers")
        .get()!.bytes,
    ).toBe(BigInt(2 * MAX_FILE_BYTES));
    expect(
      await filesHandlers.beginUpload(first, {
        collection: FILE_COLLECTION,
        requestId: createFileRequestId(f.now()),
        name: "extra",
        declaredMediaType: null,
        bytes: 1,
        purpose: "file",
      }),
    ).toEqual({ refused: "quota" });
    await filesHandlers.cancelUpload(first, {
      collection: FILE_COLLECTION,
      transferId: uploads[0]!.transferId,
    });
    const replacement = await f.begin(first, 1);
    expect(replacement.bytes).toBe(1);
    expect(
      f.sqlite
        .query<{ bytes: bigint }, []>("SELECT sum(charged) AS bytes FROM file_transfers")
        .get()!.bytes,
    ).toBe(BigInt(MAX_FILE_BYTES + 1));
  });

  test("read and native receipts participate in the same workspace and per-principal admission", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save();
    const opens = await Promise.all(
      [1, 2].map(() =>
        filesHandlers.openRead(ctx, { ref, requestId: createFileRequestId(f.now()) }),
      ),
    );
    expect(opens.every((open) => !("refused" in open))).toBe(true);
    expect(
      await filesHandlers.beginUpload(ctx, {
        collection: FILE_COLLECTION,
        requestId: createFileRequestId(f.now()),
        name: "blocked",
        declaredMediaType: null,
        bytes: 0,
        purpose: "file",
      }),
    ).toEqual({ refused: "busy" });
    const native = await filesHandlers.beginDownload(ctx, {
      machine: { kind: "machine", machineId: "m" },
      location: { kind: "location", machineId: "m", locationId: "core.files.downloads" },
      requestId: createFileRequestId(f.now()),
      installationRevision: "1",
      artifactSha256: "a".repeat(64),
      locationId: "core.files.downloads",
      locationRevision: "1",
      relativePath: ["file"],
    });
    expect(native).toEqual({ refused: "busy" });
    const first = accepted(opens[0]!);
    await filesHandlers.cancelRead(ctx, { ref, transferId: first.transfer.transferId });
    expect((await f.begin(ctx)).state).toBe("receiving");
  });

  test("retained transfer receipts consume the record cap without blocking authorized deletion", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save();
    f.sqlite
      .query(
        `WITH RECURSIVE receipts(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM receipts WHERE n<999)
      INSERT INTO file_transfers(id,request_id,actor,credential,binding,kind,target,state,bytes,created,progress,terminal,charged,active,request)
      SELECT 'retained-'||n,'request-'||n,'owner',?,'digest','read',?,'cancelled',0,?,?,?,0,0,'{}' FROM receipts`,
      )
      .run(ctx.credentialBinding, JSON.stringify(ref), f.now(), f.now(), f.now());
    expect(
      await filesHandlers.openRead(ctx, { ref, requestId: createFileRequestId(f.now()) }),
    ).toEqual({ refused: "quota" });
    expect(accepted(await filesHandlers.delete(ctx, { ref })).state).toBe("deleted");
    expect(await filesHandlers.inspect(ctx, { ref })).toEqual({ refused: "reference_unavailable" });
  });

  test("retired request IDs cannot silently create a second operation after receipt GC", async () => {
    const f = fixture();
    const ctx = f.context();
    const requestId = createFileRequestId(f.now());
    const upload = await f.begin(ctx, 0, "file", requestId);
    await filesHandlers.cancelUpload(ctx, {
      collection: FILE_COLLECTION,
      transferId: upload.transferId,
    });
    f.advance(FILE_RECEIPT_MS + 1);
    expect(
      await filesHandlers.beginUpload(ctx, {
        collection: FILE_COLLECTION,
        requestId,
        name: "private.bin",
        declaredMediaType: null,
        bytes: 0,
        purpose: "file",
      }),
    ).toEqual({ refused: "expired" });
    expect(f.publications.size).toBe(1);
    expect((await f.begin(ctx)).state).toBe("receiving");
  });

  test("library cursors never expose an unreadable candidate or hidden scan position", async () => {
    const f = fixture();
    const first = await f.save();
    const hidden = await f.save();
    const third = await f.save();
    const reader = f.context("reader", "b".repeat(64));
    f.publications.get(first.fileId)!.readers.add("reader");
    f.publications.get(third.fileId)!.readers.add("reader");
    const page = accepted(await filesHandlers.list(reader, { limit: 1 }));
    expect(page.files.map((file) => file.ref)).toEqual([first]);
    expect(page.next).toEqual(first);
    expect(
      accepted(await filesHandlers.list(reader, { after: first, limit: 1 })).files.map(
        (file) => file.ref,
      ),
    ).toEqual([third]);
    expect(await filesHandlers.list(reader, { after: hidden, limit: 1 })).toEqual({
      refused: "reference_unavailable",
    });
  });

  test("cancelling a completed read retires its projection lease without deleting the file", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save(new Uint8Array([8]));
    const open = accepted(
      await filesHandlers.openRead(ctx, { ref, requestId: createFileRequestId(f.now()) }),
    );
    const request = {
      ref,
      transferId: open.transfer.transferId,
      offset: 0,
      sequence: 0,
      length: 1,
    };
    await f.read(ctx, request);
    expect(
      accepted(await filesHandlers.cancelRead(ctx, { ref, transferId: open.transfer.transferId }))
        .state,
    ).toBe("cancelled");
    await expect(
      f.read(ctx, { ...request, offset: 1, sequence: 1, length: 0 }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(accepted(await filesHandlers.inspect(ctx, { ref })).bytes).toBe(1);
  });

  test("native delivery reconciles accepted chunks and never blindly retries an unknown commit", async () => {
    const f = fixture();
    const ctx = f.context();
    const bytes = new Uint8Array(FILE_CHUNK_BYTES + 3).fill(67);
    const ref = await f.save(bytes);
    let received = 0;
    let chunks = 0;
    let commits = 0;
    let uncertain = false;
    f.nativeTransfers.beginPut = async () => ({
      transferId: "remote",
      mode: "put",
      state: "receiving",
      bytes: 0,
    });
    f.nativeTransfers.status = async () => ({
      transferId: "remote",
      mode: "put",
      state: uncertain ? "outcome_unknown" : "receiving",
      bytes: received,
      ...(uncertain ? { reason: "outcome_unknown" as const } : {}),
    });
    f.nativeTransfers.putChunk = async (input) => {
      expect(input.offset).toBe(received);
      expect(input.data).toEqual(bytes.subarray(received, received + input.data.byteLength));
      received += input.data.byteLength;
      chunks += 1;
      if (chunks === 1) throw new NativeTransferError("transfer_disconnected");
      return { transferId: "remote", mode: "put", state: "receiving", bytes: received };
    };
    f.nativeTransfers.commitPut = async () => {
      commits += 1;
      uncertain = true;
      throw new NativeTransferError("outcome_unknown");
    };
    const machine = { kind: "machine" as const, machineId: "m" };
    const location = {
      kind: "location" as const,
      machineId: "m",
      locationId: "core.files.deliveries",
    };
    const started = accepted(
      await filesHandlers.beginDelivery(ctx, {
        ref,
        machine,
        location,
        requestId: createFileRequestId(f.now()),
        installationRevision: "install",
        artifactSha256: "d".repeat(64),
        locationId: location.locationId,
        locationRevision: "1",
        filename: "copy.bin",
      }),
    );
    const request = { ref, machine, location, transferId: started.transfer.transferId };
    expect(await filesHandlers.advanceDelivery(ctx, request)).toEqual({
      refused: "transfer_disconnected",
    });
    expect(accepted(await filesHandlers.advanceDelivery(ctx, request)).transfer.offset).toBe(
      bytes.length,
    );
    expect(chunks).toBe(2);
    expect(await filesHandlers.commitDelivery(ctx, request)).toEqual({
      refused: "outcome_unknown",
    });
    expect(accepted(await filesHandlers.commitDelivery(ctx, request)).transfer.state).toBe(
      "outcome_unknown",
    );
    expect(commits).toBe(1);
    f.publications.get(ref.fileId)!.readers.clear();
    f.nativeTransfers.receipt = async () => ({ transferId: "remote", state: "outcome_unknown" });
    expect(await filesHandlers.receiptDelivery(ctx, { transferId: request.transferId })).toEqual({
      transferId: request.transferId,
      state: "outcome_unknown",
    });
    f.nativeTransfers.receipt = async () => {
      throw new NativeTransferError("transfer_authority_refused");
    };
    expect(await filesHandlers.receiptDelivery(ctx, { transferId: request.transferId })).toEqual({
      refused: "transfer_authority_refused",
    });
  });

  test("private terminal evidence releases exact native reservations after source deletion without touching independent library files", async () => {
    const f = fixture();
    const ctx = f.context();
    const source = await f.save(new Uint8Array([1, 2, 3]));
    const independentBytes = new Uint8Array([4, 5, 6]);
    const independent = await f.save(independentBytes);
    const machine = { kind: "machine" as const, machineId: "m" };
    const location = {
      kind: "location" as const,
      machineId: "m",
      locationId: "core.files.deliveries",
    };
    f.nativeTransfers.beginPut = async () => ({
      transferId: "remote",
      mode: "put",
      state: "receiving",
      bytes: 3,
    });
    f.nativeTransfers.status = async () => ({
      transferId: "remote",
      mode: "put",
      state: "receiving",
      bytes: 3,
    });
    f.nativeTransfers.commitPut = async () => {
      throw new NativeTransferError("outcome_unknown");
    };
    const requestId = createFileRequestId(f.now());
    const delivery = accepted(
      await filesHandlers.beginDelivery(ctx, {
        ref: source,
        machine,
        location,
        requestId,
        installationRevision: "install",
        artifactSha256: "d".repeat(64),
        locationId: location.locationId,
        locationRevision: "1",
        filename: "copy.bin",
      }),
    );
    const request = { ref: source, machine, location, transferId: delivery.transfer.transferId };
    expect(await filesHandlers.commitDelivery(ctx, request)).toEqual({
      refused: "outcome_unknown",
    });
    accepted(await filesHandlers.delete(ctx, { ref: source }));
    await f.begin(ctx);
    const begin = () =>
      filesHandlers.beginUpload(ctx, {
        collection: FILE_COLLECTION,
        requestId: createFileRequestId(f.now()),
        name: "next.bin",
        declaredMediaType: null,
        bytes: 0,
        purpose: "file" as const,
      });
    expect(await begin()).toEqual({ refused: "busy" });
    const evidence = {
      kind: "terminal" as const,
      transferId: "remote",
      requestId,
      actorId: ctx.principal.id,
      credentialBinding: ctx.credentialBinding,
      mode: "put" as const,
      state: "committed" as const,
    };
    for (const wrong of [
      { ...evidence, transferId: "another" },
      { ...evidence, requestId: "another" },
      { ...evidence, actorId: "another" },
      { ...evidence, credentialBinding: "b".repeat(64) },
    ])
      await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [wrong]);
    expect(await begin()).toEqual({ refused: "busy" });
    f.setRecovery({ ok: false, reason: "backup_capacity" });
    await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [evidence]);
    const terminal = f.sqlite
      .query<{ state: string; active: bigint; terminal: bigint }, [string]>(
        "SELECT state,active,terminal FROM file_transfers WHERE id=?",
      )
      .get(request.transferId)!;
    expect(terminal).toEqual({ state: "completed", active: 0n, terminal: BigInt(f.now()) });
    f.advance(1);
    await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [evidence]);
    expect(
      f.sqlite
        .query<{ terminal: bigint }, [string]>("SELECT terminal FROM file_transfers WHERE id=?")
        .get(request.transferId)!.terminal,
    ).toBe(terminal.terminal);
    f.setRecovery({ ok: true });
    expect(accepted(await begin()).state).toBe("receiving");
    expect(accepted(await filesHandlers.inspect(ctx, { ref: independent })).sha256).toBe(
      hash(independentBytes),
    );
    expect(await filesHandlers.inspect(ctx, { ref: source })).toEqual({
      refused: "reference_unavailable",
    });
    f.nativeTransfers.receipt = async () => ({ transferId: "remote", state: "committed" });
    expect(await filesHandlers.receiptDelivery(ctx, { transferId: request.transferId })).toEqual({
      transferId: request.transferId,
      state: "completed",
    });
    expect(
      await filesHandlers.receiptDelivery(f.context("owner", "b".repeat(64)), {
        transferId: request.transferId,
      }),
    ).toEqual({ refused: "unavailable" });
  });

  test("terminal native admission evidence releases an unbound queued reservation without a begin retry", async () => {
    const f = fixture();
    const ctx = f.context();
    const machine = { kind: "machine" as const, machineId: "m" };
    const location = {
      kind: "location" as const,
      machineId: "m",
      locationId: "core.files.downloads",
    };
    const requestId = createFileRequestId(f.now());
    f.nativeTransfers.beginRead = async () => {
      throw new NativeTransferError("native_source_writer_active");
    };
    expect(
      await filesHandlers.beginDownload(ctx, {
        machine,
        location,
        requestId,
        installationRevision: "install",
        artifactSha256: "d".repeat(64),
        locationId: location.locationId,
        locationRevision: "1",
        relativePath: ["busy.bin"],
      }),
    ).toEqual({ refused: "native_source_writer_active" });
    await f.begin(ctx);
    const next = () =>
      filesHandlers.beginUpload(ctx, {
        collection: FILE_COLLECTION,
        requestId: createFileRequestId(f.now()),
        name: "next.bin",
        declaredMediaType: null,
        bytes: 0,
        purpose: "file" as const,
      });
    expect(await next()).toEqual({ refused: "busy" });
    const evidence = {
      kind: "terminal" as const,
      transferId: "refused-native",
      requestId,
      actorId: ctx.principal.id,
      credentialBinding: ctx.credentialBinding,
      mode: "read" as const,
      state: "refused" as const,
      reason: "native_source_writer_active" as const,
    };
    for (const wrong of [
      { ...evidence, requestId: "another" },
      { ...evidence, actorId: "another" },
      { ...evidence, credentialBinding: "b".repeat(64) },
      { ...evidence, mode: "put" as const },
    ])
      await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [wrong]);
    expect(await next()).toEqual({ refused: "busy" });
    await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [evidence]);
    expect(accepted(await next()).state).toBe("receiving");
  });

  test("unadmitted refusal has a credential-bound terminal receipt but no native identity or retry effect", async () => {
    const f = fixture();
    const ctx = f.context();
    const ref = await f.save(new Uint8Array([7]));
    const args = {
      ref,
      machine: { kind: "machine" as const, machineId: "m" },
      location: { kind: "location" as const, machineId: "m", locationId: "core.files.deliveries" },
      requestId: createFileRequestId(f.now()),
      installationRevision: "stale",
      artifactSha256: "d".repeat(64),
      locationId: "core.files.deliveries",
      locationRevision: "1",
      filename: "file.bin",
    };
    f.nativeTransfers.beginPut = async () => {
      throw new NativeTransferError("installation_changed");
    };
    expect(await filesHandlers.beginDelivery(ctx, args)).toEqual({
      refused: "installation_changed",
    });
    const evidence = {
      kind: "admission-refused" as const,
      requestId: args.requestId,
      actorId: ctx.principal.id,
      credentialBinding: ctx.credentialBinding,
      mode: "put" as const,
      attemptedAt: f.now(),
      reason: "installation_changed" as const,
    };
    for (const wrong of [
      { ...evidence, requestId: "other" },
      { ...evidence, actorId: "other" },
      { ...evidence, credentialBinding: "b".repeat(64) },
      { ...evidence, mode: "read" as const },
      { ...evidence, attemptedAt: f.now() - 1 },
    ])
      await filesReconcileNativeTransfers(ctx, [wrong]);
    expect(
      f.sqlite
        .query<{ state: string }, [string]>("SELECT state FROM file_transfers WHERE request_id=?")
        .get(args.requestId)!.state,
    ).toBe("queued");
    await filesReconcileNativeTransfers(ctx, [evidence]);
    f.nativeTransfers.beginPut = async () => {
      throw new Error("a refused attempt must never restart");
    };
    const repeated = accepted(await filesHandlers.beginDelivery(ctx, args));
    expect(repeated.transfer.state).toBe("refused");
    expect(repeated.native).toBeNull();
    expect(
      await filesHandlers.receiptDelivery(ctx, { transferId: repeated.transfer.transferId }),
    ).toEqual({ transferId: repeated.transfer.transferId, state: "refused" });
    expect(
      await filesHandlers.receiptDelivery(f.context("owner", "b".repeat(64)), {
        transferId: repeated.transfer.transferId,
      }),
    ).toEqual({ refused: "unavailable" });
    const terminal = f.sqlite
      .query("SELECT native_id,active,charged,terminal FROM file_transfers WHERE request_id=?")
      .get(args.requestId);
    expect(terminal).toEqual({
      native_id: null,
      active: 0n,
      charged: 0n,
      terminal: BigInt(f.now()),
    });
    f.advance(1);
    await filesReconcileNativeTransfers(ctx, [evidence]);
    expect(
      f.sqlite
        .query("SELECT native_id,active,charged,terminal FROM file_transfers WHERE request_id=?")
        .get(args.requestId),
    ).toEqual(terminal);
    expect((await f.begin(ctx)).state).toBe("receiving");
  });

  for (const kind of ["delivery", "download"] as const) {
    for (const acknowledged of [true, false]) {
      test(`${kind} ${acknowledged ? "admitted" : "unacknowledged"} reservation outlives product clocks until exact cleanup evidence`, async () => {
        const f = fixture();
        const ctx = f.context();
        const source = await f.save(new Uint8Array([1, 2, 3]));
        const machine = { kind: "machine" as const, machineId: "m" };
        const location = {
          kind: "location" as const,
          machineId: "m",
          locationId: kind === "delivery" ? "core.files.deliveries" : "core.files.downloads",
        };
        const requestId = createFileRequestId(f.now());
        const pins = {
          machine,
          location,
          requestId,
          installationRevision: "install",
          artifactSha256: "d".repeat(64),
          locationId: location.locationId,
          locationRevision: "1",
        };
        f.nativeTransfers.beginPut = async () => {
          if (!acknowledged) throw new NativeTransferError("transfer_disconnected");
          return { transferId: "remote", mode: "put", state: "receiving", bytes: 0 };
        };
        f.nativeTransfers.beginRead = async () => {
          if (!acknowledged) throw new NativeTransferError("transfer_disconnected");
          return { transferId: "remote", mode: "read", state: "ready", bytes: 3 };
        };
        const begun =
          kind === "delivery"
            ? await filesHandlers.beginDelivery(ctx, { ...pins, ref: source, filename: "copy.bin" })
            : await filesHandlers.beginDownload(ctx, { ...pins, relativePath: ["source.bin"] });
        if (!acknowledged) expect(begun).toEqual({ refused: "transfer_disconnected" });
        const row = () =>
          f.sqlite
            .query<
              {
                state: string;
                active: bigint;
                charged: bigint;
                terminal: bigint | null;
                native_id: string | null;
              },
              [string]
            >(
              "SELECT state,active,charged,terminal,native_id FROM file_transfers WHERE request_id=?",
            )
            .get(requestId)!;
        const retained = row();
        f.advance(FILE_RECEIPT_MS + FILE_LIFETIME_MS + 1);
        await f.begin(ctx);
        expect(row()).toEqual(retained);
        expect(row()).toMatchObject({
          active: 1n,
          terminal: null,
          charged: 0n,
          native_id: acknowledged ? "remote" : null,
        });
        const next = () =>
          filesHandlers.beginUpload(ctx, {
            collection: FILE_COLLECTION,
            requestId: createFileRequestId(f.now()),
            name: "next.bin",
            declaredMediaType: null,
            bytes: 0,
            purpose: "file" as const,
          });
        expect(await next()).toEqual({ refused: "busy" });
        const evidence = {
          kind: "terminal" as const,
          transferId: "remote",
          requestId,
          actorId: ctx.principal.id,
          credentialBinding: ctx.credentialBinding,
          mode: kind === "delivery" ? ("put" as const) : ("read" as const),
          state: "cancelled" as const,
        };
        await filesReconcileNativeTransfers({ database: f.db, now: f.now }, [evidence]);
        expect(row()).toMatchObject({
          state: "cancelled",
          active: 0n,
          charged: 0n,
          terminal: BigInt(f.now()),
        });
        expect(accepted(await next()).state).toBe("receiving");
      });
    }
  }

  test("machine downloads use the private carrier and do not become library files", async () => {
    const f = fixture();
    const ctx = f.context();
    const bytes = new Uint8Array([9, 2, 6]);
    const machine = { kind: "machine" as const, machineId: "m" };
    const location = {
      kind: "location" as const,
      machineId: "m",
      locationId: "core.files.downloads",
    };
    const request = {
      machine,
      location,
      requestId: createFileRequestId(f.now()),
      installationRevision: "install",
      artifactSha256: "d".repeat(64),
      locationId: location.locationId,
      locationRevision: "1",
      relativePath: ["source.bin"],
    };
    const status = {
      transferId: "snapshot",
      mode: "read" as const,
      state: "ready" as const,
      bytes: bytes.length,
      sha256: hash(bytes),
      receipt: {
        transferId: "snapshot",
        mode: "read" as const,
        requestId: request.requestId,
        machineId: machine.machineId,
        installationRevision: request.installationRevision,
        artifactSha256: request.artifactSha256,
        locationId: location.locationId,
        locationRevision: "1",
        pluginId: "core.files",
        actorId: ctx.principal.id,
        credentialBinding: ctx.credentialBinding,
        ownerId: "owner",
        ownerGeneration: 1,
        path: "/approved/source.bin",
        bytes: bytes.length,
        sha256: hash(bytes),
        committedAt: f.now(),
      },
    };
    f.nativeTransfers.beginRead = async () => status;
    f.nativeTransfers.status = async () => status;
    f.nativeTransfers.readChunk = async (input) => ({
      status,
      data: bytes.subarray(input.offset, input.offset + input.maxBytes),
      offset: input.offset,
      eof: input.offset + input.maxBytes === bytes.length,
    });
    const started = accepted(await filesHandlers.beginDownload(ctx, request));
    const carrier = filesByteCarriers.download!;
    if (carrier.direction !== "outgoing") throw new Error("outgoing required");
    const input = {
      transferId: started.transfer.transferId,
      ref: location,
      offset: 0,
      sequence: 0,
      length: bytes.length,
    };
    expect((await carrier.read(f.carrier(ctx), input)).data).toEqual(bytes);
    expect(await filesHandlers.list(ctx, { limit: 32 })).toEqual({ files: [], next: null });
    expect(
      f.sqlite.query<{ count: bigint }, []>("SELECT count(*) AS count FROM file_chunks").get()!
        .count,
    ).toBe(0n);
    f.advance(FILE_LIFETIME_MS + 1);
    await expect(
      carrier.read(f.carrier(ctx), { ...input, offset: bytes.length, sequence: 1, length: 0 }),
    ).rejects.toMatchObject({ reason: "expired" });
  });
});
