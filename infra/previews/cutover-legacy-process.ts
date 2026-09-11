#!/usr/bin/env bun
// Single-use #469 adapter. Streamed as the existing root/application UID, never
// installed in /data. No private-file/environment reads or numeric-PID signals.
import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
} from "node:fs";
import { z } from "zod";

const artifactPath = z.string().regex(/^\/nix\/store\/[a-z0-9]{32}-[^/]+\/bin\/[^/]+$/);
const artifact = z.object({
  path: artifactPath,
  realPath: artifactPath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const runtime = z.object({
  tini: artifact,
  bash: artifact,
  nixDaemon: artifact,
  bun: artifact,
  sleep: artifact,
  entrypoint: artifact,
});
const reference = z.object({
  pid: z.number().int().positive(),
  startTime: z.number().int().positive(),
  role: z.enum(["init", "supervisor", "daemon", "server", "owner", "transport"]),
  executable: artifact.shape.path,
  sha256: artifact.shape.sha256,
  parent: z.number().int().nonnegative(),
  uid: z.union([z.literal(0), z.literal(1000)]),
  group: z.number().int().positive(),
  session: z.number().int().positive(),
  argv: z.array(z.string()).optional(),
});
const requestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("source"),
    sources: z.record(z.string(), artifact.shape.sha256),
    runtime,
  }),
  z.object({
    mode: z.literal("inventory"),
    references: z.array(reference).min(4).max(6),
    runtime,
    supervisorPid: z.number().int().positive(),
  }),
  z.object({ mode: z.literal("probe"), references: z.array(reference).min(1).max(3) }),
  z.object({ mode: z.literal("signal"), references: z.array(reference).length(1) }),
]);

const healthSource =
  "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);";
const hashBuffer = Buffer.allocUnsafe(64 * 1024);
const hash = (path: string): string => {
  const descriptor = openSync(path, "r");
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    let length: number;
    while ((length = readSync(descriptor, hashBuffer, 0, hashBuffer.length, null)) !== 0)
      hasher.update(hashBuffer.subarray(0, length));
    return hasher.digest("hex");
  } finally {
    closeSync(descriptor);
  }
};
const check = (condition: unknown): void => {
  if (!condition) throw new Error();
};
const fields = (pid: number): string[] => {
  const value = readFileSync(`/proc/${pid}/stat`, "utf8");
  return value.slice(value.lastIndexOf(")") + 2).split(" ");
};
const argv = (pid: number): string[] => {
  const value = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
  check(value.pop() === "");
  return value;
};

