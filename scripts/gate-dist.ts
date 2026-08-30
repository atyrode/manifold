import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The web bundle a verify gate runs against.
 *
 * Standalone, a gate builds its own throwaway bundle — self-contained stays true.
 * Under the orchestrator (`scripts/gate.ts`), every gate reads ONE shared build via
 * `MANIFOLD_GATE_DIST`: the four browser gates each rebuilding an identical bundle
 * was most of the old gate's wall time. Gates only ever READ the dist (servers serve
 * it), so sharing is safe, and `cleanup` removes only what THIS run built.
 */
export function resolveWebDist(prefix: string): {
  readonly distDir: string;
  readonly cleanup: () => void;
} {
  const shared = process.env["MANIFOLD_GATE_DIST"] ?? "";
  if (shared !== "") {
    return { distDir: shared, cleanup: () => undefined };
  }
  const repoRoot = join(import.meta.dir, "..");
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const distDir = join(parent, "dist");
  const build = Bun.spawnSync(["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"], {
    cwd: join(repoRoot, "packages", "web"),
    stdout: "ignore",
    stderr: "inherit",
  });
  if (!build.success) throw new Error("web build failed");
  return {
    distDir,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}
