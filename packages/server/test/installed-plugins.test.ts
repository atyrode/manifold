import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionOutcomeSchema,
  defaultRuntime,
  HARDENED_CONTRACT_VERSION,
  InstalledPluginsSnapshotSchema,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db.ts";
import { exportInstalledPlugins } from "../src/installed-plugins.ts";
import { silentLogger } from "../src/log.ts";
import { startServer } from "../src/main.ts";
import { installLayout } from "../src/plugin-installs.ts";
import { ServerStore, sha256Hex } from "../src/stores.ts";
import { restoreInstalledSnapshot } from "../../../scripts/installed-bundles-candidate.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "installed-export-test-"));
  roots.push(root);
  const dataDir = join(root, "source");
  mkdirSync(dataDir);
  const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
  const ownerKey = "c".repeat(64);
  const auth = new AuthService(store, ownerKey, defaultRuntime);
  const owner = auth.authenticate(ownerKey);
  const manager = auth.mintToken(
    { principal: { name: "manager", kind: "human" }, caps: ["plugins:manage"] },
    owner,
  );
  const pluginId = "example.export";
  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: HARDENED_CONTRACT_VERSION,
      manifest: {
        id: pluginId,
        version: "1.0.0",
        title: "Export fixture",
        description: "Portable bytes",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        entry: { web: "web.js" },
      },
      files: { "web.js": Buffer.from("export {};").toString("base64") },
    }) + "\n",
  );
  const sha256 = sha256Hex(bytes);
  const bundlePath = installLayout(dataDir, pluginId, sha256).bundlePath;
  mkdirSync(join(dataDir, "plugins", pluginId), { recursive: true });
  writeFileSync(bundlePath, bytes);
  store.putPluginInstall({
    pluginId,
    sha256,
    bundlePath,
    source: "https://user:source-password@example.org/bundle?token=url-secret",
    grantedCaps: [],
    installedBy: owner.principal.id,
    installedAt: 123,
    actions: [],
    installer: { ...auth.credentialReference(owner), tokenId: "private-token-lineage" },
  });
  store.setPluginEnabled(pluginId, false, owner.principal.id, 123);
  return { root, dataDir, store, ownerKey, manager: manager.token, bytes, bundlePath, pluginId };
}

test("root export follows the action ladder and returns exact disabled bundle bytes without credentials or source secrets", async () => {
  const f = fixture();
  f.store.close();
  const running = await startServer({
    config: loadConfig({
      MANIFOLD_DATA_DIR: f.dataDir,
      MANIFOLD_PORT: "0",
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_OWNER_KEY: f.ownerKey,
    }),
    logger: silentLogger,
    announce: false,
  });
  try {
    const call = async (token: string) => {
      const response = await fetch(
        `${running.publicUrl}/api/actions/engine.plugins.exportInstalled`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        },
      );
      return ActionOutcomeSchema.parse(await response.json());
    };
    const denied = await call(f.manager);
    expect(denied.ok).toBe(false);
    const exported = await call(f.ownerKey);
    if (!exported.ok) throw new Error(exported.denial.message);
    const snapshot = InstalledPluginsSnapshotSchema.parse(exported.result);
    expect(snapshot.plugins.map(({ row, enabled }) => [row.pluginId, enabled])).toEqual([
      [f.pluginId, false],
    ]);
    expect(Buffer.from(snapshot.plugins[0]!.bytes, "base64")).toEqual(f.bytes);
    const serialized = JSON.stringify(snapshot);
    for (const secret of [
      f.ownerKey,
      "installer",
      "private-token-lineage",
      "source-password",
      "url-secret",
      "example.org",
      f.dataDir,
    ])
      expect(serialized).not.toContain(secret);
    const restored = join(f.root, "restored");
    restoreInstalledSnapshot(snapshot, restored);
    const copy = new ServerStore(openDatabase(join(restored, "manifold.db")));
    try {
      const row = copy.pluginInstalls()[0]!;
      expect(row.bundlePath).toBe(join(restored, snapshot.plugins[0]!.row.bundlePath));
      expect(row.source).toBe(row.bundlePath);
      expect(row.installer).toBeUndefined();
      expect(copy.disabledPlugins().has(f.pluginId)).toBe(true);
      expect(readFileSync(row.bundlePath)).toEqual(f.bytes);
      expect({
        ...row,
        source: snapshot.plugins[0]!.row.source,
        bundlePath: snapshot.plugins[0]!.row.bundlePath,
      }).toEqual(snapshot.plugins[0]!.row);
    } finally {
      copy.close();
    }
  } finally {
    await running.stop();
  }
});

test("exports fail closed for missing bundles and symlinks outside the data root", () => {
  const f = fixture();
  try {
    rmSync(f.bundlePath);
    expect(() => exportInstalledPlugins(f.store, f.dataDir)).toThrow(f.pluginId);
    const outside = join(f.root, "outside.json");
    writeFileSync(outside, f.bytes);
    symlinkSync(outside, f.bundlePath);
    expect(() => exportInstalledPlugins(f.store, f.dataDir)).toThrow(f.pluginId);
  } finally {
    f.store.close();
  }
});

test("export never follows a bundle link to an owner key inside the data root", () => {
  const f = fixture();
  try {
    const keyPath = join(f.dataDir, "owner.key");
    writeFileSync(keyPath, f.ownerKey, { mode: 0o600 });
    rmSync(f.bundlePath);
    symlinkSync(keyPath, f.bundlePath);
    expect(() => exportInstalledPlugins(f.store, f.dataDir)).toThrow(f.pluginId);
    rmSync(f.bundlePath);
    writeFileSync(f.bundlePath, f.ownerKey);
    expect(() => exportInstalledPlugins(f.store, f.dataDir)).toThrow(f.pluginId);
  } finally {
    f.store.close();
  }
});

test("restoration rejects path traversal, duplicate rows, altered pins and existing data roots", () => {
  const f = fixture();
  try {
    const snapshot = exportInstalledPlugins(f.store, f.dataDir);
    const plugin = snapshot.plugins[0]!;
    for (const bundlePath of [
      "../escape",
      "/tmp/escape",
      "plugins/example.export/../../escape",
      plugin.row.bundlePath.replaceAll("/", "\\"),
    ]) {
      expect(() =>
        restoreInstalledSnapshot(
          { ...snapshot, plugins: [{ ...plugin, row: { ...plugin.row, bundlePath } }] },
          join(f.root, "bad-path"),
        ),
      ).toThrow();
    }
    expect(() =>
      restoreInstalledSnapshot(
        { ...snapshot, plugins: [plugin, plugin] },
        join(f.root, "duplicate"),
      ),
    ).toThrow("duplicate");
    expect(() =>
      restoreInstalledSnapshot(
        { ...snapshot, plugins: [{ ...plugin, bytes: Buffer.from("changed").toString("base64") }] },
        join(f.root, "bad-pin"),
      ),
    ).toThrow(f.pluginId);
    expect(() => restoreInstalledSnapshot(snapshot, f.dataDir)).toThrow();
    expect(f.store.pluginInstalls()).toHaveLength(1);
    expect(readFileSync(f.bundlePath)).toEqual(f.bytes);
  } finally {
    f.store.close();
  }
});
