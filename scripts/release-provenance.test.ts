import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleChangelog, parseFragment } from "./release-core.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FixtureState {
  readonly repository: string;
  readonly tag: string;
  readonly sha: string;
  readonly parent: string;
  readonly head: string;
  main: string;
  tagSha: string | null;
  tagAfterRead?: string;
  pullState: "merged" | "missing" | "ambiguous" | "unmerged" | "foreign";
  pullCommits: number;
  pullCi: FixtureState["sourceCi"];
  repositoryIdentity?: string;
  defaultBranch?: string;
  checkedTree: string;
  sourceCi: "success" | "newer-failed" | "failed-attempt";
  tagCi: boolean;
  requiredChecks: boolean;
  immutable: boolean;
  draft: boolean;
  nativeVerification: boolean;
  swapBinaries: boolean;
  duplicateDrafts?: boolean;
  image: string;
}

// Only the remote services are replaced. The admission command reads real Git objects,
// checks real ancestry/deltas, downloads assets, and observes the verifier's exit status.
// Native Sigstore verification itself is exercised separately against a public attestation.
const GITHUB_FIXTURE = `#!/usr/bin/env bun
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.RELEASE_FIXTURE_STATE, "utf8"));
const args = process.argv.slice(2);
const emit = (value) => console.log(JSON.stringify(value));
const run = (id, sha, event, branch, attempt = 1, conclusion = "success") => ({
  id, head_sha: sha, event, head_branch: branch, run_attempt: attempt,
  path: ".github/workflows/ci.yml", status: "completed", conclusion,
  head_repository: { full_name: state.repository },
});
const pull = {
  number: 77, title: "release: " + state.tag,
  merged_at: state.pullState === "unmerged" ? null : "2026-01-03T00:00:00Z",
  merge_commit_sha: state.sha,
  base: { ref: "main", repo: { full_name: state.repository } },
  head: { ref: "release/" + state.tag, sha: state.head,
    repo: { full_name: state.pullState === "foreign" ? "fork/manifold" : state.repository } },
};
const assets = ["manifold-agent-linux-x64", "manifold-agent-darwin-arm64", "release-image.txt",
  "release-artifacts.intoto.jsonl", "release-image.intoto.jsonl"];
const artifactBytes = Object.fromEntries(assets.map((name) =>
  [name, name === "release-image.txt" ? state.image + "\\n" : name + " fixture bytes\\n"]));
const subjects = assets.slice(0, 3).map((name) => ({
  name, digest: { sha256: new Bun.CryptoHasher("sha256").update(artifactBytes[name]).digest("hex") },
}));
const release = {
  id: 91, tag_name: state.tag, draft: state.draft, prerelease: false, immutable: state.immutable,
  assets: assets.map((name, index) => ({ id: 501 + index, name, state: "uploaded", size: 32 })),
};
if (args[0] === "api") {
  const url = new URL(args[1], "https://api.github.com/");
  const base = "/repos/" + state.repository;
  if (url.pathname === base) emit({
    full_name: state.repositoryIdentity ?? state.repository,
    default_branch: state.defaultBranch ?? "main",
  });
  else if (url.pathname === base + "/git/ref/tags/" + state.tag) {
    if (state.tagSha === null) { console.error("Release tag not found (HTTP 404)"); process.exit(1); }
    const sha = state.tagSha;
    if (state.tagAfterRead !== undefined) {
      state.tagSha = state.tagAfterRead;
      delete state.tagAfterRead;
      fs.writeFileSync(process.env.RELEASE_FIXTURE_STATE, JSON.stringify(state));
    }
    emit({ ref: "refs/tags/" + state.tag, object: { sha, type: "commit" } });
  }
  else if (url.pathname === base + "/branches/main") emit({ name: "main", commit: { sha: state.main } });
  else if (url.pathname === base + "/actions/workflows/ci.yml/runs") {
    const sha = url.searchParams.get("head_sha");
    let runs = [];
    if (sha === state.parent) {
      runs = [run(1001, sha, "push", "main", state.sourceCi === "failed-attempt" ? 2 : 1)];
      if (state.sourceCi === "newer-failed") runs.push(run(1004, sha, "workflow_dispatch", "main", 1, "failure"));
    } else if (sha === state.head) {
      runs = [run(1002, sha, "pull_request", "release/" + state.tag,
        state.pullCi === "failed-attempt" ? 2 : 1)];
      if (state.pullCi === "newer-failed")
        runs.push(run(1005, sha, "pull_request", "release/" + state.tag, 1, "failure"));
    } else if (sha === state.sha && state.tagCi) runs = [run(1003, sha, "push", "main")];
    emit({ workflow_runs: runs });
  } else if (url.pathname.includes("/actions/runs/") && url.pathname.endsWith("/jobs")) {
    const failedAttempt =
      (url.pathname.includes("/1001/") && state.sourceCi === "failed-attempt") ||
      (url.pathname.includes("/1002/") && state.pullCi === "failed-attempt");
    const failure = failedAttempt && !url.pathname.includes("/attempts/1/");
    emit({ jobs: [{ name: "gate", status: "completed", conclusion: failure ? "failure" : "success" }] });
  } else if (url.pathname === base + "/commits/" + state.sha + "/pulls")
    emit(state.pullState === "missing" ? [] :
      state.pullState === "ambiguous" ? [pull, { ...pull, number: 78 }] : [pull]);
  else if (url.pathname === base + "/pulls/77") emit({ ...pull, commits: state.pullCommits });
  else if (url.pathname === base + "/git/commits/" + state.head) emit({ tree: { sha: state.checkedTree } });
  else if (url.pathname === base + "/releases/tags/" + state.tag) {
    if (state.draft) { console.error("Published release not found (HTTP 404)"); process.exit(1); }
    emit(release);
  } else if (url.pathname === base + "/releases") {
    emit([[{ id: 90, tag_name: "v0.1.0", draft: true }], [release],
      state.duplicateDrafts ? [{ ...release, id: 92 }] : []]);
  } else if (url.pathname === base + "/releases/91") emit(release);
  else if (url.pathname.startsWith(base + "/releases/assets/")) {
    const index = Number(url.pathname.split("/").at(-1)) - 501;
    if (!Number.isInteger(index) || index < 0 || index >= assets.length) throw new Error("Unknown asset id");
    const source = state.swapBinaries && index < 2 ? assets[1 - index] : assets[index];
    process.stdout.write(artifactBytes[source]);
  }
  else throw new Error("Unexpected fixture command: " + args.join(" "));
} else if (args[0] === "pr" && args[1] === "checks") {
  if (!state.requiredChecks) { console.error("Required policy check has not passed"); process.exit(1); }
  console.log("Required checks passed");
} else if (args[0] === "attestation" && args[1] === "verify") {
  if (!state.nativeVerification) { console.error("Attestation verification refused"); process.exit(1); }
  emit(args[2].startsWith("oci://") ? [{
    name: state.image.split("@")[0], digest: { sha256: state.image.split("@sha256:")[1] },
  }] : subjects);
} else throw new Error("Unexpected fixture command: " + args.join(" "));
`;

