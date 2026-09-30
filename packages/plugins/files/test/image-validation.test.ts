import { describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import {
  FileImageValidationError,
  type FileImageInfo,
  type FileImageValidationReason,
  validateFileImage,
} from "../src/image-validation.ts";

const formats = ["png", "jpeg", "webp", "gif"] as const;

async function fixture(format: (typeof formats)[number], width = 7, height = 5): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 24, g: 112, b: 203, alpha: 0.5 } },
  })
    .toFormat(format)
    .toBuffer();
}

async function expectReason(
  request: Promise<FileImageInfo>,
  reason: FileImageValidationReason,
): Promise<void> {
  try {
    await request;
  } catch (error) {
    expect(error).toBeInstanceOf(FileImageValidationError);
    expect((error as FileImageValidationError).reason).toBe(reason);
    expect((error as Error).message).toBe(reason);
    expect((error as Error).cause).toBeUndefined();
    return;
  }
  throw new Error(`Expected image refusal: ${reason}`);
}

function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "latin1");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function pngChunks(input: Buffer): { type: string; data: Buffer }[] {
  const chunks: { type: string; data: Buffer }[] = [];
  for (let offset = 8; offset < input.length; ) {
    const length = input.readUInt32BE(offset);
    chunks.push({
      type: input.toString("latin1", offset + 4, offset + 8),
      data: input.subarray(offset + 8, offset + 8 + length),
    });
    offset += length + 12;
  }
  return chunks;
}

async function animatedFixture(format: "gif" | "webp"): Promise<Buffer> {
  // Two genuinely different frames prevent an encoder from merging a duplicate.
  return sharp(Buffer.concat([Buffer.alloc(7 * 5 * 3, 0), Buffer.alloc(7 * 5 * 3, 255)]), {
    raw: { width: 7, height: 10, channels: 3, pageHeight: 5 },
  })
    .toFormat(format, { loop: 0, delay: [50, 50] })
    .toBuffer();
}

