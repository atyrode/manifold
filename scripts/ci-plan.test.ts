/**
 * The CI path filter, and the guard that keeps it honest.
 *
 * Two kinds of test live here and only one of them is about the planner's logic. The other —
 * `findDrift` — is the reason the filter is allowed to exist at all: it reads every script a
 * job runs, pulls out the repository paths and globs that script literally names, and fails
 * when one of them is outside the inputs the planner declared for that job. Without it, a
 * verifier can grow a read, the filter can skip its job on exactly the diff that read was
 * meant to catch, and CI goes green having proved nothing. The negative test below drives the
 * guard with a deliberately incomplete input set so its failure mode is demonstrated rather
 * than assumed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  FORCE_ALL,
  JOB_NAMES,
  JOBS,
  KNOWN_TERRITORY,
  matchesGlob,
  planJobs,
  renderGitHubOutput,
  shouldRun,
  type JobName,
} from "./ci-plan.ts";

const repoRoot = join(import.meta.dir, "..");

/** Untracked or generated top-level names. A literal under one of these is not a PR input. */
const IGNORED_ROOTS: Record<string, true> = {
  ".git": true,
  ".cache": true,
  ".types": true,
  coverage: true,
  data: true,
  dist: true,
  node_modules: true,
};

const rootEntries = new Set(readdirSync(repoRoot));

interface Literal {
  readonly line: number;
  readonly value: string;
}

type Frame =
  | { kind: "template"; buffer: string; line: number; interpolated: boolean }
  | { kind: "code"; depth: number };

/**
 * Every string literal in a TypeScript source, with its line, skipping comments.
 *
 * Hand-written rather than parsed with the compiler because the guard must be cheap enough
 * to run on every `bun test` and because the three things that would wreck a naive scan are
 * all local: comments (a path named in prose is not a read), regular expressions (`/"x"/`
 * would otherwise open a phantom string and desynchronise the rest of the file), and
 * template interpolation (the code inside `${}` is code, and its own literals count). An
 * interpolated template contributes no literal of its own — `${repoRoot}/x` is not a path
 * this guard can resolve — but the expressions inside it are scanned normally.
 */
export function stringLiterals(source: string): Literal[] {
  const found: Literal[] = [];
  const stack: Frame[] = [{ kind: "code", depth: 0 }];
  let index = source.startsWith("#!") ? source.indexOf("\n") : 0;
  let line = index > 0 ? 2 : 1;
  let previous = "";

  const top = (): Frame => stack[stack.length - 1] ?? { kind: "code", depth: 0 };

  while (index < source.length && index >= 0) {
    const frame = top();
    const character = source[index] ?? "";

    if (frame.kind === "template") {
      if (character === "\\") {
        frame.buffer += source[index + 1] ?? "";
        if (source[index + 1] === "\n") line += 1;
        index += 2;
        continue;
      }
      if (character === "`") {
        if (!frame.interpolated) found.push({ line: frame.line, value: frame.buffer });
        stack.pop();
        previous = "`";
        index += 1;
        continue;
      }
      if (character === "$" && source[index + 1] === "{") {
        frame.interpolated = true;
        stack.push({ kind: "code", depth: 0 });
        index += 2;
        continue;
      }
      if (character === "\n") line += 1;
      frame.buffer += character;
      index += 1;
      continue;
    }

    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (character === " " || character === "\t" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    // A `/` after a value is division; after an operator or an opener it starts a regex.
    if (character === "/" && (previous === "" || "([{,;:=!&|?+-*%^~<>".includes(previous))) {
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index] ?? "";
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          index += 1;
          break;
        } else if (inner === "\n") {
          line += 1;
          break;
        }
        index += 1;
      }
      while (index < source.length && /[a-z]/.test(source[index] ?? "")) index += 1;
      previous = "x";
      continue;
    }
    if (character === "`") {
      stack.push({ kind: "template", buffer: "", line, interpolated: false });
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const start = line;
      let buffer = "";
      index += 1;
      while (index < source.length) {
        const inner = source[index] ?? "";
        if (inner === "\\") {
          buffer += source[index + 1] ?? "";
          index += 2;
          continue;
        }
        if (inner === quote) {
          index += 1;
          break;
        }
        if (inner === "\n") {
          line += 1;
          break;
        }
        buffer += inner;
        index += 1;
      }
      found.push({ line: start, value: buffer });
      previous = quote;
      continue;
    }
    if (character === "{") {
      if (frame.kind === "code") frame.depth += 1;
    } else if (character === "}") {
      if (frame.kind === "code") {
        if (frame.depth === 0 && stack.length > 1) {
          stack.pop();
          index += 1;
          previous = "}";
          continue;
        }
        frame.depth -= 1;
      }
    }
    previous = character;
    index += 1;
  }
  return found;
}

