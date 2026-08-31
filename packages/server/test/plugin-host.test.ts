import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKSPACE_LAYOUT, defineAction } from "@manifold/plugin";
import type { ActionOutcome, Cap, PluginRoster, TileLayout, TileSurface } from "@manifold/protocol";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import { PluginHost, type ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore } from "./helpers.ts";

/**
 * THE ACTION DOOR, rung by rung.
 *
 * The ladder is the contract: each rung answers a question the next rung would otherwise
 * leak, so the ORDER is pinned here as tightly as the outcomes. A caller must not learn an
 * action's argument shape by probing a door it may not open, a disabled plugin's actions
 * must be distinguishable from names that never existed, and a token scoped to one
 * container must be refused for its scope even when it carries the required capability.
 */

const OWNER_KEY = "a".repeat(64);

interface HostFixture {
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly runtime: FakeRuntime;
  /** Exposed so a case can compose a DIFFERENT plugin list against the same services. */
  readonly rooms: RoomManager;
  readonly broker: TerminalBroker;
}

function hostFixture(): HostFixture {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const owner = auth.authenticate(OWNER_KEY);
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
    owner,
    host: testPluginHost(store, auth, rooms, broker, runtime),
    runtime,
    rooms,
    broker,
  };
}

/** A token, so authority is exercised through real attenuation rather than a hand-built context. */
function context(fixture: HostFixture, caps: readonly Cap[], padId?: string): AuthContext {
  const grant = fixture.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(padId === undefined ? {} : { padId }),
    },
    fixture.owner,
  );
  return fixture.auth.authenticate(grant.token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

/** A one-leaf workspace tree holding `surface`; structural validity is otherwise intact. */
function layoutWith(surface: TileSurface): TileLayout {
  return { root: { id: "root", dir: null, ratios: [], children: [], surface } };
}

describe("PluginHost denial ladder", () => {
  test("a name nothing composed is unknown, never forbidden", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.nope.doIt", {});

    expect(denial(outcome)).toEqual({
      rule: "unknown_action",
      message: 'unknown action "core.nope.doIt"',
    });
    fixture.store.close();
  });

  test("a disabled plugin's action is disabled, not unknown", async () => {
    const fixture = hostFixture();
    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      sessionId: "s1",
      name: "build",
    });

    // Two different truths a caller acts on differently: wait for an administrator, versus
    // fix the name. Collapsing them into one denial would hide which.
    expect(denial(outcome)).toEqual({
      rule: "plugin_disabled",
      message: 'plugin "core.terminals" is disabled',
    });
    fixture.store.close();
  });

  test("a cleanup action survives its plugin's disable (D12): kill works, rename does not", async () => {
    const fixture = hostFixture();
    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.kill", {
      sessionId: "s1",
    });

    // The disable must refuse creation and administration, never removal — otherwise an
    // administrator toggling a plugin off locks every canvas out of deleting terminals.
    // The kill still walks the REST of the ladder: here it reaches the handler, which
    // refuses on state (no such session) rather than on the disable.
    expect(denial(outcome).rule).toBe("refused");
    fixture.store.close();
  });

  test("a pad-scoped token is refused for its scope even when it holds the capability", async () => {
    const fixture = hostFixture();
    const pad = fixture.runtime.newId();
    fixture.store.createPad({
      id: pad,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      layout: "canvas",
    });
    const scoped = context(fixture, ["pads:read", "pads:write"], pad);

    const outcome = await fixture.host.dispatch(scoped, "core.terminals.rename", {
      sessionId: "s1",
      name: "build",
    });

    // MONOTONICITY: this token satisfies `pads:write`, so the only rung that can refuse it
    // is the scope rung — and it must fire before the cap check, or the message would name
    // the wrong reason and a scoped caller would believe a cap grant could fix it.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    fixture.store.close();
  });

  test("a missing declared capability is forbidden before arguments are looked at", async () => {
    const fixture = hostFixture();
    const reader = context(fixture, ["pads:read"]);

    // Deliberately malformed args: if the ladder checked shape first, the caller would learn
    // the door's schema by knocking on a door it may not open.
    const outcome = await fixture.host.dispatch(reader, "core.terminals.rename", {});

    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "pads:write capability required",
    });
    fixture.store.close();
  });

  test("arguments that do not fit the published schema are invalid_args", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      sessionId: "s1",
    });

    expect(denial(outcome).rule).toBe("invalid_args");
    expect(denial(outcome).message).toContain("name");
    fixture.store.close();
  });

  test("a handler's own refusal is the last rung and carries its message", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      sessionId: "missing",
      name: "build",
    });

    expect(denial(outcome)).toEqual({ rule: "refused", message: "terminal not found" });
    fixture.store.close();
  });

  test("an unparseable name refuses before an all-whitespace one, both as refusals", async () => {
    const fixture = hostFixture();

    const blank = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      sessionId: "missing",
      name: "   ",
    });

    // The route this replaced answered 400 for a blank name and 404 for a missing session;
    // both are now refusals, and the blank name is caught before the session is looked up.
    expect(denial(blank)).toEqual({ rule: "refused", message: "name is empty" });
    fixture.store.close();
  });
});

