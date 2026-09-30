import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginManifestSchema,
  machineArtifacts,
  unscopedRule,
} from "@manifold/protocol";
import type { PluginManifest } from "@manifold/protocol";
import type { Plugin, ViteDevServer } from "vite";
import { parseHubUrl } from "./hub.ts";
import { familyOrder, requiredDependencyIds } from "./install.ts";
import { SHARED_MODULES } from "./pack.ts";
import { PLUGIN_REFRESH_CANCEL_EVENT, pluginRefreshRuntime } from "./refresh-runtime.ts";
import { PluginRefreshError } from "./refresh-options.ts";
export { PLUGIN_REFRESH_DESCRIPTION, PluginRefreshError } from "./refresh-options.ts";

const REGISTRY = "virtual:manifold-plugin-development";
const RUNTIME = "virtual:manifold-plugin-refresh-runtime";
const BRIDGE = "virtual:manifold-plugin-refresh-entry:";
const STYLE = "virtual:manifold-plugin-refresh-style:";
const ACTIVE_PLUGIN = "manifold-plugin-development-active";
const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));
const REPOSITORY_ROOT = resolve(WEB_ROOT, "../..");
const SKIPPED: Record<string, true> = { node_modules: true, dist: true, ".git": true };
const LOCKFILES: Record<string, true> = {
  "package.json": true,
  "bun.lock": true,
  "bun.lockb": true,
  "package-lock.json": true,
  "pnpm-lock.yaml": true,
  "yarn.lock": true,
};


interface Source {
  readonly id: string;
  readonly dir: string;
  readonly manifest: PluginManifest;
  readonly entry: string;
  readonly styles?: string;
  readonly installationFiles: Set<string>;
  readonly unservableFiles: Set<string>;
  cancelled: boolean;
}

export interface PluginRefreshOptions {
  readonly root: string;
  readonly hub: string;
  /** Zero asks the OS for a port. The listener always binds loopback. */
  readonly port?: number;
}

export interface PluginRefreshHandle {
  readonly url: string;
  readonly hub: string;
  readonly plugins: readonly string[];
  readonly sources: readonly { readonly id: string; readonly manifest: PluginManifest }[];
  /** Resolves after successful cleanup; rejects on a server or cleanup failure. */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}


