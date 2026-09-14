import { ALL_CHECKS, EXTRA_CHECKS, MANDATORY_CHECKS } from "./ci-plan.ts";

type Registry = ReadonlyMap<string, ReadonlySet<string>>;
type YamlMap = { [key: string]: unknown };

const expectedChecks = [
  "build",
  "types",
  "style",
  "smoke",
  "targeted",
  "trace",
  "unit",
  "e2e-rest",
  "e2e-preview-recovery",
  "convergence",
  "terminal-selection",
  "terminal-mirror",
  "tile-drop",
  "budgets",
  "pwa",
  "axioms",
  "runtime-jobs",
  "runtime-browser",
  "preview-environment",
] as const;
const expectedMandatory = ["build", "types", "style", "smoke", "targeted"] as const;
const e2eSelectors: Readonly<Record<string, string>> = {
  "e2e-rest": "e2e (testkit except preview recovery)",
  "e2e-preview-recovery": "e2e (preview recovery)",
};

const isMap = (value: unknown): value is YamlMap =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const map = (value: unknown, description: string): YamlMap => {
  if (!isMap(value)) throw new Error(`${description} must be a mapping`);
  return value;
};

const childMap = (parent: YamlMap, key: string, description: string): YamlMap =>
  map(parent[key], description);

const optionalChildMap = (
  parent: YamlMap,
  key: string,
  description: string,
): YamlMap | undefined => {
  const value = parent[key];
  return value === undefined ? undefined : map(value, description);
};

