import { describe, expect, test } from "bun:test";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
const CLIENT = new URL("./client.ts", import.meta.url).pathname;
const BYTES = 2 * 1_048_576;
/** Bytes another writer queued ahead of the executable's output: more than any pipe holds. */
const PREFILL = 4 * 1_048_576;
/** How long a child that should exit at its 300 ms drain bound may take before it is killed. */
const EXIT_GUARD_MS = 5_000;
/** The child's environment, without any inherited Manifold binding. */
const UNBOUND = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("MANIFOLD_")),
);
/** Every child reports on file descriptor 3, which the fixtures wire to this test. */
const REPORT_EXIT = `process.on("exit", (code) => writeSync(3, \`exited \${code}\`));`;

// The executable's real process.stdout: 2 MiB is handed over in one write, far beyond a pipe's
// buffer, then settled. The child reports its settle outcome, then exits and reports that.
const SETTLE_STDOUT = `import { writeSync } from "node:fs";
import { LocalOutputError } from ${JSON.stringify(CLIENT)};
import { processStdio } from ${JSON.stringify(MAIN)};
${REPORT_EXIT}
const stdio = processStdio(Number(process.env["DRAIN_MS"]));
stdio.stdout(Buffer.alloc(${BYTES}, 97));
let outcome = "settled";
try {
  await stdio.settle();
} catch (error) {
  outcome = error instanceof LocalOutputError ? error.reason : "unexpected";
}
writeSync(3, \`\${outcome} \`);
process.exit(0);`;

/**
 * The real executable entry with a 300 ms drain bound instead of 10 s, behind bytes another
 * writer already queued on `full`: its pipe is full before the run writes anything.
 */
const executable = (args: readonly string[], full: "stdout" | "stderr") =>
  `import { writeSync } from "node:fs";
import { runExecutable } from ${JSON.stringify(MAIN)};
${REPORT_EXIT}
process.${full}.write(Buffer.alloc(${PREFILL}));
await runExecutable(${JSON.stringify(args)}, 300);`;

const EXITED = /exited \d+$/;

/** Reads `stream` until the child reported its exit, or until the stream ends. */
async function reportFrom(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let report = "";
  while (!EXITED.test(report)) {
    const { done, value } = await reader.read();
    if (done) break;
    report += Buffer.from(value).toString();
  }
  reader.releaseLock();
  return report;
}

/** Runs the child with its stdout piped into `consumer`; resolves its report and what was read. */
async function settleInto(consumer: string, drainMs: number) {
  const shell = Bun.spawn(
    ["/bin/sh", "-c", `"$0" -e "$1" 3>&2 | ${consumer}`, process.execPath, SETTLE_STDOUT],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DRAIN_MS: String(drainMs) },
    },
  );
  const report = await reportFrom(shell.stderr);
  const consumed = await new Response(shell.stdout).text();
  await shell.exited;
  return { report, consumed: consumed.trim() };
}

/**
 * Runs `script` with its `unread` stream on an anonymous pipe that `sleep` holds open and never
 * reads, and its report on a pipe to this test. Resolves what it reported before
 * {@link EXIT_GUARD_MS}; its whole process group is killed then, a child still waiting too.
 */
async function reportAgainstUnreadPipe(script: string, unread: "stdout" | "stderr") {
  const wiring = unread === "stdout" ? "2>/dev/null" : "2>&1 >/dev/null";
  const shell = Bun.spawn(
    [
      "/bin/sh",
      "-c",
      `exec 4>&1; "$0" -e "$1" ${wiring} 3>&4 4>&- | exec sleep 60 >/dev/null 4>&-`,
      process.execPath,
      script,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
      env: { ...UNBOUND, DRAIN_MS: "300" },
    },
  );
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    process.kill(-shell.pid, "SIGKILL");
  };
  const guard = setTimeout(kill, EXIT_GUARD_MS);
  try {
    return await reportFrom(shell.stdout);
  } finally {
    clearTimeout(guard);
    kill();
    await shell.exited;
  }
}

// These consumers are separate processes on the platform clock; the bounds are real time.
describe("manifold local output", () => {
  test("settling waits for a slow consumer to take every byte", async () => {
    expect(await settleInto("(sleep 1; wc -c)", 10_000)).toEqual({
      report: "settled exited 0",
      consumed: String(BYTES),
    });
  });

  test("a consumer that closes after the output was handed over is a failure", async () => {
    expect((await settleInto("head -c 65536 >/dev/null", 10_000)).report).toBe("failed exited 0");
  });

  test("a consumer that never reads is reported stalled at the bound", async () => {
    expect(await reportAgainstUnreadPipe(SETTLE_STDOUT, "stdout")).toBe("stalled exited 0");
  }, 15_000);

  test("an ssh failure's diagnostic behind a full, unread stderr cannot hold the executable", async () => {
    expect(
      await reportAgainstUnreadPipe(executable(["ssh", "machine", "true"], "stderr"), "stderr"),
    ).toBe("exited 255");
  }, 15_000);

  test("output behind a full, unread stdout cannot hold the executable", async () => {
    expect(await reportAgainstUnreadPipe(executable(["--help"], "stdout"), "stdout")).toBe(
      "exited 1",
    );
  }, 15_000);
});
