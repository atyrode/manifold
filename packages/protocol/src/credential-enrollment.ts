import { z } from "zod";
import { ServiceCredentialReferenceSchema, ServiceReadArgsSchema } from "./services.ts";

export const CREDENTIAL_ENROLLMENT_VERSION = 1;
export const CREDENTIAL_ENROLLMENT_SUITE = "HPKE-P256-HKDF-SHA256-AES-256-GCM";
export const CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES = 16_384;
export const CREDENTIAL_ENROLLMENT_MAX_CIPHERTEXT_BYTES =
  CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES + 16;
export const CREDENTIAL_ENROLLMENT_TTL_MS = 120_000;
export const CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS = 5_000;
export const CREDENTIAL_ENROLLMENT_PENDING_LIMIT = 64;
export const CREDENTIAL_ENROLLMENT_REPLAY_LIMIT = 128;

const requestId = z.uuid();
const expiry = z.int().nonnegative();
const version = z.int().positive().max(65_535);
const keyId = z.string().regex(/^[a-f0-9]{64}$/);
/** Applied after strict standard-base64 grammar, without allocating decoded ciphertext. */
function decodedBase64Bytes(value: string): number {
  return (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
const p256PublicKey = z
  .base64()
  .length(88)
  .refine((value) => decodedBase64Bytes(value) === 65);

/** Public encryption metadata belongs to the immutable, signed owner announcement. */
export const ServiceCredentialEnrollmentKeySchema = z.strictObject({
  version,
  suite: z.literal(CREDENTIAL_ENROLLMENT_SUITE),
  keyId,
  publicKey: p256PublicKey,
});
export type ServiceCredentialEnrollmentPublicKey = z.infer<
  typeof ServiceCredentialEnrollmentKeySchema
>;

export const ServiceCredentialEnrollmentRefusalSchema = z.enum([
  "credential_unauthorized",
  "credential_machine_unknown",
  "credential_owner_offline",
  "credential_owner_unproved",
  "credential_protocol_unsupported",
  "credential_key_unavailable",
  "credential_key_version_unsupported",
  "credential_key_changed",
  "credential_reference_unknown",
  "credential_origin_disallowed",
  "credential_already_held",
  "credential_source_unavailable",
  "credential_source_read_only",
  "credential_source_changed",
  "credential_source_invalid",
  "credential_enrollment_busy",
  "credential_enrollment_expired",
  "credential_enrollment_replayed",
  "credential_enrollment_unknown",
  "credential_enrollment_cancelled",
  "credential_envelope_invalid",
  "credential_value_invalid",
  "credential_storage_failed",
  "credential_owner_changed",
  "credential_target_mismatch",
]);
export type ServiceCredentialEnrollmentRefusal = z.infer<
  typeof ServiceCredentialEnrollmentRefusalSchema
>;
const refusal = z.strictObject({
  kind: z.literal("refused"),
  reason: ServiceCredentialEnrollmentRefusalSchema,
});
const unknown = z.strictObject({
  kind: z.literal("unknown"),
  reason: z.literal("credential_outcome_unknown"),
});

/** No source path, secret fingerprint, bearer or plaintext belongs in this context. */
export const ServiceCredentialEnrollmentContextSchema = z.strictObject({
  version,
  suite: z.literal(CREDENTIAL_ENROLLMENT_SUITE),
  keyId,
  machineId: ServiceReadArgsSchema.shape.machineId,
  ownerId: z.string().min(1).max(128),
  ownerGeneration: z.int().nonnegative(),
  requestId,
  serverEpoch: z.string().min(1).max(128),
  ownerChallenge: z.string().min(1).max(128),
  credentialRef: ServiceCredentialReferenceSchema.shape.ref,
  origin: ServiceCredentialReferenceSchema.shape.origins.element,
  nonce: z.uuid(),
  expiresAt: expiry,
  replace: z.boolean(),
  /** Incarnation-local opaque revision, never a digest of credential bytes. */
  sourceRevision: z.uuid().nullable(),
});
export type ServiceCredentialEnrollmentContext = z.infer<
  typeof ServiceCredentialEnrollmentContextSchema
>;
export const ServiceCredentialEnrollmentChallengeSchema = z.strictObject({
  context: ServiceCredentialEnrollmentContextSchema,
  key: ServiceCredentialEnrollmentKeySchema,
});
export type ServiceCredentialEnrollmentChallenge = z.infer<
  typeof ServiceCredentialEnrollmentChallengeSchema
>;
export const ServiceCredentialEnrollmentEnvelopeSchema = z.strictObject({
  context: ServiceCredentialEnrollmentContextSchema,
  enc: p256PublicKey,
  ciphertext: z
    .base64()
    .min(24)
    .max(Math.ceil(CREDENTIAL_ENROLLMENT_MAX_CIPHERTEXT_BYTES / 3) * 4)
    .refine((value) => {
      const bytes = decodedBase64Bytes(value);
      return bytes >= 17 && bytes <= CREDENTIAL_ENROLLMENT_MAX_CIPHERTEXT_BYTES;
    }),
});
export type ServiceCredentialEnrollmentEnvelope = z.infer<
  typeof ServiceCredentialEnrollmentEnvelopeSchema
>;
export const ServiceCredentialEnrollmentPrepareArgsSchema = z.strictObject({
  machineId: ServiceReadArgsSchema.shape.machineId,
  credentialRef: ServiceCredentialReferenceSchema.shape.ref,
  origin: ServiceCredentialReferenceSchema.shape.origins.element,
  replace: z.boolean(),
});
export type ServiceCredentialEnrollmentPrepareArgs = z.infer<
  typeof ServiceCredentialEnrollmentPrepareArgsSchema
>;
export const ServiceCredentialEnrollmentPrepareReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("prepared"),
    challenge: ServiceCredentialEnrollmentChallengeSchema,
  }),
  refusal,
  unknown,
]);
export type ServiceCredentialEnrollmentPrepareReply = z.infer<
  typeof ServiceCredentialEnrollmentPrepareReplySchema
