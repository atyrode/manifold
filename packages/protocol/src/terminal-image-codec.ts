export type TerminalRgbaFormat = "rgba" | "rgba-indexed" | "rgba-indexed-alpha" | "rgba-rle";
export interface EncodedTerminalRgba {
  format: TerminalRgbaFormat;
  bytes: Uint8Array;
}

/** Deterministic lossless PackBits; preserves the 256 Sixel colors plus transparent fill. */
export function encodeTerminalRgba(
  bytes: Uint8Array,
  maxBytes: number,
): EncodedTerminalRgba | undefined {
  if (bytes.length === 0 || bytes.length % 4 !== 0) return undefined;
  const pixels = bytes.length / 4;
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const palette = new Map<number, number>();
  for (let pixel = 0; pixel < pixels; pixel++) {
    const color = source.getUint32(pixel * 4, true);
    if (!palette.has(color)) palette.set(color, palette.size);
    if (palette.size > 257) break;
  }
  const transparent = palette.size === 257 && palette.has(0);
  if (transparent) {
    palette.delete(0);
    let index = 0;
    for (const color of palette.keys()) palette.set(color, index++);
  }
  const indexed = palette.size <= 256;
  const sampleBytes = indexed ? (transparent ? 2 : 1) : 4;
  const header = indexed ? 1 + palette.size * 4 : 0;
  const output = new Uint8Array(
    Math.min(maxBytes, header + pixels * sampleBytes + Math.ceil(pixels / 128)),
  );
  const target = new DataView(output.buffer);
  const rawFallback = (): EncodedTerminalRgba | undefined =>
    bytes.length <= maxBytes ? { format: "rgba", bytes } : undefined;
  let position = header;
  if (header > output.length) return rawFallback();
  if (indexed) {
    output[0] = palette.size - 1;
    for (const [color, index] of palette) target.setUint32(1 + index * 4, color, true);
  }
  const writeSample = (color: number): boolean => {
    if (!indexed) {
      if (position + 4 > output.length) return false;
      target.setUint32(position, color, true);
      position += 4;
    } else {
      const index = palette.get(color);
      const escaped = transparent && (color === 0 || index === 255);
      if (position + (escaped ? 2 : 1) > output.length) return false;
      if (escaped) {
        output[position++] = 255;
        output[position++] = color === 0 ? 1 : 0;
      } else {
        if (index === undefined) return false;
        output[position++] = index;
      }
    }
    return true;
  };
  let pixel = 0;
  while (pixel < pixels) {
    const color = source.getUint32(pixel * 4, true);
    let repeated = 1;
    while (
      repeated < 128 &&
      pixel + repeated < pixels &&
      source.getUint32((pixel + repeated) * 4, true) === color
    )
      repeated++;
    if (position >= output.length) return rawFallback();
    if (repeated >= (indexed ? 3 : 2)) {
      output[position++] = 128 | (repeated - 1);
      if (!writeSample(color)) return rawFallback();
      pixel += repeated;
      continue;
    }
    const first = pixel;
    pixel += repeated;
    while (pixel < pixels && pixel - first < 128) {
      const next = source.getUint32(pixel * 4, true);
      let run = 1;
      while (
        run < (indexed ? 3 : 2) &&
        pixel + run < pixels &&
        source.getUint32((pixel + run) * 4, true) === next
      )
        run++;
      if (run >= (indexed ? 3 : 2)) break;
      pixel += Math.min(run, 128 - (pixel - first));
    }
    output[position++] = pixel - first - 1;
    for (let index = first; index < pixel; index++)
      if (!writeSample(source.getUint32(index * 4, true))) return rawFallback();
  }
  if (position >= bytes.length && bytes.length <= maxBytes) return { format: "rgba", bytes };
  return {
    format: indexed ? (transparent ? "rgba-indexed-alpha" : "rgba-indexed") : "rgba-rle",
    bytes: output.slice(0, position),
  };
}

/** One bounded grammar walk; an optional sink runs only after a complete validation pass. */
function walkPackets(
  bytes: Uint8Array,
  format: TerminalRgbaFormat,
  pixels: number,
  emit?: (color: number, count: number) => void,
): boolean {
  const indexed = format === "rgba-indexed" || format === "rgba-indexed-alpha";
  const transparent = format === "rgba-indexed-alpha";
  const colors = indexed ? (bytes[0] ?? 0) + 1 : 0;
  let position = indexed ? 1 + colors * 4 : 0;
  if (position > bytes.length || (transparent && colors !== 256)) return false;
  const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let produced = 0;
  while (position < bytes.length) {
    const control = bytes[position++]!;
    const count = (control & 127) + 1;
    const repeat = (control & 128) !== 0;
    if (produced + count > pixels) return false;
    for (let sample = 0; sample < (repeat ? 1 : count); sample++) {
      let color: number;
      if (!indexed) {
        if (position + 4 > bytes.length) return false;
        color = source.getUint32(position, true);
        position += 4;
      } else {
        if (position === bytes.length) return false;
        const index = bytes[position++]!;
        if (index >= colors) return false;
        if (transparent && index === 255) {
          if (position === bytes.length) return false;
          const escape = bytes[position++]!;
          if (escape > 1) return false;
          color = escape === 1 ? 0 : source.getUint32(1 + 255 * 4, true);
        } else color = source.getUint32(1 + index * 4, true);
      }
      emit?.(color, repeat ? count : 1);
    }
    produced += count;
  }
  return produced === pixels;
}

/** Validate every packet and palette index before allocating a decoded image. */
export function validTerminalRgba(
  bytes: Uint8Array,
  format: TerminalRgbaFormat,
  pixels: number,
): boolean {
  if (!Number.isSafeInteger(pixels) || pixels <= 0) return false;
  if (format === "rgba") return bytes.length === pixels * 4;
  return walkPackets(bytes, format, pixels);
}

/** The caller's validated dimensions are the allocation ceiling, not encoded claims. */
export function decodeTerminalRgba(
  bytes: Uint8Array,
  format: TerminalRgbaFormat,
  pixels: number,
  maxPixels: number,
): Uint8Array<ArrayBuffer> | undefined {
  if (pixels > maxPixels || !validTerminalRgba(bytes, format, pixels)) return undefined;
  if (format === "rgba") return new Uint8Array(bytes);
  const output = new Uint8Array(pixels * 4);
  const target = new DataView(output.buffer);
  let pixel = 0;
  walkPackets(bytes, format, pixels, (color, count) => {
    for (let index = 0; index < count; index++) target.setUint32(pixel++ * 4, color, true);
  });
  return output;
}
