import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { defaultRuntime, type RuntimeDeps } from "@manifold/protocol";
import { spawnLocalAgent } from "./agent-spawn.ts";
import { AuthService } from "./auth.ts";
import { finalizePublicUrl, loadConfig, type ServerConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { HttpApp, MAX_HTTP_BODY_BYTES } from "./http.ts";
import { createLogger, type Logger } from "./log.ts";
import { MachineGateway } from "./machine-ws.ts";
import { defaultRoomTimers, RoomManager, type RoomTimers } from "./room.ts";
import { SESSION_TRANSPORT_PAYLOAD_BYTES, type RawSocket } from "./session-peer.ts";
import { SessionGateway } from "./session-ws.ts";
import { ServerStore } from "./stores.ts";
import { TerminalBroker } from "./terminal-broker.ts";

interface WebSocketData {
  endpoint: "session" | "machine";
  id: string;
}

class BunSocket implements RawSocket {
  constructor(private readonly socket: ServerWebSocket<WebSocketData>) {}

  get bufferedAmount(): number {
    return this.socket.getBufferedAmount();
  }

  send(data: string): number {
    return this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

/** Optional dependency injection for embedded and deterministic server starts. */
export interface StartServerOptions {
  config?: ServerConfig;
  runtime?: RuntimeDeps;
  timers?: RoomTimers;
  logger?: Logger;
  announce?: boolean;
}

/** A bound manifold server with an idempotent graceful stop operation. */
export interface RunningServer {
  readonly port: number;
  readonly publicUrl: string;
  stop(): Promise<void>;
}

/** Wires SQLite, rooms, brokers, HTTP, and both WebSockets into one Bun process. */
export function startServer(options: StartServerOptions = {}): RunningServer {
  const runtime = options.runtime ?? defaultRuntime;
  const config = options.config ?? loadConfig();
  const timers = options.timers ?? defaultRoomTimers;
  const logger = options.logger ?? createLogger(runtime);
  const store = new ServerStore(openDatabase(resolve(config.dataDir, "manifold.db")));
  const auth = new AuthService(store, config.ownerKey, runtime);
  const rooms = new RoomManager(store, runtime, timers, logger);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    timers,
    logger,
    () => config.publicUrl,
  );
  rooms.setSessionProvider((padId) => broker.listForPad(padId));
  rooms.setPendingOpenProvider((padId) => broker.hasPendingOpenForPad(padId));
  const sessions = new SessionGateway(auth, rooms, broker, timers, logger, runtime);
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    timers,
    logger,
    runtime.newId(),
    runtime,
  );
  const http = new HttpApp(config, store, auth, rooms, broker, machines, runtime, logger);

  const server = Bun.serve<WebSocketData>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    fetch(request, bunServer) {
      const pathname = new URL(request.url).pathname;
      let endpoint: WebSocketData["endpoint"] | null = null;
      if (pathname === "/ws/session") endpoint = "session";
      if (pathname === "/ws/machine") endpoint = "machine";
      if (endpoint !== null) {
        const upgraded = bunServer.upgrade(request, {
          data: { endpoint, id: runtime.newId() },
        });
        if (upgraded) return undefined;
      }
      return http.fetch(request);
    },
    websocket: {
      open(socket) {
        const transport = new BunSocket(socket);
        if (socket.data.endpoint === "session") {
          sessions.open(socket.data.id, transport);
        } else {
          machines.open(socket.data.id, transport);
        }
      },
      message(socket, message) {
        if (socket.data.endpoint === "session") {
          sessions.message(socket.data.id, message);
        } else {
          machines.message(socket.data.id, message);
        }
      },
      drain(socket) {
        if (socket.data.endpoint === "session") sessions.drain(socket.data.id);
      },
      close(socket) {
        if (socket.data.endpoint === "session") {
          sessions.close(socket.data.id);
        } else {
          machines.close(socket.data.id);
        }
      },
      maxPayloadLength: SESSION_TRANSPORT_PAYLOAD_BYTES,
      idleTimeout: 120,
    },
  });
  const boundPort = server.port;
  if (boundPort === undefined) {
    throw new Error("Bun did not expose a TCP port for the server");
  }

  finalizePublicUrl(config, boundPort);
  const localAgent = spawnLocalAgent(config, boundPort, auth, store, logger);
  if (options.announce !== false) {
    console.log(`manifold ready url=${config.publicUrl}/#key=${config.ownerKey}`);
  }

  let stopped = false;
  return {
    port: boundPort,
    publicUrl: config.publicUrl,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      rooms.flushAll();
      sessions.shutdown();
      machines.shutdown();
      await server.stop(true);
      localAgent?.release();
      store.close();
    },
  };
}

if (import.meta.main) {
  const running = startServer();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void running.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        createLogger(defaultRuntime).error("shutdown_failed", {
          error: error instanceof Error ? error.message : "unknown failure",
        });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
