import { afterEach, expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import {
  TerminalGraphicsSnapshotSchema,
  TERMINAL_GRAPHICS_ENVELOPE_BYTES,
  TERMINAL_GRAPHICS_POLICY,
  TERMINAL_GRAPHICS_PREFIX,
  TERMINAL_GRAPHICS_SNAPSHOT_BYTES,
  decodeTerminalRgba,
  encodeTerminalRgba,
  inlineImageDimensions,
  TERMINAL_GRAPHICS_PIXELS,
  type TerminalGraphicsSnapshot,
} from "@manifold/protocol";
import { TerminalGraphicsMirror } from "../src/terminal-graphics.ts";
import { TerminalParserContinuation } from "../src/terminal-parser-continuation.ts";
import { MAX_SNAPSHOT_BASE64_CHARS, PtyTerminal } from "../src/terminal.ts";

const RED = '\x1bPq"1;1;7;14#1;2;100;0;0#1!7~-!7~-!7B\x1b\\';
/** A solid Sixel whose raster attributes declare its exact extent. */
function solid(width: number, height: number): string {
  const bands = Array.from(
    { length: Math.ceil(height / 6) },
    (_, band) =>
      `!${String(width)}${String.fromCharCode(63 + ((1 << Math.min(6, height - band * 6)) - 1))}`,
  ).join("-");
  return `\x1bPq"1;1;${String(width)};${String(height)}#1;2;100;0;0#1${bands}\x1b\\`;
}
/** Deterministic four-color noise: a content-rich image whose lossless encoding stays large. */
function noise(width: number, height: number, seed: number): string {
  let state = seed;
  const colors = Array.from({ length: width * height }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 30;
  });
  let body = "";
  for (let band = 0; band * 6 < height; band++) {
    for (let color = 0; color < 4; color++) {
      body += `#${String(color)}`;
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let row = 0; row < 6 && band * 6 + row < height; row++)
          if (colors[(band * 6 + row) * width + x] === color) bits |= 1 << row;
        body += String.fromCharCode(63 + bits);
      }
      body += "$";
    }
    body += "-";
  }
  const palette = "#0;2;90;10;10#1;2;10;90;10#2;2;10;10;90#3;2;90;90;10";
  return `\x1bPq"1;1;${String(width)};${String(height)}${palette}${body}\x1b\\`;
}
/** Literal 8-pixel stripes: a Sixel input beyond the ordinary control share that encodes small. */
function stripes(width: number, height: number, layers: number): string {
  let body = "";
  for (let band = 0; band * 6 < height; band++) {
    for (let layer = 0; layer < layers; layer++) {
      body += `#${String(layer)}`;
      for (let x = 0; x < width; x++) body += (x >> 3) % layers === layer ? "~" : "?";
      body += "$";
    }
    body += "-";
  }
  const palette = Array.from(
    { length: layers },
    (_, layer) => `#${String(layer)};2;${String((layer * 37) % 100)};50;50`,
  ).join("");
  return `\x1bPq"1;1;${String(width)};${String(height)}${palette}${body}\x1b\\`;
}
const resources: { dispose(): void }[] = [];
afterEach(() => {
  for (const resource of resources.splice(0).reverse()) resource.dispose();
});

