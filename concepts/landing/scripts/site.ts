// A lab tree built as a static site: what serve.ts serves for a commit and what scripts/ab.ts
// renders from two trees. The lab page, the GPU timing page in trees that have it, and the sheet
// worker beside them (trees before it have none).
import { join } from "node:path";

/** A lab tree that could not be extracted or built. */
export class SiteBuildError extends Error {}

/** The site's pages: the lab, and the GPU timing page (bench.html) once a tree has it. */
export const PAGES = ["index.html", "bench.html"] as const;

/** Builds the lab tree at `source` (a concepts/landing directory) into `outdir`, for `publicPath`. */
export async function buildSite(source: string, outdir: string, publicPath: string): Promise<void> {
  const pages: string[] = [];
  for (const page of PAGES) {
    if (await Bun.file(join(source, page)).exists()) pages.push(join(source, page));
  }
  const result = await Bun.build({ entrypoints: pages, outdir, publicPath, minify: true });
  if (!result.success) throw new SiteBuildError(result.logs.map(String).join("\n"));
  // The page's worker, next to it: the build worker, or in trees before it the sheet worker.
  for (const name of ["build-worker", "sheet-worker"]) {
    const worker = join(source, "src", `${name}.ts`);
    if (!(await Bun.file(worker).exists())) continue;
    const built = await Bun.build({
      entrypoints: [worker],
      outdir,
      naming: `${name}.js`,
      minify: true,
    });
    if (!built.success) throw new SiteBuildError(built.logs.map(String).join("\n"));
  }
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
