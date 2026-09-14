/**
 * The repository gate, parallelized for one memory-bounded developer machine and selectable
 * by CI from one command registry. With no arguments the phase ordering is deliberately
 * conservative; `--only` lets an isolated CI runner execute one registry slice.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

type Group =
  | "build"
  | "types"
  | "style"
  | "smoke"
  | "trace"
  | "unit"
  | "e2e"
  | "convergence"
  | "terminal-selection"
  | "terminal-mirror"
  | "tile-drop"
  | "budgets"
  | "pwa"
  | "axioms";
type Phase = "prepare" | "build" | "static" | "post-static" | "convergence" | "browser";

interface GateTask {
  readonly name: string;
  readonly group: Group;
  readonly phase: Phase;
  readonly command: (dist: string | null) => readonly string[];
  readonly cwd?: string;
  readonly usesDist?: true;
  readonly retry?: true;
}

interface TaskResult {
  readonly name: string;
  readonly ok: boolean;
  readonly seconds: number;
  readonly output: string;
}

const packages = [
  "protocol",
  "ui",
  "plugin",
  "plugin-kit",
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
  "plugins/notes",
  "plugins/uri",
  "plugins/access",
  "plugins/events",
  "plugins/debug",
  "plugins/brand",
  "plugins/keys",
  "plugins/canvas",
  "plugins/compositions",
  "plugins/arrange",
  "plugins/commands",
] as const;

function fixed(...command: string[]): () => readonly string[] {
  return () => command;
}

/** The sole registry of gate task names, groups, commands, and local scheduling phases. */
const tasks: readonly GateTask[] = [
  {
    name: "changelog:generate",
    group: "build",
    phase: "prepare",
    command: fixed("bun", "scripts/generate-web-changelog.ts"),
  },
  {
    name: "build:web (shared dist)",
    group: "build",
    phase: "build",
    command: (dist) => {
      if (dist === null) throw new Error("the web build requires a dist directory");
      return ["bunx", "vite", "build", "--outDir", dist, "--emptyOutDir"];
    },
    cwd: join(repoRoot, "packages", "web"),
    usesDist: true,
  },
  ...packages.map((name): GateTask => ({
    name: `tsc ${name}`,
    group: "types",
    phase: "static",
    command: fixed("bunx", "tsc", "-p", `packages/${name}`),
  })),
  {
    name: "tsc scripts",
    group: "types",
    phase: "static",
    command: fixed("bunx", "tsc", "-p", "tsconfig.scripts.json"),
  },
  {
    name: "verify:ci-smoke",
    group: "smoke",
    phase: "post-static",
    command: fixed("bun", "scripts/verify-ci-smoke.ts"),
    usesDist: true,
  },
  {
    name: "changelog:check",
    group: "style",
    phase: "static",
    command: fixed("bun", "scripts/generate-web-changelog.ts", "--check"),
  },
  {
    name: "verify:trace",
    group: "trace",
    phase: "static",
    command: fixed("bun", "scripts/verify-trace.ts"),
  },
  { name: "lint", group: "style", phase: "static", command: fixed("bunx", "eslint", ".") },
  {
    name: "format:check",
    group: "style",
    phase: "static",
    command: fixed("bunx", "prettier", "--check", "."),
  },
  {
    name: "unit tests",
    group: "unit",
    phase: "static",
    command: fixed(
      "bun",
      "test",
      "scripts",
      ...packages.filter((name) => name !== "testkit").map((name) => `packages/${name}`),
    ),
  },
  {
    name: "e2e (testkit except preview recovery)",
    group: "e2e",
    phase: "static",
    command: fixed(
      "bun",
      "test",
      "packages/testkit",
      "--test-name-pattern",
      "^(?!a revoked preview browser identity returns through production admission without clearing content$).*$",
      "--timeout",
      "60000",
    ),
    usesDist: true,
  },
  {
    name: "e2e (preview recovery)",
    group: "e2e",
    phase: "post-static",
    command: fixed(
      "bun",
      "test",
      "packages/testkit",
      "--test-name-pattern",
      "^a revoked preview browser identity returns through production admission without clearing content$",
      "--timeout",
      "60000",
    ),
    usesDist: true,
  },
  {
    name: "verify:convergence",
    group: "convergence",
    phase: "convergence",
    command: fixed("bun", "scripts/verify-convergence.ts"),
    usesDist: true,
    retry: true,
  },
  {
    name: "verify:terminal-selection",
    group: "terminal-selection",
    phase: "browser",
    command: fixed("bun", "scripts/verify-terminal-selection.ts"),
    usesDist: true,
  },
  {
    name: "verify:terminal-mirror",
    group: "terminal-mirror",
    phase: "browser",
    command: fixed("bun", "scripts/verify-terminal-mirror.ts"),
    usesDist: true,
  },
  {
    name: "verify:tile-drop",
    group: "tile-drop",
    phase: "browser",
    command: fixed("bun", "scripts/verify-tile-drop.ts"),
    usesDist: true,
  },
  {
    name: "verify:budgets",
    group: "budgets",
    phase: "browser",
    command: fixed("bun", "scripts/verify-budgets.ts"),
    usesDist: true,
  },
  {
    name: "verify:pwa",
    group: "pwa",
    phase: "browser",
    command: fixed("bun", "scripts/verify-pwa.ts"),
    usesDist: true,
  },
  {
    name: "verify:axioms",
    group: "axioms",
    phase: "browser",
    command: fixed("bun", "scripts/verify-axioms.ts"),
    usesDist: true,
  },
];

