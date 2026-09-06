import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { packPlugin } from "@manifold/plugin-kit/pack";
import type { PluginAuthorRequest, PluginAuthorResult } from "@manifold/plugin";
import type { Logger } from "./log.ts";
import { AUTHORED_BUILD_DIR, AUTHORED_DIR, PLUGIN_BUNDLE_SUFFIX } from "./plugin-installs.ts";

/**
 * UNPACKED PLUGINS (ADR 0025 §4, #257): the directory an operator or their agent writes to,
 * `<data>/authored/<id>/`, and the loop that turns a write there into a roster row.
 *
 * The loop is watch → build → install → publish, and only the first two live here. The build
 * is the KIT's own `packPlugin` — the same `Bun.build` with the same shared-specifier plugin
 * that a `manifold-pack` from a checkout runs — so an unpacked row and a promoted bundle are
 * the same bytes from the same files (invariant 14: one bundler). The install is the host's
 * ONE install path, asked for an unpacked replace of the built artifact with the hash pinned
 * from the bytes it wrote; the publish is that path's. Nothing here loads code, and nothing
 * here reads the store: this file is the directory's hands.
 *
 * Developer mode is checked at the two entrances (the door and a change under watch): off,
 * the directory is not built and the door refuses `developer_mode_off` by name.
 */

/** Which build a change under the directory waits for before the next one starts. */
const REBUILD_DEBOUNCE_MS = 200;

/** A refused authoring attempt, in the door's own wording: `<class>: <detail>`. */
export interface AuthorRefused {
  readonly refused: string;
}

/** The builder, injectable so a unit test packs without the kit's `Bun.build` under `bun test`. */
export type AuthoredPack = (pluginDir: string, outFile: string) => Promise<{ sha256: string }>;

/** What the host lends the loop: the one install path, the row of record, and the switch. */
export interface AuthoredHost {
  /** The ONE install path, asked for an unpacked replace of `source` pinned at `sha256`. */
  installUnpacked(
    id: string,
    source: string,
    sha256: string,
    installedBy: string,
  ): Promise<AuthorRefused | PluginAuthorResult>;
  /** The unpacked row of record for `id`, or null when none is installed. */
  unpackedRow(id: string): (PluginAuthorResult & { readonly installedBy: string }) | null;
  developerMode(): boolean;
}

/** Where an unpacked plugin's files and its build land, a function of the id alone. */
export function authoredLayout(
  dataDir: string,
  pluginId: string,
): { readonly dir: string; readonly bundle: string } {
  const root = resolve(dataDir, AUTHORED_DIR);
  return {
    dir: join(root, pluginId),
    bundle: join(root, AUTHORED_BUILD_DIR, `${pluginId}${PLUGIN_BUNDLE_SUFFIX}`),
  };
}

export class AuthoredPlugins {
  private readonly root: string;
  private readonly pack: AuthoredPack;
  /** One build at a time per id: a save during a build queues the next, never interleaves. */
  private readonly building = new Map<string, Promise<AuthorRefused | PluginAuthorResult>>();
  /** The pending debounce per id, as its cancellation (the seam `room.ts` uses for timers). */
  private readonly pending = new Map<string, () => void>();
  private readonly watchers = new Map<string, FSWatcher>();

  constructor(
    private readonly dataDir: string,
    private readonly host: AuthoredHost,
    private readonly logger: Logger,
    pack: AuthoredPack = packPlugin,
  ) {
    this.root = resolve(dataDir, AUTHORED_DIR);
    this.pack = pack;
  }

  /**
   * THE AUTHORING DOOR'S HANDS: write the named files into the plugin's directory (a `null`
   * removes one), then rebuild exactly as a save under watch would. Refused before anything is
   * written while developer mode is off — the directory is admitted only behind the switch —
   * and never logs a file's contents (invariant 6): a plugin's source is the author's.
   */
  async author(
    request: PluginAuthorRequest,
    authoredBy: string,
  ): Promise<AuthorRefused | PluginAuthorResult> {
    if (!this.host.developerMode()) {
      return { refused: `developer_mode_off: ${request.id}` };
    }
    const { dir } = authoredLayout(this.dataDir, request.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(request.files)) {
      if (text === null) rmSync(join(dir, name), { force: true });
      else writeFileSync(join(dir, name), text, { mode: 0o600 });
    }
    this.logger.info("plugin_authored", {
      plugin: request.id,
      principal: authoredBy,
      files: Object.keys(request.files).length,
    });
    return this.rebuild(request.id, authoredBy);
  }