function mirror(cols = 20, rows = 5) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  const replies: string[] = [];
  const graphics = new TerminalGraphicsMirror(terminal, (reply) => replies.push(reply));
  resources.push(terminal, graphics);
  return { terminal, graphics, replies };
}
function write(terminal: Terminal, data: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(data, resolve);
  return promise;
}
/** Feeds bytes through the real PTY terminal's output ingress, as its child process would. */
function ingest(terminal: PtyTerminal, data: string): void {
  const target: unknown = terminal;
  if (
    typeof target !== "object" ||
    target === null ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  ) {
    throw new Error("Missing PTY output ingress");
  }
  target.ingest.call(target, Buffer.from(data, "latin1"));
}
function idlePty(terminalId: string, cols: number, rows: number): PtyTerminal {
  return new PtyTerminal({
    terminalId,
    cols,
    rows,
    command: [Bun.which("bash") ?? "/bin/sh", "-c", "read -r line"],
    onOutput: () => {},
  });
}
type ImageRun = ["normal" | "alternate", number, number, number, number, number];
type ObservedGraphics = TerminalGraphicsSnapshot & {
  wire: TerminalGraphicsSnapshot;
  runs: ImageRun[];
};
function decode(serialized: string): ObservedGraphics {
  const start = serialized.indexOf(TERMINAL_GRAPHICS_PREFIX) + TERMINAL_GRAPHICS_PREFIX.length;
  const wire = TerminalGraphicsSnapshotSchema.parse(
    JSON.parse(serialized.slice(start, serialized.indexOf("\x07", start))),
  );
  const cells: ImageRun[] = [];
  for (const image of wire.images) {
    const packed = Buffer.from(image.cells, "base64");
    for (let offset = 0; offset < packed.length; offset += 6)
      cells.push([
        image.buffer,
        packed.readUInt16LE(offset),
        packed.readUInt16LE(offset + 2),
        image.id,
        packed.readUInt16LE(offset + 4),
        1,
      ]);
  }
  cells.sort(
    (left, right) => left[0].localeCompare(right[0]) || left[1] - right[1] || left[2] - right[2],
  );
  const runs: ImageRun[] = [];
  for (const cell of cells) {
    const last = runs.at(-1);
    if (
      last !== undefined &&
      last[0] === cell[0] &&
      last[1] === cell[1] &&
      last[2] + last[5] === cell[2] &&
      last[3] === cell[3] &&
      last[4] + last[5] === cell[4]
    )
      last[5]++;
    else runs.push(cell);
  }
  return { ...wire, wire, runs };
}
function imagePixels(image: TerminalGraphicsSnapshot["images"][number]) {
  if (image.format === "image/png" || image.format === "image/jpeg" || image.format === "image/gif")
    throw new Error("Raster fixture requires its real decoder");
  const decoded = decodeTerminalRgba(
    Buffer.from(image.data, "base64"),
    image.format,
    image.width * image.height,
    TERMINAL_GRAPHICS_PIXELS,
  );
  if (decoded === undefined) throw new Error("Invalid RGBA fixture");
  return Buffer.from(decoded);
}

test("Sixel is negotiated without a viewer and an immediate image survives the first snapshot", async () => {
  const { terminal, graphics, replies } = mirror();
  await write(terminal, "\x1b[?2;1;0S\x1b[16t" + RED + "\r\nAFTER");
  expect(replies).toEqual(["\x1b[?2;0;140;70S", "\x1b[6;14;7t"]);
  const state = decode(graphics.serialize(0));
  expect(state.runs).toEqual([["normal", 0, 0, 0, 0, 1]]);
  expect(imagePixels(state.images[0]!).subarray(0, 4)).toEqual(Buffer.from([255, 0, 0, 255]));
  expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("AFTER");
});

test("text erasure removes graphic cells, scrolling moves them, and reset releases cached data", async () => {
  const { terminal, graphics } = mirror();
  await write(terminal, RED + "\x1b[3;4H" + RED + "\x1b[1;1H\x1b[2K");
  expect(decode(graphics.serialize(0)).runs.map((run) => run.slice(0, 3))).toEqual([
    ["normal", 2, 3],
  ]);
  await write(terminal, "\x1b[5;1H\n\n");
  expect(decode(graphics.serialize(0)).runs.map((run) => run.slice(0, 3))).toEqual([
    ["normal", 0, 3],
  ]);
  terminal.resize(30, 5);
  expect(decode(graphics.serialize(0)).runs.map((run) => run.slice(0, 3))).toEqual([
    ["normal", 0, 3],
  ]);
  await write(terminal, "\x1bc");
  const reset = decode(graphics.serialize(0));
  expect(reset.images).toEqual([]);
  expect(reset.runs).toEqual([]);
});

test("bounded graphics eviction removes the oldest still-visible image rather than only losing it on reconnect", async () => {
  const { terminal, graphics } = mirror(80, 4);
  for (let col = 1; col <= 65; col++) await write(terminal, `\x1b[1;${col}H${RED}`);
  const state = decode(graphics.serialize(0));
  expect(state.runs.some((run) => run[1] === 0 && run[2] === 0)).toBe(false);
  expect(state.runs.some((run) => run[1] === 0 && run[2] === 64)).toBe(true);
});

