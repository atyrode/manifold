// Landing concept lab server, loopback only, for a fronting proxy.
//
//   bun concepts/landing/serve.ts [port]          committed builds only:
//                                                   /            head of the concept branch
//                                                   /@<sha>/     that commit, exactly as it was
//                                                   /bench.html  the head's GPU timing page,
//                                                   /@<sha>/bench.html  that commit's
//   bun concepts/landing/serve.ts [port] --dev    this working tree with hot reload (the same
//                                                   / and /bench.html)
//
// Builds come from `git archive`, so uncommitted edits never reach the public origin, and a saved
// setup can always be replayed on the commit it was tuned on. Bun's HMR server refuses any
// Host/Origin but its bind address, so --dev only works when browsing the loopback port.
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import bench from "./bench.html";
import index from "./index.html";
import { buildSite, extractTree, PAGES } from "./scripts/site.ts";

const args = process.argv.slice(2);
const port = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 7920);
const branch = process.env.LANDING_BRANCH ?? "concept/landing";
const here = new URL(".", import.meta.url).pathname;
const cacheRoot = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "manifold-landing");

class BuildError extends Error {}

async function git(...gitArgs: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", here, ...gitArgs], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new BuildError(`git ${gitArgs.join(" ")}: ${err.trim()}`);
  return out.trim();
}

/** A full commit id that contains the lab, or undefined. */
async function resolve(ref: string): Promise<string | undefined> {
  try {
    const sha = await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
    await git("cat-file", "-e", `${sha}:concepts/landing/index.html`);
    return sha;
  } catch {
    return undefined;
  }
}

let headCache: { sha: Promise<string | undefined>; at: number } | undefined;
function head(): Promise<string | undefined> {
  if (!headCache || performance.now() - headCache.at > 3000)
    headCache = { sha: resolve(branch), at: performance.now() };
  return headCache.sha;
}

const builds = new Map<string, Promise<string>>();

/** Directory holding the built site for a commit; built once, then cached on disk. */
function built(sha: string): Promise<string> {
  let pending = builds.get(sha);
  if (!pending) {
    pending = buildCommit(sha);
    pending.catch(() => builds.delete(sha));
    builds.set(sha, pending);
  }
  return pending;
}

async function buildCommit(sha: string): Promise<string> {
  const short = sha.slice(0, 8);
  const dist = join(cacheRoot, sha);
  if (await Bun.file(join(dist, "index.html")).exists()) return dist;
  const work = join(cacheRoot, `.work-${sha}-${process.pid}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(join(work, "src"), { recursive: true });
  try {
    const toplevel = await git("rev-parse", "--show-toplevel");
    const source = await extractTree(toplevel, sha, join(work, "src"));
    await buildSite(source, join(work, "out"), `/@${short}/`);
    // The scene browser's thumbnails ride along as committed (builds before them have none, and
    // the lab draws stand-ins).
    const thumbs = join(source, "thumbs");
    for (const name of await readdir(thumbs).catch(() => [])) {
      if (/^[a-z]+\.webp$/.test(name))
        await Bun.write(join(work, "out", "thumbs", name), Bun.file(join(thumbs, name)));
    }
    for (const page of PAGES) {
      const file = Bun.file(join(work, "out", page));
      if (!(await file.exists())) continue;
      const html = await file.text();
      await Bun.write(
        file,
        html.replace("</head>", `<meta name="landing-build" content="${short}"></head>`),
      );
    }
    await mkdir(cacheRoot, { recursive: true });
    await rm(dist, { recursive: true, force: true });
    await rename(join(work, "out"), dist);
    console.log(`evt=landing.build commit=${short}`);
    return dist;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** How long a browser may keep a file: for good, for an hour, or not at all (it asks again). */
type Keep = "immutable" | "hour" | "none";

async function serveFile(dist: string, path: string, keep: Keep): Promise<Response> {
  if (path.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(dist, path || "index.html"));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  const cache =
    keep === "none" || path === "" || path.endsWith(".html")
      ? "no-cache"
      : keep === "immutable"
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";
  return new Response(file, { headers: { "cache-control": cache } });
}

async function committed(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pinned = /^\/@([0-9a-f]{7,40})(\/.*)?$/.exec(url.pathname);
  try {
    if (pinned) {
      const [, ref = "", rest] = pinned;
      if (rest === undefined) return Response.redirect(`/@${ref}/${url.search}`, 308);
      const sha = await resolve(ref);
      if (!sha) return new Response("unknown build", { status: 404 });
      return await serveFile(await built(sha), rest.slice(1), "immutable");
    }
    const sha = await head();
    if (!sha) return new Response(`no committed lab on ${branch}`, { status: 503 });
    if (url.pathname === "/") return await serveFile(await built(sha), "", "none");
    if (url.pathname === "/bench.html")
      return await serveFile(await built(sha), "bench.html", "none");
    // The head page is served from the root, so its thumbnails load from there; its worker loads
    // from the head's pinned path, built with it (src/sims/build.ts).
    if (/^\/thumbs\/[a-z]+\.webp$/.test(url.pathname))
      return await serveFile(await built(sha), url.pathname.slice(1), "hour");
    return new Response("not found", { status: 404 });
  } catch (error: unknown) {
    console.error("evt=landing.build_failed", error);
    return new Response("build failed", { status: 500 });
  }
}

const server = args.includes("--dev")
  ? Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: { hmr: true, console: true },
      routes: {
        "/": index,
        "/bench.html": bench,
        "/build-worker.js": async () => {
          const result = await Bun.build({
            entrypoints: [new URL("./src/build-worker.ts", import.meta.url).pathname],
          });
          const [output] = result.outputs;
          if (!result.success || !output)
            return new Response(result.logs.map(String).join("\n"), { status: 500 });
          return new Response(await output.text(), {
            headers: { "content-type": "text/javascript", "cache-control": "no-store" },
          });
        },
        "/thumbs/:file": (request) =>
          /^[a-z]+\.webp$/.test(request.params.file)
            ? serveFile(new URL("./thumbs", import.meta.url).pathname, request.params.file, "hour")
            : new Response("not found", { status: 404 }),
      },
      fetch: () => new Response("not found", { status: 404 }),
    })
  : Bun.serve({ hostname: "127.0.0.1", port, fetch: committed });

console.log(
  `evt=landing.serve url=${server.url} mode=${args.includes("--dev") ? "dev" : "committed"} branch=${branch}`,
);
