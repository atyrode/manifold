import { describe, expect, test } from "bun:test";
import {
  ENGINE_PLUGINS_ID,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  assembleRoster,
  composeDefaultLayout,
  defineAction,
} from "@manifold/plugin";
import type {
  ActionOutcome,
  Cap,
  PluginManifest,
  PluginRoster,
  TileLayout,
  TileRef,
} from "@manifold/protocol";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { SERVER_PLUGIN_DEFS, SHIPPED_PLUGIN_IDS } from "../src/assembly.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyElementTraits, assemblyItemNouns } from "../src/placement.ts";
import {
  OUTSIDE_SCOPE_REFUSAL,
  PluginHost,
  type MachineLiveness,
  type ServerPluginDef,
} from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testEventHub, testPluginHost, testStore } from "./helpers.ts";

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

/** No machine is connected in a bare fixture, which is the honest state of a fresh store. */
const OFFLINE_MACHINES: MachineLiveness = { isOnline: () => false };

/**
 * The real default workspace tree, COMPOSED from the real registration's roster the way the
 * layout door composes it (ADR 0017 S17-B). A layout fixture is worth deriving from the
 * production manifests rather than hand-writing, because these cases assert what happens to a
 * tree a principal could actually have been served.
 */
const DEFAULT_LAYOUT = composeDefaultLayout(
  assembleRoster(SERVER_PLUGIN_DEFS, new Set<string>()).roster,
).layout;

/**
 * A real executor over the fixture's real services. These cases compose plugin lists of
 * their own, so the roster thunk resolves to an EMPTY vocabulary: nothing here places a
 * contributed element kind, and a thunk that reached back into a half-built host would be
 * wiring the test differently from the server.
 */
function testPlacement(fixture: HostFixture): PlaceExecutor {
  return new PlaceExecutor(
    fixture.store,
    fixture.rooms,
    fixture.broker,
    fixture.runtime,
    assemblyElementTraits(() => []),
    assemblyItemNouns(() => []),
  );
}

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
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
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
function context(fixture: HostFixture, caps: readonly Cap[], containerId?: string): AuthContext {
  const grant = fixture.auth.mintToken(
    {
      principal: { name: "guest", kind: "human" },
      caps: [...caps],
      ...(containerId === undefined ? {} : { containerId }),
    },
    fixture.owner,
  );
  return fixture.auth.authenticate(grant.token);
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected a denial");
  return outcome.denial;
}

