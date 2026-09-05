import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionOutcomeSchema, type PluginManifest } from "@manifold/protocol";
import { loadConfig } from "../src/config.ts";
import { silentLogger } from "../src/log.ts";
import { startServer, type RunningServer } from "../src/main.ts";
import {
  InstallRefusal,
  PLUGIN_UPLOADS_DIR,
  installArtifact,
  installLayout,
  removeInstall,
  verifyInstalledBundle,
} from "../src/plugin-installs.ts";
import { sha256Hex, type PluginInstallRow } from "../src/stores.ts";

/**
 * THE ARTIFACT'S JOURNEY, fail-closed at every step (ADR 0016 R8). What these cases defend is
 * ORDER: the pin is checked before anything is parsed, nothing is written before the bundle is
 * admitted, and a stored bundle is re-hashed — not trusted — at boot.
 */

const MANIFEST: PluginManifest = {
  id: "vendor.sample",
  version: "1.2.3",
  title: "Sample",
  description: "an installed sample",
  capabilities: ["containers:read"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true, web: "web.js" },
};

function bundleBytes(manifest: PluginManifest = MANIFEST, files?: Record<string, string>): Buffer {
  const members = files ?? { "server.js": "export const half = 'server';", "web.js": "export {};" };
  return Buffer.from(
    JSON.stringify({
      format: 1,
      manifest,
      files: Object.fromEntries(
        Object.entries(members).map(([name, text]) => [name, Buffer.from(text).toString("base64")]),
      ),
    }),
  );
}

interface Box {
  readonly dataDir: string;
  /** Drops `bytes` into the uploads box and returns its absolute path. */
  upload(name: string, bytes: Uint8Array): string;
}

function box(): Box {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-installs-"));
  const uploads = join(dataDir, PLUGIN_UPLOADS_DIR);
  mkdirSync(uploads, { recursive: true });
  return {
    dataDir,
    upload(name, bytes) {
      const path = join(uploads, name);
      writeFileSync(path, bytes);
      return path;
    },
  };
}

async function refusal(run: () => Promise<unknown>): Promise<InstallRefusal> {
  try {
    await run();
  } catch (error) {
    if (error instanceof InstallRefusal) return error;
    throw error;
  }
  throw new Error("expected an install refusal");
}

