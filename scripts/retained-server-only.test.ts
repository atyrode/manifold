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
// integrated-preview recurrence diagnosable only by elimination (#699), and one word shared by
// three read failures and a live process is what made the next recurrence need its own issue
// (#738). A process that is exiting is watched to its end rather than refused: an exiting
// multi-threaded process drops `cmdline`/`exe` while still listed and even still running.
// The third column is how many reads the kernel refused during the scan, which the probe now
// reports alongside its predicate: one denied read and a container of them are the same word
// otherwise, and they want different repairs (#756). It is a count and nothing else — the last
// assertion here pins the entire disclosure to predicate plus integer.
for (const [scenario, expected, denied] of [
  ["gone", null],
  ["unreadable-cmdline-live", "exit-unproven"],
  ["pid-reused", "pid-reused-during-probe"],
  ["unreadable", "fingerprint-unreadable-denied", 1],
  // A denied fingerprint read on a process the kernel then confirms has EXITED owns no live
  // work: `stat` answers the exit question without ptrace access, and refusing before asking it
  // is what made the integrated preview refuse its own harness's exec session (#756).
  ["unreadable-then-gone", null, 1],
  ["unreadable-then-reused", "pid-reused-during-probe", 1],
  ["unreadable-twice", "fingerprint-unreadable-denied", 2],
  ["unreadable-then-unknown", "unclassified-process", 1],
  ["unreadable-vanished", "fingerprint-unreadable-vanished"],
  ["unreadable-unmapped", "fingerprint-unreadable-unmapped"],
  ["unreadable-no-errno", "classifier-fault"],
  ["unreadable-recheck", "exit-unconfirmable-denied", 1],
  ["unknown", "unclassified-process"],
  ["healthcheck-exec-transition", null],
  ["healthcheck-exec-transition-reused", "unclassified-process"],
  ["zombie", null],
  ["zombie-reaped", null],
  ["exiting-zombie", null],
  ["exiting-group-finishes", null],
  ["exiting-zombie-live-threads", "exit-unproven"],
  ["zombie-with-live-threads", "exit-unproven"],
  ["zombie-reused", "zombie-identity-unconfirmed"],
  ["zombie-unreadable", "exit-unconfirmable-denied", 1],
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
  readdirSync: () =>
    scenario === "unreadable-twice" || scenario === "unreadable-then-unknown"
      ? ["1", "99999999", "99999998"]
      : ["1", "99999999"],
  readFileSync: (path) => {
    if (path === "/proc/1/stat") return stat;
    if (path === "/proc/1/status") return "Uid:\\t0 0 0 0\\nGid:\\t0 0 0 0\\n";
    if (path === "/proc/1/environ") return "";
    if (path === "/proc/1/cmdline") return "bun\\0packages/server/src/main.ts\\0";
    if (path === "/proc/99999998/stat") return stat;
    if (path === "/proc/99999998/cmdline")
      return scenario === "unreadable-then-unknown" ? "unrecognized-owner\\0" : fail("EACCES");
    if (path === "/proc/99999999/stat") {
      if (scenario === "gone") return fail("ENOENT");
      statReads++;
      // The listed process is still alive at the first read and has exited by the second.
      if (scenario === "zombie-reaped") return statReads === 1 ? statFor("Z") : fail("ENOENT");
      if (scenario === "unreadable-recheck") return statReads === 1 ? stat : fail("EACCES");
      // The denied read happens first; the exit is what the probe asks stat about afterwards.
      if (scenario === "unreadable-then-gone") return statReads === 1 ? stat : fail("ENOENT");
      if (scenario === "unreadable-then-reused")
        return statReads === 1 ? stat : statFor("S", "1", "54321");
      // The measured shape of a real exiting \`bun -e\` healthcheck: its address space is gone
      // while it is still RUNNING with a sibling thread, then its leader is a zombie with that
      // thread, then the kernel reaps it to a lone zombie.
      if (scenario === "exiting-group-finishes")
        return statReads === 1
          ? statFor("R", "2")
          : statReads === 2
            ? statFor("Z", "2")
            : statFor("Z", "1");
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
      if (
        scenario === "unreadable" ||
        scenario === "unreadable-twice" ||
        scenario === "unreadable-then-unknown" ||
        scenario === "unreadable-then-gone" ||
        scenario === "unreadable-then-reused"
      )
        return fail("EACCES");
      if (scenario === "unreadable-vanished") return fail("ESRCH");
      if (scenario === "unreadable-unmapped") return fail("EIO");
      // A thrown value with no errno is a fault in the classifier, not a raced read.
      if (scenario === "unreadable-no-errno") throw new Error("private proc metadata");
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
    if (path === "/proc/99999998/exe") return "/usr/local/bin/unknown-owner";
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
      const success = stdout
        .split("\n")
        .find((line) => line.startsWith("retained-processes-server-only"));
      expect(success !== undefined).toBe(expected === null);
      if (expected === null) {
        // A success says how many reads the kernel refused, and nothing more: admitting is what
        // the probe DOES with a denied read whose process it then proved had exited, and an
        // admission that recorded nothing made that handling indistinguishable from a run where
        // the condition never arose (#762). Silent at zero, so the field carries information
        // whenever it appears, and bounded to the integer (#756).
        expect(success).toBe(
          denied === undefined
            ? "retained-processes-server-only"
            : `retained-processes-server-only denied=${String(denied)}`,
        );
      }
      if (expected !== null) {
        expect(stdout).toContain(
          `retained-processes-hold:${expected}${denied === undefined ? "" : ` denied=${String(denied)}`}`,
        );
        // The whole answer, not a substring of it: the disclosure bound this gate was given is a
        // predicate plus a count, so a pid, name, path or argument appearing here is the
        // decision on #756 being quietly widened by whoever edits the probe next.
        const answer = stdout
          .split("\n")
          .find((line) => line.startsWith("retained-processes-hold:"));
        expect(answer).toMatch(
          /^retained-processes-hold:[a-z][a-z-]{0,46}[a-z]( denied=[1-9][0-9]{0,5})?$/,
        );
      }
      // The predicate is the entire disclosure: no argument, path or probe error escapes.
      expect(stdout).not.toContain("private proc metadata");
      expect(stdout).not.toContain("/proc/");
      expect(stderr).not.toContain("private proc metadata");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });
}

for (const [scenario, admitted] of [
  ["legacy", true],
  ["current", true],
  ["current-library", true],
  ["legacy-library", true],
  ["changed-library", false],
  ["unbound-library", false],
  ["extra-flag", false],
  ["wrong-parent", false],
  ["wrong-cwd", false],
  ["wrong-socket", false],
  ["wrong-id", false],
  ["extra-environment", false],
] as const) {
  test(`retained isolate ${admitted ? "admits" : "holds"} ${scenario}`, async () => {
    const script = `
import { mock } from "bun:test";
const scenario = ${JSON.stringify(scenario)};
const legacy = scenario.startsWith("legacy");
const libraries = ["current-library", "legacy-library", "changed-library"].includes(scenario);
const dir = "/data/plugins/example.counter/" + "a".repeat(64);
const command = ["/usr/local/bin/bun", ...(legacy ? [] : ["--no-install"]), "--smol", dir + "/server.js"];
if (scenario === "extra-flag") command.splice(1, 0, "--preload=/tmp/foreign.js");
const serverEnv = { PATH: "/usr/local/bin", HOME: "/home/hub", ...(libraries ? { LD_LIBRARY_PATH: "/lib/reviewed" } : {}) };
const childEnv = {
  PATH: serverEnv.PATH, HOME: serverEnv.HOME,
  MANIFOLD_PLUGIN_ID: scenario === "wrong-id" ? "example.other" : "example.counter",
  MANIFOLD_PLUGIN_PIPE_FD: "3",
  ...(!legacy && libraries ? { LD_LIBRARY_PATH: serverEnv.LD_LIBRARY_PATH } : {}),
};
if (scenario === "changed-library" || scenario === "unbound-library") childEnv.LD_LIBRARY_PATH = "/lib/foreign";
if (scenario === "extra-environment") childEnv.BUN_OPTIONS = "--preload=/tmp/foreign.js";
const fields = (values) => values.join("\\0") + "\\0";
const environment = (value) => fields(Object.entries(value).map(([key, entry]) => key + "=" + entry));
const stat = (parent) => "1 (bun) " + Array.from({ length: 20 }, (_, index) =>
  index === 0 ? "S" : index === 1 ? parent : index === 17 ? "1" : index === 19 ? "12345" : "0").join(" ");
mock.module("node:fs", () => ({
  readdirSync: () => ["1", "99999999"],
  readFileSync: (path) => {
    if (path === "/proc/1/stat") return stat("0");
    if (path === "/proc/99999999/stat") return stat(scenario === "wrong-parent" ? "77" : "1");
    if (path.endsWith("/status")) return "Uid:\\t0 0 0 0\\nGid:\\t0 0 0 0\\n";
    if (path === "/proc/1/environ") return environment(serverEnv);
    if (path === "/proc/99999999/environ") return environment(childEnv);
    if (path === "/proc/1/cmdline") return fields(["bun", "packages/server/src/main.ts"]);
    if (path === "/proc/99999999/cmdline") return fields(command);
    throw new Error("unexpected process read");
  },
  readlinkSync: (path) => {
    if (path.endsWith("/exe")) return "/usr/local/bin/bun";
    if (path === "/proc/1/cwd") return "/app";
    if (path === "/proc/99999999/cwd") return scenario === "wrong-cwd" ? "/tmp" : dir;
    if (path === "/proc/99999999/fd/3") return scenario === "wrong-socket" ? "/tmp/foreign" : "socket:[42]";
    throw new Error("unexpected process link");
  },
}));
await import(${JSON.stringify(classifier)});
`;
    const directory = mkdtempSync(join(tmpdir(), "manifold-retained-isolate-"));
    try {
      const fixture = join(directory, "classifier.test.ts");
      writeFileSync(fixture, script);
      const child = Bun.spawn([process.execPath, "test", fixture], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(admitted ? 0 : 1);
      expect(stdout.split("\n").filter((line) => line.startsWith("retained-processes-"))).toEqual([
        admitted
          ? "retained-processes-server-only"
          : "retained-processes-hold:unclassified-process",
      ]);
      expect(stderr).not.toContain("unexpected process");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
