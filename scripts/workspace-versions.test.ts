import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("workspace metadata admission covers non-release and versionless packages", () => {
  const root = mkdtempSync(join(tmpdir(), "manifold-workspace-versions-"));
  const workspaces: Record<string, { version?: string }> = {
    "": {},
    "packages/ui": { version: "0.1.0" },
    "packages/web": { version: "0.17.0" },
    "packages/agent": {},
  };
  const saveLock = () => writeFileSync(join(root, "bun.lock"), JSON.stringify({ workspaces }));
  const check = () =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "workspace-versions.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
    for (const [name, version] of [
      ["ui", "0.1.1"],
      ["web", "0.17.0"],
      ["agent", undefined],
    ] as const) {
      const directory = join(root, "packages", name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
    }
    saveLock();
    expect(check().exitCode).toBe(1);

    workspaces["packages/ui"] = { version: "0.1.1" };
    saveLock();
    expect(check().exitCode).toBe(0);

    workspaces["packages/agent"] = { version: "0.0.0" };
    saveLock();
    expect(check().exitCode).toBe(1);

    workspaces["packages/agent"] = {};
    saveLock();
    expect(check().exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