describe("installArtifact", () => {
  test("a hash that does not match the bytes writes nothing", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const source = drop.upload("sample.manifold-plugin.json", bytes);
    const refused = await refusal(() =>
      installArtifact({ source, sha256: "0".repeat(64), dataDir: drop.dataDir }),
    );
    expect(refused.reason).toBe("hash_mismatch");
    expect(refused.detail).toContain(sha256Hex(bytes));
    expect(existsSync(join(drop.dataDir, "plugins"))).toBeFalse();
  });

  test("bytes that hash right but are not a bundle are refused naming the path", async () => {
    const drop = box();
    const bytes = Buffer.from(JSON.stringify({ format: 2, manifest: MANIFEST, files: {} }));
    const source = drop.upload("bad.manifold-plugin.json", bytes);
    const refused = await refusal(() =>
      installArtifact({ source, sha256: sha256Hex(bytes), dataDir: drop.dataDir }),
    );
    expect(refused.reason).toBe("artifact_invalid");
    expect(refused.detail).toContain("format");
    expect(existsSync(join(drop.dataDir, "plugins"))).toBeFalse();
  });

  test("a bundle whose entry names a member it lacks is refused at the half", async () => {
    const drop = box();
    const bytes = bundleBytes(MANIFEST, { "server.js": "export {};" });
    const source = drop.upload("half.manifold-plugin.json", bytes);
    const refused = await refusal(() =>
      installArtifact({ source, sha256: sha256Hex(bytes), dataDir: drop.dataDir }),
    );
    expect(refused.reason).toBe("artifact_invalid");
    expect(refused.detail).toContain("manifest.entry.web");
  });

  test("a path outside the uploads box is refused unless dev paths are on", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const elsewhere = mkdtempSync(join(tmpdir(), "manifold-elsewhere-"));
    const source = join(elsewhere, "sample.manifold-plugin.json");
    writeFileSync(source, bytes);
    const sha256 = sha256Hex(bytes);

    const refused = await refusal(() => installArtifact({ source, sha256, dataDir: drop.dataDir }));
    expect(refused.reason).toBe("artifact_unreadable");
    expect(refused.detail).toContain(PLUGIN_UPLOADS_DIR);
    expect(existsSync(join(drop.dataDir, "plugins"))).toBeFalse();

    const relative = await refusal(() =>
      installArtifact({ source: "sample.manifold-plugin.json", sha256, dataDir: drop.dataDir }),
    );
    expect(relative.reason).toBe("artifact_unreadable");

    const admitted = await installArtifact({
      source,
      sha256,
      dataDir: drop.dataDir,
      devPaths: true,
    });
    expect(admitted.bundle.manifest.id).toBe("vendor.sample");
  });

  test("the happy path writes the bundle beside its extracted members", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const sha256 = sha256Hex(bytes);
    const source = drop.upload("sample.manifold-plugin.json", bytes);
    const admitted = await installArtifact({ source, sha256, dataDir: drop.dataDir });

    const layout = installLayout(drop.dataDir, "vendor.sample", sha256);
    expect(admitted.bundlePath).toBe(layout.bundlePath);
    expect(admitted.dir).toBe(layout.dir);
    // The stored artifact is the EXACT bytes read, so it still hashes to the pin.
    expect(sha256Hex(readFileSync(layout.bundlePath))).toBe(sha256);
    expect(readdirSync(layout.dir).sort()).toEqual(["server.js", "web.js"]);
    expect(readFileSync(join(layout.dir, "server.js"), "utf8")).toBe(
      "export const half = 'server';",
    );
  });

  test("admission is asked once the bundle is parsed and before anything is written", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const source = drop.upload("sample.manifold-plugin.json", bytes);
    const seen: string[] = [];
    const refused = await refusal(() =>
      installArtifact({
        source,
        sha256: sha256Hex(bytes),
        dataDir: drop.dataDir,
        admit: (bundle) => {
          seen.push(bundle.manifest.id);
          return new InstallRefusal("already_installed", "nope");
        },
      }),
    );
    expect(refused.reason).toBe("already_installed");
    expect(seen).toEqual(["vendor.sample"]);
    expect(existsSync(join(drop.dataDir, "plugins"))).toBeFalse();
  });

  test("an https source is fetched, bounded, and refused on a non-2xx answer", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const sha256 = sha256Hex(bytes);
    const asked: string[] = [];
    const fetchImpl = ((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      asked.push(url);
      if (url.endsWith("/missing")) return Promise.resolve(new Response("nope", { status: 404 }));
      return Promise.resolve(new Response(bytes, { status: 200 }));
    }) as typeof fetch;

    const admitted = await installArtifact({
      source: "https://plugins.example/sample.manifold-plugin.json",
      sha256,
      dataDir: drop.dataDir,
      fetchImpl,
    });
    expect(admitted.sha256).toBe(sha256);

    const missing = await refusal(() =>
      installArtifact({
        source: "https://plugins.example/missing",
        sha256,
        dataDir: drop.dataDir,
        fetchImpl,
      }),
    );
    expect(missing.reason).toBe("artifact_unreadable");
    expect(missing.detail).toBe("HTTP 404");

    // Code fetched in the clear is code somebody on the path chose: never fetched at all.
    const clear = await refusal(() =>
      installArtifact({
        source: "http://plugins.example/sample.manifold-plugin.json",
        sha256,
        dataDir: drop.dataDir,
        fetchImpl,
      }),
    );
    expect(clear.reason).toBe("artifact_unreadable");
    expect(asked).toHaveLength(2);
  });
});

