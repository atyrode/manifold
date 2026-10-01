import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promotionReplicaBoundary } from "./promotion-replica-admission.ts";

const reason = "replica_guard_boundary_requires_adoption";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  ["0.18.0", "v0.24.0"],
  ["0.21.99", "v0.22.0"],
  ["0.9.0", "v1.0.0"],
])("ordinary %s to %s requires the reviewed historical migration", (build, tag) => {
  const refusal = promotionReplicaBoundary(build, tag, false);
  expect(refusal).toContain(reason);
  expect(refusal).toContain("v0.22.0");
  expect(refusal).toContain("docs/SELF-HOST.md");
  expect(refusal).toContain("Adopting an untracked replica");
  expect(refusal).toContain("--adopt-recovery");
});

test.each([
  ["0.18.0", "v0.21.99"],
  ["0.22.0", "v0.24.0"],
  ["1.0.0", "v1.1.0"],
])("%s to %s does not cross this historical boundary", (build, tag) => {
  expect(promotionReplicaBoundary(build, tag, false)).toBeNull();
});

test("authoritatively classified recovery adoption is the existing boundary exception", () => {
  expect(promotionReplicaBoundary("0.18.0", "v0.24.0", true)).toBeNull();
});

test("a malformed release identity cannot be treated as outside the boundary", () => {
  expect(() => promotionReplicaBoundary("git-deadbeef", "v0.24.0", false)).toThrow();
  expect(() => promotionReplicaBoundary("0.18.0", "v0.22.0-rc.1", true)).toThrow();
});

function cliFixture(build: string) {
  const root = mkdtempSync(join(tmpdir(), "manifold-promotion-boundary-"));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  const calls = join(root, "external-calls");
  const receipt = join(root, "receipt.json");
  writeFileSync(calls, "");
  writeFileSync(
    receipt,
    JSON.stringify({
      format: 1,
      checkpointId: "before-guarded-release",
      objectSha256: "a".repeat(64),
      sourceBuild: build,
    }),
  );
  // Trap the real external-command boundary, rather than mocking the promote module.
  // An accidental provenance/dispatch/provider command records evidence and fails closed.
  const trap = `#!/bin/sh
printf '%s' "\${0##*/}" >> "$PROMOTION_CALL_LOG"
printf '\\t%s' "$@" >> "$PROMOTION_CALL_LOG"
printf '\\n' >> "$PROMOTION_CALL_LOG"
exit 91
`;
  for (const name of ["gh", "clever", "docker"]) {
    writeFileSync(join(bin, name), trap, { mode: 0o700 });
  }
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    PROMOTION_CALL_LOG: calls,
  };
  function run(script: string, args: string[]) {
    const child = Bun.spawnSync([process.execPath, join(import.meta.dir, script), ...args], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: child.exitCode,
      err: child.stderr.toString(),
      calls: readFileSync(calls, "utf8"),
    };
  }
  return {
    promote: (tag: string, flags: string[] = []) =>
      run("promote.ts", [tag, ...flags, "--recovery-receipt", receipt]),
    boundary: (tag: string, adoption: string) =>
      run("promotion-replica-admission.ts", [build, tag, adoption]),
  };
}

test("actual promote preflight refuses a pre-boundary receipt without network, dispatch or switch", () => {
  const result = cliFixture("0.18.0").promote("v0.24.0");
  expect(result.code).toBe(1);
  expect(result.err).toContain(reason);
  expect(result.calls).toBe("");
});

test("the installed-bundle bootstrap exception cannot bypass the replica boundary", () => {
  const result = cliFixture("0.18.0").promote("v0.24.0", ["--bootstrap-gate"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain(reason);
  expect(result.calls).toBe("");
});

test("the first guarded candidate is refused by the actual promote preflight", () => {
  const result = cliFixture("0.21.99").promote("v0.22.0");
  expect(result.code).toBe(1);
  expect(result.err).toContain(reason);
  expect(result.calls).toBe("");
});

test("an incumbent at the boundary continues to release provenance, not historical refusal", () => {
  const result = cliFixture("0.22.0").promote("v0.24.0");
  expect(result.code).not.toBe(0);
  expect(result.err).not.toContain(reason);
  expect(result.calls).toMatch(/^gh\t(?:repo|api)\t/);
});

test.each([
  ["--adopt-recovery"],
  ["--adopt-recovery", "--takeover-writer", "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0"],
])("a requested recovery adoption still requires release provenance and workflow classification %#", (...flags) => {
  const result = cliFixture("0.18.0").promote("v0.24.0", flags);
  expect(result.code).not.toBe(0);
  expect(result.err).not.toContain(reason);
  expect(result.calls).toMatch(/^gh\t(?:repo|api)\t/);
});

test("an ordinary request cannot turn an explicit takeover writer into an adoption", () => {
  const result = cliFixture("0.18.0").promote("v0.24.0", [
    "--takeover-writer",
    "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0",
  ]);
  expect(result.code).toBe(1);
  expect(result.err).not.toContain(reason);
  expect(result.calls).toBe("");
});

test("trusted workflow CLI consumes the classified adoption decision without external commands", () => {
  const fixture = cliFixture("0.18.0");
  const ordinary = fixture.boundary("v0.24.0", "false");
  expect(ordinary.code).toBe(1);
  expect(ordinary.err).toContain(reason);
  expect(ordinary.calls).toBe("");
  const adoption = fixture.boundary("v0.24.0", "true");
  expect(adoption.code).toBe(0);
  expect(adoption.calls).toBe("");
  const unclassified = fixture.boundary("v0.24.0", "--adopt-recovery");
  expect(unclassified.code).toBe(1);
  expect(unclassified.calls).toBe("");
});
