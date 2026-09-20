import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { packPlugin } from "@manifold/plugin-kit/pack";
import {
  ActionOutcomeSchema,
  HARDENED_CONTRACT_MINIMUM,
  HARDENED_CONTRACT_VERSION,
  PluginBundleSchema,
  PluginsResponseSchema,
} from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import { installArtifact, PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";

// Packed with Bun 1.4.2 from 476a586ce6cce520bdaf8f8a346ee0eb84b0bb6e's sample and kit,
// before load.hardenedContract existed. Only the inert contract-1 stamp was added afterward.
// Keeping these frozen bytes tests the old strict parser, not a relabelled current runtime.
const previousBytes = gunzipSync(
  readFileSync(join(import.meta.dir, "fixtures/contract-1-counter.manifold-plugin.json.gz")),
);
const previous = PluginBundleSchema.parse(JSON.parse(previousBytes.toString()));
const ownerKey = "e".repeat(64);
const headers = { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" };
const sample = resolve(import.meta.dir, "../../plugin-kit/test/fixtures/sample");

function configuration(dir: string) {
  return loadConfig(
    {
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: "data",
      MANIFOLD_OWNER_KEY: ownerKey,
      MANIFOLD_SPAWN_AGENT: "0",
    },
    dir,
  );
}

async function action(server: RunningServer, name: string, body: unknown) {
  return ActionOutcomeSchema.parse(
    await (
      await fetch(`${server.publicUrl}/api/actions/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      })
    ).json(),
  );
}

async function roster(server: RunningServer) {
  return PluginsResponseSchema.parse(
    await (await fetch(`${server.publicUrl}/api/plugins`, { headers })).json(),
  ).plugins;
}

test("a fixture packed against the previous accepted contract dispatches and survives a hub restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifold-contract-previous-"));
  const config = configuration(dir);
  const source = join(config.dataDir, PLUGIN_UPLOADS_DIR, "previous.manifold-plugin.json");
  mkdirSync(join(config.dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
  writeFileSync(source, previousBytes);
  let server: RunningServer | undefined;
  try {
    server = await startServer({ config, logger: silentLogger, announce: false });
    expect(previous.hardenedContract).toBeLessThan(HARDENED_CONTRACT_VERSION);
    expect(
      await action(server, "engine.plugins.install", {
        source,
        sha256: sha256Hex(previousBytes),
        hardened: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await action(server, "example.counter.bump", { by: 7 })).toMatchObject({
      ok: true,
      result: { count: 7 },
    });
    expect(await action(server, "example.counter.bump", { by: -1 })).toMatchObject({
      ok: false,
      denial: { rule: "invalid_args" },
    });
    await server.stop();
    server = await startServer({ config, logger: silentLogger, announce: false });
    expect(await action(server, "example.counter.bump", { by: 2 })).toMatchObject({
      ok: true,
      result: { count: 9 },
    });
    expect(
      (await roster(server)).find((row) => row.manifest.id === previous.manifest.id),
    ).toMatchObject({
      enabled: true,
    });
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const contract of [undefined, 999]) {
  test(`${contract === undefined ? "an unstamped" : "an outside-set"} installed bundle is held without spawning and one repack restores service`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-contract-held-"));
    const config = configuration(dir);
    const uploads = join(config.dataDir, PLUGIN_UPLOADS_DIR);
    mkdirSync(uploads, { recursive: true });
    const marker = join(dir, "guest-started");
    const serverCode = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');\n${Buffer.from(previous.files["server.js"]!, "base64").toString()}`;
    const bytes = Buffer.from(
      JSON.stringify({
        ...previous,
        hardenedContract: contract,
        files: { ...previous.files, "server.js": Buffer.from(serverCode).toString("base64") },
      }),
    );
    const source = join(uploads, "old.manifold-plugin.json");
    writeFileSync(source, bytes);
    const artifact = await installArtifact({
      source,
      sha256: sha256Hex(bytes),
      dataDir: config.dataDir,
    });
    const store = new ServerStore(openDatabase(join(config.dataDir, "manifold.db")));
    store.putPluginInstall({
      pluginId: previous.manifest.id,
      sha256: artifact.sha256,
      source,
      bundlePath: artifact.bundlePath,
      grantedCaps: previous.manifest.capabilities,
      installedBy: "p-owner",
      installedAt: 1,
      actions: [],
      hardened: true,
    });
    store.close();
    const spawned: unknown[] = [];
    const logger: Logger = {
      ...silentLogger,
      info(evt, fields) {
        if (evt === "isolate_spawned") spawned.push(fields?.plugin);
      },
    };
    let server: RunningServer | undefined;
    try {
      server = await startServer({ config, logger, announce: false });
      const held = (await roster(server)).find((row) => row.manifest.id === previous.manifest.id);
      expect(held).toMatchObject({
        enabled: false,
        actions: [],
        held: { reason: "repack_required", minimum: HARDENED_CONTRACT_MINIMUM },
      });
      expect(
        await action(server, "engine.plugins.setEnabled", {
          id: previous.manifest.id,
          enabled: true,
        }),
      ).toMatchObject({
        ok: false,
        denial: { message: "repack_required" },
      });
      expect(spawned).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect(
        (await fetch(`${server.publicUrl}/api/plugins/example.counter/web.js`, { headers })).status,
      ).toBe(404);

      const repacked = await packPlugin(sample, join(uploads, "repacked.manifold-plugin.json"), {
        shared: false,
      });
      expect(
        await action(server, "engine.plugins.install", {
          source: repacked.file,
          sha256: repacked.sha256,
          hardened: true,
          replace: true,
        }),
      ).toMatchObject({ ok: true });
      const recovered = (await roster(server)).find(
        (row) => row.manifest.id === previous.manifest.id,
      );
      expect(recovered?.held).toBeUndefined();
      expect(recovered?.enabled).toBe(true);
      expect(await action(server, "example.counter.bump", { by: 3 })).toMatchObject({
        ok: true,
        result: { count: 3 },
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await server?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
