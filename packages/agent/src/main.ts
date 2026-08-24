import { hostname } from "node:os";
import { Agent, type AgentLogRecord } from "./agent.ts";

/**
 * manifold-agent entry point. Reads its configuration from the environment (CONTRACTS.md
 * runtime table), constructs the {@link Agent}, and connects. Structured logs are written as
 * JSONL to stdout — never tokens, owner keys, or terminal bytes (AGENTS.md invariant 6).
 *
 * Lifetime: the process stays alive as long as PTYs are running OR a reconnect is pending,
 * even while the server socket is down — that IS the restart-survival feature. SIGTERM/SIGINT
 * kill every PTY and exit 0.
 */

/** Reads a required env var, throwing a clear error when it is missing or empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const serverUrl = requireEnv("MANIFOLD_SERVER_URL");
  const machineToken = requireEnv("MANIFOLD_MACHINE_TOKEN");
  const machineName = process.env.MANIFOLD_MACHINE_NAME ?? hostname();

  const sink = (record: AgentLogRecord): void => {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  };

  const agent = new Agent({ serverUrl, machineToken, machineName, sink });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    sink({ ts: Date.now(), level: "info", evt: "signal", signal });
    void agent.shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  sink({ ts: Date.now(), level: "info", evt: "starting", server: serverUrl, machineName });
  void agent.connect();
}

if (import.meta.main) main();
