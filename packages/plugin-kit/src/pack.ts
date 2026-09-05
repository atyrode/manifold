#!/usr/bin/env bun
import {
  PLUGIN_BUNDLE_FORMAT,
  PLUGIN_BUNDLE_SERVER_FILE,
  PluginBundleSchema,
  PluginManifestSchema,
  type PluginBundle,
} from "@manifold/protocol";

/**
 * `pack` — from a plugin directory to the ONE artifact an install door reads (ADR 0016 §8,
 * `PluginBundleSchema`).
 *
 *     bun run --cwd packages/plugin-kit pack <plugin-dir> --out <file>
 *
 * The directory holds `manifest.json` (a `PluginManifest` whose `entry` names at least one
 * half), `server.ts` when `entry.server` is true and `web.ts` when `entry.web` names a file.
 * Each half is bundled by `Bun.build` with NOTHING external — the kit, the protocol and zod
 * are inlined — so the artifact is self-contained: the engine's loader is one
 * `Bun.spawn(["bun", "--smol", "<dir>/server.js"])` and one `new Worker(".../web.js")`, and
 * neither ever resolves a package. The bundle is parsed against the protocol's schema before
 * it is written, and the printed `sha256` is over the file's exact bytes — the pin an
 * installer hands `engine.plugins.install`.
 */

export interface PackResult {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

async function build(entrypoint: string, target: "bun" | "browser"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target,
    format: "esm",
    minify: false,
  });
  if (!result.success || result.outputs.length === 0) {
    const detail = result.logs.map((log) => log.message).join("; ");
    throw new Error(`bundling ${entrypoint} failed: ${detail === "" ? "no output" : detail}`);
  }
  const [artifact] = result.outputs;
  if (artifact === undefined) throw new Error(`bundling ${entrypoint} produced no artifact`);
  return artifact.text();
}

export async function packPlugin(pluginDir: string, outFile: string): Promise<PackResult> {
  const manifestFile = `${pluginDir}/manifest.json`;
  const manifest = PluginManifestSchema.parse(await Bun.file(manifestFile).json());
  if (manifest.entry === undefined) {
    throw new Error(`${manifestFile}: manifest.entry must name the halves this bundle runs`);
  }
  const files: Record<string, string> = {};
  if (manifest.entry.server === true) {
    const source = await build(`${pluginDir}/server.ts`, "bun");
    files[PLUGIN_BUNDLE_SERVER_FILE] = Buffer.from(source, "utf8").toString("base64");
  }
  if (manifest.entry.web !== undefined) {
    const source = await build(`${pluginDir}/web.ts`, "browser");
    files[manifest.entry.web] = Buffer.from(source, "utf8").toString("base64");
  }
  const bundle: PluginBundle = PluginBundleSchema.parse({
    format: PLUGIN_BUNDLE_FORMAT,
    manifest,
    files,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  await Bun.write(outFile, bytes);
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return { file: outFile, sha256, bytes: bytes.byteLength };
}

function usage(): never {
  console.error("usage: manifold-pack <plugin-dir> --out <file>");
  process.exit(2);
}

if (import.meta.main) {
  // `<dir> --out <file>` or `--out <file> <dir>`: three words, `--out` never last.
  const argv = process.argv.slice(2);
  const outAt = argv.indexOf("--out");
  const pluginDir = outAt === 0 ? argv[2] : argv[0];
  const outFile = argv[outAt + 1];
  if (
    argv.length !== 3 ||
    outAt === -1 ||
    outAt === 2 ||
    pluginDir === undefined ||
    outFile === undefined
  ) {
    usage();
  }
  console.log(JSON.stringify(await packPlugin(pluginDir, outFile)));
}
