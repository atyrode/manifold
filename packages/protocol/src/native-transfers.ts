import { z } from "zod";
import { ManifoldRefSchema } from "./uri.ts";

export const NATIVE_TRANSFER_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const NATIVE_TRANSFER_MAX_CHUNK_BYTES = 256 * 1024;
export const NATIVE_TRANSFER_MAX_ACTIVE = 4;
export const NATIVE_TRANSFER_MAX_PER_ACTOR = 2;
export const NATIVE_TRANSFER_MAX_PRIVATE_BYTES = 32 * 1024 * 1024;
export const NATIVE_TRANSFER_MAX_RECEIPTS = 1_000;
export const NATIVE_TRANSFER_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const NATIVE_TRANSFER_IDLE_MS = 60_000;
export const NATIVE_TRANSFER_MAX_LIFETIME_MS = 15 * 60 * 1_000;
export const NATIVE_TRANSFER_PERMIT_MS = 5_000;

const id = z.string().min(1).max(128);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = z.number().int().nonnegative().max(NATIVE_TRANSFER_MAX_FILE_BYTES);
/** Closed, non-sensitive refusal data; arbitrary exception messages never cross the carrier. */
export const NATIVE_TRANSFER_REASONS = [
  "consent_changed",
  "credential_revoked_or_expired",
  "destination_exists",
  "installation_changed",
  "location_changed",
  "machine_unavailable",
  "outcome_unknown",
  "owner_draining",
  "owner_fenced",
  "storage_capacity",
  "transfer_action_unavailable",
  "transfer_authority_refused",
  "transfer_backpressure",
  "transfer_capacity",
  "transfer_chunk_limit",
  "transfer_concurrency_limit",
  "transfer_disconnected",
  "transfer_expired",
  "transfer_invalid_request",
  "transfer_mode_mismatch",
  "transfer_receipt_limit",
  "transfer_reply_invalid",
  "transfer_request_conflict",
  "transfer_requirement_undeclared",
  "transfer_source_changed",
  "transfer_source_unavailable",
  "transfer_unavailable",
  "native_snapshot_failed",
  "native_snapshot_timeout",
  "native_snapshot_unavailable",
  "native_snapshot_unsealed",
  "native_snapshot_unsupported",
  "native_source_changed",
  "native_source_writer_active",
  "native_transfer_active_limit",
  "native_transfer_anchor_changed",
  "native_transfer_anchor_unavailable",
  "native_transfer_artifact_invalid",
  "native_transfer_artifact_mismatch",
  "native_transfer_authority_changed",
  "native_transfer_busy",
  "native_transfer_cancelled",
  "native_transfer_chunk_limit",
  "native_transfer_chunk_sequence_mismatch",
  "native_transfer_cleanup_unknown",
  "native_transfer_consent_undeclared",
  "native_transfer_directory_required",
  "native_transfer_expired",
  "native_transfer_failed",
  "native_transfer_file_limit",
  "native_transfer_hash_mismatch",
  "native_transfer_identity_changed",
  "native_transfer_installation_changed",
  "native_transfer_io_failed",
  "native_transfer_job_location_busy",
  "native_transfer_length_mismatch",
  "native_transfer_location_busy",
  "native_transfer_location_changed",
  "native_transfer_location_invalid",
  "native_transfer_location_namespace",
  "native_transfer_location_parent_missing",
  "native_transfer_managed_root_required",
  "native_transfer_not_active",
  "native_transfer_not_prepared",
  "native_transfer_not_put",
  "native_transfer_not_readable",
  "native_transfer_not_receiving",
  "native_transfer_outcome_unknown",
  "native_transfer_owner_draining",
  "native_transfer_owner_fenced",
  "native_transfer_owner_restart",
  "native_transfer_owner_unavailable",
  "native_transfer_permit_binding_mismatch",
  "native_transfer_permit_consumed",
  "native_transfer_permit_expired",
  "native_transfer_permit_invalid",
  "native_transfer_platform_unsupported",
  "native_transfer_prepared_changed",
  "native_transfer_private_capacity",
  "native_transfer_protocol_unsupported",
  "native_transfer_publication_unknown",
  "native_transfer_queue_limit",
  "native_transfer_read_range",
  "native_transfer_receipt_capacity",
  "native_transfer_receipt_path_unavailable",
  "native_transfer_recovery_unknown",
  "native_transfer_request_conflict",
  "native_transfer_root_changed",
  "native_transfer_root_unavailable",
  "native_transfer_seat_changed",
  "native_transfer_short_read",
  "native_transfer_short_write",
  "native_transfer_source_missing",
  "native_transfer_unavailable",
  "native_transfer_unknown",
  "native_transfer_unsupported",
] as const;
export const NativeTransferReasonSchema = z.enum(NATIVE_TRANSFER_REASONS);
export type NativeTransferReason = z.infer<typeof NativeTransferReasonSchema>;
const encoder = new TextEncoder();
/** One NFC component, excluding alternate paths and ambiguous platform spellings. */
export const NativeTransferFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      value.normalize("NFC") === value &&
      !/[\\/:\x00-\x1f\x7f]/.test(value) &&
      !/[. ]$/.test(value) &&
      !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value) &&
      encoder.encode(value).byteLength <= 255,
  );
