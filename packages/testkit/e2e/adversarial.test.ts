import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  mintToken,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, sceneElement, stopProcesses } from "./helpers.ts";
import {
  rawMachineSocket,
  rawSessionSocket,
  type AdversarialMachineSocket,
  type AdversarialSessionSocket,
} from "../src/adversarial.ts";

type InitMessage = Extract<ServerMessage, { type: "init" }>;

async function joinRaw(
  socket: AdversarialSessionSocket,
  padId: string,
  token: string,
): Promise<InitMessage> {
  socket.sendRaw(JSON.stringify({ type: "join", padId, token, protocolVersion: PROTOCOL_VERSION }));
  const message = await waitFor(
    () => socket.frames.find((frame) => frame.type === "init"),
    5_000,
    20,
  );
  if (message.type !== "init") throw new Error("raw join returned a non-init frame");
  return message;
}

async function closeSockets(
  sockets: readonly (AdversarialMachineSocket | AdversarialSessionSocket)[],
): Promise<void> {
  const results = await Promise.allSettled(sockets.map((socket) => socket.close()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

test("raw adversarial frames prove join ordering and frame-classification policy", async () => {
  const servers: TestServer[] = [];
  const sockets: AdversarialSessionSocket[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "adversarial");
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Adversary", color: "#b84a4a" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });

    const wrongFirst = await rawSessionSocket(server);
    sockets.push(wrongFirst);
    wrongFirst.sendRaw(JSON.stringify({ type: "ping" }));
    const wrongFirstClose = await waitFor(() => wrongFirst.closeInfo, 5_000, 20);
    expect(wrongFirstClose.code).toBe(4002);
    expect(wrongFirstClose.reason).toBe("first frame must be join");
    expect(wrongFirstClose.initiatedBy).toBe("REMOTE");

    const epochMismatch = await rawSessionSocket(server);
    sockets.push(epochMismatch);
    const epochInit = await joinRaw(epochMismatch, pad.id, grant.token);
    expect(epochInit.rev).toBe(0);
    epochMismatch.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "wrong-epoch",
        epoch: "WRONG",
        baseRev: 0,
        elements: [sceneElement("el-wrong-epoch")],
      }),
    );
    await waitFor(
      () =>
        epochMismatch.frames.some(
          (frame) => frame.type === "error" && frame.code === "epoch_mismatch",
        ) && epochMismatch.frames.some((frame) => frame.type === "resync"),
      5_000,
      20,
    );
    expect(
      epochMismatch.frames.some(
        (frame) => frame.type === "error" && frame.code === "epoch_mismatch",
      ),
    ).toBe(true);
    expect(epochMismatch.frames.some((frame) => frame.type === "resync")).toBe(true);

    const malformedKnown = await rawSessionSocket(server);
    sockets.push(malformedKnown);
    const malformedInit = await joinRaw(malformedKnown, pad.id, grant.token);
    malformedKnown.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "malformed-elements",
        epoch: malformedInit.epoch,
        baseRev: malformedInit.rev,
        elements: "nope",
      }),
    );
    const malformedClose = await waitFor(() => malformedKnown.closeInfo, 5_000, 20);
    expect(malformedClose.code).toBe(4002);
    expect(malformedClose.reason).toBe("malformed client frame");
    expect(malformedClose.initiatedBy).toBe("REMOTE");

    const unknownType = await rawSessionSocket(server);
    sockets.push(unknownType);
    await joinRaw(unknownType, pad.id, grant.token);
    unknownType.sendRaw(JSON.stringify({ type: "zorp" }));
    unknownType.sendRaw(JSON.stringify({ type: "ping" }));
    await waitFor(() => unknownType.frames.some((frame) => frame.type === "pong"), 5_000, 20);
    expect(unknownType.readyState).toBe(WebSocket.OPEN);

    const oversized = await rawSessionSocket(server);
    sockets.push(oversized);
    const oversizedInit = await joinRaw(oversized, pad.id, grant.token);
    const frameStart = oversized.frames.length;
    oversized.sendRaw(
      JSON.stringify({
        type: "scene_update",
        updateId: "oversized-batch",
        epoch: oversizedInit.epoch,
        baseRev: oversizedInit.rev,
        elements: Array.from({ length: 129 }, (_, index) => sceneElement(`el-big-${index}`)),
      }),
    );
    // The scene limit says "rejected" while the known-malformed policy says policy-close.
    // The target explicitly permits either an `invalid` error or that close, but never acceptance.
    const oversizedOutcome = await waitFor(
      () => {
        const invalid = oversized.frames
          .slice(frameStart)
          .find((frame) => frame.type === "error" && frame.code === "invalid");
        if (invalid !== undefined) return "invalid" as const;
        if (oversized.closeInfo !== null) return "closed" as const;
        return false;
      },
      5_000,
      20,
    );
    expect(["invalid", "closed"]).toContain(oversizedOutcome);
    expect(
      oversized.frames.some(
        (frame) =>
          frame.type === "scene_applied" &&
          frame.elements.some((element) => element.id.startsWith("el-big-")),
      ),
    ).toBe(false);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await Promise.all([closeSockets(sockets), stopProcesses(servers)]);
  }
}, 30_000);

