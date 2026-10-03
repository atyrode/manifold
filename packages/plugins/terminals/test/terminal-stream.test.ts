import { afterEach, expect, test } from "bun:test";
import {
  MAX_TERMINAL_PARSER_BYTES,
  MAX_TERMINAL_PARSER_FRAMES,
  type ServerMessageBody,
} from "@manifold/protocol";
import { textToBase64 } from "@manifold/sdk";
import { Terminal } from "@xterm/xterm";
import { installTerminalGraphics } from "../src/terminal-graphics";
import { TerminalStream } from "../src/terminal-stream";

type Snapshot = Extract<ServerMessageBody, { type: "terminal_snapshot" }>;
type Geometry = Snapshot["geometry"];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function viewer(cols: number, rows: number) {
  const terminal = new Terminal({ cols, rows, scrollback: 40, allowProposedApi: true });
  const graphics = installTerminalGraphics(terminal);
  const stream = new TerminalStream(terminal, graphics);
  cleanups.push(() => {
    stream.dispose();
    graphics.dispose();
    terminal.dispose();
  });
  return { terminal, stream };
}

/** One server delivery for this view as the parser receives and credits it. */
interface Feed {
  readonly settled: Promise<void>;
  readonly prepared: boolean[];
  readonly acks: number[];
  stalled: boolean;
  output(seq: number, text: string): void;
  geometry(seq: number, cols: number, revision: number | null): void;
  /** Loses one ordinal, as no ordered socket can. */
  gap(): void;
}

/** A snapshot at ordinal 0, then a consecutive tail. */
function deliver(
  stream: TerminalStream,
  deliveryId: string,
  seq: number,
  geometry: Geometry,
  text: string,
): Feed {
  let ordinal = 0;
  const settled = Promise.withResolvers<void>();
  const feed: Feed = {
    settled: settled.promise,
    prepared: [],
    acks: [],
    stalled: false,
    output(seq: number, text: string): void {
      stream.append({
        type: "terminal_output",
        terminalId: "t",
        viewportId: "v",
        deliveryId,
        deliverySeq: ++ordinal,
        seq,
        data: textToBase64(text),
      });
    },
    geometry(seq: number, cols: number, revision: number | null): void {
      stream.append({
        type: "terminal_geometry",
        terminalId: "t",
        viewportId: "v",
        deliveryId,
        deliverySeq: ++ordinal,
        seq,
        geometry: { cols, rows: 4, revision },
      });
    },
    gap(): void {
      ordinal++;
    },
  };
  stream.snapshot(
    {
      type: "terminal_snapshot",
      terminalId: "t",
      viewportId: "v",
      deliveryId,
      deliverySeq: 0,
      seq,
      geometry,
      data: textToBase64(text),
      skipped: false,
    },
    {
      prepare: (preserved) => feed.prepared.push(preserved),
      settled: () => settled.resolve(),
      acknowledge: (acknowledged, deliverySeq) => {
        expect(acknowledged).toBe(deliveryId);
        feed.acks.push(deliverySeq);
      },
      stalled: () => {
        feed.stalled = true;
      },
    },
  );
  return feed;
}

/** Resolves once every operation the stream accepted before it has completed. */
function drained(stream: TerminalStream): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.barrier(resolve);
  return promise;
}

function write(terminal: Terminal, text: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(text, resolve);
  return promise;
}

/** Holds xterm's parser inside an OSC until released, as a slow or stopped reader would. */
function blockParser(terminal: Terminal, code: number) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  const handler = terminal.parser.registerOscHandler(code, () => {
    entered.resolve();
    return release.promise;
  });
  cleanups.push(() => {
    release.resolve(true);
    handler.dispose();
  });
  return { entered: entered.promise, release: () => release.resolve(true) };
}

function bufferState(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      if (line === undefined) throw new Error("missing xterm buffer line");
      return { text: line.translateToString(true), wrapped: line.isWrapped };
    }),
  };
}

function lines(terminal: Terminal): string[] {
  return bufferState(terminal).lines.map((line) => line.text);
}

