import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostViewsSchema, type HostView } from "@manifold-plugin/machines";
import {
  MachineDrainStatusSchema,
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  identityColorFor,
  type ActionOutcome,
  type Cap,
  type MachineEnrollResponse,
} from "@manifold/protocol";
import { HARDENED_SOURCE_RECIPES, SERVER_PLUGIN_DEFS } from "../src/assembly.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { compileTrustedBuilds, type TrustedBuild } from "../src/first-party-builds.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import type { MachineAdmission, PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * THE FLEET'S DOORS, rung by rung.
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
  dispose(): Promise<void>;
}

/** Liveness a case can drive after enrolling, standing in for machines that have dialled in. */
function liveness(online: ReadonlySet<string>): MachineAdmission {
  return {
    isOnline: (machineId) => online.has(machineId),
    getTerminalExecution: () => null,
    getPhysicalCoreCount: () => undefined,
    drain: (machineId, draining) =>
      Promise.resolve(
        online.has(machineId)
          ? { ok: true, status: { terminalHostId: "host-A", draining, terminalIds: ["t1"] } }
          : { ok: false, reason: "machine is offline: its terminals are unknown" },
      ),
    repository: (machineId, path) =>
      Promise.resolve(
        online.has(machineId)
          ? {
              ok: true,
              fact: {
                path,
                identity: `${path}/.git`,
                remote: null,
                reason: "repository",
                observedAt: 1,
              },
            }
          : { ok: false, reason: "machine is offline: it cannot be asked" },
      ),
  };
}

