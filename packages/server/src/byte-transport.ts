import {
  BYTE_EOF_HEADER,
  BYTE_LEASE_HEADER,
  BYTE_OFFSET_HEADER,
  ByteAdmissionSchema,
  ByteFailureSchema,
  ByteReadReceiptSchema,
  ByteTransferError,
  ByteWriteReceiptSchema,
  MAX_BYTE_REQUESTS,
  MAX_BYTE_REQUESTS_PER_PRINCIPAL,
  MAX_BYTE_REQUESTS_PER_TRANSFER,
  type ByteCarrierRequest,
  type ByteRefusal,
  type DatabaseRecoveryAdmission,
} from "@manifold/protocol";
import type { ByteCarrierContext, ByteCarrierHandler } from "@manifold/plugin";
import { NativeTransferError } from "@manifold/plugin";

/** No waiting queue: admission itself is bounded, including rejected/slow request bodies. */
export class ByteRequestPool {
  private count = 0;
  private readonly principals = new Map<string, number>();
  private readonly transfers = new Map<string, number>();

  acquire(principalId: string, pluginId: string, transferId: string): () => void {
    const transferKey = `${pluginId}:${transferId}`;
    const principalCount = this.principals.get(principalId) ?? 0;
    const transferCount = this.transfers.get(transferKey) ?? 0;
    if (
      this.count >= MAX_BYTE_REQUESTS ||
      principalCount >= MAX_BYTE_REQUESTS_PER_PRINCIPAL ||
      transferCount >= MAX_BYTE_REQUESTS_PER_TRANSFER
    )
      throw new ByteTransferError("busy");
    this.count++;
    this.principals.set(principalId, principalCount + 1);
    this.transfers.set(transferKey, transferCount + 1);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      this.count--;
      for (const [map, key] of [
        [this.principals, principalId],
        [this.transfers, transferKey],
      ] as const) {
        const count = (map.get(key) ?? 1) - 1;
        if (count === 0) map.delete(key);
        else map.set(key, count);
      }
    };
  }
}

export type ByteTransportFailure = "byte_handler_failed" | "byte_body_cancel_failed";

export function byteFailure(reason: ByteRefusal): Response {
  const status =
    reason === "unavailable"
      ? 403
      : reason === "busy" || reason === "database_busy"
        ? 429
        : reason === "invalid" || reason === "integrity" || reason === "unsupported"
          ? 400
          : 409;
  return new Response(JSON.stringify(ByteFailureSchema.parse({ error: reason })), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function receiveBytes(
  request: Request,
  expected: number,
  context: ByteCarrierContext,
  report: (failure: ByteTransportFailure) => void,
): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) !== expected))
    throw new ByteTransferError("invalid");
  if (request.headers.get("content-type") !== "application/octet-stream")
    throw new ByteTransferError("invalid");
  const data = new Uint8Array(expected);
  const reader = request.body?.getReader();
  if (reader === undefined) {
    if (expected !== 0) throw new ByteTransferError("invalid");
    return data;
  }
  let received = 0;
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    cancellation ??= reader.cancel().catch(() => report("byte_body_cancel_failed"));
    return cancellation;
  };
  const onAbort = (): void => {
    void cancel();
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  try {
    context.assertCurrent();
    for (;;) {
      const chunk = await reader.read();
      context.assertCurrent();
      if (chunk.done) {
        finished = true;
        break;
      }
      if (chunk.value.byteLength > expected - received) throw new ByteTransferError("invalid");
      data.set(chunk.value, received);
      received += chunk.value.byteLength;
    }
    if (received !== expected) throw new ByteTransferError("invalid");
    return data;
  } finally {
    context.signal.removeEventListener("abort", onAbort);
    try {
      if (!finished) await cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

/** Authority is rechecked when Bun pulls the body, not only when headers are constructed. */
function queuedResponse(
  data: Uint8Array,
  headers: Record<string, string>,
  context: ByteCarrierContext,
  release: () => void,
): Response {
  if (data.byteLength === 0) {
    context.assertCurrent();
    release();
    return new Response(null, { headers });
  }
  let finished = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    context.signal.removeEventListener("abort", abort);
    release();
  };
  const abort = (): void => {
    if (finished) return;
    stream?.error(new ByteTransferError("unavailable"));
    finish();
  };
  context.signal.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream = controller;
        if (context.signal.aborted) abort();
      },
      pull(controller) {
        if (finished) return;
        try {
          context.assertCurrent();
          controller.enqueue(data);
          controller.close();
        } catch {
          controller.error(new ByteTransferError("unavailable"));
        } finally {
          finish();
        }
      },
      cancel: finish,
    },
    { highWaterMark: 0 },
  );
  return new Response(body, { headers });
}

