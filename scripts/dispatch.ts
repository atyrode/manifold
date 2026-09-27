#!/usr/bin/env bun
/**
 * The ready queue. `bun scripts/dispatch.ts [--next|--claims] [--limit N] [--json]
 * [--repo owner/name]`.
 *
 * `--next` first answers whether integration is drained: any open non-draft pull request outside
 * the ship integration lane refuses new work. Otherwise it lists ready issues in the order
 * `docs/TRIAGE.md` §Claims and dispatch defines: priority, then oldest. It removes what someone
 * else already holds: an issue with an open pull request against it, or a `Claim:` comment from
 * another login with no later `Release:` and less than CLAIM_HOURS old. Your own claims stay in
 * the list, because resuming your own work is the normal case. `--claims` shows exactly what
 * `--next` removed.
 *
 * This script never writes. Claiming is a comment you post; the claim is the comment, not a
 * label, an assignee or a row in a second tracker.
 */
import { $ } from "bun";

const PRIORITY = ["p0", "p1", "p2", "p3"] as const;
/** A claim goes stale at the same 24 hours as the quiet-branch rule in `AGENTS.md` Boundaries. */
const CLAIM_HOURS = 24;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 10;
const CLOSING_REFERENCE = /(?:Closes|Fixes|Resolves|Refs)\s+#(\d+)\b/gi;
const VERDICT = /^## Verdict:\s*(\w+)/;

type Priority = (typeof PRIORITY)[number] | "-";

export interface QueueComment {
  readonly body: string;
  readonly createdAt: string;
  readonly author: string;
}

export interface QueueIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly comments: readonly QueueComment[];
}

export interface Item {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly priority: Priority;
  readonly area: string;
  readonly createdAt: string;
  readonly ageDays: number;
  readonly status: string;
  /** Someone else has it: an open pull request, or a live claim from another login. */
  readonly held: boolean;
}

export interface DrainPull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  /** The armed auto-merge method (`SQUASH`, `REBASE` or `MERGE`), or null when none is armed. */
  readonly autoMerge: string | null;
  /** Committer date of the current head commit, or null when it was not resolved. */
  readonly headCommittedAt: string | null;
  /** Conversation comments, oldest first; `## Verdict:` reviews live here. */
  readonly comments: readonly Pick<QueueComment, "body" | "createdAt">[];
}

/**
 * The newest `## Verdict:` comment is `pass` and was posted after the head commit: a push
 * invalidates earlier verdicts (`docs/TRIAGE.md` §Pull requests). GitHub exposes no push time, so
 * the head commit's committer date is the bound. Anything unresolved is not current; an
 * unresolved head parses to NaN, which no verdict postdates.
 */
function currentPassVerdict(pull: DrainPull): boolean {
  const head = Date.parse(pull.headCommittedAt ?? "");
  let newest: { readonly at: number; readonly pass: boolean } | undefined;
  for (const comment of pull.comments) {
    const verdict = VERDICT.exec(comment.body.trimStart());
    if (verdict === null) continue;
    const at = Date.parse(comment.createdAt);
    if (Number.isNaN(at)) return false;
    if (newest === undefined || at >= newest.at) newest = { at, pass: verdict[1] === "pass" };
  }
  return newest !== undefined && newest.pass && newest.at > head;
}

/**
 * Non-draft work is integration work, and the ready issue queue stays closed until it drains. A
 * reviewed head with squash auto-merge armed is in the ship integration lane (`docs/TRIAGE.md`
 * §Runbooks › ship), which owns its integration; it no longer holds new work back.
 */
export function drainingPulls(pulls: readonly DrainPull[]): readonly DrainPull[] {
  return pulls
    .filter((pull) => !pull.isDraft && !(pull.autoMerge === "SQUASH" && currentPassVerdict(pull)))
    .sort((left, right) => left.number - right.number);
}

/**
 * The queue, pure: ready issues and open pull request bodies in, pick order out. Exported
 * because the live tracker cannot show a foreign claim or a stale one on demand, and "who holds
 * this" is the only judgement this script makes.
 */
