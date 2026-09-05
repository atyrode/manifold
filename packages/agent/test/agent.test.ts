import { expect, test } from "bun:test";
import { AgentMessageSchema, type AgentMessage } from "@manifold/protocol";
import {
  Agent,
  MAX_SOCKET_BUFFERED_AMOUNT_BYTES,
  TERMINAL_HOST_LOST_CLOSE_CODE,
} from "../src/agent.ts";
import { TerminalHost } from "../src/terminal-host.ts";
import type { TerminalHostDialer } from "../src/terminal-host-link.ts";
import { PtyTerminal } from "../src/terminal.ts";

/**
 * The transport half of a machine, driven against a REAL {@link TerminalHost} through an
 * in-memory seam (no socket, no second process) and against either an in-process Bun.serve
 * fake hub or a scripted websocket. Each case proves a contract of the split (issue #278):
 * what the transport advertises is the host's inventory, a transport that dies ends nothing,
 * one seat at a time, the admission latch, and the hub socket following the seat.
 */

const BASH = Bun.which("bash") ?? "/bin/sh";

/** Pairs an agent with a host as a Unix socket would, one microtask of latency each way. */
function inMemoryDialer(host: TerminalHost): TerminalHostDialer {
  return (handlers) => {
    let closed = false;
    const session = host.open({
      write(event) {
        const copy: unknown = JSON.parse(JSON.stringify(event));
        queueMicrotask(() => {
          if (!closed) handlers.onEvent(copy as typeof event);
        });
        return true;
      },
      close() {
        if (closed) return;
        closed = true;
        queueMicrotask(() => handlers.onClose("closed_by_host"));
      },
    });
    return Promise.resolve({
      send(command) {
        const copy: unknown = JSON.parse(JSON.stringify(command));
        queueMicrotask(() => {
          if (!closed) session.deliver(copy);
        });
      },
      close() {
        if (closed) return;
        closed = true;
        session.detach();
        handlers.onClose("closed_by_transport");
      },
    });
  };
}

