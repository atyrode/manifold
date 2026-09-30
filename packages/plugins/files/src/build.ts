import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";
import { z } from "zod";

const dependencyMetadata = z.object({ optionalDependencies: z.record(z.string(), z.string()) });
const glibcReport = z.object({ header: z.object({ glibcVersionRuntime: z.string() }) });

/** Build on the same supported OS/architecture as the packaged hub, never download at startup. */
export function filesServerBuild() {
  const platform = `${process.platform}-${process.arch}`;
  if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform))
    throw new Error(`Files decoder does not support the build platform: ${platform}`);
  if (process.platform === "linux" && !glibcReport.safeParse(process.report.getReport()).success)
    throw new Error("Files decoder artifacts require glibc on Linux");

  // Sharp's public CommonJS export has static native imports; its ESM createRequire calls
  // cannot give a bundler a self-contained dependency graph.
  const require = createRequire(import.meta.url);
  const sharpEntry = require.resolve("sharp");
  const sharpRequire = createRequire(sharpEntry);
  const sharpRoot = dirname(dirname(sharpEntry));
  const nativePackage = `@img/sharp-${platform}`;
  const libraryPackage = `@img/sharp-libvips-${platform}`;
  const nativeEntry = sharpRequire.resolve(`${nativePackage}/sharp.node`);
  const nativeRoot = dirname(sharpRequire.resolve(`${nativePackage}/package`));
  const libraryRoot = dirname(sharpRequire.resolve(`${libraryPackage}/package`));
  const upstreamLoader = readFileSync(nativeEntry, "utf8");
  const metadata = dependencyMetadata.parse(JSON.parse(readFileSync(join(sharpRoot, "package.json"), "utf8")) as unknown);
  const external = Object.keys(metadata.optionalDependencies)
    .filter((name) => name.startsWith("@img/sharp-") && name !== nativePackage && name !== libraryPackage)
    .map((name) => `${name}/*`);

  const plugin: BunPlugin = {
    name: "manifold-files-native-decoder",
    setup(build) {
      build.onResolve({ filter: /^sharp$/ }, () => ({ path: sharpEntry }));
      build.onLoad({ filter: /index\.cjs$/ }, ({ path }) => {
        if (path !== nativeEntry) return undefined;
        return {
          loader: "js",
          resolveDir: dirname(nativeEntry),
          // Explicit file imports embed the shared library in standalone executables too.
          // Bun materializes an embedded library for dlopen. Preloading by its SONAME lets
          // the unchanged native binding resolve its dependency despite hashed asset names.
          // The binding retains its own handle; release this temporary loader reference.
          contents: `
            import libraryAsset from ${JSON.stringify(`${libraryPackage}/binary`)} with { type: "file" };
            const { dlopen } = require("bun:ffi");
            const { fileURLToPath } = require("node:url");
            const dependency = dlopen(fileURLToPath(new URL(libraryAsset, import.meta.url)), {
              vips_version: { args: ["i32"], returns: "i32" }
            });
            try { ${upstreamLoader} } finally { dependency.close(); }
          `,
        };
      });
    },
  };
  const notices = [
    `Files native image decoder (${platform})`,
    "Source and rebuild instructions: https://github.com/lovell/sharp and https://github.com/lovell/sharp-libvips",
    "Exact dependency versions and integrity pins are recorded in the distribution's bun.lock.",
    "\nSharp and native binding license\n",
    readFileSync(join(nativeRoot, "LICENSE"), "utf8"),
    "\nNative library upstream licenses and source references\n",
    readFileSync(join(libraryRoot, "README.md"), "utf8"),
    "\nNative dependency versions\n",
    readFileSync(join(libraryRoot, "versions.json"), "utf8"),
  ].join("\n");
  return {
    plugins: [plugin],
    external,
    files: new Map([["files-decoder-notices.txt", new TextEncoder().encode(notices)]]),
  };
}
