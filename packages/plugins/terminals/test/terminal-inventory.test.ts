import { describe, expect, test } from "bun:test";
import type { MachineSummary, TerminalInfo } from "@manifold/protocol";
import { buildTerminalRows } from "../src/terminal-inventory.ts";

function terminal(overrides: Partial<TerminalInfo>): TerminalInfo {
  return {
    id: "s1",
    name: null,
    containerId: "container1",
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
  selfCaps: ["containers:read", "terminals:write"] as readonly string[],
};

describe("buildTerminalRows", () => {
  test("bound running terminal keeps its binding and the controller can kill", () => {
    const rows = buildTerminalRows({ ...BASE, terminals: [terminal({})] });
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

  test("running terminal with no live binding reports no bound elements", () => {
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map(),
      terminals: [terminal({})],
    });
    expect(rows[0]?.boundElementIds).toEqual([]);
  });

  test("unbound exited terminals disappear because they have no remaining action", () => {
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map(),
      terminals: [terminal({}), terminal({ id: "s2", status: "exited", exitCode: 0 })],
    });
    expect(rows.map((row) => row.id)).toEqual(["s1"]);
  });

  test("bound exited terminals remain revealable and dismissable", () => {
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map([["s2", ["el-exited"]]]),
      terminals: [terminal({ id: "s2", status: "exited", exitCode: 0 })],
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

  test("wildcard capability grants kill on foreign terminals", () => {
    const rows = buildTerminalRows({
      ...BASE,
      selfCaps: ["*"],
      selfId: "someone-else",
      terminals: [terminal({ controllerId: "another" })],
    });
    expect(rows[0]?.isController).toBe(false);
    expect(rows[0]?.canKill).toBe(true);
  });

  test("non-controller without wildcard cannot kill", () => {
    const rows = buildTerminalRows({
      ...BASE,
      selfId: "someone-else",
      terminals: [terminal({ controllerId: "another" })],
    });
    expect(rows[0]?.canKill).toBe(false);
  });

  test("a terminal writer cannot kill a RUNNING foreign terminal, bound or not", () => {
    // The rule this defends is the kill door's, not this projection's: a live PTY belongs to
    // whoever holds its lease, and `terminal_take` is how a writer becomes that principal.
    // The old branch here granted kill on any UNBOUND running terminal to any terminal writer,
    // which was computed from `DELETE /api/terminals/:id` — the laxer of the two doors that
    // used to answer kill. That door is gone; offering a kill the surviving door refuses is
    // strictly worse than offering nothing, so bindings no longer enter the question at all.
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map(),
      selfCaps: ["containers:read", "terminals:write"],
      selfId: "someone-else",
      terminals: [terminal({ controllerId: "another" })],
    });
    expect(rows[0]).toMatchObject({ isController: false, canKill: false });

    // Same caller, same terminal, once it has exited: nothing left to protect, and only the
    // `terminals:write` the ladder already proved is asked for.
    const dead = buildTerminalRows({
      ...BASE,
      liveBindings: new Map([["s1", ["el1"]]]),
      selfCaps: ["containers:read", "terminals:write"],
      selfId: "someone-else",
      terminals: [terminal({ controllerId: "another", status: "exited", exitCode: 0 })],
    });
    expect(dead[0]?.canKill).toBe(true);
  });

  test("offline machine refs through the row", () => {
    const rows = buildTerminalRows({
      ...BASE,
      terminals: [terminal({ machineId: "m2" })],
    });
    expect(rows[0]).toMatchObject({ machineName: "sleepy", machineOnline: false });
  });

  test("rows sort running before exited, then by id", () => {
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map([
        ["bound", ["el-bound"]],
        ["zz-exited", ["el-exited"]],
        ["another", ["el-another"]],
      ]),
      terminals: [
        terminal({ id: "zz-exited", status: "exited", exitCode: 1 }),
        terminal({ id: "another" }),
        terminal({ id: "bound" }),
      ],
    });
    expect(rows.map((row) => row.id)).toEqual(["another", "bound", "zz-exited"]);
  });

  test("cloned bindings preserve stable canvas order", () => {
    const rows = buildTerminalRows({
      ...BASE,
      liveBindings: new Map([["s1", ["el-z", "el-a", "el1", "el-m"]]]),
      terminals: [terminal({})],
    });
    expect(rows[0]).toMatchObject({
      boundElementIds: ["el-z", "el-a", "el1", "el-m"],
    });
  });

  test("unknown machine yields null machine fields without crashing", () => {
    const rows = buildTerminalRows({
      ...BASE,
      machines: null,
      terminals: [terminal({})],
    });
    expect(rows[0]).toMatchObject({ machineName: null, machineOnline: null });
  });
});