export const NativeTransferRelativePathSchema = z
  .array(NativeTransferFilenameSchema)
  .min(1)
  .max(16)
  .refine((components) => encoder.encode(components.join("/")).byteLength <= 4096);
export const NativeTransferAccessSchema = z.enum(["read", "create-child"]);
export type NativeTransferAccess = z.infer<typeof NativeTransferAccessSchema>;
const access = z
  .array(NativeTransferAccessSchema)
  .min(1)
  .max(2)
  .refine((rights) => new Set(rights).size === rights.length);

/** Inline reviewed artifact: the selected complete location declarations are part of its digest. */
export const NativeTransferPolicySchema = z.strictObject({
  format: z.literal("native-transfer-v1"),
  locations: z
    .record(id, access)
    .refine(
      (locations) => Object.keys(locations).length > 0 && Object.keys(locations).length <= 64,
    ),
});
export type NativeTransferPolicy = z.infer<typeof NativeTransferPolicySchema>;

const pins = {
  requestId: id,
  machineId: id,
  installationRevision: id,
  artifactSha256: hash,
  locationId: id,
  locationRevision: id,
};
export const NativeTransferBeginPutArgsSchema = z.strictObject({
  ...pins,
  filename: NativeTransferFilenameSchema,
  source: z.strictObject({ ref: ManifoldRefSchema, sha256: hash, bytes }),
});
export type NativeTransferBeginPutArgs = z.infer<typeof NativeTransferBeginPutArgsSchema>;
export const NativeTransferBeginReadArgsSchema = z.strictObject({
  ...pins,
  relativePath: NativeTransferRelativePathSchema,
});
export type NativeTransferBeginReadArgs = z.infer<typeof NativeTransferBeginReadArgsSchema>;
export const NativeTransferContinuationArgsSchema = z.strictObject({ transferId: id });
export type NativeTransferContinuationArgs = z.infer<typeof NativeTransferContinuationArgsSchema>;
const chunk: z.ZodType<Uint8Array, Uint8Array> = z
  .instanceof(Uint8Array)
  .refine((data) => data.byteLength <= NATIVE_TRANSFER_MAX_CHUNK_BYTES);
export const NativeTransferPutChunkArgsSchema = z.strictObject({
  transferId: id,
  seq: count,
  offset: bytes,
  data: chunk.refine((data) => data.byteLength > 0),
});
export type NativeTransferPutChunkArgs = z.infer<typeof NativeTransferPutChunkArgsSchema>;
export const NativeTransferReadChunkArgsSchema = z.strictObject({
  transferId: id,
  offset: bytes,
  maxBytes: z.number().int().positive().max(NATIVE_TRANSFER_MAX_CHUNK_BYTES),
});
export type NativeTransferReadChunkArgs = z.infer<typeof NativeTransferReadChunkArgsSchema>;
export const NativeTransferDescribeArgsSchema = z.strictObject({ machineId: id });
export type NativeTransferDescribeArgs = z.infer<typeof NativeTransferDescribeArgsSchema>;
export const NativeTransferDescriptionSchema = z.strictObject({
  machineId: id,
  installationRevision: id,
  artifactSha256: hash,
  ownerId: id,
  ownerGeneration: count,
  locations: z
    .array(
      z.strictObject({
        locationId: id,
        locationRevision: id,
        access,
        available: z.boolean(),
        reason: NativeTransferReasonSchema.optional(),
      }),
    )
    .max(64)
    .refine(
      (locations) => new Set(locations.map((row) => row.locationId)).size === locations.length,
    ),
});
export type NativeTransferDescription = z.infer<typeof NativeTransferDescriptionSchema>;

