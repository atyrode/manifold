import { createHash } from "node:crypto";
import type {
  ByteCarrierContext,
  ByteCarrierHandler,
  PluginLifecycle,
  PluginMigration,
  PluginNativeTransferContext,
  PluginReferenceContext,
} from "@manifold/plugin";
import {
  canonicalJobJson,
  type ByteCarrierRequest,
  type PluginOwnedRef,
  type PublishedReferenceIdentity,
  type ReferenceTerminalReceipt,
} from "@manifold/protocol";
import type { z } from "zod";
import type { OpenFileReadInputSchema } from "./contract.ts";
import {
  BeginFileUploadInputSchema,
  type FileReadRequestSchema,
  type FileRequestSchema,
  type FileUploadRequestSchema,
  type ListFilesInputSchema,
  FILE_CHUNK_BYTES,
  FILE_COLLECTION,
  FILE_LIFETIME_MS,
  FILE_RECEIPT_MS,
  type BeginFileUploadInput,
  type FileDescriptor,
} from "./contract.ts";
import { validateFileImage, FileImageValidationError } from "./image-validation.ts";
import {
  action,
  active,
  admission,
  byRequest,
  byteError,
  chunk,
  database,
  descriptor,
  digest,
  expires,
  fail,
  fileRef,
  geometry,
  initialize,
  load,
  maintenance,
  prepareData,
  reason,
  reserve,
  sameRef,
  terminal,
  transfer,
  type BoundContext,
  type DataContext,
  type TransferRow,
} from "./backend-store.ts";
import { nativeHandlers, downloadCarrier } from "./native.ts";
import { queryTransfers, sqlInteger } from "./backend-store.ts";
import type { ReferenceProbeRequest, ReferenceProbeResult } from "@manifold/protocol";
export { filesPendingNativeTransfers, filesReconcileNativeTransfers } from "./native.ts";

