import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// Only the injected schema methods this factory uses, not a mirrored host SDK.
interface OmpSchema<T> {
  readonly _output: T;
  optional(): OmpSchema<T | undefined>;
  describe(description: string): OmpSchema<T>;
}

interface FactoryHost {
  cwd: string;
  zod: {
    string(): OmpSchema<string>;
    number(): OmpSchema<number>;
    object<S extends Record<string, OmpSchema<unknown>>>(
      shape: S,
    ): OmpSchema<unknown> & { strict(): OmpSchema<unknown> };
  };
}

interface SshParameters {
  target: string;
  command: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface Diagnostic {
  code: string;
  message: string;
}

interface Cleanup {
  state: "confirmed" | "unconfirmed" | "not_needed";
  via: string | null;
  traceId: number | null;
  processStopped: "confirmed" | "unconfirmed" | "not_started";
}

interface SshReceipt extends Record<string, unknown> {
  type: "ssh";
  ok: boolean;
  requestId: string | null;
  terminalId: string | null;
  machineId: string | null;
  diagnostic?: Diagnostic;
  output: {
    mode: "pipes";
    bytes: number;
    stdoutBytes: number;
    stderrBytes: number;
    complete: boolean;
  };
  completion: {
    state: "exited" | "unknown" | "not_started";
    exitCode: number | null;
    reason: string | null;
  };
  cleanup: Cleanup;
  receipts: {
    door: string;
    ok: boolean | null;
    traceId: number | null;
    rule?: string;
    status?: number;
  }[];
  authorizedOnlineMachines?: { id: string; name: string }[];
}

interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  started: boolean;
  cancelRequested: boolean;
  outputDrained: boolean;
  stdinDelivered: boolean;
  error: string | null;
}

interface Evidence {
  type: "manifold_ssh";
  ok: boolean;
  target: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  cliExitCode: number | null;
  cliSignal: NodeJS.Signals | null;
  diagnostic?: Diagnostic;
  receipt: Record<string, unknown> | null;
  cleanup: Cleanup;
  local: {
    cancelRequested: boolean;
    outputDrained: boolean;
    stdinDelivered: boolean;
    receiptDirectoryRemoved: boolean;
    error: string | null;
  };
}