/** A one-leaf workspace tree holding `ref`; structural validity is otherwise intact. */
function layoutWith(ref: TileRef): TileLayout {
  return { root: { id: "root", dir: null, ratios: [], children: [], ref } };
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
    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "s1",
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
    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.kill", {
      terminalId: "s1",
    });

    // The disable must refuse creation and administration, never removal — otherwise an
    // administrator toggling a plugin off locks every canvas out of deleting terminals.
    // The kill still walks the REST of the ladder: here it reaches the handler, which
    // refuses on state (no such terminal) rather than on the disable.
    expect(denial(outcome).rule).toBe("refused");
    fixture.store.close();
  });

  test("a container-scoped token is refused for its scope even when it holds the capability", async () => {
    const fixture = hostFixture();
    const container = fixture.runtime.newId();
    fixture.store.createContainer({
      id: container,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    const scoped = context(fixture, ["containers:read", "plugins:manage"], container);

    const outcome = await fixture.host.dispatch(scoped, ENGINE_SET_ENABLED_ACTION, {
      id: "core.draw",
      enabled: false,
    });

    // MONOTONICITY: this token satisfies `plugins:manage`, so the only rung that can refuse
    // it is the scope rung — and it must fire before the cap check, or the message would name
    // the wrong reason and a scoped caller would believe a cap grant could fix it. The door is
    // workspace-graded by NATURE, not by omission: enablement is workspace-global, so no
    // container's token can ever authorize it however many caps it carries.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    fixture.store.close();
  });

  test("a missing declared capability is forbidden before arguments are looked at", async () => {
    const fixture = hostFixture();
    const reader = context(fixture, ["containers:read"]);

    // Deliberately malformed args: if the ladder checked shape first, the caller would learn
    // the door's schema by knocking on a door it may not open.
    const outcome = await fixture.host.dispatch(reader, "core.terminals.rename", {});

    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      // `core.terminals.rename` is graded `scope: "container"` and declares `terminals:write`,
      // so an UNSCOPED reader passes the scope rung and is refused here — before its arguments
      // are parsed, which is the whole point of the ordering.
      message: "terminals:write capability required",
    });
    fixture.store.close();
  });

  test("arguments that do not fit the published schema are invalid_args", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "s1",
    });

    expect(denial(outcome).rule).toBe("invalid_args");
    expect(denial(outcome).message).toContain("name");
    fixture.store.close();
  });

  test("a handler's own refusal is the last rung and carries its message", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "missing",
      name: "build",
    });

    expect(denial(outcome)).toEqual({ rule: "refused", message: "terminal not found" });
    fixture.store.close();
  });

  test("an unparseable name refuses before an all-whitespace one, both as refusals", async () => {
    const fixture = hostFixture();

    const blank = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "missing",
      name: "   ",
    });

    // The route this replaced answered 400 for a blank name and 404 for a missing terminal;
    // both are now refusals, and the blank name is caught before the terminal is looked up.
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

    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });

    expect([...fixture.store.disabledPlugins()]).toEqual(["core.terminals"]);
    expect(fixture.host.assembly().enabled("core.terminals")).toBe(false);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.find((entry) => entry.manifest.id === "core.terminals")?.enabled).toBe(false);
    // A disabled plugin stays IN the roster: a client has to name the plugin it is waiting
    // for in the placeholder it renders.
    expect(fixture.host.roster().some((entry) => entry.manifest.id === "core.terminals")).toBe(
      true,
    );

    expect(await fixture.host.setEnabled("core.terminals", true, "admin")).toEqual({ ok: true });
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
    // rebuilds its assembly when one lands. Enabling what is already enabled is an
    // answer, not news.
    expect(await fixture.host.setEnabled("core.terminals", true, "admin")).toEqual({ ok: true });
    expect(seen).toHaveLength(0);
    expect([...fixture.store.disabledPlugins()]).toEqual([]);

    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    // ...and a second disable of the same plugin is equally quiet.
    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });
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

    expect(await fixture.host.setEnabled("core.draw", false, "admin")).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([1, 1]);

    // A socket closes far more often than the roster changes; a subscription that outlived
    // its connection would push frames into a dead socket forever.
    remove();
    expect(await fixture.host.setEnabled("core.draw", true, "admin")).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([2, 1]);
    fixture.store.close();
  });

  test("the assembly is REPLACED on a toggle, so a held reference is a stale snapshot", async () => {
    const fixture = hostFixture();
    const before = fixture.host.assembly();

    expect(await fixture.host.setEnabled("core.draw", false, "admin")).toEqual({ ok: true });

    // Hot enablement (D4) is a recompose, not a mutation: everything that must react reads
    // `assembly()` again (or the published roster), which is why the identity changes.
    expect(fixture.host.assembly()).not.toBe(before);
    expect(before.enabled("core.draw")).toBe(true);
    expect(fixture.host.assembly().enabled("core.draw")).toBe(false);
    // The vocabulary itself is untouched: a disable removes no name from the registry.
    expect([...fixture.host.assembly().actions.keys()].sort()).toEqual(
      [...before.actions.keys()].sort(),
    );
    fixture.store.close();
  });

  test("an essential plugin refuses to be disabled, and an unknown id refuses too", async () => {
    const fixture = hostFixture();

    expect(await fixture.host.setEnabled("core.shell", false, "admin")).toEqual({
      refused: "essential",
    });
    expect(await fixture.host.setEnabled("core.ghost", false, "admin")).toEqual({
      refused: "unknown_plugin: core.ghost",
    });

    // Nothing was written and nothing went dark: the refusal is total.
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    expect(fixture.host.assembly().enabled("core.shell")).toBe(true);
    fixture.store.close();
  });

  test("the engine's builtin door refuses to be switched off, through its own door", async () => {
    const fixture = hostFixture();

    // BOTH doors, because enablement has two: the in-process host method the server's own
    // wiring calls, and the dispatched action any `plugins:manage` holder can reach. A
    // guarantee honoured on one path only would leave the lockout reachable from the other.
    expect(await fixture.host.setEnabled(ENGINE_PLUGINS_ID, false, "admin")).toEqual({
      refused: `builtin: ${ENGINE_PLUGINS_ID}`,
    });

    const outcome = await fixture.host.dispatch(fixture.owner, ENGINE_SET_ENABLED_ACTION, {
      id: ENGINE_PLUGINS_ID,
      enabled: false,
    });

    /*
      The self-lockout the old `essential` flag on `core.plugins` existed to prevent, solved
      where it belongs (ADR 0013 §11). The door is not a member of the assembly it
      administers, so there is no toggle to reach it: `plugins:manage` is authority to
      administer plugins, never authority to destroy the administration.
     */
    expect(denial(outcome)).toEqual({ rule: "refused", message: `builtin: ${ENGINE_PLUGINS_ID}` });
    expect([...fixture.store.disabledPlugins()]).toEqual([]);
    expect(fixture.host.assembly().enabled(ENGINE_PLUGINS_ID)).toBe(true);
    fixture.store.close();
  });

  test("the manager's SEAT is essential while the door stays outside the assembly", async () => {
    const fixture = hostFixture();

    /*
      TWO CLAIMS THAT USED TO LOOK LIKE ONE, and separating them is what issue #91 changed.

      `core.plugins` carried `essential: true` once for the wrong reason — a plugin made
      permanently undisableable so the enablement MECHANISM inside it could not be switched off
      (ADR 0013 §11). That cure was replaced by moving the door out of the assembly entirely,
      and the flag came off with it. It is back now for a different reason, and the difference is
      the whole point: the ledger of what is on and off is one of the rail's non-negotiables, so
      a workspace that could switch off its own plugin list would hide its own recovery. What is
      protected is the SEAT, never the mechanism.

      So this test pins both halves at once: the disable is refused by CLASS, and the door it
      would have taken down is not a member of the assembly at all — administration keeps
      working while the row that draws it is untouched.
    */
    const refused = await fixture.host.dispatch(fixture.owner, ENGINE_SET_ENABLED_ACTION, {
      id: "core.plugins",
      enabled: false,
    });
    expect(denial(refused)).toEqual({ rule: "refused", message: "essential" });
    expect(fixture.host.assembly().enabled("core.plugins")).toBe(true);
    // Nothing was written: a refused disable is an answer, not a half-applied transition.
    expect([...fixture.store.disabledPlugins()]).toEqual([]);

    // The door is reachable and effective on an ORDINARY plugin, with the manager's own seat
    // still standing — which is what "the door is not a member of the assembly it administers"
    // buys, and it is the claim the old form of this test was really making.
    expect(
      await fixture.host.dispatch(fixture.owner, ENGINE_SET_ENABLED_ACTION, {
        id: "core.draw",
        enabled: false,
      }),
    ).toEqual({ ok: true, result: {} });
    expect([...fixture.store.disabledPlugins()]).toEqual(["core.draw"]);
    expect(fixture.host.assembly().enabled("core.plugins")).toBe(true);
    fixture.store.close();
  });

  test("the roster records WHO changed a plugin and WHEN", async () => {
    const fixture = hostFixture();
    fixture.runtime.time = 1_700_000_000_000;

    await fixture.host.setEnabled("core.draw", false, "principal-7");

    const entry = fixture.host.roster().find((row) => row.manifest.id === "core.draw");
    // Attribution is workspace-global shared state like the flag itself: "the drawing tool
    // vanished" must be answerable by every principal, not only by whoever reads the logs.
    expect(entry?.changedBy).toBe("principal-7");
    expect(entry?.changedAt).toBe(1_700_000_000_000);
    fixture.store.close();
  });

  test("setEnabled needs plugins:manage, which the roster publishes as the action's cap", async () => {
    const fixture = hostFixture();
    const writer = context(fixture, ["containers:read", "containers:write"]);

    const outcome = await fixture.host.dispatch(writer, ENGINE_SET_ENABLED_ACTION, {
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

describe("core.space.setLayout", () => {
  test("a valid workspace tree is stored for the caller and nobody else", async () => {
    const fixture = hostFixture();
    const other = context(fixture, ["containers:read", "containers:write"]);

    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", {
      layout: DEFAULT_LAYOUT,
    });

    expect(outcome).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(DEFAULT_LAYOUT);
    // Layout writes are self-targeted by construction: the action takes no principal id.
    expect(fixture.store.workspaceLayout(other.principal.id)).toBeNull();
    fixture.store.close();
  });

  test("an unknown or disabled panel id is ACCEPTED, so a disable can never brick a layout", async () => {
    const fixture = hostFixture();
    expect(await fixture.host.setEnabled("core.terminals", false, "admin")).toEqual({ ok: true });
    const layout = layoutWith({ kind: "panel", panelId: "core.ghost.panel" });

    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", { layout });

    // Validation is STRUCTURAL only. A leaf naming a plugin nobody composed renders a
    // placeholder with a remove control; refusing the write instead would mean turning a
    // plugin off could lock a principal out of rearranging their own workspace.
    expect(outcome).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(layout);
    fixture.store.close();
  });

  test("a split of two VACANT leaves is stored as written: that is the palette's drop", async () => {
    const fixture = hostFixture();
    /*
      What dropping "Stack column" from `core.arrange`'s palette onto the workspace tree
      commits (issue #104): a split whose two seats are still EMPTY. Structural validation
      has to let it through, because the empty seats are the point of the gesture — they are
      the aims the operator drags panels into next, and a door that demanded an occupant per
      leaf would make the palette impossible to use in one gesture at a time.
     */
    const layout: TileLayout = {
      root: { id: "root", dir: "row", ratios: [0.5, 0.5], children: ["t1", "t2"], ref: null },
      t1: {
        id: "t1",
        dir: null,
        ratios: [],
        children: [],
        ref: { kind: "panel", panelId: "core.shell.sidebar" },
      },
      t2: { id: "t2", dir: "column", ratios: [0.5, 0.5], children: ["t3", "t4"], ref: null },
      t3: { id: "t3", dir: null, ratios: [], children: [], ref: null },
      t4: { id: "t4", dir: null, ratios: [], children: [], ref: null },
    };

    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", { layout });

    expect(outcome).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(layout);
    fixture.store.close();
  });

  test("a leaf that is not a panel is refused", async () => {
    const fixture = hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", {
      layout: layoutWith({ kind: "terminal", terminalId: "s1" }),
    });

    // A workspace shows panels. A terminal or container ref at this level is a category error
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

    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", {
      layout: {
        root: { id: "root", dir: "row", ratios: [1], children: ["missing"], ref: null },
      },
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "layout is not a valid tile tree",
    });
    fixture.store.close();
  });

  test("a container-scoped token cannot write a workspace layout at all", async () => {
    const fixture = hostFixture();
    const container = fixture.runtime.newId();
    fixture.store.createContainer({
      id: container,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    const scoped = context(fixture, ["containers:read", "containers:write"], container);

    const outcome = await fixture.host.dispatch(scoped, "core.space.setLayout", {
      layout: DEFAULT_LAYOUT,
    });

    // `core.space.setLayout` declares NO caps, which is exactly why the scope rung matters: the
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
    return customHost(fixture, BROKEN);
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
    // registration the assembly files got wrong.
    expect(host.assembly().actions.has("test.doors.orphan")).toBe(true);
    await expect(host.dispatch(fixture.owner, "test.doors.orphan", {})).rejects.toThrow(
      /no server handler/,
    );
    fixture.store.close();
  });

  test("the ladder still runs FIRST: a caller's own error is a denial even at a broken door", async () => {
    const fixture = hostFixture();
    const host = brokenHost(fixture);

    // Ordering matters for triage: a bad argument must not appear as a server failure just
    // because the handler behind it would have failed too.
    const outcome = await host.dispatch(fixture.owner, "test.doors.liar", { surplus: 1 });
    expect(denial(outcome).rule).toBe("invalid_args");
    fixture.store.close();
  });
});

