#!/usr/bin/env bun
/**
 * Which CI jobs a pull request actually has to run.
 *
 * A path filter is a SECOND specification of what every check depends on, written in a
 * different file from the check itself. That is the whole danger: a verifier grows a read,
 * nobody updates the filter, and the job it belongs to is skipped on exactly the diff it
 * was meant to catch. CI goes green having proved nothing, and nothing announces it. So
 * three properties hold this file up, and none of them is optional:
 *
 *   1. Every `inputs` list below is DERIVED from what the script really reads, and every
 *      entry carries the `path:line` it was derived from. Two reads in particular are
 *      counter-intuitive and are the reason a "docs-only" pull request is not a cheap one:
 *      `verify-budgets.ts` reads its ceilings out of REGISTRY.md (verify-budgets.ts:80),
 *      and `verify-axioms.ts` reads AXIOMS.md, REGISTRY.md, AGENTS.md, CHANGELOG.md,
 *      README.md and the whole `docs` tree (verify-axioms.ts:1515-1524).
 *   2. It fails SAFE in three directions: an unrecognised path runs everything, a change to
 *      the gate's own machinery runs everything, and an unrecognised job name is run rather
 *      than skipped (`shouldRun`). Widening an input set costs a runner; narrowing one costs
 *      a proof, so every judgement call below is resolved by widening.
 *   3. `ci-plan.test.ts` carries the drift guard: it scans each declared script for the
 *      repo paths and globs it literally references and fails, naming `script:line`, when one
 *      falls outside the declared inputs of a job that runs that script. That test is the
 *      mechanism; this file is only its subject.
 *
 * CLI. Three shapes, because CI has trigger types that have no base to diff against:
 *
 *   git diff --name-only "$BASE...HEAD" | bun scripts/ci-plan.ts --github-output
 *   bun scripts/ci-plan.ts --all --github-output
 *   bun scripts/ci-plan.ts --changed docs/PLAN.md --json
 *
 * Paths come from stdin (newline-separated) unless `--changed` supplies them or `--all`
 * makes them irrelevant. `--json` prints the whole plan object, including the reason, and is
 * the default. `--github-output` prints `name=value` lines for `$GITHUB_OUTPUT` — one line
 * per job, `true` or `false`, nothing else, so the workflow can gate on them without
 * parsing. The reason goes to stderr in that mode, where it lands in the run log instead of
 * in the output file. An unknown flag is an error: a typo'd flag must never be read as
 * "plan everything off".
 *
 * THE OUTPUT NAME SET IS THE SAME ON EVERY PATH. `renderGitHubOutput` iterates `JOB_NAMES`,
 * never the plan, so every job is emitted on every run whatever the trigger; there is no
 * branch that can produce a shorter key set. The workflow's half of that bargain is to
 * spell the gate as `if: needs.plan.outputs.<job> != 'false'`, so that a missing or empty
 * output — a renamed job, a step that failed before writing, a typo in the `if:` — RUNS the
 * job. Skipping must be something this planner says out loud, never something a blank says
 * for it.
 */

/** One CI job. The names are the `$GITHUB_OUTPUT` keys the workflow reads. */
export type JobName =
  | "build"
  | "types"
  | "style"
  | "unit"
  | "e2e"
  | "trace"
  | "runtime_jobs"
  | "runtime_browser"
  | "convergence"
  | "axioms_static"
  | "axioms_browser"
  | "terminal_selection"
  | "terminal_mirror"
  | "tile_drop"
  | "pwa"
  | "budgets"
  | "preview";

export interface JobSpec {
  /** Repo-relative globs whose change makes this job necessary. */
  readonly inputs: readonly string[];
  /** Jobs that MUST run whenever this one does. Closed transitively by `planJobs`. */
  readonly needs: readonly JobName[];
  /**
   * The TypeScript this job executes — its entry point and the local modules it pulls in.
   * The drift guard scans exactly these files against `inputs`, so a module listed here is
   * a promise that this job's inputs cover everything that module reads.
   */
  readonly scripts: readonly string[];
  /**
   * For a script whose assertions are labelled `S<n>` (static) and `R<n>` (browser) —
   * today only `verify-axioms.ts`, split by `--static` / `--browser` — the half this job
   * runs. The guard attributes a literal to the nearest preceding label; a literal that
   * precedes every label is module prologue and belongs to BOTH halves, which is the safe
   * way to be wrong about it.
   */
  readonly half?: "S" | "R";
}