/** `import { x } from "./y.ts"` — the local modules a script pulls in. */
function localImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/from\s+"\.\/([A-Za-z0-9_.-]+)"/g)) {
    const name = match[1];
    if (name !== undefined) out.push(`scripts/${name}`);
  }
  return [...new Set(out)];
}

/** Does this literal name a place in the repository, rather than being ordinary text? */
function isRepoPath(value: string): boolean {
  if (value === "" || value.startsWith("/") || /\s/.test(value)) return false;
  const segments = value.split("/");
  const head = segments[0] ?? "";
  if (!rootEntries.has(head) || IGNORED_ROOTS[head] === true) return false;
  return segments.every(
    (segment, position) =>
      /^[A-Za-z0-9_@.+*-]+$/.test(segment) || (segment === "" && position === segments.length - 1),
  );
}

/**
 * Concrete paths that must be covered for a literal to count as declared.
 *
 * A literal is a file, a directory the script walks, or a glob it scans, and coverage has to
 * be decided for all three. Directories and globs are probed with invented names — both a
 * shallow and a deep one, because `packages/**` and `packages/*` are different promises and
 * only the first covers a nested file.
 */
function probesFor(literal: string): string[] {
  const path = literal.endsWith("/") ? literal.slice(0, -1) : literal;
  if (path.includes("*")) {
    const expand = (deep: string): string =>
      path
        .split("/")
        .map((segment) => (segment === "**" ? deep : segment.replace(/\*/g, "probe")))
        .join("/");
    return [...new Set([expand("depth0"), expand("depth0/depth1")])];
  }
  if (existsSync(join(repoRoot, path)) && statSync(join(repoRoot, path)).isDirectory()) {
    return [`${path}/probe.ts`, `${path}/depth0/probe.ts`];
  }
  return [path];
}

interface GuardSubject {
  readonly inputs: readonly string[];
  readonly scripts: readonly string[];
  readonly half?: "S" | "R" | undefined;
}

/** Labels like `S1 server assembly` / `R4 divider drag commits once` in verify-axioms.ts. */
const CHECK_LABEL = /^([SR])\d+\s/;

/**
 * Every read a job's scripts perform that the job has not declared, as `script:line` lines.
 *
 * Empty is the only acceptable answer for the real `JOBS` table. The function takes its
 * subjects as an argument precisely so a test can hand it a broken table and watch it fail.
 */
export function findDrift(subjects: Readonly<Record<string, GuardSubject>>): string[] {
  const findings: string[] = [];
  for (const job of Object.keys(subjects)) {
    const spec = subjects[job];
    if (spec === undefined) continue;
    for (const script of spec.scripts) {
      const source = readFileSync(join(repoRoot, script), "utf8");
      let half: "S" | "R" | null = null;
      for (const literal of stringLiterals(source)) {
        const label = CHECK_LABEL.exec(literal.value);
        if (label !== null) {
          half = label[1] === "S" ? "S" : "R";
          continue;
        }
        // A read before the first label is module prologue and belongs to both halves.
        if (spec.half !== undefined && half !== null && half !== spec.half) continue;
        if (!isRepoPath(literal.value)) continue;
        const uncovered = probesFor(literal.value).find(
          (probe) => !spec.inputs.some((glob) => matchesGlob(glob, probe)),
        );
        if (uncovered !== undefined) {
          findings.push(
            `${script}:${String(literal.line)} reads ${JSON.stringify(literal.value)}, which job "${job}" does not declare`,
          );
        }
      }
    }
  }
  return findings;
}

