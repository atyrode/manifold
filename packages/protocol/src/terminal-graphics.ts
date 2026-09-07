import { z } from "zod";
import { validTerminalRgba } from "./terminal-image-codec.ts";

/** Transient graphics state travels inside the existing seq-anchored VT snapshot. */
export const TERMINAL_GRAPHICS_PREFIX = "ManifoldGraphics=";
export const TERMINAL_GRAPHICS_CELL = { width: 7, height: 14 } as const;
export const TERMINAL_GRAPHICS_BYTES = 180000;
export const TERMINAL_GRAPHICS_INPUT_BYTES = 131072;
export const TERMINAL_GRAPHICS_PIXELS = 2 * 1024 * 1024;
export const TERMINAL_GRAPHICS_CELLS = 2048;
export const TERMINAL_GRAPHICS_IMAGES = 64;
export const TERMINAL_GRAPHICS_SNAPSHOT_BYTES = 267000;

const integer = z.number().int().nonnegative();
const dimension = z.number().int().min(1).max(2048);
const image = z.strictObject({
  id: integer.max(63),
  width: dimension,
  height: dimension,
  format: z.enum([
    "rgba",
    "rgba-indexed",
    "rgba-indexed-alpha",
    "rgba-rle",
    "image/png",
    "image/jpeg",
    "image/gif",
  ]),
  data: z.base64().max(Math.ceil(TERMINAL_GRAPHICS_BYTES / 3) * 4),
  buffer: z.enum(["normal", "alternate"]),
  /** Little-endian uint16 triples: buffer row, column, source tile. */
  cells: z.base64().max(TERMINAL_GRAPHICS_CELLS * 8),
});
export const TerminalGraphicsSnapshotSchema = z
  .strictObject({
    version: z.literal(1),
    scrolling: z.boolean(),
    palette: z.base64().length(1368).endsWith("=="),
    paletteLimit: z.number().int().min(1).max(256),
    images: z.array(image).max(TERMINAL_GRAPHICS_IMAGES),
  })
  .superRefine((state, context) => {
    const ids = new Set<number>();
    let bytes = 0;
    let footprint = 0;
    let pixels = 0;
    let cells = 0;
    let invalid = false;
    for (const entry of state.images) {
      invalid ||= ids.has(entry.id);
      ids.add(entry.id);
      const columns = Math.ceil(entry.width / TERMINAL_GRAPHICS_CELL.width);
      const rows = Math.ceil(entry.height / TERMINAL_GRAPHICS_CELL.height);
      footprint += columns * rows;
      const area = entry.width * entry.height;
      pixels += area;
      if (entry.data.length > Math.ceil(TERMINAL_GRAPHICS_BYTES / 3) * 4) {
        invalid = true;
        continue;
      }
      try {
        const source = Uint8Array.from(atob(entry.data), (character) => character.charCodeAt(0));
        bytes += source.length;
        if (
          entry.format === "image/png" ||
          entry.format === "image/jpeg" ||
          entry.format === "image/gif"
        ) {
          invalid ||= inlineImageDimensions(source, entry.format) === null;
        } else {
          invalid ||= !validTerminalRgba(source, entry.format, area);
        }
        const packed = Uint8Array.from(atob(entry.cells), (character) => character.charCodeAt(0));
        cells += packed.length / 6;
        if (packed.length % 6 !== 0) {
          invalid = true;
          continue;
        }
        const view = new DataView(packed.buffer);
        for (let offset = 0; offset < packed.length; offset += 6) {
          invalid ||=
            view.getUint16(offset, true) > 6000 ||
            view.getUint16(offset + 2, true) > 999 ||
            view.getUint16(offset + 4, true) >= columns * rows;
        }
      } catch {
        invalid = true;
      }
    }
    if (
      invalid ||
      bytes > TERMINAL_GRAPHICS_BYTES ||
      pixels > TERMINAL_GRAPHICS_PIXELS ||
      cells > TERMINAL_GRAPHICS_CELLS ||
      footprint > TERMINAL_GRAPHICS_CELLS
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid or over-budget terminal graphics snapshot",
      });
    }
  });
export type TerminalGraphicsSnapshot = z.infer<typeof TerminalGraphicsSnapshotSchema>;

