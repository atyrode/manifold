import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { engineHashes } from "./engines.ts";

// The countryside built here (bun: JavaScriptCore, Safari's engine) and by node running engines.ts
// (V8, Chrome's), part by part: the same bits, so a seed lays out the same countryside in every
// browser. Skipped, saying so, where no node can run it.

const SCRIPT = fileURLToPath(new URL("./engines.ts", import.meta.url));

/** The node to run the build, or why there is none: none on the PATH, or too old to strip types. */
function v8(): { node: string } | { missing: string } {
  const node = Bun.which("node");
  if (node === null) return { missing: "no node on the PATH" };
  const version = Bun.spawnSync([node, "--version"]).stdout.toString().trim();
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  // --experimental-strip-types came with node 22.6.
  if (major < 22 || (major === 22 && minor < 6))
    return { missing: `node ${version} cannot strip TypeScript's types (22.6 or later can)` };
  return { node };
}

const engine = v8();
if ("missing" in engine)
  console.warn(
    `country/engines.test.ts skipped: ${engine.missing}; the build is not compared with V8`,
  );

test.skipIf("missing" in engine)(
  "the countryside builds bit for bit the same in V8 (node) as in JavaScriptCore (bun)",
  async () => {
    if (!("node" in engine)) return;
    // Node builds alongside this engine.
    const run = Bun.spawn([engine.node, "--experimental-strip-types", "--no-warnings", SCRIPT], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const here = engineHashes();
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toEqual(here);
  },
  120_000,
);
