import { describe, expect, test } from "bun:test";
import {
  GrantsSchema,
  ShareGrantSchema,
  TokenGrantSchema,
  type ActionOutcome,
  type Cap,
  type Grant,
  type TokenGrant,
} from "@manifold/protocol";
import { AuthService, ServiceError, type AuthContext } from "../src/auth.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  hostWithSeatOff,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

/**
 * THE ACCESS DOOR — `core.access`, rung by rung, over the real assembly.
 *
 * Handing authority out is the sharpest thing a workspace can do, so the three doors that
 * replaced `POST /api/principals`, `POST /api/tokens` and `POST /api/tokens/revoke` are
 * pinned here on every rung the ladder has: an unknown name, a disabled plugin, the token's
 * scope, the declared caps, the argument schema, and the mechanism's own refusals.
 *
 * Two properties matter beyond the ladder and are asserted directly:
 *
 * 1. AUTHORITY IS UNCHANGED. `createPrincipal` is root-only because `requireRoot` was;
 *    minting and revoking demand `tokens:mint` because the mechanism did; and both are
 *    declared `scope: "container"` because the routes accepted a container-scoped caller and
 *    let the mechanism attenuate. Every case below is written so that a drift in any of those
 *    three fails rather than passes quietly.
 * 2. NO SECRET IS LOGGED. A door whose result IS a credential has to be checked, not
 *    assumed, so the last case drives a real dispatch through a capturing logger and asserts
 *    the minted token appears nowhere in what was recorded (invariant 6).
 */

const OWNER_KEY = "a".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
}

async function fixture(logger: Logger = silentLogger): Promise<Fixture> {
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
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  return {
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    rooms,
    broker,
    host: await testPluginHost(store, auth, rooms, broker, runtime, { logger }),
    runtime,
  };
}

/** A real token, so authority is exercised through real attenuation. */
function grant(fix: Fixture, caps: readonly Cap[], containerId?: string): TokenGrant {
  return fix.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    fix.owner,
  );
}

