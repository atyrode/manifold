import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import {
  PROTOCOL_VERSION,
  TERMINAL_HOST_PROTOCOL_VERSION,
  TERMINAL_HOST_SOCKET_ENV,
} from "@manifold/protocol";
import { Agent } from "./agent.ts";
import type { AgentLogRecord } from "./log.ts";
import { resolveMachineToken } from "./machine-token.ts";
import { unixTerminalHostDialer } from "./terminal-host-link.ts";
import { listenTerminalHost } from "./terminal-host-listener.ts";
import { TerminalHost } from "./terminal-host.ts";

/**
 * manifold-agent entry point: ONE binary, two modes, two lifetimes (issue #278).
 *
 * - `manifold-agent --terminal-host` is the TERMINAL HOST: it owns every PTY and serves them
 *   on the Unix socket `MANIFOLD_TERMINAL_HOST_SOCKET`. It holds no token and dials nothing.
 *   SIGTERM here is DESTRUCTIVE (kills the shells with grace, then exits), which is why its
 *   unit is the one an activation must keep running; the safe stop is the maintenance
 *   `shutdown_request` on the socket, honoured only when drained and empty.
 * - `manifold-agent` is the TRANSPORT: it takes the seat on that socket, dials the hub, and
 *   bridges. SIGTERM here closes the socket and the seat and exits 0 — no PTY is touched.
 *   It REQUIRES the socket path and fails by name without one: it never spawns a host of its
 *   own, because a host inside the transport's cgroup dies with the transport, which is the
 *   2026-09-05 incident.
 *
 * Configuration is env-only (CONTRACTS.md runtime table). Structured logs are written as JSONL
 * to stdout — never tokens, owner keys, or terminal bytes (AGENTS.md invariant 6).
 */

const TERMINAL_HOST_FLAG = "--terminal-host";

/** Reads a required env var, throwing a clear error when it is missing or empty. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function stdoutSink(record: AgentLogRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** Runs `stop` once on SIGTERM/SIGINT; a second signal exits 1 without waiting. */
function onShutdownSignal(stop: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      stdoutSink({ ts: Date.now(), level: "warn", evt: "forced_shutdown", signal });
      process.exit(1);
    }
    shuttingDown = true;
    stdoutSink({ ts: Date.now(), level: "info", evt: "signal", signal });
    void stop().then(
      () => process.exit(0),
      (error: unknown) => {
        stdoutSink({
          ts: Date.now(),
          level: "error",
          evt: "shutdown_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function terminalHostMain(): Promise<void> {
  const socketPath = requireEnv(TERMINAL_HOST_SOCKET_ENV);
  const build = process.env.MANIFOLD_BUILD ?? "unknown";
  let listener: { stop(): void } | null = null;
  const host = new TerminalHost({
    sink: stdoutSink,
    build,
    onMaintenanceShutdown: () => {
      // Accepted only when drained and empty (terminal-host.ts): nothing to kill, so exit
      // once the accepting frame has left the socket.
      listener?.stop();
      stdoutSink({ ts: Date.now(), level: "info", evt: "shutdown", terminals: 0 });
      setTimeout(() => process.exit(0), 0);
    },
  });
  stdoutSink({
    ts: Date.now(),
    level: "info",
    evt: "starting",
    mode: "terminal_host",
    terminalHostId: host.terminalHostId,
    terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    build,
  });
  listener = await listenTerminalHost(host, socketPath, stdoutSink);
  onShutdownSignal(async () => {
    // Kill first, close the socket last: the attached transport receives every `exited`
    // before its connection goes, so the hub records the deliberate stop as exits, not as a
    // machine that merely went offline with its terminals in limbo.
    await host.shutdown();
    listener?.stop();
  });
}

function transportMain(): void {
  const serverUrl = requireEnv("MANIFOLD_SERVER_URL");
  const socketPath = requireEnv(TERMINAL_HOST_SOCKET_ENV);
  const machineToken = resolveMachineToken(process.env, (path) => readFileSync(path, "utf8"));
  const machineName = process.env.MANIFOLD_MACHINE_NAME ?? hostname();

  const agent = new Agent({
    serverUrl,
    machineToken,
    machineName,
    sink: stdoutSink,
    dialTerminalHost: unixTerminalHostDialer(socketPath),
  });
  onShutdownSignal(() => agent.shutdown());

  stdoutSink({
    ts: Date.now(),
    level: "info",
    evt: "starting",
    mode: "transport",
    server: serverUrl,
    machineName,
    protocolVersion: PROTOCOL_VERSION,
    terminalHostProtocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
    build: process.env.MANIFOLD_BUILD ?? "unknown",
  });
  void agent.connect();
}

function main(): void {
  const args = process.argv.slice(2);
  const unknown = args.find((arg) => arg !== TERMINAL_HOST_FLAG);
  if (unknown !== undefined) throw new Error(`unknown argument: ${unknown}`);
  if (args.includes(TERMINAL_HOST_FLAG)) {
    void terminalHostMain().catch((error: unknown) => {
      stdoutSink({
        ts: Date.now(),
        level: "error",
        evt: "terminal_host_start_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
    return;
  }
  transportMain();
}

if (import.meta.main) main();
