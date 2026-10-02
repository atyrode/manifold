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

test("private credential document and its independent assets reject aliases and never fall back to the shell", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-private-headers-"));
  let server: RunningServer | undefined;
  try {
    const webDist = join(directory, "web");
    mkdirSync(join(webDist, "credential-entry-assets"), { recursive: true });
    mkdirSync(join(webDist, "nested"));
    const shell = "<!doctype html><title>Ordinary plugin shell</title>";
    const entry = "<!doctype html><title>Private credential fixture</title>";
    writeFileSync(join(webDist, "index.html"), shell);
    writeFileSync(join(webDist, "credential-entry.html"), entry);
    writeFileSync(join(webDist, "nested", "credential-entry.html"), entry);
    writeFileSync(join(webDist, "credential-entry-assets", "entry.js"), "export const privateEntry = true;");
    writeFileSync(join(webDist, "credential-entry-assets", "entry.css"), "body { color: white; }");
    writeFileSync(join(webDist, "credential-entry-assets", "credential-entry.html"), entry);
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

    for (const [path, status] of [
      ["/credential-entry.html", 200],
      ["/credential-entry.html?machineId=fixture&credentialRef=fixture", 200],
      ["/credential-entry-assets/entry.js", 200],
      ["/credential-entry-assets/entry.css", 200],
      ["/credential-entry", 404],
      ["/Credential-Entry.html", 404],
      ["/%63redential-entry.html", 404],
      ["/%2563redential-entry.html", 404],
      ["/credential%252dentry.html", 404],
      ["/%63redential-entry%zz.html", 404],
      ["/credential-entry.html/", 404],
      ["/nested/credential-entry.html", 404],
      ["/nested%2fcredential-entry.html", 404],
      ["/credential-entry-assets%2fentry.js", 404],
      ["/credential-entry-assets%252fentry.js", 404],
      ["/credential-entry-assets/credential-entry.html", 404],
      ["/credential-entry-assets/missing.js", 404],
      ["/credential-entry-missing.html", 404],
      ["/credential-entry%zz.html", 404],
    ] as const) {
      const response = await fetch(`${server.publicUrl}${path}`, {
        headers: { origin: "https://foreign-lens.invalid" },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("noopener-allow-popups");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain(`script-src ${server.publicUrl}/credential-entry-assets/`);
      expect(csp).toContain(`style-src ${server.publicUrl}/credential-entry-assets/`);
      expect(csp).toContain("connect-src https: http:");
      expect(csp).toContain("form-action 'none'");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(await response.text()).not.toBe(shell);
    }
    const head = await fetch(`${server.publicUrl}/credential-entry.html`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");
    const post = await fetch(`${server.publicUrl}/credential-entry.html`, { method: "POST" });
    expect(post.status).toBe(404);
    expect(post.headers.get("cache-control")).toBe("no-store");

    rmSync(join(webDist, "credential-entry.html"));
    const missing = await fetch(`${server.publicUrl}/credential-entry.html`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.text()).not.toBe(shell);
    const ordinary = await fetch(`${server.publicUrl}/ordinary/route`);
    expect(await ordinary.text()).toBe(shell);
    expect(ordinary.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(ordinary.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
