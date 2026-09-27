import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MachineEnrollResponseSchema,
  MachinesResponseSchema,
  PLUGIN_BUNDLE_WEB_WORKER_FILE,
  identityColorFor,
  type ActionOutcome,
  type Cap,
  type PluginManifest,
} from "@manifold/protocol";
import { z } from "zod";
import { HARDENED_SOURCE_RECIPES, SERVER_PLUGIN_DEFS } from "../src/assembly.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import {
  compileTrustedBuilds,
  trustedArtifactFile,
  type TrustedBuild,
} from "../src/first-party-builds.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import type { ActionCtx, PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * THE FLEET BRIDGE UNDER ATTACK (#259). The bridge is what a hardened guest can reach, so
 * these cases are written from the handler's side: a door that declares nothing, a container-
 * scoped door, a caller revoked mid-handler, a handler holding its ctx past its dispatch, and
 * ids the host no longer knows. The in-realm handler reaches the SAME object, so each case is
 * the proof for both modes; the hardened block runs the real `core.machines` build in a child.
 */

const OWNER_KEY = "e".repeat(64);
const PROBE = "test.fleetprobe";

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
  readonly dataDir: string;
  readonly runner: IsolateSupervisor;
}

const probeManifest: PluginManifest = {
  id: PROBE,
  version: "1.0.0",
  title: "Fleet probe",
  description: "Handlers that reach for the fleet bridge from doors of every shape.",
  capabilities: ["machines:mint", "containers:read"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
};

let stashed: ActionCtx | null = null;
let gate: PromiseWithResolvers<void> | null = null;
let reached: PromiseWithResolvers<void> | null = null;

const refusal = (answer: { ok: boolean; message?: string }): unknown =>
  answer.ok ? answer : { refused: answer.message };

const probe: ServerPluginDef = {
  manifest: probeManifest,
  actions: [
    // Declares NOTHING: whatever its caller holds, its native ceiling holds no fleet authority.
    {
      name: "bare",
      title: "Bare",
      caps: [],
      input: z.strictObject({ name: z.string() }),
      result: z.unknown(),
    },
    {
      name: "scoped",
      title: "Scoped",
      caps: ["machines:mint"],
      scope: "container",
      input: z.strictObject({ name: z.string() }),
      result: z.unknown(),
    },
    {
      name: "rotate",
      title: "Rotate",
      caps: ["machines:mint"],
      input: z.strictObject({ machineId: z.string() }),
      result: z.unknown(),
    },
    {
      name: "stash",
      title: "Stash",
      caps: ["machines:mint"],
      input: z.strictObject({}),
      result: z.unknown(),
    },
  ],
  handlers: {
    bare: async (ctx: ActionCtx, args: { name: string }) => ({
      callerMayMint: ctx.auth.allows("machines:mint"),
      ...(refusal(ctx.identity.enrollMachine(args.name)) as object),
    }),
    scoped: async (ctx: ActionCtx, args: { name: string }) =>
      refusal(ctx.identity.enrollMachine(args.name)),
    rotate: async (ctx: ActionCtx, args: { machineId: string }) => {
      reached?.resolve();
      await gate?.promise;
      return refusal(ctx.identity.rotateMachineToken(args.machineId));
    },
    stash: async (ctx: ActionCtx) => {
      stashed = ctx;
      return {};
    },
  },
};

async function fixture(
  options: { trusted?: readonly TrustedBuild[]; logger?: Logger; crashBudget?: number } = {},
): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
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
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-machine-bridge-"));
  const runner = new IsolateSupervisor({
    logger: options.logger ?? silentLogger,
    runtime,
    ...(options.crashBudget === undefined
      ? {}
      : { crashBudget: { count: options.crashBudget, windowMs: 60_000 } }),
  });
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: [probe],
    isolates: { runner, dataDir },
    ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { store, auth, owner: auth.authenticate(OWNER_KEY), host, runtime, dataDir, runner };
}

async function close(fix: Fixture): Promise<void> {
  await fix.runner.close();
  fix.host.close();
  fix.store.close();
  rmSync(fix.dataDir, { recursive: true, force: true });
}

