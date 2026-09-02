import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const packageMetadata = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
  readonly version: string;
};

function gitOutput(args: readonly string[]): string | null {
  try {
    const output = execFileSync("git", [...args], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output === "" ? null : output;
  } catch {
    return null;
  }
}

const commit = gitOutput(["rev-parse", "--short=8", "HEAD"]) ?? "unknown";
const dirty = gitOutput(["status", "--porcelain"]) !== null;
const webBuild =
  process.env["VITE_MANIFOLD_WEB_BUILD"]?.trim() || `${commit}${dirty ? "-dirty" : ""}`;

/**
 * The line in `sw.js` that this build rewrites. Matched rather than templated so the worker
 * stays a readable, runnable file on disk: a reader opens it and sees real code, not a
 * placeholder, and a build that cannot find this line FAILS instead of shipping a worker whose
 * cache name never changes.
 */
const SHELL_MARKER = /^const SHELL = .*; \/\/ MANIFOLD_SHELL$/m;

/**
 * Ships the app shell's service worker (`sw.js`) from the ONE existing build — no second build
 * target, no `vite-plugin-pwa`, no generated worker (see `sw.js` for the invariant-8 reasoning).
 *
 * All this plugin does is answer the two questions the worker cannot answer about itself: WHICH
 * files this build shipped, and WHICH generation they belong to. The generation folds a digest
 * of the asset names into the build id, and those names carry vite's content hashes — so the
 * cache name changes whenever the shell's bytes do, even if two builds claim the same commit.
 * That is what ties cache invalidation to the build rather than to a human remembering to bump
 * something.
 *
 * It reads the emitted TREE rather than the rollup bundle, because `public/` (the icon, the web
 * app manifest) is copied outside the bundle and is every bit as much the shell.
 */
function shellWorker(): Plugin {
  let outDir = resolve(packageRoot, "dist");
  return {
    name: "manifold-shell-worker",
    enforce: "post",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const shipped = readdirSync(outDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map(
          (entry) =>
            `/${relative(outDir, resolve(entry.parentPath, entry.name)).split(sep).join("/")}`,
        )
        .filter((entry) => entry !== "/sw.js" && !entry.endsWith(".map"))
        .sort();
      const digest = createHash("sha256").update(shipped.join("\n")).digest("hex");
      const source = readFileSync(resolve(packageRoot, "sw.js"), "utf8");
      if (!SHELL_MARKER.test(source)) {
        throw new Error("packages/web/sw.js is missing its MANIFOLD_SHELL line");
      }
      const shell = { build: `${webBuild}-${digest.slice(0, 8)}`, assets: shipped };
      writeFileSync(
        resolve(outDir, "sw.js"),
        source.replace(SHELL_MARKER, `const SHELL = ${JSON.stringify(shell)}; // MANIFOLD_SHELL`),
      );
    },
  };
}

// Dev: vite on :5173 proxies API/WS to the manifold server on :7777.
// Prod: `vite build` emits dist/, served directly by the manifold server.
export default defineConfig({
  plugins: [react(), shellWorker()],
  define: {
    "import.meta.env.VITE_MANIFOLD_WEB_VERSION": JSON.stringify(packageMetadata.version),
    "import.meta.env.VITE_MANIFOLD_WEB_BUILD": JSON.stringify(webBuild),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:7777", changeOrigin: false },
      "/ws": { target: "http://127.0.0.1:7777", changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
