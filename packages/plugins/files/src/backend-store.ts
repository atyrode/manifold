import { createHash } from "node:crypto";
import {
  PluginDatabaseError,
  NativeTransferError,
  type PluginDatabase,
  type SqlParam,
  type SqlRow,
} from "@manifold/plugin";
import {
  ByteTransferError,
  ByteRefusalSchema,
  canonicalJobJson,
  type ManifoldRef,
  type PluginOwnedRef,
} from "@manifold/protocol";
import {
  FileDescriptorSchema,
  FileRefusalSchema,
  FileRequestIdSchema,
  FileTransferSchema,
  FILE_CHUNK_BYTES,
  FILE_IDLE_MS,
  FILE_LIFETIME_MS,
  FILE_RECEIPT_MS,
  MAX_FILE_RECORDS,
  MAX_FILE_STORAGE_BYTES,
  MAX_FILE_TRANSFERS,
  MAX_PERSONAL_FILE_TRANSFERS,
  type FileDescriptor,
  type FileRefusal,
  type FileTransfer,
} from "./contract.ts";
import type { FilesContext } from "./server.ts";

export interface DataContext {
  readonly database?: PluginDatabase;
  now(): number;
}
export interface BoundContext extends DataContext {
  readonly principal: { readonly id: string };
  readonly credentialBinding: string;
}
interface StoredTransferRow extends SqlRow {
  id: string;
  request_id: string;
  actor: string;
  credential: string;
  binding: string;
  kind: FileTransfer["kind"];
  target: string;
  file_id: string | null;
  preparation: string | null;
  state: FileTransfer["state"];
  bytes: number | bigint;
  offset: number | bigint;
  sequence: number | bigint;
  created: number | bigint;
  progress: number | bigint;
  terminal: number | bigint | null;
  charged: number | bigint;
  active: number | bigint;
  reason: string | null;
  request: string;
  descriptor: string | null;
  ready_digest: string | null;
  native_id: string | null;
  native_status: string | null;
}
export interface TransferRow extends StoredTransferRow {
  bytes: number;
  offset: number;
  sequence: number;
  created: number;
  progress: number;
  terminal: number | null;
  charged: number;
  active: number;
}
export function sqlInteger(value: SqlRow[string] | undefined): number {
  if (typeof value !== "number" && typeof value !== "bigint") return fail("integrity");
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) return fail("integrity");
  return converted;
}
/** SQLite and the hardened database bridge preserve int64; product bounds fit safe numbers. */
export async function queryTransfers(
  db: PluginDatabase,
  sql: string,
  params?: readonly SqlParam[],
): Promise<TransferRow[]> {
  const rows = await db.query<StoredTransferRow>(sql, params);
  for (const row of rows) {
    for (const key of [
      "bytes",
      "offset",
      "sequence",
      "created",
      "progress",
      "charged",
      "active",
    ] as const)
      row[key] = sqlInteger(row[key]);
    if (row.terminal !== null) row.terminal = sqlInteger(row.terminal);
  }
  return rows as TransferRow[];
}
export class FilesError extends Error {
  constructor(readonly reason: FileRefusal | "recovery_unavailable") {
    super(reason);
    this.name = "FilesError";
  }
}
export const fail = (reason: FileRefusal | "recovery_unavailable"): never => {
  throw new FilesError(reason);
};
export const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJobJson(value)).digest("hex");
export const sameRef = (left: ManifoldRef, right: ManifoldRef): boolean =>
  canonicalJobJson(left) === canonicalJobJson(right);
