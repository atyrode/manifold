import { expect, test } from "bun:test";
import {
  HttpErrorSchema,
  MachineEnrollResponseSchema,
  MintTokenRequestSchema,
  OkResponseSchema,
  RevokeRequestSchema,
  PROTOCOL_VERSION,
} from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  mintToken,
  ownerFetch,
  rawSessionSocket,
  startServer,
  waitFor,
  type AdversarialSessionSocket,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, stopProcesses } from "./helpers.ts";

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

async function closeRawSockets(sockets: readonly AdversarialSessionSocket[]): Promise<void> {
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
          type: "scene_update",
          updateId: "revoked-write",
          epoch: init.epoch,
          baseRev: init.rev,
          elements: [{ id: "el-revoked-write", version: 1, versionNonce: 1, isDeleted: false }],
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
    expect(observer.scene.has("el-revoked-write")).toBe(false);

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
    await closeRawSockets(rawSockets);
    await stopProcesses(servers);
  }
}, 45_000);
