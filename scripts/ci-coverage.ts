/**
 * Proves the CI workflow still runs every task the gate knows about.
 *
 * The gate's task registry (scripts/gate.ts) is the authority on what must be verified; the
 * workflow is a schedule for it. Fanning the gate across runners introduces the one failure
 * this repository cannot tolerate: a task that exists, passes locally, and is quietly absent
 * from CI. A missing job is not a red build — it is a green one that checked less.
 *
 * So this reads BOTH sides from source and compares them. The gate's groups come from
 * `gate.ts --list`, and the covered set comes from the `--only` arguments actually written in
 * the workflow file. There is no third list to keep in step: add a task group and CI fails
 * here until a job runs it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const workflow = join(repoRoot, ".github", "workflows", "ci.yml");

interface Registered {
  readonly group: string;
  readonly name: string;
}

function registry(): readonly Registered[] {
  const listed = Bun.spawnSync(["bun", "scripts/gate.ts", "--list"], { cwd: repoRoot });
  if (!listed.success) {
    throw new Error(`gate --list failed: ${listed.stderr.toString()}`);
  }
  return listed.stdout
    .toString()
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line) => {
      const [group = "", name = ""] = line.split("\t");
      return { group, name };
    });
}

/**
 * Every group or task the workflow selects.
 *
 * Jobs name their slice through the `gate-slice` action's `task:` input rather than writing
 * `--only` themselves, so that is the form read here; a bare `--only` is read too, for a job
 * that calls the gate directly. A `task:` whose value is a `${{ }}` expression is NOT
 * resolved — it is reported as uncovered rather than guessed at, because a wrong guess here
 * would manufacture exactly the false confidence this script exists to prevent.
 */
function selectedTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const match of text.matchAll(/--only\s+([A-Za-z0-9:,_-]+)/g)) {
    for (const token of (match[1] ?? "").split(",")) if (token !== "") tokens.add(token);
  }
  for (const match of text.matchAll(/^\s*task:\s*(\S+)\s*$/gm)) {
    const value = (match[1] ?? "").replace(/^["']|["']$/g, "");
    if (value !== "" && !value.includes("${{")) tokens.add(value);
  }
  return tokens;
}

const tasks = registry();
const text = readFileSync(workflow, "utf8");
const tokens = selectedTokens(text);
const groups = [...new Set(tasks.map((task) => task.group))];

const uncovered = groups.filter((group) => {
  if (tokens.has(group)) return false;
  // A group is also covered when every one of its tasks is named individually.
  const members = tasks.filter((task) => task.group === group);
  return !members.every((task) => tokens.has(task.name));
});

// A token naming nothing is the same defect seen from the other side: a job that believes it
// is running a check, spelled so that the gate refuses it.
const unknown = [...tokens].filter(
  (token) => !groups.includes(token) && !tasks.some((task) => task.name === token),
);

for (const group of groups) {
  const covered = !uncovered.includes(group);
  console.log(`${covered ? "PASS" : "FAIL"}  ${group}`);
}
if (uncovered.length > 0) {
  console.error(`\nci-coverage: no CI job runs ${uncovered.join(", ")}`);
}
if (unknown.length > 0) {
  console.error(`\nci-coverage: workflow selects unknown task or group ${unknown.join(", ")}`);
}
if (uncovered.length > 0 || unknown.length > 0) process.exit(1);
console.log(`\nci-coverage: ${groups.length} gate groups all scheduled`);
