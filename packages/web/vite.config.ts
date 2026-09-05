import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
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

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

/**
 * Browser identity belongs to the build, never to the instance hostname. Public files are
 * production templates; one generation serves both Vite development and emitted builds.
 * Content-addressed URLs also bypass a previous worker's cache when only branding changes.
 */
function shellIdentity(env: Record<string, string>): Plugin {
  const title = env["VITE_MANIFOLD_SITE_TITLE"]?.trim() || "manifold";
  const background = env["VITE_MANIFOLD_ICON_BACKGROUND"]?.trim();
  if (background && !/^#[\da-f]{6}$/i.test(background)) {
    throw new Error("VITE_MANIFOLD_ICON_BACKGROUND must be a six-digit hex color (#rrggbb)");
  }
  const assets = new Map<string, { source: string; contentType: string }>();
  function asset(name: string, source: string, contentType: string): string {
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const dot = name.lastIndexOf(".");
    const path = `/${name.slice(0, dot)}-${digest}${name.slice(dot)}`;
    assets.set(path, { source, contentType });
    return path;
  }
  function icon(name: string): string {
    let source = readFileSync(resolve(packageRoot, "public", name), "utf8").replace(
      "<title>manifold</title>",
      () => `<title>${escapeMarkup(title)}</title>`,
    );
    if (background) {
      source = source
        .replace(/stop-color="#(?:364fc7|5f3dc4)"/g, () => `stop-color="${background}"`)
        .replace('stroke="#4c6ef5"', () => `stroke="${background}"`);
    }
    return asset(name, source, "image/svg+xml");
  }
  const favicon = icon("icon.svg");
  const maskable = icon("icon-maskable.svg");
  const manifest = JSON.parse(
    readFileSync(resolve(packageRoot, "public/app.webmanifest"), "utf8"),
  ) as {
    name: string;
    short_name: string;
    icons: { src: string; purpose: "any" | "maskable" }[];
  };
  manifest.name = title;
  manifest.short_name = title;
  for (const entry of manifest.icons) {
    entry.src = entry.purpose === "maskable" ? maskable : favicon;
  }
  const manifestPath = asset(
    "app.webmanifest",
    `${JSON.stringify(manifest, null, 2)}\n`,
    "application/manifest+json",
  );
  return {
    name: "manifold-shell-identity",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(
          "<!-- MANIFOLD_IDENTITY -->",
          () =>
            `<title>${escapeMarkup(title)}</title>\n` +
            `    <link rel="icon" href="${favicon}" type="image/svg+xml" />\n` +
            `    <link rel="manifest" href="${manifestPath}" />`,
        );
      },
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const entry = assets.get((request.url ?? "").split("?")[0] ?? "");
        if (!entry) return next();
        response.setHeader("Content-Type", entry.contentType);
        response.setHeader("Cache-Control", "no-cache");
        response.end(entry.source);
      });
    },
    generateBundle() {
      for (const [path, { source }] of assets) {
        this.emitFile({ type: "asset", fileName: path.slice(1), source });
      }
    },
  };
}

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
 * of the asset names AND bytes into the build id, including unhashed public files and HTML —
 * so the cache name changes whenever the shell does, even if two builds claim the same commit.
 * That is what ties cache invalidation to the build rather than to a human remembering to bump
 * something.
 *
 * It reads the final emitted TREE rather than an intermediate rollup bundle, so HTML,
 * generated identity and any other shipped shell files all participate in cache identity.
 */
function shellWorker(): Plugin {
  let outDir = resolve(packageRoot, "dist");
  return {
    name: "manifold-shell-worker",
    apply: "build",
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
      const hash = createHash("sha256");
      for (const path of shipped) {
        hash
          .update(path)
          .update("\0")
          .update(readFileSync(resolve(outDir, `.${path}`)))
          .update("\0");
      }
      const digest = hash.digest("hex");
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
export default defineConfig(({ mode }) => ({
  // These files are templates for shellIdentity, not a second set of unbranded public URLs.
  publicDir: false,
  plugins: [react(), shellIdentity(loadEnv(mode, packageRoot, "VITE_MANIFOLD_")), shellWorker()],
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
}));
