import { dirname, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const configs = [...new Bun.Glob("packages/plugins/*/tsconfig.json").scanSync(repoRoot)].sort();

for (const config of configs) {
  console.log(`check: ${dirname(config)}`);
  const child = Bun.spawn(["tsc", "-p", config], {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
