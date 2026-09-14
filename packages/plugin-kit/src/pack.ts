#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { verifyBundledArtifacts } from "./artifacts.ts";
import {
  HARDENED_CONTRACT_VERSION,
  ISOLATE_MAX_ARTIFACT_BYTES,
  PLUGIN_BUNDLE_FORMAT,
  PLUGIN_BUNDLE_SERVER_FILE,
  PLUGIN_BUNDLE_STYLES_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
  machineArtifacts,
  type PluginBundle,
  type PluginManifest,
} from "@manifold/protocol";

/** Packing changes linkage, not trust: only the installer chooses `install.hardened`. */
export interface PackOptions {
  /** Resolve browser floor imports through the host registry; server processes stay self-contained. */
  readonly shared?: boolean;
}

export interface CompileOptions extends PackOptions {
  /** Replace root manifest imports and supply every declared bundled machine member in memory. */
  readonly generated?: {
    readonly manifest: PluginManifest;
    readonly members: ReadonlyMap<string, Uint8Array>;
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

async function build(
  entrypoint: string,
  target: "bun" | "browser",
  plugins: BunPlugin[],
): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target,
    format: "esm",
    // Bun's readable output embeds source-path comments relative to the process cwd. The bundle
    // hash is a security pin, so remove those comments in the build rather than rewriting output.
    minify: { whitespace: true },
    plugins,
    /*
      A bundle is a PRODUCTION artifact whatever the packing process's NODE_ENV: the shell it
      runs in is a production React whose shared `react/jsx-dev-runtime` exports `jsxDEV` as
      undefined, so a member compiled with the development JSX transform (Bun's default when
      NODE_ENV is unset — the hub's own case when it packs an unpacked directory) throws
      `jsxDEV is not a function` at first render. This define selects `react/jsx-runtime`.
    */
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success || result.outputs.length === 0) {
    const detail = result.logs.map((log) => log.message).join("; ");
    throw new Error(`bundling ${entrypoint} failed: ${detail === "" ? "no output" : detail}`);
  }
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`bundling ${entrypoint} produced no artifact`);
  return artifact.text();
}

/**
 * The web half's entry: `web.tsx` when the author kept JSX in the entry itself (the authoring
 * door's shape, docs/PLUGINS.md §10), else `web.ts`. One name per half otherwise.
 */
async function webEntry(pluginDir: string): Promise<string> {
  const tsx = `${pluginDir}/web.tsx`;
  return (await Bun.file(tsx).exists()) ? tsx : `${pluginDir}/web.ts`;
}

/** Compile and verify a complete bundle without writing source files or an output artifact. */
export async function compilePlugin(
  pluginDir: string,
  options: CompileOptions = {},
): Promise<CompiledPlugin> {
  // Own caller input before the first await; neither manifest edits nor byte/map mutations
  // during compilation may change the identity being compiled and verified.
  const shared = options.shared;
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
  pluginDir = resolve(pluginDir);
  const manifestFile = `${pluginDir}/manifest.json`;
  const sourceManifest = PluginManifestSchema.parse(await Bun.file(manifestFile).json());
  const manifest = generatedManifest ?? sourceManifest;
  if (
    generatedManifest !== undefined &&
    (manifest.id !== sourceManifest.id ||
      JSON.stringify(manifest.entry) !== JSON.stringify(sourceManifest.entry))
  )
    throw new Error(`${manifestFile}: generated manifest must preserve the source id and entry`);
  if (manifest.entry === undefined) {
    throw new Error(`${manifestFile}: manifest.entry must name the halves this bundle runs`);
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
      `${manifestFile}: ${PLUGIN_BUNDLE_STYLES_FILE} is beside the manifest but entry.styles is not true`,
    );
  }
  for (const artifact of machineArtifacts(manifest.machine)) {
    const name = artifact.bundleFile;
    if (name === undefined) continue;
    if (
      name === PLUGIN_BUNDLE_SERVER_FILE ||
      name === manifest.entry.web ||
      name === PLUGIN_BUNDLE_STYLES_FILE
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
  const builtAgainst: Record<string, string> = {};
  const plugins =
    manifest.entry.web === undefined || shared === false
      ? manifestPlugins
      : [...manifestPlugins, await sharedModules(pluginDir, builtAgainst)];
  if (manifest.entry.server === true) {
    // A hardened server has no browser realm or shared-module registry.
    const source = await build(`${pluginDir}/server.ts`, "bun", manifestPlugins);
    files[PLUGIN_BUNDLE_SERVER_FILE] = Buffer.from(source, "utf8").toString("base64");
  }
  if (manifest.entry.web !== undefined) {
    const source = await build(await webEntry(pluginDir), "browser", plugins);
    files[manifest.entry.web] = Buffer.from(source, "utf8").toString("base64");
  }
  const bundle: PluginBundle = PluginBundleSchema.parse({
    format: PLUGIN_BUNDLE_FORMAT,
    hardenedContract: HARDENED_CONTRACT_VERSION,
    manifest,
    files,
    ...(shared === false ? {} : { builtAgainst }),
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
