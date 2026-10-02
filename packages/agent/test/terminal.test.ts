import { existsSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import {
  AgentMessageSchema,
  MAX_SESSION_FRAME_BYTES,
  trackTerminalPrivateMode,
} from "@manifold/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  OutputRing,
  PtyTerminal,
  resolveShellCommand,
  type PtyGeometry,
  type PtyOutput,
  type PtyTerminalOptions,
} from "../src/terminal.ts";
import { LinuxJobRefusal } from "../src/job-linux.ts";

/**
 * Real-PTY unit tests. docs/CONTRACTS.md §Testability (agent-facing) permits the agent's PTY tests to spawn real
 * shells (this machine supports Bun.Terminal). We pin `bash --norc -i` for determinism
 * instead of inheriting the ambient login shell.
 *
 * No fixed delays: the harness resolves waiters from the `onOutput` callback the instant the
 * awaited condition holds (the real signal is the byte stream itself, which exposes no
 * event emitter to await otherwise). Each test's per-run timeout is the only backstop.
 */

const BASH = Bun.which("bash") ?? "/bin/sh";
const SH = Bun.which("sh") ?? "/bin/sh";
const SHELL_COMMAND = [BASH, "--norc", "-i"] as const;

interface Harness {
  readonly terminal: PtyTerminal;
  readonly outputs: PtyOutput[];
  readonly stream: Array<PtyOutput | PtyGeometry>;
  readonly text: () => string;
  /** Resolves as soon as accumulated output satisfies `predicate` (checked per chunk). */
  readonly waitUntil: (predicate: () => boolean) => Promise<void>;
}

const live: PtyTerminal[] = [];

function harnessFor(opts: Omit<PtyTerminalOptions, "onOutput">): Harness {
  const outputs: PtyOutput[] = [];
  const stream: Array<PtyOutput | PtyGeometry> = [];
  const decoder = new TextDecoder();
  const waiters = new Set<{ predicate: () => boolean; resolve: () => void }>();
  let buffer = "";

  const terminal = new PtyTerminal({
    ...opts,
    onOutput: (output) => {
      outputs.push(output);
      stream.push(output);
      buffer += decoder.decode(output.bytes, { stream: true });
      for (const waiter of waiters) {
        if (waiter.predicate()) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
    onGeometry: (geometry) => {
      stream.push(geometry);
      opts.onGeometry?.(geometry);
    },
  });
  live.push(terminal);

  const waitUntil = (predicate: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (predicate()) resolve();
    else waiters.add({ predicate, resolve });
    return promise;
  };

  return { terminal, outputs, stream, text: () => buffer, waitUntil };
}

/** Convenience: a harness whose PTY runs the pinned deterministic shell. */
function spawn(opts: {
  cols?: number;
  rows?: number;
  ringCapBytes?: number;
  env?: Record<string, string>;
}): Harness {
  return harnessFor({
    terminalId: "test-terminal",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    command: SHELL_COMMAND,
    ...(opts.ringCapBytes !== undefined ? { ringCapBytes: opts.ringCapBytes } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
}

/**
 * Feeds the exact callback path Bun.Terminal uses, but synchronously. Real PTY delivery cannot
 * deterministically queue BEFORE, the snapshot drain marker, and AFTER in one JavaScript turn;
 * this seam makes that production ordering observable without changing PtyTerminal's API.
 */
function injectPtyOutput(terminal: PtyTerminal, data: string): void {
  const target: unknown = terminal;
  if (
    typeof target !== "object" ||
    target === null ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  ) {
    throw new Error("PtyTerminal ingest callback is unavailable");
  }
  target.ingest.call(target, new TextEncoder().encode(data));
}

function writeHeadless(terminal: HeadlessTerminal, data: string | Uint8Array): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  terminal.write(data, resolve);
  return promise;
}

function enqueueStream(
  terminal: HeadlessTerminal,
  records: readonly (PtyOutput | PtyGeometry)[],
): void {
  for (const record of records) {
    if ("bytes" in record) terminal.write(record.bytes);
    else terminal.write("", () => terminal.resize(record.geometry.cols, record.geometry.rows));
  }
}

function headlessState(terminal: HeadlessTerminal) {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index);
      return { text: line?.translateToString(), wrapped: line?.isWrapped };
    }),
  };
}

