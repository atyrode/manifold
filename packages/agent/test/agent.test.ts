import { expect, test } from "bun:test";
import { AgentMessageSchema, type AgentMessage } from "@manifold/protocol";
import { Agent, MAX_SOCKET_BUFFERED_AMOUNT_BYTES } from "../src/agent.ts";
import { PtyTerminal } from "../src/terminal.ts";

/**
 * End-to-end machine-channel handshake against an in-process Bun.serve fake server. The
 * server drives the choreography (welcome → create → input → snapshot_request → drop) and the
 * test observes each milestone via resolvers — no fixed delays. It proves: the hello/welcome
 * handshake, PTY create + live output streaming, snapshot replies, and reconnect that
 * re-advertises the still-alive survivor with its seq watermark (server-restart adoption).
 */

const BASH = Bun.which("bash") ?? "/bin/sh";

/** Reaches the concrete live terminal so this race test can control xterm's write queue. */
function terminalForTest(agent: Agent, terminalId: string): PtyTerminal {
  const target: unknown = agent;
  if (
    typeof target !== "object" ||
    target === null ||
    !("terminals" in target) ||
    !(target.terminals instanceof Map)
  ) {
    throw new Error("Agent terminal registry is unavailable");
  }
  const terminal: unknown = target.terminals.get(terminalId);
  if (!(terminal instanceof PtyTerminal)) throw new Error(`missing test terminal ${terminalId}`);
  return terminal;
}

/** Feeds the production Bun.Terminal data callback synchronously to keep the drain pending. */
function injectPtyOutput(terminal: PtyTerminal, data: string): void {
  const target: unknown = terminal;
  if (
    typeof target !== "object" ||
    target === null ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  ) {
    throw new Error("PtyTerminal ingest callback is unavailable");
  }
  target.ingest.call(target, new TextEncoder().encode(data));
}

test("handshake, create, stream, snapshot, then reconnect re-advertises the survivor", async () => {
  const hellos: AgentMessage[] = [];
  let outputText = "";
  let maxStreamedSeq = 0;
  let snapshotRequested = false;

  const createdSeen = Promise.withResolvers<void>();
  const outputSeen = Promise.withResolvers<void>();
  const snapshotSeen = Promise.withResolvers<{ seq: number; data: string }>();
  const secondHelloSeen = Promise.withResolvers<AgentMessage>();

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket upgrade", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        // Validating with the protocol schema doubles as an assertion the agent emits valid frames.
        const msg = AgentMessageSchema.parse(JSON.parse(String(raw)));
        switch (msg.type) {
          case "hello":
            hellos.push(msg);
            ws.send(
              JSON.stringify({ type: "welcome", machineId: "machine-1", serverEpoch: "epoch-1" }),
            );
            if (hellos.length === 1) {
              ws.send(
                JSON.stringify({
                  type: "create",
                  terminalId: "sess-1",
                  cols: 80,
                  rows: 24,
                  env: {},
                }),
              );
            } else {
              secondHelloSeen.resolve(msg);
            }
            return;
          case "created":
            createdSeen.resolve();
            ws.send(
              JSON.stringify({
                type: "input",
                terminalId: "sess-1",
                data: Buffer.from("echo HELLO_AGENT\n").toString("base64"),
              }),
            );
            return;
          case "output":
            maxStreamedSeq = Math.max(maxStreamedSeq, msg.seq);
            outputText += Buffer.from(msg.data, "base64").toString("utf8");
            if (outputText.includes("HELLO_AGENT")) {
              outputSeen.resolve();
              if (!snapshotRequested) {
                snapshotRequested = true;
                ws.send(JSON.stringify({ type: "snapshot_request", terminalId: "sess-1" }));
              }
            }
            return;
          case "snapshot":
            snapshotSeen.resolve({ seq: msg.seq, data: msg.data });
            ws.close(); // drop the socket → the agent must redial
            return;
          default:
            return;
        }
      },
    },
  });

  const agent = new Agent({
    serverUrl: `http://localhost:${server.port}`,
    machineToken: "machine-token",
    machineName: "test-machine",
    backoff: { baseMs: 20, capMs: 200 },
    shellCommand: [BASH, "--norc", "-i"],
  });

  try {
    await agent.connect(); // resolves on the first welcome
    expect(agent.id).toBe("machine-1");
    expect(agent.serverEpoch).toBe("epoch-1");

    await createdSeen.promise;
    expect(agent.terminalCount).toBe(1);

    await outputSeen.promise;

    const snapshot = await snapshotSeen.promise;
    expect(typeof snapshot.data).toBe("string");
    expect(snapshot.seq).toBeGreaterThanOrEqual(1);
    // `data` is base64 of the serialized mirror; decode it to confirm the render is captured.
    const rendered = Buffer.from(snapshot.data, "base64").toString("utf8");
    expect(rendered).toContain("HELLO_AGENT");

    // The server dropped the socket after the snapshot; the agent reconnects and re-hellos.
    const secondHello = await secondHelloSeen.promise;
    if (secondHello.type !== "hello") throw new Error("expected a hello frame");
    expect(hellos.length).toBe(2);

    const survivor = secondHello.terminals.find((s) => s.terminalId === "sess-1");
    expect(survivor).toBeDefined();
    expect(survivor?.alive).toBe(true);
    expect(survivor?.cols).toBe(80);
    expect(survivor?.rows).toBe(24);
    // Watermark: the advertised seq never regresses below what was already streamed.
    expect(survivor?.seq ?? 0).toBeGreaterThan(0);
    expect(survivor?.seq ?? 0).toBeGreaterThanOrEqual(maxStreamedSeq);
  } finally {
    await agent.shutdown();
    server.stop(true);
  }
}, 20000);

