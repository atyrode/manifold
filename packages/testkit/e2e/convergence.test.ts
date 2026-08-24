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
  sceneElement,
  sceneContentHash,
  sortedScene,
  stopProcesses,
} from "./helpers.ts";

test("scene clients converge through conflicts, resume, tombstones, resurrection, and restart", async () => {
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
    if (clientA.self === null || clientB.self === null)
      throw new Error("clients initialized without self");

    const initial: SceneElement[] = Array.from({ length: 40 }, (_, index) => ({
      ...sceneElement(`el-${index}`),
      index: `a${index.toString().padStart(3, "0")}`,
      x: index * 17,
      y: index * 11,
      width: 120 + index,
      height: 60,
      strokeColor: index % 2 === 0 ? "#1f2937" : "#7c3aed",
      backgroundColor: index % 3 === 0 ? "#fef3c7" : "transparent",
    }));
    expect(clientA.updateScene(initial)).not.toBeNull();
    await waitFor(() => clientB.scene.size === 40 && clientB.rev === clientA.rev, 10_000, 20);
    expect(sortedScene(clientB)).toEqual(sortedScene(clientA));

    let winningBy: string | null = null;
    const offApplied = clientA.on("scene_applied", (message) => {
      if (message.elements.some((element) => element.id === "el-0" && element.versionNonce === 3)) {
        winningBy = message.by;
      }
    });
    const current = clientA.scene.get("el-0");
    if (current === undefined) throw new Error("missing conflict seed element");
    expect(
      clientA.updateScene([{ ...current, version: 2, versionNonce: 5, owner: clientA.self.id }]),
    ).not.toBeNull();
    expect(
      clientB.updateScene([{ ...current, version: 2, versionNonce: 3, owner: clientB.self.id }]),
    ).not.toBeNull();
    await waitFor(
      () =>
        clientA.scene.get("el-0")?.versionNonce === 3 &&
        clientB.scene.get("el-0")?.versionNonce === 3 &&
        clientA.rev === clientB.rev &&
        winningBy === clientB.self?.id,
      10_000,
      20,
    );
    offApplied();
    expect(clientA.scene.get("el-0")?.owner).toBe(clientB.self.id);
    expect(sortedScene(clientB)).toEqual(sortedScene(clientA));

    const lastEpoch = clientB.epoch;
    const lastRev = clientB.rev;
    clientB.close();
    const offlineEdits = Array.from({ length: 10 }, (_, index) => sceneElement(`el-${index + 40}`));
    expect(clientA.updateScene(offlineEdits)).not.toBeNull();
    await waitFor(() => clientA.scene.size === 50, 10_000, 20);

    const resumedB = await connect(server, {
      padId: pad.id,
      token: bob.token,
      lastEpoch,
      lastRev,
    });
    clients.push(resumedB);
    await waitFor(() => resumedB.scene.size === 50 && resumedB.rev === clientA.rev, 10_000, 20);
    expect(sortedScene(resumedB)).toEqual(sortedScene(clientA));

    const conflictWinner = clientA.scene.get("el-0");
    if (conflictWinner === undefined) throw new Error("conflict winner disappeared");
    expect(
      clientA.updateScene([{ ...conflictWinner, version: 3, versionNonce: 9, isDeleted: true }]),
    ).not.toBeNull();
    await waitFor(() => resumedB.scene.get("el-0")?.isDeleted === true, 10_000, 20);
    expect(resumedB.scene.get("el-0")?.version).toBe(3);

    const tombstone = clientA.scene.get("el-0");
    if (tombstone === undefined) throw new Error("tombstone disappeared");
    expect(
      clientA.updateScene([{ ...tombstone, version: 4, versionNonce: 8, isDeleted: false }]),
    ).not.toBeNull();
    await waitFor(
      () =>
        resumedB.scene.get("el-0")?.isDeleted === false &&
        resumedB.scene.get("el-0")?.version === 4,
      10_000,
      20,
    );

    const savedAtRev = clientA.rev + 1;
    const saved = nextMessage(clientA, "saved", 15_000, (message) => message.rev >= savedAtRev);
    expect(clientA.updateScene([sceneElement("el-durable")])).not.toBeNull();
    await waitFor(() => clientA.rev >= savedAtRev && resumedB.scene.has("el-durable"), 10_000, 20);
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
    expect(await sceneContentHash(afterRestart.scene.values())).toBe(expectedHash);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await stopProcesses(servers);
  }
}, 60_000);
