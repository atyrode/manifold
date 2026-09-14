import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import { MAX_ACTION_CALL_DEPTH, type ActionOutcome, type Cap } from "@manifold/protocol";
import { defineAction } from "@manifold/plugin";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { JobService } from "../src/job-service.ts";
import { serveCtxCall } from "../src/isolate/proxy-def.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import {
  PluginHost,
  type ActionCtx,
  type MachineAdmission,
  type ServerPluginDef,
} from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, type ServerStore, type StoredEvent } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testEventHub, testStore, testTileTrees } from "./helpers.ts";

/**
 * `ctx.actions.call` — ONE PLUGIN'S HANDLER AT ANOTHER PLUGIN'S DOOR (ADR 0041, #575).
 *
 * The whole subject of this file is AUTHORITY: the callee must see the principal of the
 * request the caller is serving and nothing more, so every case here asks the same question
 * twice — what the callee was told about who is asking, and what the ledger recorded about
 * who opened it. The composition rules (the declared edge, the two bounds) are asserted
 * beside them because they are the only thing this verb adds to the ladder.
 */

const OWNER_KEY = "b".repeat(64);
const CALLER = "test.a";
const CALLEE = "test.b";
const STRANGER = "test.c";
const OPTIONAL = "test.opt";

const OFFLINE_MACHINES: MachineAdmission = {
  isOnline: () => false,
  getTerminalExecution: () => null,
  drain: () => Promise.resolve({ ok: false, reason: "machine is offline" }),
  repository: () => Promise.resolve({ ok: false, reason: "machine is offline" }),
};

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
}

/** A plugin with no dependants and one open door, so a chain can be built out of copies. */
function relayDef(
  id: string,
  dependencies: Record<string, { type: "required" | "optional" | "incompatible" }>,
  next: string | null,
): ServerPluginDef {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: `${id} under test`,
      capabilities: [],
      dependencies,
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "relay",
        title: "Relay",
        caps: [],
        input: z.strictObject({ word: z.string().min(1) }),
        result: z.strictObject({ answer: z.unknown() }),
      }),
    ],
    handlers: {
      relay: async (ctx: ActionCtx, args: { word: string }) => {
        if (next === null) return { answer: { word: args.word } };
        return { answer: await ctx.actions.call({ plugin: next, action: "relay", input: args }) };
      },
    },
  };
}

/**
 * The pair the acceptance cases use: a caller that relays, probes and stages, and a callee
 * whose `echo` demands a capability of its own. `test.opt` is declared `optional` so it can be
 * switched off — a `required` dependency cannot be, the toggle door refuses it by name.
 *
 * The caller DECLARES `terminals:write` without using it in a door of its own: that is the
 * ceiling the operator's 2026-09-14 ruling requires of a caller, and declaring it is how a
 * plugin says out loud, on the manifest an installer reads, what its dependencies do for it.
 */
