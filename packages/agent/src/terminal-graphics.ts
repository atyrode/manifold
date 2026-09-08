import { ImageAddon } from "@xterm/addon-image";
import type { Terminal } from "@xterm/headless";
import {
  TERMINAL_GRAPHICS_BYTES,
  TERMINAL_GRAPHICS_INPUT_BYTES,
  TERMINAL_GRAPHICS_CELLS,
  TERMINAL_GRAPHICS_CELL,
  TERMINAL_GRAPHICS_PIXELS,
  TERMINAL_GRAPHICS_PREFIX,
  TERMINAL_GRAPHICS_SNAPSHOT_BYTES,
  TerminalImageBudget,
  inlineImageDimensions,
  encodeTerminalRgba,
  type TerminalGraphicsSnapshot,
} from "@manifold/protocol";

/** No DOM, native decoder, file, URL, or browser process exists in the terminal host. */
class MemoryImage {
  width = 0;
  height = 0;
  format: TerminalGraphicsSnapshot["images"][number]["format"] = "rgba";
  bytes: Uint8Array = new Uint8Array(0);
  getContext() {
    return {
      putImageData: (image: { data: Uint8ClampedArray }) => {
        this.bytes = new Uint8Array(image.data);
      },
    };
  }
}

interface ImageSpec {
  orig: MemoryImage;
  actual: MemoryImage;
  origCellSize: { width: number; height: number };
  actualCellSize: { width: number; height: number };
  bufferType: "normal" | "alternate";
  tileCount: number;
  marker?: { dispose(): void };
}
interface ImageLine {
  _extendedAttrs: Record<number, { imageId?: number; tileId?: number }>;
  getBg(x: number): number;
}
interface ImageBuffer {
  lines: { length: number; get(y: number): ImageLine | undefined };
}
interface ImageStorage {
  _images: Map<number, ImageSpec>;
  _lastId: number;
  addImage(image: MemoryImage): void;
  advanceCursor(height: number): void;
  _delImg(id: number): void;
  _evictOldest(room: number): number;
}
interface AddonInternals {
  _storage: ImageStorage;
  _renderer: object;
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
      _metrics?: { mime: string };
      _resize?: (width: number, height: number) => [number, number];
      start?: () => void;
      put?: (data: Uint32Array, start: number, end: number) => void;
      end?: (success: boolean) => boolean | Promise<boolean>;
      unhook?: (success: boolean) => boolean | Promise<boolean>;
      hook?: (params: { params: Int32Array }) => void;
    }
  >;
}
interface MirrorInternals {
  _core: {
    buffers: { normal: ImageBuffer; alt: ImageBuffer };
    _coreBrowserService?: object;
  };
  onRender?: (callback: () => void) => { dispose(): void };
}
interface AsyncOscParser {
  registerOscHandler(
    id: number,
    handler: (data: string) => boolean | Promise<boolean>,
  ): { dispose(): void };
}

let platformInstalled = false;
function installMemoryPlatform(): void {
  if (platformInstalled) return;
  // The pinned addon asks only for these canvas primitives in a headless host. The
  // bitmap path retains verified inline bytes symbolically; the browser decodes them.
  const document = {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error("Unexpected image addon DOM request");
      return new MemoryImage();
    },
  };
  const createImageBitmap = async (
    blob: Blob,
    options?: { resizeWidth?: number; resizeHeight?: number },
  ) => {
    if (
      !(blob instanceof Blob) ||
      blob.size > TERMINAL_GRAPHICS_INPUT_BYTES ||
      !["image/png", "image/jpeg", "image/gif"].includes(blob.type)
    ) {
      throw new Error("Invalid inline image bitmap");
    }
    const image = new MemoryImage();
    image.width = options?.resizeWidth ?? 0;
    image.height = options?.resizeHeight ?? 0;
    image.format = blob.type as MemoryImage["format"];
    image.bytes = new Uint8Array(await blob.arrayBuffer());
    return image;
  };
  Object.assign(globalThis, {
    document,
    window: { document, createImageBitmap },
    createImageBitmap,
    ImageData: class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    },
  });
  platformInstalled = true;
}

/** The only authoritative graphics state; its cell attributes follow xterm's own edits/reflow. */
export class TerminalGraphicsMirror {
  private readonly addon: ImageAddon;
  private readonly internals: AddonInternals;
  private readonly budget = new TerminalImageBudget();
  private readonly handlers: { dispose(): void }[] = [];
  private disposed = false;
  private pendingSixel:
    { palette: Uint32Array; paletteLimit: number; scrolling: boolean } | undefined;