const LOCAL_DRAIN_MS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(value: unknown): value is Diagnostic {
  return record(value) && typeof value.code === "string" && typeof value.message === "string";
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function byteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cleanup(value: unknown): value is Cleanup {
  return (
    record(value) &&
    (value.state === "confirmed" ||
      value.state === "unconfirmed" ||
      value.state === "not_needed") &&
    nullableString(value.via) &&
    nullableInteger(value.traceId) &&
    (value.processStopped === "confirmed" ||
      value.processStopped === "unconfirmed" ||
      value.processStopped === "not_started")
  );
}

function sshReceipt(value: unknown): value is SshReceipt {
  if (!record(value) || value.type !== "ssh" || typeof value.ok !== "boolean") return false;
  const output = value.output;
  const completion = value.completion;
  return (
    nullableString(value.requestId) &&
    nullableString(value.terminalId) &&
    nullableString(value.machineId) &&
    (value.diagnostic === undefined || diagnostic(value.diagnostic)) &&
    record(output) &&
    output.mode === "pipes" &&
    byteCount(output.bytes) &&
    byteCount(output.stdoutBytes) &&
    byteCount(output.stderrBytes) &&
    output.bytes === output.stdoutBytes + output.stderrBytes &&
    typeof output.complete === "boolean" &&
    record(completion) &&
    (completion.state === "exited" ||
      completion.state === "unknown" ||
      completion.state === "not_started") &&
    nullableInteger(completion.exitCode) &&
    nullableString(completion.reason) &&
    cleanup(value.cleanup) &&
    Array.isArray(value.receipts) &&
    value.receipts.every(
      (entry: unknown) =>
        record(entry) &&
        typeof entry.door === "string" &&
        (entry.ok === null || typeof entry.ok === "boolean") &&
        nullableInteger(entry.traceId) &&
        (entry.rule === undefined || typeof entry.rule === "string") &&
        (entry.status === undefined || byteCount(entry.status)),
    ) &&
    (value.authorizedOnlineMachines === undefined ||
      (Array.isArray(value.authorizedOnlineMachines) &&
        value.authorizedOnlineMachines.every(
          (machine: unknown) =>
            record(machine) && typeof machine.id === "string" && typeof machine.name === "string",
        )))
  );
}

function problem(code: string, message: string): Diagnostic {
  return { code, message };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ManifoldSshError extends Error {
  constructor(readonly details: Evidence) {
    // The factory maps this library error to a completed tool error result, retaining abort evidence.
    super(`${details.diagnostic?.code ?? "cli_failed"}: ${JSON.stringify(details)}`);
    this.name = "ManifoldSshError";
  }
}

/** SIGTERM only: the installed CLI owns remote escalation and its independent cleanup budget. */
async function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  input?: string,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  const { promise, resolve } = Promise.withResolvers<ProcessResult>();
  const child = spawn(executable, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let exited = false;
  let finished = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let cancelRequested = false;
  let outputDrained = true;
  let stdinDelivered = input === undefined;
  let failure: string | null = null;
  let drain: NodeJS.Timeout | undefined;
  const cancel = () => {
    if (exited || finished) return;
    cancelRequested = true;
    child.kill("SIGTERM");
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(drain);
    signal?.removeEventListener("abort", cancel);
    resolve({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode,
      signal: exitSignal,
      started: child.pid !== undefined,
      cancelRequested,
      outputDrained,
      stdinDelivered,
      error: failure,
    });
  };
  child.stdout.on("data", (bytes: Buffer) => stdout.push(bytes));
  child.stderr.on("data", (bytes: Buffer) => stderr.push(bytes));
  child.stdout.on("error", (error: Error) => {
    failure ??= error.message;
  });
  child.stderr.on("error", (error: Error) => {
    failure ??= error.message;
  });
  child.stdin.on("error", (error: Error) => {
    failure ??= error.message;
  });
  child.on("error", (error: Error) => {
    failure ??= error.message;
  });
  child.once("exit", (code, killedBy) => {
    exited = true;
    exitCode = code;
    exitSignal = killedBy;
    signal?.removeEventListener("abort", cancel);
    // A descendant may still hold a local pipe after the CLI has exited. Never wait forever.
    drain = setTimeout(() => {
      outputDrained = false;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      finish();
    }, LOCAL_DRAIN_MS);
  });
  child.once("close", finish);
  child.stdin.end(input === undefined ? undefined : Buffer.from(input, "utf8"), () => {
    if (failure === null) stdinDelivered = true;
  });
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  return promise;
}

function taggedDiagnostic(stderr: string): Diagnostic | undefined {
  const match = /(?:^|\n)manifold: ([^:\s]+): ([^\n]*)\n?$/.exec(stderr);
  return match?.[1] !== undefined && match[2] !== undefined
    ? problem(match[1], match[2])
    : undefined;
}

function classify(
  rawReceipt: Record<string, unknown> | null,
  receipt: SshReceipt | null,
  result: ProcessResult,
  stderr: string,
): Diagnostic | undefined {
  // Diagnostics and roster entries are opaque CLI evidence, never a second admission policy.
  if (rawReceipt?.type === "ssh" && diagnostic(rawReceipt.diagnostic)) return rawReceipt.diagnostic;
  if (receipt === null) {
    return (
      (result.exitCode === 255 ? taggedDiagnostic(stderr) : undefined) ??
      (result.cancelRequested
        ? problem(
            "cancelled",
            "The local CLI was cancelled; authoritative completion is unavailable.",
          )
        : problem(
            rawReceipt === null
              ? "receipt_unavailable"
              : rawReceipt.type === "ssh"
                ? "completion_unknown"
                : "receipt_invalid",
            "No valid private SSH receipt was delivered.",
          ))
    );
  }
  // Local diagnostics are appended after the exact remote stderr byte count in the receipt.
  // A remote command printing a diagnostic-looking line is not itself a CLI refusal.
  if (result.exitCode === 255 && result.stderr.length > receipt.output.stderrBytes) {
    const local = taggedDiagnostic(
      result.stderr.subarray(receipt.output.stderrBytes).toString("utf8"),
    );
    if (local !== undefined) return local;
  }
  if (!result.outputDrained)
    return problem("local_output_stalled", "Local output did not drain completely.");
  if (
    result.error !== null ||
    !result.stdinDelivered ||
    result.stdout.length !== receipt.output.stdoutBytes ||
    result.stderr.length !== receipt.output.stderrBytes
  )
    return problem(
      "local_output_failed",
      "Local stream delivery does not match the authoritative receipt.",
    );
  if (receipt.cleanup.state !== "confirmed") {
    return problem(
      "cleanup_unconfirmed",
      "The receipt does not confirm removal of the owned terminal.",
    );
  }
  if (
    receipt.requestId === null ||
    receipt.terminalId === null ||
    receipt.machineId === null ||
    receipt.completion.state !== "exited" ||
    receipt.completion.exitCode === null ||
    receipt.completion.exitCode < 0 ||
    receipt.completion.exitCode > 255 ||
    receipt.completion.reason !== null ||
    receipt.cleanup.processStopped !== "confirmed"
  )
    return problem(
      "completion_unknown",
      "The receipt does not prove the owned command's ordinary exit.",
    );
  if (!receipt.output.complete)
    return problem("output_incomplete", "The receipt does not confirm complete remote output.");
  if (result.signal !== null || result.exitCode !== receipt.completion.exitCode) {
    return problem(
      "completion_unknown",
      "The local CLI status does not match authoritative remote completion.",
    );
  }
  // receipt.ok is false for every ordinary nonzero remote status, including 255.
  return undefined;
}

function evidence(
  target: string,
  result: ProcessResult | null,
  rawReceipt: Record<string, unknown> | null,
  receipt: SshReceipt | null,
): Evidence {
  const started = result?.started ?? false;
  return {
    type: "manifold_ssh",
    ok: false,
    target,
    stdout: result?.stdout.toString("utf8") ?? "",
    stderr: result?.stderr.toString("utf8") ?? "",
    exitCode: receipt?.completion.exitCode ?? null,
    cliExitCode: result?.exitCode ?? null,
    cliSignal: result?.signal ?? null,
    receipt: rawReceipt,
    cleanup:
      receipt?.cleanup ??
      (cleanup(rawReceipt?.cleanup)
        ? rawReceipt.cleanup
        : {
            state: started ? "unconfirmed" : "not_needed",
            via: null,
            traceId: null,
            processStopped: started ? "unconfirmed" : "not_started",
          }),
    local: {
      cancelRequested: result?.cancelRequested ?? false,
      outputDrained: result?.outputDrained ?? true,
      stdinDelivered: result?.stdinDelivered ?? true,
      receiptDirectoryRemoved: false,
      error: result?.error ?? null,
    },
  };
}

async function executeSsh(
  executable: string,
  params: SshParameters,
  cwd: string,
  signal?: AbortSignal,
): Promise<Evidence> {
  let directory: string | undefined;
  let result: ProcessResult | null = null;
  let receipt: Record<string, unknown> | null = null;
  let details: Evidence | undefined;
  let failure: Diagnostic | undefined;
  let localError: string | null = null;
  let removed = true;
  try {
    if (signal?.aborted) {
      failure = problem("cancelled", "The call was cancelled before starting the local CLI.");
    } else {
      directory = await mkdtemp(join(tmpdir(), "manifold-omp-"));
      await chmod(directory, 0o700);
      const receiptPath = join(directory, "receipt.json");
      const args = ["ssh"];
      if (params.stdin === undefined) args.push("-n");
      if (params.timeoutMs !== undefined) args.push("--timeout-ms", String(params.timeoutMs));
      if (params.maxOutputBytes !== undefined)
        args.push("--max-output-bytes", String(params.maxOutputBytes));
      args.push("--receipt", receiptPath, "--", params.target, params.command);
      // Cancellation during temp-directory setup must not start a command.
      if (signal?.aborted) {
        failure = problem("cancelled", "The call was cancelled before starting the local CLI.");
      } else {
        result = await runProcess(executable, args, cwd, params.stdin, signal);
        try {
          const stat = await lstat(receiptPath);
          if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
            localError = "The CLI receipt is not a private mode-0600 regular file.";
          } else {
            const parsed: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
            if (record(parsed)) receipt = parsed;
            else localError = "The private receipt is not a JSON object.";
          }
        } catch (error) {
          localError = errorText(error);
        }
        const validated = sshReceipt(receipt) ? receipt : null;
        details = evidence(params.target, result, receipt, validated);
        failure = classify(receipt, validated, result, details.stderr);
      }
    }
  } catch (error) {
    localError = errorText(error);
    failure = problem(
      "local_adapter_failed",
      "The local adapter could not complete the CLI invocation.",
    );
  } finally {
    if (directory !== undefined) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        removed = false;
        localError = errorText(error);
        failure ??= problem(
          "local_cleanup_failed",
          "The adapter could not remove its own private receipt directory.",
        );
      }
    }
  }
  details ??= evidence(params.target, result, receipt, null);
  details.local.receiptDirectoryRemoved = removed;
  details.local.error ??= localError;
  details.local.cancelRequested ||= signal?.aborted === true && result === null;
  if (failure !== undefined) {
    details.diagnostic = failure;
    throw new ManifoldSshError(details);
  }
  details.ok = true;
  return details;
}

