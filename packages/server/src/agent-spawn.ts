import { chmodSync, closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_HOST_SOCKET_ENV } from "@manifold/protocol";
import type { AuthService, MachineEnrollment } from "./auth.ts";
import { ServiceError } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServerStore } from "./stores.ts";

const AGENT_ENTRY_MARKER = "packages/agent/src/main.ts";
const SERVER_ENTRY_MARKER = "packages/server/src/main.ts";
const TERMINAL_HOST_FLAG = "--terminal-host";

/**
 * The local machine is TWO detached processes with two lifetimes (issue #278): the terminal
 * host that owns the PTYs and the transport that dials this server. Each has its own pid
 * file and is reused independently, so a server restart finds both, a transport restart
 * finds the host, and neither is ever this server's child to tear down — `release` drops the
 * boot lock and nothing else. The host is started FIRST and its socket handed to the
 * transport; the transport never spawns a host of its own (agent main.ts).
 */

interface SpawnedAgent {
  readonly pid: number;
  unref(): void;
}

interface AgentSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: "ignore";
  readonly stdout: "ignore";
  readonly stderr: "ignore";
  readonly detached: true;
}

export interface AgentSpawnDeps {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readCmdline(pid: number): string;
  processExists(pid: number): boolean;
  spawn(command: string[], options: AgentSpawnOptions): SpawnedAgent;
}

export interface LocalAgentLease {
  /** The transport's pid (the dialling half). */
  readonly pid: number;
  /** The terminal host's pid (the PTY owner). */
  readonly terminalHostPid: number;
  release(): void;
}

const defaultAgentSpawnDeps: AgentSpawnDeps = {
  platform: process.platform,
  pid: process.pid,
  readCmdline: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8"),
  processExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  spawn: (command, options) => Bun.spawn(command, options),
};

/**
 * A pid file's process, if it is alive AND its cmdline says it is the process the file
 * claims. The host and the transport share an entry and differ by one flag, so the claim
 * names the flag's presence: a host pid file must name a host, a transport file a transport.
 */
function livePid(
  path: string,
  claim: (cmdline: string) => boolean,
  deps: AgentSpawnDeps,
): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0 || !deps.processExists(pid)) return null;
  if (deps.platform !== "linux") {
    // Non-Linux deployments have no procfs cmdline boundary; retain the previous PID-only behavior.
    return pid;
  }
  try {
    return claim(deps.readCmdline(pid)) ? pid : null;
  } catch {
    return null;
  }
}

const isServer = (cmdline: string): boolean => cmdline.includes(SERVER_ENTRY_MARKER);
const isTerminalHost = (cmdline: string): boolean =>
  cmdline.includes(AGENT_ENTRY_MARKER) && cmdline.includes(TERMINAL_HOST_FLAG);
const isTransport = (cmdline: string): boolean =>
  cmdline.includes(AGENT_ENTRY_MARKER) && !cmdline.includes(TERMINAL_HOST_FLAG);

function recordedLockPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Lock paths this process actively holds — distinguishes "we already own it" from a dead prior incarnation that recorded our (reused) pid. */
const heldLockPaths = new Set<string>();

function acquireBootLock(path: string, deps: AgentSpawnDeps): (() => void) | null {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, `${deps.pid}\n`, { encoding: "utf8" });
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
    if (recordedLockPid(path) === deps.pid) {
      // Our own pid on disk. Either this process already holds the lease
      // (double acquisition — still exclusive), or a prior incarnation died
      // uncleanly and the pid namespace was reused (container restart: old
      // pid 1, new pid 1, same server cmdline — livePid cannot tell them
      // apart). Only the in-process ledger distinguishes the two.
      if (heldLockPaths.has(path)) return null;
    } else if (livePid(path, isServer, deps) !== null) {
      return null;
    }
    try {
      unlinkSync(path);
    } catch (unlinkError) {
      if (!(unlinkError instanceof Error) || Reflect.get(unlinkError, "code") !== "ENOENT") {
        throw unlinkError;
      }
    }
    return acquireBootLock(path, deps);
  }

  heldLockPaths.add(path);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    heldLockPaths.delete(path);
    let owner: string;
    try {
      owner = readFileSync(path, "utf8").trim();
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return;
      throw error;
    }
    if (owner === String(deps.pid)) unlinkSync(path);
  };
}

