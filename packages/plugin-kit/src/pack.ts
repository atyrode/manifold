#!/usr/bin/env bun
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildArtifact, BuildOutput, BunPlugin } from "bun";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { verifyBundledArtifacts } from "./artifacts.ts";
import {
  HARDENED_CONTRACT_VERSION,
  ISOLATE_MAX_ARTIFACT_BYTES,
  MAX_PLUGIN_CHANGELOG_BYTES,
  PLUGIN_BUNDLE_FORMAT,
  PLUGIN_BUNDLE_SERVER_FILE,
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  PLUGIN_BUNDLE_STYLES_FILE,
  PROTOCOL_VERSION,
  PluginBundleSchema,
  PluginManifestSchema,
  PluginBundleFileSchema,
  machineArtifacts,
  type PluginBundle,
  type PluginManifest,
} from "@manifold/protocol";

/**
 * The author's release notes, carried as a flat member when `CHANGELOG.md` sits beside the
 * manifest, so an update review reads the candidate's own words without another fetch.
 */
export const PLUGIN_BUNDLE_CHANGELOG_FILE = "CHANGELOG.md";
/**
 * The `builtAgainst` key every pack stamps with the wire revision it was compiled against. The
 * `manifold:` prefix cannot collide with a package name, which is what the other keys are.
 */
export const BUILT_AGAINST_PROTOCOL = "manifold:protocol";

/** Packing changes linkage, not trust: only the installer chooses `install.hardened`. */
export interface PackOptions {
  /** Resolve browser floor imports through the host registry; server processes stay self-contained. */
  readonly shared?: boolean;
}

export interface CompileOptions extends PackOptions {
  /** Trusted build-time adapters and flat resources for a self-contained server half. */
  readonly serverBuild?: {
    readonly plugins?: readonly BunPlugin[];
    readonly external?: readonly string[];
    readonly files?: ReadonlyMap<string, Uint8Array>;
  } | undefined;
  /** Replace root manifest imports and supply every declared bundled machine member in memory. */
  readonly generated?: {
    readonly manifest: PluginManifest;
    readonly members: ReadonlyMap<string, Uint8Array>;
  };
  /**
   * Compile registered source instead of a manifest directory: `manifest` is the bundle's
   * manifest as given (no `manifest.json` is read), `server` names the module that starts the
   * server guest and `web` the module whose default export is the web definition. Paths
   * resolve against `pluginDir` unless absolute; each is required exactly when the manifest's
   * entry declares its half. Everything else — members, stamps, bounds, verification — is
   * the one compilation below.
   */
  readonly source?: {
    readonly manifest: PluginManifest;
    readonly server?: string | undefined;
    readonly web?: string | undefined;
  };
}

