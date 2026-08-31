import { describe, expect, test } from "bun:test";
import type { ActionOutcome, Cap, TokenGrant } from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger, type Logger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore } from "./helpers.ts";

/**
 * THE ACCESS DOOR — `core.access`, rung by rung, over the real composition.
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
 *    declared `scope: "pad"` because the routes accepted a pad-scoped caller and let the
 *    mechanism attenuate. Every case below is written so that a drift in any of those three
 *    fails rather than passes quietly.
 * 2. NO SECRET IS LOGGED. A door whose result IS a credential has to be checked, not
 *    assumed, so the last case drives a real dispatch through a capturing logger and asserts
 *    the minted token appears nowhere in what was recorded (invariant 6).
 */

const OWNER_KEY = "a".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
}

function fixture(logger: Logger = silentLogger): Fixture {
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
    () => "http://localhost:7777",
  );
  rooms.setSessionProvider((padId) => broker.listForPad(padId));
  rooms.setPendingOpenProvider((padId) => broker.hasPendingOpenForPad(padId));
  return {
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    host: testPluginHost(store, auth, rooms, broker, runtime, { logger }),
    runtime,
  };
}

/** A real token, so authority is exercised through real attenuation. */
function grant(fix: Fixture, caps: readonly Cap[], padId?: string): TokenGrant {
  return fix.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(padId === undefined ? {} : { padId }),
    },
    fix.owner,
  );
}

