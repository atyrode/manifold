import { Buffer } from "node:buffer";
import { MIMEType } from "node:util";
import { crc32 } from "node:zlib";
import sharp from "sharp";

export interface FileImageInfo {
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  width: number;
  height: number;
}

export type FileImageValidationReason =
  | "busy"
  | "cancelled"
  | "request_timeout"
  | "invalid_image"
  | "unsupported_image"
  | "media_type_mismatch"
  | "animated_image"
  | "image_too_large";

export class FileImageValidationError extends Error {
  constructor(readonly reason: FileImageValidationReason) {
    super(reason);
    this.name = "FileImageValidationError";
  }
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 4_194_304;
const MAX_DIMENSION = 8_192;
const REQUEST_TIMEOUT_MS = 5_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// These are process-wide libvips settings. Admission below additionally bounds the
// number of this product's queued/running native requests, not just vips threads.
sharp.cache(false);
sharp.concurrency(1);
let active = false;

function sniff(input: Buffer): FileImageInfo["mediaType"] {
  if (input.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff) return "image/jpeg";
  const signature = input.toString("latin1", 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  if (
    input.length >= 12 &&
    input.toString("latin1", 0, 4) === "RIFF" &&
    input.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new FileImageValidationError("unsupported_image");
}

function checkMediaType(declared: string | null, actual: FileImageInfo["mediaType"]): void {
  // Browser File.type uses the empty string for an absent claim. Otherwise use
  // WHATWG MIME parsing: case-insensitive essence, optional whitespace/parameters,
  // no aliases (such as image/jpg), and never accept a folded/header-list claim.
  if (declared === null || declared === "") return;
  for (let index = 0; index < declared.length; index++) {
    const code = declared.charCodeAt(index);
    if ((code < 32 && code !== 9) || code === 127) {
      throw new FileImageValidationError("media_type_mismatch");
    }
  }
  try {
    if (new MIMEType(declared).essence === actual) return;
  } catch {
    // Parser diagnostics may contain the supplied claim; they must not escape.
  }
  throw new FileImageValidationError("media_type_mismatch");
}

function checkDimensions(width: number, height: number, channels: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(channels) ||
    width < 1 ||
    height < 1 ||
    channels < 1
  ) {
    throw new FileImageValidationError("invalid_image");
  }
  if (
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS ||
    channels > 4
  ) {
    throw new FileImageValidationError("image_too_large");
  }
}

function checkPngStructure(input: Buffer, assertCurrent: () => void): void {
  // Framing only, not a codec: libvips must still decode every pixel. Sharp's
  // metadata does not expose APNG frames. Walk the entire bounded input, including
  // ancillary chunks and IEND, rather than searching arbitrary compressed bytes.
  let offset = PNG_SIGNATURE.length;
  let header = false;
  let palette = false;
  let data = false;
  let dataEnded = false;
  while (offset < input.length) {
    assertCurrent();
    if (input.length - offset < 12) throw new FileImageValidationError("invalid_image");
    const length = input.readUInt32BE(offset);
    if (length > 0x7fffffff || length > input.length - offset - 12) {
      throw new FileImageValidationError("invalid_image");
    }
    const end = offset + length + 12;
    const type = input.toString("latin1", offset + 4, offset + 8);
    if (
      !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
      crc32(input.subarray(offset + 4, end - 4)) !== input.readUInt32BE(end - 4)
    ) {
      throw new FileImageValidationError("invalid_image");
    }
    if (!header && type !== "IHDR") throw new FileImageValidationError("invalid_image");
    switch (type) {
      case "IHDR":
        if (header || length !== 13) throw new FileImageValidationError("invalid_image");
        header = true;
        break;
      case "PLTE":
        if (palette || data || length === 0 || length > 768 || length % 3 !== 0) {
          throw new FileImageValidationError("invalid_image");
        }
        palette = true;
        break;
      case "IDAT":
        if (dataEnded) throw new FileImageValidationError("invalid_image");
        data = true;
        break;
      case "IEND":
        if (!data || length !== 0 || end !== input.length) {
          throw new FileImageValidationError("invalid_image");
        }
        return;
      case "acTL":
      case "fcTL":
      case "fdAT":
        throw new FileImageValidationError("animated_image");
      default:
        // Unknown critical chunks cannot be safely interpreted by this decoder.
        if (type.charCodeAt(0) < 97) throw new FileImageValidationError("invalid_image");
    }
    if (data && type !== "IDAT") dataEnded = true;
    offset = end;
  }
  throw new FileImageValidationError("invalid_image");
}

function safeError(error: unknown): FileImageValidationError {
  if (error instanceof FileImageValidationError) return error;
  // Sharp 0.35.5 reports these resource limits before metadata is available.
  // Recognize only its fixed diagnostics; never publish native exception text.
  if (
    error instanceof Error &&
    (error.message === "Input image exceeds pixel limit" ||
      error.message === "Input image exceeds channel limit")
  ) {
    return new FileImageValidationError("image_too_large");
  }
  if (error instanceof Error && /(?:^|\n)timeout: \d+% complete(?:\n|$)/.test(error.message)) {
    return new FileImageValidationError("request_timeout");
  }
  return new FileImageValidationError("invalid_image");
}

async function decode(
  input: Buffer,
  mediaType: FileImageInfo["mediaType"],
  assertCurrent: () => void,
): Promise<FileImageInfo> {
  const image = sharp(input, {
    failOn: "warning",
    limitInputPixels: MAX_PIXELS,
    limitInputChannels: 4,
    sequentialRead: true,
    unlimited: false,
    pages: 1,
  }).timeout({ seconds: 5 });
  const metadata = await image.metadata();
  assertCurrent();
  if (`image/${metadata.format}` !== mediaType) {
    throw new FileImageValidationError("invalid_image");
  }
  if ((metadata.pages ?? 1) > 1) throw new FileImageValidationError("animated_image");
  checkDimensions(metadata.width, metadata.height, metadata.channels);
  const { width, height } = metadata.autoOrient;
  checkDimensions(width, height, metadata.channels);

  // A metadata probe does not validate the compressed payload. Materialize the
  // complete bounded uchar raster, then discard it. Do not re-encode the original
  // or rotate a second raster merely to calculate orientation-aware dimensions.
  const decoded = await image.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  assertCurrent();
  checkDimensions(decoded.info.width, decoded.info.height, decoded.info.channels);
  if (
    decoded.info.width !== metadata.width ||
    decoded.info.height !== metadata.height ||
    decoded.data.length !== decoded.info.width * decoded.info.height * decoded.info.channels
  ) {
    throw new FileImageValidationError("invalid_image");
  }
  return { mediaType, width, height };
}

/** Validate a private snapshot; the caller continues to own the unchanged original bytes. */
export async function validateFileImage(
  bytes: Uint8Array,
  declaredMediaType: string | null,
  signal: AbortSignal,
): Promise<FileImageInfo> {
  if (signal.aborted) throw new FileImageValidationError("cancelled");
  if (active) throw new FileImageValidationError("busy");
  if (bytes.byteLength === 0) throw new FileImageValidationError("invalid_image");
  if (bytes.byteLength > MAX_BYTES) throw new FileImageValidationError("image_too_large");

  const deadline = performance.now() + REQUEST_TIMEOUT_MS;
  let interrupted: FileImageValidationError | undefined;
  const assertCurrent = () => {
    if (interrupted) throw interrupted;
    if (signal.aborted) throw new FileImageValidationError("cancelled");
    if (performance.now() >= deadline) throw new FileImageValidationError("request_timeout");
  };
  // Native workers retain a Buffer across awaits. Snapshot once so mutation of
  // a caller's Uint8Array cannot change the sniffed format while work is queued.
  const input = Buffer.from(bytes);
  const mediaType = sniff(input);
  checkMediaType(declaredMediaType, mediaType);
  if (mediaType === "image/png") checkPngStructure(input, assertCurrent);
  assertCurrent();

  active = true;
  const { promise: cancelled, reject } = Promise.withResolvers<never>();
  const interrupt = (reason: "cancelled" | "request_timeout") => {
    interrupted ??= new FileImageValidationError(reason);
    reject(interrupted);
  };
  const onAbort = () => interrupt("cancelled");
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => interrupt("request_timeout"),
    Math.max(0, deadline - performance.now()),
  );
  const work = decode(input, mediaType, assertCurrent)
    .catch((error: unknown) => {
      assertCurrent();
      throw safeError(error);
    })
    .finally(() => {
      // Cancellation/deadline settles the caller, not the native worker. Holding
      // this seat until the real callback prevents overlapping work or a queue
      // of abandoned decodes. No late callback can restore effect authority.
      active = false;
    });
  try {
    const result = await Promise.race([work, cancelled]);
    assertCurrent();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
