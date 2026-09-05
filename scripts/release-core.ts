import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_HEADING_PATTERN = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const FRAGMENT_NAME_PATTERN = /^([1-9]\d*)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;
const FRONT_MATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const PULL_REQUEST_SUFFIX_PATTERN = /\(#([1-9]\d*)\)\s*$/;

/** Canonical order of the subsections under a release heading. */
export const CHANGELOG_SECTIONS = [
  "Breaking Changes",
  "Added",
  "Changed",
  "Fixed",
  "Removed",
] as const;
export type ChangelogSection = (typeof CHANGELOG_SECTIONS)[number];

export interface ChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
}

/**
 * One pending user-visible change, `changes/<issue>-<slug>.md`: YAML-shaped front matter
 * (`section`, `issue`, and `pr` only on a fragment migrated from a bullet that already
 * carried its pull request number) over one paragraph of user-facing prose.
 */
export interface ChangeFragment {
  readonly file: string;
  readonly section: ChangelogSection;
  readonly issue: number;
  readonly pr: number | null;
  readonly body: string;
}

export interface ReleasedFragment extends ChangeFragment {
  readonly pr: number;
}

export function parseVersion(version: string): readonly [number, number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) throw new Error(`Invalid semantic version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function isSection(value: string): value is ChangelogSection {
  return (CHANGELOG_SECTIONS as readonly string[]).includes(value);
}

/**
 * The level a release takes when none is requested. Before 1.0 a breaking change is not a
 * major: anything that adds or breaks is a minor, everything else a patch. From 1.0 on the
 * sections map onto semver directly.
 */
export function deriveReleaseLevel(
  current: string,
  fragments: readonly ChangeFragment[],
): "major" | "minor" | "patch" {
  const [major] = parseVersion(current);
  const breaking = fragments.some((fragment) => fragment.section === "Breaking Changes");
  const added = fragments.some((fragment) => fragment.section === "Added");
  if (major === 0) return breaking || added ? "minor" : "patch";
  if (breaking) return "major";
  return added ? "minor" : "patch";
}

export function resolveReleaseVersion(
  current: string,
  requested: "major" | "minor" | "patch" | string,
): string {
  const [major, minor, patch] = parseVersion(current);
  if (requested === "major") return `${major + 1}.0.0`;
  if (requested === "minor") return `${major}.${minor + 1}.0`;
  if (requested === "patch") return `${major}.${minor}.${patch + 1}`;
  parseVersion(requested);
  if (compareVersions(requested, current) <= 0) {
    throw new Error(`Release version ${requested} must be newer than ${current}`);
  }
  return requested;
}

function parseFrontMatterInteger(file: string, key: string, raw: string | undefined): number {
  if (raw === undefined) throw new Error(`${file}: front matter is missing ${key}`);
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${file}: ${key} must be a positive integer`);
  return Number(raw);
}

