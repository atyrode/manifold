import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = mkdtempSync(join(tmpdir(), "manifold-deployment-order-"));
const repository = join(directory, "repository");
const bin = join(directory, "bin");
let base = "";
let first = "";
let second = "";
let divergent = "";

function command(argv: string[], cwd = repository, env: Record<string, string> = {}) {
  const result = Bun.spawnSync(argv, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      PREVIEW_HOME: join(directory, "home"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

function git(...args: string[]): string {
  const result = command(["git", ...args]);
  if (result.code !== 0) throw new Error(result.err);
  return result.out;
}

function commit(message: string): string {
  git("commit", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

function order(current: string, target: string, mode = "forward", expected = "") {
  return command([
    "bash",
    "-c",
    'source "$1"; source "$2"; require_development_order "$3" "$4" "$5" "$6" "$7"',
    "test",
    join(root, "infra/previews/common.sh"),
    join(root, "infra/previews/deployment-order.sh"),
    repository,
    current,
    target,
    mode,
    expected,
  ]);
}

function provenance(
  revision: string,
  builds: string[] = [],
  marker = revision === "missing" ? "" : "git-v1",
) {
  const docker = join(bin, "docker");
  const container = "1".repeat(64);
  const image = `sha256:${"2".repeat(64)}`;
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
case "$1:$2" in
  ps:--all) printf '%s\\n' '${container}' ;;
  container:inspect) printf '%s\\n' '${JSON.stringify([
    {
      Config: {
        Labels: {
          "com.docker.compose.project": "manifold-dev-test",
          "com.docker.compose.service": "manifold",
        },
      },
      Image: image,
    },
  ])}' ;;
  image:inspect) printf '%s\\n' '${JSON.stringify([
    {
      Config: {
        Labels: {
          ...(marker === "" ? {} : { "io.manifold.deployment.provenance": marker }),
          ...(revision === "missing" ? {} : { "org.opencontainers.image.revision": revision }),
        },
        Env: builds.map((build) => `MANIFOLD_BUILD=${build}`),
      },
    },
  ])}' ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return command(
    [
      "bash",
      "-c",
      'set -euo pipefail; source "$1"; source "$2"; image=$(installed_development_image manifold-dev-test); development_image_revision "$image" "$3"',
      "test",
      join(root, "infra/previews/common.sh"),
      join(root, "infra/previews/deployment-order.sh"),
      repository,
    ],
    repository,
    { PATH: `${bin}:${process.env.PATH}` },
  );
}

beforeAll(() => {
  mkdirSync(repository);
  mkdirSync(bin);
  git("init", "-q");
  git("config", "user.name", "Deployment order fixture");
  git("config", "user.email", "deployment-order@invalid");
  base = commit("base");
  git("tag", "v1.0.0", base);
  first = commit("first");
  second = commit("second");
  git("checkout", "-q", "--detach", base);
  divergent = commit("divergent");
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("development deployment ordering", () => {
  test("normal deployments accept forward ancestry and same-target retries", () => {
    expect(order(first, second).code).toBe(0);
    expect(order(second, second).code).toBe(0);
  });

  test("normal deployments refuse backward and divergent targets", () => {
    expect(order(second, first)).toMatchObject({ code: 2 });
    expect(order(second, divergent)).toMatchObject({ code: 2 });
  });

  test("rollback is backward-only CAS with an idempotent target retry", () => {
    expect(order(second, first, "rollback", second).code).toBe(0);
    expect(order(second, first, "rollback", first)).toMatchObject({ code: 2 });
    expect(order(second, divergent, "rollback", second)).toMatchObject({ code: 2 });
    expect(order(first, first, "rollback", second).code).toBe(0);
  });
});

describe("installed image provenance", () => {
  test("uses the immutable image revision even when checkout HEAD drifted", () => {
    git("checkout", "-q", "--detach", first);
    const installed = provenance(second);
    expect(installed.code).toBe(0);
    expect(order(installed.out, first).code).toBe(2);
  });

  test("conservatively resolves canonical legacy development and release builds", () => {
    const described = git("describe", "--tags", "--long", "--abbrev=7", first);
    const match = /^v(.+)-(\d+)-g([0-9a-f]{7})$/.exec(described);
    if (match === null) throw new Error("Fixture commit has no canonical build");
    const build = `${match[1]}+${match[2]}.g${match[3]}`;
    expect(provenance("missing", [build])).toMatchObject({ code: 0, out: first });
    expect(provenance("missing", ["1.0.0"])).toMatchObject({ code: 0, out: base });
  });

  test("legacy images do not mistake a base image OCI revision for the application", () => {
    const described = git("describe", "--tags", "--long", "--abbrev=7", first);
    const match = /^v(.+)-(\d+)-g([0-9a-f]{7})$/.exec(described);
    if (match === null) throw new Error("Fixture commit has no canonical build");
    const build = `${match[1]}+${match[2]}.g${match[3]}`;
    expect(provenance("f".repeat(40), [build], "")).toMatchObject({ code: 0, out: first });
    expect(provenance(first, [build], "unknown").code).toBe(2);
  });

  test("refuses malformed, missing, ambiguous and dirty provenance", () => {
    expect(provenance("short")).toMatchObject({ code: 2 });
    expect(provenance("missing")).toMatchObject({ code: 2 });
    expect(provenance("missing", ["1.0.0", "1.0.1"])).toMatchObject({ code: 2 });
    expect(provenance("missing", ["1.0.0+1.g1234567.dirty"])).toMatchObject({ code: 2 });
  });

  test("an image label must name a commit, not an annotated tag object", () => {
    git("tag", "-a", "image-provenance", "-m", "not a commit", second);
    expect(provenance(git("rev-parse", "image-provenance")).code).toBe(2);
    expect(provenance("0".repeat(40)).code).toBe(2);
  });
});

describe("forced-command rollback grammar", () => {
  test("refuses abbreviated rollback expectations before invoking deployment", () => {
    const receiverDir = join(directory, "receiver");
    const home = join(directory, "receiver-home");
    mkdirSync(receiverDir);
    mkdirSync(home);
    cpSync(join(root, "infra/previews/receiver.sh"), join(receiverDir, "receiver.sh"));
    cpSync(join(root, "infra/previews/common.sh"), join(receiverDir, "common.sh"));
    writeFileSync(join(home, "env"), "PREVIEW_DOMAIN=preview.invalid\n");
    const refused = command(["bash", join(receiverDir, "receiver.sh")], receiverDir, {
      PREVIEW_HOME: home,
      SSH_ORIGINAL_COMMAND: `dev-rollback ${second.slice(0, 12)} ${first}`,
    });
    expect(refused.code).toBe(2);
  });
});