/**
 * The product itself.
 *
 * Every gate that boots the server, the agent or the web bundle is a claim about the WHOLE
 * composed product: the server assembles every plugin package at start (verify-axioms.ts:440,
 * "S1 server assembly"), so `packages/plugins/notes` is as load-bearing for a terminal gate as
 * `packages/server` is. Scoping these jobs to a subtree would mean inventing a dependency
 * graph the code does not have, and the first time that invention was wrong it would be wrong
 * silently.
 */
const RUNTIME = "packages/**";

/**
 * The prose the repository holds itself to.
 *
 * `verify-axioms.ts` reads all of it — the `docs` tree plus the five root documents
 * (verify-axioms.ts:1515-1524) — and grades the source against it. `verify-budgets.ts` reads
 * only the fenced `budgets` block in REGISTRY.md (verify-budgets.ts:80), but its inputs are
 * deliberately wider than that one read: a budget is a DOCUMENTED promise, the number in
 * REGISTRY.md and the sentence in `docs/**` that justifies it are edited in the same breath,
 * and a "documentation-only" diff that quietly relaxes a ceiling is the precise failure this
 * gate exists to catch. These two jobs are the ones a docs diff must never skip.
 */
const PROSE = [
  "AXIOMS.md",
  "REGISTRY.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "README.md",
  "docs/**",
] as const;

/**
 * The gates' shared bootstrap: the PASS/FAIL line and polls (`gate-lib.ts`), the browser
 * driver on top of it (`cdp.ts`), and the shared web bundle resolver (`gate-dist.ts`).
 * `gate-lib.ts` and `gate-dist.ts` also match `scripts/gate*.ts` in FORCE_ALL, so a change
 * to either runs everything anyway; they are named here so the drift guard still checks that
 * what they read is covered.
 */
const SHARED_GATE_SCRIPTS = [
  "scripts/cdp.ts",
  "scripts/gate-dist.ts",
  "scripts/gate-lib.ts",
] as const;

/**
 * Inputs and script graph per job.
 *
 * Derivation, in short (the full table with evidence lives in the pull request):
 *  - build            package.json:36 `changelog:generate && vite build`; the generator reads
 *                     CHANGELOG.md and `changes` (generate-web-changelog.ts:20-22) and writes
 *                     packages/web/src/generated-changelog.ts, which the bundle imports.
 *  - types            package.json:13 typechecks every package plus `tsconfig.scripts.json`
 *                     (include: ["scripts"], tsconfig.scripts.json:8) and runs check-plugins.ts.
 *  - style            package.json:31-33 `eslint .` and `prettier --check .` — every tracked
 *                     file is a subject, so this job's input is the repository.
 *  - unit / e2e       package.json:14-15, the package test trees.
 *  - trace            verify-trace.ts:63 globs packages/server/src/**\/*.ts and boots the server.
 *  - runtime_*        verify-runtime.sh:98,101,104 compile packages/agent/test/fixtures/*.c;
 *                     verify-runtime.sh:135-136 exec `verify:jobs` / `verify:jobs:browser`;
 *                     verify-jobs.ts:46-51 runs six agent and testkit test files.
 *  - convergence      boots the server (verify-convergence.ts:50) against the web bundle.
 *  - axioms_static    verify-axioms.ts:1515-1524 (packages, scripts, docs, five root .md),
 *                     :2288-2292 (Dockerfile, compose.yaml, flake.nix, infra/**,
 *                     .github/workflows/**), :2337 the generated decisions index.
 *  - axioms_browser   the R-half drives the real app (verify-axioms.ts:5423 packs the kit's
 *                     fixture plugin); REGISTRY.md is read at module scope (:236), before
 *                     either half, so it counts for both.
 *  - terminal_* /
 *    tile_drop / pwa  a server plus real Chromium over the shared bundle.
 *  - budgets          verify-budgets.ts:80 REGISTRY.md, plus the server and the bundle.
 *  - preview          verify-preview-environment.ts:664 copies infra/previews fixtures,
 *                     :1362 reads the fixture Dockerfile, :281 uses scripts/build-identity.ts.
 */
