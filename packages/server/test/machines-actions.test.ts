import { describe, expect, test } from "bun:test";
import {
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  identityColorFor,
  type ActionOutcome,
  type Cap,
  type MachineEnrollResponse,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { MachineLiveness, PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * THE FLEET'S TWO DOORS, rung by rung.
 *
 * `core.machines.list` and `core.machines.enroll` are what `GET` and `POST /api/machines`
 * became, so these cases are two claims at once: that the ladder answers each rung in its
 * fixed order, and that nothing the routes did got lost on the way through it. The second
 * claim is the load-bearing one — enrolment mints a durable credential for a process nobody
 * in the workspace can see, and its idempotence is the reason a re-run provision script
 * cannot knock a running agent off the air (issue #40).
 */

const OWNER_KEY = "b".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
}

/** Liveness a case can drive after enrolling, standing in for machines that have dialled in. */
function liveness(online: ReadonlySet<string>): MachineLiveness {
  return { isOnline: (machineId) => online.has(machineId) };
}

async function fixture(online: ReadonlySet<string> = new Set()): Promise<Fixture> {
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
  return {
    store,
    auth,
    owner,
    host: await testPluginHost(store, auth, rooms, broker, runtime, { machines: liveness(online) }),
    runtime,
  };
}

/** A real token, so authority is exercised through attenuation rather than a hand-built context. */
function context(fix: Fixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = fix.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    fix.owner,
  );
  return fix.auth.authenticate(grant.token);
}

/**
 * A container to scope a token to; `mintToken` refuses a scope naming a container that is
 * not there.
 */
function container(fix: Fixture): string {
  const id = fix.runtime.newId();
  fix.store.createContainer({
    id,
    name: "scoped",
    createdAt: fix.runtime.now(),
    discipline: "canvas",
  });
  return id;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

function enrolled(outcome: ActionOutcome): MachineEnrollResponse {
  if (!outcome.ok) throw new Error(`expected an enrolment: ${outcome.denial.message}`);
  return MachineEnrollResponseSchema.parse(outcome.result);
}

describe("core.machines.enroll", () => {
  test("mints a machine and its one-time token", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" });

    const result = enrolled(outcome);
    expect(fix.store.getMachineByName("alpha")?.id).toBe(result.machine.id);
    expect(typeof result.machineToken).toBe("string");
    // The credential is answered exactly once and only its hash is kept, which is why the
    // recovery path below has to exist at all — and it authenticates as a MACHINE, never as
    // a principal bearer.
    expect(fix.auth.authenticateMachine(result.machineToken ?? "").id).toBe(result.machine.id);
    fix.store.close();
  });

  test("re-enrolling a name is IDEMPOTENT: same row, no new token", async () => {
    const fix = await fixture();
    const first = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    );

    const again = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    );

    // A re-run provision flow must never invalidate the token a running agent holds (#40),
    // so the second call is a lookup wearing the enrolment verb's clothes.
    expect(again.machine.id).toBe(first.machine.id);
    expect(again.machineToken).toBeUndefined();
    expect(fix.auth.authenticateMachine(first.machineToken ?? "").id).toBe(first.machine.id);
    fix.store.close();
  });

  test("rotateToken recovers a lost token file: same row, fresh secret, old one dead", async () => {
    const fix = await fixture();
    const first = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    );

    const rotated = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", {
        name: "alpha",
        rotateToken: true,
      }),
    );

    expect(rotated.machine.id).toBe(first.machine.id);
    expect(typeof rotated.machineToken).toBe("string");
    expect(rotated.machineToken).not.toBe(first.machineToken);
    // Rotation is a revocation too, or the "lost" token would still be a way in.
    expect(() => fix.auth.authenticateMachine(first.machineToken ?? "")).toThrow();
    expect(fix.auth.authenticateMachine(rotated.machineToken ?? "").id).toBe(first.machine.id);
    fix.store.close();
  });

  test("a container-scoped token is refused for its SCOPE, above the capability it holds", async () => {
    const fix = await fixture();
    const scoped = context(fix, ["machines:mint"], container(fix));

    const outcome = await fix.host.dispatch(scoped, "core.machines.enroll", { name: "alpha" });

    // Enrolment is workspace-grade (D11) and the route said the same thing in its own words;
    // carrying the right capability inside one container does not reach outside it.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    expect(fix.store.getMachineByName("alpha")).toBeNull();
    fix.store.close();
  });

  test("without machines:mint it is forbidden, and the argument shape stays unlearnable", async () => {
    const fix = await fixture();
    const reader = context(fix, ["containers:read"]);

    const outcome = await fix.host.dispatch(reader, "core.machines.enroll", {});

    // Empty args would be `invalid_args` for someone allowed in; a caller who may not open
    // this door must not discover its schema by knocking on it.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "machines:mint capability required",
    });
    fix.store.close();
  });

  test("a nameless enrolment is invalid_args, not a machine called nothing", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.enroll", {});

    expect(denial(outcome).rule).toBe("invalid_args");
    expect(fix.store.listMachines()).toHaveLength(0);
    fix.store.close();
  });

  test("a disabled fleet plugin refuses enrolment — creation dies with the plugin", async () => {
    const fix = await fixture();
    await fix.host.setEnabled("core.machines", false, "admin");

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" });

    expect(denial(outcome)).toEqual({
      rule: "plugin_disabled",
      message: 'plugin "core.machines" is disabled',
    });
    fix.store.close();
  });
});

