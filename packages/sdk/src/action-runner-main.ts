#!/usr/bin/env bun
import { createReadStream, type ReadStream } from "node:fs";
import {
  ACTION_RUNNER_IDLE_TIMEOUT_MS,
  ACTION_RUNNER_MAX_FRAME_BYTES,
  AGENT_RUN_MAX_LIFETIME_MS,
  ActionRunnerBindSchema,
  type ActionRunnerBind,
  type AgentRunTerminalOutcome,
} from "@manifold/protocol";
import { ActionRunner, ActionRunnerError } from "./action-runner.ts";

const LAUNCH_KEYS = [
  "MANIFOLD_RUNNER_TOKEN",
  "MANIFOLD_AGENT_ID",
  "MANIFOLD_AGENT_SESSION",
  "MANIFOLD_AGENT_MODEL",
  "MANIFOLD_RUN_TOKEN",
  "MANIFOLD_RUN_ID",
  "MANIFOLD_ORIGIN",
  "MANIFOLD_ACTIVITY_FD",
  "MANIFOLD_SPONSOR_TOKEN",
] as const;

/** Withdraw every launcher carrier even when configuration is invalid; none reaches input. */
export function readActionRunnerEnvironment(environment: Record<string, string | undefined>): {
  origin: string;
  token: string;
  bind: ActionRunnerBind;
  activityFd?: number;
} {
  const values = Object.fromEntries(LAUNCH_KEYS.map((key) => [key, environment[key]]));
  for (const key of LAUNCH_KEYS) delete environment[key];
  if (values["MANIFOLD_SPONSOR_TOKEN"] !== undefined)
    throw new ActionRunnerError("credential_input");
  const agentMode = [
    "MANIFOLD_RUNNER_TOKEN",
    "MANIFOLD_AGENT_ID",
    "MANIFOLD_AGENT_SESSION",
    "MANIFOLD_AGENT_MODEL",
  ].some((key) => values[key] !== undefined);
  const runMode = ["MANIFOLD_RUN_TOKEN", "MANIFOLD_RUN_ID"].some(
    (key) => values[key] !== undefined,
  );
  if (agentMode === runMode) throw new ActionRunnerError("invalid_frame");
  const json = (key: string): unknown => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value) > ACTION_RUNNER_MAX_FRAME_BYTES)
      throw new ActionRunnerError("limit_exceeded");
    try {
      return JSON.parse(value);
    } catch {
      throw new ActionRunnerError("invalid_frame");
    }
  };
  const parsed = ActionRunnerBindSchema.safeParse(
    agentMode
      ? {
          agentId: values["MANIFOLD_AGENT_ID"],
          ...(values["MANIFOLD_AGENT_SESSION"] === undefined
            ? {}
            : { session: json("MANIFOLD_AGENT_SESSION") }),
          ...(values["MANIFOLD_AGENT_MODEL"] === undefined
            ? {}
            : { model: json("MANIFOLD_AGENT_MODEL") }),
        }
      : { runId: values["MANIFOLD_RUN_ID"] },
  );
  if (!parsed.success) throw new ActionRunnerError("invalid_frame");
  const descriptor = values["MANIFOLD_ACTIVITY_FD"];
  if (descriptor !== undefined && (!/^[0-9]{1,6}$/.test(descriptor) || Number(descriptor) < 3))
    throw new ActionRunnerError("invalid_frame");
  return {
    origin: values["MANIFOLD_ORIGIN"] ?? "",
    token: values[agentMode ? "MANIFOLD_RUNNER_TOKEN" : "MANIFOLD_RUN_TOKEN"] ?? "",
    bind: parsed.data,
    ...(descriptor === undefined ? {} : { activityFd: Number(descriptor) }),
  };
}