export const JOBS: Readonly<Record<JobName, JobSpec>> = {
  build: {
    inputs: [
      RUNTIME,
      "CHANGELOG.md",
      "changes/**",
      // release-core.ts:150 names README.md while walking `changes`. It excludes rather than
      // reads it — but declaring it costs one cheap job on a README diff, and an exception
      // list is exactly where drift hides, so it is declared instead of exempted.
      "README.md",
      "scripts/generate-web-changelog.ts",
      "scripts/release-core.ts",
    ],
    needs: [],
    scripts: ["scripts/generate-web-changelog.ts", "scripts/release-core.ts"],
  },
  types: {
    inputs: [RUNTIME, "scripts/**", "CHANGELOG.md", "changes/**", "README.md"],
    needs: [],
    scripts: [
      "scripts/generate-web-changelog.ts",
      "scripts/release-core.ts",
      "scripts/check-plugins.ts",
    ],
  },
  style: {
    // `prettier --check .` and `eslint .` take the whole tree as their subject, so this job
    // has no diff that can skip it. It is also the cheapest job on the board.
    inputs: ["**"],
    needs: [],
    scripts: [],
  },
  unit: {
    // No bundle: nothing under `bun test packages/*` drives a browser. Measured, not assumed
    // — all four unit shards passed twice with no dist supplied.
    inputs: [RUNTIME],
    needs: [],
    scripts: [],
  },
  e2e: {
    inputs: [RUNTIME],
    /*
      The testkit e2e cases DO drive a browser, and the way they fail without a bundle is a
      trap rather than an obvious missing dependency. `gate.ts`'s `run()` sets
      MANIFOLD_GATE_DIST for every task, and `gate-dist.ts:18-21` treats a non-empty env var
      as "a bundle already exists here" and returns it WITHOUT building. So the danger is an
      empty-but-SET dist path, not an unset one: the tests serve an empty directory, the page
      is blank, and the failure surfaces as `condition not met within 10000ms` rather than as
      anything that mentions the bundle. A full local `bun run gate` hides it, because the
      concurrent build fills that same directory in time.
     */
    needs: ["build"],
    scripts: [],
  },
  trace: {
    inputs: [RUNTIME, "scripts/verify-trace.ts", "scripts/gate-lib.ts"],
    needs: [],
    scripts: ["scripts/verify-trace.ts", "scripts/gate-lib.ts"],
  },
  runtime_jobs: {
    inputs: [
      RUNTIME,
      "scripts/verify-jobs.ts",
      "scripts/verify-runtime.sh",
      "scripts/install-runtime-ci.sh",
    ],
    needs: [],
    scripts: ["scripts/verify-jobs.ts"],
  },
  runtime_browser: {
    inputs: [
      RUNTIME,
      "scripts/verify-jobs-browser.ts",
      "scripts/verify-runtime.sh",
      "scripts/install-runtime-ci.sh",
      ...SHARED_GATE_SCRIPTS,
    ],
    // The sandboxed browser proof now consumes the shared bundle rather than building a
    // fifth copy of it inside its own systemd unit: CI downloads the `web-dist` artifact and
    // hands it over as MANIFOLD_GATE_DIST, which verify-jobs-browser.ts documents as an
    // override for exactly that. The self-build at gate-dist.ts:23-31 stays as the standalone
    // fallback, but in CI this job cannot start before `build`, so the plan must say so.
    needs: ["build"],
    scripts: ["scripts/verify-jobs-browser.ts", ...SHARED_GATE_SCRIPTS],
  },
  convergence: {
    inputs: [RUNTIME, "scripts/verify-convergence.ts", ...SHARED_GATE_SCRIPTS],
    needs: [],
    scripts: ["scripts/verify-convergence.ts", ...SHARED_GATE_SCRIPTS],
  },
  axioms_static: {
    inputs: [
      RUNTIME,
      "scripts/**",
      ...PROSE,
      "infra/**",
      ".github/workflows/**",
      "Dockerfile",
      "compose.yaml",
      "flake.nix",
    ],
    needs: [],
    scripts: ["scripts/verify-axioms.ts", "scripts/decisions-index.ts", "scripts/gate-lib.ts"],
    half: "S",
  },
  axioms_browser: {
    // The R-half drives the running product, so its inputs are the product — plus REGISTRY.md,
    // which verify-axioms.ts:236 reads at module scope before either half is selected.
    inputs: [RUNTIME, "REGISTRY.md", "scripts/verify-axioms.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-axioms.ts", ...SHARED_GATE_SCRIPTS],
    half: "R",
  },
  terminal_selection: {
    inputs: [RUNTIME, "scripts/verify-terminal-selection.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-terminal-selection.ts", ...SHARED_GATE_SCRIPTS],
  },
  terminal_mirror: {
    inputs: [RUNTIME, "scripts/verify-terminal-mirror.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-terminal-mirror.ts", ...SHARED_GATE_SCRIPTS],
  },
  tile_drop: {
    inputs: [RUNTIME, "scripts/verify-tile-drop.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-tile-drop.ts", ...SHARED_GATE_SCRIPTS],
  },
  pwa: {
    inputs: [RUNTIME, "scripts/verify-pwa.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-pwa.ts", ...SHARED_GATE_SCRIPTS],
  },
  budgets: {
    inputs: [RUNTIME, ...PROSE, "scripts/verify-budgets.ts", ...SHARED_GATE_SCRIPTS],
    needs: ["build"],
    scripts: ["scripts/verify-budgets.ts", ...SHARED_GATE_SCRIPTS],
  },
  preview: {
    inputs: [
      RUNTIME,
      "infra/**",
      "Dockerfile",
      "compose.yaml",
      "scripts/verify-preview-environment.ts",
      "scripts/build-identity.ts",
      "scripts/cdp.ts",
      "scripts/gate-lib.ts",
    ],
    // Builds its own environment image; it never reads the shared vite dist.
    needs: [],
    scripts: ["scripts/verify-preview-environment.ts", "scripts/cdp.ts", "scripts/gate-lib.ts"],
  },
};

