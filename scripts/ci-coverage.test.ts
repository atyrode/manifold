import { describe, expect, test } from "bun:test";
import { ALL_CHECKS } from "./ci-plan.ts";
import {
  ciCoverageErrors,
  deploymentCoverageErrors,
  previewDeploymentCoverageErrors,
} from "./ci-coverage.ts";

const registry = [
  "build\tbuild:web (shared dist)",
  "types\ttsc web",
  "types\ttsc plugin-kit",
  "style\tlint",
  "smoke\tCI smoke",
  "trace\ttrace",
  "unit\tunit tests",
  "e2e\te2e (testkit except preview recovery)",
  "e2e\te2e (preview recovery)",
  "convergence\tconvergence",
  "terminal-selection\tterminal-selection",
  "terminal-mirror\tterminal-mirror",
  "tile-drop\ttile-drop",
  "budgets\tbudgets",
  "pwa\tpwa",
  "axioms\taxioms",
].join("\n");

const ci = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const deployDev = await Bun.file(
  new URL("../.github/workflows/deploy-dev.yml", import.meta.url),
).text();
const deployPreview = await Bun.file(
  new URL("../.github/workflows/deploy-preview.yml", import.meta.url),
).text();

describe("risk-selected CI topology coverage", () => {
  test("accepts the complete registry, planner universe, matrices, and fail-closed gate", () => {
    expect(ciCoverageErrors(registry, ci)).toEqual([]);
  });

  test("reports malformed workflow mappings instead of throwing", () => {
    const malformed = "jobs:\n  plan:\n    outputs: malformed\n";
    expect(ciCoverageErrors(registry, malformed)).toContain("plan outputs must be a mapping");
  });

  test("requires installed planner dependencies on a clean runner", () => {
    const missingDependencies = ci.replace(
      "      - uses: ./.github/actions/bun-workspace",
      "      - uses: oven-sh/setup-bun@v2",
    );
    expect(ciCoverageErrors(registry, missingDependencies)).toContain(
      "plan job must install frozen workspace dependencies",
    );
  });

  test("plans pull requests from the tested heads' common ancestor", () => {
    const baseTip = ci.replace(
      'MERGE_BASE_SHA=$(git merge-base "$BASE_SHA" "$HEAD_SHA")',
      'MERGE_BASE_SHA="$BASE_SHA"',
    );
    expect(ciCoverageErrors(registry, baseTip)).toContain(
      'plan job missing fail-closed invocation: MERGE_BASE_SHA=$(git merge-base "$BASE_SHA" "$HEAD_SHA")',
    );

    const bypassed = ci.replace(
      '--base "$MERGE_BASE_SHA" --head "$HEAD_SHA" --github-output',
      '--base "$BASE_SHA" --head "$HEAD_SHA" --github-output',
    );
    expect(ciCoverageErrors(registry, bypassed)).toContain(
      'plan job missing fail-closed invocation: --base "$MERGE_BASE_SHA" --head "$HEAD_SHA" --github-output',
    );
  });

  test("requires targeted CI to consume the plan's exact unitPaths output", () => {
    const missingOutput = ci.replace("      unitPaths: ${{ steps.plan.outputs.unitPaths }}\n", "");
    expect(ciCoverageErrors(registry, missingOutput)).toContain(
      "plan job must expose the exact unitPaths JSON output",
    );

    const recomputed = ci.replace(
      'bun scripts/ci-plan.ts --run-targeted --unit-paths-json "$UNIT_PATHS"',
      'bun scripts/ci-plan.ts --base "$BASE_SHA" --head "$HEAD_SHA" --run-targeted',
    );
    expect(ciCoverageErrors(registry, recomputed)).toContain(
      "targeted job must consume only the planned unitPaths JSON",
    );

    const wrongOutput = ci.replace(
      "UNIT_PATHS: ${{ needs.plan.outputs.unitPaths }}",
      "UNIT_PATHS: []",
    );
    expect(ciCoverageErrors(registry, wrongOutput)).toContain(
      "targeted job must receive the exact planned unitPaths JSON",
    );
  });

  test("fails when a future gate registry group has no workflow execution", () => {
    expect(ciCoverageErrors(`${registry}\nfuture\tfuture proof`, ci)).toContain(
      "uncovered gate group: future",
    );
  });

  test("fails when the planner inventory omits a registered workflow check", () => {
    expect(
      ciCoverageErrors(registry, ci, ALL_CHECKS.slice(0, -1)).some((error) =>
        error.startsWith("planner check inventory mismatch:"),
      ),
    ).toBe(true);
  });

  test("requires every extra job to consume only its planner check", () => {
    const unconditional = ci.replace(
      "contains(fromJSON(needs.plan.outputs.checks), 'trace')",
      "always()",
    );
    expect(ciCoverageErrors(registry, unconditional)).toContain(
      "workflow job trace must use planner condition: contains(fromJSON(needs.plan.outputs.checks), 'trace')",
    );
  });

  test("requires mandatory jobs even on fast plans", () => {
    const conditional = ci.replace(
      "  smoke:\n    name: smoke\n",
      "  smoke:\n    name: smoke\n    if: false\n",
    );
    expect(ciCoverageErrors(registry, conditional)).toContain(
      "mandatory workflow job must not be conditional: smoke",
    );
  });

  test("requires all four type shards", () => {
    const threeShards = ci.replace("shard: [1, 2, 3, 4]", "shard: [1, 2, 3]");
    expect(ciCoverageErrors(registry, threeShards)).toContain(
      "types job must use the complete 1/4 through 4/4 matrix",
    );
  });

  test("requires exact gate dependency inventory", () => {
    const missingTrace = ci.replace("      - trace\n", "");
    expect(ciCoverageErrors(registry, missingTrace)).toContain(
      "gate job needs must exactly cover plan and every check",
    );
  });

  test("requires the aggregator to accept only expected unplanned skips", () => {
    const cancelled = ci.replace("result == skipped", "result == cancelled");
    expect(ciCoverageErrors(registry, cancelled)).toContain(
      "gate aggregator missing planned-skip semantic: result == skipped",
    );
  });

  test("never cancels main proof while superseded pull requests remain cancellable", () => {
    const cancellableMain = ci.replace(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
      "cancel-in-progress: true",
    );
    expect(ciCoverageErrors(registry, cancellableMain)).toContain(
      "only superseded pull-request CI may cancel in progress",
    );
  });

  test("bounds full suites by coalescing only pending proofs on the same ref", () => {
    const unbounded = ci.replace("|| github.ref }}", "|| github.run_id }}");
    expect(ciCoverageErrors(registry, unbounded)).toContain(
      "CI concurrency must coalesce pending full proofs per ref",
    );
  });
});

