#!/usr/bin/env bun
import { isatty } from "node:tty";
import { runTerminalClient, type TerminalClientStdio } from "./client.ts";

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

function writer(stream: NodeJS.WriteStream): (bytes: Uint8Array) => void {
  return (bytes) => {
    if (stream.destroyed) throw new Error("output_unavailable");
    stream.write(bytes);
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const outputFailed = () => {
    process.exitCode = 1;
    controller.abort();
  };
  const stdio: TerminalClientStdio = {
    stdout: writer(process.stdout),
    stderr: writer(process.stderr),
    stdinIsTerminal: isatty(0),
    readStdin,
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("SIGHUP", interrupt);
  process.stdout.on("error", outputFailed);
  process.stderr.on("error", outputFailed);
  try {
    process.exitCode = await runTerminalClient(process.argv.slice(2), {
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
    if (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) {
      const deadline = setTimeout(() => {
        process.exitCode = 1;
        process.stdout.destroy();
        process.stderr.destroy();
      }, 10_000);
      deadline.unref();
    }
  }
}
