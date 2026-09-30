import { z } from "zod";
import { ByteRefusalSchema } from "./bytes.ts";
import { PluginIdSchema, LocalNameSchema } from "./plugin.ts";
import { ManifoldRefSchema } from "./uri.ts";

/** Neutral mounted browser resource ceilings; products may impose smaller bounds. */
export const MAX_LOCAL_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOCAL_FILES = 4;
export const MAX_RASTER_PIXELS = 4_194_304;
export const MAX_RASTER_SIDE = 8192;
export const RasterMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export type RasterMediaType = z.infer<typeof RasterMediaTypeSchema>;
export const LocalFileHandleSchema = z.string().min(1).max(128);
export const LocalFileDescriptorSchema = z.strictObject({
  handle: LocalFileHandleSchema,
  name: z.string().max(255),
  mediaType: z.string().max(128),
  bytes: z.number().int().min(0).max(MAX_LOCAL_FILE_BYTES),
});
export type LocalFileDescriptor = z.infer<typeof LocalFileDescriptorSchema>;
export const LocalFileSelectionSchema = z.array(LocalFileDescriptorSchema).max(MAX_LOCAL_FILES);
/** A normalized, nonempty rectangle within the original authenticated raster. */
export const ByteImageCropSchema = z.strictObject({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().min(1 / MAX_RASTER_SIDE).max(1),
  height: z.number().finite().min(1 / MAX_RASTER_SIDE).max(1),
}).refine((crop) => crop.x + crop.width <= 1 && crop.y + crop.height <= 1,
  "crop must stay within the original image");
export type ByteImageCrop = z.infer<typeof ByteImageCropSchema>;
export const ByteImageSourceSchema = z.strictObject({
  pluginId: PluginIdSchema,
  carrierId: LocalNameSchema,
  transferId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  ref: ManifoldRefSchema,
  bytes: z.number().int().min(1).max(MAX_LOCAL_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: RasterMediaTypeSchema,
});
export type ByteImageSource = z.infer<typeof ByteImageSourceSchema>;
export const ByteImageReasonSchema = z.union([
  ByteRefusalSchema,
  z.enum(["hash_mismatch", "unsupported_image", "decode_failed"]),
]);
export type ByteImageReason = z.infer<typeof ByteImageReasonSchema>;
export const ByteImageStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("loading") }),
  z.strictObject({ state: z.literal("ready") }),
  z.strictObject({ state: z.literal("unavailable"), reason: ByteImageReasonSchema }),
]);
export type ByteImageStatus = z.infer<typeof ByteImageStatusSchema>;

export const ByteDownloadSourceSchema = ByteImageSourceSchema.omit({ mediaType: true }).extend({
  bytes: z.number().int().min(0).max(MAX_LOCAL_FILE_BYTES),
});
export type ByteDownloadSource = z.infer<typeof ByteDownloadSourceSchema>;
export const ByteDownloadReasonSchema = z.union([
  ByteRefusalSchema,
  z.enum(["hash_mismatch", "download_failed"]),
]);
export type ByteDownloadReason = z.infer<typeof ByteDownloadReasonSchema>;
export const ByteDownloadStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("downloading"),
    received: z.number().int().min(0).max(MAX_LOCAL_FILE_BYTES),
    total: z.number().int().min(0).max(MAX_LOCAL_FILE_BYTES),
  }).refine((status) => status.received <= status.total),
  // Handoff to the browser, not evidence that the user persisted a file.
  z.strictObject({ state: z.literal("complete") }),
  z.strictObject({ state: z.literal("unavailable"), reason: ByteDownloadReasonSchema }),
]);
export type ByteDownloadStatus = z.infer<typeof ByteDownloadStatusSchema>;
