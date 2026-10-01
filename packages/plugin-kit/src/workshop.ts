import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  ISOLATE_MAX_FRAME_BYTES,
  IsolateChildFrameSchema,
  PLUGIN_BUNDLE_SERVER_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
  machineArtifacts,
} from "@manifold/protocol";
import type { IsolateChildFrame, PluginBundle, PluginManifest } from "@manifold/protocol";
import { devCycle, discoverPlugins } from "./dev.ts";
import { roster } from "./hub.ts";
import type { Hub } from "./hub.ts";
import { BundleOrderError, familyOrder, requiredDependencyIds } from "./install.ts";
import type { Delivery } from "./install.ts";
import type { PackResult } from "./pack.ts";
import { discoverSources, sourcePackageRoot, startPluginRefresh } from "./refresh.ts";
import type { PluginRefreshHandle } from "./refresh.ts";
import { PluginRefreshError } from "./refresh-options.ts";

export interface PluginWorkshopOptions {
  readonly root: string;
  readonly hub: Hub;
  readonly deliver?: Delivery;
  readonly build?: (outputDir: string) => Promise<readonly PackResult[]>;
  /** Zero asks the OS for a port. The listener always binds loopback. */
  readonly port?: number;
}

const SKIPPED: Record<string, true> = { node_modules: true, dist: true, ".git": true };
const CONFIGURATION: Record<string, true> = {
  "package.json": true,
  "bun.lock": true,
  "bun.lockb": true,
  "package-lock.json": true,
  "pnpm-lock.yaml": true,
  "yarn.lock": true,
  "bunfig.toml": true,
  "tsconfig.json": true,
};

function configuration(name: string): boolean {
  return CONFIGURATION[name] === true || /^tsconfig(?:[.-].*)?\.json$/.test(name);
}
const DEBOUNCE_MS = 250;
const PREPARE_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 60_000;

interface WorkshopPlugin {
  readonly dir: string;
  readonly manifest: PluginManifest;
}
interface BackendGraph {
  readonly local: Set<string>;
  readonly packages: Set<string>;
}

function inside(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === "" || (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
  );
}

function installationRequired(message: string): PluginRefreshError {
  return new PluginRefreshError(
    "installation_required",
    `${message}; stop the workshop and use explicit pack/verify/install review`,
  );
}

/** Bootstrap trusts only compiler-owned bytes, never its reported family metadata. */
async function compiledManifests(
  outputDir: string,
  results: readonly PackResult[],
): Promise<PluginManifest[]> {
  const ownedRoot = await realpath(outputDir);
  const manifests = await Promise.all(
    results.map(async (packed) => {
      const file = resolve(packed.file);
      const canonical = await realpath(file);
      const info = await lstat(file);
      if (!inside(ownedRoot, canonical) || !info.isFile() || info.isSymbolicLink())
        throw installationRequired("compiler returned a bundle outside its owned output directory");
      const bytes = await Bun.file(canonical).arrayBuffer();
      const bundle = PluginBundleSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      if (sha256 !== packed.sha256)
        throw installationRequired("compiler summary does not match its actual bundle bytes");
      return {
        id: bundle.manifest.id,
        requiredDependencies: requiredDependencyIds(bundle.manifest),
        manifest: bundle.manifest,
      };
    }),
  );
  if (!manifests.length) throw installationRequired("compiler returned no authored plugin family");
  try {
    return familyOrder(manifests).map(({ manifest }) => manifest);
  } catch (error) {
    if (error instanceof BundleOrderError) throw installationRequired(error.message);
    throw error;
  }
}

