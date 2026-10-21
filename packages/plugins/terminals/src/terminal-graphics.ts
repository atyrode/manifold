import { ImageAddon } from "@xterm/addon-image";
import type { Terminal, IMarker } from "@xterm/xterm";
import {
  LEGACY_TERMINAL_GRAPHICS_POLICY,
  TERMINAL_GRAPHICS_AXIS,
  TERMINAL_GRAPHICS_CELL,
  TERMINAL_GRAPHICS_FILE_BYTES,
  TERMINAL_GRAPHICS_FILE_HEADER,
  TERMINAL_GRAPHICS_PIXELS,
  TERMINAL_GRAPHICS_POLICY,
  TERMINAL_GRAPHICS_PREFIX,
  TERMINAL_GRAPHICS_SIXEL_BYTES,
  TERMINAL_GRAPHICS_SNAPSHOT_BYTES,
  TerminalGraphicsSnapshotSchema,
  TerminalImageBudget,
  TerminalSixelGate,
  inlineImageDimensions,
  encodeTerminalRgba,
  decodeTerminalRgba,
  terminalGraphicsFootprint,
  type ServerMessageBody,
  type TerminalGraphicsRefusal,
} from "@manifold/protocol";

/** Decoded Sixels at least this large upload in their own task, so bursts stay interleaved. */
const YIELD_PIXELS = 65_536;
const MALFORMED_HEADER = "Inline image not shown: unsupported or malformed raster header.";
const MALFORMED_DATA = "Inline image not shown: invalid or unsupported raster data.";
const SIXEL_DECODE = `Inline image not shown: Sixel data is malformed or exceeds the ${TERMINAL_GRAPHICS_PIXELS.toLocaleString("en-US")}-pixel decode limit.`;

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
  _extendedAttrs: Record<number, { imageId?: number; tileId?: number } | undefined>;
  getBg(x: number): number;
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
  viewportResize(metrics: { cols: number; rows: number }): void;
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

/** Larger than any image's canonical tile count (293 × 147 at the 2,048-pixel side limit). */
const TILE_KEY_SPAN = 65_536;

/** Every image tile the buffer places, keyed `imageId * TILE_KEY_SPAN + tileId`. */
function placedImageTiles(buffer: ImageBuffer, cols: number): Set<number> {
  const placed = new Set<number>();
  for (let y = 0; y < buffer.lines.length; y++) {
    const line = buffer.lines.get(y);
    if (line === undefined) continue;
    for (let x = 0; x < cols; x++) {
      if (!(line.getBg(x) & 0x10000000)) continue;
      const cell = line._extendedAttrs[x];
      if (cell?.imageId !== undefined && cell.tileId !== undefined && cell.tileId >= 0)
        placed.add(cell.imageId * TILE_KEY_SPAN + cell.tileId);
    }
  }
  return placed;
}

function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(data);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/** Names the limiting resource with its observed and allowed quantities. */
function refusalMessage(refusal: TerminalGraphicsRefusal): string {
  const count = (value: number): string => value.toLocaleString("en-US");
  const size =
    refusal.width === undefined || refusal.height === undefined
      ? "it"
      : `${String(refusal.width)}×${String(refusal.height)}`;
  switch (refusal.resource) {
    case "sixel-input":
      return `Inline image not shown: Sixel data exceeds the ${count(refusal.allowed)}-byte input limit.`;
    case "file-input":
      return `Inline image not shown: the ${count(refusal.observed ?? refusal.allowed)}-byte iTerm image exceeds the ${count(refusal.allowed)}-byte input limit.`;
    case "file-header":
      return `Inline image not shown: its iTerm header exceeds ${count(refusal.allowed)} characters.`;
    case "axis":
      return `Inline image not shown: ${size} exceeds the ${count(refusal.allowed)}-pixel side limit.`;
    case "pixels":
      return `Inline image not shown: ${size} (${count(refusal.observed ?? 0)} pixels) exceeds the ${count(refusal.allowed)}-pixel limit.`;
    case "retained":
      return refusal.observed === undefined
        ? `Inline image not shown: ${size} needs more than the ${count(refusal.allowed)}-byte terminal image cache.`
        : `Inline image not shown: ${size} needs ${count(refusal.observed)} bytes of the ${count(refusal.allowed)}-byte terminal image cache.`;
    case "cells":
      return `Inline image not shown: ${size} covers ${count(refusal.observed ?? 0)} cells; this terminal host retains ${count(refusal.allowed)}. Upgrade the terminal host for larger images.`;
    default: {
      const unreachable: never = refusal.resource;
      return unreachable;
    }
  }
}

