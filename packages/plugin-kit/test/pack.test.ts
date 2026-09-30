import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  closeSync,
  cpSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  ISOLATE_MAX_ARTIFACT_BYTES,
  MAX_PLUGIN_CHANGELOG_BYTES,
  PLUGIN_BUNDLE_SERVER_FILE,
  PLUGIN_BUNDLE_STYLES_FILE,
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  PROTOCOL_VERSION,
  PluginBundleSchema,
  PluginManifestSchema,
  type IsolateChildFrame,
  type IsolateHostFrame,
  type MachineArtifact,
  type PluginBundle,
  type PluginManifest,
  type UiNode,
  type WebHostContext,
  type WebIsolateHostFrame,
  type WebIsolateWorkerFrame,
} from "@manifold/protocol";
import { z } from "zod";
import {
  BUILT_AGAINST_PROTOCOL,
  PLUGIN_BUNDLE_CHANGELOG_FILE,
  compilePlugin,
  packPlugin,
  type CompileOptions,
  type PackResult,
} from "../src/pack.ts";
import * as React from "react";
import * as Plugin from "@manifold/plugin";
import * as UI from "@manifold/ui";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "node:net";

/**
 * `pack` TURNS THE SAMPLE INTO THE ARTIFACT THE INSTALL DOOR READS — and the artifact runs.
 * The command is driven exactly as an author drives it (`bun src/pack.ts <dir> --out <file>`,
 * a real second process reading the printed JSON line), and the packed `server.js` is then
 * spawned exactly as the engine's supervisor spawns it (`bun --smol <file>` over a dedicated
 * socket) and answers the protocol from a third process — the one thing an in-memory transport
 * cannot show. In-process `Bun.build` is not used here on purpose: under `bun test` launched from the
 * repository root it cannot resolve the isolated linker's per-package `node_modules`, while
 * the same call from the command line can.
 */

const KIT = `${import.meta.dir}/..`;
const SAMPLE = `${import.meta.dir}/fixtures/sample`;
const PackResultSchema = z.strictObject({
  file: z.string(),
  sha256: z.string().length(64),
  bytes: z.number().int(),
});

let dir = "";
let packed: PackResult;
let bundle: PluginBundle;

