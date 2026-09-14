import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARDENED_CONTRACT_MINIMUM,
  InstalledPluginsSnapshotSchema,
  PluginsResponseSchema,
  type InstalledPluginsSnapshot,
  type PluginRoster,
} from "../packages/protocol/src/index.ts";
import { openDatabase, ServerStore, sha256Hex } from "../packages/server/src/index.ts";

export function restoreInstalledSnapshot(
  snapshot: InstalledPluginsSnapshot,
  dataDir: string,
): void {
  // An exclusive new directory also rules out preexisting symlink parents and live databases.
  const parsed = InstalledPluginsSnapshotSchema.parse(snapshot);
  mkdirSync(dataDir, { mode: 0o700 });
  const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
  try {
    for (const { row, bytes, enabled } of parsed.plugins) {
      const decoded = Buffer.from(bytes, "base64");
      if (sha256Hex(decoded) !== row.sha256) {
        throw new Error(
          `${row.pluginId}: pinned bundle hash mismatch; repack with the current plugin SDK (minimum hardened contract ${HARDENED_CONTRACT_MINIMUM})`,
        );
      }
      const bundlePath = join(dataDir, row.bundlePath);
      mkdirSync(join(dataDir, "plugins", row.pluginId), { recursive: true });
      writeFileSync(bundlePath, decoded, { flag: "wx", mode: 0o600 });
      store.putPluginInstall({
        pluginId: row.pluginId,
        sha256: row.sha256,
        source: bundlePath,
        bundlePath,
        grantedCaps: row.grantedCaps,
        installedBy: row.installedBy,
        installedAt: row.installedAt,
        actions: row.actions,
        ...(row.hardened === undefined ? {} : { hardened: row.hardened }),
        ...(row.builtAgainst === undefined ? {} : { builtAgainst: row.builtAgainst }),
        ...(row.mode === undefined ? {} : { mode: row.mode }),
      });
      store.setPluginEnabled(row.pluginId, enabled, "installed-bundles", row.installedAt);
    }
    store.setDeveloperMode(parsed.developerMode);
  } finally {
    store.close();
  }
}

/** Every inventory member must be present and healthy, including rows disabled on the source. */
export function installedBundleFailures(
  snapshot: InstalledPluginsSnapshot,
  roster: PluginRoster,
): string[] {
  const entries = new Map(roster.map((entry) => [entry.manifest.id, entry]));
  const failures: string[] = [];
  for (const { row } of snapshot.plugins) {
    const entry = entries.get(row.pluginId);
    const reason = !entry
      ? "missing from candidate roster"
      : entry.held
        ? `held: ${entry.held.reason}`
        : entry.install?.sha256 !== row.sha256
          ? "candidate pin differs from exported install"
          : (entry.install.refusal ?? (entry.lifecycle === "ok" ? undefined : entry.lifecycle));
    if (reason) {
      failures.push(
        `${row.pluginId}: ${reason}; repack with the current plugin SDK (minimum hardened contract ${entry?.held?.minimum ?? HARDENED_CONTRACT_MINIMUM})`,
      );
    }
  }
  return failures;
}

/** The verifier never imports plugin code into its own process: a clean early exit is failure. */
async function candidateRoster(dataDir: string): Promise<PluginRoster> {
  const ownerKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../packages/server/src/main.ts")],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env.PATH ?? "",
        MANIFOLD_DATA_DIR: dataDir,
        MANIFOLD_BIND: "127.0.0.1",
        MANIFOLD_PORT: "0",
        MANIFOLD_SPAWN_AGENT: "0",
        MANIFOLD_OWNER_KEY: ownerKey,
        MANIFOLD_ANNOUNCE_KEY: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const ready = Promise.withResolvers<string>();
  const deadline = setTimeout(() => ready.reject(new Error("candidate startup timed out")), 30_000);
  void child.exited.then((code) =>
    ready.reject(new Error(`candidate exited ${String(code)} before completing startup`)),
  );
  const output = (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      // Guest logs cannot create an unbounded startup buffer.
      if (buffered.length > 64 * 1024) buffered = buffered.slice(-64 * 1024);
      for (const line of lines) {
        const match = /^manifold ready url=(http:\/\/(?:127\.0\.0\.1|localhost):\d+)\s*$/.exec(
          line,
        );
        if (match?.[1] !== undefined) ready.resolve(match[1]);
      }
    }
  })().catch((error: unknown) => {
    ready.reject(error instanceof Error ? error : new Error("candidate output failed"));
  });
  try {
    const origin = await ready.promise;
    clearTimeout(deadline);
    const response = await fetch(`${origin}/api/plugins`, {
      headers: { authorization: `Bearer ${ownerKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`candidate roster HTTP ${String(response.status)}`);
    const roster = PluginsResponseSchema.parse(await response.json()).plugins;
    if (child.exitCode !== null) throw new Error("candidate exited before completing verification");
    return roster;
  } finally {
    clearTimeout(deadline);
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await child.exited;
      await output;
    } finally {
      clearTimeout(kill);
    }
  }
}

/** Runs in the candidate image; only run-owned data and a freshly generated local key exist. */
export async function checkInstalledCandidate(snapshot: InstalledPluginsSnapshot): Promise<void> {
  const parsed = InstalledPluginsSnapshotSchema.parse(snapshot);
  const root = mkdtempSync(join(tmpdir(), "manifold-installed-bundles-"));
  try {
    for (const phase of ["installed", "all-loadable"] as const) {
      const dataDir = join(root, phase);
      restoreInstalledSnapshot(parsed, dataDir);
      if (phase === "all-loadable") {
        // Boot has no onEnable hooks. This second disposable copy forces disabled in-realm
        // modules through the real loader too, without changing a single source install.
        const store = new ServerStore(openDatabase(join(dataDir, "manifold.db")));
        try {
          for (const { row } of parsed.plugins)
            store.setPluginEnabled(row.pluginId, true, "installed-bundles", row.installedAt);
          store.setDeveloperMode(true);
        } finally {
          store.close();
        }
      }
      const failures = installedBundleFailures(parsed, await candidateRoster(dataDir));
      if (failures.length > 0) throw new Error(failures.join("\n"));
    }
    console.log(
      `installed-bundles: ${parsed.plugins.length} installed bundle(s) passed candidate assembly and loading, including disabled rows`,
    );
  } catch (error) {
    const names =
      parsed.plugins.map(({ row }) => row.pluginId).join(", ") || "empty installed inventory";
    throw new Error(
      `installed-bundles refused (${names}); minimum hardened contract ${HARDENED_CONTRACT_MINIMUM}, repack with the current plugin SDK: ${error instanceof Error ? error.message : "candidate boot failed"}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: bun scripts/installed-bundles-candidate.ts SNAPSHOT.json");
  try {
    await checkInstalledCandidate(
      InstalledPluginsSnapshotSchema.parse(await Bun.file(file).json()),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "installed-bundles candidate failed");
    process.exit(1);
  }
}