test("images past the former 2,048-cell cliff are retained with every placement", async () => {
  const { terminal, graphics } = mirror(130, 40);
  for (const [width, height] of [
    [700, 282],
    [800, 252],
    [840, 420],
  ] as const) {
    await write(terminal, `\x1bc${solid(width, height)}\r\nAFTER`);
    const state = decode(graphics.serialize(0));
    expect(state.images.map((image) => [image.width, image.height])).toEqual([[width, height]]);
    expect(state.runs.reduce((placed, run) => placed + run[5], 0)).toBe(
      Math.ceil(width / 7) * Math.ceil(height / 14),
    );
    expect(terminal.buffer.active.getLine(Math.ceil(height / 14))?.translateToString(true)).toBe(
      "AFTER",
    );
  }
});

test("raster attributes refuse an impossible Sixel and its continuation is only the ignored marker", async () => {
  const terminal = idlePty("graphics-refused-sixel", 40, 8);
  try {
    ingest(terminal, 'SAFE\r\n\x1bPq"1;1;2100;300#1;2;100;0;0#1!2100~-!2100~');
    const refused = Buffer.from((await terminal.snapshot()).data).toString("latin1");
    // Every peer refuses the same raster, so a late viewer needs none of its payload.
    expect(refused.endsWith("\x1bP+q")).toBe(true);
    ingest(terminal, `-!2100~\x1b\\NEXT\r\n${RED}`);
    const recovered = decode(Buffer.from((await terminal.snapshot()).data).toString("latin1"));
    expect(recovered.images.map((image) => [image.width, image.height])).toEqual([[7, 14]]);
    expect(recovered.runs).toEqual([["normal", 2, 0, 0, 0, 1]]);
  } finally {
    await terminal.kill();
    terminal.dispose();
  }
});

test("an in-flight Sixel beyond the control share displaces the oldest image at the same byte on every peer", async () => {
  const older = noise(280, 280, 7);
  const newer = noise(280, 280, 11);
  const large = stripes(700, 276, 9);
  const retained = async (stream: string, chunk = stream.length) => {
    const peer = mirror(120, 60);
    for (let offset = 0; offset < stream.length; offset += chunk)
      await write(peer.terminal, stream.slice(offset, offset + chunk));
    return decode(peer.graphics.serialize(0)).wire.images.map((image) => image.data);
  };
  const [olderData = ""] = await retained(older);
  const [newerData = ""] = await retained(newer);
  // Within the ordinary control share both content-rich images stay retained.
  expect(await retained(`${older}\r\n${newer}\r\n${large.slice(0, 150_000)}`)).toEqual([
    olderData,
    newerData,
  ]);
  const watermark = `${older}\r\n${newer}\r\n${large.slice(0, 250_000)}`;
  const whole = await retained(watermark);
  expect(whole).toEqual([newerData]);
  expect(await retained(watermark, 4093)).toEqual(whole);

  const terminal = idlePty("graphics-joint-reservation", 120, 60);
  try {
    ingest(terminal, watermark);
    const snapshot = Buffer.from((await terminal.snapshot()).data).toString("latin1");
    expect(Buffer.from(snapshot, "latin1").toString("base64").length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_BASE64_CHARS,
    );
    const envelopeStart = snapshot.indexOf(`\x1b]1337;${TERMINAL_GRAPHICS_PREFIX}`);
    const envelopeEnd = snapshot.indexOf("\x07", envelopeStart) + 1;
    expect(envelopeEnd - envelopeStart).toBeLessThanOrEqual(
      TERMINAL_GRAPHICS_ENVELOPE_BYTES + TERMINAL_GRAPHICS_POLICY.retainedBytes,
    );
    // The replayed Sixel prefix and the envelope share one reservation.
    const continuation = snapshot.length - snapshot.lastIndexOf("\x1bP");
    expect(continuation).toBeGreaterThan(240_000);
    expect(envelopeEnd - envelopeStart + continuation).toBeLessThanOrEqual(
      TERMINAL_GRAPHICS_SNAPSHOT_BYTES,
    );
    expect(decode(snapshot).wire.images.map((image) => image.data)).toEqual(whole);
    ingest(terminal, `${large.slice(250_000)}\r\nDONE`);
    const complete = decode(Buffer.from((await terminal.snapshot()).data).toString("latin1"));
    expect(complete.images.map((image) => [image.width, image.height])).toEqual([
      [280, 280],
      [700, 276],
    ]);
  } finally {
    await terminal.kill();
    terminal.dispose();
  }
});

