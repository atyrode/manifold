#!/usr/bin/env bun
import { runTerminalClient } from "./client.ts";

if (import.meta.main) {
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
    process.exitCode = await runTerminalClient(process.argv.slice(2), {
      environment: process.env,
      signal: controller.signal,
      output: (text) => {
        if (process.stdout.destroyed) throw new Error("output_unavailable");
        process.stdout.write(text);
      },
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    process.off("SIGHUP", interrupt);
    if (process.stdout.writableLength > 0) {
      const deadline = setTimeout(() => {
        process.exitCode = 1;
        process.stdout.destroy();
      }, 10_000);
      deadline.unref();
    }
  }
}