  /**
   * ONE REBUILD: pack the directory into `authored/.build/<id>.manifold-plugin.json`, and hand
   * the artifact to the install path unless its bytes hash to the row of record — the kit's
   * `unchanged` outcome, so a save that changes nothing replaces nothing and remounts nothing.
   * A build that fails (a syntax error, a manifest the schema refuses) is `artifact_invalid`
   * naming the problem, and the row of record stands: an edit is never able to take a working
   * plugin off the roster by being wrong.
   */
  rebuild(id: string, by: string): Promise<AuthorRefused | PluginAuthorResult> {
    const previous = this.building.get(id) ?? Promise.resolve(null);
    const next = previous.then(() => this.build(id, by));
    this.building.set(id, next);
    void next.finally(() => {
      if (this.building.get(id) === next) this.building.delete(id);
    });
    return next;
  }

  private async build(id: string, by: string): Promise<AuthorRefused | PluginAuthorResult> {
    if (!this.host.developerMode()) return { refused: `developer_mode_off: ${id}` };
    const { dir, bundle } = authoredLayout(this.dataDir, id);
    if (!existsSync(join(dir, "manifest.json"))) {
      return { refused: `artifact_invalid: ${dir} has no manifest.json` };
    }
    let sha256: string;
    try {
      ({ sha256 } = await this.pack(dir, bundle));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "build failed";
      this.logger.warn("plugin_authored_build_failed", { plugin: id, error: detail });
      return { refused: `artifact_invalid: ${detail}` };
    }
    const current = this.host.unpackedRow(id);
    if (current !== null && current.sha256 === sha256) {
      return {
        id: current.id,
        version: current.version,
        grantedCaps: current.grantedCaps,
        sha256: current.sha256,
      };
    }
    const outcome = await this.host.installUnpacked(id, bundle, sha256, current?.installedBy ?? by);
    if ("refused" in outcome) {
      this.logger.warn("plugin_authored_build_failed", { plugin: id, error: outcome.refused });
    }
    return outcome;
  }

  /**
   * THE WATCH: `node:fs` `watch` on the root (directories appearing and leaving) and on every
   * `<id>/` in it (files changing), no dependency. A change debounces into one rebuild; a
   * directory that appears is watched and built; one that leaves is forgotten here and
   * nowhere else — its row is the uninstall door's to remove, exactly as a bundle's is. Every
   * existing directory is rebuilt once at start, which is how an edit made while the hub was
   * down reaches the roster. Returns the stop.
   */
  watch(): () => void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const rootWatcher = watch(this.root, (_event, filename) => {
      if (filename === null) return;
      const id = String(filename);
      if (id.startsWith(".")) return;
      if (this.isPluginDir(id)) this.follow(id);
      else this.unfollow(id);
    });
    for (const id of readdirSync(this.root)) {
      if (!id.startsWith(".") && this.isPluginDir(id)) this.follow(id);
    }
    return () => {
      rootWatcher.close();
      for (const id of [...this.watchers.keys()]) this.unfollow(id);
    };
  }

  private isPluginDir(id: string): boolean {
    try {
      return statSync(join(this.root, id)).isDirectory();
    } catch {
      return false;
    }
  }

  private follow(id: string): void {
    if (this.watchers.has(id)) return;
    const watcher = watch(join(this.root, id), (_event, filename) => {
      if (filename !== null && String(filename).startsWith(".")) return;
      this.schedule(id);
    });
    this.watchers.set(id, watcher);
    this.schedule(id);
  }

  private unfollow(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    this.pending.get(id)?.();
    this.pending.delete(id);
  }

  private schedule(id: string): void {
    this.pending.get(id)?.();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      if (!this.host.developerMode()) return;
      void this.rebuild(id, "engine.plugins").catch((error: unknown) => {
        this.logger.error("plugin_authored_build_failed", {
          plugin: id,
          error: error instanceof Error ? error.message : "rebuild failed",
        });
      });
    }, REBUILD_DEBOUNCE_MS);
    this.pending.set(id, () => clearTimeout(timer));
  }
}