test("version-1 envelopes from retained hosts keep their own bounds beside version 2", async () => {
  const small = mirror();
  await write(small.terminal, RED);
  const { wire } = decode(small.graphics.serialize(0));
  const image = wire.images[0]!;
  // Two records for a one-tile image: legacy hosts were bounded only by their cell budget.
  const twice = Buffer.from([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]).toString("base64");
  expect(
    TerminalGraphicsSnapshotSchema.safeParse({ ...wire, images: [{ ...image, cells: twice }] })
      .success,
  ).toBe(false);
  expect(
    TerminalGraphicsSnapshotSchema.safeParse({
      ...wire,
      version: 1,
      images: [{ ...image, cells: twice }],
    }).success,
  ).toBe(true);
  const wide = mirror(130, 40);
  await write(wide.terminal, solid(700, 282));
  const current = decode(wide.graphics.serialize(0)).wire;
  expect(TerminalGraphicsSnapshotSchema.safeParse(current).success).toBe(true);
  // No version-1 host ever retained 2,100 cells, so a claimed legacy envelope is invalid.
  expect(TerminalGraphicsSnapshotSchema.safeParse({ ...current, version: 1 }).success).toBe(false);
});

test("encoded rasters never alias reusable decoder memory and ignore buffer alignment", () => {
  const backing = new Uint8Array(1 + 64 * 64 * 4);
  let state = 3;
  for (let index = 0; index < backing.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    backing[index] = state >>> 24;
  }
  const unaligned = backing.subarray(1);
  const aligned = unaligned.slice();
  const fromAligned = encodeTerminalRgba(aligned, aligned.length);
  expect(encodeTerminalRgba(unaligned, unaligned.length)).toEqual(fromAligned);
  // Noise stores raw RGBA; the copy must survive the decoder reusing its buffer.
  expect(fromAligned?.format).toBe("rgba");
  aligned.fill(0);
  expect(fromAligned?.bytes).toEqual(unaligned);
});

test("an image split at a snapshot watermark completes exactly once from its continuation", async () => {
  const terminal = idlePty("graphics-watermark", 20, 5);
  try {
    const split = RED.indexOf("!7~") + 2;
    ingest(terminal, RED.slice(0, split));
    const pending = terminal.snapshot();
    ingest(terminal, RED.slice(split));
    const before = await pending;
    expect(before.seq).toBe(1);
    const beforeText = Buffer.from(before.data).toString();
    expect(decode(beforeText).runs).toEqual([]);
    const replay = mirror();
    // Headless mirrors intentionally refuse privileged snapshot-install OSC. No
    // image exists yet at this watermark, so replaying its unfinished control is
    // sufficient to exercise the actual addon parser continuation here.
    await write(replay.terminal, beforeText + RED.slice(split));
    expect(decode(replay.graphics.serialize(0)).runs).toEqual([["normal", 0, 0, 0, 0, 1]]);
    expect(decode(Buffer.from((await terminal.snapshot()).data).toString()).runs).toEqual([
      ["normal", 0, 0, 0, 0, 1],
    ]);
  } finally {
    await terminal.kill();
    terminal.dispose();
  }
});

test("a split ST does not replay an already-committed image and oversized controls remain discarded", async () => {
  const { terminal } = mirror();
  const continuation = new TerminalParserContinuation(terminal);
  await write(terminal, RED.slice(0, -1));
  expect(continuation.serialize()).toBe("\x1b");
  await write(terminal, "\\");
  expect(continuation.serialize()).toBe("");
  // Sixel payloads carry up to the Sixel input bound; every other control keeps 180,000.
  await write(terminal, "\x1bPq" + "?".repeat(390_000));
  const pending = continuation.serialize();
  expect(pending.startsWith("\x1bP")).toBe(true);
  expect(pending.slice(pending.indexOf("q") + 1)).toBe("?".repeat(390_000));
  await write(terminal, "?".repeat(10_000));
  expect(continuation.serialize()).toBe("\x1bP+q");
  await write(terminal, "\x1b\\\x1bP$q" + "m".repeat(180_001));
  expect(continuation.serialize()).toBe("\x1bP+q");
  await write(terminal, "\x1b\\\x1b]0;" + "t".repeat(180_001));
  expect(continuation.serialize()).toBe("\x1b]99999;");
  await write(terminal, "\x1b\\SAFE");
  expect(continuation.serialize()).toBe("");
});

