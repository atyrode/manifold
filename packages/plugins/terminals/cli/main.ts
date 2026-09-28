#!/usr/bin/env bun
import { isatty } from "node:tty";
import { LocalOutputError, runTerminalClient, type TerminalClientStdio } from "./client.ts";

/** How long ssh's local stdout and stderr get to take the remaining output after the run. */
const OUTPUT_DRAIN_MS = 10_000;

/** Reads stdin to EOF, stopping as soon as it exceeds the bound; never reads a terminal. */
async function readStdin(maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const reader = Bun.stdin.stream().getReader();
  const stop = () => void reader.cancel(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

/** One local output stream, counting accepted writes until the OS has taken each of them. */
class TrackedOutput {
  failed = false;
  private pending = 0;
  private idle: PromiseWithResolvers<void> | null = null;

  constructor(private readonly stream: NodeJS.WriteStream) {
    stream.on("error", () => this.settled(true));
  }

  get draining(): boolean {
    return this.pending > 0 && !this.failed;
  }

  write(bytes: Uint8Array): void {
    if (this.failed || this.stream.destroyed) throw new LocalOutputError("failed");
    this.pending++;
    this.stream.write(bytes, (error) => {
      this.pending--;
      this.settled(error !== null && error !== undefined);
    });
  }

  /** Resolves once every accepted byte was written, or once the stream failed. */
  drained(): Promise<void> {
    if (!this.draining) return Promise.resolve();
    this.idle ??= Promise.withResolvers<void>();
    return this.idle.promise;
  }

  /** Gives up on a stream that stopped draining; its unwritten bytes are dropped. */
  abandon(): void {
    this.stream.destroy();
  }

  private settled(failed: boolean): void {
    if (failed) this.failed = true;
    if (this.draining) return;
    this.idle?.resolve();
    this.idle = null;
  }
}

/** Process stdio for `manifold ssh`; settling waits at most `drainMs` for both streams. */
export function processStdio(drainMs: number): TerminalClientStdio {
  const stdout = new TrackedOutput(process.stdout);
  const stderr = new TrackedOutput(process.stderr);
  return {
    stdout: (bytes) => stdout.write(bytes),
    stderr: (bytes) => stderr.write(bytes),
    settle: async () => {
      const bound = Promise.withResolvers<void>();
      const timer = setTimeout(bound.resolve, drainMs);
      try {
        await Promise.race([Promise.all([stdout.drained(), stderr.drained()]), bound.promise]);
      } finally {
        clearTimeout(timer);
      }
      const failed = stdout.failed || stderr.failed;
      const stalled = [stdout, stderr].filter((output) => output.draining);
      for (const output of stalled) output.abandon();
      if (failed) throw new LocalOutputError("failed");
      if (stalled.length > 0) throw new LocalOutputError("stalled");
    },
    stdinIsTerminal: isatty(0),
    readStdin,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // ssh reports every Manifold-side failure, a local output failure included, as 255.
  const failedStatus = args[0] === "ssh" ? 255 : 1;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const outputFailed = () => {
    process.exitCode = failedStatus;
    controller.abort();
  };
  const stdio = processStdio(OUTPUT_DRAIN_MS);
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("SIGHUP", interrupt);
  process.stdout.on("error", outputFailed);
  process.stderr.on("error", outputFailed);
  try {
    process.exitCode = await runTerminalClient(args, {
      environment: process.env,
      signal: controller.signal,
      output: (text) => {
        if (process.stdout.destroyed) throw new Error("output_unavailable");
        process.stdout.write(text);
      },
      stdio,
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("SIGHUP", interrupt);
    if (process.stdout.writableLength > 0) {
      const deadline = setTimeout(() => {
        process.exitCode = failedStatus;
        process.stdout.destroy();
      }, 10_000);
      deadline.unref();
    }
  }
}
