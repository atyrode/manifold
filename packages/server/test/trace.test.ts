import { describe, expect, test } from "bun:test";
import { defineAction } from "@manifold/plugin";
import { EventsListResponseSchema } from "@manifold-plugin/events";
import {
  ContainerResponseSchema,
  PlaceResponseSchema,
  TRACE_AUTHORITY_OPEN,
  TRACE_AUTHORITY_ROOT,
  TRACE_OUTCOMES,
  TRACED_DENIAL_RULES,
  UNTRACED_DENIAL_RULE,
  type Cap,
} from "@manifold/protocol";
import { tileIdForRef } from "@manifold/scene";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { PluginHost, type ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, type ServerStore, type StoredEvent } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  hostWithSeatOff,
  testEventHub,
  testPluginHost,
  testStore,
} from "./helpers.ts";

/**
 * THE TRACE LEDGER (axiom A6, ADR 0018).
 *
 * The ladder's claim is not "handlers remember to record what they did" — it is that a dispatch
 * CANNOT reach a handler without its attribution already being durable, and cannot answer
 * without an outcome settled onto that row. So these cases assert the property at the ladder:
 * every rung that refuses leaves a row, a handler that throws leaves a row, a mutation rolled
 * back by its own store transaction still leaves a row, and the one name that leaves none is
 * the one the ADR rules out by argument rather than by accident.
 */

const OWNER_KEY = "b".repeat(64);
const TEST_ORIGIN = "http://localhost:7777";

/**
 * What the ledger keeps instead of an oversize argument list: the shape, never the bytes.
 * Declared as a schema so the assertion reads a validated value rather than an asserted one.
 */
const OversizePayloadSchema = z.strictObject({
  oversize: z.number().int(),
  keys: z.array(z.string()),
});

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly runtime: FakeRuntime;
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
  readonly host: PluginHost;
}

function fixture(): Fixture {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const rooms = new RoomManager(store, runtime, clock, silentLogger);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => TEST_ORIGIN,
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  return {
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    runtime,
    rooms,
    broker,
    host: testPluginHost(store, auth, rooms, broker, runtime),
  };
}

/** A real token, so authority is exercised through attenuation rather than a hand-built context. */
function tokenContext(base: Fixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = base.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    base.owner,
  );
  return base.auth.authenticate(grant.token);
}

/** The ledger, newest first — read the way `core.events.list` reads it. */
function traces(base: Fixture): readonly StoredEvent[] {
  return base.store.listEvents({ type: TRACE_ROW_TYPE, limit: 100 });
}

function newestTrace(base: Fixture): StoredEvent {
  const row = traces(base)[0];
  if (row === undefined) throw new Error("the ledger recorded nothing");
  return row;
}

/**
 * A plugin composed to break in specific places. Every handler here exists to put the ledger
 * under a failure the real doors are not supposed to have: a throw after a write, a throw
 * INSIDE a store transaction, a peek at the ledger from inside the dispatch it belongs to, and
 * an argument list carrying things that must never be persisted.
 */
function probeDefs(): readonly ServerPluginDef[] {
  return [
    {
      manifest: {
        id: "test.probe",
        version: "0.0.0",
        title: "Trace probe",
        description: "Doors that fail on purpose, so the ledger can be observed failing with them.",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "explodeAfterWrite",
          title: "Writes a container, then throws",
          caps: [],
          input: z.strictObject({ containerId: z.string().min(1) }),
          result: z.strictObject({}),
        }),
        defineAction({
          name: "rollbackWrite",
          title: "Writes a container inside a transaction that then throws",
          caps: [],
          input: z.strictObject({ containerId: z.string().min(1) }),
          result: z.strictObject({}),
        }),
        defineAction({
          name: "peekLedger",
          title: "Reads the ledger from inside its own dispatch",
          caps: [],
          input: z.strictObject({}),
          result: z.strictObject({ own: z.number(), outcome: z.string().nullable() }),
        }),
        defineAction({
          name: "keepSecrets",
          title: "Takes arguments nothing may persist",
          caps: [],
          input: z.strictObject({
            secret: z.string(),
            token: z.string(),
            data: z.string(),
            keep: z.string(),
          }),
          result: z.strictObject({}),
        }),
        defineAction({
          name: "refuseLoudly",
          title: "Refuses as data after naming a node",
          caps: [],
          input: z.strictObject({}),
          result: z.strictObject({}),
        }),
      ],
      handlers: {
        explodeAfterWrite: async (
          ctx: { store: ServerStore; now(): number },
          args: { containerId: string },
        ) => {
          ctx.store.createContainer({
            id: args.containerId,
            name: "written",
            createdAt: ctx.now(),
            discipline: "canvas",
          });
          throw new Error("the door broke after committing");
        },
        rollbackWrite: async (
          ctx: { store: ServerStore; now(): number },
          args: { containerId: string },
        ) => {
          ctx.store.transaction(() => {
            ctx.store.createContainer({
              id: args.containerId,
              name: "rolled back",
              createdAt: ctx.now(),
              discipline: "canvas",
            });
            throw new Error("the unit of work broke");
          });
          return {};
        },
        peekLedger: async (ctx: { store: ServerStore }) => {
          const own = ctx.store
            .listEvents({ type: TRACE_ROW_TYPE, limit: 10 })
            .filter((row) => row.door === "test.probe.peekLedger");
          return { own: own.length, outcome: own[0]?.outcome ?? null };
        },
        keepSecrets: async () => ({}),
        refuseLoudly: async (ctx: {
          emit(ref: { kind: "plugin"; pluginId: string }, kind: string, payload: unknown): void;
        }) => {
          ctx.emit({ kind: "plugin", pluginId: "test.probe" }, "probe_named", {});
          return { refused: "not today" };
        },
      },
    },
  ];
}