/**
 * CONTRACT V2 — the behaviours ADR 0013 ratified, each defended by the case that would
 * otherwise regress silently: a hook cannot veto a transition, a dependency violation is a
 * refusal that NAMES what is in the way rather than a cascade nobody consented to, stored
 * data an enabled plugin cannot read is refused rather than read anyway, and destruction is
 * a separate verb that refuses while the code it would erase is still running.
 */

interface HookLog {
  readonly calls: string[];
}

/** A plugin whose only behaviour is recording which hooks fired, in which order. */
function recorder(
  id: string,
  log: HookLog,
  extras: Partial<ServerPluginDef> = {},
  manifestExtras: Partial<PluginManifest> = {},
): ServerPluginDef {
  return {
    manifest: {
      id,
      version: "1.0.0",
      title: id,
      description: `${id} under test`,
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      ...manifestExtras,
    },
    actions: [],
    handlers: {},
    lifecycle: {
      onEnable: (ctx) => {
        log.calls.push(`enable:${ctx.pluginId}`);
      },
      onDisable: (ctx) => {
        log.calls.push(`disable:${ctx.pluginId}`);
      },
      onAssemblyChanged: (ctx, delta) => {
        log.calls.push(
          `changed:${ctx.pluginId}(+${delta.enabled.join("|")}-${delta.disabled.join("|")})`,
        );
      },
    },
    ...extras,
  };
}

