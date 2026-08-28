import { expect, test } from "bun:test";
import {
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  OkResponseSchema,
  RevokeRequestSchema,
  PROTOCOL_VERSION,
} from "@manifold/protocol";
import { textToBase64, type SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  enrollMachine,
  mintToken,
  ownerFetch,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, stopProcesses } from "./helpers.ts";
import {
  rawMachineSocket,
  rawSessionSocket,
  type AdversarialMachineSocket,
  type AdversarialSessionSocket,
} from "../src/adversarial.ts";

interface Parser<T> {
  parse(input: unknown): T;
}

interface ParsedResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function fetchParsed<T>(
  server: TestServer,
  token: string,
  path: string,
  schema: Parser<T>,
  init: RequestInit,
): Promise<ParsedResponse<T>> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const response = await fetch(new URL(path, server.httpUrl), { ...init, headers, signal });
  const text = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`HTTP ${response.status} returned non-JSON`, { cause: error });
  }
  return { status: response.status, body: schema.parse(decoded) };
}

async function closeRawSockets(
  sockets: readonly (AdversarialMachineSocket | AdversarialSessionSocket)[],
): Promise<void> {
  const outcomes = await Promise.allSettled(sockets.map((socket) => socket.close()));
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

test("auth closes invalid joins and enforces scope, capabilities, attenuation, and revocation", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  const rawSockets: AdversarialSessionSocket[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const padX = await createPad(server, "auth x");
    const padY = await createPad(server, "auth y");

    const garbage = await rawSessionSocket(server);
    rawSockets.push(garbage);
    garbage.sendRaw(
      JSON.stringify({
        type: "join",
        padId: padX.id,
        token: "garbage-token",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const garbageClose = await waitFor(() => garbage.closeInfo, 5_000, 20);
    expect(garbageClose.code).toBe(4401);

    const scoped = await mintToken(server, {
      principal: { kind: "human", name: "Scoped User", color: "#8f4ac1" },
      caps: ["pads:read", "scene:write"],
      padId: padX.id,
    });
    const wrongPad = await rawSessionSocket(server);
    rawSockets.push(wrongPad);
    wrongPad.sendRaw(
      JSON.stringify({
        type: "join",
        padId: padY.id,
        token: scoped.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const wrongPadClose = await waitFor(() => wrongPad.closeInfo, 5_000, 20);
    expect(wrongPadClose.code).toBe(4403);

    const noTerminal = await connect(server, {
      padId: padX.id,
      token: scoped.token,
      reconnect: false,
    });
    clients.push(noTerminal);
    const terminalForbidden = nextMessage(
      noTerminal,
      "error",
      5_000,
      (message) => message.code === "forbidden",
    );
    const openAttempt = noTerminal
      .openTerminal({ elementId: "el-forbidden-terminal", cols: 80, rows: 24, timeoutMs: 2_000 })
      .then(
        () => "opened" as const,
        () => "rejected" as const,
      );
    expect((await terminalForbidden).code).toBe("forbidden");
    expect(await openAttempt).toBe("rejected");

    const sceneOnly = await mintToken(server, {
      principal: { kind: "agent", name: "Scene Only Delegate", color: "#5f769f" },
      caps: ["scene:write"],
      padId: padX.id,
    });
    const escalationRequest = MintTokenRequestSchema.parse({
      principal: { kind: "human", name: "Escalated", color: "#b34141" },
      caps: ["terminal:write"],
      padId: padX.id,
    });
    const sceneOnlyEscalation = await fetchParsed(
      server,
      sceneOnly.token,
      "/api/tokens",
      HttpErrorSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(escalationRequest),
      },
    );
    expect(sceneOnlyEscalation.status).toBe(403);
    expect(sceneOnlyEscalation.body.error.code).toBe("forbidden");

    // This second minter has route access, so the 403 specifically proves attenuation
    // rather than merely the tokens:mint route guard tested above.
    const attenuatedMinter = await mintToken(server, {
      principal: { kind: "agent", name: "Attenuated Minter", color: "#a46b2b" },
      caps: ["tokens:mint", "scene:write"],
      padId: padX.id,
    });
    const attenuatedEscalation = await fetchParsed(
      server,
      attenuatedMinter.token,
      "/api/tokens",
      HttpErrorSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(escalationRequest),
      },
    );
    expect(attenuatedEscalation.status).toBe(403);
    expect(attenuatedEscalation.body.error.code).toBe("forbidden");

    const deniedMachine = await fetchParsed(
      server,
      scoped.token,
      "/api/machines",
      HttpErrorSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "denied-machine" }),
      },
    );
    expect(deniedMachine.status).toBe(403);
    expect(deniedMachine.body.error.code).toBe("forbidden");

    const machineMinter = await mintToken(server, {
      principal: { kind: "agent", name: "Machine Minter", color: "#2c8262" },
      caps: ["machines:mint"],
    });
    const allowedMachine = await fetchParsed(
      server,
      machineMinter.token,
      "/api/machines",
      MachineEnrollResponseSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "allowed-machine" }),
      },
    );
    expect(allowedMachine.status).toBe(200);
    expect(allowedMachine.body.machine.name).toBe("allowed-machine");

    const revokee = await mintToken(server, {
      principal: { kind: "human", name: "Revoked User", color: "#c14d7b" },
      caps: ["pads:read", "scene:write"],
      padId: padX.id,
    });
    const observerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Revocation Observer", color: "#3979ad" },
      caps: ["pads:read", "scene:write"],
      padId: padX.id,
    });
    const observer = await connect(server, {
      padId: padX.id,
      token: observerGrant.token,
      reconnect: false,
    });
    clients.push(observer);
    const revokedSocket = await rawSessionSocket(server);
    rawSockets.push(revokedSocket);
    revokedSocket.sendRaw(
      JSON.stringify({
        type: "join",
        padId: padX.id,
        token: revokee.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await waitFor(() => revokedSocket.frames.find((message) => message.type === "init"), 5_000, 20);
    const init = revokedSocket.frames.find((message) => message.type === "init");
    if (init?.type !== "init") throw new Error("revokee did not receive init");

    await ownerFetch(server, "/api/tokens/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(RevokeRequestSchema.parse({ principalId: revokee.principal.id })),
      responseSchema: OkResponseSchema,
    });
    try {
      revokedSocket.sendRaw(
        JSON.stringify({
          type: "doc_update",
          update: "AAA=",
        }),
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    const revokedClose = await waitFor(() => revokedSocket.closeInfo, 5_000, 20);
    expect(revokedClose.code).toBe(4403);
    expect(revokedClose.reason).toBe("revoked");
    const resynced = nextMessage(observer, "resync", 5_000);
    observer.requestResync();
    await resynced;
    expect(observer.elements.has("el-revoked-write")).toBe(false);

    const reconnectRevoked = await rawSessionSocket(server);
    rawSockets.push(reconnectRevoked);
    reconnectRevoked.sendRaw(
      JSON.stringify({
        type: "join",
        padId: padX.id,
        token: revokee.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const reconnectClose = await waitFor(() => reconnectRevoked.closeInfo, 5_000, 20);
    expect(reconnectClose.code).toBe(4403);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await Promise.all([closeRawSockets(rawSockets), stopProcesses(servers)]);
  }
}, 45_000);

test("revoking a viewer during PENDING terminal attach closes it before terminal delivery", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  const rawSockets: (AdversarialMachineSocket | AdversarialSessionSocket)[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "revoke during attach");
    const enrolled = await enrollMachine(server, "revoke-attach-machine");
    const machine = await rawMachineSocket(server);
    rawSockets.push(machine);
    machine.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "revoke-attach-machine",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const welcome = await waitFor(
      () => machine.frames.find((frame) => frame.type === "welcome"),
      5_000,
      20,
    );
    if (welcome.type !== "welcome") throw new Error("machine did not receive welcome");
    expect(welcome.machineId).toBe(enrolled.machineId);

    const openerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Attach Opener", color: "#3c6db0" },
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
      padId: pad.id,
    });
    const viewerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Attach Revokee", color: "#b84d68" },
      caps: ["pads:read"],
      padId: pad.id,
    });
    const opener = await connect(server, {
      padId: pad.id,
      token: openerGrant.token,
      reconnect: false,
    });
    clients.push(opener);

    const opening = opener.openTerminal({
      elementId: "el-revoke-attach",
      cols: 80,
      rows: 24,
      machineId: enrolled.machineId,
    });
    const create = await waitFor(
      () => machine.frames.find((frame) => frame.type === "create"),
      5_000,
      20,
    );
    if (create.type !== "create") throw new Error("machine did not receive create");
    machine.send({ type: "created", sessionId: create.sessionId });
    const session = await opening;

    const viewer = await rawSessionSocket(server);
    rawSockets.push(viewer);
    viewer.sendRaw(
      JSON.stringify({
        type: "join",
        padId: pad.id,
        token: viewerGrant.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await waitFor(() => viewer.frames.find((frame) => frame.type === "init"), 5_000, 20);
    const firstSnapshotRequestStart = machine.frames.length;
    viewer.sendRaw(JSON.stringify({ type: "terminal_attach", sessionId: session.id }));
    const firstSnapshotRequest = await waitFor(
      () =>
        machine.frames
          .slice(firstSnapshotRequestStart)
          .find((frame) => frame.type === "snapshot_request" && frame.sessionId === session.id),
      5_000,
      20,
    );
    if (firstSnapshotRequest.type !== "snapshot_request") {
      throw new Error("machine did not receive the viewer snapshot request");
    }
    expect(
      viewer.frames.filter(
        (frame) => frame.type === "terminal_snapshot" || frame.type === "terminal_output",
      ),
    ).toHaveLength(0);

    await ownerFetch(server, "/api/tokens/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(RevokeRequestSchema.parse({ principalId: viewerGrant.principal.id })),
      responseSchema: OkResponseSchema,
    });
    const revokedClose = await waitFor(() => viewer.closeInfo, 5_000, 20);
    expect(revokedClose.code).toBe(4403);
    expect(revokedClose.reason).toBe("revoked");
    expect(revokedClose.initiatedBy).toBe("REMOTE");
    const viewerFrameCountAtClose = viewer.frames.length;

    machine.send({
      type: "output",
      sessionId: session.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    const secondSnapshotRequestStart = machine.frames.length;
    machine.send({
      type: "snapshot",
      sessionId: session.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    opener.attachTerminal(session.id);
    const secondSnapshotRequest = await waitFor(
      () =>
        machine.frames
          .slice(secondSnapshotRequestStart)
          .find((frame) => frame.type === "snapshot_request" && frame.sessionId === session.id),
      5_000,
      20,
    );
    if (secondSnapshotRequest.type !== "snapshot_request") {
      throw new Error("machine did not receive the opener snapshot request");
    }
    expect(viewer.frames).toHaveLength(viewerFrameCountAtClose);
    const openerSnapshot = nextMessage(
      opener,
      "terminal_snapshot",
      5_000,
      (message) => message.sessionId === session.id && message.seq === 1,
    );
    machine.send({
      type: "snapshot",
      sessionId: session.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    expect((await openerSnapshot).seq).toBe(1);

    const openerOutput = nextMessage(
      opener,
      "terminal_output",
      5_000,
      (message) => message.sessionId === session.id && message.seq === 2,
    );
    machine.send({
      type: "output",
      sessionId: session.id,
      seq: 2,
      data: textToBase64("AFTER_REVOKE_2"),
    });
    expect((await openerOutput).seq).toBe(2);
    expect(viewer.frames).toHaveLength(viewerFrameCountAtClose);
    expect(
      viewer.frames.filter(
        (frame) => frame.type === "terminal_snapshot" || frame.type === "terminal_output",
      ),
    ).toHaveLength(0);

    const exited = nextMessage(
      opener,
      "session_event",
      5_000,
      (message) => message.sessionId === session.id && message.kind === "exited",
    );
    machine.send({ type: "exited", sessionId: session.id, exitCode: 0 });
    expect((await exited).kind).toBe("exited");
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await Promise.all([closeRawSockets(rawSockets), stopProcesses(servers)]);
  }
}, 45_000);

test("machine re-enroll is idempotent and rotation fences the live agent", async () => {
  const servers: TestServer[] = [];
  const rawSockets: AdversarialMachineSocket[] = [];
  try {
    const server = await startServer();
    servers.push(server);

    const enrolled = await ownerFetch(server, "/api/machines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "idempotent-machine" }),
      responseSchema: MachineEnrollResponseSchema,
    });
    if (enrolled.machineToken === undefined) {
      throw new Error("fresh enrollment must mint a token");
    }

    const live = await rawMachineSocket(server);
    rawSockets.push(live);
    live.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "idempotent-machine",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const welcome = await waitFor(
      () => live.frames.find((frame) => frame.type === "welcome"),
      5_000,
      20,
    );
    if (welcome.type !== "welcome") throw new Error("live machine did not receive welcome");
    expect(welcome.machineId).toBe(enrolled.machine.id);

    // Idempotent re-enroll: same row back, no token minted, live agent untouched.
    const reenrolled = await ownerFetch(server, "/api/machines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "idempotent-machine" }),
      responseSchema: MachineEnrollResponseSchema,
    });
    expect(reenrolled.machine.id).toBe(enrolled.machine.id);
    expect(reenrolled.machineToken).toBeUndefined();
    expect(live.closeInfo).toBeNull();

    const listed = await ownerFetch(server, "/api/machines", {
      responseSchema: MachinesResponseSchema,
    });
    expect(listed.machines.filter((machine) => machine.name === "idempotent-machine")).toHaveLength(
      1,
    );

    // Explicit rotation: new token, same row, old token revoked and its socket fenced.
    const rotated = await ownerFetch(server, "/api/machines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "idempotent-machine", rotateToken: true }),
      responseSchema: MachineEnrollResponseSchema,
    });
    expect(rotated.machine.id).toBe(enrolled.machine.id);
    if (rotated.machineToken === undefined) {
      throw new Error("rotation must mint a token");
    }
    expect(rotated.machineToken).not.toBe(enrolled.machineToken);

    const fenced = await waitFor(() => live.closeInfo, 5_000, 20);
    expect(fenced.code).toBe(4403);

    const stale = await rawMachineSocket(server);
    rawSockets.push(stale);
    stale.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "idempotent-machine",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const staleClose = await waitFor(() => stale.closeInfo, 5_000, 20);
    // The rotated machine row references only the new token, so the stale secret no longer
    // resolves to a machine at all: unauthorized (4401), not revoked-while-referenced (4403).
    expect(staleClose.code).toBe(4401);

    const fresh = await rawMachineSocket(server);
    rawSockets.push(fresh);
    fresh.send({
      type: "hello",
      token: rotated.machineToken,
      name: "idempotent-machine",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      sessions: [],
    });
    const freshWelcome = await waitFor(
      () => fresh.frames.find((frame) => frame.type === "welcome"),
      5_000,
      20,
    );
    if (freshWelcome.type !== "welcome") throw new Error("rotated token was not accepted");
    expect(freshWelcome.machineId).toBe(enrolled.machine.id);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    await Promise.all([closeRawSockets(rawSockets), stopProcesses(servers)]);
  }
}, 30_000);
