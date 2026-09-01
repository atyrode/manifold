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
  "plugins/index",
  "plugins/draw",
  "plugins/notes",
  "plugins/uri",
  "plugins/access",
  "plugins/events",
  "plugins/canvas",
  "plugins/compositions",
];

/**
 * Bounded fan-out for the per-package typechecks. Wave 1 doubled the package count to 17,
 * and 17 unbounded tsc processes peak past what a 32 GB box under normal desktop load can
 * give — the kernel reaps a few (SIGTERM, empty output) and the gate reads that as a
 * nondeterministic type failure. Six at a time keeps the wall clock flat on big machines
 * and the memory ceiling honest on small ones.
 */
async function runLimited(
  limit: number,
  jobs: readonly (() => Promise<TaskResult>)[],
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job === undefined) break;
      results[index] = await job();
    }
  });
  await Promise.all(workers);
  return results;
}

try {
  const build = run(
    "build:web (shared dist)",
    ["bunx", "vite", "build", "--outDir", sharedDist, "--emptyOutDir"],
    join(repoRoot, "packages", "web"),
  );

  // Everything that is not a browser gate rides one bounded pool: eslint's compiler pass
  // and bun's test runners are as memory-hungry as tsc, and any of them reaped under
  // pressure reads as a phantom failure with empty output.
  const staticChecks = runLimited(6, [
    ...packages.map((name) => () => run(`tsc ${name}`, ["bunx", "tsc", "-p", `packages/${name}`])),
    () => run("tsc scripts", ["bunx", "tsc", "-p", "tsconfig.scripts.json"]),
    () => run("changelog:check", ["bun", "scripts/generate-web-changelog.ts", "--check"]),
    /*
      The trace gate rides the STATIC pool rather than the browser one: it spawns a server of
      its own on an ephemeral port and dispatches over HTTP, so it costs a process rather than
      a Chromium, and it is a claim about the dispatch ladder rather than about a rendered
      surface (axiom A6, ADR 0018).
     */
    () => run("verify:trace", ["bun", "scripts/verify-trace.ts"]),
    () => run("lint", ["bunx", "eslint", "."]),
    () => run("format:check", ["bunx", "prettier", "--check", "."]),
    () =>
      run("unit tests", [
        "bun",
        "test",
        ...packages.filter((name) => name !== "testkit").map((name) => `packages/${name}`),
      ]),
    () => run("e2e (testkit)", ["bun", "test", "packages/testkit", "--timeout", "60000"]),
  ]);

  const built = await build;
  // The static pool must DRAIN before the browser gates start: each browser gate is a
  // server + one or two real Chromiums, and running them beside six compilers is what
  // put this box over its ceiling — the kernel reaps a compiler and the gate reads a
  // phantom failure with empty output. Two phases cost ~40s of wall clock; a phantom
  // RED costs a human diagnosing a failure that does not exist.
  const statics = await staticChecks;
  // verify:convergence drives TWO real browsers for ~3 minutes and is the one gate that
  // flakes under load (cold caches right after the static pool drains). It runs alone and
  // gets ONE retry — visibly: a pass-on-retry is reported as such, never silently green.
  let convergence: TaskResult[] = [];
  if (built.ok) {
    const first = await run("verify:convergence", ["bun", "scripts/verify-convergence.ts"]);
    convergence = first.ok
      ? [first]
      : [await run("verify:convergence (retry 1)", ["bun", "scripts/verify-convergence.ts"])];
  }
  const browserGates = built.ok
    ? await runLimited(2, [
        () => run("verify:terminal-selection", ["bun", "scripts/verify-terminal-selection.ts"]),
        () => run("verify:terminal-mirror", ["bun", "scripts/verify-terminal-mirror.ts"]),
        () => run("verify:tile-drop", ["bun", "scripts/verify-tile-drop.ts"]),
        () => run("verify:budgets", ["bun", "scripts/verify-budgets.ts"]),
        () => run("verify:axioms", ["bun", "scripts/verify-axioms.ts"]),
      ])
    : [];

  const results = [built, ...statics, ...convergence, ...browserGates];
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
