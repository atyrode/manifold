import { z } from "zod";
import { ManifoldRefSchema } from "./uri.ts";
import { NativeTransferReasonSchema } from "./native-transfers.ts";

export const MAX_BYTE_CHUNK_BYTES = 256 * 1024;
export const MAX_BYTE_REQUESTS = 16;
export const MAX_BYTE_REQUESTS_PER_PRINCIPAL = 8;
export const MAX_BYTE_REQUESTS_PER_TRANSFER = 4;
export const BYTE_REQUEST_TIMEOUT_MS = 15_000;
export const BYTE_READ_LEASE_MS = 15_000;
export const BYTE_OFFSET_HEADER = "x-manifold-byte-offset";
export const BYTE_EOF_HEADER = "x-manifold-byte-eof";
export const BYTE_LEASE_HEADER = "x-manifold-byte-lease-ms";

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ByteCarrierRequestSchema = z.strictObject({
  transferId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  ref: ManifoldRefSchema,
  offset: position,
  sequence: position,
  length: z.number().int().min(0).max(MAX_BYTE_CHUNK_BYTES),
});
export type ByteCarrierRequest = z.infer<typeof ByteCarrierRequestSchema>;

/** The owner can shorten a request lease, never extend the host's credential/deadline bounds. */
export const ByteAdmissionSchema = z.strictObject({
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ByteAdmission = z.infer<typeof ByteAdmissionSchema>;

export const ByteWriteReceiptSchema = z.strictObject({
  /** Durable accepted position; a replay may observe later, already-acknowledged progress. */
  offset: position,
  sequence: position,
  acceptedBytes: z.number().int().min(0).max(MAX_BYTE_CHUNK_BYTES),
});
export type ByteWriteReceipt = z.infer<typeof ByteWriteReceiptSchema>;

export const ByteReadReceiptSchema = z.strictObject({
  offset: position,
  eof: z.boolean(),
  leaseMs: z.number().int().positive().max(BYTE_READ_LEASE_MS),
});
export type ByteReadReceipt = z.infer<typeof ByteReadReceiptSchema>;
export interface ByteReadChunk extends ByteReadReceipt {
  readonly data: Uint8Array;
}
/** In-process/structured-clone shape; the public HTTP vocabulary describes its raw body separately. */
export const ByteReadChunkSchema = ByteReadReceiptSchema.extend({
  data: z.instanceof(Uint8Array).refine((data) => data.byteLength <= MAX_BYTE_CHUNK_BYTES),
});

export const BYTE_REFUSALS = [
  "unavailable",
  "invalid",
  "busy",
  "expired",
  "cancelled",
  "request_timeout",
  "quota",
  "recovery_unavailable",
  "storage_capacity",
  "backup_capacity",
  "database_busy",
  "database_full",
  "outcome_unknown",
  "integrity",
  "conflict",
  "unsupported",
] as const;
export const ByteRefusalSchema = z.union([z.enum(BYTE_REFUSALS), NativeTransferReasonSchema]);
export type ByteRefusal = z.infer<typeof ByteRefusalSchema>;
export const ByteFailureSchema = z.strictObject({ error: ByteRefusalSchema });

/** A controlled transport refusal: never serialize a plugin's arbitrary exception message. */
export class ByteTransferError extends Error {
  constructor(readonly reason: ByteRefusal) {
    super(reason);
    this.name = "ByteTransferError";
  }
}

export function byteVocabulary(): Record<string, unknown> {
  return {
    path: "/api/bytes/{pluginId}/{carrierId}",
    methods: { incoming: "POST", outgoing: "GET" },
    request: z.toJSONSchema(ByteCarrierRequestSchema),
    writeReceipt: z.toJSONSchema(ByteWriteReceiptSchema),
    readReceipt: z.toJSONSchema(ByteReadReceiptSchema),
    failure: z.toJSONSchema(ByteFailureSchema),
    headers: {
      offset: BYTE_OFFSET_HEADER,
      eof: BYTE_EOF_HEADER,
      leaseMs: BYTE_LEASE_HEADER,
    },
    maxChunkBytes: MAX_BYTE_CHUNK_BYTES,
    maxRequests: MAX_BYTE_REQUESTS,
    maxRequestsPerPrincipal: MAX_BYTE_REQUESTS_PER_PRINCIPAL,
    maxRequestsPerTransfer: MAX_BYTE_REQUESTS_PER_TRANSFER,
    requestTimeoutMs: BYTE_REQUEST_TIMEOUT_MS,
    readLeaseMs: BYTE_READ_LEASE_MS,
    authentication: "Bearer; no ambient credentials, redirects or bearer URLs",
    cache: "no-store",
  };
}