/** The same byte bound applies to the model pipe and the separately inherited harness pipe. */
async function frames(
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  accept: (value: unknown) => Promise<void>,
): Promise<void> {
  let wake: (() => void) | null = null;
  const stop = () => wake?.();
  signal.addEventListener("abort", stop);
  const iterator = input[Symbol.asyncIterator]();
  const pending = new Uint8Array(ACTION_RUNNER_MAX_FRAME_BYTES);
  let length = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (!signal.aborted) {
      const next = await new Promise<IteratorResult<Uint8Array> | null>((resolve, reject) => {
        wake = () => resolve(null);
        void iterator.next().then(resolve, reject);
      });
      wake = null;
      if (next === null || next.done) break;
      let start = 0;
      for (let index = 0; index < next.value.byteLength; index += 1) {
        if (next.value[index] !== 10) continue;
        const part = next.value.subarray(start, index);
        if (length + part.byteLength > pending.byteLength)
          throw new ActionRunnerError("limit_exceeded");
        pending.set(part, length);
        let value: unknown;
        try {
          value = JSON.parse(decoder.decode(pending.subarray(0, length + part.byteLength)));
        } catch {
          throw new ActionRunnerError("invalid_frame");
        }
        length = 0;
        await accept(value);
        start = index + 1;
        if (signal.aborted) return;
      }
      const remainder = next.value.subarray(start);
      if (length + remainder.byteLength > pending.byteLength)
        throw new ActionRunnerError("limit_exceeded");
      pending.set(remainder, length);
      length += remainder.byteLength;
    }
    if (!signal.aborted && length > 0) throw new ActionRunnerError("invalid_frame");
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

/** Both pipes are serialized through one run owner; EOF on the model pipe ends the run. */
export async function runActionStdio(options: {
  origin: string;
  token: string;
  bind: ActionRunnerBind;
  input: AsyncIterable<Uint8Array>;
  activityInput?: AsyncIterable<Uint8Array>;
  output: (line: string) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const runner = new ActionRunner({
    origin: options.origin,
    token: options.token,
    bind: options.bind,
    emit: (frame) => options.output(`${JSON.stringify(frame)}\n`),
  });
  const stopping = new AbortController();
  let outcome: AgentRunTerminalOutcome = "abandoned";
  let interrupted = false;
  const stop = () => stopping.abort();
  const interrupt = () => {
    interrupted = true;
    outcome = "cancelled";
    stop();
  };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  let idle = setTimeout(stop, ACTION_RUNNER_IDLE_TIMEOUT_MS);
  const lifetime = setTimeout(stop, AGENT_RUN_MAX_LIFETIME_MS);
  let active = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    active = active.then(async () => {
      if (stopping.signal.aborted) return;
      await operation();
      if (runner.closed) stop();
    });
    return active;
  };
  let success = false;
  const pumps: Promise<void>[] = [];
  try {
    // Adopted work already exists and needs teardown; cancelled Agent admission creates nothing.
    // Once admission starts, signals wait for its response rather than losing the run handle.
    if (!stopping.signal.aborted || "runId" in options.bind) await runner.bind();
    if (!stopping.signal.aborted && !runner.closed) {
      const model = frames(options.input, stopping.signal, (value) =>
        enqueue(async () => {
          clearTimeout(idle);
          await runner.accept(value);
          idle = setTimeout(stop, ACTION_RUNNER_IDLE_TIMEOUT_MS);
        }),
      ).finally(stop);
      pumps.push(model);
      if (options.activityInput !== undefined)
        pumps.push(
          frames(options.activityInput, stopping.signal, (value) =>
            enqueue(() => runner.reportActivity(value)),
          ).catch((error: unknown) => {
            stop();
            throw error;
          }),
        );
      await Promise.all(pumps);
    }
    success = runner.successful;
  } catch (error) {
    outcome = "failed";
    try {
      runner.report(error);
    } catch {
      /* A broken output pipe still reaches teardown. */
    }
  } finally {
    stop();
    await Promise.allSettled(pumps);
    clearTimeout(idle);
    clearTimeout(lifetime);
    options.signal?.removeEventListener("abort", interrupt);
    try {
      if (!(await runner.close(outcome))) success = false;
    } catch {
      success = false;
    }
  }
  return success ? 0 : interrupted ? 130 : 1;
}

const HELP = `manifold-action-runner — harness-bound action-plane JSONL runner

Usage: manifold-action-runner (or bun packages/sdk/src/action-runner-main.ts)

The trusted launcher supplies MANIFOLD_ORIGIN and exactly one environment binding:
Agent: MANIFOLD_RUNNER_TOKEN + MANIFOLD_AGENT_ID, optionally MANIFOLD_AGENT_SESSION
       and MANIFOLD_AGENT_MODEL (JSON). Creates a run under that Agent's standing grant.
Run:   MANIFOLD_RUN_TOKEN + MANIFOLD_RUN_ID. Adopts an already admitted harness run.
Every carrier is deleted before input is read. Credentials never belong in argv,
JSONL, prompts, logs or files. No command arguments are accepted except --help.

Admission delivers discovery, a result with runId, and exact policy automatically.
There is no start or bind model frame. Ack the exact delivered policy before invoke.
Model frames: discover, policy, ack, invoke, child, renew, finish; each needs a unique
id and an owned runId. Child declarations narrow the same Agent, never bind a session.
Read discovered schemas. Results contain only mechanical outcome/refusal, traceId
and lifecycle facts, not raw results, arguments, credentials or terminal output.

A trusted harness may inherit a separate pipe at MANIFOLD_ACTIVITY_FD (>=3).
It carries {runId,activity:"working"|"blocked"|"done"|"idle"} JSONL, never model stdin.
Both pipes are UTF-8 JSONL <=64 KiB/frame and <=1024 frames each. Model idle limit:
five minutes; total lifetime: one hour; each HTTP request: 30 seconds. Stdout: JSONL.
EOF abandons; malformed input fails; SIGINT/SIGTERM/SIGHUP cancel. Every exit attempts
finish; cleanup=failed is unconfirmed, and expiry is only the backstop. Effects use
action doors, never browser controls. See packages/sdk/README.md.
`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  let activity: ReadStream | undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const outputFailed = () => {
    process.exitCode = 1;
    controller.abort();
  };
  try {
    if (args.length === 1 && args[0] === "--help") {
      for (const key of LAUNCH_KEYS) delete process.env[key];
      process.stdout.write(HELP);
    } else {
      const configuration = readActionRunnerEnvironment(process.env);
      if (args.length !== 0) throw new ActionRunnerError("invalid_frame");
      if (configuration.activityFd !== undefined)
        activity = createReadStream("", { fd: configuration.activityFd, autoClose: false });
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", interrupt);
      process.on("SIGHUP", interrupt);
      process.stdout.on("error", outputFailed);
      process.exitCode = await runActionStdio({
        ...configuration,
        input: process.stdin,
        ...(activity === undefined ? {} : { activityInput: activity }),
        signal: controller.signal,
        output: (line) => {
          if (process.stdout.destroyed || process.stdout.writableLength > 16 * 1_048_576)
            throw new ActionRunnerError("limit_exceeded");
          process.stdout.write(line);
        },
      });
    }
  } catch {
    if (!process.stdout.destroyed)
      process.stdout.write(
        `${JSON.stringify({ type: "error", id: null, door: null, target: null, runId: null, code: "invalid_frame", traceId: null })}\n`,
      );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("SIGHUP", interrupt);
    activity?.destroy();
    process.stdin.destroy();
    if (process.stdout.writableLength > 0) {
      const drainDeadline = setTimeout(() => {
        process.exitCode = 1;
        process.stdout.destroy();
      }, 30_000);
      drainDeadline.unref();
    }
  }
}