export interface CompiledPlugin {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface PackResult {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

const SHARED: Record<string, true> = {
  react: true,
  "react-dom": true,
  "react/jsx-runtime": true,
  "react/jsx-dev-runtime": true,
  "@manifold/plugin": true,
  "@manifold/plugin/hooks": true,
  "@manifold/plugin/ui": true,
  "@manifold/ui": true,
  "@manifold/protocol": true,
  "@manifold/sdk": true,
  "@manifold/scene": true,
};
async function sharedModules(
  pluginDir: string,
  builtAgainst: Record<string, string>,
): Promise<BunPlugin> {
  const namespaces: Record<string, string> = {};
  const floorDir = fileURLToPath(new URL("../../plugin/", import.meta.url));
  const release = (await Bun.file(new URL("../../web/package.json", import.meta.url)).json()) as {
    version: string;
  };
  // Inventory before the consuming build: nested Bun.build calls inside onLoad deadlock.
  for (const path of Object.keys(SHARED)) {
    let entry: string;
    try {
      entry = Bun.resolveSync(path, pluginDir);
    } catch {
      entry = Bun.resolveSync(path, floorDir);
    }
    let packageDir = dirname(entry);
    while (!(await Bun.file(join(packageDir, "package.json")).exists())) {
      const parent = dirname(packageDir);
      if (parent === packageDir) throw new Error(`No package metadata for ${path}`);
      packageDir = parent;
    }
    const metadata = (await Bun.file(join(packageDir, "package.json")).json()) as {
      name: string;
      version?: string;
    };
    builtAgainst[metadata.name] = metadata.version ?? release.version;
    let names: string[];
    if (path === "react" || path.startsWith("react/") || path === "react-dom") {
      // The author may resolve a different installed React version, so this path is runtime-selected.
      names = Object.keys(await import(entry));
    } else {
      // Resolve export-star chains and erase type-only exports without executing browser floor
      // modules: they can own CSS or browser-only module initialization.
      const probe = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm" });
      if (!probe.success)
        throw new Error(`Cannot discover ${path} exports: ${probe.logs.join("; ")}`);
      const js = probe.outputs.find((output) => output.kind === "entry-point");
      if (js === undefined) throw new Error(`No export inventory for ${path}`);
      names = new Bun.Transpiler({ loader: "js" }).scan(await js.text()).exports;
    }
    namespaces[path] =
      `const shared = globalThis[Symbol.for("manifold.shared")];\n` +
      `if (!shared || !shared[${JSON.stringify(path)}]) throw new Error(${JSON.stringify(`Missing shared module: ${path}`)});\n` +
      names
        .map(
          (name, index) =>
            `const e${index} = shared[${JSON.stringify(path)}][${JSON.stringify(name)}]; export { e${index} as ${JSON.stringify(name)} };`,
        )
        .join("\n");
  }
  return {
    name: "manifold-shared",
    setup(builder) {
      builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/.*)?|@manifold\/.*)$/ }, ({ path }) => {
        if (SHARED[path]) return { path, namespace: "manifold-shared" };
        return undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: "manifold-shared" }, ({ path }) => {
        const contents = namespaces[path];
        if (contents === undefined) throw new Error(`No shared export inventory for ${path}`);
        return { contents, loader: "js" };
      });
    },
  };
}

/** Where the kit's own React, reconciler and frame barrel resolve from. */
const KIT_SOURCE = fileURLToPath(new URL(".", import.meta.url));
const WEB_GUEST = fileURLToPath(new URL("./web-guest.ts", import.meta.url));
const WORKER_ENTRY = "manifold:web-worker";

/**
 * THE PORTABLE WORKER'S LINKAGE (ADR 0053 §1): one self-contained module with exactly one
 * React — the kit's, which its reconciler pairs with — shared by the author's components, the
 * frame barrel and the portable hooks. `@manifold/ui` is its frame barrel and
 * `@manifold/plugin/hooks` its portable entry; the page's engine, its DOM layer and React DOM
 * are refused by name, because a Worker has no document to give them. A side-effect stylesheet
 * import compiles to nothing: frames are painted by the host's own vocabulary skin. The entry
 * is generated: it imports the author's default export and starts the guest runtime on it.
 */
function portableModules(pluginDir: string, webSource: string): BunPlugin {
  const fromPlugin = (specifier: string): string => {
    try {
      return Bun.resolveSync(specifier, pluginDir);
    } catch {
      return Bun.resolveSync(specifier, KIT_SOURCE);
    }
  };
  return {
    name: "manifold-portable-worker",
    setup(builder) {
      builder.onResolve({ filter: /^manifold:web-worker$/ }, () => ({
        path: WORKER_ENTRY,
        namespace: "manifold-worker",
      }));
      builder.onLoad({ filter: /.*/, namespace: "manifold-worker" }, () => ({
        contents:
          `import definition from ${JSON.stringify(webSource)};\n` +
          `import { startWebWorker } from ${JSON.stringify(WEB_GUEST)};\n` +
          `startWebWorker(definition);\n`,
        loader: "js",
      }));
      builder.onResolve({ filter: /^react(?:-dom|-reconciler)?(?:\/.*)?$/ }, ({ path }) => {
        if (path === "react-dom" || path.startsWith("react-dom/")) {
          throw new Error(`a portable Worker cannot import ${path}: it has no document`);
        }
        return { path: Bun.resolveSync(path, KIT_SOURCE) };
      });
      builder.onResolve({ filter: /^@manifold\/(?:ui|plugin)(?:\/.*)?$/ }, ({ path }) => {
        switch (path) {
          case "@manifold/ui":
          case "@manifold/ui/frames":
            return { path: Bun.resolveSync("@manifold/ui/frames", KIT_SOURCE) };
          case "@manifold/plugin/action":
            return { path: fromPlugin("@manifold/plugin/action") };
          case "@manifold/plugin/hooks":
          case "@manifold/plugin/portable-hooks":
            return { path: fromPlugin("@manifold/plugin/portable-hooks") };
          default:
            throw new Error(
              `a portable Worker cannot import ${path}: it is the page's own layer (import engine types with \`import type\`)`,
            );
        }
      });
      builder.onResolve({ filter: /\.css$/ }, ({ path }) => ({
        path,
        namespace: "manifold-no-document",
      }));
      builder.onLoad({ filter: /.*/, namespace: "manifold-no-document" }, () => ({
        contents: "",
        loader: "js",
      }));
    },
  };
}