beforeAll(async () => {
  dir = mkdtempSync(`${tmpdir()}/plugin-kit-pack-`);
  const out = `${dir}/example.counter.manifold-plugin.json`;
  const command = Bun.spawn(["bun", `${KIT}/src/pack.ts`, SAMPLE, "--out", out], {
    cwd: KIT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
    command.exited,
  ]);
  if (code !== 0) throw new Error(`pack exited ${String(code)}: ${stderr}`);
  packed = PackResultSchema.parse(JSON.parse(stdout));
  bundle = PluginBundleSchema.parse(await Bun.file(packed.file).json());
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the artifact", () => {
  test("is a schema-valid bundle whose sha256 is over the file's exact bytes", async () => {
    const bytes = await Bun.file(packed.file).bytes();
    expect(packed.bytes).toBe(bytes.byteLength);
    expect(packed.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(bundle.format).toBe(1);
    expect(bundle.manifest.id).toBe("example.counter");
    expect(bundle.manifest.entry).toEqual({ server: true, web: "web.js", worker: true });
    expect(Object.keys(bundle.files).sort()).toEqual([
      PLUGIN_BUNDLE_SERVER_FILE,
      "web.js",
      PLUGIN_BUNDLE_WEB_WORKER_FILE,
    ]);
  });

  test("pack output is independent of source location and process cwd", async () => {
    const locations = mkdtempSync(`${KIT}/.pack-location-`);
    const first = `${locations}/first/sample`;
    const second = `${locations}/another/depth/sample`;
    const run = async (source: string, out: string, cwd: string): Promise<PackResult> => {
      const command = Bun.spawn(["bun", `${KIT}/src/pack.ts`, source, "--out", out], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);
      if (code !== 0) throw new Error(`pack exited ${String(code)}: ${stderr}`);
      return PackResultSchema.parse(JSON.parse(stdout));
    };
    try {
      cpSync(SAMPLE, first, { recursive: true });
      cpSync(SAMPLE, second, { recursive: true });
      const left = await run(first, `${locations}/first.json`, KIT);
      const right = await run(second, `${locations}/second.json`, `${KIT}/../..`);
      expect(right.sha256).toBe(left.sha256);
      expect(right.bytes).toBe(left.bytes);
      expect(await Bun.file(right.file).bytes()).toEqual(await Bun.file(left.file).bytes());
    } finally {
      rmSync(locations, { recursive: true, force: true });
    }
  });

  test("packing carries managed tool members once and verifies their own pinned bytes", async () => {
    const source = mkdtempSync(`${tmpdir()}/managed-tool-pack-`);
    const bytes = Buffer.from("private managed executable");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pinned = {
      bundleFile: "engine",
      sha256,
      entrySha256: sha256,
      format: "raw",
      entry: ["engine"],
      maxBytes: bytes.length,
      maxExpandedBytes: bytes.length,
      maxMembers: 1,
    };
    const manifest = {
      ...bundle.manifest,
      entry: { web: "web.js" },
      machine: {
        artifacts: { "linux-x64": { ...pinned, bundleFile: "worker" } },
        tools: { engine: { "linux-x64": pinned }, other: { "linux-x64": pinned } },
        locations: {},
        operations: {
          "example.counter.run": {
            argv: [],
            input: {},
            runtimeTools: ["engine"],
            executable: { runtimeTool: "engine" },
            locations: [],
            outputs: [],
            network: "none",
            stdin: false,
            limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
          },
        },
      },
    };
    try {
      await Bun.write(`${source}/manifest.json`, JSON.stringify(manifest));
      await Bun.write(`${source}/web.ts`, "export const native = true;");
      await Bun.write(`${source}/worker`, bytes);
      await Bun.write(`${source}/engine`, bytes);
      const result = await packPlugin(source, `${source}/bundle.json`, { shared: false });
      const packed = PluginBundleSchema.parse(await Bun.file(result.file).json());
      expect(Object.keys(packed.files).sort()).toEqual(["engine", "web.js", "worker"]);
      expect(Buffer.from(packed.files.engine!, "base64")).toEqual(bytes);
      await Bun.write(`${source}/engine`, Buffer.from("substituted tool bytes"));
      await expect(packPlugin(source, `${source}/bad.json`, { shared: false })).rejects.toThrow();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("no member leaves a bare import to resolve; only the page entry links the shell's registry", () => {
    const member = (name: string): string =>
      Buffer.from(bundle.files[name] ?? "", "base64").toString("utf8");
    for (const name of [PLUGIN_BUNDLE_SERVER_FILE, "web.js", PLUGIN_BUNDLE_WEB_WORKER_FILE]) {
      const source = member(name);
      expect(source.match(/^\s*import\b[^\n]*\bfrom\s*["'][^./]/m)).toBeNull();
      expect(source.match(/\brequire\(\s*["']@manifold/)).toBeNull();
    }
    // The page entry renders with the shell's own React; the Worker carries its one copy.
    expect(member("web.js")).toContain('Symbol.for("manifold.shared")');
    expect(member(PLUGIN_BUNDLE_WEB_WORKER_FILE)).not.toContain('Symbol.for("manifold.shared")');
  });

  test("refuses a directory whose manifest names no entry", async () => {
    const bare = mkdtempSync(`${tmpdir()}/plugin-kit-bare-`);
    try {
      const manifest = { ...bundle.manifest, entry: undefined };
      await Bun.write(`${bare}/manifest.json`, JSON.stringify(manifest));
      await expect(packPlugin(bare, `${bare}/out.json`)).rejects.toThrow(
        "manifest.entry must name",
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a sheet beside the manifest is carried only when declared, and then as it is (#258)", async () => {
    const undeclared = mkdtempSync(`${tmpdir()}/plugin-kit-sheet-`);
    try {
      await Bun.write(`${undeclared}/manifest.json`, JSON.stringify(bundle.manifest));
      await Bun.write(`${undeclared}/${PLUGIN_BUNDLE_STYLES_FILE}`, ".x {}");
      await expect(packPlugin(undeclared, `${undeclared}/out.json`)).rejects.toThrow(
        "entry.styles is not true",
      );
    } finally {
      rmSync(undeclared, { recursive: true, force: true });
    }
  });

  test("a CHANGELOG.md beside the manifest is carried as written, and every pack stamps its protocol", async () => {
    const source = mkdtempSync(`${tmpdir()}/plugin-kit-changelog-`);
    try {
      await Bun.write(
        `${source}/manifest.json`,
        JSON.stringify({ ...bundle.manifest, entry: { web: "web.js" } }),
      );
      await Bun.write(`${source}/web.ts`, "export {};");
      const notes = "## 1.2.3\n\n- Counts — both ways.\n";
      await Bun.write(`${source}/${PLUGIN_BUNDLE_CHANGELOG_FILE}`, notes);
      const out = `${source}/out.json`;
      const packed = PluginBundleSchema.parse(
        await Bun.file((await packPlugin(source, out, { shared: false })).file).json(),
      );
      expect(
        Buffer.from(packed.files[PLUGIN_BUNDLE_CHANGELOG_FILE] ?? "", "base64").toString("utf8"),
      ).toBe(notes);
      // Self-contained links no shared package, yet still names the wire it was built against.
      expect(packed.builtAgainst).toEqual({ [BUILT_AGAINST_PROTOCOL]: String(PROTOCOL_VERSION) });

      await Bun.write(
        `${source}/${PLUGIN_BUNDLE_CHANGELOG_FILE}`,
        "x".repeat(MAX_PLUGIN_CHANGELOG_BYTES + 1),
      );
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow(
        PLUGIN_BUNDLE_CHANGELOG_FILE,
      );
      await Bun.write(`${source}/${PLUGIN_BUNDLE_CHANGELOG_FILE}`, new Uint8Array([0xff, 0xfe]));
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow("not UTF-8");
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  test("in-realm exports resolve from the host registry, with no shared bare imports", async () => {
    const out = `${dir}/in-realm.json`;
    const command = Bun.spawn(
      ["bun", `${KIT}/src/pack.ts`, `${import.meta.dir}/fixtures/in-realm`, "--out", out],
      {
        cwd: KIT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([command.exited, new Response(command.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
    const artifact = PluginBundleSchema.parse(await Bun.file(out).json());
    expect(artifact.manifest.entry.styles).toBe(true);
    // The sheet is a member as written — never bundled, never rewritten — for the hub to admit.
    expect(Buffer.from(artifact.files[PLUGIN_BUNDLE_STYLES_FILE] ?? "", "base64").toString()).toBe(
      await Bun.file(`${import.meta.dir}/fixtures/in-realm/${PLUGIN_BUNDLE_STYLES_FILE}`).text(),
    );
    const source = Buffer.from(artifact.files["web.js"] ?? "", "base64").toString("utf8");
    expect(source).not.toMatch(
      /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:react|@manifold\/)/,
    );
    expect(artifact.builtAgainst?.react).toMatch(/^\d+\.\d+\.\d+/);
    expect(artifact.builtAgainst?.["@manifold/plugin"]).toMatch(/^\d+\.\d+\.\d+/);
    // The design system is a shared module too, or a mod could not import it (issue #240).
    expect(artifact.builtAgainst?.["@manifold/ui"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(artifact.builtAgainst?.[BUILT_AGAINST_PROTOCOL]).toBe(String(PROTOCOL_VERSION));
    const key = Symbol.for("manifold.shared");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: { react: React, "@manifold/ui": UI, "@manifold/plugin": Plugin },
    });
    try {
      const file = `${dir}/in-realm.mjs`;
      await Bun.write(file, source);
      const loaded = await import(file);
      expect(loaded.default.id).toBe("example.counter");
      expect(typeof loaded.default.panels.counter).toBe("function");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, key);
      else Object.defineProperty(globalThis, key, previous);
    }
  });

  test("pack carries declared binary workers and refuses missing, substituted, oversized, or colliding members", async () => {
    const source = mkdtempSync(`${tmpdir()}/plugin-kit-machine-`);
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 17, 0x80);
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      const spec = {
        bundleFile: "worker",
        sha256: hash,
        entrySha256: hash,
        format: "raw",
        entry: ["worker"],
        maxBytes: bytes.length,
        maxExpandedBytes: bytes.length,
        maxMembers: 1,
      };
      const manifest = {
        ...bundle.manifest,
        entry: { web: "web.js" },
        machine: {
          artifacts: { "linux-x64": spec },
          locations: {},
          operations: {
            "example.counter.run": {
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
      };
      await Bun.write(`${source}/manifest.json`, JSON.stringify(manifest));
      await Bun.write(`${source}/web.ts`, "export {};");
      const out = `${source}/packed.json`;
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow();
      await Bun.write(`${source}/worker`, bytes);
      await packPlugin(source, out, { shared: false });
      const packed = PluginBundleSchema.parse(await Bun.file(out).json());
      expect(Buffer.from(packed.files.worker!, "base64")).toEqual(bytes);
      await Bun.write(`${source}/worker`, Buffer.from("substitution"));
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow();
      await Bun.write(`${source}/worker`, Buffer.alloc(bytes.length + 1));
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow();
      manifest.machine.artifacts["linux-x64"].bundleFile = "web.js";
      await Bun.write(`${source}/manifest.json`, JSON.stringify(manifest));
      await expect(packPlugin(source, out, { shared: false })).rejects.toThrow();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

describe("in-memory compilation", () => {
  let source = "";
  let original: PluginManifest;
  const originalWorker = Buffer.from("original worker executable");
  const originalEngine = Buffer.from("original managed executable");
  const nested = { id: "unrelated.nested", machine: { marker: "not the plugin manifest" } };
  const settings = { title: "unrelated JSON", enabled: true };

  const raw = (bundleFile: string, bytes: Uint8Array): MachineArtifact => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      bundleFile,
      sha256,
      entrySha256: sha256,
      format: "raw",
      entry: [bundleFile],
      maxBytes: bytes.byteLength,
      maxExpandedBytes: bytes.byteLength,
      maxMembers: 1,
    };
  };

  beforeAll(async () => {
    source = `${dir}/generated-source`;
    mkdirSync(`${source}/nested`, { recursive: true });
    mkdirSync(`${source}/output`);
    original = PluginManifestSchema.parse({
      ...bundle.manifest,
      // A plain module, not a React definition: this suite is about members, not linkage.
      entry: { server: true, web: "web.js" },
      machine: {
        artifacts: { "linux-x64": raw("worker", originalWorker) },
        tools: { engine: { "linux-x64": raw("engine", originalEngine) } },
        locations: {},
        operations: {
          "example.counter.run": {
            argv: [],
            input: {},
            runtimeTools: ["engine"],
            executable: { runtimeTool: "engine" },
            locations: [],
            outputs: [],
            network: "none",
            stdin: false,
            limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 4096 },
          },
        },
      },
    });
    const imports = [
      'import manifest from "./manifest.json";',
      'import nested from "./nested/manifest.json";',
      'import settings from "./settings.json";',
    ].join("\n");
    await Promise.all([
      Bun.write(`${source}/manifest.json`, JSON.stringify(original)),
      Bun.write(`${source}/nested/manifest.json`, JSON.stringify(nested)),
      Bun.write(`${source}/settings.json`, JSON.stringify(settings)),
      Bun.write(
        `${source}/server.ts`,
        `${imports}\nconsole.log(JSON.stringify({manifest, nested, settings}));`,
      ),
      Bun.write(`${source}/web.ts`, `${imports}\nexport default {manifest, nested, settings};`),
      Bun.write(`${source}/worker`, originalWorker),
      Bun.write(`${source}/engine`, originalEngine),
      Bun.write(`${source}/output/existing.json`, "unrelated output must survive"),
    ]);
  });

  const supplied = () => {
    const worker = Buffer.from("generated worker executable");
    // A subarray defends against accidentally serializing the entire backing buffer.
    const storage = Buffer.from("guard:generated managed executable:guard");
    const engine = storage.subarray(6, storage.length - 6);
    const manifest = PluginManifestSchema.parse({
      ...original,
      machine: {
        ...original.machine,
        artifacts: { "linux-x64": raw("worker", worker) },
        tools: {
          engine: { "linux-x64": raw("engine", engine) },
          alias: { "linux-x64": raw("engine", engine) },
        },
      },
    });
    return {
      manifest,
      members: new Map<string, Uint8Array>([
        ["worker", worker],
        ["engine", engine],
      ]),
    };
  };

  const snapshot = () =>
    [".", ...readdirSync(source, { recursive: true })].sort().map((name) => {
      const descriptor = openSync(`${source}/${name}`, "r");
      try {
        const stat = fstatSync(descriptor);
        return {
          name,
          mode: stat.mode,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          contents: stat.isFile() ? readFileSync(descriptor).toString("base64") : null,
        };
      } finally {
        closeSync(descriptor);
      }
    });

  const serverValue = async (compiled: PluginBundle): Promise<unknown> => {
    const server = Buffer.from(compiled.files[PLUGIN_BUNDLE_SERVER_FILE]!, "base64").toString();
    const child = Bun.spawn(["bun", "--eval", server], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`compiled server exited ${String(code)}: ${stderr}`);
    return JSON.parse(stdout);
  };

  test("compiled server and web imports see admitted machine metadata, without changing other JSON or source/output files", async () => {
    const generated = supplied();
    const before = snapshot();
    const manifestBefore = structuredClone(generated.manifest);
    const membersBefore = [...generated.members].map(([name, bytes]) => [name, Buffer.from(bytes)]);
    const result = await compilePlugin(source, { shared: false, generated });
    const compiled = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes)));
    expect(result.sha256).toBe(createHash("sha256").update(result.bytes).digest("hex"));
    expect<PluginManifest>(compiled.manifest).toEqual(manifestBefore);
    expect(compiled.manifest.machine).not.toEqual(original.machine);
    expect(Object.keys(compiled.files).sort()).toEqual(["engine", "server.js", "web.js", "worker"]);
    for (const [name, bytes] of generated.members)
      expect(Buffer.from(compiled.files[name]!, "base64")).toEqual(Buffer.from(bytes));
    expect(await serverValue(compiled)).toEqual({ manifest: compiled.manifest, nested, settings });
    // The browser module does not exist until compilation; exercise its actual loading boundary.
    const web = await import(`data:text/javascript;base64,${compiled.files["web.js"]!}`);
    expect(web.default).toEqual({ manifest: compiled.manifest, nested, settings });
    expect(snapshot()).toEqual(before);
    expect(generated.manifest).toEqual(manifestBefore);
    expect([...generated.members].map(([name, bytes]) => [name, Buffer.from(bytes)])).toEqual(
      membersBefore,
    );
  });

  test("compiled halves use admitted metadata when the root manifest is a stable symlink", async () => {
    const linked = `${dir}/generated-source-linked`;
    cpSync(source, linked, { recursive: true });
    const onDisk = readFileSync(`${linked}/manifest.json`);
    rmSync(`${linked}/manifest.json`);
    await Bun.write(`${linked}/metadata.json`, onDisk);
    symlinkSync("metadata.json", `${linked}/manifest.json`);
    const generated = supplied();
    const result = await compilePlugin(linked, { shared: false, generated });
    const compiled = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes)));
    expect(await serverValue(compiled)).toEqual({
      manifest: compiled.manifest,
      nested,
      settings,
    });
    const web = await import(`data:text/javascript;base64,${compiled.files["web.js"]!}`);
    expect(web.default).toEqual({ manifest: compiled.manifest, nested, settings });
  });

  test("owns the supplied manifest, map and byte views before awaiting source reads", async () => {
    const generated = supplied();
    const manifest = structuredClone(generated.manifest);
    const members = [...generated.members].map(
      ([name, bytes]) => [name, Buffer.from(bytes)] as const,
    );
    const options: CompileOptions = { shared: false, generated };
    const pending = compilePlugin(source, options);
    generated.manifest.id = "substituted.identity";
    generated.manifest.entry = { server: false };
    generated.manifest.machine!.artifacts["linux-x64"]!.sha256 = "0".repeat(64);
    for (const bytes of generated.members.values()) bytes.fill(0);
    generated.members.clear();
    generated.members.set("unused", new Uint8Array([1]));
    const result = await pending;
    const compiled = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(result.bytes)));
    expect<PluginManifest>(compiled.manifest).toEqual(manifest);
    for (const [name, bytes] of members)
      expect(Buffer.from(compiled.files[name]!, "base64")).toEqual(bytes);
    expect(await serverValue(compiled)).toEqual({ manifest, nested, settings });
  });

  test("refuses changing the source plugin identity or entry ownership", async () => {
    const identity = supplied();
    identity.manifest.id = "another.plugin";
    await expect(compilePlugin(source, { shared: false, generated: identity })).rejects.toThrow();
    const entry = supplied();
    entry.manifest.entry = { server: false, web: "different.js" };
    await expect(compilePlugin(source, { shared: false, generated: entry })).rejects.toThrow();
  });

  test("requires generated members even when matching artifact bytes already exist on disk", async () => {
    const generated = {
      manifest: PluginManifestSchema.parse(original),
      members: new Map<string, Uint8Array>([["engine", originalEngine]]),
    };
    await expect(compilePlugin(source, { shared: false, generated })).rejects.toThrow();
  });

  test("refuses unused members, malformed manifests and traversal without touching the source", async () => {
    const before = snapshot();
    const unused = supplied();
    unused.members.set("unused", new Uint8Array([1]));
    await expect(compilePlugin(source, { shared: false, generated: unused })).rejects.toThrow();
    const malformed = supplied();
    Object.assign(malformed.manifest, { unknown: true });
    await expect(compilePlugin(source, { shared: false, generated: malformed })).rejects.toThrow();
    const traversal = supplied();
    traversal.manifest.machine!.artifacts["linux-x64"]!.bundleFile = "../worker";
    traversal.members.set("../worker", traversal.members.get("worker")!);
    traversal.members.delete("worker");
    await expect(compilePlugin(source, { shared: false, generated: traversal })).rejects.toThrow();
    expect(snapshot()).toEqual(before);
  });

  test.each(["server.js", "web.js", "styles.css"])(
    "refuses generated member collision with %s",
    async (name) => {
      const generated = supplied();
      const worker = generated.members.get("worker")!;
      generated.manifest.machine!.artifacts["linux-x64"] = raw(name, worker);
      generated.members.delete("worker");
      generated.members.set(name, worker);
      await expect(compilePlugin(source, { shared: false, generated })).rejects.toThrow();
    },
  );

  test("refuses malformed, empty and oversized generated byte views", async () => {
    const malformed = supplied();
    malformed.members.set("worker", "not bytes" as unknown as Uint8Array);
    await expect(compilePlugin(source, { shared: false, generated: malformed })).rejects.toThrow();
    const empty = supplied();
    empty.members.set("worker", new Uint8Array());
    await expect(compilePlugin(source, { shared: false, generated: empty })).rejects.toThrow();
    const oversized = supplied();
    oversized.members.set(
      "worker",
      new Uint8Array(oversized.members.get("worker")!.byteLength + 1),
    );
    await expect(compilePlugin(source, { shared: false, generated: oversized })).rejects.toThrow();
  });

  test("bounds aggregate generated bytes before compilation", async () => {
    const generated = supplied();
    const bytes = Buffer.alloc(ISOLATE_MAX_ARTIFACT_BYTES / 2, 0x61);
    generated.manifest.machine!.artifacts["linux-x64"] = raw("worker", bytes);
    generated.manifest.machine!.tools = { engine: { "linux-x64": raw("engine", bytes) } };
    generated.members.set("worker", bytes);
    generated.members.set("engine", bytes);
    await expect(compilePlugin(source, { shared: false, generated })).rejects.toThrow();
  });

  test("applies transport, extracted executable and archive verification to generated artifacts", async () => {
    const substituted = supplied();
    substituted.members.get("worker")!.fill(0);
    await expect(
      compilePlugin(source, { shared: false, generated: substituted }),
    ).rejects.toThrow();
    const executable = supplied();
    executable.manifest.machine!.tools!.engine!["linux-x64"]!.entrySha256 = "0".repeat(64);
    await expect(compilePlugin(source, { shared: false, generated: executable })).rejects.toThrow();
    const archive = supplied();
    archive.manifest.machine!.artifacts["linux-x64"]!.format = "zip";
    await expect(compilePlugin(source, { shared: false, generated: archive })).rejects.toThrow();
  });

  test("the original file packer publishes exactly the verified compilation bytes", async () => {
    const compiled = await compilePlugin(source, { shared: false });
    const result = await packPlugin(source, `${dir}/file-parity.json`, { shared: false });
    expect(compiled.bytes).toEqual(await Bun.file(result.file).bytes());
    expect(result.sha256).toBe(compiled.sha256);
    expect(result.bytes).toBe(compiled.bytes.byteLength);
    const artifact = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(compiled.bytes)));
    expect(await serverValue(artifact)).toEqual({ manifest: original, nested, settings });
    expect(Buffer.from(artifact.files.worker!, "base64")).toEqual(originalWorker);
    expect(Buffer.from(artifact.files.engine!, "base64")).toEqual(originalEngine);
  });
});

describe("self-contained server assets", () => {
  test("runs a signed code asset above 16 MiB with no source tree or package installation", async () => {
    const root = mkdtempSync(`${tmpdir()}/plugin-native-members-`);
    const source = `${root}/source`;
    const runtime = `${root}/runtime`;
    try {
      const bytes = new Uint8Array(17 * 1024 * 1024).fill(73);
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      await Bun.write(
        `${source}/manifest.json`,
        JSON.stringify({
          ...bundle.manifest,
          entry: { server: true },
        }),
      );
      await Bun.write(`${source}/payload.bin`, bytes);
      await Bun.write(
        `${source}/server.ts`,
        `
        import asset from "./payload.bin" with { type: "file" };
        const bytes = await Bun.file(new URL(asset, import.meta.url)).bytes();
        console.log(JSON.stringify({ bytes: bytes.byteLength,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") }));
      `,
      );
      const compiled = await compilePlugin(source);
      const artifact = PluginBundleSchema.parse(
        JSON.parse(new TextDecoder().decode(compiled.bytes)),
      );
      for (const [name, encoded] of Object.entries(artifact.files))
        await Bun.write(`${runtime}/${name}`, Buffer.from(encoded, "base64"));
      rmSync(source, { recursive: true });
      const child = Bun.spawn([process.execPath, "--no-install", `${runtime}/server.js`], {
        cwd: runtime,
        env: { PATH: "", NODE_PATH: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({ bytes: bytes.byteLength, sha256 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test.each(["server.js", "web.worker.js", "styles.css", "../outside", ".env"])(
    "refuses trusted resources that replace executable entries or escape extraction: %s",
    async (name) => {
      await expect(
        compilePlugin(SAMPLE, {
          serverBuild: { files: new Map([[name, new Uint8Array([1, 2, 3])]]) },
        }),
      ).rejects.toThrow();
    },
  );
});

describe("the packed web half, as a real Worker", () => {
  const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;
  const context: WebHostContext = {
    principal,
    caps: ["containers:read"],
    containerId: "c1",
    topics: { index: [], terminals: [], attendance: [], machines: [] },
    status: "open",
    hidden: false,
    canAuthor: false,
  };
  const nodes = (tree: UiNode): UiNode[] =>
    tree.type === "box" ? [tree, ...tree.children.flatMap(nodes)] : [tree];

  test("the portable entry renders the sample with its one React and routes its button to an owned call", async () => {
    const file = `${dir}/${PLUGIN_BUNDLE_WEB_WORKER_FILE}`;
    await Bun.write(file, Buffer.from(bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE] ?? "", "base64"));
    const worker = new Worker(file, { type: "module" });
    const queue: WebIsolateWorkerFrame[] = [];
    const waiting: ((frame: WebIsolateWorkerFrame) => void)[] = [];
    worker.addEventListener("message", (event: MessageEvent<WebIsolateWorkerFrame>) => {
      const waiter = waiting.shift();
      if (waiter === undefined) queue.push(event.data);
      else waiter(event.data);
    });
    const next = (): Promise<WebIsolateWorkerFrame> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<WebIsolateWorkerFrame>();
      waiting.push(resolve);
      return promise;
    };
    const send = (frame: WebIsolateHostFrame): void => worker.postMessage(frame);
    try {
      send({ t: "init", pluginId: "example.counter", principal, caps: [], containerId: "c1" });
      await next();
      send({ t: "mount", instance: "i1", panel: "counter", kind: "panel", context });
      const first = await next();
      if (first.t !== "render") throw new Error(`expected a render, got ${JSON.stringify(first)}`);
      const painted = nodes(first.tree);
      expect(painted).toContainEqual(
        expect.objectContaining({ type: "text", text: "Hello, Ada." }),
      );
      const bump = painted.find((node) => node.type === "button" && node.label === "Bump");
      if (bump?.type !== "button") throw new Error("the sample painted no Bump button");
      expect(bump.action).toBe("example.counter.bump");

      send({ t: "event", instance: "i1", event: bump.event });
      const call = await next();
      if (call.t !== "call") throw new Error(`expected a call, got ${JSON.stringify(call)}`);
      expect(call).toMatchObject({
        instance: "i1",
        method: "action",
        args: ["example.counter.bump", { by: 1 }],
      });
      send({ t: "reply", id: call.id, ok: true, result: { ok: true, result: { count: 7 } } });
      const second = await next();
      if (second.t !== "render")
        throw new Error(`expected a render, got ${JSON.stringify(second)}`);
      expect(nodes(second.tree)).toContainEqual(
        expect.objectContaining({ type: "badge", text: "count 7" }),
      );
    } finally {
      worker.terminate();
    }
  });

  test("portable linkage refuses a self-contained page entry and page-only imports by name", async () => {
    await expect(compilePlugin(SAMPLE, { shared: false })).rejects.toThrow(
      "entry.worker requires the page-linked web entry",
    );
    const source = mkdtempSync(`${tmpdir()}/plugin-kit-portable-`);
    try {
      await Bun.write(
        `${source}/manifest.json`,
        JSON.stringify({ ...bundle.manifest, entry: { web: "web.js", worker: true } }),
      );
      for (const [specifier, binding] of [
        ["react-dom", "createPortal"],
        ["@manifold/plugin", "defineAction"],
      ] as const) {
        await Bun.write(
          `${source}/web.ts`,
          `import { ${binding} } from "${specifier}";\nexport default { id: "example.counter", panels: {}, uses: ${binding} };\n`,
        );
        // The page entry links through the shared inventory, which only the command resolves.
        const command = Bun.spawn(
          ["bun", `${KIT}/src/pack.ts`, source, "--out", `${source}/out.json`],
          { cwd: KIT, stdout: "ignore", stderr: "pipe" },
        );
        const [code, stderr] = await Promise.all([
          command.exited,
          new Response(command.stderr).text(),
        ]);
        expect(code).not.toBe(0);
        expect(stderr).toContain(`a portable Worker cannot import ${specifier}`);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

describe("registered source", () => {
  test("compiles the given manifest and entries without a manifest file, owning them first", async () => {
    const source = mkdtempSync(`${tmpdir()}/plugin-kit-registered-`);
    try {
      await Bun.write(`${source}/src/server.ts`, `console.log("server guest");\n`);
      await Bun.write(`${source}/src/entry.ts`, `export default { id: "example.registered" };\n`);
      const manifest = PluginManifestSchema.parse({
        ...bundle.manifest,
        id: "example.registered",
        entry: { server: true, web: "web.js" },
      });
      const expected = structuredClone(manifest);
      const pending = compilePlugin(source, {
        shared: false,
        source: { manifest, server: "src/server.ts", web: `${source}/src/entry.ts` },
      });
      manifest.id = "substituted.identity";
      const compiled = PluginBundleSchema.parse(
        JSON.parse(new TextDecoder().decode((await pending).bytes)),
      );
      expect<PluginManifest>(compiled.manifest).toEqual(expected);
      expect(Object.keys(compiled.files).sort()).toEqual([PLUGIN_BUNDLE_SERVER_FILE, "web.js"]);
      // The compiled module exists only as bytes; loading them is the boundary under test.
      const web = await import(`data:text/javascript;base64,${compiled.files["web.js"]!}`);
      expect(web.default).toEqual({ id: "example.registered" });

      await expect(
        compilePlugin(source, {
          shared: false,
          source: { manifest: expected, server: "src/server.ts" },
        }),
      ).rejects.toThrow("a web source is required exactly when entry.web is declared");
      await expect(
        compilePlugin(source, {
          shared: false,
          source: { manifest: expected, server: "src/server.ts", web: "src/entry.ts" },
          generated: { manifest: expected, members: new Map() },
        }),
      ).rejects.toThrow("not both");
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

describe("the packed server half, as a real isolate", () => {
  test("default packing keeps server dispatch independent of browser shared modules", async () => {
    const defaultBundlePath = `${dir}/default-linkage.json`;
    const pack = Bun.spawn(["bun", `${KIT}/src/pack.ts`, SAMPLE, "--out", defaultBundlePath], {
      cwd: KIT,
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([pack.exited, new Response(pack.stderr).text()]);
    if (code !== 0) throw new Error(stderr);
    const defaultBundle = PluginBundleSchema.parse(await Bun.file(defaultBundlePath).json());
    const serverFile = `${dir}/${PLUGIN_BUNDLE_SERVER_FILE}`;
    await Bun.write(
      serverFile,
      Buffer.from(defaultBundle.files[PLUGIN_BUNDLE_SERVER_FILE] ?? "", "base64"),
    );
    const queue: IsolateChildFrame[] = [];
    const waiting: ((frame: IsolateChildFrame) => void)[] = [];
    const child = Bun.spawn(["bun", "--smol", serverFile], {
      stdio: ["ignore", "ignore", "pipe", "socket-fd"],
      env: {
        ...process.env,
        MANIFOLD_PLUGIN_ID: "example.counter",
        MANIFOLD_PLUGIN_PIPE_FD: "3",
      },
    });
    const descriptor = child.stdio[3];
    if (descriptor === null || descriptor === undefined) throw new Error("missing isolate socket");
    const connectDescriptor = connect as unknown as (options: {
      readonly fd: number;
    }) => ReturnType<typeof connect>;
    const protocol = connectDescriptor({ fd: descriptor });
    let carry = "";
    protocol.on("data", (chunk: Buffer) => {
      carry += chunk.toString("utf8");
      let newline = carry.indexOf("\n");
      while (newline !== -1) {
        const frame = JSON.parse(carry.slice(0, newline)) as IsolateChildFrame;
        carry = carry.slice(newline + 1);
        const waiter = waiting.shift();
        if (waiter === undefined) queue.push(frame);
        else waiter(frame);
        newline = carry.indexOf("\n");
      }
    });
    const next = (): Promise<IsolateChildFrame> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<IsolateChildFrame>();
      waiting.push(resolve);
      return promise;
    };
    const send = async (frame: IsolateHostFrame): Promise<void> => {
      const receipt = randomUUID();
      protocol.write(`${JSON.stringify({ receipt, frame })}\n`);
      expect(await next()).toEqual({ t: "received", receipt });
    };
    try {
      await send({ t: "load", pluginId: "example.counter", manifest: defaultBundle.manifest, dir });
      const loaded = await next();
      expect(loaded).toMatchObject({
        t: "loaded",
        actions: [
          { name: "example.counter.bump", caps: ["containers:read"], scope: "workspace" },
          { name: "example.counter.openRaster", caps: ["containers:read"], scope: "workspace" },
          {
            name: "example.counter.cancelRaster",
            caps: ["containers:read"],
            scope: "workspace",
            cleanup: true,
          },
        ],
        hooks: { onEnable: true, onDisable: true, onAssemblyChanged: false },
      });

      await send({
        t: "dispatch",
        id: "r1",
        action: "bump",
        args: { by: 5 },
        ctx: {
          traceId: 1,
          principal: { id: "p1", kind: "human", name: "Ada", color: "#e03131" },
          caps: ["containers:read"],
          isRoot: false,
          containerScope: null,
          now: 1_000,
        },
      });
      expect(await next()).toEqual({ t: "prepared", id: "r1", targets: [] });
      await send({ t: "admitted", id: "r1", allowed: true });
      const read = await next();
      expect(read).toEqual({ t: "call", id: "r1:1", method: "storage.get", args: ["count"] });
      await send({ t: "reply", id: "r1:1", ok: true, result: "37" });
      const write = await next();
      expect(write).toEqual({
        t: "call",
        id: "r1:2",
        method: "storage.set",
        args: ["count", "42"],
      });
      await send({ t: "reply", id: "r1:2", ok: true, result: null });
      expect(await next()).toEqual({
        t: "dispatched",
        id: "r1",
        outcome: {
          ok: true,
          result: { count: 42 },
          emits: [
            {
              ref: { kind: "plugin", pluginId: "example.counter" },
              kind: "counter_bumped",
              payload: { count: 42 },
            },
          ],
        },
      });

      await send({ t: "shutdown" });
      expect(await child.exited).toBe(0);
    } finally {
      protocol.destroy();
      child.kill();
    }
  });
});
