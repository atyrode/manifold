#!/usr/bin/env bun
/**
 * The one release path. `bun run release [--dry-run] [major|minor|patch|x.y.z]`.
 *
 * With no level, the fragments decide (release-core `deriveReleaseLevel`). `--dry-run` reads
 * the same inputs, prints the version it would cut, the bullets grouped by section and whether
 * a protocol bump is pending, then exits 0 having touched nothing — from any branch, clean or
 * not. A real release refuses anything but a clean `main` that matches `origin/main` and has a
 * green ci.yml run, and refuses a fragment whose adding commit carries no `(#N)` squash suffix.
 *
 * The release commit lands through a rebase-auto-merged PR; only the matching merged main
 * tree is tagged. GitHub must allow auto-merge and rebase merges; no ruleset bypass is needed.
 * If interrupted, retain the clean checkout and resume the explicit version with
 * `bun run release --resume vX.Y.Z` under the same release authorization. Resume reuses
 * the prepared commit, release branch, checked PR and immutable tag rather than bumping
 * again. Conflicting state is refused; never manually tag an unmerged release commit.
 */
import { $ } from "bun";
import { z } from "zod";
import {
  CHANGELOG_SECTIONS,
  assembleChangelog,
  derivePullRequest,
  deriveReleaseLevel,
  parseVersion,
  readFragments,
  renderFragmentBullet,
  renderReleaseSection,
  resolveReleaseVersion,
  type ChangeFragment,
  type ReleasedFragment,
} from "./release-core.ts";
import {
  releaseRepository,
  requireFullMainCi,
  requireImmutableReleaseSetting,
  verifyReleaseCandidate,
  verifyReleaseCommit,
  verifyReleaseTag,
} from "./release-provenance.ts";
import { assertWorkspaceVersions } from "./workspace-versions.ts";

interface PackageMetadata {
  readonly version: string;
  readonly [key: string]: unknown;
}

const PROTOCOL_VERSION_FILE = "packages/protocol/src/version.ts";
const PROTOCOL_VERSION_PATTERN = /^export const PROTOCOL_VERSION = (\d+);/m;

