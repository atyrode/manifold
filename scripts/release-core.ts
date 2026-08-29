const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_HEADING_PATTERN = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/;
const ALLOWED_SECTIONS = new Set(["Breaking Changes", "Added", "Changed", "Fixed", "Removed"]);

export interface ChangelogRelease {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly string[];
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

export function finalizeChangelog(markdown: string, version: string, date: string): string {
  parseVersion(version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid release date: ${date}`);
  const marker = "## [Unreleased]";
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex < 0) throw new Error("CHANGELOG.md must contain ## [Unreleased]");
  const sectionStart = markerIndex + marker.length;
  const nextRelease = markdown.indexOf("\n## [", sectionStart);
  const unreleased = markdown.slice(sectionStart, nextRelease < 0 ? undefined : nextRelease).trim();
  if (unreleased === "") throw new Error("CHANGELOG.md has no unreleased changes");
  return markdown.replace(marker, `${marker}\n\n## [${version}] - ${date}`);
}

export function parseReleasedChangelog(markdown: string): readonly ChangelogRelease[] {
  const lines = markdown.split("\n");
  const releases: ChangelogRelease[] = [];
  let current: { version: string; date: string; changes: string[] } | null = null;
  let section: string | null = null;

  for (const line of lines) {
    const heading = RELEASE_HEADING_PATTERN.exec(line);
    if (heading !== null) {
      current = { version: heading[1]!, date: heading[2]!, changes: [] };
      releases.push(current);
      section = null;
      continue;
    }
    if (line.startsWith("## [")) {
      current = null;
      section = null;
      continue;
    }
    if (line.startsWith("### ")) {
      section = line.slice(4);
      if (!ALLOWED_SECTIONS.has(section)) {
        throw new Error(`Unsupported changelog section: ${section}`);
      }
      continue;
    }
    if (current !== null && line.startsWith("- ")) {
      if (section === null) throw new Error(`Changelog entry has no category: ${line}`);
      current.changes.push(line.slice(2));
    }
  }

  return releases;
}

/**
 * Bullets under `## [Unreleased]`, in the same shape as a release's changes.
 * Section validation matches the released parser so a bad category fails
 * `changelog:check` before it fails a release.
 */
export function parseUnreleasedChanges(markdown: string): readonly string[] {
  const lines = markdown.split("\n");
  const changes: string[] = [];
  let inUnreleased = false;
  let section: string | null = null;
  for (const line of lines) {
    if (line.startsWith("## [")) {
      inUnreleased = line.startsWith("## [Unreleased]");
      section = null;
      continue;
    }
    if (!inUnreleased) continue;
    if (line.startsWith("### ")) {
      section = line.slice(4);
      if (!ALLOWED_SECTIONS.has(section)) {
        throw new Error(`Unsupported changelog section: ${section}`);
      }
      continue;
    }
    if (line.startsWith("- ")) {
      if (section === null) throw new Error(`Changelog entry has no category: ${line}`);
      changes.push(line.slice(2));
    }
  }
  return changes;
}

/**
 * `devVersion` carries the in-progress `## [Unreleased]` section into the in-app
 * history as a leading pseudo-release, so dev deployments show their changes live.
 * Releases pass nothing: `finalizeChangelog` has already emptied Unreleased by then.
 */
export function renderWebChangelog(markdown: string, devVersion?: string): string {
  const releases = [...parseReleasedChangelog(markdown)];
  if (devVersion !== undefined) {
    const changes = parseUnreleasedChanges(markdown);
    if (changes.length > 0) {
      releases.unshift({ version: devVersion, date: "in progress", changes });
    }
  }
  return `// Generated by scripts/generate-web-changelog.ts. Do not edit.\nexport const GENERATED_WEB_CHANGELOG = ${JSON.stringify(releases, null, 2)} as const;\n`;
}
