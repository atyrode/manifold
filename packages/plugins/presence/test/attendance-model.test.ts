import { describe, expect, test } from "bun:test";
import type { Principal, PresenceState } from "@manifold/protocol";
import { deriveAttendanceRows } from "../src/attendance-model.ts";

function principal(id: string, name: string, kind: Principal["kind"] = "human"): Principal {
  return { id, kind, name, color: "#336699" };
}

function entry(
  p: Principal,
  connections = 1,
  payload: PresenceState["payload"] = {},
): PresenceState {
  return {
    principal: p,
    connections,
    connIds: Array.from({ length: connections }, (_v, index) => `${p.id}-conn-${index + 1}`),
    payload,
  };
}

describe("deriveAttendanceRows", () => {
  test("injects self when absent from the roster", () => {
    const self = principal("me", "Me");
    const rows = deriveAttendanceRows([entry(principal("peer", "Peer"))], self);
    expect(rows).toHaveLength(2);
    const selfRow = rows.find((row) => row.isSelf);
    expect(selfRow).toEqual({
      principal: self,
      connections: 1,
      status: "active",
      tool: null,
      isSelf: true,
    });
  });

  test("self sorts first, peers sort by name", () => {
    const self = principal("me", "Zed");
    const rows = deriveAttendanceRows(
      [entry(principal("b", "Bravo")), entry(self), entry(principal("a", "Alpha", "agent"))],
      self,
    );
    expect(rows.map((row) => row.principal.name)).toEqual(["Zed", "Alpha", "Bravo"]);
    expect(rows[0]?.isSelf).toBe(true);
  });

  test("status defaults to active and passes through when set", () => {
    const self = principal("me", "Me");
    const rows = deriveAttendanceRows(
      [entry(self, 1, {}), entry(principal("peer", "Peer"), 1, { status: "working" })],
      self,
    );
    expect(rows.find((row) => row.isSelf)?.status).toBe("active");
    expect(rows.find((row) => !row.isSelf)?.status).toBe("working");
  });

  /**
   * The peer tool chip is what makes "view state is observable" visible (A2): a tool nobody
   * else can see is a capability nobody else can reason about.
   */
  test("a peer's published tool passes through, and absence reads as null", () => {
    const self = principal("me", "Me");
    const rows = deriveAttendanceRows(
      [
        entry(self, 1, { vantage: { tool: "select" } }),
        entry(principal("peer", "Peer"), 1, { vantage: { tool: "draw" } }),
        entry(principal("quiet", "Quiet"), 1, {}),
      ],
      self,
    );
    expect(rows.find((row) => row.principal.id === "peer")?.tool).toBe("draw");
    expect(rows.find((row) => row.principal.id === "quiet")?.tool).toBeNull();
    expect(rows.find((row) => row.isSelf)?.tool).toBe("select");
  });

  test("connection counts pass through", () => {
    const self = principal("me", "Me");
    const rows = deriveAttendanceRows([entry(self, 3)], self);
    expect(rows).toEqual([
      { principal: self, connections: 3, status: "active", tool: null, isSelf: true },
    ]);
  });
});