function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`));
}

function denied(path: string): boolean {
  return path.split(/[\\/]/).some((part) =>
    /^(?:\.env(?:\..*)?|\.git|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|owner\.key|credentials?(?:\.(?:json|ya?ml|toml|ini|txt))?)$/i.test(part) ||
    /\.(?:pem|key|p12|pfx)$/i.test(part),
  );
}

async function containedFile(root: string, path: string): Promise<string> {
  const absolute = resolve(path);
  if (!inside(root, absolute) || denied(absolute)) {
    throw new PluginRefreshError("source_boundary", "source path is outside the registered root or is secret-bearing");
  }
  const canonical = await realpath(absolute);
  if (!inside(root, canonical) || denied(canonical) || !(await stat(canonical)).isFile()) {
    throw new PluginRefreshError("source_boundary", "source must be a regular file contained by the registered root");
  }
  return canonical;
}

async function backendFiles(root: string, entry: string, files: Set<string>): Promise<void> {
  if (files.has(entry)) return;
  const path = await containedFile(root, entry);
  files.add(path);
  const extension = extname(path);
  if (!/\.[cm]?[jt]sx?$/.test(extension)) return;
  const loader = extension.endsWith("tsx") ? "tsx" : extension.endsWith("jsx") ? "jsx" : extension.endsWith("ts") ? "ts" : "js";
  const imports = new Bun.Transpiler({ loader }).scanImports(await Bun.file(path).text());
  for (const imported of imports) {
    if (!imported.path.startsWith(".")) continue;
    await backendFiles(root, Bun.resolveSync(imported.path, dirname(path)), files);
  }
}

async function discoverSources(root: string): Promise<Source[]> {
  const found: (Source & { requiredDependencies: readonly string[] })[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    if (manifestEntry) {
      const manifestFile = await containedFile(root, join(dir, "manifest.json"));
      const manifest = PluginManifestSchema.parse(await Bun.file(manifestFile).json());
      if (manifest.entry?.web !== undefined) {
        let entry: string | undefined;
        for (const name of ["web.tsx", "web.ts"]) {
          if (entries.some((file) => file.name === name)) {
            entry = await containedFile(root, join(dir, name));
            break;
          }
        }
        if (!entry) throw new PluginRefreshError("missing_entry", `${manifest.id}: source mode requires an existing web.tsx or web.ts`);
        const installationFiles = new Set([manifestFile]);
        const unservableFiles = new Set<string>();
        if (manifest.entry.server) {
          const backend = await containedFile(root, join(dir, "server.ts"));
          unservableFiles.add(backend);
          await backendFiles(root, backend, installationFiles);
        }
        for (const artifact of machineArtifacts(manifest.machine)) {
          if (artifact.bundleFile) {
            const native = resolve(dir, artifact.bundleFile);
            installationFiles.add(native);
            unservableFiles.add(native);
          }
        }
        const styles = manifest.entry.styles ? await containedFile(root, join(dir, "styles.css")) : undefined;
        if (!manifest.entry.styles && entries.some((file) => file.name === "styles.css")) {
          throw new PluginRefreshError("stylesheet_undeclared", `${manifest.id}: styles.css requires entry.styles`);
        }
        if (styles) validateStyles(await Bun.file(styles).text(), manifest.id);
        found.push({ id: manifest.id, dir, manifest, entry, installationFiles, unservableFiles, cancelled: false, requiredDependencies: requiredDependencyIds(manifest), ...(styles ? { styles } : {}) });
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIPPED[entry.name] && !denied(entry.name)) await walk(join(dir, entry.name));
    }
  };
  await walk(root);
  if (!found.length) throw new PluginRefreshError("no_web_sources", "the registered root has no source web entries");
  return familyOrder(found);
}

function validateStyles(css: string, id: string): void {
  const refusal = unscopedRule(css, id);
  if (refusal) throw new PluginRefreshError("stylesheet_unscoped", `${id}: stylesheet_unscoped at line ${String(refusal.line)} (${refusal.reason}): ${refusal.selector}`);
}

interface SyntaxNode {
  readonly type: string;
  readonly start?: number;
  readonly end?: number;
  readonly [key: string]: unknown;
}
function syntaxNode(value: unknown): value is SyntaxNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
function visit(node: SyntaxNode, callback: (node: SyntaxNode) => void): void {
  callback(node);
  for (const child of Object.values(node)) {
    if (syntaxNode(child)) visit(child, callback);
    else if (Array.isArray(child)) for (const value of child) if (syntaxNode(value)) visit(value, callback);
  }
}

/** Normal builds and ordinary Vite development have an inert, empty registry. */
export function pluginDevelopment(): Plugin {
  let active = false;
  return {
    name: "manifold-plugin-development-inactive",
    configResolved(config) { active = config.command === "serve" && config.plugins.some((plugin) => plugin.name === ACTIVE_PLUGIN); },
    resolveId(id) { if (!active && id === REGISTRY) return `\0${REGISTRY}`; },
    load(id) { if (!active && id === `\0${REGISTRY}`) return "export const sources = [];"; },
  };
}

function activeDevelopment(root: string, sources: readonly Source[]): { plugin: Plugin; descriptors: Plugin; stop(): void } {
  let server: ViteDevServer | undefined;
  const watchers: FSWatcher[] = [];
  const dependencyRoots = new Map<string, Set<string>>();
  const owners = new Map<string, Set<string>>();
  const authorized = new Set<string>();
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const source of sources) {
    owners.set(source.entry, new Set([source.id]));
    authorized.add(source.entry);
    if (source.styles) {
      owners.set(source.styles, new Set([source.id]));
      authorized.add(source.styles);
    }
  }
  const cancel = (ids: Iterable<string>, reason: string): void => {
    const cancelled: string[] = [];
    for (const id of ids) {
      const source = byId.get(id);
      if (source && !source.cancelled) { source.cancelled = true; cancelled.push(id); }
    }
    if (!cancelled.length) return;
    server?.ws.send({ type: "custom", event: PLUGIN_REFRESH_CANCEL_EVENT, data: { ids: cancelled, reason } });
    server?.config.logger.warn(JSON.stringify({ event: "plugin-refresh-cancelled", plugins: cancelled, reason }));
  };
  const stop = (): void => {
    cancel(byId.keys(), "stopped");
    for (const watcher of watchers) watcher.close();
    watchers.length = 0;
  };
  const watchDirectory = (directory: string, callback: (path: string) => void, recursive: boolean): void => {
    const watcher = watch(directory, { recursive }, (_event, filename) => {
      if (filename === null) return;
      callback(resolve(directory, String(filename)));
    });
    watcher.on("error", () => cancel(byId.keys(), "watcher_failed"));
    watchers.push(watcher);
  };
  const dependency = async (path: string, ids: Set<string>): Promise<void> => {
    let directory = dirname(path);
    while (!(await Bun.file(join(directory, "package.json")).exists())) {
      const parent = dirname(directory);
      if (parent === directory) throw new PluginRefreshError("dependency_boundary", "dependency has no package metadata");
      directory = parent;
    }
    directory = await realpath(directory);
    if (denied(directory) || !inside(directory, path)) throw new PluginRefreshError("dependency_boundary", "dependency resolution crossed its package root");
    const existing = dependencyRoots.get(directory);
    if (existing) { for (const id of ids) existing.add(id); return; }
    const lease = new Set(ids);
    dependencyRoots.set(directory, lease);
    if (server && !server.config.server.fs.allow.includes(directory)) server.config.server.fs.allow.push(directory);
    watchDirectory(directory, () => cancel(lease, "installation_required"), true);
  };
  const safeResolved = async (path: string, importer: string, ids: Set<string>, bare: boolean): Promise<string> => {
    if (denied(path)) throw new PluginRefreshError("source_boundary", "secret-bearing source is denied");
    const canonical = await realpath(path);
    if (denied(canonical) || !(await stat(canonical)).isFile()) throw new PluginRefreshError("source_boundary", "source is not a regular public module");
    if (inside(root, path) && !path.split(sep).includes("node_modules")) {
      await containedFile(root, path);
      for (const id of ids) {
        if (byId.get(id)?.unservableFiles.has(canonical)) {
          throw new PluginRefreshError("installation_required", "the frontend cannot import its backend or native entry");
        }
      }
    } else {
      const importedPackage = [...dependencyRoots.keys()].find((directory) => inside(directory, importer));
      if (!bare && (!importedPackage || !inside(importedPackage, canonical))) throw new PluginRefreshError("source_boundary", "relative import escapes the registered source or dependency package");
      await dependency(canonical, ids);
    }
    const registered = owners.get(canonical) ?? new Set<string>();
    for (const id of ids) registered.add(id);
    owners.set(canonical, registered);
    authorized.add(canonical);
    server?.watcher.add(canonical);
    return canonical;
  };
  return {
    stop,
    descriptors: descriptorDevelopment(root, sources, owners),
    plugin: {
      name: ACTIVE_PLUGIN,
      apply: "serve",
      enforce: "pre",
      async config() {
        const excluded = new Set(Object.keys(SHARED_MODULES).filter((name) => name.startsWith("@manifold/")));
        for (const source of sources) {
          let directory = source.dir;
          while (!(await Bun.file(join(directory, "package.json")).exists()) && dirname(directory) !== directory) directory = dirname(directory);
          if (!(await Bun.file(join(directory, "package.json")).exists())) continue;
          const metadata: unknown = await Bun.file(join(directory, "package.json")).json();
          if (typeof metadata !== "object" || metadata === null) continue;
          for (const field of ["dependencies", "devDependencies", "peerDependencies"] as const) {
            if (!(field in metadata)) continue;
            const dependencies: unknown = (metadata as Record<string, unknown>)[field];
            if (typeof dependencies === "object" && dependencies !== null) for (const name of Object.keys(dependencies)) if (!SHARED_MODULES[name]) excluded.add(name);
          }
        }
        return {
          resolve: { dedupe: ["react", "react-dom", ...Object.keys(SHARED_MODULES)] },
          optimizeDeps: { exclude: [...excluded] },
          server: { fs: { strict: true, allow: [REPOSITORY_ROOT, root], deny: ["**/.env", "**/.env.*", "**/.git/**", "**/owner.key", "**/credentials", "**/credentials.json", "**/*.pem", "**/*.key"] } },
        };
      },
      configResolved(config) {
        config.server.host = "127.0.0.1";
        config.server.allowedHosts = [];
        config.server.hmr = { protocol: "ws", host: "127.0.0.1" };
      },
      async resolveId(id, importer) {
        if (id === REGISTRY || id === RUNTIME || id.startsWith(BRIDGE) || id.startsWith(STYLE)) return `\0${id}`;
        if (id.startsWith("\0") || id.startsWith("/@") || id.startsWith("virtual:")) return;
        const importedFrom = importer?.split("?")[0];
        const ids = importedFrom ? owners.get(importedFrom) : undefined;
        if (ids?.size && (SHARED_MODULES[id] || /^react(?:-dom)?\//.test(id))) {
          const resolved = await this.resolve(id, join(WEB_ROOT, "src/main.tsx"), { skipSelf: true });
          if (resolved && !resolved.id.startsWith("\0")) authorized.add(resolved.id.split("?")[0] ?? resolved.id);
          return resolved;
        }
        if (!ids?.size) {
          const resolved = await this.resolve(id, importer, { skipSelf: true });
          if (resolved && !resolved.external && !resolved.id.startsWith("\0")) {
            const file = resolved.id.split("?")[0] ?? resolved.id;
            if (isAbsolute(file) && inside(REPOSITORY_ROOT, file) && !inside(root, file) && !denied(file)) {
              const canonical = await realpath(file).catch(() => undefined);
              if (canonical && !denied(canonical)) { authorized.add(file); authorized.add(canonical); }
            }
          }
          return resolved;
        }
        if ([...ids].some((sourceId) => byId.get(sourceId)?.cancelled)) throw new PluginRefreshError("source_cancelled", "source lease requires an explicit restart");
        if (id.includes("\\") || id.split("/").some((part) => part === "..") && !id.startsWith(".")) throw new PluginRefreshError("source_boundary", "invalid source import path");
        const bare = !id.startsWith(".") && !isAbsolute(id);
        if (isAbsolute(id) && !authorized.has(id.split("?")[0] ?? id)) throw new PluginRefreshError("source_boundary", "arbitrary absolute source imports are denied");
        const resolved = await this.resolve(id, importer, { skipSelf: true });
        if (!resolved || resolved.external || resolved.id.startsWith("\0")) return resolved;
        const [file, query] = resolved.id.split("?", 2);
        if (!file) return resolved;
        let canonical: string;
        try { canonical = await safeResolved(file, importedFrom ?? "", ids, bare); }
        catch (error) {
          if (error instanceof PluginRefreshError && error.reason === "source_boundary") cancel(ids, "source_boundary");
          throw error;
        }
        return { ...resolved, id: query === undefined ? canonical : `${canonical}?${query}` };
      },
      async load(id) {
        if (id === `\0${REGISTRY}`) {
          return `export const sources = [${sources.map((source) => `{id:${JSON.stringify(source.id)},manifest:${JSON.stringify(source.manifest)},load:()=>import(${JSON.stringify(BRIDGE + source.id)})}`).join(",")}];`;
        }
        if (id === `\0${RUNTIME}`) return pluginRefreshRuntime;
        if (id.startsWith(`\0${BRIDGE}`)) {
          const source = byId.get(id.slice(BRIDGE.length + 1));
          if (!source) throw new PluginRefreshError("unknown_source", "unregistered source entry");
          if (source.cancelled) throw new PluginRefreshError("source_cancelled", "source lease requires an explicit restart");
          await containedFile(root, source.entry);
          return `${source.styles ? `import ${JSON.stringify(source.styles)};\n` : ""}import ${JSON.stringify(source.entry)};\nimport { sourceModule } from ${JSON.stringify(RUNTIME)};\nconst source = sourceModule(${JSON.stringify(source.id)});\nexport default source.default;\nexport const mountStyles = source.mountStyles;\nexport const subscribe = source.subscribe;`;
        }
        if (id.startsWith(`\0${STYLE}`)) {
          const ids = id.slice(STYLE.length + 1).split(",");
          if (ids.some((sourceId) => !byId.has(sourceId))) throw new PluginRefreshError("unknown_source", "unregistered stylesheet owner");
          return `import { updateStyles, removeStyles } from ${JSON.stringify(RUNTIME)};\nexport const updateStyle = (key, css) => updateStyles(${JSON.stringify(ids)}, key, css);\nexport const removeStyle = removeStyles;`;
        }
        const file = id.split("?")[0];
        if (file && owners.has(file)) {
          const ids = owners.get(file) ?? new Set<string>();
          if ([...ids].some((sourceId) => byId.get(sourceId)?.cancelled)) throw new PluginRefreshError("source_cancelled", "source lease requires an explicit restart");
          if (inside(root, file) && !file.split(sep).includes("node_modules")) {
            try { await containedFile(root, file); }
            catch (error) {
              if (error instanceof PluginRefreshError && error.reason === "source_boundary") cancel(ids, "source_boundary");
              throw error;
            }
          }
          if (file.endsWith(".css")) {
            const css = await Bun.file(file).text();
            for (const sourceId of ids) validateStyles(css, sourceId);
          }
        }
      },
      async configureServer(vite) {
        server = vite;
        watchDirectory(root, (file) => {
          if (LOCKFILES[file.slice(file.lastIndexOf(sep) + 1) ?? ""]) cancel(byId.keys(), "installation_required");
          else {
            const affected = sources.filter((source) => source.installationFiles.has(file));
            if (affected.length) cancel(new Set([...affected.map((source) => source.id), ...(owners.get(file) ?? [])]), "installation_required");
          }
        }, true);
        let packageDirectory = root;
        while (!(await Bun.file(join(packageDirectory, "package.json")).exists()) && dirname(packageDirectory) !== packageDirectory) packageDirectory = dirname(packageDirectory);
        if (packageDirectory !== root && await Bun.file(join(packageDirectory, "package.json")).exists()) watchDirectory(packageDirectory, (file) => {
          if (LOCKFILES[file.slice(file.lastIndexOf(sep) + 1) ?? ""]) cancel(byId.keys(), "installation_required");
        }, false);
        vite.middlewares.use((request, response, next) => {
          const raw = (request.url ?? "/").split("?")[0] ?? "/";
          let path = raw;
          try {
            for (let count = 0; count < 4 && path.includes("%"); count++) path = decodeURIComponent(path);
            if (path.includes("%") || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => part === ".." || part === ".") || denied(path)) throw new PluginRefreshError("source_boundary", "invalid request path");
          } catch {
            response.statusCode = 403;
            response.end("plugin-refresh: source_boundary");
            return;
          }
          const file = path.startsWith("/@fs/") ? resolve(path.slice(4)) : resolve(WEB_ROOT, `.${path}`);
          if (path.startsWith("/@fs/") || inside(root, file)) {
            void realpath(file).then((canonical) => {
              const registeredSource = inside(root, file) || inside(root, canonical);
              const allowed = authorized.has(file) && authorized.has(canonical);
              if (!allowed || denied(canonical) || registeredSource && !inside(root, canonical)) {
                if (authorized.has(file) && registeredSource && (!inside(root, canonical) || denied(canonical))) cancel(owners.get(file) ?? [], "source_boundary");
                response.statusCode = 403;
                response.end("plugin-refresh: source_boundary");
              } else if ([...(owners.get(canonical) ?? [])].some((id) => byId.get(id)?.cancelled)) {
                response.statusCode = 410;
                response.end("plugin-refresh: source_cancelled");
              } else next();
            }, () => { response.statusCode = 403; response.end("plugin-refresh: source_boundary"); });
            return;
          }
          next();
        });
        vite.httpServer?.once("close", stop);
      },
      handleHotUpdate(context) {
        const affected = sources.filter((source) => source.installationFiles.has(context.file));
        if (affected.length) { cancel(new Set([...affected.map((source) => source.id), ...(owners.get(context.file) ?? [])]), "installation_required"); return []; }
        const ids = owners.get(context.file);
        if (ids && [...ids].some((id) => byId.get(id)?.cancelled)) return [];
      },
    },
  };
}

/** Start the existing development frontend with exactly one ephemeral set of source roots. */
export async function startPluginRefresh(options: PluginRefreshOptions): Promise<PluginRefreshHandle> {
  const hub = parseHubUrl(options.hub);
  if (process.env["NODE_ENV"] === "production") throw new PluginRefreshError("production_inactive", "source mode requires a development environment; NODE_ENV=production cannot register sources");
  const port = options.port ?? 5173;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PluginRefreshError("invalid_port", "--port must be an integer from 0 through 65535");
  if (!(await Bun.file(join(WEB_ROOT, "vite.config.ts")).exists()) || !(await Bun.file(join(WEB_ROOT, "index.html")).exists())) {
    throw new PluginRefreshError("missing_checkout", "--fast-refresh requires the Manifold source checkout with packages/web and its installed Vite toolchain; standalone kits can use ordinary dev to pack/install");
  }
  const root = await realpath(resolve(options.root));
  if (denied(root) || !(await stat(root)).isDirectory()) throw new PluginRefreshError("source_boundary", "the registered source root must be a non-secret directory");
  const sources = await discoverSources(root);
  const active = activeDevelopment(root, sources);
  // The optional checkout-owned Vite toolchain must not be resolved by ordinary kit imports.
  const { createServer } = await import("vite").catch((error: unknown) => {
    throw new PluginRefreshError("missing_toolchain", `install the Manifold source checkout's Vite dependencies before --fast-refresh: ${error instanceof Error ? error.message : String(error)}`);
  });
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      root: WEB_ROOT,
      configFile: join(WEB_ROOT, "vite.config.ts"),
      mode: "development",
      plugins: [active.plugin, active.descriptors],
      server: {
        host: "127.0.0.1",
        port,
        strictPort: true,
        allowedHosts: [],
        hmr: {},
        proxy: Object.fromEntries(["/api", "/ws", "/healthz", "/auth"].map((path) => [path, { target: hub, changeOrigin: path === "/ws", ...(path === "/ws" ? { ws: true } : {}) }])),
      },
    });
    await server.listen();
  } catch (error) {
    active.stop();
    await server?.close();
    throw error;
  }
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") { active.stop(); await server.close(); throw new PluginRefreshError("not_listening", "Vite did not open a loopback listener"); }
  const url = new URL(`http://127.0.0.1:${String(address.port)}/`);
  url.searchParams.set("instance", hub);
  const lifetime = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  const running = server;
  running.httpServer?.once("error", (error) => {
    active.stop();
    lifetime.reject(error);
    void running.close().catch((cleanup: unknown) => running.config.logger.error(`plugin-refresh: cleanup failed: ${String(cleanup)}`));
  });
  running.httpServer?.once("close", () => {
    if (!closing) {
      lifetime.reject(new PluginRefreshError("server_closed", "the development listener closed unexpectedly"));
      void running.close().catch((error: unknown) => running.config.logger.error(`plugin-refresh: cleanup failed: ${String(error)}`));
    }
  });
  return {
    url: url.href,
    hub,
    plugins: sources.map((source) => source.id),
    sources: sources.map((source) => ({ id: source.id, manifest: source.manifest })),
    closed: lifetime.promise,
    close() {
      if (!closing) closing = (async () => {
        try { active.stop(); await running.close(); lifetime.resolve(); }
        catch (error) { lifetime.reject(error); throw error; }
      })();
      return closing;
    },
  };
}