describe("deployment evidence boundaries", () => {
  test("accepts only full exact-revision main CI for development", () => {
    expect(deploymentCoverageErrors(deployDev)).toEqual([]);
  });

  test("rejects development deployment without same-repository evidence", () => {
    const crossRepository = deployDev.replace(
      "github.event.workflow_run.head_repository.full_name == github.repository &&",
      "true &&",
    );
    expect(deploymentCoverageErrors(crossRepository)).toContain(
      "deployment condition missing trusted proof: workflow_run.head_repository.full_name == github.repository",
    );
  });

  test("rejects development deployment without an exact successful gate", () => {
    const noGate = deployDev.replace('.name == "gate"', '.name == "other"');
    expect(deploymentCoverageErrors(noGate)).toContain(
      'deployment exact-revision verification missing: .name == "gate"',
    );
  });

  test("accepts exact-head full workflow-dispatch evidence for persistent previews", () => {
    expect(previewDeploymentCoverageErrors(deployPreview, ci)).toEqual([]);
  });

  test("rejects using fast pull-request CI as preview deployment proof", () => {
    const fast = deployPreview.replace(
      'workflow_id: "ci.yml",\n                branch: pr.head.ref,\n                event: "workflow_dispatch",',
      'workflow_id: "ci.yml",\n                branch: pr.head.ref,\n                event: "pull_request",',
    );
    expect(previewDeploymentCoverageErrors(fast, ci)).toContain(
      'preview deployment full-proof check missing: event: "workflow_dispatch"',
    );
  });

  test("does not conflate the supersession query event with CI proof", () => {
    const unrelated = deployPreview.replace(
      'workflow_id: "deploy-preview.yml", branch: "main",\n                event: "workflow_dispatch"',
      'workflow_id: "deploy-preview.yml", branch: "main",\n                event: "pull_request"',
    );
    expect(previewDeploymentCoverageErrors(unrelated, ci)).toEqual([]);
  });

  test("rejects weakening the latest exact-run predicate", () => {
    const weakened = deployPreview.replace('run.event === "workflow_dispatch"', "true");
    expect(previewDeploymentCoverageErrors(weakened, ci)).toContain(
      "preview deployment full-proof check missing: exact latest CI proof predicate",
    );
  });

  test("rejects stale success when a newer exact preview proof failed or is pending", () => {
    const filtered = deployPreview.replace(
      'workflow_id: "ci.yml",\n                branch: pr.head.ref,\n                event: "workflow_dispatch",',
      'workflow_id: "ci.yml",\n                branch: pr.head.ref,\n                event: "workflow_dispatch",\n                status: "success",',
    );
    expect(previewDeploymentCoverageErrors(filtered, ci)).toContain(
      "preview deployment must inspect the latest exact run before its conclusion",
    );
  });

  test("requires preview proof to cover every expected successful CI job", () => {
    const partial = deployPreview.replace(
      "expectedJobs.size === successful.size",
      "successful.size > 0",
    );
    expect(previewDeploymentCoverageErrors(partial, ci)).toContain(
      "preview deployment full-proof check missing: expectedJobs.size === successful.size",
    );
  });

  test("requires every expected job in the real full-proof decision", () => {
    const weakened = deployPreview.replace(
      "[...expectedJobs].every((name) => successful.has(name))",
      'successful.has("gate")',
    );
    expect(previewDeploymentCoverageErrors(weakened, ci)).toContain(
      "preview deployment full-proof check missing: [...expectedJobs].every((name) => successful.has(name))",
    );
  });

  test("cross-checks preview proof names against expanded CI display names", () => {
    const renamedCi = ci.replace("    name: runtime-jobs", "    name: runtime jobs");
    expect(previewDeploymentCoverageErrors(deployPreview, renamedCi)).toContain(
      "preview deployment expected job inventory must exactly match CI display names",
    );
  });

  test("rejects missing or added preview expected-job names", () => {
    const missing = deployPreview.replace(
      '"runtime-jobs", "runtime-browser",',
      '"runtime-browser",',
    );
    expect(previewDeploymentCoverageErrors(missing, ci)).toContain(
      "preview deployment expected job inventory must exactly match CI display names",
    );

    const added = deployPreview.replace(
      '"runtime-jobs", "runtime-browser",',
      '"runtime-jobs", "runtime-browser", "future",',
    );
    expect(previewDeploymentCoverageErrors(added, ci)).toContain(
      "preview deployment expected job inventory must exactly match CI display names",
    );
  });

  test("reports malformed workflow object nodes", () => {
    const malformed = "jobs:\n  preview:\n    steps: malformed\n";
    expect(previewDeploymentCoverageErrors(malformed, ci)).toContain(
      "preview deployment steps must be a sequence",
    );
  });
});
