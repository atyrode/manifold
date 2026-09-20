import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleChangelog, parseFragment } from "./release-core.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Interruption = "commit" | "branch" | "pull" | "merged" | "local-tag" | "remote-tag";
interface ServiceState {
  repository: string;
  tag: string;
  parent: string;
  head: string;
  merged: string;
  tree: string;
  remote: string;
  pulls: {
    number: number;
    state: "open" | "closed";
    merged: boolean;
    head: string;
    title: string;
  }[];
  created: number;
  merges: number;
  watched: number;
  sourceCi: boolean;
  requiredChecks: boolean;
  immutable: boolean;
  checkedTree: string;
  interrupt?: "create" | "merge" | "watch";
  changeCheckout?: "commit" | "dirty";
}

// Only GitHub is simulated. Its merge operation updates a real bare remote, while the
// release command reads and writes real refs, objects, index and worktree throughout.
const GITHUB = `#!/usr/bin/env bun
const fs = require("node:fs");
const stateFile = process.env.RELEASE_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const emit = (value) => console.log(JSON.stringify(value));
const git = (...args) => {
  const result = Bun.spawnSync(["git", ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const remote = (...args) => git("--git-dir", state.remote, ...args);
const pull = (p) => ({
  number: p.number, title: p.title, state: p.state,
  merged_at: p.merged ? "2026-01-03T00:00:00Z" : null,
  // The REST API also exposes a synthetic merge SHA before a PR has merged.
  merge_commit_sha: state.merged,
  base: { ref: "main", repo: { full_name: state.repository } },
  head: { ref: "release/" + state.tag, sha: p.head, repo: { full_name: state.repository } },
});
const fail = (message) => { console.error(message); process.exit(1); };
const run = (id, sha, main) => ({
  id, head_sha: sha, event: main ? "push" : "pull_request", head_branch: main ? "main" : "release/" + state.tag,
  run_attempt: 1, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success",
  head_repository: { full_name: state.repository },
});
if (args[0] === "api") {
  const url = new URL(args[1], "https://api.github.com/");
  const base = "/repos/" + state.repository;
  if (url.pathname === base) emit({ full_name: state.repository, default_branch: "main" });
  else if (url.pathname === base + "/immutable-releases") emit({ enabled: state.immutable });
  else if (url.pathname === base + "/pulls") emit([state.pulls.map(pull)]);
  else if (url.pathname === base + "/branches/main") emit({ name: "main", commit: { sha: remote("rev-parse", "main") } });
  else if (url.pathname === base + "/git/ref/tags/" + state.tag)
    emit({ ref: "refs/tags/" + state.tag, object: { sha: remote("rev-parse", "refs/tags/" + state.tag + "^{commit}"), type: "commit" } });
  else if (url.pathname === base + "/actions/workflows/ci.yml/runs") {
    const sha = url.searchParams.get("head_sha");
    emit({ workflow_runs: sha === state.parent && state.sourceCi ? [run(101, sha, true)]
      : sha === state.head ? [run(102, sha, false)] : [] });
  } else if (url.pathname.match(/\\/actions\\/runs\\/(101|102)\\/attempts\\/1\\/jobs$/)) {
    emit({ jobs: [{ name: "gate", status: "completed", conclusion: "success" }] });
  } else if (url.pathname === base + "/commits/" + state.merged + "/pulls") emit(state.pulls.map(pull));
  else if (url.pathname === base + "/pulls/77") emit({ ...pull(state.pulls[0]), commits: 1 });
  else if (url.pathname === base + "/git/commits/" + state.head) emit({ tree: { sha: state.checkedTree } });
  else throw new Error("Unexpected fixture command: " + args.join(" "));
} else if (args[0] === "pr" && args[1] === "create") {
  if (state.pulls.length) fail("Duplicate release PR");
  state.pulls.push({ number: 77, state: "open", merged: false, head: state.head, title: "release: " + state.tag });
  state.created++; save();
  if (state.interrupt === "create") fail("Interrupted after PR creation");
  console.log("https://github.com/" + state.repository + "/pull/77");
} else if (args[0] === "pr" && args[1] === "merge") {
  if (!state.requiredChecks) fail("Required checks have not passed");
  if (!args.includes("--auto") || !args.includes("--rebase") || args.includes("--admin")) fail("Unsafe merge request");
  const p = state.pulls[0];
  if (!p || p.merged || p.state !== "open") fail("Duplicate or invalid merge request");
  remote("update-ref", "refs/heads/main", state.merged, state.parent);
  remote("update-ref", "-d", "refs/heads/release/" + state.tag);
  p.state = "closed"; p.merged = true; state.merges++; save();
  if (state.changeCheckout === "dirty") fs.writeFileSync("operator-work.txt", "keep local edits\\n");
  if (state.changeCheckout === "commit") {
    fs.writeFileSync("operator-work.txt", "keep local commit\\n");
    git("add", "operator-work.txt"); git("commit", "-m", "local operator work");
  }
  if (state.interrupt === "merge") fail("Interrupted after checked merge");
} else if (args[0] === "pr" && args[1] === "view") {
  const p = state.pulls[0];
  emit({ state: p.merged ? "MERGED" : p.state.toUpperCase(), mergedAt: p.merged ? "2026-01-03T00:00:00Z" : null,
    mergeCommit: p.merged ? { oid: state.merged } : null });
} else if (args[0] === "pr" && args[1] === "checks") {
  if (!state.requiredChecks) fail("Required checks have not passed");
  console.log("Checks passed");
} else if (args[0] === "run" && args[1] === "list") emit([{ databaseId: 901 }]);
else if (args[0] === "run" && args[1] === "watch") {
  state.watched++; save();
  if (state.interrupt === "watch") fail("Interrupted after tag publication");
} else throw new Error("Unexpected fixture command: " + args.join(" "));
`;

