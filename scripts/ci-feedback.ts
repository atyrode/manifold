#!/usr/bin/env bun
/** Trusted post-main CI repair routing and a bounded, non-polling CI status command. */

const CI_WORKFLOW_NAME = "CI";
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const MAIN_BRANCH = "main";
const MAX_JOBS = 20;
const MAX_PRS = 10;
const MAX_ISSUES = 10;
const MAX_TEXT = 120;
const MARKER_PREFIX = "ci-feedback";
const AUTOMATION_CREATOR = "github-actions[bot]";
const REPAIR_LABELS = ["p1", "bug", "area:infra", "needs-triage"] as const;
const READY_LABELS = ["p1", "bug", "area:infra", "agent-ready"] as const;
const FAILURE_CONCLUSIONS: Readonly<Record<string, true>> = {
  failure: true,
  timed_out: true,
  action_required: true,
  startup_failure: true,
};

type JsonRecord = Record<string, unknown>;
type LaneState =
  "green" | "failed" | "pending" | "cancelled" | "superseded" | "skipped" | "missing";

export interface TrustedRun {
  readonly id: number;
  readonly runNumber: number;
  readonly runAttempt: number;
  readonly event: "push" | "workflow_dispatch";
  readonly sha: string;
  readonly branch: "main";
  readonly status: "completed";
  readonly conclusion: string;
  readonly createdAt: string;
  readonly url: string;
  readonly actor: string;
}

export interface PublicJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

export interface PublicRun {
  readonly id: number;
  readonly runNumber: number;
  readonly createdAt: string;
  readonly event: string;
  readonly sha: string;
  readonly branch: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
  readonly jobs: readonly PublicJob[];
}

export interface StatusLane {
  readonly state: LaneState;
  readonly runId?: number;
  readonly runUrl?: string;
  readonly workflowStatus?: string;
  readonly conclusion?: string;
  readonly failedJobs: readonly { name: string; url: string }[];
  readonly skippedJobs: readonly { name: string; url: string }[];
}

export interface CiStatus {
  readonly version: 1;
  readonly repository: string;
  readonly sha: string;
  readonly fast: StatusLane;
  readonly full: StatusLane;
  readonly repairIssues: readonly string[];
  readonly repairHistory: readonly string[];
  readonly nextAction: string;
}

export interface RepairIssueState {
  readonly number: number;
  readonly creator: string;
  readonly title?: string;
  readonly state?: "open" | "closed";
  readonly body: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export type RepairIssueDecision =
  | { readonly action: "create"; readonly body: string; readonly promote: boolean }
  | {
      readonly action: "update" | "none";
      readonly issueNumber: number;
      readonly body: string;
      readonly promote: boolean;
      readonly preservedHumanContent: boolean;
    };

function record(value: unknown, context: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} is missing`);
  return value;
}

function requiredNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} is invalid`);
  }
  return value;
}

function bounded(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, limit);
}

function publicUrl(value: unknown): string {
  const candidate = bounded(value, 500);
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : "";
  } catch {
    return "";
  }
}

function requiredPublicUrl(value: unknown, context: string): string {
  const url = publicUrl(value);
  if (!url) throw new Error(`${context} is not a public GitHub URL`);
  return url;
}

function validSha(value: unknown, context: string): string {
  const sha = requiredString(value, context);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${context} is not a full commit SHA`);
  return sha.toLowerCase();
}

function validRepo(value: unknown, context: string): string {
  const repo = requiredString(value, context);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`${context} is invalid`);
  return repo;
}

function validLogin(value: unknown): string {
  const login = bounded(value, 39);
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login) ? login : "";
}

function validTimestamp(value: unknown, context: string): string {
  const timestamp = requiredString(value, context);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${context} is invalid`);
  return timestamp;
}

/**
 * Validate the complete trust boundary before a workflow_run can write. A well-formed CI run for
 * another event/branch is out of scope and returns null; malformed or identity-confused metadata
 * throws so the feedback workflow remains red rather than silently accepting it.
 */