const identity = {
  pluginId: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,2}$/)
    .max(64),
  actorId: id,
  credentialBinding: hash,
};
const putRequest = z.strictObject({
  mode: z.literal("put"),
  ...NativeTransferBeginPutArgsSchema.shape,
});
const readRequest = z.strictObject({
  mode: z.literal("read"),
  ...NativeTransferBeginReadArgsSchema.shape,
});
/** Only the floor constructs this identity; no public argument accepts an override. */
export const NativeTransferBindingSchema = z
  .strictObject({
    transferId: id,
    ...identity,
    createdAt: count,
    expiresAt: count,
    request: z.discriminatedUnion("mode", [putRequest, readRequest]),
  })
  .refine(
    ({ createdAt, expiresAt }) =>
      expiresAt > createdAt && expiresAt - createdAt <= NATIVE_TRANSFER_MAX_LIFETIME_MS,
  );
export type NativeTransferBinding = z.infer<typeof NativeTransferBindingSchema>;

export const NativeTransferReceiptSchema = z.strictObject({
  transferId: id,
  mode: z.enum(["put", "read"]),
  ...pins,
  ...identity,
  ownerId: id,
  ownerGeneration: count,
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes("\0") && encoder.encode(value).byteLength <= 4096),
  bytes,
  sha256: hash,
  committedAt: count,
});
export type NativeTransferReceipt = z.infer<typeof NativeTransferReceiptSchema>;
export const NativeTransferStateSchema = z.enum([
  "queued",
  "receiving",
  "verifying",
  "ready",
  "committed",
  "cancelled",
  "refused",
  "failed",
  "expired",
  "outcome_unknown",
]);
export type NativeTransferState = z.infer<typeof NativeTransferStateSchema>;
export const NativeTransferStatusSchema = z
  .strictObject({
    transferId: id,
    mode: z.enum(["put", "read"]),
    state: NativeTransferStateSchema,
    bytes,
    sha256: hash.optional(),
    reason: NativeTransferReasonSchema.optional(),
    receipt: NativeTransferReceiptSchema.optional(),
  })
  .refine(
    (status) =>
      (status.state !== "committed" && !(status.mode === "read" && status.state === "ready")) ||
      status.receipt !== undefined,
  )
  .refine(
    (status) =>
      !status.receipt ||
      ((status.state === "committed" || (status.mode === "read" && status.state === "ready")) &&
        status.receipt.transferId === status.transferId &&
        status.receipt.mode === status.mode &&
        status.receipt.bytes === status.bytes &&
        status.receipt.sha256 === status.sha256),
  );
export type NativeTransferStatus = z.infer<typeof NativeTransferStatusSchema>;

/** Non-sensitive receipt projection. Neither correlation nor this evidence grants authority. */
export const NativeTransferTerminalStateSchema = z.enum([
  "committed",
  "cancelled",
  "refused",
  "failed",
  "expired",
]);
export const NativeTransferReceiptViewSchema = z.strictObject({
  transferId: id,
  state: z.union([NativeTransferTerminalStateSchema, z.literal("outcome_unknown")]),
  reason: NativeTransferReasonSchema.optional(),
});
export type NativeTransferReceiptView = z.infer<typeof NativeTransferReceiptViewSchema>;
/** Host-private reservation reconciliation; no destination path, source metadata or bytes. */
export const NativeTransferTerminalEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("terminal"),
    transferId: id,
    requestId: id,
    actorId: id,
    credentialBinding: hash,
    mode: z.enum(["put", "read"]),
    state: NativeTransferTerminalStateSchema,
    reason: NativeTransferReasonSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("admission-refused"),
    requestId: id,
    actorId: id,
    credentialBinding: hash,
    mode: z.enum(["put", "read"]),
    attemptedAt: count,
    reason: NativeTransferReasonSchema,
  }),
]);
export type NativeTransferTerminalEvidence = z.infer<typeof NativeTransferTerminalEvidenceSchema>;
export const NativeTransferEvidenceBatchSchema = z
  .array(NativeTransferTerminalEvidenceSchema)
  .min(1)
  .max(64);
