import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PLUGIN_BUNDLE_SERVER_FILE,
  PluginBundleSchema,
  type IsolateChildFrame,
  type IsolateHostFrame,
  type PluginBundle,
} from "@manifold/protocol";
import { z } from "zod";
import { packPlugin, type PackResult } from "../src/pack.ts";

/**
 * `pack` TURNS THE SAMPLE INTO THE ARTIFACT THE INSTALL DOOR READS — and the artifact runs.
 * The command is driven exactly as an author drives it (`bun src/pack.ts <dir> --out <file>`,
 * a real second process reading the printed JSON line), and the packed `server.js` is then
 * spawned exactly as the engine's supervisor spawns it (`bun --smol <file>` over ipc) and
 * answers the protocol from a third process — the one thing an in-memory transport cannot
 * show. In-process `Bun.build` is not used here on purpose: under `bun test` launched from the
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
    expect(bundle.manifest.entry).toEqual({ server: true, web: "web.js" });
    expect(Object.keys(bundle.files).sort()).toEqual([PLUGIN_BUNDLE_SERVER_FILE, "web.js"]);
  });

  test("both halves are self-contained: the kit, the protocol and zod are inlined", () => {
    for (const name of [PLUGIN_BUNDLE_SERVER_FILE, "web.js"]) {
      const source = Buffer.from(bundle.files[name] ?? "", "base64").toString("utf8");
      expect(source.length).toBeGreaterThan(1_000);
      // No bare specifier survives: nothing for a loader to resolve.
      expect(source.match(/^\s*import\b[^\n]*\bfrom\s*["'][^./]/m)).toBeNull();
      expect(source.match(/\brequire\(\s*["']@manifold/)).toBeNull();
    }
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
});

describe("the packed server half, as a real isolate", () => {
  test("answers load, dispatch and shutdown over Bun ipc", async () => {
    const serverFile = `${dir}/${PLUGIN_BUNDLE_SERVER_FILE}`;
    await Bun.write(
      serverFile,
      Buffer.from(bundle.files[PLUGIN_BUNDLE_SERVER_FILE] ?? "", "base64"),
    );
    const queue: IsolateChildFrame[] = [];
    const waiting: ((frame: IsolateChildFrame) => void)[] = [];
    const child = Bun.spawn(["bun", "--smol", serverFile], {
      ipc: (message: IsolateChildFrame) => {
        const waiter = waiting.shift();
        if (waiter === undefined) queue.push(message);
        else waiter(message);
      },
      serialization: "json",
      stderr: "pipe",
      stdout: "ignore",
    });
    const send = (frame: IsolateHostFrame): void => {
      child.send(frame);
    };
    const next = (): Promise<IsolateChildFrame> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<IsolateChildFrame>();
      waiting.push(resolve);
      return promise;
    };
    try {
      send({ t: "load", pluginId: "example.counter", manifest: bundle.manifest, dir });
      const loaded = await next();
      expect(loaded).toMatchObject({
        t: "loaded",
        actions: [{ name: "example.counter.bump", caps: ["containers:read"], scope: "workspace" }],
        hooks: { onEnable: true, onDisable: false, onAssemblyChanged: false },
      });

      send({
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
      const read = await next();
      expect(read).toEqual({ t: "call", id: "r1:1", method: "storage.get", args: ["count"] });
      send({ t: "reply", id: "r1:1", ok: true, result: "37" });
      const write = await next();
      expect(write).toEqual({
        t: "call",
        id: "r1:2",
        method: "storage.set",
        args: ["count", "42"],
      });
      send({ t: "reply", id: "r1:2", ok: true, result: null });
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

      send({ t: "shutdown" });
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
    }
  });
});