/** Declaration order is the order `--github-output` emits, so the workflow diffs cleanly. */
export const JOB_NAMES = Object.keys(JOBS) as readonly JobName[];

/**
 * A change here means the plan itself, the runner, the dependency set or the toolchain is in
 * question — and a filter cannot be trusted to scope a change to the thing that computes the
 * scope. Everything runs.
 */
export const FORCE_ALL: readonly string[] = [
  "scripts/ci-plan.ts",
  "scripts/ci-plan.test.ts",
  "scripts/gate*.ts",
  "scripts/install-runtime-ci.sh",
  ".github/workflows/**",
  ".github/actions/**",
  "**/package.json",
  "**/tsconfig*.json",
  "bun.lock",
  "bunfig.toml",
  "patches/**",
  "flake.nix",
  "flake.lock",
];

/**
 * Every path class this planner has actually reasoned about.
 *
 * A changed path outside this list is a part of the repository the filter has never seen —
 * a new top-level directory, a new root-level file — and the only honest answer to "which
 * jobs does that affect?" is "all of them". This is deliberately a separate list from the
 * jobs' inputs: `style` claims the whole tree, so matching against inputs would mean nothing
 * is ever a stranger and this defence would be dead on arrival.
 */
export const KNOWN_TERRITORY: readonly string[] = [
  "packages/**",
  "scripts/**",
  "docs/**",
  "changes/**",
  "infra/**",
  "patches/**",
  ".github/**",
  "AGENTS.md",
  "AXIOMS.md",
  "CHANGELOG.md",
  "README.md",
  "REGISTRY.md",
  "SECURITY.md",
  "LICENSE",
  "Dockerfile",
  "compose.yaml",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  "flake.lock",
  "flake.nix",
  "eslint.config.js",
  ".prettierrc.json",
  ".gitignore",
  ".dockerignore",
  ".env.example",
  "tsconfig.base.json",
  "tsconfig.scripts.json",
];

export interface JobPlan {
  readonly jobs: Readonly<Record<JobName, boolean>>;
  /** True when a fail-safe rule fired: every job is on regardless of what the diff said. */
  readonly failSafe: boolean;
  /** One line, for the run log. Why this plan looks the way it does. */
  readonly reason: string;
}

const compiled = new Map<string, RegExp>();