/** Foreign generated manifests are not sources; only an exact compiled manifest selects a directory. */
async function compiledSources(
  root: string,
  manifests: readonly PluginManifest[],
): Promise<WorkshopPlugin[]> {
  const expected = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const matches = new Map<string, WorkshopPlugin[]>();
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
      const candidate: unknown = await Bun.file(join(dir, "manifest.json")).json();
      if (
        typeof candidate === "object" &&
        candidate !== null &&
        "id" in candidate &&
        typeof candidate.id === "string" &&
        expected.has(candidate.id)
      ) {
        const manifest = PluginManifestSchema.parse(candidate);
        if (isDeepStrictEqual(manifest, expected.get(manifest.id))) {
          const canonical = await realpath(dir);
          if (!inside(root, canonical))
            throw installationRequired("selected source directory escapes the author root");
          const found = matches.get(manifest.id) ?? [];
          found.push({ dir: canonical, manifest });
          matches.set(manifest.id, found);
        }
      }
    }
    for (const entry of entries)
      if (entry.isDirectory() && !SKIPPED[entry.name]) await walk(join(dir, entry.name));
  };
  await walk(root);
  return manifests.map(({ id }) => {
    const found = matches.get(id);
    if (found?.length !== 1)
      throw installationRequired(
        `${id}: compiler family requires exactly one matching source manifest`,
      );
    return found[0]!;
  });
}

/** Observe the compiler's resolved file loads, including aliases, JSON and shared modules. */
async function backendGraph(
  root: string,
  plugins: readonly WorkshopPlugin[],
): Promise<BackendGraph> {
  const entries = plugins
    .filter(({ manifest }) => manifest.entry?.server)
    .map(({ dir }) => join(dir, "server.ts"));
  const authorPackages = new Set<string | undefined>(
    await Promise.all([root, ...plugins.map(({ dir }) => dir)].map(sourcePackageRoot)),
  );
  const files = new Set<string>();
  for (const entry of entries) {
    const built = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      minify: { whitespace: true },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "manifold-workshop-server-inputs",
          setup(builder) {
            builder.onLoad({ filter: /.*/, namespace: "file" }, ({ path }) => {
              files.add(path);
              return undefined;
            });
          },
        },
      ],
    });
    if (!built.success)
      throw new Error(
        `server graph compilation failed: ${built.logs.map((log) => log.message).join("; ")}`,
      );
  }
  const local = new Set<string>();
  const packages = new Set<string>();
  for (const file of files) {
    const canonical = await realpath(file);
    const directory = await sourcePackageRoot(dirname(canonical));
    if (
      inside(root, canonical) &&
      !relative(root, canonical).split(sep).includes("node_modules") &&
      authorPackages.has(directory)
    ) {
      local.add(canonical);
    } else {
      if (directory === undefined)
        throw installationRequired("server graph escapes a declared package root");
      packages.add(directory);
    }
  }
  return { local, packages };
}