async function apngFixture(): Promise<Buffer> {
  const first = await fixture("png");
  const second = await sharp({
    create: { width: 7, height: 5, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const firstChunks = pngChunks(first);
  const header = firstChunks.find((chunk) => chunk.type === "IHDR")!;
  const control = Buffer.alloc(8);
  control.writeUInt32BE(2, 0);
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(7, 4);
    data.writeUInt32BE(5, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  const secondData = Buffer.concat(
    pngChunks(second)
      .filter((chunk) => chunk.type === "IDAT")
      .map((chunk) => chunk.data),
  );
  const sequence = Buffer.alloc(4);
  sequence.writeUInt32BE(2, 0);
  // Only APNG framing is constructed here; all compressed pixels come from sharp.
  return Buffer.concat([
    first.subarray(0, 8),
    pngChunk("IHDR", header.data),
    pngChunk("acTL", control),
    frameControl(0),
    ...firstChunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => pngChunk("IDAT", chunk.data)),
    frameControl(1),
    pngChunk("fdAT", Buffer.concat([sequence, secondData])),
    pngChunk("IEND"),
  ]);
}

// Cancellation intentionally returns before the native callback. Wait for that
// callback's admission release, without adding a test-only production interface.
async function waitForAdmission(input: Buffer): Promise<FileImageInfo> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      return await validateFileImage(input, null, new AbortController().signal);
    } catch (error) {
      if (
        !(error instanceof FileImageValidationError) ||
        error.reason !== "busy" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await setImmediate();
    }
  }
}

describe("private image validation with real codecs", () => {
  for (const format of formats) {
    test(`${format}: full decode and unchanged retained original`, async () => {
      const bytes = await fixture(format);
      const original = Buffer.from(bytes);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(await validateFileImage(bytes, `image/${format}`, new AbortController().signal)).toEqual({
        mediaType: `image/${format}`,
        width: 7,
        height: 5,
      });
      expect(bytes.equals(original)).toBe(true);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
    });

    test(`${format}: truncated encoded input is refused`, async () => {
      const bytes = await fixture(format);
      await expectReason(
        validateFileImage(bytes.subarray(0, Math.floor(bytes.length / 2)), null, new AbortController().signal),
        "invalid_image",
      );
    });
  }

  test("only the supplied Uint8Array view is decoded", async () => {
    const bytes = await fixture("png");
    const backing = Buffer.concat([Buffer.from("private-prefix"), bytes, Buffer.from("private-suffix")]);
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 14, bytes.length);
    expect(await validateFileImage(view, null, new AbortController().signal)).toEqual({
      mediaType: "image/png",
      width: 7,
      height: 5,
    });
    expect(backing.subarray(0, 14).toString()).toBe("private-prefix");
    expect(backing.subarray(-14).toString()).toBe("private-suffix");
  });

  test("queued native work owns a snapshot, not a mutable caller view", async () => {
    const bytes = await fixture("png");
    const request = validateFileImage(bytes, null, new AbortController().signal);
    bytes.fill(0);
    expect(await request).toEqual({ mediaType: "image/png", width: 7, height: 5 });
  });

  test("MIME essence is case-insensitive and parameters do not change the format claim", async () => {
    const bytes = await fixture("png");
    for (const declared of [null, "", " \tIMAGE/PNG ; note=\"contains;a;semicolon\"\t"]) {
      expect(await validateFileImage(bytes, declared, new AbortController().signal)).toEqual({
        mediaType: "image/png",
        width: 7,
        height: 5,
      });
    }
    for (const declared of ["image/jpeg", "image/x-png", "text/html", "image", "image/png, image/png", "image/png\r\nX: private", " \t"]) {
      await expectReason(
        validateFileImage(bytes, declared, new AbortController().signal),
        "media_type_mismatch",
      );
    }
  });

  test("unsupported magic never admits SVG, HTML, TIFF or a filesystem path", async () => {
    for (const bytes of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="5"/>'),
      Buffer.from("<!doctype html><html><img src='file:///private'></html>"),
      Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
      Buffer.from("/private/image.png"),
    ]) {
      await expectReason(
        validateFileImage(bytes, "image/png", new AbortController().signal),
        "unsupported_image",
      );
    }
  });

  test("empty and over-16MiB input have bounded refusals", async () => {
    await expectReason(
      validateFileImage(new Uint8Array(), null, new AbortController().signal),
      "invalid_image",
    );
    await expectReason(
      validateFileImage(new Uint8Array(16 * 1024 * 1024 + 1), null, new AbortController().signal),
      "image_too_large",
    );
  });

  test("a complete 16MiB PNG is accepted without interpreting ancillary payload as chunks", async () => {
    const bytes = await fixture("png");
    const padding = Buffer.alloc(16 * 1024 * 1024 - bytes.length - 12);
    padding.write("acTLfcTLfdAT");
    const padded = Buffer.concat([bytes.subarray(0, -12), pngChunk("ruSt", padding), bytes.subarray(-12)]);
    expect(padded.length).toBe(16 * 1024 * 1024);
    expect(await validateFileImage(padded, null, new AbortController().signal)).toEqual({
      mediaType: "image/png",
      width: 7,
      height: 5,
    });
  });

  for (let orientation = 1; orientation <= 8; orientation++) {
    test(`EXIF ${orientation}: report oriented dimensions without stripping metadata`, async () => {
      const bytes = await sharp(await fixture("jpeg")).withMetadata({ orientation }).jpeg().toBuffer();
      expect((await sharp(bytes).metadata()).orientation).toBe(orientation);
      const original = Buffer.from(bytes);
      expect(await validateFileImage(bytes, null, new AbortController().signal)).toEqual({
        mediaType: "image/jpeg",
        width: orientation >= 5 ? 5 : 7,
        height: orientation >= 5 ? 7 : 5,
      });
      expect(bytes.equals(original)).toBe(true);
    });
  }

  for (const format of ["png", "webp"] as const) {
    test(`${format}: preserve transparent and translucent pixels`, async () => {
      const pixels = Buffer.from([255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255]);
      const bytes = await sharp(pixels, { raw: { width: 3, height: 1, channels: 4 } })
        .toFormat(format, { lossless: true })
        .toBuffer();
      const original = Buffer.from(bytes);
      const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      expect(info.channels).toBe(4);
      expect([data[3], data[7], data[11]]).toEqual([0, 128, 255]);
      expect(await validateFileImage(bytes, null, new AbortController().signal)).toEqual({
        mediaType: `image/${format}`,
        width: 3,
        height: 1,
      });
      expect(bytes.equals(original)).toBe(true);
    });
  }

  for (const format of ["gif", "webp"] as const) {
    test(`${format}: real multiple-frame input is not accepted as its first frame`, async () => {
      const bytes = await animatedFixture(format);
      expect((await sharp(bytes).metadata()).pages).toBe(2);
      await expectReason(
        validateFileImage(bytes, null, new AbortController().signal),
        "animated_image",
      );
    });
  }

  test("APNG is refused even when the native metadata sees only its default image", async () => {
    const bytes = await apngFixture();
    const metadata = await sharp(bytes).metadata();
    expect(metadata.width).toBe(7);
    expect(metadata.height).toBe(5);
    expect(metadata.pages ?? 1).toBe(1);
    await expectReason(validateFileImage(bytes, null, new AbortController().signal), "animated_image");
  });

  test("orphan APNG frame chunks cannot bypass the animation refusal", async () => {
    const bytes = await fixture("png");
    for (const type of ["fcTL", "fdAT"]) {
      const input = Buffer.concat([bytes.subarray(0, -12), pngChunk(type, Buffer.alloc(26)), bytes.subarray(-12)]);
      await expectReason(validateFileImage(input, null, new AbortController().signal), "animated_image");
    }
  });

  test("malformed PNG chunk lengths, ordering, CRCs, reserved bits and trailing bytes are refused", async () => {
    const bytes = await fixture("png");
    const chunks = pngChunks(bytes);
    const ihdr = pngChunk("IHDR", chunks.find((chunk) => chunk.type === "IHDR")!.data);
    const idat = pngChunk("IDAT", Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)));
    const prefix = bytes.subarray(0, 8);
    const badCrc = Buffer.from(bytes);
    badCrc[29] = badCrc[29]! ^ 1;
    const hugeLength = Buffer.from(bytes);
    hugeLength.writeUInt32BE(0xffffffff, 8);
    const cases = [
      badCrc,
      hugeLength,
      bytes.subarray(0, -1),
      bytes.subarray(0, -12),
      Buffer.concat([bytes, Buffer.from([0])]),
      Buffer.concat([bytes, pngChunk("IEND")]),
      Buffer.concat([prefix, idat, ihdr, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, ihdr, idat, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, idat, pngChunk("ruSt"), idat, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, pngChunk("rust"), idat, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, pngChunk("RuSt"), idat, pngChunk("IEND")]),
      Buffer.concat([prefix, ihdr, idat, pngChunk("IEND", Buffer.from([0]))]),
    ];
    for (const input of cases) {
      await expectReason(validateFileImage(input, null, new AbortController().signal), "invalid_image");
    }
  });

  test("valid metadata and chunk CRCs are not proof of a decodable pixel payload", async () => {
    const bytes = await fixture("png");
    const header = pngChunks(bytes).find((chunk) => chunk.type === "IHDR")!;
    const corrupt = Buffer.concat([
      bytes.subarray(0, 8),
      pngChunk("IHDR", header.data),
      pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff])),
      pngChunk("IEND"),
    ]);
    expect((await sharp(corrupt).metadata()).width).toBe(7);
    await expectReason(validateFileImage(corrupt, null, new AbortController().signal), "invalid_image");
  });

  for (const [width, height, accepted] of [
    [2048, 2048, true],
    [2049, 2048, false],
    [8192, 1, true],
    [8193, 1, false],
    [1, 8192, true],
    [1, 8193, false],
  ] as const) {
    test(`pixel/dimension boundary ${width}×${height}`, async () => {
      const bytes = await fixture("png", width, height);
      const request = validateFileImage(bytes, null, new AbortController().signal);
      if (accepted) {
        expect(await request).toEqual({ mediaType: "image/png", width, height });
      } else {
        await expectReason(request, "image_too_large");
      }
    });
  }

  test("one admission, no queue, and cancellation cannot free a still-running native request", async () => {
    const bytes = await fixture("png");
    const controller = new AbortController();
    const request = validateFileImage(bytes, null, controller.signal);
    const busy = validateFileImage(bytes, null, new AbortController().signal);
    controller.abort(new Error("private abort reason"));
    try {
      await expectReason(request, "cancelled");
      await expectReason(busy, "busy");
      // Rejection microtasks run before the queued native callback. Abandoning a
      // caller must not make the seat available to a cancellation flood.
      await expectReason(
        validateFileImage(bytes, null, new AbortController().signal),
        "busy",
      );
    } finally {
      expect(await waitForAdmission(bytes)).toEqual({ mediaType: "image/png", width: 7, height: 5 });
    }
  });

  test("already-cancelled requests do not occupy the seat or leak signal reasons", async () => {
    const bytes = await fixture("png");
    await expectReason(
      validateFileImage(bytes, null, AbortSignal.abort("private cancellation reason")),
      "cancelled",
    );
    expect(await validateFileImage(bytes, null, new AbortController().signal)).toEqual({
      mediaType: "image/png",
      width: 7,
      height: 5,
    });
  });

  test("a late native callback cannot succeed after the elapsed deadline", async () => {
    const bytes = await fixture("png");
    // Only the monotonic clock is controlled; the native metadata/decode is real.
    const clock = spyOn(performance, "now").mockReturnValue(0);
    try {
      const request = validateFileImage(bytes, null, new AbortController().signal);
      clock.mockReturnValue(5_000);
      await expectReason(request, "request_timeout");
    } finally {
      clock.mockRestore();
    }
    expect(await validateFileImage(bytes, null, new AbortController().signal)).toEqual({
      mediaType: "image/png",
      width: 7,
      height: 5,
    });
  });
});
