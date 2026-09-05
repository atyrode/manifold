import { expect, test } from "bun:test";
import {
  assembleChangelog,
  assertReleasedSectionsIntact,
  derivePullRequest,
  deriveReleaseLevel,
  parseFragment,
  parseReleasedChangelog,
  renderWebChangelog,
  resolveReleaseVersion,
  type ChangeFragment,
  type ReleasedFragment,
} from "./release-core.ts";

const fragment = (
  section: ChangeFragment["section"],
  issue: number,
  body: string,
  pr: number | null = null,
): ChangeFragment => ({ file: `${issue}-x.md`, section, issue, pr, body });

const released = (
  section: ChangeFragment["section"],
  issue: number,
  body: string,
  pr: number,
): ReleasedFragment => ({ file: `${issue}-x.md`, section, issue, pr, body });

test("semantic release targets only move the version forward", () => {
  expect(resolveReleaseVersion("1.2.3", "patch")).toBe("1.2.4");
  expect(resolveReleaseVersion("1.2.3", "minor")).toBe("1.3.0");
  expect(resolveReleaseVersion("1.2.3", "major")).toBe("2.0.0");
  expect(() => resolveReleaseVersion("1.2.3", "1.2.3")).toThrow("must be newer");
  expect(() => resolveReleaseVersion("1.2.3", "1.2.3-beta.1")).toThrow("Invalid semantic version");
});

test("the fragments derive the level: before 1.0 anything added or broken is a minor", () => {
  expect(deriveReleaseLevel("0.6.2", [fragment("Fixed", 1, "a")])).toBe("patch");
  expect(deriveReleaseLevel("0.6.2", [fragment("Fixed", 1, "a"), fragment("Added", 2, "b")])).toBe(
    "minor",
  );
  expect(deriveReleaseLevel("0.6.2", [fragment("Breaking Changes", 1, "a")])).toBe("minor");
  expect(deriveReleaseLevel("1.4.0", [fragment("Breaking Changes", 1, "a")])).toBe("major");
  expect(deriveReleaseLevel("1.4.0", [fragment("Added", 1, "a")])).toBe("minor");
});

test("a fragment is front matter over one paragraph, and each refusal names the file", () => {
  expect(
    parseFragment("12-thing.md", "---\nsection: Fixed\nissue: 12\n---\nOne line\nwrapped.\n"),
  ).toEqual({ file: "12-thing.md", section: "Fixed", issue: 12, pr: null, body: "One line wrapped." });
  expect(() => parseFragment("thing.md", "---\nsection: Fixed\nissue: 12\n---\nx\n")).toThrow(
    "thing.md: fragment files are named <issue>-<slug>.md",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Tweaked\nissue: 12\n---\nx\n")).toThrow(
    "12-a.md: section must be one of",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Fixed\nissue: twelve\n---\nx\n")).toThrow(
    "12-a.md: issue must be a positive integer",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Fixed\nissue: 13\n---\nx\n")).toThrow(
    "file name says issue 12 but front matter says 13",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Fixed\nissue: 12\n---\n\n")).toThrow(
    "12-a.md: fragment body is empty",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Fixed\nissue: 12\n---\na\n\nb\n")).toThrow(
    "12-a.md: fragment body must be one paragraph",
  );
  expect(() => parseFragment("12-a.md", "---\nsection: Fixed\nissue: 12\n---\n- a\n")).toThrow(
    "12-a.md: fragment body is prose",
  );
  expect(() => parseFragment("12-a.md", "section: Fixed\nissue: 12\nx\n")).toThrow(
    "12-a.md: fragment must open with a --- front matter block",
  );
});

test("the pull request is the squash suffix of the subject that added the fragment", () => {
  expect(derivePullRequest("plugin-manager: one list in three bands (#239) (#243)")).toBe(243);
  expect(derivePullRequest("docs: fragments for #250")).toBeNull();
  expect(derivePullRequest("web: fix (#12) and more")).toBeNull();
});

test("assembling a release places the fragments above the newest release in canonical order", () => {
  const source = "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old fix. (#1, #2)\n";
  const assembled = assembleChangelog(source, "1.0.1", "2026-08-26", [
    released("Fixed", 5, "Fixed drag.", 6),
    released("Added", 3, "Added a thing.", 4),
  ]);
  expect(assembled).toBe(
    "# Changelog\n\n## [1.0.1] - 2026-08-26\n\n### Added\n\n- Added a thing. (#3, #4)\n\n### Fixed\n\n- Fixed drag. (#5, #6)\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old fix. (#1, #2)\n",
  );
  expect(parseReleasedChangelog(assembled).map((release) => release.version)).toEqual([
    "1.0.1",
    "1.0.0",
  ]);
  expect(() => assembleChangelog(source, "1.0.1", "2026-08-26", [])).toThrow("no fragments");
  expect(() =>
    assembleChangelog(source, "0.9.0", "2026-08-26", [released("Fixed", 5, "x", 6)]),
  ).toThrow("must be newer than 1.0.0");
});

test("CHANGELOG.md holds released sections only", () => {
  expect(() => parseReleasedChangelog("# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n"))
    .toThrow("pending changes are changes/*.md");
  expect(() => parseReleasedChangelog("# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- Loose. (#1)\n"))
    .toThrow("no category");
});

test("released sections are immutable beneath a newer release", () => {
  const tagged = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old fix. (#1, #2)\n";
  const grown = "# Changelog\n\n## [1.0.1] - 2026-02-01\n\n### Added\n\n- New. (#3, #4)\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old fix. (#1, #2)\n";
  expect(() => assertReleasedSectionsIntact(grown, tagged, "v1.0.0")).not.toThrow();
  expect(() =>
    assertReleasedSectionsIntact(grown.replace("Old fix.", "Old fix, reworded."), tagged, "v1.0.0"),
  ).toThrow("edits a released section");
  expect(() =>
    assertReleasedSectionsIntact(grown.replace("## [1.0.0] - 2026-01-01", "## [1.0.0] - 2026-01-02"), tagged, "v1.0.0"),
  ).toThrow("lost the newest release of v1.0.0");
});

test("the in-app history leads with an unreleased entry only while fragments exist", () => {
  const source = "# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Fixed\n\n- Old fix. (#1, #2)\n";
  const generated = (markdown: string, fragments: readonly ChangeFragment[]): unknown => {
    const module = renderWebChangelog(markdown, fragments);
    return JSON.parse(module.slice(module.indexOf("= ") + 2, module.lastIndexOf(" as const")));
  };
  expect(generated(source, [])).toEqual([
    { version: "1.0.0", date: "2026-01-01", changes: ["Old fix. (#1, #2)"] },
  ]);
  expect(
    generated(source, [fragment("Fixed", 5, "Fixed drag."), fragment("Added", 3, "Added a thing.", 4)]),
  ).toEqual([
    {
      version: "unreleased",
      date: "in progress",
      changes: ["Added a thing. (#3, #4)", "Fixed drag. (#5)"],
    },
    { version: "1.0.0", date: "2026-01-01", changes: ["Old fix. (#1, #2)"] },
  ]);
});
