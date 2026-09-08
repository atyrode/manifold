import { ImageAddon } from "@xterm/addon-image";
import type { Terminal, IMarker } from "@xterm/xterm";
import {
  TERMINAL_GRAPHICS_BYTES,
  TERMINAL_GRAPHICS_INPUT_BYTES,
  TERMINAL_GRAPHICS_CELLS,
  TERMINAL_GRAPHICS_CELL,
  TERMINAL_GRAPHICS_PIXELS,
  TERMINAL_GRAPHICS_PREFIX,
  TERMINAL_GRAPHICS_SNAPSHOT_BYTES,
  TerminalGraphicsSnapshotSchema,
  TerminalImageBudget,
  inlineImageDimensions,
  encodeTerminalRgba,
  decodeTerminalRgba,
} from "@manifold/protocol";

interface ImageSpec {
  orig: HTMLCanvasElement | ImageBitmap;
  actual: HTMLCanvasElement | ImageBitmap;
  origCellSize: { width: number; height: number };
  actualCellSize: { width: number; height: number };
  bufferType: "normal" | "alternate";
  tileCount: number;
  marker?: { dispose(): void };
}
interface ImageLine {
  length: number;
}
interface ImageBuffer {
  lines: { length: number; get(y: number): ImageLine | undefined };
}
interface ImageStorage {
  _images: Map<number, ImageSpec>;
  _lastId: number;
  addImage(image: HTMLCanvasElement | ImageBitmap): void;
  advanceCursor(height: number): void;
  _delImg(id: number): void;
  _evictOldest(room: number): number;
  _writeToCell(line: ImageLine, col: number, id: number, tile: number): void;
  render(range: { start: number; end: number }): void;
}
interface GraphicsDimensions {
  css: { cell: { width: number; height: number }; canvas: { width: number; height: number } };
}
interface AddonInternals {
  _storage: ImageStorage;
  _renderer: {
    dimensions?: GraphicsDimensions;
    _ctx?: CanvasRenderingContext2D;
    draw(image: ImageSpec, tile: number, col: number, row: number, count?: number): void;
  };
  _opts: { sixelScrolling: boolean; sixelPaletteLimit: number };
  _report(data: string): void;
  _handlers: Map<
    string,
    {
      _dec?: {
        _palette: Uint32Array;
        width: number;
        height: number;
        data8?: Uint8Array;
        release(): void;
      };
      _header?: { size?: number };
      _size?: number;
      _aborted?: boolean;
      _metrics?: { width: number; height: number; mime: string };
      _resize?: (width: number, height: number) => [number, number];
      end?: (success: boolean) => boolean | Promise<boolean>;
      start?: () => void;
      put?: (data: Uint32Array, start: number, end: number) => void;
      hook?: (params: { params: Int32Array }) => void;
      unhook?: (success: boolean) => boolean | Promise<boolean>;
    }
  >;
}
interface MarkerTerminal {
  registerMarker(cursorYOffset?: number): IMarker | undefined;
}
interface TerminalInternals {
  _core: { buffers: { normal: ImageBuffer; alt: ImageBuffer } };
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(data);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export interface TerminalGraphics {
  writeSnapshot(data: Uint8Array, callback?: () => void): void;
  dispose(): void;
}

/** ImageAddon owns rendering and image-cell editing; this bridge owns no parallel overlay. */
export function installTerminalGraphics(
  terminal: Terminal,
  onImageRejected?: (message: string) => void,
): TerminalGraphics {
  const addon = new ImageAddon({
    enableSizeReports: false,
    pixelLimit: TERMINAL_GRAPHICS_PIXELS + 1,
    storageLimit: 0.5,
    showPlaceholder: false,
    sixelSizeLimit: TERMINAL_GRAPHICS_INPUT_BYTES,
    iipSizeLimit: TERMINAL_GRAPHICS_INPUT_BYTES,
  });
  terminal.loadAddon(addon);
  const internals = addon as unknown as AddonInternals;
  const rejectImage = (
    message = "Inline image not shown: exceeds the browser terminal's bounded graphics limits.",
  ): void => {
    if (!disposed) onImageRejected?.(message);
  };
  let disposed = false;
  const ready = terminal.parser.registerOscHandler(777, async (data) => {
    if (data !== "ManifoldGraphicsReady") return false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (disposed) return true;
      if (internals._handlers.get("sixel")?._dec !== undefined) return true;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 1);
      await promise;
    }
    if (disposed) return true;
    throw new Error("Terminal graphics decoder initialization timed out");
  });
  terminal.write("\x1b]777;ManifoldGraphicsReady\x07", () => ready.dispose());
  const { _storage: storage, _renderer: renderer } = internals;
  if (
    !(storage?._images instanceof Map) ||
    typeof storage._writeToCell !== "function" ||
    renderer === undefined
  ) {
    throw new Error("Unsupported @xterm/addon-image private API (expected 0.9.0)");
  }
  const dimensions = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(renderer),
    "dimensions",
  )?.get;
  if (dimensions === undefined) throw new Error("Missing pinned graphics renderer metrics");
  const actualDimensions = dimensions as (
    this: AddonInternals["_renderer"],
  ) => GraphicsDimensions | undefined;
  let painting = false;
  Object.defineProperty(renderer, "dimensions", {
    get: () =>
      painting
        ? actualDimensions.call(renderer)
        : {
            css: {
              cell: TERMINAL_GRAPHICS_CELL,
              canvas: { width: terminal.cols * 7, height: terminal.rows * 14 },
            },
          },
  });
  const render = storage.render.bind(storage);
  storage.render = (range) => {
    painting = true;
    try {
      render(range);
    } finally {
      painting = false;
    }
  };
  // Keep tile indices in canonical cells. Resampling an intermediate canvas to
  // fractional CSS cell widths can create a spurious extra source column after
  // rounding; scaling the source tile directly also avoids per-font image copies.
  renderer.draw = (image, tile, col, row, count = 1) => {
    const cell = actualDimensions.call(renderer)?.css.cell;
    const context = renderer._ctx;
    if (cell === undefined || context === undefined) return;
    const columns = Math.ceil(image.orig.width / TERMINAL_GRAPHICS_CELL.width);
    let offset = 0;
    while (offset < count) {
      const sourceTile = tile + offset;
      const sourceX = (sourceTile % columns) * TERMINAL_GRAPHICS_CELL.width;
      const sourceY = Math.floor(sourceTile / columns) * TERMINAL_GRAPHICS_CELL.height;
      const span = Math.min(count - offset, columns - (sourceTile % columns));
      const width = Math.min(span * TERMINAL_GRAPHICS_CELL.width, image.orig.width - sourceX);
      const height = Math.min(TERMINAL_GRAPHICS_CELL.height, image.orig.height - sourceY);
      if (width <= 0 || height <= 0) return;
      context.drawImage(
        image.orig,
        sourceX,
        sourceY,
        width,
        height,
        (col + offset) * cell.width,
        row * cell.height,
        (width / TERMINAL_GRAPHICS_CELL.width) * cell.width,
        (height / TERMINAL_GRAPHICS_CELL.height) * cell.height,
      );
      offset += span;
    }
  };
  // Exactly one authority answers capability queries. Multiple viewers must not
  // race replies or change the protocol selected by an application on reconnect.
  internals._report = () => {};
  const geometry = terminal.parser.registerCsiHandler({ final: "t" }, (params) =>
    [14, 16, 18].includes(Number(params[0])),
  );
  const palettePolicy = terminal.parser.registerCsiHandler(
    { prefix: "?", final: "S" },
    (params) =>
      params[0] === 1 &&
      (params[1] === 4 ||
        (params[1] === 3 && (typeof params[2] !== "number" || params[2] < 1 || params[2] > 256))),
  );
  const budget = new TerminalImageBudget();
  let encodedBytes = 0;
  let generation = 0;
  let decodingGeneration = 0;
  const iip = internals._handlers.get("iip");
  if (iip?.end === undefined) throw new Error("Missing pinned iTerm handler");
  if (iip.start === undefined || iip.put === undefined || iip._resize === undefined)
    throw new Error("Missing pinned iTerm parser controls");
  let headerOpen = true;
  let headerChars = 0;
  let headerRejected = false;
  const start = iip.start.bind(iip);
  iip.start = () => {
    headerOpen = true;
    headerChars = 0;
    headerRejected = false;
    start();
  };
  const put = iip.put.bind(iip);
  iip.put = (data, first, last) => {
    if (headerRejected) return;
    if (headerOpen) {
      for (let index = first; index < last; index++) {
        if (++headerChars > 4096) {
          headerRejected = true;
          return;
        }
        if (data[index] === 58) {
          headerOpen = false;
          break;
        }
      }
    }
    put(data, first, last);
  };
  const resizeImage = iip._resize.bind(iip);
  iip._resize = (width, height) => {
    const bytes = iip._dec?.data8;
    if (bytes === undefined || inlineImageDimensions(bytes, iip._metrics?.mime ?? "") === null) {
      rejectImage("Inline image not shown: unsupported or malformed raster header.");
      return [0, 0];
    }
    return resizeImage(width, height);
  };
  const end = iip.end.bind(iip);
  const sixel = internals._handlers.get("sixel");
  if (sixel?.hook === undefined) throw new Error("Missing pinned Sixel handler");
  const hook = sixel.hook.bind(sixel);
  sixel.hook = (params) => {
    // A canonical transparent default background matches the headless decoder,
    // independent of the browser's theme. Explicit Sixel color pixels are unchanged.
    params.params[1] = 1;
    hook(params);
  };
  if (sixel.unhook === undefined) throw new Error("Missing pinned Sixel decoder");
  const unhook = sixel.unhook.bind(sixel);
  sixel.unhook = (success) => {
    if (success && (sixel._aborted || (sixel._size ?? 0) > TERMINAL_GRAPHICS_INPUT_BYTES))
      rejectImage();
    const decoder = sixel._dec;
    if (
      decoder !== undefined &&
      (decoder.width > 2048 ||
        decoder.height > 2048 ||
        decoder.width * decoder.height > TERMINAL_GRAPHICS_PIXELS)
    ) {
      decoder.release();
      rejectImage();
      return true;
    }
    return unhook(success);
  };
  iip.end = (success) => {
    if (headerRejected || (iip._header?.size ?? 0) > TERMINAL_GRAPHICS_INPUT_BYTES) {
      rejectImage();
      return true;
    }
    decodingGeneration = generation;
    encodedBytes = iip._header?.size ?? 0;
    const result = end(success);
    if ((iip._metrics?.width ?? 0) * (iip._metrics?.height ?? 0) > TERMINAL_GRAPHICS_PIXELS)
      rejectImage();
    if (result instanceof Promise)
      return result
        .catch(() => {
          rejectImage("Inline image not shown: invalid or unsupported raster data.");
          // A valid header can enclose corrupt raster bytes. Refuse its pixels but
          // preserve the protocol's admitted cell footprint, like an unavailable glyph,
          // so following PTY text and a later snapshot keep the same cursor geometry.
          if (iip._metrics !== undefined && iip._resize !== undefined) {
            const [width, height] = resizeImage(iip._metrics.width, iip._metrics.height).map(
              Math.floor,
            );
            if (
              width !== undefined &&
              height !== undefined &&
              width > 0 &&
              height > 0 &&
              width <= 2048 &&
              height <= 2048 &&
              width * height <= TERMINAL_GRAPHICS_PIXELS
            ) {
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              storage.addImage(canvas);
            }
          }
          return true;
        })
        .finally(() => {
          encodedBytes = 0;
        });
    encodedBytes = 0;
    return result;
  };
  const del = storage._delImg.bind(storage);
  storage._delImg = (id) => {
    budget.remove(id);
    del(id);
    // Evicted pixels may be on a different row than the new image's dirty range.
    if (!disposed) terminal.refresh(0, terminal.rows - 1);
  };
  storage._evictOldest = () => 0;
  const advance = storage.advanceCursor.bind(storage);
  storage.advanceCursor = (height) => {
    if (height > 0 && height <= 2048) advance(height);
  };
  const evict = (id: number): void => {
    storage._images.get(id)?.marker?.dispose();
    storage._delImg(id);
  };
  const add = storage.addImage.bind(storage);
  storage.addImage = (image) => {
    if (disposed || (encodedBytes > 0 && decodingGeneration !== generation)) {
      if (image instanceof ImageBitmap) image.close();
      return;
    }
    const footprint =
      Math.ceil(image.width / TERMINAL_GRAPHICS_CELL.width) *
      Math.ceil(image.height / TERMINAL_GRAPHICS_CELL.height);
    let charge = encodedBytes;
    if (
      footprint <= TERMINAL_GRAPHICS_CELLS &&
      charge === 0 &&
      image instanceof HTMLCanvasElement
    ) {
      const rgba = image.getContext("2d")?.getImageData(0, 0, image.width, image.height).data;
      const encoded =
        rgba === undefined
          ? undefined
          : encodeTerminalRgba(
              new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
              TERMINAL_GRAPHICS_BYTES,
            );
      charge = encoded?.bytes.length ?? 0;
    }
    if (
      footprint > TERMINAL_GRAPHICS_CELLS ||
      !budget.admit(storage._lastId + 1, image.width, image.height, charge, evict)
    ) {
      if (image instanceof ImageBitmap) image.close();
      rejectImage();
      return;
    }
    // The addon supports absent markers; browser xterm's public type does not.
    const markerTerminal = terminal as unknown as MarkerTerminal;
    const registerMarker = markerTerminal.registerMarker;
    markerTerminal.registerMarker = () => undefined;
    try {
      add(image);
    } finally {
      markerTerminal.registerMarker = registerMarker;
    }
    const spec = storage._images.get(storage._lastId);
    if (spec !== undefined) {
      const footprint =
        Math.ceil(image.width / TERMINAL_GRAPHICS_CELL.width) *
        Math.ceil(image.height / TERMINAL_GRAPHICS_CELL.height);
      Object.defineProperty(spec, "tileCount", { get: () => footprint, set: () => {} });
    }
  };
  let restoring = false;
  const reset = addon.reset.bind(addon);
  addon.reset = () => {
    generation++;
    budget.clear();
    reset();
  };
  const restore = terminal.parser.registerOscHandler(1337, async (data) => {
    if (!data.startsWith(TERMINAL_GRAPHICS_PREFIX)) return false;
    if (!restoring || data.length > TERMINAL_GRAPHICS_SNAPSHOT_BYTES) return true;
    let raw: unknown;
    try {
      raw = JSON.parse(data.slice(TERMINAL_GRAPHICS_PREFIX.length));
    } catch {
      return true;
    }
    const parsed = TerminalGraphicsSnapshotSchema.safeParse(raw);
    if (!parsed.success) return true;
    const state = parsed.data;
    const buffers = (terminal as unknown as TerminalInternals)._core.buffers;
    // Validate against THIS parsed text snapshot before allocating any decoded image.
    const placements = new Map<number, DataView>();
    for (const image of state.images) {
      const packed = decodeBase64(image.cells);
      const cells = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
      const target = image.buffer === "normal" ? buffers.normal : buffers.alt;
      for (let offset = 0; offset < cells.byteLength; offset += 6) {
        const line = target.lines.get(cells.getUint16(offset, true));
        if (line === undefined || cells.getUint16(offset + 2, true) >= line.length) return true;
      }
      placements.set(image.id, cells);
    }
    const current = generation;
    const images = new Map<number, HTMLCanvasElement>();
    try {
      for (const image of state.images) {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (context === null) return true;
        const bytes = decodeBase64(image.data);
        if (
          image.format === "rgba" ||
          image.format === "rgba-indexed" ||
          image.format === "rgba-indexed-alpha" ||
          image.format === "rgba-rle"
        ) {
          const rgba = decodeTerminalRgba(
            bytes,
            image.format,
            image.width * image.height,
            TERMINAL_GRAPHICS_PIXELS,
          );
          if (rgba === undefined) return true;
          context.putImageData(
            new ImageData(
              new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
              image.width,
              image.height,
            ),
            0,
            0,
          );
        } else {
          // Inline bytes only. No URL, file name, fetch, or data-URL navigation.
          try {
            const bitmap = await createImageBitmap(new Blob([bytes], { type: image.format }), {
              resizeWidth: image.width,
              resizeHeight: image.height,
            });
            context.drawImage(bitmap, 0, 0);
            bitmap.close();
          } catch {
            rejectImage("Inline image not shown: invalid or unsupported raster data.");
            // Corrupt raster pixels are omitted, not allowed to discard other
            // valid images or change this snapshot's already-parsed cell layout.
          }
        }
        images.set(image.id, canvas);
      }
    } catch {
      return true;
    }
    if (generation !== current) return true;
    addon.reset();
    internals._opts.sixelScrolling = state.scrolling;
    internals._opts.sixelPaletteLimit = state.paletteLimit;
    internals._handlers
      .get("sixel")
      ?._dec?._palette.set(new Uint32Array(decodeBase64(state.palette).buffer));
    const ids = new Map<number, number>();
    for (const image of state.images) {
      const canvas = images.get(image.id);
      if (canvas === undefined) continue;
      const id = ++storage._lastId;
      const size =
        (image.data.length / 4) * 3 -
        (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0);
      if (!budget.admit(id, canvas.width, canvas.height, size, evict)) continue;
      ids.set(image.id, id);
      const footprint =
        Math.ceil(canvas.width / TERMINAL_GRAPHICS_CELL.width) *
        Math.ceil(canvas.height / TERMINAL_GRAPHICS_CELL.height);
      const spec: ImageSpec = {
        orig: canvas,
        actual: canvas,
        origCellSize: TERMINAL_GRAPHICS_CELL,
        actualCellSize: { ...TERMINAL_GRAPHICS_CELL },
        bufferType: image.buffer,
        tileCount: footprint,
      };
      Object.defineProperty(spec, "tileCount", { get: () => footprint, set: () => {} });
      storage._images.set(id, spec);
    }
    for (const image of state.images) {
      const id = ids.get(image.id);
      const cells = placements.get(image.id);
      if (id === undefined || cells === undefined) continue;
      const buffer = image.buffer === "normal" ? buffers.normal : buffers.alt;
      for (let offset = 0; offset < cells.byteLength; offset += 6) {
        const line = buffer.lines.get(cells.getUint16(offset, true));
        if (line !== undefined)
          storage._writeToCell(
            line,
            cells.getUint16(offset + 2, true),
            id,
            cells.getUint16(offset + 4, true),
          );
      }
    }
    terminal.refresh(0, terminal.rows - 1);
    return true;
  });
  return {
    writeSnapshot: (data, callback) => {
      // Invalidate async image work immediately, then reset behind queued writes.
      // Public xterm.reset() leaves its parser queue/state intact: CAN first
      // cancels an unfinished old control so it cannot consume the new snapshot.
      generation++;
      terminal.write("\x18", () => {
        terminal.reset();
        addon.reset();
        restoring = true;
      });
      terminal.write(data, () => {
        restoring = false;
        callback?.();
      });
    },
    dispose: () => {
      disposed = true;
      generation++;
      ready.dispose();
      geometry.dispose();
      palettePolicy.dispose();
      restore.dispose();
      budget.clear();
    },
  };
}