test("abandoning an in-flight snapshot on PTY disposal sends no frame or rejection", async () => {
  const createdSeen = Promise.withResolvers<void>();
  const exitedSeen = Promise.withResolvers<void>();
  const pongSeen = Promise.withResolvers<void>();
  const snapshotStarted = Promise.withResolvers<void>();
  const snapshotOutcome = Promise.withResolvers<"abandoned" | "sent">();
  let snapshotFrames = 0;
  const sendToAgentReady = Promise.withResolvers<(message: string) => void>();
  const stderrMessages: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...values: unknown[]) => {
    stderrMessages.push(values.map(String).join(" "));
  };
  console.error = (...values: unknown[]) => {
    stderrMessages.push(values.map(String).join(" "));
  };

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        sendToAgentReady.resolve((message) => {
          ws.send(message);
        });
      },
      message(ws, raw) {
        const msg = AgentMessageSchema.parse(JSON.parse(String(raw)));
        switch (msg.type) {
          case "hello":
            ws.send(
              JSON.stringify({ type: "welcome", machineId: "machine-1", serverEpoch: "epoch-1" }),
            );
            ws.send(
              JSON.stringify({
                type: "create",
                terminalId: "dispose-race",
                cols: 80,
                rows: 24,
                env: {},
              }),
            );
            return;
          case "created":
            createdSeen.resolve();
            return;
          case "snapshot":
            snapshotFrames += 1;
            snapshotOutcome.resolve("sent");
            return;
          case "exited":
            exitedSeen.resolve();
            return;
          case "pong":
            pongSeen.resolve();
            return;
          default:
            return;
        }
      },
    },
  });

  const agent = new Agent({
    serverUrl: `http://localhost:${server.port}`,
    machineToken: "machine-token",
    machineName: "test-machine",
    backoff: { baseMs: 20, capMs: 200 },
    shellCommand: [BASH, "--norc", "-i"],
    sink(record) {
      if (record.evt === "snapshot_abandoned") snapshotOutcome.resolve("abandoned");
    },
  });

  try {
    await agent.connect();
    await createdSeen.promise;
    const terminal = terminalForTest(agent, "dispose-race");
    const originalSnapshot = terminal.snapshot.bind(terminal);
    terminal.snapshot = () => {
      const pending = originalSnapshot();
      snapshotStarted.resolve();
      return pending;
    };

    // Keep xterm parsing while the request queues its drain marker, then dispose only after
    // snapshot() has actually returned its pending promise to Agent.onSnapshotRequest.
    const row = `${"x".repeat(79)}\r\n`;
    injectPtyOutput(terminal, row.repeat(500));
    const sendServerFrame = await sendToAgentReady.promise;
    sendServerFrame(JSON.stringify({ type: "snapshot_request", terminalId: "dispose-race" }));
    await snapshotStarted.promise;
    terminal.dispose();

    expect(await snapshotOutcome.promise).toBe("abandoned");
    await exitedSeen.promise;
    expect(snapshotFrames).toBe(0);

    // A ping after the rejected snapshot proves the void-dispatched handler did not leave an
    // unhandled rejection that terminates Bun's process.
    sendServerFrame(JSON.stringify({ type: "ping" }));
    await pongSeen.promise;
    expect(agent.terminalCount).toBe(0);
    expect(stderrMessages).toEqual([]);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await agent.shutdown();
    server.stop(true);
  }
}, 20000);

