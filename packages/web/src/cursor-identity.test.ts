import { describe, expect, test } from "bun:test";
import {
  recordRemoteCursor,
  remoteCursorSocketId,
  stepRemoteCursors,
  type RemoteCursor,
} from "./cursor-identity.ts";

describe("connection-scoped cursor identity", () => {
  test("filters only this connection's echo and retains a same-principal sibling", () => {
    const cursors = new Map<string, RemoteCursor>();

    expect(
      recordRemoteCursor(cursors, { principalId: "owner", connId: "self", x: 1, y: 2 }, "self"),
    ).toBe(false);
    expect(
      recordRemoteCursor(cursors, { principalId: "owner", connId: "sibling", x: 3, y: 4 }, "self"),
    ).toBe(true);

    expect([...cursors]).toEqual([
      [
        remoteCursorSocketId("owner", "sibling"),
        {
          principalId: "owner",
          connId: "sibling",
          x: 3,
          y: 4,
          targetX: 3,
          targetY: 4,
          tool: "pointer",
        },
      ],
    ]);
  });

  test("retargets an existing cursor and advances it smoothly", () => {
    const cursors = new Map<string, RemoteCursor>();
    recordRemoteCursor(cursors, { principalId: "peer", connId: "socket", x: 0, y: 0 }, null);
    recordRemoteCursor(cursors, { principalId: "peer", connId: "socket", x: 100, y: 50 }, null);

    expect(cursors.get("peer:socket")).toMatchObject({
      x: 0,
      y: 0,
      targetX: 100,
      targetY: 50,
    });
    expect(stepRemoteCursors(cursors, 80)).toBe(true);
    expect(cursors.get("peer:socket")).toMatchObject({ x: 50, y: 25 });
  });

  test("connection ids produce distinct remote cursor ids for one principal", () => {
    expect(remoteCursorSocketId("owner", "one")).toBe("owner:one");
    expect(remoteCursorSocketId("owner", "two")).toBe("owner:two");
    expect(remoteCursorSocketId("owner", "one")).not.toBe(remoteCursorSocketId("owner", "two"));
  });
});