export function parseFragment(file: string, text: string): ChangeFragment {
  const name = FRAGMENT_NAME_PATTERN.exec(file);
  if (name === null) throw new Error(`${file}: fragment files are named <issue>-<slug>.md`);
  const parts = FRONT_MATTER_PATTERN.exec(text);
  if (parts === null) throw new Error(`${file}: fragment must open with a --- front matter block`);
  const fields = new Map<string, string>();
  for (const line of parts[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) throw new Error(`${file}: front matter line is not key: value: ${line}`);
    const key = line.slice(0, separator).trim();
    if (!["section", "issue", "pr"].includes(key)) {
      throw new Error(`${file}: unknown front matter key ${key}`);
    }
    if (fields.has(key)) throw new Error(`${file}: front matter repeats ${key}`);
    fields.set(key, line.slice(separator + 1).trim());
  }
  const section = fields.get("section");
  if (section === undefined) throw new Error(`${file}: front matter is missing section`);
  if (!isSection(section)) {
    throw new Error(
      `${file}: section must be one of ${CHANGELOG_SECTIONS.join(", ")}, not ${section}`,
    );
  }
  const issue = parseFrontMatterInteger(file, "issue", fields.get("issue"));
  if (issue !== Number(name[1])) {
    throw new Error(`${file}: file name says issue ${name[1]} but front matter says ${issue}`);
  }
  const rawPr = fields.get("pr");
  const pr = rawPr === undefined ? null : parseFrontMatterInteger(file, "pr", rawPr);
  const body = parts[2]!.trim();
  if (body === "") throw new Error(`${file}: fragment body is empty`);
  if (/\n\s*\n/.test(body)) throw new Error(`${file}: fragment body must be one paragraph`);
  if (/^[-*#]/.test(body)) throw new Error(`${file}: fragment body is prose, not a list or heading`);
  return { file, section, issue, pr, body: body.replace(/\s*\n\s*/g, " ") };
}

function compareFragments(left: ChangeFragment, right: ChangeFragment): number {
  const bySection =
    CHANGELOG_SECTIONS.indexOf(left.section) - CHANGELOG_SECTIONS.indexOf(right.section);
  if (bySection !== 0) return bySection;
  if (left.issue !== right.issue) return left.issue - right.issue;
  return left.file < right.file ? -1 : left.file > right.file ? 1 : 0;
}

/** Every fragment in `dir`, in changelog order; every refusal names its file. */
export function readFragments(dir: string): readonly ChangeFragment[] {
  const fragments: ChangeFragment[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "README.md") continue;
    fragments.push(parseFragment(entry.name, readFileSync(join(dir, entry.name), "utf8")));
  }
  return fragments.sort(compareFragments);
}

/** The `(#N)` a squash-merge appends to its subject, or null when the subject has none. */
export function derivePullRequest(subject: string): number | null {
  const match = PULL_REQUEST_SUFFIX_PATTERN.exec(subject);
  return match === null ? null : Number(match[1]);
}

export function renderFragmentBullet(fragment: ChangeFragment): string {
  const refs = fragment.pr === null ? `#${fragment.issue}` : `#${fragment.issue}, #${fragment.pr}`;
  return `${fragment.body} (${refs})`;
}

/** The release's own markdown: the heading and its subsections in canonical order. */
export function renderReleaseSection(
  version: string,
  date: string,
  fragments: readonly ReleasedFragment[],
): string {
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid release date: ${date}`);
  if (fragments.length === 0) throw new Error("changes/ has no fragments; nothing to release");
  const ordered = [...fragments].sort(compareFragments);
  const blocks = [`## [${version}] - ${date}`];
  for (const section of CHANGELOG_SECTIONS) {
    const bullets = ordered.filter((fragment) => fragment.section === section);
    if (bullets.length === 0) continue;
    blocks.push(
      `### ${section}\n\n${bullets.map((fragment) => `- ${renderFragmentBullet(fragment)}`).join("\n")}`,
    );
  }
  return blocks.join("\n\n");
}

/** `CHANGELOG.md` with the new release placed above the newest released section. */
export function assembleChangelog(
  markdown: string,
  version: string,
  date: string,
  fragments: readonly ReleasedFragment[],
): string {
  const releases = parseReleasedChangelog(markdown);
  const newest = releases[0];
  if (newest !== undefined && compareVersions(version, newest.version) <= 0) {
    throw new Error(`Release version ${version} must be newer than ${newest.version}`);
  }
  const section = renderReleaseSection(version, date, fragments);
  const index = markdown.indexOf("\n## [");
  if (index < 0) return `${markdown.trimEnd()}\n\n${section}\n`;
  return `${markdown.slice(0, index).trimEnd()}\n\n${section}\n${markdown.slice(index)}`;
}

/**
 * Every `## [x.y.z] - date` section. Refuses any other `## [` heading: pending changes are
 * fragments under `changes/`, never a section of this file.
 */
export function parseReleasedChangelog(markdown: string): readonly ChangelogRelease[] {
  const lines = markdown.split("\n");
  const releases: ChangelogRelease[] = [];
  let current: { version: string; date: string; changes: string[] } | null = null;
  let section: string | null = null;

  for (const line of lines) {
    const heading = RELEASE_HEADING_PATTERN.exec(line);
    if (heading !== null) {
      const previous = releases[releases.length - 1];
      if (previous !== undefined && compareVersions(previous.version, heading[1]!) <= 0) {
        throw new Error(`Releases must descend: ${heading[1]} follows ${previous.version}`);
      }
      current = { version: heading[1]!, date: heading[2]!, changes: [] };
      releases.push(current);
      section = null;
      continue;
    }
    if (line.startsWith("## ")) {
      throw new Error(
        `CHANGELOG.md holds only released sections (pending changes are changes/*.md): ${line}`,
      );
    }
    if (line.startsWith("### ")) {
      if (current === null) throw new Error(`Changelog section outside a release: ${line}`);
      section = line.slice(4);
      if (!isSection(section)) throw new Error(`Unsupported changelog section: ${section}`);
      continue;
    }
    if (line.startsWith("- ")) {
      if (current === null) throw new Error(`Changelog entry outside a release: ${line}`);
      if (section === null) throw new Error(`Changelog entry has no category: ${line}`);
      current.changes.push(line.slice(2));
    }
  }

  return releases;
}

/**
 * Released sections are immutable: the text from a tag's newest release heading to the end
 * of the file must survive byte for byte at HEAD. A newer release may sit above it. The
 * tagged file may still open with the retired `## [Unreleased]` heading; it is skipped.
 */
export function assertReleasedSectionsIntact(head: string, tagged: string, tag: string): void {
  const heading = tagged.split("\n").find((line) => RELEASE_HEADING_PATTERN.test(line));
  if (heading === undefined) return;
  const frozen = tagged.slice(tagged.indexOf(`\n${heading}\n`) + 1);
  const headStart = head.indexOf(`\n${heading}\n`);
  if (headStart < 0) {
    throw new Error(`CHANGELOG.md lost the newest release of ${tag}: ${heading}`);
  }
  if (head.slice(headStart + 1) !== frozen) {
    throw new Error(
      `CHANGELOG.md edits a released section: everything from ${heading} down must match ${tag}`,
    );
  }
}

/**
 * The in-app history: every release, and — only while fragments exist — a leading
 * "unreleased" entry so a development deployment shows what it carries.
 */
export function renderWebChangelog(markdown: string, fragments: readonly ChangeFragment[]): string {
  const releases = [...parseReleasedChangelog(markdown)];
  if (fragments.length > 0) {
    releases.unshift({
      version: "unreleased",
      date: "in progress",
      changes: [...fragments].sort(compareFragments).map(renderFragmentBullet),
    });
  }
  return `// Generated by scripts/generate-web-changelog.ts. Do not edit.\nexport const GENERATED_WEB_CHANGELOG = ${JSON.stringify(releases, null, 2)} as const;\n`;
}