/** Reaches the concrete live terminal so a race test can control xterm's write queue. */
function terminalForTest(host: TerminalHost, terminalId: string): PtyTerminal {
  const target: unknown = host;
  if (
    typeof target !== "object" ||
    target === null ||
    !("terminals" in target) ||
    !(target.terminals instanceof Map)
  ) {
    throw new Error("TerminalHost terminal registry is unavailable");
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
  const hellos: Extract<AgentMessage, { type: "hello" }>[] = [];
  let outputText = "";
  let maxStreamedSeq = 0;
  let snapshotRequested = false;

  const createdSeen = Promise.withResolvers<void>();
  const outputSeen = Promise.withResolvers<void>();
  const snapshotSeen = Promise.withResolvers<{ seq: number; data: string }>();
  const secondHelloSeen = Promise.withResolvers<Extract<AgentMessage, { type: "hello" }>>();

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

  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const agent = new Agent({
    serverUrl: `http://localhost:${server.port}`,
    machineToken: "machine-token",
    machineName: "test-machine",
    backoff: { baseMs: 20, capMs: 200 },
    dialTerminalHost: inMemoryDialer(host),
  });

  try {
    await agent.connect(); // resolves on the first welcome
    expect(agent.id).toBe("machine-1");
    expect(agent.serverEpoch).toBe("epoch-1");
    expect(hellos[0]?.terminalHostId).toBe(host.terminalHostId);

    await createdSeen.promise;
    expect(host.terminalCount).toBe(1);

    await outputSeen.promise;

    const snapshot = await snapshotSeen.promise;
    expect(typeof snapshot.data).toBe("string");
    expect(snapshot.seq).toBeGreaterThanOrEqual(1);
    // `data` is base64 of the serialized mirror; decode it to confirm the render is captured.
    const rendered = Buffer.from(snapshot.data, "base64").toString("utf8");
    expect(rendered).toContain("HELLO_AGENT");

    // The server dropped the socket after the snapshot; the agent reconnects and re-hellos.
    const secondHello = await secondHelloSeen.promise;
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
    await host.shutdown();
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

  const host = new TerminalHost({
    shellCommand: [BASH, "--norc", "-i"],
    sink(record) {
      if (record.evt === "snapshot_abandoned") snapshotOutcome.resolve("abandoned");
    },
  });
  const agent = new Agent({
    serverUrl: `http://localhost:${server.port}`,
    machineToken: "machine-token",
    machineName: "test-machine",
    backoff: { baseMs: 20, capMs: 200 },
    dialTerminalHost: inMemoryDialer(host),
  });

  try {
    await agent.connect();
    await createdSeen.promise;
    const terminal = terminalForTest(host, "dispose-race");
    const originalSnapshot = terminal.snapshot.bind(terminal);
    terminal.snapshot = () => {
      const pending = originalSnapshot();
      snapshotStarted.resolve();
      return pending;
    };

    // Keep xterm parsing while the request queues its drain marker, then dispose only after
    // snapshot() has actually returned its pending promise to the host's request handler.
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
    expect(stderrMessages).toEqual([]);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await agent.shutdown();
    await host.shutdown();
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

/** A hub that welcomes every hello on a scripted socket; `sockets` records each dial. */
function scriptedHub(
  sockets: ScriptedSocket[],
  onSend?: (socket: ScriptedSocket, msg: AgentMessage) => void,
) {
  return (): WebSocket => {
    const socket = new ScriptedSocket();
    socket.onSend = (msg) => {
      if (msg.type === "hello") {
        socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: `e-${sockets.length}` });
      }
      onSend?.(socket, msg);
    };
    sockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket.asWebSocket();
  };
}

test("phantom transport: silence past the liveness deadline forces close and re-dial", async () => {
  const sockets: ScriptedSocket[] = [];
  const secondDial = Promise.withResolvers<ScriptedSocket>();
  const records: Array<{ evt: string; [k: string]: unknown }> = [];
  const livenessFired = Promise.withResolvers<void>();
  const host = new TerminalHost();

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "watchdog-machine",
    backoff: { baseMs: 1, capMs: 5 },
    livenessTimeoutMs: 20, // the watchdog's own real timer, kept tiny; no test-side sleeps
    dialTerminalHost: inMemoryDialer(host),
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
    await host.shutdown();
  }
}, 20000);

test("server close code and reason ref in logs; 4409 gets the version-rejected marker", async () => {
  const records: Array<{ evt: string; [k: string]: unknown }> = [];
  const disconnectedSeen = Promise.withResolvers<void>();
  const socket = new ScriptedSocket();
  const host = new TerminalHost();

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "rejected-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 }, // park the retry loop out of test scope
    dialTerminalHost: inMemoryDialer(host),
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
    await host.shutdown();
    void connectAttempt;
  }
}, 20000);

test("disconnected exit is advertised with its code and forgotten on welcome", async () => {
  const sockets: ScriptedSocket[] = [];
  const created = Promise.withResolvers<void>();
  const secondHello = Promise.withResolvers<Extract<AgentMessage, { type: "hello" }>>();
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-c", "read -r _; exit 17"] });

  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "exit-retention-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
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
    const terminal = terminalForTest(host, "dead-while-away");
    terminal.write("finish\n");
    const exit = await terminal.exited;
    expect(exit.exitCode).toBe(17);
    expect(host.terminalCount).toBe(1);

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
    expect(host.terminalCount).toBe(1);

    const second = sockets[1];
    if (second === undefined) throw new Error("missing second socket");
    second.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-2" });
    await Promise.resolve(); // the acknowledgement crosses the in-memory seam in one microtask
    expect(host.terminalCount).toBe(0);
  } finally {
    await agent.shutdown();
    await host.shutdown();
  }
}, 20000);

test("socket output backpressure closes the transport for reconnect recovery", async () => {
  const socket = new ScriptedSocket();
  const records: Array<{ evt: string; [key: string]: unknown }> = [];
  const host = new TerminalHost();
  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "backpressure-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
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
      bridgeToHub: (event: {
        type: "output";
        terminalId: string;
        seq: number;
        data: string;
      }) => void;
    };
    internals.bridgeToHub({ type: "output", terminalId: "busy-terminal", seq: 1, data: "AQ==" });

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
    await host.shutdown();
  }
});