function descriptorDevelopment(root: string, sources: readonly Source[], owners: ReadonlyMap<string, Set<string>>): Plugin {
  const entries = new Map(sources.map((source) => [source.entry, source]));
  return {
    name: "manifold-plugin-development-descriptors",
    apply: "serve",
    enforce: "post",
    async transform(code, id) {
      const file = id.split("?")[0] ?? id;
      const source = entries.get(file);
      const styleOwners = file.endsWith(".css") ? owners.get(file) : undefined;
      if (!source && !styleOwners?.size) return;
      const edits: { start: number; end: number; text: string }[] = [];
      const syntax = this.parse(code) as unknown as SyntaxNode;
      if (styleOwners?.size) {
        for (const owner of styleOwners) validateStyles(await Bun.file(file).text(), owner);
        visit(syntax, (node) => {
          if (node.type !== "ImportDeclaration" || !syntaxNode(node.source) || node.source.value !== "/@vite/client") return;
          if (typeof node.source.start === "number" && typeof node.source.end === "number") edits.push({ start: node.source.start, end: node.source.end, text: JSON.stringify(STYLE + [...styleOwners].sort().join(",")) });
        });
      } else if (source) {
        await containedFile(root, file);
        let definition = false;
        visit(syntax, (node) => {
          if (node.type === "ExportDefaultDeclaration" && syntaxNode(node.declaration) && typeof node.start === "number" && typeof node.end === "number" && typeof node.declaration.start === "number" && typeof node.declaration.end === "number") {
            const declaration = node.declaration;
            const expression = code.slice(declaration.start, declaration.end);
            const named = (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && syntaxNode(declaration.id) && typeof declaration.id.name === "string" ? declaration.id.name : undefined;
            edits.push({ start: node.start, end: node.end, text: named ? `${expression}\nconst __manifoldDefinition = ${named};\nexport default __manifoldDefinition;` : `const __manifoldDefinition = (${expression});\nexport default __manifoldDefinition;` });
            definition = true;
          }
          if (node.type === "CallExpression" && syntaxNode(node.callee) && node.callee.type === "MemberExpression" && syntaxNode(node.callee.property) && node.callee.property.name === "validateRefreshBoundaryAndEnqueueUpdate" && syntaxNode(node.callee.object) && typeof node.callee.start === "number" && typeof node.callee.end === "number" && typeof node.callee.object.start === "number" && typeof node.callee.object.end === "number") {
            const runtime = code.slice(node.callee.object.start, node.callee.object.end);
            edits.push({ start: node.callee.start, end: node.callee.end, text: `((filename, before, after) => __manifoldAccept(${runtime}, ${JSON.stringify(file)}, before, after))` });
          }
        });
        if (!definition) throw new PluginRefreshError("missing_definition", `${source.id}: source entry must export its definition as default`);
        edits.push({ start: code.length, end: code.length, text: `\nimport { publish as __manifoldPublish, registerEntry as __manifoldRegister, acceptDescriptor as __manifoldAccept, acceptEntry as __manifoldAcceptEntry } from ${JSON.stringify(RUNTIME)};\n__manifoldRegister(${JSON.stringify(file)}, ${JSON.stringify(source.id)});\n__manifoldPublish(${JSON.stringify(source.id)}, __manifoldDefinition);\nif (import.meta.hot) import.meta.hot.accept((module) => __manifoldAcceptEntry(${JSON.stringify(file)}, ${JSON.stringify(source.id)}, module));\n` });
      } else return;
      if (!edits.length) return;
      for (const edit of edits.sort((left, right) => right.start - left.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
      return { code, map: null };
    },
  };
}
