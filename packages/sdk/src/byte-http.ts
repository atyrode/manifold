import {
  BYTE_EOF_HEADER,
  BYTE_LEASE_HEADER,
  BYTE_OFFSET_HEADER,
  BYTE_REQUEST_TIMEOUT_MS,
  ByteCarrierRequestSchema,
  ByteFailureSchema,
  ByteReadReceiptSchema,
  ByteTransferError,
  ByteWriteReceiptSchema,
  LocalNameSchema,
  PluginIdSchema,
  formatManifoldUri,
  type ByteCarrierRequest,
  type ByteReadChunk,
  type ByteWriteReceipt,
} from "@manifold/protocol";
import type { ActionHttpOptions } from "./action-http.ts";

export type ByteHttpOptions = Pick<ActionHttpOptions, "origin" | "token" | "signal" | "timeoutMs">;

async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new ByteTransferError("invalid");
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const result = new Uint8Array(declared === null ? limit : Number(declared));
  let length = 0;
  let done = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) {
        done = true;
        break;
      }
      if (part.value.byteLength > result.byteLength - length) throw new ByteTransferError("invalid");
      result.set(part.value, length);
      length += part.value.byteLength;
    }
    if (declared !== null && length !== result.byteLength) throw new ByteTransferError("invalid");
    return length === result.byteLength ? result : result.subarray(0, length);
  } finally {
    try {
      if (!done) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

function targetUrl(
  origin: string,
  pluginId: string,
  carrierId: string,
  request: ByteCarrierRequest,
): URL {
  if (!PluginIdSchema.safeParse(pluginId).success || !LocalNameSchema.safeParse(carrierId).success)
    throw new ByteTransferError("invalid");
  const url = new URL(`${origin.replace(/\/+$/, "")}/api/bytes/${pluginId}/${carrierId}`);
  url.search = new URLSearchParams({
    transferId: request.transferId,
    ref: formatManifoldUri(request.ref),
    offset: String(request.offset),
    sequence: String(request.sequence),
    length: String(request.length),
  }).toString();
  return url;
}

function isUnsharedByteArray(data: Uint8Array): data is Uint8Array<ArrayBuffer> {
  return data.buffer instanceof ArrayBuffer;
}

async function exchange<T>(
  options: ByteHttpOptions,
  pluginId: string,
  carrierId: string,
  input: ByteCarrierRequest,
  data: Uint8Array | undefined,
  receive: (response: Response, signal: AbortSignal, request: ByteCarrierRequest) => Promise<T>,
): Promise<T> {
  const parsed = ByteCarrierRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    (data !== undefined && (!isUnsharedByteArray(data) || data.byteLength !== parsed.data.length))
  )
    throw new ByteTransferError("invalid");
  if (options.signal?.aborted) throw new ByteTransferError("cancelled");
  const timeoutMs = options.timeoutMs ?? BYTE_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BYTE_REQUEST_TIMEOUT_MS)
    throw new ByteTransferError("invalid");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  const headers = new Headers({ authorization: `Bearer ${options.token}` });
  if (data !== undefined) headers.set("content-type", "application/octet-stream");
  try {
    const response = await fetch(targetUrl(options.origin, pluginId, carrierId, parsed.data), {
      method: data === undefined ? "GET" : "POST",
      headers,
      ...(data === undefined ? {} : { body: data }),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    try {
      if (!response.ok) {
        const bytes = await boundedBody(response, 2048, signal);
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new ByteTransferError(data === undefined ? "unavailable" : "outcome_unknown");
        }
        const failure = ByteFailureSchema.safeParse(payload);
        throw new ByteTransferError(
          failure.success
            ? failure.data.error
            : data === undefined ? "unavailable" : "outcome_unknown",
        );
      }
      if (response.headers.get("cache-control") !== "no-store")
        throw new ByteTransferError(data === undefined ? "invalid" : "outcome_unknown");
      return await receive(response, signal, parsed.data);
    } finally {
      if (response.body !== null && !response.bodyUsed) await response.body.cancel();
    }
  } catch (error) {
    if (options.signal?.aborted)
      throw new ByteTransferError(data === undefined ? "cancelled" : "outcome_unknown");
    if (timeout.aborted)
      throw new ByteTransferError(data === undefined ? "request_timeout" : "outcome_unknown");
    if (error instanceof ByteTransferError) throw error;
    throw new ByteTransferError(data === undefined ? "unavailable" : "outcome_unknown");
  }
}

/** Durable acknowledgement, never inferred from a successful socket write. */
export function writeByteChunk(
  options: ByteHttpOptions,
  pluginId: string,
  carrierId: string,
  input: ByteCarrierRequest,
  data: Uint8Array,
): Promise<ByteWriteReceipt> {
  return exchange(options, pluginId, carrierId, input, data, async (response, signal, request) => {
    const body = await boundedBody(response, 2048, signal);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new ByteTransferError("outcome_unknown");
    }
    const receipt = ByteWriteReceiptSchema.safeParse(payload);
    if (
      !receipt.success ||
      receipt.data.sequence !== request.sequence ||
      receipt.data.acceptedBytes !== request.length ||
      receipt.data.offset < request.offset + request.length
    )
      throw new ByteTransferError("outcome_unknown");
    return receipt.data;
  });
}

/** All readers share the bounded authenticated carrier; no bearer or signed URL is returned. */
export function readByteChunk(
  options: ByteHttpOptions,
  pluginId: string,
  carrierId: string,
  input: ByteCarrierRequest,
): Promise<ByteReadChunk> {
  return exchange(options, pluginId, carrierId, input, undefined, async (response, signal, request) => {
    const rawOffset = response.headers.get(BYTE_OFFSET_HEADER);
    const rawLease = response.headers.get(BYTE_LEASE_HEADER);
    const rawEof = response.headers.get(BYTE_EOF_HEADER);
    if (
      rawOffset === null ||
      !/^\d+$/.test(rawOffset) ||
      rawLease === null ||
      !/^\d+$/.test(rawLease) ||
      (rawEof !== "true" && rawEof !== "false") ||
      response.headers.get("content-type") !== "application/octet-stream"
    )
      throw new ByteTransferError("invalid");
    const receipt = ByteReadReceiptSchema.safeParse({
      offset: Number(rawOffset),
      eof: rawEof === "true",
      leaseMs: Number(rawLease),
    });
    if (!receipt.success || receipt.data.offset !== request.offset)
      throw new ByteTransferError("invalid");
    const data = await boundedBody(response, request.length, signal);
    if (data.byteLength === 0 && request.length !== 0 && !receipt.data.eof)
      throw new ByteTransferError("invalid");
    return { ...receipt.data, data };
  });
}