function pair(): readonly ServerPluginDef[] {
  const caller: ServerPluginDef = {
    manifest: {
      id: CALLER,
      version: "1.0.0",
      title: "Caller",
      description: "Calls its declared dependency.",
      capabilities: ["terminals:write"],
      dependencies: { [CALLEE]: { type: "required" }, [OPTIONAL]: { type: "optional" } },
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [{ id: "relayed", title: "Relayed" }],
      },
    },
    actions: [
      defineAction({
        name: "relay",
        title: "Relay a word to the dependency",
        caps: [],
        input: z.strictObject({ word: z.string().min(1) }),
        result: z.strictObject({ word: z.string(), principal: z.string() }),
      }),
      defineAction({
        name: "probe",
        title: "Call any door and answer whatever comes back",
        caps: [],
        input: z.strictObject({
          plugin: z.string(),
          action: z.string(),
          input: z.unknown(),
          proxy: z.boolean().optional(),
        }),
        result: z.strictObject({ answer: z.unknown() }),
      }),
      defineAction({
        name: "stage",
        title: "Emit, call, then refuse",
        caps: [],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
      defineAction({
        name: "loose",
        title: "Accept any argument at all",
        caps: [],
        // The one door in the fixture that does NOT refuse unknown keys, so a forged
        // attribution reaches a COMMITTED row rather than only a refused rung's.
        input: z.looseObject({ word: z.string().min(1) }),
        result: z.strictObject({ word: z.string() }),
      }),
    ],
    handlers: {
      relay: async (ctx: ActionCtx, args: { word: string }) =>
        ctx.actions.call({ plugin: CALLEE, action: "echo", input: { word: args.word } }),
      probe: async (
        ctx: ActionCtx,
        args: { plugin: string; action: string; input: unknown; proxy?: boolean },
      ) => {
        const request = { plugin: args.plugin, action: args.action, input: args.input };
        // `proxy` routes the identical request through the isolate boundary's own server
        // (`serveCtxCall`), which is what a hardened guest's `call` frame reaches.
        if (args.proxy === true) {
          return {
            answer: await serveCtxCall("actions.call", [request], { kind: "dispatch", ctx }),
          };
        }
        return { answer: await ctx.actions.call(request) };
      },
      stage: async (ctx: ActionCtx) => {
        ctx.emit({ kind: "plugin", pluginId: CALLER }, "relayed");
        await ctx.actions.call({ plugin: CALLEE, action: "echo", input: { word: "staged" } });
        return { refused: "the caller changed its mind" };
      },
      loose: async (_ctx: ActionCtx, args: { word: string }) => ({ word: args.word }),
    },
  };
  const callee: ServerPluginDef = {
    manifest: {
      id: CALLEE,
      version: "1.0.0",
      title: "Callee",
      description: "Answers its dependants.",
      capabilities: ["terminals:write"],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [{ id: "echoed", title: "Echoed" }],
      },
    },
    actions: [
      defineAction({
        name: "echo",
        title: "Echo a word",
        caps: ["terminals:write"],
        input: z.strictObject({ word: z.string().min(1) }),
        result: z.strictObject({ word: z.string(), principal: z.string() }),
      }),
      defineAction({
        name: "sulk",
        title: "Refuse on domain grounds",
        caps: [],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
      defineAction({
        name: "boom",
        title: "Break, rather than refuse",
        caps: [],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
    ],
    handlers: {
      echo: async (ctx: ActionCtx, args: { word: string }) => {
        ctx.emit({ kind: "plugin", pluginId: CALLEE }, "echoed");
        return { word: args.word, principal: ctx.principal.id };
      },
      sulk: async () => ({ refused: "the callee says no" }),
      boom: async () => {
        throw new Error("secret: the callee's own table is missing");
      },
    },
  };
  const stranger: ServerPluginDef = {
    manifest: {
      id: STRANGER,
      version: "1.0.0",
      title: "Stranger",
      description: "Nobody declared it.",
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "echo",
        title: "Echo",
        caps: [],
        input: z.strictObject({ word: z.string().min(1) }),
        result: z.strictObject({ word: z.string() }),
      }),
    ],
    handlers: { echo: async (_ctx: ActionCtx, args: { word: string }) => ({ word: args.word }) },
  };
  return [caller, callee, stranger, relayDef(OPTIONAL, {}, null)];
}

async function fixture(defs: readonly ServerPluginDef[] = pair()): Promise<Fixture> {
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
  let host: PluginHost | null = null;
  const events = testEventHub(
    store,
    auth,
    broker,
    () => {
      if (host === null) throw new Error("the event plane read the assembly before the host");
      return host.assembly();
    },
    runtime,
  );
  host = await PluginHost.boot(
    defs,
    store,
    auth,
    rooms,
    broker,
    new PlaceExecutor(
      store,
      rooms,
      broker,
      runtime,
      assemblyPlacementVocabulary(() => []),
      assemblyItemNouns(() => []),
    ),
    OFFLINE_MACHINES,
    new InstanceDialer(store, runtime, silentLogger, () => "http://localhost:7777"),
    runtime,
    silentLogger,
    events,
    {},
  );
  return { store, auth, owner: auth.authenticate(OWNER_KEY), host, runtime };
}

/** A minted token, so a narrower principal is real attenuation rather than a hand-built context. */
function guest(base: Fixture, caps: readonly Cap[]): AuthContext {
  const grant = base.auth.mintToken(
    { principal: { name: "guest", kind: "human" }, caps: [...caps] },
    base.owner,
  );
  return base.auth.authenticate(grant.token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error(`expected a denial, got ${JSON.stringify(outcome)}`);
  return outcome.denial;
}

function traces(base: Fixture): readonly StoredEvent[] {
  return base.store.listEvents({ type: TRACE_ROW_TYPE, limit: 100 });
}

function rowFor(base: Fixture, door: string): StoredEvent {
  const row = traces(base).find((candidate) => candidate.door === door);
  if (row === undefined) throw new Error(`no trace row for ${door}`);
  return row;
}

describe("a declared dependency's door", () => {
  test("opens under the CALLER'S principal, with the calling plugin as the origin", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.relay`, { word: "hi" });

    /*
      THE AUTHORITY CLAIM, from the callee's own mouth: `principal` is whatever `ctx.principal`
      said inside `test.b.echo`, and it is the client's — not a plugin identity, not the
      installer's, not root-by-composition. A plugin that gained authority by being called
      would show a different id here and nothing else in the system would notice.
    */
    expect(outcome).toEqual({
      ok: true,
      result: { word: "hi", principal: base.owner.principal.id },
    });

    const caller = rowFor(base, `${CALLER}.relay`);
    const callee = rowFor(base, `${CALLEE}.echo`);
    expect(callee.principalId).toBe(base.owner.principal.id);
    expect(callee.outcome).toBe("ok");
    // The ledger's own answer to "who opened this door": the calling PLUGIN, plus the row of
    // the dispatch it was serving, so the two frames of one trace read as one chain.
    expect(JSON.parse(callee.payload)).toEqual({
      word: "hi",
      origin: CALLER,
      parentTrace: caller.id,
    });
    base.store.close();
  });

  test("a client cannot forge the reserved attribution keys, on a committed row or a refused one", async () => {
    const base = await fixture();

    // A LOOSE door, so the forged pair survives argument parsing and reaches a committed row.
    expect(
      await base.host.dispatch(base.owner, `${CALLER}.loose`, {
        word: "hi",
        origin: "test.evil",
        parentTrace: 42,
      }),
    ).toEqual({ ok: true, result: { word: "hi" } });
    // And a STRICT door, whose write-ahead row is written before the arguments are graded.
    expect(
      denial(
        await base.host.dispatch(base.owner, `${CALLER}.relay`, {
          word: "hi",
          origin: "test.evil",
          parentTrace: 42,
        }),
      ).rule,
    ).toBe("invalid_args");

    /*
      `origin` and `parentTrace` are the LEDGER's names, not a door's: a reader auditing
      `core.events.list` must be able to take a row carrying them as proof that a plugin opened
      that door. Stripping them from every redacted body is what makes `traceOrigin` their one
      writer, so a client typing them into its own request attributes nothing to anybody.
    */
    for (const door of [`${CALLER}.loose`, `${CALLER}.relay`]) {
      const payload = JSON.parse(rowFor(base, door).payload) as Record<string, unknown>;
      expect(payload).toEqual({ word: "hi" });
    }
    base.store.close();
  });

  test("a callee that THROWS is not a refusal, and its error text never reaches the caller", async () => {
    const base = await fixture();

    for (const proxy of [false, true]) {
      const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
        plugin: CALLEE,
        action: "boom",
        input: {},
        proxy,
      });

      // The edge and the outcome, and nothing of the callee's internals: another plugin's
      // sentence — a constraint, a stack message — is not this caller's to publish, and the
      // class stays one a client can switch on. Identical in realm and through the proxy.
      expect(denial(outcome)).toEqual({
        rule: "refused",
        message: `refused: ${CALLER} -> ${CALLEE}.boom (failed)`,
      });
      expect(denial(outcome).message).not.toContain("secret");
    }
    // The two rows still tell the truth apart: the callee broke, the caller refused.
    expect(rowFor(base, `${CALLEE}.boom`).outcome).toBe("failed");
    expect(rowFor(base, `${CALLER}.probe`).outcome).toBe("refused");
    base.store.close();
  });

  test("a callee's staged emissions flush on ITS success while the caller's stay staged", async () => {
    const base = await fixture();

    // The caller emits, calls, and then refuses: one dispatch's staging must not be able to
    // hold another dispatch's announcement, and a refusal must publish nothing of its own.
    expect(denial(await base.host.dispatch(base.owner, `${CALLER}.stage`, {}))).toEqual({
      rule: "refused",
      message: "the caller changed its mind",
    });

    expect(base.store.listEvents({ type: "echoed", limit: 5 })).toHaveLength(1);
    expect(base.store.listEvents({ type: "relayed", limit: 5 })).toHaveLength(0);
    base.store.close();
  });

  test("a hardened guest reaches the same door through the proxy and gets the same result", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: CALLEE,
      action: "echo",
      input: { word: "through the wire" },
      proxy: true,
    });

    expect(outcome).toEqual({
      ok: true,
      result: { answer: { word: "through the wire", principal: base.owner.principal.id } },
    });
    base.store.close();
  });
});

describe("what a sibling call is refused by", () => {
  test("an undeclared plugin refuses undeclared_dependency, naming both", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: STRANGER,
      action: "echo",
      input: { word: "hi" },
    });

    // `test.c` is composed, enabled and has that door: the ONLY thing wrong is that nobody
    // wrote the edge down, which is the whole point of a declared dependency graph.
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `undeclared_dependency: ${CALLER} -> ${STRANGER}`,
    });
    expect(traces(base).some((row) => row.door === `${STRANGER}.echo`)).toBe(false);
    base.store.close();
  });

  test("a declared optional dependency that is off refuses dependency_unavailable, and the caller stays enabled", async () => {
    const base = await fixture();
    expect(await base.host.setEnabled(OPTIONAL, false, "admin")).toEqual({ ok: true });

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: OPTIONAL,
      action: "relay",
      input: { word: "hi" },
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `dependency_unavailable: ${CALLER} -> ${OPTIONAL}`,
    });
    // No cascade (ADR 0013 §5.5): the dependant keeps serving every door that does not need
    // the absent peer, and says so by name at the one that does.
    expect(base.host.assembly().enabled(CALLER)).toBe(true);
    expect(
      await base.host.dispatch(base.owner, `${CALLER}.relay`, { word: "still here" }),
    ).toMatchObject({ ok: true });
    base.store.close();
  });

  test("a declared dependency nothing composed is the same class", async () => {
    const base = await fixture([
      relayDef(CALLER, { "test.absent": { type: "optional" } }, "test.absent"),
    ]);

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.relay`, { word: "hi" });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `dependency_unavailable: ${CALLER} -> test.absent`,
    });
    base.store.close();
  });

  test("a principal without the callee's capability is refused AT the callee, with capability", async () => {
    const base = await fixture();
    const reader = guest(base, ["containers:read"]);

    const outcome = await base.host.dispatch(reader, `${CALLER}.relay`, { word: "hi" });

    /*
      THE CONFUSED DEPUTY, ANSWERED. `test.a.relay` demands no capability of its caller, so
      this principal opens it, and `test.a`'s own ceiling does declare `terminals:write`, so
      the caller-ceiling bound passes; `test.b.echo` demands `terminals:write` of the
      PRINCIPAL, which this one does not hold. The refusal is the CALLEE's rung 4 — a plugin
      cannot lend its caller authority the caller never had — and the two bounds are visibly
      different questions: `caller_ceiling` is about the manifest, `capability` about the
      credential.
    */
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `capability: ${CALLER} -> ${CALLEE}.echo (terminals:write capability required)`,
    });
    expect(rowFor(base, `${CALLEE}.echo`).outcome).toBe("forbidden");
    expect(base.store.listEvents({ type: "echoed", limit: 5 })).toHaveLength(0);
    base.store.close();
  });

  test("a caller whose own ceiling lacks the callee door's capability refuses caller_ceiling", async () => {
    /*
      THE REVIEWER'S REPRODUCTION, RULED ON (operator, 2026-09-14; ADR 0041 §3). `test.mgr`
      declares no capability at all and depends on the engine's assembly administration. Under
      the old rule an OWNER opening any of its doors administered the assembly on its behalf —
      an authority its installer's grant never gave it. The caller's own ceiling is now a
      second bound, so the sibling call is refused before the dispatch and the victim keeps
      serving; the owner may still open `engine.plugins.setEnabled` directly.
    */
    const manager: ServerPluginDef = {
      manifest: {
        id: "test.mgr",
        version: "1.0.0",
        title: "Manager",
        description: "Wants the assembly.",
        capabilities: [],
        dependencies: { "engine.plugins": { type: "required" } },
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "seize",
          title: "Disable a sibling through the engine's own door",
          caps: [],
          input: z.strictObject({ id: z.string() }),
          result: z.strictObject({ answer: z.unknown() }),
        }),
      ],
      handlers: {
        seize: async (ctx: ActionCtx, args: { id: string }) => ({
          answer: await ctx.actions.call({
            plugin: "engine.plugins",
            action: "setEnabled",
            input: { id: args.id, enabled: false },
          }),
        }),
      },
    };
    const base = await fixture([manager, relayDef("test.victim", {}, null)]);

    const outcome = await base.host.dispatch(base.owner, "test.mgr.seize", { id: "test.victim" });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "caller_ceiling: test.mgr -> engine.plugins.setEnabled (plugins:manage)",
    });
    expect(base.host.assembly().enabled("test.victim")).toBe(true);
    expect(traces(base).some((row) => row.door === "engine.plugins.setEnabled")).toBe(false);
    // The principal's own authority is untouched: the owner still opens that door directly.
    expect(
      await base.host.dispatch(base.owner, "engine.plugins.setEnabled", {
        id: "test.victim",
        enabled: false,
      }),
    ).toEqual({ ok: true, result: {} });
    base.store.close();
  });

  test("the same bound crossing the proxy, and a declared ceiling still succeeds", async () => {
    const base = await fixture();

    // `test.a` declares `terminals:write`, which is what `test.b.echo` demands: the ceiling
    // holds, so the call goes through — in realm and through the hardened path alike.
    expect(
      await base.host.dispatch(base.owner, `${CALLER}.probe`, {
        plugin: CALLEE,
        action: "echo",
        input: { word: "within" },
        proxy: true,
      }),
    ).toMatchObject({ ok: true });

    // `test.opt.relay` declares no caps at all, so an empty-ceiling call is not refused either:
    // the bound is the callee DOOR's demands, not a requirement to declare something.
    expect(
      await base.host.dispatch(base.owner, `${CALLER}.probe`, {
        plugin: OPTIONAL,
        action: "relay",
        input: { word: "open" },
        proxy: true,
      }),
    ).toEqual({ ok: true, result: { answer: { answer: { word: "open" } } } });
    base.store.close();
  });

  test("an engine builtin callee runs under the caller's native ceiling, not its caller's caps", async () => {
    /*
      THE OTHER HALF OF THE CEILING RULE. `engine.jobs`'s doors declare NO caps of their own
      and resolve authority from the context they are handed, so the caps check above cannot
      see them: a `capabilities: []` plugin depending on `engine.jobs` would otherwise execute
      a job with its caller's whole credential, while its own `ctx.jobs.execute` — the same
      mechanism, reached by method name — carries the ceiling its manifest declared. A builtin
      callee is therefore dispatched under `nativeAuth`.
    */
    const runner: ServerPluginDef = {
      manifest: {
        id: "test.runner",
        version: "1.0.0",
        title: "Runner",
        description: "Wants the engine's jobs.",
        capabilities: [],
        dependencies: { "engine.jobs": { type: "required" } },
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "ask",
          title: "Describe a machine's jobs through the engine's own door",
          caps: [],
          input: z.strictObject({ machineId: z.string() }),
          result: z.strictObject({ answer: z.unknown() }),
        }),
      ],
      handlers: {
        ask: async (ctx: ActionCtx, args: { machineId: string }) => ({
          answer: await ctx.actions.call({
            plugin: "engine.jobs",
            action: "describe",
            input: { machineId: args.machineId, pluginId: "test.runner" },
          }),
        }),
      },
    };
    const base = await fixture([runner]);
    base.host.setJobs(new JobService(base.store, base.auth, base.runtime));
    const machineId = base.auth.enrollMachine("runner-host", base.owner).machine.id;

    const outcome = await base.host.dispatch(base.owner, "test.runner.ask", { machineId });

    // The OWNER holds `machines:run` at that machine; `test.runner` declared nothing, so the
    // engine's door refuses the read it would have answered for the owner's own dispatch.
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "refused: test.runner -> engine.jobs.describe (forbidden: job request refused)",
    });
    expect(rowFor(base, "engine.jobs.describe").outcome).toBe("refused");
    expect(
      await base.host.dispatch(base.owner, "engine.jobs.describe", {
        machineId,
        pluginId: "test.runner",
      }),
    ).toMatchObject({ ok: true });
    base.store.close();
  });

  test("a callee door guarded by its OWN namespaced capability is reachable", async () => {
    /*
      ADR 0035's shape, and `atyrode.code.runSession`'s: the callee guards its door with a cap
      in its OWN namespace. A manifest may declare only its own namespace, so a caller could
      never hold `test.own:echo` — demanding it of the caller's ceiling would make every such
      door unreachable. The ceiling therefore bounds ENGINE caps only; a namespaced cap is the
      callee's own gate, graded against the PRINCIPAL at the callee, which is where the grant
      rows for it live.
    */
    const own: ServerPluginDef = {
      manifest: {
        id: "test.own",
        version: "1.0.0",
        title: "Own",
        description: "Guards its door with its own capability.",
        capabilities: ["test.own:echo"],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "echo",
          title: "Echo behind a namespaced capability",
          caps: ["test.own:echo"],
          input: z.strictObject({ word: z.string().min(1) }),
          result: z.strictObject({ word: z.string() }),
        }),
      ],
      handlers: { echo: async (_ctx: ActionCtx, args: { word: string }) => ({ word: args.word }) },
    };
    const asker: ServerPluginDef = {
      manifest: {
        id: CALLER,
        version: "1.0.0",
        title: "Asker",
        description: "Depends on a plugin with a capability of its own.",
        // Nothing: a manifest may declare only its OWN namespace, so this caller COULD not
        // hold `test.own:echo` however much it wanted to.
        capabilities: [],
        dependencies: { "test.own": { type: "required" } },
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "relay",
          title: "Relay to the namespaced door",
          caps: [],
          input: z.strictObject({ word: z.string().min(1) }),
          result: z.strictObject({ answer: z.unknown() }),
        }),
      ],
      handlers: {
        relay: async (ctx: ActionCtx, args: { word: string }) => ({
          answer: await ctx.actions.call({ plugin: "test.own", action: "echo", input: args }),
        }),
      },
    };
    const base = await fixture([asker, own]);
    // The ROOT credential holds a plugin's capability only where a grant row names it (ADR
    // 0035), so the principal is granted it here — which is the point: the cap is the callee's
    // gate on the caller's CLIENT, and the caller's manifest never mentions it.
    base.auth.grant(
      {
        principal: { kind: "principal", id: base.owner.principal.id },
        node: "manifold://",
        caps: ["test.own:echo"],
        effect: "allow",
        reach: "subtree",
      },
      base.owner,
    );

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.relay`, { word: "hi" });

    expect(outcome).toEqual({ ok: true, result: { answer: { word: "hi" } } });
    // And the principal's own gate still holds: a client without the grant is refused AT the
    // callee, which is where a namespaced cap is graded.
    expect(
      denial(
        await base.host.dispatch(guest(base, ["containers:read"]), `${CALLER}.relay`, {
          word: "hi",
        }),
      ),
    ).toEqual({
      rule: "refused",
      message: `capability: ${CALLER} -> test.own.echo (test.own:echo capability required)`,
    });
    base.store.close();
  });

  test("a door the callee does not publish refuses unknown_action", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: CALLEE,
      action: "ghost",
      input: {},
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `unknown_action: ${CALLEE}.ghost`,
    });
    base.store.close();
  });

  test("the callee's own refusal propagates with the callee named", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: CALLEE,
      action: "sulk",
      input: {},
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `refused: ${CALLER} -> ${CALLEE}.sulk (the callee says no)`,
    });
    base.store.close();
  });

  test("a plugin already on the trace refuses dispatch_cycle", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: CALLER,
      action: "relay",
      input: { word: "hi" },
    });

    /*
      The caller is the first frame on its own trace, so a plugin reaching for its own door
      meets the bound rather than the edge: `undeclared_dependency` would send an author to
      declare a self-dependency, which composition refuses outright. A -> B -> A is refused by
      the same line, one frame later; the declared-edge graph is acyclic today, and the stack
      is what keeps that true for any future caller of this verb.
    */
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `dispatch_cycle: ${CALLER} -> ${CALLER}`,
    });
    base.store.close();
  });

  test("a chain one plugin deeper than the bound refuses dispatch_depth", async () => {
    // A legal DAG: nine plugins, each declaring the next `required`, each relaying to it. The
    // client's dispatch is frame 1, so the ninth plugin is the frame the bound refuses.
    const ids = Array.from({ length: MAX_ACTION_CALL_DEPTH + 1 }, (_, index) => `test.p${index}`);
    const base = await fixture(
      ids.map((id, index) => {
        const next = ids[index + 1] ?? null;
        return relayDef(id, next === null ? {} : { [next]: { type: "required" } }, next);
      }),
    );

    const outcome = await base.host.dispatch(base.owner, `${ids[0] ?? ""}.relay`, { word: "deep" });

    const denied = denial(outcome);
    expect(denied.rule).toBe("refused");
    expect(denied.message).toContain(`dispatch_depth: ${ids.join(" -> ")}`);
    // Frame 8 refused before it dispatched, so the deepest door was never opened.
    expect(
      traces(base).some((row) => row.door === `${ids[MAX_ACTION_CALL_DEPTH] ?? ""}.relay`),
    ).toBe(false);
    expect(
      traces(base).filter((row) => row.door === `test.p${MAX_ACTION_CALL_DEPTH - 1}.relay`),
    ).toHaveLength(1);
    base.store.close();
  });

  test("a refusal crossing the isolate boundary is the same sentence, thrown", async () => {
    const base = await fixture();

    const outcome = await base.host.dispatch(base.owner, `${CALLER}.probe`, {
      plugin: STRANGER,
      action: "echo",
      input: { word: "hi" },
      proxy: true,
    });

    // The proxy throws, the supervisor answers `{ ok: false, error }`, the guest runtime raises
    // `HostCallError` with this detail, and an uncaught one refuses the guest's dispatch — so a
    // hardened caller and an in-realm caller read the identical class and offenders.
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: `undeclared_dependency: ${CALLER} -> ${STRANGER}`,
    });
    base.store.close();
  });
});