const sequence = (value: unknown, description: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${description} must be a sequence`);
  return value;
};

const strings = (value: unknown, description: string): string[] => {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error(`${description} must be a non-empty string or sequence`);
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== "string")
      throw new Error(`${description} must be a non-empty string or sequence`);
    result.push(item);
  }
  return result;
};

const workflowErrors = (source: string, inspect: (workflow: YamlMap) => string[]): string[] => {
  try {
    return inspect(parseWorkflow(source));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
};

export const parseGateList = (output: string): Registry => {
  const groups = new Map<string, Set<string>>();
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields.length !== 2 || !fields[0] || !fields[1] || fields[1] !== fields[1].trim())
      throw new Error(`gate --list line ${index + 1} must be <group>\\t<task>`);
    const tasks = groups.get(fields[0]) ?? new Set<string>();
    tasks.add(fields[1]);
    groups.set(fields[0], tasks);
  }
  if (groups.size === 0) throw new Error("gate --list returned no groups");
  return groups;
};

const parseWorkflow = (source: string): YamlMap => map(Bun.YAML.parse(source), "workflow");

const collectKey = (value: unknown, key: string, found: unknown[] = []): unknown[] => {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    for (const item of items) collectKey(item, key, found);
  } else if (isMap(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === key) found.push(child);
      collectKey(child, key, found);
    }
  }
  return found;
};

const callArguments = (source: string, callee: string): string[] => {
  const calls: string[] = [];
  let offset = 0;
  while ((offset = source.indexOf(`${callee}(`, offset)) !== -1) {
    const start = offset + callee.length + 1;
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const character = source[index] ?? "";
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth++;
      } else if (character === ")" && --depth === 0) {
        calls.push(source.slice(start, index));
        offset = index + 1;
        break;
      }
      if (index === source.length - 1) offset = source.length;
    }
  }
  return calls;
};

const compact = (source: string): string => source.replace(/\s+/g, "");

const jobNeeds = (job: YamlMap): string[] =>
  job["needs"] === undefined ? [] : strings(job["needs"], "job needs");

const sorted = (values: readonly string[]): string[] => [...values].sort();
const same = (left: readonly string[], right: readonly string[]): boolean =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));

const staticStringArray = (source: string): string[] | undefined => {
  const normalized = source.trim().replace(/,\s*]$/, "]");
  if (!normalized.startsWith("[") || !normalized.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(normalized);
    return strings(parsed, "static string array");
  } catch {
    return undefined;
  }
};

const workflowJobDisplayNames = (workflow: YamlMap): string[] => {
  const jobs = childMap(workflow, "jobs", "CI workflow jobs");
  const displayNames: string[] = [];
  for (const [id, value] of Object.entries(jobs)) {
    const job = map(value, `CI workflow job ${id}`);
    const name = job["name"];
    if (typeof name !== "string") throw new Error(`CI workflow job ${id} name must be a string`);
    const strategy = optionalChildMap(job, "strategy", `CI workflow job ${id} strategy`);
    const matrix = strategy
      ? optionalChildMap(strategy, "matrix", `CI workflow job ${id} matrix`)
      : undefined;
    if (!matrix) {
      if (name.includes("${{"))
        throw new Error(`CI workflow job ${id} has an unsupported dynamic display name`);
      displayNames.push(name);
      continue;
    }
    const axes = Object.entries(matrix);
    if (axes.length !== 1) throw new Error(`CI workflow job ${id} must use one static matrix axis`);
    const [axis, rawValues] = axes[0] ?? [];
    if (!axis || !/^[a-z][a-z0-9-]*$/.test(axis))
      throw new Error(`CI workflow job ${id} has an unsupported matrix axis`);
    const placeholder = `\${{ matrix.${axis} }}`;
    if (!name.includes(placeholder))
      throw new Error(`CI workflow job ${id} name must include its matrix axis`);
    for (const rawValue of sequence(rawValues, `CI workflow job ${id} matrix ${axis}`)) {
      if (typeof rawValue !== "string" && typeof rawValue !== "number")
        throw new Error(`CI workflow job ${id} matrix ${axis} values must be strings or numbers`);
      const expanded = name.replaceAll(placeholder, String(rawValue));
      if (expanded.includes("${{"))
        throw new Error(`CI workflow job ${id} has an unsupported dynamic display name`);
      displayNames.push(expanded);
    }
  }
  return displayNames;
};

export const deploymentCoverageErrors = (source: string): string[] =>
  workflowErrors(source, (workflow) => {
    const errors: string[] = [];
    const deploy = childMap(
      childMap(workflow, "jobs", "deployment jobs"),
      "deploy",
      "deployment job",
    );
    const condition = String(deploy["if"] ?? "");
    for (const proof of [
      "workflow_run.status == 'completed'",
      "workflow_run.conclusion == 'success'",
      "workflow_run.head_repository.full_name == github.repository",
      "workflow_run.head_branch == 'main'",
      "workflow_run.event == 'push'",
      "workflow_run.event == 'workflow_dispatch'",
    ]) {
      if (!condition.includes(proof))
        errors.push(`deployment condition missing trusted proof: ${proof}`);
    }
    const script = collectKey(deploy["steps"], "run").map(String).join("\n");
    for (const proof of [
      "git rev-parse HEAD",
      "actions/runs/$RUN_ID",
      ".run_attempt == $run_attempt",
      '.path == ".github/workflows/ci.yml"',
      ".head_sha == $sha",
      '.name == "gate"',
      '.conclusion == "success"',
    ]) {
      if (!script.includes(proof))
        errors.push(`deployment exact-revision verification missing: ${proof}`);
    }
    return errors;
  });

export const previewDeploymentCoverageErrors = (
  source: string,
  ciWorkflowSource: string,
): string[] =>
  workflowErrors(source, (workflow) => {
    const preview = childMap(
      childMap(workflow, "jobs", "preview deployment jobs"),
      "preview",
      "preview deployment job",
    );
    const steps = sequence(preview["steps"], "preview deployment steps");
    const proofStep = steps
      .map((step, index) => map(step, `preview deployment step ${index + 1}`))
      .find((step) => step["name"] === "Recheck state and select the exact current head");
    if (!proofStep) throw new Error("preview deployment proof step is missing");
    if (
      typeof proofStep["uses"] !== "string" ||
      !proofStep["uses"].startsWith("actions/github-script@")
    ) {
      throw new Error("preview deployment proof step must use actions/github-script");
    }
    const withInputs = childMap(proofStep, "with", "preview deployment proof inputs");
    const script = withInputs["script"];
    if (typeof script !== "string")
      throw new Error("preview deployment proof script must be a string");

    const errors: string[] = [];
    const ciQueries = callArguments(script, "github.rest.actions.listWorkflowRuns").filter(
      (query) => compact(query).includes('workflow_id:"ci.yml"'),
    );
    const ciQuery = ciQueries.length === 1 ? compact(ciQueries[0] ?? "") : "";
    if (!ciQuery.includes('workflow_id:"ci.yml"'))
      errors.push('preview deployment full-proof check missing: workflow_id: "ci.yml"');
    if (!ciQuery.includes('event:"workflow_dispatch"'))
      errors.push('preview deployment full-proof check missing: event: "workflow_dispatch"');
    if (ciQuery.includes('status:"success"'))
      errors.push("preview deployment must inspect the latest exact run before its conclusion");

    const expectedJobsMarker = "const expectedJobs = ";
    const expectedJobsOffset = script.indexOf(expectedJobsMarker);
    const expectedJobsCall =
      expectedJobsOffset < 0
        ? undefined
        : callArguments(script.slice(expectedJobsOffset + expectedJobsMarker.length), "new Set")[0];
    const expectedJobs =
      expectedJobsCall === undefined ? undefined : staticStringArray(expectedJobsCall);
    if (!expectedJobs) {
      errors.push("preview deployment expected job inventory must be a static string list");
    } else {
      const ciJobNames = workflowJobDisplayNames(parseWorkflow(ciWorkflowSource));
      if (!same(expectedJobs, ciJobNames))
        errors.push(
          "preview deployment expected job inventory must exactly match CI display names",
        );
    }

    const proofPredicates = callArguments(script, "data.workflow_runs.find");
    const expectedPredicate = compact(`(run) =>
      run.head_sha === pr.head.sha &&
      run.head_branch === pr.head.ref &&
      run.head_repository?.full_name === \`\${context.repo.owner}/\${context.repo.repo}\` &&
      run.path === ".github/workflows/ci.yml" &&
      run.event === "workflow_dispatch"`);
    if (proofPredicates.length !== 1 || compact(proofPredicates[0] ?? "") !== expectedPredicate) {
      errors.push("preview deployment full-proof check missing: exact latest CI proof predicate");
    }

    for (const proof of [
      'proof?.status === "completed"',
      'proof.conclusion === "success"',
      "jobs.length === expectedJobs.size",
      "expectedJobs.size === successful.size",
      "[...expectedJobs].every((name) => successful.has(name))",
      "gh workflow run ci.yml --ref",
    ]) {
      if (!script.includes(proof))
        errors.push(`preview deployment full-proof check missing: ${proof}`);
    }
    return errors;
  });

