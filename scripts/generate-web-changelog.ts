#!/usr/bin/env bun
import { renderWebChangelog } from "./release-core.ts";
import { format, resolveConfig } from "prettier";

const sourcePath = "CHANGELOG.md";
const outputPath = "packages/web/src/generated-changelog.ts";
// Dev builds surface the Unreleased section as a leading "in progress" entry so the
// deployed app's history tracks the branch; release versions never take this path
// (finalizeChangelog empties Unreleased before regeneration).
const webVersion = ((await Bun.file("packages/web/package.json").json()) as { version: string })
  .version;
const devVersion = webVersion.includes("-dev") ? webVersion : undefined;
const prettierConfig = await resolveConfig(outputPath);
const expected = await format(renderWebChangelog(await Bun.file(sourcePath).text(), devVersion), {
  ...prettierConfig,
  parser: "typescript",
});
const check = process.argv.includes("--check");

if (check) {
  let actual: string;
  try {
    actual = await Bun.file(outputPath).text();
  } catch {
    console.error(`${outputPath} is missing; run bun run changelog:generate`);
    process.exit(1);
  }
  if (actual !== expected) {
    console.error(`${outputPath} is stale; run bun run changelog:generate`);
    process.exit(1);
  }
  console.log("In-app changelog matches CHANGELOG.md");
} else {
  await Bun.write(outputPath, expected);
  console.log(`Generated ${outputPath}`);
}