export function parseTrustedWorkflowEvent(
  payload: unknown,
  expectedRepository: string,
): TrustedRun | null {
  const expected = validRepo(expectedRepository, "expected repository");
  const root = record(payload, "workflow_run event");
  if (root["action"] !== "completed") throw new Error("workflow_run action must be completed");

  const repository = record(root["repository"], "event repository");
  if (requiredString(repository["full_name"], "event repository.full_name") !== expected) {
    throw new Error("event repository does not match GITHUB_REPOSITORY");
  }
  if (
    requiredString(repository["default_branch"], "event repository.default_branch") !== MAIN_BRANCH
  ) {
    throw new Error("event repository default branch is not main");
  }

  const run = record(root["workflow_run"], "workflow_run");
  if (requiredString(run["name"], "workflow_run.name") !== CI_WORKFLOW_NAME) {
    throw new Error("workflow_run name is not CI");
  }
  if (requiredString(run["path"], "workflow_run.path") !== CI_WORKFLOW_PATH) {
    throw new Error("workflow_run path is not the trusted CI workflow");
  }

  const event = requiredString(run["event"], "workflow_run.event");
  if (event === "pull_request") return null;
  if (event !== "push" && event !== "workflow_dispatch") {
    throw new Error(`unsupported CI event: ${bounded(event)}`);
  }

  const headRepository = record(run["head_repository"], "workflow_run.head_repository");
  if (
    requiredString(headRepository["full_name"], "workflow_run.head_repository.full_name") !==
    expected
  ) {
    throw new Error("workflow_run head repository is not the trusted repository");
  }
  if (run["repository"] !== undefined) {
    const runRepository = record(run["repository"], "workflow_run.repository");
    if (
      requiredString(runRepository["full_name"], "workflow_run.repository.full_name") !== expected
    ) {
      throw new Error("workflow_run repository is not the trusted repository");
    }
  }

  const branch = requiredString(run["head_branch"], "workflow_run.head_branch");
  if (branch !== MAIN_BRANCH) return null;
  if (requiredString(run["status"], "workflow_run.status") !== "completed") {
    throw new Error("workflow_run is not completed");
  }

  const actorValue = run["triggering_actor"] ?? run["actor"];
  const actor = validLogin(record(actorValue, "workflow_run actor")["login"]);
  return {
    id: requiredNumber(run["id"], "workflow_run.id"),
    runNumber: requiredNumber(run["run_number"], "workflow_run.run_number"),
    runAttempt: requiredNumber(run["run_attempt"], "workflow_run.run_attempt"),
    event,
    sha: validSha(run["head_sha"], "workflow_run.head_sha"),
    branch: MAIN_BRANCH,
    status: "completed",
    conclusion: requiredString(run["conclusion"], "workflow_run.conclusion"),
    createdAt: validTimestamp(run["created_at"], "workflow_run.created_at"),
    url: requiredPublicUrl(run["html_url"], "workflow_run.html_url"),
    actor,
  };
}

export function issueMarker(runId: number): string {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("run ID is invalid");
  return `<!-- ${MARKER_PREFIX}:run=${String(runId)} -->`;
}

function shaMarker(sha: string): string {
  return `<!-- ${MARKER_PREFIX}:sha=${sha} -->`;
}

const MANAGED_SECTION =
  /<!-- ci-feedback:managed:start sha256=([0-9a-f]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- ci-feedback:managed:end -->/;

function bodyHash(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body.replace(/\r\n/g, "\n")).digest("hex");
}

export function managedRepairBody(content: string): string {
  return `<!-- ci-feedback:managed:start sha256=${bodyHash(content)} -->\n${content}\n<!-- ci-feedback:managed:end -->`;
}