interface Options {
  readonly list: boolean;
  readonly only: string | null;
  readonly shard: number | null;
}

function usage(message: string): never {
  console.error(
    `gate: ${message}\nusage: bun scripts/gate.ts [--list | --only <group-or-task> [--shard 1/4|2/4|3/4|4/4]]`,
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Options {
  let list = false;
  let only: string | null = null;
  let shard: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") {
      if (list) usage("--list may be specified only once");
      list = true;
      continue;
    }
    if (argument === "--only") {
      if (only !== null) usage("--only may be specified only once");
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) usage("--only requires a value");
      if (value === "") usage("--only requires a non-empty value");
      only = value;
      index += 1;
      continue;
    }
    if (argument === "--shard") {
      if (shard !== null) usage("--shard may be specified only once");
      const value = argv[index + 1];
      const match = value === undefined ? null : /^([1-4])\/4$/.exec(value);
      if (match === null) usage("--shard requires one of 1/4, 2/4, 3/4, or 4/4");
      shard = Number(match[1]);
      index += 1;
      continue;
    }
    usage(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (list && only !== null) usage("--list and --only cannot be combined");
  if (list && shard !== null) usage("--list and --shard cannot be combined");
  if (shard !== null && only !== "types") usage("--shard requires --only types");
  return { list, only, shard };
}

async function run(
  task: GateTask,
  dist: string | null,
  displayName = task.name,
): Promise<TaskResult> {
  const started = performance.now();
  const env = { ...process.env };
  if (task.usesDist === true && dist !== null) env["MANIFOLD_GATE_DIST"] = dist;
  else delete env["MANIFOLD_GATE_DIST"];
  const child = Bun.spawn([...task.command(dist)], {
    cwd: task.cwd ?? repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const seconds = (performance.now() - started) / 1000;
  const result = {
    name: displayName,
    ok: exitCode === 0,
    seconds,
    output: `${stdout}${stderr}`,
  };
  console.log(`${result.ok ? "PASS" : "FAIL"}  ${displayName} (${seconds.toFixed(1)}s)`);
  if (!result.ok) console.log(result.output);
  return result;
}

/** Six-wide locally: compilers, eslint, and Bun tests all have material memory footprints. */
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

async function runWithRetry(task: GateTask, dist: string | null): Promise<TaskResult> {
  const first = await run(task, dist);
  if (first.ok || task.retry !== true) return first;
  return run(task, dist, `${task.name} (retry 1)`);
}

function report(results: readonly TaskResult[]): number {
  const failed = results.filter((result) => !result.ok);
  console.log(
    failed.length === 0
      ? "\ngate: GREEN"
      : `\ngate: RED\n${failed.map((result) => ` - ${result.name}`).join("\n")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.list) {
  for (const task of tasks) console.log(`${task.group}\t${task.name}`);
  process.exit(0);
}

const configuredDist = process.env["MANIFOLD_GATE_DIST"] ?? "";
if (configuredDist !== "" && !isAbsolute(configuredDist)) {
  usage("MANIFOLD_GATE_DIST must be an absolute path");
}
let createdDistParent: string | null = null;
const dist = (): string => {
  if (configuredDist !== "") return configuredDist;
  createdDistParent ??= mkdtempSync(join(tmpdir(), "manifold-gate-"));
  return join(createdDistParent, "dist");
};

async function selected(selector: string): Promise<number> {
  const group = tasks.filter((task) => task.group === selector || task.name === selector);
  if (group.length === 0) usage(`unknown task or group ${JSON.stringify(selector)}`);
  const shard = options.shard;
  const matching =
    shard === null
      ? group
      : group.filter((task, index) => task.group !== "types" || index % 4 === shard - 1);
  const results: TaskResult[] = [];
  // Registry order is significant for the build group: generated history must exist before Vite.
  if (matching.some((task) => task.phase === "build" || task.phase === "prepare")) {
    for (const task of matching) {
      const result = await runWithRetry(task, task.usesDist === true ? dist() : null);
      results.push(result);
      if (!result.ok) break;
    }
  } else {
    const selectedDist = configuredDist === "" ? null : configuredDist;
    if (
      selectedDist !== null &&
      matching.some((task) => task.usesDist === true) &&
      !existsSync(join(selectedDist, "index.html"))
    ) {
      usage(`MANIFOLD_GATE_DIST has no index.html: ${selectedDist}`);
    }
    const regular = matching.filter((task) => task.phase !== "post-static");
    results.push(
      ...(await runLimited(
        6,
        regular.map(
          (task) => () => runWithRetry(task, task.usesDist === true ? selectedDist : null),
        ),
      )),
    );
    for (const task of matching.filter((candidate) => candidate.phase === "post-static")) {
      results.push(await runWithRetry(task, task.usesDist === true ? selectedDist : null));
    }
  }
  return report(results);
}

async function localGate(): Promise<number> {
  const prepare = tasks.find((task) => task.phase === "prepare");
  const build = tasks.find((task) => task.phase === "build");
  if (prepare === undefined || build === undefined)
    throw new Error("gate registry lacks build tasks");

  // Generated history is imported by both the web typecheck and the bundle.
  const generated = await run(prepare, null);
  if (!generated.ok) return report([generated]);

  const sharedDist = dist();
  const building = run(build, sharedDist);
  const staticChecks = runLimited(
    6,
    tasks
      .filter((task) => task.phase === "static")
      .map((task) => () => run(task, task.usesDist === true ? sharedDist : null)),
  );

  const built = await building;
  // Hard drain before Chromium: browser processes beside six compilers exceed the local ceiling.
  const statics = await staticChecks;
  const postStatics: TaskResult[] = [];
  let convergence: TaskResult[] = [];
  let browsers: TaskResult[] = [];
  if (built.ok) {
    const postStaticTasks = tasks.filter((task) => task.phase === "post-static");
    if (postStaticTasks.length === 0) throw new Error("gate registry lacks post-static");
    for (const task of postStaticTasks) postStatics.push(await run(task, sharedDist));
    const convergenceTask = tasks.find((task) => task.phase === "convergence");
    if (convergenceTask === undefined) throw new Error("gate registry lacks convergence");
    convergence = [await runWithRetry(convergenceTask, sharedDist)];
    browsers = await runLimited(
      2,
      tasks.filter((task) => task.phase === "browser").map((task) => () => run(task, sharedDist)),
    );
  }
  return report([built, ...statics, ...postStatics, ...convergence, ...browsers]);
}

let exitCode: number;
try {
  exitCode = options.only === null ? await localGate() : await selected(options.only);
} finally {
  if (createdDistParent !== null) rmSync(createdDistParent, { recursive: true, force: true });
}
process.exit(exitCode);
