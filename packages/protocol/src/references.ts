import { z } from "zod";
import { MAX_MANIFEST_CAPABILITIES, PluginCapSchema } from "./plugin.ts";
import { PluginOwnedRefKindSchema, PluginOwnedRefSchema } from "./uri.ts";
import { isElementEnvelopeKey, SceneElementSchema } from "./elements.ts";

const ReferenceIdSchema = z.string().min(1).max(128);
const ReferenceDigestSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
const RestrictedCapsSchema = PluginCapSchema.array()
  .min(1)
  .max(MAX_MANIFEST_CAPABILITIES)
  .refine((caps) => new Set(caps).size === caps.length, "duplicate reference capability");
export const MAX_REFERENCE_AUDIENCE_PAGE = 64;
export const MAX_REFERENCE_READ_FILTER = 64;
export const ReferenceReadFilterRequestSchema = z
  .strictObject({
    kind: PluginOwnedRefKindSchema,
    refs: PluginOwnedRefSchema.array().max(MAX_REFERENCE_READ_FILTER),
  })
  .refine(
    (request) =>
      request.refs.every((ref) => ref.kind === request.kind) &&
      new Set(request.refs.map((ref) => JSON.stringify(ref))).size === request.refs.length,
  );
export type ReferenceReadFilterRequest = z.infer<typeof ReferenceReadFilterRequestSchema>;

/** A consumer-owned document reference, not a copy or grant of the referent's content. */
export const ReferenceAttachmentRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  target: z.strictObject({ kind: z.literal("container"), containerId: ReferenceIdSchema }),
  discipline: z.string().min(1).max(64),
  element: SceneElementSchema,
  referenceProperty: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (key) =>
        !isElementEnvelopeKey(key) && !["__proto__", "constructor", "prototype"].includes(key),
    ),
});
export type ReferenceAttachmentRequest = z.infer<typeof ReferenceAttachmentRequestSchema>;
export const ReferenceAttachmentResultSchema = z.strictObject({
  ref: z.strictObject({
    kind: z.literal("element"),
    containerId: ReferenceIdSchema,
    elementId: ReferenceIdSchema,
  }),
  created: z.boolean(),
});
export type ReferenceAttachmentResult = z.infer<typeof ReferenceAttachmentResultSchema>;

export const ReferencePrepareRequestSchema = z.strictObject({
  kind: PluginOwnedRefKindSchema,
  requestId: ReferenceIdSchema,
  bindingDigest: ReferenceDigestSchema,
});
export type ReferencePrepareRequest = z.infer<typeof ReferencePrepareRequestSchema>;
export const ReferencePublishRequestSchema = z.strictObject({
  preparationId: ReferenceIdSchema,
  readyDigest: ReferenceDigestSchema,
  /** Owner deadline for a new publication; cannot extend preparation or block a published receipt. */
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export type ReferencePublishRequest = z.infer<typeof ReferencePublishRequestSchema>;
export const ReferenceAbortRequestSchema = z.strictObject({ preparationId: ReferenceIdSchema });
export type ReferenceAbortRequest = z.infer<typeof ReferenceAbortRequestSchema>;
export const ReferenceRequirePublishedRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  access: z.enum(["read", "share", "delete"]),
});
export type ReferenceRequirePublishedRequest = z.infer<
  typeof ReferenceRequirePublishedRequestSchema
>;
export const ReferenceUnpublishRequestSchema = z.strictObject({ ref: PluginOwnedRefSchema });
export type ReferenceUnpublishRequest = z.infer<typeof ReferenceUnpublishRequestSchema>;
/** Only the original operation credential may reconcile a retained terminal outcome. */
export const ReferenceReceiptRequestSchema = z.strictObject({ ref: PluginOwnedRefSchema });
export type ReferenceReceiptRequest = z.infer<typeof ReferenceReceiptRequestSchema>;
export const ReferenceGrantRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  principalId: ReferenceIdSchema,
  caps: RestrictedCapsSchema,
  /** Null for the first decision; deliberate re-sharing must name the retired decision. */
  previousGrantId: ReferenceIdSchema.nullable(),
});
export type ReferenceGrantRequest = z.infer<typeof ReferenceGrantRequestSchema>;
export const ReferenceRevokeRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  grantId: ReferenceIdSchema,
});
export type ReferenceRevokeRequest = z.infer<typeof ReferenceRevokeRequestSchema>;
export const ReferenceAudienceRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  after: ReferenceIdSchema.optional(),
  limit: z.number().int().min(1).max(MAX_REFERENCE_AUDIENCE_PAGE).optional(),
});
export type ReferenceAudienceRequest = z.infer<typeof ReferenceAudienceRequestSchema>;

export const ReferencePreparationSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  preparationId: ReferenceIdSchema,
  bindingDigest: ReferenceDigestSchema,
  expiresAt: z.number().int().nonnegative(),
});
export type ReferencePreparation = z.infer<typeof ReferencePreparationSchema>;

/** Host-authored identity and phase; private bookkeeping may never infer publication. */
export const ReferenceProbeRequestSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  preparationId: ReferenceIdSchema,
  requestId: ReferenceIdSchema,
  bindingDigest: ReferenceDigestSchema,
  publication: z.enum(["prepared", "published"]),
});
export type ReferenceProbeRequest = z.infer<typeof ReferenceProbeRequestSchema>;
export const ReferenceProbeResultSchema = z
  .strictObject({
    preparationId: ReferenceIdSchema,
    readyDigest: ReferenceDigestSchema.nullable(),
    /** Pending preparation deadline only; it never expires an already published file. */
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .nullable();
export type ReferenceProbeResult = z.infer<typeof ReferenceProbeResultSchema>;
export const PublishedReferenceIdentitySchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  preparationId: ReferenceIdSchema,
  readyDigest: ReferenceDigestSchema,
});
export type PublishedReferenceIdentity = z.infer<typeof PublishedReferenceIdentitySchema>;
export const ReferenceReadFilterResultSchema =
  PublishedReferenceIdentitySchema.array().max(MAX_REFERENCE_READ_FILTER);
export type ReferenceReadFilterResult = z.infer<typeof ReferenceReadFilterResultSchema>;
export const PublishedReferenceSchema = PublishedReferenceIdentitySchema;
export type PublishedReference = z.infer<typeof PublishedReferenceSchema>;
export const ReferenceTerminalReceiptSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  preparationId: ReferenceIdSchema,
  state: z.enum(["aborted", "deleted"]),
});
export type ReferenceTerminalReceipt = z.infer<typeof ReferenceTerminalReceiptSchema>;
export const RestrictedGrantViewSchema = z.strictObject({
  grantId: ReferenceIdSchema,
  principalId: ReferenceIdSchema,
  caps: RestrictedCapsSchema,
  /** Whether the mechanism's ordinary grant still exists, not a credential-access claim. */
  active: z.boolean(),
});
export type RestrictedGrantView = z.infer<typeof RestrictedGrantViewSchema>;
export const RestrictedGrantResultSchema = z.strictObject({
  changed: z.boolean(),
  principalReadAllowed: z.boolean(),
  credentialAccess: z.literal("not_evaluated"),
});
export type RestrictedGrantResult = z.infer<typeof RestrictedGrantResultSchema>;
export const RestrictedAudiencePageSchema = z.strictObject({
  shares: RestrictedGrantViewSchema.array().max(MAX_REFERENCE_AUDIENCE_PAGE),
  next: ReferenceIdSchema.nullable(),
});
export type RestrictedAudiencePage = z.infer<typeof RestrictedAudiencePageSchema>;
