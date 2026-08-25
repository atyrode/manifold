import { describe, expect, test } from "bun:test";
import type { MachineSummary, SessionInfo } from "@manifold/protocol";
import { buildSessionRows } from "./session-inventory.ts";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "s1",
    padId: "pad1",
    elementId: "el1",
    machineId: "m1",
    status: "running",
    exitCode: null,
    cols: 80,
    rows: 24,
    controllerId: "me",
    createdBy: "me",
    ...overrides,
  };
}

const MACHINES: readonly MachineSummary[] = [
  { id: "m1", name: "tyrode-vps", online: true },
  { id: "m2", name: "sleepy", online: false },
];

const BASE = {
  machines: MACHINES,
  liveBindings: new Map([["s1", "el1"]]),
  selfId: "me",
  selfCaps: ["pads:read", "terminal:write"] as readonly string[],
};

describe("buildSessionRows", () => {
  test("bound running session is not orphaned and controller can kill", () => {
    const rows = buildSessionRows({ ...BASE, sessions: [session({})] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      orphaned: false,
      boundElementId: "el1",
      machineName: "tyrode-vps",
      machineOnline: true,
      isController: true,
      canKill: true,
    });
  });

  test("running session with no live binding is flagged orphaned", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map(),
      sessions: [session({})],
    });
    expect(rows[0]?.orphaned).toBe(true);
    expect(rows[0]?.boundElementId).toBeNull();
  });

  test("deleted-element tombstones are the caller's concern; only live bindings count", () => {
    // The caller filters isDeleted elements out of liveBindings; a session whose
    // element was deleted therefore shows up orphaned.
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map(),
      sessions: [session({}), session({ id: "s2", status: "exited", exitCode: 0 })],
    });
    expect(rows.map((row) => row.orphaned)).toEqual([true, false]);
    expect(rows.find((row) => row.id === "s2")?.canKill).toBe(false);
  });

  test("wildcard capability grants kill on foreign sessions", () => {
    const rows = buildSessionRows({
      ...BASE,
      selfCaps: ["*"],
      selfId: "someone-else",
      sessions: [session({ controllerId: "another" })],
    });
    expect(rows[0]?.isController).toBe(false);
    expect(rows[0]?.canKill).toBe(true);
  });

  test("non-controller without wildcard cannot kill", () => {
    const rows = buildSessionRows({
      ...BASE,
      selfId: "someone-else",
      sessions: [session({ controllerId: "another" })],
    });
    expect(rows[0]?.canKill).toBe(false);
  });

  test("offline machine surfaces through the row", () => {
    const rows = buildSessionRows({
      ...BASE,
      sessions: [session({ machineId: "m2" })],
    });
    expect(rows[0]).toMatchObject({ machineName: "sleepy", machineOnline: false });
  });

  test("rows sort orphans first, then bound running, then exited", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map([["bound", "el-bound"]]),
      sessions: [
        session({ id: "zz-exited", status: "exited", exitCode: 1 }),
        session({ id: "orphan", elementId: "gone" }),
        session({ id: "bound" }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["orphan", "bound", "zz-exited"]);
  });

  test("unknown machine yields null machine fields without crashing", () => {
    const rows = buildSessionRows({
      ...BASE,
      machines: null,
      sessions: [session({})],
    });
    expect(rows[0]).toMatchObject({ machineName: null, machineOnline: null });
  });
});
