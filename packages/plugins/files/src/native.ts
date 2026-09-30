import type { ByteCarrierContext, ByteCarrierHandler } from "@manifold/plugin";
import { canonicalJobJson, NativeTransferStatusSchema, NativeTransferEvidenceBatchSchema, type ByteCarrierRequest, type NativeTransferStatus, type NativeTransferTerminalEvidence } from "@manifold/protocol";
import type { z } from "zod";
import { BeginFileDeliverySchema, BeginFileDownloadSchema, FileDeliveryRequestSchema, FileDownloadRequestSchema, DescribeFileMachineSchema, FILE_CHUNK_BYTES, FILE_LIFETIME_MS, type FileTransfer } from "./contract.ts";
import { action, active, admission, byRequest, byteError, chunk, database, descriptor, digest, expires, fail, geometry, initialize, load, prepareData, reason, reserve, sameRef, transfer, type BoundContext, type DataContext, type TransferRow } from "./backend-store.ts";
import { authorizedFile, type FilesContext } from "./server.ts";

type Delivery = z.output<typeof BeginFileDeliverySchema>;
type Download = z.output<typeof BeginFileDownloadSchema>;
type DeliveryRequest = z.output<typeof FileDeliveryRequestSchema>;
type DownloadRequest = z.output<typeof FileDownloadRequestSchema>;
function pins(args: Delivery | Download): void {
  if (args.machine.machineId !== args.location.machineId || args.locationId !== args.location.locationId) fail("invalid");
}
function native(row: TransferRow): NativeTransferStatus | null {
  return row.native_status === null ? null : NativeTransferStatusSchema.parse(JSON.parse(row.native_status));
}
function result(row: TransferRow) { return { transfer: transfer(row), native: native(row) }; }
function state(status: NativeTransferStatus, kind: TransferRow["kind"]): FileTransfer["state"] {
  if (status.state === "committed") return "completed";
  if (status.state === "ready") return kind === "download" ? "reading" : "verifying";
  return status.state;
}
async function saveStatus(ctx: BoundContext, row: TransferRow, status: NativeTransferStatus): Promise<TransferRow> {
  if (row.native_id !== null && status.transferId !== row.native_id) return fail("integrity");
  if (status.mode !== (row.kind === "delivery" ? "put" : "read")) return fail("integrity");
  const next = state(status, row.kind);
  const done = ["completed", "cancelled", "refused", "failed", "expired"].includes(next);
  if (row.terminal !== null && !done && next !== "outcome_unknown") return row;
  const offset = row.kind === "delivery" ? status.bytes : row.offset;
  if (row.kind === "delivery" && offset > row.bytes) return fail("integrity");
  const encoded = canonicalJobJson(status);
  try {
    if ((!done || next === "completed") && encoded.length > (row.native_status?.length ?? 0)) await admission(database(ctx));
    await database(ctx).run(`UPDATE file_transfers SET native_id=?,native_status=?,state=?,bytes=?,
      offset=max(offset,?),sequence=max(sequence,?),progress=CASE WHEN offset<? THEN ? ELSE progress END,
      reason=?,active=?,terminal=CASE WHEN ?=1 THEN COALESCE(terminal,?) ELSE terminal END
      WHERE id=? AND (native_id IS NULL OR native_id=?) AND
        (terminal IS NULL OR ?=1 OR ?='outcome_unknown')`,
      [status.transferId, encoded, next, row.kind === "download" ? status.bytes : row.bytes,
        offset, Math.ceil(offset / FILE_CHUNK_BYTES), offset, ctx.now(), status.reason ?? null, done ? 0 : 1, done ? 1 : 0, ctx.now(), row.id, status.transferId,
        done ? 1 : 0, next]);
    return await load(ctx, row.id, row.kind);
  } catch (error) {
    if (status.state === "committed" || status.state === "outcome_unknown") return fail("outcome_unknown");
    throw error;
  }
}