async function probeContext(executable: string, cwd: string): Promise<boolean> {
  const result = await runProcess(executable, ["context", "--json"], cwd);
  const stdout = result.stdout.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `context_invalid: ${JSON.stringify({ stdout, stderr: result.stderr.toString("utf8"), cliExitCode: result.exitCode })}`,
    );
  }
  if (
    result.signal === null &&
    result.error === null &&
    result.outputDrained &&
    record(parsed) &&
    parsed.type === "context"
  ) {
    if (
      result.exitCode === 0 &&
      parsed.ok === true &&
      parsed.binding === "terminal" &&
      parsed.remoteShellLaunch === "not_probed"
    )
      return true;
    if (result.exitCode === 1 && parsed.ok === false && diagnostic(parsed.diagnostic)) return false;
  }
  const code =
    record(parsed) && diagnostic(parsed.diagnostic) ? parsed.diagnostic.code : "context_invalid";
  throw new Error(
    `${code}: ${JSON.stringify({ context: parsed, stderr: result.stderr.toString("utf8"), cliExitCode: result.exitCode })}`,
  );
}

export default async function factory(host: FactoryHost) {
  const executable = Bun.which("manifold", { PATH: process.env.PATH ?? "" });
  if (executable === null || !isAbsolute(executable)) {
    throw new Error("cli_unavailable: An installed manifold executable is required on PATH.");
  }
  // This is a local inherited-binding gate, not doctor, a credential lookup, or a shell-authority probe.
  if (!(await probeContext(executable, host.cwd))) return [];
  return {
    name: "manifold_ssh",
    label: "Manifold SSH",
    description:
      "Run one literal shell command on a Manifold machine using the installed CLI and the inherited ordinary-terminal binding. Target is a machine name or UUID. Stdout and stderr remain separate; confirmed ordinary remote exits 0–255 are results, including nonzero exits. CLI refusals, limits, uncertain completion and cleanup are errors with receipt evidence. No replay or interactive TTY.",
    loadMode: "essential" as const,
    strict: true,
    parameters: host.zod
      .object({
        target: host.zod
          .string()
          .describe("Machine name or UUID; the CLI owns selection and admission."),
        command: host.zod
          .string()
          .describe(
            "One literal command argv element, at most 4096 characters; not escaped or joined locally.",
          ),
        stdin: host.zod
          .string()
          .describe("Optional UTF-8 input; absent input uses CLI -n, not a TTY.")
          .optional(),
        timeoutMs: host.zod
          .number()
          .describe(
            "CLI timeout in milliseconds (default 60000, maximum 3600000). The CLI validates limits.",
          )
          .optional(),
        maxOutputBytes: host.zod
          .number()
          .describe(
            "CLI combined stdout/stderr byte cap (default 1048576, maximum 16777216). Output is never silently shortened.",
          )
          .optional(),
      })
      .strict(),
    async execute(
      _toolCallId: string,
      params: SshParameters,
      _onUpdate: unknown,
      _context: unknown,
      signal?: AbortSignal,
    ) {
      try {
        const details = await executeSsh(executable, params, host.cwd, signal);
        return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        if (!(error instanceof ManifoldSshError)) throw error;
        // A throw after abort loses details in the host loop; this completed error result does not.
        return {
          content: [{ type: "text" as const, text: error.message }],
          details: error.details,
          isError: true,
        };
      }
    },
  };
}