test("a create naming a program execs it in place of the shell; a missing program is a named create_error", async () => {
  /*
    Issue #192. The pinned test shell is the DEFAULT, not an override: a create that names a
    program runs that program, so the first bytes on the wire are the program's own — no
    prompt, no rc file, nothing typed. And an argv[0] the machine cannot exec is answered
    with the program's name, never with a shell that garbles it or a bare `posix_spawn`.
  */
  const socket = new ScriptedSocket();
  const created = Promise.withResolvers<void>();
  const createError = Promise.withResolvers<Extract<AgentMessage, { type: "create_error" }>>();
  const printed = Promise.withResolvers<void>();
  let outputText = "";
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "program-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: () => {
      socket.onSend = (msg) => {
        switch (msg.type) {
          case "hello":
            socket.receive({ type: "welcome", machineId: "m-1", serverEpoch: "e-1" });
            return;
          case "created":
            created.resolve();
            return;
          case "create_error":
            createError.resolve(msg);
            return;
          case "output":
            outputText += Buffer.from(msg.data, "base64").toString("utf8");
            if (outputText.includes("PROG_x_OK")) printed.resolve();
            return;
          default:
            return;
        }
      };
      queueMicrotask(() => socket.open());
      return socket.asWebSocket();
    },
  });

  try {
    await agent.connect();
    socket.receive({
      type: "create",
      terminalId: "runs-a-program",
      cols: 80,
      rows: 24,
      env: { CODE_TEST: "x" },
      program: { argv: ["/bin/sh", "-c", 'printf "PROG_%s_OK\\n" "$CODE_TEST"; exec cat'] },
    });
    await created.promise;
    await printed.promise;
    // The program's stdout IS the first thing on the wire: nothing prompted before it.
    expect(outputText.startsWith("PROG_x_OK")).toBe(true);

    socket.receive({
      type: "create",
      terminalId: "no-such-program",
      cols: 80,
      rows: 24,
      env: {},
      program: { argv: ["/nonexistent/bin", "--flag"] },
    });
    const failure = await createError.promise;
    expect(failure.terminalId).toBe("no-such-program");
    expect(failure.message).toBe("program not found: /nonexistent/bin");
    expect(host.terminalCount).toBe(1);
  } finally {
    await agent.shutdown();
    await host.shutdown();
  }
}, 20000);

test("a transport shutdown ends nothing: the next transport advertises the same live PTY", async () => {
  /*
    Issue #278, the incident's shape inverted. SIGTERM on the transport (Agent.shutdown) is
    the routine activation path, and it must leave the shell — same process, same seq
    watermark — for whichever transport takes the seat next. The output produced while NO
    transport held the seat is not lost either: it is in the host's ring and mirror, and the
    successor's snapshot renders it.
  */
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const firstSockets: ScriptedSocket[] = [];
  const created = Promise.withResolvers<void>();
  const pidPrinted = Promise.withResolvers<void>();
  let firstOutput = "";
  const first = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "continuity-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: scriptedHub(firstSockets, (_socket, msg) => {
      if (msg.type === "created") created.resolve();
      if (msg.type === "output") {
        firstOutput += Buffer.from(msg.data, "base64").toString("utf8");
        if (/PID_\d+_END/.test(firstOutput)) pidPrinted.resolve();
      }
    }),
  });
  await first.connect();
  const socket = firstSockets[0];
  if (socket === undefined) throw new Error("missing first socket");
  socket.receive({ type: "create", terminalId: "survivor", cols: 80, rows: 24, env: {} });
  await created.promise;
  socket.receive({
    type: "input",
    terminalId: "survivor",
    data: Buffer.from('printf "PID_%s_END\\n" "$$"\n').toString("base64"),
  });
  await pidPrinted.promise;
  const pid = /PID_(\d+)_END/.exec(firstOutput)?.[1];
  const terminal = terminalForTest(host, "survivor");

  await first.shutdown();
  expect(terminal.alive).toBe(true);
  expect(host.terminalCount).toBe(1);
  expect(host.transportAttached).toBe(false);

  // Output with no seat: retained by the host, never streamed, never dropped.
  const seqBefore = terminal.seq;
  terminal.write('printf "WHILE_DOWN_%s\\n" "$$"\n');
  await new Promise<void>((resolve) => {
    const poll = (): void => {
      if (terminal.seq > seqBefore) resolve();
      else setTimeout(poll, 10);
    };
    poll();
  });

  const secondSockets: ScriptedSocket[] = [];
  const secondHello = Promise.withResolvers<Extract<AgentMessage, { type: "hello" }>>();
  const snapshotSeen = Promise.withResolvers<Extract<AgentMessage, { type: "snapshot" }>>();
  const second = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "continuity-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: scriptedHub(secondSockets, (_socket, msg) => {
      if (msg.type === "hello") secondHello.resolve(msg);
      if (msg.type === "snapshot") snapshotSeen.resolve(msg);
    }),
  });
  try {
    await second.connect();
    const hello = await secondHello.promise;
    expect(hello.terminalHostId).toBe(host.terminalHostId);
    expect(hello.terminals).toEqual([
      { terminalId: "survivor", cols: 80, rows: 24, alive: true, seq: terminal.seq },
    ]);
    secondSockets[0]?.receive({ type: "snapshot_request", terminalId: "survivor" });
    const snapshot = await snapshotSeen.promise;
    const rendered = Buffer.from(snapshot.data, "base64").toString("utf8");
    expect(rendered).toContain(`WHILE_DOWN_${pid}`);
    expect(snapshot.seq).toBe(terminal.seq);
  } finally {
    await second.shutdown();
    await host.shutdown();
  }
}, 20000);

