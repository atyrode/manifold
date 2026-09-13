import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  RepositoryObserver,
  normalizeRemote,
  type ProbeOutcome,
  type RepositoryProbe,
} from "../src/repository.ts";

/**
 * Real git, real directories: the whole value of this observer is that it agrees with the
 * git on the host, and a fake git could only prove that it agrees with the fake. The bounds
 * — the timeout, the missing git, the cache window and its ceiling — are the states a real
 * git will not produce on demand, so those cases drive a scripted probe instead.
 */
const root = mkdtempSync(join(tmpdir(), "manifold-repository-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const done = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${done.stderr.toString()}`);
  }
}

/** A checkout with one commit, so a linked worktree can be added to it. */
function checkout(name: string, origin?: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "file.txt"), "one\n");
  git(path, "add", "file.txt");
  git(path, "commit", "-q", "-m", "one");
  if (origin !== undefined) git(path, "remote", "add", "origin", origin);
  return path;
}

/** A scripted git that records which paths it was actually asked about. */
function scripted(outcome: ProbeOutcome): { probe: RepositoryProbe; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    probe: {
      run: (path) => {
        asked.push(path);
        return Promise.resolve(outcome);
      },
    },
  };
}

describe("what a folder on this host is", () => {
  test("a checkout answers with its resolved common directory and normalized origin", async () => {
    const path = checkout("plain", "git@github.com:atyrode/manifold.git");

    const fact = await new RepositoryObserver().observe(path);

    expect(fact).toMatchObject({
      path,
      identity: join(path, ".git"),
      remote: "github.com/atyrode/manifold",
      reason: "repository",
    });
    expect(fact.observedAt).toBeGreaterThan(0);
  });

  test("a linked worktree is the SAME repository: one identity, two paths", async () => {
    const main = checkout("shared", "https://github.com/atyrode/manifold");
    const linked = join(root, "shared-worktree");
    git(main, "worktree", "add", "-q", linked, "-b", "side");

    const observer = new RepositoryObserver();
    const first = await observer.observe(main);
    const second = await observer.observe(linked);

    expect(second.reason).toBe("repository");
    expect(second.path).toBe(linked);
    // The point of the whole fact: the locators differ, the subject does not.
    expect(second.identity).toBe(first.identity);
    expect(second.remote).toBe("github.com/atyrode/manifold");
  });

  test("a checkout reached through a symlink is not a second repository", async () => {
    const real = checkout("symlinked");
    const link = join(root, "symlink-to-repo");
    symlinkSync(real, link);

    const observer = new RepositoryObserver();
    const through = await observer.observe(link);
    const direct = await observer.observe(real);

    expect(through.reason).toBe("repository");
    expect(through.identity).toBe(direct.identity);
  });

  test("a checkout with no origin is still one repository", async () => {
    const path = checkout("originless");

    const fact = await new RepositoryObserver().observe(path);

    expect(fact.reason).toBe("repository");
    expect(fact.identity).toBe(join(path, ".git"));
    expect(fact.remote).toBeNull();
  });

  test("an ordinary directory, a file and an absent path each say which they are", async () => {
    const plain = join(root, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    const file = join(root, "a-file");
    writeFileSync(file, "not a folder\n");
    const observer = new RepositoryObserver();

    expect(await observer.observe(plain)).toMatchObject({
      identity: null,
      remote: null,
      reason: "not_a_repository",
    });
    expect((await observer.observe(file)).reason).toBe("not_a_repository");
    expect(await observer.observe(join(root, "nothing-here"))).toMatchObject({
      identity: null,
      remote: null,
      reason: "absent",
    });
  });

  test("a folder inside a checkout reports the repository above it", async () => {
    const path = checkout("nested");
    const inner = join(path, "src", "deep");
    mkdirSync(inner, { recursive: true });

    const fact = await new RepositoryObserver().observe(inner);

    expect(fact.path).toBe(inner);
    expect(fact.identity).toBe(join(path, ".git"));
  });
});

describe("bounds", () => {
  test("a probe that ran out of its second is a timeout, never 'not a repository'", async () => {
    const observer = new RepositoryObserver({ probe: scripted({ kind: "timed_out" }).probe });

    expect((await observer.observe(root)).reason).toBe("timed_out");
  });

  test("a host without git says so rather than calling every folder unversioned", async () => {
    const observer = new RepositoryObserver({ probe: scripted({ kind: "no_git" }).probe });

    expect((await observer.observe(root)).reason).toBe("git_unavailable");
  });

  test("one observation per path per window, and the window expires", async () => {
    let now = 1_000;
    const git = scripted({ kind: "refused" });
    const observer = new RepositoryObserver({
      probe: git.probe,
      runtime: { now: () => now, newId: () => "id" },
      ttlMs: 60_000,
    });

    const first = await observer.observe(root);
    now += 30_000;
    const cached = await observer.observe(root);

    expect(cached.observedAt).toBe(first.observedAt);
    expect(git.asked).toEqual([root]);

    now += 31_000;
    expect((await observer.observe(root)).observedAt).toBe(62_000);
    expect(git.asked).toEqual([root, root]);
  });

  test("the cache is bounded: naming fresh paths evicts the oldest, not the newest", async () => {
    const git = scripted({ kind: "refused" });
    const observer = new RepositoryObserver({ probe: git.probe, maxEntries: 2 });
    const paths = ["ceiling-a", "ceiling-b", "ceiling-c"].map((name) => {
      const path = join(root, name);
      mkdirSync(path, { recursive: true });
      return path;
    });

    for (const path of paths) await observer.observe(path);
    expect(git.asked).toEqual(paths);

    // The newest two are still answered from the cache; the oldest is looked at again.
    await observer.observe(paths[2] ?? "");
    await observer.observe(paths[1] ?? "");
    expect(git.asked).toEqual(paths);

    await observer.observe(paths[0] ?? "");
    expect(git.asked).toEqual([...paths, paths[0] ?? ""]);
  });
});

describe("one repository, however its remote is spelled", () => {
  const canonical = "github.com/atyrode/manifold";

  test.each([
    ["git@github.com:atyrode/manifold.git", canonical],
    ["git@github.com:atyrode/manifold", canonical],
    ["ssh://git@github.com/atyrode/manifold", canonical],
    ["https://github.com/atyrode/manifold", canonical],
    ["https://github.com/atyrode/manifold.git/", canonical],
    ["https://token@github.com/atyrode/manifold.git", canonical],
    ["https://user:pass@github.com/atyrode/manifold/", canonical],
    ["git://github.com/atyrode/manifold.git", canonical],
    [
      "https://gitlab.example.com:8443/group/sub/project.git",
      "gitlab.example.com/group/sub/project",
    ],
    ["http://localhost/atyrode/manifold.git", "localhost/atyrode/manifold"],
  ])("%s is %s", (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });

  test.each([
    ["", "a checkout with no origin"],
    ["/srv/git/thing", "an absolute path on one machine"],
    ["../sibling", "a relative path"],
    ["origin", "a bare word"],
    ["https://github.com/", "a host with no repository"],
  ])("%s normalizes to nothing: it is %s", (url) => {
    expect(normalizeRemote(url)).toBeNull();
  });

  test("the ssh short form and the https form of one repository agree on the disk too", async () => {
    const short = checkout("remote-ssh", "git@github.com:atyrode/manifold.git");
    const long = checkout("remote-https", "https://github.com/atyrode/manifold.git/");
    const observer = new RepositoryObserver();

    const [a, b] = await Promise.all([observer.observe(short), observer.observe(long)]);

    expect(a.remote).toBe(canonical);
    expect(b.remote).toBe(canonical);
    // One project, two clones: one remote, two identities.
    expect(a.identity).toBe(resolve(short, ".git"));
    expect(a.identity).not.toBe(b.identity);
  });
});
