import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  PreviewIdentityAssertionSchema,
  PreviewIdentityNonceResponseSchema,
  ContainerResponseSchema,
  TokenGrantSchema,
} from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/main.ts";

const OWNER_KEY = "a".repeat(64);
const runningServers: RunningServer[] = [];
const temporaryDirectories: string[] = [];

function dataDirectory(name: string): string {
  const path = mkdtempSync(join(tmpdir(), `manifold-preview-identity-${name}-`));
  temporaryDirectories.push(path);
  return path;
}

async function action(
  origin: string,
  token: string,
  name: string,
  args: unknown,
): Promise<unknown> {
  const response = await fetch(`${origin}/api/actions/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const outcome = ActionOutcomeSchema.parse(await response.json());
  if (!outcome.ok) throw new Error(outcome.denial.message);
  return outcome.result;
}

afterEach(async () => {
  for (const running of runningServers.splice(0)) await running.stop();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("production preview identity", () => {
  test("exchanges a restricted production identity without transferring its credential", async () => {
    const productionConfig = loadConfig({
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: dataDirectory("production"),
      MANIFOLD_OWNER_KEY: OWNER_KEY,
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_PREVIEW_DOMAIN: "localhost",
    });
    const production = await startServer({ config: productionConfig, announce: false });
    runningServers.push(production);

    const previewConfig = loadConfig({
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: dataDirectory("preview"),
      MANIFOLD_OWNER_KEY: "b".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_IDENTITY_AUTHORITY: production.publicUrl,
    });
    const preview = await startServer({ config: previewConfig, announce: false });
    runningServers.push(preview);
    previewConfig.publicUrl = `http://preview.localhost:${preview.port}`;

    const productionGrant = TokenGrantSchema.parse(
      await action(production.publicUrl, OWNER_KEY, "core.access.mint", {
        principal: { name: "restricted reviewer", kind: "human" },
        caps: ["containers:read"],
      }),
    );
    const start = await fetch(`${preview.publicUrl}/api/identity/preview-start`, {
      method: "POST",
    });
    expect(start.status).toBe(200);
    const { nonce } = PreviewIdentityNonceResponseSchema.parse(await start.json());
    const nonceCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    expect(nonceCookie).toMatch(/^manifold-preview-nonce=[A-Za-z0-9_-]{43}$/);
    expect(nonceCookie).not.toContain(nonce);
    const issue = await fetch(`${production.publicUrl}/api/identity/preview-assertion`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${productionGrant.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audience: previewConfig.publicUrl, nonce }),
    });
    expect(issue.status).toBe(200);
    const issued = PreviewIdentityAssertionSchema.parse(await issue.json());
    expect(issued.assertion).not.toContain(productionGrant.token);

    const stage = await fetch(`${preview.publicUrl}/auth/preview/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ assertion: issued.assertion }),
    });
    expect(stage.status).toBe(200);
    const callbackCookie = stage.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const missingNonce = await fetch(`${preview.publicUrl}/auth/preview/finalize`);
    expect(missingNonce.status).toBe(403);
    // An attacker can start the flow, then send its public nonce to a signed-in victim.
    // Only the victim receives the callback cookie; neither browser may finalize alone.
    const initiatorOnly = await fetch(`${preview.publicUrl}/auth/preview/finalize`, {
      headers: { cookie: nonceCookie ?? "" },
    });
    expect(initiatorOnly.status).toBe(403);
    const recipientOnly = await fetch(`${preview.publicUrl}/auth/preview/finalize`, {
      headers: { cookie: callbackCookie },
    });
    expect(recipientOnly.status).toBe(403);

    const accept = await fetch(`${preview.publicUrl}/auth/preview/finalize`, {
      headers: { cookie: `${nonceCookie ?? ""}; ${callbackCookie}` },
    });
    expect(accept.status).toBe(200);
    expect(accept.headers.get("cache-control")).toBe("no-store");
    expect(accept.headers.get("x-frame-options")).toBe("DENY");
    const callback = await accept.text();
    expect(callback).not.toContain(productionGrant.token);
    const localToken = /"token":"([^"]+)"/.exec(callback)?.[1];
    if (localToken === undefined) throw new Error("preview callback did not deliver a local token");
    expect(
      (
        await fetch(`${preview.publicUrl}/api/layout`, {
          headers: { authorization: `Bearer ${localToken}` },
        })
      ).status,
    ).toBe(200);
    const deniedMutation = ActionOutcomeSchema.parse(
      await (
        await fetch(`${preview.publicUrl}/api/actions/core.index.createContainer`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${localToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "must remain forbidden" }),
        })
      ).json(),
    );
    expect(deniedMutation.ok).toBeFalse();

    const replayStage = await fetch(`${preview.publicUrl}/auth/preview/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ assertion: issued.assertion }),
    });
    expect(replayStage.status).toBe(200);
    const replay = await fetch(`${preview.publicUrl}/auth/preview/finalize`, {
      headers: { cookie: `${nonceCookie ?? ""}; ${callbackCookie}` },
    });
    expect(replay.status).toBe(403);
    expect(
      (
        await fetch(`${production.publicUrl}/api/identity/preview-assertion`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ audience: previewConfig.publicUrl, nonce }),
        })
      ).status,
    ).toBe(401);
    const container = ContainerResponseSchema.parse(
      await action(production.publicUrl, OWNER_KEY, "core.index.createContainer", {
        name: "private production scope",
      }),
    ).container;
    const scopedGrant = TokenGrantSchema.parse(
      await action(production.publicUrl, OWNER_KEY, "core.access.mint", {
        principal: { name: "container reviewer", kind: "human" },
        caps: ["containers:read"],
        containerId: container.id,
      }),
    );
    const scopedIssue = await fetch(`${production.publicUrl}/api/identity/preview-assertion`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scopedGrant.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ audience: previewConfig.publicUrl, nonce }),
    });
    expect(scopedIssue.status).toBe(403);
  });
});
