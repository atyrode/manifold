import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = join(import.meta.dir, "gate.ts");
const requiredGroups = [
  "build",
  "types",
  "smoke",
  "style",
  "trace",
  "unit",
  "e2e",
  "convergence",
  "terminal-selection",
  "terminal-mirror",
  "tile-drop",
  "budgets",
  "pwa",
  "axioms",
] as const;

interface GateRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface GateInvocation {
  readonly args: readonly string[];
  readonly dist: string;
}

interface SelectedTaskRun {
  readonly result: GateRunResult;
  readonly invocations: readonly GateInvocation[];
  readonly dist: string;
}

async function runGate(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<GateRunResult> {
  const env = { ...process.env };
  delete env["MANIFOLD_GATE_DIST"];
  Object.assign(env, environment);
  const child = Bun.spawn([process.execPath, gate, ...args], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runSelectedTasks(
  selector: string,
  extraArguments: readonly string[] = [],
): Promise<SelectedTaskRun> {
  const root = mkdtempSync(join(tmpdir(), "manifold-gate-test-"));
  const bin = join(root, "bin");
  const dist = join(root, "dist");
  const log = join(root, "invocation.json");
  mkdirSync(bin);
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "");
  const fakeCommand = `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(Bun.env["GATE_TEST_LOG"], JSON.stringify({
  args: Bun.argv.slice(2),
  dist: Bun.env["MANIFOLD_GATE_DIST"],
}) + "\\n");
`;
  for (const executable of ["bun", "bunx"]) {
    writeFileSync(join(bin, executable), fakeCommand, { mode: 0o755 });
  }

  try {
    const result = await runGate(["--only", selector, ...extraArguments], {
      GATE_TEST_LOG: log,
      MANIFOLD_GATE_DIST: dist,
      PATH: bin,
    });
    const invocations = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as GateInvocation);
    return { result, invocations, dist };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("gate CLI", () => {
  test("--list is deterministic, complete, and machine-readable", async () => {
    const [first, second] = await Promise.all([runGate(["--list"]), runGate(["--list"])]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(second.stderr).toBe("");
    expect(second.stdout).toBe(first.stdout);

    const lines = first.stdout.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^[^\t\r\n]+\t[^\t\r\n]+$/);
    expect(new Set(lines).size).toBe(lines.length);
    const taskNames = lines.map((line) => line.slice(line.indexOf("\t") + 1));
    expect(new Set(taskNames).size).toBe(taskNames.length);
    expect(new Set(lines.map((line) => line.slice(0, line.indexOf("\t"))))).toEqual(
      new Set(requiredGroups),
    );
    expect(lines).toContain("types\ttsc plugin-kit");
    expect(lines.filter((line) => line.startsWith("e2e\t"))).toEqual([
      "e2e\te2e (testkit except preview recovery)",
      "e2e\te2e (preview recovery)",
    ]);
  });

  test("smoke is a real registry task that consumes the selected build artifact", async () => {
    const { result, invocations, dist } = await runSelectedTasks("smoke");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(invocations).toEqual([{ args: ["scripts/verify-ci-smoke.ts"], dist }]);
  });

  test("four type shards are disjoint and cover the unsharded registry exactly", async () => {
    const full = await runSelectedTasks("types");
    const shards = await Promise.all(
      ([1, 2, 3, 4] as const).map((shard) => runSelectedTasks("types", ["--shard", `${shard}/4`])),
    );
    const fullCommands = full.invocations.map((invocation) => invocation.args.join("\u0000"));
    const shardCommands = shards.map((result) =>
      result.invocations.map((invocation) => invocation.args.join("\u0000")),
    );
    expect(shardCommands.flat().sort()).toEqual([...fullCommands].sort());
    for (let left = 0; left < shardCommands.length; left += 1) {
      for (let right = left + 1; right < shardCommands.length; right += 1) {
        expect(
          shardCommands[left]?.filter((command) => shardCommands[right]?.includes(command)),
        ).toEqual([]);
      }
    }
  });

  test.each([
    {
      selector: "e2e (testkit except preview recovery)",
      pattern:
        "^(?!a revoked preview browser identity returns through production admission without clearing content$).*$",
    },
    {
      selector: "e2e (preview recovery)",
      pattern:
        "^a revoked preview browser identity returns through production admission without clearing content$",
    },
  ] as const)("--only runs e2e partition %# independently", async ({ selector, pattern }) => {
    const { result, invocations, dist } = await runSelectedTasks(selector);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`PASS  ${selector}`);
    expect(invocations).toEqual([
      {
        args: ["test", "packages/testkit", "--test-name-pattern", pattern, "--timeout", "60000"],
        dist,
      },
    ]);
  });

  test("--only e2e drains the rest partition before preview recovery", async () => {
    const { result, invocations } = await runSelectedTasks("e2e");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(invocations.map((invocation) => invocation.args[3])).toEqual([
      "^(?!a revoked preview browser identity returns through production admission without clearing content$).*$",
      "^a revoked preview browser identity returns through production admission without clearing content$",
    ]);
  });

  test.each([
    [["--only"], "--only requires a value"],
    [["--list", "--list"], "--list may be specified only once"],
    [["--only", "types", "--only", "style"], "--only may be specified only once"],
    [["--list", "--only", "types"], "--list and --only cannot be combined"],
    [["--shard", "1/4"], "--shard requires --only types"],
    [["--only", "style", "--shard", "1/4"], "--shard requires --only types"],
    [["--only", "types", "--shard", "0/4"], "--shard requires one of"],
    [["--only", "types", "--shard", "1/3"], "--shard requires one of"],
    [["--unknown"], 'unknown argument "--unknown"'],
    [["types"], 'unknown argument "types"'],
    [["--only", "not-a-gate-selector"], 'unknown task or group "not-a-gate-selector"'],
  ] as const)("rejects invalid arguments %# with a named diagnostic", async (args, diagnostic) => {
    const result = await runGate(args);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`gate: ${diagnostic}`);
    expect(result.stderr).toContain("usage: bun scripts/gate.ts");
    expect(result.stdout).toBe("");
  });

  test("rejects a relative MANIFOLD_GATE_DIST before starting selected tasks", async () => {
    const result = await runGate(["--only", "types"], {
      MANIFOLD_GATE_DIST: "relative/dist",
      PATH: "",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBe(
      "gate: MANIFOLD_GATE_DIST must be an absolute path\n" +
        "usage: bun scripts/gate.ts [--list | --only <group-or-task> [--shard 1/4|2/4|3/4|4/4]]\n",
    );
    expect(result.stdout).toBe("");
  });
});