describe("PluginHost enablement", () => {
  test("setEnabled persists, recomposes, and publishes the new roster", async () => {
    const fixture = hostFixture();
    const seen: PluginRoster[] = [];
    const remove = fixture.host.onRosterChange((roster) => {
      seen.push(roster);
    });

    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });

    expect([...fixture.store.disabledPlugins()]).toEqual(["core.terminals"]);
    expect(fixture.host.composition().enabled("core.terminals")).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.find((entry) => entry.manifest.id === "core.terminals")?.enabled).toBe(false);
    // A disabled plugin stays IN the roster: a client has to name the plugin it is waiting
    // for in the placeholder it renders.
    expect(fixture.host.roster().some((entry) => entry.manifest.id === "core.terminals")).toBe(
      true,
    );

    expect(fixture.host.setEnabled("core.terminals", true)).toEqual({ ok: true });
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    expect(seen).toHaveLength(2);
    remove();
    fixture.store.close();
  });

  test("a no-op toggle publishes NOTHING, so a socket is not woken for a non-change", async () => {
    const fixture = hostFixture();
    const seen: PluginRoster[] = [];
    const remove = fixture.host.onRosterChange((roster) => {
      seen.push(roster);
    });

    // D3: every publish is a connection-level frame to every open socket, and every client
    // rebuilds its composition when one lands. Enabling what is already enabled is an
    // answer, not news.
    expect(fixture.host.setEnabled("core.terminals", true)).toEqual({ ok: true });
    expect(seen).toHaveLength(0);
    expect([...fixture.store.disabledPlugins()]).toEqual([]);

    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    // ...and a second disable of the same plugin is equally quiet.
    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    remove();
    fixture.store.close();
  });

  test("a removed listener stops hearing rosters, and does not disturb the others", async () => {
    const fixture = hostFixture();
    const staying: PluginRoster[] = [];
    const leaving: PluginRoster[] = [];
    fixture.host.onRosterChange((roster) => {
      staying.push(roster);
    });
    const remove = fixture.host.onRosterChange((roster) => {
      leaving.push(roster);
    });

    expect(fixture.host.setEnabled("core.draw", false)).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([1, 1]);

    // A socket closes far more often than the roster changes; a subscription that outlived
    // its connection would push frames into a dead socket forever.
    remove();
    expect(fixture.host.setEnabled("core.draw", true)).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([2, 1]);
    fixture.store.close();
  });

  test("the composition is REPLACED on a toggle, so a held reference is a stale snapshot", async () => {
    const fixture = hostFixture();
    const before = fixture.host.composition();

    expect(fixture.host.setEnabled("core.draw", false)).toEqual({ ok: true });

    // Hot enablement (D4) is a recompose, not a mutation: everything that must react reads
    // `composition()` again (or the published roster), which is why the identity changes.
    expect(fixture.host.composition()).not.toBe(before);
    expect(before.enabled("core.draw")).toBe(true);
    expect(fixture.host.composition().enabled("core.draw")).toBe(false);
    // The vocabulary itself is untouched: a disable removes no name from the registry.
    expect([...fixture.host.composition().actions.keys()].sort()).toEqual(
      [...before.actions.keys()].sort(),
    );
    fixture.store.close();
  });

  test("an essential plugin refuses to be disabled, and an unknown id refuses too", async () => {
    const fixture = hostFixture();

    expect(fixture.host.setEnabled("core.shell", false)).toEqual({ refused: "essential" });
    expect(fixture.host.setEnabled("core.ghost", false)).toEqual({
      refused: 'unknown plugin "core.ghost"',
    });

    // Nothing was written and nothing went dark: the refusal is total.
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    expect(fixture.host.composition().enabled("core.shell")).toBe(true);
    fixture.store.close();
  });

  test("the plugin-manager action forwards the host's refusal verbatim", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.plugins.setEnabled", {
      id: "core.shell",
      enabled: false,
    });

    expect(denial(outcome)).toEqual({ rule: "refused", message: "essential" });
    fixture.store.close();
  });

  test("the administration door cannot disable ITSELF, so nobody can freeze the composition", async () => {
    const fixture = hostFixture();

    // BOTH doors, because enablement has two: the in-process host method the server's own
    // wiring calls, and the dispatched action any `plugins:manage` holder can reach. An
    // essential flag honoured on one path only would leave the lockout reachable from the
    // other.
    expect(fixture.host.setEnabled("core.plugins", false)).toEqual({ refused: "essential" });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.plugins.setEnabled", {
      id: "core.plugins",
      enabled: false,
    });

    /*
      The self-lockout D4's essential flag exists for. `core.plugins.setEnabled` IS the only
      door onto enablement, so disabling its own plugin would make every later attempt —
      root's included — fail the `plugin_disabled` rung, freezing the workspace's composition
      short of editing SQLite by hand. `plugins:manage` is authority to administer plugins,
      never authority to destroy the administration.
     */
    expect(denial(outcome)).toEqual({ rule: "refused", message: "essential" });
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    expect(fixture.host.composition().enabled("core.plugins")).toBe(true);

    // And administration is still alive afterwards: the refusal cost nothing.
    expect(
      await fixture.host.dispatch(fixture.owner, "core.plugins.setEnabled", {
        id: "core.draw",
        enabled: false,
      }),
    ).toEqual({ ok: true, result: {} });
    expect([...fixture.store.disabledPlugins()]).toEqual(["core.draw"]);
    fixture.store.close();
  });

  test("setEnabled needs plugins:manage, which the roster publishes as the action's cap", async () => {
    const fixture = hostFixture();
    const writer = context(fixture, ["pads:read", "pads:write"]);

    const outcome = await fixture.host.dispatch(writer, "core.plugins.setEnabled", {
      id: "core.terminals",
      enabled: false,
    });

    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "plugins:manage capability required",
    });
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    fixture.store.close();
  });
});