function managedParts(
  body: string,
): { prefix: string; content: string; suffix: string; valid: boolean } | null {
  const match = MANAGED_SECTION.exec(body);
  if (!match || match.index === undefined) return null;
  if (body.indexOf("<!-- ci-feedback:managed:start", match.index + match[0].length) !== -1)
    return null;
  const content = match[2]!;
  return {
    prefix: body.slice(0, match.index),
    content,
    suffix: body.slice(match.index + match[0].length),
    valid: bodyHash(content) === match[1],
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

/**
 * Decide both the bounded managed-body mutation and the safe state transition. Human text outside
 * the managed section is retained; a modified/invalid managed section is never overwritten.
 */
export function decideRepairIssue(
  runId: number,
  desiredBody: string,
  owner: string,
  actionable: boolean,
  issues: readonly RepairIssueState[],
): RepairIssueDecision {
  const marker = issueMarker(runId);
  const matches = issues.filter(
    (issue) =>
      issue.creator === AUTOMATION_CREATOR &&
      (issue.body.includes(marker) || issue.title?.endsWith(`(run ${String(runId)})`)),
  );
  if (matches.length > 1)
    throw new Error(`multiple repair issues contain marker for run ${String(runId)}`);
  const existing = matches[0];
  if (!existing) return { action: "create", body: desiredBody, promote: actionable };
  if (existing.state === "closed") {
    return {
      action: "none",
      issueNumber: existing.number,
      body: existing.body,
      promote: false,
      preservedHumanContent: true,
    };
  }

  const current = managedParts(existing.body);
  const desired = managedParts(desiredBody);
  if (!desired?.valid) throw new Error("desired repair body is not a valid managed section");
  const managedUntouched = current?.valid === true;
  const humanContent =
    !current || current.prefix.trim().length > 0 || current.suffix.trim().length > 0;
  const body =
    current?.valid === true ? `${current.prefix}${desiredBody}${current.suffix}` : existing.body;
  const untouchedInitialTriage =
    managedUntouched &&
    !humanContent &&
    sameStrings(existing.labels, REPAIR_LABELS) &&
    sameStrings(existing.assignees, [owner]);
  return {
    action: body === existing.body ? "none" : "update",
    issueNumber: existing.number,
    body,
    promote: actionable && untouchedInitialTriage,
    preservedHumanContent: humanContent || !managedUntouched,
  };
}

function publicJob(value: unknown): PublicJob {
  const job = record(value, "workflow job");
  return {
    id: requiredNumber(job["id"], "workflow job.id"),
    name: bounded(job["name"]) || "unnamed job",
    status: bounded(job["status"], 32),
    conclusion: bounded(job["conclusion"], 32),
    url: requiredPublicUrl(job["html_url"], "workflow job.html_url"),
  };
}

function publicRun(value: unknown, jobs: readonly PublicJob[] = []): PublicRun {
  const run = record(value, "workflow run");
  return {
    id: requiredNumber(run["id"], "workflow run.id"),
    runNumber: requiredNumber(run["run_number"], "workflow run.run_number"),
    createdAt: validTimestamp(run["created_at"], "workflow run.created_at"),
    event: bounded(run["event"], 32),
    sha: validSha(run["head_sha"], "workflow run.head_sha"),
    branch: bounded(run["head_branch"], 100),
    status: bounded(run["status"], 32),
    conclusion: bounded(run["conclusion"], 32),
    url: requiredPublicUrl(run["html_url"], "workflow run.html_url"),
    jobs: jobs.slice(0, 100),
  };
}

function lane(run: PublicRun | undefined, superseded = false): StatusLane {
  if (!run) return { state: "missing", failedJobs: [], skippedJobs: [] };
  const failedJobs = run.jobs
    .filter((job) => FAILURE_CONCLUSIONS[job.conclusion])
    .slice(0, MAX_JOBS)
    .map((job) => ({ name: bounded(job.name) || "unnamed job", url: publicUrl(job.url) }));
  const skippedJobs = run.jobs
    .filter((job) => job.conclusion === "skipped")
    .slice(0, MAX_JOBS)
    .map((job) => ({ name: bounded(job.name) || "unnamed job", url: publicUrl(job.url) }));
  let state: LaneState;
  if (run.status !== "completed") state = "pending";
  else if (run.conclusion === "success") state = "green";
  else if (run.conclusion === "cancelled") state = superseded ? "superseded" : "cancelled";
  else if (run.conclusion === "skipped" || run.conclusion === "neutral") state = "skipped";
  else state = "failed";
  return {
    state,
    runId: run.id,
    runUrl: publicUrl(run.url),
    workflowStatus: bounded(run.status, 32),
    conclusion: bounded(run.conclusion, 32),
    failedJobs,
    skippedJobs,
  };
}

/** Build the stable public status schema from already-fetched, whitelisted metadata. */
export function buildStatus(
  repository: string,
  sha: string,
  runs: readonly PublicRun[],
  repairIssues: readonly string[],
  repairHistory: readonly string[] = [],
): CiStatus {
  const target = validSha(sha, "status SHA");
  const relevant = runs
    .filter((run) => run.sha === target)
    .sort((a, b) => b.runNumber - a.runNumber || b.id - a.id);
  const fastRun = relevant.find((run) => run.event === "pull_request");
  const fullRun = relevant.find(
    (run) =>
      (run.event === "push" || run.event === "workflow_dispatch") && run.branch === MAIN_BRANCH,
  );
  const fullSuperseded =
    fullRun?.conclusion === "cancelled" &&
    runs.some(
      (run) =>
        (run.event === "push" || run.event === "workflow_dispatch") &&
        run.branch === MAIN_BRANCH &&
        run.runNumber > fullRun.runNumber,
    );
  const fast = lane(fastRun);
  const full = lane(fullRun, fullSuperseded);
  const links = repairIssues.map(publicUrl).filter(Boolean).slice(0, MAX_ISSUES);
  const historyLinks = repairHistory.map(publicUrl).filter(Boolean).slice(0, MAX_ISSUES);

  let nextAction: string;
  if (full.state === "failed") {
    nextAction =
      links.length > 0
        ? "Repair the failed full-main run using the linked open issue."
        : historyLinks.length > 0
          ? "The matching repair issue is closed history; inspect it and request fresh triage without reopening or duplicating it."
          : "Route the failed full-main run to a CI repair issue.";
  } else if (full.state === "pending") {
    nextAction = "Full main verification is still running; inspect the run without polling.";
  } else if (full.state === "green") {
    nextAction = "Full main verification is green for this exact revision.";
  } else if (full.state === "superseded") {
    nextAction = "This cancelled full-main run was superseded by a newer full-main run.";
  } else if (full.state === "cancelled") {
    nextAction = "This full run was cancelled without newer full-main evidence; inspect it.";
  } else if (fast.state === "failed") {
    nextAction = "Repair the failed fast PR checks before integration.";
  } else if (fast.state === "green") {
    nextAction = "Fast PR checks are green; full main verification has not run for this revision.";
  } else {
    nextAction = "No CI evidence was found for this exact revision; run or inspect CI.";
  }

  return {
    version: 1,
    repository: validRepo(repository, "repository"),
    sha: target,
    fast,
    full,
    repairIssues: links,
    repairHistory: historyLinks,
    nextAction,
  };
}

export function renderStatus(status: CiStatus, json: boolean): string {
  if (json) return `${JSON.stringify(status)}\n`;
  const rows = [
    `revision: ${status.sha}`,
    `fast PR: ${status.fast.state}${status.fast.runUrl ? ` ${status.fast.runUrl}` : ""}`,
    `full main: ${status.full.state}${status.full.runUrl ? ` ${status.full.runUrl}` : ""}`,
  ];
  for (const [kind, current] of [
    ["failed", [...status.fast.failedJobs, ...status.full.failedJobs]],
    ["skipped", [...status.fast.skippedJobs, ...status.full.skippedJobs]],
  ] as const) {
    for (const job of current.slice(0, MAX_JOBS))
      rows.push(`${kind} job: ${job.name}${job.url ? ` ${job.url}` : ""}`);
  }
  for (const issue of status.repairIssues) rows.push(`repair issue: ${issue}`);
  for (const issue of status.repairHistory) rows.push(`repair history: ${issue}`);
  rows.push(`next: ${status.nextAction}`);
  return `${rows.join("\n")}\n`;
}

async function gh(args: readonly string[], input?: unknown): Promise<string> {
  const child = Bun.spawn(["gh", ...args], {
    stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(bounded(stderr, 1000) || `gh ${args.join(" ")} failed`);
  return stdout;
}

async function ghJson(args: readonly string[], input?: unknown): Promise<unknown> {
  const output = await gh(args, input);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`gh ${args.join(" ")} returned invalid JSON`);
  }
}

function array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
}

async function listJobs(repository: string, runId: number): Promise<readonly PublicJob[]> {
  const response = record(
    await ghJson(["api", `repos/${repository}/actions/runs/${String(runId)}/jobs?per_page=100`]),
    "jobs response",
  );
  const total = response["total_count"];
  if (typeof total !== "number" || total > 100)
    throw new Error("workflow job metadata is missing or exceeds the safe bound of 100");
  return array(response["jobs"], "jobs response.jobs").map(publicJob);
}

interface RepairIssue extends RepairIssueState {
  readonly url: string;
  readonly title: string;
}

interface AssociatedPull {
  readonly number: number;
  readonly url: string;
  readonly author: string;
  readonly mergedBy: string;
}

function repairIssue(value: unknown): RepairIssue {
  const issue = record(value, "repair issue");
  const state = bounded(issue["state"], 16).toLowerCase();
  if (state !== "open" && state !== "closed") throw new Error("repair issue.state is invalid");
  return {
    number: requiredNumber(issue["number"], "repair issue.number"),
    creator: bounded(record(issue["user"], "repair issue.user")["login"], 100),
    title: bounded(issue["title"], 300),
    state,
    body: typeof issue["body"] === "string" ? issue["body"].slice(0, 100_000) : "",
    labels: array(issue["labels"], "repair issue.labels")
      .map((label) => bounded(record(label, "repair issue label")["name"], 100))
      .filter(Boolean),
    assignees: array(issue["assignees"], "repair issue.assignees")
      .map((assignee) => validLogin(record(assignee, "repair issue assignee")["login"]))
      .filter(Boolean),
    url: requiredPublicUrl(issue["html_url"] ?? issue["url"], "repair issue.html_url"),
  };
}

async function searchIssues(
  repository: string,
  marker: string,
  since: string,
): Promise<readonly RepairIssue[]> {
  const query = [
    "state=all",
    "sort=updated",
    "direction=desc",
    "per_page=100",
    `since=${encodeURIComponent(validTimestamp(since, "issue lookup since"))}`,
  ].join("&");
  const values = array(
    await ghJson(["api", `repos/${repository}/issues?${query}`]),
    "issue list response",
  );
  if (values.length === 100) {
    throw new Error(
      "bounded direct issue lookup is truncated; refusing a potentially duplicate mutation",
    );
  }
  const runId = /ci-feedback:run=(\d+)/.exec(marker)?.[1];
  return values
    .filter((value) => record(value, "repair issue")["pull_request"] === undefined)
    .map(repairIssue)
    .filter((issue) => issue.creator === AUTOMATION_CREATOR)
    .filter(
      (issue) =>
        issue.body.includes(marker) ||
        (runId !== undefined && issue.title.endsWith(`(run ${runId})`)),
    );
}

async function associatedPulls(
  repository: string,
  sha: string,
): Promise<readonly AssociatedPull[]> {
  const values = array(
    await ghJson(["api", `repos/${repository}/commits/${sha}/pulls?per_page=${String(MAX_PRS)}`]),
    "associated pulls",
  );
  return values
    .flatMap((value) => {
      const pull = record(value, "associated pull");
      if (typeof pull["merged_at"] !== "string") return [];
      const base = record(pull["base"], "associated pull.base");
      if (base["ref"] !== MAIN_BRANCH) return [];
      const author = validLogin(record(pull["user"], "associated pull.user")["login"]);
      const mergedByValue = pull["merged_by"];
      const mergedBy =
        mergedByValue === null || mergedByValue === undefined
          ? ""
          : validLogin(record(mergedByValue, "associated pull.merged_by")["login"]);
      return [
        {
          number: requiredNumber(pull["number"], "associated pull.number"),
          url: requiredPublicUrl(pull["html_url"], "associated pull.html_url"),
          author,
          mergedBy,
        },
      ];
    })
    .slice(0, MAX_PRS);
}

async function resolvableOwner(repository: string, candidates: readonly string[]): Promise<string> {
  for (const candidate of [...new Set(candidates.map(validLogin).filter(Boolean))]) {
    const child = Bun.spawn(["gh", "api", `repos/${repository}/assignees/${candidate}`], {
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    if ((await child.exited) === 0) return candidate;
  }
  throw new Error(
    "no associated PR author, merger, or workflow actor is a resolvable triage owner",
  );
}

function failedJobs(jobs: readonly PublicJob[]): readonly PublicJob[] {
  return jobs.filter((job) => FAILURE_CONCLUSIONS[job.conclusion]).slice(0, MAX_JOBS);
}

function renderRepairBody(
  run: TrustedRun,
  jobs: readonly PublicJob[],
  pulls: readonly AssociatedPull[],
  owner: string,
  repository: string,
): string {
  const failures = failedJobs(jobs);
  const jobRows =
    failures.length > 0
      ? failures.map(
          (job) =>
            `- [${job.name.replace(/([\\[\]()@])/g, "\\$1")}](${job.url || run.url}) — \`${job.conclusion}\` (job ${String(job.id)})`,
        )
      : [
          "- The workflow reported failure without a failed job in bounded Actions metadata; inspect the run summary.",
        ];
  const pullRows =
    pulls.length > 0
      ? pulls.map(
          (pull) => `- [#${String(pull.number)}](${pull.url}) — @${pull.author || "unknown"}`,
        )
      : ["- No merged PR was associated with this revision by GitHub."];
  const shaUrl = `https://github.com/${repository}/commit/${run.sha}`;
  const content = [
    issueMarker(run.id),
    shaMarker(run.sha),
    "## Problem",
    "",
    `Full main verification did not pass for [\`${run.sha}\`](${shaUrl}) in [CI run ${String(run.id)}](${run.url}).`,
    `Conclusion: \`${run.conclusion}\`; run attempt: \`${String(run.runAttempt)}\`; event: \`${run.event}\`; branch: \`${run.branch}\`.`,
    "",
    `**Accountable triage owner:** @${owner}. This assignment owns routing and resolution; it does not assert that the owner caused the defect.`,
    "",
    "### Failed jobs",
    "",
    ...jobRows,
    "",
    "### Associated merged pull requests",
    "",
    ...pullRows,
    "",
    "## Standing scope",
    "",
    "Issue #574 authorizes diagnosis and repository/CI repair for this failure. Do not deploy or release, use live credentials, weaken security or data-loss boundaries, remove assertions, or widen the change beyond the demonstrated failure without operator approval.",
    "",
    "## Reproduce and repair",
    "",
    `1. Check out exact revision \`${run.sha}\` from the trusted repository without persisting credentials.`,
    `2. Open the linked failed job summary and reproduce its named check locally on that exact tree; do not download or execute PR artifacts from this feedback workflow.`,
    "3. Identify the root cause, make the smallest source fix, and rerun the focused failing command plus the risk-plan baseline for the changed paths.",
    "4. Push the repair through normal review and require a new full main CI run for the repaired exact revision.",
    "5. If a safe repair is not available, prepare a reviewed revert of the associated merged PR(s). Do not auto-revert.",
    "",
    "## Acceptance",
    "",
    "- The failure is reproduced or the run evidence explains why it cannot be reproduced, and the root cause is recorded here.",
    "- The focused failed check passes on the repair revision without weakening assertions or mandatory boundary checks.",
    "- The risk-plan baseline selected for the repair passes, and full main CI is green for the exact integrated repair revision.",
    "- The repair or reviewed revert is linked here; uncertain defects remain open for triage rather than being auto-closed.",
    "",
    "Automation promotes this issue only after concrete failed-job evidence, ownership, scope, and acceptance are complete.",
  ].join("\n");
  return managedRepairBody(content);
}

export function repairIsActionable(
  body: string,
  owner: string,
  jobs: readonly PublicJob[],
): boolean {
  return (
    validLogin(owner) === owner &&
    failedJobs(jobs).some((job) => job.name.length > 0 && job.url.length > 0) &&
    body.includes("## Problem") &&
    body.includes("## Acceptance") &&
    body.includes("## Standing scope") &&
    body.includes("Issue #574")
  );
}

async function routeFailure(repository: string, run: TrustedRun, dryRun = false): Promise<void> {
  const [jobs, pulls] = await Promise.all([
    listJobs(repository, run.id),
    associatedPulls(repository, run.sha),
  ]);
  const owner = await resolvableOwner(repository, [
    ...pulls.map((pull) => pull.author),
    ...pulls.map((pull) => pull.mergedBy),
    run.actor,
  ]);
  const body = renderRepairBody(run, jobs, pulls, owner, repository);
  const existing = await searchIssues(repository, issueMarker(run.id), run.createdAt);
  const actionable = repairIsActionable(body, owner, jobs);
  const decision = decideRepairIssue(run.id, body, owner, actionable, existing);
  const title = `CI repair: main ${run.sha.slice(0, 12)} (run ${String(run.id)})`;
  const createPayload = { title, body, labels: [...REPAIR_LABELS], assignees: [owner] };
  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify({
        version: 1,
        dryRun: true,
        run: {
          id: run.id,
          attempt: run.runAttempt,
          sha: run.sha,
          url: run.url,
          conclusion: run.conclusion,
        },
        mutation: decision,
        steps: [
          ...(decision.action === "create" ? [{ action: "create", payload: createPayload }] : []),
          ...(decision.action === "update"
            ? [
                {
                  action: "update-body",
                  issueNumber: decision.issueNumber,
                  payload: { body: decision.body },
                },
              ]
            : []),
          ...(decision.promote
            ? [
                {
                  action: "promote-agent-ready",
                  issueNumber: decision.action === "create" ? null : decision.issueNumber,
                  payload: { labels: READY_LABELS },
                },
              ]
            : []),
        ],
      })}\n`,
    );
    return;
  }

  let issueNumber: number;
  if (decision.action === "create") {
    const created = record(
      await ghJson(
        ["api", "--method", "POST", `repos/${repository}/issues`, "--input", "-"],
        createPayload,
      ),
      "created repair issue",
    );
    issueNumber = requiredNumber(created["number"], "created repair issue.number");
  } else {
    issueNumber = decision.issueNumber;
    if (decision.action === "update") {
      await ghJson(
        [
          "api",
          "--method",
          "PATCH",
          `repos/${repository}/issues/${String(issueNumber)}`,
          "--input",
          "-",
        ],
        {
          body: decision.body,
        },
      );
    }
  }
  if (decision.promote) {
    await ghJson(
      [
        "api",
        "--method",
        "PATCH",
        `repos/${repository}/issues/${String(issueNumber)}`,
        "--input",
        "-",
      ],
      {
        labels: [...READY_LABELS],
      },
    );
  }
}

async function isSupersededCancellation(repository: string, run: TrustedRun): Promise<boolean> {
  const response = record(
    await ghJson([
      "api",
      `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&per_page=20`,
    ]),
    "workflow runs response",
  );
  return array(response["workflow_runs"], "workflow runs response.workflow_runs").some((value) => {
    const candidate = record(value, "workflow run");
    return (
      (candidate["event"] === "push" || candidate["event"] === "workflow_dispatch") &&
      candidate["head_branch"] === MAIN_BRANCH &&
      typeof candidate["run_number"] === "number" &&
      candidate["run_number"] > run.runNumber
    );
  });
}

async function earliestRunCreation(repository: string, sha: string): Promise<string> {
  const response = record(
    await ghJson([
      "api",
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
    ]),
    "revision workflow runs response",
  );
  const total = response["total_count"];
  if (typeof total !== "number" || total > 100) {
    throw new Error("revision workflow metadata is missing or exceeds the safe bound of 100");
  }
  const timestamps = array(response["workflow_runs"], "revision workflow runs")
    .map((value) =>
      validTimestamp(
        record(value, "revision workflow run")["created_at"],
        "revision workflow run.created_at",
      ),
    )
    .sort();
  const earliest = timestamps[0];
  if (!earliest) throw new Error("revision has no workflow-run creation metadata");
  return earliest;
}

async function annotateRecovery(repository: string, run: TrustedRun): Promise<void> {
  const issues = await searchIssues(
    repository,
    shaMarker(run.sha),
    await earliestRunCreation(repository, run.sha),
  );
  const marker = `<!-- ${MARKER_PREFIX}:recovery-run=${String(run.id)} -->`;
  for (const issue of issues.slice(0, MAX_ISSUES)) {
    const comments = array(
      await ghJson([
        "api",
        `repos/${repository}/issues/${String(issue.number)}/comments?per_page=100`,
      ]),
      "repair issue comments",
    );
    if (comments.length === 100)
      throw new Error(
        `repair issue #${String(issue.number)} has too many comments for idempotent recovery`,
      );
    if (
      comments.some(
        (value) =>
          typeof record(value, "repair issue comment")["body"] === "string" &&
          String(record(value, "repair issue comment")["body"]).includes(marker),
      )
    )
      continue;
    await ghJson(
      [
        "api",
        "--method",
        "POST",
        `repos/${repository}/issues/${String(issue.number)}/comments`,
        "--input",
        "-",
      ],
      {
        body: `${marker}\nFull main CI later passed for the same exact revision in [run ${String(run.id)}](${run.url}). This is recovery evidence only; the defect is not auto-closed.`,
      },
    );
  }
}

