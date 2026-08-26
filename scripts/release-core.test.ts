import { expect, test } from "bun:test";
import {
  finalizeChangelog,
  parseReleasedChangelog,
  resolveReleaseVersion,
} from "./release-core.ts";

test("semantic release targets only move the version forward", () => {
  expect(resolveReleaseVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(resolveReleaseVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(resolveReleaseVersion("1.2.3", "major")).toBe("2.0.0");
  expect(() => resolveReleaseVersion("1.2.3", "1.2.3")).toThrow("must be newer");
  expect(() => resolveReleaseVersion("1.2.3", "1.2.3-beta.1")).toThrow("Invalid semantic version");
});

test("finalizing a changelog freezes unreleased entries under the release", () => {
  const source =
    "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fixed drag.\n\n## [1.0.0] - 2026-01-01\n";
  const finalized = finalizeChangelog(source, "1.0.1", "2026-08-26");

  expect(finalized).toContain(
    "## [Unreleased]\n\n## [1.0.1] - 2026-08-26\n\n### Fixed\n\n- Fixed drag.",
  );
  expect(parseReleasedChangelog(finalized)).toEqual([
    { version: "1.0.1", date: "2026-08-26", changes: ["Fixed drag."] },
    { version: "1.0.0", date: "2026-01-01", changes: [] },
  ]);
});

test("a release refuses an empty unreleased section", () => {
  expect(() =>
    finalizeChangelog(
      "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n",
      "1.0.1",
      "2026-08-26",
    ),
  ).toThrow("no unreleased changes");
});