/** The host has already authenticated, admitted the exact declared cap/ref and bound the lease. */
export async function serveByteCarrier(options: {
  readonly request: Request;
  readonly input: ByteCarrierRequest;
  readonly context: ByteCarrierContext;
  readonly handler: ByteCarrierHandler;
  readonly release: () => void;
  readonly report: (failure: ByteTransportFailure) => void;
  readonly restrictDeadline: (expiresAt: number) => void;
  readonly admitIncoming?: () => Promise<DatabaseRecoveryAdmission>;
}): Promise<Response> {
  const { request, input, context, handler, release, report } = options;
  let writeStarted = false;
  try {
    context.assertCurrent();
    const admission = ByteAdmissionSchema.safeParse(await handler.authorize(context, input));
    if (!admission.success) throw new ByteTransferError("invalid");
    options.restrictDeadline(admission.data.expiresAt);
    context.assertCurrent();
    // This carrier is an exact-offset protocol, never a cache/range/conditional oracle.
    if (
      [
        "range",
        "if-range",
        "if-match",
        "if-none-match",
        "if-modified-since",
        "if-unmodified-since",
      ].some((header) => request.headers.has(header))
    )
      throw new ByteTransferError("invalid");
    if (handler.direction === "incoming") {
      const data = await receiveBytes(request, input.length, context, report);
      context.assertCurrent();
      const admission = await options.admitIncoming?.();
      context.assertCurrent();
      if (admission?.ok === false)
        throw new ByteTransferError(
          admission.reason === "recovery_unavailable" ? "unavailable" : admission.reason,
        );
      writeStarted = true;
      const receipt = ByteWriteReceiptSchema.safeParse(await handler.write(context, input, data));
      context.assertCurrent();
      if (
        !receipt.success ||
        receipt.data.sequence !== input.sequence ||
        receipt.data.acceptedBytes !== input.length ||
        receipt.data.offset < input.offset + input.length
      )
        throw new ByteTransferError("outcome_unknown");
      return queuedResponse(
        new TextEncoder().encode(JSON.stringify(receipt.data)),
        {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
        context,
        release,
      );
    }
    const { data, ...rawReceipt } = await handler.read(context, input);
    context.assertCurrent();
    const receipt = ByteReadReceiptSchema.safeParse(rawReceipt);
    if (
      !receipt.success ||
      !(data instanceof Uint8Array) ||
      data.byteLength > input.length ||
      receipt.data.offset !== input.offset ||
      (data.byteLength === 0 && input.length !== 0 && !receipt.data.eof)
    )
      throw new ByteTransferError("unavailable");
    return queuedResponse(
      data,
      {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment",
        "content-length": String(data.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        [BYTE_OFFSET_HEADER]: String(receipt.data.offset),
        [BYTE_EOF_HEADER]: String(receipt.data.eof),
        [BYTE_LEASE_HEADER]: String(receipt.data.leaseMs),
      },
      context,
      release,
    );
  } catch (error) {
    release();
    if (error instanceof ByteTransferError) return byteFailure(error.reason);
    if (error instanceof NativeTransferError) return byteFailure(error.reason);
    report("byte_handler_failed");
    return byteFailure(writeStarted ? "outcome_unknown" : "unavailable");
  }
}
