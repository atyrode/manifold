import { describe, expect, test } from "bun:test";
import {
  buildStatus,
  decideRepairIssue,
  issueMarker,
  managedRepairBody,
  parseTrustedWorkflowEvent,
  renderStatus,
  repairIsActionable,
  type PublicRun,
} from "./ci-feedback.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY = "example/manifold";

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "completed",
    repository: { full_name: REPOSITORY, default_branch: "main" },
    workflow_run: {
      id: 77,
      run_number: 12,
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "push",
      run_attempt: 1,
      head_branch: "main",
      head_sha: SHA,
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/example/manifold/actions/runs/77",
      head_repository: { full_name: REPOSITORY },
      created_at: "2026-09-13T12:00:00Z",
      repository: { full_name: REPOSITORY },
      triggering_actor: { login: "maintainer" },
      ...overrides,
    },
  };
}

function run(overrides: Partial<PublicRun> = {}): PublicRun {
  return {
    id: 77,
    createdAt: "2026-09-13T12:00:00Z",
    runNumber: 12,
    event: "push",
    sha: SHA,
    branch: "main",
    status: "completed",
    conclusion: "failure",
    url: "https://github.com/example/manifold/actions/runs/77",
    jobs: [],
    ...overrides,
  };
}

describe("workflow_run trust boundary", () => {
  test("accepts only trusted full-main metadata", () => {
    expect(parseTrustedWorkflowEvent(event(), REPOSITORY)).toEqual({
      runAttempt: 1,
      id: 77,
      runNumber: 12,
      event: "push",
      sha: SHA,
      branch: "main",
      status: "completed",
      createdAt: "2026-09-13T12:00:00Z",
      conclusion: "failure",
      url: "https://github.com/example/manifold/actions/runs/77",
      actor: "maintainer",
    });
    expect(parseTrustedWorkflowEvent(event({ event: "pull_request" }), REPOSITORY)).toBeNull();
    expect(parseTrustedWorkflowEvent(event({ head_branch: "release" }), REPOSITORY)).toBeNull();
  });

  test("fails closed on repository, workflow path, and malformed identity", () => {
    expect(() =>
      parseTrustedWorkflowEvent(
        event({ head_repository: { full_name: "fork/manifold" } }),
        REPOSITORY,
      ),
    ).toThrow("head repository");
    expect(() =>
      parseTrustedWorkflowEvent(event({ path: ".github/workflows/other.yml" }), REPOSITORY),
    ).toThrow("trusted CI workflow");
    expect(() => parseTrustedWorkflowEvent(event({ head_sha: "not-a-sha" }), REPOSITORY)).toThrow(
      "full commit SHA",
    );
  });
});

describe("repair issue routing", () => {
  const initialLabels = ["p1", "bug", "area:infra", "needs-triage"];
  const oldBody = managedRepairBody(
    `${issueMarker(77)}\n## Problem\nold\n## Standing scope\nIssue #574\n## Acceptance\nold`,
  );
  const desiredBody = managedRepairBody(
    `${issueMarker(77)}\n## Problem\nnew\n## Standing scope\nIssue #574\n## Acceptance\nnew`,
  );

  test("creates in triage and schedules promotion only for complete actionable evidence", () => {
    expect(decideRepairIssue(77, desiredBody, "maintainer", true, [])).toEqual({
      action: "create",
      body: desiredBody,
      promote: true,
    });
    expect(decideRepairIssue(77, desiredBody, "maintainer", false, [])).toMatchObject({
      action: "create",
      promote: false,
    });
  });

  test("resumes promotion after an interrupted untouched initial create", () => {
    expect(
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 9,
          body: desiredBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
      ]),
    ).toEqual({
      action: "none",
      issueNumber: 9,
      body: desiredBody,
      promote: true,
      preservedHumanContent: false,
    });
  });

  test("preserves user additions, holds, ownership, and edits inside the managed section", () => {
    const heldBody = `${oldBody}\n\n## Decision\nOperator is investigating.`;
    const held = decideRepairIssue(77, desiredBody, "maintainer", true, [
      {
        number: 9,
        body: heldBody,
        labels: ["p1", "bug", "area:web", "needs-operator", "security"],
        assignees: ["operator"],
      },
    ]);
    expect(held).toMatchObject({ action: "update", promote: false, preservedHumanContent: true });
    expect(held.body).toContain("## Decision\nOperator is investigating.");
    expect(held.body).toContain("## Problem\nnew");

    const crlfBody = `${oldBody.replace(/\n/g, "\r\n")}\r\n\r\n## Diagnosis\r\nKeep this text byte-for-byte.`;
    const crlf = decideRepairIssue(77, desiredBody, "maintainer", true, [
      {
        number: 9,
        body: crlfBody,
        labels: initialLabels,
        assignees: ["maintainer"],
      },
    ]);
    expect(crlf).toMatchObject({ action: "update", promote: false, preservedHumanContent: true });
    expect(crlf.body).toContain("## Problem\nnew");
    expect(crlf.body).toEndWith("\r\n\r\n## Diagnosis\r\nKeep this text byte-for-byte.");

    const editedManagedBody = oldBody.replace("## Problem\nold", "## Problem\noperator diagnosis");
    expect(
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 9,
          body: editedManagedBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
      ]),
    ).toEqual({
      action: "none",
      issueNumber: 9,
      body: editedManagedBody,
      promote: false,
      preservedHumanContent: true,
    });

    const replacedBody = "## Decision\nOperator replaced the automation report.";
    expect(
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 9,
          title: "CI repair: main 0123456789ab (run 77)",
          body: replacedBody,
          labels: ["p1", "bug", "area:web", "needs-operator"],
          assignees: ["operator"],
        },
      ]),
    ).toEqual({
      action: "none",
      issueNumber: 9,
      body: replacedBody,
      promote: false,
      preservedHumanContent: true,
    });

    expect(
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 9,
          state: "closed",
          body: desiredBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
      ]),
    ).toEqual({
      action: "none",
      issueNumber: 9,
      body: desiredBody,
      promote: false,
      preservedHumanContent: true,
    });
  });

  test("requires concrete failed-job evidence and complete policy sections for readiness", () => {
    const failedJob = {
      id: 1,
      name: "types",
      status: "completed",
      conclusion: "failure",
      url: "https://github.com/example/manifold/actions/runs/77/job/1",
    };
    expect(repairIsActionable(desiredBody, "maintainer", [failedJob])).toBe(true);
    expect(repairIsActionable(desiredBody, "maintainer", [])).toBe(false);
    expect(
      repairIsActionable(
        managedRepairBody(`${issueMarker(77)}\n## Problem\nmissing acceptance`),
        "maintainer",
        [failedJob],
      ),
    ).toBe(false);
  });

  test("fails when duplicate run markers already exist", () => {
    expect(() =>
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        { number: 9, body: desiredBody, labels: initialLabels, assignees: ["maintainer"] },
        { number: 10, body: desiredBody, labels: initialLabels, assignees: ["maintainer"] },
      ]),
    ).toThrow("multiple repair issues");
  });
});

