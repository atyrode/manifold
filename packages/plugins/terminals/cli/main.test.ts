import { describe, expect, test } from "bun:test";

const MAIN = new URL("./main.ts", import.meta.url).pathname;
const CLIENT = new URL("./client.ts", import.meta.url).pathname;
const BYTES = 2 * 1_048_576;

// The executable's real process.stdout: 2 MiB is handed over in one write, far beyond a pipe's
// buffer, then settled. The child reports its settle outcome on stderr, and its exit too.
const CHILD = `import { writeSync } from "node:fs";
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
writeSync(2, outcome);`;

/** Runs the child with its stdout piped into `consumer`; resolves stderr once it has `until`. */
async function settleInto(consumer: string, drainMs: number, until: string) {
  const shell = Bun.spawn(
    ["/bin/sh", "-c", `"$0" -e "$1" | ${consumer}`, process.execPath, CHILD],
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

// These consumers are separate processes on the platform clock; the bounds are real time.
describe("manifold ssh local output", () => {
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

  test("a consumer that stops reading is abandoned at the bound, and the process still exits", async () => {
    expect((await settleInto("sleep 3", 300, "exited")).report).toBe("stalled exited");
  });
});
