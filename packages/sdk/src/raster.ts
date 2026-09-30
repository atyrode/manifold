import {
  MAX_LOCAL_FILE_BYTES,
  MAX_RASTER_PIXELS,
  MAX_RASTER_SIDE,
  type RasterMediaType,
} from "@manifold/protocol";

export interface RasterDimensions { readonly width: number; readonly height: number }

/** Structural admission, NOT a pixel decoder. No browser decode runs before this bound.
 * Walk the complete container to refuse animation/secondary frames and contradictory sizes.
 * The browser still must successfully decode; the durable owner separately validates pixels.
 */
export function inspectStaticRaster(data: Uint8Array, mediaType: RasterMediaType): RasterDimensions {
  const fail = (): never => { throw new Error("unsupported_image"); };
  if (data.length === 0 || data.length > MAX_LOCAL_FILE_BYTES) fail();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const has = (at: number, count: number): boolean => at >= 0 && at + count <= data.length;
  const text = (at: number, value: string): boolean => {
    if (!has(at, value.length)) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (data[at + index] !== value.charCodeAt(index)) return false;
    }
    return true;
  };
  const u16 = (at: number, little = false): number => has(at, 2) ? view.getUint16(at, little) : fail();
  const u32 = (at: number, little = false): number => has(at, 4) ? view.getUint32(at, little) : fail();
  const size = (width: number, height: number): RasterDimensions => {
    if (width < 1 || height < 1 || width > MAX_RASTER_SIDE || height > MAX_RASTER_SIDE ||
        width * height > MAX_RASTER_PIXELS) fail();
    return { width, height };
  };
  if (mediaType === "image/png") {
    if (!text(0, "\x89PNG\r\n\x1a\n") || !text(12, "IHDR") || u32(8) !== 13) fail();
    const dimensions = size(u32(16), u32(20));
    let offset = 8;
    let pixels = false;
    let endedPixels = false;
    while (has(offset, 12)) {
      const length = u32(offset);
      if (!has(offset, length + 12)) fail();
      if (text(offset + 4, "acTL") || text(offset + 4, "fcTL") || text(offset + 4, "fdAT")) fail();
      if (offset !== 8 && text(offset + 4, "IHDR")) fail();
      if (text(offset + 4, "IDAT")) {
        if (endedPixels) fail();
        pixels = true;
      } else if (pixels) endedPixels = true;
      if (text(offset + 4, "IEND")) {
        if (!pixels || length !== 0 || offset + 12 !== data.length) fail();
        return dimensions;
      }
      offset += length + 12;
    }
    return fail();
  }
  if (mediaType === "image/gif") {
    if (!text(0, "GIF87a") && !text(0, "GIF89a")) fail();
    const dimensions = size(u16(6, true), u16(8, true));
    if (!has(0, 13)) fail();
    let offset = 13 + ((data[10]! & 0x80) ? 3 * (1 << ((data[10]! & 7) + 1)) : 0);
    let frames = 0;
    const blocks = (): void => {
      while (has(offset, 1)) {
        const length = data[offset++]!;
        if (length === 0) return;
        if (!has(offset, length)) fail();
        offset += length;
      }
      fail();
    };
    while (has(offset, 1)) {
      const marker = data[offset++]!;
      if (marker === 0x3b) {
        if (frames !== 1 || offset !== data.length) fail();
        return dimensions;
      }
      if (marker === 0x21) {
        if (!has(offset, 1)) fail();
        const extension = data[offset++]!;
        // Plain text is another rendered frame. Application metadata is inert here;
        // even a loop extension cannot animate a container with exactly one image.
        if (extension !== 0xf9 && extension !== 0xfe && extension !== 0xff) fail();
        blocks();
      } else if (marker === 0x2c) {
        if (++frames !== 1 || !has(offset, 9)) fail();
        const frame = size(u16(offset + 4, true), u16(offset + 6, true));
        if (u16(offset, true) + frame.width > dimensions.width ||
            u16(offset + 2, true) + frame.height > dimensions.height) fail();
        const packed = data[offset + 8]!;
        offset += 9 + ((packed & 0x80) ? 3 * (1 << ((packed & 7) + 1)) : 0);
        if (!has(offset, 1) || data[offset]! < 2 || data[offset]! > 8) fail();
        offset += 1;
        blocks();
      } else fail();
    }
    return fail();
  }
  if (mediaType === "image/webp") {
    if (!text(0, "RIFF") || !text(8, "WEBP") || u32(4, true) + 8 !== data.length) fail();
    let canvas: RasterDimensions | undefined;
    let image: RasterDimensions | undefined;
    let offset = 12;
    while (has(offset, 8)) {
      const length = u32(offset + 4, true);
      const start = offset + 8;
      if (!has(start, length + (length & 1))) fail();
      if (text(offset, "ANIM") || text(offset, "ANMF")) fail();
      if (text(offset, "VP8X")) {
        if (offset !== 12 || length !== 10 || (data[start]! & 2)) fail();
        const dimension = (at: number): number => 1 + data[at]! + (data[at + 1]! << 8) + (data[at + 2]! << 16);
        canvas = size(dimension(start + 4), dimension(start + 7));
      } else if (text(offset, "VP8 ")) {
        if (image !== undefined || length < 10 || (data[start]! & 1) || !text(start + 3, "\x9d\x01\x2a")) fail();
        image = size(u16(start + 6, true) & 0x3fff, u16(start + 8, true) & 0x3fff);
      } else if (text(offset, "VP8L")) {
        if (image !== undefined || length < 5 || data[start] !== 0x2f) fail();
        const bits = u32(start + 1, true);
        if (bits >>> 29 !== 0) fail();
        image = size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
      }
      offset = start + length + (length & 1);
    }
    if (offset !== data.length || image === undefined) return fail();
    if (canvas !== undefined && (canvas.width !== image.width || canvas.height !== image.height)) fail();
    return image;
  }
  if (mediaType === "image/jpeg") {
    if (!text(0, "\xff\xd8")) fail();
    let offset = 2;
    let dimensions: RasterDimensions | undefined;
    let scan = false;
    while (has(offset, 2)) {
      if (data[offset++] !== 0xff) fail();
      while (data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xd9) {
        if (!scan || dimensions === undefined || offset !== data.length) return fail();
        return dimensions;
      }
      if (marker === undefined || marker === 0xd8 || marker === 0xdc || marker === 0x00 ||
          marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return fail();
      const length = u16(offset);
      if (length < 2 || !has(offset, length)) fail();
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (dimensions !== undefined || (marker !== 0xc0 && marker !== 0xc1 && marker !== 0xc2) || length < 8) fail();
        dimensions = size(u16(offset + 5), u16(offset + 3));
      }
      offset += length;
      if (marker === 0xda) {
        if (dimensions === undefined) fail();
        scan = true;
        // Entropy is opaque: only marker escapes and restart markers are interpreted.
        while (has(offset, 2)) {
          if (data[offset] !== 0xff) { offset += 1; continue; }
          const next = data[offset + 1]!;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
          break;
        }
      }
    }
  }
  return fail();
}