test("bytes and sparse geometry replay in arrival order and earn credit only once parsed", async () => {
  const { terminal, stream } = viewer(30, 2);
  const feed = deliver(stream, "d1", 0, { cols: 6, rows: 4, revision: 1 }, "start\r\n");
  feed.geometry(0, 8, 2);
  feed.output(1, "12345678901");
  feed.geometry(1, 4, 3);
  feed.output(2, "\r\nsame\r\n");
  feed.geometry(2, 10, 4);
  feed.output(3, "same\r\n");
  feed.geometry(2, 25, 3); // stale revision, independent of byte seq
  feed.output(3, "DUPLICATE");
  feed.output(1, "STALE");
  feed.geometry(2, 25, 4); // duplicate revision
  expect(feed.acks).toEqual([]);
  await drained(stream);

  // Independent source replay: each write finishes at its actual grid, before resizing.
  const source = new Terminal({ cols: 6, rows: 4, scrollback: 40, allowProposedApi: true });
  cleanups.push(() => source.dispose());
  await write(source, "start\r\n");
  source.resize(8, 4);
  await write(source, "12345678901");
  source.resize(4, 4);
  await write(source, "\r\nsame\r\n");
  source.resize(10, 4);
  await write(source, "same\r\n");
  const expected = bufferState(source);
  expect(expected.lines.filter((line) => line.text === "same")).toHaveLength(2);
  expect(bufferState(terminal)).toEqual(expected);
  expect(feed.acks.at(-1)).toBe(10);
  expect(feed.acks).toEqual([...new Set(feed.acks)].sort((left, right) => left - right));
});

test("one parser write is in flight and credit waits for its completion", async () => {
  const { terminal, stream } = viewer(8, 4);
  const feed = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "");
  await feed.settled;
  const writes = { inFlight: 0, peak: 0 };
  const original = terminal.write.bind(terminal);
  terminal.write = (data, callback) => {
    writes.inFlight++;
    writes.peak = Math.max(writes.peak, writes.inFlight);
    original(data, () => {
      writes.inFlight--;
      callback?.();
    });
  };
  const parser = blockParser(terminal, 901);
  feed.output(1, "\x1b]901;wait\x07a");
  await parser.entered;
  for (let seq = 2; seq <= 50; seq++) feed.output(seq, "b");
  expect(writes.peak).toBe(1);
  expect(feed.acks).toEqual([0]);
  parser.release();
  await drained(stream);
  expect(writes.peak).toBe(1);
  expect(feed.acks.at(-1)).toBe(50);
  expect(lines(terminal).join("")).toBe(`a${"b".repeat(49)}`);
});

test("a handoff still charges the retired parser operation against the new delivery", async () => {
  const { terminal, stream } = viewer(8, 4);
  const old = deliver(stream, "old", 0, { cols: 8, rows: 4, revision: 0 }, "");
  await old.settled;
  const parser = blockParser(terminal, 903);
  old.output(1, `\x1b]903;${"p".repeat(500_000)}\x07`);
  await parser.entered;
  stream.suspend();
  const rejected = deliver(
    stream,
    "over-bound",
    1,
    { cols: 8, rows: 4, revision: 0 },
    "q".repeat(300_000),
  );
  expect(rejected.stalled).toBe(true);
  expect(stream.deliveryId).toBeNull();
  expect(stream.coherent).toBe(false);
  parser.release();
  await drained(stream);
  expect(old.acks).toEqual([0]);
  expect(rejected.acks).toEqual([]);
  const recovered = deliver(stream, "recovered", 2, { cols: 8, rows: 4, revision: 0 }, "retained");
  await recovered.settled;
  expect(recovered.acks).toEqual([0]);
  expect(lines(terminal)).toEqual(["retained", "", "", ""]);
});

test.each<{ name: string; overflow: (feed: Feed) => void }>([
  {
    name: "the frame bound",
    overflow: (feed) => {
      for (let seq = 2; seq <= MAX_TERMINAL_PARSER_FRAMES; seq++) feed.output(seq, "x");
      expect(feed.stalled).toBe(false);
      feed.output(MAX_TERMINAL_PARSER_FRAMES + 1, "x");
    },
  },
  {
    name: "the byte bound",
    overflow: (feed) => {
      // Charged in base64 wire characters: each frame below is half the bound.
      const half = "x".repeat((MAX_TERMINAL_PARSER_BYTES / 8) * 3);
      feed.output(2, half);
      expect(feed.stalled).toBe(false);
      feed.output(3, half);
    },
  },
  {
    name: "a delivery ordinal gap",
    overflow: (feed) => {
      feed.output(2, "x");
      feed.gap();
      feed.output(3, "x");
    },
  },
])("$name retires a delivery unparsed until a fresh snapshot", async ({ overflow }) => {
  const { terminal, stream } = viewer(8, 4);
  const feed = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "");
  await feed.settled;
  expect(stream.coherent).toBe(true);
  const parser = blockParser(terminal, 902);
  feed.output(1, "\x1b]902;wait\x07kept");
  await parser.entered;
  overflow(feed);
  expect(feed.stalled).toBe(true);
  expect(stream.coherent).toBe(false);
  expect(stream.deliveryId).toBeNull();
  feed.output(1_000, "late");
  parser.release();
  await drained(stream);
  // No arbitrary tail reached xterm, and a retired delivery earns no credit even for the
  // one operation that was already in flight.
  expect(lines(terminal)).toEqual(["kept", "", "", ""]);
  expect(feed.acks).toEqual([0]);

  const fresh = deliver(stream, "d2", 2_000, { cols: 8, rows: 4, revision: 0 }, "fresh");
  await fresh.settled;
  expect(stream.coherent).toBe(true);
  expect(fresh.acks).toEqual([0]);
  expect(lines(terminal)).toEqual(["fresh", "", "", ""]);
});