function running(changed: readonly string[]): JobName[] {
  const plan = planJobs(changed);
  return JOB_NAMES.filter((name) => plan.jobs[name]);
}

describe("planJobs", () => {
  test("a documentation-only change still runs the two gates that read documentation", () => {
    const plan = planJobs(["docs/decisions/0032-bun-version.md", "docs/PLAN.md"]);

    expect(plan.failSafe).toBe(false);
    expect(plan.jobs.axioms_static).toBe(true);
    expect(plan.jobs.budgets).toBe(true);
    // ...and nothing that a prose diff cannot reach.
    expect(plan.jobs.unit).toBe(false);
    expect(plan.jobs.e2e).toBe(false);
    expect(plan.jobs.types).toBe(false);
    expect(plan.jobs.convergence).toBe(false);
    expect(plan.jobs.preview).toBe(false);
    expect(running(["docs/PLAN.md"])).toEqual(["build", "style", "axioms_static", "budgets"]);
  });

  test("a REGISTRY.md-only change runs the axioms and budget gates", () => {
    const plan = planJobs(["REGISTRY.md"]);

    expect(plan.failSafe).toBe(false);
    expect(plan.jobs.budgets).toBe(true);
    expect(plan.jobs.axioms_static).toBe(true);
    // verify-axioms.ts:236 reads REGISTRY.md at module scope, before --static/--browser
    // selects a half, so the browser half depends on it too.
    expect(plan.jobs.axioms_browser).toBe(true);
    expect(plan.jobs.unit).toBe(false);
  });

  test("a path the planner has no rule for forces every job", () => {
    for (const stranger of ["services/edge/main.ts", "Makefile", "deploy/terraform/main.tf"]) {
      const plan = planJobs([stranger]);
      expect(plan.failSafe).toBe(true);
      expect(plan.reason).toContain(stranger);
      expect(JOB_NAMES.filter((name) => !plan.jobs[name])).toEqual([]);
    }
  });

  test("one unknown path in an otherwise ordinary diff still forces every job", () => {
    const plan = planJobs(["docs/PLAN.md", "packages/web/src/app.tsx", "Makefile"]);
    expect(plan.failSafe).toBe(true);
    expect(JOB_NAMES.filter((name) => !plan.jobs[name])).toEqual([]);
  });

  test("an empty diff is absence of evidence, not evidence of absence", () => {
    for (const empty of [[], ["", "   "]]) {
      const plan = planJobs(empty);
      expect(plan.failSafe).toBe(true);
      expect(JOB_NAMES.filter((name) => !plan.jobs[name])).toEqual([]);
    }
  });

  test("a change to the gate's own machinery forces every job", () => {
    const machinery = [
      "scripts/ci-plan.ts",
      "scripts/ci-plan.test.ts",
      "scripts/gate.ts",
      "scripts/gate-lib.ts",
      "scripts/install-runtime-ci.sh",
      ".github/workflows/ci.yml",
      ".github/actions/setup/action.yml",
      "package.json",
      "packages/web/package.json",
      "bun.lock",
      "tsconfig.base.json",
      "packages/server/tsconfig.json",
      "patches/@xterm%2Fxterm@6.0.0.patch",
    ];
    for (const path of machinery) {
      const plan = planJobs([path]);
      expect(`${path}: ${String(plan.failSafe)}`).toBe(`${path}: true`);
      expect(JOB_NAMES.filter((name) => !plan.jobs[name])).toEqual([]);
    }
  });

  test("no consumer of the shared web bundle is ever planned without the build", () => {
    const consumers: readonly JobName[] = [
      "runtime_browser",
      "axioms_browser",
      "terminal_selection",
      "terminal_mirror",
      "tile_drop",
      "pwa",
      "budgets",
    ];
    expect(consumers).toHaveLength(7);
    // Both directions, so a consumer added to the table without being added here fails too.
    expect(JOB_NAMES.filter((name) => JOBS[name].needs.includes("build"))).toEqual([...consumers]);
    // `preview` builds its own environment image and is passed no bundle; it stays edge-free.
    expect(JOBS.preview.needs).toEqual([]);
    // The invariant, exercised rather than asserted about the table: drive the planner with
    // one representative path per declared input of every consumer and check it holds.
    const probes = new Set<string>();
    for (const consumer of consumers) {
      for (const glob of JOBS[consumer].inputs)
        for (const probe of probesFor(glob)) probes.add(probe);
    }
    for (const probe of probes) {
      const plan = planJobs([probe]);
      const broken = consumers.filter((name) => plan.jobs[name] && !plan.jobs.build);
      expect(`${probe}: ${broken.join(",")}`).toBe(`${probe}: `);
    }
  });

  test("an unrecognised job name is run, never skipped", () => {
    const plan = planJobs(["docs/PLAN.md"]);
    expect(shouldRun(plan, "a_job_added_after_this_filter_was_written")).toBe(true);
    expect(shouldRun(plan, "axioms_static")).toBe(true);
    expect(shouldRun(plan, "unit")).toBe(false);
  });

  test("the GitHub output names every job exactly once, as true or false", () => {
    const lines = renderGitHubOutput(planJobs(["docs/PLAN.md"])).split("\n");
    expect(lines).toHaveLength(JOB_NAMES.length);
    expect(lines.map((line) => line.split("=")[0])).toEqual([...JOB_NAMES]);
    expect(lines.every((line) => /=(?:true|false)$/.test(line))).toBe(true);
    expect(lines).toContain("axioms_static=true");
    expect(lines).toContain("unit=false");
  });

  test("style is unconditional and must stay that way", () => {
    // `eslint .` and `prettier --check .` take the whole tree as their subject, so there is
    // no safe filter for them. This test exists so that narrowing `style` later is a visible
    // decision rather than a quiet one.
    expect(JOBS.style.inputs).toEqual(["**"]);
    for (const path of [
      "docs/PLAN.md",
      "LICENSE",
      ".env.example",
      "packages/ui/src/pad.tsx",
      "changes/492-ci-fanout.md",
      "infra/Caddyfile.example",
    ]) {
      expect(`${path}: ${String(planJobs([path]).jobs.style)}`).toBe(`${path}: true`);
    }
  });
});