describe("verifyInstalledBundle", () => {
  function rowFor(dataDir: string, sha256: string): PluginInstallRow {
    return {
      pluginId: "vendor.sample",
      sha256,
      source: "/uploads/sample",
      grantedCaps: ["containers:read"],
      installedBy: "p-owner",
      installedAt: 1,
      bundlePath: installLayout(dataDir, "vendor.sample", sha256).bundlePath,
      actions: [],
    };
  }

  test("re-hashes the stored file and re-extracts a member somebody edited", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const sha256 = sha256Hex(bytes);
    const admitted = await installArtifact({
      source: drop.upload("s.manifold-plugin.json", bytes),
      sha256,
      dataDir: drop.dataDir,
    });
    // An edited extracted file is NOT the artifact of record: verification rewrites it.
    writeFileSync(join(admitted.dir, "server.js"), "process.exit(1)");
    const verdict = verifyInstalledBundle(rowFor(drop.dataDir, sha256));
    expect(verdict.ok).toBeTrue();
    expect(readFileSync(join(admitted.dir, "server.js"), "utf8")).toBe(
      "export const half = 'server';",
    );
  });

  test("a bundle that no longer hashes to the pin is hash_mismatch, and a missing one unreadable", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const sha256 = sha256Hex(bytes);
    const row = rowFor(drop.dataDir, sha256);
    expect(verifyInstalledBundle(row)).toMatchObject({ ok: false, refusal: "artifact_unreadable" });

    await installArtifact({
      source: drop.upload("s.manifold-plugin.json", bytes),
      sha256,
      dataDir: drop.dataDir,
    });
    writeFileSync(row.bundlePath, bundleBytes({ ...MANIFEST, capabilities: ["*"] }));
    expect(verifyInstalledBundle(row)).toMatchObject({ ok: false, refusal: "hash_mismatch" });
  });

  test("a bundle whose manifest moved to another id is refused: the row is the consent", async () => {
    const drop = box();
    const bytes = bundleBytes({ ...MANIFEST, id: "vendor.other" });
    const sha256 = sha256Hex(bytes);
    const admitted = await installArtifact({
      source: drop.upload("o.manifold-plugin.json", bytes),
      sha256,
      dataDir: drop.dataDir,
    });
    const row: PluginInstallRow = {
      ...rowFor(drop.dataDir, sha256),
      bundlePath: admitted.bundlePath,
    };
    expect(verifyInstalledBundle(row)).toMatchObject({ ok: false, refusal: "artifact_invalid" });
  });

  test("removeInstall deletes the bundle, its members, and an emptied home", async () => {
    const drop = box();
    const bytes = bundleBytes();
    const sha256 = sha256Hex(bytes);
    const admitted = await installArtifact({
      source: drop.upload("s.manifold-plugin.json", bytes),
      sha256,
      dataDir: drop.dataDir,
    });
    removeInstall(rowFor(drop.dataDir, sha256));
    expect(existsSync(admitted.bundlePath)).toBeFalse();
    expect(existsSync(admitted.dir)).toBeFalse();
    expect(existsSync(join(drop.dataDir, "plugins", "vendor.sample"))).toBeFalse();
  });
});

/**
 * THE WORKER MODULE ROUTE, over a real server: the one HTTP door this wave adds (S7). A
 * web-only bundle, so no child process is involved — the route serves from the verified bundle
 * the host holds, and what it serves is decided by the roster: installed AND enabled, or 404.
 */
describe("GET /api/plugins/:id/web.js", () => {
  const OWNER_KEY = "e".repeat(64);
  const temporaryDirectories: string[] = [];
  const runningServers: RunningServer[] = [];

  afterEach(async () => {
    for (const running of runningServers.splice(0)) await running.stop();
    for (const path of temporaryDirectories.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("serves the enabled plugin's module with the pin as its ETag, and 404 otherwise", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "manifold-web-module-"));
    temporaryDirectories.push(cwd);
    const config = loadConfig(
      {
        MANIFOLD_PORT: "0",
        MANIFOLD_DATA_DIR: "data",
        MANIFOLD_OWNER_KEY: OWNER_KEY,
        MANIFOLD_SPAWN_AGENT: "0",
      },
      cwd,
    );
    const uploads = join(config.dataDir, PLUGIN_UPLOADS_DIR);
    mkdirSync(uploads, { recursive: true });
    const bytes = bundleBytes(
      { ...MANIFEST, id: "vendor.webonly", entry: { web: "web.js" } },
      { "web.js": "export const panel = 'hello';" },
    );
    const source = join(uploads, "webonly.manifold-plugin.json");
    writeFileSync(source, bytes);
    const sha256 = sha256Hex(bytes);
    const running = await startServer({ config, logger: silentLogger, announce: false });
    runningServers.push(running);
    const headers = { authorization: `Bearer ${OWNER_KEY}`, "content-type": "application/json" };
    const door = async (name: string, body: unknown): Promise<unknown> => {
      const response = await fetch(`${running.publicUrl}/api/actions/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return ActionOutcomeSchema.parse(await response.json());
    };
    const moduleUrl = `${running.publicUrl}/api/plugins/vendor.webonly/web.js`;

    expect((await fetch(moduleUrl, { headers })).status).toBe(404);
    expect(await door("engine.plugins.install", { source, sha256 })).toEqual({
      ok: true,
      result: { id: "vendor.webonly", version: "1.2.3", grantedCaps: ["containers:read"] },
    });

    const served = await fetch(moduleUrl, { headers });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(served.headers.get("cache-control")).toBe("no-store");
    expect(served.headers.get("etag")).toBe(`"${sha256}"`);
    expect(await served.text()).toBe("export const panel = 'hello';");
    // The same authority as the roster read: no bearer, no module.
    expect((await fetch(moduleUrl)).status).toBe(401);

    expect(
      await door("engine.plugins.setEnabled", { id: "vendor.webonly", enabled: false }),
    ).toEqual({ ok: true, result: {} });
    expect((await fetch(moduleUrl, { headers })).status).toBe(404);
  });
});
