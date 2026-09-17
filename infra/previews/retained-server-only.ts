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
  | `fingerprint-unreadable-${ReadFault}`
  | `exit-unconfirmable-${ReadFault}`
  | "exit-unproven"
  | "pid-reused-during-probe"
  | "proc-field-shape";

/**
 * Which way a /proc read failed, carried in the token. `process-unreadable` used to answer for
 * every failure at three different sites, so the one CI recurrence that reached it could not say
 * whether the probe had been denied a look, told the task was gone, or handed something else
 * entirely — and those want different repairs (#738).
 */
type ReadFault = "denied" | "vanished" | "unmapped";

class Held extends Error {
  constructor(readonly predicate: Hold) {
    super(predicate);
  }
}

function hold(predicate: Hold): never {
  throw new Held(predicate);
}

/**
 * A thrown value carrying no errno is not a raced /proc read at all, it is a fault in this
 * classifier; answering `process-unreadable` for one hid a bug behind a refusal that looked
 * legitimate. Rethrowing reaches the outer `classifier-fault`, which still fails closed.
 */
function errno(error: unknown): string {
  const code = Reflect.get(error as object, "code");
  if (typeof code !== "string") throw error;
  return code;
}

function readFault(code: string): ReadFault {
  if (code === "EACCES" || code === "EPERM") return "denied";
  if (code === "ESRCH") return "vanished";
  return "unmapped";
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

/**
 * Whether a thread group finished exiting, which is the only question a fingerprint that read
 * ENOENT or a zombie group leader actually leaves open. A multi-threaded process releases its
 * address space before it is reaped, so `cmdline` and `exe` vanish while `/proc/<pid>` and even
 * the RUNNING state remain: a real `bun -e` healthcheck spends a measured 0.3-2ms per exit in
 * exactly those states, on every exit it performs. Refusing them outright is what failed a
 * permitted rollback on unrelated PRs while this classifier reported one word for four facts
 * (#738), and it is the same mistake #699
 * fixed for a single-threaded process that exits mid-probe — only spread across threads, so
 * only time separates a group that is finishing from a sibling thread that will outlive its
 * leader. Admission is never granted because time passed, only when the terminal
 * single-threaded zombie or the empty PID is OBSERVED under an unchanged start time.
 */
type Exit = "finished" | "unfinished" | "replaced";

// 250x the 2ms this transition was measured to take, because a loaded CI runner starves the
// very threads being waited on, and the wait is only ever paid on a path that would otherwise
// refuse. Nothing is admitted for elapsing: the deadline only bounds how long the probe will
// keep watching before it refuses.
const exitDeadlineMs = 500;
const exitStepMs = 5;

function observedExit(pid: string, starttime: string | undefined): Exit {
  const deadline = Date.now() + exitDeadlineMs;
  for (;;) {
    let stat: string[];
    try {
      stat = procFields(pid);
    } catch (error) {
      // Proven gone: no work remains that replacement could destroy.
      const code = errno(error);
      if (code === "ENOENT") return "finished";
      hold(`exit-unconfirmable-${readFault(code)}`);
    }
    // A reaped-and-reused PID cannot carry the start time this probe already read, so a
    // different one — or an identity this probe never managed to establish — is a live
    // occupant it never examined, not the exit it was watching.
    if (starttime === undefined || stat[19] !== starttime) return "replaced";
    if (stat[0] === "Z" && stat[17] === "1") return "finished";
    if (Date.now() >= deadline) return "unfinished";
    Bun.sleepSync(exitStepMs);
  }
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
        // A lone zombie owns no live work, but it must still be the SAME dead process a moment
        // later: a reaped-and-reused PID holds. A zombie group leader whose siblings are still
        // running is not answerable either way yet, so it is watched rather than refused (#738).
        const exit = observedExit(pid, stat[19]);
        if (exit === "replaced") hold("zombie-identity-unconfirmed");
        if (exit === "unfinished") hold("exit-unproven");
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
      // A healthcheck or isolate can exit between listing /proc and reading its fingerprint,
      // and an exiting multi-threaded process drops `cmdline` and `exe` BEFORE it stops being
      // listed or even stops running, so an ENOENT here says nothing about whether work
      // remains. Two unrelated facts arrive as the same ENOENT, and `starttime` is what
      // separates them: a reused PID cannot carry the start time this probe already read, so
      // the same start time is still the process that was classified — now exiting — while a
      // different one is a live occupant this probe never examined. Refusing both is what made
      // a permitted rollback fail on a process that had already finished (#699), and refusing
      // the unfinished half is what failed three consecutive unrelated PRs (#738).
      if (error instanceof Held) throw error;
      const code = errno(error);
      if (code !== "ENOENT") hold(`fingerprint-unreadable-${readFault(code)}`);
      const exit = observedExit(pid, stat?.[19]);
      if (exit === "replaced") hold("pid-reused-during-probe");
      if (exit === "unfinished") hold("exit-unproven");
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
