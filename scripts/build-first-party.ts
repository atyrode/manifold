#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { HARDENED_SOURCE_RECIPES, SERVER_PLUGIN_DEFS } from "../packages/server/src/assembly.ts";
import {
  compileTrustedBuilds,
  trustedArtifactFile,
} from "../packages/server/src/first-party-builds.ts";

/**
 * BUILD-TIME TRUSTED FIRST-PARTY ARTIFACTS (ADR 0053 §7, issue #259).
 *
 * A packaged hub that carries no source tree (the Nix `bun build --compile` binary) cannot
 * compile a hardened first-party plugin at start. This compiles every recipe the composition
 * root names, with the same compiler and binding checks the source hub runs at start, and
 * writes `<out>/<id>.manifold-plugin.json`. The package ships that directory beside the binary
 * as `MANIFOLD_FIRST_PARTY_ARTIFACTS`; selecting an id is still the operator's
 * `MANIFOLD_HARDENED_PLUGINS`, and the binary re-binds each artifact to its own registered
 * definition before any of it runs.
 *
 *   bun scripts/build-first-party.ts <out-dir>
 */
const out = process.argv[2];
if (out === undefined || process.argv.length !== 3) {
  console.error("usage: bun scripts/build-first-party.ts <out-dir>");
  process.exit(2);
}
const builds = await compileTrustedBuilds(
  [...HARDENED_SOURCE_RECIPES.keys()],
  SERVER_PLUGIN_DEFS,
  HARDENED_SOURCE_RECIPES,
);
mkdirSync(out, { recursive: true });
for (const build of builds) {
  writeFileSync(trustedArtifactFile(out, build.bundle.manifest.id), build.bytes);
  console.log(`${build.bundle.manifest.id} ${build.sha256}`);
}
