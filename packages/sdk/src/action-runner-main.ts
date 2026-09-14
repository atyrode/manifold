#!/usr/bin/env bun
import {
  ACTION_RUNNER_IDLE_TIMEOUT_MS,
  ACTION_RUNNER_MAX_FRAME_BYTES,
  AGENT_RUN_MAX_LIFETIME_MS,
  type AgentRunTerminalOutcome,
} from "@manifold/protocol";
import { ActionRunner, ActionRunnerError } from "./action-runner.ts";

/** Bounded JSONL framing shared by the executable and pipe-level lifecycle tests. */
export async function runActionStdio(options: {
  origin: string;
  sponsorToken: string;
  input: AsyncIterable<Uint8Array>;
  output: (line: string) => void;
  signal?: AbortSignal;
}): Promise<number> {
  const runner = new ActionRunner({
    origin: options.origin,
    sponsorToken: options.sponsorToken,
    emit: (frame) => options.output(`${JSON.stringify(frame)}\n`),
  });
  let wake: (() => void) | null = null;
  let outcome: AgentRunTerminalOutcome = "abandoned";
  let interrupted = false;
  let stopping = false;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  const interrupt = () => {
    interrupted = true;
    outcome = "cancelled";
    stop();
  };
  options.signal?.addEventListener("abort", interrupt, { once: true });
  if (options.signal?.aborted) interrupt();
  let idle = setTimeout(stop, ACTION_RUNNER_IDLE_TIMEOUT_MS);
  const lifetime = setTimeout(stop, AGENT_RUN_MAX_LIFETIME_MS);
  const iterator = options.input[Symbol.asyncIterator]();
  const pending = new Uint8Array(ACTION_RUNNER_MAX_FRAME_BYTES);
  let pendingLength = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let success = false;
  try {
    while (!runner.closed && !stopping) {
      // One removable wake slot, not a never-settled Promise.race subscription per chunk.
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
        if (pendingLength + part.byteLength > pending.byteLength)
          throw new ActionRunnerError("limit_exceeded");
        pending.set(part, pendingLength);
        const line = pending.subarray(0, pendingLength + part.byteLength);
        pendingLength = 0;
        let input: unknown;
        try {
          input = JSON.parse(decoder.decode(line));
        } catch {
          throw new ActionRunnerError("invalid_frame");
        }
        clearTimeout(idle);
        await runner.accept(input);
        idle = setTimeout(stop, ACTION_RUNNER_IDLE_TIMEOUT_MS);
        start = index + 1;
        if (runner.closed || stopping) break;
      }
      if (runner.closed || stopping) break;
      const remainder = next.value.subarray(start);
      if (pendingLength + remainder.byteLength > pending.byteLength)
        throw new ActionRunnerError("limit_exceeded");
      pending.set(remainder, pendingLength);
      pendingLength += remainder.byteLength;
    }
    if (!runner.closed && !stopping && pendingLength > 0)
      throw new ActionRunnerError("invalid_frame");
    success = runner.successful;
  } catch (error) {
    outcome = "failed";
    // An output pipe failure must not prevent the finally block from reaching the finish door.
    try {
      runner.report(error);
    } catch {
      /* The reader may have gone away; teardown still runs. */
    }
  } finally {
    clearTimeout(idle);
    clearTimeout(lifetime);
    options.signal?.removeEventListener("abort", interrupt);
    try {
      if (!(await runner.close(outcome))) success = false;
    } catch {
      success = false; /* A broken output pipe cannot undo an attempted teardown. */
    }
  }
  return success ? 0 : interrupted ? 130 : 1;
}

const HELP = `manifold-action-runner — bounded action-plane JSONL runner

Usage: bun packages/sdk/src/action-runner-main.ts
       manifold-action-runner

The trusted launcher sets MANIFOLD_ORIGIN and MANIFOLD_SPONSOR_TOKEN in the process
 environment. Never supply a credential in argv, a JSON frame, a prompt or a log.
No command-line arguments are accepted except --help. Stdout is JSONL only.

Send start {id,version:1,declaration:{name,purpose,target,reach,caps,lifetimeMs}}.
Read discovery and policy frames, then ack {id,runId,policy:{revision,
acknowledgements:[{id,digest}]}} using every exact delivered bundle.
Invoke {id,runId,door,target,args,justification?}; target is a caller declaration,
not a claim about resolved trace targets. Read discovered schemas; the server door
validates arguments. Results contain only outcome/refusal rule and durable traceId,
never raw results, refusal messages, credentials, arguments or terminal output.
Use child {id,runId,declaration,justification?}, renew {id,runId,lifetimeMs,
justification?}, policy {id,runId}, discover {id,runId}, and finish {id,runId,
outcome:"completed"|"failed"|"cancelled"|"abandoned"}. Child runId is returned by
its create result; all child bearers remain here. A stale-policy refusal delivers
new exact bytes: acknowledge explicitly before retrying; no automatic assent.

Unique ids, sequential UTF-8 JSONL frames <=64 KiB; at most 1024 requests,
five minutes idle, one hour process lifetime, 30 seconds per HTTP request.
EOF abandons unfinished work; malformed input fails it; SIGINT/SIGTERM/SIGHUP
cancel it. Every path attempts finish through the same action door. Read closed:
cleanup=failed is not clean; expiry is the backstop, including SIGKILL or a lost
creation response. Effects use discovered actions, never browser controls;
use browser interaction only to verify the human-facing UX itself.
See packages/sdk/README.md for the trusted-launcher and policy contract.
`;

if (import.meta.main) {
  // Read and withdraw the inherited secret before processing any untrusted input.
  const sponsorToken = process.env["MANIFOLD_SPONSOR_TOKEN"] ?? "";
  delete process.env["MANIFOLD_SPONSOR_TOKEN"];
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(HELP);
  } else if (args.length !== 0) {
    process.stdout.write(
      `${JSON.stringify({ type: "error", id: null, door: null, target: null, runId: null, code: "invalid_frame", traceId: null })}\n`,
    );
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    const outputFailed = () => {
      process.exitCode = 1;
      controller.abort();
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    process.on("SIGHUP", interrupt);
    process.stdout.on("error", outputFailed);
    try {
      process.exitCode = await runActionStdio({
        origin: process.env["MANIFOLD_ORIGIN"] ?? "",
        sponsorToken,
        input: process.stdin,
        signal: controller.signal,
        output: (line) => {
          if (process.stdout.destroyed || process.stdout.writableLength > 16 * 1_048_576)
            throw new ActionRunnerError("limit_exceeded");
          process.stdout.write(line);
        },
      });
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
}
