import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import { loadConfig } from "../../server/src/config.ts";
import { startServer as startInProcessServer, type RunningServer } from "../../server/src/main.ts";
import type { StoredIdentity } from "../../web/src/api.ts";
import {
  ContainerResponseSchema,
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
  createContainer,
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
    const containerX = await createContainer(server, "auth x");
    const containerY = await createContainer(server, "auth y");

    const garbage = await rawSessionSocket(server);
    rawSockets.push(garbage);
    garbage.sendRaw(
      sessionFrame({
        type: "join",
        containerId: containerX.id,
        token: "garbage-token",
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const garbageClose = await waitFor(() => garbage.closeInfo, 5_000, 20);
    expect(garbageClose.code).toBe(4401);

    const scoped = await mintToken(server, {
      principal: { kind: "human", name: "Scoped User", color: "#8f4ac1" },
      caps: ["containers:read", "scenes:write"],
      containerId: containerX.id,
    });
    const wrongContainer = await rawSessionSocket(server);
    rawSockets.push(wrongContainer);
    wrongContainer.sendRaw(
      sessionFrame({
        type: "join",
        containerId: containerY.id,
        token: scoped.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const wrongContainerClose = await waitFor(() => wrongContainer.closeInfo, 5_000, 20);
    expect(wrongContainerClose.code).toBe(4403);

    const noTerminal = await connect(server, {
      containerId: containerX.id,
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
      caps: ["scenes:write"],
      containerId: containerX.id,
    });
    const escalationRequest = MintTokenRequestSchema.parse({
      principal: { kind: "human", name: "Escalated", color: "#b34141" },
      caps: ["terminals:write"],
      containerId: containerX.id,
    });
    /*
      Minting is `core.access.mint` now, so the two escalation refusals below are
      DENIALS in a 200 envelope rather than 403 bodies — and the ladder makes them two
      different rungs, which is exactly the distinction the pair was written to draw.
      A capability the caller does not hold is refused by the door before the mechanism is
      reached (`forbidden`); authority the caller holds but may not pass on is refused by the
      mechanism (`refused`), on the real caller, with the wording the route used to return.
    */
    const sceneOnlyEscalation = await callAction(
      server,
      sceneOnly.token,
      "core.access.mint",
      escalationRequest,
    );
    expect(sceneOnlyEscalation.ok).toBe(false);
    if (sceneOnlyEscalation.ok) throw new Error("scene-only minting was not refused");
    expect(sceneOnlyEscalation.denial.rule).toBe("forbidden");
    expect(sceneOnlyEscalation.denial.message).toBe("tokens:mint capability required");

    // This second minter passes the cap rung, so its refusal specifically proves attenuation
    // rather than merely the `tokens:mint` guard tested above. It is also the case that keeps
    // `scope: "container"` honest: a container-scoped agent MAY mint inside its own container, so the
    // door lets it through to the mechanism instead of refusing it for its scope.
    const attenuatedMinter = await mintToken(server, {
      principal: { kind: "agent", name: "Attenuated Minter", color: "#a46b2b" },
      caps: ["tokens:mint", "scenes:write"],
      containerId: containerX.id,
    });
    const attenuatedEscalation = await callAction(
      server,
      attenuatedMinter.token,
      "core.access.mint",
      escalationRequest,
    );
    expect(attenuatedEscalation.ok).toBe(false);
    if (attenuatedEscalation.ok) throw new Error("attenuated escalation was not refused");
    expect(attenuatedEscalation.denial.rule).toBe("refused");
    expect(attenuatedEscalation.denial.message).toBe("cannot mint capability terminals:write");

    // The same minter minting WITHIN its own authority and scope succeeds: the point of the
    // scoped carve-out is that delegation downward keeps working.
    const delegated = await callAction(
      server,
      attenuatedMinter.token,
      "core.access.mint",
      MintTokenRequestSchema.parse({
        principal: { kind: "agent", name: "Sub Agent", color: "#6b8fa4" },
        caps: ["scenes:write"],
      }),
    );
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error("in-scope delegation was refused");
    expect(TokenGrantSchema.parse(delegated.result).containerId).toBe(containerX.id);

    // A container-scoped token is refused at the SCOPE rung now instead of by the route's own
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
      caps: ["containers:read", "scenes:write"],
      containerId: containerX.id,
    });
    const observerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Revocation Observer", color: "#3979ad" },
      caps: ["containers:read", "scenes:write"],
      containerId: containerX.id,
    });
    const observer = await connect(server, {
      containerId: containerX.id,
      token: observerGrant.token,
      reconnect: false,
    });
    clients.push(observer);
    const revokedSocket = await rawSessionSocket(server);
    rawSockets.push(revokedSocket);
    revokedSocket.sendRaw(
      sessionFrame({
        type: "join",
        containerId: containerX.id,
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
        "core.access.revoke",
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
        containerId: containerX.id,
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
    const container = await createContainer(server, "revoke during attach");
    const enrolled = await enrollMachine(server, "revoke-attach-machine");
    const machine = await rawMachineSocket(server);
    rawSockets.push(machine);
    machine.send({
      type: "hello",
      token: enrolled.machineToken,
      name: "revoke-attach-machine",
      agentVersion: "testkit",
      protocolVersion: PROTOCOL_VERSION,
      terminalExecution: "unconfined",
      terminals: [],
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
      caps: ["containers:read", "terminals:spawn", "terminals:write"],
    });
    const viewerGrant = await mintToken(server, {
      principal: { kind: "human", name: "Attach Revokee", color: "#b84d68" },
      caps: ["containers:read"],
    });
    const opener = await connect(server, {
      containerId: container.id,
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
    machine.send({ type: "created", terminalId: create.terminalId });
    const terminal = await opening;
    const openerHome = await connect(server, {
      containerId: terminal.containerId,
      token: openerGrant.token,
      reconnect: false,
    });
    clients.push(openerHome);

    const viewer = await rawSessionSocket(server);
    rawSockets.push(viewer);
    viewer.sendRaw(
      sessionFrame({
        type: "join",
        containerId: terminal.containerId,
        token: viewerGrant.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    await waitFor(() => viewer.frames.find((frame) => frame.type === "init"), 5_000, 20);
    const firstSnapshotRequestStart = machine.frames.length;
    viewer.sendRaw(sessionFrame({ type: "terminal_attach", terminalId: terminal.id }));
    const firstSnapshotRequest = await waitFor(
      () =>
        machine.frames
          .slice(firstSnapshotRequestStart)
          .find((frame) => frame.type === "snapshot_request" && frame.terminalId === terminal.id),
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
      "core.access.revoke",
      RevokeRequestSchema.parse({ principalId: viewerGrant.principal.id }),
    );
    const revokedClose = await waitFor(() => viewer.closeInfo, 5_000, 20);
    expect(revokedClose.code).toBe(4403);
    expect(revokedClose.reason).toBe("revoked");
    expect(revokedClose.initiatedBy).toBe("REMOTE");
    const viewerFrameCountAtClose = viewer.frames.length;

    machine.send({
      type: "output",
      terminalId: terminal.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    const secondSnapshotRequestStart = machine.frames.length;
    machine.send({
      type: "snapshot",
      terminalId: terminal.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    openerHome.attachTerminal(terminal.id);
    const secondSnapshotRequest = await waitFor(
      () =>
        machine.frames
          .slice(secondSnapshotRequestStart)
          .find((frame) => frame.type === "snapshot_request" && frame.terminalId === terminal.id),
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
      (message) => message.terminalId === terminal.id && message.seq === 1,
    );
    machine.send({
      type: "snapshot",
      terminalId: terminal.id,
      seq: 1,
      data: textToBase64("AFTER_REVOKE_1"),
    });
    expect((await openerSnapshot).seq).toBe(1);

    const openerOutput = nextMessage(
      openerHome,
      "terminal_output",
      5_000,
      (message) => message.terminalId === terminal.id && message.seq === 2,
    );
    machine.send({
      type: "output",
      terminalId: terminal.id,
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

    const departed = nextMessage(
      openerHome,
      "terminal_event",
      5_000,
      (message) => message.terminalId === terminal.id && message.kind === "parked",
    );
    machine.send({ type: "exited", terminalId: terminal.id, exitCode: 7 });
    expect((await departed).kind).toBe("parked");
    await waitFor(() => !openerHome.terminals.has(terminal.id), 5_000, 20);
    expect(viewer.frames).toHaveLength(viewerFrameCountAtClose);
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
      terminalExecution: "unconfined",
      terminals: [],
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
      terminalExecution: "unconfined",
      terminals: [],
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
      terminalExecution: "unconfined",
      terminals: [],
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

test("a revoked preview browser identity returns through production admission without clearing content", async () => {
  const dist = resolveWebDist("manifold-identity-web-");
  const directories: string[] = [];
  const servers: RunningServer[] = [];
  const browser = new Browser();
  try {
    const productionDir = mkdtempSync(join(tmpdir(), "manifold-identity-production-"));
    const previewDir = mkdtempSync(join(tmpdir(), "manifold-identity-preview-"));
    directories.push(productionDir, previewDir);
    const productionConfig = loadConfig({
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: productionDir,
      MANIFOLD_OWNER_KEY: "a".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_WEB_DIST: dist.distDir,
      MANIFOLD_PREVIEW_DOMAIN: "localhost",
    });
    const production = await startInProcessServer({ config: productionConfig, announce: false });
    servers.push(production);
    const previewConfig = loadConfig({
      MANIFOLD_PORT: "0",
      MANIFOLD_DATA_DIR: previewDir,
      MANIFOLD_OWNER_KEY: "b".repeat(64),
      MANIFOLD_SPAWN_AGENT: "0",
      MANIFOLD_WEB_DIST: dist.distDir,
      MANIFOLD_IDENTITY_AUTHORITY: production.publicUrl,
    });
    const preview = await startInProcessServer({ config: previewConfig, announce: false });
    servers.push(preview);
    previewConfig.publicUrl = `http://preview.localhost:${preview.port}`;
    const previewOrigin = previewConfig.publicUrl;
    // Administrative fixture requests stay on the loopback URL; only Chromium needs DNS
    // for the audience-qualified preview origin.
    const previewOwner = { httpUrl: preview.publicUrl, ownerKey: previewConfig.ownerKey };
    const content = ContainerResponseSchema.parse(
      await ownerAction(previewOwner, "core.index.createContainer", { name: "keep-preview-content" }),
    ).container;
    await browser.launch({ incognito: true });
    await browser.goto(`${production.publicUrl}/#key=${productionConfig.ownerKey}`);
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
      10_000,
      50,
    );
    await browser.typeInto("#identity-name", "preview-reviewer");
    await browser.clickTestId("identity-enter");
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
      10_000,
      50,
    );
    const productionIdentity = await browser.evaluate<string>(
      "localStorage.getItem('manifold.identity')",
    );
    await browser.goto(`${previewOrigin}/`);
    await waitFor(
      () => browser.evaluate<boolean>(
        `location.origin === ${JSON.stringify(previewOrigin)} &&
         document.querySelector('.workspace') !== null &&
         localStorage.getItem('manifold.identity') !== null`,
      ),
      20_000,
      50,
    );
    const initial = await browser.evaluate<StoredIdentity>(
      "JSON.parse(localStorage.getItem('manifold.identity'))",
    );
    await browser.evaluate(`localStorage.setItem('identity-test-content', 'keep');
      localStorage.setItem('manifold.identity@https://elsewhere.example', 'keep-foreign');
      localStorage.setItem('manifold.ownerKey', ${JSON.stringify(previewConfig.ownerKey)})`);
    await ownerAction(previewOwner, "core.access.revoke", { principalId: initial.principal.id });
    const refused = await fetch(`${preview.publicUrl}/api/plugins`, {
      headers: { authorization: `Bearer ${initial.token}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "revoked" } });
    // No storage edits or admission URL shortcut: reopening the ordinary preview is the
    // reported broken path, with a locally unexpired but server-revoked credential.
    await browser.goto(`${previewOrigin}/`);
    await waitFor(
      () => browser.evaluate<boolean>(
        `location.origin === ${JSON.stringify(previewOrigin)} &&
         document.querySelector('.workspace') !== null &&
         JSON.parse(localStorage.getItem('manifold.identity') || 'null')?.token !==
           ${JSON.stringify(initial.token)} &&
         localStorage.getItem('manifold.identity') !== null`,
      ),
      20_000,
      50,
    );
    expect(await browser.evaluate<boolean>(`(async () => {
      const identity = JSON.parse(localStorage.getItem('manifold.identity'));
      return (await fetch('/api/plugins', {
        headers: { authorization: 'Bearer ' + identity.token }
      })).ok;
    })()`)).toBe(true);
    expect(await browser.evaluate<string[]>(
      `['identity-test-content', 'manifold.identity@https://elsewhere.example',
        'manifold.ownerKey'].map(key => localStorage.getItem(key))`,
    )).toEqual(["keep", "keep-foreign", previewConfig.ownerKey]);
    expect(ContainerResponseSchema.parse(
      await ownerAction(previewOwner, "core.index.readContainer", { containerId: content.id }),
    ).container).toEqual(content);
    await browser.goto(`${production.publicUrl}/`);
    expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
      productionIdentity,
    );
  } finally {
    await browser.close();
    for (const server of servers.reverse()) await server.stop();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    dist.cleanup();
  }
}, 90_000);

test("browser identity survives non-auth failures and a delayed refusal for a replaced token", async () => {
  const dist = resolveWebDist("manifold-identity-race-web-");
  const server = await startServer({ env: { MANIFOLD_WEB_DIST: dist.distDir } });
  const browser = new Browser();
  try {
    await browser.launch({ incognito: true });
    await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
      10_000,
      50,
    );
    await browser.typeInto("#identity-name", "identity-race");
    await browser.clickTestId("identity-enter");
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
      10_000,
      50,
    );
    const original = await browser.evaluate<string>("localStorage.getItem('manifold.identity')");
    const originalPrincipalId = await browser.evaluate<string>(
      "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
    );
    for (const failure of [
      { status: 403, code: "forbidden", message: "containers:read capability required" },
      { status: 503, code: "forbidden", message: "revoked" },
      { status: 0, code: "", message: "network unavailable" },
    ]) {
      const injected = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const fetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            if (new URL(input, location.href).pathname === '/api/plugins') {
              const failure = ${JSON.stringify(failure)};
              window.__identityFailureSeen = true;
              if (failure.status === 0) throw new TypeError(failure.message);
              return Response.json({ error: {
                code: failure.code, message: failure.message
              } }, { status: failure.status });
            }
            return fetch(input, init);
          };
        })()`,
      });
      await browser.goto(`${server.httpUrl}/`);
      await waitFor(
        () => browser.evaluate<boolean>(
          "window.__identityFailureSeen === true && document.querySelector('.workspace') !== null",
        ),
        10_000,
        50,
      );
      expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
        original,
      );
      expect(await browser.evaluate<boolean>("document.querySelector('.gate-screen') === null")).toBe(
        true,
      );
      await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: injected.result?.["identifier"],
      });
    }
    const replacement = await mintToken(server, {
      principal: { kind: "human", name: "replacement-reviewer", color: "#8f4ac1" },
      caps: ["*"],
    });
    // The request really uses the old token. Delay the server's real revoked response
    // until a replacement has been installed, without firing a storage event: the
    // rejection boundary must check the register, not trust a stale React closure.
    const delayed = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          if (new URL(input, location.href).pathname === '/api/plugins') {
            const response = await fetch(input, init);
            if (response.status === 403) {
              const { promise, resolve } = Promise.withResolvers();
              window.__releaseIdentityResponse = resolve;
              await promise;
              return response;
            }
            if (response.ok) window.__replacementRosterLoaded = true;
            return response;
          }
          return fetch(input, init);
        };
      })()`,
    });
    // Other boot reads must not race the one deliberately delayed refusal.
    await browser.send("Network.enable", {});
    await browser.send("Network.setBlockedURLs", {
      urls: ["*/api/bindings", "*/api/settings", "*/api/layout", "*/api/attendance"],
    });
    await ownerAction(server, "core.access.revoke", {
      principalId: originalPrincipalId,
    });
    await browser.goto(`${server.httpUrl}/`);
    await waitFor(
      () => browser.evaluate<boolean>("typeof window.__releaseIdentityResponse === 'function'"),
      10_000,
      50,
    );
    await browser.evaluate(`localStorage.setItem('manifold.identity', ${JSON.stringify(JSON.stringify(replacement))});
      window.__releaseIdentityResponse()`);
    await browser.send("Network.setBlockedURLs", { urls: [] });
    await waitFor(
      () => browser.evaluate<boolean>(
        "window.__replacementRosterLoaded === true && document.querySelector('.workspace') !== null",
      ),
      10_000,
      50,
    );
    expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
      JSON.stringify(replacement),
    );
    expect(await browser.evaluate<boolean>("document.querySelector('.gate-screen') === null")).toBe(
      true,
    );
    await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: delayed.result?.["identifier"],
    });
  } catch (error) {
    throw e2eFailure(error, [server]);
  } finally {
    await browser.close();
    await server.stop();
    dist.cleanup();
  }
}, 90_000);