test("unknown native startup rejects exit and retains disposal authority until positive empty proof", async () => {
  let proofAvailable = false;
  const failure = new LinuxJobRefusal("cgroup-empty-unproven", undefined, false, async () => {
    if (!proofAvailable) throw new Error("still unproven");
  });
  const terminal = new PtyTerminal({
    terminalId: "unknown-native",
    cols: 80,
    rows: 24,
    onOutput() {},
    runtime: async () => {
      throw failure;
    },
  });
  try {
    await expect(terminal.exited).rejects.toBe(failure);
    expect(terminal.toAdvertised()).toMatchObject({ alive: true });
    expect(terminal.toAdvertised()).not.toHaveProperty("exitCode");
    expect(terminal.workloadEmpty).toBe(false);
    expect(() => terminal.dispose()).toThrow("empty proof");
    await expect(terminal.kill()).rejects.toThrow("still unproven");
    expect(terminal.workloadEmpty).toBe(false);
  } finally {
    proofAvailable = true;
    await expect(terminal.kill()).rejects.toBe(failure);
    expect(terminal.workloadEmpty).toBe(true);
    terminal.dispose();
  }
});

afterEach(async () => {
  for (const terminal of live) {
    try {
      await terminal.kill();
    } catch {
      // already exited
    }
    terminal.dispose();
  }
  live.length = 0;
});

test("arbitrary PTY output never invents application readiness", async () => {
  const h = harnessFor({
    terminalId: "no-readiness",
    cols: 80,
    rows: 24,
    command: [SH, "-c", "read -r _"],
  });
  injectPtyOutput(h.terminal, "prompt-shaped output $ ");
  await h.terminal.snapshot();
  expect(h.terminal.readinessObservation).toBeNull();
  expect(h.terminal.toAdvertised()).not.toHaveProperty("readiness");
});

test("the reserved OSC declaration reports application readiness exactly once", async () => {
  const h = harnessFor({
    terminalId: "application-readiness",
    cols: 80,
    rows: 24,
    command: [SH, "-c", "read -r _"],
  });
  injectPtyOutput(h.terminal, "\u001b]777;ManifoldReady\u0007");
  expect(await h.terminal.readiness).toBe("application");
  injectPtyOutput(h.terminal, "\u001b[?2004h");
  const snapshot = await h.terminal.snapshot();
  expect(Buffer.from(snapshot.data).toString()).not.toContain("ManifoldReady");
  expect(h.terminal.readinessObservation).toBe("application");
  expect(h.terminal.toAdvertised()).toMatchObject({ readiness: "application" });
});

test("DEC bracketed-paste enable reports its named shell heuristic", async () => {
  const h = harnessFor({
    terminalId: "bracketed-paste-readiness",
    cols: 80,
    rows: 24,
    command: [SH, "-c", "read -r _"],
  });
  injectPtyOutput(h.terminal, "\u001b[?2004h");
  expect(await h.terminal.readiness).toBe("bracketed_paste");
  expect(h.terminal.toAdvertised()).toMatchObject({ readiness: "bracketed_paste" });
});

test("echo round-trip yields strictly monotonic seq from 1", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0); // shell initialized (emitted its prompt)
  h.terminal.write("echo MARK_$((2+2))\n");
  await h.waitUntil(() => h.text().includes("MARK_4"));

  const seqs = h.outputs.map((output) => output.seq);
  // strictly monotonic AND contiguous from 1 (seq is assigned +1 per emission).
  expect(seqs).toEqual(seqs.map((_value, index) => index + 1));
  expect(seqs[0]).toBe(1);
}, 12000);