async function fixture(
  online: ReadonlySet<string> = new Set(),
  trusted: readonly TrustedBuild[] = [],
): Promise<Fixture> {
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
  const isolates =
    trusted.length === 0
      ? undefined
      : {
          runner: new IsolateSupervisor({ logger: silentLogger, runtime }),
          dataDir: mkdtempSync(join(tmpdir(), "manifold-host-views-")),
        };
  try {
    const host = await testPluginHost(store, auth, rooms, broker, runtime, {
      machines: liveness(online),
      trusted,
      ...(isolates === undefined ? {} : { isolates }),
    });
    return {
      store,
      auth,
      owner,
      host,
      runtime,
      async dispose() {
        try {
          await isolates?.runner.close();
        } finally {
          host.close();
          store.close();
          if (isolates !== undefined) rmSync(isolates.dataDir, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await isolates?.runner.close();
    store.close();
    if (isolates !== undefined) rmSync(isolates.dataDir, { recursive: true, force: true });
    throw error;
  }
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
    const alphaEnrollment = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    );
    const alpha = alphaEnrollment.machine.id;
    const betaEnrollment = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "beta" }),
    );
    const beta = betaEnrollment.machine.id;
    if (betaEnrollment.machineToken === undefined) throw new Error("expected a fresh token");
    fix.auth.recordMachineRefusal(betaEnrollment.machineToken, 4403);
    online.add(alpha);

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.list", {});

    if (!outcome.ok) throw new Error("expected a list");
    const { machines } = MachinesResponseSchema.parse(outcome.result);
    expect(machines).toEqual([
      { id: alpha, name: "alpha", online: true, color: identityColorFor(alpha) },
      {
        id: beta,
        name: "beta",
        online: false,
        color: identityColorFor(beta),
        lastRefusal: { code: 4403, at: fix.runtime.now() },
      },
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
});

describe("core.machines.forget", () => {
  test("requires withdrawal, removes all credentials and the roster row, and preserves traces", async () => {
    const fix = await fixture();
    const first = fix.auth.enrollMachine("retired", fix.owner);
    const rotated = fix.auth.rotateMachineToken(first.machine);
    const machineId = first.machine.id;
    const forget = () => fix.host.dispatch(fix.owner, "core.machines.forget", { machineId });
    expect(denial(await forget())).toEqual({ rule: "refused", message: "not_revoked" });
    expect(fix.auth.authenticateMachine(rotated.machineToken).id).toBe(machineId);
    await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId });
    const history = fix.store.listEvents({ limit: 100 });
    expect((await forget()).ok).toBe(true);
    expect(fix.store.getMachine(machineId)).toBeNull();
    expect(fix.store.listTokensByPrincipal(machineId)).toEqual([]);
    expect(fix.store.listEvents({ type: "trace", limit: 1 })[0]).toMatchObject({
      door: "core.machines.forget",
      outcome: "ok",
      targets: [`manifold://machine/${machineId}`],
    });
    const listed = await fix.host.dispatch(fix.owner, "core.machines.list", {});
    if (!listed.ok) throw new Error(listed.denial.message);
    expect(MachinesResponseSchema.parse(listed.result).machines).toEqual([]);
    expect(fix.store.listEvents({ limit: 100 })).toEqual(expect.arrayContaining(history));
    expect(denial(await forget())).toEqual({ rule: "refused", message: "machine not found" });
    expect(fix.store.listEvents({ type: "trace", limit: 1 })[0]).toMatchObject({
      door: "core.machines.forget",
      outcome: "refused",
    });
    fix.store.close();
  });

  test("retained terminals and a pending drain refuse without destroying inventory", async () => {
    const fix = await fixture();
    const { machine } = fix.auth.enrollMachine("retained", fix.owner);
    fix.auth.revokeMachine(machine.id, fix.owner);
    const forget = () =>
      fix.host.dispatch(fix.owner, "core.machines.forget", { machineId: machine.id });
    fix.store.setMachineDraining(machine.id, true);
    expect(denial(await forget()).message).toBe("drain_pending");
    fix.store.setMachineDraining(machine.id, false);
    fix.store.createTerminal({
      id: "retained-terminal",
      machineId: machine.id,
      containerId: container(fix),
      createdBy: fix.owner.principal.id,
      agentPrincipalId: fix.owner.principal.id,
      createdAt: fix.runtime.now(),
    });
    expect(denial(await forget()).message).toBe("terminals_retained");
    expect(fix.store.getTerminal("retained-terminal")?.status).toBe("running");
    expect(fix.store.getMachine(machine.id)).not.toBeNull();
    fix.store.markTerminalExited("retained-terminal", 0, null);
    expect(denial(await forget()).message).toBe("terminals_retained");
    fix.store.deleteTerminal("retained-terminal");
    expect((await forget()).ok).toBe(true);
    fix.store.close();
  });

  test("fleet administration requires an unscoped machines:mint credential", async () => {
    const fix = await fixture();
    const { machine } = fix.auth.enrollMachine("retired", fix.owner);
    fix.auth.revokeMachine(machine.id, fix.owner);
    for (const actor of [
      context(fix, ["containers:read"]),
      context(fix, ["machines:mint"], container(fix)),
    ]) {
      expect(
        denial(
          await fix.host.dispatch(actor, "core.machines.forget", {
            machineId: machine.id,
          }),
        ).rule,
      ).toBe("forbidden");
    }
    expect(fix.store.getMachine(machine.id)).not.toBeNull();
    fix.store.close();
  });
});

/**
 * THE ADMISSION DOOR (#278). The mechanism is the broker's and proven there; this is the
 * ladder around it — who may close a machine to new work, and that an owner's silence is a
 * refusal rather than a safe-looking empty list.
 */
