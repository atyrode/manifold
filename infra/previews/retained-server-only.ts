#!/usr/bin/env bun
// Streamed into the actual incumbent, never installed in /data. No environment,
// credentials, sockets, database or application imports: only public /proc process
// metadata, reduced to one fixed success token. Unknown legacy shapes HOLD.
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

/**
 * Every refusal this classifier can reach, and the only strings it ever prints. A refusal used
 * to be one bare `Error` and an exit code, so a CI recurrence could be repaired only by
 * re-deriving the branch by elimination (#699). Tokens are literals: no path, argument or
 * environment value is ever interpolated into one.
 */
type Hold =
  | "server-process-shape"
  | "server-process-absent"
  | "server-restarted-during-probe"
  | "zombie-identity-unconfirmed"
  | "unclassified-process"
  | "process-unreadable"
  | "pid-reused-during-probe"
  | "proc-field-shape";

class Held extends Error {
  constructor(readonly predicate: Hold) {
    super(predicate);
  }
}

function hold(predicate: Hold): never {
  throw new Held(predicate);
}

const healthSource =
  "const r = await fetch('http://127.0.0.1:7777/healthz'); if (!r.ok) process.exit(1);";
const healthCommand = `bun -e "${healthSource}"`;
const bun = (name: string | undefined): boolean => name === "bun" || name === "/usr/local/bin/bun";

function bunHealthcheckArgs(args: string[]): boolean {
  return args.length === 3 && bun(args[0]) && args[1] === "-e" && args[2] === healthSource;
}

function shellHealthcheckArgs(args: string[]): boolean {
  return (
    args.length === 3 && args[0] === "/bin/sh" && args[1] === "-c" && args[2] === healthCommand
  );
}

function stockHealthcheck(args: string[], executable: string): boolean {
  return (
    (bunHealthcheckArgs(args) && executable === "/usr/local/bin/bun") ||
    (shellHealthcheckArgs(args) && executable === "/usr/bin/dash")
  );
}

function healthcheckExecTransition(args: string[], executable: string): boolean {
  return shellHealthcheckArgs(args) && executable === "/usr/local/bin/bun";
}

function confirmedHealthcheck(pid: string, initialStarttime: string | undefined): boolean {
  const stat = procFields(pid);
  const args = nullFields(`/proc/${pid}/cmdline`);
  const executable = readlinkSync(`/proc/${pid}/exe`);
  return (
    initialStarttime !== undefined &&
    stat[19] === initialStarttime &&
    stockHealthcheck(args, executable)
  );
}
const pluginServer =
  /^\/data\/plugins\/([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,2})\/([a-f0-9]{64})\/server\.js$/;

function nullFields(path: string): string[] {
  const fields = readFileSync(path, "utf8").split("\0");
  if (fields.pop() !== "") hold("proc-field-shape");
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
  if (uid === undefined || gid === undefined) hold("proc-field-shape");
  return `${uid.trim().replace(/\s+/g, ":")}/${gid.trim().replace(/\s+/g, ":")}`;
}

function processEnvironment(pid: string): Map<string, string> {
  const environment = new Map<string, string>();
  for (const field of nullFields(`/proc/${pid}/environ`)) {
    const separator = field.indexOf("=");
    if (separator <= 0) hold("proc-field-shape");
    const key = field.slice(0, separator);
    if (environment.has(key)) hold("proc-field-shape");
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
    let stat: string[] | undefined;
    try {
      stat = procFields(pid);
      if (pid !== "1" && stat[0] === "Z") {
        // A lone zombie owns no live work. A zombie group leader with other threads may.
        // Confirm the same terminal identity; a reaped-and-reused PID still holds.
        const confirmed = procFields(pid);
        if (
          stat[17] !== "1" ||
          confirmed[0] !== "Z" ||
          confirmed[17] !== "1" ||
          !stat[19] ||
          confirmed[19] !== stat[19]
        )
          hold("zombie-identity-unconfirmed");
        continue;
      }
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
          hold("server-process-shape");
        server = true;
        continue;
      }
      // The stock read-only Docker healthcheck may overlap the snapshot. Its shell
      // execs Bun, so cmdline and exe can briefly describe different sides of that
      // transition. Confirm once, including stable PID identity, before refusing it.
      if (
        stockHealthcheck(args, executable) ||
        (healthcheckExecTransition(args, executable) && confirmedHealthcheck(pid, stat[19]))
      )
        continue;
      // An installed server plugin is supervised by PID1 and restarts with it. Admit only the
      // loader's complete process fingerprint; an owner, workload, wrapper or lookalike still holds.
      if (serverOwnedIsolate(pid, args, executable, serverIdentity, serverEnvironment)) continue;
      hold("unclassified-process");
    } catch (error) {
      // A healthcheck or isolate can exit between listing /proc and reading its fingerprint.
      // Two unrelated facts arrive as the same ENOENT, and `starttime` is what separates them:
      // a reused PID cannot carry the start time this probe already read, so the same start
      // time is still the process that was classified — now exiting — while a different one is
      // a live occupant this probe never examined. Refusing both is what made a permitted
      // rollback fail on a process that had already finished (#699).
      if (error instanceof Held) throw error;
      if (Reflect.get(error as object, "code") !== "ENOENT") hold("process-unreadable");
      let after: string[];
      try {
        after = procFields(pid);
      } catch (absence) {
        // Proven gone: no work remains that replacement could destroy.
        if (Reflect.get(absence as object, "code") === "ENOENT") continue;
        hold("process-unreadable");
      }
      if (!stat?.[19] || after[19] !== stat[19]) hold("pid-reused-during-probe");
      // The kernel has reaped it to a single-threaded zombie: no address space, no
      // descriptors, no CPU. A live process whose fingerprint stayed unreadable holds.
      if (after[0] !== "Z" || after[17] !== "1") hold("process-unreadable");
    }
  }
  // starttime is stable across the probe, unlike CPU counters in /proc/1/stat.
  const starttime = (stat: string): string | undefined =>
    stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  if (!server) hold("server-process-absent");
  if (!starttime(before) || starttime(before) !== starttime(readFileSync("/proc/1/stat", "utf8")))
    hold("server-restarted-during-probe");
  console.log("retained-processes-server-only");
} catch (error) {
  // The predicate that refused, and nothing else: process arguments, environment values and
  // filesystem errors (including paths) never leave the container. Without it a recurrence in
  // CI could only be diagnosed by elimination, which is what #699 was opened to end.
  console.log(
    `retained-processes-hold:${error instanceof Held ? error.predicate : "classifier-fault"}`,
  );
  process.exit(1);
}