async function currentRunAttempt(
  repository: string,
  eventRun: TrustedRun,
): Promise<TrustedRun | null> {
  const liveValue = await ghJson([
    "api",
    `repos/${repository}/actions/runs/${String(eventRun.id)}`,
  ]);
  const live = record(liveValue, "current workflow run");
  const attempt = requiredNumber(live["run_attempt"], "current workflow run.run_attempt");
  const status = requiredString(live["status"], "current workflow run.status");
  if (attempt > eventRun.runAttempt || status !== "completed") return null;
  if (attempt < eventRun.runAttempt)
    throw new Error("current workflow run attempt is older than the event");
  const current = parseTrustedWorkflowEvent(
    {
      action: "completed",
      repository: { full_name: repository, default_branch: MAIN_BRANCH },
      workflow_run: liveValue,
    },
    repository,
  );
  if (!current) throw new Error("current workflow run no longer has trusted full-main identity");
  if (
    current.sha !== eventRun.sha ||
    current.runNumber !== eventRun.runNumber ||
    current.conclusion !== eventRun.conclusion
  ) {
    throw new Error("current workflow run identity differs from the completed event");
  }
  return current;
}

async function processEvent(path: string, repository: string): Promise<void> {
  const eventRun = parseTrustedWorkflowEvent(JSON.parse(await Bun.file(path).text()), repository);
  if (!eventRun) return;
  const run = await currentRunAttempt(repository, eventRun);
  if (!run) {
    process.stdout.write(
      `stale workflow_run event for run ${String(eventRun.id)} attempt ${String(eventRun.runAttempt)}; no mutation\n`,
    );
    return;
  }
  if (FAILURE_CONCLUSIONS[run.conclusion]) {
    await routeFailure(repository, run);
  } else if (run.conclusion === "success") {
    await annotateRecovery(repository, run);
  } else if (run.conclusion === "cancelled") {
    const superseded = await isSupersededCancellation(repository, run);
    process.stdout.write(
      `${superseded ? "superseded" : "non-superseded"} cancelled full-main run ${String(run.id)}; no defect was auto-filed\n`,
    );
  }
}

