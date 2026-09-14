#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildChannel } from "../packages/protocol/src/index.ts";

/**
 * WHAT RUNS, in three words — the one derivation behind `/healthz`, the web bundle's rev line
 * and the deploy workflows' "did the right thing come up" checks (docs/CONTRACTS.md §HTTP,
 * docs/SELF-HOST.md §Environments).
 *
 *   version  the last reachable release tag, without its `v`
 *   build    `version` at that tag exactly; `<version>+<distance>.g<sha7>` past it; `.dirty`
 *            appended when the working tree has uncommitted changes
 *   channel  `release` when build equals version, `development` otherwise
 *
 * ONE implementation on purpose: the server derives it at boot (`packages/server/src/config.ts`)
 * and vite injects it into the bundle (`packages/web/vite.config.ts`), so the two halves of one
 * deployment can never disagree about what they are. Both prefer the `MANIFOLD_VERSION`,
 * `MANIFOLD_BUILD` and `MANIFOLD_CHANNEL` environment variables when set — that is how a
 * container, which ships no `.git`, learns its identity from the Dockerfile ARGs a workflow or
 * compose passed — and derive from git only what the environment left unsaid.
 *
 * Without git or a reachable `v*` tag the identity falls back to `packages/web/package.json`'s
 * version (the file `bun run release` bumps), as a `development` build with `build = version`.
 */

export interface BuildIdentity {
  readonly version: string;
  readonly build: string;
  readonly channel: BuildChannel;
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESCRIBE = /^v(.+)-(\d+)-g([0-9a-f]+)(-dirty)?$/;
const CHANNELS: readonly BuildChannel[] = ["release", "development"];
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function describe(repositoryRoot: string, revision?: string): string | null {
  const args = ["describe", "--tags", "--long", "--abbrev=7", "--match", "v*"];
  args.push(revision ?? "--dirty=-dirty");
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function packagedVersion(repositoryRoot: string, revision?: string): string {
  try {
    const contents =
      revision === undefined
        ? readFileSync(resolve(repositoryRoot, "packages/web/package.json"), "utf8")
        : execFileSync("git", ["show", `${revision}:packages/web/package.json`], {
            cwd: repositoryRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
    const metadata: unknown = JSON.parse(contents);
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "version" in metadata &&
      typeof metadata.version === "string" &&
      metadata.version !== ""
    ) {
      return metadata.version;
    }
  } catch (cause) {
    if (revision !== undefined) {
      throw new Error(`Cannot read the package version at ${revision}`, { cause });
    }
    // A compiled binary carries no package.json beside it; the fallback below is honest about that.
  }
  if (revision !== undefined) throw new Error(`No package version at ${revision}`);
  return "0.0.0";
}

/** Derives the checked-out tree's identity, or an immutable commit without moving the checkout. */
export function deriveBuildIdentity(
  repositoryRoot: string = REPOSITORY_ROOT,
  revision?: string,
): BuildIdentity {
  if (revision !== undefined) {
    if (!COMMIT_SHA.test(revision)) throw new Error("Build revision must be a full commit SHA");
    let resolved: string;
    try {
      resolved = execFileSync("git", ["rev-parse", "--verify", `${revision}^{commit}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch (cause) {
      throw new Error(`Cannot resolve build revision ${revision}`, { cause });
    }
    if (resolved !== revision) throw new Error(`Build revision ${revision} is not a commit`);
  }
  const match = describe(repositoryRoot, revision)?.match(DESCRIBE);
  if (match === null || match === undefined) {
    const version = packagedVersion(repositoryRoot, revision);
    return { version, build: version, channel: "development" };
  }
  const [, version = "", distance = "0", sha = "", dirty] = match;
  const released = distance === "0" && dirty === undefined;
  return {
    version,
    build: released
      ? version
      : `${version}+${distance}.g${sha}${dirty === undefined ? "" : ".dirty"}`,
    channel: released ? "release" : "development",
  };
}

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The environment's word first, the tree's for whatever it left blank. `MANIFOLD_CHANNEL` must
 * be one of the two channels: a misspelt deploy is refused at boot rather than reported as a
 * channel nobody defined.
 */
export function resolveBuildIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
  repositoryRoot: string = REPOSITORY_ROOT,
): BuildIdentity {
  const version = setting(env.MANIFOLD_VERSION);
  const build = setting(env.MANIFOLD_BUILD);
  const channel = setting(env.MANIFOLD_CHANNEL);
  if (channel !== undefined && !CHANNELS.includes(channel as BuildChannel)) {
    throw new Error(`MANIFOLD_CHANNEL must be one of ${CHANNELS.join(", ")}, not ${channel}`);
  }
  const derived =
    version === undefined || build === undefined || channel === undefined
      ? deriveBuildIdentity(repositoryRoot)
      : undefined;
  return {
    version: version ?? derived?.version ?? "0.0.0",
    build: build ?? derived?.build ?? "0.0.0",
    channel: (channel as BuildChannel | undefined) ?? derived?.channel ?? "development",
  };
}

if (import.meta.main) {
  // Derive from trusted tooling even when an older source revision is being deployed.
  let repositoryRoot = REPOSITORY_ROOT;
  let revision: string | undefined;
  let emitEnvironment = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    switch (argument) {
      case "--env":
        emitEnvironment = true;
        break;
      case "--repository":
      case "--revision": {
        const value = process.argv[++index];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${argument} requires a value`);
        }
        if (argument === "--repository") repositoryRoot = resolve(value);
        else revision = value;
        break;
      }
      default:
        throw new Error(`Unknown build identity argument: ${argument}`);
    }
  }
  const identity = deriveBuildIdentity(repositoryRoot, revision);
  if (emitEnvironment) {
    console.log(
      [
        `export MANIFOLD_VERSION=${identity.version}`,
        `export MANIFOLD_BUILD=${identity.build}`,
        `export MANIFOLD_CHANNEL=${identity.channel}`,
      ].join("\n"),
    );
  } else {
    console.log(JSON.stringify(identity));
  }
}