function customHost(
  fixture: HostFixture,
  defs: readonly ServerPluginDef[],
  options: {
    readonly lifecycleTimeoutMs?: number;
    readonly distribution?: ReadonlySet<string>;
  } = {},
): PluginHost {
  // The hub reads the assembly of the host it is handed to, exactly as `main.ts` wires it.
  let host: PluginHost | null = null;
  const events = testEventHub(
    fixture.store,
    fixture.auth,
    fixture.broker,
    () => {
      if (host === null) throw new Error("the event plane read the assembly before the host");
      return host.assembly();
    },
    fixture.runtime,
  );
  host = new PluginHost(
    defs,
    fixture.store,
    fixture.auth,
    fixture.rooms,
    fixture.broker,
    testPlacement(fixture),
    OFFLINE_MACHINES,
    new InstanceDialer(fixture.store, fixture.runtime, silentLogger, () => "http://localhost:7777"),
    fixture.runtime,
    silentLogger,
    events,
    options,
  );
  return host;
}

/**
 * THE `core.` RESERVATION, at the host rather than in the engine's unit tests.
 *
 * `assembleRoster` refuses the squat wherever it is handed a distribution; what this case
 * defends is the WIRING — that the production host is actually handed one (`main.ts` passes
 * `SHIPPED_PLUGIN_IDS`, derived from the registration table), because an unwired reservation
 * reads identically to a defended one until a stranger's `core.` plugin composes cleanly.
 */
describe("PluginHost core namespace", () => {
  test("a manifest under core. that the distribution never registered is refused by name", () => {
    const fixture = hostFixture();
    const log: HookLog = { calls: [] };

    expect(() =>
      customHost(fixture, [recorder("core.impostor", log)], { distribution: SHIPPED_PLUGIN_IDS }),
    ).toThrow(/claims the reserved "core\." namespace/);

    // A stranger's own namespace is their business: the reservation defends authorship, not
    // membership of the roster.
    expect(() =>
      customHost(fixture, [recorder("vendor.impostor", log)], { distribution: SHIPPED_PLUGIN_IDS }),
    ).not.toThrow();
    fixture.store.close();
  });

  test("the distribution's own seats compose through the real wiring", () => {
    const fixture = hostFixture();
    // `testPluginHost` is the production wiring verbatim — `SERVER_PLUGIN_DEFS` plus the
    // derived distribution — so this asserts the reservation costs the shipped roster nothing.
    const ids = fixture.host.roster().map((entry) => entry.manifest.id);
    for (const shipped of SHIPPED_PLUGIN_IDS) expect(ids).toContain(shipped);
    for (const id of ids.filter((candidate) => candidate.startsWith("core."))) {
      expect(SHIPPED_PLUGIN_IDS.has(id)).toBe(true);
    }
    fixture.store.close();
  });
});