test("real PTY receives terminal env without inheriting machine credentials", async () => {
  const machineToken = "test-machine-token-MUST-NOT-LEAK-7c70f857";
  const machineServerUrl = "https://machine-control.invalid";
  const machineName = "test-machine-secret-name";
  const savedToken = process.env.MANIFOLD_MACHINE_TOKEN;
  const savedServerUrl = process.env.MANIFOLD_SERVER_URL;
  const savedMachineName = process.env.MANIFOLD_MACHINE_NAME;

  process.env.MANIFOLD_MACHINE_TOKEN = machineToken;
  process.env.MANIFOLD_SERVER_URL = machineServerUrl;
  process.env.MANIFOLD_MACHINE_NAME = machineName;
  try {
    const h = spawn({
      env: {
        MANIFOLD_URL: "https://terminal.invalid",
        MANIFOLD_CONTAINER: "container-test",
        MANIFOLD_ELEMENT: "element-test",
        MANIFOLD_TOKEN: "terminal-token-safe-for-child",
      },
    });
    await h.waitUntil(() => h.outputs.length > 0);
    // Split the completion marker in the echoed command so the wait resolves only after env
    // has printed every child variable, not when the interactive shell echoes our input.
    h.terminal.write('env; printf "\\nENV_DUMP_""DONE\\n"\n');
    await h.waitUntil(() => h.text().includes("ENV_DUMP_DONE"));

    const output = h.text();
    // Compare booleans so a regression failure never dumps the process environment (and its
    // unrelated ambient secrets) into test output.
    expect(output.includes("MANIFOLD_URL=https://terminal.invalid")).toBe(true);
    expect(output.includes("MANIFOLD_CONTAINER=container-test")).toBe(true);
    expect(output.includes("MANIFOLD_ELEMENT=element-test")).toBe(true);
    expect(output.includes("MANIFOLD_TOKEN=terminal-token-safe-for-child")).toBe(true);
    expect(output.includes("MANIFOLD_MACHINE_TOKEN")).toBe(false);
    expect(output.includes("MANIFOLD_SERVER_URL")).toBe(false);
    expect(output.includes("MANIFOLD_MACHINE_NAME")).toBe(false);
    expect(output.includes(machineToken)).toBe(false);
    expect(output.includes(machineServerUrl)).toBe(false);
    expect(output.includes(machineName)).toBe(false);
  } finally {
    if (savedToken === undefined) delete process.env.MANIFOLD_MACHINE_TOKEN;
    else process.env.MANIFOLD_MACHINE_TOKEN = savedToken;
    if (savedServerUrl === undefined) delete process.env.MANIFOLD_SERVER_URL;
    else process.env.MANIFOLD_SERVER_URL = savedServerUrl;
    if (savedMachineName === undefined) delete process.env.MANIFOLD_MACHINE_NAME;
    else process.env.MANIFOLD_MACHINE_NAME = savedMachineName;
  }
}, 12000);

test("snapshot seq equals the last emitted seq; later outputs exceed it", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  h.terminal.write("echo AAA\n");
  await h.waitUntil(() => h.text().includes("AAA"));

  // SAME TICK: read the watermark, then snapshot. snapshot() captures currentSeq
  // synchronously on entry, so no data callback can interleave between these two statements.
  const lastSeq = h.terminal.seq;
  const snapshot = await h.terminal.snapshot();
  expect(snapshot.seq).toBe(lastSeq);
  // snapshot() drains the mirror through `seq`, so the rendered data includes AAA exactly.
  expect(Buffer.from(snapshot.data).toString()).toContain("AAA");

  const before = h.outputs.length;
  h.terminal.write("echo BBB\n");
  await h.waitUntil(() => h.text().includes("BBB"));
  const laterOutputs = h.outputs.slice(before);
  expect(laterOutputs.length).toBeGreaterThan(0);
  for (const output of laterOutputs) expect(output.seq).toBeGreaterThan(snapshot.seq);
}, 12000);

