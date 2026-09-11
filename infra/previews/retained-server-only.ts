#!/usr/bin/env bun
// Streamed into the actual incumbent, never installed in /data. No environment,
// credentials, sockets, database or application imports: only public /proc process
// metadata, reduced to one fixed success token. Unknown legacy shapes HOLD.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

const healthSource =
  "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);";
const healthCommand = `bun -e "${healthSource}"`;
const bun = (name: string | undefined): boolean => name === "bun" || name === "/usr/local/bin/bun";

try {
  const before = readFileSync("/proc/1/stat", "utf8");
  const pids = readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name));
  let server = false;
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    // Any disappearing/unreadable process makes the snapshot unknown, not empty.
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (args.pop() !== "") throw new Error();
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
    // The stock read-only Docker healthcheck may overlap the snapshot. No other
    // child, agent, terminal host, workload, wrapper or helper is a supported hub.
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