async function fingerprint(path: string): Promise<string> {
  try {
    // realpath is part of the pin: a replaced symlink cannot silently move a dependency.
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) return "not-file";
    return `${canonical}:${new Bun.CryptoHasher("sha256").update(await Bun.file(canonical).arrayBuffer()).digest("hex")}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function pins(paths: Iterable<string>): Promise<Map<string, string>> {
  const values = await Promise.all(
    [...paths].map(async (path) => [path, await fingerprint(path)] as const),
  );
  return new Map(values);
}

/** Manifest/dependency/compiler configuration and native bytes are never a save-to-install input. */
async function authorityPins(
  root: string,
  plugins: readonly WorkshopPlugin[],
  selected = false,
): Promise<Map<string, string>> {
  const paths = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED[entry.name]) await walk(path);
      else if (entry.name === "manifest.json" || configuration(entry.name)) paths.add(path);
    }
  };
  if (!selected) await walk(root);
  for (const start of selected ? plugins.map(({ dir }) => dir) : [root]) {
    let directory = start;
    while (true) {
      for (const name of Object.keys(CONFIGURATION)) paths.add(join(directory, name));
      for (const entry of await readdir(directory, { withFileTypes: true }))
        if (!entry.isDirectory() && configuration(entry.name))
          paths.add(join(directory, entry.name));
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const { dir, manifest } of plugins) {
    paths.add(join(dir, "manifest.json"));
    for (const artifact of machineArtifacts(manifest.machine)) {
      if (artifact.bundleFile) paths.add(join(dir, artifact.bundleFile));
    }
  }
  return pins(paths);
}

/** Run only the existing guest load handshake, with no host calls or lifecycle hooks. */
async function preparedAuthority(
  bundle: PluginBundle,
  directory: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (!bundle.manifest.entry?.server) return { actions: [] };
  const entry = join(directory, `${bundle.manifest.id}.server.js`);
  await Bun.write(entry, Buffer.from(bundle.files[PLUGIN_BUNDLE_SERVER_FILE] ?? "", "base64"));
  signal.throwIfAborted();
  // Never inherit the workshop's owner key, terminal binding or other instance credentials.
  const child = Bun.spawn([process.execPath, "--smol", entry], {
    cwd: directory,
    stdio: ["ignore", "ignore", "ignore", "socket-fd"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      MANIFOLD_PLUGIN_ID: bundle.manifest.id,
      MANIFOLD_PLUGIN_PIPE_FD: "3",
    },
  });
  let socket: Socket | undefined;
  const loaded = Promise.withResolvers<Extract<IsolateChildFrame, { t: "loaded" }>>();
  const fail = (message: string): void => loaded.reject(new Error(message));
  const abort = (): void => fail("workshop stopped during server preparation");
  const timer = setTimeout(() => fail("server preparation timed out"), PREPARE_TIMEOUT_MS);
  signal.addEventListener("abort", abort, { once: true });
  try {
    const descriptor = child.stdio[3];
    if (typeof descriptor !== "number") throw new Error("server preparation has no frame socket");
    const connectDescriptor = connect as unknown as (options: { readonly fd: number }) => Socket;
    socket = connectDescriptor({ fd: descriptor });
    socket.setEncoding("utf8");
    let carry = "";
    socket.on("error", () => fail("server preparation frame socket failed"));
    socket.on("end", () => fail("server preparation ended before load"));
    socket.on("data", (chunk: string) => {
      carry += chunk;
      if (Buffer.byteLength(carry) > ISOLATE_MAX_FRAME_BYTES) {
        fail("server preparation frame exceeds its byte bound");
        socket?.destroy();
        return;
      }
      let newline: number;
      while ((newline = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        try {
          const frame = IsolateChildFrameSchema.parse(JSON.parse(line));
          if (frame.t === "loaded") loaded.resolve(frame);
          else if (frame.t === "load_failed") fail(`server preparation failed: ${frame.error}`);
          else if (frame.t !== "received") fail("server preparation attempted a host operation");
        } catch {
          fail("server preparation returned an invalid frame");
        }
      }
    });
    socket.write(
      `${JSON.stringify({ receipt: randomUUID(), frame: { t: "load", pluginId: bundle.manifest.id, manifest: bundle.manifest, dir: directory, hardenedContract: bundle.hardenedContract } })}\n`,
    );
    void child.exited.then(() => fail("server preparation process exited before load"));
    const frame = await loaded.promise;
    return {
      actions: frame.actions,
      hooks: frame.hooks,
      migrations: frame.migrations,
      harness: frame.harness,
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    socket?.destroy();
    child.kill("SIGKILL");
    await child.exited;
    await rm(entry, { force: true });
  }
}

/**
 * Installation-authorized source development against an existing hub. This promise returns
 * only after SIGINT/SIGTERM and owned-resource cleanup; startup and cleanup failures reject.
 * Frontend readiness is a listening source transport, never browser or installed-row admission.
 */
export async function devWorkshop(options: PluginWorkshopOptions): Promise<void> {
  if (process.env.NODE_ENV === "production")
    throw new PluginRefreshError(
      "production_inactive",
      "workshop requires a development environment",
    );
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new PluginRefreshError("invalid_port", "--port must be an integer from 0 through 65535");
  const root = await realpath(resolve(options.root));
  let plugins: WorkshopPlugin[] = [];
  let graph: BackendGraph = { local: new Set(), packages: new Set() };
  let baseline = new Map<string, string>();
  let sourceDirectories: readonly string[] | undefined;
  const packDir = await mkdtemp(join(tmpdir(), "manifold-workshop-"));
  const stopped = new AbortController();
  const end = Promise.withResolvers<void>();
  void end.promise.catch(() => {});
  const watchers: FSWatcher[] = [];
  const watchedPackages = new Set<string>();
  const authority = new Map<string, unknown>();
  const bundleShape = new Map<string, unknown>();
  const last = new Map<string, string>();
  let frontend: PluginRefreshHandle | undefined;
  let port = options.port ?? 7913;
  let timer: Timer | undefined;
  let pending = false;
  let generation = 0;
  let invalidated = false;
  let backendDirty = false;
  let building = false;
  let activeBuild: Promise<void> | undefined;
  let failure: unknown;
  let running = Promise.resolve();
  let cycle = 0;
  const stop = (): void => {
    if (stopped.signal.aborted) return;
    stopped.abort();
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    end.resolve();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const fail = (error: unknown): void => {
    failure = error;
    end.reject(error);
    stop();
  };
  const authorBuild = options.build;
  const build =
    authorBuild === undefined
      ? undefined
      : async (outputDir: string): Promise<readonly PackResult[]> => {
          stopped.signal.throwIfAborted();
          building = true;
          const compilation = Promise.resolve().then(() => authorBuild(outputDir));
          const interrupted = Promise.withResolvers<never>();
          const abort = (): void =>
            interrupted.reject(new Error("workshop stopped during author compilation"));
          const deadline = setTimeout(() => {
            const error = new Error("author compilation timed out after 60 seconds");
            fail(error);
            interrupted.reject(error);
          }, BUILD_TIMEOUT_MS);
          stopped.signal.addEventListener("abort", abort, { once: true });
          activeBuild = compilation
            .then(
              () => {},
              () => {},
            )
            .then(async () => {
              building = false;
              // An arbitrary author callback cannot be preempted; prevent its late output from leaking.
              if (stopped.signal.aborted) await rm(outputDir, { recursive: true, force: true });
            });
          void activeBuild.catch((error: unknown) => {
            console.error(
              JSON.stringify({
                event: "plugin-workshop-late-build",
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          });
          try {
            const results = await Promise.race([compilation, interrupted.promise]);
            await compiledManifests(outputDir, results);
            stopped.signal.throwIfAborted();
            return results;
          } finally {
            clearTimeout(deadline);
            stopped.signal.removeEventListener("abort", abort);
          }
        };

  const watchDirectory = (
    directory: string,
    recursive: boolean,
    changed: (path: string) => void,
  ): void => {
    const watcher = watch(directory, { recursive }, (_event, name) => {
      if (name !== null) changed(resolve(directory, String(name)));
    });
    watcher.on("error", fail);
    watchers.push(watcher);
  };
  const refuse = (): void => {
    if (invalidated || stopped.signal.aborted) return;
    invalidated = true;
    generation++;
    console.error(
      JSON.stringify({
        event: "plugin-workshop-refused",
        reason: "installation_required",
        message:
          "manifest, dependency, native or authority declarations changed; stop and explicitly pack/verify/install before restarting",
      }),
    );
    void frontend?.close().catch(fail);
  };
  const watchPackages = (packages: ReadonlySet<string>): void => {
    for (const directory of packages) {
      if (watchedPackages.has(directory)) continue;
      watchedPackages.add(directory);
      watchDirectory(directory, true, refuse);
    }
  };
  const launchFrontend = async (): Promise<void> => {
    if (stopped.signal.aborted || invalidated) return;
    await frontend?.close();
    frontend = await startPluginRefresh({
      root,
      hub: options.hub.url,
      port,
      backendInputs: graph.local,
      ...(sourceDirectories === undefined ? {} : { sourceDirectories }),
      onDependencyChange: refuse,
    });
    if (stopped.signal.aborted || invalidated) {
      await frontend.close();
      return;
    }
    port = Number(new URL(frontend.url).port);
    void frontend.closed.catch(fail);
    console.log(
      JSON.stringify({
        event: "plugin-workshop-ready",
        mode: "frontend-and-backend",
        url: frontend.url,
        hub: frontend.hub,
        plugins: frontend.plugins,
        state: "listening",
        admission: "ordinary browser sign-in and matching enabled installed in-realm row required",
      }),
    );
  };
  const runCycle = async (): Promise<void> => {
    stopped.signal.throwIfAborted();
    if (invalidated) return;
    if (
      !isDeepStrictEqual(
        baseline,
        await authorityPins(root, plugins, sourceDirectories !== undefined),
      )
    ) {
      refuse();
      return;
    }
    graph = await backendGraph(root, plugins);
    watchPackages(graph.packages);
    const startGeneration = generation;
    const inputs = await pins(graph.local);
    const rows = await roster(options.hub);
    const installation = rows
      .find(({ manifest }) => manifest.id === "engine.plugins")
      ?.actions.find(({ name }) => name === "engine.plugins.install");
    const properties = installation?.input["properties"];
    if (
      typeof properties !== "object" ||
      properties === null ||
      !("retainInstallation" in properties)
    )
      throw new PluginRefreshError(
        "installation_api_unavailable",
        "the hub must advertise engine.plugins.install retainInstallation before starting a workshop; source-only --fast-refresh remains available without installation authority",
      );
    const report = await devCycle(
      {
        ...options,
        root,
        packDir,
        ...(build === undefined ? {} : { build }),
        signal: stopped.signal,
        preserveGrant: true,
        beforeInstall: async (bundles) => {
          const expectedIds = new Set(plugins.map(({ manifest }) => manifest.id));
          if (bundles.length !== expectedIds.size || bundles.some(({ id }) => !expectedIds.has(id)))
            throw installationRequired("compiler changed the plugin family");
          if (sourceDirectories !== undefined) {
            const selected = await compiledSources(
              root,
              plugins.map(({ manifest }) => manifest),
            );
            if (
              !isDeepStrictEqual(
                sourceDirectories,
                selected.map(({ dir }) => dir),
              )
            )
              throw installationRequired("compiler family source directories changed");
            await discoverSources(root, graph.local, sourceDirectories);
          }
          for (const packed of bundles) {
            const bundle = PluginBundleSchema.parse(await Bun.file(packed.file).json());
            const plugin = plugins.find(({ manifest }) => manifest.id === packed.id)!;
            const row = rows.find(({ manifest }) => manifest.id === packed.id);
            if (
              !row?.install ||
              row.enabled !== true ||
              row.held !== undefined ||
              row.install.mode === "unpacked" ||
              row.install.refusal !== undefined ||
              row.lifecycle === "enable_failed" ||
              row.lifecycle === "isolate_starting" ||
              row.lifecycle === "isolate_crashed" ||
              row.hardened === true ||
              row.install.hardened === true ||
              !isDeepStrictEqual(row.manifest, plugin.manifest) ||
              !isDeepStrictEqual(bundle.manifest, plugin.manifest)
            )
              throw installationRequired(
                `${packed.id}: workshop requires an existing enabled matching bundled in-realm installation`,
              );
            const native: Record<string, string | undefined> = {};
            for (const artifact of machineArtifacts(bundle.manifest.machine)) {
              if (!artifact.bundleFile) continue;
              const bytes = Buffer.from(
                await Bun.file(join(plugin.dir, artifact.bundleFile)).arrayBuffer(),
              ).toString("base64");
              if (bundle.files[artifact.bundleFile] !== bytes)
                throw installationRequired(`${packed.id}: compiler changed a native member`);
              native[artifact.bundleFile] = bytes;
            }
            const shape = { manifest: bundle.manifest, builtAgainst: bundle.builtAgainst, native };
            if (
              !isDeepStrictEqual(row.install.builtAgainst, bundle.builtAgainst) ||
              (bundleShape.has(packed.id) && !isDeepStrictEqual(bundleShape.get(packed.id), shape))
            )
              throw installationRequired(`${packed.id}: compiled dependency/native shape changed`);
            const prepared = await preparedAuthority(bundle, packDir, stopped.signal);
            const actions =
              typeof prepared === "object" && prepared !== null && "actions" in prepared
                ? prepared.actions
                : undefined;
            if (
              !isDeepStrictEqual(row.actions, actions) ||
              (authority.has(packed.id) && !isDeepStrictEqual(authority.get(packed.id), prepared))
            )
              throw installationRequired(
                `${packed.id}: server action or lifecycle declarations changed`,
              );
            authority.set(packed.id, prepared);
            bundleShape.set(packed.id, shape);
          }
          if (
            invalidated ||
            !isDeepStrictEqual(
              baseline,
              await authorityPins(root, plugins, sourceDirectories !== undefined),
            )
          )
            throw installationRequired("installation inputs changed during compilation");
          if (generation !== startGeneration || !isDeepStrictEqual(inputs, await pins(graph.local)))
            throw new Error("server inputs changed during compilation; queued save will rebuild");
          stopped.signal.throwIfAborted();
        },
      },
      last,
      ++cycle,
    );
    console.log(JSON.stringify({ event: "plugin-workshop-cycle", ...report }));
    await launchFrontend();
    // Installation may have awaited a hook while another save queued the next generation.
    if (generation === startGeneration) backendDirty = false;
  };
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending || invalidated || stopped.signal.aborted) return;
      pending = true;
      running = running.then(async () => {
        pending = false;
        if (stopped.signal.aborted || invalidated) return;
        try {
          await runCycle();
        } catch (error) {
          if (stopped.signal.aborted) return;
          if (error instanceof PluginRefreshError && error.reason === "installation_required")
            refuse();
          else
            console.error(
              JSON.stringify({
                event: "plugin-workshop-cycle-failed",
                cycle,
                message: error instanceof Error ? error.message : String(error),
                backend: "previous installation retained when compilation failed",
              }),
            );
        }
      });
    }, DEBOUNCE_MS);
  };
  let terminalError: unknown;
  let compilerCleanupError: unknown;
  try {
    if (build) {
      const bootstrapDir = join(packDir, "bootstrap");
      await mkdir(bootstrapDir);
      const results = await build(bootstrapDir);
      plugins = await compiledSources(root, await compiledManifests(bootstrapDir, results));
      sourceDirectories = plugins.map(({ dir }) => dir);
      await rm(bootstrapDir, { recursive: true, force: true });
    } else {
      plugins = await Promise.all(
        (await discoverPlugins(root)).map(async ({ dir }) => ({
          dir,
          manifest: PluginManifestSchema.parse(await Bun.file(join(dir, "manifest.json")).json()),
        })),
      );
    }
    stopped.signal.throwIfAborted();
    graph = await backendGraph(root, plugins);
    // Validate the selected graph/style boundary before obtaining installation effects.
    await discoverSources(root, graph.local, sourceDirectories);
    baseline = await authorityPins(root, plugins, sourceDirectories !== undefined);
    watchDirectory(root, true, (path) => {
      if (
        relative(root, path)
          .split(sep)
          .some((part) => SKIPPED[part])
      )
        return;
      if (
        (sourceDirectories === undefined && basename(path) === "manifest.json") ||
        configuration(basename(path)) ||
        baseline.has(path)
      ) {
        refuse();
        return;
      }
      if (graph.local.has(path)) {
        backendDirty = true;
        generation++;
        schedule();
      } else if (backendDirty) {
        generation++;
        schedule();
      }
    });
    let directory = dirname(root);
    while (true) {
      watchDirectory(directory, false, (path) => {
        if (configuration(basename(path))) refuse();
      });
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    watchPackages(graph.packages);
    // Unlike ordinary dev, startup cannot sit forever retrying while claiming readiness.
    running = runCycle();
    await running;
    if (invalidated) throw installationRequired("workshop startup invalidated");
    await end.promise;
  } catch (error) {
    if (failure !== undefined) terminalError = failure;
    else if (!stopped.signal.aborted || error instanceof PluginRefreshError) terminalError = error;
  } finally {
    stop();
    try {
      await running;
    } catch {
      /* The cycle's failure was already reported by its owner. */
    }
    if (building && activeBuild) {
      let deadline: Timer | undefined;
      try {
        await Promise.race([
          activeBuild,
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 5000);
          }),
        ]);
      } catch (error) {
        compilerCleanupError = error;
      } finally {
        clearTimeout(deadline);
      }
    }
    try {
      await frontend?.close();
    } finally {
      await rm(packDir, { recursive: true, force: true });
      // A repeated interrupt must not bypass cleanup of the workshop's owned resources.
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (compilerCleanupError !== undefined) throw compilerCleanupError;
  if (building)
    throw new Error(
      "workshop author compiler is still running; owned frontend/watchers/temp directory closed, late compiler cleanup is unconfirmed",
    );
  console.log(JSON.stringify({ event: "plugin-workshop-stopped", cleanup: "complete" }));
  if (terminalError !== undefined) throw terminalError;
}
