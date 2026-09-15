import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      html_url: `https://github.com/example/manifold/actions/runs/${String(overrides["id"] ?? 77)}`,
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
          creator: "github-actions[bot]",
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
        creator: "github-actions[bot]",
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
        creator: "github-actions[bot]",
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
          creator: "github-actions[bot]",
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
          creator: "github-actions[bot]",
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
          creator: "github-actions[bot]",
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

  test("ignores forged public markers from non-automation issue creators", () => {
    expect(
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 8,
          creator: "unrelated-user",
          title: "CI repair: main 0123456789ab (run 77)",
          body: desiredBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
      ]),
    ).toEqual({ action: "create", body: desiredBody, promote: true });
  });

  test("fails when duplicate run markers already exist", () => {
    expect(() =>
      decideRepairIssue(77, desiredBody, "maintainer", true, [
        {
          number: 9,
          creator: "github-actions[bot]",
          body: desiredBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
        {
          number: 10,
          creator: "github-actions[bot]",
          body: desiredBody,
          labels: initialLabels,
          assignees: ["maintainer"],
        },
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

describe("exact-revision incident recovery", () => {
  test("closes only untouched bot run incidents and resumes after an interrupted comment", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "ci-feedback-recovery-"));
    const executable = join(import.meta.dir, "ci-feedback.ts");
    const gh = join(fixture, "gh");
    const statePath = join(fixture, "state.json");
    const eventPath = join(fixture, "event.json");
    const labels = ["p1", "bug", "area:infra", "agent-ready"].map((name) => ({ name }));
    const assignees = [{ login: "maintainer" }];
    const incidentContent = (runId: number, sha: string, explicit = true) =>
      [
        issueMarker(runId),
        `<!-- ci-feedback:sha=${sha} -->`,
        ...(explicit ? ["<!-- ci-feedback:kind=full-main-run-incident -->"] : []),
        "## Problem",
        "Full main verification did not pass.",
        "## Standing scope",
        "Issue #574 authorizes diagnosis and repository/CI repair for this failure.",
        "## Reproduce and repair",
        "Inspect the failed run.",
        "## Acceptance",
        "Repair or recover.",
        "Automation promotes this issue only after concrete failed-job evidence, ownership, scope, and acceptance are complete.",
      ].join("\n");
    const issue = (
      number: number,
      body: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      number,
      user: { login: "github-actions[bot]" },
      title: `CI run incident: main ${SHA.slice(0, 12)} (run 77)`,
      state: "open",
      body,
      labels,
      assignees,
      html_url: `https://github.com/${REPOSITORY}/issues/${String(number)}`,
      ...overrides,
    });
    const otherSha = "a".repeat(40);
    const pristine = managedRepairBody(incidentContent(77, SHA));
    const legacy = managedRepairBody(incidentContent(78, SHA, false));
    const oldRecovery =
      `<!-- ci-feedback:recovery-run=88 -->\n` +
      `Full main CI later passed for the same exact revision in [run 88](https://github.com/${REPOSITORY}/actions/runs/88). This is recovery evidence only; the defect is not auto-closed.`;
    await writeFile(
      statePath,
      JSON.stringify({
        issues: [
          issue(1, pristine),
          issue(2, legacy, {
            title: `CI repair: main ${SHA.slice(0, 12)} (run 78)`,
          }),
          issue(3, managedRepairBody(incidentContent(77, otherSha)), {
            title: `CI run incident: main ${otherSha.slice(0, 12)} (run 77)`,
          }),
          issue(4, pristine, { user: { login: "human" } }),
          issue(5, `${pristine}\n\n## Diagnosis\nRepurposed as a durable defect.`),
          issue(6, pristine),
          issue(
            7,
            managedRepairBody(
              `${issueMarker(77)}\n<!-- ci-feedback:sha=${SHA} -->\n## Deployment incident`,
            ),
            { title: `Deployment incident for ${SHA}` },
          ),
          issue(8, pristine.replace("Full main verification", "Diagnosed verification")),
          issue(9, pristine, {
            labels: [{ name: "p1" }, { name: "needs-operator" }],
            assignees: [{ login: "operator" }],
          }),
        ],
        comments: {
          "1": [],
          "2": [{ body: oldRecovery }],
          "3": [],
          "4": [],
          "5": [],
          "6": [{ body: "Root cause diagnosed; preserve this defect record." }],
          "7": [],
          "8": [],
          "9": [],
        },
        mutations: [],
        interruptClose: true,
      }),
    );
    await writeFile(eventPath, JSON.stringify(event({ id: 88, conclusion: "success" })));
    await writeFile(
      gh,
      `#!/usr/bin/env bun
const statePath = process.env.CI_FEEDBACK_FIXTURE_STATE;
if (!statePath) throw new Error("missing fixture state");
const state = await Bun.file(statePath).json();
const args = process.argv.slice(2);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
if (!endpoint) throw new Error("unexpected gh args: " + args.join(" "));
const save = async () => await Bun.write(statePath, JSON.stringify(state));
if (endpoint === "repos/${REPOSITORY}/actions/runs/88") {
  console.log(JSON.stringify(${JSON.stringify(event({ id: 88, conclusion: "success" }).workflow_run)}));
} else if (endpoint.startsWith("repos/${REPOSITORY}/actions/workflows/ci.yml/runs?head_sha=")) {
  console.log(JSON.stringify({ total_count: 2, workflow_runs: [{ created_at: "2026-09-13T12:00:00Z" }, { created_at: "2026-09-14T12:00:00Z" }] }));
} else if (endpoint.startsWith("repos/${REPOSITORY}/issues?")) {
  console.log(JSON.stringify(state.issues));
} else {
  const comments = /^repos\\/${REPOSITORY.replace("/", "\\/")}\\/issues\\/(\\d+)\\/comments(?:\\?per_page=100)?$/.exec(endpoint);
  const issue = /^repos\\/${REPOSITORY.replace("/", "\\/")}\\/issues\\/(\\d+)$/.exec(endpoint);
  if (comments) {
    const number = comments[1];
    if (args.includes("POST")) {
      const payload = await Bun.stdin.json();
      state.comments[number].push({ body: payload.body });
      state.mutations.push({ issue: Number(number), action: "comment", payload });
      await save();
      console.log(JSON.stringify({ id: state.mutations.length }));
    } else {
      console.log(JSON.stringify(state.comments[number]));
    }
  } else if (issue && args.includes("PATCH")) {
    if (state.interruptClose) {
      state.interruptClose = false;
      await save();
      console.error("simulated interrupted close");
      process.exit(1);
    }
    const payload = await Bun.stdin.json();
    const target = state.issues.find((candidate) => candidate.number === Number(issue[1]));
    Object.assign(target, payload);
    state.mutations.push({ issue: Number(issue[1]), action: "close", payload });
    await save();
    console.log(JSON.stringify(target));
  } else {
    throw new Error("unexpected endpoint: " + endpoint);
  }
}
`,
    );
    await chmod(gh, 0o755);
    const runCli = async (expectedExit = 0) => {
      const child = Bun.spawn([process.execPath, executable, "--event", eventPath], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: `${fixture}:${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: REPOSITORY,
          CI_FEEDBACK_FIXTURE_STATE: statePath,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(expectedExit);
      if (expectedExit !== 0) expect(stderr).toContain("simulated interrupted close");
    };
    try {
      await runCli(1);
      await runCli();
      await runCli();
      const state = JSON.parse(await readFile(statePath, "utf8")) as {
        issues: Array<{ number: number; state: string; body: string }>;
        mutations: Array<{
          issue: number;
          action: string;
          payload: Record<string, unknown>;
        }>;
      };
      expect(state.mutations).toHaveLength(4);
      expect(state.mutations.map(({ issue: number, action }) => [number, action])).toEqual([
        [1, "comment"],
        [1, "close"],
        [2, "comment"],
        [2, "close"],
      ]);
      expect(state.mutations[0]?.payload["body"]).toContain(
        `ci-feedback:recovery-run=88 sha=${SHA}`,
      );
      expect(state.mutations[1]?.payload).toEqual({
        state: "closed",
        state_reason: "completed",
      });
      expect(state.issues.slice(0, 2).map(({ state, body }) => [state, body])).toEqual([
        ["closed", pristine],
        ["closed", legacy],
      ]);
      expect(
        state.issues.filter(({ number }) => number > 2).every(({ state }) => state === "open"),
      ).toBe(true);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});