describe("core.machines.drain", () => {
  test("relays the owner's report to a fleet administrator", async () => {
    const online = new Set<string>();
    const fix = await fixture(online);
    const alpha = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    ).machine.id;
    online.add(alpha);

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.drain", {
      machineId: alpha,
      draining: true,
    });

    if (!outcome.ok) throw new Error(`expected a report: ${outcome.denial.message}`);
    expect(MachineDrainStatusSchema.parse(outcome.result)).toEqual({
      terminalHostId: "host-A",
      draining: true,
      terminalIds: ["t1"],
    });
    fix.store.close();
  });

  test("an owner that cannot answer is refused, never reported empty", async () => {
    const fix = await fixture();
    const alpha = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    ).machine.id;

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.drain", {
      machineId: alpha,
      draining: true,
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "machine is offline: its terminals are unknown",
    });
    fix.store.close();
  });

  test("an unknown machine is refused before the mechanism is asked", async () => {
    const fix = await fixture(new Set(["ghost"]));

    const outcome = await fix.host.dispatch(fix.owner, "core.machines.drain", {
      machineId: "ghost",
      draining: true,
    });

    expect(denial(outcome)).toEqual({ rule: "refused", message: "unknown machine" });
    fix.store.close();
  });

  test("needs machines:mint at workspace scope, exactly as enroll and revoke do", async () => {
    const fix = await fixture();
    const alpha = enrolled(
      await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
    ).machine.id;

    const capless = await fix.host.dispatch(
      context(fix, ["containers:read"]),
      "core.machines.drain",
      { machineId: alpha, draining: true },
    );
    expect(denial(capless)).toEqual({
      rule: "forbidden",
      message: "machines:mint capability required",
    });

    const scoped = await fix.host.dispatch(
      context(fix, ["machines:mint"], container(fix)),
      "core.machines.drain",
      { machineId: alpha, draining: true },
    );
    expect(denial(scoped)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });

    const malformed = await fix.host.dispatch(fix.owner, "core.machines.drain", {
      machineId: alpha,
    });
    expect(denial(malformed).rule).toBe("invalid_args");
    fix.store.close();
  });
});