export interface FilesContext extends BoundContext {
  readonly references: PluginReferenceContext;
  readonly nativeTransfers: PluginNativeTransferContext;
  newId(): string | Promise<string>;
}
function displayName(value: string): string {
  let sanitized = "";
  for (const character of value.normalize("NFC")) {
    const code = character.codePointAt(0)!;
    sanitized +=
      code <= 0x1f ||
      code === 0x7f ||
      character === "/" ||
      character === "\\" ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
        ? "_"
        : character;
  }
  let result = "";
  for (const character of sanitized.trim() || "file") {
    if (result.length + character.length > 255) break;
    result += character;
  }
  return result;
}
function matches(row: TransferRow, published: PublishedReferenceIdentity): boolean {
  return (
    row.kind === "upload" &&
    row.state === "ready" &&
    row.preparation === published.preparationId &&
    row.ready_digest === published.readyDigest &&
    row.file_id === published.ref.fileId
  );
}
export async function authorizedFile(
  ctx: FilesContext,
  ref: PluginOwnedRef,
  access: "read" | "share" | "delete" = "read",
): Promise<TransferRow> {
  const published = await ctx.references.requirePublished({ ref, access });
  const row = (
    await queryTransfers(
      database(ctx),
      "SELECT * FROM file_transfers WHERE kind='upload' AND file_id=?",
      [ref.fileId],
    )
  )[0];
  if (!row || !matches(row, published)) return fail("unavailable");
  return row;
}
async function publishedBytes(ctx: ByteCarrierContext, row: TransferRow): Promise<TransferRow> {
  const ref = fileRef(row);
  const published = await ctx.requirePublished(ref);
  const source = (
    await queryTransfers(
      database(ctx),
      "SELECT * FROM file_transfers WHERE kind='upload' AND file_id=?",
      [ref.fileId],
    )
  )[0];
  if (
    !source ||
    !matches(source, published) ||
    row.ready_digest !== source.ready_digest ||
    row.preparation !== source.preparation
  )
    return fail("unavailable");
  ctx.assertCurrent();
  return source;
}
async function bindPreparation(ctx: FilesContext, row: TransferRow): Promise<TransferRow> {
  if (row.preparation !== null) return row;
  const prepared = await ctx.references.prepare({
    kind: "file",
    requestId: row.request_id,
    bindingDigest: row.binding,
  });
  await database(ctx).run(
    "UPDATE file_transfers SET preparation=?,file_id=? WHERE id=? AND state='receiving' AND preparation IS NULL",
    [prepared.preparationId, prepared.ref.fileId, row.id],
  );
  return load(ctx, row.id, "upload");
}
async function beginUpload(ctx: FilesContext, args: BeginFileUploadInput) {
  const binding = digest({ kind: "upload", args });
  const previous = await byRequest(ctx, args.requestId, binding);
  if (previous)
    return transfer(
      previous.state === "receiving" ? await bindPreparation(ctx, previous) : previous,
    );
  let row = await reserve(ctx, {
    id: await ctx.newId(),
    requestId: args.requestId,
    binding,
    kind: "upload",
    target: FILE_COLLECTION,
    bytes: args.bytes,
    charged: args.bytes,
    request: args,
    state: "receiving",
  });
  try {
    row = await bindPreparation(ctx, row);
  } catch (error) {
    const why = reason(error);
    if (why !== "outcome_unknown")
      await terminal(ctx, row, "failed", why === "recovery_unavailable" ? "storage_capacity" : why);
    throw error;
  }
  return transfer(row);
}
async function completeUpload(ctx: FilesContext, args: z.output<typeof FileUploadRequestSchema>) {
  let row = await load(ctx, args.transferId, "upload");
  if (row.state !== "ready") {
    active(row, ctx.now());
    if (row.state !== "receiving" || row.offset !== row.bytes || !row.preparation)
      return fail("conflict");
    await admission(database(ctx));
    const claimed = await database(ctx).run(
      "UPDATE file_transfers SET state='verifying' WHERE id=? AND state='receiving' AND offset=bytes",
      [row.id],
    );
    if (claimed.changes !== 1) return fail("busy");
    const request = BeginFileUploadInputSchema.parse(JSON.parse(row.request));
    const hash = createHash("sha256");
    const imageBytes = request.purpose === "image" ? new Uint8Array(row.bytes) : null;
    try {
      let offset = 0;
      for (let sequence = 0; offset < row.bytes; sequence += 1) {
        active(row, ctx.now());
        const bytes = await chunk(database(ctx), row.id, sequence);
        if (bytes.byteLength !== Math.min(FILE_CHUNK_BYTES, row.bytes - offset))
          return fail("integrity");
        hash.update(bytes);
        imageBytes?.set(bytes, offset);
        offset += bytes.byteLength;
      }
      const sha256 = hash.digest("hex");
      if (request.expectedSha256 !== undefined && request.expectedSha256 !== sha256)
        return fail("integrity");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, expires(row) - ctx.now()));
      let image: FileDescriptor["image"];
      try {
        image = imageBytes
          ? await validateFileImage(imageBytes, request.declaredMediaType, controller.signal)
          : null;
      } finally {
        clearTimeout(timer);
      }
      active(row, ctx.now());
      const metadata: FileDescriptor = {
        ref: fileRef(row),
        home: { kind: "root" },
        ownerId: row.actor,
        name: displayName(request.name),
        declaredMediaType: request.declaredMediaType,
        mediaType: image?.mediaType ?? "application/octet-stream",
        bytes: row.bytes,
        sha256,
        createdAt: row.created,
        image,
      };
      const readyDigest = digest({ preparationId: row.preparation, file: metadata });
      const saved = await database(ctx).run(
        `UPDATE file_transfers SET state='ready',descriptor=?,ready_digest=?,terminal=?
        WHERE id=? AND state='verifying' AND progress+60000>? AND created+?>?`,
        [
          canonicalJobJson(metadata),
          readyDigest,
          ctx.now(),
          row.id,
          ctx.now(),
          FILE_LIFETIME_MS,
          ctx.now(),
        ],
      );
      if (saved.changes !== 1) return fail("expired");
      row = await load(ctx, row.id, "upload");
    } catch (error) {
      // Before ready there is no publishable payload. Abort main first; failed authority leaves
      // the host's bounded preparation expiry/restart reconciliation in charge of reclamation.
      const failure = error instanceof FileImageValidationError ? new Error(error.reason) : error;
      if (row.preparation) await ctx.references.abort({ preparationId: row.preparation });
      const why = reason(failure);
      await terminal(ctx, row, "failed", why === "recovery_unavailable" ? "storage_capacity" : why);
      throw failure;
    }
  }
  if (!row.preparation || !row.ready_digest) return fail("unavailable");
  await admission(database(ctx));
  // Idempotent publication reconciles an existing main commit; it never reinstalls revoked rows.
  const publication = {
    preparationId: row.preparation,
    readyDigest: row.ready_digest,
    expiresAt: expires(row),
  };
  const published = await ctx.references.publish(publication);
  if (!matches(row, published)) return fail("integrity");
  await database(ctx).run(
    "UPDATE file_transfers SET active=0,terminal=COALESCE(terminal,?) WHERE id=? AND state='ready'",
    [ctx.now(), row.id],
  );
  return { ref: published.ref };
}
async function cancelUpload(ctx: FilesContext, args: z.output<typeof FileUploadRequestSchema>) {
  const row = await load(ctx, args.transferId, "upload");
  if (row.state === "ready" && row.active === 0) return fail("conflict");
  if (row.preparation) {
    const receipt = await ctx.references.abort({ preparationId: row.preparation });
    await filesReclaimReferences(ctx, [receipt]);
  } else await terminal(ctx, row, "cancelled", "cancelled");
  return transfer(await load(ctx, row.id, "upload"));
}
async function list(ctx: FilesContext, args: z.output<typeof ListFilesInputSchema>) {
  if (args.after) {
    const allowed = await ctx.references.readable({ kind: "file", refs: [args.after] });
    const previous = (
      await queryTransfers(
        database(ctx),
        "SELECT * FROM file_transfers WHERE kind='upload' AND file_id=?",
        [args.after.fileId],
      )
    )[0];
    if (!previous || !allowed.some((identity) => matches(previous, identity)))
      return fail("reference_unavailable");
  }
  let cursor = args.after?.fileId ?? "";
  let scanned = 0;
  const files: FileDescriptor[] = [];
  while (scanned < 1000) {
    const candidates = await queryTransfers(
      database(ctx),
      "SELECT * FROM file_transfers WHERE kind='upload' AND state='ready' AND file_id>? ORDER BY file_id LIMIT ?",
      [cursor, Math.min(64, 1000 - scanned)],
    );
    if (candidates.length === 0) break;
    scanned += candidates.length;
    cursor = candidates[candidates.length - 1]!.file_id!;
    const allowed = await ctx.references.readable({ kind: "file", refs: candidates.map(fileRef) });
    for (const candidate of candidates) {
      const found = allowed.find((identity) => matches(candidate, identity));
      if (found) files.push(descriptor(candidate));
      if (files.length > args.limit) break;
    }
    if (files.length > args.limit) break;
  }
  // Revalidate after the scan's awaits. A page cursor is itself an authorized file, never
  // a hidden row count/position. The extra readable row alone proves there is another page.
  const current = await ctx.references.readable({
    kind: "file",
    refs: files.slice(0, args.limit).map((file) => file.ref),
  });
  const page = files
    .slice(0, args.limit)
    .filter((file) => current.some((entry) => entry.ref.fileId === file.ref.fileId));
  return {
    files: page,
    next: files.length > args.limit && page.length ? page[page.length - 1]!.ref : null,
  };
}
async function openRead(ctx: FilesContext, args: z.output<typeof OpenFileReadInputSchema>) {
  const source = await authorizedFile(ctx, args.ref);
  const binding = digest({
    kind: "read",
    args,
    readyDigest: source.ready_digest,
    preparationId: source.preparation,
  });
  const previous = await byRequest(ctx, args.requestId, binding);
  if (previous) return { file: descriptor(source), transfer: transfer(previous) };
  const row = await reserve(ctx, {
    id: await ctx.newId(),
    requestId: args.requestId,
    binding,
    kind: "read",
    target: args.ref,
    fileId: args.ref.fileId,
    bytes: source.bytes,
    charged: 0,
    request: args,
    state: "reading",
  });
  await database(ctx).run(
    "UPDATE file_transfers SET preparation=?,ready_digest=? WHERE id=? AND state='reading'",
    [source.preparation, source.ready_digest, row.id],
  );
  await authorizedFile(ctx, args.ref);
  return { file: descriptor(source), transfer: transfer(await load(ctx, row.id, "read")) };
}
async function readRecord(ctx: FilesContext, args: z.output<typeof FileReadRequestSchema>) {
  const row = await load(ctx, args.transferId, "read");
  if (!sameRef(fileRef(row), args.ref)) return fail("unavailable");
  const source = await authorizedFile(ctx, args.ref);
  if (row.ready_digest !== source.ready_digest || row.preparation !== source.preparation)
    return fail("unavailable");
  return row;
}
export const filesHandlers = {
  beginUpload: action(beginUpload),
  completeUpload: action(completeUpload),
  cancelUpload: action(cancelUpload),
  inspectUpload: action(async (ctx, args: z.output<typeof FileUploadRequestSchema>) =>
    transfer(await load(ctx, args.transferId, "upload")),
  ),
  list: action(list),
  inspect: action(async (ctx, args: z.output<typeof FileRequestSchema>) =>
    descriptor(await authorizedFile(ctx, args.ref)),
  ),
  resolve: action(async (ctx, args: z.output<typeof FileRequestSchema>) => ({
    title: descriptor(await authorizedFile(ctx, args.ref)).name,
  })),
  openRead: action(openRead),
  inspectRead: action(async (ctx, args: z.output<typeof FileReadRequestSchema>) =>
    transfer(await readRecord(ctx, args)),
  ),
  cancelRead: action(async (ctx, args: z.output<typeof FileReadRequestSchema>) => {
    const row = await readRecord(ctx, args);
    await database(ctx).run(
      `UPDATE file_transfers SET state='cancelled',reason='cancelled',active=0,terminal=COALESCE(terminal,?)
      WHERE id=? AND state IN ('reading','completed')`,
      [ctx.now(), row.id],
    );
    return transfer(await load(ctx, row.id, "read"));
  }),
  delete: action(async (ctx, args: z.output<typeof FileRequestSchema>) => {
    const receipt = await ctx.references.unpublish(args);
    await filesReclaimReferences(ctx, [receipt]);
    return receipt;
  }),
  // This must stay a pure reference-service call: deletion can be reconciled even if private
  // SQLite is full or unavailable, and it conveys no metadata beyond the terminal identity.
  receipt: async (ctx: FilesContext, args: { ref: PluginOwnedRef }) => {
    try {
      return await ctx.references.receipt(args);
    } catch (error) {
      return { refused: reason(error) };
    }
  },
  share: action(async (ctx, args: Parameters<PluginReferenceContext["grant"]>[0]) => {
    await authorizedFile(ctx, args.ref, "share");
    return ctx.references.grant(args);
  }),
  unshare: action(async (ctx, args: Parameters<PluginReferenceContext["revoke"]>[0]) => {
    await authorizedFile(ctx, args.ref, "share");
    return ctx.references.revoke(args);
  }),
  audience: action(async (ctx, args: Parameters<PluginReferenceContext["audience"]>[0]) => {
    await authorizedFile(ctx, args.ref, "share");
    return ctx.references.audience(args);
  }),
  ...nativeHandlers,
};
async function uploadAdmission(ctx: ByteCarrierContext, input: ByteCarrierRequest) {
  await prepareData(ctx);
  ctx.assertCurrent();
  const row = await load(ctx, input.transferId, "upload");
  if (!sameRef(input.ref, FILE_COLLECTION) || row.preparation === null) return fail("unavailable");
  active(row, ctx.now());
  if (row.state !== "receiving") return fail("conflict");
  geometry(row, input);
  if (input.offset > row.offset) return fail("conflict");
  return row;
}
async function readAdmission(ctx: ByteCarrierContext, input: ByteCarrierRequest) {
  await prepareData(ctx);
  ctx.assertCurrent();
  const row = await load(ctx, input.transferId, "read");
  if (!sameRef(input.ref, fileRef(row))) return fail("unavailable");
  if (row.state === "cancelled") return fail("cancelled");
  geometry(row, input, true);
  const projection = input.length === 0 && row.state === "completed";
  if (!projection) {
    if ((row.state !== "reading" && row.state !== "completed") || ctx.now() >= expires(row))
      return fail("expired");
    if (input.offset > row.offset) return fail("conflict");
  }
  const source = await publishedBytes(ctx, row);
  return {
    row,
    source,
    deadline: projection
      ? Math.min(ctx.now() + 15_000, row.terminal! + FILE_RECEIPT_MS)
      : expires(row),
  };
}
export const filesByteCarriers: Readonly<Record<string, ByteCarrierHandler>> = {
  upload: {
    direction: "incoming",
    async authorize(ctx, input) {
      try {
        return { expiresAt: expires(await uploadAdmission(ctx, input)) };
      } catch (error) {
        return byteError(error);
      }
    },
    async write(ctx, input, data) {
      try {
        const row = await uploadAdmission(ctx, input);
        if (data.byteLength !== input.length) return fail("invalid");
        if (input.offset < row.offset) {
          const existing = await chunk(database(ctx), row.id, input.sequence);
          if (
            existing.byteLength !== data.byteLength ||
            !existing.every((value, index) => value === data[index])
          )
            return fail("conflict");
        } else {
          await admission(database(ctx));
          ctx.assertCurrent();
          await database(ctx).batch([
            {
              sql: `INSERT INTO file_chunks(transfer_id,sequence,offset,data) SELECT id,?,?,? FROM file_transfers
              WHERE id=? AND state='receiving' AND offset=? AND sequence=? AND progress+60000>? AND created+?>?
              ON CONFLICT(transfer_id,sequence) DO NOTHING`,
              params: [
                input.sequence,
                input.offset,
                data,
                row.id,
                input.offset,
                input.sequence,
                ctx.now(),
                FILE_LIFETIME_MS,
                ctx.now(),
              ],
            },
            {
              sql: `UPDATE file_transfers SET offset=offset+?,sequence=sequence+1,progress=?
              WHERE id=? AND state='receiving' AND offset=? AND sequence=? AND EXISTS(
              SELECT 1 FROM file_chunks WHERE transfer_id=? AND sequence=? AND data=?)`,
              params: [
                data.byteLength,
                ctx.now(),
                row.id,
                input.offset,
                input.sequence,
                row.id,
                input.sequence,
                data,
              ],
            },
          ]);
          const accepted = await chunk(database(ctx), row.id, input.sequence);
          if (
            accepted.byteLength !== data.byteLength ||
            !accepted.every((value, index) => value === data[index])
          )
            return fail("conflict");
        }
        const current = await load(ctx, row.id, "upload");
        ctx.assertCurrent();
        active(current, ctx.now());
        if (current.state !== "receiving") return fail("conflict");
        if (current.offset < input.offset + input.length) return fail("conflict");
        return { offset: current.offset, sequence: input.sequence, acceptedBytes: data.byteLength };
      } catch (error) {
        return byteError(error);
      }
    },
  },
  read: {
    direction: "outgoing",
    async authorize(ctx, input) {
      try {
        return { expiresAt: (await readAdmission(ctx, input)).deadline };
      } catch (error) {
        return byteError(error);
      }
    },
    async read(ctx, input) {
      try {
        const { row, source, deadline } = await readAdmission(ctx, input);
        const data =
          input.length === 0
            ? new Uint8Array(0)
            : await chunk(database(ctx), source.id, input.sequence);
        if (data.byteLength !== input.length) return fail("integrity");
        const end = input.offset + data.byteLength;
        const eof = end === row.bytes;
        if (row.state === "reading" && (end > row.offset || row.bytes === 0)) {
          await database(ctx).run(
            `UPDATE file_transfers SET offset=?,sequence=?,progress=?,state=?,active=?,terminal=?
            WHERE id=? AND state='reading' AND offset=? AND progress+60000>? AND created+?>?`,
            [
              end,
              input.sequence + (data.byteLength > 0 ? 1 : 0),
              ctx.now(),
              eof ? "completed" : "reading",
              eof ? 0 : 1,
              eof ? ctx.now() : null,
              row.id,
              input.offset,
              ctx.now(),
              FILE_LIFETIME_MS,
              ctx.now(),
            ],
          );
        }
        await publishedBytes(ctx, row);
        ctx.assertCurrent();
        const current = await load(ctx, row.id, "read");
        if (current.state === "cancelled") return fail("cancelled");
        if (!["reading", "completed"].includes(current.state) || current.offset < end)
          return fail("unavailable");
        ctx.assertCurrent();
        if (ctx.now() >= deadline) return fail("expired");
        return {
          data,
          offset: input.offset,
          eof,
          leaseMs: Math.max(1, Math.min(15_000, deadline - ctx.now())),
        };
      } catch (error) {
        return byteError(error);
      }
    },
  },
  download: downloadCarrier,
};
export async function filesProbeReady(
  ctx: DataContext,
  input: ReferenceProbeRequest,
): Promise<ReferenceProbeResult> {
  const db = database(ctx);
  if (
    !(await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='file_transfers'"))
      .length
  )
    return null;
  // Request/binding also identifies an interrupted host-prepare/private-bind handoff.
  const row = (
    await queryTransfers(
      db,
      "SELECT * FROM file_transfers WHERE kind='upload' AND request_id=? AND binding=?",
      [input.requestId, input.bindingDigest],
    )
  )[0];
  if (
    !row ||
    (row.preparation !== null && row.preparation !== input.preparationId) ||
    (row.file_id !== null && row.file_id !== input.ref.fileId)
  )
    return null;
  const expiresAt = expires(row);
  if (row.state !== "ready") {
    const terminal = ["cancelled", "expired", "failed", "deleted"].includes(row.state);
    return {
      preparationId: input.preparationId,
      readyDigest: null,
      expiresAt: terminal ? Math.min(expiresAt, ctx.now()) : expiresAt,
    };
  }
  if (!row.ready_digest || !row.descriptor) return null;
  const metadata = descriptor(row);
  if (
    digest({ preparationId: row.preparation, file: metadata }) !== row.ready_digest ||
    metadata.bytes !== row.bytes ||
    !sameRef(metadata.ref, input.ref)
  )
    return null;
  const chunks = await db.query(
    "SELECT sequence,offset,length(data) AS bytes FROM file_chunks WHERE transfer_id=? ORDER BY sequence",
    [row.id],
  );
  if (chunks.length !== Math.ceil(row.bytes / FILE_CHUNK_BYTES)) return null;
  for (let sequence = 0; sequence < chunks.length; sequence += 1) {
    const part = chunks[sequence]!;
    if (
      sqlInteger(part.sequence) !== sequence ||
      sqlInteger(part.offset) !== sequence * FILE_CHUNK_BYTES ||
      sqlInteger(part.bytes) !== Math.min(FILE_CHUNK_BYTES, row.bytes - sequence * FILE_CHUNK_BYTES)
    )
      return null;
  }
  if (input.publication === "published" && row.active !== 0) {
    // Host-confirmed publication releases only admission bookkeeping, never grants or bytes.
    await db.run(
      `UPDATE file_transfers SET active=0 WHERE id=? AND state='ready'
      AND preparation=? AND ready_digest=?`,
      [row.id, input.preparationId, row.ready_digest],
    );
  }
  return { preparationId: input.preparationId, readyDigest: row.ready_digest, expiresAt };
}
export async function filesReclaimReferences(
  ctx: DataContext,
  receipts: readonly ReferenceTerminalReceipt[],
): Promise<void> {
  const db = database(ctx);
  await initialize(db);
  for (const receipt of receipts) {
    await db.run(
      `UPDATE file_transfers SET state=?,active=0,
      terminal=CASE WHEN state IN ('deleted','cancelled','expired','failed') THEN COALESCE(terminal,?) ELSE ? END,reason='unavailable'
      WHERE (kind='upload' OR kind='read') AND file_id=? AND preparation=?`,
      [
        receipt.state === "deleted" ? "deleted" : "cancelled",
        ctx.now(),
        ctx.now(),
        receipt.ref.fileId,
        receipt.preparationId,
      ],
    );
    // At most 64 immutable rows per file. Main-first terminal proof is the only authority
    // to reclaim ready data; no local published flag can manufacture that proof.
    await db.run(
      `DELETE FROM file_chunks WHERE transfer_id IN (
      SELECT id FROM file_transfers WHERE kind='upload' AND file_id=? AND preparation=? AND state IN ('deleted','cancelled'))`,
      [receipt.ref.fileId, receipt.preparationId],
    );
  }
  await maintenance(ctx);
}
export const filesLifecycle = {
  onEnable: async (ctx: DataContext) => {
    await prepareData(ctx);
  },
  onDisable: async (ctx: DataContext) => {
    const db = await prepareData(ctx);
    await db.run(
      "UPDATE file_transfers SET state='cancelled',reason='cancelled',active=0,terminal=COALESCE(terminal,?) WHERE kind='read' AND state='reading'",
      [ctx.now()],
    );
  },
} satisfies PluginLifecycle;
export const filesMigrations = [
  {
    name: "files-immutable-chunks-v1",
    to: { major: 1, minor: 0 },
    async migrate(_storage: unknown, db?: DataContext["database"]) {
      if (!db) return fail("unavailable");
      await initialize(db);
    },
  },
] as const satisfies readonly PluginMigration[];
