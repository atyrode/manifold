import { describe, expect, test } from "bun:test";
import type { MachineSummary, SessionInfo } from "@manifold/protocol";
import { buildSessionRows } from "./session-inventory.ts";

function session(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "s1",
    name: null,
    padId: "pad1",
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
  liveBindings: new Map([["s1", ["el1"]]]),
  selfId: "me",
  selfCaps: ["pads:read", "terminal:write"] as readonly string[],
};

describe("buildSessionRows", () => {
  test("bound running session keeps its binding and the controller can kill", () => {
    const rows = buildSessionRows({ ...BASE, sessions: [session({})] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "s1",
      boundElementIds: ["el1"],
      machineName: "tyrode-vps",
      machineOnline: true,
      isController: true,
      canKill: true,
    });
  });

  test("running session with no live binding reports no bound elements", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map(),
      sessions: [session({})],
    });
    expect(rows[0]?.boundElementIds).toEqual([]);
  });

  test("unbound exited sessions disappear because they have no remaining action", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map(),
      sessions: [session({}), session({ id: "s2", status: "exited", exitCode: 0 })],
    });
    expect(rows.map((row) => row.id)).toEqual(["s1"]);
  });

  test("bound exited sessions remain revealable and dismissable", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map([["s2", ["el-exited"]]]),
      sessions: [session({ id: "s2", status: "exited", exitCode: 0 })],
    });
    expect(rows[0]).toMatchObject({
      id: "s2",
      status: "exited",
      boundElementIds: ["el-exited"],
      // Kill and dismiss are one verb: the server sweeps a dead terminal for any
      // writer, so the row's action stays available after exit.
      canKill: true,
    });
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

  test("terminal writer can claim and kill an unbound foreign session", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map(),
      selfCaps: ["pads:read", "terminal:write"],
      selfId: "someone-else",
      sessions: [session({ controllerId: "another" })],
    });
    expect(rows[0]).toMatchObject({ isController: false, canKill: true });
  });

  test("offline machine surfaces through the row", () => {
    const rows = buildSessionRows({
      ...BASE,
      sessions: [session({ machineId: "m2" })],
    });
    expect(rows[0]).toMatchObject({ machineName: "sleepy", machineOnline: false });
  });

  test("rows sort running before exited, then by id", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map([
        ["bound", ["el-bound"]],
        ["zz-exited", ["el-exited"]],
        ["another", ["el-another"]],
      ]),
      sessions: [
        session({ id: "zz-exited", status: "exited", exitCode: 1 }),
        session({ id: "another" }),
        session({ id: "bound" }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["another", "bound", "zz-exited"]);
  });

  test("cloned bindings preserve stable canvas order", () => {
    const rows = buildSessionRows({
      ...BASE,
      liveBindings: new Map([["s1", ["el-z", "el-a", "el1", "el-m"]]]),
      sessions: [session({})],
    });
    expect(rows[0]).toMatchObject({
      boundElementIds: ["el-z", "el-a", "el1", "el-m"],
    });
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
