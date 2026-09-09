import { chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TERMINAL_HOST_SOCKET_ENV } from "@manifold/protocol";
import type { AuthService, MachineEnrollment } from "./auth.ts";
import { ServiceError } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServerStore } from "./stores.ts";
import {
  configureLocalJobOwner,
  loadLocalJobOwnerTemplate,
  readPrivateLocalFile,
  writePrivateLocalFile,
} from "./local-job-owner-config.ts";

const AGENT_ENTRY_MARKER = "packages/agent/src/main.ts";
const SERVER_ENTRY_MARKER = "packages/server/src/main.ts";
const TERMINAL_HOST_FLAG = "--terminal-host";

/**
 * The local machine is TWO detached processes with two lifetimes (issue #278): the terminal
 * host that owns the PTYs and the transport that dials this server. Each has its own pid
 * file and is reused independently, so a server restart finds both, a transport restart
 * finds the host. `release` drops the boot lock and nothing else. Detachment is only a
 * process-lifetime guarantee, NOT escape from a service cgroup. Packaged deployments use
 * external preparation and independent service units rather than detached children.
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
  privateFile = false,
): number | null {
  let raw: string;
  try {
    const contents = privateFile ? readPrivateLocalFile(path) : readFileSync(path, "utf8");
    if (contents === null) return null;
    raw = contents.trim();
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

const isServer = (cmdline: string): boolean =>
  cmdline.includes(SERVER_ENTRY_MARKER) ||
  cmdline.split("\0").some((arg) => /\/(?:\.?manifold-server(?:-wrapped)?)$/.test(arg));
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
  privateFile = false,
): MachineEnrollment | null {
  let token: string;
  try {
    const contents = privateFile ? readPrivateLocalFile(tokenPath) : readFileSync(tokenPath, "utf8");
    if (contents === null) return null;
    token = contents.trim();
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  if (!privateFile) chmodSync(tokenPath, 0o600);
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
  privateFile = false,
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
  if (privateFile) {
    writePrivateLocalFile(pidPath, `${child.pid}\n`);
  } else {
    writeFileSync(pidPath, `${child.pid}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(pidPath, 0o600);
  }
  return child.pid;
}

/**
 * Reuses or starts the detached local terminal host and transport, and persists only their
 * respawn handles. Native bootstrap binds authenticated enrollment before starting either half;
 * the terminal host receives only public owner configuration, never the machine token.
 */