describe("PluginHost lifecycle", () => {
  test("hooks fire on TRANSITIONS only, never at boot", async () => {
    const fixture = hostFixture();
    const log: HookLog = { calls: [] };
    const host = customHost(fixture, [recorder("test.alpha", log)]);

    // Boot is not a transition: everything enabled is simply live, so a process start owes
    // no fan-out and invents no failures for plugins that were already on.
    expect(log.calls).toEqual([]);

    await host.setEnabled("test.alpha", false, "admin");
    expect(log.calls).toEqual(["disable:test.alpha"]);
    await host.setEnabled("test.alpha", true, "admin");
    expect(log.calls).toEqual(["disable:test.alpha", "enable:test.alpha"]);
    fixture.store.close();
  });

  test("survivors hear onAssemblyChanged once, in assembly order, with the delta", async () => {
    const fixture = hostFixture();
    const log: HookLog = { calls: [] };
    const host = customHost(fixture, [
      recorder("test.zulu", log, {}, { after: ["test.alpha"] }),
      recorder("test.alpha", log),
      recorder("test.mike", log),
    ]);

    await host.setEnabled("test.mike", false, "admin");

    /*
      The disabled plugin gets its own hook and is NOT a survivor; the other two hear the
      change exactly once each, in the assembly's topological order (`test.alpha` before
      `test.zulu` because `after` says so; the engine's builtin row declares no hooks). That
      order is derived and total precisely so this fan-out is reproducible.
     */
    expect(log.calls).toEqual([
      "disable:test.mike",
      "changed:test.alpha(+-test.mike)",
      "changed:test.zulu(+-test.mike)",
    ]);
    fixture.store.close();
  });

  test("a hook that throws is NAMED on the roster and does not undo the transition", async () => {
    const fixture = hostFixture();
    const log: HookLog = { calls: [] };
    const host = customHost(fixture, [
      recorder("test.alpha", log, {
        lifecycle: {
          onDisable: () => {
            throw new Error("cannot let go");
          },
        },
      }),
    ]);

    expect(await host.setEnabled("test.alpha", false, "admin")).toEqual({ ok: true });

    // A DISABLE ALWAYS COMPLETES. The remedy for a plugin misbehaving on the way out must
    // never be that plugin, so the flag is written, the roster says so, and the failure is
    // reported as state rather than swallowed or obeyed.
    expect(host.assembly().enabled("test.alpha")).toBe(false);
    expect([...fixture.store.disabledPlugins()]).toEqual(["test.alpha"]);
    const entry = host.roster().find((row) => row.manifest.id === "test.alpha");
    expect(entry?.lifecycle).toBe("disable_failed");
    fixture.store.close();
  });

  test("a hook that never settles cannot hold the workspace hostage", async () => {
    const fixture = hostFixture();
    const log: HookLog = { calls: [] };
    // Never resolved, deliberately: the hook simply does not finish, which is the worst case
    // the bound exists for and the one a fixed sleep would only approximate.
    const stuck = Promise.withResolvers<void>();
    const host = customHost(
      fixture,
      [recorder("test.alpha", log, { lifecycle: { onEnable: () => stuck.promise } })],
      { lifecycleTimeoutMs: 5 },
    );
    await host.setEnabled("test.alpha", false, "admin");

    // Resolving at all IS the assertion: enablement is workspace-global, so a hook able to
    // stall it would let one plugin freeze every principal's assembly. The engine stops
    // WAITING at the bound; it cannot stop the hook, and pretending otherwise would be a lie.
    expect(await host.setEnabled("test.alpha", true, "admin")).toEqual({ ok: true });

    expect(host.assembly().enabled("test.alpha")).toBe(true);
    expect(host.roster().find((row) => row.manifest.id === "test.alpha")?.lifecycle).toBe(
      "enable_failed",
    );
    fixture.store.close();
  });

  test("a recovered hook clears the failure state on the next transition", async () => {
    const fixture = hostFixture();
    let failing = true;
    const host = customHost(fixture, [
      {
        manifest: {
          id: "test.flaky",
          version: "1.0.0",
          title: "Flaky",
          description: "Fails once, then behaves.",
          capabilities: [],
          contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        },
        actions: [],
        handlers: {},
        lifecycle: {
          onDisable: () => {
            if (!failing) return;
            failing = false;
            throw new Error("first attempt fails");
          },
        },
      },
    ]);

    await host.setEnabled("test.flaky", false, "admin");
    expect(host.roster().find((row) => row.manifest.id === "test.flaky")?.lifecycle).toBe(
      "disable_failed",
    );

    // The state describes the LAST attempt, not a permanent mark: it is in-memory runtime
    // knowledge about this process, not a durable judgement about the plugin.
    await host.setEnabled("test.flaky", true, "admin");
    await host.setEnabled("test.flaky", false, "admin");
    expect(
      host.roster().find((row) => row.manifest.id === "test.flaky")?.lifecycle,
    ).toBeUndefined();
    fixture.store.close();
  });
});

describe("PluginHost dependencies", () => {
  function pair(): readonly ServerPluginDef[] {
    const log: HookLog = { calls: [] };
    return [
      recorder("test.base", log),
      recorder(
        "test.leaf",
        log,
        {},
        { dependencies: { "test.base": { type: "required", reason: "reads its storage" } } },
      ),
      recorder("test.rival", log, {}, { dependencies: { "test.leaf": { type: "incompatible" } } }),
    ];
  }

  test("disabling a dependency is REFUSED and names the dependents", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, pair());
    await host.setEnabled("test.rival", false, "admin");

    const outcome = await host.setEnabled("test.base", false, "admin");

    // No disable cascade (ADR 0013 §5.4): in a workspace-global setting, a cascade is other
    // principals' panels and elements vanishing without their consent, while a refusal is one
    // round trip that says exactly what is in the way.
    expect(outcome).toEqual({ refused: "missing_dependency: test.leaf" });
    expect(host.assembly().enabled("test.base")).toBe(true);
    expect([...fixture.store.disabledPlugins()]).toEqual(["test.rival"]);
    fixture.store.close();
  });

  test("a dependency freed of its dependents can then be disabled", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, pair());
    await host.setEnabled("test.rival", false, "admin");

    expect(await host.setEnabled("test.leaf", false, "admin")).toEqual({ ok: true });
    expect(await host.setEnabled("test.base", false, "admin")).toEqual({ ok: true });

    // And the refusal is symmetric: the leaf cannot come back while its dependency is off.
    expect(await host.setEnabled("test.leaf", true, "admin")).toEqual({
      refused: "dependency_disabled: test.base",
    });
    expect(host.assembly().enabled("test.leaf")).toBe(false);
    fixture.store.close();
  });

  test("an incompatible peer refuses the enable, in whichever direction it was declared", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, pair());

    // Booted with both on (nothing structural forbids it), the refusal appears the moment
    // somebody tries to move a toggle — and the roster already says why.
    expect(await host.setEnabled("test.rival", false, "admin")).toEqual({ ok: true });
    expect(await host.setEnabled("test.rival", true, "admin")).toEqual({
      refused: "incompatible_dependency: test.leaf",
    });

    // The rival declared the incompatibility, but it binds both ways: nothing about "these
    // two must not run together" depends on which manifest said it.
    expect(await host.setEnabled("test.leaf", false, "admin")).toEqual({ ok: true });
    expect(await host.setEnabled("test.rival", true, "admin")).toEqual({ ok: true });
    expect(await host.setEnabled("test.leaf", true, "admin")).toEqual({
      refused: "incompatible_dependency: test.rival",
    });
    fixture.store.close();
  });
});

