import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
  The wrapper's boundary, not the proof behind it: stand-in tools let it run up to the delegated
  unit it would start, and the recorded `systemd-run` argv is exactly what enters its `env -i`.
*/
const script = resolve(import.meta.dir, "verify-runtime.sh");
const directory = mkdtempSync(join(tmpdir(), "manifold-verify-runtime-"));
const bin = join(directory, "bin");
const record = join(directory, "systemd-run.argv");
mkdirSync(bin);
const tools: Record<string, string> = {
  cc: 'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then : >"$2"; fi; shift; done',
  readelf: "exit 0",
  busybox: "exit 0",
  bwrap: "printf '  %s FD\\n' --bind-fd --ro-bind-fd --seccomp --block-fd --info-fd",
  "systemd-run": `printf '%s\\0' "$@" >${JSON.stringify(record)}`,
  systemctl: "echo not-found",
};
for (const [name, body] of Object.entries(tools)) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function browserWrapper(identity: Record<string, string>) {
  rmSync(record, { force: true });
  const result = Bun.spawnSync(["bash", script, "browser"], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: directory,
      BUN: process.execPath,
      CC: join(bin, "cc"),
      MANIFOLD_TEST_BWRAP: join(bin, "bwrap"),
      MANIFOLD_TEST_STATIC_BUSYBOX: join(bin, "busybox"),
      MANIFOLD_OWNER_KEY: "a451".repeat(16),
      ...identity,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const argv = existsSync(record) ? readFileSync(record, "utf8").split("\0") : null;
  return { code: result.exitCode, stderr: result.stderr.toString(), argv };
}

const stamped = {
  MANIFOLD_VERSION: "0.25.1",
  MANIFOLD_BUILD: "0.25.1+1.g637f8b7",
  MANIFOLD_CHANNEL: "development",
};
const identityOf = (argv: readonly string[] | null): string[] =>
  (argv ?? []).filter((argument) => /^MANIFOLD_(?:VERSION|BUILD|CHANNEL)=/.test(argument));

// The wrapper itself refuses non-Linux hosts and root before it reads any identity, so its
// argv can only be observed where it can run; the real Linux runtime jobs in CI stay mandatory.
const wrapperHost = process.platform === "linux" && process.getuid?.() !== 0;

describe.skipIf(!wrapperHost)("runtime proof wrapper", () => {
  test("the browser proof serves the dist under the identity the caller stamped on it", () => {
    // #920: a proof re-deriving its identity from git could name a tag pushed mid-run instead.
    const browser = browserWrapper(stamped);
    expect(browser.code).toBe(0);
    expect(identityOf(browser.argv).sort()).toEqual(
      Object.entries(stamped)
        .map(([key, value]) => `${key}=${value}`)
        .sort(),
    );
    expect(browser.argv?.some((argument) => argument.startsWith("MANIFOLD_OWNER_KEY="))).toBe(
      false,
    );

    const unstamped = browserWrapper({});
    expect(unstamped.code).toBe(0);
    expect(identityOf(unstamped.argv)).toEqual([]);
  });

  test("refuses a malformed identity before starting any unit", () => {
    for (const [identity, reason] of [
      [{ MANIFOLD_BUILD: "0.25.1 --uid=0" }, "MANIFOLD_BUILD must be an inert build identity"],
      [{ MANIFOLD_VERSION: "-0.25.1" }, "MANIFOLD_VERSION must be an inert build identity"],
      [{ MANIFOLD_CHANNEL: "nightly" }, "MANIFOLD_CHANNEL must be release or development"],
    ] as const) {
      const refused = browserWrapper({ ...stamped, ...identity });
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(reason);
      expect(refused.argv).toBeNull();
    }
  });
});