export const ciCoverageErrors = (
  gateListOutput: string,
  workflowSource: string,
  plannerChecks: readonly string[] = ALL_CHECKS,
): string[] => {
  const registry = parseGateList(gateListOutput);
  return workflowErrors(workflowSource, (workflow) => {
    const errors: string[] = [];
    const jobs = childMap(workflow, "jobs", "workflow jobs");
    const jobIds = Object.keys(jobs);

    if (!same(plannerChecks, expectedChecks))
      errors.push(`planner check inventory mismatch: ${JSON.stringify(sorted(plannerChecks))}`);
    if (!same(MANDATORY_CHECKS, expectedMandatory))
      errors.push(
        `planner mandatory inventory mismatch: ${JSON.stringify(sorted(MANDATORY_CHECKS))}`,
      );
    if (!same([...MANDATORY_CHECKS, ...EXTRA_CHECKS], ALL_CHECKS))
      errors.push("planner mandatory/extra inventories do not partition ALL_CHECKS");

    const expectedJobs = ["plan", ...expectedChecks, "gate"];
    for (const id of expectedJobs) {
      if (!jobs[id]) errors.push(`missing required workflow job: ${id}`);
    }
    for (const id of jobIds) {
      if (!expectedJobs.includes(id))
        errors.push(`workflow job is outside planner inventory: ${id}`);
    }

    const selectors = new Set(
      collectKey(jobs, "task").flatMap((value) => strings(value, "workflow task selector")),
    );
    const knownTasks = new Set([...registry.values()].flatMap((tasks) => [...tasks]));
    for (const selector of selectors) {
      if (!registry.has(selector) && !knownTasks.has(selector))
        errors.push(`unknown workflow selector: ${selector}`);
    }
    for (const [group, tasks] of registry) {
      const dedicatedCommand = group === "types" || group === "smoke";
      if (
        !dedicatedCommand &&
        !selectors.has(group) &&
        ![...tasks].every((task) => selectors.has(task))
      )
        errors.push(`uncovered gate group: ${group}`);
    }

    for (const [id, selector] of Object.entries(e2eSelectors)) {
      const job = optionalChildMap(jobs, id, `workflow job ${id}`);
      const selected = job
        ? collectKey(job, "task").flatMap((value) => strings(value, `${id} task`))
        : [];
      if (job && (selected.length !== 1 || selected[0] !== selector))
        errors.push(`workflow job ${id} must select only: ${selector}`);
    }

    const plan = optionalChildMap(jobs, "plan", "plan job");
    if (plan) {
      const outputs = childMap(plan, "outputs", "plan outputs");
      if (String(outputs["checks"] ?? "") !== "${{ steps.plan.outputs.checks }}")
        errors.push("plan job must expose the exact checks JSON output");
      const steps = sequence(plan["steps"], "plan steps");
      const workspaceStep = steps
        .map((step, index) => map(step, `plan step ${index + 1}`))
        .find((step) => step["uses"] === "./.github/actions/bun-workspace");
      if (!workspaceStep) errors.push("plan job must install frozen workspace dependencies");
      const script = collectKey(plan["steps"], "run").map(String).join("\n");
      for (const argument of [
        '--base "$BASE_SHA" --head "$HEAD_SHA" --github-output',
        "--full --github-output",
      ]) {
        if (!script.includes(argument))
          errors.push(`plan job missing fail-closed invocation: ${argument}`);
      }
    }

    for (const id of expectedMandatory) {
      const job = optionalChildMap(jobs, id, `workflow job ${id}`);
      if (!job) continue;
      if (job["if"] !== undefined)
        errors.push(`mandatory workflow job must not be conditional: ${id}`);
      if (!jobNeeds(job).includes("plan"))
        errors.push(`mandatory workflow job must need plan: ${id}`);
    }

    const smoke = optionalChildMap(jobs, "smoke", "smoke job");
    if (smoke) {
      if (!jobNeeds(smoke).includes("build")) errors.push("smoke job must need the exact build");
      const script = JSON.stringify(smoke["steps"]);
      if (
        !script.includes("manifold-web-dist-${{ github.sha }}") ||
        !script.includes("bun scripts/verify-ci-smoke.ts")
      )
        errors.push("smoke job must consume the exact-SHA build artifact");
    }
    const targeted = optionalChildMap(jobs, "targeted", "targeted job");
    if (targeted) {
      const script = collectKey(targeted["steps"], "run").map(String).join("\n");
      if (
        !script.includes('--base "$BASE_SHA" --head "$HEAD_SHA" --run-targeted') ||
        !script.includes("--full --run-targeted")
      )
        errors.push("targeted job must run the planner against the exact revision pair");
    }
    for (const id of EXTRA_CHECKS) {
      const job = optionalChildMap(jobs, id, `workflow job ${id}`);
      if (!job) continue;
      const condition = String(job["if"] ?? "");
      const expected = `contains(fromJSON(needs.plan.outputs.checks), '${id}')`;
      if (condition !== expected)
        errors.push(`workflow job ${id} must use planner condition: ${expected}`);
    }

    const types = optionalChildMap(jobs, "types", "types job");
    const shards = types
      ? childMap(childMap(types, "strategy", "types strategy"), "matrix", "types matrix")["shard"]
      : undefined;
    if (!Array.isArray(shards) || !same(shards.map(String), ["1", "2", "3", "4"]))
      errors.push("types job must use the complete 1/4 through 4/4 matrix");
    const typesScript = types ? collectKey(types["steps"], "run").map(String).join("\n") : "";
    if (!typesScript.includes('--only types --shard "${{ matrix.shard }}/4"'))
      errors.push("types job must execute its selected four-way shard");

    const preview = optionalChildMap(jobs, "preview-environment", "preview job");
    const modes = preview
      ? childMap(childMap(preview, "strategy", "preview strategy"), "matrix", "preview matrix")[
          "mode"
        ]
      : undefined;
    if (!Array.isArray(modes) || !same(modes.map(String), ["plain", "integrated"]))
      errors.push("preview job must retain plain and integrated matrix modes");

    const gate = optionalChildMap(jobs, "gate", "gate job");
    if (gate) {
      if (String(gate["if"] ?? "") !== "always()") errors.push("gate job must have if: always()");
      if (!same(jobNeeds(gate), ["plan", ...expectedChecks]))
        errors.push("gate job needs must exactly cover plan and every check");
      const gateScript = collectKey(gate["steps"], "run").map(String).join("\n");
      for (const semantic of ["EXPECTED_CHECKS", "main/dispatch proof", "result == skipped"]) {
        if (!gateScript.includes(semantic))
          errors.push(`gate aggregator missing planned-skip semantic: ${semantic}`);
      }
    }

    const concurrency = childMap(workflow, "concurrency", "workflow concurrency");
    const concurrencyGroup =
      "ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.ref }}";
    if (String(concurrency["group"]) !== concurrencyGroup)
      errors.push("CI concurrency must coalesce pending full proofs per ref");
    if (String(concurrency["cancel-in-progress"]) !== "${{ github.event_name == 'pull_request' }}")
      errors.push("only superseded pull-request CI may cancel in progress");
    return errors;
  });
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
  const deployment = await Bun.file(new URL(".github/workflows/deploy-dev.yml", repoRoot)).text();
  const previewDeployment = await Bun.file(
    new URL(".github/workflows/deploy-preview.yml", repoRoot),
  ).text();
  const errors = [
    ...ciCoverageErrors(registry, workflow),
    ...deploymentCoverageErrors(deployment),
    ...previewDeploymentCoverageErrors(previewDeployment, workflow),
  ];
  if (errors.length > 0) {
    console.error(`ci coverage: RED\n${errors.map((error) => ` - ${error}`).join("\n")}`);
    process.exit(1);
  }
  console.log("ci coverage: GREEN");
}
