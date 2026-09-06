#!/usr/bin/env bun
import { watch } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PluginManifestSchema } from "@manifold/protocol";
import type { Hub } from "./hub.ts";
import {
  exitWith,
  familyOrder,
  installBundle,
  parseHubFlags,
  resolveOwnerKey,
  type Delivery,
  type InstallOutcome,
} from "./install.ts";
import { packPlugin } from "./pack.ts";

/**
 * `dev` — the inner loop for an out-of-tree plugin author (issue #319): pack, install, watch,
 * repeat. A browser reload on the hub shows the change.
 *
 *     bun run --cwd packages/plugin-kit dev <plugins-root> --hub <url>
 *         [--deliver path | docker:<container>] [--owner-key-file <path>]
 *
 * Every directory under the root holding a `manifest.json` is a plugin (a part lives inside
 * its parent's directory, ADR 0023; `node_modules` and `dist` are never looked into). Each is
 * packed into a temporary directory and installed parents first, with `install`'s exact
 * semantics — so the first cycle on a hub that already runs these ids is a set of `unchanged`
 * lines and costs nothing. Then the root is watched; a burst of saves is one cycle, and a
 * cycle installs only the bundles whose sha changed. A cycle that fails to pack or install
 * reports the failure and the loop keeps watching: the author's next save is the retry.
 *
 * One JSON line per cycle. The loop is pack + replace-install, deliberately: the engine
 * respawns the isolate and serves the web half `no-store`, and that is the whole reload story.
 */

const DEBOUNCE_MS = 250;
const SKIPPED_DIRS: Record<string, true> = { node_modules: true, dist: true };

interface CycleEntry {
  readonly id: string;
  readonly sha256: string;
  readonly outcome: InstallOutcome;
}

interface CycleReport {
  readonly cycle: number;
  readonly plugins: readonly CycleEntry[];
  readonly ms: number;
}

/** Every plugin directory under `root`, as `{ dir, id }`, by walking for `manifest.json`. */
export async function discoverPlugins(
  root: string,
): Promise<{ readonly dir: string; readonly id: string }[]> {
  const found: { dir: string; id: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
      const manifest = PluginManifestSchema.parse(
        await Bun.file(join(dir, "manifest.json")).json(),
      );
      found.push({ dir, id: manifest.id });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRS[entry.name] !== true)
        await walk(join(dir, entry.name));
    }
  };
  await walk(root);
  return familyOrder(found);
}

interface DevOptions {
  readonly root: string;
  readonly hub: Hub;
  readonly deliver?: Delivery;
  readonly packDir: string;
}

/**
 * One cycle: pack everything, install what moved. `last` is the sha each id was installed at
 * by a previous cycle; a bundle that packs to the same bytes is not even mentioned to the hub.
 */
async function cycle(
  options: DevOptions,
  last: Map<string, string>,
  number: number,
): Promise<CycleReport> {
  const started = performance.now();
  const plugins: CycleEntry[] = [];
  for (const plugin of await discoverPlugins(options.root)) {
    const file = join(options.packDir, `${plugin.id}.manifold-plugin.json`);
    const packed = await packPlugin(plugin.dir, file);
    if (last.get(plugin.id) === packed.sha256) {
      plugins.push({ id: plugin.id, sha256: packed.sha256, outcome: "unchanged" });
      continue;
    }
    const report = await installBundle({
      source: file,
      hub: options.hub,
      sha256: packed.sha256,
      ...(options.deliver === undefined ? {} : { deliver: options.deliver }),
    });
    last.set(plugin.id, packed.sha256);
    plugins.push({ id: plugin.id, sha256: packed.sha256, outcome: report.outcome });
  }
  return { cycle: number, plugins, ms: Math.round(performance.now() - started) };
}

/** Runs the first cycle, then one per burst of changes under the root, until the process ends. */
export async function devLoop(options: Omit<DevOptions, "packDir">): Promise<never> {
  const packDir = await mkdtemp(join(tmpdir(), "manifold-dev-"));
  const full: DevOptions = { ...options, packDir };
  const last = new Map<string, string>();
  let number = 0;
  let running: Promise<void> = Promise.resolve();
  let pending = false;

  const run = (): void => {
    // Cycles never overlap: a change during one is queued as exactly one more.
    if (pending) return;
    pending = true;
    running = running.then(async () => {
      pending = false;
      number++;
      try {
        console.log(JSON.stringify(await cycle(full, last, number)));
      } catch (error) {
        console.error(
          `dev: cycle ${String(number)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };

  let timer: Timer | undefined;
  watch(options.root, { recursive: true }, (_event, filename) => {
    const path = typeof filename === "string" ? filename : "";
    if (path.split(sep).some((segment) => SKIPPED_DIRS[segment] === true)) return;
    clearTimeout(timer);
    timer = setTimeout(run, DEBOUNCE_MS);
  });
  const cleanup = (): void => {
    void rm(packDir, { recursive: true, force: true }).finally(() => process.exit(0));
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  run();
  return new Promise<never>(() => {});
}

function usage(): never {
  console.error(
    "usage: manifold-dev <plugins-root> --hub <url> [--deliver path | docker:<container>] [--owner-key-file <path>]",
  );
  process.exit(2);
}

if (import.meta.main) {
  try {
    const flags = parseHubFlags(process.argv.slice(2), false);
    const [root] = flags.positionals;
    if (root === undefined || flags.positionals.length !== 1) usage();
    const ownerKey = await resolveOwnerKey(flags.ownerKeyFile, flags.deliver);
    await devLoop({
      root: resolve(root),
      hub: { url: flags.hub, ownerKey },
      ...(flags.deliver === undefined ? {} : { deliver: flags.deliver }),
    });
  } catch (error) {
    exitWith("dev", error);
  }
}
