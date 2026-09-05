import { describe, expect, test } from "bun:test";
import type { ActionOutcome, Cap } from "@manifold/protocol";
import { AuthService, type AuthContext } from "../../../server/src/auth.ts";
import { silentLogger } from "../../../server/src/log.ts";
import { RoomManager } from "../../../server/src/room.ts";
import type { ServerStore } from "../../../server/src/stores.ts";
import { TerminalBroker } from "../../../server/src/terminal-broker.ts";
import type { PluginHost } from "../../../server/src/plugin-host.ts";
import {
  FakeClock,
  FakeRuntime,
  testPluginHost,
  testStore,
  testTileTrees,
} from "../../../server/test/helpers.ts";
import { EVENTS_LIST_MAX, EventsListResponseSchema } from "../src/index.ts";

/**
 * THE AUDIT DOOR, rung by rung, against the REAL host.
 *
 * A door-only plugin has no screen to look at, so the door itself is the whole deliverable and
 * the ladder is the whole contract. That is why these cases dispatch through `PluginHost` over
 * the production `SERVER_PLUGIN_DEFS` rather than calling `eventsHandlers.list` with a fake
 * context: the two refusals that matter here — a caller without `*`, and a container-scoped
 * token asking a workspace question — are the HOST's rungs, and a handler test could not tell
 * the truth about either. `core.access`'s own handler tests say the same thing from the other
 * side: what a handler owns is tested locally, what the ladder owns is tested against the door.
 *
 * The read half is exercised through the same door for a second reason. `listEvents` chooses
 * between two indexes on the presence of `containerId` and the action translates `kind` into
 * the column's `type`; a test that called the store directly would prove the store and leave
 * both of those unproven.
 */

const OWNER_KEY = "a".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
}

async function fixture(): Promise<Fixture> {
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
  return {
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    host: await testPluginHost(store, auth, rooms, broker, runtime),
    runtime,
  };
}