export function spawnLocalAgent(
  config: ServerConfig,
  boundPort: number,
  auth: AuthService,
  store: ServerStore,
  logger: Logger,
  deps: AgentSpawnDeps = defaultAgentSpawnDeps,
  nativeOwner?: { admissionPublicKey: string },
): LocalAgentLease | null {
  if (!config.spawnAgent) return null;
  const templatePath = config.localJobOwnerTemplate;
  if (templatePath !== undefined && (deps.platform !== "linux" || nativeOwner === undefined))
    throw new Error("local_job_owner_requires_linux_and_admission_key");
  const external = config.localAgentSupervision === "external";
  if (external && templatePath === undefined)
    throw new Error("external_local_supervision_requires_native_template");
  const template = templatePath === undefined
    ? undefined
    : loadLocalJobOwnerTemplate(config.dataDir, templatePath, nativeOwner!.admissionPublicKey);
  const release = acquireBootLock(resolve(config.dataDir, "agent.lock"), deps);
  if (release === null) {
    logger.info("local_agent_spawn_locked");
    return null;
  }

  try {
    const hostPidPath = resolve(config.dataDir, "terminal-host.pid");
    const pidPath = resolve(config.dataDir, "agent.pid");
    const tokenPath = resolve(config.dataDir, "agent.token");
    const ownerConfigPath = resolve(config.dataDir, "job-owner", "config.json");
    let terminalHostPid = livePid(hostPidPath, isTerminalHost, deps, template !== undefined);
    const existingPid = livePid(pidPath, isTransport, deps, template !== undefined);
    const supervisionPath = resolve(config.dataDir, "agent.supervision");
    const previousSupervision = template === undefined ? null : readPrivateLocalFile(supervisionPath);
    const supervision = external ? "external\n" : "detached\n";
    if (previousSupervision !== null && previousSupervision !== supervision)
      throw new Error("local_agent_supervision_conflict: retained lifetimes cannot change supervisors");
    if (external && (terminalHostPid !== null || existingPid !== null))
      throw new Error("local_agent_supervision_conflict: detached owners require explicit drained maintenance");
    if (template === undefined && existsSync(resolve(config.dataDir, "job-owner")))
      throw new Error("local_job_owner_definition_conflict: removing the template cannot reconfigure retained owners");
    let enrollment = savedEnrollment(tokenPath, auth, store, template !== undefined);
    if (
      template !== undefined && enrollment === null &&
      (terminalHostPid !== null || existingPid !== null || existsSync(ownerConfigPath))
    ) throw new Error("local_job_owner_enrollment_unavailable: retained native identity cannot be replaced");
    if (enrollment === null && existingPid === null) {
      const existingMachine = store.getMachineByName(config.localMachineName);
      if (template !== undefined && existingMachine !== null)
        throw new Error("local_job_owner_enrollment_unavailable: an existing machine requires its retained credential");
      enrollment = existingMachine === null
        ? auth.enrollLocalMachine(config.localMachineName)
        : auth.rotateMachineToken(existingMachine);
      if (template !== undefined) {
        writePrivateLocalFile(tokenPath, `${enrollment.machineToken}\n`);
      } else {
        writeFileSync(tokenPath, `${enrollment.machineToken}\n`, { encoding: "utf8", mode: 0o600 });
        chmodSync(tokenPath, 0o600);
      }
    }
    const owner = template === undefined ? undefined : configureLocalJobOwner(
      config.dataDir,
      template,
      enrollment!.machine.id,
      nativeOwner!.admissionPublicKey,
      { host: terminalHostPid, transport: existingPid },
    );
    if (template !== undefined && previousSupervision === null)
      writePrivateLocalFile(supervisionPath, supervision, true);
    // This is authenticated placement identity, not a native capability/readiness assertion.
    if (enrollment !== null) store.setMeta("native_local_machine_id", enrollment.machine.id);
    if (external) {
      logger.info("local_agent_prepared", { machineId: enrollment!.machine.id });
      release();
      return null;
    }
    const inherited: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) inherited[name] = value;
    }
    // The declaration is the only owner source. The retained host holds no enrollment secret.
    delete inherited.MANIFOLD_JOB_OWNER_CONFIG;
    delete inherited.MANIFOLD_JOB_OWNER_SOCKET;
    delete inherited.MANIFOLD_MACHINE_TOKEN;
    delete inherited.MANIFOLD_MACHINE_TOKEN_FILE;
    const socketPath = resolve(config.dataDir, "terminal-host", "host.sock");
    const environment = {
      ...inherited,
      ...owner?.environment,
      [TERMINAL_HOST_SOCKET_ENV]: socketPath,
    };
    if (terminalHostPid !== null) {
      logger.info("local_terminal_host_reused", { pid: terminalHostPid });
    } else {
      terminalHostPid = spawnDetached(hostPidPath, [TERMINAL_HOST_FLAG], environment, deps, owner !== undefined);
      owner?.record("host", terminalHostPid);
      logger.info("local_terminal_host_spawned", { pid: terminalHostPid });
    }
    if (existingPid !== null) {
      logger.info("local_agent_reused", { pid: existingPid });
      return { pid: existingPid, terminalHostPid, release };
    }
    if (enrollment === null) throw new Error("local_agent_enrollment_unavailable");
    const pid = spawnDetached(
      pidPath,
      [],
      {
        ...environment,
        MANIFOLD_SERVER_URL: `http://127.0.0.1:${boundPort}`,
        MANIFOLD_MACHINE_TOKEN: enrollment.machineToken,
        MANIFOLD_MACHINE_NAME: config.localMachineName,
      },
      deps,
      owner !== undefined,
    );
    owner?.record("transport", pid);
    logger.info("local_agent_spawned", { machineId: enrollment.machine.id, pid, terminalHostPid });
    return { pid, terminalHostPid, release };
  } catch (error) {
    release();
    throw error;
  }
}
