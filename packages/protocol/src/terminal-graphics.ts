import { z } from "zod";
import { validTerminalRgba } from "./terminal-image-codec.ts";

/** Transient graphics state travels inside the existing seq-anchored VT snapshot. */
export const TERMINAL_GRAPHICS_PREFIX = "ManifoldGraphics=";
export const TERMINAL_GRAPHICS_CELL = { width: 7, height: 14 } as const;
export const TERMINAL_GRAPHICS_IMAGES = 64;
export const TERMINAL_GRAPHICS_PIXELS = 2 * 1024 * 1024;
/** Pixels per side; 293 x 147 canonical tiles keep every tile id inside a uint16 record. */
export const TERMINAL_GRAPHICS_AXIS = 2048;
/** An iTerm inline file after base64 decoding, and its streaming header characters. */
export const TERMINAL_GRAPHICS_FILE_BYTES = 131_072;
export const TERMINAL_GRAPHICS_FILE_HEADER = 4_096;

/**
 * The UTF-8 snapshot bytes the graphics envelope and the one unfinished control a parser can
 * hold share inside the 449,992-byte snapshot payload (ADR 0031, divided by ADR 0061).
 */
export const TERMINAL_GRAPHICS_SNAPSHOT_BYTES = 447_000;
/** Envelope framing, scalars and the 256-entry palette, excluding image entries. */
export const TERMINAL_GRAPHICS_ENVELOPE_BYTES = 2_000;
/** An unfinished control's introducer, parameters, intermediates and final byte. */
const TERMINAL_CONTROL_HEADER_BYTES = 2_048;
/** Unfinished non-Sixel control payload a continuation carries; covers a maximal iTerm file. */
export const TERMINAL_CONTROL_PAYLOAD_BYTES = 180_000;
/** Sixel DCS input; OMP's 9x18 pre-negotiation frames of ordinary screenshots fit within it. */
export const TERMINAL_GRAPHICS_SIXEL_BYTES = 393_216;
/** Charged per retained image for its JSON entry, beside its base64 data and cell records. */
const IMAGE_ENTRY_BYTES = 128;

/** Admission rules of the terminal host that produced a stream; viewers follow its envelope. */
export interface TerminalGraphicsPolicy {
  readonly version: 1 | 2;
  /** UTF-8 payload bytes in v2; retained v1 hosts count parser code points instead. */
  readonly sixelBytes: number;
  /** Version 2: snapshot charge of every retained entry. Version 1: retained encoded bytes. */
  readonly retainedBytes: number;
  /** Version 1 hosts also cap retained canonical cells; version 2 charges their records. */
  readonly cells: number | undefined;
}

/**
 * Ordinary controls keep their fixed share of the reservation. A Sixel payload beyond that
 * share displaces retained images, oldest first, instead of enlarging the snapshot.
 */
export const TERMINAL_GRAPHICS_POLICY: TerminalGraphicsPolicy = {
  version: 2,
  sixelBytes: TERMINAL_GRAPHICS_SIXEL_BYTES,
  retainedBytes:
    TERMINAL_GRAPHICS_SNAPSHOT_BYTES -
    TERMINAL_GRAPHICS_ENVELOPE_BYTES -
    TERMINAL_CONTROL_PAYLOAD_BYTES -
    TERMINAL_CONTROL_HEADER_BYTES,
  cells: undefined,
};

/** Retained terminal hosts from before protocol 59 emit version 1 envelopes. */
export const LEGACY_TERMINAL_GRAPHICS_POLICY: TerminalGraphicsPolicy = {
  version: 1,
  sixelBytes: 131_072,
  retainedBytes: 180_000,
  cells: 2_048,
};

export type TerminalGraphicsResource =
  "sixel-input" | "file-input" | "file-header" | "axis" | "pixels" | "retained" | "cells";

/** The limiting resource of a refused image, with observed and allowed quantities. */
export interface TerminalGraphicsRefusal {
  readonly resource: TerminalGraphicsResource;
  /** Absent when work stopped at the bound before the exact quantity was known. */
  readonly observed: number | undefined;
  readonly allowed: number;
  readonly width?: number;
  readonly height?: number;
}

/** Canonical 7x14 cells an image covers; also its tile count and worst-case placements. */
export function terminalGraphicsFootprint(width: number, height: number): number {
  return (
    Math.ceil(width / TERMINAL_GRAPHICS_CELL.width) *
    Math.ceil(height / TERMINAL_GRAPHICS_CELL.height)
  );
}

