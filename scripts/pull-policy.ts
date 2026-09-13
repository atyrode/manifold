#!/usr/bin/env bun
/**
 * Pull-request lifecycle invariants. The evaluator is pure; the CLI reads one current pull request,
 * its claimed issues, and the open pull roster through `gh`, then exits non-zero on violations.
 */
import { $ } from "bun";

const CLAIM = /^(?:Closes|Fixes|Resolves|Refs)\s+#(\d+)\b/gim;
const DECISION_BLOCK = /^## Decision\b/m;
const PRIORITY = ["p0", "p1", "p2", "p3"] as const;

export interface PullPolicyPull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly labels: readonly string[];
  readonly files: readonly string[];
}

export interface PullPolicyIssue {
  readonly number: number;
  readonly state: "OPEN" | "CLOSED";
  readonly labels: readonly string[];
  readonly body: string;
  readonly comments: readonly string[];
}

export interface PullPolicyFinding {
  readonly rule: "P1" | "P2" | "P3" | "P4" | "P5";
  readonly message: string;
}

export function claimedIssues(body: string): readonly number[] {
  return [...new Set([...body.matchAll(CLAIM)].map((match) => Number(match[1])))]
    .filter(Number.isInteger)
    .sort((left, right) => left - right);
}

function section(body: string, heading: string): readonly string[] | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("<!--"));
}

function dependencies(body: string): readonly number[] | undefined {
  const lines = section(body, "Dependencies");
  if (lines === undefined) return undefined;
  if (lines.length === 1 && /^-?\s*None\.?$/i.test(lines[0] ?? "")) return [];
  const parsed = lines.flatMap((line) => {
    const match = /^-?\s*Depends-on:\s*#(\d+)\s*$/i.exec(line);
    return match === null ? [] : [Number(match[1])];
  });
  return parsed.length === lines.length ? parsed : undefined;
}

function hasDecision(issue: PullPolicyIssue): boolean {
  return (
    DECISION_BLOCK.test(issue.body) || issue.comments.some((body) => DECISION_BLOCK.test(body))
  );
}

