import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBuildIdentity } from "./build-identity.ts";

function repository(run: (root: string, git: (...args: string[]) => string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "manifold-build-revision-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Build identity fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Build identity fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  try {
    git("init", "--quiet");
    mkdirSync(join(root, "packages/web"), { recursive: true });
    writeFileSync(join(root, "packages/web/package.json"), '{"version":"1.2.3"}\n');
    git("add", ".");
    git("commit", "--quiet", "-m", "initial source");
    run(root, git);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("historical build identity ignores the installed checkout and leaves it untouched", () => {
  repository((root, git) => {
    const historical = git("rev-parse", "HEAD");
    git("tag", "v1.2.3");
    writeFileSync(join(root, "packages/web/package.json"), '{"version":"4.5.6"}\n');
    git("add", ".");
    git("commit", "--quiet", "-m", "newer installed tooling");
    const installed = git("rev-parse", "HEAD");
    writeFileSync(join(root, "packages/web/package.json"), '{"version":"7.8.9"}\n');
    const dirtyTree = git("diff");

    expect(deriveBuildIdentity(root, historical)).toEqual({
      version: "1.2.3",
      build: "1.2.3",
      channel: "release",
    });
    expect(git("rev-parse", "HEAD")).toBe(installed);
    expect(git("diff")).toBe(dirtyTree);
  });
});

test("an untagged historical revision reads its own package version", () => {
  repository((root, git) => {
    const historical = git("rev-parse", "HEAD");
    writeFileSync(join(root, "packages/web/package.json"), '{"version":"4.5.6"}\n');
    git("add", ".");
    git("commit", "--quiet", "-m", "newer package version");

    expect(deriveBuildIdentity(root, historical)).toEqual({
      version: "1.2.3",
      build: "1.2.3",
      channel: "development",
    });
  });
});

test("explicit build revisions never silently fall back or peel a tag object", () => {
  repository((root, git) => {
    expect(() => deriveBuildIdentity(root, "HEAD")).toThrow(Error);
    expect(() => deriveBuildIdentity(root, "0".repeat(40))).toThrow(Error);
    git("tag", "-a", "v1.2.3", "-m", "release");
    expect(() => deriveBuildIdentity(root, git("rev-parse", "v1.2.3"))).toThrow(Error);
  });
});