function context(fix: Fixture, caps: readonly Cap[], padId?: string): AuthContext {
  return fix.auth.authenticate(grant(fix, caps, padId).token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected a result, got ${outcome.denial.message}`);
  return outcome.result;
}

/** A real container, because a pad-scoped grant is only mintable against one that exists. */
function padId(fix: Fixture): string {
  const id = fix.runtime.newId();
  fix.store.createPad({ id, name: "access pad", createdAt: fix.runtime.now(), layout: "canvas" });
  return id;
}

describe("core.access ladder", () => {
  test("an unknown door in a composed namespace is unknown, never forbidden", async () => {
    const fix = fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.access.listTokens", {});

    // A caller probing for a read that does not exist learns exactly that, and no more: the
    // plugin publishes three doors, and inventing a fourth is not a capability question.
    expect(denial(outcome).rule).toBe("unknown_action");
    fix.store.close();
  });

  test("disabling the plugin closes creation and minting but never revocation", async () => {
    const fix = fixture();
    const victim = grant(fix, ["pads:read"]);
    expect(await fix.host.setEnabled("core.access", false, "admin")).toEqual({ ok: true });

    const created = await fix.host.dispatch(fix.owner, "core.access.createPrincipal", {
      name: "blocked",
    });
    const minted = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      principal: { name: "blocked", kind: "agent" },
      caps: ["pads:read"],
    });
    const revoked = await fix.host.dispatch(fix.owner, "core.access.revokeToken", {
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

  test("a pad-scoped token is refused the workspace door and admitted to the scoped ones", async () => {
    const fix = fixture();
    const pad = padId(fix);
    const scoped = context(fix, ["tokens:mint", "scene:write"], pad);

    const created = await fix.host.dispatch(scoped, "core.access.createPrincipal", {
      name: "escalated",
    });
    const minted = await fix.host.dispatch(scoped, "core.access.mintToken", {
      principal: { name: "sub agent", kind: "agent" },
      caps: ["scene:write"],
    });

    // Bootstrapping a root identity is workspace-grade by construction, so the scope rung
    // answers first — before caps, so a scoped caller learns nothing about what it lacks.
    expect(denial(created)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    /*
      Minting inside your own container still works, which is the whole reason both doors are
      declared `scope: "pad"`: a pad-scoped agent delegating to a sub-agent is the shipped
      behaviour of `POST /api/tokens`, and the mechanism binds the new grant to the minter's
      own scope rather than trusting the request.
    */
    const delegated = result(minted);
    expect(delegated).toMatchObject({ padId: pad, caps: ["scene:write"] });
    fix.store.close();
  });

  test("a scoped minter cannot reach another container, which is the scope obligation", async () => {
    const fix = fixture();
    const home = padId(fix);
    const elsewhere = padId(fix);
    const scoped = context(fix, ["tokens:mint", "scene:write"], home);

    const outcome = await fix.host.dispatch(scoped, "core.access.mintToken", {
      principal: { name: "trespasser", kind: "agent" },
      caps: ["scene:write"],
      padId: elsewhere,
    });

    // `scope: "pad"` lets the caller past the scope rung; the containment check that keeps
    // the door honest then runs in the mechanism, on the real caller. Naming a pad you are
    // not scoped to is refused with the wording the route returned.
    expect(denial(outcome)).toEqual({ rule: "refused", message: "cannot widen pad scope" });
    fix.store.close();
  });

  test("declared caps mirror the routes: root for a bootstrap, tokens:mint for the rest", async () => {
    const fix = fixture();
    const minter = context(fix, ["tokens:mint"]);
    const bystander = context(fix, ["pads:read"]);

    const bootstrapByMinter = await fix.host.dispatch(minter, "core.access.createPrincipal", {
      name: "not root",
    });
    const mintByBystander = await fix.host.dispatch(bystander, "core.access.mintToken", {
      principal: { name: "nope", kind: "agent" },
      caps: ["pads:read"],
    });
    const revokeByBystander = await fix.host.dispatch(bystander, "core.access.revokeToken", {
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
    const fix = fixture();
    const bystander = context(fix, ["pads:read"]);

    const outcome = await fix.host.dispatch(bystander, "core.access.mintToken", { caps: [] });

    // The rung order is the contract: a caller must not learn a door's argument schema by
    // knocking on one it may not open.
    expect(denial(outcome).rule).toBe("forbidden");
    fix.store.close();
  });

  test("a malformed mint is invalid_args, including the either-or the schema refines", async () => {
    const fix = fixture();

    const noPrincipal = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      caps: ["pads:read"],
    });
    const bothPrincipals = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      principalId: fix.owner.principal.id,
      principal: { name: "two ways", kind: "agent" },
      caps: ["pads:read"],
    });
    const noCaps = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      principalId: fix.owner.principal.id,
      caps: [],
    });

    expect(denial(noPrincipal).rule).toBe("invalid_args");
    expect(denial(bothPrincipals).rule).toBe("invalid_args");
    expect(denial(noCaps).rule).toBe("invalid_args");
    fix.store.close();
  });

  test("the mechanism's refusals arrive as refusals, with their wording intact", async () => {
    const fix = fixture();
    const minter = context(fix, ["tokens:mint", "scene:write"]);

    const tooWide = await fix.host.dispatch(minter, "core.access.mintToken", {
      principal: { name: "escalated", kind: "agent" },
      caps: ["terminal:write"],
    });
    const wildcard = await fix.host.dispatch(minter, "core.access.mintToken", {
      principal: { name: "root wannabe", kind: "human" },
      caps: ["*"],
    });
    const missing = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      principalId: "no-such-principal",
      caps: ["pads:read"],
    });
    const notMine = await fix.host.dispatch(minter, "core.access.revokeToken", {
      principalId: fix.owner.principal.id,
    });

    // Attenuation, wildcard reservation, existence and entitlement: four different answers
    // the door itself cannot give, each relayed as `refused` rather than raised as a 500.
    expect(denial(tooWide)).toEqual({
      rule: "refused",
      message: "cannot mint capability terminal:write",
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
    const fix = fixture();

    const outcome = await fix.host.dispatch(fix.owner, "core.access.createPrincipal", {
      name: "second owner",
      kind: "human",
    });

    const issued = result(outcome);
    expect(issued).toMatchObject({ caps: ["*"], padId: null });
    if (issued === null || typeof issued !== "object") throw new Error("no grant");
    const token = Reflect.get(issued, "token");
    if (typeof token !== "string") throw new Error("no token in the grant");
    // The point of the door is a WORKING identity, not a row: the browser's whole boot path
    // is this call followed by authenticating with what it returned.
    expect(fix.auth.authenticate(token).isRoot).toBe(true);
    fix.store.close();
  });

  test("revocation reports how many tokens died, and zero is a success", async () => {
    const fix = fixture();
    const victim = grant(fix, ["pads:read"]);
    fix.auth.mintToken({ principalId: victim.principal.id, caps: ["pads:read"] }, fix.owner);

    const first = await fix.host.dispatch(fix.owner, "core.access.revokeToken", {
      principalId: victim.principal.id,
    });
    const again = await fix.host.dispatch(fix.owner, "core.access.revokeToken", {
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
    const fix = fixture({ info: capture, warn: capture, error: capture });

    const outcome = await fix.host.dispatch(fix.owner, "core.access.mintToken", {
      principal: { name: "logged", kind: "agent" },
      caps: ["pads:read"],
    });

    const issued = result(outcome);
    if (issued === null || typeof issued !== "object") throw new Error("no grant");
    const token = Reflect.get(issued, "token");
    if (typeof token !== "string" || token.length === 0) throw new Error("no token in the grant");
    const log = recorded.join("\n");
    // The door logged the dispatch — it must, one line per action — and the credential it
    // just created appears nowhere in it. Neither does the raw request.
    expect(log).toContain("core.access.mintToken");
    expect(log).not.toContain(token);
    expect(log).not.toContain("logged");
    fix.store.close();
  });
});