test("snapshot excludes output queued after its drain marker", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);

  injectPtyOutput(h.terminal, "\r\nSNAPSHOT_BEFORE\r\n");
  const preAfterSeq = h.terminal.seq;
  const pendingSnapshot = h.terminal.snapshot();
  injectPtyOutput(h.terminal, "\r\nSNAPSHOT_AFTER\r\n");

  const snapshot = await pendingSnapshot;
  expect(snapshot.seq).toBe(preAfterSeq);
  expect(Buffer.from(snapshot.data).toString()).toContain("SNAPSHOT_BEFORE");
  expect(Buffer.from(snapshot.data).toString()).not.toContain("SNAPSHOT_AFTER");
  expect(h.terminal.seq).toBeGreaterThan(snapshot.seq);
}, 12000);

test("snapshot queued before a later resize retains its original history and grid", async () => {
  const h = harnessFor({
    terminalId: "snapshot-before-resize",
    cols: 12,
    rows: 3,
    command: [SH, "-c", "read -r _"],
  });
  const before = Array.from({ length: 8 }, (_, index) => `row-${index}\r\n`).join("");
  injectPtyOutput(h.terminal, before);
  const reference = await h.terminal.snapshot();

  const pending = h.terminal.snapshot();
  h.terminal.resize(12, 12);
  const after = "LATER_ROW\r\n";
  injectPtyOutput(h.terminal, after);
  const snapshot = await pending;

  // The marker precedes the taller grid. Mutable requested rows must not make its bounded
  // serializer discard history that was present in the actual three-row mirror.
  expect(snapshot.data).toEqual(reference.data);
  expect(Buffer.from(snapshot.data).toString()).toContain("row-0");
  expect(Buffer.from(snapshot.data).toString()).not.toContain("LATER_ROW");
  expect(snapshot.seq).toBe(1);
  expect(snapshot.geometry).toEqual({ cols: 12, rows: 3, revision: 0 });
  expect(h.outputs.map((output) => [output.seq, Buffer.from(output.bytes).toString()])).toEqual([
    [1, before],
    [2, after],
  ]);

  const restored = new HeadlessTerminal({
    cols: 12,
    rows: 3,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const expected = new HeadlessTerminal({
    cols: 12,
    rows: 3,
    scrollback: 5000,
    allowProposedApi: true,
  });
  try {
    await writeHeadless(expected, reference.data);
    await writeHeadless(restored, snapshot.data);
    expect(headlessState(restored)).toEqual(headlessState(expected));
    const later = await h.terminal.snapshot();
    expect(later.geometry).toEqual({ cols: 12, rows: 12, revision: 1 });
    expect(snapshot.geometry).toEqual({ cols: 12, rows: 3, revision: 0 });
  } finally {
    restored.dispose();
    expected.dispose();
  }
});

test("resize queued before snapshot captures its parsed grid and excludes later redraw", async () => {
  const h = harnessFor({
    terminalId: "resize-before-snapshot",
    cols: 12,
    rows: 4,
    command: [SH, "-c", "read -r _"],
  });
  const before = "abcdefghijklmnopqrstuvwx\r\nBASE\r\n";
  injectPtyOutput(h.terminal, before);
  h.terminal.resize(8, 4);
  const pending = h.terminal.snapshot();
  h.terminal.resize(16, 6);
  const after = "\u001b[1A\r\u001b[2KLATER_REDRAW\r\n";
  injectPtyOutput(h.terminal, after);
  const snapshot = await pending;
  expect(snapshot.geometry).toEqual({ cols: 8, rows: 4, revision: 1 });
  expect(snapshot.seq).toBe(1);
  expect(Buffer.from(snapshot.data).toString()).not.toContain("LATER_REDRAW");

  const restored = new HeadlessTerminal({
    cols: snapshot.geometry.cols,
    rows: snapshot.geometry.rows,
    scrollback: 5000,
    allowProposedApi: true,
  });
  const expected = new HeadlessTerminal({
    cols: 12,
    rows: 4,
    scrollback: 5000,
    allowProposedApi: true,
  });
  try {
    await writeHeadless(expected, before);
    expected.resize(8, 4);
    await writeHeadless(restored, snapshot.data);
    expect(headlessState(restored)).toEqual(headlessState(expected));
    const later = await h.terminal.snapshot();
    expect(later.geometry).toEqual({ cols: 16, rows: 6, revision: 2 });
    expect(snapshot.geometry).toEqual({ cols: 8, rows: 4, revision: 1 });
    expect(h.outputs.map((output) => Buffer.from(output.bytes).toString())).toEqual([
      before,
      after,
    ]);
  } finally {
    restored.dispose();
    expected.dispose();
  }
});

test("idle geometry revisions at one output seq replay in source order without changing bytes", async () => {
  const h = harnessFor({
    terminalId: "idle-geometry",
    cols: 12,
    rows: 4,
    command: [SH, "-c", "read -r _"],
  });
  const repeated = "abcdefghijklmnopqrstuvwx\r\n";
  injectPtyOutput(h.terminal, repeated);
  const baseline = await h.terminal.snapshot();
  h.terminal.resize(8, 4);
  h.terminal.resize(10, 6);
  h.terminal.resize(12, 4);
  h.terminal.resize(12, 4);
  injectPtyOutput(h.terminal, repeated);
  const redraw = "\u001b[1A\r\u001b[2KFINAL\r\n";
  injectPtyOutput(h.terminal, redraw);

  // Publication is synchronous at enqueue, not deferred behind xterm's parser. All three
  // idle boundaries share seq 1, but each changed grid remains an independent revision.
  expect(
    h.stream.map((record) =>
      "bytes" in record ? { seq: record.seq, bytes: Buffer.from(record.bytes).toString() } : record,
    ),
  ).toEqual([
    { seq: 1, bytes: repeated },
    { seq: 1, geometry: { cols: 8, rows: 4, revision: 1 } },
    { seq: 1, geometry: { cols: 10, rows: 6, revision: 2 } },
    { seq: 1, geometry: { cols: 12, rows: 4, revision: 3 } },
    { seq: 2, bytes: repeated },
    { seq: 3, bytes: redraw },
  ]);
  const final = await h.terminal.snapshot();
  const makeViewer = () =>
    new HeadlessTerminal({ cols: 12, rows: 4, scrollback: 5000, allowProposedApi: true });
  const liveViewer = makeViewer();
  const lateViewer = makeViewer();
  const mirrorViewer = makeViewer();
  try {
    enqueueStream(liveViewer, h.stream);
    await writeHeadless(liveViewer, "");
    await writeHeadless(lateViewer, baseline.data);
    enqueueStream(
      lateViewer,
      h.stream.filter((record) =>
        "bytes" in record
          ? record.seq > baseline.seq
          : record.geometry.revision > baseline.geometry.revision,
      ),
    );
    await writeHeadless(lateViewer, "");
    await writeHeadless(mirrorViewer, final.data);
    expect(headlessState(lateViewer)).toEqual(headlessState(liveViewer));
    expect(headlessState(mirrorViewer)).toEqual(headlessState(liveViewer));
    expect(final.geometry).toEqual({ cols: 12, rows: 4, revision: 3 });
    expect(final.seq).toBe(3);
  } finally {
    liveViewer.dispose();
    lateViewer.dispose();
    mirrorViewer.dispose();
  }
});

test("reattached viewers recover private paste mode at the snapshot watermark", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  // Mixed modes must still reach xterm's built-in bracketed-paste handler.
  injectPtyOutput(h.terminal, "\u001b[?2004;5522h");
  const pendingSnapshot = h.terminal.snapshot();
  injectPtyOutput(h.terminal, "\u001b[?5522l");
  const snapshot = await pendingSnapshot;
  const viewer = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
  const pasteMode = trackTerminalPrivateMode(viewer.parser, 5522);
  const replay = (data: string | Uint8Array): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    viewer.write(data, resolve);
    return promise;
  };
  try {
    await replay(snapshot.data);
    expect(pasteMode.enabled).toBe(true);
    expect(viewer.modes.bracketedPasteMode).toBe(true);
    await replay((await h.terminal.snapshot()).data);
    expect(pasteMode.enabled).toBe(false);
    await replay("\u001b[?5522h\u001bc");
    expect(pasteMode.enabled).toBe(false);
  } finally {
    pasteMode.dispose();
    viewer.dispose();
  }
}, 12000);

