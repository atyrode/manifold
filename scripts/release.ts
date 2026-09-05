#!/usr/bin/env bun
/**
 * The one release path. `bun run release [--dry-run] [major|minor|patch|x.y.z]`.
 *
 * With no level, the fragments decide (release-core `deriveReleaseLevel`). `--dry-run` reads
 * the same inputs, prints the version it would cut, the bullets grouped by section and whether
 * a protocol bump is pending, then exits 0 having touched nothing — from any branch, clean or
 * not. A real release refuses anything but a clean `main` that matches `origin/main` and has a
 * green ci.yml run, and refuses a fragment whose adding commit carries no `(#N)` squash suffix.
 */
import { $ } from "bun";
import {
  CHANGELOG_SECTIONS,
  assembleChangelog,
  derivePullRequest,
  deriveReleaseLevel,
  readFragments,
  renderFragmentBullet,
  resolveReleaseVersion,
  type ChangeFragment,
  type ReleasedFragment,
} from "./release-core.ts";

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
      : `Protocol bump pending: ${protocolAtTag} (${lastTag}) → ${protocolAtHead} (HEAD); the hub ships at or ahead of this release (invariant 10)`;

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

// The gate ran ONCE, on CI, for this exact commit (ci.yml on push to main). A release from a
// commit with no green run is refused here rather than re-verified locally.
const head = await gitText(["rev-parse", "HEAD"]);
const green =
  await $`gh run list --workflow ci.yml --commit ${head} --status success --limit 1 --json databaseId`
    .quiet()
    .text();
if ((JSON.parse(green) as readonly unknown[]).length === 0) {
  throw new Error(
    `main@${head.slice(0, 7)} has no green ci.yml run; push and wait for CI before releasing`,
  );
}

if (fragments.length === 0) throw new Error("changes/ has no fragments; nothing to release");
if (withoutPr.length > 0) {
  throw new Error(
    `No pull request number for ${withoutPr.map((fragment) => `changes/${fragment.file}`).join(", ")}: the commit that added it carries no "(#N)" squash suffix`,
  );
}
const released = resolved.filter((fragment): fragment is ReleasedFragment => fragment.pr !== null);

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
const tag = `v${version}`;
await $`git tag ${tag}`;
const sha = await gitText(["rev-parse", "HEAD"]);
await $`git push --atomic origin refs/heads/main:refs/heads/main ${`${sha}:refs/tags/${tag}`}`;
await watchRelease(tag);
console.log(`Released ${tag}. Production has not moved.`);
console.log(`promote with: bun run promote ${tag}`);
