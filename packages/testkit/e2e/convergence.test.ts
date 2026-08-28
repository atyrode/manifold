import { expect, test } from "bun:test";
import type { SceneElement } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  mintToken,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import {
  closeClients,
  e2eFailure,
  nextMessage,
  sceneContentHash,
  sortedScene,
  stopProcesses,
  terminalElement,
} from "./helpers.ts";

test("Yjs clients converge through field conflicts, resume, recreate, and restart", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  let server: TestServer | null = null;
  try {
    server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "convergence");
    const alice = await mintToken(server, {
      principal: { kind: "human", name: "Alice", color: "#aa3355" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });
    const bob = await mintToken(server, {
      principal: { kind: "human", name: "Bob", color: "#3366cc" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });

    const clientA = await connect(server, { padId: pad.id, token: alice.token });
    const clientB = await connect(server, { padId: pad.id, token: bob.token });
    clients.push(clientA, clientB);

    const initial: SceneElement[] = Array.from({ length: 40 }, (_, index) =>
      terminalElement(`el-${index}`, {
        zIndex: index,
        x: index * 17,
        y: index * 11,
        width: 120 + index,
        height: 60,
      }),
    );
    clientA.transact((tx) => {
      for (const element of initial) tx.create(element);
    });
    await waitFor(() => clientB.elements.size === 40, 10_000, 20);
    expect(sortedScene(clientB)).toEqual(sortedScene(clientA));

    // Independent fields are separate Y.Map keys: neither concurrent edit may be lost.
    clientA.transact((tx) => {
      tx.patch("el-0", { x: 400 });
    });
    clientB.transact((tx) => {
      tx.patch("el-0", { width: 300 });
    });
    await waitFor(
      () =>
        clientA.elements.get("el-0")?.x === 400 &&
        clientB.elements.get("el-0")?.x === 400 &&
        clientA.elements.get("el-0")?.width === 300 &&
        clientB.elements.get("el-0")?.width === 300,
      10_000,
      20,
    );

    // Same-key conflicts choose one CRDT winner, identically on every replica.
    clientA.transact((tx) => {
      tx.patch("el-0", { y: 111 });
    });
    clientB.transact((tx) => {
      tx.patch("el-0", { y: 222 });
    });
    await waitFor(
      () => {
        const left = clientA.elements.get("el-0")?.y;
        const right = clientB.elements.get("el-0")?.y;
        return left === right && (left === 111 || left === 222);
      },
      10_000,
      20,
    );
    expect(sortedScene(clientB)).toEqual(sortedScene(clientA));

    const lastEpoch = clientB.epoch;
    const lastRev = clientB.rev;
    clientB.close();
    clientA.transact((tx) => {
      for (let index = 40; index < 50; index += 1) {
        tx.create(terminalElement(`el-${index}`));
      }
    });
    await waitFor(() => clientA.elements.size === 50, 10_000, 20);

    const resumedB = await connect(server, {
      padId: pad.id,
      token: bob.token,
      lastEpoch,
      lastRev,
    });
    clients.push(resumedB);
    await waitFor(() => resumedB.elements.size === 50, 10_000, 20);
    expect(sortedScene(resumedB)).toEqual(sortedScene(clientA));

    clientA.transact((tx) => {
      tx.remove("el-0");
    });
    await waitFor(
      () => !clientA.elements.has("el-0") && !resumedB.elements.has("el-0"),
      10_000,
      20,
    );
    resumedB.transact((tx) => {
      tx.create(terminalElement("el-0", { x: 512, zIndex: tx.nextZIndex() }));
    });
    await waitFor(
      () => clientA.elements.get("el-0")?.x === 512 && resumedB.elements.get("el-0")?.x === 512,
      10_000,
      20,
    );

    const savedAfterRev = clientA.rev;
    const saved = nextMessage(clientA, "saved", 15_000, (message) => message.rev > savedAfterRev);
    clientA.transact((tx) => {
      tx.create(terminalElement("el-durable"));
    });
    await waitFor(() => resumedB.elements.has("el-durable"), 10_000, 20);
    await saved;
    const expectedScene = sortedScene(clientA);
    const expectedHash = await sceneContentHash(expectedScene);
    const expectedEpoch = clientA.epoch;
    expect(expectedEpoch).not.toBe("");

    closeClients(clients);
    await server.stop();
    const restarted = await startServer({
      dataDir: server.dataDir,
      port: server.port,
      ownerKey: server.ownerKey,
    });
    server = restarted;
    servers.push(restarted);
    const afterRestart = await connect(restarted, {
      padId: pad.id,
      token: alice.token,
      reconnect: false,
    });
    clients.push(afterRestart);
    expect(afterRestart.epoch).toBe(expectedEpoch);
    expect(sortedScene(afterRestart)).toEqual(expectedScene);
    expect(await sceneContentHash(afterRestart.elements.values())).toBe(expectedHash);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await stopProcesses(servers);
  }
}, 60_000);