>;
export const ServiceCredentialEnrollmentCommitArgsSchema = z.strictObject({
  machineId: ServiceReadArgsSchema.shape.machineId,
  envelope: ServiceCredentialEnrollmentEnvelopeSchema,
});
export type ServiceCredentialEnrollmentCommitArgs = z.infer<
  typeof ServiceCredentialEnrollmentCommitArgsSchema
>;
export const ServiceCredentialEnrollmentCommitReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("stored"),
    credentialRef: ServiceCredentialReferenceSchema.shape.ref,
    available: z.literal(true),
    replaced: z.boolean(),
    sourceRevision: z.uuid(),
  }),
  refusal,
  unknown,
]);
export type ServiceCredentialEnrollmentCommitReply = z.infer<
  typeof ServiceCredentialEnrollmentCommitReplySchema
>;
export const ServiceCredentialEnrollmentCancelArgsSchema = z.strictObject({
  machineId: ServiceReadArgsSchema.shape.machineId,
  requestId,
  nonce: z.uuid(),
});
export type ServiceCredentialEnrollmentCancelArgs = z.infer<
  typeof ServiceCredentialEnrollmentCancelArgsSchema
>;
export const ServiceCredentialEnrollmentCancelReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancelled") }),
  refusal,
  unknown,
]);
export type ServiceCredentialEnrollmentCancelReply = z.infer<
  typeof ServiceCredentialEnrollmentCancelReplySchema
>;

export const ServiceCredentialEnrollmentPrepareCommandSchema = z.strictObject({
  type: z.literal("credential_enrollment_prepare"),
  requestId,
  serverEpoch: z.string().min(1).max(128),
  ownerChallenge: z.string().min(1).max(128),
  ...ServiceCredentialEnrollmentPrepareArgsSchema.shape,
});
export const ServiceCredentialEnrollmentCommitCommandSchema = z.strictObject({
  type: z.literal("credential_enrollment_commit"),
  envelope: ServiceCredentialEnrollmentEnvelopeSchema,
});
export const ServiceCredentialEnrollmentCancelCommandSchema = z.strictObject({
  type: z.literal("credential_enrollment_cancel"),
  requestId,
  /** A pre-offer abort knows only its never-reused request UUID. */
  nonce: z.uuid().nullable(),
});
/** The native owner requests this final live check after decrypting, before publication. */
export const ServiceCredentialEnrollmentAuthorizedCommandSchema = z
  .strictObject({
    type: z.literal("credential_enrollment_authorized"),
    requestId,
    nonce: z.uuid(),
    allowed: z.boolean(),
    reason: ServiceCredentialEnrollmentRefusalSchema.nullable(),
  })
  .refine(({ allowed, reason }) => allowed === (reason === null));
export const ServiceCredentialEnrollmentPreparedEventSchema = z.strictObject({
  type: z.literal("credential_enrollment_prepared"),
  requestId,
  reply: ServiceCredentialEnrollmentPrepareReplySchema,
});
export const ServiceCredentialEnrollmentResultEventSchema = z.strictObject({
  type: z.literal("credential_enrollment_result"),
  requestId,
  reply: ServiceCredentialEnrollmentCommitReplySchema,
});
export const ServiceCredentialEnrollmentCancelledEventSchema = z.strictObject({
  type: z.literal("credential_enrollment_cancelled"),
  requestId,
  reply: ServiceCredentialEnrollmentCancelReplySchema,
});
export const ServiceCredentialEnrollmentAuthorizeEventSchema = z.strictObject({
  type: z.literal("credential_enrollment_authorize"),
  requestId,
  nonce: z.uuid(),
});
