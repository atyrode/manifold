import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const versionMetadata = z.object({ version: z.string().optional() });
const lockMetadata = z.object({ workspaces: z.record(z.string(), versionMetadata) });

/** Bun owns workspace resolution; this checks the versions in its generated metadata. */
export async function assertWorkspaceVersions(directory = process.cwd()): Promise<void> {
  const root = await realpath(directory);
  const source: unknown = Bun.JSONC.parse(await Bun.file(join(root, "bun.lock")).text());
  const { workspaces } = lockMetadata.parse(source);
  if (!Object.hasOwn(workspaces, "")) throw new Error("bun.lock is missing its root workspace");

  for (const [workspace, locked] of Object.entries(workspaces)) {
    const candidate = resolve(root, workspace, "package.json");
    const path = relative(root, candidate);
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
      throw new Error(`Workspace metadata leaves the repository: ${JSON.stringify(workspace)}`);
    }
    const manifestPath = await realpath(candidate);
    const actualPath = relative(root, manifestPath);
    if (isAbsolute(actualPath) || actualPath === ".." || actualPath.startsWith(`..${sep}`)) {
      throw new Error(`Workspace manifest leaves the repository: ${JSON.stringify(workspace)}`);
    }
    const manifest: unknown = await Bun.file(manifestPath).json();
    if (locked.version !== versionMetadata.parse(manifest).version) {
      throw new Error(
        `bun.lock workspace ${JSON.stringify(workspace || ".")} has stale version metadata; run bun install and verify the regenerated lock before committing`,
      );
    }
  }
}

if (import.meta.main) {
  await assertWorkspaceVersions();
  console.log("workspace versions: consistent");
}
