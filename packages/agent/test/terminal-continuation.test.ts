import { expect, test } from "bun:test";
import { Terminal } from "@xterm/headless";
import { PtyTerminal } from "../src/terminal.ts";
import { TerminalParserContinuation } from "../src/terminal-parser-continuation.ts";
import { TerminalGraphicsMirror } from "../src/terminal-graphics.ts";
import {
  AgentMessageSchema,
  TerminalGraphicsSnapshotSchema,
  TERMINAL_GRAPHICS_PREFIX,
} from "@manifold/protocol";

async function write(terminal: Terminal, data: Uint8Array): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(data, resolve);
  return promise;
}
function ingest(terminal: PtyTerminal, data: Uint8Array): void {
  const target: unknown = terminal;
  if (
    !target ||
    typeof target !== "object" ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  )
    throw new Error("missing PTY ingress");
  target.ingest.call(terminal, data);
}
async function compare(prefix: Uint8Array, tail: Uint8Array): Promise<void> {
  const terminal = new PtyTerminal({
    terminalId: "continuation",
    cols: 40,
    rows: 8,
    command: [Bun.which("bash") ?? "/bin/sh", "-c", "read -r line"],
    onOutput: () => {},
  });
  const live = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const late = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  try {
    ingest(terminal, prefix);
    await write(live, prefix);
    const snapshot = await terminal.snapshot();
    await write(late, snapshot.data);
    ingest(terminal, tail);
    await write(live, tail);
    await write(late, tail);
    const rows = (t: Terminal) =>
      Array.from({ length: 8 }, (_, i) => t.buffer.active.getLine(i)?.translateToString());
    expect(rows(late)).toEqual(rows(live));
    const styles = (t: Terminal) =>
      Array.from({ length: 8 }, (_, row) =>
        Array.from({ length: 40 }, (_, col) => {
          const cell = t.buffer.active.getLine(row)?.getCell(col);
          return cell && [cell.getFgColor(), cell.getBgColor(), cell.isBold(), cell.isItalic()];
        }),
      );
    expect(styles(late)).toEqual(styles(live));
    expect(late.buffer.active.cursorX).toBe(live.buffer.active.cursorX);
    expect(late.buffer.active.cursorY).toBe(live.buffer.active.cursorY);
  } finally {
    await terminal.kill();
    terminal.dispose();
    live.dispose();
    late.dispose();
  }
}

test("snapshot preserves a multibyte character split at the exact output watermark", async () => {
  await compare(new Uint8Array([0xe2, 0x82]), new Uint8Array([0xac, 0x58]));
});
test("snapshot does not execute a pending CSI newline twice", async () => {
  await compare(Buffer.from("\x1b[1\n"), Buffer.from("mX"));
});
test("C1 and saturated parameter continuations preserve following cursor placement", async () => {
  await compare(Buffer.from("\u009b31"), Buffer.from("mX"));
  await compare(Buffer.from("\x1b[" + "0".repeat(100000) + "2"), Buffer.from("CX"));
});
test("unbounded escape intermediates retain bounded semantic parser state", async () => {
  await compare(Buffer.from("\x1b" + " ".repeat(200000)), Buffer.from("qX"));
});

test("subparameter overflow does not change a later main parameter's digit target", async () => {
  await compare(Buffer.from("\x1b[1" + ":0".repeat(33) + ";3"), Buffer.from("1mX"));
});

test("non-ASCII pending controls remain within the machine snapshot wire limit", async () => {
  const terminal = new PtyTerminal({
    terminalId: "bounded-osc",
    cols: 40,
    rows: 8,
    command: [Bun.which("bash") ?? "/bin/sh", "-c", "read -r line"],
    onOutput: () => {},
  });
  try {
    ingest(terminal, Buffer.from("\x1b]0;" + "€".repeat(179000)));
    const snapshot = await terminal.snapshot();
    expect(
      AgentMessageSchema.safeParse({
        type: "snapshot",
        terminalId: "bounded-osc",
        seq: snapshot.seq,
        data: Buffer.from(snapshot.data).toString("base64"),
      }).success,
    ).toBe(true);
  } finally {
    await terminal.kill();
    terminal.dispose();
  }
});

test("DCS continuation preserves native decoding and canonicalizes huge numeric headers", async () => {
  for (const prefix of [
    Buffer.from("\x1bP" + "0".repeat(180001) + "q~"),
    Buffer.from([0x1b, 0x50, 0xff, 0x71, 0x7e]),
    Buffer.from("\x1bPq~" + "$\x7f".repeat(70000)),
  ]) {
    const live = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    const late = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    const liveGraphics = new TerminalGraphicsMirror(live, () => {});
    const lateGraphics = new TerminalGraphicsMirror(late, () => {});
    const continuation = new TerminalParserContinuation(live);
    try {
      await write(live, prefix);
      await write(late, Buffer.from(continuation.serialize()));
      await write(live, Buffer.from("\x1b\\"));
      await write(late, Buffer.from("\x1b\\"));
      const state = (g: TerminalGraphicsMirror) => {
        const data = g.serialize(0);
        const start = data.indexOf(TERMINAL_GRAPHICS_PREFIX) + TERMINAL_GRAPHICS_PREFIX.length;
        return TerminalGraphicsSnapshotSchema.parse(JSON.parse(data.slice(start, -1)));
      };
      expect(state(lateGraphics)).toEqual(state(liveGraphics));
    } finally {
      liveGraphics.dispose();
      lateGraphics.dispose();
      live.dispose();
      late.dispose();
    }
  }
});

test("C1 execution ending DCS does not advertise phantom Sixel replay", async () => {
  const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  const graphics = new TerminalGraphicsMirror(terminal, () => {});
  const continuation = new TerminalParserContinuation(terminal);
  try {
    await write(terminal, Buffer.from("\x1bPq#1;2;0;100;0#1\u0085"));
    expect(continuation.serialize()).toBe("");
    expect(continuation.replaysSixel()).toBe(false);
  } finally {
    graphics.dispose();
    terminal.dispose();
  }
});