async function gitText(args: readonly string[]): Promise<string> {
  const result = await $`git ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Git failed");
  return result.text().trim();
}

function protocolVersionOf(source: string, where: string): number {
  const match = PROTOCOL_VERSION_PATTERN.exec(source);
  if (match === null) throw new Error(`${where} declares no PROTOCOL_VERSION`);
  return Number(match[1]);
}

/**
 * The pull request that landed a fragment: the `(#N)` suffix of the squash commit that ADDED
 * the file. A migrated fragment may carry `pr:` itself. Null names a fragment a release
 * would refuse — uncommitted, or added by a commit without the suffix.
 */
async function pullRequestOf(fragment: ChangeFragment): Promise<number | null> {
  if (fragment.pr !== null) return fragment.pr;
  const subjects = await gitText([
    "log",
    "--diff-filter=A",
    "--format=%s",
    "--",
    `changes/${fragment.file}`,
  ]);
  const subject = subjects.split("\n")[0] ?? "";
  return subject === "" ? null : derivePullRequest(subject);
}

/**
 * Required checks decide when the release PR may land. A closed PR or a bounded wait that
 * expires leaves the release untagged and names the PR so the operator can recover it.
 */
async function waitForReleasePull(repository: string, url: string): Promise<string> {
  console.log(`Waiting for release PR ${url} to merge…`);
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const result = await $`gh pr view ${url} --repo ${repository} --json state,mergedAt,mergeCommit`.quiet().text();
    const pull = JSON.parse(result) as {
      readonly state: string;
      readonly mergedAt: string | null;
      readonly mergeCommit: { readonly oid: string } | null;
    };
    if (pull.state === "MERGED" && pull.mergedAt !== null && pull.mergeCommit !== null) {
      return z.string().regex(/^[0-9a-f]{40}$/).parse(pull.mergeCommit.oid);
    }
    if (pull.state === "CLOSED") throw new Error(`Release PR closed without merging: ${url}`);
    await Bun.sleep(10_000);
  }
  throw new Error(`Release PR did not merge within 30 minutes; no tag was created: ${url}`);
}

async function watchRelease(tag: string): Promise<void> {
  console.log("Waiting for the GitHub release workflow…");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result =
      await $`gh run list --workflow release.yml --branch ${tag} --limit 1 --json databaseId`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) {
      const runs = JSON.parse(result.text()) as readonly { readonly databaseId: number }[];
      const run = runs[0];
      if (run !== undefined) {
        const watched = await $`gh run watch ${run.databaseId} --exit-status`.nothrow();
        if (watched.exitCode !== 0) throw new Error(`GitHub release workflow failed for ${tag}`);
        return;
      }
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`GitHub release workflow did not start for ${tag}`);
}

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const ReleasePull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  merge_commit_sha: Sha.nullable(),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  head: z.object({
    ref: z.string(),
    sha: Sha,
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

async function cleanMain(): Promise<string> {
  if ((await gitText(["branch", "--show-current"])) !== "main") {
    throw new Error("Releases must run from main");
  }
  if ((await gitText(["status", "--porcelain"])) !== "") {
    throw new Error("Releases require a clean working tree");
  }
  return gitText(["rev-parse", "HEAD"]);
}

async function unchangedCheckout(snapshot: string): Promise<void> {
  if ((await cleanMain()) !== snapshot) {
    throw new Error("Local checkout changed while waiting; refusing to replace local work");
  }
}

async function ancestor(before: string, after: string): Promise<boolean> {
  const result = await $`git merge-base --is-ancestor ${before} ${after}`.quiet().nothrow();
  if (result.exitCode > 1) throw new Error(result.stderr.toString());
  return result.exitCode === 0;
}

async function remoteRef(ref: string): Promise<string | null> {
  const output = await gitText(["ls-remote", "--refs", "origin", ref]);
  if (output === "") return null;
  const rows = output.split("\n");
  if (rows.length !== 1 || rows[0]!.split("\t")[1] !== ref) {
    throw new Error(`Ambiguous remote reference: ${ref}`);
  }
  return Sha.parse(rows[0]!.split("\t")[0]);
}

async function localTagCommit(tag: string): Promise<string | null> {
  const refs = await gitText(["for-each-ref", "--format=%(refname)", `refs/tags/${tag}`]);
  if (!refs.split("\n").includes(`refs/tags/${tag}`)) return null;
  return gitText(["rev-parse", `refs/tags/${tag}^{commit}`]);
}

async function releasePull(repository: string, tag: string): Promise<z.infer<typeof ReleasePull> | undefined> {
  const owner = repository.split("/")[0]!;
  const query = `repos/${repository}/pulls?state=all&base=main&head=${owner}:release/${tag}&per_page=100`;
  const result = await $`gh api ${query} --paginate --slurp`.quiet().text();
  const pulls = z.array(z.array(ReleasePull)).parse(JSON.parse(result)).flat();
  if (pulls.length > 1) throw new Error(`Ambiguous release PRs for ${tag}`);
  const pull = pulls[0];
  if (pull !== undefined) {
    const sameRepo = (name: string) => name.toLowerCase() === repository.toLowerCase();
    if (
      pull.title !== `release: ${tag}` ||
      pull.base.ref !== "main" ||
      !sameRepo(pull.base.repo.full_name) ||
      pull.head.ref !== `release/${tag}` ||
      pull.head.repo === null ||
      !sameRepo(pull.head.repo.full_name)
    ) throw new Error(`Conflicting release PR for ${tag}`);
    if (pull.state === "closed" && pull.merged_at === null) {
      throw new Error(`Release PR closed without merging: #${pull.number}`);
    }
    if (pull.merged_at !== null && pull.merge_commit_sha === null) {
      throw new Error(`Release PR has inconsistent merge evidence: #${pull.number}`);
    }
  }
  return pull;
}

/**
 * The only publication path, shared by newly generated and recovered releases. Discovery
 * is read-only until the candidate and local checkout have both been accounted for.
 */
async function publishRelease(
  repository: string,
  tag: string,
  snapshot: string,
  prepared?: string,
  body?: string,
): Promise<void> {
  const tagRef = `refs/tags/${tag}`;
  const releaseBranch = `release/${tag}`;
  const releaseRef = `refs/heads/${releaseBranch}`;
  await $`git fetch --no-tags origin main`;
  const main = await gitText(["rev-parse", "origin/main"]);
  const localTag = await localTagCommit(tag);
  const retained = (await gitText(["show", "-s", "--format=%s", snapshot])) === `release: ${tag}`
    ? snapshot
    : undefined;
  let retainedTree: string | undefined;
  if (retained !== undefined) {
    await verifyReleaseCandidate(repository, tag, retained);
    retainedTree = await gitText(["rev-parse", `${retained}^{tree}`]);
  }
  const onMain = await ancestor(snapshot, main);
  if (!onMain && retained === undefined) {
    throw new Error("Local main contains unrelated unpublished work");
  }
  await unchangedCheckout(snapshot);

  if ((await remoteRef(tagRef)) !== null) {
    const proof = await verifyReleaseTag(repository, tag);
    if (localTag !== null && localTag !== proof.sha) {
      throw new Error(`Local tag ${tag} conflicts with the verified remote release`);
    }
    if (retainedTree !== undefined && retainedTree !== await gitText(["rev-parse", `${proof.sha}^{tree}`])) {
      throw new Error("Retained release commit differs from the published release");
    }
    await unchangedCheckout(snapshot);
    await watchRelease(tag);
    await unchangedCheckout(snapshot);
    reportRelease(tag);
    return;
  }

  let pull = await releasePull(repository, tag);
  const branchSha = await remoteRef(releaseRef);
  if (branchSha !== null) await $`git fetch --no-tags origin ${branchSha}`;
  if (pull !== undefined) await $`git fetch --no-tags origin ${pull.head.sha}`;
  if (pull !== undefined && branchSha !== null && branchSha !== pull.head.sha) {
    throw new Error("Release branch differs from its recorded PR head");
  }
  const candidate = prepared ?? pull?.head.sha ?? branchSha ?? retained;
  if (candidate === undefined) throw new Error(`No prepared release found for ${tag}`);
  if ((branchSha !== null && candidate !== branchSha) || (pull !== undefined && candidate !== pull.head.sha)) {
    throw new Error("Conflicting prepared release candidates");
  }
  const candidateProof = await verifyReleaseCandidate(repository, tag, candidate);
  const tree = await gitText(["rev-parse", `${candidate}^{tree}`]);
  if (retained !== undefined && retained !== candidate) {
    if (pull?.merged_at === null || pull === undefined || retainedTree !== tree) {
      throw new Error("Ambiguous retained release candidate");
    }
  }
  if (localTag !== null && (pull === undefined || pull.merged_at === null || localTag !== pull.merge_commit_sha)) {
    throw new Error(`Local tag ${tag} does not name the recorded merged release`);
  }
  await unchangedCheckout(snapshot);

  let sha = pull?.merged_at != null ? pull.merge_commit_sha : null;
  if (sha === null) {
    if (branchSha === null) {
      // An empty lease never overwrites a concurrent publisher's branch.
      await $`git push ${`--force-with-lease=${releaseRef}:`} origin ${`${candidate}:${releaseRef}`}`;
    }
    if (pull === undefined) {
      // Recheck after publishing: an operator may have opened the PR in the meantime.
      pull = await releasePull(repository, tag);
      if (pull !== undefined && pull.head.sha !== candidate) {
        throw new Error("Release PR changed during publication");
      }
      if (pull === undefined) {
        const description = body ?? `## Problem

Publish the retained ${tag} release without bypassing required checks.

## Change

Reuse the canonical release commit ${candidate}; no release content was regenerated.

## Dependencies

- None

## Evidence

Full main CI is green at ${candidateProof.parent}. Required checks on this PR must pass before rebase auto-merge.

## Acceptance

- Merge the release tree through main, then tag and publish without promoting production.

This bun run release PR is exempt from issue lifecycle checks for the release committer
(agent-policy.yml); the shared engineering contract and gate still apply.
`;
        await $`gh pr create --repo ${repository} --base main --head ${releaseBranch} --title ${`release: ${tag}`} --body ${description}`;
        pull = await releasePull(repository, tag);
        if (pull === undefined || pull.head.sha !== candidate) {
          throw new Error("Created release PR does not match the prepared commit");
        }
      }
    }
    await unchangedCheckout(snapshot);
    const url = `https://github.com/${repository}/pull/${pull.number}`;
    console.log(`Release PR: ${url}`);
    if (pull.merged_at === null) {
      await $`gh pr merge ${url} --repo ${repository} --rebase --auto --delete-branch --match-head-commit ${candidate}`;
    }
    sha = await waitForReleasePull(repository, url);
  }

  // Admission selects the PR's recorded merge, never a possibly later main tip.
  await verifyReleaseCommit(repository, tag, sha);
  if ((await gitText(["rev-parse", `${sha}^{tree}`])) !== tree) {
    throw new Error("Merged release differs from the prepared tree; no tag was created");
  }
  await unchangedCheckout(snapshot);
  // Only replace a dedicated, canonically verified prepared commit with the same tree.
  // Otherwise local main may advance only by fast-forward; later main is never rewound.
  if (!onMain) {
    if (retainedTree !== tree) throw new Error("Refusing to replace unrelated local work");
    await $`git reset --keep ${sha}`;
  } else if (await ancestor(snapshot, sha)) {
    await $`git merge --ff-only ${sha}`;
  }
  const updated = await cleanMain();
  const currentTag = await localTagCommit(tag);
  if (currentTag !== null && currentTag !== sha) throw new Error(`Conflicting local tag ${tag}`);
  if ((await remoteRef(tagRef)) !== null) {
    const proof = await verifyReleaseTag(repository, tag);
    if (proof.sha !== sha) throw new Error(`Conflicting remote tag ${tag}`);
  } else {
    await unchangedCheckout(updated);
    if (currentTag === null) await $`git tag ${tag} ${sha}`;
    const tagObject = await gitText(["rev-parse", tagRef]);
    if ((await gitText(["rev-parse", `${tagObject}^{commit}`])) !== sha) {
      throw new Error(`Local tag ${tag} changed before publication`);
    }
    await unchangedCheckout(updated);
    await $`git push origin ${`${tagObject}:${tagRef}`}`;
  }
  await watchRelease(tag);
  await unchangedCheckout(updated);
  reportRelease(tag);
}

function reportRelease(tag: string): void {
  console.log(`Released ${tag}. Production has not moved.`);
  console.log(`capture the incumbent full state, then promote with: bun run promote ${tag} --recovery-receipt PATH`);
}

const args = process.argv.slice(2);
const resume = args[0] === "--resume";
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (
  resume
    ? args.length !== 2 || !args[1]!.startsWith("v")
    : positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")
) {
  console.error("usage: bun run release [--dry-run] [major|minor|patch|x.y.z] | --resume vMAJOR.MINOR.PATCH");
  process.exit(1);
}
if (resume) {
  const tag = args[1]!;
  parseVersion(tag.slice(1));
  const snapshot = await cleanMain();
  const repository = await releaseRepository();
  await requireImmutableReleaseSetting(repository);
  await publishRelease(repository, tag, snapshot);
  process.exit(0);
}
const requested = positional[0];

// Inputs every run parses, dry or not: a bad fragment is refused before anything else.
const fragments = readFragments("changes");
const packagePath = "packages/web/package.json";
const packageMetadata = (await Bun.file(packagePath).json()) as PackageMetadata;
const current = packageMetadata.version;
const level = requested ?? deriveReleaseLevel(current, fragments);
const version = resolveReleaseVersion(current, level);

const described = await $`git describe --tags --abbrev=0`.quiet().nothrow();
const lastTag = described.exitCode === 0 ? described.text().trim() : null;
const protocolAtHead = protocolVersionOf(
  await Bun.file(PROTOCOL_VERSION_FILE).text(),
  PROTOCOL_VERSION_FILE,
);
const protocolAtTag =
  lastTag === null
    ? null
    : protocolVersionOf(
        await gitText(["show", `${lastTag}:${PROTOCOL_VERSION_FILE}`]),
        `${lastTag}:${PROTOCOL_VERSION_FILE}`,
      );
const protocolLine =
  protocolAtTag === null
    ? `Protocol: ${protocolAtHead} at HEAD; no release tag to compare against`
    : protocolAtTag === protocolAtHead
      ? `Protocol: ${protocolAtHead}, unchanged since ${lastTag}`
      : `Protocol bump pending: ${protocolAtTag} (${lastTag}) → ${protocolAtHead} (HEAD); the hub ships at or ahead of this release (docs/CONTRACTS.md §Protocol and compatibility)`;

const pullRequests = await Promise.all(fragments.map(pullRequestOf));
const resolved: readonly ChangeFragment[] = fragments.map((fragment, index) => ({
  ...fragment,
  pr: pullRequests[index] ?? null,
}));
const withoutPr = resolved.filter((fragment) => fragment.pr === null);

if (dryRun) {
  if (fragments.length === 0) {
    console.log(`Nothing to release: changes/ has no fragments (current ${current}).`);
  } else {
    console.log(
      `Would release v${version} (${requested === undefined ? `derived ${level}` : `requested ${level}`} from ${current}, ${fragments.length} fragment(s))`,
    );
    for (const section of CHANGELOG_SECTIONS) {
      const bullets = resolved.filter((fragment) => fragment.section === section);
      if (bullets.length === 0) continue;
      console.log(`\n### ${section}\n`);
      for (const fragment of bullets) console.log(`- ${renderFragmentBullet(fragment)}`);
    }
  }
  console.log(`\n${protocolLine}`);
  if (withoutPr.length > 0) {
    console.log(
      `\nA release would refuse ${withoutPr.length} fragment(s) with no squash-merge commit yet (uncommitted, or the adding commit carries no "(#N)" suffix):\n${withoutPr.map((fragment) => `  changes/${fragment.file}`).join("\n")}`,
    );
  }
  process.exit(0);
}

const branch = await gitText(["branch", "--show-current"]);
if (branch !== "main") throw new Error(`Releases must run from main, not ${branch}`);
if ((await gitText(["status", "--porcelain"])) !== "") {
  throw new Error("Releases require a clean working tree");
}
await $`git fetch origin main --tags`;
if ((await gitText(["rev-parse", "HEAD"])) !== (await gitText(["rev-parse", "origin/main"]))) {
  throw new Error("main must exactly match origin/main before release");
}

// Only full main CI is source release evidence. A successful fast PR run for the same SHA is not.
// Both main pushes and explicit main verification dispatches execute the full suite.
// The release PR runs its own required checks before merging the generated release changes.
const head = await gitText(["rev-parse", "HEAD"]);
const repository = await releaseRepository();
await requireImmutableReleaseSetting(repository);
await requireFullMainCi(repository, head);

if (fragments.length === 0) throw new Error("changes/ has no fragments; nothing to release");
if (withoutPr.length > 0) {
  throw new Error(
    `No pull request number for ${withoutPr.map((fragment) => `changes/${fragment.file}`).join(", ")}: the commit that added it carries no "(#N)" squash suffix`,
  );
}
const released = resolved.filter((fragment): fragment is ReleasedFragment => fragment.pr !== null);
const tag = `v${version}`;
const releaseBranch = `release/${tag}`;
const releaseRef = `refs/heads/${releaseBranch}`;
if ((await gitText(["ls-remote", "--heads", "origin", releaseRef])) !== "") {
  throw new Error(`Release branch ${releaseBranch} already exists on origin; use bun run release --resume ${tag}`);
}

const date = new Date().toISOString().slice(0, 10);
const changelog = assembleChangelog(await Bun.file("CHANGELOG.md").text(), version, date, released);

await Bun.write(packagePath, `${JSON.stringify({ ...packageMetadata, version }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", changelog);
await $`git rm -q -- ${released.map((fragment) => `changes/${fragment.file}`)}`;
await $`bun scripts/generate-web-changelog.ts`;
await $`bun install`;
await assertWorkspaceVersions();
// The release commit changes only the version, the changelog and the fragments it consumed:
// these two cover exactly that in seconds.
await $`bun run check`;
await $`bun run changelog:check`;

await $`git add CHANGELOG.md bun.lock packages/web/package.json`;
await $`git commit -m ${`release: v${version}`}`;
const releaseSha = await gitText(["rev-parse", "HEAD"]);
await publishRelease(repository, tag, releaseSha, releaseSha, releaseBody());

function releaseBody(): string {
const body = `## Problem

Publish ${tag} from green main without bypassing its required checks.

## Change

${renderReleaseSection(version, date, released)}

${protocolLine}

## Dependencies

- None

## Evidence

Source ci.yml is green at ${head}; release generation, workspace-version check, bun run check and changelog:check passed.
Required checks on this PR must pass before rebase auto-merge.

## Acceptance

- Merge the release tree through main, then tag and publish it without promoting production.

This bun run release PR is exempt from issue lifecycle checks for the release committer
(agent-policy.yml); the shared engineering contract and gate still apply.
`;
  return body;
}
