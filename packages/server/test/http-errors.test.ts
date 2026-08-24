import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDeps } from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import type { Logger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";

const OWNER_KEY = "f".repeat(64);
const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];

class FaultRuntime implements RuntimeDeps {
  failNewId = false;
  private nextId = 0;

  newId(): string {
    if (this.failNewId) throw new Error("sensitive internal failure");
    this.nextId += 1;
    return `id-${this.nextId}`;
  }

  now(): number {
    return 0;
  }
}

function startFixture(runtime: RuntimeDeps, logger: Logger): RunningServer {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-http-errors-test-"));
  temporaryDirectories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const running = startServer({ config, runtime, logger, announce: false });
  runningServers.push(running);
  return running;
}

function createPadRequest(running: RunningServer, body: unknown): Request {
  return new Request(`${running.publicUrl}/api/pads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OWNER_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("HTTP error mapping", () => {
  test("an unknown handler error returns a non-leaking 500 internal response", async () => {
    const runtime = new FaultRuntime();
    const errors: Array<{ evt: string; fields?: Readonly<Record<string, unknown>> }> = [];
    const logger: Logger = {
      info(): void {},
      warn(): void {},
      error(evt, fields): void {
        errors.push({ evt, ...(fields === undefined ? {} : { fields }) });
      },
    };
    const running = startFixture(runtime, logger);
    runtime.failNewId = true;

    const response = await fetch(createPadRequest(running, { name: "pad" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal", message: "internal server error" },
    });
    expect(errors).toEqual([
      {
        evt: "http_request_failed",
        fields: { method: "POST", error: "sensitive internal failure" },
      },
    ]);
  });

  test("an invalid request body returns a 400 invalid response", async () => {
    const logger: Logger = { info(): void {}, warn(): void {}, error(): void {} };
    const running = startFixture(new FaultRuntime(), logger);

    const response = await fetch(createPadRequest(running, { name: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid", message: "request did not match the protocol schema" },
    });
  });
});
