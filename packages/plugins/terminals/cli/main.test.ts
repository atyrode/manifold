import { describe, expect, test } from "bun:test";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
const CLIENT = new URL("./client.ts", import.meta.url).pathname;
const BYTES = 2 * 1_048_576;
/** How long a child that should exit at its 300 ms drain bound may take before it is killed. */
const EXIT_GUARD_MS = 5_000;
/** The child's environment, without any inherited Manifold binding. */
const UNBOUND = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("MANIFOLD_")),
);

// The executable's real process.stdout: 2 MiB is handed over in one write, far beyond a pipe's
// buffer, then settled. The child reports its settle outcome on stderr, then exits as the
// executable does, and reports that too.
const SETTLE_STDOUT = `import { writeSync } from "node:fs";
import { LocalOutputError } from ${JSON.stringify(CLIENT)};
import { processStdio } from ${JSON.stringify(MAIN)};
process.on("exit", () => writeSync(2, " exited"));
const stdio = processStdio(Number(process.env["DRAIN_MS"]));
stdio.stdout(Buffer.alloc(${BYTES}, 97));
let outcome = "settled";
try {
  await stdio.settle();
} catch (error) {
  outcome = error instanceof LocalOutputError ? error.reason : "unexpected";
}
writeSync(2, outcome);
process.exit(0);`;

/** The real executable entry with a 300 ms drain bound instead of 10 s. */
const executable = (
  args: readonly string[],
) => `import { runExecutable } from ${JSON.stringify(MAIN)};
await runExecutable(${JSON.stringify(args)}, 300);`;

/** Runs the child with its stdout piped into `consumer`; resolves stderr once it has `until`. */
async function settleInto(consumer: string, drainMs: number, until: string) {
  const shell = Bun.spawn(
    ["/bin/sh", "-c", `"$0" -e "$1" | ${consumer}`, process.execPath, SETTLE_STDOUT],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DRAIN_MS: String(drainMs) },
    },
  );
  const reader = shell.stderr.getReader();
  let report = "";
  while (!report.includes(until)) {
    const { done, value } = await reader.read();
    if (done) break;
    report += Buffer.from(value).toString();
  }
  reader.releaseLock();
  const consumed = await new Response(shell.stdout).text();
  await shell.exited;
  return { report, consumed: consumed.trim() };
}

/**
 * Runs `script` with one stream on a FIFO whose read end stays open and is never read,
 * optionally filled to capacity first. Resolves whether the child exited by itself before
 * {@link EXIT_GUARD_MS} (a child still running is killed), its status and its other stream.
 */
async function againstUnreadFifo(script: string, unread: "stdout" | "stderr", prefill: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "manifold-ssh-fifo-"));
  try {
    const fifo = join(dir, "unread");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const held = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (prefill) {
        // Every byte is taken by the kernel, none is read: the next write has to wait.
        const filler = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        try {
          for (;;) writeSync(filler, Buffer.alloc(4096));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EAGAIN")) throw error;
        } finally {
          closeSync(filler);
        }
      }
      const writer = openSync(fifo, constants.O_WRONLY);
      const child = Bun.spawn([process.execPath, "-e", script], {
        stdio: [
          "ignore",
          unread === "stdout" ? writer : "pipe",
          unread === "stderr" ? writer : "pipe",
        ],
        env: { ...UNBOUND, DRAIN_MS: "300" },
      });
      closeSync(writer);
      const guard = Promise.withResolvers<false>();
      const timer = setTimeout(() => guard.resolve(false), EXIT_GUARD_MS);
      const exited = await Promise.race([child.exited.then(() => true), guard.promise]);
      clearTimeout(timer);
      if (!exited) child.kill("SIGKILL");
      const other = unread === "stdout" ? child.stderr : child.stdout;
      if (!(other instanceof ReadableStream)) throw new Error("the reported stream is not piped");
      const report = await new Response(other).text();
      return { exited, status: await child.exited, report };
    } finally {
      closeSync(held);
    }
  } finally {
    await rm(dir, { recursive: true });
  }
}

// These consumers are separate processes on the platform clock; the bounds are real time.
describe("manifold local output", () => {
  test("settling waits for a slow consumer to take every byte", async () => {
    expect(await settleInto("(sleep 1; wc -c)", 10_000, "exited")).toEqual({
      report: "settled exited",
      consumed: String(BYTES),
    });
  });

  test("a consumer that closes after the output was handed over is a failure", async () => {
    expect((await settleInto("head -c 65536 >/dev/null", 10_000, "exited")).report).toBe(
      "failed exited",
    );
  });

  test("a consumer that never reads is reported stalled at the bound", async () => {
    expect(await againstUnreadFifo(SETTLE_STDOUT, "stdout", false)).toEqual({
      exited: true,
      status: 0,
      report: "stalled exited",
    });
  }, 15_000);

  test("an ssh failure's diagnostic behind a full, unread stderr cannot hold the executable", async () => {
    expect(await againstUnreadFifo(executable(["ssh", "machine", "true"]), "stderr", true)).toEqual(
      { exited: true, status: 255, report: "" },
    );
  }, 15_000);

  test("output behind a full, unread stdout cannot hold the executable", async () => {
    expect(await againstUnreadFifo(executable(["--help"]), "stdout", true)).toEqual({
      exited: true,
      status: 1,
      report: "",
    });
  }, 15_000);
});
