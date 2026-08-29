import { expect, test } from "bun:test";
import { PROTOCOL_VERSION, type ServerMessage } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import { Y, createSceneDoc, decodeUpdate, readElements } from "@manifold/scene";
import {
  connect,
  createPad,
  enrollMachine,
  isMachineOnline,
  mintToken,
  startAgent,
  startServer,
  waitFor,
  type TestAgent,
  type TestServer,
} from "../src/index.ts";
import {
  rawSessionSocket,
  sessionFrame,
  type AdversarialSessionSocket,
} from "../src/adversarial.ts";
import {
  closeClients,
  e2eFailure,
  nextMessage,
  stopProcesses,
  terminalElement,
} from "./helpers.ts";

type InitMessage = Extract<ServerMessage, { type: "init" }>;

test("scene survives restart while presence and cursors do not", async () => {
  const servers: TestServer[] = [];
  const agents: TestAgent[] = [];
  const clients: SessionClient[] = [];
  let rejoined: AdversarialSessionSocket | null = null;
  try {
    const firstServer = await startServer();
    servers.push(firstServer);
    const pad = await createPad(firstServer, "presence restart isolation");
    const enrolled = await enrollMachine(firstServer, "presence-restart-agent");
    const agent = await startAgent({
      serverUrl: firstServer.url,
      machineToken: enrolled.machineToken,
      name: "presence-restart-agent",
    });
    agents.push(agent);

    const alice = await mintToken(firstServer, {
      principal: { kind: "human", name: "Presence Alice", color: "#d13f62" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });
    const observer = await mintToken(firstServer, {
      principal: { kind: "human", name: "Presence Observer", color: "#3274d9" },
      caps: ["pads:read"],
      padId: pad.id,
    });
    const aliceClient = await connect(firstServer, { padId: pad.id, token: alice.token });
    const observerClient = await connect(firstServer, { padId: pad.id, token: observer.token });
    clients.push(aliceClient, observerClient);

    const saved = nextMessage(aliceClient, "saved", 15_000);
    aliceClient.transact((tx) => tx.create(terminalElement("restart-scene")));
    await saved;

    const cursorSeen = nextMessage(
      observerClient,
      "cursor",
      5_000,
      (message) => message.principalId === alice.principal.id && message.x === 41,
    );
    aliceClient.sendPresence({
      cursor: { x: 41, y: 82 },
      selection: ["restart-scene"],
    });
    aliceClient.sendCursor(41, 82);
    await cursorSeen;
    await waitFor(
      () => {
        const payload = observerClient.roster.get(alice.principal.id)?.payload;
        return payload?.cursor?.x === 41 && payload.selection?.[0] === "restart-scene";
      },
      5_000,
      20,
    );

    await firstServer.stop("SIGTERM");
    closeClients(clients);
    const restarted = await startServer({
      dataDir: firstServer.dataDir,
      port: firstServer.port,
      ownerKey: firstServer.ownerKey,
    });
    servers.push(restarted);
    await waitFor(async () => isMachineOnline(restarted, enrolled.machineId), 20_000, 100);

    rejoined = await rawSessionSocket(restarted);
    rejoined.sendRaw(
      sessionFrame({
        type: "join",
        padId: pad.id,
        token: alice.token,
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
    const init = await waitFor(
      () => rejoined?.frames.find((frame): frame is InitMessage => frame.type === "init"),
      5_000,
      20,
    );

    const restored = createSceneDoc();
    Y.applyUpdate(restored, decodeUpdate(init.doc));
    expect(readElements(restored).has("restart-scene")).toBe(true);
    expect(init.roster).toHaveLength(1);
    expect(init.roster[0]?.principal.id).toBe(alice.principal.id);
    expect(init.roster[0]?.payload).toEqual({});
    expect(rejoined.frames.some((frame) => frame.type === "cursor")).toBe(false);
  } catch (error) {
    throw e2eFailure(error, [...servers, ...agents]);
  } finally {
    closeClients(clients);
    await rejoined?.close().catch(() => undefined);
    await stopProcesses([...servers, ...agents]);
  }
}, 60_000);