async function build(
  entrypoint: string,
  target: "bun" | "browser",
  plugins: BunPlugin[],
  onlyEntry = false,
  external: string[] = [],
): Promise<readonly BuildArtifact[]> {
  let result: BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [entrypoint],
      target,
      format: "esm",
      // Bun's readable output embeds source-path comments relative to the process cwd. The bundle
      // hash is a security pin, so remove those comments in the build rather than rewriting output.
      minify: { whitespace: true },
      plugins,
      external,
      /*
        A bundle is a PRODUCTION artifact whatever the packing process's NODE_ENV: the shell it
        runs in is a production React whose shared `react/jsx-dev-runtime` exports `jsxDEV` as
        undefined, so a member compiled with the development JSX transform (Bun's default when
        NODE_ENV is unset — the hub's own case when it packs an unpacked directory) throws
        `jsxDEV is not a function` at first render. This define selects `react/jsx-runtime`.
      */
      define: { "process.env.NODE_ENV": '"production"' },
    });
  } catch (error) {
    // Bun rejects a failed build with its messages as an aggregate; name them, not "failed".
    const messages = error instanceof AggregateError ? error.errors : [error];
    const detail = messages
      .map((inner: unknown) =>
        typeof inner === "object" && inner !== null && "message" in inner
          ? String(inner.message)
          : String(inner),
      )
      .join("; ");
    throw new Error(`bundling ${entrypoint} failed: ${detail}`, { cause: error });
  }
  if (!result.success || result.outputs.length === 0) {
    const detail = result.logs.map((log) => log.message).join("; ");
    throw new Error(`bundling ${entrypoint} failed: ${detail === "" ? "no output" : detail}`);
  }
  const entries = result.outputs.filter((artifact) => artifact.kind === "entry-point");
  if (entries.length !== 1) throw new Error(`bundling ${entrypoint} must produce one entry`);
  if (onlyEntry && result.outputs.length !== 1) {
    throw new Error(`bundling ${entrypoint} produced assets a browser entry cannot carry`);
  }
  if (result.outputs.some((artifact) => artifact.kind !== "entry-point" && artifact.kind !== "asset"))
    throw new Error(`bundling ${entrypoint} produced an unsupported output`);
  return result.outputs;
}

/**
 * The web half's entry: `web.tsx` when the author kept JSX in the entry itself (the authoring
 * door's shape, docs/PLUGINS.md §10), else `web.ts`. One name per half otherwise.
 */
async function webEntry(pluginDir: string): Promise<string> {
  const tsx = `${pluginDir}/web.tsx`;
  return (await Bun.file(tsx).exists()) ? tsx : `${pluginDir}/web.ts`;
}

/**
 * `CHANGELOG.md` as a member's base64, or undefined when there is none (or it is empty). Read
 * like a machine member — no-follow, regular, bounded, whole — and refused unless it is
 * UTF-8 text, so the bytes the hub later reads as notes are text by construction.
 */