/** A real token, so authority is exercised through attenuation rather than a hand-built context. */
function context(where: Fixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = where.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    where.owner,
  );
  return where.auth.authenticate(grant.token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

/**
 * Four records across two containers plus one that belongs to none, written out of timestamp
 * order so "newest first" is a real claim about the read rather than an accident of insertion.
 */
function seed(where: Fixture): void {
  where.store.addEvent("c-alpha", 2_000, "p-1", "principal_joined", { via: "share" });
  where.store.addEvent("c-beta", 4_000, "p-2", "terminal_opened", { terminalId: "t-1" });
  where.store.addEvent("c-alpha", 1_000, "p-2", "terminal_opened", { terminalId: "t-2" });
  where.store.addEvent(null, 3_000, "p-1", "token_revoked", { count: 2 });
}

/**
 * The published result, parsed by the action's OWN schema — the shape a client would get —
 * narrowed to the EVENT family.
 *
 * The narrowing is the point rather than a convenience. Since axiom A6 the journal carries two
 * row families and this door reads both: every dispatch in these cases, including the read
 * itself, appends a trace row (`type: "trace"`). Cases about event rows therefore say so, and
 * the family boundary gets a case of its own below instead of leaking into all of them.
 *
 * `owner_authenticated` is dropped for the same reason and it is NOT a trace: ADR 0019 §4 made
 * the owner path leave an event row, and every fixture here authenticates the owner key to get
 * its root context — so that row is an artifact of the harness rather than of the case, exactly
 * as the read's own trace is. The audit row's own behaviour is pinned where it belongs
 * (`packages/server/test/identity-posture.test.ts`).
 */
async function list(
  where: Fixture,
  caller: AuthContext,
  args: Readonly<Record<string, unknown>>,
): Promise<readonly { ts: number; type: string; containerId: string | null }[]> {
  const outcome = await where.host.dispatch(caller, "core.events.list", args);
  if (!outcome.ok) throw new Error(`expected rows, got ${outcome.denial.rule}`);
  return EventsListResponseSchema.parse(outcome.result).events.filter(
    (row) => row.door === null && row.type !== "owner_authenticated",
  );
}

describe("core.events.list authority", () => {
  test("a caller without `*` is forbidden, however many other caps it holds", async () => {
    const where = await fixture();
    const reader = context(where, ["containers:read", "containers:write", "tokens:mint"]);

    const outcome = await where.host.dispatch(reader, "core.events.list", {});

    /*
      THE POINT OF THE DOOR. The trail carries other principals' activity, and no cap in the
      vocabulary means "may read other people's history" — so a delegated token, however
      generously minted, is refused. A cap rung is what makes that a published fact rather
      than a convention: the manifest declares `*`, the roster shows it, and the refusal names
      it back.
    */
    expect(denial(outcome)).toEqual({ rule: "forbidden", message: "* capability required" });
    where.store.close();
  });

  test("a container-scoped token is refused for its SCOPE, above the cap rung", async () => {
    const where = await fixture();
    const container = where.runtime.newId();
    where.store.createContainer({
      id: container,
      name: "scoped",
      createdAt: where.runtime.now(),
      discipline: "canvas",
    });
    const scoped = context(where, ["containers:read"], container);

    const outcome = await where.host.dispatch(scoped, "core.events.list", {
      containerId: container,
    });

    /*
      Asking only about its OWN container, and still refused — which is the ordering being
      load-bearing rather than pedantic. `scope: "workspace"` is the default this action keeps,
      so the scope rung answers before caps and before arguments are parsed; a scoped caller
      therefore never reaches the handler, and the `containerId` filter can never become a way
      out of a container. That is why the handler owes `ctx.outsideScope` nothing.
    */
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    where.store.close();
  });

  test("root reads it", async () => {
    const where = await fixture();
    seed(where);

    const rows = await list(where, where.owner, {});

    expect(rows.length).toBe(4);
    where.store.close();
  });
});

describe("core.events.list arguments", () => {
  test("a limit outside the declared bound is invalid_args, not a clamped success", async () => {
    const where = await fixture();
    seed(where);

    /*
      Zero, negative and over-the-maximum all fail the SCHEMA, which is the rung above the
      handler — so the bound is a published part of the action's JSON Schema at
      `GET /api/protocol` rather than a silent truncation a caller has no way to discover.
      Clamping would be friendlier and would make the door lie about what it did.
    */
    for (const limit of [0, -1, EVENTS_LIST_MAX + 1]) {
      const outcome = await where.host.dispatch(where.owner, "core.events.list", { limit });
      expect(denial(outcome).rule).toBe("invalid_args");
    }

    // The boundary itself is legal: a maximum that refused its own value would be an off-by-one
    // nobody could tell from the schema.
    const atMax = await list(where, where.owner, { limit: EVENTS_LIST_MAX });
    expect(atMax.length).toBe(4);
    where.store.close();
  });

  test("an unknown argument is invalid_args, because the input is strict", async () => {
    const where = await fixture();

    const outcome = await where.host.dispatch(where.owner, "core.events.list", { type: "x" });

    // `type` is the ROW's word, never the filter's — and a strict input is what turns that
    // distinction into an error a caller can read instead of a filter silently ignored.
    expect(denial(outcome).rule).toBe("invalid_args");
    where.store.close();
  });
});

describe("core.events.list rows", () => {
  test("newest first, by timestamp rather than by insertion", async () => {
    const where = await fixture();
    seed(where);

    const rows = await list(where, where.owner, {});

    expect(rows.map((row) => row.ts)).toEqual([4_000, 3_000, 2_000, 1_000]);
    where.store.close();
  });

  test("the kind filter selects on the event's own type", async () => {
    const where = await fixture();
    seed(where);

    const rows = await list(where, where.owner, { kind: "terminal_opened" });

    expect(rows.map((row) => row.ts)).toEqual([4_000, 1_000]);
    expect(rows.every((row) => row.type === "terminal_opened")).toBe(true);
    where.store.close();
  });

  test("the containerId filter narrows to one container and drops the container-less rows", async () => {
    const where = await fixture();
    seed(where);

    const rows = await list(where, where.owner, { containerId: "c-alpha" });

    // The workspace-wide record at ts 3,000 has no container, so narrowing excludes it rather
    // than treating "belongs to nothing" as "belongs to everything".
    expect(rows.map((row) => row.ts)).toEqual([2_000, 1_000]);
    expect(rows.every((row) => row.containerId === "c-alpha")).toBe(true);
    where.store.close();
  });

  test("both filters compose", async () => {
    const where = await fixture();
    seed(where);

    const rows = await list(where, where.owner, {
      containerId: "c-alpha",
      kind: "terminal_opened",
    });

    expect(rows.map((row) => row.ts)).toEqual([1_000]);
    where.store.close();
  });

  test("limit truncates from the NEWEST end, and truncates after filtering", async () => {
    const where = await fixture();
    seed(where);

    const newest = await list(where, where.owner, { limit: 2 });
    expect(newest.map((row) => row.ts)).toEqual([4_000, 3_000]);

    // Filter first, then cut: a limit applied before the predicate would answer "no terminals"
    // for a workspace whose two newest records happen to be something else.
    const filtered = await list(where, where.owner, { kind: "terminal_opened", limit: 1 });
    expect(filtered.map((row) => row.ts)).toEqual([4_000]);
    where.store.close();
  });

  test("the payload arrives as the stored TEXT, not a parsed object", async () => {
    const where = await fixture();
    where.store.addEvent("c-alpha", 5_000, "p-1", "token_revoked", { count: 2 });

    const outcome = await where.host.dispatch(where.owner, "core.events.list", {});
    if (!outcome.ok) throw new Error("expected rows");
    const rows = EventsListResponseSchema.parse(outcome.result).events;
    const event = rows.find((row) => row.type === "token_revoked");

    /*
      Verbatim, because no schema anywhere declares what a given event type's payload holds.
      Publishing the text keeps the door honest about that — a reader decides what to parse,
      and a malformed row stays readable as a row instead of poisoning the page.
    */
    expect(event?.payload).toBe('{"count":2}');
    where.store.close();
  });

  test("an empty trail is an empty list, not a refusal", async () => {
    const where = await fixture();

    const rows = await list(where, where.owner, {});

    // "Nothing happened yet" is an answer. A read that refused when it found nothing would make
    // a fresh workspace indistinguishable from one the caller may not see.
    expect(rows).toEqual([]);
    where.store.close();
  });

  test("ONE door reads both families: the ledger comes back through this action", async () => {
    const where = await fixture();
    seed(where);

    const outcome = await where.host.dispatch(where.owner, "core.events.list", { kind: "trace" });
    if (!outcome.ok) throw new Error("expected rows");
    const rows = EventsListResponseSchema.parse(outcome.result).events;

    /*
      A6's read path is this door and no other. `kind: "trace"` selects the ledger — the reading
      dispatch's own row is in it, unsettled, because the ladder commits the attribution before
      the handler runs — and an event row seeded beside it carries none of the trace columns, so
      the two families are distinguishable without a second table or a second door.
     */
    const own = rows.find((row) => row.door === "core.events.list");
    expect(own).toBeDefined();
    expect(own?.principalId).toBe(where.owner.principal.id);
    expect(own?.authority).toBe("root");
    expect(own?.outcome).toBeNull();
    expect(rows.every((row) => row.type === "trace")).toBe(true);
    where.store.close();
  });
});