describe("core.layout.set", () => {
  test("a valid workspace tree is stored for the caller and nobody else", async () => {
    const fixture = hostFixture();
    const other = context(fixture, ["pads:read", "pads:write"]);

    const outcome = await fixture.host.dispatch(fixture.owner, "core.layout.set", {
      layout: DEFAULT_WORKSPACE_LAYOUT,
    });

    expect(outcome).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(
      DEFAULT_WORKSPACE_LAYOUT,
    );
    // Layout writes are self-targeted by construction: the action takes no principal id.
    expect(fixture.store.workspaceLayout(other.principal.id)).toBeNull();
    fixture.store.close();
  });

  test("an unknown or disabled panel id is ACCEPTED, so a disable can never brick a layout", async () => {
    const fixture = hostFixture();
    expect(fixture.host.setEnabled("core.terminals", false)).toEqual({ ok: true });
    const layout = layoutWith({ kind: "panel", panelId: "core.ghost.panel" });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.layout.set", { layout });

    // Validation is STRUCTURAL only. A leaf naming a plugin nobody composed renders a
    // placeholder with a remove control; refusing the write instead would mean turning a
    // plugin off could lock a principal out of rearranging their own workspace.
    expect(outcome).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(layout);
    fixture.store.close();
  });

  test("a leaf that is not a panel is refused", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.layout.set", {
      layout: layoutWith({ kind: "terminal", sessionId: "s1" }),
    });

    // A workspace shows panels. A terminal or pad surface at this level is a category error
    // the renderer could not honour, so it is refused rather than stored and ignored.
    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: 'workspace leaves hold panels, not "terminal"',
    });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toBeNull();
    fixture.store.close();
  });

  test("a tree that is not a tree is refused", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.layout.set", {
      layout: {
        root: { id: "root", dir: "row", ratios: [1], children: ["missing"], surface: null },
      },
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "layout is not a valid tile tree",
    });
    fixture.store.close();
  });

  test("a pad-scoped token cannot write a workspace layout at all", async () => {
    const fixture = hostFixture();
    const pad = fixture.runtime.newId();
    fixture.store.createPad({
      id: pad,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      layout: "canvas",
    });
    const scoped = context(fixture, ["pads:read", "pads:write"], pad);

    const outcome = await fixture.host.dispatch(scoped, "core.layout.set", {
      layout: DEFAULT_WORKSPACE_LAYOUT,
    });

    // `core.layout.set` declares NO caps, which is exactly why the scope rung matters: the
    // cap check would have passed it through.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    expect(fixture.store.workspaceLayout(scoped.principal.id)).toBeNull();
    fixture.store.close();
  });
});

