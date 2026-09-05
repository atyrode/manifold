#!/usr/bin/env bun
/**
 * The in-app release history, generated from `CHANGELOG.md` (released sections) and
 * `changes/*.md` (pending fragments, rendered as a leading "unreleased" entry while any
 * exist). The output is untracked: `build:web`, `dev:web`, `check` and the gate run this first.
 *
 * `--check` writes nothing. It proves that every fragment parses, that `CHANGELOG.md` parses,
 * and that the released sections are byte-identical to the newest tag's — releases are
 * immutable, and `bun run release` is the only writer above them.
 */
import { $ } from "bun";
import { format, resolveConfig } from "prettier";
import {
  assertReleasedSectionsIntact,
  parseReleasedChangelog,
  readFragments,
  renderWebChangelog,
} from "./release-core.ts";

const sourcePath = "CHANGELOG.md";
const fragmentsDir = "changes";
const outputPath = "packages/web/src/generated-changelog.ts";

const fragments = readFragments(fragmentsDir);
const markdown = await Bun.file(sourcePath).text();
const releases = parseReleasedChangelog(markdown);

if (process.argv.includes("--check")) {
  const described = await $`git describe --tags --abbrev=0`.quiet().nothrow();
  if (described.exitCode !== 0) {
    throw new Error(
      "No release tag is reachable from HEAD (git fetch --tags); cannot check released sections",
    );
  }
  const tag = described.text().trim();
  const tagged = await $`git show ${`${tag}:${sourcePath}`}`.quiet().text();
  assertReleasedSectionsIntact(markdown, tagged, tag);
  console.log(
    `${fragments.length} fragment(s) parse, ${releases.length} release(s) parse, released sections match ${tag}`,
  );
} else {
  const prettierConfig = await resolveConfig(outputPath);
  const rendered = await format(renderWebChangelog(markdown, fragments), {
    ...prettierConfig,
    parser: "typescript",
  });
  await Bun.write(outputPath, rendered);
  console.log(`Generated ${outputPath} (${fragments.length} pending, ${releases.length} released)`);
}
