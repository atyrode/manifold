import { describe, expect, test } from "bun:test";
import { drainingPulls } from "./dispatch.ts";
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
  test("blocks only for non-draft pull requests in number order", () => {
    expect(
      drainingPulls([
        { number: 12, title: "ready", url: "https://example.test/12", isDraft: false },
        { number: 9, title: "held", url: "https://example.test/9", isDraft: true },
        { number: 10, title: "correcting", url: "https://example.test/10", isDraft: false },
      ]).map((pullRequest) => pullRequest.number),
    ).toEqual([10, 12]);
  });
});