function fixture(interruption: Interruption = "commit") {
  const root = mkdtempSync(join(tmpdir(), "manifold-release-resume-"));
  roots.push(root);
  const directory = join(root, "repo");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const stateFile = join(root, "state.json");
  for (const path of [directory, bin, join(root, "home"), join(root, "tmp")]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), GITHUB, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Release fixture",
    GIT_COMMITTER_NAME: "Release fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
    GITHUB_REPOSITORY: "owner/manifold",
    RELEASE_FIXTURE_STATE: stateFile,
  };
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  git("init", "--bare", "--initial-branch=main", remote);
  git("init", "--initial-branch=main");
  git("remote", "add", "origin", remote);
  mkdirSync(join(directory, "packages/web"), { recursive: true });
  mkdirSync(join(directory, "packages/protocol/src"), { recursive: true });
  writeFileSync(
    join(directory, "packages/protocol/src/version.ts"),
    "export const PROTOCOL_VERSION = 7;\n",
  );
  mkdirSync(join(directory, "changes"));
  const manifest = { name: "@manifold/web", version: "1.2.3" };
  const lock = {
    lockfileVersion: 1,
    workspaces: { "packages/web": { ...manifest } },
    packages: {},
  };
  const fragment = "---\nsection: Fixed\nissue: 123\n---\nKeep retained records readable.\n";
  const changelog =
    "# Changelog\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- Retain records. (#120, #121)\n";
  writeFileSync(
    join(directory, "packages/web/package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(join(directory, "bun.lock"), JSON.stringify(lock, null, 2) + "\n");
  writeFileSync(join(directory, "changes/123-records.md"), fragment);
  writeFileSync(join(directory, "CHANGELOG.md"), changelog);
  writeFileSync(join(directory, "application.ts"), "export const retained = true;\n");
  git("add", ".");
  git("commit", "-m", "server: preserve records (#456)");
  const parent = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  manifest.version = "1.2.4";
  lock.workspaces["packages/web"].version = "1.2.4";
  writeFileSync(
    join(directory, "packages/web/package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(join(directory, "bun.lock"), JSON.stringify(lock, null, 2) + "\n");
  writeFileSync(
    join(directory, "CHANGELOG.md"),
    assembleChangelog(changelog, "1.2.4", "2026-01-03", [
      { ...parseFragment("123-records.md", fragment), pr: 456 },
    ]),
  );
  git("rm", "changes/123-records.md");
  git("add", ".");
  git("commit", "-m", "release: v1.2.4");
  const head = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  env.GIT_COMMITTER_DATE = "2026-01-03T00:00:00Z";
  const merged = git("commit-tree", tree, "-p", parent, "-m", "release: v1.2.4");
  // GitHub already has both objects when it performs its checked rebase merge.
  git("push", "origin", `${head}:refs/pull/77/head`, `${merged}:refs/fixture/merge`);
  const integrated = ["merged", "local-tag", "remote-tag"].includes(interruption);
  const state: ServiceState = {
    repository: "owner/manifold",
    tag: "v1.2.4",
    parent,
    head,
    merged,
    tree,
    remote,
    pulls:
      interruption === "commit" || interruption === "branch"
        ? []
        : [
            {
              number: 77,
              state: integrated ? "closed" : "open",
              merged: integrated,
              head,
              title: "release: v1.2.4",
            },
          ],
    created: 0,
    merges: 0,
    watched: 0,
    sourceCi: true,
    requiredChecks: true,
    immutable: true,
    checkedTree: tree,
  };
  if (interruption === "branch" || interruption === "pull")
    git("push", "origin", `${head}:refs/heads/release/v1.2.4`);
  if (integrated) git("--git-dir", remote, "update-ref", "refs/heads/main", merged, parent);
  if (interruption === "local-tag" || interruption === "remote-tag") {
    git("reset", "--hard", merged);
    git("tag", state.tag, merged);
  }
  if (interruption === "remote-tag") git("push", "origin", `refs/tags/${state.tag}`);
  const invoke = async (...args: string[]) => {
    writeFileSync(stateFile, JSON.stringify(state));
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./release.ts", import.meta.url).pathname,
        ...(args.length ? args : ["--resume", state.tag]),
      ],
      { cwd: directory, env, stdout: "pipe", stderr: "pipe" },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    Object.assign(state, JSON.parse(readFileSync(stateFile, "utf8")) as ServiceState);
    if (err.includes("Unexpected fixture command:")) throw new Error(err);
    return { code, out, err };
  };
  return { state, git, invoke, directory, remote };
}

// Kept as a standalone positive regression so it can also be replayed against pre-fix source.
test("resume publishes the retained release commit without regenerating its version or tree", async () => {
  const f = fixture();
  const result = await f.invoke();
  expect(result.code, result.err).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(f.state.merged);
  expect(f.git("rev-parse", "HEAD^{tree}")).toBe(f.state.tree);
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(f.state.merged);
  expect(
    JSON.parse(readFileSync(join(f.directory, "packages/web/package.json"), "utf8")).version,
  ).toBe("1.2.4");
  expect(f.state.pulls.map((p) => p.number)).toEqual([77]);
  expect(f.state.created).toBe(1);
  expect(f.state.merges).toBe(1);
}, 20_000);

for (const interruption of ["branch", "pull", "merged", "local-tag", "remote-tag"] as const) {
  test(`resume reuses the release after interruption at ${interruption}`, async () => {
    const f = fixture(interruption);
    const first = await f.invoke();
    expect(first.code, first.err).toBe(0);
    const tag = f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4");
    expect(tag).toBe(f.state.merged);
    expect(f.git("rev-parse", "HEAD^{tree}")).toBe(f.state.tree);
    expect(f.state.created).toBe(interruption === "branch" ? 1 : 0);
    expect(f.state.merges).toBe(interruption === "branch" || interruption === "pull" ? 1 : 0);
    const resources = { created: f.state.created, merges: f.state.merges };
    const second = await f.invoke();
    expect(second.code, second.err).toBe(0);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(tag);
    expect({ created: f.state.created, merges: f.state.merges }).toEqual(resources);
    expect(f.state.watched).toBe(2);
  }, 20_000);
}

for (const interruption of ["create", "merge", "watch"] as const) {
  test(`resume survives an actual command interruption after ${interruption}`, async () => {
    const f = fixture();
    f.state.interrupt = interruption;
    expect((await f.invoke()).code).not.toBe(0);
    delete f.state.interrupt;
    const result = await f.invoke();
    expect(result.code, result.err).toBe(0);
    expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(f.state.merged);
    expect(f.state.created).toBe(1);
    expect(f.state.merges).toBe(1);
    expect(f.git("rev-parse", "HEAD^{tree}")).toBe(f.state.tree);
  }, 20_000);
}

test("resume selects the recorded merge and never rewinds later main", async () => {
  const f = fixture("merged");
  f.git("reset", "--hard", f.state.merged);
  writeFileSync(join(f.directory, "later-work.txt"), "later main work\n");
  f.git("add", ".");
  f.git("commit", "-m", "server: later independent main work");
  const later = f.git("rev-parse", "HEAD");
  f.git("push", "origin", "main");
  const result = await f.invoke();
  expect(result.code, result.err).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(later);
  expect(f.git("--git-dir", f.remote, "rev-parse", "main")).toBe(later);
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(f.state.merged);
  expect(readFileSync(join(f.directory, "later-work.txt"), "utf8")).toBe("later main work\n");
}, 20_000);

test("resume discovers an existing remote branch from a clean source-main checkout", async () => {
  const f = fixture("branch");
  f.git("reset", "--hard", f.state.parent);
  const result = await f.invoke();
  expect(result.code, result.err).toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(f.state.merged);
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(f.state.merged);
  expect(f.state.created).toBe(1);
}, 20_000);

for (const failure of [
  "source-ci",
  "required-checks",
  "immutable",
  "tree",
  "closed",
  "ambiguous",
  "branch",
  "local-tag",
  "remote-tag",
  "version",
] as const) {
  test(`resume refuses ${failure} conflicts without replacing existing refs or local state`, async () => {
    const f = fixture("merged");
    if (failure === "source-ci") f.state.sourceCi = false;
    if (failure === "required-checks") f.state.requiredChecks = false;
    if (failure === "immutable") f.state.immutable = false;
    if (failure === "tree") f.state.checkedTree = f.git("rev-parse", `${f.state.parent}^{tree}`);
    if (failure === "closed") {
      f.state.pulls[0]!.merged = false;
      f.state.pulls[0]!.state = "closed";
    }
    if (failure === "ambiguous") f.state.pulls.push({ ...f.state.pulls[0]!, number: 78 });
    if (failure === "branch")
      f.git("push", "origin", `${f.state.parent}:refs/heads/release/v1.2.4`);
    if (failure === "local-tag") f.git("tag", f.state.tag, f.state.parent);
    if (failure === "remote-tag") {
      f.git("tag", f.state.tag, f.state.parent);
      f.git("push", "origin", `refs/tags/${f.state.tag}`);
    }
    if (failure === "version") f.state.tag = "v1.2.5";
    const refs = f.git("--git-dir", f.remote, "show-ref");
    const head = f.git("rev-parse", "HEAD");
    const tree = f.git("rev-parse", "HEAD^{tree}");
    expect((await f.invoke()).code).not.toBe(0);
    expect(f.git("--git-dir", f.remote, "show-ref")).toBe(refs);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(f.git("rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.state.created).toBe(0);
    expect(f.state.merges).toBe(0);
  }, 20_000);
}

for (const change of ["commit", "dirty"] as const) {
  test(`resume preserves concurrent local ${change} while waiting for checked merge`, async () => {
    const f = fixture("pull");
    f.state.changeCheckout = change;
    expect((await f.invoke()).code).not.toBe(0);
    expect(readFileSync(join(f.directory, "operator-work.txt"), "utf8")).toBe(
      change === "commit" ? "keep local commit\n" : "keep local edits\n",
    );
    expect(f.git("--git-dir", f.remote, "for-each-ref", "--format=%(refname)", "refs/tags")).toBe(
      "",
    );
    if (change === "commit")
      expect(f.git("show", "-s", "--format=%s", "HEAD")).toBe("local operator work");
    else expect(f.git("rev-parse", "HEAD")).toBe(f.state.head);
  }, 20_000);
}

test("resume refuses unrelated unpublished local commits before creating remote resources", async () => {
  const f = fixture("branch");
  writeFileSync(join(f.directory, "operator-work.txt"), "keep unpublished work\n");
  f.git("add", ".");
  f.git("commit", "-m", "local operator work");
  const head = f.git("rev-parse", "HEAD");
  const refs = f.git("--git-dir", f.remote, "show-ref");
  expect((await f.invoke()).code).not.toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  expect(f.git("--git-dir", f.remote, "show-ref")).toBe(refs);
  expect(f.state.pulls).toEqual([]);
}, 20_000);

test("a prepared version bump cannot smuggle application changes into a release", async () => {
  const f = fixture();
  writeFileSync(join(f.directory, "application.ts"), "export const retained = false;\n");
  f.git("add", ".");
  f.git("commit", "--amend", "--no-edit");
  const candidate = f.git("rev-parse", "HEAD");
  const refs = f.git("--git-dir", f.remote, "show-ref");
  expect((await f.invoke()).code).not.toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(candidate);
  expect(f.git("--git-dir", f.remote, "show-ref")).toBe(refs);
  expect(f.state.pulls).toEqual([]);
}, 20_000);

test("an open release PR cannot bypass required checks or publish a tag", async () => {
  const f = fixture("pull");
  f.state.requiredChecks = false;
  const refs = f.git("--git-dir", f.remote, "show-ref");
  expect((await f.invoke()).code).not.toBe(0);
  expect(f.git("--git-dir", f.remote, "show-ref")).toBe(refs);
  expect(f.git("rev-parse", "HEAD")).toBe(f.state.head);
  expect(f.state.pulls[0]!.merged).toBe(false);
  expect(f.state.created).toBe(0);
  expect(f.state.merges).toBe(0);
}, 20_000);

test("resume restores a missing release branch for the existing open PR", async () => {
  const f = fixture("pull");
  f.git("--git-dir", f.remote, "update-ref", "-d", "refs/heads/release/v1.2.4");
  const result = await f.invoke();
  expect(result.code, result.err).toBe(0);
  expect(f.state.created).toBe(0);
  expect(f.state.merges).toBe(1);
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/tags/v1.2.4")).toBe(f.state.merged);
}, 20_000);

test("resume requires an explicit canonical tag and cannot be combined with dry-run", async () => {
  const f = fixture();
  const refs = f.git("--git-dir", f.remote, "show-ref");
  for (const args of [
    ["--resume"],
    ["--resume", "1.2.4"],
    ["--resume", "v01.2.4"],
    ["--resume", "v1.2.4", "--dry-run"],
  ]) {
    expect((await f.invoke(...args)).code).not.toBe(0);
  }
  expect(f.git("rev-parse", "HEAD")).toBe(f.state.head);
  expect(f.git("--git-dir", f.remote, "show-ref")).toBe(refs);
  expect(f.state.pulls).toEqual([]);
}, 20_000);

test("resume preserves a concurrent commit at the local release-head update", async () => {
  const f = fixture();
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("Release fixtures require native Git");
  const marker = join(f.directory, "..", "concurrent-head");
  const edited = "export const editedAfterVerification = true;\n";
  // Race the native checkout transition, after its last admission check. The shim
  // supports both ordinary checkout operations and a compare-and-swap ref update.
  writeFileSync(
    join(f.directory, "..", "bin", "git"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
const realGit = ${JSON.stringify(realGit)};
const marker = ${JSON.stringify(marker)};
const run = (...args) => {
  const result = Bun.spawnSync([realGit, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
if (["reset", "merge", "update-ref"].includes(args[0]) && args.includes(${JSON.stringify(f.state.merged)}) && !(await Bun.file(marker).exists())) {
  await Bun.write("application.ts", ${JSON.stringify(edited)});
  run("add", "application.ts");
  run("commit", "-m", "server: retain concurrent work");
  await Bun.write(marker, run("rev-parse", "HEAD"));
}
const result = Bun.spawnSync([realGit, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode);
`,
    { mode: 0o700 },
  );
  const result = await f.invoke();
  expect(result.code, result.err).not.toBe(0);
  expect(f.git("rev-parse", "HEAD")).toBe(readFileSync(marker, "utf8"));
  expect(readFileSync(join(f.directory, "application.ts"), "utf8")).toBe(edited);
  expect(f.git("--git-dir", f.remote, "tag", "--list")).toBe("");
}, 20_000);
