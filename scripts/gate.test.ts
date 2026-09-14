import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const gate = join(import.meta.dir, "gate.ts");
const requiredGroups = [
  "build",
  "types",
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

async function runGate(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
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
    expect(new Set(lines.map((line) => line.slice(0, line.indexOf("\t"))))).toEqual(
      new Set(requiredGroups),
    );
    expect(lines).toContain("types\ttsc plugin-kit");
  });

  test.each([
    [["--only"], "--only requires a value"],
    [["--list", "--list"], "--list may be specified only once"],
    [["--only", "types", "--only", "style"], "--only may be specified only once"],
    [["--list", "--only", "types"], "--list and --only cannot be combined"],
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
        "usage: bun scripts/gate.ts [--list | --only <group-or-task>]\n",
    );
    expect(result.stdout).toBe("");
  });
});