  constructor(
    private readonly terminal: Terminal,
    report: (data: string) => void,
  ) {
    installMemoryPlatform();
    const mirror = terminal as unknown as MirrorInternals;
    mirror.onRender = () => ({ dispose() {} });
    this.addon = new ImageAddon({
      enableSizeReports: false,
      pixelLimit: TERMINAL_GRAPHICS_PIXELS + 1,
      storageLimit: 0.5,
      showPlaceholder: false,
      sixelSizeLimit: TERMINAL_GRAPHICS_INPUT_BYTES,
      iipSizeLimit: TERMINAL_GRAPHICS_INPUT_BYTES,
    });
    terminal.loadAddon(this.addon as unknown as Parameters<Terminal["loadAddon"]>[0]);
    this.internals = this.addon as unknown as AddonInternals;
    const { _storage: storage, _renderer: renderer } = this.internals;
    if (
      !(storage?._images instanceof Map) ||
      typeof storage._delImg !== "function" ||
      renderer === undefined
    ) {
      throw new Error("Unsupported @xterm/addon-image private API (expected 0.9.0)");
    }
    Object.defineProperty(renderer, "dimensions", {
      get: () => ({
        css: {
          cell: TERMINAL_GRAPHICS_CELL,
          canvas: {
            width: terminal.cols * TERMINAL_GRAPHICS_CELL.width,
            height: terminal.rows * TERMINAL_GRAPHICS_CELL.height,
          },
        },
      }),
    });
    // ImageAddon's WASM decoder initializes asynchronously. Block the parser ahead
    // of the first PTY write so an immediate image or snapshot cannot race startup.
    // xterm 6's headless typings omit async OSC handlers supported by its parser.
    const asyncParser = terminal.parser as unknown as AsyncOscParser;
    const ready = asyncParser.registerOscHandler(777, async (data) => {
      if (data !== "ManifoldGraphicsReady") return false;
      for (let attempt = 0; attempt < 1000; attempt++) {
        if (this.disposed) return true;
        if (this.internals._handlers.get("sixel")?._dec !== undefined) return true;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 1);
        await promise;
      }
      if (this.disposed) return true;
      throw new Error("Terminal graphics decoder initialization timed out");
    });
    this.handlers.push(ready);
    terminal.write("\x1b]777;ManifoldGraphicsReady\x07", () => ready.dispose());
    this.internals._report = report;
    const iip = this.internals._handlers.get("iip");
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
      if (bytes === undefined || inlineImageDimensions(bytes, iip._metrics?.mime ?? "") === null)
        return [0, 0];
      return resizeImage(width, height);
    };
    const end = iip.end.bind(iip);
    iip.end = (success) => {
      if (headerRejected) return true;
      const result = end(success);
      if (result instanceof Promise) return result.catch(() => true);
      return result;
    };
    const sixel = this.internals._handlers.get("sixel");
    if (sixel?.unhook === undefined || sixel.hook === undefined)
      throw new Error("Missing pinned Sixel decoder");
    const unhook = sixel.unhook.bind(sixel);
    const hook = sixel.hook.bind(sixel);
    sixel.hook = (params) => {
      const palette = sixel._dec?._palette;
      this.pendingSixel =
        palette === undefined
          ? undefined
          : {
              palette: new Uint32Array(palette.subarray(0, 256)),
              paletteLimit: this.internals._opts.sixelPaletteLimit,
              scrolling: this.internals._opts.sixelScrolling,
            };
      hook(params);
    };
    sixel.unhook = (success) => {
      this.pendingSixel = undefined;
      const decoder = sixel._dec;
      if (
        decoder !== undefined &&
        (decoder.width > 2048 ||
          decoder.height > 2048 ||
          decoder.width * decoder.height > TERMINAL_GRAPHICS_PIXELS)
      ) {
        // Sparse Sixel bands can be small while their rectangular RGBA expansion
        // is enormous. Check BEFORE upstream unhook reads decoder.data8.
        decoder.release();
        return true;
      }
      return unhook(success);
    };
    const del = storage._delImg.bind(storage);
    storage._delImg = (id) => {
      this.budget.remove(id);
      del(id);
    };
    storage._evictOldest = () => 0;
    const advance = storage.advanceCursor.bind(storage);
    storage.advanceCursor = (height) => {
      if (height > 0 && height <= 2048) advance(height);
    };
    const add = storage.addImage.bind(storage);
    storage.addImage = (image) => {
      if (
        Math.ceil(image.width / TERMINAL_GRAPHICS_CELL.width) *
          Math.ceil(image.height / TERMINAL_GRAPHICS_CELL.height) >
        TERMINAL_GRAPHICS_CELLS
      )
        return;
      if (image.format === "rgba") {
        const encoded = encodeTerminalRgba(image.bytes, TERMINAL_GRAPHICS_BYTES);
        if (encoded === undefined) return;
        image.format = encoded.format;
        image.bytes = encoded.bytes;
      }
      if (
        !this.budget.admit(
          storage._lastId + 1,
          image.width,
          image.height,
          image.bytes.length,
          (id) => {
            storage._images.get(id)?.marker?.dispose();
            storage._delImg(id);
          },
        )
      )
        return;
      // Cache lifetime cannot depend on a viewer's truncated scrollback. Cell edits
      // still erase/scroll the image; backing data has one bounded FIFO on all peers.
      const registerMarker = terminal.registerMarker;
      terminal.registerMarker = () => undefined;
      try {
        add(image);
      } finally {
        terminal.registerMarker = registerMarker;
      }
      const spec = storage._images.get(storage._lastId);
      if (spec !== undefined) {
        const footprint =
          Math.ceil(image.width / TERMINAL_GRAPHICS_CELL.width) *
          Math.ceil(image.height / TERMINAL_GRAPHICS_CELL.height);
        // Cell edits still remove placements, but cannot evict backing data based
        // on which historical rows this particular viewer happened to receive.
        Object.defineProperty(spec, "tileCount", { get: () => footprint, set: () => {} });
      }
    };
    const reset = this.addon.reset.bind(this.addon);
    this.addon.reset = () => {
      this.pendingSixel = undefined;
      this.budget.clear();
      reset();
    };
    // Geometry is terminal-owned, not whichever viewer answered first. This also
    // makes OMP's XTSMGRAPHICS probe work before a browser has attached.
    terminal.options.windowOptions = {
      getWinSizePixels: true,
      getCellSizePixels: true,
      getWinSizeChars: true,
    };
    this.handlers.push(
      terminal.parser.registerCsiHandler({ final: "t" }, (params) => {
        if (params[0] === 14) report(`\x1b[4;${terminal.rows * 14};${terminal.cols * 7}t`);
        else if (params[0] === 16) report("\x1b[6;14;7t");
        else if (params[0] === 18) report(`\x1b[8;${terminal.rows};${terminal.cols}t`);
        else return false;
        return true;
      }),
    );
    this.handlers.push(
      terminal.parser.registerCsiHandler({ prefix: "?", final: "S" }, (params) => {
        if (params[0] !== 1) return false;
        if (params[1] === 4) {
          report("\x1b[?1;0;256S");
          return true;
        }
        if (
          params[1] === 3 &&
          (typeof params[2] !== "number" || params[2] < 1 || params[2] > 256)
        ) {
          report("\x1b[?1;2S");
          return true;
        }
        return false;
      }),
    );
    // A PTY may emit arbitrary OSC bytes, but cannot install privileged snapshot
    // state in the mirror. The browser restoration handler validates the same grammar.
    this.handlers.push(
      terminal.parser.registerOscHandler(1337, (data) => data.startsWith(TERMINAL_GRAPHICS_PREFIX)),
    );
  }

  serialize(scrollback: number, includeCells = true, replayPendingSixel = true): string {
    const { _storage: storage } = this.internals;
    const pending = replayPendingSixel ? this.pendingSixel : undefined;
    const palette =
      pending?.palette ??
      this.internals._handlers.get("sixel")?._dec?._palette ??
      new Uint32Array(256);
    const buffers = (this.terminal as unknown as MirrorInternals)._core.buffers;
    const state: TerminalGraphicsSnapshot = {
      version: 1,
      scrolling: pending?.scrolling ?? this.internals._opts.sixelScrolling,
      palette: Buffer.from(palette.buffer, palette.byteOffset, 1024).toString("base64"),
      paletteLimit: pending?.paletteLimit ?? this.internals._opts.sixelPaletteLimit,
      images: [],
    };
    const ids = new Map<number, number>();
    const placements: number[][] = [];
    for (const [originalId, spec] of storage._images) {
      const id = ids.size;
      ids.set(originalId, id);
      placements.push([]);
      state.images.push({
        id,
        width: spec.orig.width,
        height: spec.orig.height,
        format: spec.orig.format,
        data: Buffer.from(spec.orig.bytes).toString("base64"),
        buffer: spec.bufferType,
        cells: "",
      });
    }
    for (const name of includeCells ? (["normal", "alternate"] as const) : []) {
      const buffer = name === "normal" ? buffers.normal : buffers.alt;
      const start =
        name === "normal" ? Math.max(0, buffer.lines.length - this.terminal.rows - scrollback) : 0;
      for (let y = start; y < buffer.lines.length; y++) {
        const line = buffer.lines.get(y);
        if (line === undefined) continue;
        for (let x = 0; x < this.terminal.cols; x++) {
          if (!(line.getBg(x) & 0x10000000)) continue;
          const cell = line._extendedAttrs[x];
          if (cell?.imageId === undefined || cell.tileId === undefined || cell.tileId < 0) continue;
          const id = ids.get(cell.imageId);
          if (id === undefined) continue;
          placements[id]?.push(y - start, x, cell.tileId);
        }
      }
    }
    for (const image of state.images) {
      const cells = placements[image.id] ?? [];
      const packed = Buffer.alloc(cells.length * 2);
      cells.forEach((value, index) => packed.writeUInt16LE(value, index * 2));
      image.cells = packed.toString("base64");
    }
    const data = `${TERMINAL_GRAPHICS_PREFIX}${JSON.stringify(state)}`;
    if (Buffer.byteLength(data) + 8 > TERMINAL_GRAPHICS_SNAPSHOT_BYTES)
      throw new Error("Terminal graphics exceeded its reserved snapshot budget");
    return `\x1b]1337;${data}\x07`;
  }

  dispose(): void {
    this.disposed = true;
    for (const handler of this.handlers) handler.dispose();
    this.budget.clear();
  }
}