/** Exact host-journal evidence releases only its own reservation, never any independent copy. */
export async function filesReconcileNativeTransfers(
  ctx: DataContext, input: readonly NativeTransferTerminalEvidence[],
): Promise<void> {
  const receipts = NativeTransferEvidenceBatchSchema.parse(input);
  // A native admission can durably refuse before begin returns its transfer ID. The
  // host's unique request/actor/credential/mode binding still identifies that queued row.
  const db = database(ctx);
  await initialize(db);
  await db.batch(receipts.map((receipt) => ({
    sql: `UPDATE file_transfers SET native_id=COALESCE(native_id,?),state=?,reason=?,active=0,charged=0,
      terminal=COALESCE(terminal,?),native_status=NULL
      WHERE (native_id=? OR (native_id IS NULL AND state='queued'))
        AND request_id=? AND actor=? AND credential=? AND kind=?
        AND (active=1 OR state IN ('publishing','outcome_unknown'))`,
    params: [receipt.transferId, receipt.state === "committed" ? "completed" : receipt.state, receipt.reason ?? null, ctx.now(),
      receipt.transferId, receipt.requestId, receipt.actorId, receipt.credentialBinding,
      receipt.mode === "put" ? "delivery" : "download"],
  })));
}
async function beginDelivery(ctx: FilesContext, args: Delivery) {
  pins(args); const source = await authorizedFile(ctx, args.ref); const file = descriptor(source);
  const binding = digest({ kind: "delivery", args, readyDigest: source.ready_digest, preparationId: source.preparation });
  let row = await byRequest(ctx, args.requestId, binding);
  if (row) {
    if (row.native_id) return result(await reconcile(ctx, row));
    active(row, ctx.now());
  } else {
    row = await reserve(ctx, { id: await ctx.newId(), requestId: args.requestId, binding, kind: "delivery", target: args.ref,
      fileId: args.ref.fileId, bytes: file.bytes, charged: 0, request: args, state: "queued" });
  }
  await database(ctx).run("UPDATE file_transfers SET preparation=?,ready_digest=? WHERE id=? AND native_id IS NULL", [source.preparation, source.ready_digest, row.id]);
  const status = await ctx.nativeTransfers.beginPut({ requestId: args.requestId, machineId: args.machine.machineId,
    installationRevision: args.installationRevision, artifactSha256: args.artifactSha256,
    locationId: args.locationId, locationRevision: args.locationRevision, filename: args.filename,
    source: { ref: file.ref, sha256: file.sha256, bytes: file.bytes } });
  return result(await saveStatus(ctx, row, status));
}
async function beginDownload(ctx: FilesContext, args: Download) {
  pins(args); const binding = digest({ kind: "download", args });
  let row = await byRequest(ctx, args.requestId, binding);
  if (row) {
    if (row.native_id) return result(await reconcile(ctx, row));
    active(row, ctx.now());
  } else {
    row = await reserve(ctx, { id: await ctx.newId(), requestId: args.requestId, binding, kind: "download", target: args.location,
      bytes: 0, charged: 0, request: args, state: "queued" });
  }
  const status = await ctx.nativeTransfers.beginRead({ requestId: args.requestId, machineId: args.machine.machineId,
    installationRevision: args.installationRevision, artifactSha256: args.artifactSha256,
    locationId: args.locationId, locationRevision: args.locationRevision, relativePath: args.relativePath });
  return result(await saveStatus(ctx, row, status));
}
async function bound(ctx: FilesContext, args: DeliveryRequest | DownloadRequest, kind: "delivery" | "download"): Promise<TransferRow> {
  const row = await load(ctx, args.transferId, kind);
  const request = kind === "delivery" ? BeginFileDeliverySchema.parse(JSON.parse(row.request)) : BeginFileDownloadSchema.parse(JSON.parse(row.request));
  if (!sameRef(args.machine, request.machine) || !sameRef(args.location, request.location)) return fail("unavailable");
  if (kind === "delivery") {
    if (!("ref" in args) || !("ref" in request) || !sameRef(args.ref, request.ref)) return fail("unavailable");
    const source = await authorizedFile(ctx, args.ref);
    if (source.ready_digest !== row.ready_digest || source.preparation !== row.preparation) return fail("unavailable");
  }
  return row;
}
async function reconcile(ctx: FilesContext, row: TransferRow): Promise<TransferRow> {
  if (row.native_id === null) return fail("conflict");
  const status = await ctx.nativeTransfers.status({ transferId: row.native_id });
  // Completing a browser download does not turn a retained snapshot status into a new read.
  if (row.kind === "download" && row.state === "completed" && status.state === "ready") return row;
  return saveStatus(ctx, row, status);
}
async function advanceDelivery(ctx: FilesContext, args: DeliveryRequest) {
  let row = await bound(ctx, args, "delivery"); active(row, ctx.now());
  if (row.native_id === null) return fail("conflict");
  if (row.state === "publishing" || row.state === "outcome_unknown") return result(await reconcile(ctx, row));
  row = await reconcile(ctx, row);
  if (row.state === "completed" || row.offset === row.bytes) return result(row);
  if (row.state !== "receiving") return fail("conflict");
  const source = await authorizedFile(ctx, args.ref);
  const data = await chunk(database(ctx), source.id, row.sequence);
  if (data.byteLength !== Math.min(FILE_CHUNK_BYTES, row.bytes - row.offset)) return fail("integrity");
  const status = await ctx.nativeTransfers.putChunk({ transferId: row.native_id!, seq: row.sequence, offset: row.offset, data });
  return result(await saveStatus(ctx, row, status));
}
async function commitDelivery(ctx: FilesContext, args: DeliveryRequest) {
  let row = await bound(ctx, args, "delivery");
  if (!row.native_id) return fail("conflict");
  // An unacknowledged commit never causes another commit. Only the owner can reconcile it.
  if (row.state === "publishing" || row.state === "outcome_unknown" || row.state === "completed") return result(await reconcile(ctx, row));
  active(row, ctx.now()); row = await reconcile(ctx, row);
  if (row.offset !== row.bytes || !["receiving", "verifying"].includes(row.state)) return fail("conflict");
  const claimed = await database(ctx).run("UPDATE file_transfers SET state='publishing' WHERE id=? AND state IN ('receiving','verifying')", [row.id]);
  if (claimed.changes !== 1) return fail("busy");
  let status: NativeTransferStatus;
  try {
    status = await ctx.nativeTransfers.commitPut({ transferId: row.native_id! });
  } catch (error) {
    const why = reason(error);
    // Preserve the floor's durable decision, not a guessed promise that retry is safe.
    if (why === "outcome_unknown" || why === "native_transfer_outcome_unknown" || why === "native_transfer_publication_unknown") {
      try {
        await database(ctx).run("UPDATE file_transfers SET state='outcome_unknown',reason='outcome_unknown' WHERE id=? AND state='publishing'", [row.id]);
      } catch {
        // The already-durable local publishing marker and the floor decision remain intact.
        return fail("outcome_unknown");
      }
    } else {
      await database(ctx).run("UPDATE file_transfers SET state='failed',reason=?,active=0,terminal=COALESCE(terminal,?) WHERE id=? AND state='publishing'", [why, ctx.now(), row.id]);
    }
    throw error;
  }
  try { return result(await saveStatus(ctx, row, status)); }
  catch {
    // The independent copy may already exist. Failure to persist its local projection is
    // uncertainty, never a failed-before-publication result or permission to commit again.
    return fail("outcome_unknown");
  }
}
async function cancel(ctx: FilesContext, args: DeliveryRequest | DownloadRequest, kind: "delivery" | "download") {
  const row = await bound(ctx, args, kind);
  if (!row.native_id) return fail("conflict");
  const status = await ctx.nativeTransfers.cancel({ transferId: row.native_id });
  return result(await saveStatus(ctx, row, status));
}
export const nativeHandlers = {
  describeMachine: action(async (ctx, args: z.output<typeof DescribeFileMachineSchema>) => ctx.nativeTransfers.describe({ machineId: args.machine.machineId })),
  beginDelivery: action(beginDelivery), advanceDelivery: action(advanceDelivery), commitDelivery: action(commitDelivery),
  inspectDelivery: action(async (ctx, args: DeliveryRequest) => result(await reconcile(ctx, await bound(ctx, args, "delivery")))),
  cancelDelivery: action(async (ctx, args: DeliveryRequest) => cancel(ctx, args, "delivery")),
  beginDownload: action(beginDownload),
  inspectDownload: action(async (ctx, args: DownloadRequest) => result(await reconcile(ctx, await bound(ctx, args, "download")))),
  cancelDownload: action(async (ctx, args: DownloadRequest) => cancel(ctx, args, "download")),
  receiptDelivery: action(async (ctx, args: { transferId: string }) => {
    const row = await load(ctx, args.transferId, "delivery");
    if (!row.native_id) return fail("unavailable");
    const receipt = await ctx.nativeTransfers.receipt({ transferId: row.native_id });
    if (receipt.state !== "outcome_unknown") {
      await filesReconcileNativeTransfers(ctx, [{ ...receipt, state: receipt.state, mode: "put", requestId: row.request_id,
        actorId: row.actor, credentialBinding: row.credential }]);
    }
    return { transferId: row.id, state: receipt.state === "committed" ? "completed" as const : receipt.state };
  }),
};
async function downloadAdmission(ctx: ByteCarrierContext, input: ByteCarrierRequest) {
  await prepareData(ctx); ctx.assertCurrent();
  const row = await load(ctx, input.transferId, "download");
  if (!sameRef(input.ref, JSON.parse(row.target))) return fail("unavailable");
  if (!row.native_id || !["reading", "completed"].includes(row.state) || ctx.now() >= expires(row)) return fail("expired");
  geometry(row, input, true); if (input.offset > row.offset) return fail("conflict");
  const status = await ctx.nativeTransfers.status({ transferId: row.native_id });
  const previous = native(row);
  if (status.state !== "ready" || status.bytes !== row.bytes || status.sha256 !== previous?.sha256 || !status.receipt) return fail("unavailable");
  ctx.assertCurrent(); return row;
}
export const downloadCarrier: ByteCarrierHandler = {
  direction: "outgoing",
  async authorize(ctx, input) {
    try { return { expiresAt: expires(await downloadAdmission(ctx, input)) }; }
    catch (error) { return byteError(error); }
  },
  async read(ctx, input) {
    try {
      const row = await downloadAdmission(ctx, input);
      const reply = input.length === 0 ? { data: new Uint8Array(0), offset: input.offset, eof: true } :
        await ctx.nativeTransfers.readChunk({ transferId: row.native_id!, offset: input.offset, maxBytes: input.length });
      if (reply.offset !== input.offset || reply.data.byteLength !== input.length || reply.eof !== (input.offset + input.length === row.bytes)) return fail("integrity");
      const end = input.offset + reply.data.byteLength;
      if (row.state === "reading" && (end > row.offset || row.bytes === 0)) {
        await database(ctx).run(`UPDATE file_transfers SET offset=?,sequence=?,progress=?,state=?,active=?,terminal=?
          WHERE id=? AND state='reading' AND offset=? AND progress+60000>? AND created+?>?`,
          [end, input.sequence + (input.length ? 1 : 0), ctx.now(), reply.eof ? "completed" : "reading", reply.eof ? 0 : 1, reply.eof ? ctx.now() : null,
            row.id, input.offset, ctx.now(), FILE_LIFETIME_MS, ctx.now()]);
      }
      const current = await load(ctx, row.id, "download");
      if (current.state === "cancelled") return fail("cancelled");
      if (!["reading", "completed"].includes(current.state) || current.offset < end) return fail("unavailable");
      ctx.assertCurrent(); if (ctx.now() >= expires(row)) return fail("expired");
      return { data: reply.data, offset: reply.offset, eof: reply.eof, leaseMs: Math.max(1, Math.min(15_000, expires(row) - ctx.now())) };
    } catch (error) { return byteError(error); }
  },
};
