#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { HARDENED_SOURCE_RECIPES } from "../packages/server/src/assembly.ts";

const outfile = process.argv[2];
if (outfile === undefined || process.argv.length !== 3)
  throw new Error("usage: bun scripts/build-server.ts <outfile>");
const dependencies = [...HARDENED_SOURCE_RECIPES.values()].flatMap((recipe) => {
  const build = recipe().serverBuild;
  return build === undefined ? [] : [build];
});
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../packages/server/src/main.ts")],
  target: "bun",
  format: "esm",
  plugins: dependencies.flatMap((build) => [...(build.plugins ?? [])]),
  external: dependencies.flatMap((build) => [...(build.external ?? [])]),
  compile: { outfile, execArgv: ["--no-install"] },
});
if (!result.success) throw new AggregateError(result.logs, "standalone hub compilation failed");
const members = new Set<string>();
for (const build of dependencies) {
  for (const [name, bytes] of build.files ?? []) {
    if (members.has(name)) throw new Error(`duplicate standalone build resource: ${name}`);
    members.add(name);
    await Bun.write(join(dirname(outfile), name), bytes);
  }
}
