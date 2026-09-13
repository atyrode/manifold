import { describe, expect, test } from "bun:test";
import {
  MachineRepositoryFactSchema,
  formatManifoldUri,
  type ActionOutcome,
  type Cap,
  type MachineRepositoryFact,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { MachineRepositoryOutcome } from "../src/machine-ws.ts";
import type { MachineAdmission, PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * `engine.machines.repository`, rung by rung (issue #529).
 *
 * The claim worth proving here is not what a fact contains — the agent's own tests prove that
 * against real checkouts — but that the authority is asked AT THE MACHINE. A fleet is many
 * hosts, and a token that may read one host's folders must not read another's; a capability
 * check in the abstract would let it, which is exactly the mistake this door must not make.
 */

const OWNER_KEY = "c".repeat(64);
const WORK = "/home/operator/work";

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  /** Every path the fleet was actually asked about, in order. */
  readonly asked: string[];
}

/** What this fixture's host reports about a folder it recognises. */
function observed(path: string): MachineRepositoryFact {
  return {
    path,
    identity: "/home/operator/work/.git",
    remote: "github.com/atyrode/manifold",
    reason: "repository",
    observedAt: 7,
  };
}

async function fixture(answer?: MachineRepositoryOutcome): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  const asked: string[] = [];
  const machines: MachineAdmission = {
    isOnline: () => true,
    getTerminalExecution: () => null,
    drain: () => Promise.resolve({ ok: false, reason: "fixture has no terminal owner" }),
    repository: (_machineId, path) => {
      asked.push(path);
      return Promise.resolve(answer ?? { ok: true, fact: observed(path) });
    },
  };
  const host = await testPluginHost(store, auth, rooms, broker, runtime, { machines });
  return { store, auth, owner, host, asked };
}

/** A real token, so authority is exercised through attenuation rather than a hand-built context. */
function context(fix: Fixture, caps: readonly Cap[]): AuthContext {
  const grant = fix.auth.mintToken(
    { principal: { name: "reader", kind: "agent" }, caps: [...caps] },
    fix.owner,
  );
  return fix.auth.authenticate(grant.token);
}

async function enroll(fix: Fixture, name: string): Promise<string> {
  const outcome = await fix.host.dispatch(fix.owner, "core.machines.enroll", { name });
  if (!outcome.ok) throw new Error(`enrolment refused: ${outcome.denial.message}`);
  return fix.store.getMachineByName(name)?.id ?? "";
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

describe("engine.machines.repository", () => {
  test("answers the machine's own observation to a caller entitled to read it", async () => {
    const fix = await fixture();
    const machineId = await enroll(fix, "alpha");

    const outcome = await fix.host.dispatch(fix.owner, "engine.machines.repository", {
      machineId,
      path: WORK,
    });

    expect(outcome.ok).toBe(true);
    expect(MachineRepositoryFactSchema.parse(outcome.ok ? outcome.result : null)).toEqual(
      observed(WORK),
    );
    expect(fix.asked).toEqual([WORK]);
    fix.store.close();
  });

  test("a caller without machines:read never reaches the host", async () => {
    const fix = await fixture();
    const machineId = await enroll(fix, "alpha");
    const stranger = context(fix, ["containers:read"]);

    const outcome = await fix.host.dispatch(stranger, "engine.machines.repository", {
      machineId,
      path: WORK,
    });

    expect(denial(outcome).message).toContain("machines:read");
    // Not merely denied: nothing was asked of the fleet, so no probe ran on any host.
    expect(fix.asked).toEqual([]);
    fix.store.close();
  });

  test("the capability is asked AT the machine: another machine's folders stay unreadable", async () => {
    const fix = await fixture();
    const mine = await enroll(fix, "mine");
    const theirs = await enroll(fix, "theirs");
    const reader = context(fix, ["machines:read"]);
    // A5 flows the minted allow down from the root; the operator withholds ONE host by
    // naming it, which is the only way a fleet's authority is sayable per machine.
    fix.auth.grant(
      {
        principal: { kind: "principal", id: reader.principal.id },
        node: formatManifoldUri({ kind: "machine", machineId: theirs }),
        caps: ["machines:read"],
        effect: "deny",
        reach: "subtree",
      },
      fix.owner,
    );

    const allowed = await fix.host.dispatch(reader, "engine.machines.repository", {
      machineId: mine,
      path: WORK,
    });
    const refused = await fix.host.dispatch(reader, "engine.machines.repository", {
      machineId: theirs,
      path: WORK,
    });

    expect(allowed.ok).toBe(true);
    expect(denial(refused).rule).toBe("refused");
    expect(denial(refused).message).toContain("machines:read");
    // The refusal names no host, and the withheld machine was never asked anything.
    expect(denial(refused).message).not.toContain(theirs);
    expect(fix.asked).toEqual([WORK]);
    fix.store.close();
  });

  test("a machine this workspace never enrolled is refused before the fleet is asked", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "engine.machines.repository", {
      machineId: "never-enrolled",
      path: WORK,
    });

    expect(denial(outcome).message).toBe("unknown machine");
    expect(fix.asked).toEqual([]);
    fix.store.close();
  });

  test("a relative path, a NUL and an over-long path are refused as arguments", async () => {
    const fix = await fixture();
    const machineId = await enroll(fix, "alpha");

    for (const path of ["relative/work", `${WORK}\u0000/etc/shadow`, `/${"a".repeat(4096)}`]) {
      const outcome = await fix.host.dispatch(fix.owner, "engine.machines.repository", {
        machineId,
        path,
      });
      expect(denial(outcome).rule).toBe("invalid_args");
    }
    expect(fix.asked).toEqual([]);
    fix.store.close();
  });

  test("a fleet that cannot be asked answers why, never a fact nobody observed", async () => {
    const fix = await fixture({ ok: false, reason: "machine is offline: it cannot be asked" });
    const machineId = await enroll(fix, "alpha");

    const outcome = await fix.host.dispatch(fix.owner, "engine.machines.repository", {
      machineId,
      path: WORK,
    });

    expect(denial(outcome).message).toBe("machine is offline: it cannot be asked");
    fix.store.close();
  });
});
