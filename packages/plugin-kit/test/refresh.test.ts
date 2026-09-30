import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRefreshFlags } from "../src/dev.ts";
import { PluginRefreshError, startPluginRefresh } from "../src/refresh.ts";
import type { PluginRefreshHandle } from "../src/refresh.ts";

const HUB = "http://127.0.0.1:1";

async function source(root: string, directory: string, id: string, server = false): Promise<string> {
  const dir = join(root, directory);
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "manifest.json"), JSON.stringify({
    id,
    version: "1.0.0",
    title: "Refresh boundary fixture",
    description: "A source module subject to installed-plugin admission.",
    capabilities: [],
    contributes: { panels: [{ id: "counter", title: "Counter" }] },
    entry: { web: "web.js", styles: true, ...(server ? { server: true } : {}) },
  }));
  await Bun.write(join(dir, "web.tsx"), `import { useState } from "react";
function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }
export default { id: ${JSON.stringify(id)}, panels: { counter: Counter } };
`);
  await Bun.write(join(dir, "styles.css"), `.plugin-${id.replaceAll(".", "_")} { color: rgb(1, 2, 3); }\n`);
  if (server) {
    await Bun.write(join(dir, "server.ts"), `import { protocol } from "./contract.ts"; export const backend = protocol;\n`);
    await Bun.write(join(dir, "contract.ts"), `export const protocol = "backend-v1";\n`);
  }
  return dir;
}

async function request(handle: PluginRefreshHandle, file: string): Promise<Response> {
  return fetch(new URL(`/@fs${file}`, handle.url), { signal: AbortSignal.timeout(5000) });
}

async function cancelled(handle: PluginRefreshHandle, file: string): Promise<Response> {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const response = await request(handle, file);
    if (response.status === 410) return response;
    await response.body?.cancel();
    // This integration observes the OS filesystem watcher; fake clocks cannot deliver its events.
    await Bun.sleep(25);
  }
  throw new Error("source was not cancelled after an installation-required edit");
}

test("source flags refuse installation authority and invalid listener ports before filesystem access", () => {
  expect(parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", "0"])).toEqual({ root: resolve("missing-root"), hub: HUB, port: 0 });
  expect(parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", "65535"]).port).toBe(65535);
  for (const flag of ["--owner-key-file", "--deliver", "--hardened"]) expect(() => parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, flag, "not-read"])).toThrow("cannot be used with --fast-refresh");
  for (const port of ["-1", "65536", "1.5", "NaN", ""]) expect(() => parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", port])).toThrow("--port");
  expect(() => parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--poert", "42"])).toThrow("unknown flag");
  expect(() => parseRefreshFlags(["one", "two", "--fast-refresh", "--hub", HUB])).toThrow("exactly one");
});

test("CLI help and description require neither a source, a hub nor an owner key", async () => {
  for (const flag of ["--help", "--describe"]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/dev.ts"), "nonexistent-source", "--fast-refresh", flag], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MANIFOLD_OWNER_KEY_FILE: "/nonexistent-owner-key-for-refresh-description" },
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit).toBe(0);
    expect(stderr).not.toContain("owner key");
    if (flag === "--describe") {
      const description: unknown = JSON.parse(stdout);
      expect(description).toMatchObject({ mode: "frontend-source", binding: "127.0.0.1" });
    }
  }
});

test("public handle serves multiple explicit entries, proxies ordinary hub routes and releases its listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-lifetime-"));
  const hub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (incoming) => new Response(new URL(incoming.url).pathname) });
  let handle: PluginRefreshHandle | undefined;
  try {
    const first = await source(root, "parent", "example.refresh");
    const second = await source(root, "parent/child", "example.refresh.child");
    handle = await startPluginRefresh({ root, hub: hub.url.origin, port: 0 });
    expect(handle.plugins).toEqual(["example.refresh", "example.refresh.child"]);
    expect(handle.sources.map((item) => item.manifest.id)).toEqual(handle.plugins);
    expect(new URL(handle.url).hostname).toBe("127.0.0.1");
    expect(new URL(handle.url).searchParams.get("instance")).toBe(hub.url.origin);
    for (const directory of [first, second]) expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    for (const path of ["/healthz", "/auth/session", "/api/protocol"]) expect(await (await fetch(new URL(path, handle.url))).text()).toBe(path);
    await Promise.all([handle.close(), handle.close(), handle.closed]);
    await expect(fetch(handle.url)).rejects.toThrow();
  } finally {
    await handle?.close();
    await hub.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("HTTP source boundaries refuse arbitrary modules, secrets, encoded traversal and symlink escapes without cancelling legitimate entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-boundaries-"));
  const outside = await mkdtemp(join(tmpdir(), "plugin-refresh-outside-"));
  let handle: PluginRefreshHandle | undefined;
  try {
    const directory = await source(root, "plugin", "example.refresh");
    const privateFile = join(directory, "private.ts");
    await Bun.write(privateFile, 'export const content = "PRIVATE_SOURCE_MARKER";');
    await Bun.write(join(outside, "public.ts"), 'export const content = "OUTSIDE_SOURCE_MARKER";');
    await symlink(join(outside, "public.ts"), join(directory, "escaped.ts"));
    for (const name of [".env", ".env.local", "owner.key", "credentials.json", ".git/config"]) await Bun.write(join(directory, name), "PRIVATE_SOURCE_MARKER");
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    for (const file of [privateFile, join(directory, "escaped.ts"), join(outside, "public.ts"), ...[".env", ".env.local", "owner.key", "credentials.json", ".git/config"].map((name) => join(directory, name))]) {
      const response = await request(handle, file);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("SOURCE_MARKER");
    }
    const traversal = await fetch(`${new URL(handle.url).origin}/@fs${directory}/%252e%252e/private.ts`);
    expect(traversal.status).toBe(403);
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 30000);

