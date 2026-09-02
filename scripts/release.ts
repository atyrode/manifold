#!/usr/bin/env bun
import { $ } from "bun";
import { finalizeChangelog, resolveReleaseVersion } from "./release-core.ts";

interface PackageMetadata {
  readonly version: string;
  readonly [key: string]: unknown;
}

async function gitText(args: readonly string[]): Promise<string> {
  const result = await $`git ${args}`.quiet().nothrow();
  if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || "Git failed");
  return result.text().trim();
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

/** Waits for every workflow this release triggered downstream (`workflow_run`), whatever they are. */
async function watchDownstream(since: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result =
      await $`gh run list --event workflow_run --limit 10 --json databaseId,name,createdAt`
        .quiet()
        .nothrow();
    if (result.exitCode === 0) {
      const runs = (
        JSON.parse(result.text()) as readonly {
          readonly databaseId: number;
          readonly name: string;
          readonly createdAt: string;
        }[]
      ).filter((run) => run.createdAt >= since);
      if (runs.length > 0) {
        for (const run of runs) {
          console.log(`Waiting for ${run.name}…`);
          const watched = await $`gh run watch ${run.databaseId} --exit-status`.nothrow();
          if (watched.exitCode !== 0) throw new Error(`${run.name} failed for ${since}`);
        }
        return;
      }
    }
    await Bun.sleep(15_000);
  }
  console.log("No workflow subscribed to this release.");
}

const requested = process.argv[2];
if (requested === undefined) {
  console.error("Usage: bun run release -- <major|minor|patch|x.y.z>");
  process.exit(1);
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

const packagePath = "packages/web/package.json";
const packageMetadata = (await Bun.file(packagePath).json()) as PackageMetadata;
const version = resolveReleaseVersion(packageMetadata.version, requested);
const date = new Date().toISOString().slice(0, 10);
const changelog = finalizeChangelog(await Bun.file("CHANGELOG.md").text(), version, date);

await Bun.write(`${packagePath}`, `${JSON.stringify({ ...packageMetadata, version }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", changelog);
await $`bun scripts/generate-web-changelog.ts`;
await $`bun install`;
// The release commit changes only the version, the changelog freeze and the generated
// changelog: these two cover exactly that in seconds.
await $`bun run check`;
await $`bun run changelog:check`;

await $`git add CHANGELOG.md bun.lock packages/web/package.json packages/web/src/generated-changelog.ts`;
await $`git commit -m ${`release: v${version}`}`;
const tag = `v${version}`;
await $`git tag ${tag}`;
const sha = await gitText(["rev-parse", "HEAD"]);
const since = new Date(Date.now() - 60_000).toISOString();
await $`git push --atomic origin refs/heads/main:refs/heads/main ${`${sha}:refs/tags/${tag}`}`;
await watchRelease(tag);
await watchDownstream(since);
console.log(`Released ${tag}`);
