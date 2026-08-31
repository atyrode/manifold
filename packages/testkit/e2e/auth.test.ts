import { expect, test } from "bun:test";
import {
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  RevokeRequestSchema,
  RevokeResultSchema,
  TokenGrantSchema,
  PROTOCOL_VERSION,
} from "@manifold/protocol";
import { textToBase64, type SessionClient } from "@manifold/sdk";
import {
  callAction,
  connect,
  createPad,
  enrollMachine,
  mintToken,
  ownerAction,
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
      sessionFrame({
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
      sessionFrame({
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
    /*
      Minting is `core.access.mintToken` now, so the two escalation refusals below are
      DENIALS in a 200 envelope rather than 403 bodies — and the ladder makes them two
      different rungs, which is exactly the distinction the pair was written to draw.
      A capability the caller does not hold is refused by the door before the mechanism is
      reached (`forbidden`); authority the caller holds but may not pass on is refused by the
      mechanism (`refused`), on the real caller, with the wording the route used to return.
    */
    const sceneOnlyEscalation = await callAction(
      server,
      sceneOnly.token,
      "core.access.mintToken",
      escalationRequest,
    );
    expect(sceneOnlyEscalation.ok).toBe(false);
    if (sceneOnlyEscalation.ok) throw new Error("scene-only minting was not refused");
    expect(sceneOnlyEscalation.denial.rule).toBe("forbidden");
    expect(sceneOnlyEscalation.denial.message).toBe("tokens:mint capability required");

    // This second minter passes the cap rung, so its refusal specifically proves attenuation
    // rather than merely the `tokens:mint` guard tested above. It is also the case that keeps
    // `scope: "pad"` honest: a pad-scoped agent MAY mint inside its own container, so the
    // door lets it through to the mechanism instead of refusing it for its scope.
    const attenuatedMinter = await mintToken(server, {
      principal: { kind: "agent", name: "Attenuated Minter", color: "#a46b2b" },
      caps: ["tokens:mint", "scene:write"],
      padId: padX.id,
    });
    const attenuatedEscalation = await callAction(
      server,
      attenuatedMinter.token,
      "core.access.mintToken",
      escalationRequest,
    );
    expect(attenuatedEscalation.ok).toBe(false);
    if (attenuatedEscalation.ok) throw new Error("attenuated escalation was not refused");
    expect(attenuatedEscalation.denial.rule).toBe("refused");
    expect(attenuatedEscalation.denial.message).toBe("cannot mint capability terminal:write");

    // The same minter minting WITHIN its own authority and scope succeeds: the point of the
    // scoped carve-out is that delegation downward keeps working.
    const delegated = await callAction(
      server,
      attenuatedMinter.token,
      "core.access.mintToken",
      MintTokenRequestSchema.parse({
        principal: { kind: "agent", name: "Sub Agent", color: "#6b8fa4" },
        caps: ["scene:write"],
      }),
    );
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error("in-scope delegation was refused");
    expect(TokenGrantSchema.parse(delegated.result).padId).toBe(padX.id);

    // A pad-scoped token is refused at the SCOPE rung now instead of by the route's own
    // guard, which is the same answer wearing the ladder's vocabulary.
    const deniedMachine = await callAction(server, scoped.token, "core.machines.enroll", {
      name: "denied-machine",
    });
    expect(deniedMachine.ok).toBe(false);
    if (deniedMachine.ok) throw new Error("a scoped token enrolled a machine");
    expect(deniedMachine.denial.rule).toBe("forbidden");

    const machineMinter = await mintToken(server, {
      principal: { kind: "agent", name: "Machine Minter", color: "#2c8262" },
      caps: ["machines:mint"],
    });
    const allowedMachine = await callAction(server, machineMinter.token, "core.machines.enroll", {
      name: "allowed-machine",
    });
    expect(allowedMachine.ok).toBe(true);
    if (!allowedMachine.ok) throw new Error("machines:mint could not enroll a machine");
    expect(MachineEnrollResponseSchema.parse(allowedMachine.result).machine.name).toBe(
      "allowed-machine",
    );

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
      sessionFrame({
        type: "join",
        padId: padX.id,
        token: revokee.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await waitFor(() => revokedSocket.frames.find((message) => message.type === "init"), 5_000, 20);
    const init = revokedSocket.frames.find((message) => message.type === "init");
    if (init?.type !== "init") throw new Error("revokee did not receive init");

    const revocation = RevokeResultSchema.parse(
      await ownerAction(
        server,
        "core.access.revokeToken",
        RevokeRequestSchema.parse({ principalId: revokee.principal.id }),
      ),
    );
    // The count is the door's answer where the route said only `{ok:true}`: one token was
    // minted for this principal, so exactly one died, and the fence below closes its socket.
    expect(revocation.revoked).toBe(1);
    try {
      revokedSocket.sendRaw(
        sessionFrame({
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
      sessionFrame({
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

    // Both grants are workspace-scoped: attaching to a terminal means joining the
    // composition it lives in, and the server mints that container's id with the PTY.
    const openerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Attach Opener", color: "#3c6db0" },
      caps: ["pads:read", "terminal:spawn", "terminal:write"],
    });
    const viewerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Attach Revokee", color: "#b84d68" },
      caps: ["pads:read"],
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
    const openerHome = await connect(server, {
      padId: session.padId,
      token: openerGrant.token,
      reconnect: false,
    });
    clients.push(openerHome);

    const viewer = await rawSessionSocket(server);
    rawSockets.push(viewer);
    viewer.sendRaw(
      sessionFrame({
        type: "join",
        padId: session.padId,
        token: viewerGrant.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await waitFor(() => viewer.frames.find((frame) => frame.type === "init"), 5_000, 20);
    const firstSnapshotRequestStart = machine.frames.length;
    viewer.sendRaw(sessionFrame({ type: "terminal_attach", sessionId: session.id }));
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

    await ownerAction(
      server,
      "core.access.revokeToken",
      RevokeRequestSchema.parse({ principalId: viewerGrant.principal.id }),
    );
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
    openerHome.attachTerminal(session.id);
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
      openerHome,
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
      openerHome,
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
      openerHome,
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

    const enrolled = MachineEnrollResponseSchema.parse(
      await ownerAction(server, "core.machines.enroll", { name: "idempotent-machine" }),
    );
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
    const reenrolled = MachineEnrollResponseSchema.parse(
      await ownerAction(server, "core.machines.enroll", { name: "idempotent-machine" }),
    );
    expect(reenrolled.machine.id).toBe(enrolled.machine.id);
    expect(reenrolled.machineToken).toBeUndefined();
    expect(live.closeInfo).toBeNull();

    const listed = MachinesResponseSchema.parse(
      await ownerAction(server, "core.machines.list", {}),
    );
    expect(listed.machines.filter((machine) => machine.name === "idempotent-machine")).toHaveLength(
      1,
    );

    // Explicit rotation: new token, same row, old token revoked and its socket fenced.
    const rotated = MachineEnrollResponseSchema.parse(
      await ownerAction(server, "core.machines.enroll", {
        name: "idempotent-machine",
        rotateToken: true,
      }),
    );
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
