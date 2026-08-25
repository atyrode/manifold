import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { FakeRuntime } from "./helpers.ts";

const OWNER_KEY = "e".repeat(64);
const temporaryDirectories: string[] = [];
const runningServers: RunningServer[] = [];

function startFixture(runtime: FakeRuntime): {
  readonly origin: string;
  readonly running: RunningServer;
} {
  const cwd = mkdtempSync(join(tmpdir(), "manifold-vm-session-test-"));
  temporaryDirectories.push(cwd);
  const config = loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_PUBLIC_URL: "https://manifold.tyrode.dev",
      MANIFOLD_SPAWN_AGENT: "0",
    },
    cwd,
  );
  const running = startServer({ config, runtime, announce: false });
  runningServers.push(running);
  return { origin: `http://127.0.0.1:${running.port}`, running };
}

async function bootstrapIdentity(
  origin: string,
): Promise<{ readonly token: string; readonly principalId: string }> {
  const response = await fetch(`${origin}/api/principals`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OWNER_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "vm viewer", kind: "human" }),
  });
  const body = (await response.json()) as { token: string; principal: { id: string } };
  return { token: body.token, principalId: body.principal.id };
}

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("VM proxy sessions", () => {
  test("a root browser token issues a scoped cookie that follows source-token revocation", async () => {
    const runtime = new FakeRuntime();
    const { origin } = startFixture(runtime);
    const identity = await bootstrapIdentity(origin);

    const missing = await fetch(`${origin}/api/vm/authorize`);
    expect(missing.status).toBe(401);

    const issued = await fetch(`${origin}/api/vm/session`, {
      method: "POST",
      headers: { authorization: `Bearer ${identity.token}` },
    });
    expect(issued.status).toBe(200);
    expect(await issued.json()).toEqual({ expiresAt: 3_600_000 });
    const setCookie = issued.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("Domain=manifold.tyrode.dev");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
    const cookie = setCookie!.split(";", 1)[0]!;

    const authorized = await fetch(`${origin}/api/vm/authorize`, {
      headers: { cookie },
    });
    expect(authorized.status).toBe(204);

    const revoked = await fetch(`${origin}/api/tokens/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OWNER_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principalId: identity.principalId }),
    });
    expect(revoked.status).toBe(200);

    const denied = await fetch(`${origin}/api/vm/authorize`, {
      headers: { cookie },
    });
    expect(denied.status).toBe(401);
  });
});