async function repositoryName(): Promise<string> {
  const configured = process.env["GH_REPO"] || process.env["GITHUB_REPOSITORY"];
  if (configured) return validRepo(configured, "repository");
  return validRepo(
    (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim(),
    "repository",
  );
}

async function currentSha(explicit: string | undefined): Promise<string> {
  if (explicit) return validSha(explicit, "--sha");
  return validSha((await Bun.$`git rev-parse HEAD`.quiet()).text().trim(), "HEAD");
}

async function statusCommand(explicitSha: string | undefined, json: boolean): Promise<void> {
  const repository = await repositoryName();
  const sha = await currentSha(explicitSha);
  const [shaResponse, mainResponse] = await Promise.all([
    ghJson([
      "api",
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20`,
    ]),
    ghJson(["api", `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&per_page=20`]),
  ]);
  const shaRunsResponse = record(shaResponse, "SHA workflow runs response");
  const shaRunTotal = shaRunsResponse["total_count"];
  if (typeof shaRunTotal !== "number" || shaRunTotal > 20) {
    throw new Error("revision workflow metadata is missing or exceeds the status bound of 20");
  }
  const rawRuns = [
    ...array(shaRunsResponse["workflow_runs"], "SHA workflow runs"),
    ...array(
      record(mainResponse, "main workflow runs response")["workflow_runs"],
      "main workflow runs",
    ),
  ].slice(0, 40);
  const uniqueRuns = [
    ...new Map(
      rawRuns.map((value) => [
        requiredNumber(record(value, "workflow run")["id"], "workflow run.id"),
        value,
      ]),
    ).values(),
  ];
  const runs = await Promise.all(
    uniqueRuns.map(async (value) => {
      const base = publicRun(value);
      return publicRun(value, base.sha === sha ? await listJobs(repository, base.id) : []);
    }),
  );
  const exactRunTimes = runs
    .filter((run) => run.sha === sha)
    .map((run) => run.createdAt)
    .sort();
  const issues = exactRunTimes[0]
    ? await searchIssues(repository, shaMarker(sha), exactRunTimes[0])
    : [];
  const openIssues = issues.filter((issue) => issue.state === "open").map((issue) => issue.url);
  const closedIssues = issues.filter((issue) => issue.state === "closed").map((issue) => issue.url);
  process.stdout.write(
    renderStatus(buildStatus(repository, sha, runs, openIssues, closedIssues), json),
  );
}

async function dryRunCommand(runIdText: string | undefined): Promise<void> {
  if (!runIdText || !/^[1-9]\d*$/.test(runIdText))
    throw new Error("--dry-run requires --run-id <positive integer>");
  const runId = Number(runIdText);
  if (!Number.isSafeInteger(runId)) throw new Error("--run-id is too large");
  const repository = await repositoryName();
  const [repositoryMetadata, runMetadata] = await Promise.all([
    ghJson(["api", `repos/${repository}`]),
    ghJson(["api", `repos/${repository}/actions/runs/${String(runId)}`]),
  ]);
  const run = parseTrustedWorkflowEvent(
    {
      action: "completed",
      repository: repositoryMetadata,
      workflow_run: runMetadata,
    },
    repository,
  );
  if (!run) throw new Error("historical run is not a full main push/workflow_dispatch run");
  if (!FAILURE_CONCLUSIONS[run.conclusion]) {
    throw new Error(`historical run conclusion ${run.conclusion} is not a routable failure`);
  }
  await routeFailure(repository, run, true);
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const known: Readonly<Record<string, true>> = {
    "--status": true,
    "--json": true,
    "--sha": true,
    "--event": true,
    "--dry-run": true,
    "--run-id": true,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!known[arg]) throw new Error(`unknown argument: ${arg}`);
    if (arg === "--sha" || arg === "--event" || arg === "--run-id") index++;
  }
  const eventPath = optionValue(args, "--event");
  if (args.includes("--status")) {
    if (eventPath || args.includes("--dry-run") || args.includes("--run-id")) {
      throw new Error("--status cannot be combined with --event, --dry-run, or --run-id");
    }
    await statusCommand(optionValue(args, "--sha"), args.includes("--json"));
    return;
  }
  if (args.includes("--dry-run")) {
    if (eventPath || args.includes("--sha"))
      throw new Error("--dry-run cannot be combined with --event or --sha");
    await dryRunCommand(optionValue(args, "--run-id"));
    return;
  }
  if (args.includes("--json") || args.includes("--sha") || args.includes("--run-id")) {
    throw new Error("--json/--sha require --status; --run-id requires --dry-run");
  }
  await processEvent(
    eventPath ?? requiredString(process.env["GITHUB_EVENT_PATH"], "GITHUB_EVENT_PATH"),
    validRepo(process.env["GITHUB_REPOSITORY"], "GITHUB_REPOSITORY"),
  );
}

if (import.meta.main) {
  await main();
}
