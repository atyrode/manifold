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

function describe(repositoryRoot: string): string | null {
  try {
    return execFileSync(
      "git",
      ["describe", "--tags", "--long", "--abbrev=7", "--match", "v*", "--dirty=-dirty"],
      { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

function packagedVersion(repositoryRoot: string): string {
  try {
    const metadata = JSON.parse(
      readFileSync(resolve(repositoryRoot, "packages/web/package.json"), "utf8"),
    ) as { readonly version?: unknown };
    if (typeof metadata.version === "string" && metadata.version !== "") return metadata.version;
  } catch {
    // A compiled binary carries no package.json beside it; the fallback below is honest about that.
  }
  return "0.0.0";
}

/** Derives the identity of the tree at `repositoryRoot` (this checkout by default). */
export function deriveBuildIdentity(repositoryRoot: string = REPOSITORY_ROOT): BuildIdentity {
  const match = describe(repositoryRoot)?.match(DESCRIBE);
  if (match === null || match === undefined) {
    const version = packagedVersion(repositoryRoot);
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
  // `bun scripts/build-identity.ts` prints JSON; `--env` prints `export`s for a shell to eval
  // before `docker compose up --build`, which is how a self-hoster stamps a locally built image.
  const identity = deriveBuildIdentity();
  if (process.argv.includes("--env")) {
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