test("snapshot validation rejects deceptive image headers and out-of-image tile references", async () => {
  const { terminal, graphics } = mirror();
  await write(terminal, RED);
  const state = decode(graphics.serialize(0));
  const image = state.images[0]!;
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71], 0);
  png.set([73, 72, 68, 82], 12);
  png.writeUInt32BE(100000, 16);
  png.writeUInt32BE(100000, 20);
  expect(
    TerminalGraphicsSnapshotSchema.safeParse({
      ...state.wire,
      images: [{ ...image, format: "image/png", data: png.toString("base64") }],
    }).success,
  ).toBe(false);
  expect(
    TerminalGraphicsSnapshotSchema.safeParse({
      ...state.wire,
      images: [{ ...image, cells: Buffer.from([0, 0, 0, 0, 99, 0]).toString("base64") }],
    }).success,
  ).toBe(false);
});

test("unfinished Sixel replays with its pre-command palette rather than recoloring earlier pixels", async () => {
  const original = mirror();
  await write(original.terminal, "\x1bPq#1;2;100;0;0#1\x1b\\");
  const prefix = '\x1bPq"1;1;14;6#1!7~#1;2;0;100;0#1';
  const suffix = "!7~\x1b\\";
  await write(original.terminal, prefix);
  const snapshot = decode(original.graphics.serialize(0));
  const color = Buffer.from(snapshot.palette, "base64").subarray(4, 8);
  expect(color).toEqual(Buffer.from([255, 0, 0, 255]));
  const replay = mirror();
  await write(
    replay.terminal,
    `\x1bPq#1;2;${Math.round((color[0]! * 100) / 255)};${Math.round((color[1]! * 100) / 255)};${Math.round((color[2]! * 100) / 255)}#1\x1b\\` +
      prefix +
      suffix,
  );
  await write(original.terminal, suffix);
  const expected = imagePixels(decode(original.graphics.serialize(0)).images[0]!);
  expect(imagePixels(decode(replay.graphics.serialize(0)).images[0]!)).toEqual(expected);
  const pixels = expected;
  expect(pixels.subarray(0, 4)).toEqual(Buffer.from([255, 0, 0, 255]));
  expect(pixels.subarray(28, 32)).toEqual(Buffer.from([0, 255, 0, 255]));
});

test("sparse Sixel expansion and hostile IIP headers are rejected without corrupting later output", async () => {
  const { terminal, graphics } = mirror();
  await write(terminal, "\x1bPq!1000~-" + "~-".repeat(9000) + "\x1b\\");
  await write(
    terminal,
    "\x1b]1337;File=" +
      Array.from({ length: 1000 }, (_, index) => `p${index}=x;`).join("") +
      ":AAAA\x07",
  );
  const malformed = Buffer.alloc(24);
  malformed.set([255, 216, 255, 224, 0, 2, 255, 192, 0, 0, 8, 0, 1, 0, 1]);
  await write(
    terminal,
    `\x1b]1337;File=inline=1;size=24;width=1;height=1:${malformed.toString("base64")}\x07SAFE`,
  );
  expect(decode(graphics.serialize(0)).images).toEqual([]);
  expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("SAFE");
});

test("repeated shrink and grow retains a restorable visible image within its admitted footprint", async () => {
  const { terminal, graphics } = mirror(200);
  await write(terminal, '\x1bPq"1;1;1400;14#1;2;100;0;0#1!1400~-!1400~-!1400B\x1b\\');
  for (let cycle = 0; cycle < 20; cycle++) {
    terminal.resize(100, 5);
    terminal.resize(200, 5);
  }
  const state = decode(graphics.serialize(0));
  expect(state.runs).toEqual([["normal", 0, 0, 0, 0, 200]]);
});