function context(fix: Fixture, caps: readonly Cap[], containerId?: string): AuthContext {
  return fix.auth.authenticate(grant(fix, caps, containerId).token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected a result, got ${outcome.denial.message}`);
  return outcome.result;
}

/**
 * A real container, because a container-scoped grant is only mintable against one that
 * exists.
 */
function accessContainer(fix: Fixture): string {
  const id = fix.runtime.newId();
  fix.store.createContainer({
    id,
    name: "access container",
    createdAt: fix.runtime.now(),
    discipline: "canvas",
  });
  return id;
}

describe("core.access ladder", () => {
  test("an unknown door in an assembled namespace is unknown, never forbidden", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.access.listTokens", {});

    // A caller probing for a read that does not exist learns exactly that, and no more: the
    // plugin publishes three doors, and inventing a fourth is not a capability question.
    expect(denial(outcome).rule).toBe("unknown_action");
    fix.store.close();
  });

  test("an access seat that is off closes creation and minting but never revocation", async () => {
    const fix = await fixture();
    const victim = grant(fix, ["containers:read"]);
    /*
      THE DOOR REFUSES NOW. `core.access` is `essential` (issue #113): `createPrincipal` is the
      only path from a credential to an identity, so a workspace with this seat off cannot let
      a new browser in at all. The rung-2 contracts below are what the seat still owes when an
      assembly arrives with it off out of band, which is the only way it can be.
    */
    expect(await fix.host.setEnabled("core.access", false, "admin")).toEqual({
      refused: "essential",
    });
    const host = await hostWithSeatOff(fix, "core.access");

    const created = await host.dispatch(fix.owner, "core.access.createPrincipal", {
      name: "blocked",
    });
    const minted = await host.dispatch(fix.owner, "core.access.mint", {
      principal: { name: "blocked", kind: "agent" },
      caps: ["containers:read"],
    });
    const revoked = await host.dispatch(fix.owner, "core.access.revoke", {
      principalId: victim.principal.id,
    });

    expect(denial(created).rule).toBe("plugin_disabled");
    expect(denial(minted).rule).toBe("plugin_disabled");
    // D12, and this is the case that carve-out exists for: a leaked token must be killable
    // while the plugin that issued it is switched off. `cleanup: true` is what makes it so.
    expect(result(revoked)).toEqual({ revoked: 1 });
    expect(() => fix.auth.authenticate(victim.token)).toThrow();
    fix.store.close();
  });

  test("a container-scoped token is refused the workspace door and admitted to the scoped ones", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const scoped = context(fix, ["tokens:mint", "scenes:write"], container);

    const created = await fix.host.dispatch(scoped, "core.access.createPrincipal", {
      name: "escalated",
    });
    const minted = await fix.host.dispatch(scoped, "core.access.mint", {
      principal: { name: "sub agent", kind: "agent" },
      caps: ["scenes:write"],
    });

    // Bootstrapping a root identity is workspace-grade by construction, so the scope rung
    // answers first — before caps, so a scoped caller learns nothing about what it lacks.
    expect(denial(created)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    /*
      Minting inside your own container still works, which is the whole reason both doors are
      declared `scope: "container"`: a container-scoped agent delegating to a sub-agent is the
      shipped behaviour of `POST /api/tokens`, and the mechanism binds the new grant to the
      minter's own scope rather than trusting the request.
    */
    const delegated = result(minted);
    expect(delegated).toMatchObject({ containerId: container, caps: ["scenes:write"] });
    fix.store.close();
  });

  test("a scoped minter cannot reach another container, which is the scope obligation", async () => {
    const fix = await fixture();
    const home = accessContainer(fix);
    const elsewhere = accessContainer(fix);
    const scoped = context(fix, ["tokens:mint", "scenes:write"], home);

    const outcome = await fix.host.dispatch(scoped, "core.access.mint", {
      principal: { name: "trespasser", kind: "agent" },
      caps: ["scenes:write"],
      containerId: elsewhere,
    });

    // `scope: "container"` lets the caller past the scope rung; the containment check that
    // keeps the door honest then runs in the mechanism, on the real caller. Naming a
    // container you are not scoped to is refused with the wording the route returned.
    expect(denial(outcome)).toEqual({ rule: "refused", message: "cannot widen container scope" });
    fix.store.close();
  });

  test("declared caps mirror the routes: root for a bootstrap, tokens:mint for the rest", async () => {
    const fix = await fixture();
    const minter = context(fix, ["tokens:mint"]);
    const bystander = context(fix, ["containers:read"]);

    const bootstrapByMinter = await fix.host.dispatch(minter, "core.access.createPrincipal", {
      name: "not root",
    });
    const mintByBystander = await fix.host.dispatch(bystander, "core.access.mint", {
      principal: { name: "nope", kind: "agent" },
      caps: ["containers:read"],
    });
    const revokeByBystander = await fix.host.dispatch(bystander, "core.access.revoke", {
      principalId: bystander.principal.id,
    });

    // `tokens:mint` is NOT root: holding the minting cap must not confer the bootstrap door,
    // exactly as `requireRoot` refused a `tokens:mint` holder before.
    expect(denial(bootstrapByMinter).rule).toBe("forbidden");
    expect(denial(mintByBystander)).toEqual({
      rule: "forbidden",
      message: "tokens:mint capability required",
    });
    expect(denial(revokeByBystander)).toEqual({
      rule: "forbidden",
      message: "tokens:mint capability required",
    });
    fix.store.close();
  });

  test("authority is checked before shape, so a bad request from a bad caller says forbidden", async () => {
    const fix = await fixture();
    const bystander = context(fix, ["containers:read"]);

    const outcome = await fix.host.dispatch(bystander, "core.access.mint", { caps: [] });

    // The rung order is the contract: a caller must not learn a door's argument schema by
    // knocking on one it may not open.
    expect(denial(outcome).rule).toBe("forbidden");
    fix.store.close();
  });

  test("a malformed mint is invalid_args, including the either-or the schema refines", async () => {
    const fix = await fixture();

    const noPrincipal = await fix.host.dispatch(fix.owner, "core.access.mint", {
      caps: ["containers:read"],
    });
    const bothPrincipals = await fix.host.dispatch(fix.owner, "core.access.mint", {
      principalId: fix.owner.principal.id,
      principal: { name: "two ways", kind: "agent" },
      caps: ["containers:read"],
    });
    const noCaps = await fix.host.dispatch(fix.owner, "core.access.mint", {
      principalId: fix.owner.principal.id,
      caps: [],
    });

    expect(denial(noPrincipal).rule).toBe("invalid_args");
    expect(denial(bothPrincipals).rule).toBe("invalid_args");
    expect(denial(noCaps).rule).toBe("invalid_args");
    fix.store.close();
  });

  test("the mechanism's refusals arrive as refusals, with their wording intact", async () => {
    const fix = await fixture();
    const minter = context(fix, ["tokens:mint", "scenes:write"]);

    const tooWide = await fix.host.dispatch(minter, "core.access.mint", {
      principal: { name: "escalated", kind: "agent" },
      caps: ["terminals:write"],
    });
    const wildcard = await fix.host.dispatch(minter, "core.access.mint", {
      principal: { name: "root wannabe", kind: "human" },
      caps: ["*"],
    });
    const missing = await fix.host.dispatch(fix.owner, "core.access.mint", {
      principalId: "no-such-principal",
      caps: ["containers:read"],
    });
    const notMine = await fix.host.dispatch(minter, "core.access.revoke", {
      principalId: fix.owner.principal.id,
    });

    // Attenuation, wildcard reservation, existence and entitlement: four different answers
    // the door itself cannot give, each relayed as `refused` rather than raised as a 500.
    expect(denial(tooWide)).toEqual({
      rule: "refused",
      message: "cannot mint capability terminals:write",
    });
    expect(denial(wildcard)).toEqual({
      rule: "refused",
      message: "only root may mint wildcard authority",
    });
    expect(denial(missing)).toEqual({ rule: "refused", message: "principal not found" });
    expect(denial(notMine)).toEqual({
      rule: "refused",
      message: "cannot revoke another principal",
    });
    fix.store.close();
  });

  test("the bootstrap door issues a usable root identity", async () => {
    const fix = await fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.access.createPrincipal", {
      name: "second owner",
      kind: "human",
    });

    const issued = result(outcome);
    expect(issued).toMatchObject({ caps: ["*"], containerId: null });
    if (issued === null || typeof issued !== "object") throw new Error("no grant");
    const token = Reflect.get(issued, "token");
    if (typeof token !== "string") throw new Error("no token in the grant");
    // The point of the door is a WORKING identity, not a row: the browser's whole boot path
    // is this call followed by authenticating with what it returned.
    expect(fix.auth.authenticate(token).isRoot).toBe(true);
    fix.store.close();
  });

  test("revocation reports how many tokens died, and zero is a success", async () => {
    const fix = await fixture();
    const victim = grant(fix, ["containers:read"]);
    fix.auth.mintToken({ principalId: victim.principal.id, caps: ["containers:read"] }, fix.owner);

    const first = await fix.host.dispatch(fix.owner, "core.access.revoke", {
      principalId: victim.principal.id,
    });
    const again = await fix.host.dispatch(fix.owner, "core.access.revoke", {
      principalId: victim.principal.id,
    });

    // Both of that principal's tokens die at once, and asking a second time is idempotent —
    // a nil count is the honest answer, never a refusal.
    expect(result(first)).toEqual({ revoked: 2 });
    expect(result(again)).toEqual({ revoked: 0 });
    fix.store.close();
  });

  test("a dispatch that MINTS a secret records no secret", async () => {
    const recorded: string[] = [];
    const capture = (evt: string, fields?: Readonly<Record<string, unknown>>): void => {
      recorded.push(JSON.stringify({ evt, ...(fields ?? {}) }));
    };
    const fix = await fixture({ info: capture, warn: capture, error: capture });

    const outcome = await fix.host.dispatch(fix.owner, "core.access.mint", {
      principal: { name: "logged", kind: "agent" },
      caps: ["containers:read"],
    });

    const issued = result(outcome);
    if (issued === null || typeof issued !== "object") throw new Error("no grant");
    const token = Reflect.get(issued, "token");
    if (typeof token !== "string" || token.length === 0) throw new Error("no token in the grant");
    const log = recorded.join("\n");
    // The door logged the dispatch — it must, one line per action — and the credential it
    // just created appears nowhere in it. Neither does the raw request.
    expect(log).toContain("core.access.mint");
    expect(log).not.toContain(token);
    expect(log).not.toContain("logged");
    fix.store.close();
  });
});

/**
 * THE SHARE DOORS, on the same ladder and against the same assembly (ADR 0014).
 *
 * A share is a token bound to a node, so what has to be pinned is that it is TREATED as one:
 * the caps rung is `mint`'s, the attenuation refusals are `mintToken`'s words, the scope rung
 * admits a container-scoped minter to its own container and no further, and the secret it
 * produces is subject to invariant 6 like every other. The two GUEST doors are the exception
 * that proves the rule — they are `scope: "workspace"` because a dial names a node at another
 * instance, which no local container scope can describe.
 */
describe("core.access share ladder", () => {
  const GUEST_ORIGIN = "http://guest.localhost:7778";

  function containerNode(containerId: string) {
    return { kind: "container" as const, containerId };
  }

  test("a container-scoped minter may share its own container and no other", async () => {
    const fix = await fixture();
    const home = accessContainer(fix);
    const elsewhere = accessContainer(fix);
    const scoped = context(fix, ["tokens:mint", "containers:read"], home);

    const own = await fix.host.dispatch(scoped, "core.access.mintShare", {
      node: containerNode(home),
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    });
    const trespass = await fix.host.dispatch(scoped, "core.access.mintShare", {
      node: containerNode(elsewhere),
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    });

    /*
      `scope: "container"` is a preservation, not a widening: the agent confined to one
      container is exactly the principal that should be able to show that container to somebody
      — and the containment check that keeps it honest runs in the mechanism, on the real
      caller, in the words `mint` already uses.
    */
    expect(result(own)).toMatchObject({
      share: { ref: containerNode(home), caps: ["containers:read"], origin: GUEST_ORIGIN },
    });
    expect(denial(trespass)).toEqual({ rule: "refused", message: "cannot widen container scope" });
    fix.store.close();
  });

  test("minting a share is `tokens:mint`, and it attenuates in the mechanism's words", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const bystander = context(fix, ["containers:read"]);
    const minter = context(fix, ["tokens:mint", "containers:read"]);

    const unauthorized = await fix.host.dispatch(bystander, "core.access.mintShare", {
      node: containerNode(container),
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    });
    const tooWide = await fix.host.dispatch(minter, "core.access.mintShare", {
      node: containerNode(container),
      caps: ["scenes:write"],
      origin: GUEST_ORIGIN,
    });

    // No new capability was invented for sharing: handing authority to another instance is
    // handing authority out, and a share whose caps exceed the minter's is the same refusal a
    // token's would be. A second cap here would have been a second answer to "who may delegate".
    expect(denial(unauthorized)).toEqual({
      rule: "forbidden",
      message: "tokens:mint capability required",
    });
    expect(denial(tooWide)).toEqual({
      rule: "refused",
      message: "cannot mint capability scenes:write",
    });
    fix.store.close();
  });

  test("only a container can be shared, and a bad origin is refused rather than normalized", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);

    const terminal = await fix.host.dispatch(fix.owner, "core.access.mintShare", {
      node: { kind: "terminal", terminalId: "t1" },
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    });
    const pathMounted = await fix.host.dispatch(fix.owner, "core.access.mintShare", {
      node: containerNode(container),
      caps: ["containers:read"],
      origin: "http://guest.localhost:7778/workspace",
    });

    /*
      The node rule is the door's: a grant a token cannot express must not be answered
      "minted". The origin rule is the schema's, and it refuses rather than trimming to the
      host — sharing to `example.com/manifold` by silently addressing `example.com` would hand
      a node to a DIFFERENT instance than the one the minter named.
    */
    expect(denial(terminal)).toEqual({
      rule: "refused",
      message: "only a container can be shared",
    });
    expect(denial(pathMounted).rule).toBe("invalid_args");
    fix.store.close();
  });

  test("the guest doors are workspace-grade, because a dial is not in any local container", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const scoped = context(fix, ["containers:read", "containers:write"], container);

    const dialed = await fix.host.dispatch(scoped, "core.access.dialShare", {
      origin: GUEST_ORIGIN,
      token: "someone-elses-secret",
    });
    const opened = await fix.host.dispatch(scoped, "core.access.openDial", { dialId: "d1" });

    // Not a policy choice — a forced one. A container-scoped token is scoped to a LOCAL
    // container id, and the node a dial names lives at another instance entirely, so admitting
    // the caller would be admitting it to something its scope cannot describe.
    for (const outcome of [dialed, opened]) {
      expect(denial(outcome)).toEqual({
        rule: "forbidden",
        message: "scoped tokens cannot invoke workspace actions",
      });
    }
    fix.store.close();
  });

  test("opening a dial reads containers; accepting one writes them", async () => {
    const fix = await fixture();
    const reader = context(fix, ["containers:read"]);

    const acceptedByReader = await fix.host.dispatch(reader, "core.access.dialShare", {
      origin: GUEST_ORIGIN,
      token: "someone-elses-secret",
    });
    const openedByReader = await fix.host.dispatch(reader, "core.access.openDial", {
      dialId: "no-such-dial",
    });

    /*
      Accepting a share changes what this workspace SHOWS, which is `containers:write`; using
      one is a read. The reader therefore gets past the caps rung on `openDial` and meets a real
      refusal from the dialer instead — the shape that matters is that the two doors sit on
      different rungs, not the wording of a missing row.
    */
    expect(denial(acceptedByReader)).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });
    expect(denial(openedByReader).rule).toBe("refused");
    fix.store.close();
  });

  test("an access seat that is off stops sharing and dialling, but never revocation", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const minted = result(
      await fix.host.dispatch(fix.owner, "core.access.mintShare", {
        node: containerNode(container),
        caps: ["containers:read"],
        origin: GUEST_ORIGIN,
      }),
    );
    const shareId = Reflect.get(Reflect.get(minted as object, "share") as object, "id");
    if (typeof shareId !== "string") throw new Error("no share id");
    const host = await hostWithSeatOff(fix, "core.access");

    const blocked = await host.dispatch(fix.owner, "core.access.mintShare", {
      node: containerNode(container),
      caps: ["containers:read"],
      origin: GUEST_ORIGIN,
    });
    const listed = await host.dispatch(fix.owner, "core.access.listShares", {});
    const revoked = await host.dispatch(fix.owner, "core.access.revokeShare", { shareId });

    /*
      D12 with the sharpest possible subject: the holder of a share secret is ANOTHER INSTANCE,
      beyond this workspace's reach entirely. If a disable suspended `revokeShare`, an
      administrative toggle would keep a foreign instance projecting a node whose owner had
      already decided to cut the pipe — A4's "when an owner cuts the pipe, the projection dies
      everywhere", defeated by a checkbox.
    */
    expect(denial(blocked).rule).toBe("plugin_disabled");
    expect(denial(listed).rule).toBe("plugin_disabled");
    expect(result(revoked)).toEqual({ revoked: 0 });
    fix.store.close();
  });

  test("the inventory publishes the share and never its secret", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const minted = result(
      await fix.host.dispatch(fix.owner, "core.access.mintShare", {
        node: containerNode(container),
        caps: ["containers:read"],
        origin: GUEST_ORIGIN,
      }),
    );
    const token = Reflect.get(minted as object, "token");
    if (typeof token !== "string" || token.length === 0) throw new Error("no share secret");

    const inventory = result(await fix.host.dispatch(fix.owner, "core.access.listShares", {}));

    // One door, both directions, and the secrets discipline enforced by the SHAPE: `Share` has
    // no field a secret fits in, so a list door cannot leak one even by accident.
    expect(inventory).toMatchObject({ dials: [] });
    expect(JSON.stringify(inventory)).not.toContain(token);
    expect((Reflect.get(inventory as object, "shares") as unknown[]).length).toBe(1);
    fix.store.close();
  });

  test("a dispatch that mints a SHARE secret records no secret", async () => {
    const recorded: string[] = [];
    const capture = (evt: string, fields?: Readonly<Record<string, unknown>>): void => {
      recorded.push(JSON.stringify({ evt, ...(fields ?? {}) }));
    };
    const fix = await fixture({ info: capture, warn: capture, error: capture });
    const container = accessContainer(fix);

    const minted = result(
      await fix.host.dispatch(fix.owner, "core.access.mintShare", {
        node: containerNode(container),
        caps: ["containers:read"],
        origin: GUEST_ORIGIN,
      }),
    );
    const token = Reflect.get(minted as object, "token");
    if (typeof token !== "string" || token.length === 0) throw new Error("no share secret");

    const log = recorded.join("\n");
    // The one credential in this wave that travels to another organization's machine, checked
    // rather than assumed: the dispatch is logged by name, and the secret is nowhere in it.
    expect(log).toContain("core.access.mintShare");
    expect(log).not.toContain(token);
    fix.store.close();
  });
});

/**
 * THE GRANT DOORS, and the waterfall UNDERNEATH the doors they do not move (ADR 0011).
 *
 * Two different things are pinned here, and keeping them apart is the point of the file.
 *
 * 1. THE DOORS themselves — `grant`, `revokeGrant`, `listGrants` — on the ladder every other
 *    `core.access` door runs: root-only, workspace-graded, the schema, the mechanism's
 *    refusals relayed verbatim, and `revokeGrant` outliving a disable (D12).
 * 2. THE EVALUATOR, observed the only way that proves it is real: through ORDINARY dispatch of
 *    a door that has nothing to do with grants. `core.index.renameContainer` is the subject
 *    throughout — `containers:write`, `scope: "container"`, and entirely unaware that authority
 *    stopped being a field on a token. If a grant row can widen and narrow that door for a live
 *    caller, the seam held; if it can only be seen through `effectiveCaps`, it did not.
 *
 * Every case reuses ONE `AuthContext` across the grant write and the dispatch that follows it,
 * with no re-authentication. That is deliberate: ADR 0011 rejects evaluating at mount time
 * because "caching authority into a composition makes revocation a restart", so a verdict that
 * survived a revocation would be the design failing quietly rather than a test failing loudly.
 */
describe("core.access grant ladder", () => {
  const ROOT = "manifold://";

  function containerNodeUri(containerId: string): string {
    return `manifold://container/${containerId}`;
  }

  /** The subject door: `containers:write` at `scope: "container"`, and no idea grants exist. */
  async function rename(fix: Fixture, actor: AuthContext, containerId: string) {
    return await fix.host.dispatch(actor, "core.index.renameContainer", {
      containerId,
      name: "renamed by grant",
    });
  }

  /** The owner writing one row, through the real door rather than into the store. */
  async function write(fix: Fixture, input: Record<string, unknown>): Promise<Grant> {
    const outcome = await fix.host.dispatch(fix.owner, "core.access.grant", input);
    return result(outcome) as Grant;
  }

  test("the doors are root-only, and the scope rung answers a scoped caller first", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const minter = context(fix, ["tokens:mint"]);
    const scoped = context(fix, ["tokens:mint"], container);

    const byMinter = await fix.host.dispatch(minter, "core.access.grant", {
      principal: { kind: "principal", id: minter.principal.id },
      node: ROOT,
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    const byScoped = await fix.host.dispatch(scoped, "core.access.listGrants", {});

    /*
      Stricter than `mint` on purpose, and the reason is `deny`: minting attenuates downward,
      but a deny row at a container beats an allow at the root, so a `tokens:mint` holder who
      could write one could lock the owner out of the owner's own container. ADR 0011 defines
      attenuation for minting and nothing for denial, so the door stays narrow until that is
      ruled on — and a drift to `tokens:mint` fails here rather than passing quietly.
    */
    expect(denial(byMinter)).toEqual({ rule: "forbidden", message: "* capability required" });
    // Workspace-graded because the ARGUMENT may name the root, which no container scope
    // describes — `dialShare`'s reasoning, and the scope rung answers before caps as always.
    expect(denial(byScoped)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    fix.store.close();
  });

  test("a node grant widens a LIVE container-scoped credential the token never carried", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);

    const before = await rename(fix, reader, container);
    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    const after = await rename(fix, reader, container);

    /*
      THE CASE THE WHOLE WAVE EXISTS FOR. Flat caps could say "this token may write containers"
      or "may not", and nothing in between; there was no way to say "this one, here". The token
      is untouched — same secret, same `Cap[]`, same `AuthContext` object — and the answer
      changed because a row appeared at the node the door asks about.

      Note the refusal before is rung 4 in its ORIGINAL wording. The vocabulary did not move:
      what moved is where the caps came from.
    */
    expect(denial(before)).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });
    expect(result(after)).toMatchObject({ container: { id: container, name: "renamed by grant" } });
    fix.store.close();
  });

  test("a deny at the container beats an allow at the root: deeper wins", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);

    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node: ROOT,
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    const allowed = await rename(fix, reader, container);
    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "deny",
      reach: "subtree",
    });
    const denied = await rename(fix, reader, container);

    // Precedence rule 1, and the reason it is rule 1: a denial that could be overruled by a
    // shallower grant would be a suggestion. "Everywhere except this container" is the shape an
    // owner actually reaches for, and it is sayable only if depth outranks the root.
    expect(result(allowed)).toMatchObject({ container: { id: container } });
    expect(denial(denied)).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });
    fix.store.close();
  });

  test("at equal depth and equal specificity, deny beats allow", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);
    const node = containerNodeUri(container);

    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node,
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node,
      caps: ["containers:write"],
      effect: "deny",
      reach: "subtree",
    });

    // Precedence rule 3. Both rows are principal-specific at the same node, so rules 1 and 2
    // are silent and the tie-break that decides is the safe one — and it must beat rule 4,
    // which would otherwise hand the answer to whichever row was written last.
    expect(denial(await rename(fix, reader, container))).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });
    fix.store.close();
  });

  test("a named principal's allow beats a class deny at the same node: specificity outranks effect", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);
    const node = containerNodeUri(container);

    await write(fix, {
      principal: { kind: "any-human" },
      node,
      caps: ["containers:write"],
      effect: "deny",
      reach: "subtree",
    });
    await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node,
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });

    /*
      THE ORDERING CASE, and the one most likely to be got backwards, because "deny wins" reads
      like a safety rule that should outrank everything. It must not. ADR 0011 puts specificity
      at rule 2 and effect at rule 3, and that order is what makes "nobody but her" sayable: a
      class deny plus a named allow. Invert them and the only way to express an exception is to
      enumerate every principal who is NOT excepted, which the class forms exist to avoid.
    */
    expect(result(await rename(fix, reader, container))).toMatchObject({
      container: { id: container },
    });
    fix.store.close();
  });

  test("revoking a grant takes effect on the next dispatch, with no reconnect", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);

    const written = await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    const allowed = await rename(fix, reader, container);
    const revoked = await fix.host.dispatch(fix.owner, "core.access.revokeGrant", {
      grantId: written.id,
    });
    const again = await fix.host.dispatch(fix.owner, "core.access.revokeGrant", {
      grantId: written.id,
    });
    const afterRevoke = await rename(fix, reader, container);

    /*
      ADR 0011 rejected mount-time evaluation because "caching authority into a composition makes
      revocation a restart". This is that ruling with a stopwatch: the SAME `AuthContext` — never
      re-authenticated, its socket conceptually still open — is refused the moment the row is
      gone. A cache that survived here would not fail loudly anywhere else.

      Zero is a success on the second call, `revoke`'s ruling applied to a row: revocation is
      idempotent, and "already gone" is not a refusal.
    */
    expect(result(allowed)).toMatchObject({ container: { id: container } });
    expect(result(revoked)).toEqual({ revoked: 1 });
    expect(result(again)).toEqual({ revoked: 0 });
    expect(denial(afterRevoke)).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });
    fix.store.close();
  });

  test("a token's own row is not revocable as a grant, and the owner cannot be denied", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);

    const own = result(
      await fix.host.dispatch(fix.owner, "core.access.listGrants", {
        principalId: reader.principal.id,
      }),
    ) as { grants: Grant[] };
    const tokenRow = own.grants[0];
    if (tokenRow === undefined) throw new Error("a minted token has no grant row");
    const revokeTokenRow = await fix.host.dispatch(fix.owner, "core.access.revokeGrant", {
      grantId: tokenRow.id,
    });
    const denyOwner = await fix.host.dispatch(fix.owner, "core.access.grant", {
      principal: { kind: "principal", id: fix.owner.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "deny",
      reach: "subtree",
    });

    /*
      TWO HOLES CLOSED BY THE MECHANISM, relayed as refusals rather than decided at the door —
      a handler that re-decided either would be a second evaluator one rung above the only one.

      A token's row IS that token: deleting it would leave a live bearer whose authority came
      from nowhere, so the way to end it is to revoke the token. And no row may deny the
      workspace owner anywhere: the owner key authenticates outside the token system precisely
      so administration cannot lock its own administrator out, and a deny row at depth would
      have been the one way to do it — reachable even from a bootstrapped `*` token, which is
      why the mechanism refuses it rather than trusting the door's root-only grading alone.
    */
    expect(denial(revokeTokenRow)).toEqual({
      rule: "refused",
      message: "a token's own grant is revoked by revoking the token",
    });
    expect(denial(denyOwner)).toEqual({
      rule: "refused",
      message: "cannot deny the workspace owner",
    });
    fix.store.close();
  });

  test("listGrants narrows by node and by principal, and a malformed row never lands", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const elsewhere = accessContainer(fix);
    const subject = context(fix, ["containers:read"]);

    await write(fix, {
      principal: { kind: "principal", id: subject.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "allow",
      reach: "node",
    });
    const here = result(
      await fix.host.dispatch(fix.owner, "core.access.listGrants", {
        node: containerNodeUri(container),
      }),
    ) as { grants: Grant[] };
    const there = result(
      await fix.host.dispatch(fix.owner, "core.access.listGrants", {
        node: containerNodeUri(elsewhere),
      }),
    ) as { grants: Grant[] };
    const notAUri = await fix.host.dispatch(fix.owner, "core.access.grant", {
      principal: { kind: "principal", id: subject.principal.id },
      node: "container/whatever",
      caps: ["containers:write"],
      effect: "allow",
      reach: "node",
    });
    const noEffect = await fix.host.dispatch(fix.owner, "core.access.grant", {
      principal: { kind: "principal", id: subject.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      reach: "node",
    });

    expect(here.grants.map((row) => row.principal)).toContainEqual({
      kind: "principal",
      id: subject.principal.id,
    });
    expect(there.grants.some((row) => row.node === containerNodeUri(container))).toBe(false);
    // A node that is not a `manifold://` address is invalid ARGUMENTS, not a refusal: invariant
    // 13 says authority names nodes the one way everything else does, and a bare container id
    // would be a second address system entering through the one door that decides everything.
    expect(denial(notAUri).rule).toBe("invalid_args");
    // Neither closed pair has a default. A row that meant `deny` and got `allow` by omission is
    // the mistake a default makes silently, so the schema makes it impossible.
    expect(denial(noEffect).rule).toBe("invalid_args");
    fix.store.close();
  });

  test("revoking a grant outlives an access seat being off; writing and listing do not", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const reader = context(fix, ["containers:read"], container);
    const written = await write(fix, {
      principal: { kind: "principal", id: reader.principal.id },
      node: containerNodeUri(container),
      caps: ["containers:write"],
      effect: "allow",
      reach: "subtree",
    });
    const host = await hostWithSeatOff(fix, "core.access");

    const blocked = await host.dispatch(fix.owner, "core.access.grant", {
      principal: { kind: "any-agent" },
      node: ROOT,
      caps: ["containers:read"],
      effect: "allow",
      reach: "subtree",
    });
    const listed = await host.dispatch(fix.owner, "core.access.listGrants", {});
    const revoked = await host.dispatch(fix.owner, "core.access.revokeGrant", {
      grantId: written.id,
    });

    /*
      D12, on the sharpest new subject: a grant that should not exist is somebody holding
      authority they should not, which is a leaked token by another name. If a disable suspended
      this door, an administrative toggle — or a mistake — would keep that authority alive until
      somebody noticed and switched the plugin back on. Creation and reading die; taking
      authority back does not.
    */
    expect(denial(blocked).rule).toBe("plugin_disabled");
    expect(denial(listed).rule).toBe("plugin_disabled");
    expect(result(revoked)).toEqual({ revoked: 1 });
    // And it was a real revocation, not a bookkeeping one: the caller it widened is refused.
    expect(denial(await rename(fix, reader, container)).rule).toBe("forbidden");
    fix.store.close();
  });
});

