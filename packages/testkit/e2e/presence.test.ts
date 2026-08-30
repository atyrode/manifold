import { expect, test } from "bun:test";
import { PadPresenceResponseSchema, type Cursor, type Principal } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createPad,
  mintToken,
  ownerFetch,
  startServer,
  waitFor,
  type TestServer,
} from "../src/index.ts";
import { closeClients, e2eFailure, nextMessage, stopProcesses } from "./helpers.ts";

function expectPrincipal(actual: Principal, expected: Principal): void {
  expect(actual.id).toBe(expected.id);
  expect(actual.kind).toBe(expected.kind);
  expect(actual.name).toBe(expected.name);
  expect(actual.color).toBe(expected.color);
}

test("presence is principal-stamped, drop-tolerant, merged, and connection-counted", async () => {
  const servers: TestServer[] = [];
  const clients: SessionClient[] = [];
  try {
    const server = await startServer();
    servers.push(server);
    const pad = await createPad(server, "presence");
    const otherPad = await createPad(server, "other presence");
    const alice = await mintToken(server, {
      principal: { kind: "human", name: "Alice Presence", color: "#d13f62" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });
    const bob = await mintToken(server, {
      principal: { kind: "agent", name: "Bob Presence", color: "#3274d9" },
      caps: ["pads:read", "scene:write"],
      padId: pad.id,
    });
    const charlie = await mintToken(server, {
      principal: { kind: "human", name: "Charlie Presence", color: "#2f9e44" },
      caps: ["pads:read"],
      padId: otherPad.id,
    });
    const clientA = await connect(server, { padId: pad.id, token: alice.token });
    const clientB = await connect(server, { padId: pad.id, token: bob.token });
    const clientC = await connect(server, { padId: otherPad.id, token: charlie.token });
    clients.push(clientA, clientB, clientC);

    await waitFor(() => clientA.roster.size === 2 && clientB.roster.size === 2, 5_000, 20);
    const rosterAlice = clientB.roster.get(alice.principal.id);
    const rosterBob = clientB.roster.get(bob.principal.id);
    if (rosterAlice === undefined || rosterBob === undefined) {
      throw new Error("both principals were not present in the roster");
    }
    expectPrincipal(rosterAlice.principal, alice.principal);
    expectPrincipal(rosterBob.principal, bob.principal);

    const crossPadPresence = await ownerFetch(server, "/api/pad-presence", {
      responseSchema: PadPresenceResponseSchema,
    });
    expect(crossPadPresence.pads).toContainEqual({
      padId: pad.id,
      principals: [alice.principal, bob.principal].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    expect(crossPadPresence.pads).toContainEqual({
      padId: otherPad.id,
      principals: [charlie.principal],
    });

    const scopedResponse = await fetch(`${server.httpUrl}/api/pad-presence`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(scopedResponse.status).toBe(200);
    const scopedPresence = PadPresenceResponseSchema.parse(await scopedResponse.json());
    expect(scopedPresence.pads).toEqual([
      {
        padId: pad.id,
        principals: [alice.principal, bob.principal].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      },
    ]);
    expect(rosterAlice.connections).toBe(1);
    expect(rosterBob.connections).toBe(1);

    const receivedCursors: Cursor[] = [];
    const offCursor = clientB.on("cursor", (message) => {
      if (message.principalId !== alice.principal.id) return;
      receivedCursors.push({ x: message.x, y: message.y });
    });
    const firstCursor = nextMessage(
      clientB,
      "cursor",
      500,
      (message) => message.principalId === alice.principal.id,
    );
    for (let index = 0; index < 50; index += 1) {
      clientA.sendCursor(index, index * 2);
      // This integration contract explicitly requires real 10ms wire pacing; fake timers
      // cannot advance the independently running server's backpressure/throttle clock.
      if (index < 49) await Bun.sleep(10);
    }
    await firstCursor;
    await waitFor(
      () => {
        const latest = receivedCursors.at(-1);
        return latest?.x === 49 && latest.y === 98;
      },
      5_000,
      10,
    );
    offCursor();
    expect(receivedCursors.length).toBeGreaterThanOrEqual(1);
    for (let index = 1; index < receivedCursors.length; index += 1) {
      const previous = receivedCursors[index - 1];
      const current = receivedCursors[index];
      if (previous === undefined || current === undefined) throw new Error("cursor array changed");
      expect(current.x).toBeGreaterThan(previous.x);
      expect(current.y).toBeGreaterThan(previous.y);
    }
    expect(receivedCursors.at(-1)).toEqual({ x: 49, y: 98 });

    clientA.sendPresence({ selection: ["el-selected"] });
    clientA.sendPresence({ status: "working" });
    await waitFor(
      () => {
        const state = clientB.roster.get(alice.principal.id);
        return (
          state?.payload.selection?.[0] === "el-selected" && state.payload.status === "working"
        );
      },
      2_000,
      20,
    );
    expect(clientB.roster.get(alice.principal.id)?.payload).toMatchObject({
      selection: ["el-selected"],
      status: "working",
    });

    clientA.close();
    await waitFor(() => !clientB.roster.has(alice.principal.id), 5_000, 20);

    const tabOne = await connect(server, { padId: pad.id, token: alice.token });
    const tabTwo = await connect(server, { padId: pad.id, token: alice.token });
    clients.push(tabOne, tabTwo);
    await waitFor(() => clientB.roster.get(alice.principal.id)?.connections === 2, 5_000, 20);
    expect(
      [...clientB.roster.values()].filter((entry) => entry.principal.id === alice.principal.id),
    ).toHaveLength(1);

    tabOne.close();
    await waitFor(() => clientB.roster.get(alice.principal.id)?.connections === 1, 5_000, 20);
    expect(clientB.roster.has(alice.principal.id)).toBe(true);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await stopProcesses(servers);
  }
}, 30_000);
