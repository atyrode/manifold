type Registry = ReadonlyMap<string, ReadonlySet<string>>;

interface WorkflowJob {
  readonly id: string;
  readonly lines: readonly string[];
}

const groupName = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const selectorName = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]*$/;
const requiredJobSelectors: Readonly<Record<string, string>> = {
  "e2e-rest": "e2e (testkit except preview recovery)",
  "e2e-preview-recovery": "e2e (preview recovery)",
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const literal = (value: string, description: string): string => {
  const parsed = unquote(value);
  if (!selectorName.test(parsed)) {
    throw new Error(`${description} must be a literal name, got: ${value.trim() || "<empty>"}`);
  }
  return parsed;
};

export const parseGateList = (output: string): Registry => {
  const groups = new Map<string, Set<string>>();
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 2) {
      throw new Error(`gate --list line ${index + 1} must be <group>\\t<task>`);
    }
    const group = literal(fields[0] ?? "", `gate --list group on line ${index + 1}`);
    if (!groupName.test(group)) {
      throw new Error(`gate --list group on line ${index + 1} must be a selector name`);
    }
    const task = fields[1] ?? "";
    if (task === "" || task !== task.trim()) {
      throw new Error(`gate --list task on line ${index + 1} must be a non-empty exact name`);
    }
    const tasks = groups.get(group) ?? new Set<string>();
    tasks.add(task);
    groups.set(group, tasks);
  }
  if (groups.size === 0) throw new Error("gate --list returned no groups");
  return groups;
};

const indentation = (line: string): number => line.length - line.trimStart().length;

const workflowJobs = (source: string): WorkflowJob[] => {
  const lines = source.split(/\r?\n/);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsLine < 0) throw new Error("workflow is missing jobs");

  const jobs: WorkflowJob[] = [];
  let current: { id: string; lines: string[] } | undefined;
  for (const line of lines.slice(jobsLine + 1)) {
    if (line.trim() !== "" && indentation(line) === 0) break;
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
    if (header) {
      if (current) jobs.push(current);
      current = { id: header[1]!, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) jobs.push(current);
  if (jobs.length === 0) throw new Error("workflow jobs mapping is empty");
  return jobs;
};

const parseSequenceValue = (value: string, description: string): string[] => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [literal(trimmed, description)];
  }
  const body = trimmed.slice(1, -1).trim();
  if (body === "") throw new Error(`${description} must not be empty`);
  return body.split(",").map((item) => literal(item, description));
};

const keySelections = (
  lines: readonly string[],
  key: string,
  description: string,
  exactIndent?: number,
): string[] => {
  const selections: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (exactIndent !== undefined && indentation(line) !== exactIndent) continue;
    const match = new RegExp(`^\\s*(?:-\\s+)?${key}:\\s*(.*?)\\s*$`).exec(line);
    if (!match) continue;
    const value = match[1]!.replace(/\s+#.*$/, "").trim();
    if (value !== "") {
      selections.push(...parseSequenceValue(value, description));
      continue;
    }

    const keyIndent = indentation(line);
    let found = false;
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child]!;
      if (childLine.trim() === "") continue;
      if (indentation(childLine) <= keyIndent) break;
      const item = /^\s*-\s+(.+?)\s*$/.exec(childLine);
      if (!item) {
        throw new Error(`${description} must be a literal scalar or sequence`);
      }
      selections.push(literal(item[1]!.replace(/\s+#.*$/, ""), description));
      found = true;
    }
    if (!found) throw new Error(`${description} must not be empty`);
  }
  return selections;
};

const scalarJobKey = (job: WorkflowJob, key: string): string | undefined => {
  const prefix = `    ${key}:`;
  const lines = job.lines.filter((line) => line.startsWith(prefix));
  if (lines.length === 0) return undefined;
  if (lines.length > 1) throw new Error(`job ${job.id} has duplicate ${key} keys`);
  return lines[0]!
    .slice(prefix.length)
    .replace(/\s+#.*$/, "")
    .trim();
};

const jobNeeds = (job: WorkflowJob): string[] => {
  const direct = scalarJobKey(job, "needs");
  if (direct === undefined) return [];
  if (direct !== "") return parseSequenceValue(direct, `gate job needs`);
  return keySelections(job.lines, "needs", "gate job needs", 4);
};

export const ciCoverageErrors = (gateListOutput: string, workflowSource: string): string[] => {
  const registry = parseGateList(gateListOutput);
  const jobs = workflowJobs(workflowSource);
  const errors: string[] = [];

  let selectors: string[] = [];
  try {
    selectors = keySelections(
      jobs.flatMap((job) => job.lines),
      "task",
      "workflow task selector",
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const knownTasks = new Set([...registry.values()].flatMap((tasks) => [...tasks]));
  const selected = new Set(selectors);
  for (const selector of selected) {
    if (!registry.has(selector) && !knownTasks.has(selector)) {
      errors.push(`unknown workflow selector: ${selector}`);
    }
  }
  for (const [group, tasks] of registry) {
    if (!selected.has(group) && ![...tasks].every((task) => selected.has(task))) {
      errors.push(`uncovered gate group: ${group}`);
    }
  }

  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const required of ["runtime-jobs", "runtime-browser"]) {
    if (!byId.has(required)) errors.push(`missing required workflow job: ${required}`);
  }
  for (const [jobId, expectedSelector] of Object.entries(requiredJobSelectors)) {
    const job = byId.get(jobId);
    if (!job) {
      errors.push(`missing required workflow job: ${jobId}`);
      continue;
    }
    try {
      const jobSelectors = keySelections(job.lines, "task", `workflow job ${jobId} task selector`);
      if (jobSelectors.length !== 1 || jobSelectors[0] !== expectedSelector) {
        errors.push(`workflow job ${jobId} must select only: ${expectedSelector}`);
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const preview = byId.get("preview-environment");
  if (!preview) {
    errors.push("missing required preview job");
  } else {
    let modes: string[] = [];
    try {
      modes = keySelections(preview.lines, "mode", `preview job ${preview.id} matrix mode`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    for (const mode of ["plain", "integrated"]) {
      if (!modes.includes(mode))
        errors.push(`preview job ${preview.id} missing matrix mode: ${mode}`);
    }
  }

  const gate = byId.get("gate");
  if (!gate) {
    errors.push("missing final gate job");
  } else {
    const condition = unquote(scalarJobKey(gate, "if") ?? "");
    if (condition !== "always()") errors.push("gate job must have if: always()");
    let needs: string[] = [];
    try {
      needs = jobNeeds(gate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    const needed = new Set(needs);
    for (const job of jobs) {
      if (job.id !== "gate" && !needed.has(job.id)) {
        errors.push(`gate job needs missing verification job: ${job.id}`);
      }
    }
  }

  return errors;
};

if (import.meta.main) {
  const repoRoot = new URL("..", import.meta.url);
  const listed = Bun.spawnSync(["bun", "scripts/gate.ts", "--list"], {
    cwd: repoRoot.pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    process.stderr.write(new TextDecoder().decode(listed.stderr));
    process.exit(listed.exitCode);
  }
  const registry = new TextDecoder().decode(listed.stdout);
  const workflow = await Bun.file(new URL(".github/workflows/ci.yml", repoRoot)).text();
  const errors = ciCoverageErrors(registry, workflow);
  if (errors.length > 0) {
    console.error(`ci coverage: RED\n${errors.map((error) => ` - ${error}`).join("\n")}`);
    process.exit(1);
  }
  console.log("ci coverage: GREEN");
}
