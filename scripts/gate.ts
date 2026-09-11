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
 *
 * Run with no arguments this schedules every task in phases sized for ONE developer box.
 * CI has no such ceiling — it has a runner per job — so it selects slices of the same
 * registry instead:
 *
 *     bun scripts/gate.ts --list-groups            the slices CI is expected to cover
 *     bun scripts/gate.ts --only types             every tsc, plus changelog:check
 *     bun scripts/gate.ts --only unit --shard 2/4 --parallel
 *
 * The point of the registry is that there is exactly one definition of what each task
 * RUNS. A CI job that invoked `bun test` itself would drift from this file the first time
 * a flag changed here, and nothing would notice.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirs, typecheckProjects, unitTestProjects } from "./packages.ts";

const repoRoot = join(import.meta.dir, "..");
const distParent = mkdtempSync(join(tmpdir(), "manifold-gate-"));
const sharedDist = join(distParent, "dist");
/**
 * A bundle CI already built and handed over as an artifact. When it is set nothing here
 * rebuilds: the browser gates read it exactly as they read a locally built one.
 */
const externalDist = process.env["MANIFOLD_GATE_DIST"] ?? "";
const distDir = externalDist === "" ? sharedDist : externalDist;
/**
 * Whether anything in THIS invocation will put a bundle at {@link distDir}.
 *
 * Only then may the path be advertised to a task. gate-dist.ts reads a set
 * MANIFOLD_GATE_DIST as "a bundle already exists here" and serves it without building, so
 * pointing a task at an empty directory does not fall back — it silently serves nothing,
 * and a browser gate reads a blank page instead of the app. A full run always builds, which
 * is why this only ever bit a selected slice.
 */
let distPromised = externalDist !== "";

interface TaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly output: string;
}

/**
 * `group` is the CI-job granularity: one slice per runner. `needsDist` marks the gates that
 * read the web bundle, so selecting one without a prebuilt bundle builds it first rather
 * than failing deep inside a browser. `retry` marks the one task allowed a second attempt.
 *
 * Two tasks can subdivide themselves across runners, by different means, because their work
 * has different shapes. `shardable` splits a test suite by FILE, which is safe because bun
 * gives each shard its own process. `groupable` splits verify:convergence by dependency
 * CLOSURE, because its rounds are one chain of shared scene state — round N drags what
 * round N-1 created — so only a closed group can be lifted out and still mean anything.
 */
interface Task {
  readonly name: string;
  readonly group: string;
  readonly cmd: readonly string[];
  readonly cwd?: string;
  readonly needsDist?: true;
  readonly shardable?: true;
  readonly groupable?: true;
  readonly parallelizable?: true;
  readonly retry?: true;
}

