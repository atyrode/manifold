#!/usr/bin/env bun
/** Read-only release admission. Publication and promotion use the same Git/CI/attestation policy. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  assembleChangelog,
  derivePullRequest,
  parseFragment,
  parseReleasedChangelog,
  parseVersion,
  resolveReleaseVersion,
  type ReleasedFragment,
} from "./release-core.ts";

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
const Repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const Run = z.object({
  id: z.number().int().positive(),
  run_attempt: z.number().int().positive(),
  head_sha: Sha,
  head_branch: z.string().nullable(),
  event: z.string(),
  path: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  head_repository: z.object({ full_name: z.string() }).nullable(),
});
const Runs = z.object({ workflow_runs: z.array(Run) });
const Jobs = z.object({
  jobs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});
const RefObject = z.object({ sha: Sha, type: z.enum(["commit", "tag"]) });
const Pull = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  merged_at: z.string().nullable(),
  merge_commit_sha: Sha.nullable(),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
  head: z.object({
    ref: z.string(),
    sha: Sha,
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
const Release = z.object({
  id: z.number().int().positive(),
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  immutable: z.boolean().optional(),
  assets: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      state: z.string(),
      size: z.number().int().positive(),
    }),
  ),
});
const VerifiedSubjects = z.array(
  z.object({
    name: z.string(),
    digest: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  }),
);
const FLEET_ASSETS = ["manifold-agent-linux-x64", "manifold-agent-darwin-arm64"] as const;
const IMAGE_ASSET = "release-image.txt";
const ARTIFACT_BUNDLE = "release-artifacts.intoto.jsonl";
const IMAGE_BUNDLE = "release-image.intoto.jsonl";
const RELEASE_ASSETS = [...FLEET_ASSETS, IMAGE_ASSET, ARTIFACT_BUNDLE, IMAGE_BUNDLE];

export interface ReleaseProvenance {
  readonly repository: string;
  readonly tag: string;
  readonly sha: string;
  readonly parent: string;
  readonly pull: number;
  readonly sourceCi: number;
}

export interface VerifiedRelease extends ReleaseProvenance {
  readonly releaseId: number;
  readonly image: string;
}

async function command(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${err.trim()}`);
  return out;
}

async function api(path: string): Promise<unknown> {
  return JSON.parse(await command(["gh", "api", path])) as unknown;
}

function sameRepository(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

export async function releaseRepository(): Promise<string> {
  const name =
    process.env.GITHUB_REPOSITORY ??
    (
      await command(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
    ).trim();
  return Repository.parse(name);
}

/** The setting requires administrator read access; use the release operator's own CLI context. */
export async function requireImmutableReleaseSetting(repository: string): Promise<void> {
  Repository.parse(repository);
  const setting = z
    .object({ enabled: z.boolean() })
    .parse(await api(`repos/${repository}/immutable-releases`));
  if (!setting.enabled) throw new Error("Enable immutable releases before starting a release");
}

async function successfulRun(repository: string, sha: string, main: boolean): Promise<number> {
  Repository.parse(repository);
  Sha.parse(sha);
  const query = `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100${main ? "&branch=main" : ""}`;
  const runs = Runs.parse(await api(query)).workflow_runs;
  const eligible = runs.filter(
    (run) =>
      run.head_sha === sha &&
      (main
        ? run.head_branch === "main" && ["push", "workflow_dispatch"].includes(run.event)
        : run.event === "pull_request"),
  );
  const latest = eligible.reduce<z.infer<typeof Run> | undefined>(
    (newest, run) => (newest === undefined || run.id > newest.id ? run : newest),
    undefined,
  );
  if (
    latest === undefined ||
    latest.status !== "completed" ||
    latest.conclusion !== "success" ||
    latest.path !== ".github/workflows/ci.yml" ||
    latest.head_repository === null ||
    !sameRepository(latest.head_repository.full_name, repository)
  ) {
    throw new Error(
      `${sha} has no successful latest ${main ? "full main" : "release PR"} CI proof`,
    );
  }
  const jobs = Jobs.parse(
    await api(
      `repos/${repository}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=100`,
    ),
  ).jobs;
  const gates = jobs.filter((job) => job.name === "gate");
  if (
    gates.length !== 1 ||
    gates[0]!.status !== "completed" ||
    gates[0]!.conclusion !== "success"
  ) {
    throw new Error(`${sha} has no successful gate in its current CI attempt`);
  }
  return latest.id;
}

export async function requireFullMainCi(repository: string, sha: string): Promise<number> {
  return successfulRun(repository, sha, true);
}

