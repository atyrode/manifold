import { expect, test } from "bun:test";
import { AgentMessageSchema, type AgentMessage } from "@manifold/protocol";
import { Agent } from "../src/agent.ts";

/**
 * End-to-end machine-channel handshake against an in-process Bun.serve fake server. The
 * server drives the choreography (welcome → create → input → snapshot_request → drop) and the
 * test observes each milestone via resolvers — no fixed delays. It proves: the hello/welcome
 * handshake, PTY create + live output streaming, snapshot replies, and reconnect that
 * re-advertises the still-alive survivor with its seq watermark (server-restart adoption).
 */

const BASH = Bun.which("bash") ?? "/bin/sh";

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
