import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { build, defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  CREDENTIAL_ENTRY_ASSETS_PREFIX,
  CREDENTIAL_ENTRY_DOCUMENT_PATH,
  CREDENTIAL_ENTRY_SECURITY_HEADERS,
  privateCredentialEntryCsp,
  privateCredentialEntryStaticPath,
} from "@manifold/plugin/private-entry";
import { pluginDevelopment } from "@manifold/plugin-kit/refresh-vite";
import { resolveBuildIdentity } from "../../scripts/build-identity.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");

/*
 * The bundle's identity is the SERVER's identity, by the one derivation both read
 * (`scripts/build-identity.ts`): `MANIFOLD_VERSION`/`MANIFOLD_BUILD`/`MANIFOLD_CHANNEL` when the
 * build was told (a Dockerfile ARG, a workflow), the checkout's git tags otherwise. A lens and
 * the instance that served it therefore print the same `build`, which is the whole point of
 * printing one.
 */
const identity = resolveBuildIdentity(process.env, repositoryRoot);

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

/** The shipped `<title>` when nobody chose one; Docker and compose pass it back explicitly. */
const DEFAULT_TITLE = "manifold";

/**
 * Browser identity belongs to the build, never to the instance hostname. Public files are
 * production templates; one generation serves both Vite development and emitted builds.
 * Content-addressed URLs also bypass a previous worker's cache when only branding changes.
 */
function shellIdentity(env: Record<string, string>, title: string): Plugin {
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

type CredentialEntryResource = {
  source: string | Uint8Array;
  contentType: string;
  contentLength: number;
};

/**
 * One independent graph for builds and development. Multipage shared chunks would make
 * the private document depend on shell chunks (or remove shell offline assets). This graph
 * deliberately has no React, plugin-development, shell composition or HMR plugins.
 */
async function buildCredentialEntry(mode: string, outDir: string, write: boolean) {
  const assetNames = `${CREDENTIAL_ENTRY_ASSETS_PREFIX.slice(1)}[name]-[hash]`;
  const graph = await build({
    configFile: false,
    root: packageRoot,
    mode,
    base: "/",
    publicDir: false,
    logLevel: "warn",
    plugins: [{
      name: "manifold-credential-graph-boundary",
      enforce: "post",
      generateBundle: {
        order: "post",
        handler(_options, bundle) {
          for (const output of Object.values(bundle)) {
            if (
              output.fileName !== CREDENTIAL_ENTRY_DOCUMENT_PATH.slice(1) &&
              !output.fileName.startsWith(CREDENTIAL_ENTRY_ASSETS_PREFIX.slice(1))
            ) {
              throw new Error("Private credential assets must have their own URL namespace");
            }
            if (output.type !== "chunk") continue;
            for (const id of Object.keys(output.modules)) {
              const path = id.split(sep).join("/");
              if (
                path.includes("/packages/plugins/") ||
                /\/packages\/web\/src\/(?:main|app|identity|api|assembly|plugin-host|shared-registry)\.(?:ts|tsx)$/.test(path) ||
                /\/packages\/plugin\/src\/(?:hooks|index|runtime)\.ts$/.test(path) ||
                path.includes("/vite/dist/client/") ||
                path === "/@vite/client"
              ) {
                throw new Error("The private credential entry must not load the plugin shell or HMR");
              }
            }
          }
        },
      },
    }],
    build: {
      outDir,
      write,
      emptyOutDir: false,
      sourcemap: false,
      assetsDir: CREDENTIAL_ENTRY_ASSETS_PREFIX.slice(1, -1),
      rollupOptions: {
        input: resolve(packageRoot, CREDENTIAL_ENTRY_DOCUMENT_PATH.slice(1)),
        output: {
          entryFileNames: `${assetNames}.js`,
          chunkFileNames: `${assetNames}.js`,
          assetFileNames: `${assetNames}[extname]`,
        },
      },
    },
  });
  if (Array.isArray(graph) || !("output" in graph)) {
    throw new Error("The private credential entry requires one finite build graph");
  }
  return graph.output;
}

function credentialEntry(): Plugin {
  let outDir = resolve(packageRoot, "dist");
  let mode = "production";
  let disposeDevGraph: (() => Promise<void>) | undefined;
  return {
    name: "manifold-credential-entry",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      mode = config.mode;
    },
    configureServer(server) {
      const assets = new Map<string, CredentialEntryResource>();
      let pending = Promise.resolve();
      let closed = false;
      // Rebuild on each navigation, not on a watcher/HMR event. Keep content-addressed assets
      // for this server's lifetime: an older open page may still need its lazy crypto chunks.
      function document(): Promise<CredentialEntryResource> {
        const next = pending.then(async () => {
          if (closed) throw new Error("The private credential development graph is closed");
          const graph = await buildCredentialEntry(mode, outDir, false);
          if (closed) throw new Error("The private credential development graph is closed");
          let document: CredentialEntryResource | undefined;
          for (const output of graph) {
            const path = `/${output.fileName}`;
            const source = output.type === "chunk" ? output.code : output.source;
            const contentType = path === CREDENTIAL_ENTRY_DOCUMENT_PATH
              ? "text/html; charset=utf-8"
              : path.endsWith(".js")
                ? "text/javascript; charset=utf-8"
                : path.endsWith(".css")
                  ? "text/css; charset=utf-8"
                  : "application/octet-stream";
            const entry = {
              source,
              contentType,
              contentLength: typeof source === "string" ? Buffer.byteLength(source) : source.byteLength,
            };
            if (path === CREDENTIAL_ENTRY_DOCUMENT_PATH) document = entry;
            else assets.set(path, entry);
          }
          if (!document) throw new Error("The private credential build did not emit its document");
          return document;
        });
        pending = next.then(() => {}, () => {});
        return next;
      }
      disposeDevGraph = async () => {
        closed = true;
        await pending;
        assets.clear();
      };
      server.middlewares.use(async (request, response, next) => {
        // Preserve the raw path so encoded, nested and source aliases cannot be normalized
        // into a canonical private resource. Ordinary authenticated API names remain proxies.
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (!privateCredentialEntryStaticPath(path)) return next();
        for (const [name, value] of CREDENTIAL_ENTRY_SECURITY_HEADERS) {
          response.setHeader(name, value);
        }
        try {
          const protocol = server.config.server.https ? "https" : "http";
          const origin = new URL(`${protocol}://${request.headers.host ?? "localhost"}`).origin;
          response.setHeader("content-security-policy", privateCredentialEntryCsp(origin));
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.statusCode = 404;
            response.end();
            return;
          }
          const entry = path === CREDENTIAL_ENTRY_DOCUMENT_PATH
            ? await document()
            : assets.get(path);
          if (!entry) {
            response.statusCode = 404;
            response.end();
            return;
          }
          response.setHeader("content-type", entry.contentType);
          response.setHeader("content-length", entry.contentLength);
          response.end(request.method === "HEAD" ? undefined : entry.source);
        } catch {
          // Never hand a failed private build to the shell fallback or Vite's HMR error page.
          response.statusCode = 500;
          response.end();
        }
      });
    },
    async closeBundle() {
      await disposeDevGraph?.();
    },
    writeBundle: {
      order: "pre",
      sequential: true,
      async handler() {
        await buildCredentialEntry(mode, outDir, true);
      },
    },
  };
}