describe("core.machines host-view doors", () => {
  let builds: readonly TrustedBuild[] = [];
  beforeAll(async () => {
    builds = await compileTrustedBuilds(
      ["core.machines"],
      SERVER_PLUGIN_DEFS,
      HARDENED_SOURCE_RECIPES,
    );
  }, 120_000);

  for (const mode of ["native", "hardened"] as const) {
    test(`${mode} grouping preserves inventory, forgotten IDs and metadata-only removal`, async () => {
      const fix = await fixture(new Set(), mode === "hardened" ? builds : []);
      try {
        const alpha = enrolled(
          await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "shell-account" }),
        );
        const beta = enrolled(
          await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "governed-account" }),
        );
        const view: HostView = {
          id: "10000000-0000-4000-8000-000000000001",
          name: "Physical host",
          members: [
            { machineId: alpha.machine.id, accountLabel: "shell" },
            { machineId: beta.machine.id, accountLabel: "governed" },
          ],
        };
        const read = async (actor = fix.owner) => {
          const outcome = await fix.host.dispatch(actor, "core.machines.listHostViews", {});
          if (!outcome.ok) throw new Error(outcome.denial.message);
          return HostViewsSchema.parse(outcome.result);
        };
        expect(await read()).toEqual({ revision: 0, hosts: [] });
        expect(await fix.store.pluginStorage("core.machines").get("host-views")).toBeNull();
        const administrator = context(fix, ["machines:mint", "containers:read"]);
        const saved = await fix.host.dispatch(administrator, "core.machines.setHostView", {
          expectedRevision: 0,
          host: {
            ...view,
            name: "  Physical host  ",
            members: view.members.map((member) => ({
              ...member,
              accountLabel: ` ${member.accountLabel} `,
            })),
          },
        });
        if (!saved.ok) throw new Error(saved.denial.message);
        expect(HostViewsSchema.parse(saved.result)).toEqual({ revision: 1, hosts: [view] });
        expect(await read(context(fix, ["containers:read"], container(fix)))).toEqual({
          revision: 1,
          hosts: [view],
        });

        const news = fix.store.listEvents({ type: "host_views_changed", limit: 100 });
        expect(news.map((event) => JSON.parse(event.payload))).toEqual([{ revision: 1 }]);
        expect(
          (await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
            expectedRevision: 1,
            host: view,
          })).ok,
        ).toBe(true);
        expect(fix.store.listEvents({ type: "host_views_changed", limit: 100 })).toEqual(news);
        expect(
          denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
            expectedRevision: 0,
            host: view,
          })),
        ).toEqual({ rule: "refused", message: "host_views_changed" });
        expect(
          denial(await fix.host.dispatch(fix.owner, "core.machines.removeHostView", {
            expectedRevision: 0,
            hostId: view.id,
          })),
        ).toEqual({ rule: "refused", message: "host_views_changed" });

        // No online/offline transition is available to invalidate these two mutations.
        expect((await fix.host.dispatch(fix.owner, "core.machines.revoke", {
          machineId: alpha.machine.id,
        })).ok).toBe(true);
        expect((await fix.host.dispatch(fix.owner, "core.machines.forget", {
          machineId: alpha.machine.id,
        })).ok).toBe(true);
        expect(fix.store.listEvents({ type: "machine_inventory_changed", limit: 100 })
          .map((event) => JSON.parse(event.payload))).toEqual([
          { machineId: alpha.machine.id },
          { machineId: alpha.machine.id },
        ]);
        expect(await read()).toEqual({ revision: 1, hosts: [view] });
        const replacement = enrolled(
          await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "shell-account" }),
        );
        expect(replacement.machine.id).not.toBe(alpha.machine.id);
        expect(await read()).toEqual({ revision: 1, hosts: [view] });

        const renamed = { ...view, name: "Renamed host" };
        const renamedOutcome = await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
          expectedRevision: 1,
          host: renamed,
        });
        if (!renamedOutcome.ok) throw new Error(renamedOutcome.denial.message);
        expect(HostViewsSchema.parse(renamedOutcome.result)).toEqual({
          revision: 2,
          hosts: [renamed],
        });
        expect(
          denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
            expectedRevision: 2,
            host: {
              ...renamed,
              members: [{ machineId: alpha.machine.id, accountLabel: "changed missing account" }],
            },
          })),
        ).toEqual({ rule: "refused", message: "machine_unavailable" });
        const removed = await fix.host.dispatch(fix.owner, "core.machines.removeHostView", {
          expectedRevision: 2,
          hostId: view.id,
        });
        if (!removed.ok) throw new Error(removed.denial.message);
        expect(HostViewsSchema.parse(removed.result)).toEqual({ revision: 3, hosts: [] });
        const inventory = await fix.host.dispatch(fix.owner, "core.machines.list", {});
        if (!inventory.ok) throw new Error(inventory.denial.message);
        expect(MachinesResponseSchema.parse(inventory.result).machines.map((machine) => machine.id))
          .toEqual([beta.machine.id, replacement.machine.id]);
        expect(fix.auth.authenticateMachine(beta.machineToken ?? "").id).toBe(beta.machine.id);
        expect(fix.auth.authenticateMachine(replacement.machineToken ?? "").id)
          .toBe(replacement.machine.id);
      } finally {
        await fix.dispose();
      }
    }, 60_000);

    test(`${mode} host-view doors enforce administrator authority and input boundaries`, async () => {
      const fix = await fixture(new Set(), mode === "hardened" ? builds : []);
      try {
        const machine = fix.auth.enrollMachine("account", fix.owner).machine;
        const view: HostView = {
          id: "20000000-0000-4000-8000-000000000001",
          name: "Host",
          members: [{ machineId: machine.id, accountLabel: "shell" }],
        };
        const reader = context(fix, ["containers:read"]);
        for (const actor of [reader, context(fix, ["machines:mint"], container(fix))]) {
          expect(denial(await fix.host.dispatch(actor, "core.machines.setHostView", {
            expectedRevision: 0,
            host: view,
          })).rule).toBe("forbidden");
          expect(denial(await fix.host.dispatch(actor, "core.machines.removeHostView", {
            expectedRevision: 0,
            hostId: view.id,
          })).rule).toBe("forbidden");
        }
        expect(denial(await fix.host.dispatch(context(fix, ["terminals:write"]),
          "core.machines.listHostViews", {})).rule).toBe("forbidden");
        expect(denial(await fix.host.dispatch(context(fix, ["machines:mint"]),
          "core.machines.setHostView", { expectedRevision: 0, host: view }))).toEqual({
          rule: "refused",
          message: "containers:read capability required",
        });
        const invalidHosts = [
          { ...view, id: "not-a-uuid" },
          { ...view, name: "   " },
          { ...view, name: "n".repeat(65) },
          { ...view, members: [] },
          { ...view, members: [...view.members, ...view.members] },
          { ...view, members: Array.from({ length: 65 }, (_, index) => ({
            machineId: `endpoint-${index}`,
            accountLabel: "shell",
          })) },
          { ...view, members: [{ machineId: machine.id, accountLabel: " " }] },
          { ...view, members: [{ machineId: machine.id, accountLabel: "a".repeat(65) }] },
        ];
        for (const host of invalidHosts) {
          expect(denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
            expectedRevision: 0,
            host,
          })).rule).toBe("invalid_args");
        }
        expect(denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
          host: view,
        })).rule).toBe("invalid_args");
        expect(denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
          expectedRevision: 0,
          host: { ...view, members: [{ machineId: "unknown-endpoint", accountLabel: "shell" }] },
        }))).toEqual({ rule: "refused", message: "machine_unavailable" });
        expect(await fix.store.pluginStorage("core.machines").get("host-views")).toBeNull();
        expect(fix.store.listEvents({ type: "host_views_changed", limit: 100 })).toEqual([]);
      } finally {
        await fix.dispose();
      }
    }, 60_000);

    test(`${mode} concurrent host CAS has one winner and enforces global membership on retry`, async () => {
      const fix = await fixture(new Set(), mode === "hardened" ? builds : []);
      try {
        const machine = fix.auth.enrollMachine("shared-account", fix.owner).machine;
        const views: HostView[] = [1, 2].map((index) => ({
          id: `30000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          name: "Same display name",
          members: [{ machineId: machine.id, accountLabel: "shell" }],
        }));
        const outcomes = await Promise.all(views.map((host) =>
          fix.host.dispatch(fix.owner, "core.machines.setHostView", { expectedRevision: 0, host })));
        const successful = outcomes.filter((outcome) => outcome.ok);
        expect(successful).toHaveLength(1);
        expect(outcomes.filter((outcome) => !outcome.ok).map(denial)).toEqual([
          { rule: "refused", message: "host_views_changed" },
        ]);
        const winner = successful[0];
        if (winner === undefined || !winner.ok) throw new Error("expected one CAS winner");
        const registry = HostViewsSchema.parse(winner.result);
        const loser = views.find((view) => view.id !== registry.hosts[0]?.id);
        if (loser === undefined) throw new Error("expected the other host");
        expect(denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
          expectedRevision: 1,
          host: loser,
        }))).toEqual({ rule: "refused", message: "host_view_member_already_grouped" });
        const read = await fix.host.dispatch(fix.owner, "core.machines.listHostViews", {});
        if (!read.ok) throw new Error(read.denial.message);
        expect(HostViewsSchema.parse(read.result)).toEqual(registry);
        expect(fix.store.listEvents({ type: "host_views_changed", limit: 100 })
          .map((event) => JSON.parse(event.payload))).toEqual([{ revision: 1 }]);
      } finally {
        await fix.dispose();
      }
    }, 60_000);

    test(`${mode} multibyte capacity refusal leaves the registry bytes unchanged`, async () => {
      const fix = await fixture(new Set(), mode === "hardened" ? builds : []);
      try {
        const historical: HostView[] = Array.from({ length: 4 }, (_, index) => ({
          id: `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
          name: "Historical host",
          members: Array.from({ length: 64 }, (_, member) => ({
            machineId: `historical-${index}-${member}`,
            accountLabel: "界".repeat(64),
          })),
        }));
        const registry = { revision: 4, hosts: historical };
        const stored = JSON.stringify(registry);
        const storage = fix.store.pluginStorage("core.machines");
        await storage.set("host-views", stored);
        const members = Array.from({ length: 64 }, (_, index) => ({
          machineId: fix.auth.enrollMachine(`account-${index}`, fix.owner).machine.id,
          accountLabel: "界".repeat(64),
        }));
        expect(denial(await fix.host.dispatch(fix.owner, "core.machines.setHostView", {
          expectedRevision: 4,
          host: {
            id: "40000000-0000-4000-8000-000000000004",
            name: "New host",
            members,
          },
        }))).toEqual({ rule: "refused", message: "host_view_capacity_exceeded" });
        expect(await storage.get("host-views")).toBe(stored);
        expect(fix.store.listEvents({ type: "host_views_changed", limit: 100 })).toEqual([]);
      } finally {
        await fix.dispose();
      }
    }, 60_000);
  }
});
