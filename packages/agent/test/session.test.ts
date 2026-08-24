import { existsSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { AgentMessageSchema, MAX_SESSION_FRAME_BYTES } from "@manifold/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import {
  OutputRing,
  PtySession,
  resolveShellCommand,
  type PtyOutput,
  type PtySessionOptions,
} from "../src/session.ts";

/**
 * Real-PTY unit tests. AGENTS.md invariant 7 permits the agent's PTY tests to spawn real
 * shells (this machine supports Bun.Terminal). We pin `bash --norc -i` for determinism
 * instead of inheriting the ambient login shell.
 *
 * No fixed delays: the harness resolves waiters from the `onOutput` callback the instant the
 * awaited condition holds (the real signal is the byte stream itself, which exposes no
 * event emitter to await otherwise). Each test's per-run timeout is the only backstop.
 */

const BASH = Bun.which("bash") ?? "/bin/sh";
const SHELL_COMMAND = [BASH, "--norc", "-i"] as const;

interface Harness {
  readonly session: PtySession;
  readonly outputs: PtyOutput[];
  readonly text: () => string;
  /** Resolves as soon as accumulated output satisfies `predicate` (checked per chunk). */
  readonly waitUntil: (predicate: () => boolean) => Promise<void>;
}

const live: PtySession[] = [];

function harnessFor(opts: Omit<PtySessionOptions, "onOutput">): Harness {
  const outputs: PtyOutput[] = [];
  const decoder = new TextDecoder();
  const waiters = new Set<{ predicate: () => boolean; resolve: () => void }>();
  let buffer = "";

  const session = new PtySession({
    ...opts,
    onOutput: (output) => {
      outputs.push(output);
      buffer += decoder.decode(output.bytes, { stream: true });
      for (const waiter of waiters) {
        if (waiter.predicate()) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
  });
  live.push(session);

  const waitUntil = (predicate: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    if (predicate()) resolve();
    else waiters.add({ predicate, resolve });
    return promise;
  };

  return { session, outputs, text: () => buffer, waitUntil };
}

/** Convenience: a harness whose PTY runs the pinned deterministic shell. */
function spawn(opts: {
  cols?: number;
  rows?: number;
  ringCapBytes?: number;
  env?: Record<string, string>;
}): Harness {
  return harnessFor({
    sessionId: "test-session",
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
 * this seam makes that production ordering observable without changing PtySession's API.
 */
function injectPtyOutput(session: PtySession, data: string): void {
  const target: unknown = session;
  if (
    typeof target !== "object" ||
    target === null ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  ) {
    throw new Error("PtySession ingest callback is unavailable");
  }
  target.ingest.call(target, new TextEncoder().encode(data));
}

afterEach(async () => {
  for (const session of live) {
    try {
      await session.kill();
    } catch {
      // already exited
    }
    session.dispose();
  }
  live.length = 0;
});

test("echo round-trip yields strictly monotonic seq from 1", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0); // shell initialized (emitted its prompt)
  h.session.write("echo MARK_$((2+2))\n");
  await h.waitUntil(() => h.text().includes("MARK_4"));

  const seqs = h.outputs.map((output) => output.seq);
  // strictly monotonic AND contiguous from 1 (seq is assigned +1 per emission).
  expect(seqs).toEqual(seqs.map((_value, index) => index + 1));
  expect(seqs[0]).toBe(1);
}, 12000);

test("real PTY receives session env without inheriting machine credentials", async () => {
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
        MANIFOLD_URL: "https://session.invalid",
        MANIFOLD_PAD: "pad-test",
        MANIFOLD_ELEMENT: "element-test",
        MANIFOLD_TOKEN: "session-token-safe-for-child",
      },
    });
    await h.waitUntil(() => h.outputs.length > 0);
    // Split the completion marker in the echoed command so the wait resolves only after env
    // has printed every child variable, not when the interactive shell echoes our input.
    h.session.write('env; printf "\\nENV_DUMP_""DONE\\n"\n');
    await h.waitUntil(() => h.text().includes("ENV_DUMP_DONE"));

    const output = h.text();
    // Compare booleans so a regression failure never dumps the process environment (and its
    // unrelated ambient secrets) into test output.
    expect(output.includes("MANIFOLD_URL=https://session.invalid")).toBe(true);
    expect(output.includes("MANIFOLD_PAD=pad-test")).toBe(true);
    expect(output.includes("MANIFOLD_ELEMENT=element-test")).toBe(true);
    expect(output.includes("MANIFOLD_TOKEN=session-token-safe-for-child")).toBe(true);
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
  h.session.write("echo AAA\n");
  await h.waitUntil(() => h.text().includes("AAA"));

  // SAME TICK: read the watermark, then snapshot. snapshot() captures currentSeq
  // synchronously on entry, so no data callback can interleave between these two statements.
  const lastSeq = h.session.seq;
  const snapshot = await h.session.snapshot();
  expect(snapshot.seq).toBe(lastSeq);
  // snapshot() drains the mirror through `seq`, so the rendered data includes AAA exactly.
  expect(snapshot.data).toContain("AAA");

  const before = h.outputs.length;
  h.session.write("echo BBB\n");
  await h.waitUntil(() => h.text().includes("BBB"));
  const laterOutputs = h.outputs.slice(before);
  expect(laterOutputs.length).toBeGreaterThan(0);
  for (const output of laterOutputs) expect(output.seq).toBeGreaterThan(snapshot.seq);
}, 12000);