export const fileRef = (row: TransferRow): PluginOwnedRef => {
  if (row.file_id === null) return fail("unavailable");
  return { kind: "file", fileId: row.file_id };
};
export function database(ctx: DataContext): PluginDatabase {
  if (!ctx.database) return fail("unavailable");
  return ctx.database;
}
const initialized = new WeakMap<PluginDatabase, Promise<void>>();
export async function initialize(db: PluginDatabase): Promise<void> {
  let pending = initialized.get(db);
  if (!pending) {
    pending = db
      .batch([
        {
          sql: `CREATE TABLE IF NOT EXISTS file_transfers (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, credential TEXT NOT NULL,
        binding TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, file_id TEXT, preparation TEXT,
        state TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 16777216),
        offset INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, progress INTEGER NOT NULL, terminal INTEGER,
        charged INTEGER NOT NULL CHECK(charged BETWEEN 0 AND 16777216), active INTEGER NOT NULL,
        reason TEXT, request TEXT NOT NULL, descriptor TEXT, ready_digest TEXT, native_id TEXT, native_status TEXT
      )`,
        },
        {
          sql: "CREATE UNIQUE INDEX IF NOT EXISTS files_identity ON file_transfers(file_id) WHERE kind='upload'",
        },
        {
          sql: `CREATE TABLE IF NOT EXISTS file_chunks (
        transfer_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence BETWEEN 0 AND 63),
        offset INTEGER NOT NULL, data BLOB NOT NULL CHECK(length(data) BETWEEN 1 AND 262144),
        PRIMARY KEY(transfer_id,sequence)
      ) WITHOUT ROWID`,
        },
      ])
      .then(() => undefined);
    initialized.set(db, pending);
    pending.catch(() => initialized.delete(db));
  }
  await pending;
}
export async function admission(db: PluginDatabase): Promise<void> {
  const result = await db.admitRecovery();
  if (!result.ok) fail(result.reason);
}
export async function maintenance(ctx: DataContext): Promise<void> {
  const db = database(ctx);
  const now = ctx.now();
  await db.batch([
    // Native admission/cleanup is not proved by this product clock, including a begin
    // whose native id acknowledgement was lost. Only exact host/owner evidence retires it.
    {
      sql: `UPDATE file_transfers SET state='expired',reason='expired',active=0,terminal=COALESCE(terminal,?)
      WHERE kind IN ('upload','read') AND active=1 AND state NOT IN ('ready','publishing','outcome_unknown')
        AND (created+?<=? OR progress+?<=?)`,
      params: [now, FILE_LIFETIME_MS, now, FILE_IDLE_MS, now],
    },
    {
      sql: `DELETE FROM file_chunks WHERE (transfer_id,sequence) IN (
      SELECT c.transfer_id,c.sequence FROM file_chunks c JOIN file_transfers t ON t.id=c.transfer_id
      WHERE t.kind='upload' AND t.state IN ('cancelled','expired','failed','deleted') LIMIT 64)`,
    },
    {
      sql: `UPDATE file_transfers SET charged=0 WHERE state IN ('cancelled','expired','failed','deleted')
      AND NOT EXISTS(SELECT 1 FROM file_chunks WHERE transfer_id=file_transfers.id)`,
    },
    {
      sql: `DELETE FROM file_transfers WHERE id IN (SELECT id FROM file_transfers WHERE terminal IS NOT NULL
      AND terminal+?<=? AND state NOT IN ('ready','publishing','outcome_unknown') AND charged=0
      AND NOT EXISTS(SELECT 1 FROM file_chunks WHERE transfer_id=file_transfers.id) LIMIT 32)`,
      params: [FILE_RECEIPT_MS, now],
    },
  ]);
}
export async function prepareData(ctx: DataContext): Promise<PluginDatabase> {
  const db = database(ctx);
  await initialize(db);
  await maintenance(ctx);
  return db;
}
export async function load(
  ctx: BoundContext,
  id: string,
  kind?: TransferRow["kind"],
): Promise<TransferRow> {
  const rows = await queryTransfers(
    database(ctx),
    "SELECT * FROM file_transfers WHERE id=? AND actor=? AND credential=?",
    [id, ctx.principal.id, ctx.credentialBinding],
  );
  const row = rows[0];
  if (!row || (kind !== undefined && row.kind !== kind)) return fail("unavailable");
  if (
    row.terminal !== null &&
    row.state !== "outcome_unknown" &&
    row.state !== "publishing" &&
    row.terminal + FILE_RECEIPT_MS <= ctx.now()
  )
    return fail("expired");
  return row;
}
export async function byRequest(
  ctx: BoundContext,
  requestId: string,
  binding: string,
): Promise<TransferRow | null> {
  const row = (
    await queryTransfers(database(ctx), "SELECT * FROM file_transfers WHERE request_id=?", [
      requestId,
    ])
  )[0];
  if (!row) return null;
  if (row.actor !== ctx.principal.id || row.credential !== ctx.credentialBinding)
    return fail("unavailable");
  if (row.binding !== binding) return fail("conflict");
  return load(ctx, row.id);
}
export async function reserve(
  ctx: BoundContext,
  input: {
    id: string;
    requestId: string;
    binding: string;
    kind: TransferRow["kind"];
    target: ManifoldRef;
    bytes: number;
    charged: number;
    request: unknown;
    fileId?: string;
    state: TransferRow["state"];
  },
): Promise<TransferRow> {
  const db = database(ctx);
  await admission(db);
  const now = ctx.now();
  const parsed = FileRequestIdSchema.safeParse(input.requestId);
  if (!parsed.success) return fail("invalid");
  const started = Number(input.requestId.slice(0, input.requestId.indexOf("_")));
  if (Math.abs(now - started) > 60_000) return fail("expired");
  const rows = await queryTransfers(
    db,
    `INSERT INTO file_transfers
    (id,request_id,actor,credential,binding,kind,target,file_id,state,bytes,created,progress,charged,active,request)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,1,? WHERE
      (SELECT count(*) FROM file_transfers)<? AND
      (SELECT COALESCE(sum(charged),0) FROM file_transfers)+?<=? AND
      (SELECT count(*) FROM file_transfers WHERE active=1)<? AND
      (SELECT count(*) FROM file_transfers WHERE active=1 AND actor=?)<?
    ON CONFLICT(request_id) DO NOTHING RETURNING *`,
    [
      input.id,
      input.requestId,
      ctx.principal.id,
      ctx.credentialBinding,
      input.binding,
      input.kind,
      canonicalJobJson(input.target),
      input.fileId ?? null,
      input.state,
      input.bytes,
      now,
      now,
      input.charged,
      canonicalJobJson(input.request),
      MAX_FILE_RECORDS,
      input.charged,
      MAX_FILE_STORAGE_BYTES,
      MAX_FILE_TRANSFERS,
      ctx.principal.id,
      MAX_PERSONAL_FILE_TRANSFERS,
    ],
  );
  if (rows[0]) return rows[0];
  const previous = await byRequest(ctx, input.requestId, input.binding);
  if (previous) return previous;
  const counts = (
    await db.query(
      "SELECT count(*) AS retained,COALESCE(sum(charged),0) AS charged,sum(active) AS active,COALESCE(sum(active=1 AND actor=?),0) AS personal FROM file_transfers",
      [ctx.principal.id],
    )
  )[0]!;
  if (
    Number(counts.retained) >= MAX_FILE_RECORDS ||
    Number(counts.charged) + input.charged > MAX_FILE_STORAGE_BYTES
  )
    return fail("quota");
  return fail("busy");
}
export function expires(row: TransferRow): number {
  return Math.min(row.created + FILE_LIFETIME_MS, row.progress + FILE_IDLE_MS);
}
export function active(row: TransferRow, now: number): void {
  if (!row.active || now >= expires(row)) fail(row.state === "cancelled" ? "cancelled" : "expired");
}
export function transfer(row: TransferRow): FileTransfer {
  return FileTransferSchema.parse({
    transferId: row.id,
    ref: JSON.parse(row.target),
    kind: row.kind,
    state: row.kind === "upload" && row.state === "ready" && row.active ? "verifying" : row.state,
    bytes: row.bytes,
    offset: row.offset,
    sequence: row.sequence,
    chunkBytes: FILE_CHUNK_BYTES,
    createdAt: row.created,
    expiresAt: row.active || row.terminal === null ? expires(row) : row.terminal + FILE_RECEIPT_MS,
    reason: row.reason,
  });
}
export function descriptor(row: TransferRow): FileDescriptor {
  if (!row.descriptor || !row.ready_digest) return fail("unavailable");
  return FileDescriptorSchema.parse(JSON.parse(row.descriptor));
}
export function reason(error: unknown): FileRefusal | "recovery_unavailable" {
  if (
    error instanceof FilesError ||
    error instanceof NativeTransferError ||
    error instanceof ByteTransferError
  )
    return error.reason;
  if (error instanceof Error) {
    const exact = FileRefusalSchema.safeParse(error.message);
    if (exact.success) return exact.data;
    if (error instanceof PluginDatabaseError || error.name === "PluginDatabaseError") {
      const message = error.message;
      for (const code of [
        "outcome_unknown",
        "recovery_unavailable",
        "backup_capacity",
        "storage_capacity",
        "database_full",
        "database_busy",
      ] as const)
        if (message.startsWith(code + ":") || message === code) return code;
      if (/SQLITE_BUSY|database is locked|checkpoint.*busy/i.test(message)) return "database_busy";
      if (/SQLITE_FULL|ENOSPC|disk.*full/i.test(message)) return "database_full";
    }
  }
  return "unavailable";
}
export function byteError(error: unknown): never {
  const parsed = ByteRefusalSchema.safeParse(reason(error));
  throw new ByteTransferError(parsed.success ? parsed.data : "unavailable");
}
export function action<A, R>(handler: (ctx: FilesContext, args: A) => Promise<R>) {
  return async (ctx: FilesContext, args: A): Promise<R | { refused: string }> => {
    try {
      await prepareData(ctx);
      return await handler(ctx, args);
    } catch (error) {
      return { refused: reason(error) };
    }
  };
}
export async function chunk(db: PluginDatabase, id: string, sequence: number): Promise<Uint8Array> {
  const row = (
    await db.query("SELECT data FROM file_chunks WHERE transfer_id=? AND sequence=?", [
      id,
      sequence,
    ])
  )[0];
  if (!(row?.data instanceof Uint8Array)) return fail("integrity");
  return row.data;
}
export async function terminal(
  ctx: DataContext,
  row: TransferRow,
  state: "failed" | "cancelled",
  why: FileRefusal | null,
): Promise<void> {
  await database(ctx).run(
    `UPDATE file_transfers SET state=?,reason=?,active=0,terminal=COALESCE(terminal,?)
    WHERE id=? AND state NOT IN ('ready','completed','deleted','publishing','outcome_unknown')`,
    [state, why, ctx.now(), row.id],
  );
  await maintenance(ctx);
}
export function geometry(
  row: TransferRow,
  input: { offset: number; sequence: number; length: number },
  zero = false,
): void {
  if (
    zero &&
    input.length === 0 &&
    input.offset === row.bytes &&
    input.sequence === Math.ceil(row.bytes / FILE_CHUNK_BYTES)
  )
    return;
  if (
    input.offset !== input.sequence * FILE_CHUNK_BYTES ||
    input.offset >= row.bytes ||
    input.length !== Math.min(FILE_CHUNK_BYTES, row.bytes - input.offset)
  )
    fail("invalid");
}