describe("the drift guard", () => {
  test("every path a job's scripts read is covered by that job's declared inputs", () => {
    expect(findDrift(JOBS)).toEqual([]);
  });

  test("it names the script, the line and the path when a read is undeclared", () => {
    // verify-budgets.ts:80 reads its ceilings out of REGISTRY.md. This is the drift the
    // guard exists for: a plausible-looking input set that covers the code the gate drives
    // and forgets the document it grades against.
    const findings = findDrift({
      budgets: {
        inputs: ["packages/**", "scripts/verify-budgets.ts"],
        scripts: ["scripts/verify-budgets.ts"],
      },
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/^scripts\/verify-budgets\.ts:\d+ reads "REGISTRY\.md"/);
    expect(findings[0]).toContain('job "budgets" does not declare');
  });

  test("it catches a documentation tree that a job stopped declaring", () => {
    const { inputs, scripts, half } = JOBS.axioms_static;
    const findings = findDrift({
      axioms_static: { inputs: inputs.filter((glob) => glob !== "docs/**"), scripts, half },
    });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join("\n")).toContain('reads "docs"');
  });

  test("every local module a script imports is declared beside it by some job", () => {
    const declared = new Set<string>();
    for (const name of JOB_NAMES) for (const script of JOBS[name].scripts) declared.add(script);

    const orphans: string[] = [];
    for (const script of declared) {
      for (const imported of localImports(readFileSync(join(repoRoot, script), "utf8"))) {
        const together = JOB_NAMES.some(
          (name) => JOBS[name].scripts.includes(script) && JOBS[name].scripts.includes(imported),
        );
        if (!together)
          orphans.push(`${script} imports ${imported}, which no job declares beside it`);
      }
    }
    expect(orphans).toEqual([]);
  });

  test("the scanner ignores comments and regular expressions and reads inside interpolation", () => {
    const source = [
      "// REGISTRY.md",
      "/* docs/PLAN.md */",
      'const re = /"AXIOMS.md"/;',
      'const a = "packages/server/src/main.ts";',
      "const b = `${read('docs/TRIAGE.md')}/tail`;",
      "const c = `changes`;",
    ].join("\n");

    expect(stringLiterals(source).map((literal) => literal.value)).toEqual([
      "packages/server/src/main.ts",
      "docs/TRIAGE.md",
      "changes",
    ]);
  });
});