test("one seat: a second transport is refused without killing anything and takes over once released", async () => {
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const firstSockets: ScriptedSocket[] = [];
  const created = Promise.withResolvers<void>();
  const first = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "fenced-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: scriptedHub(firstSockets, (_socket, msg) => {
      if (msg.type === "created") created.resolve();
    }),
  });
  await first.connect();
  firstSockets[0]?.receive({ type: "create", terminalId: "fenced", cols: 80, rows: 24, env: {} });
  await created.promise;

  const refused = Promise.withResolvers<void>();
  const records: Array<{ evt: string; [key: string]: unknown }> = [];
  const secondSockets: ScriptedSocket[] = [];
  const second = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "fenced-machine",
    backoff: { baseMs: 5, capMs: 20 },
    dialTerminalHost: inMemoryDialer(host),
    sink: (record) => {
      records.push(record);
      if (record.evt === "terminal_host_refused") refused.resolve();
    },
    createSocket: scriptedHub(secondSockets),
  });
  const secondConnect = second.connect();
  try {
    await refused.promise;
    // The loser dialled no hub (it could vouch for nothing) and ended nothing.
    expect(secondSockets).toHaveLength(0);
    expect(terminalForTest(host, "fenced").alive).toBe(true);
    expect(second.terminalHostId).toBeNull();

    await first.shutdown();
    // The retry loop (the same backoff as the hub dial) claims the released seat.
    await secondConnect;
    expect(second.terminalHostId).toBe(host.terminalHostId);
    expect(secondSockets[0]?.sent.find((msg) => msg.type === "hello")).toMatchObject({
      terminals: [expect.objectContaining({ terminalId: "fenced", alive: true })],
    });
    expect(terminalForTest(host, "fenced").alive).toBe(true);
  } finally {
    await second.shutdown();
    await host.shutdown();
  }
}, 20000);

test("shutdown during attachment releases the owner seat and ignores a late acknowledgement", async () => {
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const attached = Promise.withResolvers<void>();
  let deliverAttached: (() => void) | undefined;
  const dial = inMemoryDialer(host);
  const first = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "attachment-race",
    dialTerminalHost: (handlers) =>
      dial({
        ...handlers,
        onEvent(event) {
          if (event.type === "attached") {
            deliverAttached = () => handlers.onEvent(event);
            attached.resolve();
          } else {
            handlers.onEvent(event);
          }
        },
      }),
    createSocket: scriptedHub([]),
  });
  const successor = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "attachment-race",
    dialTerminalHost: dial,
    createSocket: scriptedHub([]),
  });
  try {
    void first.connect();
    await attached.promise;
    await first.shutdown();
    expect(host.transportAttached).toBe(false);
    deliverAttached?.();
    await successor.connect();
    expect(successor.terminalHostId).toBe(host.terminalHostId);
    expect(first.terminalHostId).toBeNull();
  } finally {
    await first.shutdown();
    await successor.shutdown();
    await host.shutdown();
  }
}, 20000);