async function run(name: string, cmd: readonly string[], cwd = repoRoot): Promise<TaskResult> {
  const started = performance.now();
  const child = Bun.spawn([...cmd], {
    cwd,
    env:
      distPromised || name === buildTask.name
        ? { ...process.env, MANIFOLD_GATE_DIST: distDir }
        : // Standalone: let the task build its own throwaway bundle, as gate-dist documents.
          { ...process.env, MANIFOLD_GATE_DIST: "" },
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

const buildTask: Task = {
  name: "build:web (shared dist)",
  group: "build",
  // Into the shared location, whether that is this run's temp dir or the path CI handed over.
  // Selecting `build` on its own is how CI produces the bundle it then gives every gate.
  cmd: ["bunx", "vite", "build", "--outDir", distDir, "--emptyOutDir"],
  cwd: join(repoRoot, "packages", "web"),
};

/**
 * Every task the gate knows how to run. `verify:axioms` appears as two entries because it
 * IS two gates in one file: a pure static pass over the axiom registry, and a browser pass.
 * Splitting them lets the cheap half report in seconds instead of queueing behind Chromium.
 */
const tasks: readonly Task[] = [
  buildTask,
  ...typecheckProjects.map((name): Task => ({
    name: `tsc ${name}`,
    group: "types",
    cmd: ["bunx", "tsc", "-p", `packages/${name}`],
  })),
  { name: "tsc scripts", group: "types", cmd: ["bunx", "tsc", "-p", "tsconfig.scripts.json"] },
  {
    name: "changelog:check",
    group: "types",
    cmd: ["bun", "scripts/generate-web-changelog.ts", "--check"],
  },
  /*
    The trace gate rides the STATIC pool rather than the browser one: it spawns a server of
    its own on an ephemeral port and dispatches over HTTP, so it costs a process rather than
    a Chromium, and it is a claim about the dispatch ladder rather than about a rendered
    surface (axiom A6, ADR 0018).
   */
  { name: "verify:trace", group: "trace", cmd: ["bun", "scripts/verify-trace.ts"] },
  { name: "lint", group: "style", cmd: ["bunx", "eslint", "."] },
  { name: "format:check", group: "style", cmd: ["bunx", "prettier", "--check", "."] },
  {
    name: "unit tests",
    group: "unit",
    cmd: ["bun", "test", ...projectDirs(unitTestProjects)],
    shardable: true,
    parallelizable: true,
  },
  {
    name: "e2e (testkit)",
    group: "e2e",
    cmd: ["bun", "test", "packages/testkit", "--timeout", "60000"],
    shardable: true,
  },
  {
    name: "verify:convergence",
    group: "convergence",
    cmd: ["bun", "scripts/verify-convergence.ts"],
    needsDist: true,
    groupable: true,
    retry: true,
  },
  {
    name: "verify:axioms (static)",
    group: "axioms-static",
    cmd: ["bun", "scripts/verify-axioms.ts", "--static"],
  },
  {
    name: "verify:axioms (browser)",
    group: "axioms-browser",
    cmd: ["bun", "scripts/verify-axioms.ts", "--browser"],
    needsDist: true,
  },
  {
    name: "verify:terminal-selection",
    group: "browser",
    cmd: ["bun", "scripts/verify-terminal-selection.ts"],
    needsDist: true,
  },
  {
    name: "verify:terminal-mirror",
    group: "browser",
    cmd: ["bun", "scripts/verify-terminal-mirror.ts"],
    needsDist: true,
  },
  {
    name: "verify:tile-drop",
    group: "browser",
    cmd: ["bun", "scripts/verify-tile-drop.ts"],
    needsDist: true,
  },
  {
    name: "verify:budgets",
    group: "browser",
    cmd: ["bun", "scripts/verify-budgets.ts"],
    needsDist: true,
  },
  { name: "verify:pwa", group: "browser", cmd: ["bun", "scripts/verify-pwa.ts"], needsDist: true },
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

interface Selection {
  readonly only: readonly string[];
  readonly shard: string | null;
  readonly roundGroup: string | null;
  readonly parallel: boolean;
  readonly concurrency: number | null;
}

function usage(message: string): never {
  console.error(`gate: ${message}
usage: bun scripts/gate.ts [--only <group|task>[,...]] [--shard i/n] [--group <name>]
                           [--parallel] [--concurrency n] [--list] [--list-groups]`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Selection | "list" | "list-groups" {
  const only: string[] = [];
  let shard: string | null = null;
  let roundGroup: string | null = null;
  let parallel = false;
  let concurrency: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) usage(`${arg} needs a value`);
      index += 1;
      return value;
    };
    if (arg === "--list") return "list";
    if (arg === "--list-groups") return "list-groups";
    else if (arg === "--only") only.push(...next().split(",").filter(Boolean));
    else if (arg === "--shard") shard = next();
    else if (arg === "--group") roundGroup = next();
    else if (arg === "--parallel") parallel = true;
    else if (arg === "--concurrency") concurrency = Number.parseInt(next(), 10);
    else usage(`unrecognised argument ${JSON.stringify(arg)}`);
  }
  if (shard !== null && !/^\d+\/\d+$/.test(shard)) usage("--shard takes i/n, e.g. 2/4");
  if (concurrency !== null && (!Number.isInteger(concurrency) || concurrency < 1)) {
    usage("--concurrency takes a positive integer");
  }
  // A modifier with nothing selected would be silently ignored, and a CI job that believes
  // it is running shard 2 of 4 while actually running the whole gate is worse than a failure.
  if (only.length === 0 && (shard !== null || roundGroup !== null || parallel)) {
    usage("--shard, --group and --parallel apply to a selection; pass --only");
  }
  return { only, shard, roundGroup, parallel, concurrency };
}

/** The command a task runs once sharding, round grouping and parallelism are applied. */
function commandFor(task: Task, selection: Selection): readonly string[] {
  const extra: string[] = [];
  if (selection.shard !== null) {
    if (task.shardable !== true) usage(`${task.name} cannot be sharded`);
    extra.push(`--shard=${selection.shard}`);
  }
  if (selection.roundGroup !== null) {
    if (task.groupable !== true) usage(`${task.name} has no round groups`);
    // Two arguments, not `--group=x`: verify-convergence.ts refuses the equals form, and a
    // gate that passes a flag its own task rejects is a fan-out that verifies nothing.
    extra.push("--group", selection.roundGroup);
  }
  if (selection.parallel) {
    if (task.parallelizable !== true) usage(`${task.name} cannot be run with --parallel`);
    extra.push("--parallel");
  }
  return [...task.cmd, ...extra];
}

async function runTask(task: Task, selection: Selection): Promise<TaskResult[]> {
  const first = await run(task.name, commandFor(task, selection), task.cwd ?? repoRoot);
  if (first.ok || task.retry !== true) return [first];
  // A pass-on-retry is reported as such, never silently green.
  return [await run(`${task.name} (retry 1)`, commandFor(task, selection), task.cwd ?? repoRoot)];
}

function report(results: readonly TaskResult[]): never {
  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? "\ngate: GREEN"
      : `\ngate: RED\n${failed.map((result) => ` - ${result.name}`).join("\n")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

const parsed = parseArgs(process.argv.slice(2));
try {
  if (parsed === "list") {
    for (const task of tasks) console.log(`${task.group}\t${task.name}`);
    process.exit(0);
  }
  if (parsed === "list-groups") {
    for (const group of [...new Set(tasks.map((task) => task.group))]) console.log(group);
    process.exit(0);
  }

  // The in-app history is untracked and generated from CHANGELOG.md + changes/*.md: the web
  // typecheck and the shared bundle both import it, so it is produced before either starts.
  const generated = await run("changelog:generate", ["bun", "scripts/generate-web-changelog.ts"]);
  if (!generated.ok) {
    console.log("\ngate: RED\n - changelog:generate");
    process.exit(1);
  }

  if (parsed.only.length > 0) {
    // Selected slice: one CI runner's worth. No phase drain and no pool ceiling — the whole
    // machine is this slice's, and the memory argument below is about sharing one desktop.
    const wanted = new Set(parsed.only);
    const selected = tasks.filter((task) => wanted.has(task.group) || wanted.has(task.name));
    const unknown = parsed.only.filter(
      (name) => !tasks.some((task) => task.group === name || task.name === name),
    );
    // Selecting nothing must never read as success: that is how a check silently stops running.
    if (unknown.length > 0) usage(`no such task or group: ${unknown.join(", ")}`);
    if (selected.length === 0) usage("--only selected no tasks");

    const results: TaskResult[] = [];
    // Build when asked to, and also when a selected gate needs a bundle nobody handed over.
    const buildSelected = selected.some((task) => task.group === "build");
    const needsBuild = selected.some((task) => task.needsDist === true) && externalDist === "";
    distPromised = distPromised || buildSelected || needsBuild;
    if (buildSelected || needsBuild) {
      // The build takes none of the selection's modifiers: `--group ink` describes the
      // convergence rounds to run, not how to build a bundle, and handing it on would make
      // the build refuse a flag it has no opinion about.
      const built = await runTask(buildTask, {
        ...parsed,
        shard: null,
        roundGroup: null,
        parallel: false,
      });
      results.push(...built);
      if (built.some((result) => !result.ok)) report(results);
    }
    const limit = parsed.concurrency ?? Math.max(1, availableParallelism());
    results.push(
      ...(
        await runLimited(
          limit,
          selected
            .filter((task) => task.group !== "build")
            .map((task) => () => runTask(task, parsed).then((list) => list[list.length - 1]!)),
        )
      ).flat(),
    );
    report(results);
  }

  const groupTasks = (group: string): readonly Task[] =>
    tasks.filter((task) => task.group === group);
  const noSelection: Selection = {
    only: [],
    shard: null,
    roundGroup: null,
    parallel: false,
    concurrency: null,
  };
  // A full run always produces the shared bundle, so every task may be told where it is.
  distPromised = true;
  const build =
    externalDist === ""
      ? run(buildTask.name, buildTask.cmd, buildTask.cwd)
      : Promise.resolve({ name: buildTask.name, ok: true, seconds: 0, output: "" });

  // Everything that is not a browser gate rides one bounded pool: eslint's compiler pass
  // and bun's test runners are as memory-hungry as tsc, and any of them reaped under
  // pressure reads as a phantom failure with empty output.
  const staticChecks = runLimited(
    6,
    ["types", "trace", "style", "unit", "e2e", "axioms-static"]
      .flatMap((group) => groupTasks(group))
      .map((task) => () => run(task.name, task.cmd, task.cwd)),
  );

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
    for (const task of groupTasks("convergence")) {
      convergence = [...convergence, ...(await runTask(task, noSelection))];
    }
  }
  const browserGates = built.ok
    ? await runLimited(
        2,
        [...groupTasks("browser"), ...groupTasks("axioms-browser")].map(
          (task) => () => run(task.name, task.cmd, task.cwd),
        ),
      )
    : [];

  report([built, ...statics, ...convergence, ...browserGates]);
} finally {
  rmSync(distParent, { recursive: true, force: true });
}
