/**
 * The repository gate, parallelized.
 *
 * Same checks as the old `&&` chain — nothing is skipped and nothing is scoped down —
 * but the wall time is the SLOWEST task, not the sum. Two facts make that safe:
 * every browser gate is fully isolated (own server on its own port, own data dir,
 * own chromium debug port), and the web bundle they exercise is byte-identical, so
 * it is built ONCE and shared through `MANIFOLD_GATE_DIST` instead of four times.
 *
 * Static checks, unit tests and the testkit e2e run concurrently with that build;
 * the browser gates launch the moment the bundle lands. Output is buffered per task
 * and replayed on completion, so failures read whole instead of interleaved.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const distParent = mkdtempSync(join(tmpdir(), "manifold-gate-"));
const sharedDist = join(distParent, "dist");

interface TaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly output: string;
}

async function run(name: string, cmd: readonly string[], cwd = repoRoot): Promise<TaskResult> {
  const started = performance.now();
  const child = Bun.spawn([...cmd], {
    cwd,
    env: { ...process.env, MANIFOLD_GATE_DIST: sharedDist },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = (performance.now() - started) / 1000;
  const result = { name, ok: exitCode === 0, seconds, output: `${stdout}${stderr}` };
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${name} (${seconds.toFixed(1)}s)`);
  if (!result.ok) console.log(result.output);
  return result;
}

const packages = [
  "protocol",
  "plugin",
  "scene",
  "sdk",
  "server",
  "agent",
  "testkit",
  "web",
  "plugins/shell",
  "plugins/plugin-manager",
  "plugins/terminals",
  "plugins/presence",
  "plugins/machines",
  "plugins/views",
  "plugins/draw",
  "plugins/uri",
];

try {
  const build = run(
    "build:web (shared dist)",
    ["bunx", "vite", "build", "--outDir", sharedDist, "--emptyOutDir"],
    join(repoRoot, "packages", "web"),
  );

  const staticChecks: Promise<TaskResult>[] = [
    run("changelog:check", ["bun", "scripts/generate-web-changelog.ts", "--check"]),
    ...packages.map((name) => run(`tsc ${name}`, ["bunx", "tsc", "-p", `packages/${name}`])),
    run("tsc scripts", ["bunx", "tsc", "-p", "tsconfig.scripts.json"]),
    run("lint", ["bunx", "eslint", "."]),
    run("format:check", ["bunx", "prettier", "--check", "."]),
    run("unit tests", [
      "bun",
      "test",
      ...packages.filter((name) => name !== "testkit").map((name) => `packages/${name}`),
    ]),
    run("e2e (testkit)", ["bun", "test", "packages/testkit", "--timeout", "60000"]),
  ];

  const built = await build;
  const browserGates: Promise<TaskResult>[] = built.ok
    ? [
        run("verify:convergence", ["bun", "scripts/verify-convergence.ts"]),
        run("verify:terminal-selection", ["bun", "scripts/verify-terminal-selection.ts"]),
        run("verify:terminal-mirror", ["bun", "scripts/verify-terminal-mirror.ts"]),
        run("verify:tile-drop", ["bun", "scripts/verify-tile-drop.ts"]),
        run("verify:axioms", ["bun", "scripts/verify-axioms.ts"]),
      ]
    : [];

  const results = [built, ...(await Promise.all([...staticChecks, ...browserGates]))];
  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? "\ngate: GREEN"
      : `\ngate: RED\n${failed.map((result) => ` - ${result.name}`).join("\n")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
} finally {
  rmSync(distParent, { recursive: true, force: true });
}