test("a reused machine token fences the old socket before routing later commands", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  const sockets: (AdversarialMachineSocket | AdversarialSessionSocket)[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const enrolled = await enrollMachine(server, "fenced-machine");

    const first = await rawMachineSocket(server);
    sockets.push(first);
    first.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "fenced-machine-first",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const firstWelcome = await waitFor(
      () => first.frames.find((frame) => frame.type === "welcome"),
      5_000,
      20,
    );
    if (firstWelcome.type !== "welcome") throw new Error("first machine did not receive welcome");
    expect(firstWelcome.machineId).toBe(enrolled.machineId);
    const firstFrameCount = first.frames.length;

    const second = await rawMachineSocket(server);
    sockets.push(second);
    second.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "fenced-machine-second",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const secondWelcome = await waitFor(
      () => second.frames.find((frame) => frame.type === "welcome"),
      5_000,
      20,
    );
    if (secondWelcome.type !== "welcome") throw new Error("second machine did not receive welcome");
    expect(secondWelcome.machineId).toBe(enrolled.machineId);
    const superseded = await waitFor(() => first.closeInfo, 5_000, 20);
    expect(superseded.code).toBe(4001);
    expect(superseded.reason).toBe("superseded");
    expect(superseded.initiatedBy).toBe("REMOTE");

    const pad = await createPad(server, "machine fence");
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Machine Fence User", color: "#4777b8" },
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const client = await connect(server, { padId: pad.id, token: grant.token, reconnect: false });
    clients.push(client);
    const opening = client.openTerminal({
      elementId: "el-fenced-machine",
      cols: 80,
      rows: 24,
      machineId: enrolled.machineId,
    });
    const create = await waitFor(
      () => second.frames.find((frame) => frame.type === "create"),
      5_000,
      20,
    );
    if (create.type !== "create") throw new Error("active machine did not receive create");
    second.send({ type: "created", sessionId: create.sessionId });
    const session = await opening;
    expect(session.machineId).toBe(enrolled.machineId);
    expect(first.frames).toHaveLength(firstFrameCount);

    const exited = nextMessage(
      client,
      "session_event",
      5_000,
      (message) => message.sessionId === session.id && message.kind === "exited",
    );
    const killStart = second.frames.length;
    client.killTerminal(session.id);
    const kill = await waitFor(
      () =>
        second.frames
          .slice(killStart)
          .find((frame) => frame.type === "kill" && frame.sessionId === session.id),
      5_000,
      20,
    );
    if (kill.type !== "kill") throw new Error("active machine did not receive kill");
    second.send({ type: "exited", sessionId: session.id, exitCode: 0 });
    expect((await exited).kind).toBe("exited");
    expect(first.frames).toHaveLength(firstFrameCount);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await Promise.all([closeSockets(sockets), stopProcesses(servers)]);
  }
}, 30_000);
