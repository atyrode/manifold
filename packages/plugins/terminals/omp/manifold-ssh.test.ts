import { describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import factory from "./manifold-ssh";

interface FixtureOptions {
  receipt?: Record<string, unknown>;
  receiptKind?: "symlink" | "nonprivate";
  stdout?: string;
  stderr?: string;
  localStderr?: string;
  status?: number;
  waitForCancellation?: boolean;
}

interface ToolConsumer {
  execute(
    id: string,
    params: { target: string; command: string },
    onUpdate: undefined,
    context: undefined,
    signal?: AbortSignal,
  ): Promise<{ details: unknown; isError?: boolean }>;
}

// These tests exercise subprocess receipt authority, not schema construction.
// The artifact is separately loaded with the exact host's injected omptype/Zod facade.
class FixtureSchema<T> {
  declare readonly _output: T;
  optional(): FixtureSchema<T | undefined> {
    return this;
  }
  describe(_description: string) {
    return this;
  }
  strict() {
    return this;
  }
}
const zod = {
  string: () => new FixtureSchema<string>(),
  number: () => new FixtureSchema<number>(),
  object: (_shape: Record<string, unknown>) => new FixtureSchema<unknown>(),
};

// Real subprocesses cross the receipt boundary; no network, provider, session, or model calls.
async function withCli(
  options: FixtureOptions,
  consume: (tool: ToolConsumer, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "manifold-omp-test-"));
  const executable = join(directory, "manifold");
  const config = JSON.stringify({
    ...options,
    directory,
    marker: join(directory, "receipt-path"),
    ready: join(directory, "ready"),
    signalled: join(directory, "signalled"),
  });
  await writeFile(
    executable,
    `#!${process.execPath}
import { watch, writeFileSync, symlinkSync, chmodSync } from "node:fs";
const config = ${config};
if (process.argv[2] === "context") {
  console.log(JSON.stringify({ type: "context", ok: true, binding: "terminal", remoteShellLaunch: "not_probed" }));
  process.exit(0);
}
const receiptPath = process.argv[process.argv.indexOf("--receipt") + 1];
writeFileSync(config.marker, receiptPath);
function complete() {
  process.stdout.write(config.stdout ?? "");
  process.stderr.write(config.stderr ?? "");
  if (config.receipt !== undefined) {
    const data = JSON.stringify(config.receipt);
    if (config.receiptKind === "symlink") {
      const target = config.directory + "/foreign-receipt.json";
      writeFileSync(target, data, { flag: "wx", mode: 0o600 });
      symlinkSync(target, receiptPath);
    } else {
      writeFileSync(receiptPath, data, { flag: "wx", mode: config.receiptKind === "nonprivate" ? 0o644 : 0o600 });
      if (config.receiptKind === "nonprivate") chmodSync(receiptPath, 0o644);
    }
  }
  process.stderr.write(config.localStderr ?? "");
  process.exit(config.status ?? 0);
}
if (config.waitForCancellation) {
  let cancelled = false;
  const keepAlive = watch(config.directory, (_event, filename) => {
    if (cancelled && filename === "release") {
      keepAlive.close();
      complete();
    }
  });
  process.once("SIGTERM", () => {
    cancelled = true;
    writeFileSync(config.signalled, "signalled");
  });
  writeFileSync(config.ready, "ready");
} else complete();
`,
  );
  await chmod(executable, 0o700);
  const oldPath = process.env.PATH;
  let tool: ToolConsumer;
  try {
    process.env.PATH = `${directory}:${oldPath ?? ""}`;
    const loaded = await factory({ cwd: directory, zod });
    if (Array.isArray(loaded))
      throw new Error("The ordinary fixture CLI did not register the tool.");
    tool = loaded;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
  try {
    await consume(tool, directory);
  } finally {
    if (options.waitForCancellation) await writeFile(join(directory, "release"), "release");
    await rm(directory, { recursive: true, force: true });
  }
}

function receipt(exitCode: number, stdout = "", stderr = ""): Record<string, unknown> {
  return {
    type: "ssh",
    ok: exitCode === 0,
    requestId: "request-owned",
    terminalId: "terminal-owned",
    machineId: "machine-visible",
    output: {
      mode: "pipes",
      bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      complete: true,
    },
    completion: { state: "exited", exitCode, reason: null },
    cleanup: { state: "confirmed", via: "removal_event", traceId: 37, processStopped: "confirmed" },
    receipts: [{ door: "core.terminals.kill", ok: true, traceId: 37 }],
  };
}

async function failureOf(tool: ToolConsumer, signal?: AbortSignal): Promise<unknown> {
  const result = await tool.execute(
    "call",
    { target: "machine", command: "opaque command" },
    undefined,
    undefined,
    signal,
  );
  expect(result.isError).toBe(true);
  return result.details;
}

async function assertReceiptRemoved(directory: string) {
  const path = (await readFile(join(directory, "receipt-path"), "utf8")).trim();
  await expect(access(dirname(path))).rejects.toThrow();
  // The fixture directory is not owned by the adapter and must remain intact.
  expect(await readFile(join(directory, "receipt-path"), "utf8")).toBe(path);
}

async function waitForMarker(directory: string, name: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  // Subscribe before checking so a marker created during setup cannot be missed.
  const watcher = watch(directory, (_event, filename) => {
    if (filename === name) resolve();
  });
  try {
    try {
      await access(join(directory, name));
      resolve();
    } catch {
      // Await the actual child event rather than a polling sleep.
    }
    await promise;
  } finally {
    watcher.close();
  }
}

describe("manifold_ssh receipt authority", () => {
  test.each(["symlink", "nonprivate"] as const)(
    "a %s receipt cannot authorize a successful result",
    async (receiptKind) => {
      const supplied = receipt(0);
      await withCli({ receipt: supplied, receiptKind }, async (tool, directory) => {
        expect(await failureOf(tool)).toMatchObject({
          ok: false,
          exitCode: null,
          diagnostic: { code: "receipt_unavailable" },
          receipt: null,
          cleanup: { state: "unconfirmed", processStopped: "unconfirmed" },
          local: { receiptDirectoryRemoved: true },
        });
        await assertReceiptRemoved(directory);
        if (receiptKind === "symlink")
          expect(
            JSON.parse(await readFile(join(directory, "foreign-receipt.json"), "utf8")),
          ).toEqual(supplied);
      });
    },
  );

  test("an authoritative remote 255, even diagnostic-looking remote stderr, is an ordinary result", async () => {
    const stdout = "ordinary output λ\n";
    const stderr = "manifold: receipt_failed: this line belongs to the remote command\n";
    await withCli(
      { receipt: receipt(255, stdout, stderr), stdout, stderr, status: 255 },
      async (tool, directory) => {
        const result = await tool.execute(
          "call",
          { target: "machine", command: "opaque command" },
          undefined,
          undefined,
        );
        expect(result.isError).not.toBe(true);
        expect(result.details).toMatchObject({
          ok: true,
          exitCode: 255,
          stdout,
          stderr,
          cleanup: { state: "confirmed", processStopped: "confirmed", traceId: 37 },
          receipt: { ok: false, receipts: [{ traceId: 37 }] },
        });
        await assertReceiptRemoved(directory);
      },
    );
  });

  test("a local receipt write failure cannot masquerade as the saved remote 255", async () => {
    await withCli(
      {
        receipt: receipt(255),
        status: 255,
        localStderr: "manifold: receipt_failed: private receipt close failed\n",
      },
      async (tool, directory) => {
        expect(await failureOf(tool)).toMatchObject({
          diagnostic: { code: "receipt_failed" },
          exitCode: 255,
          cliExitCode: 255,
          cleanup: { state: "confirmed", processStopped: "confirmed", traceId: 37 },
          local: { receiptDirectoryRemoved: true },
        });
        await assertReceiptRemoved(directory);
      },
    );
  });

  test("opaque CLI refusals preserve authorized visibility without becoming remote exit 255", async () => {
    const refused = {
      ...receipt(255),
      diagnostic: { code: "shell_spawn_not_delegated", message: "opaque admission refusal" },
      authorizedOnlineMachines: [{ id: "visible-id", name: "visible-name" }],
    };
    await withCli({ receipt: refused, status: 255 }, async (tool, directory) => {
      expect(await failureOf(tool)).toMatchObject({
        diagnostic: refused.diagnostic,
        receipt: {
          authorizedOnlineMachines: refused.authorizedOnlineMachines,
          receipts: [{ traceId: 37 }],
        },
      });
      await assertReceiptRemoved(directory);
    });
  });

  test("unconfirmed removal is an error even when a remote status is known", async () => {
    const uncertain = {
      ...receipt(7),
      cleanup: { state: "unconfirmed", via: "kill", traceId: 38, processStopped: "unconfirmed" },
    };
    await withCli({ receipt: uncertain, status: 7 }, async (tool) => {
      expect(await failureOf(tool)).toMatchObject({
        diagnostic: { code: "cleanup_unconfirmed" },
        exitCode: 7,
        cleanup: uncertain.cleanup,
      });
    });
  });

  test("contradictory command cessation cannot turn confirmed hub removal into success", async () => {
    const uncertain = {
      ...receipt(0),
      cleanup: { state: "confirmed", via: "kill", traceId: 39, processStopped: "unconfirmed" },
    };
    await withCli({ receipt: uncertain }, async (tool) => {
      expect(await failureOf(tool)).toMatchObject({
        diagnostic: { code: "completion_unknown" },
        cleanup: uncertain.cleanup,
      });
    });
  });

  test.each([
    {
      label: "unknown completion",
      completion: { state: "unknown", exitCode: 0, reason: null },
      code: "completion_unknown",
    },
    { label: "missing owned terminal identity", terminalId: null, code: "completion_unknown" },
    {
      label: "missing cessation evidence",
      cleanup: { state: "confirmed", via: "kill", traceId: 39 },
      code: "completion_unknown",
    },
    {
      label: "owner loss",
      completion: { state: "exited", exitCode: 0, reason: "owner_lost" },
      code: "completion_unknown",
    },
    {
      label: "incomplete output",
      output: { mode: "pipes", bytes: 0, stdoutBytes: 0, stderrBytes: 0, complete: false },
      code: "output_incomplete",
    },
  ])("$label remains an error despite receipt.ok", async ({ label: _label, code, ...metadata }) => {
    await withCli({ receipt: { ...receipt(0), ...metadata } }, async (tool) => {
      expect(await failureOf(tool)).toMatchObject({ diagnostic: { code } });
    });
  });

  test("a CLI status mismatch is not an ordinary remote exit", async () => {
    await withCli({ receipt: receipt(0), status: 255 }, async (tool) => {
      expect(await failureOf(tool)).toMatchObject({
        diagnostic: { code: "completion_unknown" },
        exitCode: 0,
        cliExitCode: 255,
      });
    });
  });

  test("local output loss cannot be hidden by a complete remote receipt", async () => {
    await withCli({ receipt: receipt(0, "missing bytes") }, async (tool) => {
      expect(await failureOf(tool)).toMatchObject({
        diagnostic: { code: "local_output_failed" },
        stdout: "",
      });
    });
  });

  test("cancellation waits for cleanup evidence and preserves uncertainty with both final streams", async () => {
    const stdout = "before cancellation\n";
    const stderr = "cleanup settled\n";
    const cancelled = {
      ...receipt(143, stdout, stderr),
      diagnostic: { code: "cancelled", message: "CLI attempted scoped command cleanup" },
      cleanup: { state: "unconfirmed", via: "kill", traceId: 37, processStopped: "unconfirmed" },
      output: {
        mode: "pipes",
        bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
        stdoutBytes: Buffer.byteLength(stdout),
        stderrBytes: Buffer.byteLength(stderr),
        complete: false,
      },
    };
    await withCli(
      { receipt: cancelled, stdout, stderr, status: 255, waitForCancellation: true },
      async (tool, directory) => {
        const controller = new AbortController();
        const ready = waitForMarker(directory, "ready");
        let settled = false;
        const result = failureOf(tool, controller.signal).then((value) => {
          settled = true;
          return value;
        });
        await ready;
        const signalled = waitForMarker(directory, "signalled");
        controller.abort();
        await signalled;
        expect(settled).toBe(false);
        await writeFile(join(directory, "release"), "release");
        expect(await result).toMatchObject({
          diagnostic: cancelled.diagnostic,
          stdout,
          stderr,
          cleanup: { state: "unconfirmed", processStopped: "unconfirmed", traceId: 37 },
          local: { cancelRequested: true, receiptDirectoryRemoved: true },
        });
        await assertReceiptRemoved(directory);
      },
    );
  });

  test("a cancellation race does not overwrite a fully authoritative ordinary result", async () => {
    await withCli(
      { receipt: receipt(7), status: 7, waitForCancellation: true },
      async (tool, directory) => {
        const controller = new AbortController();
        const ready = waitForMarker(directory, "ready");
        const result = tool.execute(
          "call",
          { target: "machine", command: "opaque command" },
          undefined,
          undefined,
          controller.signal,
        );
        await ready;
        const signalled = waitForMarker(directory, "signalled");
        controller.abort();
        await signalled;
        await writeFile(join(directory, "release"), "release");
        expect((await result).details).toMatchObject({
          ok: true,
          exitCode: 7,
          cleanup: { state: "confirmed", processStopped: "confirmed" },
          local: { cancelRequested: true },
        });
        await assertReceiptRemoved(directory);
      },
    );
  });

  test("cancellation before invocation never claims a started or cleaned remote process", async () => {
    await withCli({}, async (tool, directory) => {
      const controller = new AbortController();
      controller.abort();
      expect(await failureOf(tool, controller.signal)).toMatchObject({
        diagnostic: { code: "cancelled" },
        receipt: null,
        cleanup: { state: "not_needed", processStopped: "not_started", traceId: null },
        local: { cancelRequested: true, receiptDirectoryRemoved: true },
      });
      await expect(access(join(directory, "receipt-path"))).rejects.toThrow();
    });
  });
});
