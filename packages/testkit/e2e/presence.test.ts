import { expect, test } from "bun:test";
import { AttendanceResponseSchema, type Cursor, type Principal } from "@manifold/protocol";
import type { SessionClient } from "@manifold/sdk";
import {
  connect,
  createContainer,
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
    const container = await createContainer(server, "presence");
    const otherContainer = await createContainer(server, "other presence");
    const alice = await mintToken(server, {
      principal: { kind: "human", name: "Alice Presence", color: "#d13f62" },
      caps: ["containers:read", "scenes:write"],
      containerId: container.id,
    });
    const bob = await mintToken(server, {
      principal: { kind: "agent", name: "Bob Presence", color: "#3274d9" },
      caps: ["containers:read", "scenes:write"],
      containerId: container.id,
    });
    const charlie = await mintToken(server, {
      principal: { kind: "human", name: "Charlie Presence", color: "#2f9e44" },
      caps: ["containers:read"],
      containerId: otherContainer.id,
    });
    const clientA = await connect(server, { containerId: container.id, token: alice.token });
    const clientB = await connect(server, { containerId: container.id, token: bob.token });
    const clientC = await connect(server, { containerId: otherContainer.id, token: charlie.token });
    clients.push(clientA, clientB, clientC);

    await waitFor(() => clientA.attendance.size === 2 && clientB.attendance.size === 2, 5_000, 20);
    const attendanceAlice = clientB.attendance.get(alice.principal.id);
    const attendanceBob = clientB.attendance.get(bob.principal.id);
    if (attendanceAlice === undefined || attendanceBob === undefined) {
      throw new Error("both principals were not present in the roster");
    }
    expectPrincipal(attendanceAlice.principal, alice.principal);
    expectPrincipal(attendanceBob.principal, bob.principal);

    const crossRoomAttendance = await ownerFetch(server, "/api/attendance", {
      responseSchema: AttendanceResponseSchema,
    });
    expect(crossRoomAttendance.attendance).toContainEqual({
      containerId: container.id,
      principals: [alice.principal, bob.principal].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
    expect(crossRoomAttendance.attendance).toContainEqual({
      containerId: otherContainer.id,
      principals: [charlie.principal],
    });

    const scopedResponse = await fetch(`${server.httpUrl}/api/attendance`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(scopedResponse.status).toBe(200);
    const scopedPresence = AttendanceResponseSchema.parse(await scopedResponse.json());
    expect(scopedPresence.attendance).toEqual([
      {
        containerId: container.id,
        principals: [alice.principal, bob.principal].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      },
    ]);
    expect(attendanceAlice.connections).toBe(1);
    expect(attendanceBob.connections).toBe(1);

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
        const state = clientB.attendance.get(alice.principal.id);
        return (
          state?.payload.selection?.[0] === "el-selected" && state.payload.status === "working"
        );
      },
      2_000,
      20,
    );
    expect(clientB.attendance.get(alice.principal.id)?.payload).toMatchObject({
      selection: ["el-selected"],
      status: "working",
    });

    clientA.close();
    await waitFor(() => !clientB.attendance.has(alice.principal.id), 5_000, 20);

    const tabOne = await connect(server, { containerId: container.id, token: alice.token });
    const tabTwo = await connect(server, { containerId: container.id, token: alice.token });
    clients.push(tabOne, tabTwo);
    await waitFor(() => clientB.attendance.get(alice.principal.id)?.connections === 2, 5_000, 20);
    expect(
      [...clientB.attendance.values()].filter((entry) => entry.principal.id === alice.principal.id),
    ).toHaveLength(1);

    tabOne.close();
    await waitFor(() => clientB.attendance.get(alice.principal.id)?.connections === 1, 5_000, 20);
    expect(clientB.attendance.has(alice.principal.id)).toBe(true);
  } catch (error) {
    throw e2eFailure(error, servers);
  } finally {
    closeClients(clients);
    await stopProcesses(servers);
  }
}, 30_000);