export function queue(
  issues: readonly QueueIssue[],
  pullBodies: ReadonlyMap<number, string>,
  viewer: string,
  now: number,
): readonly Item[] {
  const pullFor = new Map<number, number>();
  for (const [pull, body] of pullBodies) {
    for (const match of body.matchAll(CLOSING_REFERENCE)) {
      const issue = Number(match[1]);
      if (Number.isInteger(issue) && !pullFor.has(issue)) pullFor.set(issue, pull);
    }
  }

  const items = issues.map((issue): Item => {
    // The newest claim nobody retired: a later `Release:` from the same author ends it.
    const comments = issue.comments.map((comment) => ({
      lead: comment.body.trimStart().toLowerCase(),
      at: Date.parse(comment.createdAt),
      author: comment.author,
    }));
    const claim = comments
      .filter((comment) => comment.lead.startsWith("claim"))
      .sort((a, b) => b.at - a.at)[0];
    const released =
      claim !== undefined &&
      comments.some(
        (comment) =>
          comment.author === claim.author &&
          comment.at > claim.at &&
          comment.lead.startsWith("release:"),
      );
    const claimHours = claim === undefined ? Infinity : (now - claim.at) / HOUR_MS;
    const live = claim !== undefined && !released && claimHours < CLAIM_HOURS;
    const pull = pullFor.get(issue.number);

    let status = "free";
    if (pull !== undefined) status = `pr #${String(pull)}`;
    else if (live && claim !== undefined) {
      const who = claim.author === viewer ? "you" : claim.author;
      status = `claimed by ${who} ${String(Math.floor(claimHours))}h`;
    }

    return {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      priority: PRIORITY.find((label) => issue.labels.includes(label)) ?? "-",
      area: issue.labels.find((label) => label.startsWith("area:"))?.slice("area:".length) ?? "-",
      createdAt: issue.createdAt,
      ageDays: Math.floor((now - Date.parse(issue.createdAt)) / DAY_MS),
      status,
      held: pull !== undefined || (live && claim !== undefined && claim.author !== viewer),
    };
  });

  // Pick order: p0 first, then p1..p3, an unprioritized issue last rather than first, oldest
  // first within a priority.
  const rank = (priority: Priority): number =>
    priority === "-" ? PRIORITY.length : PRIORITY.indexOf(priority);
  return items.sort(
    (a, b) => rank(a.priority) - rank(b.priority) || a.createdAt.localeCompare(b.createdAt),
  );
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

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

const REVIEW_EVIDENCE = `query($owner: String!, $name: String!, $number: Int!, $head: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid comments(last: 100) { nodes { body createdAt } } }
    object(oid: $head) { ... on Commit { committedDate } }
  }
}`;

/** GraphQL repository variables: `gh` fills its placeholders from the current checkout. */
function repoFields(repo: string | undefined): readonly string[] {
  if (repo === undefined) return ["-F", "owner={owner}", "-F", "name={repo}"];
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo);
  if (match === null) throw new Error("--repo needs owner/name");
  return ["-f", `owner=${match[1] ?? ""}`, "-f", `name=${match[2] ?? ""}`];
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

  const wantClaims = args.includes("--claims");
  const asJson = args.includes("--json");
  const limitArg = valueOf("--limit");
  const limit = limitArg === undefined ? DEFAULT_LIMIT : Number(limitArg);
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit needs a positive integer");
  const repo = valueOf("--repo");
  const repoArgs = repo === undefined ? [] : ["--repo", repo];

  const gh = async (command: readonly string[]): Promise<string> => {
    const result = await $`gh ${command}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString().trim() || `gh ${command.join(" ")} failed`);
    }
    return result.text();
  };

  const viewer = (await gh(["api", "user", "--jq", ".login"])).trim();

  const issues = asArray(
    JSON.parse(
      await gh([
        "issue",
        "list",
        ...repoArgs,
        "--label",
        "agent-ready",
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number,title,labels,createdAt,comments,url",
      ]),
    ),
  ).flatMap((raw): QueueIssue[] => {
    const record = asRecord(raw);
    const number = record["number"];
    if (typeof number !== "number") return [];
    return [
      {
        number,
        title: text(record, "title"),
        url: text(record, "url"),
        labels: asArray(record["labels"]).map((label) => text(label, "name")),
        createdAt: text(record, "createdAt"),
        comments: asArray(record["comments"]).map((comment) => ({
          body: text(comment, "body"),
          createdAt: text(comment, "createdAt"),
          author: text(asRecord(comment)["author"] ?? {}, "login"),
        })),
      },
    ];
  });

  // Verdict evidence is read only for armed squash auto-merges. The newest verdict, if any, is
  // among the newest 100 comments; the head commit is the listed head SHA. A head that moved
  // between the two reads, or a verdict older than that window, is therefore not current.
  const reviewEvidence = async (
    number: number,
    head: string,
  ): Promise<Pick<DrainPull, "headCommittedAt" | "comments">> => {
    const repository = asRecord(
      asRecord(
        asRecord(
          JSON.parse(
            await gh([
              "api",
              "graphql",
              "-f",
              `query=${REVIEW_EVIDENCE}`,
              ...repoFields(repo),
              "-F",
              `number=${String(number)}`,
              "-f",
              `head=${head}`,
            ]),
          ),
        )["data"],
      )["repository"],
    );
    const pull = asRecord(repository["pullRequest"]);
    const commit = repository["object"];
    const committedAt =
      text(pull, "headRefOid") === head && commit !== null && commit !== undefined
        ? text(commit, "committedDate")
        : "";
    return {
      headCommittedAt: committedAt === "" ? null : committedAt,
      comments: asArray(asRecord(pull["comments"])["nodes"]).map((comment) => ({
        body: text(comment, "body"),
        createdAt: text(comment, "createdAt"),
      })),
    };
  };

  const pullBodies = new Map<number, string>();
  const openPulls: DrainPull[] = [];
  for (const raw of asArray(
    JSON.parse(
      await gh([
        "pr",
        "list",
        ...repoArgs,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,url,body,isDraft,headRefName,headRefOid,autoMergeRequest",
      ]),
    ),
  )) {
    const record = asRecord(raw);
    const number = record["number"];
    if (typeof number !== "number") continue;
    pullBodies.set(number, text(record, "body"));
    const isDraft = record["isDraft"] === true;
    const request = record["autoMergeRequest"];
    const method = request === null || request === undefined ? "" : text(request, "mergeMethod");
    const autoMerge = method === "" ? null : method;
    const head = text(record, "headRefOid");
    openPulls.push({
      number,
      title: text(record, "title"),
      url: text(record, "url"),
      isDraft,
      autoMerge,
      ...(!wantClaims && !isDraft && autoMerge === "SQUASH" && head !== ""
        ? await reviewEvidence(number, head)
        : { headCommittedAt: null, comments: [] }),
    });
  }

  if (!wantClaims) {
    const draining = drainingPulls(openPulls);
    if (draining.length > 0) {
      if (asJson) {
        console.log(
          JSON.stringify(
            {
              blocked:
                "open non-draft pull requests outside the integration lane must drain before new work",
              pulls: draining.map(({ number, title, url, isDraft }) => ({
                number,
                title,
                url,
                isDraft,
              })),
            },
            null,
            2,
          ),
        );
      } else {
        console.error(
          "Dispatch blocked: drain every open non-draft pull request outside the integration lane first.",
        );
        for (const pull of draining) {
          console.error(`- #${String(pull.number)} ${pull.title} (${pull.url})`);
        }
      }
      process.exit(2);
    }
  }

  const items = queue(issues, pullBodies, viewer, Date.now());
  const selected = items.filter((item) => (wantClaims ? item.held : !item.held)).slice(0, limit);

  if (asJson) {
    console.log(JSON.stringify(selected, null, 2));
  } else if (selected.length === 0) {
    console.log(wantClaims ? "No held ready work." : "No free ready work.");
  } else {
    console.log("| # | pri | area | age | status | title |");
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const item of selected) {
      console.log(
        `| #${String(item.number)} | ${item.priority} | ${item.area} | ${String(item.ageDays)}d | ${item.status} | ${item.title} |`,
      );
    }
    const held = items.filter((item) => item.held).length;
    console.log(
      `\nReady: ${String(items.length)} issues, ${String(held)} held, showing ${String(selected.length)}`,
    );
  }
}