async function changelogMember(pluginDir: string): Promise<string | undefined> {
  const file = await open(
    join(pluginDir, PLUGIN_BUNDLE_CHANGELOG_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${PLUGIN_BUNDLE_CHANGELOG_FILE} is not a readable regular file`, {
      cause: error,
    });
  });
  if (file === undefined) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PLUGIN_CHANGELOG_BYTES)
      throw new Error(
        `${PLUGIN_BUNDLE_CHANGELOG_FILE} must be a regular file of at most ${String(MAX_PLUGIN_CHANGELOG_BYTES)} bytes`,
      );
    if (stat.size === 0) return undefined;
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size)
      throw new Error(`${PLUGIN_BUNDLE_CHANGELOG_FILE} changed while packing`);
    const text = bytes.subarray(0, offset);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(text);
    } catch {
      throw new Error(`${PLUGIN_BUNDLE_CHANGELOG_FILE} is not UTF-8 text`);
    }
    return text.toString("base64");
  } finally {
    await file.close();
  }
}

/** Compile and verify a complete bundle without writing source files or an output artifact. */
export async function compilePlugin(
  pluginDir: string,
  options: CompileOptions = {},
): Promise<CompiledPlugin> {
  // Own caller input before the first await; neither manifest edits nor byte/map mutations
  // during compilation may change the identity being compiled and verified.
  const shared = options.shared;
  const serverBuild = options.serverBuild;
  const serverPlugins = [...(serverBuild?.plugins ?? [])];
  const serverExternal = [...(serverBuild?.external ?? [])];
  const serverFiles = new Map<string, string>();
  let serverResourceBytes = 0;
  for (const [name, bytes] of serverBuild?.files ?? []) {
    PluginBundleFileSchema.parse(name);
    if (!(bytes instanceof Uint8Array)) throw new Error(`invalid server resource: ${name}`);
    serverResourceBytes += 4 * Math.ceil(bytes.byteLength / 3);
    if (serverResourceBytes > ISOLATE_MAX_ARTIFACT_BYTES)
      throw new Error("server resources exceed the artifact byte budget");
    serverFiles.set(name, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"));
  }
  const generated = options.generated;
  const generatedManifest =
    generated === undefined ? undefined : PluginManifestSchema.parse(generated.manifest);
  const members = generated === undefined ? undefined : new Map<string, string>();
  if (generated !== undefined && generatedManifest !== undefined && members !== undefined) {
    const limits = new Map<string, number>();
    for (const artifact of machineArtifacts(generatedManifest.machine)) {
      const name = artifact.bundleFile;
      if (name !== undefined)
        limits.set(name, Math.min(limits.get(name) ?? artifact.maxBytes, artifact.maxBytes));
    }
    let encodedBytes = 0;
    for (const [name, bytes] of generated.members) {
      const maxBytes = limits.get(name);
      if (maxBytes === undefined) throw new Error(`unused generated machine member: ${name}`);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength <= 0 || bytes.byteLength > maxBytes)
        throw new Error(`generated machine member exceeds its byte budget or is empty: ${name}`);
      encodedBytes += 4 * Math.ceil(bytes.byteLength / 3);
      if (encodedBytes > ISOLATE_MAX_ARTIFACT_BYTES)
        throw new Error("bundle members exceed the artifact byte budget");
      // Base64 owns the snapshot without retaining or first copying the caller's backing buffer.
      members.set(
        name,
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
      );
    }
  }
  const source = options.source;
  if (source !== undefined && generated !== undefined) {
    throw new Error("compile registered source or generated members, not both");
  }
  const registered =
    source === undefined
      ? undefined
      : {
          manifest: PluginManifestSchema.parse(source.manifest),
          server: source.server,
          web: source.web,
        };
  pluginDir = resolve(pluginDir);
  const manifestFile = `${pluginDir}/manifest.json`;
  let manifest: PluginManifest;
  let where: string;
  if (registered === undefined) {
    const sourceManifest = PluginManifestSchema.parse(await Bun.file(manifestFile).json());
    manifest = generatedManifest ?? sourceManifest;
    where = manifestFile;
    if (
      generatedManifest !== undefined &&
      (manifest.id !== sourceManifest.id ||
        JSON.stringify(manifest.entry) !== JSON.stringify(sourceManifest.entry))
    )
      throw new Error(`${manifestFile}: generated manifest must preserve the source id and entry`);
  } else {
    manifest = registered.manifest;
    where = `${manifest.id} registered source`;
  }
  if (manifest.entry === undefined) {
    throw new Error(`${where}: manifest.entry must name the halves this bundle runs`);
  }
  if (manifest.entry.web === PLUGIN_BUNDLE_CHANGELOG_FILE) {
    throw new Error(`${where}: entry.web may not claim ${PLUGIN_BUNDLE_CHANGELOG_FILE}`);
  }
  if (serverBuild !== undefined && manifest.entry.server !== true)
    throw new Error(`${where}: server build resources require a server half`);
  if (registered !== undefined) {
    if ((manifest.entry.server === true) !== (registered.server !== undefined)) {
      throw new Error(`${where}: a server source is required exactly when entry.server is true`);
    }
    if ((manifest.entry.web !== undefined) !== (registered.web !== undefined)) {
      throw new Error(`${where}: a web source is required exactly when entry.web is declared`);
    }
  }
  if (manifest.entry.worker === true) {
    if (manifest.entry.web === undefined) {
      throw new Error(`${where}: entry.worker is compiled beside an in-realm entry.web`);
    }
    // The page entry of a portable build IS its in-realm module, so it must link the shell's
    // React: a self-contained copy would render hooks against a second React in the page.
    if (shared === false) {
      throw new Error(
        `${where}: entry.worker requires the page-linked web entry; a self-contained web entry would load a second React into the page`,
      );
    }
  }
  const files: Record<string, string> = {};
  /*
    The sheet is carried as it is, never bundled: the hub admits it under the root-class rule
    and the loader injects it beside the module (ADR 0025 §7). Declared or not is the
    manifest's word — a sheet on disk that the manifest does not name is refused here, before
    a build is paid for, rather than silently left behind; a declared one that is missing
    fails the read by name.
  */
  const sheet = Bun.file(`${pluginDir}/${PLUGIN_BUNDLE_STYLES_FILE}`);
  if (manifest.entry.styles === true) {
    files[PLUGIN_BUNDLE_STYLES_FILE] = Buffer.from(await sheet.text(), "utf8").toString("base64");
  } else if (await sheet.exists()) {
    throw new Error(
      `${where}: ${PLUGIN_BUNDLE_STYLES_FILE} is beside the manifest but entry.styles is not true`,
    );
  }
  const changelog = await changelogMember(pluginDir);
  if (changelog !== undefined) files[PLUGIN_BUNDLE_CHANGELOG_FILE] = changelog;
  for (const artifact of machineArtifacts(manifest.machine)) {
    const name = artifact.bundleFile;
    if (name === undefined) continue;
    if (
      name === PLUGIN_BUNDLE_SERVER_FILE ||
      name === manifest.entry.web ||
      name === PLUGIN_BUNDLE_STYLES_FILE ||
      name === PLUGIN_BUNDLE_CHANGELOG_FILE ||
      (manifest.entry.worker === true && name === PLUGIN_BUNDLE_WEB_WORKER_FILE)
    )
      throw new Error(`machine member collides with a plugin entry: ${name}`);
    if (Object.hasOwn(files, name)) continue;
    if (members !== undefined) {
      const data = members.get(name);
      if (data === undefined) throw new Error(`missing generated machine member: ${name}`);
      files[name] = data;
      continue;
    }
    const file = await open(join(pluginDir, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size <= 0 ||
        stat.size > artifact.maxBytes ||
        4 * Math.ceil(stat.size / 3) > ISOLATE_MAX_ARTIFACT_BYTES
      )
        throw new Error(`machine member exceeds its byte budget or is not a regular file: ${name}`);
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, null);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset !== stat.size) throw new Error(`machine member changed while packing: ${name}`);
      files[name] = bytes.subarray(0, offset).toString("base64");
    } finally {
      await file.close();
    }
  }
  const entryNames = new Set([
    PLUGIN_BUNDLE_SERVER_FILE,
    manifest.entry.web,
    PLUGIN_BUNDLE_WEB_WORKER_FILE,
    PLUGIN_BUNDLE_STYLES_FILE,
    PLUGIN_BUNDLE_CHANGELOG_FILE,
  ]);
  const addResource = (name: string, encoded: string): void => {
    PluginBundleFileSchema.parse(name);
    if (entryNames.has(name) || Object.hasOwn(files, name))
      throw new Error(`server resource collides with another bundle member: ${name}`);
    files[name] = encoded;
  };
  for (const [name, encoded] of serverFiles) addResource(name, encoded);
  const addBuild = async (entry: string, outputs: readonly BuildArtifact[]): Promise<void> => {
    const encodedBytes = Object.values(files).reduce((total, data) => total + data.length, 0) +
      outputs.reduce((total, artifact) => total + 4 * Math.ceil(artifact.size / 3), 0);
    if (encodedBytes > ISOLATE_MAX_ARTIFACT_BYTES)
      throw new Error("compiled members exceed the artifact byte budget");
    for (const artifact of outputs) {
      const encoded = Buffer.from(await artifact.arrayBuffer()).toString("base64");
      if (artifact.kind === "entry-point") {
        if (Object.hasOwn(files, entry)) throw new Error(`duplicate bundle entry: ${entry}`);
        files[entry] = encoded;
      } else {
        addResource(basename(artifact.path), encoded);
      }
    }
  };
  const manifestPlugins: BunPlugin[] = [];
  if (generatedManifest !== undefined) {
    const rootManifest = await realpath(manifestFile);
    const contents = JSON.stringify(manifest);
    manifestPlugins.push({
      name: "manifold-generated-manifest",
      setup(builder) {
        builder.onLoad({ filter: /.*/, namespace: "file" }, ({ path }) => {
          if (path === rootManifest) return { contents, loader: "json" };
          return undefined;
        });
      },
    });
  }
  /*
    Every pack stamps the wire revision it compiled against, shared or self-contained, so the
    hub names a protocol mismatch from the bundle's own word rather than guessing one; a
    shared pack adds the floor-package versions it links to beside it.
  */
  const builtAgainst: Record<string, string> = {
    [BUILT_AGAINST_PROTOCOL]: String(PROTOCOL_VERSION),
  };
  const plugins =
    manifest.entry.web === undefined || shared === false
      ? manifestPlugins
      : [...manifestPlugins, await sharedModules(pluginDir, builtAgainst)];
  if (manifest.entry.server === true) {
    // A hardened server has no browser realm or shared-module registry.
    const entry =
      registered?.server === undefined
        ? `${pluginDir}/server.ts`
        : resolve(pluginDir, registered.server);
    await addBuild(PLUGIN_BUNDLE_SERVER_FILE, await build(
      entry, "bun", [...manifestPlugins, ...serverPlugins], false, serverExternal,
    ));
  }
  if (manifest.entry.web !== undefined) {
    const entry =
      registered?.web === undefined
        ? await webEntry(pluginDir)
        : resolve(pluginDir, registered.web);
    await addBuild(manifest.entry.web, await build(entry, "browser", plugins, true));
    if (manifest.entry.worker === true) {
      const worker = await build(
        WORKER_ENTRY,
        "browser",
        [...manifestPlugins, portableModules(pluginDir, entry)],
        true,
      );
      await addBuild(PLUGIN_BUNDLE_WEB_WORKER_FILE, worker);
    }
  }
  const bundle: PluginBundle = PluginBundleSchema.parse({
    format: PLUGIN_BUNDLE_FORMAT,
    hardenedContract: HARDENED_CONTRACT_VERSION,
    manifest,
    files,
    builtAgainst,
  });
  await verifyBundledArtifacts(bundle);
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  if (bytes.byteLength > ISOLATE_MAX_ARTIFACT_BYTES)
    throw new Error("plugin bundle exceeds the artifact byte budget");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

/** File-writing convenience over the same verified in-memory compilation. */
export async function packPlugin(
  pluginDir: string,
  outFile: string,
  options: PackOptions = {},
): Promise<PackResult> {
  const { bytes, sha256 } = await compilePlugin(pluginDir, options);
  await Bun.write(outFile, bytes);
  return { file: outFile, sha256, bytes: bytes.byteLength };
}

function usage(): never {
  console.error("usage: manifold-pack <plugin-dir> --out <file> [--self-contained]");
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const shared = !args.includes("--self-contained");
  const argv = args.filter((arg) => arg !== "--self-contained");
  const outAt = argv.indexOf("--out");
  const pluginDir = outAt === 0 ? argv[2] : argv[0];
  const outFile = argv[outAt + 1];
  if (
    argv.length !== 3 ||
    outAt === -1 ||
    outAt === 2 ||
    pluginDir === undefined ||
    outFile === undefined
  )
    usage();
  console.log(JSON.stringify(await packPlugin(pluginDir, outFile, { shared })));
}