test("a reflow that repeats an image tile on a second row still snapshots one placement per tile", async () => {
  const { terminal, graphics } = mirror(20, 5);
  await write(terminal, `${"A".repeat(20)}\r${solid(140, 14)}\r\n\r\n`);
  terminal.resize(10, 5);
  // Inserting a line splits the wrapped text rows: growing back no longer rejoins them, while
  // the addon still extends the first image row, so tiles 10-19 now sit on two rows.
  await write(terminal, "\x1b[2;1H\x1b[1L");
  terminal.resize(20, 5);
  await write(terminal, "");
  // `decode` parses with the schema a late viewer applies; one record per tile keeps it valid.
  const tiles = decode(graphics.serialize(0)).runs.flatMap(([, , , , tile, count]) =>
    Array.from({ length: count }, (_, offset) => tile + offset),
  );
  expect(tiles.toSorted((left, right) => left - right)).toEqual(
    Array.from({ length: 20 }, (_, tile) => tile),
  );
});

test("lossless packets retain full-size image colors including 256 colors plus transparency", () => {
  const rgba = new Uint8Array(700 * 276 * 4);
  for (let pixel = 0; pixel < rgba.length / 4; pixel++) {
    const color = Math.floor(pixel / 4) % 257;
    if (color === 256) continue;
    rgba[pixel * 4] = color;
    rgba[pixel * 4 + 1] = (color * 17) % 256;
    rgba[pixel * 4 + 2] = (color * 31) % 256;
    rgba[pixel * 4 + 3] = 255;
  }
  const encoded = encodeTerminalRgba(rgba, 180000);
  if (encoded === undefined) throw new Error("Admitted palette fixture was rejected");
  const decoded = decodeTerminalRgba(
    encoded.bytes,
    encoded.format,
    rgba.length / 4,
    TERMINAL_GRAPHICS_PIXELS,
  );
  expect(decoded).toEqual(rgba);
  expect(
    decodeTerminalRgba(encoded.bytes, encoded.format, 1, TERMINAL_GRAPHICS_PIXELS),
  ).toBeUndefined();
});

test("packet decoder rejects malformed counts, palette references and truncated RGBA before expansion", () => {
  const palette = Uint8Array.from([0, 255, 0, 0, 255]);
  expect(
    decodeTerminalRgba(Uint8Array.from([...palette, 128, 1]), "rgba-indexed", 1, 100),
  ).toBeUndefined();
  expect(
    decodeTerminalRgba(Uint8Array.from([...palette, 255, 0]), "rgba-indexed", 1, 100),
  ).toBeUndefined();
  expect(
    decodeTerminalRgba(Uint8Array.from([...palette, 1, 0]), "rgba-indexed", 2, 100),
  ).toBeUndefined();
  expect(decodeTerminalRgba(Uint8Array.from([128, 255, 0]), "rgba-rle", 1, 100)).toBeUndefined();
  expect(
    decodeTerminalRgba(Uint8Array.from([...palette, 128, 0]), "rgba-indexed", 101, 100),
  ).toBeUndefined();
  const transparent = new Uint8Array(1 + 256 * 4 + 3);
  transparent[0] = 255;
  transparent.set([128, 255, 2], 1 + 256 * 4);
  expect(decodeTerminalRgba(transparent, "rgba-indexed-alpha", 1, 100)).toBeUndefined();
});

test("arbitrary RGBA colors retain exact alpha without forced palette quantization", () => {
  const rgba = new Uint8Array(4096 * 4);
  const view = new DataView(rgba.buffer);
  for (let pixel = 0; pixel < 4096; pixel++)
    view.setUint32(pixel * 4, (pixel * 104729) >>> 0, true);
  const encoded = encodeTerminalRgba(rgba, 180000);
  if (encoded === undefined) throw new Error("Bounded raw image was rejected");
  expect(decodeTerminalRgba(encoded.bytes, encoded.format, 4096, TERMINAL_GRAPHICS_PIXELS)).toEqual(
    rgba,
  );
});

test("GIF frame dimensions cannot bypass the native decoder pixel bound", () => {
  // Chromium decodes this as 2x2 despite the deceptive 1x1 logical screen.
  const gif = new Uint8Array([
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 0, 0, 44, 0, 0, 0, 0, 2, 0, 2, 0,
    0, 2, 3, 76, 18, 5, 0, 59,
  ]);
  expect(inlineImageDimensions(gif, "image/gif")).toBeNull();
  gif[6] = 2;
  gif[8] = 2;
  expect(inlineImageDimensions(gif, "image/gif")).toEqual([2, 2]);
  expect(inlineImageDimensions(gif.subarray(0, gif.length - 1), "image/gif")).toBeNull();
});
