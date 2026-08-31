import { describe, expect, test } from "bun:test";
import {
  CURSOR_HALF_LIFE_MS,
  FLOW_SNAP_EPSILON,
  FRACTION_SNAP_EPSILON,
} from "../src/presence/interpolate.ts";
import {
  clampCursorFraction,
  cursorFraction,
  cursorLabel,
  pruneRemoteCursors,
  recordRemoteCursor,
  remoteCursorSocketId,
  stepRemoteCursors,
  type RemoteCursor,
} from "../src/presence/cursor-identity.ts";

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
    expect(stepRemoteCursors(cursors, CURSOR_HALF_LIFE_MS, FLOW_SNAP_EPSILON)).toBe(true);
    expect(cursors.get("peer:socket")).toMatchObject({ x: 50, y: 25 });
  });

  test("eases fractional cursors instead of snapping them to every frame", () => {
    const snapped = new Map<string, RemoteCursor>();
    // View-root fractions: the whole span of motion is smaller than the flow epsilon, so
    // easing at scene scale teleports the cursor on the very first frame — the defect
    // that made tiled cursors jump while canvas cursors glided.
    recordRemoteCursor(snapped, { principalId: "peer", connId: "socket", x: 0.2, y: 0.4 }, null);
    recordRemoteCursor(snapped, { principalId: "peer", connId: "socket", x: 0.4, y: 0.8 }, null);
    expect(stepRemoteCursors(snapped, CURSOR_HALF_LIFE_MS, FLOW_SNAP_EPSILON)).toBe(true);
    expect(snapped.get("peer:socket")).toMatchObject({ x: 0.4, y: 0.8 });

    const eased = new Map<string, RemoteCursor>();
    recordRemoteCursor(eased, { principalId: "peer", connId: "socket", x: 0.2, y: 0.4 }, null);
    recordRemoteCursor(eased, { principalId: "peer", connId: "socket", x: 0.4, y: 0.8 }, null);
    expect(stepRemoteCursors(eased, CURSOR_HALF_LIFE_MS, FRACTION_SNAP_EPSILON)).toBe(true);
    const halfway = eased.get("peer:socket");
    expect(halfway?.x).toBeCloseTo(0.3, 10);
    expect(halfway?.y).toBeCloseTo(0.6, 10);

    // Termination still holds: a remainder under half a pixel of a 1000px view root
    // lands on the target instead of creeping toward it forever.
    recordRemoteCursor(
      eased,
      { principalId: "peer", connId: "socket", x: 0.3001, y: 0.6001 },
      null,
    );
    expect(stepRemoteCursors(eased, CURSOR_HALF_LIFE_MS, FRACTION_SNAP_EPSILON)).toBe(true);
    expect(eased.get("peer:socket")).toMatchObject({ x: 0.3001, y: 0.6001 });
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

describe("view-root cursor fractions", () => {
  const box = { left: 100, top: 40, width: 400, height: 200 } as const;

  test("projects a client point into fractions of the box, origin included", () => {
    expect(cursorFraction(box, { x: 100, y: 40 })).toEqual({ x: 0, y: 0 });
    expect(cursorFraction(box, { x: 300, y: 140 })).toEqual({ x: 0.5, y: 0.5 });
    expect(cursorFraction(box, { x: 500, y: 240 })).toEqual({ x: 1, y: 1 });
    // Fractions are box-size independent: the same tile for every viewer.
    expect(cursorFraction({ left: 0, top: 0, width: 40, height: 20 }, { x: 20, y: 10 })).toEqual(
      cursorFraction(box, { x: 300, y: 140 }),
    );
  });

  test("clamps a point outside the box to the unit square", () => {
    expect(cursorFraction(box, { x: -50, y: 39 })).toEqual({ x: 0, y: 0 });
    expect(cursorFraction(box, { x: 9_000, y: 9_000 })).toEqual({ x: 1, y: 1 });
  });

  test("a view that has not laid out yet reports the origin instead of dividing by zero", () => {
    expect(cursorFraction({ left: 0, top: 0, width: 0, height: 0 }, { x: 12, y: 12 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  test("clamps received fractions so no frame can paint outside the view root", () => {
    expect(clampCursorFraction({ x: 0.25, y: 0.75 })).toEqual({ x: 0.25, y: 0.75 });
    // A canvas-space frame reaching a tiled renderer lands on the border, never off it.
    expect(clampCursorFraction({ x: 1_284, y: -12 })).toEqual({ x: 1, y: 0 });
    expect(clampCursorFraction({ x: Number.NaN, y: Number.NaN })).toEqual({ x: 0, y: 0 });
  });
});