/**
 * SHARES ARE GRANTS NOW (ADR 0011 §Tokens become grant references, ADR 0014).
 *
 * ADR 0011 left exactly one field inert — `principal.kind === "instance"` — and said wave 3
 * would supply real values for it. This is that join, and it is worth pinning at the DOOR rather
 * than in the store because the claim is about vocabulary: a share is not a parallel authority
 * system that happens to resemble grants, it IS a grant row plus a credential that references
 * one, so the grant reader can see it and the grant precedence rules apply to it unchanged.
 */
describe("core.access shares are grant rows", () => {
  const GUEST_ORIGIN = "http://guest.localhost:7778";

  test("minting a share writes the instance grant on the shared node", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);

    const minted = result(
      await fix.host.dispatch(fix.owner, "core.access.mintShare", {
        node: { kind: "container", containerId: container },
        caps: ["containers:read"],
        origin: GUEST_ORIGIN,
      }),
    );
    const listed = result(
      await fix.host.dispatch(fix.owner, "core.access.listGrants", {
        node: `manifold://container/${container}`,
      }),
    ) as { grants: Grant[] };

    const row = listed.grants.find((grant) => grant.principal.kind === "instance");
    expect(row).toMatchObject({
      principal: { kind: "instance", origin: GUEST_ORIGIN },
      node: `manifold://container/${container}`,
      caps: ["containers:read"],
      effect: "allow",
      reach: "subtree",
    });
    // The row is bookkeeping about authority, never a credential: the share's secret exists in
    // the mint answer alone, and a grant has no field one fits in.
    const token = Reflect.get(minted as object, "token");
    expect(JSON.stringify(listed)).not.toContain(token as string);
    fix.store.close();
  });

  test("revoking a share deletes its grant row, and the share stays auditable", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const node = `manifold://container/${container}`;
    const minted = result(
      await fix.host.dispatch(fix.owner, "core.access.mintShare", {
        node: { kind: "container", containerId: container },
        caps: ["containers:read"],
        origin: GUEST_ORIGIN,
      }),
    );
    const shareId = Reflect.get(Reflect.get(minted as object, "share") as object, "id") as string;

    await fix.host.dispatch(fix.owner, "core.access.revokeShare", { shareId });
    const listed = result(
      await fix.host.dispatch(fix.owner, "core.access.listGrants", { node }),
    ) as { grants: Grant[] };
    const inventory = result(await fix.host.dispatch(fix.owner, "core.access.listShares", {}));

    /*
      ABSENCE IS THE REVOCATION. A grant presents no credential, so there is no holder left to
      refuse and a `revokedAt` on the row would be a second way to say "confers nothing" — the
      asymmetry with tokens and shares is deliberate, and it is why those two keep their column:
      a bearer secret already handed over has to keep being refused by name.

      The share row itself survives, revoked: an owner who cut a pipe still needs to see that
      they did, and the audit trail of who shared what with whom does not evaporate.
    */
    expect(listed.grants.some((grant) => grant.principal.kind === "instance")).toBe(false);
    expect(Reflect.get(inventory as object, "shares")).toMatchObject([{ id: shareId }]);
    fix.store.close();
  });
});

