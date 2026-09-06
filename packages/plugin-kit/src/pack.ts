#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BunPlugin } from "bun";
import {
  PLUGIN_BUNDLE_FORMAT,
  PLUGIN_BUNDLE_SERVER_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
  type PluginBundle,
} from "@manifold/protocol";

/** Packing changes linkage, not trust: only the installer chooses `install.hardened`. */
export interface PackOptions {
  /** Resolve floor imports through the host registry; false preserves self-contained kit guests. */
  readonly shared?: boolean;
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
    minify: false,
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

export async function packPlugin(
  pluginDir: string,
  outFile: string,
  options: PackOptions = {},
): Promise<PackResult> {
  pluginDir = resolve(pluginDir);
  const manifestFile = `${pluginDir}/manifest.json`;
  const manifest = PluginManifestSchema.parse(await Bun.file(manifestFile).json());
  if (manifest.entry === undefined) {
    throw new Error(`${manifestFile}: manifest.entry must name the halves this bundle runs`);
  }
  const files: Record<string, string> = {};
  const builtAgainst: Record<string, string> = {};
  const plugins = options.shared === false ? [] : [await sharedModules(pluginDir, builtAgainst)];
  if (manifest.entry.server === true) {
    const source = await build(`${pluginDir}/server.ts`, "bun", plugins);
    files[PLUGIN_BUNDLE_SERVER_FILE] = Buffer.from(source, "utf8").toString("base64");
  }
  if (manifest.entry.web !== undefined) {
    const source = await build(await webEntry(pluginDir), "browser", plugins);
    files[manifest.entry.web] = Buffer.from(source, "utf8").toString("base64");
  }
  const bundle: PluginBundle = PluginBundleSchema.parse({
    format: PLUGIN_BUNDLE_FORMAT,
    manifest,
    files,
    ...(options.shared === false ? {} : { builtAgainst }),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  await Bun.write(outFile, bytes);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
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