test("huge scrollback snapshot stays within machine wire caps and restores", async () => {
  const cols = 300;
  const rows = 24;
  const h = spawn({ cols, rows });
  await h.waitUntil(() => h.outputs.length > 0);

  // More than the mirror's 5000-line scrollback, with nearly every column occupied. An
  // unbounded SerializeAddon snapshot is well above both the 700k base64 field limit and the
  // 1 MiB machine frame cap.
  const wideLine = `${"x".repeat(cols - 1)}\r\n`;
  injectPtyOutput(h.terminal, `${wideLine.repeat(6000)}LATEST_SNAPSHOT_ROW\r\n`);
  const snapshot = await h.terminal.snapshot();
  const encoded = Buffer.from(snapshot.data).toString("base64");
  const message = {
    type: "snapshot",
    terminalId: h.terminal.terminalId,
    seq: snapshot.seq,
    data: encoded,
  } as const;
  const frame = JSON.stringify(message);

  expect(AgentMessageSchema.safeParse(message).success).toBe(true);
  expect(Buffer.byteLength(frame)).toBeLessThan(MAX_SESSION_FRAME_BYTES);
  expect(Buffer.from(encoded, "base64")).toEqual(Buffer.from(snapshot.data));
  expect(Buffer.from(snapshot.data).toString()).toContain("LATEST_SNAPSHOT_ROW");

  // The bounded payload remains a valid xterm serialization, not a byte slice ending inside
  // UTF-8. Restore it into a fresh mirror and prove it can be drained and serialized again.
  const restored = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  restored.loadAddon(serializer);
  const { promise, resolve } = Promise.withResolvers<void>();
  restored.write(snapshot.data, resolve);
  await promise;
  expect(serializer.serialize({ scrollback: 1 }).length).toBeGreaterThan(0);
  restored.dispose();
}, 20000);