function segmentToSource(segment: string): string {
  let out = "";
  for (const character of segment) {
    if (character === "*") out += "[^/]*";
    else if (character === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".includes(character)) out += `\\${character}`;
    else out += character;
  }
  return out;
}

/**
 * Matches a repo-relative path against one glob. `**` spans any number of segments, `*` and
 * `?` stay inside one. Deliberately small: a dependency here would be a dependency the CI
 * plan has to install before it can decide whether to install anything.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  let regex = compiled.get(pattern);
  if (regex === undefined) {
    const segments = pattern.split("/");
    let source = "";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] ?? "";
      const last = index === segments.length - 1;
      if (segment === "**") {
        source += last ? "(?:[^/]+(?:/[^/]+)*)?" : "(?:[^/]+/)*";
        continue;
      }
      source += segmentToSource(segment);
      if (!last) source += "/";
    }
    regex = new RegExp(`^${source}$`);
    compiled.set(pattern, regex);
  }
  return regex.test(path);
}

function normalise(changedPaths: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of changedPaths) {
    const trimmed = raw.trim().replace(/^\.\//, "");
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/**
 * Every job on, with the reason it happened. Four of this planner's five exits are this one:
 * an empty diff, a change to the machinery, a stranger path, and `--all` for the triggers
 * (push, merge_group, workflow_dispatch) that have no base to diff against.
 */
export function planEverything(reason: string): JobPlan {
  const jobs = {} as Record<JobName, boolean>;
  for (const name of JOB_NAMES) jobs[name] = true;
  return { jobs, failSafe: true, reason };
}

/**
 * The plan. Pure: no git, no filesystem, no environment — the CLI at the bottom of this file
 * is the only thing that touches any of those, so a test can drive every branch directly.
 */
export function planJobs(changedPaths: readonly string[]): JobPlan {
  const paths = normalise(changedPaths);

  // An empty diff is not evidence that nothing changed; it is the absence of evidence.
  if (paths.length === 0) return planEverything("no changed paths were supplied");

  const forced = paths.find((path) => FORCE_ALL.some((glob) => matchesGlob(glob, path)));
  if (forced !== undefined) return planEverything(`${forced} changes the gate's own machinery`);

  const stranger = paths.find((path) => !KNOWN_TERRITORY.some((glob) => matchesGlob(glob, path)));
  if (stranger !== undefined) {
    return planEverything(`${stranger} matches no rule this planner knows`);
  }

  const jobs = {} as Record<JobName, boolean>;
  for (const name of JOB_NAMES) {
    jobs[name] = paths.some((path) => JOBS[name].inputs.some((glob) => matchesGlob(glob, path)));
  }

  // A plan that skips a producer while a consumer runs is not a cheaper plan, it is a broken
  // one: the six browser gates read ONE shared vite bundle. Closed to a fixed point so an
  // added edge never has to be ordered by hand.
  for (;;) {
    let grew = false;
    for (const name of JOB_NAMES) {
      if (!jobs[name]) continue;
      for (const need of JOBS[name].needs) {
        if (!jobs[need]) {
          jobs[need] = true;
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  const running = JOB_NAMES.filter((name) => jobs[name]);
  return {
    jobs,
    failSafe: false,
    reason: `${String(paths.length)} changed path(s) require ${String(running.length)} of ${String(JOB_NAMES.length)} job(s): ${running.join(", ") || "none"}`,
  };
}

/**
 * Whether a named job runs. An unrecognised name is RUN, never skipped: the one thing worse
 * than a slow gate is a gate that quietly stopped covering a job someone renamed.
 */
export function shouldRun(plan: JobPlan, job: string): boolean {
  return plan.jobs[job as JobName] ?? true;
}

/** `name=value` lines for `$GITHUB_OUTPUT`, one per job, in declaration order. */
export function renderGitHubOutput(plan: JobPlan): string {
  return JOB_NAMES.map((name) => `${name}=${String(plan.jobs[name])}`).join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const changed: string[] = [];
  let explicit = false;
  let everything = false;
  let githubOutput = false;
  let collecting = false;

  for (const argument of argv) {
    if (argument === "--changed") {
      explicit = true;
      collecting = true;
      continue;
    }
    if (argument === "--all") {
      everything = true;
      collecting = false;
      continue;
    }
    if (argument === "--github-output") {
      githubOutput = true;
      collecting = false;
      continue;
    }
    if (argument === "--json") {
      githubOutput = false;
      collecting = false;
      continue;
    }
    if (argument.startsWith("-") || !collecting) {
      process.stderr.write(
        `ci-plan: unknown argument ${argument}\n` +
          "usage: ci-plan.ts [--all | --changed <path>...] [--json | --github-output]\n",
      );
      return 2;
    }
    changed.push(argument);
  }

  if (!everything && !explicit) {
    if (process.stdin.isTTY === true) {
      process.stderr.write("ci-plan: no --all, no --changed paths and nothing on stdin\n");
      return 2;
    }
    changed.push(...(await Bun.stdin.text()).split("\n"));
  }

  const plan = everything
    ? planEverything("--all: this trigger has no base to diff against")
    : planJobs(changed);
  if (githubOutput) {
    process.stderr.write(`ci-plan: ${plan.reason}\n`);
    process.stdout.write(`${renderGitHubOutput(plan)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