describe("PluginHost storage, migrations and purge", () => {
  const VERSIONED_ID = "test.versioned";

  function versioned(options: {
    readonly major: number;
    readonly minor: number;
    readonly withMigration: boolean;
    readonly onPurge?: () => void;
  }): readonly ServerPluginDef[] {
    return [
      {
        manifest: {
          id: VERSIONED_ID,
          version: "1.0.0",
          title: "Versioned",
          description: "Keeps durable data of its own.",
          capabilities: [],
          dataVersion: { major: options.major, minor: options.minor },
          contributes: {
            panels: [],
            sections: [],
            elements: [{ type: "versioned-thing", title: "Thing" }],
            tools: [],
            events: [],
          },
        },
        actions: [],
        handlers: {},
        ...(options.onPurge === undefined ? {} : { lifecycle: { onPurge: options.onPurge } }),
        ...(options.withMigration
          ? {
              migrations: [
                {
                  name: "0002-widen-rows",
                  to: { major: options.major, minor: 0 },
                  migrate: (storage) => {
                    const held = storage.get("row");
                    storage.set("row", `${held ?? ""}+migrated`);
                  },
                },
              ],
            }
          : {}),
      },
    ];
  }

  test("a plugin's storage is namespaced, and the engine's own keys are unforgeable", () => {
    const fixture = hostFixture();
    const mine = fixture.store.pluginStorage("test.alpha");
    const yours = fixture.store.pluginStorage("test.beta");

    mine.set("shared-key", "mine");
    yours.set("shared-key", "yours");

    // One substrate, two namespaces: a plugin cannot read another's rows even by guessing
    // its keys, which is what lets a purge erase exactly one plugin's data.
    expect(mine.get("shared-key")).toBe("mine");
    expect(yours.get("shared-key")).toBe("yours");
    expect(mine.keys()).toEqual(["shared-key"]);

    // Reserved keys are the engine's: a plugin that could write `$version` could claim its
    // data was already migrated and be believed.
    expect(() => mine.set("$version", "9.9")).toThrow(/reserved/);
    expect(() => mine.set("no spaces allowed", "x")).toThrow(/not a valid key/);
    mine.stampDataVersion({ major: 3, minor: 1 });
    expect(mine.dataVersion()).toEqual({ major: 3, minor: 1 });
    // ...and the stamp is not part of the key set the plugin iterates.
    expect(mine.keys()).toEqual(["shared-key"]);
    fixture.store.close();
  });

  test("a pending migration runs once, is ledgered by name, and stamps the version", () => {
    const fixture = hostFixture();
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    storage.set("row", "original");
    storage.stampDataVersion({ major: 1, minor: 0 });

    const host = customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));

    expect(storage.get("row")).toBe("original+migrated");
    expect(storage.appliedMigrations()).toEqual(["0002-widen-rows"]);
    expect(storage.dataVersion()).toEqual({ major: 2, minor: 0 });
    expect(host.assembly().pendingMigrations.size).toBe(0);

    // A second host over the same database is a restart: the ledger is what makes the
    // migration at-most-once, so the data must not be transformed twice.
    customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    expect(storage.get("row")).toBe("original+migrated");
    fixture.store.close();
  });

  test("stored data a plugin's code cannot read refuses the enable, and boot", async () => {
    const fixture = hostFixture();
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    storage.stampDataVersion({ major: 3, minor: 0 });

    // A DOWNGRADE. Old code cannot be trusted with newer data and no migration runs
    // backwards, so the honest answer is a refusal rather than a best-effort read.
    expect(() =>
      customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true })),
    ).toThrow(/data_downgrade|downgrade is refused/);

    // Disabled, the same data is simply RETAINED: it cannot hurt anyone, so assembly
    // proceeds and the refusal moves to the door, where an actor is present to be told.
    fixture.store.setPluginEnabled(VERSIONED_ID, false, "admin", 0);
    const host = customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    const outcome = await host.setEnabled(VERSIONED_ID, true, "admin");
    expect("refused" in outcome && outcome.refused.startsWith("data_downgrade")).toBe(true);
    expect(host.assembly().enabled(VERSIONED_ID)).toBe(false);
    fixture.store.close();
  });

  test("a major bump with no migration to bridge it refuses too", () => {
    const fixture = hostFixture();
    fixture.store.pluginStorage(VERSIONED_ID).stampDataVersion({ major: 1, minor: 4 });

    expect(() =>
      customHost(fixture, versioned({ major: 2, minor: 0, withMigration: false })),
    ).toThrow(/data_migration_missing|no unapplied migration/);

    // A MINOR difference is safe in both directions by the definition of minor, so the same
    // data at 1.4 composes cleanly against code declaring 1.9 — and against 1.0.
    expect(() =>
      customHost(fixture, versioned({ major: 1, minor: 9, withMigration: false })),
    ).not.toThrow();
    expect(() =>
      customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false })),
    ).not.toThrow();
    fixture.store.close();
  });

  test("purge is refused while the plugin is enabled, and for a builtin door", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false }));

    expect(await host.purge(VERSIONED_ID, "admin")).toEqual({
      refused: `still_enabled: ${VERSIONED_ID}`,
    });
    expect(await host.purge(ENGINE_PLUGINS_ID, "admin")).toEqual({
      refused: `builtin: ${ENGINE_PLUGINS_ID}`,
    });
    expect(await host.purge("test.ghost", "admin")).toEqual({
      refused: "unknown_plugin: test.ghost",
    });
    fixture.store.close();
  });

  test("purge erases the disabled plugin's data, releases its element type, and reports both", async () => {
    const fixture = hostFixture();
    const purged: string[] = [];
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    const host = customHost(
      fixture,
      versioned({
        major: 1,
        minor: 0,
        withMigration: false,
        onPurge: () => {
          purged.push("hook");
        },
      }),
    );
    storage.set("row", "keep me");
    expect(fixture.store.elementOwners().get("versioned-thing")).toBe(VERSIONED_ID);

    await host.setEnabled(VERSIONED_ID, false, "admin");
    const outcome = await host.purge(VERSIONED_ID, "admin");

    // A disable RETAINS (there is no erase-on-disable); purge is the separate, explicitly
    // named verb that destroys, and the plugin is told through `onPurge` before its rows go.
    expect(purged).toEqual(["hook"]);
    expect(outcome).toEqual({
      id: VERSIONED_ID,
      removed: { storage: 2, elements: 1, ownership: 1 },
    });
    expect(storage.get("row")).toBeNull();
    expect(storage.dataVersion()).toBeNull();
    // The reservation is released, so a replacement may now claim the type DELIBERATELY —
    // which is exactly the squat that assembly refuses while the reservation stands.
    expect(fixture.store.elementOwners().has("versioned-thing")).toBe(false);
    fixture.store.close();
  });

  test("purge is reachable through the engine door, with plugins:manage", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false }));
    await host.setEnabled(VERSIONED_ID, false, "admin");
    const writer = context(fixture, ["containers:read", "containers:write"]);

    const refusedByCaps = await host.dispatch(writer, ENGINE_PURGE_ACTION, { id: VERSIONED_ID });
    expect(denial(refusedByCaps)).toEqual({
      rule: "forbidden",
      message: "plugins:manage capability required",
    });

    const outcome = await host.dispatch(fixture.owner, ENGINE_PURGE_ACTION, { id: VERSIONED_ID });
    expect(outcome).toEqual({
      ok: true,
      // One row: the data-version stamp the engine wrote when the plugin started serving.
      result: { id: VERSIONED_ID, removed: { storage: 1, elements: 1, ownership: 1 } },
    });
    fixture.store.close();
  });
});

