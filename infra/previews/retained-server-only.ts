#!/usr/bin/env bun
// Streamed into the actual incumbent, never installed in /data. No environment,
// credentials, sockets, database or application imports: only public /proc process
// metadata, reduced to one fixed success token. Unknown legacy shapes HOLD.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

const healthSource =
  "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);";
const healthCommand = `bun -e "${healthSource}"`;
const bun = (name: string | undefined): boolean => name === "bun" || name === "/usr/local/bin/bun";
const pluginServer =
  /^\/data\/plugins\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,2})\/([a-f0-9]{64})\/server\.js$/;

function nullFields(path: string): string[] {
  const fields = readFileSync(path, "utf8").split("\0");
  if (fields.pop() !== "") throw new Error();
  return fields;
}

function procFields(pid: string): string[] {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function processIdentity(pid: string): string {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const uid = /^Uid:\s+(\d+\s+\d+\s+\d+\s+\d+)$/m.exec(status)?.[1];
  const gid = /^Gid:\s+(\d+\s+\d+\s+\d+\s+\d+)$/m.exec(status)?.[1];
  if (uid === undefined || gid === undefined) throw new Error();
  return `${uid.trim().replace(/\s+/g, ":")}/${gid.trim().replace(/\s+/g, ":")}`;
}

function processEnvironment(pid: string): Map<string, string> {
  const environment = new Map<string, string>();
  for (const field of nullFields(`/proc/${pid}/environ`)) {
    const separator = field.indexOf("=");
    if (separator <= 0) throw new Error();
    const key = field.slice(0, separator);
    if (environment.has(key)) throw new Error();
    environment.set(key, field.slice(separator + 1));
  }
  return environment;
}

function serverOwnedIsolate(
  pid: string,
  args: string[],
  executable: string,
  serverIdentity: string,
  serverEnvironment: Map<string, string>,
): boolean {
  const matched = pluginServer.exec(args[2] ?? "");
  if (
    matched === null ||
    matched[1]!.length > 64 ||
    args.length !== 3 ||
    args[0] !== "/usr/local/bin/bun" ||
    args[1] !== "--smol" ||
    executable !== "/usr/local/bin/bun"
  )
    return false;
  const dir = args[2]!.slice(0, -"/server.js".length);
  if (
    procFields(pid)[1] !== "1" ||
    readlinkSync(`/proc/${pid}/cwd`) !== dir ||
    processIdentity(pid) !== serverIdentity ||
    !/^socket:\[\d+\]$/.test(readlinkSync(`/proc/${pid}/fd/3`))
  )
    return false;
  const environment = processEnvironment(pid);
  const serverHome = serverEnvironment.get("HOME");
  const expectedKeys = new Set([
    "PATH",
    "MANIFOLD_PLUGIN_ID",
    "MANIFOLD_PLUGIN_PIPE_FD",
    ...(serverHome === undefined ? [] : ["HOME"]),
  ]);
  return (
    environment.size === expectedKeys.size &&
    [...environment.keys()].every((key) => expectedKeys.has(key)) &&
    environment.get("PATH") === (serverEnvironment.get("PATH") ?? "") &&
    environment.get("MANIFOLD_PLUGIN_ID") === matched[1] &&
    environment.get("MANIFOLD_PLUGIN_PIPE_FD") === "3" &&
    environment.get("HOME") === serverHome
  );
}

try {
  const before = readFileSync("/proc/1/stat", "utf8");
  const serverIdentity = processIdentity("1");
  const serverEnvironment = processEnvironment("1");
  const pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  let server = false;
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    // Any disappearing/unreadable process makes the snapshot unknown, not empty.
    const args = nullFields(`/proc/${pid}/cmdline`);
    const executable = readlinkSync(`/proc/${pid}/exe`);
    if (pid === "1") {
      if (
        args.length !== 2 ||
        !bun(args[0]) ||
        args[1] !== "packages/server/src/main.ts" ||
        executable !== "/usr/local/bin/bun" ||
        readlinkSync("/proc/1/cwd") !== "/app"
      )
        throw new Error();
      server = true;
      continue;
    }
    // The stock read-only Docker healthcheck may overlap the snapshot.
    if (
      args.length === 3 &&
      bun(args[0]) &&
      args[1] === "-e" &&
      args[2] === healthSource &&
      executable === "/usr/local/bin/bun"
    )
      continue;
    if (
      args.length === 3 &&
      args[0] === "/bin/sh" &&
      args[1] === "-c" &&
      args[2] === healthCommand &&
      executable === "/usr/bin/dash"
    )
      continue;
    // An installed server plugin is supervised by PID1 and restarts with it. Admit only the
    // loader's complete process fingerprint; an owner, workload, wrapper or lookalike still holds.
    if (serverOwnedIsolate(pid, args, executable, serverIdentity, serverEnvironment)) continue;
    throw new Error();
  }
  // starttime is stable across the probe, unlike CPU counters in /proc/1/stat.
  const starttime = (stat: string): string | undefined =>
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (
    !server ||
    !starttime(before) ||
    starttime(before) !== starttime(readFileSync("/proc/1/stat", "utf8"))
  )
    throw new Error();
  console.log("retained-processes-server-only");
} catch {
  // Never disclose process arguments or filesystem errors (including paths).
  process.exit(1);
}