test("drain is answered from the host, latches across transports, and refuses new creates by name", async () => {
  const host = new TerminalHost({ shellCommand: [BASH, "--norc", "-i"] });
  const firstSockets: ScriptedSocket[] = [];
  const created = Promise.withResolvers<void>();
  const drainStatus = Promise.withResolvers<Extract<AgentMessage, { type: "drain_status" }>>();
  const first = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "drain-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: scriptedHub(firstSockets, (_socket, msg) => {
      if (msg.type === "created") created.resolve();
      if (msg.type === "drain_status") drainStatus.resolve(msg);
    }),
  });
  await first.connect();
  const socket = firstSockets[0];
  if (socket === undefined) throw new Error("missing first socket");
  socket.receive({ type: "create", terminalId: "kept", cols: 80, rows: 24, env: {} });
  await created.promise;

  socket.receive({ type: "drain", requestId: "req-1", draining: true });
  expect(await drainStatus.promise).toEqual({
    type: "drain_status",
    requestId: "req-1",
    terminalHostId: host.terminalHostId,
    draining: true,
    terminalIds: ["kept"],
  });
  await first.shutdown();

  const secondSockets: ScriptedSocket[] = [];
  const createError = Promise.withResolvers<Extract<AgentMessage, { type: "create_error" }>>();
  const second = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "drain-machine",
    backoff: { baseMs: 5_000, capMs: 5_000 },
    dialTerminalHost: inMemoryDialer(host),
    createSocket: scriptedHub(secondSockets, (_socket, msg) => {
      if (msg.type === "create_error") createError.resolve(msg);
    }),
  });
  try {
    await second.connect();
    expect(host.isDraining).toBe(true); // the latch outlived the transport that set it
    secondSockets[0]?.receive({ type: "create", terminalId: "late", cols: 80, rows: 24, env: {} });
    expect(await createError.promise).toEqual({
      type: "create_error",
      terminalId: "late",
      message: "terminal host draining",
    });
    expect(host.terminalCount).toBe(1);
  } finally {
    await second.shutdown();
    await host.shutdown();
  }
}, 20000);

test("losing the terminal host closes the hub socket and holds the dial until re-seated", async () => {
  const host = new TerminalHost();
  const sockets: ScriptedSocket[] = [];
  const records: Array<{ evt: string; [key: string]: unknown }> = [];
  let dials = 0;
  const rehello = Promise.withResolvers<AgentMessage>();
  const agent = new Agent({
    serverUrl: "http://fake.invalid",
    machineToken: "machine-token",
    machineName: "lost-host-machine",
    backoff: { baseMs: 5, capMs: 20 },
    dialTerminalHost: (handlers) => {
      dials += 1;
      if (dials === 2) throw new Error("host down");
      return inMemoryDialer(host)(handlers);
    },
    sink: (record) => {
      records.push(record);
    },
    createSocket: scriptedHub(sockets, (_socket, msg) => {
      if (msg.type === "hello" && sockets.length === 2) rehello.resolve(msg);
    }),
  });
  try {
    await agent.connect();
    const firstSocket = sockets[0];
    if (firstSocket === undefined) throw new Error("missing first socket");

    // The host drops the seat (as a host crash would from the transport's point of view).
    const internals = agent as unknown as { seat: { link: { close(): void } } | null };
    const link = internals.seat?.link;
    if (link === undefined) throw new Error("missing seat");
    link.close();

    expect(firstSocket.closedByAgent?.code).toBe(TERMINAL_HOST_LOST_CLOSE_CODE);
    expect(records.some((record) => record.evt === "terminal_host_lost")).toBe(true);

    await rehello.promise;
    // The second dial attempt failed (host down) and was retried; only then was the hub
    // dialled again — never a hello this process could not back.
    expect(records.some((record) => record.evt === "terminal_host_unreachable")).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.sent.find((msg) => msg.type === "hello")).toMatchObject({
      terminalHostId: host.terminalHostId,
    });
  } finally {
    await agent.shutdown();
    await host.shutdown();
  }
}, 20000);