test("source startup refuses symlinked entry escapes, missing explicit entries and unscoped stylesheet forms", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-startup-"));
  const outside = await mkdtemp(join(tmpdir(), "plugin-refresh-entry-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    await rm(join(directory, "web.tsx"));
    await Bun.write(join(outside, "entry.tsx"), 'export default { id: "example.refresh" };');
    await symlink(join(outside, "entry.tsx"), join(directory, "web.tsx"));
    await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({ reason: "source_boundary" });
    await rm(join(directory, "web.tsx"));
    await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({ reason: "missing_entry" });
    await source(root, "plugin", "example.refresh");
    for (const css of ["body { color: red; }", '@import "./another.css";', ".plugin-example_refresh { .foreign & { color: red; } }"]) {
      await Bun.write(join(directory, "styles.css"), css);
      await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({ reason: "stylesheet_unscoped" });
    }
    await expect(startPluginRefresh({ root, hub: HUB, port: 65536 })).rejects.toBeInstanceOf(PluginRefreshError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("real external package imports are registered narrowly and dependency edits cancel the installed source lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-dependency-"));
  const packageRoot = await mkdtemp(join(tmpdir(), "plugin-refresh-package-"));
  let handle: PluginRefreshHandle | undefined;
  try {
    const directory = await source(root, "plugin", "example.refresh");
    await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "external-ui": "1.0.0" } }));
    await mkdir(join(root, "node_modules"), { recursive: true });
    await Bun.write(join(packageRoot, "package.json"), JSON.stringify({ name: "external-ui", version: "1.0.0", type: "module", exports: "./index.tsx" }));
    await Bun.write(join(packageRoot, "index.tsx"), 'import { useState } from "react"; export function Counter() { const [n] = useState(7); return <span>{n}</span>; }');
    await Bun.write(join(packageRoot, "private.ts"), 'export const secret = "UNREGISTERED_PACKAGE_MARKER";');
    await symlink(packageRoot, join(root, "node_modules/external-ui"));
    await Bun.write(join(directory, "web.tsx"), 'import { Counter } from "external-ui"; export default { id: "example.refresh", panels: { counter: Counter } };');
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    expect((await request(handle, join(packageRoot, "index.tsx"))).status).toBe(403);
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    expect((await request(handle, join(packageRoot, "index.tsx"))).status).toBe(200);
    expect((await request(handle, join(packageRoot, "private.ts"))).status).toBe(403);
    await Bun.write(join(packageRoot, "index.tsx"), 'export function Counter() { return <span>changed dependency</span>; }');
    expect((await cancelled(handle, join(directory, "web.tsx"))).status).toBe(410);
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
}, 30000);

test("backend shared-contract and manifest edits terminate admission until an explicit process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-installation-"));
  let handle: PluginRefreshHandle | undefined;
  try {
    const directory = await source(root, "plugin", "example.refresh", true);
    await Bun.write(join(directory, "web.tsx"), 'import { protocol } from "./contract.ts"; export default { id: "example.refresh", panels: {} }; console.log(protocol);');
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    expect((await request(handle, join(directory, "server.ts"))).status).toBe(403);
    await Bun.write(join(directory, "contract.ts"), 'export const protocol = "backend-v2";');
    expect((await cancelled(handle, join(directory, "web.tsx"))).status).toBe(410);
    await Bun.write(join(directory, "contract.ts"), 'export const protocol = "backend-v1";');
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(410);
    await handle.close();
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    const manifestFile = join(directory, "manifest.json");
    const manifest = await Bun.file(manifestFile).json();
    await Bun.write(manifestFile, JSON.stringify({ ...manifest, version: "1.0.1" }));
    expect((await cancelled(handle, join(directory, "web.tsx"))).status).toBe(410);
    expect(handle.sources[0]?.manifest.version).toBe("1.0.0");
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