describe("the rules stay attached to the repository", () => {
  test("every declared script exists", () => {
    const missing: string[] = [];
    for (const name of JOB_NAMES) {
      for (const script of JOBS[name].scripts) {
        if (!existsSync(join(repoRoot, script))) missing.push(`${name}: ${script}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every literal input path and territory rule points at something real", () => {
    const dead: string[] = [];
    for (const name of JOB_NAMES) {
      for (const glob of JOBS[name].inputs) {
        if (glob.includes("*")) continue;
        if (!existsSync(join(repoRoot, glob))) dead.push(`${name}: ${glob}`);
      }
    }
    for (const rule of [...KNOWN_TERRITORY, ...FORCE_ALL]) {
      const head = rule.split("/")[0] ?? "";
      if (head.includes("*")) continue;
      if (!existsSync(join(repoRoot, head))) dead.push(`territory: ${rule}`);
    }
    expect(dead).toEqual([]);
  });
});

describe("the command line", () => {
  const run = (
    args: readonly string[],
    stdin: string,
  ): { code: number; out: string; err: string } => {
    const result = Bun.spawnSync(
      [process.execPath, join(repoRoot, "scripts/ci-plan.ts"), ...args],
      {
        cwd: repoRoot,
        stdin: new TextEncoder().encode(stdin),
      },
    );
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  };

  test("--github-output reads a newline-separated diff on stdin", () => {
    const { code, out, err } = run(["--github-output"], "docs/PLAN.md\nREGISTRY.md\n");
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toContain("axioms_static=true");
    expect(out.trim().split("\n")).toContain("unit=false");
    expect(err).toContain("changed path(s) require");
  });

  test("--changed prints the plan as JSON", () => {
    const { code, out } = run(["--changed", "packages/web/src/app.tsx"], "");
    expect(code).toBe(0);
    const parsed: unknown = JSON.parse(out);
    expect(parsed).toMatchObject({ failSafe: false, jobs: { unit: true, build: true } });
  });

  test("--all turns every output on and emits the SAME key set as a diffed run", () => {
    const all = run(["--all", "--github-output"], "");
    const diffed = run(["--github-output"], "docs/PLAN.md\n");

    expect(all.code).toBe(0);
    const allLines = all.out.trim().split("\n");
    expect(allLines).toEqual(JOB_NAMES.map((name) => `${name}=true`));

    // The property the workflow's `if:` depends on: a job whose output key is absent on one
    // trigger type would read as an empty string, and an empty string is not `true`.
    const keys = (output: string): string[] =>
      output
        .trim()
        .split("\n")
        .map((line) => line.split("=")[0] ?? "");
    expect(keys(all.out)).toEqual(keys(diffed.out));
    expect(keys(all.out)).toEqual([...JOB_NAMES]);
    expect(all.err).toContain("no base to diff against");
  });

  test("--all ignores stdin rather than letting a stale diff narrow it", () => {
    const { code, out } = run(["--all", "--json"], "docs/PLAN.md\n");
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { jobs: Record<string, boolean>; failSafe: boolean };
    expect(parsed.failSafe).toBe(true);
    expect(Object.values(parsed.jobs).filter((value) => !value)).toEqual([]);
  });

  test("an unknown flag is an error, not an empty plan", () => {
    const { code, err } = run(["--only-fast"], "");
    expect(code).not.toBe(0);
    expect(err).toContain("unknown argument --only-fast");
  });
});
