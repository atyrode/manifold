import { describe, expect, test } from "bun:test";
import { recordRemoteCursor, remoteCursorSocketId, type RemoteCursor } from "./cursor-identity.ts";

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
        { principalId: "owner", connId: "sibling", x: 3, y: 4, tool: "pointer" },
      ],
    ]);
  });

  test("connection ids produce distinct remote cursor ids for one principal", () => {
    expect(remoteCursorSocketId("owner", "one")).toBe("owner:one");
    expect(remoteCursorSocketId("owner", "two")).toBe("owner:two");
    expect(remoteCursorSocketId("owner", "one")).not.toBe(remoteCursorSocketId("owner", "two"));
  });
});
