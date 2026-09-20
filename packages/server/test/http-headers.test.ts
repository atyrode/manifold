import { expect, test } from "bun:test";
import { ACTION_RESULT_PROJECTION_HEADER, ACTION_TRACE_ID_HEADER } from "@manifold/protocol";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { startServer, type RunningServer } from "../src/main.ts";

test("direct static, SPA, error and API responses share baseline headers without widening shell CORS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-http-headers-"));
  let server: RunningServer | undefined;
  try {
    const webDist = join(directory, "web");
    mkdirSync(webDist);
    writeFileSync(join(webDist, "index.html"), "<!doctype html><title>Header fixture</title>");
    writeFileSync(join(webDist, "app.js"), "export const loaded = true;");
    server = await startServer({
      config: loadConfig({
        MANIFOLD_PORT: "0",
        MANIFOLD_DATA_DIR: join(directory, "data"),
        MANIFOLD_WEB_DIST: webDist,
        MANIFOLD_OWNER_KEY: "a".repeat(64),
        MANIFOLD_SPAWN_AGENT: "0",
      }),
      announce: false,
    });
    for (const [path, status, contentType] of [
      ["/app.js", 200, "javascript"],
      ["/nested/client-route", 200, "text/html"],
      ["/%zz", 400, "application/json"],
      ["/healthz", 200, "application/json"],
    ] as const) {
      const response = await fetch(`${server.publicUrl}${path}`, {
        headers: { origin: "https://lens.invalid" },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain(contentType);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("access-control-allow-origin")).toBe(
        path === "/healthz" ? "*" : null,
      );
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(response.headers.get("strict-transport-security")).toBeNull();
    }
    const preflight = await fetch(`${server.publicUrl}/api/actions/core.access.inspectRun`, {
      method: "OPTIONS",
      headers: {
        origin: "https://lens.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": ACTION_RESULT_PROJECTION_HEADER,
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      ACTION_RESULT_PROJECTION_HEADER,
    );
    for (const value of [
      "",
      "A".repeat(64),
      "a".repeat(63),
      `${"a".repeat(64)},${"b".repeat(64)}`,
    ]) {
      const response = await fetch(`${server.publicUrl}/api/actions/core.access.inspectRun`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${"a".repeat(64)}`,
          "content-type": "application/json",
          [ACTION_RESULT_PROJECTION_HEADER]: value,
        },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(response.headers.get(ACTION_TRACE_ID_HEADER)).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
    }
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