describe("core.machines.list", () => {
  test("reports every row with live connectedness and a derived color", async () => {
    const online = new Set<string>();
    const fix = await fixture(online);
    const alpha = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    ).machine.id;
    const beta = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "beta" }),
    ).machine.id;
    online.add(alpha);

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.list", {});

    if (!outcome.ok) throw new Error("expected a list");
    const { machines } = MachinesResponseSchema.parse(outcome.result);
    expect(machines).toEqual([
      { id: alpha, name: "alpha", online: true, color: identityColorFor(alpha) },
      { id: beta, name: "beta", online: false, color: identityColorFor(beta) },
    ]);
    fix.store.close();
  });

  test('a container-scoped reader still sees the whole fleet — the read is scope:"container"', async () => {
    const fix = await fixture();
    await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" });
    const scoped = context(fix, ["containers:read"], container(fix));

    const outcome = await fix.host.dispatch(scoped, "core.machines.list", {});

    // `GET /api/machines` answered any authenticated token, scoped ones included: a viewer
    // holding a share link still has to paint the machine badge on the terminal in front of
    // it. Converting the read to an action must not quietly take that away.
    if (!outcome.ok) throw new Error(`expected a list: ${outcome.denial.message}`);
    expect(MachinesResponseSchema.parse(outcome.result).machines).toHaveLength(1);
    fix.store.close();
  });

  test("without containers:read it is forbidden, scoped or not", async () => {
    const fix = await fixture();
    const scoped = context(fix, ["terminals:write"], container(fix));

    const outcome = await fix.host.dispatch(scoped, "core.machines.list", {});

    // The scope rung lets a scoped caller reach the caps rung; it never carries them past it.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "containers:read capability required",
    });
    fix.store.close();
  });

  test("an argument the door does not publish is invalid_args", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.list", {
      containerId: "container-1",
    });

    // The fleet is not filterable, and a strict schema is how a caller finds that out rather
    // than silently receiving everything under the impression it asked for one container.
    expect(denial(outcome).rule).toBe("invalid_args");
    fix.store.close();
  });

  test("a disabled fleet plugin refuses the inventory: a list is not cleanup", async () => {
    const fix = await fixture();
    await fix.host.setEnabled("core.machines", false, "admin");

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.list", {});

    expect(denial(outcome)).toEqual({
      rule: "plugin_disabled",
      message: 'plugin "core.machines" is disabled',
    });
    fix.store.close();
  });

  test("an unknown fleet verb is unknown_action, never a hint that one exists", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.forget", { id: "m1" });

    expect(denial(outcome)).toEqual({
      rule: "unknown_action",
      message: 'unknown action "core.machines.forget"',
    });
    fix.store.close();
  });
});
