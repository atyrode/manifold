import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthService, MachineEnrollment } from "./auth.ts";
import { ServiceError } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import type { ServerStore } from "./stores.ts";

function livePid(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return null;
    throw error;
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
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
): number | null {
  if (!config.spawnAgent) return null;
  const pidPath = resolve(config.dataDir, "agent.pid");
  const existingPid = livePid(pidPath);
  if (existingPid !== null) {
    logger.info("local_agent_reused", { pid: existingPid });
    return existingPid;
  }

  const tokenPath = resolve(config.dataDir, "agent.token");
  let enrollment = savedEnrollment(tokenPath, auth, store);
  if (enrollment === null) {
    const existingMachine = store.getMachineByName("local");
    enrollment =
      existingMachine === null
        ? auth.enrollLocalMachine("local")
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
  environment.MANIFOLD_MACHINE_NAME = "local";

  const child = Bun.spawn(["bun", "packages/agent/src/main.ts"], {
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
  return child.pid;
}
