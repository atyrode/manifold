import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_INSTALL_ACTION,
  ENGINE_PLUGINS_ID,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_UNINSTALL_ACTION,
  MAX_STORAGE_VALUE_BYTES,
  PluginStorageError,
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
import {
  IsolateDenial,
  IsolateLoadError,
  type InstalledPluginRef,
  type IsolateLoadResult,
  type IsolateRunner,
  type IsolateState,
} from "../src/isolate/contract.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import {
  OUTSIDE_SCOPE_REFUSAL,
  PluginHost,
  type IsolateDeps,
  type MachineAdmission,
  type ServerPluginDef,
} from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, sha256Hex, type ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  testEventHub,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

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
const OFFLINE_MACHINES: MachineAdmission = {
  isOnline: () => false,
  drain: () =>
    Promise.resolve({ ok: false, reason: "machine is offline: its terminals are unknown" }),
};

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
    assemblyPlacementVocabulary(() => []),
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

async function hostFixture(): Promise<HostFixture> {
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
  return {
    store,
    auth,
    owner,
    host: await testPluginHost(store, auth, rooms, broker, runtime),
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
    const fixture = await hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.nope.doIt", {});

    expect(denial(outcome)).toEqual({
      rule: "unknown_action",
      message: 'unknown action "core.nope.doIt"',
    });
    fixture.store.close();
  });

  test("a disabled plugin's action is disabled, not unknown", async () => {
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "s1",
    });

    expect(denial(outcome).rule).toBe("invalid_args");
    expect(denial(outcome).message).toContain("name");
    fixture.store.close();
  });

  test("a handler's own refusal is the last rung and carries its message", async () => {
    const fixture = await hostFixture();

    const outcome = await fixture.host.dispatch(fixture.owner, "core.terminals.rename", {
      terminalId: "missing",
      name: "build",
    });

    expect(denial(outcome)).toEqual({ rule: "refused", message: "terminal not found" });
    fixture.store.close();
  });

  test("an unparseable name refuses before an all-whitespace one, both as refusals", async () => {
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();

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
    const fixture = await hostFixture();
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

  async function brokenHost(fixture: HostFixture): Promise<PluginHost> {
    return customHost(fixture, BROKEN);
  }

  test("a result that fails its published schema THROWS instead of denying", async () => {
    const fixture = await hostFixture();
    const host = await brokenHost(fixture);

    // Were this a `refused`, a caller would retry forever against a door that can never
    // succeed, and the published JSON Schema would be a lie nobody notices.
    await expect(host.dispatch(fixture.owner, "test.doors.liar", {})).rejects.toThrow();
    fixture.store.close();
  });

  test("a composed action with no handler THROWS: that is a wiring bug, not a refusal", async () => {
    const fixture = await hostFixture();
    const host = await brokenHost(fixture);

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
    const fixture = await hostFixture();
    const host = await brokenHost(fixture);

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

async function customHost(
  fixture: HostFixture,
  defs: readonly ServerPluginDef[],
  options: {
    readonly lifecycleTimeoutMs?: number;
    readonly distribution?: ReadonlySet<string>;
    readonly isolates?: IsolateDeps;
  } = {},
): Promise<PluginHost> {
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
  host = await PluginHost.boot(
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
  test("a manifest under core. that the distribution never registered is refused by name", async () => {
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };

    await expect(
      customHost(fixture, [recorder("core.impostor", log)], { distribution: SHIPPED_PLUGIN_IDS }),
    ).rejects.toThrow(/claims the reserved "core\." namespace/);

    // A stranger's own namespace is their business: the reservation defends authorship, not
    // membership of the roster.
    await customHost(fixture, [recorder("vendor.impostor", log)], {
      distribution: SHIPPED_PLUGIN_IDS,
    });
    fixture.store.close();
  });

  test("the distribution's own seats compose through the real wiring", async () => {
    const fixture = await hostFixture();
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
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };
    const host = await customHost(fixture, [recorder("test.alpha", log)]);

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
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };
    const host = await customHost(fixture, [
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
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };
    const host = await customHost(fixture, [
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
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };
    // Never resolved, deliberately: the hook simply does not finish, which is the worst case
    // the bound exists for and the one a fixed sleep would only approximate.
    const stuck = Promise.withResolvers<void>();
    const host = await customHost(
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
    const fixture = await hostFixture();
    let failing = true;
    const host = await customHost(fixture, [
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
    const fixture = await hostFixture();
    const host = await customHost(fixture, pair());
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
    const fixture = await hostFixture();
    const host = await customHost(fixture, pair());
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
    const fixture = await hostFixture();
    const host = await customHost(fixture, pair());

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
                  migrate: async (storage) => {
                    const held = await storage.get("row");
                    await storage.set("row", `${held ?? ""}+migrated`);
                  },
                },
              ],
            }
          : {}),
      },
    ];
  }

  test("a plugin's storage is namespaced, and the engine's own keys are unforgeable", async () => {
    const fixture = await hostFixture();
    const mine = fixture.store.pluginStorage("test.alpha");
    const yours = fixture.store.pluginStorage("test.beta");

    await mine.set("shared-key", "mine");
    await yours.set("shared-key", "yours");

    // One substrate, two namespaces: a plugin cannot read another's rows even by guessing
    // its keys, which is what lets a purge erase exactly one plugin's data.
    expect(await mine.get("shared-key")).toBe("mine");
    expect(await yours.get("shared-key")).toBe("yours");
    expect(await mine.keys()).toEqual(["shared-key"]);

    // Reserved keys are the engine's: a plugin that could write `$version` could claim its
    // data was already migrated and be believed.
    await expect(mine.set("$version", "9.9")).rejects.toThrow(/reserved/);
    await mine.stampDataVersion({ major: 3, minor: 1 });
    expect(await mine.dataVersion()).toEqual({ major: 3, minor: 1 });
    // ...and the stamp is not part of the key set the plugin iterates.
    expect(await mine.keys()).toEqual(["shared-key"]);
    fixture.store.close();
  });

  test("a refused key or value REJECTS the promise; nothing throws before it exists", async () => {
    const fixture = await hostFixture();
    const mine = fixture.store.pluginStorage("test.alpha");

    /*
      ONE FAILURE PATH (ADR 0016 §4). A handler that awaits storage served over an RPC can
      only ever see a rejection, so the in-realm handle must answer the same way: were these
      to throw synchronously, the two assignments below would throw before `expect` ran, and
      a `try`/`catch` written against one implementation would miss on the other.
    */
    const badKey = mine.set("no spaces allowed", "x");
    const oversize = mine.set("blob", "x".repeat(MAX_STORAGE_VALUE_BYTES + 1));
    await expect(badKey).rejects.toBeInstanceOf(PluginStorageError);
    await expect(oversize).rejects.toThrow(/over the .*-byte limit/);
    expect(await mine.keys()).toEqual([]);
    fixture.store.close();
  });

  test("a pending migration runs once, is ledgered by name, and stamps the version", async () => {
    const fixture = await hostFixture();
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    await storage.set("row", "original");
    await storage.stampDataVersion({ major: 1, minor: 0 });

    const host = await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));

    expect(await storage.get("row")).toBe("original+migrated");
    expect(await storage.appliedMigrations()).toEqual(["0002-widen-rows"]);
    expect(await storage.dataVersion()).toEqual({ major: 2, minor: 0 });
    expect(host.assembly().pendingMigrations.size).toBe(0);

    // A second host over the same database is a restart: the ledger is what makes the
    // migration at-most-once, so the data must not be transformed twice.
    await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    expect(await storage.get("row")).toBe("original+migrated");
    fixture.store.close();
  });

  test("stored data a plugin's code cannot read refuses the enable, and boot", async () => {
    const fixture = await hostFixture();
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    await storage.stampDataVersion({ major: 3, minor: 0 });

    // A DOWNGRADE. Old code cannot be trusted with newer data and no migration runs
    // backwards, so the honest answer is a refusal rather than a best-effort read.
    await expect(
      customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true })),
    ).rejects.toThrow(/data_downgrade|downgrade is refused/);

    // Disabled, the same data is simply RETAINED: it cannot hurt anyone, so assembly
    // proceeds and the refusal moves to the door, where an actor is present to be told.
    fixture.store.setPluginEnabled(VERSIONED_ID, false, "admin", 0);
    const host = await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    const outcome = await host.setEnabled(VERSIONED_ID, true, "admin");
    expect("refused" in outcome && outcome.refused.startsWith("data_downgrade")).toBe(true);
    expect(host.assembly().enabled(VERSIONED_ID)).toBe(false);
    fixture.store.close();
  });

  test("a major bump with no migration to bridge it refuses too", async () => {
    const fixture = await hostFixture();
    await fixture.store.pluginStorage(VERSIONED_ID).stampDataVersion({ major: 1, minor: 4 });

    await expect(
      customHost(fixture, versioned({ major: 2, minor: 0, withMigration: false })),
    ).rejects.toThrow(/data_migration_missing|no unapplied migration/);

    // A MINOR difference is safe in both directions by the definition of minor, so the same
    // data at 1.4 composes cleanly against code declaring 1.9 — and against 1.0.
    await customHost(fixture, versioned({ major: 1, minor: 9, withMigration: false }));
    await customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false }));
    fixture.store.close();
  });

  test("purge is refused while the plugin is enabled, and for a builtin door", async () => {
    const fixture = await hostFixture();
    const host = await customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false }));

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
    const fixture = await hostFixture();
    const purged: string[] = [];
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    const host = await customHost(
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
    await storage.set("row", "keep me");
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
    expect(await storage.get("row")).toBeNull();
    expect(await storage.dataVersion()).toBeNull();
    // The reservation is released, so a replacement may now claim the type DELIBERATELY —
    // which is exactly the squat that assembly refuses while the reservation stands.
    expect(fixture.store.elementOwners().has("versioned-thing")).toBe(false);
    fixture.store.close();
  });

  test("purge is reachable through the engine door, with plugins:manage", async () => {
    const fixture = await hostFixture();
    const host = await customHost(fixture, versioned({ major: 1, minor: 0, withMigration: false }));
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

  async function scopedFixture(): Promise<{
    readonly fixture: HostFixture;
    readonly host: PluginHost;
    readonly container: string;
    readonly seen: { containerScope: string | null | undefined };
  }> {
    const fixture = await hostFixture();
    const seen: { containerScope: string | null | undefined } = { containerScope: undefined };
    const container = fixture.runtime.newId();
    fixture.store.createContainer({
      id: container,
      name: "scoped",
      createdAt: fixture.runtime.now(),
      discipline: "canvas",
    });
    return { fixture, host: await customHost(fixture, scopedDefs(seen)), container, seen };
  }

  test("a container-scoped token reaches a container-scoped action, and the handler is told which container", async () => {
    const { fixture, host, container, seen } = await scopedFixture();
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
    const { fixture, host, container, seen } = await scopedFixture();
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
    const { fixture, host, seen } = await scopedFixture();

    const outcome = await host.dispatch(fixture.owner, `${SCOPED_ID}.read`, {});

    // `scope: "container"` is about what the door PROMISES, not about who may open it: an
    // unscoped principal gets `containerScope: null` and the handler resolves its target the
    // way it always did (for terminals, the terminal row's own container).
    expect(outcome).toEqual({ ok: true, result: { containerScope: null } });
    expect(seen.containerScope).toBeNull();
    fixture.store.close();
  });

  test("the cap rung still runs for a scoped caller, and runs AT its container", async () => {
    const { fixture, host, container } = await scopedFixture();
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
    const { fixture, host, container } = await scopedFixture();
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
    const fixture = await hostFixture();
    const host = await customHost(fixture, guardDefs());
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
    const fixture = await hostFixture();
    const host = await customHost(fixture, guardDefs());
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

/**
 * THE INSTALL DOORS (ADR 0016 §8 stage 2), against a runner with no process behind it: the
 * host's verdicts — consent, grant, rollback, boot re-verification, the child's own rungs — are
 * what these cases defend, and none of them needs a child to be true.
 */

/**
 * A runner that answers `load` from a table and records every call, and lets a case push a
 * state the way a supervisor would when a child spawns or crashes.
 */
class FakeRunner implements IsolateRunner {
  readonly loads: string[] = [];
  readonly unloads: string[] = [];
  private readonly states = new Map<string, IsolateState>();
  private readonly listeners = new Set<
    (pluginId: string, state: IsolateState, detail?: string) => void
  >();

  constructor(private readonly serve: (ref: InstalledPluginRef) => IsolateLoadResult) {}

  async load(ref: InstalledPluginRef): Promise<IsolateLoadResult> {
    this.loads.push(ref.pluginId);
    const result = this.serve(ref);
    this.states.set(ref.pluginId, "running");
    return result;
  }

  async unload(pluginId: string): Promise<void> {
    this.unloads.push(pluginId);
    this.states.set(pluginId, "stopped");
  }

  state(pluginId: string): IsolateState {
    return this.states.get(pluginId) ?? "stopped";
  }

  onState(listener: (pluginId: string, state: IsolateState, detail?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  report(pluginId: string, state: IsolateState): void {
    this.states.set(pluginId, state);
    for (const listener of this.listeners) listener(pluginId, state);
  }

  async close(): Promise<void> {}
}

const SAMPLE_ID = "vendor.sample";

const SAMPLE_MANIFEST: PluginManifest = {
  id: SAMPLE_ID,
  version: "1.2.3",
  title: "Sample",
  description: "an installed sample",
  capabilities: ["containers:read", "tokens:mint", "plugins:manage"],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true, web: "web.js" },
};

/** What the child would announce for the sample: one ordinary door, one needing a withheld cap. */
function sampleLoad(
  ref: InstalledPluginRef,
  handlers: Readonly<Record<string, (ctx: unknown, args: unknown) => Promise<unknown>>> = {},
  hooks: HookLog = { calls: [] },
): IsolateLoadResult {
  return {
    def: {
      manifest: ref.manifest,
      actions: [
        defineAction({
          name: "ping",
          title: "Ping",
          caps: ["containers:read"],
          input: z.unknown(),
          result: z.unknown(),
        }),
        defineAction({
          name: "mint",
          title: "Mint",
          caps: ["tokens:mint"],
          input: z.unknown(),
          result: z.unknown(),
        }),
      ],
      handlers: {
        ping: async () => ({ pong: true }),
        mint: async () => ({ minted: true }),
        ...handlers,
      },
    },
    lifecycle: {
      onEnable: (ctx) => {
        hooks.calls.push(`enable:${ctx.pluginId}`);
      },
    },
  };
}

interface InstallFixture extends HostFixture {
  readonly dataDir: string;
  readonly runner: FakeRunner;
  readonly isolates: IsolateDeps;
  /** Writes a hardened-runner bundle into the uploads box. */
  drop(
    manifest?: PluginManifest,
    files?: Record<string, string>,
  ): { source: string; sha256: string; hardened: true };
}

async function installFixture(
  serve: (ref: InstalledPluginRef) => IsolateLoadResult = (ref) => sampleLoad(ref),
): Promise<InstallFixture> {
  const base = await hostFixture();
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-install-door-"));
  mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
  const runner = new FakeRunner(serve);
  let dropped = 0;
  return {
    ...base,
    dataDir,
    runner,
    isolates: { runner, dataDir },
    drop(
      manifest = SAMPLE_MANIFEST,
      files = { "server.js": "export {};", "web.js": "export const web = 1;" },
    ) {
      const bytes = Buffer.from(
        JSON.stringify({
          format: 1,
          manifest,
          files: Object.fromEntries(
            Object.entries(files).map(([name, text]) => [
              name,
              Buffer.from(text).toString("base64"),
            ]),
          ),
        }),
      );
      dropped += 1;
      const source = join(
        dataDir,
        PLUGIN_UPLOADS_DIR,
        `drop-${String(dropped)}.manifold-plugin.json`,
      );
      writeFileSync(source, bytes);
      return { source, sha256: sha256Hex(bytes), hardened: true };
    },
  };
}

function installedRow(host: PluginHost, id: string): PluginRoster[number] {
  const row = host.roster().find((entry) => entry.manifest.id === id);
  if (row === undefined) throw new Error(`${id} is not on the roster`);
  return row;
}

describe("PluginHost install doors", () => {
  test("in-realm installs use the full context and reload only after disable and enable", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop(SAMPLE_MANIFEST, {
      "server.js": `
        import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
        const { defineAction } = globalThis[Symbol.for("manifold.shared")]["@manifold/plugin"];
        let calls = 0;
        export default {
          actions: [defineAction({
            name: "ping", title: "Ping", caps: ["containers:read"],
            input: z.strictObject({}), result: z.unknown(),
          })],
          handlers: {
            async ping(ctx) {
              return {
                calls: ++calls,
                owner: ctx.store.pluginInstalls()[0].installedBy,
                principal: ctx.principal.id,
              };
            },
          },
        };
      `,
      "web.js": "export {};",
    });
    expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, { source, sha256 })).ok).toBe(
      true,
    );
    const result = (calls: number): ActionOutcome => ({
      ok: true,
      result: { calls, owner: fixture.owner.principal.id, principal: fixture.owner.principal.id },
    });
    expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual(result(1));
    expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual(result(2));
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(denial(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).rule).toBe(
      "plugin_disabled",
    );
    expect(await host.setEnabled(SAMPLE_ID, true, "admin")).toEqual({ ok: true });
    expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual(result(1));
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(await host.uninstall(SAMPLE_ID, "admin", false)).toEqual({ ok: true });
    expect(denial(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).rule).toBe(
      "unknown_action",
    );
    fixture.store.close();
  });

  test("install lands a plugin row carrying the installer's consent, high-risk caps withheld", async () => {
    const hooks: HookLog = { calls: [] };
    const fixture = await installFixture((ref) => sampleLoad(ref, {}, hooks));
    const host = await customHost(fixture, [], {
      distribution: SHIPPED_PLUGIN_IDS,
      isolates: fixture.isolates,
    });
    const published: PluginRoster[] = [];
    host.onRosterChange((roster) => {
      published.push(roster);
    });
    const { source, sha256 } = fixture.drop();

    // Root only: a manager token switches shipped rows, it does not admit a stranger's code.
    const manager = context(fixture, ["plugins:manage"]);
    expect(
      denial(
        await host.dispatch(manager, ENGINE_INSTALL_ACTION, { source, sha256, hardened: true }),
      ),
    ).toEqual({
      rule: "forbidden",
      message: "* capability required",
    });

    expect(
      await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, { source, sha256, hardened: true }),
    ).toEqual({
      ok: true,
      result: { id: SAMPLE_ID, version: "1.2.3", grantedCaps: ["containers:read"] },
    });
    const row = installedRow(host, SAMPLE_ID);
    expect(row.source).toBe("plugin");
    expect(row.enabled).toBe(true);
    expect(row.install).toEqual({
      sha256,
      source,
      grantedCaps: ["containers:read"],
      installedBy: fixture.owner.principal.id,
      installedAt: fixture.runtime.now(),
      hardened: true,
    });
    expect(row.actions.map((action) => action.name)).toEqual([
      `${SAMPLE_ID}.ping`,
      `${SAMPLE_ID}.mint`,
    ]);
    expect(fixture.runner.loads).toEqual([SAMPLE_ID]);
    expect(fixture.store.pluginInstalls().map((stored) => stored.pluginId)).toEqual([SAMPLE_ID]);
    // An install of an enabled row IS an enable: the hook fires and the roster is pushed.
    expect(hooks.calls).toEqual([`enable:${SAMPLE_ID}`]);
    expect(published).toHaveLength(1);
    expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
      ok: true,
      result: { pong: true },
    });
    expect(host.webModule(SAMPLE_ID)).toEqual({
      sha256,
      bytes: Buffer.from("export const web = 1;"),
    });
    fixture.store.close();
  });

  test("grant widens the default explicitly, restricted to the manifest's own ceiling", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    const outcome = await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
      source,
      sha256,
      grant: ["tokens:mint", "scenes:write"],
      hardened: true,
    });
    expect(outcome).toEqual({
      ok: true,
      result: { id: SAMPLE_ID, version: "1.2.3", grantedCaps: ["containers:read", "tokens:mint"] },
    });
    fixture.store.close();
  });

  test("a door needing a cap the installer withheld is forbidden naming the plugin, before the caller", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    // Root holds every cap; the refusal is the PLUGIN's grant, and the message says so.
    expect(denial(await host.dispatch(fixture.owner, `${SAMPLE_ID}.mint`, {}))).toEqual({
      rule: "forbidden",
      message: `tokens:mint not granted to plugin ${SAMPLE_ID}`,
    });
    const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
    expect(trace?.door).toBe(`${SAMPLE_ID}.mint`);
    expect(trace?.outcome).toBe("forbidden");
    fixture.store.close();
  });

  test("uninstall refuses a running row, then a row with data; purge: true purges first and removes everything", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    const stored = fixture.store.pluginInstalls()[0];
    if (stored === undefined) throw new Error("no install row");
    await fixture.store.pluginStorage(SAMPLE_ID).set("kept", "yes");

    const running = await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID });
    expect(denial(running).rule).toBe("refused");
    expect(denial(running).message).toMatch(/^still_enabled: /);

    // Off, with data: the door names the count and the two ways out (#233). Nothing moved.
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    const retained = await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID });
    expect(denial(retained)).toEqual({
      rule: "refused",
      message: "storage_retained: 1 keys; purge first or pass purge: true",
    });
    expect(fixture.store.pluginInstalls().map((row) => row.pluginId)).toEqual([SAMPLE_ID]);
    expect(existsSync(stored.bundlePath)).toBe(true);
    expect(await fixture.store.pluginStorage(SAMPLE_ID).get("kept")).toBe("yes");

    // Consent to destroy: the purge verb runs first — its own event, on the engine's node —
    // and the uninstall follows, so no row is ever left with data no door can reach.
    expect(
      await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID, purge: true }),
    ).toEqual({ ok: true, result: {} });
    expect(fixture.store.listEvents({ type: "plugin_purged", limit: 10 })).toHaveLength(1);
    expect(fixture.store.listEvents({ type: "plugin_uninstalled", limit: 10 })).toHaveLength(1);
    expect(await fixture.store.pluginStorage(SAMPLE_ID).count()).toBe(0);
    expect(host.roster().some((entry) => entry.manifest.id === SAMPLE_ID)).toBe(false);
    expect(fixture.store.pluginInstalls()).toEqual([]);
    expect(existsSync(stored.bundlePath)).toBe(false);
    expect(fixture.runner.unloads).toEqual([SAMPLE_ID]);
    expect(
      denial(await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID }))
        .message,
    ).toMatch(/^not_installed: /);
    fixture.store.close();
  });

  test("uninstall forgets the switch: a reinstall of the same id is on, like a first install", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(installedRow(host, SAMPLE_ID).changedBy).toBe("admin");
    // Nothing stored, so the plain door goes through — and takes the OFF with it.
    expect(await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID })).toEqual({
      ok: true,
      result: {},
    });
    expect(fixture.store.disabledPlugins().has(SAMPLE_ID)).toBe(false);

    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    const row = installedRow(host, SAMPLE_ID);
    expect(row.enabled).toBe(true);
    expect(row.changedBy).toBeUndefined();
    expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
      ok: true,
      result: { pong: true },
    });
    fixture.store.close();
  });

  test("a bundle claiming engine. or core. is refused by namespace and writes nothing", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], {
      distribution: SHIPPED_PLUGIN_IDS,
      isolates: fixture.isolates,
    });
    const squat = fixture.drop({ ...SAMPLE_MANIFEST, id: "core.impostor" });
    const outcome = await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, squat);
    expect(denial(outcome).message).toMatch(/^namespace_reserved: "core\.impostor"/);
    expect(fixture.runner.loads).toEqual([]);
    expect(fixture.store.pluginInstalls()).toEqual([]);
    expect(existsSync(join(fixture.dataDir, "plugins"))).toBe(false);
    fixture.store.close();
  });

  test("a second install of an id is already_installed; replace needs the row off, then upgrades", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const first = fixture.drop();
    expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, first)).ok).toBe(true);
    const firstRow = fixture.store.pluginInstalls()[0];
    const second = fixture.drop({ ...SAMPLE_MANIFEST, version: "2.0.0" });

    expect(
      denial(await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, second)).message,
    ).toMatch(/^already_installed: /);
    expect(
      denial(
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          ...second,
          replace: true,
          hardened: true,
        }),
      ).message,
    ).toMatch(/^still_enabled: /);

    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(
      await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
        ...second,
        replace: true,
        hardened: true,
      }),
    ).toEqual({
      ok: true,
      result: { id: SAMPLE_ID, version: "2.0.0", grantedCaps: ["containers:read"] },
    });
    const row = installedRow(host, SAMPLE_ID);
    expect(row.manifest.version).toBe("2.0.0");
    expect(row.install?.sha256).toBe(second.sha256);
    // The row stays off — a replace is not an enable — and the old artifact is gone.
    expect(row.enabled).toBe(false);
    expect(existsSync(firstRow?.bundlePath ?? "")).toBe(false);
    expect(fixture.runner.unloads).toEqual([SAMPLE_ID]);
    expect(fixture.runner.loads).toEqual([SAMPLE_ID, SAMPLE_ID]);
    fixture.store.close();
  });

  test("an assembly refusal at install time rolls back and answers artifact_invalid", async () => {
    const fixture = await installFixture();
    const log: HookLog = { calls: [] };
    // The same id already composes in-realm: a duplicate the assembly refuses by name.
    const host = await customHost(fixture, [recorder(SAMPLE_ID, log)], {
      isolates: fixture.isolates,
    });
    const { source, sha256 } = fixture.drop();
    const outcome = await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
      source,
      sha256,
      hardened: true,
    });
    expect(denial(outcome).message).toMatch(/^artifact_invalid: duplicate plugin id/);
    expect(fixture.store.pluginInstalls()).toEqual([]);
    expect(existsSync(join(fixture.dataDir, "plugins", SAMPLE_ID))).toBe(false);
    expect(fixture.runner.unloads).toEqual([SAMPLE_ID]);
    // The in-realm row is untouched: still one row under that id, still the first-party one.
    const rows = host.roster().filter((entry) => entry.manifest.id === SAMPLE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.install).toBeUndefined();
    fixture.store.close();
  });

  test("a child that fails to load rolls back and answers artifact_invalid with its reason", async () => {
    const fixture = await installFixture(() => {
      throw new IsolateLoadError("server.js threw at import");
    });
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    const outcome = await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
      source,
      sha256,
      hardened: true,
    });
    expect(denial(outcome).message).toBe("artifact_invalid: server.js threw at import");
    expect(fixture.store.pluginInstalls()).toEqual([]);
    expect(host.roster().some((entry) => entry.manifest.id === SAMPLE_ID)).toBe(false);
    fixture.store.close();
  });

  test("boot re-verifies every stored bundle and refuses a tampered one by name, never loading it", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    const stored = fixture.store.pluginInstalls()[0];
    if (stored === undefined) throw new Error("no install row");
    const published = installedRow(host, SAMPLE_ID).actions;
    // The file on disk changes under the pin: a manifest now claiming everything.
    writeFileSync(
      stored.bundlePath,
      JSON.stringify({
        format: 1,
        manifest: { ...SAMPLE_MANIFEST, capabilities: ["*"] },
        files: { "server.js": Buffer.from("export {};").toString("base64") },
      }),
    );

    const rebooted = new FakeRunner((ref) => sampleLoad(ref));
    const second = await customHost(fixture, [], {
      isolates: { runner: rebooted, dataDir: fixture.dataDir },
    });
    const row = installedRow(second, SAMPLE_ID);
    // The triple a manager reads as "refused": the switch is honestly ON, the lifecycle says
    // the row does not serve, and the install block says why.
    expect(row.enabled).toBe(true);
    expect(row.lifecycle).toBe("enable_failed");
    expect(row.install?.refusal).toBe("hash_mismatch");
    expect(row.install?.sha256).toBe(sha256);
    // Nothing from the file — no child, no module, not the `*` it now claims — but the doors
    // the row remembers from its admission are published, under the ceiling they need.
    expect(row.actions).toEqual(published);
    expect(row.manifest.capabilities).toEqual(["containers:read", "tokens:mint"]);
    expect(rebooted.loads).toEqual([]);
    expect(second.webModule(SAMPLE_ID)).toBeNull();
    // A dispatch to one is the runner's rung, traced, naming the verdict — never the untraced
    // `unknown_action` for a door the roster showed yesterday.
    expect(await second.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
      ok: false,
      denial: {
        rule: "unavailable",
        message: "bundle failed verification at boot: hash_mismatch",
      },
    });
    const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
    expect(trace?.door).toBe(`${SAMPLE_ID}.ping`);
    expect(trace?.outcome).toBe("unavailable");
    // The installer's grant still narrows the remembered doors at rung 4, before the refusal.
    expect(denial(await second.dispatch(fixture.owner, `${SAMPLE_ID}.mint`, {})).message).toBe(
      `tokens:mint not granted to plugin ${SAMPLE_ID}`,
    );
    // The remedy is the ordinary one: disable, uninstall.
    expect(await second.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(await second.uninstall(SAMPLE_ID, "admin", false)).toEqual({ ok: true });
    expect(fixture.store.pluginInstalls()).toEqual([]);
    fixture.store.close();
  });

  test("a denial the child or supervisor grades is settled as that rung, traced, never a failure", async () => {
    const fixture = await installFixture((ref) =>
      sampleLoad(ref, {
        ping: async (_ctx, args) => {
          const asked = args as { rule: "invalid_args" | "unavailable" };
          throw new IsolateDenial(asked.rule, `${asked.rule} from the child`);
        },
      }),
    );
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    for (const rule of ["invalid_args", "unavailable"] as const) {
      expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, { rule })).toEqual({
        ok: false,
        denial: { rule, message: `${rule} from the child` },
      });
      const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
      expect(trace?.door).toBe(`${SAMPLE_ID}.ping`);
      expect(trace?.outcome).toBe(rule);
    }
    fixture.store.close();
  });

  test("the runner's state is a roster lifecycle every principal sees, and it is pushed", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const { source, sha256 } = fixture.drop();
    expect(
      (
        await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
          source,
          sha256,
          hardened: true,
        })
      ).ok,
    ).toBe(true);
    const nextRoster = (): Promise<PluginRoster> => {
      const { promise, resolve } = Promise.withResolvers<PluginRoster>();
      const remove = host.onRosterChange((roster) => {
        remove();
        resolve(roster);
      });
      return promise;
    };

    let pushed = nextRoster();
    fixture.runner.report(SAMPLE_ID, "starting");
    expect((await pushed).find((entry) => entry.manifest.id === SAMPLE_ID)?.lifecycle).toBe(
      "isolate_starting",
    );
    pushed = nextRoster();
    fixture.runner.report(SAMPLE_ID, "running");
    expect(
      (await pushed).find((entry) => entry.manifest.id === SAMPLE_ID)?.lifecycle,
    ).toBeUndefined();
    pushed = nextRoster();
    fixture.runner.report(SAMPLE_ID, "crashed");
    expect(installedRow(host, SAMPLE_ID).lifecycle).toBeUndefined();
    expect((await pushed).find((entry) => entry.manifest.id === SAMPLE_ID)?.lifecycle).toBe(
      "isolate_crashed",
    );
    // A disabled row's module is nobody's to fetch.
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(host.webModule(SAMPLE_ID)).toBeNull();
    fixture.store.close();
  });
});
