import { resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { elementPayloadGuard } from "@manifold/plugin";
import {
  defaultRuntime,
  INSTANCE_CHANNEL_PATH,
  normalizeInstanceOrigin,
  type RuntimeDeps,
} from "@manifold/protocol";
import { spawnLocalAgent } from "./agent-spawn.ts";
import { FLOOR_EVENT_OWNERS, SERVER_PLUGIN_DEFS, SHIPPED_PLUGIN_IDS } from "./assembly.ts";
import { AuthService } from "./auth.ts";
import { finalizePublicUrl, loadConfig, type ServerConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { EventHub } from "./event-hub.ts";
import { HttpApp, MAX_HTTP_BODY_BYTES } from "./http.ts";
import { InstanceDialer } from "./instance-dialer.ts";
import { InstanceGateway } from "./instance-ws.ts";
import { createLogger, type Logger } from "./log.ts";
import { MachineGateway } from "./machine-ws.ts";
import { assemblyElementTraits, assemblyItemNouns, PlaceExecutor } from "./placement.ts";
import { PluginHost } from "./plugin-host.ts";
import { defaultRoomTimers, RoomManager, type RoomTimers } from "./room.ts";
import { SESSION_TRANSPORT_PAYLOAD_BYTES, type RawSocket } from "./session-channel.ts";
import { SessionGateway } from "./session-ws.ts";
import { ServerStore } from "./stores.ts";
import { TerminalBroker } from "./terminal-broker.ts";

interface WebSocketData {
  endpoint: "session" | "machine" | "instance";
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
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  /*
    The executor resolves legality against the ASSEMBLY's element traits and names species by
    the assembly's noun table (ADR 0013 §12), and
    the assembly's space plugin drives the executor — mutually dependent, so the roster
    arrives as a thunk read at placement time rather than a table captured here.
   */
  const placement: PlaceExecutor = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    assemblyElementTraits(() => plugins.roster()),
    assemblyItemNouns(() => plugins.roster()),
  );
  broker.setPlacement(placement);
  /*
    The machine gateway before the assembly, because the assembly consults it:
    `core.machines.list` reports persisted rows AND live connectedness, and only this
    registry knows the second half. Nothing it needs is downstream of the host.
   */
  const machines = new MachineGateway(
    auth,
    store,
    broker,
    timers,
    logger,
    runtime.newId(),
    runtime,
  );
  /*
    THE INSTANCE CHANNEL, both ends. The host gateway sits beside the machine gateway for
    the same reason it looks like it (ADR 0014): a remote process dialing in with a token,
    version-negotiated, liveness-pinged, superseded on re-dial. The guest dialer is its
    mirror and is STARTED last, after the socket is bound, because a dial re-opened at boot
    is outbound traffic and an instance that dials before it can answer is a partner nobody
    can call back.

    Both are constructed here rather than inside the host because the assembly consults
    NEITHER: a share is authority, and authority is the identity mechanism's, not a
    plugin's. What the assembly gets is the door binding, further down.
  */
  const selfOrigin = (): string => normalizeInstanceOrigin(config.publicUrl) ?? config.publicUrl;
  const instances = new InstanceGateway(auth, store, timers, logger, runtime.newId(), selfOrigin);
  const dialer = new InstanceDialer(store, runtime, logger, selfOrigin);
  /*
    THE EVENT PLANE, before the host and after everything it reads from — the same thunk
    treatment the placement executor gets above, and for the same reason: the hub validates an
    emission against the ASSEMBLY and the host that owns the assembly needs the hub, so the
    roster arrives as a function read at emission time rather than a table captured here.

    `owners` comes from `assembly.ts` because it names plugins and no floor file may
    (`FLOOR_EVENT_OWNERS`); `terminals` is the broker, which is the only thing that knows which
    container a terminal currently lives in — the one hop the topic tree resolves from state.
   */
  const events = new EventHub(
    {
      assembly: () => plugins.assembly(),
      terminals: broker,
      owners: FLOOR_EVENT_OWNERS,
    },
    auth,
    store,
    runtime,
    logger,
  );
  /*
    The assembly, and the host that answers for it. It is built BEFORE the gateways
    that consult it: the session gateway pushes the roster and refuses terminal
    creation for a disabled terminals plugin, and the HTTP app serves the action door.
   */
  const plugins: PluginHost = new PluginHost(
    SERVER_PLUGIN_DEFS,
    store,
    auth,
    rooms,
    broker,
    placement,
    machines,
    dialer,
    runtime,
    logger,
    events,
    /*
      The `core.` reservation, made real: the ids this distribution registers, derived from
      `assembly.ts` and handed to the host as data, because the host may not name a plugin.
      Without this argument a manifest under `core.` composes unchecked (`AssemblyEnv`).
    */
    { distribution: SHIPPED_PLUGIN_IDS },
  );
  /*
    THE element-payload boundary, installed rather than constructed for the same reason the
    terminal view above it is: the schemas belong to the assembly, the assembly belongs to the
    host, and the host needs the rooms. So the room asks a function whether a record is
    acceptable and is told — it never learns that a plugin exists (ADR 0013 §16 clause 5).
    Until this line runs a room accepts every payload, which is the correct behaviour during
    boot and exactly what the envelope already does for a type nobody claims.
  */
  rooms.setElementPayloadGuard(elementPayloadGuard(() => plugins.assembly()));
  /*
    The three floor doors that announce on the plane, installed rather than constructed for
    the reason directly above: the broker, the rooms and the dialer are all upstream of the
    assembly the hub reads. Until these lines run, each writes its durable `events` row
    itself and fans nothing out — the correct behaviour during boot, since nobody can be
    subscribed yet.
   */
  broker.setEvents(events);
  rooms.setEvents(events);
  dialer.setEvents(events);
  const sessions = new SessionGateway(
    auth,
    rooms,
    broker,
    plugins,
    timers,
    logger,
    runtime,
    events,
  );
  const http = new HttpApp(config, store, auth, rooms, broker, machines, plugins, logger);

  const server = Bun.serve<WebSocketData>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: MAX_HTTP_BODY_BYTES,
    fetch(request, bunServer) {
      const pathname = new URL(request.url).pathname;
      let endpoint: WebSocketData["endpoint"] | null = null;
      if (pathname === "/ws/session") endpoint = "session";
      if (pathname === "/ws/machine") endpoint = "machine";
      // The literal comes from the protocol, not from here: the endpoint is a join between
      // the server that serves it and the SDK that dials it, and the foundation law prefers
      // a join the compiler can see to two string literals in two packages.
      if (pathname === INSTANCE_CHANNEL_PATH) endpoint = "instance";
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
        if (socket.data.endpoint === "session") sessions.open(socket.data.id, transport);
        else if (socket.data.endpoint === "machine") machines.open(socket.data.id, transport);
        else instances.open(socket.data.id, transport);
      },
      message(socket, message) {
        if (socket.data.endpoint === "session") sessions.message(socket.data.id, message);
        else if (socket.data.endpoint === "machine") machines.message(socket.data.id, message);
        else instances.message(socket.data.id, message);
      },
      drain(socket) {
        if (socket.data.endpoint === "session") sessions.drain(socket.data.id);
      },
      close(socket) {
        if (socket.data.endpoint === "session") sessions.close(socket.data.id);
        else if (socket.data.endpoint === "machine") machines.close(socket.data.id);
        else instances.close(socket.data.id);
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
  /*
    Dials resume AFTER the socket is bound and the public URL is final, and both halves of
    that ordering are load-bearing: a dial declares this instance's origin in its hello, so
    it cannot run before `finalizePublicUrl`, and a partner that answers a welcome may want
    to reach back, so it should not run before this process can be reached.
  */
  dialer.start();
  if (options.announce !== false) {
    // The pre-authed fragment is announce-key opt-in (MANIFOLD_ANNOUNCE_KEY=1,
    // dev/test only) so the owner key never enters persisted log streams;
    // operators read <data>/owner.key instead (docs/SELF-HOST.md).
    const fragment = config.announceKey ? `/#key=${config.ownerKey}` : "";
    console.log(`manifold ready url=${config.publicUrl}${fragment}`);
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
      instances.shutdown();
      dialer.shutdown();
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