/**
 * RUNG 3, NARROWED — `scope: "container"`.
 *
 * The wave-1 rule stands for every workspace-grade door: a token scoped to one container
 * cannot authorize a workspace mutation. What an action may now do is DECLARE that its whole
 * effect is confined to one container, which lets a container-scoped caller through — with the
 * container taken from the TOKEN, the caps evaluated there, and the handler contractually bound
 * to honour it. These cases pin all three, plus the fact that nothing widened: the rung below
 * still runs, and an undeclared action still refuses.
 */
describe("PluginHost action scope", () => {
  const SCOPED_ID = "test.scoped";

  function scopedDefs(seen: {
    containerScope: string | null | undefined;
  }): readonly ServerPluginDef[] {
    return [
      {
        manifest: {
          id: SCOPED_ID,
          version: "1.0.0",
          title: "Scoped",
          description: "One door graded for a container, one for the workspace.",
          capabilities: ["containers:read", "containers:write"],
          contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        },
        actions: [
          defineAction({
            name: "read",
            title: "Read inside one container",
            caps: ["containers:read"],
            scope: "container",
            input: z.strictObject({}),
            result: z.strictObject({ containerScope: z.string().nullable() }),
          }),
          defineAction({
            name: "sweep",
            title: "Touch the whole workspace",
            caps: ["containers:read"],
            input: z.strictObject({}),
            result: z.strictObject({}),
          }),
          defineAction({
            name: "write",
            title: "Write inside one container",
            caps: ["containers:write"],
            scope: "container",
            input: z.strictObject({}),
            result: z.strictObject({ containerScope: z.string().nullable() }),
          }),
        ],
        handlers: {
          read: async (ctx: { containerScope: string | null }) => {
            // A handler declaring `containerScope` as its WHOLE slice: the scope is a
            // first-class part of the context precisely so this is the natural way to read it.
            seen.containerScope = ctx.containerScope;
            return { containerScope: ctx.containerScope };
          },
          sweep: async () => ({}),
          write: async (ctx: { containerScope: string | null }) => ({
            containerScope: ctx.containerScope,
          }),
        },
      },
    ];
  }

  function scopedFixture(): {
    readonly fixture: HostFixture;
    readonly host: PluginHost;
    readonly container: string;
    readonly seen: { containerScope: string | null | undefined };
  } {
    const fixture = hostFixture();
    const seen: { containerScope: string | null | undefined } = { containerScope: undefined };
    const container = fixture.runtime.newId();
    fixture.store.createContainer({
      id: container,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    return { fixture, host: customHost(fixture, scopedDefs(seen)), container, seen };
  }

  test("a container-scoped token reaches a container-scoped action, and the handler is told which container", async () => {
    const { fixture, host, container, seen } = scopedFixture();
    const scoped = context(fixture, ["containers:read"], container);

    const outcome = await host.dispatch(scoped, `${SCOPED_ID}.read`, {});

    // The container comes from the TOKEN, never from the arguments — authority that read
    // arguments would force the ladder to validate shape before authority, and a caller would
    // learn a door's schema by knocking on one it may not open.
    expect(outcome).toEqual({ ok: true, result: { containerScope: container } });
    expect(seen.containerScope).toBe(container);
    fixture.store.close();
  });

  test("the same token is still refused every action that did not declare itself confined", async () => {
    const { fixture, host, container, seen } = scopedFixture();
    const scoped = context(fixture, ["containers:read"], container);

    const outcome = await host.dispatch(scoped, `${SCOPED_ID}.sweep`, {});

    // Nothing widened: the default is workspace-grade, so an action that says nothing keeps
    // the wave-1 refusal verbatim — message included, because clients switch on it.
    expect(denial(outcome)).toEqual({
      rule: "forbidden",
      message: "scoped tokens cannot invoke workspace actions",
    });
    expect(seen.containerScope).toBeUndefined();
    fixture.store.close();
  });

  test("a workspace-grade caller reaches the container-scoped action with no scope at all", async () => {
    const { fixture, host, seen } = scopedFixture();

    const outcome = await host.dispatch(fixture.owner, `${SCOPED_ID}.read`, {});

    // `scope: "container"` is about what the door PROMISES, not about who may open it: an
    // unscoped principal gets `containerScope: null` and the handler resolves its target the
    // way it always did (for terminals, the terminal row's own container).
    expect(outcome).toEqual({ ok: true, result: { containerScope: null } });
    expect(seen.containerScope).toBeNull();
    fixture.store.close();
  });

  test("the cap rung still runs for a scoped caller, and runs AT its container", async () => {
    const { fixture, host, container } = scopedFixture();
    const reader = context(fixture, ["containers:read"], container);

    // Holding `containers:read` at this container is not authority to write in it: the scope
    // rung let the caller reach rung 4, and rung 4 refused — which is why declaring a container
    // scope narrows the refusal without ever widening authority.
    expect(denial(await host.dispatch(reader, `${SCOPED_ID}.write`, {}))).toEqual({
      rule: "forbidden",
      message: "containers:write capability required",
    });

    // And a token scoped to a DIFFERENT container, holding the cap, is evaluated at its own
    // scope: it passes the rung and the handler is handed that container, which is exactly the
    // value it is obliged to constrain itself to.
    const other = fixture.runtime.newId();
    fixture.store.createContainer({
      id: other,
      name: "other",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    const writer = context(fixture, ["containers:read", "containers:write"], other);
    expect(await host.dispatch(writer, `${SCOPED_ID}.write`, {})).toEqual({
      ok: true,
      result: { containerScope: other },
    });
    fixture.store.close();
  });

  test("the ladder order is unchanged: scope refuses before arguments are looked at", async () => {
    const { fixture, host, container } = scopedFixture();
    const scoped = context(fixture, ["containers:read"], container);

    // Deliberately malformed args at a workspace-grade door. If the new rung had moved below
    // validation — as it would have to if the container came from the arguments — this would
    // answer `invalid_args` and leak the door's schema to a caller who may not open it.
    const outcome = await host.dispatch(scoped, `${SCOPED_ID}.sweep`, { surplus: true });

    expect(denial(outcome).rule).toBe("forbidden");
    fixture.store.close();
  });
});

describe("ctx.outsideScope", () => {
  const GUARD_ID = "test.guard";

  /** A door whose argument names a container, discharging containment through the shared helper. */
  function guardDefs(): readonly ServerPluginDef[] {
    return [
      {
        manifest: {
          id: GUARD_ID,
          version: "1.0.0",
          title: "Guard",
          description:
            "Names a container in its arguments and must stay inside the caller's scope.",
          capabilities: ["containers:read"],
          contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        },
        actions: [
          defineAction({
            name: "touch",
            title: "Touch a named container",
            caps: ["containers:read"],
            scope: "container",
            input: z.strictObject({ containerId: z.string() }),
            result: z.strictObject({ touched: z.string() }),
          }),
        ],
        handlers: {
          touch: async (
            ctx: { outsideScope(containerId: string | null): { readonly refused: string } | null },
            args: { containerId: string },
          ) => {
            const denial = ctx.outsideScope(args.containerId);
            if (denial !== null) return denial;
            return { touched: args.containerId };
          },
        },
      },
    ];
  }

  test("a scoped caller reaching another container is refused with the one canonical wording", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, guardDefs());
    const mine = fixture.runtime.newId();
    const theirs = fixture.runtime.newId();
    for (const id of [mine, theirs]) {
      fixture.store.createContainer({
        id,
        name: id,
        createdAt: fixture.runtime.now(),
        discipline: "canvas",
      });
    }
    const scoped = context(fixture, ["containers:read"], mine);

    // THE GAP THE RUNG CANNOT CLOSE: this caller's caps genuinely hold at its own container, so
    // rung 4 passed it. Only the handler knows the argument names a different container —
    // which is why the obligation exists, and why it gets ONE wording rather than one per
    // plugin for a client to guess between.
    expect(
      denial(await host.dispatch(scoped, `${GUARD_ID}.touch`, { containerId: theirs })),
    ).toEqual({
      rule: "refused",
      message: OUTSIDE_SCOPE_REFUSAL,
    });
    // The message names no container: telling a scoped caller the id of one it may not reach
    // is a disclosure the refusal does not need.
    expect(OUTSIDE_SCOPE_REFUSAL).not.toContain(theirs);

    // Its own container passes, and a workspace-grade caller is confined by nothing.
    expect(await host.dispatch(scoped, `${GUARD_ID}.touch`, { containerId: mine })).toEqual({
      ok: true,
      result: { touched: mine },
    });
    expect(
      await host.dispatch(fixture.owner, `${GUARD_ID}.touch`, { containerId: theirs }),
    ).toEqual({
      ok: true,
      result: { touched: theirs },
    });
    fixture.store.close();
  });

  test("an unresolvable container is refused for a scoped caller and allowed for a workspace one", async () => {
    const fixture = hostFixture();
    const host = customHost(fixture, guardDefs());
    const container = fixture.runtime.newId();
    fixture.store.createContainer({
      id: container,
      name: "mine",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    const scoped = context(fixture, ["containers:read"], container);

    // A handler that could not resolve a container for the thing it was asked about passes
    // null. For a scoped caller that is a refusal — authority cannot be proven against a
    // container nobody named — and for an unscoped one there was never anything to confine.
    expect(host.assembly().actions.has(`${GUARD_ID}.touch`)).toBe(true);
    const scopedCtx = await host.dispatch(scoped, `${GUARD_ID}.touch`, { containerId: "" });
    expect(denial(scopedCtx).message).toBe(OUTSIDE_SCOPE_REFUSAL);
    expect(await host.dispatch(fixture.owner, `${GUARD_ID}.touch`, { containerId: "" })).toEqual({
      ok: true,
      result: { touched: "" },
    });
    fixture.store.close();
  });
});
