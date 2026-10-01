import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseRefreshFlags } from "../src/dev.ts";
import { PluginRefreshError, startPluginRefresh } from "../src/refresh.ts";
import type { PluginRefreshHandle } from "../src/refresh.ts";

const HUB = "http://127.0.0.1:1";

async function source(
  root: string,
  directory: string,
  id: string,
  server = false,
): Promise<string> {
  const dir = join(root, directory);
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "manifest.json"),
    JSON.stringify({
      id,
      version: "1.0.0",
      title: "Refresh boundary fixture",
      description: "A source module subject to installed-plugin admission.",
      capabilities: [],
      contributes: { panels: [{ id: "counter", title: "Counter" }] },
      entry: { web: "web.js", styles: true, ...(server ? { server: true } : {}) },
    }),
  );
  await Bun.write(
    join(dir, "web.tsx"),
    `import { useState } from "react";
function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }
export default { id: ${JSON.stringify(id)}, panels: { counter: Counter } };
`,
  );
  await Bun.write(
    join(dir, "styles.css"),
    `.plugin-${id.replaceAll(".", "_")} { color: rgb(1, 2, 3); }\n`,
  );
  if (server) {
    await Bun.write(
      join(dir, "server.ts"),
      `import { protocol } from "./contract.ts"; export const backend = protocol;\n`,
    );
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
  expect(
    parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", "0"]),
  ).toEqual({ root: resolve("missing-root"), hub: HUB, port: 0 });
  expect(
    parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", "65535"]).port,
  ).toBe(65535);
  for (const flag of ["--owner-key-file", "--deliver", "--hardened"])
    expect(() =>
      parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, flag, "not-read"]),
    ).toThrow("cannot be used with --fast-refresh");
  for (const port of ["-1", "65536", "1.5", "NaN", ""])
    expect(() =>
      parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--port", port]),
    ).toThrow("--port");
  expect(() =>
    parseRefreshFlags(["missing-root", "--fast-refresh", "--hub", HUB, "--poert", "42"]),
  ).toThrow("unknown flag");
  expect(() => parseRefreshFlags(["one", "two", "--fast-refresh", "--hub", HUB])).toThrow(
    "exactly one",
  );
});

test("public handle serves multiple explicit entries and releases its listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-lifetime-"));
  let handle: PluginRefreshHandle | undefined;
  const hub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => Response.json({ path: new URL(request.url).pathname }),
  });
  try {
    const first = await source(root, "parent", "example.refresh");
    const second = await source(root, "parent/child", "example.refresh.child");
    handle = await startPluginRefresh({ root, hub: hub.url.origin, port: 0 });
    expect(handle.plugins).toEqual(["example.refresh", "example.refresh.child"]);
    expect(new URL(handle.url).hostname).toBe("127.0.0.1");
    expect(new URL(handle.url).searchParams.get("instance")).toBe(hub.url.origin);
    for (const path of ["/api/development-proxy", "/healthz", "/auth/development-proxy"]) {
      const response = await fetch(new URL(path, handle.url));
      expect(await response.json()).toEqual({ path });
    }
    for (const directory of [first, second])
      expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
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
    for (const name of [".env", ".env.local", "owner.key", "credentials.json", ".git/config"])
      await Bun.write(join(directory, name), "PRIVATE_SOURCE_MARKER");
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    for (const file of [
      privateFile,
      join(directory, "escaped.ts"),
      join(outside, "public.ts"),
      ...[".env", ".env.local", "owner.key", "credentials.json", ".git/config"].map((name) =>
        join(directory, name),
      ),
    ]) {
      const response = await request(handle, file);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("SOURCE_MARKER");
      for (const prefix of ["/@id/", "/@id/%2F"]) {
        const wrapped = await fetch(
          new URL(prefix + (prefix.endsWith("%2F") ? file.slice(1) : file) + "?raw", handle.url),
        );
        expect(wrapped.status).toBe(403);
        expect(await wrapped.text()).not.toContain("SOURCE_MARKER");
      }
    }
    const traversal = await fetch(
      `${new URL(handle.url).origin}/@fs${directory}/%252e%252e/private.ts`,
    );
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
    await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({
      reason: "source_boundary",
    });
    await rm(join(directory, "web.tsx"));
    await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({
      reason: "missing_entry",
    });
    await source(root, "plugin", "example.refresh");
    for (const css of [
      "body { color: red; }",
      '@import "./another.css";',
      ".plugin-example_refresh { .foreign & { color: red; } }",
    ]) {
      await Bun.write(join(directory, "styles.css"), css);
      await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({
        reason: "stylesheet_unscoped",
      });
    }
    await expect(startPluginRefresh({ root, hub: HUB, port: 65536 })).rejects.toBeInstanceOf(
      PluginRefreshError,
    );
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
    await Bun.write(
      join(root, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies: { "external-ui": "1.0.0" } }),
    );
    await mkdir(join(root, "node_modules"), { recursive: true });
    await Bun.write(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "external-ui",
        version: "1.0.0",
        type: "module",
        exports: "./index.tsx",
      }),
    );
    await Bun.write(
      join(packageRoot, "index.tsx"),
      'import { useState } from "react"; export function Counter() { const [n] = useState(7); return <span>{n}</span>; }',
    );
    await Bun.write(
      join(packageRoot, "private.ts"),
      'export const secret = "UNREGISTERED_PACKAGE_MARKER";',
    );
    await symlink(packageRoot, join(root, "node_modules/external-ui"));
    await Bun.write(
      join(directory, "web.tsx"),
      'import { Counter } from "external-ui"; export default { id: "example.refresh", panels: { counter: Counter } };',
    );
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    expect((await request(handle, join(packageRoot, "index.tsx"))).status).toBe(403);
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    expect((await request(handle, join(packageRoot, "index.tsx"))).status).toBe(200);
    expect((await request(handle, join(packageRoot, "private.ts"))).status).toBe(403);
    await Bun.write(
      join(packageRoot, "index.tsx"),
      "export function Counter() { return <span>changed dependency</span>; }",
    );
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
    await Bun.write(
      join(directory, "web.tsx"),
      'import { protocol } from "./contract.ts"; export default { id: "example.refresh", panels: {} }; console.log(protocol);',
    );
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

