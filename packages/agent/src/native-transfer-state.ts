import { z } from "zod";
import { NativeTransferBindingSchema, NativeTransferStatusSchema } from "@manifold/protocol";

const identity = z.string().regex(/^[0-9]+:[0-9]+$/);
/** Private journal metadata only. Neither temporary names nor inode identities cross the wire. */
export const RetainedNativeTransferSchema = z.strictObject({
  binding: NativeTransferBindingSchema,
  status: NativeTransferStatusSchema,
  ownerId: z.string().min(1).max(256),
  ownerGeneration: z.number().int().positive(),
  updatedAt: z.number().int().nonnegative(),
  /** Accepted bytes or a forward lifecycle transition, never observation/retry time. */
  lastProgressAt: z.number().int().nonnegative(),
  /** Furthest nonempty read end delivered; replayed ranges cannot renew idle time. */
  readHighWaterOffset: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024),
  nextSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  chunks: z
    .array(
      z.strictObject({
        seq: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(256 * 1024),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(4),
  reservedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(16 * 1024 * 1024),
  rootIdentity: identity.optional(),
  temporary: z
    .string()
    .regex(/^\.native-transfer-[0-9a-f-]{36}$/)
    .optional(),
  temporaryIdentity: identity.optional(),
  prepared: z
    .strictObject({
      identity,
      bytes: z
        .number()
        .int()
        .nonnegative()
        .max(16 * 1024 * 1024),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  commitPermit: z
    .strictObject({
      permitId: z.string().min(1).max(256),
      commandDigest: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});
export type RetainedNativeTransfer = z.infer<typeof RetainedNativeTransferSchema>;