test("same byte watermark preserves the painted buffer and modes only with identical geometry", async () => {
  const { terminal, stream } = viewer(8, 4);
  const first = deliver(stream, "d1", 1, { cols: 8, rows: 4, revision: 0 }, "\x1b[?2004hcopy-me");
  await first.settled;
  const retained = bufferState(terminal);
  expect(terminal.modes.bracketedPasteMode).toBe(true);

  stream.suspend();
  const handoff = deliver(stream, "d2", 1, { cols: 8, rows: 4, revision: 0 }, "must-not-repaint");
  await handoff.settled;
  expect(handoff.prepared).toEqual([true]);
  expect(bufferState(terminal)).toEqual(retained);
  expect(terminal.modes.bracketedPasteMode).toBe(true);

  // Two idle resizes can return to the same dimensions with a different revision.
  const idle = deliver(stream, "d3", 1, { cols: 8, rows: 4, revision: 1 }, "idle");
  await idle.settled;
  expect(idle.prepared).toEqual([false]);
  expect(lines(terminal)).toEqual(["idle", "", "", ""]);
  expect(terminal.modes.bracketedPasteMode).toBe(false);
  const fresh = deliver(stream, "d4", 1, { cols: 4, rows: 4, revision: 2 }, "fresh\r\n");
  await fresh.settled;
  expect(terminal.cols).toBe(4);
  expect(lines(terminal)).toEqual(["fres", "h", "", ""]);

  // Late frames of replaced deliveries are neither parsed nor credited.
  first.output(2, "stale");
  idle.output(2, "stale");
  fresh.output(2, "tail");
  await drained(stream);
  expect(lines(terminal)).toEqual(["fres", "h", "tail", ""]);
  expect(first.acks).toEqual([0]);
  expect(idle.acks).toEqual([0]);
  expect(fresh.acks).toEqual([0, 1]);
});

test("nullable legacy revisions still require matching dimensions to preserve a snapshot", async () => {
  const { terminal, stream } = viewer(12, 4);
  const legacy = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: null }, "legacy");
  await legacy.settled;
  expect(terminal.cols).toBe(8);
  const retained = bufferState(terminal);
  await deliver(stream, "d2", 0, { cols: 8, rows: 4, revision: null }, "not-replayed").settled;
  expect(bufferState(terminal)).toEqual(retained);
  const grid = deliver(stream, "d3", 0, { cols: 4, rows: 4, revision: null }, "grid");
  await grid.settled;
  expect(terminal.cols).toBe(4);
  expect(lines(terminal)).toEqual(["grid", "", "", ""]);
  grid.geometry(0, 4, null); // same legacy dimensions: nothing to apply
  grid.geometry(0, 6, null);
  await drained(stream);
  expect(terminal.cols).toBe(6);
  expect(grid.acks.at(-1)).toBe(2);
});

test("a fresh snapshot replays behind the in-flight parse and CAN cancels its unfinished control", async () => {
  const { terminal, stream } = viewer(8, 4);
  const old = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "old");
  await old.settled;
  old.output(1, "\x1b]900;unfinished");
  const replaced = deliver(stream, "d2", 1, { cols: 4, rows: 4, revision: 1 }, "ABCDE\r\n");
  replaced.output(2, "tail");
  // Geometry cannot leapfrog bytes already in xterm's parser.
  expect(terminal.cols).toBe(8);
  await replaced.settled;
  await drained(stream);
  expect(lines(terminal)).toEqual(["ABCD", "E", "tail", ""]);
  expect(replaced.acks.at(-1)).toBe(1);
});

