import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PluginManifestSchema } from "@manifold/protocol";
import { dispatch, ownerAction, roster } from "../src/hub.ts";
import { inspectBundle, installBundle } from "../src/install.ts";
import { packPlugin } from "../src/pack.ts";
import { canSpawnServer, startServer } from "../src/verify.ts";
import type { SpawnedServer } from "../src/verify.ts";
import { parseRefreshFlags, parseWorkshopFlags } from "../src/dev.ts";

const ID = "example.workshop";
const RUNNER = join(import.meta.dir, "fixtures/workshop/runner.ts");

interface Event {
  readonly event: string;
  readonly url?: string;
  readonly outputDir?: string;
}

interface WorkshopProcess {
  readonly events: Event[];
  event(name: string, after?: number): Promise<Event>;
  stop(expectedExit?: number): Promise<void>;
}

async function fixture(root: string, native = false): Promise<string> {
  const directory = join(root, "plugin");
  await mkdir(join(directory, "child"), { recursive: true });
  await mkdir(join(root, "domain"));
  await mkdir(join(root, "shared"));
  await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await Bun.write(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@workshop/*": ["domain/*"] } } }));
  await symlink(resolve(import.meta.dir, "../../../node_modules"), join(root, "node_modules"));
  await Bun.write(join(root, "domain/value.ts"), 'import data from "../shared/value.json"; export const label = data.label;');
  await Bun.write(join(root, "shared/value.json"), JSON.stringify({ label: "original-backend" }));
  const payload = "#!/bin/sh\nexit 0\n";
  const digest = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  const machine = native ? {
    artifacts: { "linux-x64": { bundleFile: "native", sha256: digest, entrySha256: digest, format: "raw", entry: ["native"], maxBytes: 64, maxExpandedBytes: 64, maxMembers: 1 } },
    locations: {},
    operations: {
      [`${ID}.run`]: { argv: [], input: {}, runtimeTools: [], locations: [], outputs: [], network: "none", stdin: false, limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 4096 } },
    },
  } : undefined;
  const manifest = PluginManifestSchema.parse({
    id: ID, version: "1.0.0", title: "Workshop regression", description: "Installed backend and approved source development share transitive inputs.",
    capabilities: ["containers:read"], contributes: { panels: [{ id: "counter", title: "Counter" }] },
    entry: { server: true, web: "web.js", styles: true }, ...(machine ? { machine } : {}),
  });
  await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest));
  if (native) await Bun.write(join(directory, "native"), payload);
  await Bun.write(join(directory, "server.ts"), serverSource());
  await Bun.write(join(directory, "web.tsx"), frontend("original-frontend"));
  await Bun.write(join(directory, "styles.css"), ".plugin-example_workshop { color: rgb(1, 2, 3); }");
  await Bun.write(join(directory, "child/manifest.json"), JSON.stringify({
    id: `${ID}.child`, version: "1.0.0", title: "Workshop child", description: "A later family compilation must complete before the parent installs.",
    capabilities: [], contributes: {}, entry: { server: true, web: "web.js" },
  }));
  await Bun.write(join(directory, "child/server.ts"), `import { defineServerPlugin } from "@manifold/plugin-kit/server"; import { PluginManifestSchema } from "@manifold/protocol"; import manifest from "./manifest.json"; const plugin = { manifest: PluginManifestSchema.parse(manifest), actions: [], handlers: {} }; defineServerPlugin(plugin); export default plugin;`);
  await Bun.write(join(directory, "child/web.tsx"), `export default { id: "${ID}.child", panels: {} };`);
  await Bun.write(join(root, "private.ts"), 'export const value = "UNREGISTERED_WORKSHOP_MARKER";');
  await Bun.write(join(root, "owner.key"), "DENIED_WORKSHOP_MARKER");
  return directory;
}

function frontend(marker: string): string {
  return `import { useState } from "react"; import { label } from "../domain/value.ts";
export function Counter() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{label} ${marker} {n}</button>; }
export default { id: "${ID}", panels: { counter: Counter } };`;
}

function serverSource(caps = '["containers:read"]'): string {
  return `import { defineServerAction, defineServerPlugin } from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
import { z } from "zod";
import manifest from "./manifest.json";
import { label } from "@workshop/value";
const read = defineServerAction({ name: "read", title: "Read", caps: ${caps}, input: z.strictObject({}), result: z.strictObject({ label: z.string(), count: z.number().int() }) });
const plugin = { manifest: PluginManifestSchema.parse(manifest), actions: [read], handlers: {
  async read(ctx) { const count = Number(await ctx.storage.get("count") ?? "0") + 1; await ctx.storage.set("count", String(count)); return { label, count }; }
} }; defineServerPlugin(plugin); export default plugin;`;
}

async function installFamily(root: string, server: SpawnedServer): Promise<void> {
  for (const [id, source] of [[ID, "plugin"], [`${ID}.child`, "plugin/child"]] as const) {
    const file = join(root, "dist", `${id}.manifold-plugin.json`);
    await packPlugin(join(root, source), file);
    await installBundle({ source: file, hub: server });
  }
}

function launch(root: string, server: SpawnedServer, blockBuild = false): WorkshopProcess {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("MANIFOLD_") && !name.startsWith("WORKSHOP_TEST_")));
  const child = Bun.spawn([process.execPath, RUNNER, root, server.url], {
    env: { ...env, NODE_ENV: "development", WORKSHOP_TEST_OWNER_KEY: server.ownerKey, WORKSHOP_TEST_BLOCK_BUILD: blockBuild ? "1" : "" },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const events: Event[] = [];
  let diagnostic = "";
  const consume = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    let carry = "";
    for await (const chunk of stream) {
      carry += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        try {
          const event: unknown = JSON.parse(line);
          if (typeof event === "object" && event !== null && "event" in event && typeof event.event === "string") events.push(event as Event);
        } catch { diagnostic = `${diagnostic}\n${line}`.slice(-4000); }
      }
    }
  };
  const drain = Promise.all([consume(child.stdout), consume(child.stderr)]);
  const event = async (name: string, after = 0): Promise<Event> => {
    // These events cross a real child process and OS watcher; fake time cannot deliver them.
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      const found = events.slice(after).find((entry) => entry.event === name);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`workshop exited ${child.exitCode}: ${diagnostic}; events: ${JSON.stringify(events)}`);
      await Bun.sleep(25);
    }
    throw new Error(`workshop did not report ${name}: ${diagnostic}; events: ${JSON.stringify(events)}`);
  };
  const stop = async (expectedExit = 0): Promise<void> => {
    if (child.exitCode === null) child.kill("SIGTERM");
    // Bound cleanup of the actual process rather than replacing its platform signal handling.
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try { expect(await child.exited).toBe(expectedExit); await drain; }
    finally { clearTimeout(timeout); }
  };
  return { events, event, stop };
}

async function read(server: SpawnedServer): Promise<{ label: string; count: number }> {
  const outcome = await dispatch(server, server.ownerKey, `${ID}.read`, {});
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(outcome.denial.rule);
  return outcome.result as { label: string; count: number };
}

async function pin(server: SpawnedServer): Promise<string | undefined> {
  return (await roster(server)).find((row) => row.manifest.id === ID)?.install?.sha256;
}

async function sourceResponse(url: string, file: string): Promise<Response> {
  return fetch(new URL(`/@fs${file}`, url), { signal: AbortSignal.timeout(5000) });
}

test("installation modes remain exclusive and reject malformed workshop ports without acquiring credentials", () => {
  const hub = "http://127.0.0.1:1";
  for (const incompatible of ["--fast-refresh", "--hardened"])
    expect(() => parseWorkshopFlags(["root", "--workshop", incompatible, "--hub", hub])).toThrow("cannot be used");
  for (const port of ["-1", "65536", "1.5", "NaN", ""])
    expect(() => parseWorkshopFlags(["root", "--workshop", "--hub", hub, "--port", port])).toThrow("--port");
  expect(() => parseRefreshFlags(["root", "--fast-refresh", "--hub", hub, "--workshop"])).toThrow("unknown flag");
  expect(() => parseWorkshopFlags(["root", "--workshop", "--hub", hub, "--build-module", "--deliver"])).toThrow("module path");
});

test.skipIf(!canSpawnServer())("frontend-only saves avoid compilation/install; alias-resolved shared JSON updates the backend; failed family compile retains backend and correction recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-workshop-behavior-"));
  const server = await startServer();
  let workshop: WorkshopProcess | undefined;
  try {
    const directory = await fixture(root);
    await installFamily(root, server);
    workshop = launch(root, server);
    const ready = await workshop.event("plugin-workshop-ready");
    const url = ready.url!;
    expect(new URL(url).hostname).toBe("127.0.0.1");
    expect((await sourceResponse(url, join(directory, "web.tsx"))).status).toBe(200);
    for (const denied of [join(root, "private.ts"), join(root, "owner.key"), join(directory, "server.ts"), join(directory, "child/server.ts")])
      expect((await sourceResponse(url, denied)).status).toBe(403);
    const originalPin = await pin(server);
    expect(await read(server)).toEqual({ label: "original-backend", count: 1 });
    const buildCount = workshop.events.filter(({ event }) => event === "workshop-test-build").length;
    await Bun.write(join(directory, "web.tsx"), frontend("changed-frontend"));
    await Bun.write(join(directory, "styles.css"), ".plugin-example_workshop { color: rgb(9, 8, 7); }");
    expect(await (await sourceResponse(url, join(directory, "web.tsx"))).text()).toContain("changed-frontend");
    // The negative assertion spans the real filesystem debounce in a separate process.
    await Bun.sleep(750);
    expect(workshop.events.filter(({ event }) => event === "workshop-test-build").length).toBe(buildCount);
    expect(await pin(server)).toBe(originalPin);
    let checkpoint = workshop.events.length;
    await Bun.write(join(root, "shared/value.json"), JSON.stringify({ label: "changed-shared-backend" }));
    await workshop.event("plugin-workshop-ready", checkpoint);
    expect(await pin(server)).not.toBe(originalPin);
    expect(await read(server)).toEqual({ label: "changed-shared-backend", count: 2 });
    const retainedPin = await pin(server);
    checkpoint = workshop.events.length;
    // The first bundle compiles, but the later child's browser half fails the full-family pack.
    await Bun.write(join(directory, "child/web.tsx"), "export default { broken syntax;");
    await Bun.write(join(root, "shared/value.json"), JSON.stringify({ label: "recovered-backend" }));
    await workshop.event("plugin-workshop-cycle-failed", checkpoint);
    expect(await pin(server)).toBe(retainedPin);
    expect(await read(server)).toEqual({ label: "changed-shared-backend", count: 3 });
    checkpoint = workshop.events.length;
    await Bun.write(join(directory, "child/web.tsx"), `export default { id: "${ID}.child", panels: {} };`);
    await workshop.event("plugin-workshop-ready", checkpoint);
    expect(await read(server)).toEqual({ label: "recovered-backend", count: 4 });
    expect((await sourceResponse(url, join(directory, "web.tsx"))).status).toBe(200);
    const outputDir = workshop.events.find(({ event }) => event === "workshop-test-build")?.outputDir!;
    expect(await Bun.file(join(outputDir, `${ID}.manifold-plugin.json`)).exists()).toBe(true);
    await workshop.stop();
    expect(await Bun.file(join(outputDir, `${ID}.manifold-plugin.json`)).exists()).toBe(false);
    await expect(fetch(url, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    expect(await read(server)).toEqual({ label: "recovered-backend", count: 5 });
    workshop = undefined;
  } finally {
    await workshop?.stop();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test.skipIf(!canSpawnServer())("same-manifest action authority edits refuse the entire installation and cannot resume implicitly after reverting", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-workshop-authority-"));
  const server = await startServer();
  let workshop: WorkshopProcess | undefined;
  try {
    const directory = await fixture(root);
    await installFamily(root, server);
    workshop = launch(root, server);
    const ready = await workshop.event("plugin-workshop-ready");
    const retainedPin = await pin(server);
    expect(await read(server)).toEqual({ label: "original-backend", count: 1 });
    await Bun.write(join(directory, "server.ts"), serverSource("[]"));
    await workshop.event("plugin-workshop-refused");
    expect(await pin(server)).toBe(retainedPin);
    expect(await read(server)).toEqual({ label: "original-backend", count: 2 });
    await Bun.write(join(directory, "server.ts"), serverSource());
    // A reverted file must remain refused across the real watcher/debounce window.
    await Bun.sleep(750);
    expect(await pin(server)).toBe(retainedPin);
    expect(workshop.events.filter(({ event }) => event === "plugin-workshop-ready").length).toBe(1);
    await expect(fetch(ready.url!, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  } finally {
    await workshop?.stop();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

for (const boundary of ["manifest", "dependency", "native"] as const) {
  test.skipIf(!canSpawnServer())(`${boundary} changes revoke source and never implicitly reinstall native/authority declarations`, async () => {
    const root = await mkdtemp(join(tmpdir(), `plugin-workshop-${boundary}-`));
    const server = await startServer();
    let workshop: WorkshopProcess | undefined;
    try {
      const directory = await fixture(root, boundary === "native");
      await installFamily(root, server);
      workshop = launch(root, server);
      const ready = await workshop.event("plugin-workshop-ready");
      const retainedPin = await pin(server);
      const builds = workshop.events.filter(({ event }) => event === "workshop-test-build").length;
      if (boundary === "manifest") {
        const file = join(directory, "manifest.json");
        await Bun.write(file, JSON.stringify({ ...await Bun.file(file).json(), capabilities: [] }));
      } else if (boundary === "dependency") {
        await Bun.write(join(root, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { "new-dependency": "1.0.0" } }));
      } else {
        await Bun.write(join(directory, "native"), "#!/bin/sh\nexit 1\n");
      }
      await workshop.event("plugin-workshop-refused");
      // Observe a full watcher/debounce window, not merely the first cancellation event.
      await Bun.sleep(400);
      expect(workshop.events.filter(({ event }) => event === "workshop-test-build").length).toBe(builds);
      expect(await pin(server)).toBe(retainedPin);
      expect(await read(server)).toEqual({ label: "original-backend", count: 1 });
      await expect(fetch(ready.url!, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    } finally {
      await workshop?.stop();
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
}

test.skipIf(!canSpawnServer())("stopping a hung author compiler is bounded and never claims complete compiler cleanup or mutates the existing backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-workshop-hung-"));
  const server = await startServer();
  let workshop: WorkshopProcess | undefined;
  try {
    await fixture(root);
    await installFamily(root, server);
    const retainedPin = await pin(server);
    workshop = launch(root, server, true);
    const building = await workshop.event("workshop-test-build");
    expect((await stat(building.outputDir!)).isDirectory()).toBe(true);
    await workshop.stop(1);
    expect(workshop.events.some(({ event }) => event === "plugin-workshop-ready")).toBe(false);
    expect(workshop.events.some(({ event }) => event === "plugin-workshop-stopped")).toBe(false);
    await expect(stat(building.outputDir!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await pin(server)).toBe(retainedPin);
    expect(await read(server)).toEqual({ label: "original-backend", count: 1 });
    workshop = undefined;
  } finally {
    await workshop?.stop(1);
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test.skipIf(!canSpawnServer())("workshop replacement retains already-consented high-risk plugin authority rather than silently revoking it", async () => {
  const root = await mkdtemp(join(tmpdir(), "plugin-workshop-retained-grant-"));
  const server = await startServer();
  let workshop: WorkshopProcess | undefined;
  try {
    const directory = await fixture(root);
    const manifestFile = join(directory, "manifest.json");
    await Bun.write(manifestFile, JSON.stringify({
      ...await Bun.file(manifestFile).json(),
      capabilities: ["containers:read", "tokens:mint"],
    }));
    await Bun.write(join(directory, "server.ts"), serverSource('["containers:read", "tokens:mint"]'));
    await installFamily(root, server);
    const file = join(root, "dist", `${ID}.manifold-plugin.json`);
    const facts = await inspectBundle(file);
    await ownerAction(server, "engine.plugins.install", {
      source: file, sha256: facts.sha256, replace: true, grant: ["tokens:mint"],
    });
    const grants = (await roster(server)).find((row) => row.manifest.id === ID)!.install!.grantedCaps;
    expect(grants).toContain("tokens:mint");
    expect(await read(server)).toEqual({ label: "original-backend", count: 1 });
    workshop = launch(root, server);
    await workshop.event("plugin-workshop-ready");
    const checkpoint = workshop.events.length;
    await Bun.write(join(root, "shared/value.json"), JSON.stringify({ label: "retained-authority-backend" }));
    await workshop.event("plugin-workshop-ready", checkpoint);
    expect((await roster(server)).find((row) => row.manifest.id === ID)!.install!.grantedCaps).toEqual(grants);
    expect(await read(server)).toEqual({ label: "retained-authority-backend", count: 2 });
  } finally {
    await workshop?.stop();
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
