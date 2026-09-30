import {
  ByteRefusalSchema,
  ManifoldRefSchema,
  NativeTransferBeginPutArgsSchema,
  NativeTransferBeginReadArgsSchema,
  NativeTransferReceiptSchema,
  NativeTransferStatusSchema,
  PluginOwnedRefSchema,
} from "@manifold/protocol";
import { z } from "zod";

export const FILES_ID = "core.files";
export const FILE_CREATE = "core.files:create";
export const FILE_READ = "core.files:read";
export const FILE_DELETE = "core.files:delete";
export const FILE_SHARE = "core.files:share";
export const FILE_COLLECTION = { kind: "plugin", pluginId: FILES_ID } as const;
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_STORAGE_BYTES = 32 * 1024 * 1024;
export const MAX_FILE_RECORDS = 1000;
export const FILE_DATABASE_BYTES = 64 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 256 * 1024;
export const FILE_IDLE_MS = 60_000;
export const FILE_LIFETIME_MS = 15 * 60_000;
export const FILE_RECEIPT_MS = 7 * 24 * 60 * 60_000;
export const MAX_FILE_TRANSFERS = 4;
export const MAX_PERSONAL_FILE_TRANSFERS = 2;

const id = z.string().min(1).max(128);
export const FileRequestIdSchema = z
  .string()
  .max(128)
  .regex(/^[0-9]{13}_[a-zA-Z0-9_-]{1,100}$/);
/** Persist this intent across retries; a new identifier means a deliberate new operation. */
export function createFileRequestId(now = Date.now()): string {
  return FileRequestIdSchema.parse(`${now}_${globalThis.crypto.randomUUID()}`);
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const bytes = z.number().int().nonnegative().max(MAX_FILE_BYTES);
export const FileCollectionSchema = z.strictObject({
  kind: z.literal("plugin"),
  pluginId: z.literal(FILES_ID),
});
export const FileImageInfoSchema = z
  .strictObject({
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .refine((image) => image.width * image.height <= 4_194_304);
export const FileDescriptorSchema = z.strictObject({
  ref: PluginOwnedRefSchema,
  home: z.strictObject({ kind: z.literal("root") }),
  ownerId: id,
  name: z.string().min(1).max(255),
  declaredMediaType: z.string().max(128).nullable(),
  mediaType: z.string().min(1).max(128),
  bytes,
  sha256: digest,
  createdAt: instant,
  image: FileImageInfoSchema.nullable(),
});
export type FileDescriptor = z.infer<typeof FileDescriptorSchema>;
export const FileRefusalSchema = z.union([
  ByteRefusalSchema,
  z.enum([
    "invalid_image",
    "unsupported_image",
    "media_type_mismatch",
    "animated_image",
    "image_too_large",
    "reference_unavailable",
    "reference_conflict",
    "reference_capacity",
  ]),
]);
export type FileRefusal = z.infer<typeof FileRefusalSchema>;
export const FileTransferStateSchema = z.enum([
  "receiving",
  "verifying",
  "ready",
  "reading",
  "completed",
  "cancelled",
  "expired",
  "failed",
  "deleted",
  "queued",
  "publishing",
  "refused",
  "outcome_unknown",
]);
export const FileTransferSchema = z.strictObject({
  transferId: id,
  ref: ManifoldRefSchema,
  kind: z.enum(["upload", "read", "delivery", "download"]),
  state: FileTransferStateSchema,
  bytes,
  offset: bytes,
  sequence: z.number().int().nonnegative(),
  chunkBytes: z.literal(FILE_CHUNK_BYTES),
  createdAt: instant,
  expiresAt: instant,
  reason: FileRefusalSchema.nullable(),
});
export type FileTransfer = z.infer<typeof FileTransferSchema>;
export const BeginFileUploadInputSchema = z.strictObject({
  collection: FileCollectionSchema,
  requestId: FileRequestIdSchema,
  name: z.string().min(1).max(1024),
  declaredMediaType: z.string().max(128).nullable(),
  bytes,
  expectedSha256: digest.optional(),
  purpose: z.enum(["file", "image"]),
});
export type BeginFileUploadInput = z.infer<typeof BeginFileUploadInputSchema>;
export const FileUploadRequestSchema = z.strictObject({
  collection: FileCollectionSchema,
  transferId: id,
});
export const FileRequestSchema = z.strictObject({ ref: PluginOwnedRefSchema });
export const FileReadRequestSchema = FileRequestSchema.extend({ transferId: id });
export const OpenFileReadInputSchema = FileRequestSchema.extend({ requestId: FileRequestIdSchema });
export const OpenFileReadResultSchema = z.strictObject({
  file: FileDescriptorSchema,
  transfer: FileTransferSchema,
});
export const ListFilesInputSchema = z.strictObject({
  after: PluginOwnedRefSchema.optional(),
  limit: z.number().int().positive().max(64).default(32),
});
export const ListFilesResultSchema = z.strictObject({
  files: FileDescriptorSchema.array().max(64),
  next: PluginOwnedRefSchema.nullable(),
});

export const FileMachineSchema = z.strictObject({ kind: z.literal("machine"), machineId: id });
export const FileLocationSchema = z.strictObject({
  kind: z.literal("location"),
  machineId: id,
  locationId: id,
});
export const DescribeFileMachineSchema = z.strictObject({ machine: FileMachineSchema });
export const BeginFileDeliverySchema = NativeTransferBeginPutArgsSchema.omit({
  source: true,
  machineId: true,
}).extend({
  requestId: FileRequestIdSchema,
  ref: PluginOwnedRefSchema,
  machine: FileMachineSchema,
  location: FileLocationSchema,
});
export const FileDeliveryRequestSchema = FileRequestSchema.extend({
  machine: FileMachineSchema,
  location: FileLocationSchema,
  transferId: id,
});
export const BeginFileDownloadSchema = NativeTransferBeginReadArgsSchema.omit({
  machineId: true,
}).extend({
  requestId: FileRequestIdSchema,
  machine: FileMachineSchema,
  location: FileLocationSchema,
});
export const FileDownloadRequestSchema = z.strictObject({
  machine: FileMachineSchema,
  location: FileLocationSchema,
  transferId: id,
});
export const FileNativeResultSchema = z.strictObject({
  transfer: FileTransferSchema,
  native: NativeTransferStatusSchema.nullable(),
});

export const FileIntakeResultSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("saved"), ref: PluginOwnedRefSchema }),
  z.strictObject({ state: z.literal("cancelled"), savedRef: PluginOwnedRefSchema.nullable() }),
  z.strictObject({ state: z.literal("delivered"), receipt: NativeTransferReceiptSchema }),
]);
export type FileIntakeResult = z.infer<typeof FileIntakeResultSchema>;