test("ring buffer evicts oldest whole chunks under a tiny cap", async () => {
  const h = spawn({ ringCapBytes: 256 });
  await h.waitUntil(() => h.outputs.length > 0);
  // Emit far more than the cap across many PTY reads. The completion marker is written split
  // (`RE""ADY`) so the shell's command-line echo does NOT contain the literal "READY" — only
  // the command's OUTPUT does, so the wait resolves after all `seq` output, not on the echo.
  h.terminal.write('seq 1 100000; echo RE""ADY\n');
  await h.waitUntil(() => h.text().includes("READY"));

  // Eviction happened: the oldest retained chunk is past seq 1, and far fewer chunks are
  // retained than were emitted. (Byte-exact cap behavior is covered by the OutputRing unit
  // test below; PTY chunk sizes are not deterministic.)
  expect(h.terminal.oldestRingSeq).toBeGreaterThan(1);
  expect(h.terminal.ringChunkCount).toBeLessThan(h.terminal.seq);
}, 15000);

test("resize propagates to the PTY (stty size reflects new geometry)", async () => {
  const h = spawn({ cols: 80, rows: 24 });
  await h.waitUntil(() => h.outputs.length > 0);
  h.terminal.resize(120, 40);
  h.terminal.write("stty size\n");
  await h.waitUntil(() => h.text().includes("40 120")); // `stty size` prints "rows cols"
  expect(h.text()).toContain("40 120");
}, 12000);

test("propagates the shell's own exit code", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  h.terminal.write("exit 3\n");
  const { exitCode } = await h.terminal.exited;
  expect(exitCode).toBe(3);
  expect(h.terminal.alive).toBe(false);
}, 12000);

