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

const packagePath = "packages/web/package.json";
const packageMetadata = (await Bun.file(packagePath).json()) as PackageMetadata;
const version = resolveReleaseVersion(packageMetadata.version, requested);
const date = new Date().toISOString().slice(0, 10);
const changelog = finalizeChangelog(await Bun.file("CHANGELOG.md").text(), version, date);

await Bun.write(`${packagePath}`, `${JSON.stringify({ ...packageMetadata, version }, null, 2)}\n`);
await Bun.write("CHANGELOG.md", changelog);
await $`bun scripts/generate-web-changelog.ts`;
await $`bun install`;
await $`bun run gate`;

await $`git add CHANGELOG.md bun.lock packages/web/package.json packages/web/src/generated-changelog.ts`;
await $`git commit -m ${`release: v${version}`}`;
const tag = `v${version}`;
await $`git tag ${tag}`;
const sha = await gitText(["rev-parse", "HEAD"]);
await $`git push --atomic origin refs/heads/main:refs/heads/main ${`${sha}:refs/tags/${tag}`}`;
await watchRelease(tag);
console.log(`Released ${tag}`);
