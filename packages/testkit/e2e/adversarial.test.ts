import { expect, test } from "bun:test";
import { MAX_DOC_UPDATE_BYTES, PROTOCOL_VERSION, type ServerMessage } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  Y,
  createSceneDoc,
  decodeUpdate,
  elementsMap,
  encodeUpdate,
  readElements,
} from "@manifold/scene";
import {
  connect,
  createContainer,
  enrollMachine,
  mintToken,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, stopProcesses } from "./helpers.ts";
import {
  rawMachineSocket,
  rawSessionSocket,
  sessionFrame,
  type AdversarialMachineSocket,
  type AdversarialSessionSocket,
} from "../src/adversarial.ts";

type InitMessage = Extract<ServerMessage, { type: "init" }>;

async function joinRaw(
  socket: AdversarialSessionSocket,
  containerId: string,
  token: string,
): Promise<InitMessage> {
  socket.sendRaw(
    sessionFrame({ type: "join", containerId, token, protocolVersion: PROTOCOL_VERSION }),
  );
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
    const container = await createContainer(server, "adversarial");
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Adversary", color: "#b84a4a" },
      caps: ["containers:read", "scenes:write"],
      containerId: container.id,
    });

    const wrongFirst = await rawSessionSocket(server);
    sockets.push(wrongFirst);
    wrongFirst.sendRaw(JSON.stringify({ type: "pong" }));
    const wrongFirstClose = await waitFor(() => wrongFirst.closeInfo, 5_000, 20);
    expect(wrongFirstClose.code).toBe(4002);
    expect(wrongFirstClose.reason).toBe("first frame must be join");
    expect(wrongFirstClose.initiatedBy).toBe("REMOTE");

    const malformedKnown = await rawSessionSocket(server);
    sockets.push(malformedKnown);
    await joinRaw(malformedKnown, container.id, grant.token);
    malformedKnown.sendRaw(
      sessionFrame({
        type: "doc_update",
        update: "not base64",
      }),
    );
    const malformedClose = await waitFor(() => malformedKnown.closeInfo, 5_000, 20);
    expect(malformedClose.code).toBe(4002);
    expect(malformedClose.reason).toBe("malformed client frame");
    expect(malformedClose.initiatedBy).toBe("REMOTE");

    const unknownType = await rawSessionSocket(server);
    sockets.push(unknownType);
    await joinRaw(unknownType, container.id, grant.token);
    unknownType.sendRaw(sessionFrame({ type: "zorp" }));
    // The socket survived an unknown type, and it is still SERVING: a frame the server
    // answers proves that, where a liveness pong (which the server never answers) could not.
    unknownType.sendRaw(sessionFrame({ type: "resync_request" }));
    await waitFor(() => unknownType.frames.some((frame) => frame.type === "resync"), 5_000, 20);
    expect(unknownType.readyState).toBe(WebSocket.OPEN);

    const oversized = await rawSessionSocket(server);
    sockets.push(oversized);
    await joinRaw(oversized, container.id, grant.token);
    const frameStart = oversized.frames.length;
    oversized.sendRaw(
      sessionFrame({
        type: "doc_update",
        update: encodeUpdate(new Uint8Array(MAX_DOC_UPDATE_BYTES + 1)),
      }),
    );
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
    expect(oversized.frames.slice(frameStart).some((frame) => frame.type === "doc_update")).toBe(
      false,
    );

    const repaired = await rawSessionSocket(server);
    sockets.push(repaired);
    await joinRaw(repaired, container.id, grant.token);
    const invalidDoc = createSceneDoc();
    const invalidElement = new Y.Map<unknown>();
    invalidElement.set("id", "invalid-element");
    invalidElement.set("type", "terminal");
    elementsMap(invalidDoc).set("invalid-element", invalidElement);
    const repairStart = repaired.frames.length;
    repaired.sendRaw(
      sessionFrame({
        type: "doc_update",
        update: encodeUpdate(Y.encodeStateAsUpdate(invalidDoc)),
      }),
    );
    const repairFrames = await waitFor(
      () => {
        const updates = repaired.frames
          .slice(repairStart)
          .filter((frame) => frame.type === "doc_update");
        return updates.length >= 2 ? updates : false;
      },
      5_000,
      20,
    );
    expect(repairFrames.map((frame) => frame.by)).toEqual([grant.principal.id, "server"]);
    repaired.sendRaw(sessionFrame({ type: "resync_request" }));
    const resync = await waitFor(
      () => repaired.frames.slice(repairStart).find((frame) => frame.type === "resync"),
      5_000,
      20,
    );
    if (resync.type !== "resync") throw new Error("missing repaired resync");
    const repairedDoc = createSceneDoc();
    Y.applyUpdate(repairedDoc, decodeUpdate(resync.doc));
    expect(readElements(repairedDoc).has("invalid-element")).toBe(false);
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
      terminals: [],
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
      terminals: [],
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

    const container = await createContainer(server, "machine fence");
    // Workspace-scoped: killing the terminal is a message to the composition it lives in,
    // and that composition's id is minted by the server as the PTY lands.
    const grant = await mintToken(server, {
      principal: { kind: "human", name: "Machine Fence User", color: "#4777b8" },
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const client = await connect(server, {
      containerId: container.id,
      token: grant.token,
      reconnect: false,
    });
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
    second.send({ type: "created", terminalId: create.terminalId });
    const terminal = await opening;
    expect(terminal.machineId).toBe(enrolled.machineId);
    expect(first.frames).toHaveLength(firstFrameCount);

    const home = await connect(server, {
      containerId: terminal.containerId,
      token: grant.token,
      reconnect: false,
    });
    clients.push(home);
    await waitFor(() => home.terminals.has(terminal.id), 5_000, 20);
    // A kill destroys the terminal, so the home hears a departure rather than an exit; what
    // this test is about is WHICH socket the kill frame reaches.
    const departed = nextMessage(
      home,
      "terminal_event",
      5_000,
      (message) => message.terminalId === terminal.id && message.kind === "parked",
    );
    const killStart = second.frames.length;
    home.killTerminal(terminal.id);
    const kill = await waitFor(
      () =>
        second.frames
          .slice(killStart)
          .find((frame) => frame.type === "kill" && frame.terminalId === terminal.id),
      5_000,
      20,
    );
    if (kill.type !== "kill") throw new Error("active machine did not receive kill");
    expect((await departed).kind).toBe("parked");
    // The machine answers the kill the only way it can. The terminal is already gone, so the
    // frame changes nothing — and must not resurrect it as an exited row.
    second.send({ type: "exited", terminalId: terminal.id, exitCode: 0 });
    await waitFor(() => home.terminals.get(terminal.id) === undefined, 5_000, 20);
    expect(first.frames).toHaveLength(firstFrameCount);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await Promise.all([closeSockets(sockets), stopProcesses(servers)]);
  }
}, 30_000);
