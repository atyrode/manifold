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
 * If interrupted after merge, do not bump again: retain the local release commit, fetch
 * origin main, and compare its tree with origin/main^{tree}. Under the same
 * explicit release authorization, and only when those trees match and vX.Y.Z is absent
 * remotely, reset clean local main to origin/main, tag that SHA, push refs/tags/vX.Y.Z and
 * watch release.yml with `gh run watch --exit-status`. Never tag an unmerged release commit.
 */
import { $ } from "bun";
import {
  CHANGELOG_SECTIONS,
  assembleChangelog,
  derivePullRequest,
  deriveReleaseLevel,
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
} from "./release-provenance.ts";

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
async function waitForReleasePull(url: string): Promise<void> {
  console.log(`Waiting for release PR ${url} to merge…`);
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const result = await $`gh pr view ${url} --json state,mergedAt,mergeCommit`.quiet().text();
    const pull = JSON.parse(result) as {
      readonly state: string;
      readonly mergedAt: string | null;
      readonly mergeCommit: { readonly oid: string } | null;
    };
    if (pull.state === "MERGED" && pull.mergedAt !== null && pull.mergeCommit !== null) return;
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

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("--"));
if (positional.length > 1 || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) {
  console.error("Usage: bun run release [--dry-run] [major|minor|patch|x.y.z]");
  process.exit(1);
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
  throw new Error(`Release branch ${releaseBranch} already exists on origin; recover its PR`);
}

const date = new Date().toISOString().slice(0, 10);
const changelog = assembleChangelog(await Bun.file("CHANGELOG.md").text(), version, date, released);

await Bun.write(packagePath, `${JSON.stringify({ ...packageMetadata, version }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", changelog);
await $`git rm -q -- ${released.map((fragment) => `changes/${fragment.file}`)}`;
await $`bun scripts/generate-web-changelog.ts`;
await $`bun install`;
// The release commit changes only the version, the changelog and the fragments it consumed:
// these two cover exactly that in seconds.
await $`bun run check`;
await $`bun run changelog:check`;

await $`git add CHANGELOG.md bun.lock packages/web/package.json`;
await $`git commit -m ${`release: v${version}`}`;
const releaseSha = await gitText(["rev-parse", "HEAD"]);
const releaseTree = await gitText(["rev-parse", `${releaseSha}^{tree}`]);
// The empty lease requires an absent ref even if another release starts after our check.
await $`git push ${`--force-with-lease=${releaseRef}:`} origin ${`${releaseSha}:${releaseRef}`}`;
const body = `## Problem

Publish ${tag} from green main without bypassing its required checks.

## Change

${renderReleaseSection(version, date, released)}

${protocolLine}

## Dependencies

- None

## Evidence

Source ci.yml is green at ${head}; release generation, bun run check and changelog:check passed.
Required checks on this PR must pass before rebase auto-merge.

## Acceptance

- Merge the release tree through main, then tag and publish it without promoting production.

This bun run release PR is exempt from issue lifecycle checks for the release committer
(agent-policy.yml); the shared engineering contract and gate still apply.
`;
const pullUrl = (
  await $`gh pr create --base main --head ${releaseBranch} --title ${`release: ${tag}`} --body ${body}`
    .quiet()
    .text()
).trim();
console.log(`Release PR: ${pullUrl}`);
await $`gh pr merge ${pullUrl} --rebase --auto --delete-branch`;
await waitForReleasePull(pullUrl);

await $`git fetch origin main`;
const sha = await gitText(["rev-parse", "origin/main"]);
if ((await gitText(["rev-parse", `${sha}^{tree}`])) !== releaseTree) {
  throw new Error(`Merged main differs from the release tree; no tag was created: ${pullUrl}`);
}
if (
  (await gitText(["branch", "--show-current"])) !== "main" ||
  (await gitText(["rev-parse", "HEAD"])) !== releaseSha ||
  (await gitText(["status", "--porcelain"])) !== ""
) {
  throw new Error(`Local checkout changed while waiting; no tag was created: ${pullUrl}`);
}
await $`git reset --hard ${sha}`;
await $`git tag ${tag} ${sha}`;
await $`git push origin ${`refs/tags/${tag}`}`;
await watchRelease(tag);
console.log(`Released ${tag}. Production has not moved.`);
console.log(
  `capture the incumbent full state, then promote with: bun run promote ${tag} --recovery-receipt PATH`,
);
