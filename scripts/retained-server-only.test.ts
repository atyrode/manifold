import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const classifier = pathToFileURL(
  join(import.meta.dir, "../infra/previews/retained-server-only.ts"),
).href;

// Each scenario is one raced /proc transition and the predicate it must answer with; `null`
// admits. The predicate is the contract: a refusal that names nothing is what made an
// integrated-preview recurrence diagnosable only by elimination (#699).
for (const [scenario, expected] of [
  ["gone", null],
  ["unreadable-cmdline-live", "process-unreadable"],
  ["pid-reused", "pid-reused-during-probe"],
  ["unreadable", "process-unreadable"],
  ["unknown", "unclassified-process"],
  ["healthcheck-exec-transition", null],
  ["healthcheck-exec-transition-reused", "unclassified-process"],
  ["zombie", null],
  ["zombie-reaped", null],
  ["exiting-zombie", null],
  ["exiting-zombie-live-threads", "process-unreadable"],
  ["zombie-with-live-threads", "zombie-identity-unconfirmed"],
  ["zombie-reused", "zombie-identity-unconfirmed"],
  ["zombie-unreadable", "process-unreadable"],
] as const) {
  test(`retained process snapshot ${expected === null ? "admits" : `answers ${expected} for`} a ${scenario} process`, async () => {
    // Run the real streamed classifier in an isolated process. Fault injection makes
    // the /proc enumeration/read race deterministic without altering any real PID.
    const script = `
import { mock } from "bun:test";
const scenario = ${JSON.stringify(scenario)};
const statFor = (state = "S", threads = "1", started = "12345") =>
  "1 (bun) " + Array.from({ length: 20 }, (_, index) =>
    index === 0 ? state : index === 17 ? threads : index === 19 ? started : "0").join(" ");
const stat = statFor();
let statReads = 0;
let cmdlineReads = 0;
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
      statReads++;
      // The listed process is still alive at the first read and has exited by the second.
      if (scenario === "zombie-reaped") return statReads === 1 ? statFor("Z") : fail("ENOENT");
      if (scenario.startsWith("exiting-zombie"))
        return statReads === 1
          ? stat
          : statFor("Z", scenario.endsWith("-live-threads") ? "2" : "1");
      if (scenario === "pid-reused") return statReads === 1 ? stat : statFor("S", "1", "54321");
      if (scenario.startsWith("zombie")) {
        if (scenario === "zombie-unreadable" && statReads > 1) return fail("EACCES");
        return statFor(
          "Z",
          scenario === "zombie-with-live-threads" ? "2" : "1",
          scenario === "zombie-reused" && statReads > 1 ? "54321" : "12345",
        );
      }
      if (scenario.startsWith("healthcheck-exec-transition"))
        return statFor("S", "1", scenario.endsWith("-reused") && statReads > 1 ? "54321" : "12345");
      return stat;
    }
    if (path === "/proc/99999999/cmdline") {
      if (scenario === "unreadable") return fail("EACCES");
      if (scenario === "unknown") return "unrecognized-owner\\0";
      if (scenario.startsWith("healthcheck-exec-transition")) {
        cmdlineReads++;
        return cmdlineReads === 1
          ? "/bin/sh\\0-c\\0bun -e \\"const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);\\"\\0"
          : "bun\\0-e\\0const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);\\0";
      }
      return fail("ENOENT");
    }
    return fail("EACCES");
  },
  readlinkSync: (path) => {
    if (path === "/proc/1/exe") return "/usr/local/bin/bun";
    if (path === "/proc/1/cwd") return "/app";
    if (path === "/proc/99999999/exe")
      return scenario.startsWith("healthcheck-exec-transition")
        ? "/usr/local/bin/bun"
        : "/usr/local/bin/unknown-owner";
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
      expect(code).toBe(expected === null ? 0 : 1);
      expect(stdout.includes("retained-processes-server-only")).toBe(expected === null);
      if (expected !== null) expect(stdout).toContain(`retained-processes-hold:${expected}`);
      // The predicate is the entire disclosure: no argument, path or probe error escapes.
      expect(stdout).not.toContain("private proc metadata");
      expect(stdout).not.toContain("/proc/");
      expect(stderr).not.toContain("private proc metadata");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}