function savedEnrollment(
  tokenPath: string,
  auth: AuthService,
  store: ServerStore,
): MachineEnrollment | null {
  let token: string;
  try {
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  chmodSync(tokenPath, 0o600);
  if (token.length === 0) return null;
  try {
    const authenticated = auth.authenticateMachine(token);
    const machine = store.getMachine(authenticated.id);
    if (machine === null) return null;
    return { machine, machineToken: token };
  } catch (error) {
    if (error instanceof ServiceError) return null;
    throw error;
  }
}

/** Detaches one half of the local machine and records its pid for the next boot's reuse. */
function spawnDetached(
  pidPath: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  deps: AgentSpawnDeps,
): number {
  const child = deps.spawn(["bun", AGENT_ENTRY_MARKER, ...args], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  writeFileSync(pidPath, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(pidPath, 0o600);
  return child.pid;
}

/**
 * Reuses or starts the detached local terminal host and transport, and persists only their
 * respawn handles. Enrolment happens only when a transport must be started: the host holds
 * no token, and a reused transport already holds its own.
 */
export function spawnLocalAgent(
  config: ServerConfig,
  boundPort: number,
  auth: AuthService,
  store: ServerStore,
  logger: Logger,
  deps: AgentSpawnDeps = defaultAgentSpawnDeps,
): LocalAgentLease | null {
  if (!config.spawnAgent) return null;
  const release = acquireBootLock(resolve(config.dataDir, "agent.lock"), deps);
  if (release === null) {
    logger.info("local_agent_spawn_locked");
    return null;
  }

  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[name] = value;
  }
  // The socket lives in a directory the host makes private (0700) on first start.
  const socketPath = resolve(config.dataDir, "terminal-host", "host.sock");

  const hostPidPath = resolve(config.dataDir, "terminal-host.pid");
  let terminalHostPid = livePid(hostPidPath, isTerminalHost, deps);
  if (terminalHostPid !== null) {
    logger.info("local_terminal_host_reused", { pid: terminalHostPid });
  } else {
    terminalHostPid = spawnDetached(
      hostPidPath,
      [TERMINAL_HOST_FLAG],
      { ...inherited, [TERMINAL_HOST_SOCKET_ENV]: socketPath },
      deps,
    );
    logger.info("local_terminal_host_spawned", { pid: terminalHostPid });
  }

  const pidPath = resolve(config.dataDir, "agent.pid");
  const existingPid = livePid(pidPath, isTransport, deps);
  if (existingPid !== null) {
    logger.info("local_agent_reused", { pid: existingPid });
    return { pid: existingPid, terminalHostPid, release };
  }

  const tokenPath = resolve(config.dataDir, "agent.token");
  let enrollment = savedEnrollment(tokenPath, auth, store);
  if (enrollment === null) {
    const existingMachine = store.getMachineByName(config.localMachineName);
    enrollment =
      existingMachine === null
        ? auth.enrollLocalMachine(config.localMachineName)
        : auth.rotateMachineToken(existingMachine);
    writeFileSync(tokenPath, `${enrollment.machineToken}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(tokenPath, 0o600);
  }

  const pid = spawnDetached(
    pidPath,
    [],
    {
      ...inherited,
      MANIFOLD_SERVER_URL: `http://127.0.0.1:${boundPort}`,
      MANIFOLD_MACHINE_TOKEN: enrollment.machineToken,
      MANIFOLD_MACHINE_NAME: config.localMachineName,
      [TERMINAL_HOST_SOCKET_ENV]: socketPath,
    },
    deps,
  );
  logger.info("local_agent_spawned", { machineId: enrollment.machine.id, pid, terminalHostPid });
  return { pid, terminalHostPid, release };
}