test("kill terminates the PTY and resolves exited; dispose is idempotent", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  const exit = await h.terminal.kill();
  expect(h.terminal.alive).toBe(false);
  // The promise kill returns IS `exited`: one exit, observed once, however it arrived.
  expect(await h.terminal.exited).toBe(exit);
  // No assertion on the code: kill sends SIGTERM (ignored by interactive shells) and closes
  // the master, and whether the shell reads EOF first (exit 0) or takes SIGHUP first (signal,
  // null) is the kernel's race, not this contract's. The code is forwarded as reported (#330).
  h.terminal.dispose();
  h.terminal.dispose(); // idempotent, no throw
}, 12000);

test("OutputRing evicts oldest whole chunks past the cap, never the newest", () => {
  const ring = new OutputRing(10);
  ring.push(1, new Uint8Array(4));
  ring.push(2, new Uint8Array(4));
  expect(ring.bytes).toBe(8);
  expect(ring.length).toBe(2);
  expect(ring.oldestSeq).toBe(1);

  ring.push(3, new Uint8Array(4)); // 12 > 10 → evict seq 1
  expect(ring.bytes).toBe(8);
  expect(ring.length).toBe(2);
  expect(ring.oldestSeq).toBe(2);
  expect(ring.newestSeq).toBe(3);

  ring.push(4, new Uint8Array(50)); // a lone over-cap chunk is retained by itself
  expect(ring.length).toBe(1);
  expect(ring.oldestSeq).toBe(4);
  expect(ring.bytes).toBe(50);
});

test("resolveShellCommand prefers $SHELL, else finds a real shell on PATH (no /bin/bash)", () => {
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = "/custom/login/shell";
    expect(resolveShellCommand()).toEqual(["/custom/login/shell"]);

    delete process.env.SHELL;
    const resolved = resolveShellCommand();
    expect(resolved).toHaveLength(1);
    const shell = resolved[0];
    // The NixOS defect: the fallback must never be the nonexistent literal /bin/bash.
    expect(shell).not.toBe("/bin/bash");
    expect(shell !== undefined && existsSync(shell)).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test("opens a PTY via PATH discovery when SHELL is unset (no command override)", async () => {
  const saved = process.env.SHELL;
  delete process.env.SHELL;
  try {
    // No `command` override → PtyTerminal must resolve a shell itself (bash/sh on PATH).
    const h = harnessFor({ terminalId: "no-shell", cols: 80, rows: 24 });
    await h.waitUntil(() => h.outputs.length > 0); // PTY opened and the shell produced output
    expect(h.terminal.alive).toBe(true);
    // Split marker so only the command OUTPUT (not the echoed input line) matches: real I/O.
    h.terminal.write('echo SHELL""_OK\n');
    await h.waitUntil(() => h.text().includes("SHELL_OK"));
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
}, 12000);

test("spawn failure disposes the mirror allocated during construction", () => {
  let disposed = false;
  class DisposeSpyTerminal extends HeadlessTerminal {
    override dispose(): void {
      disposed = true;
      super.dispose();
    }
  }

  expect(
    () =>
      new PtyTerminal({
        terminalId: "spawn-failure",
        cols: 80,
        rows: 24,
        cwd: "/definitely/missing/manifold-agent-cwd",
        command: [BASH, "--norc", "-i"],
        onOutput: () => {},
        createMirror: (options) => new DisposeSpyTerminal(options),
      }),
  ).toThrow(`program or working directory not found: ${BASH}`);
  expect(disposed).toBe(true);
});

test("a failed PATH lookup retains the precise missing-program reason", () => {
  const program = "manifold-definitely-missing-program";
  expect(
    () =>
      new PtyTerminal({
        terminalId: "path-spawn-failure",
        cols: 80,
        rows: 24,
        command: [program],
        onOutput: () => {},
      }),
  ).toThrow(`program not found: ${program}`);
});