test("source transforms reject secret and outside-root asset inlining before Vite can read bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-assets-"));
  const outside = await mkdtemp(join(tmpdir(), "plugin-refresh-asset-outside-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    await Bun.write(join(directory, ".env"), "SECRET_ASSET_MARKER");
    const outsideFile = join(outside, "payload.txt");
    await Bun.write(outsideFile, "OUTSIDE_ASSET_MARKER");
    for (const asset of [".env?inline", outsideFile + "?inline"]) {
      await Bun.write(
        join(directory, "web.tsx"),
        `export default { id: "example.refresh", panels: {} }; export const asset = new URL(${JSON.stringify(asset)}, import.meta.url);`,
      );
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        const response = await request(handle, join(directory, "web.tsx"));
        expect(response.ok).toBe(false);
        const body = await response.text();
        expect(body).not.toContain("SECRET_ASSET_MARKER");
        expect(body).not.toContain("OUTSIDE_ASSET_MARKER");
      } finally {
        await handle.close();
      }
    }
    await Bun.write(
      join(directory, "web.tsx"),
      'import "./unsafe.css"; export default { id: "example.refresh", panels: {} };',
    );
    for (const target of [".env?inline", outsideFile + "?inline"]) {
      await Bun.write(
        join(directory, "unsafe.css"),
        `.plugin-example_refresh { background: url(${JSON.stringify(target)}); }`,
      );
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
        const response = await request(handle, join(directory, "unsafe.css"));
        expect(response.ok).toBe(false);
        const body = await response.text();
        expect(body).not.toContain("SECRET_ASSET_MARKER");
        expect(body).not.toContain("OUTSIDE_ASSET_MARKER");
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 30000);

test("one plugin cannot import a sibling's backend, including a server-only sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-sibling-"));
  try {
    const first = await source(root, "first", "example.first");
    const second = await source(root, "second", "example.second", true);
    for (const serverOnly of [false, true]) {
      if (serverOnly) {
        const file = join(second, "manifest.json");
        const manifest = await Bun.file(file).json();
        await Bun.write(
          file,
          JSON.stringify({ ...manifest, contributes: {}, entry: { server: true } }),
        );
      }
      await Bun.write(
        join(first, "web.tsx"),
        'import "../second/server.ts"; export default { id: "example.first", panels: {} };',
      );
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        const response = await request(handle, join(first, "web.tsx"));
        expect(response.ok).toBe(false);
        expect(await response.text()).not.toContain("backend-v1");
        expect((await request(handle, join(second, "server.ts"))).status).toBe(403);
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("declared native bundle members must be regular files, not source-serving symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-native-"));
  const outside = await mkdtemp(join(tmpdir(), "plugin-refresh-native-outside-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    const manifestFile = join(directory, "manifest.json");
    const manifest = await Bun.file(manifestFile).json();
    await Bun.write(
      manifestFile,
      JSON.stringify({
        ...manifest,
        machine: {
          artifacts: {
            "linux-x64": {
              bundleFile: "native",
              sha256: "0".repeat(64),
              entrySha256: "0".repeat(64),
              format: "raw",
              entry: ["native"],
              maxBytes: 64,
              maxExpandedBytes: 64,
              maxMembers: 1,
            },
          },
          locations: {},
          operations: {
            "example.refresh.run": {
              argv: [],
              input: {},
              runtimeTools: [],
              locations: [],
              outputs: [],
              network: "none",
              stdin: false,
              limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 4096 },
            },
          },
        },
      }),
    );
    await Bun.write(join(outside, "payload"), "OUTSIDE_NATIVE_MARKER");
    await symlink(join(outside, "payload"), join(directory, "native"));
    await expect(startPluginRefresh({ root, hub: HUB, port: 0 })).rejects.toMatchObject({
      reason: "source_boundary",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("unsupported stylesheet dialects cannot bypass plugin-root CSS admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-styles-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    for (const extension of [".pcss", ".postcss", ".scss"]) {
      await Bun.write(
        join(directory, "web.tsx"),
        `import "./extra${extension}"; export default { id: "example.refresh", panels: {} };`,
      );
      await Bun.write(join(directory, "extra" + extension), "body { color: red; }");
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
        expect((await request(handle, join(directory, "extra" + extension))).ok).toBe(false);
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("implicit Vite readers cannot compose CSS Modules, follow authored source maps or enumerate source globs", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-implicit-"));
  const outside = await mkdtemp(join(tmpdir(), "plugin-refresh-map-outside-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    const web = join(directory, "web.tsx");
    const mapped = join(outside, "mapped-private.ts");
    await Bun.write(mapped, "PRIVATE_MAPPED_SOURCE_MARKER");
    await Bun.write(join(directory, ".env"), "PRIVATE_COMPOSED_SOURCE_MARKER");
    await Bun.write(join(directory, "unsafe.css"), '.x { background: url("./.env?inline"); }\n');
    await Bun.write(
      join(directory, "unsafe.module.css"),
      '.plugin-example_refresh { composes: x from "./unsafe.css"; }\n',
    );
    await Bun.write(
      join(directory, "plain.css"),
      '.plugin-example_refresh { composes: x from "./unsafe.css"; }\n',
    );
    const map = Buffer.from(
      JSON.stringify({ version: 3, sources: [mapped], names: [], mappings: "AAAA" }),
    ).toString("base64");
    for (const [contents, target] of [
      [
        'import "./unsafe.module.css"; export default { id: "example.refresh", panels: {} };',
        join(directory, "unsafe.module.css"),
      ],
      [
        'import "./plain.css?x.module.css"; export default { id: "example.refresh", panels: {} };',
        join(directory, "plain.css") + "?x.module.css",
      ],
      [
        'import "./plain.css?x.module.scss"; export default { id: "example.refresh", panels: {} };',
        join(directory, "plain.css") + "?x.module.scss",
      ],
      [
        `export default { id: "example.refresh", panels: {} };\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
        web,
      ],
      [
        `export const paths = Object.keys(import.meta.glob("../../${outside.slice(outside.lastIndexOf("/") + 1)}/mapped-private.ts", { exhaustive: true })); export default { id: "example.refresh", panels: {} };`,
        web,
      ],
    ] as const) {
      await Bun.write(web, contents);
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        const entry = await request(handle, web);
        const response = target === web ? entry : await request(handle, target);
        expect(response.ok).toBe(false);
        const body = await response.text();
        expect(body).not.toContain("PRIVATE_MAPPED_SOURCE_MARKER");
        expect(body).not.toContain("PRIVATE_COMPOSED_SOURCE_MARKER");
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}, 30000);

test("source descriptors accept local default specifiers and default re-exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-exports-"));
  try {
    const directory = await source(root, "plugin", "example.refresh");
    await Bun.write(
      join(directory, "definition.ts"),
      'export const definition = { id: "example.refresh", panels: {} }; export default definition;',
    );
    for (const contents of [
      'const definition = { id: "example.refresh", panels: {} }; export { definition as default };',
      'export { default } from "./definition.ts";',
      'export { definition as default } from "./definition.ts";',
    ]) {
      const web = join(directory, "web.tsx");
      await Bun.write(web, contents);
      const handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
      try {
        expect((await request(handle, web)).status).toBe(200);
      } finally {
        await handle.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("selected sources retain shared author modules but lease a nested foreign package as immutable dependency inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-package-ownership-"));
  let handle: PluginRefreshHandle | undefined;
  try {
    const directory = await source(root, "plugin", "example.refresh");
    const foreign = await source(root, "generated/foreign", "example.foreign");
    await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await Bun.write(join(foreign, "package.json"), JSON.stringify({ name: "foreign-input", type: "module" }));
    await Bun.write(join(foreign, "styles.css"), "body { color: red; }");
    await Bun.write(join(foreign, "value.ts"), 'export const value = "pinned-dependency";');
    await Bun.write(join(root, "shared.ts"), 'import { value } from "./generated/foreign/value.ts"; export const shared = value;');
    await Bun.write(join(directory, "web.tsx"), `import { shared } from "../shared.ts"; export const value = shared; export default { id: "example.refresh", panels: {} };`);
    handle = await startPluginRefresh({ root, hub: HUB, port: 0, sourceDirectories: [directory] });
    expect(handle.plugins).toEqual(["example.refresh"]);
    expect((await request(handle, join(directory, "web.tsx"))).status).toBe(200);
    expect((await request(handle, join(root, "shared.ts"))).status).toBe(200);
    expect((await request(handle, join(foreign, "value.ts"))).status).toBe(200);
    expect((await request(handle, join(foreign, "web.tsx"))).status).toBe(403);
    await Bun.write(join(foreign, "value.ts"), 'export const value = "changed-dependency";');
    expect((await cancelled(handle, join(directory, "web.tsx"))).status).toBe(410);
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("the public source listener preserves its exact Host admission and TLS HMR client endpoint while using its owned loopback socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-refresh-public-transport-"));
  const previousHost = process.env.MANIFOLD_DEV_HOST;
  const publicHost = "preview.manifold.example";
  let handle: PluginRefreshHandle | undefined;
  let socket: WebSocket | undefined;
  try {
    process.env.MANIFOLD_DEV_HOST = publicHost;
    const directory = await source(root, "plugin", "example.refresh");
    handle = await startPluginRefresh({ root, hub: HUB, port: 0 });
    const entryUrl = new URL(`/@fs${join(directory, "web.tsx")}`, handle.url);
    expect((await fetch(entryUrl, { headers: { Host: publicHost } })).status).toBe(200);
    expect((await fetch(entryUrl, { headers: { Host: "unlisted.manifold.example" } })).status).toBe(403);
    expect((await fetch(entryUrl, { headers: { Host: `subdomain.${publicHost}` } })).status).toBe(403);
    const response = await fetch(new URL("/@vite/client", handle.url), { headers: { Host: publicHost } });
    expect(response.status).toBe(200);
    const client = await response.text();
    // Execute the actual served client's endpoint calculation, rather than checking a config copy.
    const declarations = client.match(/const socketProtocol =[\s\S]*?(?=const forwardConsole =)/)?.[0];
    if (!declarations) throw new Error("Vite client has no executable websocket transport declarations");
    const { endpoint, token } = new Function("importMetaUrl", `${declarations}; return { endpoint: socketProtocol + "://" + socketHost, token: wsToken };`)(
      new URL("/@vite/client", handle.url),
    ) as { endpoint: string; token: string };
    expect(endpoint).toBe(`wss://${publicHost}:443/`);
    // The TLS router is external to this fixture; exercise the same supplied socket on loopback.
    const local = new URL(endpoint);
    local.protocol = "ws:";
    local.hostname = "127.0.0.1";
    local.port = new URL(handle.url).port;
    local.searchParams.set("token", token);
    socket = new WebSocket(local, "vite-hmr");
    const connected = Promise.withResolvers<unknown>();
    const deadline = AbortSignal.timeout(5000);
    // This handshake crosses a real OS socket; deterministic timers cannot deliver its frame.
    deadline.addEventListener("abort", () => connected.reject(new Error("source HMR socket did not connect")), { once: true });
    socket.addEventListener("error", () => connected.reject(new Error("source HMR socket failed")), { once: true });
    socket.addEventListener("message", ({ data }) => connected.resolve(JSON.parse(String(data))), { once: true });
    expect(await connected.promise).toEqual({ type: "connected" });
  } finally {
    socket?.close();
    await handle?.close();
    if (previousHost === undefined) delete process.env.MANIFOLD_DEV_HOST;
    else process.env.MANIFOLD_DEV_HOST = previousHost;
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
