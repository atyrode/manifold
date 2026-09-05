#!/usr/bin/env bun
import { $ } from "bun";

/*
 * PROMOTION IS ITS OWN VERB (ADR 0022, amended by #244; docs/SELF-HOST.md §Environments).
 * `bun run release` publishes; this dispatches `deploy-hub.yml` with one published tag and
 * watches it to the end, so "production runs vX.Y.Z" is a sentence somebody typed, never a side
 * effect of a push. It refuses anything that is not a published (non-draft) GitHub Release:
 * production runs releases, and a tag alone is not one.
 */

const tag = process.argv[2];
if (tag === undefined || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("Usage: bun run promote vX.Y.Z   (a published release tag)");
  process.exit(1);
}

const release = await $`gh release view ${tag} --json isDraft,publishedAt`.quiet().nothrow();
if (release.exitCode !== 0) {
  throw new Error(`${tag} has no GitHub Release; publish it with bun run release first`);
}
const { isDraft } = JSON.parse(release.text()) as { readonly isDraft: boolean };
if (isDraft) throw new Error(`${tag} is a draft release, not a published one`);

const since = new Date(Date.now() - 60_000).toISOString();
await $`gh workflow run deploy-hub.yml -f ${`tag=${tag}`}`;
console.log(`Dispatched deploy-hub.yml for ${tag}; waiting for the run…`);

let run: number | undefined;
for (let attempt = 0; attempt < 20 && run === undefined; attempt += 1) {
  await Bun.sleep(3_000);
  const listed =
    await $`gh run list --workflow deploy-hub.yml --event workflow_dispatch --limit 5 --json databaseId,createdAt`
      .quiet()
      .nothrow();
  if (listed.exitCode !== 0) continue;
  const runs = JSON.parse(listed.text()) as readonly {
    readonly databaseId: number;
    readonly createdAt: string;
  }[];
  run = runs.find((candidate) => candidate.createdAt >= since)?.databaseId;
}
if (run === undefined) throw new Error(`deploy-hub.yml did not start for ${tag}`);

const watched = await $`gh run watch ${run} --exit-status`.nothrow();
if (watched.exitCode !== 0) throw new Error(`deploy-hub.yml failed for ${tag} (run ${run})`);

console.log(`Production now runs ${tag}; pin the fleet to ${tag} (atyrode/dotfiles).`);
