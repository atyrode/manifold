import { expect, test } from "bun:test";
import { AgentMessageSchema, type AgentMessage } from "@manifold/protocol";
import { Agent } from "../src/agent.ts";
import { PtySession } from "../src/session.ts";

/**
 * End-to-end machine-channel handshake against an in-process Bun.serve fake server. The
 * server drives the choreography (welcome → create → input → snapshot_request → drop) and the
 * test observes each milestone via resolvers — no fixed delays. It proves: the hello/welcome
 * handshake, PTY create + live output streaming, snapshot replies, and reconnect that
 * re-advertises the still-alive survivor with its seq watermark (server-restart adoption).
 */

const BASH = Bun.which("bash") ?? "/bin/sh";

/** Reaches the concrete live session so this race test can control xterm's write queue. */
function sessionForTest(agent: Agent, sessionId: string): PtySession {
  const target: unknown = agent;
  if (
    typeof target !== "object" ||
    target === null ||
    !("sessions" in target) ||
    !(target.sessions instanceof Map)
  ) {
    throw new Error("Agent session registry is unavailable");
  }
  const session: unknown = target.sessions.get(sessionId);
  if (!(session instanceof PtySession)) throw new Error(`missing test session ${sessionId}`);
  return session;
}

/** Feeds the production Bun.Terminal data callback synchronously to keep the drain pending. */
function injectPtyOutput(session: PtySession, data: string): void {
  const target: unknown = session;
  if (
    typeof target !== "object" ||
    target === null ||
    !("ingest" in target) ||
    typeof target.ingest !== "function"
  ) {
    throw new Error("PtySession ingest callback is unavailable");
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
                  sessionId: "sess-1",
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
                sessionId: "sess-1",
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
                ws.send(JSON.stringify({ type: "snapshot_request", sessionId: "sess-1" }));
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
    expect(agent.sessionCount).toBe(1);

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

    const survivor = secondHello.sessions.find((s) => s.sessionId === "sess-1");
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
                sessionId: "dispose-race",
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
    const session = sessionForTest(agent, "dispose-race");
    const originalSnapshot = session.snapshot.bind(session);
    session.snapshot = () => {
      const pending = originalSnapshot();
      snapshotStarted.resolve();
      return pending;
    };

    // Keep xterm parsing while the request queues its drain marker, then dispose only after
    // snapshot() has actually returned its pending promise to Agent.onSnapshotRequest.
    const row = `${"x".repeat(79)}\r\n`;
    injectPtyOutput(session, row.repeat(500));
    const sendServerFrame = await sendToAgentReady.promise;
    sendServerFrame(JSON.stringify({ type: "snapshot_request", sessionId: "dispose-race" }));
    await snapshotStarted.promise;
    session.dispose();

    expect(await snapshotOutcome.promise).toBe("abandoned");
    await exitedSeen.promise;
    expect(snapshotFrames).toBe(0);

    // A ping after the rejected snapshot proves the void-dispatched handler did not leave an
    // unhandled rejection that terminates Bun's process.
    sendServerFrame(JSON.stringify({ type: "ping" }));
    await pongSeen.promise;
    expect(agent.sessionCount).toBe(0);
    expect(stderrMessages).toEqual([]);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
    await agent.shutdown();
    server.stop(true);
  }
}, 20000);
