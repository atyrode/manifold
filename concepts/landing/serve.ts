// Landing concept lab server, loopback only, for a fronting proxy.
//
//   bun concepts/landing/serve.ts [port]          committed builds only:
//                                                   /            head of the concept branch
//                                                   /@<sha>/     that commit, exactly as it was
//   bun concepts/landing/serve.ts [port] --dev    this working tree with hot reload
//
// Builds come from `git archive`, so uncommitted edits never reach the public origin, and a saved
// setup can always be replayed on the commit it was tuned on. Bun's HMR server refuses any
// Host/Origin but its bind address, so --dev only works when browsing the loopback port.
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import index from "./index.html";

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
  if (!headCache || performance.now() - headCache.at > 3000) headCache = { sha: resolve(branch), at: performance.now() };
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
    const archive = Bun.spawn(["git", "-C", await git("rev-parse", "--show-toplevel"), "archive", sha, "concepts/landing"], { stdout: "pipe", stderr: "pipe" });
    const untar = Bun.spawn(["tar", "-x", "-C", join(work, "src")], { stdin: archive.stdout });
    if ((await archive.exited) !== 0 || (await untar.exited) !== 0) {
      throw new BuildError(`could not extract ${short}: ${(await new Response(archive.stderr).text()).trim()}`);
    }
    const source = join(work, "src", "concepts", "landing");
    const result = await Bun.build({
      entrypoints: [join(source, "index.html")],
      outdir: join(work, "out"),
      publicPath: `/@${short}/`,
      minify: true,
    });
    if (!result.success) throw new BuildError(result.logs.map(String).join("\n"));
    for (const file of await readdir(join(source, "art"))) {
      await Bun.write(join(work, "out", "art", file), Bun.file(join(source, "art", file)));
    }
    const html = await Bun.file(join(work, "out", "index.html")).text();
    await Bun.write(join(work, "out", "index.html"), html.replace("</head>", `<meta name="landing-build" content="${short}"></head>`));
    await mkdir(cacheRoot, { recursive: true });
    await rm(dist, { recursive: true, force: true });
    await rename(join(work, "out"), dist);
    console.log(`evt=landing.build commit=${short}`);
    return dist;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function serveFile(dist: string, path: string, immutable: boolean): Promise<Response> {
  if (path.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(join(dist, path || "index.html"));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  const cache = path === "" || path === "index.html" ? "no-cache" : immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600";
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
      return await serveFile(await built(sha), rest.slice(1), true);
    }
    const sha = await head();
    if (!sha) return new Response(`no committed lab on ${branch}`, { status: 503 });
    if (url.pathname === "/") return await serveFile(await built(sha), "", false);
    // Builds before pinning fetched artwork from the root.
    if (url.pathname.startsWith("/art/")) return await serveFile(await built(sha), url.pathname.slice(1), false);
    return new Response("not found", { status: 404 });
  } catch (error: unknown) {
    console.error("evt=landing.build_failed", error);
    return new Response("build failed", { status: 500 });
  }
}

const art = new URL("./art/", import.meta.url);
const server = args.includes("--dev")
  ? Bun.serve({
      hostname: "127.0.0.1",
      port,
      development: { hmr: true, console: true },
      routes: {
        "/": index,
        "/art/:file": (request) => {
          const { file } = request.params;
          if (!/^[a-z0-9-]+\.jpg$/.test(file)) return new Response("not found", { status: 404 });
          return new Response(Bun.file(new URL(file, art)));
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    })
  : Bun.serve({ hostname: "127.0.0.1", port, fetch: committed });

console.log(`evt=landing.serve url=${server.url} mode=${args.includes("--dev") ? "dev" : "committed"} branch=${branch}`);