const integer = z.number().int().nonnegative();
const dimension = z.number().int().min(1).max(TERMINAL_GRAPHICS_AXIS);
const format = z.enum([
  "rgba",
  "rgba-indexed",
  "rgba-indexed-alpha",
  "rgba-rle",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
const palette = z.base64().length(1368).endsWith("==");
function envelope<const Version extends 1 | 2>(
  version: Version,
  dataChars: number,
  cellChars: number,
) {
  return z.strictObject({
    version: z.literal(version),
    scrolling: z.boolean(),
    palette,
    paletteLimit: z.number().int().min(1).max(256),
    images: z
      .array(
        z.strictObject({
          id: integer.max(TERMINAL_GRAPHICS_IMAGES - 1),
          width: dimension,
          height: dimension,
          format,
          data: z.base64().max(dataChars),
          buffer: z.enum(["normal", "alternate"]),
          /** Little-endian uint16 triples: buffer row, column, source tile. */
          cells: z.base64().max(cellChars),
        }),
      )
      .max(TERMINAL_GRAPHICS_IMAGES),
  });
}
export const TerminalGraphicsSnapshotSchema = z
  .discriminatedUnion("version", [
    envelope(
      1,
      Math.ceil(LEGACY_TERMINAL_GRAPHICS_POLICY.retainedBytes / 3) * 4,
      (LEGACY_TERMINAL_GRAPHICS_POLICY.cells ?? 0) * 8,
    ),
    envelope(2, TERMINAL_GRAPHICS_POLICY.retainedBytes, TERMINAL_GRAPHICS_POLICY.retainedBytes),
  ])
  .superRefine((state, context) => {
    const ids = new Set<number>();
    let charge = 0;
    let footprints = 0;
    let pixels = 0;
    let cells = 0;
    let invalid = false;
    for (const entry of state.images) {
      invalid ||= ids.has(entry.id);
      ids.add(entry.id);
      const footprint = terminalGraphicsFootprint(entry.width, entry.height);
      footprints += footprint;
      const area = entry.width * entry.height;
      pixels += area;
      try {
        const source = Uint8Array.from(atob(entry.data), (character) => character.charCodeAt(0));
        charge +=
          state.version === 1
            ? source.length
            : IMAGE_ENTRY_BYTES + entry.data.length + entry.cells.length;
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
        // Version 2 charges every image for at most one record per canonical tile.
        if (packed.length % 6 !== 0 || (state.version === 2 && packed.length / 6 > footprint)) {
          invalid = true;
          continue;
        }
        const view = new DataView(packed.buffer);
        for (let offset = 0; offset < packed.length; offset += 6) {
          invalid ||=
            view.getUint16(offset, true) > 6000 ||
            view.getUint16(offset + 2, true) > 999 ||
            view.getUint16(offset + 4, true) >= footprint;
        }
      } catch {
        invalid = true;
      }
    }
    const policy = state.version === 1 ? LEGACY_TERMINAL_GRAPHICS_POLICY : TERMINAL_GRAPHICS_POLICY;
    if (
      invalid ||
      charge > policy.retainedBytes ||
      pixels > TERMINAL_GRAPHICS_PIXELS ||
      (policy.cells !== undefined && (cells > policy.cells || footprints > policy.cells))
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
  private readonly images = new Map<number, { charge: number; pixels: number; cells: number }>();
  private charged = 0;
  private pixels = 0;
  private cells = 0;
  private rules = TERMINAL_GRAPHICS_POLICY;

  get policy(): TerminalGraphicsPolicy {
    return this.rules;
  }

  remove(id: number): void {
    const value = this.images.get(id);
    if (value === undefined) return;
    this.charged -= value.charge;
    this.pixels -= value.pixels;
    this.cells -= value.cells;
    this.images.delete(id);
  }

  /** Releases every admission; a snapshot also adopts its producing host's policy. */
  clear(policy = this.rules): void {
    this.images.clear();
    this.charged = this.pixels = this.cells = 0;
    this.rules = policy;
  }

  /** Largest encoding whose retained charge could still admit an image of this size. */
  encodedLimit(width: number, height: number): number {
    if (this.rules.version === 1) return this.rules.retainedBytes;
    const room =
      this.rules.retainedBytes - IMAGE_ENTRY_BYTES - 8 * terminalGraphicsFootprint(width, height);
    return Math.max(0, Math.floor(room / 4) * 3);
  }

  /**
   * The per-image refusal, computable before decoding or uploading. One encoded byte checks
   * what dimensions alone prove; `undefined` means encoding stopped at {@link encodedLimit}.
   * An image this accepts is always admitted, after evicting older images.
   */
  refuse(
    width: number,
    height: number,
    encodedBytes: number | undefined,
  ): TerminalGraphicsRefusal | undefined {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > TERMINAL_GRAPHICS_AXIS ||
      height > TERMINAL_GRAPHICS_AXIS
    ) {
      return {
        resource: "axis",
        observed: Math.max(width, height),
        allowed: TERMINAL_GRAPHICS_AXIS,
        width,
        height,
      };
    }
    if (width * height > TERMINAL_GRAPHICS_PIXELS) {
      return {
        resource: "pixels",
        observed: width * height,
        allowed: TERMINAL_GRAPHICS_PIXELS,
        width,
        height,
      };
    }
    const footprint = terminalGraphicsFootprint(width, height);
    if (this.rules.cells !== undefined && footprint > this.rules.cells) {
      return { resource: "cells", observed: footprint, allowed: this.rules.cells, width, height };
    }
    const charge =
      encodedBytes !== undefined && Number.isSafeInteger(encodedBytes) && encodedBytes > 0
        ? this.charge(width, height, encodedBytes)
        : undefined;
    if (charge !== undefined && charge <= this.rules.retainedBytes) return undefined;
    return {
      resource: "retained",
      observed: charge,
      allowed: this.rules.retainedBytes,
      width,
      height,
    };
  }

  admit(
    id: number,
    width: number,
    height: number,
    encodedBytes: number,
    evict: (id: number) => void,
  ): boolean {
    if (this.refuse(width, height, encodedBytes) !== undefined) return false;
    const pixels = width * height;
    const cells = terminalGraphicsFootprint(width, height);
    const charge = this.charge(width, height, encodedBytes);
    while (
      this.images.size >= TERMINAL_GRAPHICS_IMAGES ||
      this.charged + charge > this.rules.retainedBytes ||
      this.pixels + pixels > TERMINAL_GRAPHICS_PIXELS ||
      (this.rules.cells !== undefined && this.cells + cells > this.rules.cells)
    ) {
      if (!this.evictOldest(evict)) break;
    }
    this.images.set(id, { charge, pixels, cells });
    this.charged += charge;
    this.pixels += pixels;
    this.cells += cells;
    return true;
  }

  /**
   * An in-flight Sixel payload of `payloadBytes` beyond the ordinary control share
   * displaces the oldest images. Monotone in its argument, so evaluating it at any parser
   * chunk boundaries leaves every peer with the same images at the same byte position.
   */
  reserve(payloadBytes: number, evict: (id: number) => void): void {
    if (this.rules.version === 1) return;
    const limit =
      this.rules.retainedBytes -
      Math.max(0, Math.min(payloadBytes, this.rules.sixelBytes) - TERMINAL_CONTROL_PAYLOAD_BYTES);
    while (this.charged > limit && this.evictOldest(evict));
  }

  private charge(width: number, height: number, encodedBytes: number): number {
    return this.rules.version === 1
      ? encodedBytes
      : IMAGE_ENTRY_BYTES +
          Math.ceil(encodedBytes / 3) * 4 +
          8 * terminalGraphicsFootprint(width, height);
  }

  private evictOldest(evict: (id: number) => void): boolean {
    const oldest = this.images.keys().next().value;
    if (oldest === undefined) return false;
    this.remove(oldest);
    evict(oldest);
    return true;
  }
}

/**
 * Streaming Sixel payload admission shared by the mirror and every viewer. It counts the
 * UTF-8 bytes a snapshot continuation would carry, and refuses raster attributes that
 * already prove an impossible image before the decoder sees the data it would allocate for.
 * A version-1 host decoded such a control before refusing it, so under that policy the
 * decoder still runs and keeps the control's palette updates; refusal waits for unhook.
 */
export class TerminalSixelGate {
  private counted = 0;
  private raster: string | undefined = "";
  private refused: TerminalGraphicsRefusal | undefined;

  constructor(private readonly budget: TerminalImageBudget) {}

  /** Payload charge: UTF-8 bytes in v2, code points in v1; never decreases per control. */
  get bytes(): number {
    return this.counted;
  }

  get refusal(): TerminalGraphicsRefusal | undefined {
    return this.refused;
  }

  start(): void {
    this.counted = 0;
    this.raster = "";
    this.refused = undefined;
  }

  /** Counts one parser chunk. False refuses this chunk and the rest of the control. */
  put(data: Uint32Array, start: number, end: number): boolean {
    if (this.refused !== undefined) return false;
    const limit = this.budget.policy.sixelBytes;
    const legacy = this.budget.policy.version === 1;
    for (let index = start; index < end; index++) {
      const code = data[index]!;
      this.counted += legacy || code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      if (this.counted > limit) {
        this.refused = { resource: "sixel-input", observed: undefined, allowed: limit };
        this.counted = limit;
        return false;
      }
      if (this.raster === undefined || legacy) continue;
      // `"Pan;Pad;Ph;Pv` precedes any pixel data; its end commits the decoder's canvas.
      const continues =
        this.raster.length === 0 ? code === 0x22 : code === 0x3b || (code >= 0x30 && code <= 0x39);
      if (continues && this.raster.length < 64) {
        this.raster += String.fromCharCode(code);
        continue;
      }
      const [, , width = 0, height = 0] = this.raster.slice(1).split(";").map(Number);
      this.raster = undefined;
      if (width > 0 && height > 0) this.refused = this.budget.refuse(width, height, 1);
      if (this.refused !== undefined) return false;
    }
    return true;
  }
}