function caller(fix: Fixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = fix.auth.mintToken(
    {
      principal: { name: "caller", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    fix.owner,
  );
  return fix.auth.authenticate(grant.token);
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected a result: ${outcome.denial.message}`);
  return outcome.result;
}

describe("the fleet bridge's authority", () => {
  test("a door that declares no fleet capability mints nothing, even for the owner", async () => {
    const fix = await fixture();
    const answer = result(await fix.host.dispatch(fix.owner, `${PROBE}.bare`, { name: "sneak" }));
    // The caller's own question says yes; the door's native ceiling is what the bridge asks.
    expect(answer).toEqual({ callerMayMint: true, refused: "machines:mint capability required" });
    expect(fix.store.getMachineByName("sneak")).toBeNull();
    await close(fix);
  });

  test("a container-scoped door cannot enroll, though its scoped caller holds machines:mint", async () => {
    const fix = await fixture();
    const containerId = fix.runtime.newId();
    fix.store.createContainer({
      id: containerId,
      name: "scoped",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });
    const scoped = caller(fix, ["machines:mint"], containerId);
    const outcome = await fix.host.dispatch(scoped, `${PROBE}.scoped`, { name: "inside" });
    expect(result(outcome)).toEqual({ refused: "machines:mint capability required" });
    expect(fix.store.getMachineByName("inside")).toBeNull();
    await close(fix);
  });

  test("a caller revoked mid-handler rotates nothing, and the machine keeps its credential", async () => {
    const fix = await fixture();
    const machine = fix.auth.enrollMachine("alpha", fix.owner);
    const minter = caller(fix, ["machines:mint"]);
    gate = Promise.withResolvers<void>();
    reached = Promise.withResolvers<void>();
    const pending = fix.host.dispatch(minter, `${PROBE}.rotate`, {
      machineId: machine.machine.id,
    });
    // Admitted and inside the handler, holding its ctx, before authority is withdrawn.
    await reached.promise;
    fix.auth.revokePrincipal(minter.principal.id, fix.owner);
    gate.resolve();
    expect(result(await pending)).toEqual({ refused: "machines:mint capability required" });
    gate = null;
    reached = null;
    expect(fix.auth.authenticateMachine(machine.machineToken).id).toBe(machine.machine.id);
    await close(fix);
  });

  test("a stale or forgotten id is re-resolved and refused, never rotated from a description", async () => {
    const fix = await fixture();
    const unknown = await fix.host.dispatch(fix.owner, `${PROBE}.rotate`, { machineId: "ghost" });
    expect(result(unknown)).toEqual({ refused: "machine not found" });
    const forgotten = fix.auth.enrollMachine("retired", fix.owner).machine.id;
    fix.auth.revokeMachine(forgotten, fix.owner);
    fix.auth.forgetMachine(forgotten, fix.owner);
    const stale = await fix.host.dispatch(fix.owner, `${PROBE}.rotate`, { machineId: forgotten });
    expect(result(stale)).toEqual({ refused: "machine not found" });
    expect(fix.store.listTokensByPrincipal(forgotten)).toEqual([]);
    await close(fix);
  });

  test("a ctx held past its dispatch has no fleet authority left", async () => {
    const fix = await fixture();
    result(await fix.host.dispatch(fix.owner, `${PROBE}.stash`, {}));
    const late = stashed?.identity.enrollMachine("late");
    expect(late).toEqual({
      ok: false,
      code: "forbidden",
      message: "plugin authority unavailable",
    });
    expect(stashed?.machines.inventory().ok).toBe(false);
    expect(fix.store.getMachineByName("late")).toBeNull();
    stashed = null;
    await close(fix);
  });
});

/**
 * THE REAL `core.machines` BUILD, HARDENED: compiled by the composition root's own recipe,
 * bound to the registered definition, supervised in a child, and dispatched through the same
 * ladder. Nothing here is a fixture guest.
 */
describe("core.machines hardened by the trusted bootstrap", () => {
  let builds: readonly TrustedBuild[] = [];
  beforeAll(async () => {
    builds = await compileTrustedBuilds(
      ["core.machines"],
      SERVER_PLUGIN_DEFS,
      HARDENED_SOURCE_RECIPES,
    );
  }, 120_000);
  afterAll(() => {
    builds = [];
  });

  test("an id the build does not register, or cannot compile hardened, fails by name", async () => {
    await expect(
      compileTrustedBuilds(["core.nothing"], SERVER_PLUGIN_DEFS, HARDENED_SOURCE_RECIPES),
    ).rejects.toThrow('"core.nothing" is not a plugin this build registers');
    await expect(
      compileTrustedBuilds(["core.terminals"], SERVER_PLUGIN_DEFS, HARDENED_SOURCE_RECIPES),
    ).rejects.toThrow('"core.terminals" has no hardened source recipe');
  });

  test("a packaged hub's build-time artifact binds to the registered definition or fails by name", async () => {
    const build = builds[0];
    if (build === undefined) throw new Error("no build");
    const dir = mkdtempSync(join(tmpdir(), "manifold-first-party-artifacts-"));
    try {
      const select = () =>
        compileTrustedBuilds(["core.machines"], SERVER_PLUGIN_DEFS, HARDENED_SOURCE_RECIPES, dir);
      await expect(select()).rejects.toThrow("core.machines: hardened build failed");
      writeFileSync(trustedArtifactFile(dir, "core.machines"), build.bytes);
      expect((await select()).map(({ sha256 }) => sha256)).toEqual([build.sha256]);
      // Same compiler output, one declaration changed: not this binary's registered plugin.
      const drifted = { ...build.bundle, manifest: { ...build.bundle.manifest, version: "9.9.9" } };
      writeFileSync(trustedArtifactFile(dir, "core.machines"), JSON.stringify(drifted));
      await expect(select()).rejects.toThrow(
        "core.machines: hardened build refused: its manifest is not the registered manifest",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runs the same doors in a child: atomic enrollment, inventory, withdrawal, and its effective mode", async () => {
    const fix = await fixture({ trusted: builds });
    const row = fix.host.roster().find((entry) => entry.manifest.id === "core.machines");
    expect(row?.hardened).toBe(true);
    expect(row?.install).toBeUndefined();

    // Two concurrent enrolments of one name across the process boundary: one machine, one token.
    const [first, second] = (
      await Promise.all([
        fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
        fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "alpha" }),
      ])
    ).map((outcome) => MachineEnrollResponseSchema.parse(result(outcome)));
    expect(first?.machine.id).toBe(second?.machine.id ?? "");
    const tokens = [first?.machineToken, second?.machineToken].filter(
      (token) => token !== undefined,
    );
    expect(tokens).toHaveLength(1);
    const machineId = first?.machine.id ?? "";
    expect(fix.auth.authenticateMachine(tokens[0] ?? "").id).toBe(machineId);

    const listed = MachinesResponseSchema.parse(
      result(await fix.host.dispatch(fix.owner, "core.machines.list", {})),
    );
    expect(listed.machines).toEqual([
      { id: machineId, name: "alpha", online: false, color: identityColorFor(machineId) },
    ]);

    // A caller without the door's capability is refused at the ladder, before the child is asked.
    const reader = caller(fix, ["containers:read"]);
    const denied = await fix.host.dispatch(reader, "core.machines.revoke", { machineId });
    expect(denied.ok).toBe(false);
    expect(fix.store.revokedMachineIds().has(machineId)).toBe(false);

    expect(result(await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId }))).toEqual(
      { revoked: 1 },
    );
    expect(fix.store.listEvents({ type: "trace", limit: 1 })[0]).toMatchObject({
      door: "core.machines.revoke",
      outcome: "ok",
      targets: [`manifold://machine/${machineId}`],
    });
    expect(() => fix.auth.authenticateMachine(tokens[0] ?? "")).toThrow();
    await close(fix);
  }, 60_000);

  test("serves its portable Worker entry only while enabled, and disable keeps cleanup reachable", async () => {
    const fix = await fixture({ trusted: builds });
    const build = builds[0];
    if (build === undefined) throw new Error("no build");
    const served = fix.host.webWorkerModule("core.machines");
    expect(served?.sha256).toBe(build.sha256);
    expect(Buffer.from(served?.bytes ?? new Uint8Array()).toString("base64")).toBe(
      build.bundle.files[PLUGIN_BUNDLE_WEB_WORKER_FILE] ?? "",
    );
    // A first-party row has no installed web module to hand out.
    expect(fix.host.webModule("core.machines")).toBeNull();

    const machineId = fix.auth.enrollMachine("cut", fix.owner).machine.id;
    expect(await fix.host.setEnabled("core.machines", false, "admin")).toEqual({ ok: true });
    expect(fix.host.webWorkerModule("core.machines")).toBeNull();
    const enroll = await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "late" });
    expect(enroll.ok ? null : enroll.denial.rule).toBe("plugin_disabled");
    expect(result(await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId }))).toEqual(
      { revoked: 1 },
    );
    await close(fix);
  }, 60_000);

  test("a crashed child is published on the roster and refuses rather than falling back in-realm", async () => {
    const pids: number[] = [];
    const logger: Logger = {
      ...silentLogger,
      info: (event, fields) => {
        if (event === "isolate_spawned" && typeof fields?.["pid"] === "number")
          pids.push(fields["pid"]);
      },
    };
    const fix = await fixture({ trusted: builds, logger, crashBudget: 1 });
    const pid = pids.at(-1);
    if (pid === undefined) throw new Error("no child spawned");
    // The roster publication is the signal: the host reconciles the runner's crash onto it.
    const crashed = Promise.withResolvers<void>();
    const stop = fix.host.onRosterChange((roster) => {
      const row = roster.find((entry) => entry.manifest.id === "core.machines");
      if (row?.lifecycle === "isolate_crashed") crashed.resolve();
    });
    process.kill(pid, "SIGKILL");
    await crashed.promise;
    stop();
    const row = fix.host.roster().find((entry) => entry.manifest.id === "core.machines");
    expect(row?.hardened).toBe(true);
    const outcome = await fix.host.dispatch(fix.owner, "core.machines.list", {});
    expect(outcome.ok ? null : outcome.denial.rule).toBe("unavailable");
    await close(fix);
  }, 60_000);
});