test("a replacement snapshot cannot accept input against modes while its replay is incomplete", async () => {
  const { terminal, stream } = viewer(8, 4);
  await deliver(stream, "old", 0, { cols: 8, rows: 4, revision: 0 }, "old").settled;
  const parser = blockParser(terminal, 904);
  const fresh = deliver(
    stream,
    "fresh",
    1,
    { cols: 8, rows: 4, revision: 0 },
    "\x1b]904;wait\x07new",
  );
  await parser.entered;
  expect(stream.coherent).toBe(false);
  expect(fresh.acks).toEqual([]);
  parser.release();
  await fresh.settled;
  expect(stream.coherent).toBe(true);
  expect(fresh.acks).toEqual([0]);
  expect(lines(terminal)).toEqual(["new", "", "", ""]);
});

test("restart fences old geometry, settlement and credit while accepting fresh counters", async () => {
  const { terminal, stream } = viewer(8, 4);
  const old = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "old");
  await old.settled;
  const visibleColumns: number[] = [];
  const resized = terminal.onResize(({ cols }) => visibleColumns.push(cols));
  cleanups.push(() => resized.dispose());
  const parser = blockParser(terminal, 903);
  old.output(1, "\x1b]903;wait\x07old-tail");
  await parser.entered;
  old.geometry(1, 30, 20);
  const stale = deliver(stream, "d2", 1, { cols: 30, rows: 4, revision: 20 }, "");
  let staleInputReady = false;
  void stale.settled.then(() => {
    staleInputReady = true;
  });
  stream.restart();
  expect(stream.coherent).toBe(false);
  const restarted = deliver(stream, "d3", 0, { cols: 8, rows: 4, revision: 0 }, "new\r\n");
  restarted.geometry(0, 6, 1);
  restarted.output(1, "fresh\r\n");
  parser.release();
  await restarted.settled;
  await drained(stream);
  expect(staleInputReady).toBe(false);
  expect(stale.prepared).toEqual([]);
  expect(stale.acks).toEqual([]);
  expect(old.acks).toEqual([0]);
  expect(visibleColumns).not.toContain(30);
  expect(terminal.cols).toBe(6);
  expect(lines(terminal)).toEqual(["new", "fresh", "", ""]);
  expect(restarted.acks.at(-1)).toBe(2);
  expect(stream.coherent).toBe(true);
});

test.each<{ name: string; retire: (stream: TerminalStream) => void; coherent: boolean }>([
  // A handoff keeps the coherent screen and its input until the next snapshot.
  { name: "a handoff", retire: (stream) => stream.suspend(), coherent: true },
  // A refused attachment receives nothing newer, so input waits for a fresh replay.
  { name: "a server refusal", retire: (stream) => stream.refuse(), coherent: false },
])("$name retires credit but still parses accepted output in order", async (scenario) => {
  const { terminal, stream } = viewer(8, 4);
  const feed = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "");
  await feed.settled;
  const parser = blockParser(terminal, 904);
  feed.output(1, "\x1b]904;wait\x07a");
  await parser.entered;
  feed.output(2, "b");
  feed.output(3, "c");
  scenario.retire(stream);
  feed.output(4, "d");
  parser.release();
  await drained(stream);
  expect(lines(terminal)[0]).toBe("abc");
  expect(feed.acks).toEqual([0]);
  expect(stream.coherent).toBe(scenario.coherent);
  const next = deliver(stream, "d2", 3, { cols: 8, rows: 4, revision: 0 }, "unused");
  await next.settled;
  expect(next.prepared).toEqual([true]);
  expect(lines(terminal)[0]).toBe("abc");
  expect(stream.coherent).toBe(true);
});

test("disposal drops queued work and fences every completion callback", async () => {
  const { terminal, stream } = viewer(8, 4);
  const feed = deliver(stream, "d1", 0, { cols: 8, rows: 4, revision: 0 }, "");
  await feed.settled;
  const parser = blockParser(terminal, 905);
  feed.output(1, "\x1b]905;wait\x07a");
  await parser.entered;
  feed.output(2, "queued");
  stream.dispose();
  parser.release();
  await write(terminal, "");
  expect(lines(terminal)[0]).toBe("a");
  expect(feed.acks).toEqual([0]);
});
