import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../../scripts/cdp.ts";
import { resolveWebDist } from "../../../scripts/gate-dist.ts";
import {
  ContainerResponseSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  MintTokenRequestSchema,
  RevokeRequestSchema,
  RevokeResultSchema,
  TokenGrantSchema,
  PROTOCOL_VERSION,
  type Principal,
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
  const servers: TestServer[] = [];
  const browser = new Browser();
  try {
    const productionDir = mkdtempSync(join(tmpdir(), "manifold-identity-production-"));
    const previewDir = mkdtempSync(join(tmpdir(), "manifold-identity-preview-"));
    directories.push(productionDir, previewDir);
    const production = await startServer({
      dataDir: productionDir,
      ownerKey: "a".repeat(64),
      env: { MANIFOLD_WEB_DIST: dist.distDir, MANIFOLD_PREVIEW_DOMAIN: "localhost" },
    });
    servers.push(production);
    const reservation = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
    const previewPort = reservation.port!;
    await reservation.stop(true);
    const previewOrigin = `http://preview.localhost:${previewPort}`;
    const preview = await startServer({
      dataDir: previewDir,
      port: previewPort,
      ownerKey: "b".repeat(64),
      env: {
        MANIFOLD_WEB_DIST: dist.distDir,
        MANIFOLD_PUBLIC_URL: previewOrigin,
        MANIFOLD_IDENTITY_AUTHORITY: production.httpUrl,
      },
    });
    servers.push(preview);
    // Administrative fixture requests stay on the loopback URL; only Chromium needs DNS
    // for the audience-qualified preview origin.
    const previewOwner = {
      httpUrl: `http://localhost:${preview.port}`,
      ownerKey: preview.ownerKey,
    };
    const content = ContainerResponseSchema.parse(
      await ownerAction(previewOwner, "core.index.createContainer", {
        name: "keep-preview-content",
      }),
    ).container;
    await browser.launch({ incognito: true });
    await browser.goto(`${production.httpUrl}/#key=${production.ownerKey}`);
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
      () =>
        browser.evaluate<boolean>(
          `location.origin === ${JSON.stringify(previewOrigin)} &&
         document.querySelector('.workspace') !== null &&
         localStorage.getItem('manifold.identity') !== null`,
        ),
      20_000,
      50,
    );
    const initial = await browser.evaluate<{ token: string; principal: Principal }>(
      "JSON.parse(localStorage.getItem('manifold.identity'))",
    );
    await browser.evaluate(`localStorage.setItem('identity-test-content', 'keep');
      localStorage.setItem('manifold.identity@https://elsewhere.example', 'keep-foreign');
      localStorage.setItem('manifold.ownerKey', ${JSON.stringify(preview.ownerKey)})`);
    await ownerAction(previewOwner, "core.access.revoke", { principalId: initial.principal.id });
    const refused = await fetch(`${previewOwner.httpUrl}/api/plugins`, {
      headers: { authorization: `Bearer ${initial.token}` },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "revoked" } });
    // Recovery must remain native even when its first attempt fails or is interrupted.
    // Keep the rejected register and cached owner key across a real browser Reload.
    for (const scenario of [
      { admission: "failed", expired: false },
      { admission: "interrupted", expired: false },
      { admission: "failed", expired: true },
    ]) {
      const stored = JSON.stringify(
        scenario.expired ? { ...initial, expiresInMs: 0, receivedAt: Date.now() } : initial,
      );
      await browser.evaluate(
        `localStorage.setItem('manifold.identity', ${JSON.stringify(stored)})`,
      );
      const unavailable = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `(() => {
          const fetch = window.fetch.bind(window);
          window.__protectedIdentityRequests = 0;
          window.fetch = async (input, init) => {
            const path = new URL(input, location.href).pathname;
            if (path === '/api/plugins') window.__protectedIdentityRequests++;
            if (path === '/api/identity/preview-start') {
              window.__admissionAttemptSeen = true;
              if (${JSON.stringify(scenario.admission)} === 'interrupted') {
                return Promise.withResolvers().promise;
              }
              return Response.json({ error: {
                code: 'unavailable', message: 'Admission temporarily unavailable'
              } }, { status: 503 });
            }
            return fetch(input, init);
          };
        })()`,
      });
      await browser.goto(`${previewOrigin}/`);
      for (const reload of [false, true]) {
        if (reload) {
          await browser.evaluate("window.__admissionAttemptSeen = false");
          await browser.send("Page.reload", {});
        }
        await waitFor(
          () =>
            browser.evaluate<boolean>(
              "window.__admissionAttemptSeen === true && document.querySelector('.gate-screen') !== null",
            ),
          10_000,
          50,
        );
        expect(
          await browser.evaluate<boolean>(
            "document.querySelector('#identity-name') === null && document.querySelector('.workspace') === null",
          ),
        ).toBe(true);
        expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
          stored,
        );
        expect(await browser.evaluate<string>("localStorage.getItem('manifold.ownerKey')")).toBe(
          preview.ownerKey,
        );
        if (scenario.expired) {
          expect(await browser.evaluate<number>("window.__protectedIdentityRequests")).toBe(0);
        }
      }
      await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: unavailable.result?.["identifier"],
      });
    }
    // No admission URL shortcut: reopening the ordinary preview must complete the same
    // production handoff after both rejected and locally expired recovery attempts.
    await browser.goto(`${previewOrigin}/`);
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `location.origin === ${JSON.stringify(previewOrigin)} &&
         document.querySelector('.workspace') !== null &&
         JSON.parse(localStorage.getItem('manifold.identity') || 'null')?.token !==
           ${JSON.stringify(initial.token)} &&
         localStorage.getItem('manifold.identity') !== null`,
        ),
      20_000,
      50,
    );
    expect(
      await browser.evaluate<boolean>(`(async () => {
      const identity = JSON.parse(localStorage.getItem('manifold.identity'));
      return (await fetch('/api/plugins', {
        headers: { authorization: 'Bearer ' + identity.token }
      })).ok;
    })()`),
    ).toBe(true);
    expect(
      await browser.evaluate<string[]>(
        `['identity-test-content', 'manifold.identity@https://elsewhere.example',
        'manifold.ownerKey'].map(key => localStorage.getItem(key))`,
      ),
    ).toEqual(["keep", "keep-foreign", preview.ownerKey]);
    expect(
      ContainerResponseSchema.parse(
        await ownerAction(previewOwner, "core.index.readContainer", { containerId: content.id }),
      ).container,
    ).toEqual(content);
    await browser.goto(`${production.httpUrl}/`);
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