export interface TerminalGraphics {
  writeSnapshot(
    data: Uint8Array,
    geometry: Extract<ServerMessageBody, { type: "terminal_snapshot" }>["geometry"],
    callback?: () => void,
  ): void;
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
    sixelSizeLimit: TERMINAL_GRAPHICS_SIXEL_BYTES,
    iipSizeLimit: TERMINAL_GRAPHICS_FILE_BYTES,
  });
  terminal.loadAddon(addon);
  const internals = addon as unknown as AddonInternals;
  let disposed = false;
  // A redrawing program resends its image on every frame. One refused resource is reported
  // once per terminal view, so a refusal never restarts or recurs with each repaint.
  const noticed = new Set<string>();
  const notify = (key: string, message: string): void => {
    if (disposed || noticed.has(key)) return;
    noticed.add(key);
    onImageRejected?.(message);
  };
  const notifyRefusal = (refusal: TerminalGraphicsRefusal): void => {
    notify(refusal.resource, refusalMessage(refusal));
  };
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
  // The producing host's snapshot selects its rules; this stream follows them until replaced.
  const budget = new TerminalImageBudget();
  const sixelGate = new TerminalSixelGate(budget);
  /** Snapshot charge of the image the next addImage call stores, bound to its parser generation. */
  let pending: { charge: number; generation: number } | undefined;
  let generation = 0;
  const del = storage._delImg.bind(storage);
  storage._delImg = (id) => {
    budget.remove(id);
    del(id);
    // Evicted pixels may be on a different row than the new image's dirty range.
    if (!disposed) terminal.refresh(0, terminal.rows - 1);
  };
  storage._evictOldest = () => 0;
  const evict = (id: number): void => {
    storage._images.get(id)?.marker?.dispose();
    storage._delImg(id);
  };
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
        if (++headerChars > TERMINAL_GRAPHICS_FILE_HEADER) {
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
      notify(MALFORMED_HEADER, MALFORMED_HEADER);
      return [0, 0];
    }
    const [outputWidth = 0, outputHeight = 0] = resizeImage(width, height).map(Math.floor);
    // The pinned fit can produce an empty sub-pixel result; no admission limit was exceeded.
    if (!(outputWidth >= 1 && outputHeight >= 1)) return [0, 0];
    // Header dimensions and file bytes decide admission before createImageBitmap decodes.
    const refusal = budget.refuse(outputWidth, outputHeight, bytes.length);
    if (refusal !== undefined) {
      notifyRefusal(refusal);
      return [0, 0];
    }
    pending = { charge: bytes.length, generation };
    return [outputWidth, outputHeight];
  };
  const end = iip.end.bind(iip);
  const sixel = internals._handlers.get("sixel");
  if (sixel?.hook === undefined || sixel.put === undefined || sixel.unhook === undefined)
    throw new Error("Missing pinned Sixel handler");
  const hook = sixel.hook.bind(sixel);
  sixel.hook = (params) => {
    sixelGate.start();
    // A canonical transparent default background matches the headless decoder,
    // independent of the browser's theme. Explicit Sixel color pixels are unchanged.
    params.params[1] = 1;
    hook(params);
  };
  const sixelPut = sixel.put.bind(sixel);
  sixel.put = (data, first, last) => {
    const accepted = sixelGate.put(data, first, last);
    // The same payload count as the mirror, so evictions agree at every seq boundary.
    budget.reserve(sixelGate.bytes, evict);
    if (accepted) {
      sixelPut(data, first, last);
      return;
    }
    if (sixel._aborted) return;
    // Raster metadata or the input bound refused it before any canvas exists.
    sixel._aborted = true;
    sixel._dec?.release();
    if (sixelGate.refusal !== undefined) notifyRefusal(sixelGate.refusal);
  };
  const unhook = sixel.unhook.bind(sixel);
  sixel.unhook = (success) => {
    const decoder = sixel._dec;
    if (!success || decoder === undefined) return unhook(success);
    if (sixel._aborted) {
      if (sixelGate.refusal === undefined) notify(SIXEL_DECODE, SIXEL_DECODE);
      return unhook(success);
    }
    const { width, height } = decoder;
    if (!width || !height) return unhook(success);
    // Level-1 Sixels learn their extent only while decoding; still refuse before upload.
    const early = budget.refuse(width, height, 1);
    if (early !== undefined) {
      decoder.release();
      notifyRefusal(early);
      return true;
    }
    const current = generation;
    const admit = (): boolean | Promise<boolean> => {
      if (disposed || current !== generation) {
        decoder.release();
        return true;
      }
      // Charge from the decoder's own pixels: no canvas upload or readback precedes refusal.
      const rgba = decoder.data8;
      const encoded =
        rgba === undefined
          ? undefined
          : encodeTerminalRgba(
              new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
              budget.encodedLimit(width, height),
            );
      const refusal = budget.refuse(width, height, encoded?.bytes.length);
      if (refusal !== undefined || encoded === undefined) {
        decoder.release();
        if (refusal !== undefined) notifyRefusal(refusal);
        return true;
      }
      pending = { charge: encoded.bytes.length, generation: current };
      try {
        return unhook(success);
      } finally {
        pending = undefined;
      }
    };
    if (width * height < YIELD_PIXELS) return admit();
    const { promise, resolve, reject } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      try {
        resolve(admit());
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  };
  iip.end = (success) => {
    if (headerRejected) {
      notifyRefusal({
        resource: "file-header",
        observed: undefined,
        allowed: TERMINAL_GRAPHICS_FILE_HEADER,
      });
      return true;
    }
    const declared = iip._header?.size ?? 0;
    if (declared > TERMINAL_GRAPHICS_FILE_BYTES) {
      notifyRefusal({
        resource: "file-input",
        observed: declared,
        allowed: TERMINAL_GRAPHICS_FILE_BYTES,
      });
      return true;
    }
    pending = undefined;
    const result = end(success);
    const metrics = iip._metrics;
    if (metrics !== undefined && metrics.width * metrics.height > TERMINAL_GRAPHICS_PIXELS) {
      notifyRefusal({
        resource: "pixels",
        observed: metrics.width * metrics.height,
        allowed: TERMINAL_GRAPHICS_PIXELS,
        width: metrics.width,
        height: metrics.height,
      });
    }
    if (!(result instanceof Promise)) {
      pending = undefined;
      return result;
    }
    return result
      .catch(() => {
        notify(MALFORMED_DATA, MALFORMED_DATA);
        // A valid header can enclose corrupt raster bytes. Refuse its pixels but
        // preserve the protocol's admitted cell footprint, like an unavailable glyph,
        // so following PTY text and a later snapshot keep the same cursor geometry.
        if (iip._metrics !== undefined && pending !== undefined) {
          const [width, height] = resizeImage(iip._metrics.width, iip._metrics.height).map(
            Math.floor,
          );
          if (
            width !== undefined &&
            height !== undefined &&
            budget.refuse(width, height, pending.charge) === undefined
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
        pending = undefined;
      });
  };
  const advance = storage.advanceCursor.bind(storage);
  storage.advanceCursor = (height) => {
    if (height > 0 && height <= TERMINAL_GRAPHICS_AXIS) advance(height);
  };
  // Same rule as the host mirror: growing must not extend a row with tiles that a split
  // wrapped continuation still places, and a row's expansion stops at its first placed
  // tile. A version-1 host never applied the rule, so this viewer follows its old addon.
  const viewportResize = storage.viewportResize.bind(storage);
  storage.viewportResize = (metrics) => {
    if (budget.policy.version === 1) {
      viewportResize(metrics);
      return;
    }
    const write = storage._writeToCell;
    let placed: Set<number> | undefined;
    const stopped = new Set<ImageLine>();
    storage._writeToCell = (line, col, id, tile) => {
      if (placed === undefined) {
        const { buffers } = (terminal as unknown as TerminalInternals)._core;
        placed = placedImageTiles(
          terminal.buffer.active.type === "normal" ? buffers.normal : buffers.alt,
          terminal.cols,
        );
      }
      const key = id * TILE_KEY_SPAN + tile;
      if (stopped.has(line) || placed.has(key)) {
        stopped.add(line);
        return;
      }
      placed.add(key);
      write.call(storage, line, col, id, tile);
    };
    try {
      viewportResize(metrics);
    } finally {
      storage._writeToCell = write;
    }
  };
  const add = storage.addImage.bind(storage);
  storage.addImage = (image) => {
    const charge = pending;
    pending = undefined;
    if (disposed || charge === undefined || charge.generation !== generation) {
      if (image instanceof ImageBitmap) image.close();
      return;
    }
    if (!budget.admit(storage._lastId + 1, image.width, image.height, charge.charge, evict)) {
      if (image instanceof ImageBitmap) image.close();
      const refusal = budget.refuse(image.width, image.height, charge.charge);
      if (refusal !== undefined) notifyRefusal(refusal);
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
      const footprint = terminalGraphicsFootprint(image.width, image.height);
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
    // A retained terminal host keeps its own admission rules: live output that follows
    // this snapshot must be admitted exactly as the producing mirror admits it.
    if (typeof raw === "object" && raw !== null && "version" in raw) {
      if (raw.version === 1) budget.clear(LEGACY_TERMINAL_GRAPHICS_POLICY);
      else if (raw.version === 2) budget.clear(TERMINAL_GRAPHICS_POLICY);
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
            notify(MALFORMED_DATA, MALFORMED_DATA);
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
      const footprint = terminalGraphicsFootprint(canvas.width, canvas.height);
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
    writeSnapshot: (data, geometry, callback) => {
      // Invalidate async image work immediately, then reset behind queued writes.
      // Public xterm.reset() leaves its parser queue/state intact: CAN first
      // cancels an unfinished old control so it cannot consume the new snapshot.
      generation++;
      terminal.write("\x18", () => {
        if (disposed) return;
        terminal.reset();
        addon.reset();
        terminal.resize(geometry.cols, geometry.rows);
        restoring = true;
        // Submit replay only once CAN has parsed: the delivery owns one parser operation.
        terminal.write(data, () => {
          if (disposed) return;
          restoring = false;
          callback?.();
        });
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
