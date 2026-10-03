import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/*
  Stand-in tools control manager outcomes at the real shell wrapper boundary, not the native
  proof behind it. Exit status and the real temporary root establish its cleanup transitions.
*/
const script = resolve(import.meta.dir, "verify-runtime.sh");
const directory = mkdtempSync(join(tmpdir(), "manifold-verify-runtime-"));
const bin = join(directory, "bin");
const record = join(directory, "unit.home");
const stopped = join(directory, "systemctl.stopped");
mkdirSync(bin);
const tools: Record<string, string> = {
  cc: 'while [ $# -gt 0 ]; do if [ "$1" = -o ]; then : >"$2"; fi; shift; done',
  readelf: "exit 0",
  busybox: "exit 0",
  bwrap: "printf '  %s FD\\n' --bind-fd --ro-bind-fd --seccomp --block-fd --info-fd",
  "systemd-run": `: >"$VERIFY_RUNTIME_RECORD"
for argument in "$@"; do
  case "$argument" in HOME=*) printf '%s' "$argument" >"$VERIFY_RUNTIME_RECORD" ;; esac
done
exit "$VERIFY_RUNTIME_WORKLOAD_STATUS"`,
  systemctl: `case " $* " in
  *" show "*)
    state=$VERIFY_RUNTIME_INITIAL_STATE
    if [ -e "$VERIFY_RUNTIME_STOPPED" ]; then state=$VERIFY_RUNTIME_AFTER_STATE; fi
    case "$state" in
      error) exit 1 ;;
      empty) printf '\\n' ;;
      *) printf '%s\\n' "$state" ;;
    esac ;;
  *" stop "*) : >"$VERIFY_RUNTIME_STOPPED"; exit "$VERIFY_RUNTIME_STOP_STATUS" ;;
  *) exit 1 ;;
esac`,
  rm: `if [ "$VERIFY_RUNTIME_REMOVE_FAILURE" = 1 ]; then exit 1; fi
exec "$VERIFY_RUNTIME_REAL_RM" "$@"`,
};
for (const [name, body] of Object.entries(tools)) {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

type QueryState = "not-found" | "loaded" | "empty" | "error";
interface CleanupScenario {
  initialState?: QueryState;
  afterStop?: QueryState;
  stopStatus?: number;
  workloadStatus?: number;
  removalFails?: boolean;
}

function browserWrapper(identity: Record<string, string>, cleanup: CleanupScenario = {}) {
  rmSync(record, { force: true });
  rmSync(stopped, { force: true });
  const realRm = Bun.which("rm");
  if (!realRm) throw new Error("runtime wrapper fixture requires rm");
  const result = Bun.spawnSync(["bash", script, "browser"], {
    env: {
      PATH: `${bin}:${process.env["PATH"] ?? ""}`,
      HOME: directory,
      BUN: process.execPath,
      CC: join(bin, "cc"),
      MANIFOLD_TEST_BWRAP: join(bin, "bwrap"),
      MANIFOLD_TEST_STATIC_BUSYBOX: join(bin, "busybox"),
      VERIFY_RUNTIME_RECORD: record,
      VERIFY_RUNTIME_STOPPED: stopped,
      VERIFY_RUNTIME_INITIAL_STATE: cleanup.initialState ?? "not-found",
      VERIFY_RUNTIME_AFTER_STATE: cleanup.afterStop ?? "not-found",
      VERIFY_RUNTIME_STOP_STATUS: String(cleanup.stopStatus ?? 0),
      VERIFY_RUNTIME_WORKLOAD_STATUS: String(cleanup.workloadStatus ?? 0),
      VERIFY_RUNTIME_REMOVE_FAILURE: cleanup.removalFails ? "1" : "0",
      VERIFY_RUNTIME_REAL_RM: realRm,
      ...identity,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const unitStarted = existsSync(record);
  const home = unitStarted ? readFileSync(record, "utf8").slice(5) : null;
  const root = home ? resolve(home, "..") : null;
  if (root && !root.startsWith("/tmp/manifold-jobs-browser."))
    throw new Error("runtime wrapper fixture received an unexpected root");
  try {
    return {
      code: result.exitCode,
      unitStarted,
      rootRemoved: root === null ? null : !existsSync(root),
    };
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

const stamped = {
  MANIFOLD_VERSION: "0.25.1",
  MANIFOLD_BUILD: "0.25.1+1.g637f8b7",
  MANIFOLD_CHANNEL: "development",
};

// The wrapper itself refuses non-Linux hosts and root before it reads any identity, so its
// argv can only be observed where it can run; the real Linux runtime jobs in CI stay mandatory.
const wrapperHost = process.platform === "linux" && process.getuid?.() !== 0;

describe.skipIf(!wrapperHost)("runtime proof wrapper", () => {
  test("refuses a malformed identity before starting any unit", () => {
    for (const identity of [
      { MANIFOLD_BUILD: "0.25.1 --uid=0" },
      { MANIFOLD_VERSION: "-0.25.1" },
      { MANIFOLD_CHANNEL: "nightly" },
    ] as const) {
      const refused = browserWrapper({ ...stamped, ...identity });
      expect(refused.code).toBe(1);
      expect(refused.unitStarted).toBe(false);
    }
  });

  test("collection between inspection and stop preserves successful proof", () => {
    const result = browserWrapper(stamped, {
      initialState: "loaded",
      afterStop: "not-found",
      stopStatus: 1,
    });
    expect({ code: result.code, rootRemoved: result.rootRemoved }).toEqual({
      code: 0,
      rootRemoved: true,
    });
  });

  test("a failed stop without positive absence cannot certify retirement", () => {
    for (const afterStop of ["loaded", "empty", "error"] as const) {
      const result = browserWrapper(stamped, { initialState: "loaded", afterStop, stopStatus: 1 });
      expect({ code: result.code, rootRemoved: result.rootRemoved }).toEqual({
        code: 1,
        rootRemoved: true,
      });
    }
  });

  test("a failed initial inspection cannot certify retirement", () => {
    const result = browserWrapper(stamped, { initialState: "error" });
    expect({ code: result.code, rootRemoved: result.rootRemoved }).toEqual({
      code: 1,
      rootRemoved: true,
    });
  });

  test("confirmed collection does not hide the proof's failure", () => {
    const result = browserWrapper(stamped, {
      initialState: "loaded",
      afterStop: "not-found",
      stopStatus: 1,
      workloadStatus: 37,
    });
    expect({ code: result.code, rootRemoved: result.rootRemoved }).toEqual({
      code: 37,
      rootRemoved: true,
    });
  });

  test("failure to remove the owned root cannot certify cleanup", () => {
    const result = browserWrapper(stamped, { removalFails: true });
    expect({ code: result.code, rootRemoved: result.rootRemoved }).toEqual({
      code: 1,
      rootRemoved: false,
    });
  });
});