/**
 * Ships the app shell's service worker (`sw.js`) from the ONE existing build — no second build
 * target, no `vite-plugin-pwa`, no generated worker (see `sw.js` for the docs/CONTRACTS.md §Dependency decisions reasoning).
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
    writeBundle: {
      order: "post",
      sequential: true,
      handler() {
        const shipped = readdirSync(outDir, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map(
            (entry) =>
              `/${relative(outDir, resolve(entry.parentPath, entry.name)).split(sep).join("/")}`,
          )
          .filter(
            (entry) =>
              entry !== "/sw.js" &&
              entry !== CREDENTIAL_ENTRY_DOCUMENT_PATH &&
              !entry.startsWith(CREDENTIAL_ENTRY_ASSETS_PREFIX) &&
              !entry.endsWith(".map"),
          )
          .sort();
        const source = readFileSync(resolve(packageRoot, "sw.js"), "utf8");
        // Policy-only worker changes also need a new generation, not just changed shell assets.
        const hash = createHash("sha256").update(source).update("\0");
        for (const path of shipped) {
          hash
            .update(path)
            .update("\0")
            .update(readFileSync(resolve(outDir, `.${path}`)))
            .update("\0");
        }
        const digest = hash.digest("hex");
        if (!SHELL_MARKER.test(source)) {
          throw new Error("packages/web/sw.js is missing its MANIFOLD_SHELL line");
        }
        const shell = { build: `${identity.build}-${digest.slice(0, 8)}`, assets: shipped };
        writeFileSync(
          resolve(outDir, "sw.js"),
          source.replace(SHELL_MARKER, `const SHELL = ${JSON.stringify(shell)}; // MANIFOLD_SHELL`),
        );
      },
    },
  };
}

// Dev: vite on :5173 proxies API/WS to MANIFOLD_PORT (7777 by default).
// MANIFOLD_DEV_HOST admits a live preview's hostname and sends HMR through its TLS router.
// Prod: `vite build` emits dist/, served directly by the manifold server.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, packageRoot, "VITE_MANIFOLD_");
  const title = env["VITE_MANIFOLD_SITE_TITLE"]?.trim() || DEFAULT_TITLE;
  const target = `http://127.0.0.1:${process.env["MANIFOLD_PORT"] ?? 7777}`;
  const devHost = process.env["MANIFOLD_DEV_HOST"];
  return {
    // These files are templates for shellIdentity, not a second set of unbranded public URLs.
    publicDir: false,
    plugins: [
      react(),
      pluginDevelopment(),
      shellIdentity(env, title),
      credentialEntry(),
      shellWorker(),
    ],
    define: {
      "import.meta.env.VITE_MANIFOLD_WEB_VERSION": JSON.stringify(identity.version),
      "import.meta.env.VITE_MANIFOLD_WEB_BUILD": JSON.stringify(identity.build),
      "import.meta.env.VITE_MANIFOLD_WEB_CHANNEL": JSON.stringify(identity.channel),
      // The title the operator CHOSE, or "": a development build marks its tab only when nobody
      // has already named it (`main.tsx`). The default handed back explicitly is not a choice.
      "import.meta.env.VITE_MANIFOLD_SITE_TITLE": JSON.stringify(
        title === DEFAULT_TITLE ? "" : title,
      ),
    },
    server: {
      port: 5173,
      ...(devHost
        ? {
            allowedHosts: [devHost],
            hmr: { protocol: "wss" as const, clientPort: 443, host: devHost },
          }
        : {}),
      proxy: {
        "/api": { target, changeOrigin: false },
        "/healthz": { target, changeOrigin: false },
        "/auth": { target, changeOrigin: false },
        "/ws": { target, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});
