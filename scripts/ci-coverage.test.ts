import { describe, expect, test } from "bun:test";
import { ciCoverageErrors } from "./ci-coverage.ts";

const registry = [
  "build\tbuild:web (shared dist)",
  "types\ttsc web",
  "types\ttsc plugin-kit",
  "style\tlint",
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

const registryJobs = [
  "build",
  "types",
  "style",
  "trace",
  "unit",
  "convergence",
  "terminal-selection",
  "terminal-mirror",
  "tile-drop",
  "budgets",
  "pwa",
  "axioms",
] as const;

const e2eJobs = [
  { id: "e2e-rest", selector: "e2e (testkit except preview recovery)" },
  { id: "e2e-preview-recovery", selector: "e2e (preview recovery)" },
] as const;

const workflow = (options?: {
  readonly omitTask?: string;
  readonly taskReplacement?: Readonly<Record<string, string>>;
  readonly gateIf?: string;
  readonly omitNeed?: string;
  readonly omitJob?: string;
}): string => {
  const verificationJobs: string[] = registryJobs
    .filter((task) => task !== options?.omitTask && task !== options?.omitJob)
    .map(
      (task) => `  ${task}:
    uses: ./.github/actions/gate-slice
    with:
      task: ${options?.taskReplacement?.[task] ?? task}`,
    );
  verificationJobs.push(
    ...e2eJobs
      .filter(({ id }) => id !== options?.omitTask && id !== options?.omitJob)
      .map(
        ({ id, selector }) => `  ${id}:
    uses: ./.github/actions/gate-slice
    with:
      task: ${options?.taskReplacement?.[id] ?? selector}`,
      ),
  );
  if (options?.omitJob !== "runtime-jobs") {
    verificationJobs.push(
      "  runtime-jobs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/verify-runtime.sh --system jobs",
    );
  }
  if (options?.omitJob !== "runtime-browser") {
    verificationJobs.push(
      "  runtime-browser:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bash scripts/verify-runtime.sh --system browser",
    );
  }
  if (options?.omitJob !== "preview-environment") {
    verificationJobs.push(`  preview-environment:
    strategy:
      matrix:
        mode: [plain, integrated]
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ matrix.mode }}`);
  }
  const needs = [
    ...registryJobs,
    ...e2eJobs.map(({ id }) => id),
    "runtime-jobs",
    "runtime-browser",
    "preview-environment",
  ].filter(
    (job) => job !== options?.omitTask && job !== options?.omitNeed && job !== options?.omitJob,
  );
  return `name: CI
jobs:
${verificationJobs.join("\n")}
  gate:
    if: ${options?.gateIf ?? "always()"}
    needs:
${needs.map((job) => `      - ${job}`).join("\n")}
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
`;
};

describe("CI topology coverage", () => {
  test("accepts literal gate groups, required runtime and preview jobs, and a complete gate", () => {
    expect(ciCoverageErrors(registry, workflow())).toEqual([]);
  });

  test("reports a registry group omitted from the workflow", () => {
    expect(ciCoverageErrors(registry, workflow({ omitTask: "types" }))).toContain(
      "uncovered gate group: types",
    );
  });

  test("reports a workflow selector unknown to the registry", () => {
    expect(
      ciCoverageErrors(registry, workflow({ taskReplacement: { style: "styles" } })),
    ).toContain("unknown workflow selector: styles");
  });

  test("fails closed instead of accepting a dynamic task selector", () => {
    expect(
      ciCoverageErrors(registry, workflow({ taskReplacement: { style: "${{ matrix.task }}" } })),
    ).toContain("workflow task selector must be a literal name, got: ${{ matrix.task }}");
  });

  test("requires both dedicated e2e workflow jobs", () => {
    expect(ciCoverageErrors(registry, workflow({ omitJob: "e2e-rest" }))).toContain(
      "missing required workflow job: e2e-rest",
    );
    expect(ciCoverageErrors(registry, workflow({ omitJob: "e2e-preview-recovery" }))).toContain(
      "missing required workflow job: e2e-preview-recovery",
    );
  });

  test("requires each dedicated e2e job to retain its selector", () => {
    const missingSelector = workflow().replace(
      "      task: e2e (preview recovery)",
      "      name: e2e (preview recovery)",
    );
    expect(ciCoverageErrors(registry, missingSelector)).toContain(
      "workflow job e2e-preview-recovery must select only: e2e (preview recovery)",
    );
  });

  test("rejects swapped e2e selectors even though every registry task remains covered", () => {
    const errors = ciCoverageErrors(
      registry,
      workflow({
        taskReplacement: {
          "e2e-rest": "e2e (preview recovery)",
          "e2e-preview-recovery": "e2e (testkit except preview recovery)",
        },
      }),
    );
    expect(errors).toContain(
      "workflow job e2e-rest must select only: e2e (testkit except preview recovery)",
    );
    expect(errors).toContain(
      "workflow job e2e-preview-recovery must select only: e2e (preview recovery)",
    );
  });

  test("rejects collapsing both e2e selectors onto the rest runner", () => {
    const collapsed = workflow({ omitJob: "e2e-preview-recovery" }).replace(
      "task: e2e (testkit except preview recovery)",
      "task: [e2e (testkit except preview recovery), e2e (preview recovery)]",
    );
    const errors = ciCoverageErrors(registry, collapsed);
    expect(errors).not.toContain("uncovered gate group: e2e");
    expect(errors).toContain(
      "workflow job e2e-rest must select only: e2e (testkit except preview recovery)",
    );
    expect(errors).toContain("missing required workflow job: e2e-preview-recovery");
  });

  test("requires the final gate to run even after a failed dependency", () => {
    expect(ciCoverageErrors(registry, workflow({ gateIf: "success()" }))).toContain(
      "gate job must have if: always()",
    );
  });

  test("names an executable verification job omitted from gate needs", () => {
    expect(ciCoverageErrors(registry, workflow({ omitNeed: "runtime-browser" }))).toContain(
      "gate job needs missing verification job: runtime-browser",
    );
  });

  test("requires both dedicated e2e jobs in final gate needs", () => {
    expect(ciCoverageErrors(registry, workflow({ omitNeed: "e2e-rest" }))).toContain(
      "gate job needs missing verification job: e2e-rest",
    );
    expect(ciCoverageErrors(registry, workflow({ omitNeed: "e2e-preview-recovery" }))).toContain(
      "gate job needs missing verification job: e2e-preview-recovery",
    );
  });

  test("names a required non-registry job omitted from the workflow", () => {
    expect(ciCoverageErrors(registry, workflow({ omitJob: "runtime-jobs" }))).toContain(
      "missing required workflow job: runtime-jobs",
    );
  });

  test("requires the preview matrix job", () => {
    expect(ciCoverageErrors(registry, workflow({ omitJob: "preview-environment" }))).toContain(
      "missing required preview job",
    );
  });

  test("requires both preview matrix modes on one preview job", () => {
    const missingIntegrated = workflow().replace("mode: [plain, integrated]", "mode: [plain]");
    expect(ciCoverageErrors(registry, missingIntegrated)).toContain(
      "preview job preview-environment missing matrix mode: integrated",
    );
  });
});
