import { describe, expect, test } from "bun:test";
import type { Principal, PresenceState } from "@manifold/protocol";
import { deriveRosterRows } from "./roster-model.ts";

function principal(id: string, name: string, kind: Principal["kind"] = "human"): Principal {
  return { id, kind, name, color: "#336699" };
}

function entry(
  p: Principal,
  connections = 1,
  payload: PresenceState["payload"] = {},
): PresenceState {
  return { principal: p, connections, payload };
}

describe("deriveRosterRows", () => {
  test("injects self when absent from the roster", () => {
    const self = principal("me", "Me");
    const rows = deriveRosterRows([entry(principal("peer", "Peer"))], self);
    expect(rows).toHaveLength(2);
    const selfRow = rows.find((row) => row.isSelf);
    expect(selfRow).toEqual({ principal: self, connections: 1, status: "active", isSelf: true });
  });

  test("self sorts first, peers sort by name", () => {
    const self = principal("me", "Zed");
    const rows = deriveRosterRows(
      [entry(principal("b", "Bravo")), entry(self), entry(principal("a", "Alpha", "agent"))],
      self,
    );
    expect(rows.map((row) => row.principal.name)).toEqual(["Zed", "Alpha", "Bravo"]);
    expect(rows[0]?.isSelf).toBe(true);
  });

  test("status defaults to active and passes through when set", () => {
    const self = principal("me", "Me");
    const rows = deriveRosterRows(
      [entry(self, 1, {}), entry(principal("peer", "Peer"), 1, { status: "working" })],
      self,
    );
    expect(rows.find((row) => row.isSelf)?.status).toBe("active");
    expect(rows.find((row) => !row.isSelf)?.status).toBe("working");
  });

  test("connection counts pass through", () => {
    const self = principal("me", "Me");
    const rows = deriveRosterRows([entry(self, 3)], self);
    expect(rows).toEqual([{ principal: self, connections: 3, status: "active", isSelf: true }]);
  });
});