test("explicit owner links recover rejected standalone identities without cached-owner fallback", async () => {
  const dist = resolveWebDist("manifold-owner-recovery-web-");
  const server = await startServer({ env: { MANIFOLD_WEB_DIST: dist.distDir } });
  try {
    for (const refusal of ["revoked", "expired"]) {
      const browser = new Browser();
      try {
        await browser.launch({ incognito: true });
        await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
          10_000,
          50,
        );
        await browser.typeInto("#identity-name", `standalone-${refusal}`);
        await browser.clickTestId("identity-enter");
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
          10_000,
          50,
        );
        if (refusal === "expired") {
          // Exercise a relative admission deadline without changing the server clock.
          await browser.evaluate(`(() => {
            const identity = JSON.parse(localStorage.getItem("manifold.identity"));
            identity.receivedAt = Date.now();
            identity.expiresInMs = 60_000;
            localStorage.setItem("manifold.identity", JSON.stringify(identity));
          })()`);
        }
        const original = await browser.evaluate<string>(
          "localStorage.getItem('manifold.identity')",
        );
        if (refusal === "revoked") {
          await ownerAction(server, "core.access.revoke", {
            principalId: (JSON.parse(original) as { principal: { id: string } }).principal.id,
          });
        } else {
          await browser.send("Page.addScriptToEvaluateOnNewDocument", {
            source: `(() => {
              const identity = JSON.parse(localStorage.getItem("manifold.identity"));
              const now = Date.now;
              Date.now = () => identity.receivedAt + identity.expiresInMs + 1;
              window.__restoreIdentityClock = () => { Date.now = now; };
            })()`,
          });
        }
        await browser.goto(`${server.httpUrl}/`);
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('.gate-screen') !== null"),
          10_000,
          50,
        );
        expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
          original,
        );
        expect(
          await browser.evaluate<boolean>("document.querySelector('#identity-name') === null"),
        ).toBe(true);
        await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
          10_000,
          50,
        );
        expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
          original,
        );
        await browser.evaluate("window.__restoreIdentityClock?.()");
        await browser.typeInto("#identity-name", `recovered-${refusal}`);
        await browser.clickTestId("identity-enter");
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
          10_000,
          50,
        );
        expect(
          await browser.evaluate<number>(`(async () => {
          const identity = JSON.parse(localStorage.getItem("manifold.identity"));
          return (await fetch("/api/plugins", {
            headers: { Authorization: "Bearer " + identity.token }
          })).status;
        })()`),
        ).toBe(200);
      } finally {
        await browser.close();
      }
    }
  } catch (error) {
    throw e2eFailure(error, [server]);
  } finally {
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
    dist.cleanup();
  }
}, 90_000);

