#!/usr/bin/env bun
import { parseReleasedChangelog } from "./release-core.ts";

const requested = process.argv[2]?.replace(/^v/, "");
if (requested === undefined) {
  console.error("Usage: bun scripts/release-notes.ts <version>");
  process.exit(1);
}

const releases = parseReleasedChangelog(await Bun.file("CHANGELOG.md").text());
const release = releases.find((candidate) => candidate.version === requested);
if (release === undefined) {
  console.error(`CHANGELOG.md has no release ${requested}`);
  process.exit(1);
}

console.log(release.changes.map((change) => `- ${change}`).join("\n"));
