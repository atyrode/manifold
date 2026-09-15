import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const classifier = pathToFileURL(
  join(import.meta.dir, "../infra/previews/retained-server-only.ts"),
).href;

for (const scenario of ["gone", "reused", "unreadable", "unknown"] as const) {
  test(`retained process snapshot ${scenario === "gone" ? "admits" : "refuses"} a ${scenario} process`, async () => {
    // Run the real streamed classifier in an isolated process. Fault injection makes
    // the /proc enumeration/read race deterministic without altering any real PID.
    const script = `
import { mock } from "bun:test";
const scenario = ${JSON.stringify(scenario)};
const stat = "1 (bun) " + Array.from({ length: 20 }, (_, index) => index === 19 ? "12345" : "0").join(" ");
const fail = (code) => { throw Object.assign(new Error("private proc metadata"), { code }); };
mock.module("node:fs", () => ({
  readdirSync: () => ["1", "99999999"],
  readFileSync: (path) => {
    if (path === "/proc/1/stat") return stat;
    if (path === "/proc/1/status") return "Uid:\\t0 0 0 0\\nGid:\\t0 0 0 0\\n";
    if (path === "/proc/1/environ") return "";
    if (path === "/proc/1/cmdline") return "bun\\0packages/server/src/main.ts\\0";
    if (path === "/proc/99999999/stat") {
      if (scenario === "gone") return fail("ENOENT");
      return stat;
    }
    if (path === "/proc/99999999/cmdline") {
      if (scenario === "unreadable") return fail("EACCES");
      if (scenario === "unknown") return "unrecognized-owner\\0";
      return fail("ENOENT");
    }
    return fail("EACCES");
  },
  readlinkSync: (path) => {
    if (path === "/proc/1/exe") return "/usr/local/bin/bun";
    if (path === "/proc/1/cwd") return "/app";
    if (path === "/proc/99999999/exe") return "/usr/local/bin/unknown-owner";
    return fail("EACCES");
  },
}));
// The classifier exits at module scope; load it only after injecting the raced /proc boundary.
await import(${JSON.stringify(classifier)});
`;
    const directory = mkdtempSync(join(tmpdir(), "manifold-retained-race-"));
    try {
      const fixture = join(directory, "classifier.test.ts");
      writeFileSync(fixture, script);
      // Bun's built-in module mocks are active only under its test runner.
      const child = Bun.spawn([process.execPath, "test", fixture], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(scenario === "gone" ? 0 : 1);
      expect(stdout.includes("retained-processes-server-only")).toBe(scenario === "gone");
      expect(stderr).not.toContain("private proc metadata");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}