describe("bounded machine-readable status", () => {
  test("reports failed and skipped jobs without confusing fast and full green", () => {
    const status = buildStatus(
      REPOSITORY,
      SHA,
      [
        run({
          jobs: [
            {
              id: 1,
              name: "types",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/example/manifold/actions/runs/77/job/1",
            },
            {
              id: 2,
              name: "preview",
              status: "completed",
              conclusion: "skipped",
              url: "https://github.com/example/manifold/actions/runs/77/job/2",
            },
          ],
        }),
        run({ id: 70, runNumber: 11, event: "pull_request", conclusion: "success", jobs: [] }),
      ],
      ["https://github.com/example/manifold/issues/90"],
    );

    expect(status.fast.state).toBe("green");
    expect(status.full.state).toBe("failed");
    expect(status.full.failedJobs).toEqual([
      { name: "types", url: "https://github.com/example/manifold/actions/runs/77/job/1" },
    ]);
    expect(status.full.skippedJobs).toEqual([
      { name: "preview", url: "https://github.com/example/manifold/actions/runs/77/job/2" },
    ]);
  });

  test("marks a cancelled full run superseded only when newer full-main evidence exists", () => {
    const cancelled = run({ conclusion: "cancelled" });
    expect(buildStatus(REPOSITORY, SHA, [cancelled], []).full.state).toBe("cancelled");
    const newer = run({
      id: 78,
      runNumber: 13,
      sha: "fedcba9876543210fedcba9876543210fedcba98",
      conclusion: "success",
    });
    const status = buildStatus(REPOSITORY, SHA, [cancelled, newer], []);
    expect(status.full.state).toBe("superseded");
  });

  test("emits only whitelisted, bounded public metadata", () => {
    const injected = run({
      jobs: Array.from({ length: 30 }, (_, index) => ({
        id: index + 1,
        name: `failed-${"x".repeat(300)}`,
        status: "completed",
        conclusion: "failure",
        url:
          index === 0
            ? "https://attacker.invalid/token"
            : `https://github.com/example/manifold/jobs/${String(index)}`,
        secret: "TOP_SECRET",
      })),
      secret: "TOP_SECRET",
    } as Partial<PublicRun>);
    const output = renderStatus(
      buildStatus(
        REPOSITORY,
        SHA,
        [injected],
        ["https://attacker.invalid/issue/1", "https://github.com/example/manifold/issues/2"],
      ),
      true,
    );

    expect(output).not.toContain("TOP_SECRET");
    expect(output).not.toContain("attacker.invalid");
    const parsed = JSON.parse(output) as {
      full: { failedJobs: { name: string }[] };
      repairIssues: string[];
    };
    expect(parsed.full.failedJobs).toHaveLength(20);
    expect(parsed.full.failedJobs[0]!.name.length).toBeLessThanOrEqual(120);
    expect(parsed.repairIssues).toEqual(["https://github.com/example/manifold/issues/2"]);
    expect(output.length).toBeLessThan(10_000);
  });
});
