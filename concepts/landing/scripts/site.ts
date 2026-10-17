// A lab tree built as a static site: what serve.ts serves for a commit and what scripts/ab.ts
// renders from two trees. The lab page, the GPU timing page in trees that have it, and the build
// worker beside them.
import { join } from "node:path";

/** A lab tree that could not be extracted or built. */
export class SiteBuildError extends Error {}

/** The site's pages: the lab, and the GPU timing page (bench.html) once a tree has it. */
export const PAGES = ["index.html", "bench.html"] as const;

/**
 * Builds the lab tree at `source` (a concepts/landing directory) into `outdir`, for `publicPath`.
 * The pages share their chunks, and each scene's code is a chunk of its own, loaded once the scene
 * is needed (src/scenes/index.ts `loadScene`).
 */
export async function buildSite(source: string, outdir: string, publicPath: string): Promise<void> {
  const pages: string[] = [];
  for (const page of PAGES) {
    if (await Bun.file(join(source, page)).exists()) pages.push(join(source, page));
  }
  const result = await Bun.build({
    entrypoints: pages,
    outdir,
    publicPath,
    minify: true,
    splitting: true,
  });
  if (!result.success) throw new SiteBuildError(result.logs.map(String).join("\n"));
  // The build worker, at the site's root beside the pages: where the page loads it from, under
  // serve.ts at the commit's pinned path even for the head (`/@<sha>/build-worker.js`,
  // src/sims/build.ts). A tree without one is built without it.
  const worker = join(source, "src", "build-worker.ts");
  if (!(await Bun.file(worker).exists())) return;
  const built = await Bun.build({
    entrypoints: [worker],
    outdir,
    naming: "build-worker.js",
    minify: true,
  });
  if (!built.success) throw new SiteBuildError(built.logs.map(String).join("\n"));
}

/** Extracts commit `sha`'s concepts/landing from the repository `repo` under `root`; returns it. */
export async function extractTree(repo: string, sha: string, root: string): Promise<string> {
  const archive = Bun.spawn(["git", "-C", repo, "archive", sha, "concepts/landing"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const untar = Bun.spawn(["tar", "-x", "-C", root], { stdin: archive.stdout });
  if ((await archive.exited) !== 0 || (await untar.exited) !== 0) {
    const said = (await new Response(archive.stderr).text()).trim();
    throw new SiteBuildError(`could not extract ${sha.slice(0, 8)}: ${said}`);
  }
  return join(root, "concepts", "landing");
}
