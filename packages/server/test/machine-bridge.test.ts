import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE_INSTALL_ACTION } from "@manifold/plugin";
import { compilePlugin } from "@manifold/plugin-kit/pack";
import {
  MachineBridgeResultSchemas,
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
import { parseBundle, PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";
import { portableFleetProbe } from "./fixtures/portable-fleet.ts";

/**
 * THE FLEET BRIDGE UNDER ATTACK (#259). The bridge is what a hardened guest can reach, so
 * these cases are written from the handler's side: a door that declares nothing, a container-
 * scoped door, a caller revoked mid-handler, a handler holding its ctx past its dispatch, and
 * ids the host no longer knows. The native handler and installed child exercise the shared
 * authority boundary; the trusted-bootstrap block runs the real `core.machines` build.
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

const openFixtures = new Set<Fixture>();

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
    bare: async (ctx: ActionCtx, args: { name: string }) =>
      refusal(ctx.identity.enrollMachine(args.name)),
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
  options: {
    trusted?: readonly TrustedBuild[];
    logger?: Logger;
    crashBudget?: number;
    idleEvictMs?: number;
    plugins?: readonly ServerPluginDef[];
  } = {},
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
    ...(options.idleEvictMs === undefined ? {} : { idleEvictMs: options.idleEvictMs }),
    ...(options.crashBudget === undefined
      ? {}
      : { crashBudget: { count: options.crashBudget, windowMs: 60_000 } }),
  });
  try {
    const host = await testPluginHost(store, auth, rooms, broker, runtime, {
      settingsPlugins: [probe, ...(options.plugins ?? [])],
      isolates: { runner, dataDir },
      ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const created = {
      store,
      auth,
      owner: auth.authenticate(OWNER_KEY),
      host,
      runtime,
      dataDir,
      runner,
    };
    openFixtures.add(created);
    return created;
  } catch (error) {
    await runner.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function close(fix: Fixture): Promise<void> {
  if (!openFixtures.delete(fix)) return;
  try {
    await fix.runner.close();
  } finally {
    fix.host.close();
    fix.store.close();
    rmSync(fix.dataDir, { recursive: true, force: true });
  }
}

afterEach(async () => {
  gate?.resolve();
  gate = null;
  reached = null;
  stashed = null;
  for (const fix of openFixtures) await close(fix);
});

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
    const answer = await fix.host.dispatch(fix.owner, `${PROBE}.bare`, { name: "sneak" });
    // A fully authorized caller cannot lend this door an undeclared native capability.
    expect(answer.ok ? null : answer.denial.rule).toBe("refused");
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
    expect(outcome.ok ? null : outcome.denial.rule).toBe("refused");
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
    const denied = await pending;
    expect(denied.ok ? null : denied.denial.rule).toBe("refused");
    gate = null;
    reached = null;
    expect(fix.auth.authenticateMachine(machine.machineToken).id).toBe(machine.machine.id);
    await close(fix);
  });

  test("unrelated roster recomposition preserves an admitted door's fleet authority", async () => {
    const fix = await fixture();
    const machine = fix.auth.enrollMachine("recomposition", fix.owner);
    gate = Promise.withResolvers<void>();
    reached = Promise.withResolvers<void>();
    const pending = fix.host.dispatch(fix.owner, `${PROBE}.rotate`, {
      machineId: machine.machine.id,
    });
    try {
      await reached.promise;
      expect(await fix.host.setEnabled("core.machines", false, "admin")).toEqual({ ok: true });
      gate.resolve();
      result(await pending);
      expect(() => fix.auth.authenticateMachine(machine.machineToken)).toThrow();
    } finally {
      gate?.resolve();
      await pending;
      gate = null;
      reached = null;
      await close(fix);
    }
  });

  test("a stale or forgotten id is re-resolved and refused, never rotated from a description", async () => {
    const fix = await fixture();
    const unknown = await fix.host.dispatch(fix.owner, `${PROBE}.rotate`, { machineId: "ghost" });
    expect(unknown.ok ? null : unknown.denial.rule).toBe("refused");
    const forgotten = fix.auth.enrollMachine("retired", fix.owner).machine.id;
    fix.auth.revokeMachine(forgotten, fix.owner);
    fix.auth.forgetMachine(forgotten, fix.owner);
    const stale = await fix.host.dispatch(fix.owner, `${PROBE}.rotate`, { machineId: forgotten });
    expect(stale.ok ? null : stale.denial.rule).toBe("refused");
    expect(fix.store.listTokensByPrincipal(forgotten)).toEqual([]);
    await close(fix);
  });

  test("a ctx held past its dispatch has no fleet authority left", async () => {
    const fix = await fixture();
    result(await fix.host.dispatch(fix.owner, `${PROBE}.stash`, {}));
    const late = stashed?.identity.enrollMachine("late");
    expect(late?.ok === false ? late.code : null).toBe("forbidden");
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

    expect(
      result(await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId })),
    ).toEqual({ revoked: 1 });
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
    expect(
      result(await fix.host.dispatch(fix.owner, "core.machines.revoke", { machineId })),
    ).toEqual({ revoked: 1 });
    await close(fix);
  }, 60_000);

  test("idle eviction and a recoverable crash preserve real machine bridge authority", async () => {
    const pids: number[] = [];
    const evicted = Promise.withResolvers<void>();
    const logger: Logger = {
      ...silentLogger,
      info: (event, fields) => {
        if (fields?.["plugin"] !== "core.machines") return;
        if (event === "isolate_spawned" && typeof fields["pid"] === "number")
          pids.push(fields["pid"]);
        if (event === "isolate_evicted") evicted.resolve();
      },
    };
    // This observes the real supervisor's idle timer and OS child retirement, not a fake clock.
    const fix = await fixture({ trusted: builds, logger, idleEvictMs: 100, crashBudget: 2 });
    await evicted.promise;
    expect(fix.runner.state("core.machines")).toBe("stopped");

    // This dispatch is admitted before spawning/reassembly; its live bridge must survive both.
    const enrolled = MachineEnrollResponseSchema.parse(
      result(await fix.host.dispatch(fix.owner, "core.machines.enroll", { name: "resumed" })),
    );
    expect(enrolled.machineToken).toBeDefined();
    expect(fix.auth.authenticateMachine(enrolled.machineToken ?? "").id).toBe(enrolled.machine.id);
    const pid = pids.at(-1);
    if (pid === undefined) throw new Error("no resumed child");
    const stopped = Promise.withResolvers<void>();
    const stop = fix.runner.onState((id, state, detail) => {
      if (id === "core.machines" && state === "stopped" && detail !== "idle") stopped.resolve();
    });
    try {
      process.kill(pid, "SIGKILL");
      await stopped.promise;
    } finally {
      stop();
    }
    const inventory = MachinesResponseSchema.parse(
      result(await fix.host.dispatch(fix.owner, "core.machines.list", {})),
    );
    expect(inventory.machines.map((machine) => machine.id)).toEqual([enrolled.machine.id]);
    expect(fix.runner.state("core.machines")).toBe("running");
    expect(new Set(pids).size).toBe(3);
    expect(fix.auth.authenticateMachine(enrolled.machineToken ?? "").id).toBe(enrolled.machine.id);
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

describe("authored child permission and retained trusted lifetime", () => {
  const id = portableFleetProbe.manifest.id;
  let build: TrustedBuild;
  beforeAll(async () => {
    const compiled = await compilePlugin(join(import.meta.dir, "fixtures"), {
      source: {
        manifest: portableFleetProbe.manifest,
        server: join(import.meta.dir, "fixtures/portable-fleet.ts"),
      },
    });
    build = { ...compiled, bundle: parseBundle(compiled.bytes) };
  }, 60_000);

  async function install(grant: readonly Cap[] = []): Promise<Fixture> {
    const fix = await fixture();
    mkdirSync(join(fix.dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
    const source = join(fix.dataDir, PLUGIN_UPLOADS_DIR, "fleet.manifold-plugin.json");
    writeFileSync(source, build.bytes);
    result(
      await fix.host.dispatch(fix.owner, ENGINE_INSTALL_ACTION, {
        source,
        sha256: build.sha256,
        hardened: true,
        grant,
      }),
    );
    return fix;
  }

  test("an installed grant cannot replace a door declaration or its caller's authority", async () => {
    const withheld = await install();
    const withheldResult = await withheld.host.dispatch(withheld.owner, `${id}.enroll`, {
      name: "withheld",
    });
    expect(withheldResult.ok ? null : withheldResult.denial.rule).toBe("forbidden");
    expect(withheld.store.getMachineByName("withheld")).toBeNull();
    await close(withheld);

    const fix = await install(["machines:mint", "containers:read"]);
    const enrollment = async (actor: AuthContext, action: string, name: string) =>
      MachineBridgeResultSchemas["identity.enrollMachine"].parse(
        result(await fix.host.dispatch(actor, `${id}.${action}`, { name })),
      );
    const bare = await enrollment(fix.owner, "bare", "undeclared");
    expect(bare.ok ? null : bare.code).toBe("forbidden");
    expect(fix.store.getMachineByName("undeclared")).toBeNull();
    const reader = caller(fix, ["containers:read"]);
    const borrowed = await fix.host.dispatch(reader, `${id}.enroll`, { name: "borrowed" });
    expect(borrowed.ok ? null : borrowed.denial.rule).toBe("forbidden");
    expect(fix.store.getMachineByName("borrowed")).toBeNull();

    const containerId = fix.runtime.newId();
    fix.store.createContainer({
      id: containerId,
      name: "scoped",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });
    const scoped = caller(fix, ["containers:read", "machines:mint"], containerId);
    const escaped = await enrollment(scoped, "enroll", "outside");
    expect(escaped.ok ? null : escaped.code).toBe("forbidden");
    expect(fix.store.getMachineByName("outside")).toBeNull();
    expect((await enrollment(fix.owner, "enroll", "authorized")).ok).toBe(true);
    expect(fix.store.getMachineByName("authorized")?.name).toBe("authorized");
    const inventory = MachineBridgeResultSchemas["machines.inventory"].parse(
      result(await fix.host.dispatch(scoped, `${id}.inventory`, {})),
    );
    if (!inventory.ok) throw new Error(`scoped inventory refused: ${inventory.code}`);
    expect(inventory.value.machines.map((machine) => machine.name)).toEqual(["authorized"]);
    await close(fix);
  }, 60_000);

  test("revocation between real child RPCs leaves the enrolled credential intact", async () => {
    const fix = await install(["machines:mint"]);
    const machine = fix.auth.enrollMachine("protected", fix.owner);
    const minter = caller(fix, ["machines:mint"]);
    const storage = fix.store.pluginStorage(id);
    const pending = fix.host.dispatch(minter, `${id}.delayedRotate`, {
      machineId: machine.machine.id,
    });
    try {
      // The other process reaches this durable barrier over real IPC; a fake clock cannot advance it.
      const deadline = Date.now() + 3_000;
      while ((await storage.get("entered")) !== "yes") {
        if (Date.now() >= deadline) throw new Error("child did not enter the rotation barrier");
        await Bun.sleep(1);
      }
      fix.auth.revokePrincipal(minter.principal.id, fix.owner);
      await storage.set("release", "yes");
      const denied = MachineBridgeResultSchemas["identity.rotateMachineToken"].parse(
        result(await pending),
      );
      expect(denied.ok ? null : denied.code).toBe("forbidden");
      expect(fix.auth.authenticateMachine(machine.machineToken).id).toBe(machine.machine.id);
    } finally {
      await storage.set("release", "yes");
      await pending;
    }
    await close(fix);
  }, 60_000);

  test("a held trusted child is retired and resumes cleanup while remaining disabled", async () => {
    // core.machines is unversioned; this actual authored fixture supplies a real data hold.
    const fix = await fixture({ plugins: [portableFleetProbe], trusted: [build] });
    const storage = fix.store.pluginStorage(id);
    const read = async () =>
      z
        .strictObject({ pid: z.number(), marker: z.string().nullable() })
        .parse(result(await fix.host.dispatch(fix.owner, `${id}.cleanup`, {})));
    await storage.set("marker", "retained");
    const before = await read();
    expect(before.pid).not.toBe(process.pid);
    await storage.stampDataVersion({ major: 99, minor: 0 });
    expect(await fix.host.setEnabled(PROBE, false, "admin")).toEqual({ ok: true });
    const held = fix.host.roster().find((row) => row.manifest.id === id);
    expect(held?.held).toBeDefined();
    expect(held?.enabled).toBe(false);
    expect(fix.runner.state(id)).toBe("stopped");
    expect((await fix.host.dispatch(fix.owner, `${id}.cleanup`, {})).ok).toBe(false);

    await storage.stampDataVersion({ major: 1, minor: 0 });
    expect(await fix.host.setEnabled(id, false, "admin")).toEqual({ ok: true });
    const released = fix.host.roster().find((row) => row.manifest.id === id);
    expect(released?.held).toBeUndefined();
    expect(released?.enabled).toBe(false);
    const after = await read();
    expect(after.marker).toBe("retained");
    expect(after.pid).not.toBe(process.pid);
    expect(after.pid).not.toBe(before.pid);
    expect(fix.runner.state(id)).toBe("running");
    await close(fix);
  }, 60_000);
});