/**
 * A TOKEN'S ROW DIES WITH THE TOKEN (issue #140).
 *
 * Before this, revoking a principal left its token-materialized grant rows behind — unreachable,
 * because `tokenBound` rows answer only to the credential that holds them, but immortal, so
 * `listGrants` and the inspector's authority reading printed every principal a gate run had ever
 * minted and revoked. Pinned at the DOOR because the claim is about what the read door shows
 * after the write door ran, and both sides of that are contracts an operator reads.
 */
describe("core.access revocation retires a token's grant row", () => {
  /** The rows one principal, or one node, answers for — through the read door. */
  async function rows(fix: Fixture, filter: { principalId?: string; node?: string }) {
    return GrantsSchema.parse(
      result(await fix.host.dispatch(fix.owner, "core.access.listGrants", filter)),
    ).grants;
  }

  test("revoking a principal's last token empties its rows, and revoking again is a no-op", async () => {
    const fix = await fixture();
    const guest = grant(fix, ["containers:read", "scenes:write"]);
    const principalId = guest.principal.id;

    const before = await rows(fix, { principalId });
    const revoked = await fix.host.dispatch(fix.owner, "core.access.revoke", { principalId });
    const after = await rows(fix, { principalId });
    const again = await fix.host.dispatch(fix.owner, "core.access.revoke", { principalId });

    /*
      The door's answer is unchanged — the TOKEN count, with zero a success the second time —
      and the row is simply absent, not filtered: a grant presents nothing to anybody, so its
      absence is its revocation, exactly as it is for a share's row. The credential's own
      account of what it was issued survives on the token, which is why nothing is lost.
    */
    expect(before).toMatchObject([{ caps: ["containers:read", "scenes:write"] }]);
    expect(result(revoked)).toEqual({ revoked: 1 });
    expect(after).toEqual([]);
    expect(result(again)).toEqual({ revoked: 0 });
    expect(() => fix.auth.authenticate(guest.token)).toThrow(ServiceError);
    expect(fix.store.listTokensByPrincipal(principalId)).toMatchObject([
      { caps: ["containers:read", "scenes:write"], grantId: null },
    ]);
    fix.store.close();
  });

  test("a principal with two tokens keeps the survivor's row until the second dies", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const minter = context(fix, ["tokens:mint", "containers:read"], container);

    // One principal, two credentials: a scoped one minted inside the container by a scoped
    // minter, and an unscoped one minted by the owner. A scoped revocation reaches only the
    // first — the door's published contract — which is what lets this test kill one at a time.
    const scoped = TokenGrantSchema.parse(
      result(
        await fix.host.dispatch(minter, "core.access.mint", {
          principal: { name: "twice", kind: "agent" },
          caps: ["containers:read"],
        }),
      ),
    );
    const principalId = scoped.principal.id;
    const unscoped = fix.auth.mintToken({ principalId, caps: ["containers:read"] }, fix.owner);

    const both = await rows(fix, { principalId });
    const first = await fix.host.dispatch(minter, "core.access.revoke", { principalId });
    const survivor = await rows(fix, { principalId });
    const stillHeld = fix.auth.authenticate(unscoped.token).principal.id;
    const second = await fix.host.dispatch(fix.owner, "core.access.revoke", { principalId });
    const none = await rows(fix, { principalId });

    /*
      Retirement is per TOKEN, not per principal: the scoped credential's row goes with the
      scoped credential, the unscoped one's stays with the credential that still authenticates
      — anything coarser would either strand a live bearer's authority or keep a dead one's.
    */
    expect(both.map((row) => row.node).sort()).toEqual(
      [`manifold://container/${container}`, "manifold://"].sort(),
    );
    expect(result(first)).toEqual({ revoked: 1 });
    expect(survivor.map((row) => row.node)).toEqual(["manifold://"]);
    expect(stillHeld).toBe(principalId);
    expect(result(second)).toEqual({ revoked: 1 });
    expect(none).toEqual([]);
    fix.store.close();
  });

  test("a share's tickets lose their rows with the share, and the share row stays", async () => {
    const fix = await fixture();
    const container = accessContainer(fix);
    const node = `manifold://container/${container}`;
    const minted = ShareGrantSchema.parse(
      result(
        await fix.host.dispatch(fix.owner, "core.access.mintShare", {
          node: { kind: "container", containerId: container },
          caps: ["containers:read"],
          origin: "http://guest.localhost:7778",
        }),
      ),
    );
    const share = fix.store.getShare(minted.share.id);
    if (share === null) throw new Error("minted share has no row");
    const ticket = fix.auth.mintShareTicket(share, {
      id: "guest-visitor",
      kind: "human",
      name: "visitor",
      color: "#3355cc",
    });

    const before = await rows(fix, { node });
    const revoked = await fix.host.dispatch(fix.owner, "core.access.revokeShare", {
      shareId: minted.share.id,
    });
    const after = await rows(fix, { node });

    /*
      Share revocation is UNCHANGED at its door — severed tickets are the count, the share row
      survives revoked — and the ticket's own token row now follows the same rule as any other
      token's: the instance row and the ticket principal's row both leave the node together.
    */
    expect(before.map((row) => row.principal.kind).sort()).toEqual(["instance", "principal"]);
    expect(result(revoked)).toEqual({ revoked: 1 });
    expect(after).toEqual([]);
    expect(() => fix.auth.authenticate(ticket.token)).toThrow(ServiceError);
    expect(fix.store.getShare(minted.share.id)?.revokedAt).not.toBeNull();
    fix.store.close();
  });
});
