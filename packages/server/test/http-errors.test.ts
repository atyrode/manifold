import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  MachineEnrollResponseSchema,
  ResolveResponseSchema,
  type RuntimeDeps,
} from "@manifold/protocol";
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

async function startFixture(runtime: RuntimeDeps, logger: Logger): Promise<RunningServer> {
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
  const running = await startServer({ config, runtime, logger, announce: false });
  runningServers.push(running);
  return running;
}

/**
 * The index's creation door, which mints an id: the one request whose handler reaches the
 * runtime, and therefore the one that can be made to fail there.
 */
function createContainerRequest(running: RunningServer, body: unknown): Request {
  return new Request(`${running.publicUrl}/api/actions/core.index.createContainer`, {
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
  test("resolve names an enrolled machine and answers absence for an unknown machine", async () => {
    const logger: Logger = { info(): void {}, warn(): void {}, error(): void {} };
    const running = await startFixture(new FaultRuntime(), logger);
    const headers = { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" };
    const response = await fetch(`${running.publicUrl}/api/actions/core.machines.enroll`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "alpha" }),
    });
    const outcome = ActionOutcomeSchema.parse(await response.json());
    if (!outcome.ok) throw new Error(outcome.denial.message);
    const { machine } = MachineEnrollResponseSchema.parse(outcome.result);
    for (const [machineId, title] of [
      [machine.id, "alpha"],
      ["unknown-machine", null],
    ] as const) {
      const uri = `manifold://machine/${machineId}`;
      const resolved = await fetch(
        `${running.publicUrl}/api/resolve?uri=${encodeURIComponent(uri)}`,
        { headers },
      );
      expect(resolved.status).toBe(200);
      expect(ResolveResponseSchema.parse(await resolved.json())).toEqual({
        uri,
        ref: { kind: "machine", machineId },
        exists: title !== null,
        title,
      });
    }
    const malformed = await fetch(`${running.publicUrl}/api/resolve?uri=manifold://machine/`, {
      headers,
    });
    expect(malformed.status).toBe(400);
  });

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
    const running = await startFixture(runtime, logger);
    runtime.failNewId = true;

    const response = await fetch(createContainerRequest(running, { name: "container" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "internal", message: "internal server error" },
    });
    // A handler that throws is logged TWICE by design and both lines matter: the dispatcher
    // names the action that broke, and the request layer records the failed request. Neither
    // carries the exception into the response.
    expect(errors).toEqual([
      {
        evt: "action",
        fields: {
          name: "core.index.createContainer",
          // The owner principal, minted at boot by this runtime's first id.
          principal: "id-1",
          outcome: "failed",
          error: "sensitive internal failure",
        },
      },
      {
        evt: "http_request_failed",
        fields: { method: "POST", error: "sensitive internal failure" },
      },
    ]);
  });

  test("a body that fails an action's schema is a denial, not an HTTP error", async () => {
    const logger: Logger = { info(): void {}, warn(): void {}, error(): void {} };
    const running = await startFixture(new FaultRuntime(), logger);

    const response = await fetch(createContainerRequest(running, { name: "" }));

    // The action door answers 200 for every ANSWER it has, and "your arguments do not match
    // the published schema" is an answer a client renders — not a transport failure.
    expect(response.status).toBe(200);
    const payload = ActionOutcomeSchema.parse(await response.json());
    expect(payload.ok).toBe(false);
    if (payload.ok) throw new Error("expected a denial");
    expect(payload.denial.rule).toBe("invalid_args");
  });

  test("a malformed JSON body returns a 400 invalid response", async () => {
    const logger: Logger = { info(): void {}, warn(): void {}, error(): void {} };
    const running = await startFixture(new FaultRuntime(), logger);

    // Not a schema question: a body that is not JSON never reaches a door, so this is the
    // one remaining shape of `invalid` the request layer itself still answers.
    const response = await fetch(
      new Request(`${running.publicUrl}/api/actions/core.index.createContainer`, {
        method: "POST",
        headers: { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid", message: "request body must be valid JSON" },
    });
  });
});