/** Inspect raster headers before any decoder allocation; never accepts an external source. */
export function inlineImageDimensions(data: Uint8Array, format: string): [number, number] | null {
  let width = 0;
  let height = 0;
  if (
    format === "image/png" &&
    data.length >= 24 &&
    data[0] === 137 &&
    data[1] === 80 &&
    data[2] === 78 &&
    data[3] === 71 &&
    data[12] === 73 &&
    data[13] === 72 &&
    data[14] === 68 &&
    data[15] === 82
  ) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    format === "image/gif" &&
    data.length >= 13 &&
    data[0] === 71 &&
    data[1] === 73 &&
    data[2] === 70 &&
    data[3] === 56 &&
    (data[4] === 55 || data[4] === 57) &&
    data[5] === 97
  ) {
    width = data[6]! + data[7]! * 256;
    height = data[8]! + data[9]! * 256;
    let offset = 13 + (data[10]! & 128 ? 3 * (2 << (data[10]! & 7)) : 0);
    let pixels = 0;
    let frames = 0;
    let terminated = false;
    const skipBlocks = (): boolean => {
      while (offset < data.length) {
        const size = data[offset++]!;
        if (size === 0) return true;
        offset += size;
      }
      return false;
    };
    while (offset < data.length) {
      const block = data[offset++]!;
      if (block === 0x3b) {
        terminated = true;
        break;
      }
      if (block === 0x21) {
        if (offset >= data.length) return null;
        offset++; // extension label
        if (!skipBlocks()) return null;
        continue;
      }
      if (block !== 0x2c || offset + 9 > data.length) return null;
      const left = data[offset]! + data[offset + 1]! * 256;
      const top = data[offset + 2]! + data[offset + 3]! * 256;
      const frameWidth = data[offset + 4]! + data[offset + 5]! * 256;
      const frameHeight = data[offset + 6]! + data[offset + 7]! * 256;
      const packed = data[offset + 8]!;
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height)
        return null;
      pixels += frameWidth * frameHeight;
      if (pixels > TERMINAL_GRAPHICS_PIXELS) return null;
      frames++;
      offset += 9 + (packed & 128 ? 3 * (2 << (packed & 7)) : 0);
      if (offset >= data.length || data[offset]! < 2 || data[offset]! > 8) return null;
      offset++; // LZW minimum code size
      if (!skipBlocks()) return null;
    }
    // Native GIF decoders can enlarge beyond the logical screen using frame
    // descriptors. Validate every frame before handing any bytes to that decoder.
    if (!terminated || frames === 0) return null;
  } else if (format === "image/jpeg" && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset + 4 < data.length && data[offset] === 255) {
      const marker = data[offset + 1];
      const length = data[offset + 2]! * 256 + data[offset + 3]!;
      if (length < 2 || offset + 2 + length > data.length) break;
      if ((marker === 192 || marker === 194) && length >= 8) {
        height = data[offset + 5]! * 256 + data[offset + 6]!;
        width = data[offset + 7]! * 256 + data[offset + 8]!;
        break;
      }
      offset += 2 + length;
    }
  }
  return width > 0 && height > 0 && width * height <= TERMINAL_GRAPHICS_PIXELS
    ? [width, height]
    : null;
}

/** Identical stream-local admission in the authoritative mirror and every viewer. */
export class TerminalImageBudget {
  private readonly images = new Map<number, { bytes: number; pixels: number; cells: number }>();
  private bytes = 0;
  private pixels = 0;
  private cells = 0;

  remove(id: number): void {
    const value = this.images.get(id);
    if (value === undefined) return;
    this.bytes -= value.bytes;
    this.pixels -= value.pixels;
    this.cells -= value.cells;
    this.images.delete(id);
  }

  clear(): void {
    this.images.clear();
    this.bytes = this.pixels = this.cells = 0;
  }

  admit(
    id: number,
    width: number,
    height: number,
    encodedBytes: number,
    evict: (id: number) => void,
  ): boolean {
    const pixels = width * height;
    const bytes = encodedBytes;
    if (!Number.isSafeInteger(bytes) || bytes < 1) return false;
    const cells =
      Math.ceil(width / TERMINAL_GRAPHICS_CELL.width) *
      Math.ceil(height / TERMINAL_GRAPHICS_CELL.height);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 2048 ||
      height > 2048 ||
      pixels > TERMINAL_GRAPHICS_PIXELS ||
      bytes > TERMINAL_GRAPHICS_BYTES ||
      cells > TERMINAL_GRAPHICS_CELLS
    )
      return false;
    while (
      this.images.size >= TERMINAL_GRAPHICS_IMAGES ||
      this.bytes + bytes > TERMINAL_GRAPHICS_BYTES ||
      this.pixels + pixels > TERMINAL_GRAPHICS_PIXELS ||
      this.cells + cells > TERMINAL_GRAPHICS_CELLS
    ) {
      const oldest = this.images.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
      evict(oldest);
    }
    this.images.set(id, { bytes, pixels, cells });
    this.bytes += bytes;
    this.pixels += pixels;
    this.cells += cells;
    return true;
  }
}
