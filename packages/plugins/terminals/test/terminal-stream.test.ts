import { afterEach, expect, test } from "bun:test";
import type { ServerMessageBody } from "@manifold/protocol";
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

function replace(
  stream: TerminalStream,
  seq: number,
  geometry: Geometry,
  text: string,
): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.snapshot(
    { type: "terminal_snapshot", terminalId: "t", seq, geometry, data: textToBase64(text) },
    () => {},
    resolve,
  );
  return promise;
}

function output(stream: TerminalStream, seq: number, text: string): void {
  stream.append({ type: "terminal_output", terminalId: "t", seq, data: textToBase64(text) });
}

function geometry(stream: TerminalStream, seq: number, cols: number, revision: number): void {
  stream.append({
    type: "terminal_geometry",
    terminalId: "t",
    seq,
    geometry: { cols, rows: 4, revision },
  });
}

function write(terminal: Terminal, text: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(text, resolve);
  return promise;
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

test("pending sparse geometry and repeated bytes replay in source order, not watermark order", async () => {
  const { terminal, stream } = viewer(30, 2);
  geometry(stream, 0, 8, 2);
  output(stream, 1, "12345678901");
  geometry(stream, 1, 4, 3);
  output(stream, 2, "\r\nsame\r\n");
  geometry(stream, 2, 10, 4);
  output(stream, 3, "same\r\n");
  geometry(stream, 2, 25, 3); // stale geometry, independent of byte seq
  output(stream, 3, "DUPLICATE");
  output(stream, 1, "STALE");
  geometry(stream, 2, 25, 4); // duplicate geometry revision
  await replace(stream, 0, { cols: 6, rows: 4, revision: 1 }, "start\r\n");

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
});

test("same byte watermark preserves the painted buffer and modes only with identical geometry", async () => {
  const { terminal, stream } = viewer(8, 4);
  await replace(stream, 1, { cols: 8, rows: 4, revision: 0 }, "\x1b[?2004hcopy-me");
  const retained = bufferState(terminal);
  expect(terminal.modes.bracketedPasteMode).toBe(true);

  stream.suspend();
  await replace(stream, 1, { cols: 8, rows: 4, revision: 0 }, "must-not-repaint");
  expect(bufferState(terminal)).toEqual(retained);
  expect(terminal.modes.bracketedPasteMode).toBe(true);

  // Two idle resizes can return to the same dimensions with a different revision.
  await replace(stream, 1, { cols: 8, rows: 4, revision: 1 }, "idle");
  expect(bufferState(terminal).lines.map((line) => line.text)).toEqual(["idle", "", "", ""]);
  expect(terminal.modes.bracketedPasteMode).toBe(false);
  await replace(stream, 1, { cols: 4, rows: 4, revision: 2 }, "fresh\r\n");
  expect(terminal.cols).toBe(4);
  expect(terminal.modes.bracketedPasteMode).toBe(false);
  expect(bufferState(terminal).lines.map((line) => line.text)).toEqual(["fres", "h", "", ""]);

  output(stream, 2, "tail");
  await write(terminal, "");
  const latest = bufferState(terminal);
  stream.snapshot(
    {
      type: "terminal_snapshot",
      terminalId: "t",
      seq: 1,
      geometry: { cols: 8, rows: 4, revision: 0 },
      data: textToBase64("stale"),
    },
    () => {
      throw new Error("stale snapshot prepared a replacement");
    },
    () => {
      throw new Error("stale snapshot re-enabled delivery");
    },
  );
  await write(terminal, "");
  expect(bufferState(terminal)).toEqual(latest);
});

test("nullable legacy revisions still require matching dimensions to preserve a snapshot", async () => {
  const { terminal, stream } = viewer(12, 4);
  stream.append({
    type: "terminal_geometry",
    terminalId: "t",
    seq: 0,
    geometry: { cols: 3, rows: 4, revision: null },
  });
  await replace(stream, 0, { cols: 8, rows: 4, revision: null }, "legacy");
  expect(terminal.cols).toBe(8); // latest-record legacy snapshot covers old admissions
  const retained = bufferState(terminal);
  await replace(stream, 0, { cols: 8, rows: 4, revision: null }, "not-replayed");
  expect(bufferState(terminal)).toEqual(retained);
  await replace(stream, 0, { cols: 4, rows: 4, revision: null }, "grid");
  expect(terminal.cols).toBe(4);
  expect(bufferState(terminal).lines.map((line) => line.text)).toEqual(["grid", "", "", ""]);
});

test("snapshot geometry resets behind queued parsing and CAN cancels an unfinished old control", async () => {
  const { terminal, stream } = viewer(8, 4);
  await replace(stream, 0, { cols: 8, rows: 4, revision: 0 }, "old");
  output(stream, 1, "\x1b]900;unfinished");
  const replayed = replace(stream, 1, { cols: 4, rows: 4, revision: 1 }, "ABCDE\r\n");
  output(stream, 2, "tail");
  // Geometry cannot leapfrog bytes already in xterm's parser queue.
  expect(terminal.cols).toBe(8);
  await replayed;
  await write(terminal, "");
  expect(bufferState(terminal).lines.map((line) => line.text)).toEqual(["ABCD", "E", "tail", ""]);
});

test("restart fences old geometry and unsettled delivery while accepting fresh seq and revision counters", async () => {
  const { terminal, stream } = viewer(8, 4);
  await replace(stream, 0, { cols: 8, rows: 4, revision: 0 }, "old");
  const blocked = Promise.withResolvers<boolean>();
  const entered = Promise.withResolvers<void>();
  const visibleColumns: number[] = [];
  const resized = terminal.onResize(({ cols }) => visibleColumns.push(cols));
  const handler = terminal.parser.registerOscHandler(901, () => {
    entered.resolve();
    return blocked.promise;
  });
  cleanups.push(() => {
    blocked.resolve(true);
    handler.dispose();
    resized.dispose();
  });
  output(stream, 1, "\x1b]901;wait\x07old-tail");
  await entered.promise;
  geometry(stream, 1, 30, 20);
  let staleInputReady = false;
  stream.snapshot(
    {
      type: "terminal_snapshot",
      terminalId: "t",
      seq: 1,
      geometry: { cols: 30, rows: 4, revision: 20 },
      data: "",
    },
    () => {},
    () => {
      staleInputReady = true;
    },
  );
  stream.restart();
  geometry(stream, 0, 6, 1);
  const restarted = replace(stream, 0, { cols: 8, rows: 4, revision: 0 }, "new\r\n");
  output(stream, 1, "fresh\r\n");
  blocked.resolve(true);
  await restarted;
  await write(terminal, "");
  expect(staleInputReady).toBe(false);
  expect(visibleColumns).not.toContain(30);
  expect(terminal.cols).toBe(6);
  expect(bufferState(terminal).lines.map((line) => line.text)).toEqual(["new", "fresh", "", ""]);
});
