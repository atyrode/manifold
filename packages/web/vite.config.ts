import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vite";
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

// Dev: vite on :5173 proxies API/WS to the manifold server on :7777.
// Prod: `vite build` emits dist/, served directly by the manifold server.
export default defineConfig({
  plugins: [react()],
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