async function remoteTag(repository: string, tag: string): Promise<string> {
  const response = z
    .object({ ref: z.string(), object: RefObject })
    .parse(await api(`repos/${repository}/git/ref/tags/${tag}`));
  if (response.ref !== `refs/tags/${tag}`) throw new Error("GitHub returned another tag reference");
  let object = response.object;
  for (let depth = 0; depth < 8; depth += 1) {
    if (object.type === "commit") return object.sha;
    object = z
      .object({ object: RefObject })
      .parse(await api(`repos/${repository}/git/tags/${object.sha}`)).object;
  }
  throw new Error("Release tag indirection is too deep");
}

async function gitText(args: readonly string[]): Promise<string> {
  return (await command(["git", ...args])).trim();
}

async function fileAt(sha: string, path: string): Promise<string> {
  return command(["git", "show", `${sha}:${path}`]);
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function verifyReleaseDelta(sha: string, parent: string, tag: string): Promise<void> {
  const version = tag.slice(1);
  const before = object(
    JSON.parse(await fileAt(parent, "packages/web/package.json")),
    "parent manifest",
  );
  if (typeof before.version !== "string") throw new Error("Parent manifest has no version");
  resolveReleaseVersion(before.version, version);
  const manifest = `${JSON.stringify({ ...before, version }, null, 2)}\n`;
  if ((await fileAt(sha, "packages/web/package.json")) !== manifest)
    throw new Error("Release manifest differs from the canonical version-only write");

  const lock = await fileAt(parent, "bun.lock");
  const workspaces = object(
    object(Bun.JSONC.parse(lock), "parent lock").workspaces,
    "lock workspaces",
  );
  const workspace = object(workspaces["packages/web"], "web lock entry");
  if (workspace.name !== before.name || workspace.version !== before.version)
    throw new Error("Parent lock does not describe the parent web package");
  // Bun's pinned lock writer changes only this workspace version. Preserve all other bytes:
  // parsed equality would allow duplicate keys with different meanings to another consumer.
  const prefix = `    "packages/web": {\n      "name": ${JSON.stringify(before.name)},\n      "version": `;
  const original = `${prefix}${JSON.stringify(before.version)}`;
  if (!lock.includes(original) || lock.indexOf(original) !== lock.lastIndexOf(original))
    throw new Error("Parent lock has no unique canonical web workspace entry");
  if (
    (await fileAt(sha, "bun.lock")) !==
    lock.replace(original, `${prefix}${JSON.stringify(version)}`)
  )
    throw new Error("Release changes bytes outside the lock's web workspace version");

  const entries = (await command(["git", "ls-tree", "-z", parent, "changes/"]))
    .split("\0")
    .filter(Boolean);
  const fragments: ReleasedFragment[] = [];
  for (const entry of entries) {
    const match = /^(\d+) blob [0-9a-f]{40}\t(changes\/([^/]+))$/.exec(entry);
    if (match === null || match[1] !== "100644")
      throw new Error("Release fragments must be ordinary files");
    if (match[3] === "README.md") continue;
    const fragment = parseFragment(match[3]!, await fileAt(parent, match[2]!));
    let pr = fragment.pr;
    if (pr === null) {
      const subject =
        (await gitText(["log", parent, "--diff-filter=A", "--format=%s", "--", match[2]!])).split(
          "\n",
        )[0] ?? "";
      pr = derivePullRequest(subject);
    }
    if (pr === null) throw new Error(`No merged pull request for changes/${fragment.file}`);
    fragments.push({ ...fragment, pr });
  }
  if (fragments.length === 0) throw new Error("Release has no pending fragments");
  const changelog = await fileAt(sha, "CHANGELOG.md");
  const newest = parseReleasedChangelog(changelog)[0];
  if (newest?.version !== version)
    throw new Error("Release changelog does not start with the tag version");
  const expected = assembleChangelog(
    await fileAt(parent, "CHANGELOG.md"),
    version,
    newest.date,
    fragments,
  );
  if (changelog !== expected)
    throw new Error("Release changelog is not the canonical consumed-fragment delta");

  const expectedPaths = new Set([
    "CHANGELOG.md",
    "bun.lock",
    "packages/web/package.json",
    ...fragments.map((f) => `changes/${f.file}`),
  ]);
  const diff = (
    await command(["git", "diff", "--raw", "--abbrev=40", "--no-renames", "-z", parent, sha])
  ).split("\0");
  diff.pop();
  for (let index = 0; index < diff.length; index += 2) {
    const entry = /^:100644 (100644|000000) [0-9a-f]{40} [0-9a-f]{40} (M|D)$/.exec(diff[index]!);
    const path = diff[index + 1]!;
    const deleted = path.startsWith("changes/");
    if (
      !expectedPaths.delete(path) ||
      entry === null ||
      entry[2] !== (deleted ? "D" : "M") ||
      entry[1] !== (deleted ? "000000" : "100644")
    ) {
      throw new Error(`Release includes a non-release change: ${path}`);
    }
  }
  if (expectedPaths.size !== 0)
    throw new Error("Release did not consume exactly its pending fragments and version metadata");
}

function validateReleaseSelection(repository: string, tag: string): void {
  Repository.parse(repository);
  if (!tag.startsWith("v")) throw new Error("Select an explicit vMAJOR.MINOR.PATCH release tag");
  parseVersion(tag.slice(1));
}

/** Prove a prepared release's local Git delta and source CI before publishing it. */
export async function verifyReleaseCandidate(
  repository: string,
  tag: string,
  sha: string,
): Promise<Pick<ReleaseProvenance, "parent" | "sourceCi">> {
  validateReleaseSelection(repository, tag);
  Sha.parse(sha);
  const parents = (await gitText(["show", "-s", "--format=%P", sha])).split(" ");
  if (parents.length !== 1 || !Sha.safeParse(parents[0]).success)
    throw new Error("Release must have one main predecessor");
  const parent = parents[0]!;
  if ((await gitText(["show", "-s", "--format=%s", sha])) !== `release: ${tag}`) {
    throw new Error("Tag is not a dedicated release commit");
  }
  await verifyReleaseDelta(sha, parent, tag);
  const sourceCi = await requireFullMainCi(repository, parent);
  return { parent, sourceCi };
}

/** Prove an integrated release independently of whether its tag has been published. */
export async function verifyReleaseCommit(
  repository: string,
  tag: string,
  sha: string,
): Promise<ReleaseProvenance> {
  validateReleaseSelection(repository, tag);
  Sha.parse(sha);
  const repo = z
    .object({ full_name: z.string(), default_branch: z.literal("main") })
    .parse(await api(`repos/${repository}`));
  if (!sameRepository(repo.full_name, repository)) throw new Error("Repository identity mismatch");
  const main = z
    .object({ name: z.literal("main"), commit: z.object({ sha: Sha }) })
    .parse(await api(`repos/${repository}/branches/main`)).commit.sha;
  await command(["git", "fetch", "--no-tags", "origin", sha, main]);
  await command(["git", "merge-base", "--is-ancestor", sha, main]);
  const { parent, sourceCi } = await verifyReleaseCandidate(repository, tag, sha);
  const pulls = z
    .array(Pull)
    .parse(await api(`repos/${repository}/commits/${sha}/pulls?per_page=100`));
  const matches = pulls.filter(
    (pull) =>
      pull.merged_at !== null &&
      pull.merge_commit_sha === sha &&
      pull.title === `release: ${tag}` &&
      pull.base.ref === "main" &&
      sameRepository(pull.base.repo.full_name, repository) &&
      pull.head.repo !== null &&
      sameRepository(pull.head.repo.full_name, repository) &&
      pull.head.ref === `release/${tag}`,
  );
  if (matches.length !== 1) throw new Error("Release has no unambiguous merged release PR");
  const pull = matches[0]!;
  z.object({ commits: z.literal(1) }).parse(await api(`repos/${repository}/pulls/${pull.number}`));
  const head = z
    .object({ tree: z.object({ sha: Sha }) })
    .parse(await api(`repos/${repository}/git/commits/${pull.head.sha}`));
  if (head.tree.sha !== (await gitText(["rev-parse", `${sha}^{tree}`])))
    throw new Error("Release differs from its checked PR tree");
  await successfulRun(repository, pull.head.sha, false);
  await command(["gh", "pr", "checks", String(pull.number), "--repo", repository, "--required"]);
  return { repository, tag, sha, parent, pull: pull.number, sourceCi };
}

export async function verifyReleaseTag(
  repository: string,
  tag: string,
): Promise<ReleaseProvenance> {
  validateReleaseSelection(repository, tag);
  const sha = await remoteTag(repository, tag);
  const proof = await verifyReleaseCommit(repository, tag, sha);
  if ((await remoteTag(repository, tag)) !== sha)
    throw new Error("Release tag moved during provenance verification");
  return proof;
}

async function verifyAttestedSubject(
  proof: ReleaseProvenance,
  artifact: string,
  bundle: string,
  name: string,
  sha256: string,
): Promise<void> {
  // Exact certificate identity includes the workflow; gh forbids combining it with --signer-workflow.
  const subjects = VerifiedSubjects.parse(
    JSON.parse(
      await command([
        "gh",
        "attestation",
        "verify",
        artifact,
        "--bundle",
        bundle,
        "--repo",
        proof.repository,
        "--cert-identity",
        `https://github.com/${proof.repository}/.github/workflows/release.yml@refs/tags/${proof.tag}`,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--source-ref",
        `refs/tags/${proof.tag}`,
        "--source-digest",
        proof.sha,
        "--signer-digest",
        proof.sha,
        "--deny-self-hosted-runners",
        "--format",
        "json",
        "--jq",
        "[.[].verificationResult.statement.subject[]]",
      ]),
    ),
  );
  // Native digest verification alone permits exchanging two correctly signed platform binaries.
  if (!subjects.some((subject) => subject.name === name && subject.digest.sha256 === sha256)) {
    throw new Error(`Attestation does not bind ${name} to its release bytes`);
  }
}
async function draftRelease(repository: string, tag: string): Promise<z.infer<typeof Release>> {
  // The by-tag REST endpoint is published-only. Inspect every page, and refuse duplicate drafts.
  const pages = z
    .array(z.array(Release.pick({ id: true, tag_name: true, draft: true })))
    .parse(
      JSON.parse(
        await command([
          "gh",
          "api",
          `repos/${repository}/releases?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      ),
    );
  const matches = pages.flatMap((page) =>
    page.filter((release) => release.draft && release.tag_name === tag),
  );
  if (matches.length !== 1) throw new Error("Expected a unique draft for the release tag");
  const release = Release.parse(await api(`repos/${repository}/releases/${matches[0]!.id}`));
  if (release.id !== matches[0]!.id) throw new Error("GitHub returned another draft release");
  return release;
}

async function downloadAsset(repository: string, id: number, path: string): Promise<void> {
  const child = Bun.spawn(
    [
      "gh",
      "api",
      `repos/${repository}/releases/assets/${id}`,
      "--header",
      "Accept: application/octet-stream",
    ],
    { stdout: Bun.file(path), stderr: "pipe" },
  );
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Release asset download failed (${code}): ${err.trim()}`);
}

async function verifyReleaseAssets(
  repository: string,
  tag: string,
  draft: boolean,
): Promise<VerifiedRelease> {
  const proof = await verifyReleaseTag(repository, tag);
  const release = draft
    ? await draftRelease(repository, tag)
    : Release.parse(await api(`repos/${repository}/releases/tags/${tag}`));
  if (
    release.tag_name !== tag ||
    release.draft !== draft ||
    release.prerelease ||
    (!draft && release.immutable !== true)
  ) {
    throw new Error(
      draft ? "Expected a staged, non-prerelease draft" : "Release is not published and immutable",
    );
  }
  for (const name of RELEASE_ASSETS) {
    const assets = release.assets.filter(
      (asset) => asset.name === name && asset.state === "uploaded",
    );
    if (assets.length !== 1) throw new Error(`Release is missing its unique ${name} asset`);
  }
  const directory = await mkdtemp(join(tmpdir(), "manifold-release-proof-"));
  try {
    for (const name of RELEASE_ASSETS) {
      const asset = release.assets.find(
        (candidate) => candidate.name === name && candidate.state === "uploaded",
      )!;
      await downloadAsset(repository, asset.id, join(directory, name));
    }
    for (const name of [...FLEET_ASSETS, IMAGE_ASSET]) {
      const artifact = join(directory, name);
      const hash = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(artifact).stream()) hash.update(chunk);
      await verifyAttestedSubject(
        proof,
        artifact,
        join(directory, ARTIFACT_BUNDLE),
        name,
        hash.digest("hex"),
      );
    }
    const image = (await readFile(join(directory, IMAGE_ASSET), "utf8")).trim();
    const prefix = `ghcr.io/${repository.toLowerCase()}@`;
    if (!image.startsWith(prefix) || !/^sha256:[0-9a-f]{64}$/.test(image.slice(prefix.length))) {
      throw new Error("Release image is not an immutable image in this repository's namespace");
    }
    await verifyAttestedSubject(
      proof,
      `oci://${image}`,
      join(directory, IMAGE_BUNDLE),
      prefix.slice(0, -1),
      image.slice(prefix.length + "sha256:".length),
    );
    if ((await remoteTag(repository, tag)) !== proof.sha)
      throw new Error("Release tag moved while checking artifacts");
    return { ...proof, releaseId: release.id, image };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function verifyPromotionRelease(
  repository: string,
  tag: string,
): Promise<VerifiedRelease> {
  const proof = await verifyReleaseAssets(repository, tag, false);
  await requireFullMainCi(repository, proof.sha);
  return proof;
}

async function main(): Promise<void> {
  const [mode, tag, ...extra] = process.argv.slice(2);
  if (
    tag === undefined ||
    extra.length !== 0 ||
    !["tag", "draft", "published", "promotion"].includes(mode ?? "")
  ) {
    throw new Error(
      "Usage: bun scripts/release-provenance.ts <tag|draft|published|promotion> vMAJOR.MINOR.PATCH",
    );
  }
  const repository = await releaseRepository();
  const proof =
    mode === "tag"
      ? await verifyReleaseTag(repository, tag)
      : mode === "promotion"
        ? await verifyPromotionRelease(repository, tag)
        : await verifyReleaseAssets(repository, tag, mode === "draft");
  console.log(JSON.stringify(proof));
}

if (import.meta.main) await main();