test("snapshot excludes output queued after its drain marker", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);

  injectPtyOutput(h.session, "\r\nSNAPSHOT_BEFORE\r\n");
  const preAfterSeq = h.session.seq;
  const pendingSnapshot = h.session.snapshot();
  injectPtyOutput(h.session, "\r\nSNAPSHOT_AFTER\r\n");

  const snapshot = await pendingSnapshot;
  expect(snapshot.seq).toBe(preAfterSeq);
  expect(snapshot.data).toContain("SNAPSHOT_BEFORE");
  expect(snapshot.data).not.toContain("SNAPSHOT_AFTER");
  expect(h.session.seq).toBeGreaterThan(snapshot.seq);
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
  injectPtyOutput(h.session, `${wideLine.repeat(6000)}LATEST_SNAPSHOT_ROW\r\n`);
  const snapshot = await h.session.snapshot();
  const encoded = Buffer.from(snapshot.data, "utf8").toString("base64");
  const message = {
    type: "snapshot",
    sessionId: h.session.sessionId,
    seq: snapshot.seq,
    data: encoded,
  } as const;
  const frame = JSON.stringify(message);

  expect(AgentMessageSchema.safeParse(message).success).toBe(true);
  expect(Buffer.byteLength(frame)).toBeLessThan(MAX_SESSION_FRAME_BYTES);
  expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(snapshot.data);
  expect(snapshot.data.includes("LATEST_SNAPSHOT_ROW")).toBe(true);

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
  h.session.write('seq 1 100000; echo RE""ADY\n');
  await h.waitUntil(() => h.text().includes("READY"));

  // Eviction happened: the oldest retained chunk is past seq 1, and far fewer chunks are
  // retained than were emitted. (Byte-exact cap behavior is covered by the OutputRing unit
  // test below; PTY chunk sizes are not deterministic.)
  expect(h.session.oldestRingSeq).toBeGreaterThan(1);
  expect(h.session.ringChunkCount).toBeLessThan(h.session.seq);
}, 15000);

test("resize propagates to the PTY (stty size reflects new geometry)", async () => {
  const h = spawn({ cols: 80, rows: 24 });
  await h.waitUntil(() => h.outputs.length > 0);
  h.session.resize(120, 40);
  h.session.write("stty size\n");
  await h.waitUntil(() => h.text().includes("40 120")); // `stty size` prints "rows cols"
  expect(h.text()).toContain("40 120");
}, 12000);

test("propagates the shell's own exit code", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  h.session.write("exit 3\n");
  const { exitCode } = await h.session.exited;
  expect(exitCode).toBe(3);
  expect(h.session.alive).toBe(false);
}, 12000);

test("kill terminates the PTY and resolves exited; dispose is idempotent", async () => {
  const h = spawn({});
  await h.waitUntil(() => h.outputs.length > 0);
  const exit = await h.session.kill();
  expect(h.session.alive).toBe(false);
  // Interactive shells ignore SIGTERM; the PTY close delivers SIGHUP → signal death → null.
  expect(exit.exitCode).toBeNull();
  h.session.dispose();
  h.session.dispose(); // idempotent, no throw
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
    // No `command` override → PtySession must resolve a shell itself (bash/sh on PATH).
    const h = harnessFor({ sessionId: "no-shell", cols: 80, rows: 24 });
    await h.waitUntil(() => h.outputs.length > 0); // PTY opened and the shell produced output
    expect(h.session.alive).toBe(true);
    // Split marker so only the command OUTPUT (not the echoed input line) matches: real I/O.
    h.session.write('echo SHELL""_OK\n');
    await h.waitUntil(() => h.text().includes("SHELL_OK"));
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
}, 12000);
