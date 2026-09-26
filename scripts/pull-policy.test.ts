import { describe, expect, test } from "bun:test";
import { drainingPulls, type DrainPull } from "./dispatch.ts";
import { evaluatePullPolicy, type PullPolicyIssue, type PullPolicyPull } from "./pull-policy.ts";

const pull = (overrides: Partial<PullPolicyPull> = {}): PullPolicyPull => ({
  number: 10,
  title: "change",
  url: "https://example.test/pull/10",
  body: "Closes #7\n\n## Dependencies\n\n- None",
  isDraft: false,
  baseRefName: "main",
  headRefName: "web/7-change",
  labels: [],
  files: ["packages/web/src/change.ts"],
  ...overrides,
});

const issue = (overrides: Partial<PullPolicyIssue> = {}): PullPolicyIssue => ({
  number: 7,
  state: "OPEN",
  labels: ["agent-ready", "p2", "area:web"],
  body: "## Problem\nA problem\n\n## Acceptance\nIt works",
  comments: [],
  ...overrides,
});

const findings = (
  current: PullPolicyPull,
  open: readonly PullPolicyPull[] = [current],
  claimed: PullPolicyIssue = issue(),
) => evaluatePullPolicy(current, open, new Map([[claimed.number, claimed]]));

describe("pull request lifecycle policy", () => {
  test("accepts one current-main PR for an accepted issue", () => {
    expect(findings(pull())).toEqual([]);
  });

  test("refuses implementation before issue acceptance", () => {
    expect(findings(pull(), undefined, issue({ labels: ["needs-triage"] }))).toContainEqual({
      rule: "P1",
      message:
        "issue #7 must be agent-ready with one priority, or a structured needs-operator hold",
    });
  });

  test("requires structured operator holds to remain draft", () => {
    const held = issue({
      labels: ["needs-operator", "design"],
      comments: ["## Decision\nQuestion: choose"],
    });
    expect(findings(pull(), undefined, held)).toContainEqual({
      rule: "P2",
      message: "operator-held issue #7 requires a draft PR",
    });
    expect(
      findings(pull({ isDraft: true, files: ["docs/decisions/0042-choice.md"] }), undefined, held),
    ).toEqual([]);
  });

  test("refuses implementation files while an operator decision is open", () => {
    const held = issue({
      labels: ["needs-operator", "design"],
      comments: ["## Decision\nQuestion: choose"],
    });
    expect(findings(pull({ isDraft: true }), undefined, held)).toContainEqual({
      rule: "P2",
      message: "operator-held issue #7 may carry decision documents, not implementation",
    });
    expect(
      findings(pull({ isDraft: true, files: ["docs/decisions/0042-choice.md"] }), undefined, held),
    ).toEqual([]);
  });

  test("refuses a second PR claiming the same initiative", () => {
    const current = pull();
    const other = pull({ number: 11, headRefName: "web/7-other" });
    expect(findings(current, [current, other])).toContainEqual({
      rule: "P3",
      message: "duplicates initiative claim #7 with PR #11",
    });
  });

  test("requires dependency declarations to match the Git base", () => {
    const dependency = pull({
      number: 9,
      body: "Closes #8\n\n## Dependencies\n\n- None",
      headRefName: "protocol/8-base",
    });
    const stacked = pull({
      body: "Closes #7\n\n## Dependencies\n\n- Depends-on: #9",
      baseRefName: "protocol/8-base",
    });
    expect(findings(stacked, [stacked, dependency])).toEqual([]);
    expect(
      findings({ ...stacked, baseRefName: "main" }, [
        { ...stacked, baseRefName: "main" },
        dependency,
      ]),
    ).toContainEqual({
      rule: "P4",
      message: "a PR depending on an open PR must use that PR's head branch as its base",
    });
  });

  test("refuses an empty superseded PR", () => {
    expect(findings(pull({ files: [] }))).toContainEqual({
      rule: "P5",
      message: "PR has no unique diff and must be reconciled or closed",
    });
  });
});

describe("dispatch integration drain", () => {
  const headCommittedAt = "2026-09-26T17:00:00Z";
  const verdict = (outcome: string, createdAt: string) => ({
    body: `## Verdict: ${outcome}\n\nReviewed head abc1234 against #7.`,
    createdAt,
  });
  const current = verdict("pass", "2026-09-26T17:05:00Z");
  const drain = (number: number, overrides: Partial<DrainPull> = {}): DrainPull => ({
    number,
    title: "change",
    url: `https://example.test/${String(number)}`,
    isDraft: false,
    autoMerge: null,
    headCommittedAt,
    comments: [],
    ...overrides,
  });
  const blocking = (pulls: readonly DrainPull[]) =>
    drainingPulls(pulls).map((pullRequest) => pullRequest.number);

  test("blocks only for non-draft pull requests in number order", () => {
    expect(blocking([drain(12), drain(9, { isDraft: true }), drain(10)])).toEqual([10, 12]);
  });

  test("treats a current pass verdict with squash auto-merge armed as in the integration lane", () => {
    expect(
      blocking([
        drain(12, { autoMerge: "SQUASH", comments: [current] }),
        drain(13, {
          autoMerge: "SQUASH",
          comments: [verdict("fail", "2026-09-26T17:02:00Z"), current],
        }),
      ]),
    ).toEqual([]);
  });

  test("keeps every other non-draft pull request blocking", () => {
    expect(
      blocking([
        drain(1, { comments: [current] }),
        drain(2, { autoMerge: "REBASE", comments: [current] }),
        drain(3, { autoMerge: "SQUASH", comments: [verdict("pass", "2026-09-26T16:55:00Z")] }),
        drain(4, { autoMerge: "SQUASH", comments: [verdict("pass", headCommittedAt)] }),
        drain(5, {
          autoMerge: "SQUASH",
          comments: [current, verdict("fail", "2026-09-26T17:10:00Z")],
        }),
        drain(6, { autoMerge: "SQUASH", comments: [current], headCommittedAt: null }),
        drain(7, {
          autoMerge: "SQUASH",
          comments: [{ body: "Looks good.", createdAt: "2026-09-26T17:05:00Z" }],
        }),
      ]),
    ).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