/**
 * Scripted in-memory socket (agent-side mirror of the server tests' FakeSocket):
 * the test plays the server role by driving open/receive/serverClose, so these
 * cases stay deterministic and network-free per AGENTS.md invariant 7.
 */
class ScriptedSocket {
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: AgentMessage[] = [];
  closedByAgent: { code: number | undefined; reason: string | undefined } | null = null;
  onSend: ((msg: AgentMessage) => void) | null = null;

  asWebSocket(): WebSocket {
    return this as unknown as WebSocket;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  serverClose(code: number, reason: string): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  send(data: string): void {
    const msg = AgentMessageSchema.parse(JSON.parse(data));
    this.sent.push(msg);
    this.onSend?.(msg);
  }

  close(code?: number, reason?: string): void {
    this.closedByAgent = { code, reason };
    this.readyState = WebSocket.CLOSED;
    // Mirror runtime behavior: a locally initiated close still emits a close event.
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  }
}

test("phantom transport: silence past the liveness deadline forces close and re-dial", async () => {
  const sockets: ScriptedSocket[] = [];
  const secondDial = Promise.withResolvers<ScriptedSocket>();
  const records: Array<{ evt: string; [k: string]: unknown }> = [];
  const livenessFired = Promise.withResolvers<void>();

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "watchdog-machine",
    backoff: { baseMs: 1, capMs: 5 },
    livenessTimeoutMs: 20, // the watchdog's own real timer, kept tiny; no test-side sleeps
    sink: (record) => {
      records.push(record);
      if (record.evt === "liveness_timeout") livenessFired.resolve();
    },
    createSocket: () => {
      const socket = new ScriptedSocket();
      socket.onSend = (msg) => {
        // First dial: welcome the hello, then go silent forever — no pings, no
        // frames. This models the phantom transport (dead TCP nobody RST).
        if (msg.type === "hello" && sockets.length === 1) {
          socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-1" });
        }
      };
      sockets.push(socket);
      if (sockets.length === 2) secondDial.resolve(socket);
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  try {
    await agent.connect();
    await livenessFired.promise; // the agent's watchdog, not a test timer
    const first = sockets[0];
    expect(first?.closedByAgent?.code).toBe(4008);

    const second = await secondDial.promise; // silence was fatal: the agent re-dialed
    expect(second).toBeDefined();
    expect(records.some((r) => r.evt === "disconnected")).toBe(true);
  } finally {
    await agent.shutdown();
  }
}, 20000);

test("server close code and reason ref in logs; 4409 gets the version-rejected marker", async () => {
  const records: Array<{ evt: string; [k: string]: unknown }> = [];
  const disconnectedSeen = Promise.withResolvers<void>();
  const socket = new ScriptedSocket();

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "rejected-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 }, // park the retry loop out of test scope
    sink: (record) => {
      records.push(record);
      if (record.evt === "disconnected") disconnectedSeen.resolve();
    },
    createSocket: () => {
      socket.onSend = (msg) => {
        if (msg.type === "hello") socket.serverClose(4409, "protocol version mismatch");
      };
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  const connectAttempt = agent.connect(); // never resolves (no welcome); shutdown unblocks teardown
  try {
    await disconnectedSeen.promise;
    const rejected = records.find((r) => r.evt === "protocol_version_rejected");
    expect(rejected?.code).toBe(4409);
    expect(rejected?.level).toBe("error");
    const disconnected = records.find((r) => r.evt === "disconnected");
    expect(disconnected?.code).toBe(4409);
    expect(disconnected?.reason).toBe("protocol version mismatch");
  } finally {
    await agent.shutdown();
    void connectAttempt;
  }
}, 20000);

test("disconnected exit is advertised with its code and forgotten on welcome", async () => {
  const sockets: ScriptedSocket[] = [];
  const created = Promise.withResolvers<void>();
  const secondHello = Promise.withResolvers<Extract<AgentMessage, { type: "hello" }>>();

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "exit-retention-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    shellCommand: [BASH, "--norc", "-c", "read -r _; exit 17"],
    createSocket: () => {
      const socket = new ScriptedSocket();
      socket.onSend = (msg) => {
        if (msg.type === "hello") {
          if (sockets.length === 1) {
            socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-1" });
          } else {
            secondHello.resolve(msg);
          }
        } else if (msg.type === "created") {
          created.resolve();
        }
      };
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  try {
    await agent.connect();
    const first = sockets[0];
    if (first === undefined) throw new Error("missing first socket");
    first.receive({
      type: "create",
      terminalId: "dead-while-away",
      cols: 80,
      rows: 24,
      env: {},
    });
    await created.promise;

    first.serverClose(1006, "transport lost");
    const terminal = terminalForTest(agent, "dead-while-away");
    terminal.write("finish\n");
    const exit = await terminal.exited;
    expect(exit.exitCode).toBe(17);
    expect(agent.terminalCount).toBe(1);

    const internals = agent as unknown as { reconnectTimer: Timer | null; dial: () => void };
    clearTimeout(internals.reconnectTimer ?? undefined);
    internals.reconnectTimer = null;
    internals.dial();

    const hello = await secondHello.promise;
    expect(hello.terminals).toContainEqual({
      terminalId: "dead-while-away",
      cols: 80,
      rows: 24,
      alive: false,
      seq: terminal.seq,
      exitCode: 17,
    });
    expect(agent.terminalCount).toBe(1);

    const second = sockets[1];
    if (second === undefined) throw new Error("missing second socket");
    second.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-2" });
    expect(agent.terminalCount).toBe(0);
  } finally {
    await agent.shutdown();
  }
}, 20000);

test("socket output backpressure closes the transport for reconnect recovery", async () => {
  const socket = new ScriptedSocket();
  const records: Array<{ evt: string; [key: string]: unknown }> = [];
  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "backpressure-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    sink: (record) => records.push(record),
    createSocket: () => {
      socket.onSend = (msg) => {
        if (msg.type === "hello") {
          socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-1" });
        }
      };
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  try {
    await agent.connect();
    socket.bufferedAmount = MAX_SOCKET_BUFFERED_AMOUNT_BYTES + 1;
    const internals = agent as unknown as {
      onOutput: (terminalId: string, output: { seq: number; bytes: Uint8Array }) => void;
    };
    internals.onOutput("busy-terminal", { seq: 1, bytes: new Uint8Array([1]) });

    expect(socket.closedByAgent).toEqual({ code: 4009, reason: "outbound buffer exceeded" });
    expect(records).toContainEqual(
      expect.objectContaining({
        evt: "socket_backpressure",
        bufferedAmount: MAX_SOCKET_BUFFERED_AMOUNT_BYTES + 1,
        capBytes: MAX_SOCKET_BUFFERED_AMOUNT_BYTES,
      }),
    );
    expect(socket.sent.some((msg) => msg.type === "output")).toBe(false);
  } finally {
    await agent.shutdown();
  }
});

test("shutdown escalates a signal-trapping PTY after its grace window", async () => {
  const socket = new ScriptedSocket();
  const created = Promise.withResolvers<void>();
  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "bounded-shutdown-machine",
    shutdownGraceMs: 25,
    shellCommand: [BASH, "--norc", "-c", "trap '' TERM HUP; while :; do sleep 1; done"],
    createSocket: () => {
      socket.onSend = (msg) => {
        if (msg.type === "hello") {
          socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-1" });
        } else if (msg.type === "created") {
          created.resolve();
        }
      };
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  await agent.connect();
  socket.receive({
    type: "create",
    terminalId: "trap-signals",
    cols: 80,
    rows: 24,
    env: {},
  });
  await created.promise;

  const startedAt = performance.now();
  await agent.shutdown();
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  expect(agent.terminalCount).toBe(0);
}, 5000);