test("browser identity survives non-auth failures and concurrent register replacement", async () => {
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
        () =>
          browser.evaluate<boolean>(
            "window.__identityFailureSeen === true && document.querySelector('.workspace') !== null",
          ),
        10_000,
        50,
      );
      expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
        original,
      );
      expect(
        await browser.evaluate<boolean>("document.querySelector('.gate-screen') === null"),
      ).toBe(true);
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
      () =>
        browser.evaluate<boolean>(
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
    const successor = await mintToken(server, {
      principal: { kind: "human", name: "successor-reviewer", color: "#8f4ac1" },
      caps: ["*"],
    });
    // Model the exact cross-tab interleaving: getItem snapshots the rejected bearer,
    // then another tab stores a successor before that old read returns. A subsequent
    // removeItem would erase the successor even though the old snapshot matched.
    const interleaved = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) {
          const snapshot = getItem.call(this, key);
          if (this === localStorage && key === 'manifold.identity' &&
              window.__replaceAfterIdentityRead) {
            window.__replaceAfterIdentityRead = false;
            localStorage.setItem(key, ${JSON.stringify(JSON.stringify(successor))});
            window.__identityReadInterleaved = true;
          }
          return snapshot;
        };
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          if (new URL(input, location.href).pathname === '/api/plugins') {
            const response = await fetch(input, init);
            if (response.status === 403) {
              const { promise, resolve } = Promise.withResolvers();
              window.__releaseIdentityResponse = () => {
                window.__replaceAfterIdentityRead = true;
                resolve();
              };
              await promise;
            }
            return response;
          }
          return fetch(input, init);
        };
      })()`,
    });
    await browser.send("Network.setBlockedURLs", {
      urls: ["*/api/bindings", "*/api/settings", "*/api/layout", "*/api/attendance"],
    });
    await ownerAction(server, "core.access.revoke", { principalId: replacement.principal.id });
    await browser.goto(`${server.httpUrl}/`);
    await waitFor(
      () => browser.evaluate<boolean>("typeof window.__releaseIdentityResponse === 'function'"),
      10_000,
      50,
    );
    await browser.evaluate("window.__releaseIdentityResponse()");
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          "window.__identityReadInterleaved === true && document.querySelector('.gate-screen') !== null",
        ),
      10_000,
      50,
    );
    expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
      JSON.stringify(successor),
    );
    expect(
      await browser.evaluate<boolean>("document.querySelector('#identity-name') === null"),
    ).toBe(true);
    await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: interleaved.result?.["identifier"],
    });
    await browser.send("Network.setBlockedURLs", { urls: [] });
    await browser.goto(`${server.httpUrl}/`);
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
      10_000,
      50,
    );
    expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
      JSON.stringify(successor),
    );

    // Parsing an earlier malformed snapshot must not delete a concurrent admission either.
    const malformed = await browser.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        localStorage.setItem('manifold.identity', '{');
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function(key) {
          const snapshot = getItem.call(this, key);
          if (this === localStorage && key === 'manifold.identity' && snapshot === '{') {
            localStorage.setItem(key, ${JSON.stringify(JSON.stringify(successor))});
            window.__malformedReadInterleaved = true;
          }
          return snapshot;
        };
      })()`,
    });
    await browser.goto(`${server.httpUrl}/`);
    await waitFor(
      () =>
        browser.evaluate<boolean>(
          `window.__malformedReadInterleaved === true &&
         document.querySelector('.gate-screen, .workspace') !== null`,
        ),
      10_000,
      50,
    );
    expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
      JSON.stringify(successor),
    );
    await browser.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: malformed.result?.["identifier"],
    });
    await browser.goto(`${server.httpUrl}/`);
    await waitFor(
      () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
      10_000,
      50,
    );
  } catch (error) {
    throw e2eFailure(error, [server]);
  } finally {
    await browser.close();
    await server.stop();
    dist.cleanup();
  }
}, 90_000);

