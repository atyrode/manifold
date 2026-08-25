import { chmodSync, closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthService, MachineEnrollment } from "./auth.ts";
import { ServiceError } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServerStore } from "./stores.ts";

const AGENT_ENTRY_MARKER = "packages/agent/src/main.ts";
const SERVER_ENTRY_MARKER = "packages/server/src/main.ts";

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
  readonly pid: number;
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

function livePid(path: string, marker: string, deps: AgentSpawnDeps): number | null {
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
    return deps.readCmdline(pid).includes(marker) ? pid : null;
  } catch {
    return null;
  }
}

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
    } else if (livePid(path, SERVER_ENTRY_MARKER, deps) !== null) {
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

/** Reuses or enrolls the detached local PTY agent and persists only its respawn handles. */
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
  const pidPath = resolve(config.dataDir, "agent.pid");
  const existingPid = livePid(pidPath, AGENT_ENTRY_MARKER, deps);
  if (existingPid !== null) {
    logger.info("local_agent_reused", { pid: existingPid });
    return { pid: existingPid, release };
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

  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  environment.MANIFOLD_SERVER_URL = `http://127.0.0.1:${boundPort}`;
  environment.MANIFOLD_MACHINE_TOKEN = enrollment.machineToken;
  environment.MANIFOLD_MACHINE_NAME = config.localMachineName;

  const child = deps.spawn(["bun", AGENT_ENTRY_MARKER], {
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
  logger.info("local_agent_spawned", { machineId: enrollment.machine.id, pid: child.pid });
  return { pid: child.pid, release };
}