function fixture(
  editRelease?: (directory: string) => void,
  stage: "tagged" | "integrated" | "prepared" = "tagged",
) {
  const root = mkdtempSync(join(tmpdir(), "manifold-release-admission-"));
  roots.push(root);
  const directory = join(root, "repo");
  const remote = join(root, "origin.git");
  const bin = join(root, "bin");
  const stateFile = join(root, "state.json");
  for (const path of [directory, bin, join(root, "home"), join(root, "tmp")]) mkdirSync(path);
  writeFileSync(join(bin, "gh"), GITHUB_FIXTURE, { mode: 0o700 });
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
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
  mkdirSync(join(directory, "changes"));
  const manifest = { name: "@manifold/web", version: "1.2.3" };
  const lock = {
    lockfileVersion: 1,
    workspaces: { "packages/web": { ...manifest } },
    packages: { fixed: ["fixed@1.0.0", "sha512-fixture"] },
  };
  const fragment = "---\nsection: Fixed\nissue: 123\n---\nKeep retained records readable.\n";
  const changelog =
    "# Changelog\n\n## [1.2.3] - 2026-01-01\n\n### Fixed\n\n- Retain record ownership. (#120, #121)\n";
  writeFileSync(
    join(directory, "packages/web/package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  writeFileSync(join(directory, "bun.lock"), JSON.stringify(lock, null, 2) + "\n");
  writeFileSync(join(directory, "changes/123-records.md"), fragment);
  writeFileSync(join(directory, "CHANGELOG.md"), changelog);
  writeFileSync(join(directory, "application.ts"), "export const retained = true;\n");
  git("add", ".");
  git("commit", "-m", "server: preserve retained records (#456)");
  const parent = git("rev-parse", "HEAD");
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
  editRelease?.(directory);
  git("add", ".");
  git("commit", "-m", "release: v1.2.4");
  const head = git("rev-parse", "HEAD");
  const checkedTree = git("rev-parse", "HEAD^{tree}");
  // Rebase merging preserves the tested tree, not necessarily the PR head's commit id.
  env.GIT_COMMITTER_DATE = "2026-01-03T00:00:00Z";
  const sha = git("commit-tree", checkedTree, "-p", parent, "-m", "release: v1.2.4");
  if (stage === "prepared") {
    git("push", "origin", `${parent}:refs/heads/main`);
  } else {
    git("update-ref", "refs/heads/main", sha);
    git("push", "origin", "main", `${head}:refs/pull/77/head`);
    if (stage === "tagged") {
      git("tag", "v1.2.4", sha);
      git("push", "origin", "refs/tags/v1.2.4");
    }
  }
  const state: FixtureState = {
    repository: "owner/manifold",
    tag: "v1.2.4",
    sha,
    parent,
    head,
    main: stage === "prepared" ? parent : sha,
    tagSha: stage === "tagged" ? sha : null,
    pullState: stage === "prepared" ? "missing" : "merged",
    pullCommits: 1,
    pullCi: "success",
    checkedTree,
    sourceCi: "success",
    tagCi: false,
    requiredChecks: true,
    immutable: true,
    draft: false,
    nativeVerification: true,
    swapBinaries: false,
    image: `ghcr.io/owner/manifold@sha256:${"a".repeat(64)}`,
  };
  const invoke = async (
    mode: "tag" | "draft" | "published" | "promotion" | "candidate" | "commit",
    sha = mode === "candidate" ? state.head : state.sha,
  ) => {
    writeFileSync(stateFile, JSON.stringify(state));
    const module = new URL("./release-provenance.ts", import.meta.url).pathname;
    const args =
      mode === "candidate" || mode === "commit"
        ? [
            "--eval",
            `import { verifyReleaseCandidate, verifyReleaseCommit } from ${JSON.stringify(module)};
const verify = ${mode === "candidate" ? "verifyReleaseCandidate" : "verifyReleaseCommit"};
console.log(JSON.stringify(await verify(${JSON.stringify(state.repository)}, ${JSON.stringify(state.tag)}, ${JSON.stringify(sha)})));`,
          ]
        : [module, mode, state.tag];
    const child = Bun.spawn(
      [process.execPath, ...args],
      {
        cwd: directory,
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (err.includes("Unexpected fixture command:")) throw new Error(err);
    return { code, out, err };
  };
  return { state, invoke, root, directory, git };
}

test("a retained unpublished candidate needs neither a release branch, merged PR nor tag", async () => {
  const { state, invoke, git } = fixture(undefined, "prepared");
  const refs = git("ls-remote", "origin");
  expect(refs).toBe(`${state.parent}\tHEAD\n${state.parent}\trefs/heads/main`);
  const candidate = await invoke("candidate");
  expect(candidate.code, candidate.err).toBe(0);
  expect(JSON.parse(candidate.out)).toEqual({ parent: state.parent, sourceCi: 1001 });
  expect(git("rev-parse", "HEAD")).toBe(state.head);
  expect(git("ls-remote", "origin")).toBe(refs);
  expect((await invoke("tag")).code).not.toBe(0);
}, 10_000);

test("candidate admission requires a dedicated single-parent release commit", async () => {
  const { state, invoke, git } = fixture(undefined, "prepared");
  const unrelated = git("commit-tree", state.checkedTree, "-p", state.parent, "-m", "other work");
  expect((await invoke("candidate", unrelated)).code).not.toBe(0);
  const merge = git(
    "commit-tree", state.checkedTree, "-p", state.parent, "-p", state.head,
    "-m", `release: ${state.tag}`,
  );
  expect((await invoke("candidate", merge)).code).not.toBe(0);
}, 10_000);

test("an integrated untagged release remains admissible after main advances", async () => {
  const { state, invoke, git, directory } = fixture(undefined, "integrated");
  const before = await invoke("commit");
  expect(before.code, before.err).toBe(0);
  const proof = JSON.parse(before.out);
  expect(proof).toEqual({
    repository: state.repository,
    tag: state.tag,
    sha: state.sha,
    parent: state.parent,
    pull: 77,
    sourceCi: 1001,
  });
  writeFileSync(join(directory, "application.ts"), "export const retained = 'later work';\n");
  git("commit", "-am", "server: independent later change");
  state.main = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  expect(state.main).not.toBe(state.sha);
  const advanced = await invoke("commit");
  expect(advanced.code, advanced.err).toBe(0);
  expect(JSON.parse(advanced.out)).toEqual(proof);
  expect(git("rev-parse", "HEAD")).toBe(state.main);
  expect(git("ls-remote", "origin", "refs/tags/*")).toBe("");
  expect((await invoke("tag")).code).not.toBe(0);
}, 15_000);

test("publishing a candidate branch does not make it an integrated release", async () => {
  const { state, invoke, git } = fixture(undefined, "prepared");
  git("push", "origin", `${state.sha}:refs/heads/release/${state.tag}`);
  // Even a claimed merged PR cannot replace actual main ancestry.
  state.pullState = "merged";
  expect((await invoke("candidate", state.sha)).code).toBe(0);
  expect((await invoke("commit")).code).not.toBe(0);
  expect(git("ls-remote", "origin", "refs/heads/main")).toBe(
    `${state.parent}\trefs/heads/main`,
  );
}, 10_000);

test("untagged admission requires one merged same-repository single-commit release PR", async () => {
  const { state, invoke } = fixture(undefined, "integrated");
  for (const pullState of ["missing", "ambiguous", "unmerged", "foreign"] as const) {
    state.pullState = pullState;
    expect((await invoke("commit")).code, pullState).not.toBe(0);
  }
  state.pullState = "merged";
  state.pullCommits = 2;
  expect((await invoke("commit")).code).not.toBe(0);
}, 20_000);

test("untagged admission verifies repository identity and its default-main policy", async () => {
  const { state, invoke } = fixture(undefined, "integrated");
  state.repositoryIdentity = "other/manifold";
  expect((await invoke("commit")).code).not.toBe(0);
  state.repositoryIdentity = state.repository;
  state.defaultBranch = "other";
  expect((await invoke("commit")).code).not.toBe(0);
}, 10_000);

test("untagged admission requires the checked tree, latest PR CI and required policy checks", async () => {
  const { state, invoke, git } = fixture(undefined, "integrated");
  const checkedTree = state.checkedTree;
  state.checkedTree = git("rev-parse", `${state.parent}^{tree}`);
  expect((await invoke("commit")).code).not.toBe(0);
  state.checkedTree = checkedTree;
  for (const pullCi of ["newer-failed", "failed-attempt"] as const) {
    state.pullCi = pullCi;
    expect((await invoke("commit")).code, pullCi).not.toBe(0);
  }
  state.pullCi = "success";
  state.requiredChecks = false;
  expect((await invoke("commit")).code).not.toBe(0);
}, 20_000);

test("tag admission still refuses a tag that moves during the shared commit proof", async () => {
  const { state, invoke } = fixture();
  state.tagAfterRead = state.parent;
  expect((await invoke("tag")).code).not.toBe(0);
}, 10_000);

test("publication admits the checked rebase tree before tagged-main CI, but promotion waits for it", async () => {
  const { state, invoke } = fixture();
  expect(state.sha).not.toBe(state.head);
  const admission = await invoke("tag");
  expect(admission.code, admission.err).toBe(0);
  expect(JSON.parse(admission.out).sha).toBe(state.sha);
  const pending = await invoke("promotion");
  expect(pending.code).not.toBe(0);
  state.tagCi = true;
  const promoted = await invoke("promotion");
  expect(promoted.code, promoted.err).toBe(0);
  expect(JSON.parse(promoted.out).image).toBe(state.image);
}, 20_000);

test("a checked PR and green CI cannot authorize application code in the release delta", async () => {
  const { invoke } = fixture((directory) => {
    writeFileSync(join(directory, "application.ts"), "export const retained = false;\n");
  });
  for (const mode of ["tag", "candidate", "commit"] as const) {
    const result = await invoke(mode);
    expect(result.code, mode).not.toBe(0);
    expect(result.err).toContain("application.ts");
  }
}, 15_000);

test("release-only filenames do not permit dependency changes or executable file modes", async () => {
  const dependency = fixture((directory) => {
    const path = join(directory, "bun.lock");
    const lock = JSON.parse(readFileSync(path, "utf8")) as { packages: { fixed: string[] } };
    lock.packages.fixed = ["fixed@2.0.0", "sha512-other"];
    writeFileSync(path, JSON.stringify(lock));
  });
  expect((await dependency.invoke("tag")).code).not.toBe(0);
  const executable = fixture((directory) =>
    chmodSync(join(directory, "packages/web/package.json"), 0o755),
  );
  expect((await executable.invoke("tag")).code).not.toBe(0);
}, 10_000);

test("a release branch is refused until its exact commit is integrated into main", async () => {
  const { state, invoke } = fixture();
  state.main = state.parent;
  expect((await invoke("tag")).code).not.toBe(0);
  state.main = state.sha;
  const integrated = await invoke("tag");
  expect(integrated.code, integrated.err).toBe(0);
  expect(JSON.parse(integrated.out).sha).toBe(state.sha);
}, 10_000);

test("newer failed CI and a failed current rerun cannot borrow an older green result", async () => {
  const { state, invoke } = fixture();
  for (const sourceCi of ["newer-failed", "failed-attempt"] as const) {
    state.sourceCi = sourceCi;
    for (const mode of ["tag", "candidate", "commit"] as const) {
      expect((await invoke(mode)).code, `${mode}: ${sourceCi}`).not.toBe(0);
    }
  }
}, 20_000);

test("release PR tree identity and every required policy check remain independent requirements", async () => {
  const { state, invoke } = fixture();
  const tree = state.checkedTree;
  state.checkedTree = "f".repeat(40);
  expect((await invoke("tag")).code).not.toBe(0);
  state.checkedTree = tree;
  state.requiredChecks = false;
  expect((await invoke("tag")).code).not.toBe(0);
}, 10_000);

test("draft verification does not make mutable or unpublished assets promotable", async () => {
  const { state, invoke } = fixture();
  state.tagCi = true;
  state.draft = true;
  state.immutable = false;
  const draft = await invoke("draft");
  expect(draft.code, draft.err).toBe(0);
  expect(JSON.parse(draft.out).image).toBe(state.image);
  expect((await invoke("promotion")).code).not.toBe(0);
  state.draft = false;
  expect((await invoke("promotion")).code).not.toBe(0);
}, 20_000);

test("native attestation refusal and a signed mutable image selection both fail closed and clean up", async () => {
  const { state, invoke, root } = fixture();
  state.tagCi = true;
  state.nativeVerification = false;
  expect((await invoke("promotion")).code).not.toBe(0);
  state.nativeVerification = true;
  state.image = "ghcr.io/owner/manifold:v1.2.4";
  expect((await invoke("promotion")).code).not.toBe(0);
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
}, 10_000);

test("valid signatures cannot substitute a different signed platform binary under an asset name", async () => {
  const { state, invoke } = fixture();
  state.swapBinaries = true;
  // Use publication staging, where release assets are still mutable.
  state.draft = true;
  const staged = await invoke("draft");
  expect(staged.code).not.toBe(0);
  expect(staged.err).toContain("manifold-agent-linux-x64");
}, 10_000);

test("release metadata cannot introduce duplicate JSON keys hidden from semantic comparison", async () => {
  const { invoke } = fixture((directory) => {
    const path = join(directory, "packages/web/package.json");
    const manifest = readFileSync(path, "utf8");
    writeFileSync(path, manifest.replace("{", '{\n  "name": "@unreviewed/web",'));
  });
  const result = await invoke("tag");
  expect(result.code).not.toBe(0);
}, 10_000);

test("draft publication refuses ambiguous tag names across release pages", async () => {
  const { state, invoke } = fixture();
  state.draft = true;
  const unique = await invoke("draft");
  expect(unique.code, unique.err).toBe(0);
  state.duplicateDrafts = true;
  const result = await invoke("draft");
  expect(result.code).not.toBe(0);
}, 10_000);