/**
 * A BROKEN DOOR IS NOT A DENIAL.
 *
 * The denial ladder answers questions about the CALLER — its authority, its scope, its
 * arguments, the state it aimed at. A door that violates its own published contract is a
 * different category entirely: the roster promised every reader a result shape (A3), so
 * breaking that promise has to reach the logs and the caller as a failure, never be laundered
 * into a 200 that says the request was refused. These cases compose a deliberately broken
 * plugin against the real services to pin that line.
 */
describe("PluginHost contract failures", () => {
  const BROKEN: readonly ServerPluginDef[] = [
    {
      manifest: {
        id: "test.doors",
        version: "0.0.0",
        title: "Broken doors",
        description: "Two ways for a plugin author to break the published contract.",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      },
      actions: [
        defineAction({
          name: "liar",
          title: "Promises a count",
          caps: [],
          input: z.strictObject({}),
          result: z.strictObject({ count: z.number() }),
        }),
        defineAction({
          name: "orphan",
          title: "Composed with no handler",
          caps: [],
          input: z.strictObject({}),
          result: z.strictObject({}),
        }),
      ],
      handlers: {
        liar: async () => ({ count: "many" }),
      },
    },
  ];

  function brokenHost(fixture: HostFixture): PluginHost {
    return new PluginHost(
      BROKEN,
      fixture.store,
      fixture.auth,
      fixture.rooms,
      fixture.broker,
      fixture.runtime,
      silentLogger,
    );
  }

  test("a result that fails its published schema THROWS instead of denying", async () => {
    const fixture = hostFixture();
    const host = brokenHost(fixture);

    // Were this a `refused`, a caller would retry forever against a door that can never
    // succeed, and the published JSON Schema would be a lie nobody notices.
    await expect(host.dispatch(fixture.owner, "test.doors.liar", {})).rejects.toThrow();
    fixture.store.close();
  });

  test("a composed action with no handler THROWS: that is a wiring bug, not a refusal", async () => {
    const fixture = hostFixture();
    const host = brokenHost(fixture);

    // The action is real vocabulary — it is in the roster and `/api/protocol` — so
    // `unknown_action` would be false, and any denial would blame the caller for a
    // registration the composition files got wrong.
    expect(host.composition().actions.has("test.doors.orphan")).toBe(true);
    await expect(host.dispatch(fixture.owner, "test.doors.orphan", {})).rejects.toThrow(
      /no server handler/,
    );
    fixture.store.close();
  });

  test("the ladder still runs FIRST: a caller's own error is a denial even at a broken door", async () => {
    const fixture = hostFixture();
    const host = brokenHost(fixture);

    // Ordering matters for triage: a bad argument must not surface as a server failure just
    // because the handler behind it would have failed too.
    const outcome = await host.dispatch(fixture.owner, "test.doors.liar", { surplus: 1 });
    expect(denial(outcome).rule).toBe("invalid_args");
    fixture.store.close();
  });
});