test("installed module, stylesheet, and isolated-module refusals recover identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "manifold-auth-assets-"));
  const dist = resolveWebDist("manifold-auth-assets-web-");
  const server = await startServer({
    env: { MANIFOLD_PLUGIN_DEV_PATHS: "1", MANIFOLD_WEB_DIST: dist.distDir },
  });
  try {
    const pack = async (fixture: string) => {
      const process = Bun.spawn(
        [
          "bun",
          join(import.meta.dir, "../../plugin-kit/src/pack.ts"),
          join(import.meta.dir, "../../plugin-kit/test/fixtures", fixture),
          "--out",
          join(dir, `${fixture}.json`),
          ...(fixture === "sample" ? ["--self-contained"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (exit !== 0) throw new Error(`pack ${fixture} failed: ${stderr}`);
      return JSON.parse(stdout) as { file: string; sha256: string };
    };
    const [inRealm, isolated] = await Promise.all([pack("in-realm"), pack("sample")]);
    for (const scenario of [
      { name: "module", asset: "web.js", bundle: inRealm, hardened: false, replacement: false },
      {
        name: "stylesheet",
        asset: "styles.css",
        bundle: inRealm,
        hardened: false,
        replacement: false,
      },
      {
        name: "isolated-module",
        asset: "web.js",
        bundle: isolated,
        hardened: true,
        replacement: false,
      },
      {
        name: "isolated-replacement",
        asset: "web.js",
        bundle: isolated,
        hardened: true,
        replacement: true,
      },
    ]) {
      const browser = new Browser();
      let installed = false;
      try {
        await browser.launch();
        await browser.goto(`${server.httpUrl}/#key=${server.ownerKey}`);
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('#identity-name') !== null"),
          10_000,
          50,
        );
        await browser.typeInto("#identity-name", `asset-${scenario.name}`);
        await browser.clickTestId("identity-enter");
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
          10_000,
          50,
        );
        const principalId = await browser.evaluate<string>(
          "JSON.parse(localStorage.getItem('manifold.identity')).principal.id",
        );
        const container = await createContainer(server, `Asset ${scenario.name}`);
        expect(
          await browser.evaluate<boolean>(`(async () => {
            const identity = JSON.parse(localStorage.getItem("manifold.identity"));
            const headers = { Authorization: "Bearer " + identity.token, "Content-Type": "application/json" };
            const { layout } = await (await fetch("/api/layout", { headers })).json();
            layout.root.children.push("asset-counter");
            layout.root.ratios.push(1);
            layout["asset-counter"] = { id: "asset-counter", dir: null, ratios: [], children: [],
              ref: { kind: "panel", panelId: "example.counter.counter" } };
            return (await (await fetch("/api/actions/core.space.setLayout", {
              method: "POST", headers, body: JSON.stringify({ layout }),
            })).json()).ok;
          })()`),
        ).toBe(true);
        await browser.goto(`${server.httpUrl}/p/${container.id}`);
        await waitFor(
          () => browser.evaluate<boolean>("document.querySelector('.workspace') !== null"),
          10_000,
          50,
        );
        // Park, rather than fake, the asset request. Once it is waiting, no new JSON
        // request may race it to the first genuine authentication refusal.
        await browser.evaluate(`(() => {
          const original = window.fetch.bind(window);
          const target = ${JSON.stringify(`/api/plugins/example.counter/${scenario.asset}`)};
          window.__assetWaiting = false;
          window.__otherRequests = 0;
          window.__nativeAdmissionRequested = false;
          window.fetch = async (input, init) => {
            const path = new URL(input instanceof Request ? input.url : input, location.href).pathname;
            if (path === target && !window.__assetWaiting) {
              window.__assetWaiting = true;
              await new Promise(resolve => { window.__releaseAsset = resolve; });
              const response = await original(input, init);
              const body = await response.clone().json();
              window.__assetRefusal = { status: response.status, ...body.error };
              return response;
            }
            if (window.__assetWaiting) {
              const bearer = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("Authorization");
              if (window.__replacementToken && bearer === "Bearer " + window.__replacementToken) {
                return original(input, init);
              }
              if (path === "/api/identity/preview-config") window.__nativeAdmissionRequested = true;
              return new Promise(() => {});
            }
            window.__otherRequests++;
            try { return await original(input, init); }
            finally { window.__otherRequests--; }
          };
        })()`);
        await ownerAction(server, "engine.plugins.install", {
          source: scenario.bundle.file,
          sha256: scenario.bundle.sha256,
          hardened: scenario.hardened,
        });
        installed = true;
        await waitFor(
          () =>
            browser.evaluate<boolean>(
              "window.__assetWaiting === true && window.__otherRequests === 0",
            ),
          15_000,
          50,
        );
        await ownerAction(server, "core.access.revoke", { principalId });
        const replacement = scenario.replacement
          ? await mintToken(server, { principalId, caps: ["*"] })
          : null;
        if (replacement !== null) {
          await browser.evaluate(`localStorage.setItem("manifold.identity", ${JSON.stringify(JSON.stringify(replacement))});
            window.__replacementToken = ${JSON.stringify(replacement.token)}`);
        }
        await browser.evaluate("window.__releaseAsset()");
        await waitFor(
          () => browser.evaluate<boolean>("window.__assetRefusal !== undefined"),
          10_000,
          50,
        );
        expect(
          await browser.evaluate<{ status: number; code: string; message: string }>(
            "window.__assetRefusal",
          ),
        ).toEqual({
          status: 403,
          code: "forbidden",
          message: "revoked",
        });
        if (replacement === null) {
          await waitFor(
            () => browser.evaluate<boolean>("window.__nativeAdmissionRequested === true"),
            10_000,
            50,
          );
          expect(
            await browser.evaluate<boolean>(
              "document.querySelector('.workspace, #identity-name') === null",
            ),
          ).toBe(true);
        } else {
          await waitFor(
            () =>
              browser.evaluate<boolean>(
                "[...document.querySelectorAll('button')].some(button => button.textContent === 'Bump')",
              ),
            10_000,
            50,
          );
          await browser.evaluate(
            "[...document.querySelectorAll('button')].find(button => button.textContent === 'Bump').click()",
          );
          await waitFor(
            () => browser.evaluate<boolean>("document.body.textContent.includes('count 1')"),
            10_000,
            50,
          );
          expect(await browser.evaluate<string>("localStorage.getItem('manifold.identity')")).toBe(
            JSON.stringify(replacement),
          );
          expect(await browser.evaluate<boolean>("window.__nativeAdmissionRequested")).toBe(false);
        }
      } finally {
        await browser.close();
        if (installed) {
          await ownerAction(server, "engine.plugins.setEnabled", {
            id: "example.counter",
            enabled: false,
          });
          await ownerAction(server, "engine.plugins.uninstall", {
            id: "example.counter",
            purge: true,
          });
        }
      }
    }
  } catch (error) {
    throw e2eFailure(error, [server]);
  } finally {
    await server.stop();
    rmSync(server.dataDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    dist.cleanup();
  }
}, 120_000);
