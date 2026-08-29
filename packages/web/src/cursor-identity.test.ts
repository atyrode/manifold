import { describe, expect, test } from "bun:test";
import { CURSOR_HALF_LIFE_MS } from "./interpolate.ts";
import {
  cursorLabel,
  pruneRemoteCursors,
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
    expect(stepRemoteCursors(cursors, CURSOR_HALF_LIFE_MS)).toBe(true);
    expect(cursors.get("peer:socket")).toMatchObject({ x: 50, y: 25 });
  });

  test("connection ids produce distinct remote cursor ids for one principal", () => {
    expect(remoteCursorSocketId("owner", "one")).toBe("owner:one");
    expect(remoteCursorSocketId("owner", "two")).toBe("owner:two");
    expect(remoteCursorSocketId("owner", "one")).not.toBe(remoteCursorSocketId("owner", "two"));
  });

  test("prunes a closed tab's cursor while a sibling tab of the same principal stays", () => {
    const cursors = new Map<string, RemoteCursor>();
    recordRemoteCursor(cursors, { principalId: "owner", connId: "tab-1", x: 1, y: 1 }, null);
    recordRemoteCursor(cursors, { principalId: "owner", connId: "tab-2", x: 2, y: 2 }, null);
    recordRemoteCursor(cursors, { principalId: "owner", connId: "tab-3", x: 3, y: 3 }, null);
    recordRemoteCursor(cursors, { principalId: "peer", connId: "conn", x: 9, y: 9 }, null);

    // Tabs 2 and 3 closed; the principal remains in the roster through tab 1.
    const changed = pruneRemoteCursors(cursors, [
      { principal: { id: "owner" }, connIds: ["tab-1"] },
      { principal: { id: "peer" }, connIds: ["conn"] },
    ]);

    expect(changed).toBe(true);
    expect([...cursors.keys()].sort()).toEqual(["owner:tab-1", "peer:conn"]);
    // A second pass with the same roster is a no-op.
    expect(
      pruneRemoteCursors(cursors, [
        { principal: { id: "owner" }, connIds: ["tab-1"] },
        { principal: { id: "peer" }, connIds: ["conn"] },
      ]),
    ).toBe(false);

    // A departed principal loses every cursor.
    expect(pruneRemoteCursors(cursors, [{ principal: { id: "owner" }, connIds: ["tab-1"] }])).toBe(
      true,
    );
    expect([...cursors.keys()]).toEqual(["owner:tab-1"]);
  });

  test("labels sibling tabs of one principal deterministically", () => {
    // Single connection: bare name regardless of connId.
    expect(cursorLabel("alex-dev", "b", ["b"])).toBe("alex-dev");
    // Sorted conn order assigns ordinals; every viewer computes the same result.
    expect(cursorLabel("alex-dev", "a", ["b", "a", "c"])).toBe("alex-dev");
    expect(cursorLabel("alex-dev", "b", ["b", "a", "c"])).toBe("alex-dev (2)");
    expect(cursorLabel("alex-dev", "c", ["b", "a", "c"])).toBe("alex-dev (3)");
    // A connId missing from the roster keeps the bare name rather than guessing.
    expect(cursorLabel("alex-dev", "zz", ["b", "a"])).toBe("alex-dev");
  });
});