export const NativeTransferReadChunkResultSchema = z
  .strictObject({
    data: chunk,
    offset: bytes,
    eof: z.boolean(),
    status: NativeTransferStatusSchema,
  })
  .refine(
    (reply) =>
      reply.status.mode === "read" && reply.offset + reply.data.byteLength <= reply.status.bytes,
  );
export type NativeTransferReadChunkResult = z.infer<typeof NativeTransferReadChunkResultSchema>;

/** JSON carriers count decoded bytes, including the final base64 quantum. */
export const NativeTransferChunkDataSchema = z
  .base64()
  .max(Math.ceil(NATIVE_TRANSFER_MAX_CHUNK_BYTES / 3) * 4)
  .refine((data) => decodedChunkBytes(data) <= NATIVE_TRANSFER_MAX_CHUNK_BYTES);
function decodedChunkBytes(data: string): number {
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export const NativeTransferReadChunkWireResultSchema = z
  .strictObject({
    data: NativeTransferChunkDataSchema,
    offset: bytes,
    eof: z.boolean(),
    status: NativeTransferStatusSchema,
  })
  .refine(
    (reply) =>
      reply.status.mode === "read" &&
      reply.offset + decodedChunkBytes(reply.data) <= reply.status.bytes,
  );
export type NativeTransferReadChunkWireResult = z.infer<
  typeof NativeTransferReadChunkWireResultSchema
>;
export const NativeTransferRequestSchema = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("beginPut"),
    binding: NativeTransferBindingSchema.safeExtend({ request: putRequest }),
  }),
  z.strictObject({
    method: z.literal("beginRead"),
    binding: NativeTransferBindingSchema.safeExtend({ request: readRequest }),
  }),
  z
    .strictObject({
      method: z.literal("putChunk"),
      transferId: id,
      seq: count,
      offset: bytes,
      data: NativeTransferChunkDataSchema.refine((data) => data.length > 0),
    })
    .refine(
      (request) =>
        request.offset + decodedChunkBytes(request.data) <= NATIVE_TRANSFER_MAX_FILE_BYTES,
    ),
  z.strictObject({ method: z.literal("preparePut"), transferId: id }),
  z.strictObject({ method: z.literal("commitPut"), transferId: id }),
  z.strictObject({ method: z.literal("readChunk"), ...NativeTransferReadChunkArgsSchema.shape }),
  z.strictObject({ method: z.literal("cancel"), transferId: id }),
  z.strictObject({ method: z.literal("status"), transferId: id }),
  // Host-only: exact original journal identity; never accepted by plugin effect methods.
  z.strictObject({
    method: z.literal("evidence"),
    transferId: id,
    bindingDigest: hash,
    ownerGeneration: count,
  }),
]);
export type NativeTransferRequest = z.infer<typeof NativeTransferRequestSchema>;

/** Every command, including status, is signed over its complete canonical request digest. */
export const NativeTransferPermitSchema = z.strictObject({
  body: z
    .strictObject({
      permitId: id,
      commandDigest: hash,
      transferId: id,
      ...identity,
      machineId: id,
      ownerId: id,
      ownerGeneration: count,
      /** The proved attachment challenge; reconnecting the same owner fences old permits. */
      seatNonce: id,
      issuedAt: count,
      expiresAt: count,
    })
    .refine(
      ({ issuedAt, expiresAt }) =>
        expiresAt > issuedAt && expiresAt - issuedAt <= NATIVE_TRANSFER_PERMIT_MS,
    ),
  signature: z.base64().length(88),
});
export type NativeTransferPermit = z.infer<typeof NativeTransferPermitSchema>;
export const NativeTransferResultSchema = z.discriminatedUnion("ok", [
  z
    .strictObject({
      ok: z.literal(true),
      status: NativeTransferStatusSchema,
      data: NativeTransferChunkDataSchema.optional(),
      offset: bytes.optional(),
      eof: z.boolean().optional(),
    })
    .refine((result) =>
      result.data === undefined
        ? result.offset === undefined && result.eof === undefined
        : result.offset !== undefined &&
          result.eof !== undefined &&
          result.status.mode === "read" &&
          result.offset + decodedChunkBytes(result.data) <= result.status.bytes,
    ),
  z.strictObject({
    ok: z.literal(false),
    reason: NativeTransferReasonSchema,
    status: NativeTransferStatusSchema.optional(),
  }),
]);
export type NativeTransferResult = z.infer<typeof NativeTransferResultSchema>;