try {
  check(process.platform === "linux");
  const request = requestSchema.parse(JSON.parse(process.argv.slice(2).join("")));
  if (request.mode === "source") {
    check(process.getuid?.() === 1000);
    // Existence only: do not open dotenv or user Bun configuration.
    for (const directory of ["/app", "/home/developer"])
      check(
        !readdirSync(directory).some((name) => name.startsWith(".env") || name === ".bunfig.toml"),
      );
    check(!existsSync("/bunfig.toml") && !existsSync("/.bunfig.toml"));
    for (const [path, sha256] of Object.entries(request.sources)) {
      check(
        path.startsWith("/app/") &&
          !path.split("/").includes("..") &&
          /^[a-f0-9]{64}$/.test(String(sha256)),
      );
      check(lstatSync(path).isFile() && hash(path) === sha256);
    }
    check(!existsSync("/app/bunfig.toml") || Object.hasOwn(request.sources, "/app/bunfig.toml"));
    for (const reference of Object.values(request.runtime))
      check(hash(reference.path) === reference.sha256);
  } else if (request.mode === "inventory") {
    const references = request.references;
    check(process.getuid?.() === 0 && Array.isArray(references));
    check(readFileSync("/sys/fs/cgroup/cgroup.type", "utf8").trim() === "domain");
    check(
      !readdirSync("/sys/fs/cgroup").some((name) =>
        lstatSync(`/sys/fs/cgroup/${name}`).isDirectory(),
      ),
    );
    // Root's loader settings are checked only for existence, not read or exported.
    check(!existsSync("/root/.bunfig.toml") && !existsSync("/root/bunfig.toml"));
    const expected = new Map(references.map((reference) => [reference.pid, reference]));
    const found = new Set<number>();
    const pids = readdirSync("/proc")
      .filter((name) => /^[0-9]+$/.test(name))
      .sort((a, b) => Number(expected.has(Number(a))) - Number(expected.has(Number(b))));
    for (const name of pids) {
      const pid = Number(name);
      if (pid === process.pid) continue;
      const state = fields(pid);
      const args = argv(pid);
      check(readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() === "0::/");
      const reference = expected.get(pid);
      if (reference) {
        check(
          state[19] === String(reference.startTime) &&
            !["Z", "X"].includes(state[0]!) &&
            Number(state[1]) === reference.parent &&
            Number(state[2]) === reference.group &&
            Number(state[3]) === reference.session,
        );
        const uid = readFileSync(`/proc/${pid}/status`, "utf8")
          .split("\n")
          .find((line) => line.startsWith("Uid:"))
          ?.trim()
          .split(/\s+/)
          .slice(1);
        check(uid?.length === 4 && uid.every((value) => value === String(reference.uid)));
        if (reference.uid === 0) {
          check(
            JSON.stringify(args) === JSON.stringify(reference.argv) &&
              readlinkSync(`/proc/${pid}/exe`) === reference.executable &&
              hash(`/proc/${pid}/exe`) === reference.sha256 &&
              readlinkSync(`/proc/${pid}/cwd`) === (reference.role === "daemon" ? "/" : "/app"),
          );
        }
        found.add(pid);
        continue;
      }
      // Only the exact inherited supervisor's read-only polling child and the
      // stock healthcheck Bun are transient. An unproved health shell also holds.
      const executable = readlinkSync(`/proc/${pid}/exe`);
      const sleeper =
        Number(state[1]) === request.supervisorPid &&
        JSON.stringify(args) === JSON.stringify([request.runtime.sleep.path, "0.1"]) &&
        executable === request.runtime.sleep.realPath;
      const health =
        JSON.stringify(args) === JSON.stringify(["bun", "-e", healthSource]) &&
        executable === request.runtime.bun.realPath;
      check(sleeper || health);
      check(
        hash(`/proc/${pid}/exe`) ===
          (sleeper ? request.runtime.sleep.sha256 : request.runtime.bun.sha256),
      );
    }
    check(found.size === expected.size);
  } else {
    const references = request.references;
    check(
      process.getuid?.() === 1000 &&
        Array.isArray(references) &&
        references.length >= 1 &&
        references.length <= 3,
    );
    // libc wrappers avoid architecture-specific syscall numbers. Missing symbols
    // or unsupported pidfds refuse; never fall back to process.kill/kill(2).
    const libc = dlopen("libc.so.6", {
      pidfd_open: { args: [FFIType.i32, FFIType.u32], returns: FFIType.i32 },
      pidfd_send_signal: {
        args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const handles: number[] = [];
    try {
      for (const reference of references) {
        check(
          Number.isSafeInteger(reference.pid) &&
            reference.pid >= 2 &&
            Number.isSafeInteger(reference.startTime) &&
            reference.startTime > 0 &&
            typeof reference.executable === "string" &&
            reference.executable.startsWith("/nix/store/") &&
            /^[a-f0-9]{64}$/.test(reference.sha256) &&
            ["owner", "transport", "server"].includes(reference.role),
        );
        const fd = libc.symbols.pidfd_open(reference.pid, 0);
        check(fd >= 0);
        handles.push(fd);
        const state = fields(reference.pid);
        check(state[19] === String(reference.startTime) && !["Z", "X"].includes(state[0]!));
        check(
          Number(state[1]) === reference.parent &&
            Number(state[2]) === reference.group &&
            Number(state[3]) === reference.session &&
            readFileSync(`/proc/${reference.pid}/cgroup`, "utf8").trim() === "0::/",
        );
        if (reference.role === "owner")
          check(
            lstatSync("/data/terminal-host").isDirectory() &&
              lstatSync("/data/terminal-host/host.sock").isSocket(),
          );
        const args = argv(reference.pid);
        const suffix =
          reference.role === "server"
            ? ["packages/server/src/main.ts"]
            : [
                "packages/agent/src/main.ts",
                ...(reference.role === "owner" ? ["--terminal-host"] : []),
              ];
        check(
          ["bun", reference.executable].includes(args[0]!) &&
            JSON.stringify(args.slice(1)) === JSON.stringify(suffix) &&
            readlinkSync(`/proc/${reference.pid}/exe`) === reference.executable &&
            readlinkSync(`/proc/${reference.pid}/cwd`) === "/app" &&
            hash(`/proc/${reference.pid}/exe`) === reference.sha256,
        );
      }
      if (request.mode === "signal") {
        check(references.length === 1 && ["transport", "server"].includes(references[0].role));
        check(libc.symbols.pidfd_send_signal(handles[0]!, 15, null, 0) === 0);
      } else check(request.mode === "probe");
    } finally {
      for (const fd of handles) libc.symbols.close(fd);
      libc.close();
    }
  }
  console.log("legacy-process-generation-verified");
} catch {
  // No arguments, paths, source, credentials, or loader diagnostics leave the adapter.
  process.exitCode = 1;
}