/** Evaluate the current pull request against issue state and the open pull roster. */
export function evaluatePullPolicy(
  current: PullPolicyPull,
  openPulls: readonly PullPolicyPull[],
  issues: ReadonlyMap<number, PullPolicyIssue>,
): readonly PullPolicyFinding[] {
  const findings: PullPolicyFinding[] = [];
  const claims = claimedIssues(current.body);
  if (claims.length === 0) {
    findings.push({
      rule: "P1",
      message: "PR must claim an issue with Closes/Fixes/Resolves/Refs #N",
    });
  }

  for (const number of claims) {
    const issue = issues.get(number);
    if (issue === undefined) {
      findings.push({ rule: "P1", message: `claimed issue #${String(number)} was not loaded` });
      continue;
    }
    const priority = PRIORITY.filter((label) => issue.labels.includes(label));
    const accepted =
      issue.state === "OPEN" && issue.labels.includes("agent-ready") && priority.length === 1;
    const held =
      issue.state === "OPEN" && issue.labels.includes("needs-operator") && hasDecision(issue);
    if (!accepted && !held) {
      findings.push({
        rule: "P1",
        message: `issue #${String(number)} must be agent-ready with one priority, or a structured needs-operator hold`,
      });
    }
    if (held && !current.isDraft) {
      findings.push({
        rule: "P2",
        message: `operator-held issue #${String(number)} requires a draft PR`,
      });
    }
    if (held && current.files.some((path) => !path.endsWith(".md"))) {
      findings.push({
        rule: "P2",
        message: `operator-held issue #${String(number)} may carry decision documents, not implementation`,
      });
    }
  }

  if (current.labels.includes("needs-operator")) {
    const structured =
      claims.some((number) => {
        const issue = issues.get(number);
        return issue !== undefined && hasDecision(issue);
      }) || DECISION_BLOCK.test(current.body);
    if (!current.isDraft || !structured) {
      findings.push({
        rule: "P2",
        message:
          "needs-operator requires a draft PR and a structured Decision block on the PR or claimed issue",
      });
    }
  }

  for (const other of openPulls) {
    if (other.number === current.number) continue;
    const shared = claimedIssues(other.body).filter((number) => claims.includes(number));
    if (shared.length > 0) {
      findings.push({
        rule: "P3",
        message: `duplicates initiative claim ${shared.map((number) => `#${String(number)}`).join(", ")} with PR #${String(other.number)}`,
      });
    }
  }

  const declared = dependencies(current.body);
  if (declared === undefined) {
    findings.push({
      rule: "P4",
      message: "Dependencies must be exactly `- None` or `- Depends-on: #N`",
    });
  } else if (current.baseRefName === "main" && declared.length > 0) {
    findings.push({
      rule: "P4",
      message: "a PR depending on an open PR must use that PR's head branch as its base",
    });
  } else if (current.baseRefName !== "main") {
    const dependency =
      declared.length === 1 ? openPulls.find((pull) => pull.number === declared[0]) : undefined;
    if (dependency === undefined || dependency.headRefName !== current.baseRefName) {
      findings.push({
        rule: "P4",
        message: "a stacked PR must declare its one base PR and target that PR's head branch",
      });
    }
  }

  if (current.files.length === 0) {
    findings.push({
      rule: "P5",
      message: "PR has no unique diff and must be reconciled or closed",
    });
  }
  return findings;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("gh returned a non-object where an object was expected");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  return typeof field === "string" ? field : "";
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function toPull(value: unknown): PullPolicyPull {
  const record = asRecord(value);
  const number = record["number"];
  if (typeof number !== "number") throw new Error("gh pull response omitted its number");
  return {
    number,
    title: text(record, "title"),
    url: text(record, "url"),
    body: text(record, "body"),
    isDraft: record["isDraft"] === true,
    baseRefName: text(record, "baseRefName"),
    headRefName: text(record, "headRefName"),
    labels: array(record["labels"]).map((label) => text(label, "name")),
    files: array(record["files"]).map((file) => text(file, "path")),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  const pullNumber = Number(valueOf("--pr") ?? process.env["PR_NUMBER"]);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0)
    throw new Error("--pr needs a positive integer");
  const repo = valueOf("--repo") ?? process.env["GH_REPO"];
  const repoArgs = repo === undefined ? [] : ["--repo", repo];
  const gh = async (command: readonly string[]): Promise<unknown> => {
    const result = await $`gh ${command}`.quiet().nothrow();
    if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "gh failed");
    return JSON.parse(result.text()) as unknown;
  };

  const current = toPull(
    await gh([
      "pr",
      "view",
      String(pullNumber),
      ...repoArgs,
      "--json",
      "number,title,url,body,isDraft,baseRefName,headRefName,labels,files",
    ]),
  );
  const openPulls = array(
    await gh([
      "pr",
      "list",
      ...repoArgs,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,title,url,body,isDraft,baseRefName,headRefName,labels",
    ]),
  ).map(toPull);
  const issues = new Map<number, PullPolicyIssue>();
  for (const number of claimedIssues(current.body)) {
    const raw = asRecord(
      await gh([
        "issue",
        "view",
        String(number),
        ...repoArgs,
        "--json",
        "number,state,labels,body,comments",
      ]),
    );
    issues.set(number, {
      number,
      state: raw["state"] === "CLOSED" ? "CLOSED" : "OPEN",
      labels: array(raw["labels"]).map((label) => text(label, "name")),
      body: text(raw, "body"),
      comments: array(raw["comments"]).map((comment) => text(comment, "body")),
    });
  }

  const findings = evaluatePullPolicy(current, openPulls, issues);
  if (findings.length === 0) {
    console.log(`Pull policy: PR #${String(current.number)} passes P1-P5`);
  } else {
    for (const finding of findings)
      console.error(`${finding.rule} PR #${String(current.number)}: ${finding.message}`);
    process.exitCode = 1;
  }
}
