import { describe, expect, test } from "bun:test";
import { ciCoverageErrors } from "./ci-coverage.ts";

const registry = [
  "build\tbuild:web (shared dist)",
  "types\ttsc web",
  "types\ttsc plugin-kit",
  "style\tlint",
  "trace\ttrace",
  "unit\tunit tests",
  "e2e\te2e (testkit)",
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
  "e2e",
  "convergence",
  "terminal-selection",
  "terminal-mirror",
  "tile-drop",
  "budgets",
  "pwa",
  "axioms",
] as const;

const workflow = (options?: {
  readonly omitTask?: string;
  readonly taskReplacement?: Readonly<Record<string, string>>;
  readonly gateIf?: string;
  readonly omitNeed?: string;
  readonly omitJob?: string;
}): string => {
  const verificationJobs = registryJobs
    .filter((task) => task !== options?.omitTask)
    .map(
      (task) => `  ${task}:
    uses: ./.github/actions/gate-slice
    with:
      task: ${options?.taskReplacement?.[task] ?? task}`,
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
    ...registryJobs.filter((task) => task !== options?.omitTask),
    "runtime-jobs",
    "runtime-browser",
    "preview-environment",
  ].filter((job) => job !== options?.omitNeed && job !== options?.omitJob);
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