function probeHost(base: Fixture): PluginHost {
  let host: PluginHost | null = null;
  const events = testEventHub(
    base.store,
    base.auth,
    base.broker,
    () => {
      if (host === null) throw new Error("the event plane read the assembly before the host");
      return host.assembly();
    },
    base.runtime,
  );
  host = new PluginHost(
    probeDefs(),
    base.store,
    base.auth,
    base.rooms,
    base.broker,
    new PlaceExecutor(
      base.store,
      base.rooms,
      base.broker,
      base.runtime,
      assemblyPlacementVocabulary(() => []),
      assemblyItemNouns(() => []),
    ),
    { isOnline: () => false },
    new InstanceDialer(base.store, base.runtime, silentLogger, () => TEST_ORIGIN),
    base.runtime,
    silentLogger,
    events,
  );
  return host;
}

describe("the trace ledger records every exercise of authority", () => {
  test("an ok dispatch leaves ONE settled row naming door, actor, authority and targets", async () => {
    const base = fixture();

    const outcome = await base.host.dispatch(
      base.owner,
      "core.index.createContainer",
      { name: "traced" },
      "sock-7",
    );
    expect(outcome.ok).toBeTrue();

    const rows = traces(base);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.type).toBe(TRACE_ROW_TYPE);
    expect(row.door).toBe("core.index.createContainer");
    expect(row.principalId).toBe(base.owner.principal.id);
    // The owner key IS the wildcard, so `root` is what was satisfied — recording
    // `containers:write` would name a grant nothing consulted.
    expect(row.authority).toBe(TRACE_AUTHORITY_ROOT);
    expect(row.outcome).toBe("ok");
    // The nodes the door NAMED, read off the same emission the event plane carries — the index
    // announces on its own collection node, so that is the target.
    expect(row.targets).toEqual(["manifold://plugin/core.index"]);
    expect(row.session).toBe("sock-7");
    expect(JSON.parse(row.payload)).toEqual({ name: "traced" });
    base.store.close();
  });

  test("leaf removal — the door that used to commit untraced — leaves a settled `ok` row", async () => {
    /*
      THE A6 GAP, closed and pinned (issue #114). `DELETE /api/containers/:id/tiles/:tileId`
      committed workspace state through the HTTP layer, so no rung of this ladder ever ran for
      it: a mutation landed and the ledger stayed silent, which is the state A6 declares
      unreachable. The T3 gate covers the door's ARGUMENT rung against a live server; what this
      case pins is the half a refused knock cannot see — that the row for a removal which
      actually HAPPENED says so.
     */
    const base = fixture();
    const created = await base.host.dispatch(base.owner, "core.index.createContainer", {
      name: "traced composition",
      discipline: "composition",
    });
    if (!created.ok) throw new Error(`the composition was refused: ${created.denial.message}`);
    const composition = ContainerResponseSchema.parse(created.result).container;
    /*
      TWO occupants, and the removal takes the first — so the composition SURVIVES the write.
      Retiring a container erases every event row attributed to it (`deleteContainer` clears
      the container's `events`), which is a store-level property of the ledger shared by every
      door that names a container it then removes (`core.index.deleteContainer` first among
      them) and nothing this door introduced. This case is about the door, so it holds the
      subject still.
     */
    const occupantIn = async (name: string, edge: string | null, target: string | null) => {
      const guest = await base.host.dispatch(base.owner, "core.index.createContainer", { name });
      if (!guest.ok) throw new Error(`the occupant was refused: ${guest.denial.message}`);
      const occupant = ContainerResponseSchema.parse(guest.result).container;
      const placed = await base.host.dispatch(base.owner, "core.space.place", {
        ref: { kind: "container", containerId: occupant.id },
        destination: { kind: "tile", containerId: composition.id, targetTileId: target, edge },
      });
      if (!placed.ok) throw new Error(`the leaf was refused: ${placed.denial.message}`);
      const landed = PlaceResponseSchema.parse(placed.result);
      if (landed.op !== "add_tile") throw new Error(`expected add_tile, got ${landed.op}`);
      return { occupantId: occupant.id, tileId: landed.tileId };
    };
    const seed = await occupantIn("the first occupant", null, null);
    await occupantIn("the second occupant", "right", seed.tileId);
    /*
      Resolved by IDENTITY rather than remembered: splitting a leaf moves the original's
      content into a fresh one, so `seed.tileId` names the split by now — the same staleness
      the executor resolves around.
     */
    const first = tileIdForRef(base.rooms.get(composition.id)?.tileLayout() ?? null, {
      kind: "container",
      containerId: seed.occupantId,
    });
    if (first === null) throw new Error("the composition holds no leaf for the first occupant");

    const removed = await base.host.dispatch(base.owner, "core.space.removeTile", {
      containerId: composition.id,
      tileId: first,
    });

    expect(removed).toEqual({ ok: true, result: {} });
    // The leaf is really gone, and the composition it left is still standing: a traced row
    // about a write that did not happen would be worse than no row at all.
    expect(base.rooms.get(composition.id)?.tileLayout()?.[first]).toBeUndefined();
    expect(base.store.getContainer(composition.id)).not.toBeNull();
    // By door rather than by recency: the fixture's clock does not tick, so the placement that
    // seeded the leaf and the removal share a timestamp and their order is not the assertion.
    const rows = traces(base).filter((candidate) => candidate.door === "core.space.removeTile");
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.outcome).toBe("ok");
    expect(row.principalId).toBe(base.owner.principal.id);
    expect(row.authority).toBe(TRACE_AUTHORITY_ROOT);
    // The node the door named at its commit point, which is the composition that lost the leaf.
    expect(row.targets).toEqual([`manifold://container/${composition.id}`]);
    expect(JSON.parse(row.payload)).toEqual({ containerId: composition.id, tileId: first });
    base.store.close();
  });

  test("a dispatch over the HTTP door records no session, and the absence is the datum", async () => {
    const base = fixture();

    await base.host.dispatch(base.owner, "core.index.createContainer", { name: "api" });

    expect(newestTrace(base).session).toBeNull();
    base.store.close();
  });

  test("a container-scoped token's authority and container land on the row", async () => {
    const base = fixture();
    const created = await base.host.dispatch(base.owner, "core.index.createContainer", {
      name: "scoped",
    });
    if (!created.ok) throw new Error("fixture container was refused");
    const containerId = ContainerResponseSchema.parse(created.result).container.id;
    const scoped = tokenContext(base, ["containers:read"], containerId);

    const outcome = await base.host.dispatch(scoped, "core.index.readContainer", { containerId });
    expect(outcome.ok).toBeTrue();

    const row = newestTrace(base);
    expect(row.authority).toBe("containers:read");
    expect(row.containerId).toBe(containerId);
    expect(row.principalId).toBe(scoped.principal.id);
    base.store.close();
  });

  test("EVERY refusal rung above the handler leaves a settled row naming its rung", async () => {
    const base = fixture();
    const created = await base.host.dispatch(base.owner, "core.index.createContainer", {
      name: "rungs",
    });
    if (!created.ok) throw new Error("fixture container was refused");
    const containerId = ContainerResponseSchema.parse(created.result).container.id;

    // Rung 3, SCOPE: a container-scoped token on a workspace-grade door.
    const scoped = tokenContext(base, ["containers:write"], containerId);
    const scopeRefusal = await base.host.dispatch(scoped, "core.index.createContainer", {
      name: "nope",
    });
    expect(scopeRefusal.ok).toBeFalse();
    expect(newestTrace(base).outcome).toBe("forbidden");

    // Rung 4, CAPS: a token that carries the wrong capability entirely.
    const weak = tokenContext(base, ["containers:read"]);
    const capRefusal = await base.host.dispatch(weak, "core.index.createContainer", {
      name: "nope",
    });
    expect(capRefusal.ok).toBeFalse();
    const capRow = newestTrace(base);
    expect(capRow.outcome).toBe("forbidden");
    expect(capRow.authority).toBe("containers:write");

    // Rung 5, ARGUMENTS: the shape is wrong, and the ledger still knows who asked what.
    const argRefusal = await base.host.dispatch(base.owner, "core.index.createContainer", {
      nonsense: true,
    });
    expect(argRefusal.ok).toBeFalse();
    const argRow = newestTrace(base);
    expect(argRow.outcome).toBe("invalid_args");
    expect(JSON.parse(argRow.payload)).toEqual({ nonsense: true });

    /*
      Rung 2, PLUGIN DISABLED: a door whose plugin is off answers, and the answer is recorded.
      `core.index` is `essential` (issue #113), so the seat is switched off the one way it can
      be — out of band, before an assembly composes — and the ledger it writes to is the same
      store, which is what `newestTrace` reads.
    */
    const offIndex = hostWithSeatOff(base, "core.index");
    const disabledRefusal = await offIndex.dispatch(base.owner, "core.index.createContainer", {
      name: "nope",
    });
    expect(disabledRefusal.ok).toBeFalse();
    expect(newestTrace(base).outcome).toBe("plugin_disabled");

    // Every rung the ledger promises it can say, said.
    const outcomes = new Set(traces(base).map((row) => row.outcome));
    for (const rule of TRACED_DENIAL_RULES) {
      if (rule === "refused") continue; // the handler's own rung; asserted below
      expect(outcomes.has(rule)).toBeTrue();
    }
    base.store.close();
  });

  test("a handler's own refusal settles `refused`, keeping the nodes it named", async () => {
    const base = fixture();
    const host = probeHost(base);

    const outcome = await host.dispatch(base.owner, "test.probe.refuseLoudly", {});
    expect(outcome.ok).toBeFalse();

    const row = newestTrace(base);
    expect(row.outcome).toBe("refused");
    // A refusal is not an event — nothing was published — but the node the door named is still
    // what it was reaching for, and an auditor wants that.
    expect(row.targets).toEqual(["manifold://plugin/test.probe"]);
    base.store.close();
  });

  test("the ONE untraced name is an unregistered one, and it is still logged", async () => {
    const base = fixture();

    const outcome = await base.host.dispatch(base.owner, "core.nothing.here", {});
    expect(outcome.ok).toBeFalse();
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.denial.rule).toBe(UNTRACED_DENIAL_RULE);

    // No door, no declared authority, nothing exercised — and a caller-chosen name that would
    // otherwise be a writer into the ledger (ADR 0018 §4).
    expect(traces(base).length).toBe(0);
    base.store.close();
  });

  test("a door that throws is traced `failed`, and its mutation stands", async () => {
    const base = fixture();
    const host = probeHost(base);

    await expect(
      host.dispatch(base.owner, "test.probe.explodeAfterWrite", { containerId: "kept" }),
    ).rejects.toThrow();

    const row = newestTrace(base);
    expect(row.door).toBe("test.probe.explodeAfterWrite");
    expect(row.outcome).toBe("failed");
    // The write committed on its own before the throw, so the ledger and the store agree: it
    // happened, and it is attributed.
    expect(base.store.getContainer("kept")).not.toBeNull();
    base.store.close();
  });

  test("a mutation ROLLED BACK by its own transaction still leaves its trace", async () => {
    const base = fixture();
    const host = probeHost(base);

    await expect(
      host.dispatch(base.owner, "test.probe.rollbackWrite", { containerId: "gone" }),
    ).rejects.toThrow();

    /*
      THE HONEST GUARANTEE, asserted (ADR 0018 §7). The trace does NOT share the handler's
      transaction, and this is the case that shows why the axiom wants it that way: the
      mutation is gone, and the attempt is not. A trace that rolled back with the mutation
      would erase exactly the rows A6 exists to keep — the refusal and the broken door.
     */
    expect(base.store.getContainer("gone")).toBeNull();
    const row = newestTrace(base);
    expect(row.door).toBe("test.probe.rollbackWrite");
    expect(row.outcome).toBe("failed");
    base.store.close();
  });

  test("the attribution is DURABLE BEFORE the handler runs, unsettled while it does", async () => {
    const base = fixture();
    const host = probeHost(base);

    const outcome = await host.dispatch(base.owner, "test.probe.peekLedger", {});
    expect(outcome.ok).toBeTrue();
    if (!outcome.ok) throw new Error("unreachable");

    // The handler read its OWN row out of the journal, which is the write-ahead made visible:
    // no mutation a handler makes can precede the record of who was allowed to make it.
    expect(outcome.result).toEqual({ own: 1, outcome: null });
    // And by the time the dispatch answers, that same row carries the outcome.
    expect(newestTrace(base).outcome).toBe("ok");
    base.store.close();
  });

  test("secrets and terminal bytes never reach the ledger", async () => {
    const base = fixture();
    const host = probeHost(base);
    // A non-root caller, so the door's EMPTY cap list is what the row reports: `open` says
    // authority was never the question here, which a blank column would say far less clearly.
    const guest = tokenContext(base, ["containers:read"]);

    await host.dispatch(guest, "test.probe.keepSecrets", {
      secret: "hunter2",
      token: "bearer-abc",
      data: "\u001b[2Jrm -rf /",
      keep: "visible",
    });

    const row = newestTrace(base);
    expect(JSON.parse(row.payload)).toEqual({ keep: "visible" });
    expect(row.payload).not.toContain("hunter2");
    expect(row.payload).not.toContain("bearer-abc");
    expect(row.payload).not.toContain("rm -rf");
    expect(row.authority).toBe(TRACE_AUTHORITY_OPEN);
    base.store.close();
  });

  test("an oversize argument list is recorded as a shape, not as bytes", async () => {
    const base = fixture();

    await base.host.dispatch(base.owner, "core.index.createContainer", { name: "x".repeat(8_000) });

    const row = newestTrace(base);
    const payload = OversizePayloadSchema.parse(JSON.parse(row.payload));
    expect(payload.keys).toEqual(["name"]);
    expect(payload.oversize).toBeGreaterThan(4_096);
    expect(row.payload.length).toBeLessThan(1_000);
    base.store.close();
  });

  test("the trail's ONE read door publishes the ledger", async () => {
    const base = fixture();
    await base.host.dispatch(base.owner, "core.index.createContainer", { name: "readable" });

    // No second audit API: the ledger is read by the door that already reads the trail.
    const outcome = await base.host.dispatch(base.owner, "core.events.list", {
      kind: TRACE_ROW_TYPE,
      limit: 10,
    });
    expect(outcome.ok).toBeTrue();
    if (!outcome.ok) throw new Error("unreachable");
    const rows = EventsListResponseSchema.parse(outcome.result).events;
    const created = rows.find((row) => row.door === "core.index.createContainer");
    expect(created).toBeDefined();
    expect(created?.outcome).toBe("ok");
    expect(created?.targets).toEqual(["manifold://plugin/core.index"]);
    // The list door's own dispatch is in the ledger too, unsettled at the moment it read.
    expect(rows.some((row) => row.door === "core.events.list")).toBeTrue();
    base.store.close();
  });

  test("an event row is not a trace row: the two families share one table and one reader", async () => {
    const base = fixture();
    base.store.addEvent("container-1", 1, "principal-1", "terminal_opened", { terminalId: "t1" });

    const rows = base.store.listEvents({ limit: 10 });
    const event = rows.find((row) => row.type === "terminal_opened");
    expect(event).toBeDefined();
    expect(event?.door).toBeNull();
    expect(event?.authority).toBeNull();
    expect(event?.outcome).toBeNull();
    expect(event?.session).toBeNull();
    expect(event?.targets).toEqual([]);
    base.store.close();
  });

  test("an outcome settles exactly once: a second settle changes nothing", () => {
    const store = testStore();
    const id = store.appendTrace({
      ts: 5,
      actor: "principal-1",
      authority: TRACE_AUTHORITY_ROOT,
      door: "test.door",
      containerId: null,
      payload: {},
      session: null,
      outcome: null,
      targets: [],
    });

    expect(store.settleTrace(id, "ok", ["manifold://container/c1"])).toBeTrue();
    // A recorded answer is not rewritable — not by a retry, not by a later rung, not by a bug.
    expect(store.settleTrace(id, "failed", [])).toBeFalse();
    const row = store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0]!;
    expect(row.outcome).toBe("ok");
    expect(row.targets).toEqual(["manifold://container/c1"]);
    store.close();
  });

  test("the ledger's outcome vocabulary covers every rung the ladder can answer with", () => {
    // The two vocabularies are joined by name at runtime, so a rung added without an outcome
    // would be a row the ledger could not write. The complement is derived, never retyped.
    const words: readonly string[] = TRACE_OUTCOMES;
    for (const rule of TRACED_DENIAL_RULES) {
      expect(words).toContain(rule);
    }
    expect(words).not.toContain(UNTRACED_DENIAL_RULE);
  });
});
