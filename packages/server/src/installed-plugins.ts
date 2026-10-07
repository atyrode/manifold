import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  HARDENED_CONTRACT_MINIMUM,
  ISOLATE_MAX_ARTIFACT_BYTES,
  PluginIdSchema,
  type InstalledPluginRow,
  type InstalledPluginStates,
  type InstalledPluginsSnapshot,
} from "@manifold/protocol";
import { installLayout, parseBundle } from "./plugin-installs.ts";
import { readReplacementJournal } from "./plugin-replacements.ts";
import { sha256Hex, type PluginInstallRow, type ServerStore } from "./stores.ts";

/** Configured intent remains inspectable even when bundle loading is held or broken. */
export function listInstalledPlugins(store: ServerStore): InstalledPluginStates {
  const disabled = store.disabledPlugins();
  return {
    plugins: store.pluginInstalls().map(({ pluginId, sha256 }) => ({
      pluginId,
      sha256,
      enabled: !disabled.has(pluginId),
    })),
  };
}

/** One installed row's pinned bytes, read exactly, and its portable projection. */
function exportedBundle(
  row: PluginInstallRow,
  dataDir: string | null,
): { readonly row: InstalledPluginRow; readonly bytes: string } {
  const fail = () =>
    new Error(
      `${row.pluginId}: installed bundle cannot be exported; restore its pinned bundle or repack with the current plugin SDK (minimum hardened contract ${HARDENED_CONTRACT_MINIMUM})`,
    );
  if (dataDir === null) throw fail();
  if (!PluginIdSchema.safeParse(row.pluginId).success || !/^[0-9a-f]{64}$/.test(row.sha256))
    throw fail();
  const expected = installLayout(dataDir, row.pluginId, row.sha256).bundlePath;
  if (resolve(row.bundlePath) !== resolve(expected)) throw fail();
  let bytes: Buffer;
  try {
    const root = realpathSync(dataDir);
    const path = realpathSync(row.bundlePath);
    if (path !== resolve(root, relative(resolve(dataDir), expected))) throw fail();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size <= 0 || stat.size > ISOLATE_MAX_ARTIFACT_BYTES) throw fail();
      const bounded = Buffer.allocUnsafe(stat.size + 1);
      let offset = 0;
      while (offset < bounded.length) {
        const count = readSync(fd, bounded, offset, bounded.length - offset, null);
        if (count === 0) break;
        offset += count;
      }
      if (offset !== stat.size) throw fail();
      bytes = bounded.subarray(0, offset);
      if (sha256Hex(bytes) !== row.sha256 || parseBundle(bytes).manifest.id !== row.pluginId)
        throw fail();
    } finally {
      closeSync(fd);
    }
  } catch {
    throw fail();
  }
  const bundlePath = `plugins/${row.pluginId}/${row.sha256}.manifold-plugin.json`;
  return {
    row: {
      pluginId: row.pluginId,
      sha256: row.sha256,
      source: bundlePath,
      grantedCaps: [...row.grantedCaps],
      installedBy: row.installedBy,
      installedAt: row.installedAt,
      bundlePath,
      actions: [...row.actions],
      ...(row.hardened === undefined ? {} : { hardened: row.hardened }),
      ...(row.builtAgainst === undefined ? {} : { builtAgainst: row.builtAgainst }),
      ...(row.mode === undefined ? {} : { mode: row.mode }),
    },
    bytes: bytes.toString("base64"),
  };
}

/**
 * Read only the installed bundle inventory, with an allowlisted persistence projection. With
 * `crossings`, also the staged-crossing journal (#1068): each member's replaced row and its
 * retained bytes, so a rollback gate can boot the previous hub on the closure a restore yields.
 */
export function exportInstalledPlugins(
  store: ServerStore,
  dataDir: string | null,
  crossings = false,
): InstalledPluginsSnapshot {
  const disabled = store.disabledPlugins();
  const plugins = store.pluginInstalls().map((row) => ({
    ...exportedBundle(row, dataDir),
    enabled: !disabled.has(row.pluginId),
  }));
  const snapshot = { format: 1 as const, developerMode: store.developerMode(), plugins };
  if (!crossings || dataDir === null) return snapshot;
  return {
    ...snapshot,
    crossings: readReplacementJournal(dataDir).map((record) => ({
      revision: record.revision,
      setSha256: record.setSha256,
      members: record.members.map((member) => ({
        pluginId: member.previous.pluginId,
        sha256: member.sha256,
        previous: exportedBundle(member.previous, dataDir),
      })),
    })),
  };
}
