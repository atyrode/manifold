import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign } from "node:crypto";
import { installBundle } from "@manifold/plugin-kit/install";
import { packPlugin } from "@manifold/plugin-kit/pack";
import {
  canonicalJobJson,
  JOB_OWNER_PROTOCOL_VERSION,
  JobDeploymentReviewSchema,
  MAX_PANEL_ARG_BYTES,
} from "@manifold/protocol";
import {
  ENGINE_AUTHOR_ACTION,
  ENGINE_INSTALL_ACTION,
  ENGINE_PLUGINS_ID,
  ENGINE_PURGE_ACTION,
  ENGINE_SET_DEVELOPER_MODE_ACTION,
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
  JobCommand,
  JobOwner,
  MachineHalf,
  ServicePolicy,
  PluginManifest,
  PluginRoster,
  TileLayout,
  TileRef,
} from "@manifold/protocol";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { SERVER_PLUGIN_DEFS, SHIPPED_PLUGIN_IDS } from "../src/assembly.ts";
import { authoredLayout } from "../src/authored.ts";
import { openDatabase } from "../src/db.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { JobService } from "../src/job-service.ts";
import {
  IsolateDenial,
  IsolateLoadError,
  type InstalledPluginRef,
  type IsolateLoadResult,
  type IsolateRunner,
  type IsolateState,
} from "../src/isolate/contract.ts";
import { serveCtxCall } from "../src/isolate/proxy-def.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyPlacementVocabulary, assemblyItemNouns } from "../src/placement.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import {
  openPluginDatabase,
  pluginDatabasePath,
  stagePluginDatabase,
} from "../src/plugin-database.ts";
import {
  OUTSIDE_SCOPE_REFUSAL,
  PluginHost,
  type ActionCtx,
  type IsolateDeps,
  type MachineAdmission,
  type ServerPluginDef,
} from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, sha256Hex, ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import type { PluginDatabase, StreamProducer } from "@manifold/plugin";
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
  getTerminalExecution: () => null,
  drain: () =>
    Promise.resolve({ ok: false, reason: "machine is offline: its terminals are unknown" }),
  repository: () =>
    Promise.resolve({ ok: false, reason: "machine is offline: it cannot be asked" }),
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
      id: "core.canvas.draw",
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

    expect(await fixture.host.setEnabled("core.canvas.draw", false, "admin")).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([1, 1]);

    // A socket closes far more often than the roster changes; a subscription that outlived
    // its connection would push frames into a dead socket forever.
    remove();
    expect(await fixture.host.setEnabled("core.canvas.draw", true, "admin")).toEqual({ ok: true });
    expect([staying, leaving].map((seen) => seen.length)).toEqual([2, 1]);
    fixture.store.close();
  });

  test("the assembly is REPLACED on a toggle, so a held reference is a stale snapshot", async () => {
    const fixture = await hostFixture();
    const before = fixture.host.assembly();

    expect(await fixture.host.setEnabled("core.canvas.draw", false, "admin")).toEqual({ ok: true });

    // Hot enablement (D4) is a recompose, not a mutation: everything that must react reads
    // `assembly()` again (or the published roster), which is why the identity changes.
    expect(fixture.host.assembly()).not.toBe(before);
    expect(before.enabled("core.canvas.draw")).toBe(true);
    expect(fixture.host.assembly().enabled("core.canvas.draw")).toBe(false);
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
        id: "core.canvas.draw",
        enabled: false,
      }),
    ).toEqual({ ok: true, result: {} });
    expect([...fixture.store.disabledPlugins()]).toEqual(["core.canvas.draw"]);
    expect(fixture.host.assembly().enabled("core.plugins")).toBe(true);
    fixture.store.close();
  });

  test("the roster records WHO changed a plugin and WHEN", async () => {
    const fixture = await hostFixture();
    fixture.runtime.time = 1_700_000_000_000;

    await fixture.host.setEnabled("core.canvas.draw", false, "principal-7");

    const entry = fixture.host.roster().find((row) => row.manifest.id === "core.canvas.draw");
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

  test("a panel leaf's argument rides the door, and an unbounded one is refused", async () => {
    const fixture = await hostFixture();
    const root = layoutWith({ kind: "panel", panelId: "core.shell.sidebar" }).root;
    const opened: TileLayout = { root: { ...root!, arg: { kind: "record", id: "r-1" } } };

    const stored = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", {
      layout: opened,
    });
    expect(stored).toEqual({ ok: true, result: {} });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(opened);

    /*
      The one thing the door decides about an argument beyond where it may sit: a value it
      could not hand back unchanged, or one large enough to bloat every workspace read, is
      refused rather than stored (issue #516, `validPanelArg`). The store is the reason —
      a tree is read whole on every boot, so the bound is the door's business and not a
      caller's good manners.
     */
    const bloated: TileLayout = {
      root: { ...root!, arg: { id: "x".repeat(MAX_PANEL_ARG_BYTES) } },
    };
    const outcome = await fixture.host.dispatch(fixture.owner, "core.space.setLayout", {
      layout: bloated,
    });

    expect(denial(outcome)).toEqual({
      rule: "refused",
      message: "layout is not a valid tile tree",
    });
    expect(fixture.store.workspaceLayout(fixture.owner.principal.id)).toEqual(opened);
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
    let traceId: number | null = null;
    await expect(
      host.dispatch(fixture.owner, "test.doors.orphan", {}, null, {
        onTrace: (id) => {
          traceId = id;
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0]).toMatchObject({
      id: traceId,
      door: "test.doors.orphan",
      outcome: "failed",
    });
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
    readonly dataDir?: string;
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

  test("held definitions cannot run migrations or lifecycle hooks during live changes", async () => {
    const fixture = await hostFixture();
    const log: HookLog = { calls: [] };
    const bad = recorder(
      "test.bad",
      log,
      {
        actions: [
          defineAction({
            name: "write",
            title: "Write",
            caps: ["containers:write"],
            input: z.strictObject({}),
            result: z.strictObject({}),
          }),
        ],
        lifecycle: {
          onEnable: () => {
            log.calls.push("held enable");
          },
          onAssemblyChanged: () => {
            log.calls.push("held change");
          },
          onPurge: () => {
            log.calls.push("held purge");
          },
        },
        migrations: [
          {
            name: "to-two",
            to: { major: 2, minor: 0 },
            migrate: async (storage) => {
              await storage.set("migrated", "yes");
            },
          },
        ],
      },
      { dataVersion: { major: 2, minor: 0 } },
    );
    await fixture.store.pluginStorage("test.bad").stampDataVersion({ major: 1, minor: 0 });
    const host = await customHost(fixture, [
      bad,
      recorder("test.dependent", log, {}, { dependencies: { "test.bad": { type: "required" } } }),
      recorder("test.good", log),
    ]);
    const held = host.roster().find((row) => row.manifest.id === "test.bad")?.held;
    if (held === undefined) throw new Error("expected the invalid plugin to be held");
    expect(held.reason).toContain("outside its manifest capabilities");
    expect(await host.setEnabled("test.bad", true, "admin")).toEqual({ refused: held.reason });
    await host.setEnabled("test.good", false, "admin");
    await host.setEnabled("test.good", true, "admin");
    expect(await fixture.store.pluginStorage("test.bad").get("migrated")).toBeNull();
    await host.purge("test.bad", "admin");
    expect(log.calls).toEqual(["disable:test.good", "enable:test.good"]);
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

  test("unreadable stored data holds non-core at boot and refuses enable", async () => {
    const fixture = await hostFixture();
    const storage = fixture.store.pluginStorage(VERSIONED_ID);
    await storage.stampDataVersion({ major: 3, minor: 0 });

    // A DOWNGRADE. Old code cannot be trusted with newer data and no migration runs
    // backwards, so the honest answer is a refusal rather than a best-effort read.
    const held = await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    const row = held.roster().find((entry) => entry.manifest.id === VERSIONED_ID);
    if (row?.held === undefined) throw new Error("expected the unreadable plugin to be held");
    expect(row?.enabled).toBe(false);
    expect(row?.held?.reason).toMatch(/data_downgrade|downgrade is refused/);
    expect(await held.setEnabled(VERSIONED_ID, true, "admin")).toEqual({
      refused: row.held.reason,
    });

    // Disabled, the same data is simply RETAINED: it cannot hurt anyone, so assembly
    // proceeds and the refusal moves to the door, where an actor is present to be told.
    fixture.store.setPluginEnabled(VERSIONED_ID, false, "admin", 0);
    const host = await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: true }));
    const outcome = await host.setEnabled(VERSIONED_ID, true, "admin");
    expect("refused" in outcome && outcome.refused.startsWith("data_downgrade")).toBe(true);
    expect(host.assembly().enabled(VERSIONED_ID)).toBe(false);
    fixture.store.close();
  });

  test("a major bump with no migration is held while minor changes remain readable", async () => {
    const fixture = await hostFixture();
    await fixture.store.pluginStorage(VERSIONED_ID).stampDataVersion({ major: 1, minor: 4 });

    const held = await customHost(fixture, versioned({ major: 2, minor: 0, withMigration: false }));
    expect(held.roster().find((entry) => entry.manifest.id === VERSIONED_ID)?.held?.reason).toMatch(
      /data_migration_missing|no unapplied migration/,
    );

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
      // A plugin that declared no database still reports a size, and 0 is a real size.
      databaseBytes: 0,
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
      result: {
        id: VERSIONED_ID,
        removed: { storage: 1, elements: 1, ownership: 1 },
        databaseBytes: 0,
      },
    });
    fixture.store.close();
  });
});

/**
 * THE PLUGIN'S OWN TABLES, from the host's side (ADR 0034).
 *
 * The engine's file is `plugin-database.test.ts`'s subject. What these cases pin is the
 * WIRING: who gets a slice and who does not, that a migration is handed one, and that the
 * file follows storage's lifecycle — retained by a disable, destroyed by a purge, and
 * refusing a silent uninstall exactly as a namespace holding keys does.
 */
describe("PluginHost database", () => {
  const ROWS_ID = "test.rows";
  const KEYS_ID = "test.keys";

  /** Two plugins that differ in one manifest line: one declares a database, one does not. */
  function databaseDefs(
    options: {
      readonly migration?: boolean;
      readonly retain?: (database: PluginDatabase) => void;
      readonly disable?: () => Promise<void>;
    } = {},
  ): readonly ServerPluginDef[] {
    return [
      {
        manifest: {
          id: ROWS_ID,
          version: "1.0.0",
          title: "Rows",
          description: "Keeps its data as rows.",
          capabilities: [],
          database: { maxBytes: 4 * 1024 * 1024 },
          ...(options.migration === true ? { dataVersion: { major: 2, minor: 0 } } : {}),
          contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        },
        actions: [
          defineAction({
            name: "write",
            title: "Write a row",
            caps: [],
            input: z.strictObject({}),
            result: z.strictObject({ note: z.string(), declared: z.boolean() }),
          }),
        ],
        handlers: {
          write: async (ctx: ActionCtx) => {
            if (ctx.database === undefined) return { note: "", declared: false };
            options.retain?.(ctx.database);
            await ctx.database.run(
              "CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
            );
            await ctx.database.run("INSERT INTO notes(body) VALUES (?)", ["kept"]);
            const rows = await ctx.database.query<{ body: string }>("SELECT body FROM notes");
            return { note: rows[0]?.body ?? "", declared: true };
          },
        },
        lifecycle: {
          onDisable: async (ctx) => {
            if (ctx.database !== undefined) options.retain?.(ctx.database);
            await options.disable?.();
          },
        },
        ...(options.migration === true
          ? {
              migrations: [
                {
                  name: "0001-make-the-table",
                  to: { major: 2, minor: 0 },
                  migrate: async (storage, database) => {
                    if (database === undefined) {
                      await storage.set("migrated", "without a database");
                      return;
                    }
                    options.retain?.(database);
                    await database.run(
                      "CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
                    );
                    await storage.set("migrated", "with a database");
                  },
                },
              ],
            }
          : {}),
      },
      {
        manifest: {
          id: KEYS_ID,
          version: "1.0.0",
          title: "Keys",
          description: "Keeps its data as keys.",
          capabilities: [],
          contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        },
        actions: [
          defineAction({
            name: "look",
            title: "Look for a database",
            caps: [],
            input: z.strictObject({}),
            result: z.strictObject({ declared: z.boolean() }),
          }),
        ],
        handlers: {
          look: async (ctx: ActionCtx) => ({ declared: ctx.database !== undefined }),
        },
      },
    ];
  }

  test("the slice reaches the plugin that declared a database, and nobody else", async () => {
    const fixture = await hostFixture();
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-host-db-"));
    const host = await customHost(fixture, databaseDefs(), { dataDir });
    try {
      expect(await host.dispatch(fixture.owner, `${ROWS_ID}.write`, {})).toEqual({
        ok: true,
        result: { note: "kept", declared: true },
      });
      /*
        The declaration is the whole of what decides it (ADR 0034 §6): the second plugin runs
        in the same host, on the same data directory, and has no slice at all — so a file
        exists only for the plugin that asked for one, and nothing was created for the other.
      */
      expect(await host.dispatch(fixture.owner, `${KEYS_ID}.look`, {})).toEqual({
        ok: true,
        result: { declared: false },
      });
      expect(existsSync(pluginDatabasePath(dataDir, ROWS_ID))).toBe(true);
      expect(existsSync(pluginDatabasePath(dataDir, KEYS_ID))).toBe(false);
    } finally {
      host.close();
      fixture.store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("a migration is handed the database, and makes the table its plugin then writes to", async () => {
    const fixture = await hostFixture();
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-host-db-"));
    const storage = fixture.store.pluginStorage(ROWS_ID);
    await storage.stampDataVersion({ major: 1, minor: 0 });
    let retained: PluginDatabase | undefined;
    const host = await customHost(
      fixture,
      databaseDefs({
        migration: true,
        retain: (database) => {
          retained = database;
        },
      }),
      { dataDir },
    );
    try {
      // The ledger and the stamp stay in `plugin_kv` whatever shape the data has, so ONE
      // version and ONE ledger answer for a plugin whose data is keys, rows or both.
      expect(await storage.get("migrated")).toBe("with a database");
      expect(await storage.appliedMigrations()).toEqual(["0001-make-the-table"]);
      expect(await storage.dataVersion()).toEqual({ major: 2, minor: 0 });
      await expect(retained!.run("DROP TABLE notes")).rejects.toThrow(/closed/);
      // The table the migration created is the one the handler inserts into: a second
      // `CREATE TABLE` would have thrown rather than returned.
      expect(await host.dispatch(fixture.owner, `${ROWS_ID}.write`, {})).toEqual({
        ok: true,
        result: { note: "kept", declared: true },
      });
    } finally {
      host.close();
      fixture.store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("purge deletes the file with its journal and reports the bytes that went", async () => {
    const fixture = await hostFixture();
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-host-db-"));
    const retained: PluginDatabase[] = [];
    const disabled = Promise.withResolvers<void>();
    const host = await customHost(
      fixture,
      databaseDefs({
        retain: (database) => retained.push(database),
        disable: () => disabled.promise,
      }),
      { dataDir, lifecycleTimeoutMs: 5 },
    );
    try {
      await host.dispatch(fixture.owner, `${ROWS_ID}.write`, {});
      await expect(retained[0]!.run("DROP TABLE notes")).rejects.toThrow(/closed/);
      // A DISABLE RETAINS: the rows are still on disk when the plugin stops serving, which is
      // what makes purge the separate, explicitly named act that destroys them.
      await host.setEnabled(ROWS_ID, false, "admin");
      expect(existsSync(pluginDatabasePath(dataDir, ROWS_ID))).toBe(true);
      await expect(retained[1]!.run("DROP TABLE notes")).rejects.toThrow(/closed/);
      disabled.resolve();
      const live = openPluginDatabase({ dataDir, pluginId: ROWS_ID });
      expect(await live.query("SELECT body FROM notes")).toEqual([{ body: "kept" }]);
      live.close();

      const outcome = await host.purge(ROWS_ID, "admin");
      if ("refused" in outcome) throw new Error(outcome.refused);
      expect(outcome.id).toBe(ROWS_ID);
      expect(outcome.databaseBytes).toBeGreaterThan(0);
      expect(existsSync(pluginDatabasePath(dataDir, ROWS_ID))).toBe(false);
      expect(existsSync(`${pluginDatabasePath(dataDir, ROWS_ID)}-wal`)).toBe(false);
      await expect(retained[0]!.batch([{ sql: "CREATE TABLE resurrected(v)" }])).rejects.toThrow(
        /closed/,
      );
      expect(existsSync(pluginDatabasePath(dataDir, ROWS_ID))).toBe(false);

      // The next open starts from no file at all, so the purged plugin is a fresh one.
      await host.setEnabled(ROWS_ID, true, "admin");
      expect(await host.dispatch(fixture.owner, `${ROWS_ID}.write`, {})).toEqual({
        ok: true,
        result: { note: "kept", declared: true },
      });
    } finally {
      disabled.resolve();
      host.close();
      fixture.store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    "prepared-before-activation",
    "prepared-between-renames",
    "prepared-activated",
    "prepared-first-file",
    "committed-activated",
    "committed-cleaned",
    "prepared-unknown",
    "committed-unknown",
  ] as const)("boot recovers %s with the matching KV and ledger", async (point) => {
    const fixture = await hostFixture();
    const dataDir = mkdtempSync(join(tmpdir(), "manifold-db-recovery-"));
    const metadataPath = join(dataDir, "server.db");
    let store = new ServerStore(openDatabase(metadataPath));
    const livePath = pluginDatabasePath(dataDir, ROWS_ID);
    const options = { dataDir, pluginId: ROWS_ID };
    const first = point === "prepared-first-file";
    const committed = point.startsWith("committed");
    try {
      if (!first) {
        const old = openPluginDatabase(options);
        await old.run("CREATE TABLE notes(body TEXT)");
        await old.run("INSERT INTO notes VALUES ('old')");
        old.close();
      }
      const storage = store.pluginStorage(ROWS_ID);
      await storage.set("row", "old");
      await storage.stampDataVersion({ major: 1, minor: 0 });
      const draft = store.beginPluginMigration(ROWS_ID);
      const image = stagePluginDatabase(options, store);
      await image.database.run("CREATE TABLE IF NOT EXISTS notes(body TEXT)");
      await image.database.run("DELETE FROM notes");
      await image.database.run("INSERT INTO notes VALUES ('new')");
      await draft.storage.set("row", "new");
      await draft.storage.recordMigration("upgrade", 1);
      await draft.storage.stampDataVersion({ major: 2, minor: 0 });
      image.activate();
      if (point === "prepared-before-activation" || point === "prepared-between-renames")
        renameSync(livePath, `${livePath}.stage`);
      if (point === "prepared-before-activation") renameSync(`${livePath}.backup`, livePath);
      if (committed) draft.commit(() => image.committed());
      else draft.discard();
      if (point === "committed-cleaned") rmSync(`${livePath}.backup`);
      if (point.endsWith("unknown")) writeFileSync(livePath, "operator-owned evidence");
      // Close/reopen the durable metadata DB, deliberately leaving the journal unfinished.
      store.close();
      store = new ServerStore(openDatabase(metadataPath));
      if (point.endsWith("unknown")) {
        await expect(customHost({ ...fixture, store }, [], { dataDir })).rejects.toThrow(
          /unknown database image/,
        );
        expect(readFileSync(livePath, "utf8")).toBe("operator-owned evidence");
        expect(existsSync(`${livePath}.backup`)).toBe(true);
        expect(store.pluginDatabaseJournal(ROWS_ID)?.phase).toBe(
          committed ? "committed" : "prepared",
        );
        return;
      }
      const host = await customHost({ ...fixture, store }, [], { dataDir });
      host.close();
      const recovered = store.pluginStorage(ROWS_ID);
      expect(await recovered.get("row")).toBe(committed ? "new" : "old");
      expect(await recovered.dataVersion()).toEqual({ major: committed ? 2 : 1, minor: 0 });
      expect(await recovered.appliedMigrations()).toEqual(committed ? ["upgrade"] : []);
      if (first) expect(existsSync(livePath)).toBe(false);
      else {
        const rows = openPluginDatabase(options);
        expect(await rows.query("SELECT body FROM notes")).toEqual([
          { body: committed ? "new" : "old" },
        ]);
        rows.close();
      }
      expect(store.pluginDatabaseJournals()).toEqual([]);
      expect(existsSync(`${livePath}.stage`)).toBe(false);
      expect(existsSync(`${livePath}.backup`)).toBe(false);
    } finally {
      store.close();
      fixture.store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
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
          hardenedContract: 2,
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

/** Real authored exports, packed and admitted through the ordinary pinned install door. */
async function migrationBundle(
  fixture: InstallFixture,
  major: number,
  failure:
    | "none"
    | "throw"
    | "timeout"
    | "crash"
    | "malformed"
    | "cross-call"
    | "slice"
    | "loaded"
    | "conflict"
    | "load_failed" = "none",
  database: NonNullable<PluginManifest["database"]> | null = { maxBytes: 4 * 1024 * 1024 },
): Promise<{ source: string; sha256: string }> {
  const manifest: PluginManifest = {
    ...SAMPLE_MANIFEST,
    version: `${String(major)}.0.0`,
    dataVersion: { major, minor: 0 },
    ...(database === null ? {} : { database }),
    capabilities: [],
    entry: { server: true },
  };
  const dir = mkdtempSync(join(fixture.dataDir, "migration-author-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(dir, "server.ts"),
    `
    import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
    import { defineServerAction, defineServerPlugin } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@manifold/plugin-kit/server")))};
    const manifest = ${JSON.stringify(manifest)};
    let migrationId;
    const def = {
      manifest,
      actions: ["read", "hold", "seed"].map(name => defineServerAction({
        name, title: name, caps: [], input: z.strictObject({}), result: z.unknown()
      })),
      handlers: {
        async read(ctx) {
          return { ...JSON.parse(await ctx.storage.get("row") ?? "null"),
            sql: ctx.database ? (await ctx.database.query("SELECT body FROM state"))[0]?.body : null };
        },
        async seed(ctx) {
          await ctx.database.run("CREATE TABLE state(body TEXT)");
          await ctx.database.run("INSERT INTO state VALUES (?)",
            [JSON.parse(await ctx.storage.get("row")).model]);
          return {};
        },
        async hold(ctx) {
          await ctx.storage.set("entered", "yes");
          while (await ctx.storage.get("release") !== "yes") await Bun.sleep(1);
          return JSON.parse(await ctx.storage.get("row"));
        }
      },
      migrations: ${
        major === 1
          ? "[]"
          : `[
        { name: "canonical-v3", to: { major: 2, minor: 0 }, async migrate(storage, database) {
          const before = await storage.get("row");
          const row = JSON.parse(before);
          if (row.schema !== 2) throw new Error("migration ran more than once");
          if (database) {
            await database.run("CREATE TABLE IF NOT EXISTS state(body TEXT)");
            await database.run("DELETE FROM state");
            await database.run("INSERT INTO state VALUES ('migrated')");
          }
          await storage.set("row", JSON.stringify({ ...row, schema: 3, choice: row.model }));
          await storage.set("applied", String(Number(await storage.get("applied") ?? "0") + 1));
          ${failure === "throw" ? 'throw new Error("transformation refused");' : ""}
          ${failure === "timeout" ? "await Promise.withResolvers().promise;" : ""}
          ${failure === "crash" ? "process.exit(7);" : ""}
          ${failure === "malformed" ? 'process.send({t:"migrated", id:migrationId, name:"canonical-v3", outcome:{ok:"yes"}});' : ""}
          ${failure === "cross-call" ? 'process.send({t:"migrated", id:"retired-request", name:"canonical-v3", outcome:{ok:true}});' : ""}
          ${failure === "slice" ? 'process.send({t:"call", id:migrationId + ":forbidden", method:"newId", args:[]});' : ""}
          ${failure === "loaded" ? 'process.send({t:"loaded", actions:[], hooks:{onEnable:false,onDisable:false,onAssemblyChanged:false}});' : ""}
          ${failure === "load_failed" ? 'process.send({t:"load_failed", error:"wrong-phase load failure"});' : ""}
        } }
      ]`
      }
    };
    defineServerPlugin(def);
    if (typeof process.send === "function")
      process.on("message", frame => { if (frame.t === "migrate") migrationId = frame.id; });
    export default def;
  `,
  );
  const source = join(
    fixture.dataDir,
    PLUGIN_UPLOADS_DIR,
    `${String(major)}-${failure}.manifold-plugin.json`,
  );
  const packed = await packPlugin(dir, source);
  return { source, sha256: packed.sha256 };
}

// Real subprocess IPC and child exit are not driven by the host's fake clock. Poll the
// observable boundary, never a guessed "long enough" delay.
async function untilMigration(predicate: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= until) throw new Error("migration boundary did not arrive");
    await Bun.sleep(1);
  }
}

describe("installed guest data migrations", () => {
  test.each([false, true])(
    "drains old dispatch and atomically serves transformed data (hardened: %s)",
    async (hardened) => {
      const f = await installFixture();
      const runner = new IsolateSupervisor({ logger: silentLogger, runtime: f.runtime });
      const releaseDraft = Promise.withResolvers<void>();
      const inFlight: Promise<unknown>[] = [];
      try {
        const host = await customHost(f, [], { isolates: { ...f.isolates, runner } });
        const first = await migrationBundle(f, 1);
        const next = await migrationBundle(f, 2);
        expect(
          (await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, { ...first, hardened })).ok,
        ).toBe(true);
        const storage = f.store.pluginStorage(SAMPLE_ID);
        const original = { schema: 2, revision: 7, model: "kept" };
        await storage.set("row", JSON.stringify(original));
        expect((await host.dispatch(f.owner, `${SAMPLE_ID}.seed`, {})).ok).toBe(true);
        const old = host.dispatch(f.owner, `${SAMPLE_ID}.hold`, {});
        inFlight.push(old);
        await untilMigration(async () => (await storage.get("entered")) === "yes");
        const drafting = Promise.withResolvers<void>();
        const begin = f.store.beginPluginMigration.bind(f.store);
        f.store.beginPluginMigration = (id, includeData) => {
          const session = begin(id, includeData);
          return {
            ...session,
            storage: {
              ...session.storage,
              set: async (key, value) => {
                await session.storage.set(key, value);
                if (id === SAMPLE_ID && key === "row") {
                  drafting.resolve();
                  await releaseDraft.promise;
                }
              },
            },
          };
        };
        const upgrade = host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
          ...next,
          hardened,
          replace: true,
        });
        inFlight.push(upgrade);
        await untilMigration(async () => {
          const result = await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {});
          return !result.ok && result.denial.rule === "unavailable";
        });
        expect(await storage.dataVersion()).toEqual({ major: 1, minor: 0 });
        await storage.set("release", "yes");
        expect(await old).toEqual({ ok: true, result: original });
        await drafting.promise;
        expect(JSON.parse((await storage.get("row"))!)).toEqual(original);
        expect(await storage.appliedMigrations()).toEqual([]);
        const live = openPluginDatabase({ dataDir: f.dataDir, pluginId: SAMPLE_ID });
        expect(await live.query("SELECT body FROM state")).toEqual([{ body: "kept" }]);
        live.close();
        expect(denial(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).rule).toBe(
          "unavailable",
        );
        // An unrelated namespace commits during IPC, outside the migration's transaction.
        await f.store.pluginStorage("test.other").set("live", "retained");
        releaseDraft.resolve();
        expect((await upgrade).ok).toBe(true);
        const transformed = { ...original, schema: 3, choice: "kept", sql: "migrated" };
        expect(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).toEqual({
          ok: true,
          result: transformed,
        });
        expect(await storage.appliedMigrations()).toEqual(["canonical-v3"]);
        expect(await storage.dataVersion()).toEqual({ major: 2, minor: 0 });
        expect(await storage.get("applied")).toBe("1");
        expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
        expect(await host.setEnabled(SAMPLE_ID, true, "admin")).toEqual({ ok: true });
        expect(await storage.get("applied")).toBe("1");
        expect(
          denial(
            await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
              ...first,
              hardened,
              replace: true,
            }),
          ).message,
        ).toContain("major downgrade");
        expect(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).toEqual({
          ok: true,
          result: transformed,
        });
        expect(await f.store.pluginStorage("test.other").get("live")).toBe("retained");
        expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
        // Even with no KV rows left, the file alone prevents silent uninstall.
        await storage.clear();
        const retained = await host.uninstall(SAMPLE_ID, "admin", false);
        expect("refused" in retained && retained.refused.startsWith("storage_retained")).toBe(true);
        expect(await host.uninstall(SAMPLE_ID, "admin", true)).toEqual({ ok: true });
        expect(existsSync(pluginDatabasePath(f.dataDir, SAMPLE_ID))).toBe(false);
        expect(f.store.pluginInstalls()).toEqual([]);
        host.close();
      } finally {
        releaseDraft.resolve();
        await f.store.pluginStorage(SAMPLE_ID).set("release", "yes");
        await Promise.allSettled(inFlight);
        await runner.close();
        f.store.close();
        rmSync(f.dataDir, { recursive: true, force: true });
      }
    },
  );

  test.each(
    (
      [
        "throw",
        "timeout",
        "crash",
        "malformed",
        "cross-call",
        "slice",
        "loaded",
        "load_failed",
        "conflict",
      ] as const
    ).flatMap((failure) =>
      (failure === "throw" || failure === "timeout" ? [false, true] : [true]).map((hardened) => ({
        failure,
        hardened,
      })),
    ),
  )(
    "%j never publishes a draft, records success, or loses another plugin's commit",
    async ({ failure, hardened }) => {
      const f = await installFixture();
      const runner = new IsolateSupervisor({
        logger: silentLogger,
        runtime: f.runtime,
        migrationDeadlineMs: failure === "timeout" ? 100 : 10_000,
      });
      try {
        const host = await customHost(f, [], { isolates: { ...f.isolates, runner } });
        const first = await migrationBundle(f, 1);
        const next = await migrationBundle(f, 2, failure);
        expect(
          (await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, { ...first, hardened })).ok,
        ).toBe(true);
        const storage = f.store.pluginStorage(SAMPLE_ID);
        const original = { schema: 2, revision: 7, model: "retained" };
        await storage.set("row", JSON.stringify(original));
        expect((await host.dispatch(f.owner, `${SAMPLE_ID}.seed`, {})).ok).toBe(true);
        const installed = f.store.pluginInstalls();
        const begin = f.store.beginPluginMigration.bind(f.store);
        f.store.beginPluginMigration = (id, includeData) => {
          const session = begin(id, includeData);
          return {
            ...session,
            storage: {
              ...session.storage,
              set: async (key, value) => {
                await session.storage.set(key, value);
                if (key === "row") {
                  expect(JSON.parse((await storage.get("row"))!)).toEqual(original);
                  expect(denial(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).rule).toBe(
                    "unavailable",
                  );
                  await f.store
                    .pluginStorage("test.other")
                    .set("live", "committed-during-migration");
                  if (failure === "conflict") await storage.set("racer", "retained");
                }
              },
            },
          };
        };
        const outcome = await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
          ...next,
          hardened,
          replace: true,
        });
        expect(denial(outcome).message).toContain("artifact_invalid");
        expect(f.store.pluginInstalls()).toEqual(installed);
        expect(await storage.appliedMigrations()).toEqual([]);
        expect(await storage.dataVersion()).toEqual({ major: 1, minor: 0 });
        expect(await storage.get("applied")).toBeNull();
        expect(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).toEqual({
          ok: true,
          result: { ...original, sql: "retained" },
        });
        expect(await f.store.pluginStorage("test.other").get("live")).toBe(
          "committed-during-migration",
        );
        if (failure === "conflict") expect(await storage.get("racer")).toBe("retained");
        expect(f.store.pluginDatabaseJournals()).toEqual([]);
        expect(existsSync(`${pluginDatabasePath(f.dataDir, SAMPLE_ID)}.stage`)).toBe(false);
        host.close();
      } finally {
        await runner.close();
        f.store.close();
        rmSync(f.dataDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.each([
    { change: "add", hardened: false },
    { change: "remove", hardened: true },
    { change: "quota", hardened: false },
  ] as const)(
    "replacement uses the candidate database declaration: %j",
    async ({ change, hardened }) => {
      const f = await installFixture();
      const runner = new IsolateSupervisor({ logger: silentLogger, runtime: f.runtime });
      let host: PluginHost | undefined;
      try {
        host = await customHost(f, [], { isolates: { ...f.isolates, runner } });
        const first = await migrationBundle(f, 1, "none", change === "add" ? null : {});
        const next = await migrationBundle(
          f,
          2,
          "none",
          change === "remove" ? null : { maxBytes: change === "quota" ? 4096 : 4 * 1024 * 1024 },
        );
        expect(
          (await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, { ...first, hardened })).ok,
        ).toBe(true);
        const storage = f.store.pluginStorage(SAMPLE_ID);
        const original = { schema: 2, revision: 7, model: "retained" };
        await storage.set("row", JSON.stringify(original));
        if (change !== "add")
          expect((await host.dispatch(f.owner, `${SAMPLE_ID}.seed`, {})).ok).toBe(true);
        const installed = f.store.pluginInstalls();
        const result = await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
          ...next,
          hardened,
          replace: true,
        });
        expect(result.ok).toBe(change !== "quota");
        expect(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).toEqual({
          ok: true,
          result:
            change === "quota"
              ? { ...original, sql: "retained" }
              : {
                  ...original,
                  schema: 3,
                  choice: "retained",
                  sql: change === "remove" ? null : "migrated",
                },
        });
        expect(await storage.dataVersion()).toEqual({
          major: change === "quota" ? 1 : 2,
          minor: 0,
        });
        expect(await storage.appliedMigrations()).toEqual(
          change === "quota" ? [] : ["canonical-v3"],
        );
        if (change === "quota") expect(f.store.pluginInstalls()).toEqual(installed);
        if (change === "remove") {
          const retained = openPluginDatabase({ dataDir: f.dataDir, pluginId: SAMPLE_ID });
          expect(await retained.query("SELECT body FROM state")).toEqual([{ body: "retained" }]);
          retained.close();
        }
      } finally {
        host?.close();
        await runner.close();
        f.store.close();
        rmSync(f.dataDir, { recursive: true, force: true });
      }
    },
  );

  test("replacement enforces a smaller candidate database quota without a migration", async () => {
    const f = await installFixture();
    const runner = new IsolateSupervisor({ logger: silentLogger, runtime: f.runtime });
    let host: PluginHost | undefined;
    try {
      host = await customHost(f, [], { isolates: { ...f.isolates, runner } });
      const first = await migrationBundle(f, 1, "none");
      expect((await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, first)).ok).toBe(true);
      const storage = f.store.pluginStorage(SAMPLE_ID);
      const original = { schema: 2, revision: 7, model: "retained" };
      await storage.set("row", JSON.stringify(original));
      expect((await host.dispatch(f.owner, `${SAMPLE_ID}.seed`, {})).ok).toBe(true);
      const installed = f.store.pluginInstalls();

      const smaller = await migrationBundle(f, 1, "throw", { maxBytes: 4096 });
      const outcome = await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
        ...smaller,
        replace: true,
      });
      expect(denial(outcome).message).toContain("candidate manifest page budget");
      expect(f.store.pluginInstalls()).toEqual(installed);
      expect(await host.dispatch(f.owner, `${SAMPLE_ID}.read`, {})).toEqual({
        ok: true,
        result: { ...original, sql: "retained" },
      });
    } finally {
      host?.close();
      await runner.close();
      f.store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });

  test("enabling a disabled replacement enforces its retained database quota", async () => {
    const f = await installFixture();
    const runner = new IsolateSupervisor({ logger: silentLogger, runtime: f.runtime });
    let host: PluginHost | undefined;
    try {
      host = await customHost(f, [], { isolates: { ...f.isolates, runner } });
      const first = await migrationBundle(f, 1, "none");
      expect((await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, first)).ok).toBe(true);
      await f.store
        .pluginStorage(SAMPLE_ID)
        .set("row", JSON.stringify({ schema: 2, revision: 7, model: "retained" }));
      expect((await host.dispatch(f.owner, `${SAMPLE_ID}.seed`, {})).ok).toBe(true);
      expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });

      const smaller = await migrationBundle(f, 1, "throw", { maxBytes: 4096 });
      expect(
        (
          await host.dispatch(f.owner, ENGINE_INSTALL_ACTION, {
            ...smaller,
            replace: true,
          })
        ).ok,
      ).toBe(true);
      const enabled = await host.setEnabled(SAMPLE_ID, true, "admin");
      expect("refused" in enabled ? enabled.refused : "").toContain(
        "candidate manifest page budget",
      );
      expect(installedRow(host, SAMPLE_ID).enabled).toBe(false);
    } finally {
      host?.close();
      await runner.close();
      f.store.close();
      rmSync(f.dataDir, { recursive: true, force: true });
    }
  });
});

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
    // Absent on the wire is in-realm, and the ROW says so: the persisted flag is what a
    // restart reloads by, so a request that named no runner must not be read back as
    // hardened by migration 21's backfill or by any column default.
    expect(fixture.store.pluginInstalls().map((row) => row.hardened)).toEqual([false]);
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

  test("native delegates remain bounded by the installer's grant even for root callers", async () => {
    const fixture = await installFixture((ref) => ({
      def: {
        manifest: ref.manifest,
        actions: [
          defineAction({
            name: "read",
            title: "Read",
            caps: [],
            delegates: ["services:read"],
            input: z.strictObject({}),
            result: z.strictObject({}),
          }),
        ],
        handlers: { read: async () => ({}) },
      },
      lifecycle: {},
    }));
    try {
      const host = await customHost(fixture, [], { isolates: fixture.isolates });
      const bundle = fixture.drop({ ...SAMPLE_MANIFEST, capabilities: ["*"] });
      expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, bundle)).ok).toBe(true);
      expect(denial(await host.dispatch(fixture.owner, `${SAMPLE_ID}.read`, {})).rule).toBe(
        "forbidden",
      );
      expect(
        (
          await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
            ...fixture.drop({ ...SAMPLE_MANIFEST, id: "vendor.granted", capabilities: ["*"] }),
            grant: ["services:read"],
          })
        ).ok,
      ).toBe(true);
      expect(await host.dispatch(fixture.owner, "vendor.granted.read", {})).toEqual({
        ok: true,
        result: {},
      });
    } finally {
      fixture.store.close();
    }
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
      message: "storage_retained: 1 keys and 0 database pages; purge first or pass purge: true",
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

  test("a row whose data is ROWS is refused a silent uninstall exactly as one holding keys is", async () => {
    /*
      #233's guard widened to the shape ADR 0034 added (§5). The sample declares a database and
      its door writes a table; it holds NO keys, so the only thing standing between it and a
      silent uninstall is the page count — which is the whole point of counting it.
    */
    const fixture = await installFixture((ref) =>
      sampleLoad(ref, {
        ping: async (ctx: unknown) => {
          const database = (ctx as ActionCtx).database;
          if (database === undefined) return { pong: false };
          await database.run("CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
          await database.run("INSERT INTO records(body) VALUES (?)", ["kept"]);
          return { pong: true };
        },
      }),
    );
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    try {
      const { source, sha256 } = fixture.drop({ ...SAMPLE_MANIFEST, database: {} });
      expect(
        (
          await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, {
            source,
            sha256,
            hardened: true,
          })
        ).ok,
      ).toBe(true);
      expect(await host.dispatch(fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
        ok: true,
        result: { pong: true },
      });
      expect(await fixture.store.pluginStorage(SAMPLE_ID).count()).toBe(0);

      expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
      const retained = await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, {
        id: SAMPLE_ID,
      });
      expect(denial(retained).rule).toBe("refused");
      expect(denial(retained).message).toMatch(
        /^storage_retained: 0 keys and [1-9]\d* database pages; /,
      );
      expect(existsSync(pluginDatabasePath(fixture.dataDir, SAMPLE_ID))).toBe(true);

      // Consent, and the file goes with the row: the purge runs first and reports the bytes.
      expect(
        await host.dispatch(fixture.owner, ENGINE_UNINSTALL_ACTION, { id: SAMPLE_ID, purge: true }),
      ).toEqual({ ok: true, result: {} });
      expect(existsSync(pluginDatabasePath(fixture.dataDir, SAMPLE_ID))).toBe(false);
    } finally {
      host.close();
      fixture.store.close();
    }
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

  test("a bundle whose sheet reaches past its root class is refused stylesheet_unscoped and writes nothing; a rooted one is served at the pin (#258)", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], {
      distribution: SHIPPED_PLUGIN_IDS,
      isolates: fixture.isolates,
    });
    const manifest: PluginManifest = {
      ...SAMPLE_MANIFEST,
      entry: { server: true, web: "web.js", styles: true },
    };
    const unscoped = fixture.drop(manifest, {
      "server.js": "export {};",
      "web.js": "export const web = 1;",
      "styles.css": ".plugin-vendor_sample { color: red }\n.sidebar-section-title { color: red }",
    });
    expect(
      denial(await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, unscoped)).message,
    ).toBe(
      "stylesheet_unscoped: styles.css:2 the leftmost compound is not this plugin's root class (.sidebar-section-title)",
    );
    expect(fixture.store.pluginInstalls()).toEqual([]);
    expect(existsSync(join(fixture.dataDir, "plugins"))).toBe(false);

    const classless = fixture.drop(manifest, {
      "server.js": "export {};",
      "web.js": "export const web = 1;",
      "styles.css": "body { margin: 0 }",
    });
    expect(
      denial(await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, classless)).message,
    ).toBe("stylesheet_unscoped: styles.css:1 a rule with no class reaches every node (body)");

    // A form the walk cannot ownership-check reaches the door as its own sentence, not as the
    // silence that used to read as "admitted" (#410).
    const scoped = fixture.drop(manifest, {
      "server.js": "export {};",
      "web.js": "export const web = 1;",
      "styles.css": "@scope (.plugin-vendor_sample) { .sidebar-section-title { color: red } }",
    });
    expect(denial(await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, scoped)).message).toBe(
      "stylesheet_unscoped: styles.css:1 this at-rule form is outside the dialect the ownership rule reads (@scope (.plugin-vendor_sample))",
    );

    const sheet =
      ".plugin-vendor_sample { color: red }\n.plugin-vendor_sample__title { font-weight: 600 }";
    const rooted = fixture.drop(manifest, {
      "server.js": "export {};",
      "web.js": "export const web = 1;",
      "styles.css": sheet,
    });
    expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, rooted)).ok).toBe(true);
    expect(host.stylesheet(SAMPLE_ID)).toEqual({
      sha256: rooted.sha256,
      bytes: Buffer.from(sheet),
    });
    // Off, the sheet leaves with the module: nothing is fetched for a row that paints nothing.
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    expect(host.stylesheet(SAMPLE_ID)).toBeNull();
    expect(await host.setEnabled(SAMPLE_ID, true, "admin")).toEqual({ ok: true });
    expect(host.stylesheet(SAMPLE_ID)?.sha256).toBe(rooted.sha256);
    // A bundle that declares no sheet serves none, whatever it carries.
    expect(await host.setEnabled(SAMPLE_ID, false, "admin")).toEqual({ ok: true });
    const undeclared = fixture.drop(
      { ...SAMPLE_MANIFEST, version: "2.0.0" },
      { "server.js": "export {};", "web.js": "export const web = 1;", "styles.css": sheet },
    );
    expect(
      (await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, { ...undeclared, replace: true }))
        .ok,
    ).toBe(true);
    expect(host.stylesheet(SAMPLE_ID)).toBeNull();
    fixture.store.close();
  });

  test("a second install needs replace and an intentionally disabled replacement stays off", async () => {
    const fixture = await installFixture();
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const first = fixture.drop();
    expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, first)).ok).toBe(true);
    const firstRow = fixture.store.pluginInstalls()[0];
    const second = fixture.drop({ ...SAMPLE_MANIFEST, version: "2.0.0" });

    expect(
      denial(await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, second)).message,
    ).toMatch(/^already_installed: /);

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

/** Real install/dispatch/native services; only the native owner's transport is simulated. */
async function retainedServiceFixture(dataVersion?: PluginManifest["dataVersion"]) {
  const generations = new Map<string, number>();
  const fixture: InstallFixture = await installFixture((ref) => {
    const generation = (generations.get(ref.pluginId) ?? 0) + 1;
    generations.set(ref.pluginId, generation);
    if (ref.manifest.version === "9.0.0") throw new IsolateLoadError("candidate did not load");
    const loaded = sampleLoad(ref, {
      ping: async () => {
        if (
          generations.get(ref.pluginId) !== generation ||
          fixture.runner.state(ref.pluginId) !== "running"
        )
          throw new IsolateDenial("unavailable", "retired child");
        return { version: ref.manifest.version };
      },
    });
    return ref.manifest.version === "8.0.0"
      ? {
          ...loaded,
          def: { ...loaded.def, actions: [...loaded.def.actions, ...loaded.def.actions] },
        }
      : loaded;
  });
  try {
    const host = await customHost(fixture, [], { isolates: fixture.isolates });
    const jobs = new JobService(fixture.store, fixture.auth, fixture.runtime);
    host.setJobs(jobs);
    const machineId = fixture.auth.enrollMachine("native-owner", fixture.owner).machine.id;
    const operationId = `${SAMPLE_ID}.serve`;
    const artifactSha256 = "a".repeat(64);
    const machine: MachineHalf = {
      artifacts: {
        "linux-x64": {
          url: "https://example.invalid/worker",
          sha256: artifactSha256,
          entrySha256: artifactSha256,
          format: "raw",
          entry: ["worker"],
          maxBytes: 4096,
          maxExpandedBytes: 4096,
          maxMembers: 1,
        },
      },
      operations: {
        [operationId]: {
          argv: [],
          input: {},
          runtimeTools: [],
          locations: [],
          outputs: [],
          network: "none",
          providesService: true,
          stdin: false,
          limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
        },
      },
      locations: {},
    };
    const manifest: PluginManifest = {
      ...SAMPLE_MANIFEST,
      machine,
      ...(dataVersion ? { dataVersion } : {}),
    };
    const first = fixture.drop(manifest);
    expect((await host.dispatch(fixture.owner, ENGINE_INSTALL_ACTION, first)).ok).toBe(true);
    const commands: JobCommand[] = [];
    const channel = {
      machineId,
      send: ({ command }: { type: "job_command"; command: JobCommand }) => {
        commands.push(command);
        return true;
      },
    };
    const pair = generateKeyPairSync("ed25519");
    const owner: JobOwner = {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
      ownerId: "retained-owner",
      generation: 1,
      platforms: ["linux-x64"],
      inventoryDigest: "b".repeat(64),
      publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      resources: { tools: {}, services: {}, anchors: {}, serviceDefinitions: {} },
    };
    const proveOwner = () => {
      jobs.online(channel, owner, "epoch");
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("missing native challenge");
      const proof = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId,
        owner,
      };
      jobs.event(channel, {
        type: "owner_proof",
        ...proof,
        signature: sign(null, Buffer.from(canonicalJobJson(proof)), pair.privateKey).toString(
          "base64",
        ),
      });
    };
    proveOwner();
    const request = {
      deploymentId: "retained-service",
      pluginId: SAMPLE_ID,
      targets: [{ machineId }],
      operationIds: [operationId],
    };
    const reviewOutcome = await host.dispatch(
      fixture.owner,
      "engine.jobs.reviewDeployment",
      request,
    );
    if (!reviewOutcome.ok) throw new Error(reviewOutcome.denial.message);
    const review = JobDeploymentReviewSchema.parse(reviewOutcome.result);
    expect(
      (
        await host.dispatch(fixture.owner, "engine.jobs.applyDeployment", {
          request,
          reviewDigest: review.reviewDigest,
        })
      ).ok,
    ).toBe(true);
    const install = commands.findLast((command) => command.type === "install");
    if (install?.type !== "install") throw new Error("missing reviewed native installation");
    jobs.event(channel, {
      type: "installed",
      pluginId: SAMPLE_ID,
      installationRevision: install.installationRevision,
      artifactSha256,
    });
    const policy: ServicePolicy = {
      serviceId: `${SAMPLE_ID}.broker`,
      revision: "one",
      maxConcurrent: 1,
      runtime: {
        scope: "instance",
        pluginId: SAMPLE_ID,
        operationId,
        installationRevision: install.installationRevision,
        artifactSha256,
        resourceBindingDigest: sha256Hex(canonicalJobJson(null)),
        input: {},
      },
      operations: {
        inspect: {
          method: "GET",
          readable: true,
          path: "/inspect",
          input: {},
          query: {},
          body: [],
          timeoutMs: 1000,
          maxRequestBytes: 1024,
          maxResponseBytes: 4096,
          maxResultBytes: 2048,
          response: { kind: "projected-json", fields: [["state"]], maxArrayItems: 16 },
        },
      },
    };
    const configured = await jobs.configureInstanceService(fixture.owner, {
      serviceId: policy.serviceId,
      expectedRevision: null,
      machineId,
      policy,
      enabled: true,
    });
    const start = commands.find((command) => command.type === "start");
    if (!start || !start.request.service || !configured.configuration)
      throw new Error("reviewed native service did not start");
    const storedPolicy = jobs.readInstanceServiceConfiguration(fixture.owner, {
      serviceId: policy.serviceId,
    }).policy;
    if (!storedPolicy) throw new Error("missing service policy");
    owner.resources = {
      tools: {},
      anchors: {},
      services: { [policy.serviceId]: sha256Hex(canonicalJobJson(storedPolicy)) },
      serviceDefinitions: {
        [policy.serviceId]: { revision: storedPolicy.revision, operationIds: ["inspect"] },
      },
    };
    proveOwner();
    jobs.event(channel, {
      type: "installed",
      pluginId: SAMPLE_ID,
      installationRevision: install.installationRevision,
      artifactSha256,
    });
    jobs.event(channel, {
      type: "state",
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      state: "started",
    });
    jobs.event(channel, {
      type: "service_ready",
      jobId: start.request.jobId,
      service: start.request.service,
    });
    const readService = async () => {
      const pending = host.dispatch(fixture.owner, "engine.services.readInstance", {
        serviceId: policy.serviceId,
        expectedRevision: configured.configuration!.revision,
        operationId: "inspect",
        input: {},
      });
      const command = commands.findLast((command) => command.type === "service_read");
      if (command?.type !== "service_read") throw new Error("native read was not admitted");
      jobs.event(channel, {
        type: "service_authorize",
        subject: { kind: "read", requestId: command.requestId },
        authorizationId: `authorize-${command.requestId}`,
        serviceId: command.serviceId,
        revision: command.revision,
        policySha256: command.policySha256,
        operationId: command.operationId,
      });
      jobs.event(channel, {
        type: "service_read_result",
        requestId: command.requestId,
        reply: {
          type: "service_result",
          requestId: command.requestId,
          ok: true,
          result: { state: "usable" },
        },
      });
      expect(await pending).toEqual({
        ok: true,
        result: {
          type: "service_result",
          requestId: command.requestId,
          ok: true,
          result: { state: "usable" },
        },
      });
    };
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const auth = fixture.auth.authenticate(
          request.headers.get("authorization")?.slice(7) ?? "",
        );
        const path = new URL(request.url).pathname;
        if (path === "/api/plugins")
          return Response.json({ plugins: host.roster(), developerMode: false });
        if (path.startsWith("/api/actions/"))
          return Response.json(
            await host.dispatch(
              auth,
              decodeURIComponent(path.slice("/api/actions/".length)),
              await request.json(),
            ),
          );
        return new Response("not found", { status: 404 });
      },
    });
    return {
      fixture,
      host,
      jobs,
      machineId,
      machine,
      manifest,
      operationId,
      policy,
      first,
      start,
      commands,
      channel,
      owner,
      readService,
      hub: { url: http.url.origin, ownerKey: OWNER_KEY },
      close: () => {
        http.stop(true);
        jobs.offline(channel);
        fixture.store.close();
        rmSync(fixture.dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fixture.store.close();
    rmSync(fixture.dataDir, { recursive: true, force: true });
    throw error;
  }
}

describe("enabled bundle replacement retains native execution", () => {
  test("boot holds preserve native enablement and release readmits the same installation", async () => {
    const f = await retainedServiceFixture({ major: 1, minor: 0 });
    try {
      const before = f.jobs.jobs.installation(f.machineId, SAMPLE_ID)!;
      const configuration = f.jobs.describeInstanceService(f.fixture.owner, {
        serviceId: f.policy.serviceId,
      }).configuration;
      const storage = f.fixture.store.pluginStorage(SAMPLE_ID);
      await storage.stampDataVersion({ major: 99, minor: 0 });
      const rebooted = await customHost(f.fixture, [], { isolates: f.fixture.isolates });
      rebooted.setJobs(f.jobs);
      expect(installedRow(rebooted, SAMPLE_ID).held).toBeDefined();
      expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toEqual({ ...before, ready: false });
      expect(f.jobs.jobs.cancellation(f.start.request.jobId)).not.toBeNull();
      expect(
        f.jobs.describeInstanceService(f.fixture.owner, { serviceId: f.policy.serviceId }),
      ).toMatchObject({ state: "stopping", configuration });
      f.jobs.event(f.channel, {
        type: "installed",
        pluginId: SAMPLE_ID,
        installationRevision: before.revision,
        artifactSha256: before.artifact,
      });
      expect(
        f.jobs.describe(f.fixture.owner, {
          machineId: f.machineId,
          pluginId: SAMPLE_ID,
        }).installation,
      ).toMatchObject({ revision: before.revision, enabled: true, ready: false });
      const fact = {
        jobId: f.start.request.jobId,
        requestDigest: f.start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
      };
      f.jobs.event(f.channel, {
        type: "result",
        result: {
          ...fact,
          state: "cancelled",
          reason: "plugin_held",
          exitCode: null,
          startedAt: f.fixture.runtime.now(),
          finishedAt: f.fixture.runtime.now(),
          usage: null,
          limits: f.start.request.limits,
          outputs: [],
        },
      });
      f.jobs.event(f.channel, { type: "workload_empty", ...fact });
      f.commands.length = 0;
      f.jobs.tick();
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(
        f.jobs.describeInstanceService(f.fixture.owner, { serviceId: f.policy.serviceId }),
      ).toMatchObject({ state: "unavailable", configuration });
      await storage.stampDataVersion(f.manifest.dataVersion ?? { major: 1, minor: 0 });
      const recovered = await customHost(f.fixture, [], { isolates: f.fixture.isolates });
      recovered.setJobs(f.jobs);
      expect(installedRow(recovered, SAMPLE_ID).held).toBeUndefined();
      const install = f.commands.findLast((command) => command.type === "install");
      expect(install).toMatchObject({ installationRevision: before.revision });
      expect(install && "action" in install ? install.action : undefined).toBeUndefined();
      // A disabled owner's same-revision resource report can already be in flight at release.
      f.jobs.event(f.channel, {
        type: "installed",
        pluginId: SAMPLE_ID,
        installationRevision: before.revision,
        artifactSha256: before.artifact,
        resources: {
          artifactAvailable: true,
          tools: [],
          operations: [
            {
              operationId: f.operationId,
              available: false,
              reason: "operation_not_installed",
            },
          ],
        },
      });
      f.jobs.tick();
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      f.jobs.event(f.channel, {
        type: "installed",
        pluginId: SAMPLE_ID,
        installationRevision: before.revision,
        artifactSha256: before.artifact,
        resources: {
          artifactAvailable: true,
          tools: [],
          operations: [{ operationId: f.operationId, available: true }],
        },
      });
      f.jobs.tick();
      const start = f.commands.findLast((command) => command.type === "start");
      expect(start).toBeDefined();
      if (!start) throw new Error("released native service was not readmitted");
      f.jobs.event(f.channel, {
        type: "state",
        jobId: start.request.jobId,
        requestDigest: start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "started",
      });
      f.jobs.event(f.channel, {
        type: "service_ready",
        jobId: start.request.jobId,
        service: start.request.service!,
      });
      expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toEqual(before);
      expect(
        f.jobs.describeInstanceService(f.fixture.owner, { serviceId: f.policy.serviceId }),
      ).toMatchObject({ state: "ready", configuration });
    } finally {
      f.close();
    }
  });

  test.each(["disable-and-purge", "uninstall"] as const)(
    "held native %s revokes installation intent without resurrection on reinstall",
    async (operation) => {
      const f = await retainedServiceFixture();
      try {
        const lifecycle: string[] = [];
        const runner = new FakeRunner((ref) => {
          const loaded = sampleLoad(ref);
          return {
            ...loaded,
            def: { ...loaded.def, actions: [...loaded.def.actions, ...loaded.def.actions] },
            lifecycle: {
              onEnable: () => {
                lifecycle.push("enable");
              },
              onDisable: () => {
                lifecycle.push("disable");
              },
              onPurge: () => {
                lifecycle.push("purge");
              },
            },
          };
        });
        const held = await customHost(f.fixture, [], {
          isolates: { runner, dataDir: f.fixture.dataDir },
        });
        held.setJobs(f.jobs);
        expect(installedRow(held, SAMPLE_ID).held).toBeDefined();
        const native = f.jobs.jobs.installation(f.machineId, SAMPLE_ID)!;
        const fact = {
          jobId: f.start.request.jobId,
          requestDigest: f.start.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
        };
        f.jobs.event(f.channel, {
          type: "result",
          result: {
            ...fact,
            state: "cancelled",
            reason: "plugin_held",
            exitCode: null,
            startedAt: f.fixture.runtime.now(),
            finishedAt: f.fixture.runtime.now(),
            usage: null,
            limits: f.start.request.limits,
            outputs: [],
          },
        });
        f.jobs.event(f.channel, { type: "workload_empty", ...fact });
        f.commands.length = 0;
        if (operation === "disable-and-purge") {
          expect(
            await held.setEnabled(SAMPLE_ID, true, f.fixture.owner.principal.id),
          ).toHaveProperty("refused");
          expect(await held.setEnabled(SAMPLE_ID, false, f.fixture.owner.principal.id)).toEqual({
            ok: true,
          });
          expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toMatchObject({
            revision: native.revision,
            enabled: false,
          });
          expect(await held.purge(SAMPLE_ID, f.fixture.owner.principal.id)).not.toHaveProperty(
            "refused",
          );
        }
        expect(await held.uninstall(SAMPLE_ID, f.fixture.owner.principal.id, false)).toEqual({
          ok: true,
        });
        expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toMatchObject({
          revision: native.revision,
          enabled: false,
        });
        expect(lifecycle).toEqual([]);
        const reinstall = await customHost(f.fixture, [], { isolates: f.fixture.isolates });
        reinstall.setJobs(f.jobs);
        expect(
          (
            await reinstall.dispatch(
              f.fixture.owner,
              ENGINE_INSTALL_ACTION,
              f.fixture.drop(f.manifest),
            )
          ).ok,
        ).toBe(true);
        f.jobs.event(f.channel, {
          type: "installed",
          pluginId: SAMPLE_ID,
          installationRevision: native.revision,
          artifactSha256: native.artifact,
        });
        f.jobs.tick();
        expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toMatchObject({
          revision: native.revision,
          enabled: false,
          ready: false,
        });
        expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
        expect(
          f.commands
            .filter((command) => command.type === "install")
            .every((command) => command.action === "disable" || command.action === "purge"),
        ).toBe(true);
      } finally {
        f.close();
      }
    },
  );

  test("repeated supported replacements preserve one usable broker and its enabled dependent", async () => {
    const f = await retainedServiceFixture();
    try {
      const childId = `${SAMPLE_ID}.part`;
      const child = f.fixture.drop({
        ...SAMPLE_MANIFEST,
        id: childId,
        dependencies: { [SAMPLE_ID]: { type: "required" } },
      });
      expect((await f.host.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, child)).ok).toBe(true);
      await f.readService();
      const before = f.jobs.describe(f.fixture.owner, {
        machineId: f.machineId,
        pluginId: SAMPLE_ID,
      });
      const native = f.jobs.jobs.installation(f.machineId, SAMPLE_ID);
      const policy = f.jobs.readInstanceServiceConfiguration(f.fixture.owner, {
        serviceId: f.policy.serviceId,
      }).policy;
      for (const version of ["2.0.0", "2.0.1", "2.0.2"]) {
        const updated = f.fixture.drop({ ...f.manifest, version });
        expect((await installBundle({ ...updated, hub: f.hub })).outcome).toBe("replaced");
        expect((await installBundle({ ...updated, hub: f.hub })).outcome).toBe("unchanged");
        expect(f.host.enabled(childId)).toBe(true);
        expect(f.fixture.store.disabledPlugins().size).toBe(0);
        expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
          ok: true,
          result: { version },
        });
        f.jobs.tick();
        await f.readService();
        expect(
          f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID }),
        ).toEqual(before);
        expect(f.jobs.jobs.installation(f.machineId, SAMPLE_ID)).toEqual(native);
        expect(f.jobs.jobs.get(f.start.request.jobId)?.request).toEqual(f.start.request);
        expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();
        expect(
          f.jobs.jobs.instanceServiceJobs(f.policy.serviceId).map((job) => job.request.jobId),
        ).toEqual([f.start.request.jobId]);
        expect(
          f.jobs.readInstanceServiceConfiguration(f.fixture.owner, {
            serviceId: f.policy.serviceId,
          }).policy,
        ).toEqual(policy);
        expect(
          f.jobs.describeInstanceService(f.fixture.owner, { serviceId: f.policy.serviceId }).state,
        ).toBe("ready");
      }
    } finally {
      f.close();
    }
  });

  test.each(["assembly", "child-load", "action-collision"] as const)(
    "%s replacement failure restores a callable old module and the same usable native service",
    async (failure) => {
      const f = await retainedServiceFixture();
      try {
        const before = f.jobs.describe(f.fixture.owner, {
          machineId: f.machineId,
          pluginId: SAMPLE_ID,
        });
        const oldRow = f.fixture.store.pluginInstalls();
        const candidate = f.fixture.drop({
          ...f.manifest,
          version:
            failure === "child-load" ? "9.0.0" : failure === "action-collision" ? "8.0.0" : "2.0.0",
          ...(failure === "assembly"
            ? { dependencies: { "vendor.absent": { type: "required" as const } } }
            : {}),
        });
        await expect(installBundle({ ...candidate, hub: f.hub })).rejects.toThrow(
          "artifact_invalid",
        );
        expect(f.fixture.store.pluginInstalls()).toEqual(oldRow);
        expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
          ok: true,
          result: { version: SAMPLE_MANIFEST.version },
        });
        f.jobs.tick();
        await f.readService();
        expect(
          f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID }),
        ).toEqual(before);
        expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();
        expect(
          f.jobs.jobs.instanceServiceJobs(f.policy.serviceId).map((job) => job.request.jobId),
        ).toEqual([f.start.request.jobId]);
        const corrected = f.fixture.drop({ ...f.manifest, version: "2.0.1" });
        expect((await installBundle({ ...corrected, hub: f.hub })).outcome).toBe("replaced");
        await f.readService();
      } finally {
        f.close();
      }
    },
  );

  test("a refused in-realm replacement exposes a surviving child's terminal crash without retiring native execution", async () => {
    const f = await retainedServiceFixture();
    const crashKey = `manifold.test.admission-crash:${f.fixture.dataDir}`;
    const globals = globalThis as Record<symbol, unknown>;
    globals[Symbol.for(crashKey)] = () => f.fixture.runner.report(SAMPLE_ID, "crashed");
    try {
      const oldRow = f.fixture.store.pluginInstalls();
      const native = f.jobs.describe(f.fixture.owner, {
        machineId: f.machineId,
        pluginId: SAMPLE_ID,
      });
      const published: PluginRoster[] = [];
      f.host.onRosterChange((roster) => published.push(roster));
      const candidate = f.fixture.drop(
        { ...f.manifest, version: "2.0.0" },
        {
          "server.js": `
          globalThis[Symbol.for(${JSON.stringify(crashKey)})]();
          throw new Error("candidate admission refused");
        `,
          "web.js": "export {};",
        },
      );
      expect(
        denial(
          await f.host.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, {
            ...candidate,
            hardened: false,
            replace: true,
          }),
        ).message,
      ).toMatch(/^artifact_invalid:/);
      expect(f.fixture.store.pluginInstalls()).toEqual(oldRow);
      expect(installedRow(f.host, SAMPLE_ID)).toMatchObject({
        enabled: true,
        lifecycle: "isolate_crashed",
        manifest: { version: SAMPLE_MANIFEST.version },
      });
      expect(
        published.map((roster) => roster.find((row) => row.manifest.id === SAMPLE_ID)?.lifecycle),
      ).toEqual(["isolate_crashed"]);
      expect(denial(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).rule).toBe(
        "unavailable",
      );
      await f.readService();
      expect(
        f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID }),
      ).toEqual(native);
      expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();

      // A later failed child admission reloads a healthy old module: the earlier terminal
      // state belongs to the retired child, not that newly loaded generation.
      const failedChild = f.fixture.drop({ ...f.manifest, version: "9.0.0" });
      expect(
        denial(
          await f.host.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, {
            ...failedChild,
            replace: true,
          }),
        ).message,
      ).toMatch(/^artifact_invalid:/);
      expect(installedRow(f.host, SAMPLE_ID).lifecycle).toBeUndefined();
      expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
        ok: true,
        result: { version: SAMPLE_MANIFEST.version },
      });
      await f.readService();
    } finally {
      delete globals[Symbol.for(crashKey)];
      f.close();
    }
  });

  test("a successful in-realm replacement does not inherit the old child's admission-time crash", async () => {
    const f = await retainedServiceFixture();
    const crashKey = `manifold.test.admission-crash:${f.fixture.dataDir}`;
    const globals = globalThis as Record<symbol, unknown>;
    globals[Symbol.for(crashKey)] = () => f.fixture.runner.report(SAMPLE_ID, "crashed");
    try {
      const native = f.jobs.describe(f.fixture.owner, {
        machineId: f.machineId,
        pluginId: SAMPLE_ID,
      });
      const published: PluginRoster[] = [];
      f.host.onRosterChange((roster) => published.push(roster));
      const candidate = f.fixture.drop(
        { ...f.manifest, version: "2.0.0" },
        {
          "server.js": `
          import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
          const { defineAction } = globalThis[Symbol.for("manifold.shared")]["@manifold/plugin"];
          globalThis[Symbol.for(${JSON.stringify(crashKey)})]();
          export default {
            actions: [defineAction({
              name: "ping", title: "Ping", caps: ["containers:read"],
              input: z.strictObject({}), result: z.unknown(),
            })],
            handlers: { ping: async () => ({ version: "2.0.0" }) },
          };
        `,
          "web.js": "export {};",
        },
      );
      expect(
        (
          await f.host.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, {
            ...candidate,
            hardened: false,
            replace: true,
          })
        ).ok,
      ).toBe(true);
      expect(installedRow(f.host, SAMPLE_ID).lifecycle).toBeUndefined();
      expect(
        published.map((roster) => roster.find((row) => row.manifest.id === SAMPLE_ID)?.lifecycle),
      ).toEqual([undefined]);
      expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
        ok: true,
        result: { version: "2.0.0" },
      });
      await f.readService();
      expect(
        f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID }),
      ).toEqual(native);
      expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();
    } finally {
      delete globals[Symbol.for(crashKey)];
      f.close();
    }
  });

  test.each(["declaration", "artifact", "resources", "operator-disable"] as const)(
    "%s replacement preserves native execution until an explicit disable and never copies approval",
    async (change) => {
      const f = await retainedServiceFixture();
      try {
        const original = f.jobs.jobs.installation(f.machineId, SAMPLE_ID)!;
        const machine = structuredClone(f.machine);
        if (change === "declaration") machine.operations[f.operationId]!.network = "host";
        else if (change === "artifact") {
          machine.artifacts["linux-x64"]!.sha256 = "c".repeat(64);
          machine.artifacts["linux-x64"]!.entrySha256 = "c".repeat(64);
        } else if (change === "resources") machine.requiresResourceBindings = true;
        const candidate = f.fixture.drop({ ...f.manifest, version: "2.0.0", machine });
        if (change !== "operator-disable") {
          await expect(installBundle({ ...candidate, hub: f.hub })).rejects.toThrow(
            "still_enabled",
          );
          expect(installedRow(f.host, SAMPLE_ID).install?.sha256).toBe(f.first.sha256);
          expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
            ok: true,
            result: { version: f.manifest.version },
          });
          f.jobs.tick();
          await f.readService();
          expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();
          expect(
            f.jobs.describeInstanceService(f.fixture.owner, {
              serviceId: f.policy.serviceId,
            }).state,
          ).toBe("ready");
        }
        expect(await f.host.setEnabled(SAMPLE_ID, false, f.fixture.owner.principal.id)).toEqual({
          ok: true,
        });
        expect((await installBundle({ ...candidate, hub: f.hub })).outcome).toBe("replaced");
        expect(f.host.enabled(SAMPLE_ID)).toBe(false);
        expect(await f.host.setEnabled(SAMPLE_ID, true, f.fixture.owner.principal.id)).toEqual({
          ok: true,
        });
        f.jobs.tick();
        const description = f.jobs.describe(f.fixture.owner, {
          machineId: f.machineId,
          pluginId: SAMPLE_ID,
        });
        expect(description.installation).toMatchObject({
          revision: original.revision,
          artifactSha256: original.artifact,
          enabled: false,
          ready: false,
        });
        expect(description.consents.every((consent) => !consent.enabled)).toBe(true);
        expect(
          f.jobs.describeInstanceService(f.fixture.owner, { serviceId: f.policy.serviceId }).state,
        ).toBe("stopping");
        expect(() =>
          f.jobs.execute(f.fixture.owner, SAMPLE_ID, "new-execution", {
            jobId: "not-approved",
            machineId: f.machineId,
            operationId: f.operationId,
            input: {},
            outputs: [],
          }),
        ).toThrow("installation_changed");
        // Restoring the old declaration is not a hidden re-grant either.
        expect((await installBundle({ ...f.first, hub: f.hub })).outcome).toBe("replaced");
        expect(
          f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID })
            .installation?.enabled,
        ).toBe(false);
      } finally {
        f.close();
      }
    },
  );

  test.each([
    { damage: "missing", disabled: false, failureVersion: "9.0.0" },
    { damage: "tampered", disabled: true, failureVersion: "8.0.0" },
  ] as const)(
    "a $damage boot-unverified bundle repairs without purging data (disabled: $disabled)",
    async ({ damage, disabled, failureVersion }) => {
      const f = await retainedServiceFixture();
      try {
        const storage = f.fixture.store.pluginStorage(SAMPLE_ID);
        await storage.set("value", "retained before restart");
        const stored = f.fixture.store.pluginInstalls()[0];
        if (stored === undefined) throw new Error("no installed bundle");
        await f.fixture.runner.unload(SAMPLE_ID);
        if (damage === "missing") rmSync(stored.bundlePath);
        else writeFileSync(stored.bundlePath, "tampered bundle bytes");

        const runner = new FakeRunner((ref): IsolateLoadResult => {
          if (ref.manifest.version === "9.0.0")
            throw new IsolateLoadError("candidate did not load");
          const loaded = sampleLoad(ref);
          let enabled = false;
          return {
            ...loaded,
            lifecycle: {
              onEnable: () => {
                enabled = true;
              },
              onDisable: () => {
                enabled = false;
              },
            },
            def: {
              ...loaded.def,
              actions:
                ref.manifest.version === "8.0.0"
                  ? [...loaded.def.actions, ...loaded.def.actions]
                  : loaded.def.actions,
              handlers: {
                ...loaded.def.handlers,
                ping: async (ctx) => {
                  if (!enabled) throw new IsolateDenial("unavailable", "child was not enabled");
                  return {
                    version: ref.manifest.version,
                    value: await ctx.storage.get("value"),
                  };
                },
              },
            },
          };
        });
        const rebooted = await customHost(f.fixture, [], {
          isolates: { runner, dataDir: f.fixture.dataDir },
        });
        rebooted.setJobs(f.jobs);
        expect(installedRow(rebooted, SAMPLE_ID)).toMatchObject({
          enabled: true,
          lifecycle: "enable_failed",
          manifest: { version: "unverified" },
          install: {
            sha256: stored.sha256,
            refusal: damage === "missing" ? "artifact_unreadable" : "hash_mismatch",
          },
        });
        expect(runner.loads).toEqual([]);
        expect(denial(await rebooted.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).rule).toBe(
          "unavailable",
        );
        if (disabled)
          expect(await rebooted.setEnabled(SAMPLE_ID, false, f.fixture.owner.principal.id)).toEqual(
            { ok: true },
          );

        const before = installedRow(rebooted, SAMPLE_ID);
        const deniedBefore = await rebooted.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {});
        // Fail both before a child is admitted and after its actions are loaded. Neither
        // path may try to resurrect the unreadable old module or erase its boot refusal.
        const failed = f.fixture.drop({ ...f.manifest, version: failureVersion });
        expect(
          denial(
            await rebooted.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, {
              ...failed,
              replace: true,
            }),
          ).message,
        ).toMatch(/^artifact_invalid:/);
        expect(f.fixture.store.pluginInstalls()).toEqual([stored]);
        expect(installedRow(rebooted, SAMPLE_ID)).toEqual(before);
        expect(await rebooted.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual(
          deniedBefore,
        );
        expect(rebooted.webModule(SAMPLE_ID)).toBeNull();
        expect(await storage.get("value")).toBe("retained before restart");
        expect(runner.state(SAMPLE_ID)).toBe("stopped");

        const repaired = f.fixture.drop({ ...f.manifest, version: "2.0.0" });
        expect(
          (
            await rebooted.dispatch(f.fixture.owner, ENGINE_INSTALL_ACTION, {
              ...repaired,
              replace: true,
            })
          ).ok,
        ).toBe(true);
        expect(installedRow(rebooted, SAMPLE_ID)).toMatchObject({
          enabled: !disabled,
          manifest: { version: "2.0.0" },
          install: { sha256: repaired.sha256 },
        });
        expect(installedRow(rebooted, SAMPLE_ID).install?.refusal).toBeUndefined();
        expect(f.fixture.store.disabledPlugins().has(SAMPLE_ID)).toBe(disabled);
        if (disabled) {
          expect(
            denial(await rebooted.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).rule,
          ).toBe("plugin_disabled");
          expect(rebooted.webModule(SAMPLE_ID)).toBeNull();
          expect(await rebooted.setEnabled(SAMPLE_ID, true, f.fixture.owner.principal.id)).toEqual({
            ok: true,
          });
        }
        expect(await rebooted.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
          ok: true,
          result: { version: "2.0.0", value: "retained before restart" },
        });
        expect(rebooted.webModule(SAMPLE_ID)?.sha256).toBe(repaired.sha256);
        // Even the same candidate machine declaration cannot inherit authority from an
        // unknown old declaration. An assembly enable is not a new native review.
        const native = f.jobs.describe(f.fixture.owner, {
          machineId: f.machineId,
          pluginId: SAMPLE_ID,
        });
        expect(native.installation).toMatchObject({ enabled: false, ready: false });
        expect(native.consents.every((consent) => !consent.enabled)).toBe(true);
        expect(() =>
          f.jobs.execute(f.fixture.owner, SAMPLE_ID, "unverified-repair", {
            jobId: "unreviewed-repair",
            machineId: f.machineId,
            operationId: f.operationId,
            input: {},
            outputs: [],
          }),
        ).toThrow("installation_changed");
      } finally {
        f.close();
      }
    },
  );

  test("in-realm migration failure rolls back data and ledger while the original native service stays usable", async () => {
    const f = await retainedServiceFixture();
    try {
      const server = (migrate: boolean, fail: boolean) => `
        import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
        const { defineAction } = globalThis[Symbol.for("manifold.shared")]["@manifold/plugin"];
        export default {
          actions: [defineAction({
            name: "ping", title: "Read stored data", caps: ["containers:read"],
            input: z.strictObject({}), result: z.unknown(),
          })],
          handlers: { async ping(ctx) {
            return { value: await ctx.storage.get("value"), version: await ctx.storage.dataVersion(),
              migrations: await ctx.storage.appliedMigrations() };
          } },
          migrations: ${
            migrate
              ? `[
            { name: "first", to: { major: 2, minor: 0 }, async migrate(storage) {
              await storage.set("value", "first");
            } },
            { name: "second", to: { major: 3, minor: 0 }, async migrate(storage) {
              await storage.set("value", "second");
              ${fail ? 'throw new Error("migration failed after writing");' : ""}
            } }
          ]`
              : "[]"
          },
        };
      `;
      const first = f.fixture.drop(
        { ...f.manifest, dataVersion: { major: 1, minor: 0 } },
        {
          "server.js": server(false, false),
          "web.js": "export {};",
        },
      );
      expect((await installBundle({ ...first, hardened: false, hub: f.hub })).outcome).toBe(
        "replaced",
      );
      await f.fixture.store.pluginStorage(SAMPLE_ID).set("value", "original");
      const old = f.fixture.store.pluginInstalls();
      const before = f.jobs.describe(f.fixture.owner, {
        machineId: f.machineId,
        pluginId: SAMPLE_ID,
      });
      const next = { ...f.manifest, version: "3.0.0", dataVersion: { major: 3, minor: 0 } };
      const failed = f.fixture.drop(next, {
        "server.js": server(true, true),
        "web.js": "export {};",
      });
      await expect(installBundle({ ...failed, hardened: false, hub: f.hub })).rejects.toThrow(
        "migration failed",
      );
      expect(f.fixture.store.pluginInstalls()).toEqual(old);
      expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
        ok: true,
        result: { value: "original", version: { major: 1, minor: 0 }, migrations: [] },
      });
      await f.readService();
      const corrected = f.fixture.drop(next, {
        "server.js": server(true, false),
        "web.js": "export {};",
      });
      expect((await installBundle({ ...corrected, hardened: false, hub: f.hub })).outcome).toBe(
        "replaced",
      );
      expect(await f.host.dispatch(f.fixture.owner, `${SAMPLE_ID}.ping`, {})).toEqual({
        ok: true,
        result: {
          value: "second",
          version: { major: 3, minor: 0 },
          migrations: ["first", "second"],
        },
      });
      await expect(installBundle({ ...first, hardened: false, hub: f.hub })).rejects.toThrow(
        "major downgrade",
      );
      f.jobs.tick();
      await f.readService();
      expect(
        f.jobs.describe(f.fixture.owner, { machineId: f.machineId, pluginId: SAMPLE_ID }),
      ).toEqual(before);
      expect(f.jobs.jobs.cancellation(f.start.request.jobId)).toBeNull();
    } finally {
      f.close();
    }
  });
});

/**
 * UNPACKED PLUGINS (ADR 0025 §4): the authoring door, the developer-mode switch and the live
 * replace, against a pack that is not the kit's — `Bun.build` cannot run under `bun test` from
 * the repository root (see `packages/plugin-kit/test/pack.test.ts`), so the seam the host
 * exposes for exactly this reason (`IsolateDeps.pack`) is handed a builder that turns the
 * directory's files into the same bundle grammar the kit writes. What these cases defend is
 * the host's part of the loop: the switch's verdicts, the row, the hash, the rollback.
 */

const UNPACKED_ID = "vendor.unpacked";
const UNPACKED_HOOKS = Symbol.for("manifold.test.unpacked-hooks");

/** A server half that records its lifecycle on a process-global array the case reads. */
function unpackedServer(version: string): string {
  return `
    const hooks = (globalThis[Symbol.for("manifold.test.unpacked-hooks")] ??= []);
    export default {
      actions: [],
      handlers: {},
      lifecycle: {
        onEnable: () => { hooks.push("enable:${version}"); },
        onDisable: () => { hooks.push("disable:${version}"); },
      },
    };
  `;
}

function unpackedManifest(extras: Partial<PluginManifest> = {}): string {
  return JSON.stringify({
    id: UNPACKED_ID,
    version: "1.0.0",
    title: "Unpacked",
    description: "authored on this instance",
    capabilities: ["containers:read"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    entry: { server: true, web: "web.js" },
    ...extras,
  });
}

/**
 * The kit's shape without the kit's bundler: `manifest.json` parsed, `server.ts` as the server
 * member, `web.tsx` as the web member, `styles.css` carried as it is when present, a manifest
 * the schema refuses thrown as a build error.
 */
async function fakePack(pluginDir: string, outFile: string): Promise<{ sha256: string }> {
  const manifest: unknown = JSON.parse(readFileSync(join(pluginDir, "manifest.json"), "utf8"));
  const member = (name: string): string =>
    Buffer.from(readFileSync(join(pluginDir, name), "utf8")).toString("base64");
  const files: Record<string, string> = {
    "server.js": member("server.ts"),
    "web.js": member("web.tsx"),
  };
  if (existsSync(join(pluginDir, "styles.css"))) files["styles.css"] = member("styles.css");
  const bytes = Buffer.from(JSON.stringify({ format: 1, hardenedContract: 2, manifest, files }));
  writeFileSync(outFile, bytes);
  return { sha256: sha256Hex(bytes) };
}

function hookLog(): string[] {
  return ((globalThis as Record<symbol, unknown>)[UNPACKED_HOOKS] ??= []) as string[];
}

async function unpackedFixture(): Promise<{ fixture: InstallFixture; host: PluginHost }> {
  const fixture = await installFixture();
  mkdirSync(join(fixture.dataDir, "authored", ".build"), { recursive: true });
  const host = await customHost(fixture, [], {
    isolates: { ...fixture.isolates, pack: fakePack },
  });
  hookLog().length = 0;
  return { fixture, host };
}

describe("PluginHost unpacked plugins", () => {
  test("author builds the directory into an unpacked row pinned at the pack's hash; an edit replaces it live", async () => {
    const { fixture, host } = await unpackedFixture();
    const published: { roster: PluginRoster; developerMode: boolean }[] = [];
    host.onRosterChange((roster, developerMode) => {
      published.push({ roster, developerMode });
    });
    expect(host.developerMode()).toBe(false);
    expect(await host.setDeveloperMode(true, "admin")).toEqual({ ok: true });
    // The flip rides the roster frame: one publish, the switch beside it.
    expect(published.map((entry) => entry.developerMode)).toEqual([true]);
    expect(host.developerMode()).toBe(true);

    const authored = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest(),
          "server.ts": unpackedServer("1.0.0"),
          "web.tsx": "export const web = 1;",
        },
      },
      fixture.owner.principal.id,
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in authored) throw new Error(authored.refused);
    const { bundle } = authoredLayout(fixture.dataDir, UNPACKED_ID);
    // The answer is the row: the install result plus the pin of the bytes the pack wrote.
    expect(authored).toEqual({
      id: UNPACKED_ID,
      version: "1.0.0",
      grantedCaps: ["containers:read"],
      sha256: sha256Hex(readFileSync(bundle)),
    });
    const row = installedRow(host, UNPACKED_ID);
    expect(row.enabled).toBe(true);
    expect(row.install?.mode).toBe("unpacked");
    expect(row.install?.sha256).toBe(authored.sha256);
    expect(row.install?.source).toBe(bundle);
    expect(row.install?.installedBy).toBe(fixture.owner.principal.id);
    expect(fixture.store.pluginInstalls().map((stored) => stored.mode)).toEqual(["unpacked"]);
    expect(hookLog()).toEqual(["enable:1.0.0"]);
    expect(host.webModule(UNPACKED_ID)?.sha256).toBe(authored.sha256);

    // A save that changes nothing replaces nothing: same hash, no publish, no hook.
    const publishes = published.length;
    expect(
      await host.author(
        { id: UNPACKED_ID, files: { "web.tsx": "export const web = 1;" } },
        "someone-else",
        fixture.auth.credentialReference(fixture.owner),
      ),
    ).toEqual(authored);
    expect(published).toHaveLength(publishes);

    // An edit while the row RUNS replaces it live: the old module hears `onDisable`, the new
    // one `onEnable`, the row carries the new hash and the installer who first admitted it —
    // never the later author — and the old artifact leaves the disk.
    const firstBundlePath = fixture.store.pluginInstalls()[0]?.bundlePath ?? "";
    const edited = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest({ version: "2.0.0" }),
          "server.ts": unpackedServer("2.0.0"),
        },
      },
      "someone-else",
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in edited) throw new Error(edited.refused);
    expect(edited.version).toBe("2.0.0");
    expect(edited.sha256).not.toBe(authored.sha256);
    const replaced = installedRow(host, UNPACKED_ID);
    expect(replaced.enabled).toBe(true);
    expect(replaced.manifest.version).toBe("2.0.0");
    expect(replaced.install?.sha256).toBe(edited.sha256);
    expect(replaced.install?.installedBy).toBe(fixture.owner.principal.id);
    expect(hookLog()).toEqual(["enable:1.0.0", "disable:1.0.0", "enable:2.0.0"]);
    expect(existsSync(firstBundlePath)).toBe(false);
    expect(host.webModule(UNPACKED_ID)?.sha256).toBe(edited.sha256);
    fixture.store.close();
  });

  test("an edit the assembly refuses rolls back to the previous row and wakes it again", async () => {
    const { fixture, host } = await unpackedFixture();
    expect(await host.setDeveloperMode(true, "admin")).toEqual({ ok: true });
    const authored = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest(),
          "server.ts": unpackedServer("1.0.0"),
          "web.tsx": "export const web = 1;",
        },
      },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in authored) throw new Error(authored.refused);

    // The edit requires a plugin nobody composed: an `AssemblyError`, answered by name.
    const broken = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest({
            version: "2.0.0",
            dependencies: { "vendor.absent": { type: "required" } },
          }),
        },
      },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    expect(broken).toEqual({
      refused: `artifact_invalid: plugin "${UNPACKED_ID}" requires plugin "vendor.absent", which is not composed`,
    });
    const row = installedRow(host, UNPACKED_ID);
    expect(row.enabled).toBe(true);
    expect(row.manifest.version).toBe("1.0.0");
    expect(row.install?.sha256).toBe(authored.sha256);
    expect(fixture.store.pluginInstalls().map((stored) => stored.sha256)).toEqual([
      authored.sha256,
    ]);
    expect(hookLog()).toEqual(["enable:1.0.0"]);

    // A build that fails (the manifest is not even JSON) is the same class, and the row stands.
    const unbuildable = await host.author(
      { id: UNPACKED_ID, files: { "manifest.json": "{ not json" } },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    expect("refused" in unbuildable && unbuildable.refused.startsWith("artifact_invalid: ")).toBe(
      true,
    );
    expect(installedRow(host, UNPACKED_ID).install?.sha256).toBe(authored.sha256);

    // A manifest naming another id is not the directory it was authored in.
    const impostor = await host.author(
      { id: UNPACKED_ID, files: { "manifest.json": unpackedManifest({ id: "vendor.other" }) } },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    expect(impostor).toEqual({
      refused: `artifact_invalid: manifest id "vendor.other" is not the directory it was authored in, "${UNPACKED_ID}"`,
    });
    fixture.store.close();
  });

  test("an authored sheet that reaches past the root is refused stylesheet_unscoped with the row standing; rooted, it is served at the pin (#258)", async () => {
    const { fixture, host } = await unpackedFixture();
    expect(await host.setDeveloperMode(true, "admin")).toEqual({ ok: true });
    const authored = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest(),
          "server.ts": unpackedServer("1.0.0"),
          "web.tsx": "export const web = 1;",
        },
      },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in authored) throw new Error(authored.refused);

    // The author declares the sheet and writes one that paints the shell: refused by name,
    // through the same install path a bundle meets, and the working row stands at its pin.
    expect(
      await host.author(
        {
          id: UNPACKED_ID,
          files: {
            "manifest.json": unpackedManifest({
              entry: { server: true, web: "web.js", styles: true },
            }),
            "styles.css": ".sidebar-section-title { color: red }",
          },
        },
        "admin",
        fixture.auth.credentialReference(fixture.owner),
      ),
    ).toEqual({
      refused:
        "stylesheet_unscoped: styles.css:1 the leftmost compound is not this plugin's root class (.sidebar-section-title)",
    });
    expect(installedRow(host, UNPACKED_ID).install?.sha256).toBe(authored.sha256);
    expect(host.stylesheet(UNPACKED_ID)).toBeNull();

    const sheet = ".plugin-vendor_unpacked { color: red }";
    const rooted = await host.author(
      { id: UNPACKED_ID, files: { "styles.css": sheet } },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in rooted) throw new Error(rooted.refused);
    expect(rooted.sha256).not.toBe(authored.sha256);
    expect(host.stylesheet(UNPACKED_ID)).toEqual({
      sha256: rooted.sha256,
      bytes: Buffer.from(sheet),
    });
    fixture.store.close();
  });

  test("developer mode off disables every unpacked row first, then refuses enable and author by name", async () => {
    const { fixture, host } = await unpackedFixture();
    // Off, the door refuses before anything is written.
    expect(
      await host.author(
        { id: UNPACKED_ID, files: { "manifest.json": unpackedManifest() } },
        "admin",
        fixture.auth.credentialReference(fixture.owner),
      ),
    ).toEqual({ refused: `developer_mode_off: ${UNPACKED_ID}` });
    expect(existsSync(authoredLayout(fixture.dataDir, UNPACKED_ID).dir)).toBe(false);

    expect(await host.setDeveloperMode(true, "admin")).toEqual({ ok: true });
    const authored = await host.author(
      {
        id: UNPACKED_ID,
        files: {
          "manifest.json": unpackedManifest(),
          "server.ts": unpackedServer("1.0.0"),
          "web.tsx": "export const web = 1;",
        },
      },
      "admin",
      fixture.auth.credentialReference(fixture.owner),
    );
    if ("refused" in authored) throw new Error(authored.refused);
    expect(installedRow(host, UNPACKED_ID).enabled).toBe(true);

    const published: { roster: PluginRoster; developerMode: boolean }[] = [];
    host.onRosterChange((roster, developerMode) => {
      published.push({ roster, developerMode });
    });
    // OFF: the running unpacked row is disabled through the one door, attributed to whoever
    // flipped the switch, BEFORE the switch reads off — then the row is marked by name.
    expect(await host.setDeveloperMode(false, "flipper")).toEqual({ ok: true });
    expect(host.developerMode()).toBe(false);
    expect(hookLog()).toEqual(["enable:1.0.0", "disable:1.0.0"]);
    // Two publishes: the disable (switch still on, nothing marked yet), then the flip.
    expect(published.map((entry) => entry.developerMode)).toEqual([true, false]);
    const off = installedRow(host, UNPACKED_ID);
    expect(off.enabled).toBe(false);
    expect(off.refusal).toBe("developer_mode_off");
    expect(off.changedBy).toBe("flipper");
    expect(await host.setEnabled(UNPACKED_ID, true, "admin")).toEqual({
      refused: `developer_mode_off: ${UNPACKED_ID}`,
    });
    expect(
      await host.author(
        { id: UNPACKED_ID, files: { "web.tsx": "export const web = 2;" } },
        "admin",
        fixture.auth.credentialReference(fixture.owner),
      ),
    ).toEqual({ refused: `developer_mode_off: ${UNPACKED_ID}` });
    expect(installedRow(host, UNPACKED_ID).install?.sha256).toBe(authored.sha256);

    // ON again moves no row: the mark lifts, the row stays where the flip left it.
    expect(await host.setDeveloperMode(true, "admin")).toEqual({ ok: true });
    const back = installedRow(host, UNPACKED_ID);
    expect(back.enabled).toBe(false);
    expect(back.refusal).toBeUndefined();
    expect(await host.setEnabled(UNPACKED_ID, true, "admin")).toEqual({ ok: true });
    expect(hookLog()).toEqual(["enable:1.0.0", "disable:1.0.0", "enable:1.0.0"]);
    fixture.store.close();
  });

  test("setDeveloperMode and author are root only", async () => {
    const { fixture, host } = await unpackedFixture();
    const manager = context(fixture, ["plugins:manage"]);
    expect(
      denial(await host.dispatch(manager, ENGINE_SET_DEVELOPER_MODE_ACTION, { on: true })),
    ).toEqual({ rule: "forbidden", message: "* capability required" });
    expect(
      denial(
        await host.dispatch(manager, ENGINE_AUTHOR_ACTION, {
          id: UNPACKED_ID,
          files: { "manifest.json": unpackedManifest() },
        }),
      ),
    ).toEqual({ rule: "forbidden", message: "* capability required" });
    expect(host.developerMode()).toBe(false);

    expect(
      await host.dispatch(fixture.owner, ENGINE_SET_DEVELOPER_MODE_ACTION, { on: true }),
    ).toEqual({ ok: true, result: {} });
    const outcome = await host.dispatch(fixture.owner, ENGINE_AUTHOR_ACTION, {
      id: UNPACKED_ID,
      files: {
        "manifest.json": unpackedManifest(),
        "server.ts": unpackedServer("1.0.0"),
        "web.tsx": "export const web = 1;",
      },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result).toEqual({
        id: UNPACKED_ID,
        version: "1.0.0",
        grantedCaps: ["containers:read"],
        sha256: installedRow(host, UNPACKED_ID).install?.sha256,
      });
    }
    fixture.store.close();
  });
});

describe("registered native service doors", () => {
  test("invalid reads and configurations never disclose service input or policy bodies in traces", async () => {
    const fixture = await hostFixture();
    try {
      for (const [door, args] of [
        [
          "engine.services.read",
          {
            machineId: "machine",
            serviceId: "private-service",
            revision: "revision",
            policySha256: "a".repeat(64),
            operationId: "read",
            input: { query: "never-persist-input" },
            credential: "never-persist-credential",
          },
        ],
        [
          "engine.services.invoke",
          {
            machineId: "machine",
            serviceId: "private-service",
            revision: "revision",
            policySha256: "a".repeat(64),
            operationId: "write",
            input: { query: "never-persist-input" },
            credential: "never-persist-credential",
          },
        ],
        [
          "engine.services.configureConfiguration",
          {
            machineId: "machine",
            expectedRevision: null,
            policies: [
              { serviceId: "private-service", credential: { ref: "never-persist-reference" } },
            ],
          },
        ],
      ] as const) {
        const outcome = await fixture.host.dispatch(fixture.owner, door, args);
        expect(denial(outcome).rule).toBe("invalid_args");
        const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
        expect(trace?.door).toBe(door);
        expect(trace?.outcome).toBe("invalid_args");
        expect(JSON.stringify(trace)).not.toContain("never-persist");
        expect(JSON.stringify(trace)).not.toContain("private-service");
      }
    } finally {
      fixture.store.close();
    }
  });

  test("native configuration cannot be reached by a non-owner and its denial remains opaque", async () => {
    const fixture = await hostFixture();
    try {
      const reader = context(fixture, ["services:read"]);
      const outcome = await fixture.host.dispatch(
        reader,
        "engine.services.configureConfiguration",
        {
          machineId: "machine",
          expectedRevision: null,
          policies: [{ credential: "never-persist-policy" }],
        },
      );
      expect(denial(outcome).rule).toBe("forbidden");
      const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
      expect(JSON.stringify(trace)).not.toContain("never-persist");
      expect(
        fixture.host.canReadGoverned(fixture.owner, {
          kind: "service",
          machineId: "machine",
          serviceId: "service",
        }),
      ).toBe(false);
    } finally {
      fixture.store.close();
    }
  });
});

describe("registered governed job doors", () => {
  test("malformed private input is refused with an opaque trace before service availability", async () => {
    const fixture = await hostFixture();
    try {
      const outcome = await fixture.host.dispatch(fixture.owner, "engine.jobs.execute", {
        pluginId: "sample.worker",
        jobId: "private-job",
        machineId: "machine",
        operationId: "sample.worker.run",
        input: { secret: "never-persist-this" },
        outputs: [],
        credential: { token: "never-persist-token" },
      });
      expect(denial(outcome).rule).toBe("invalid_args");
      const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
      expect(trace?.door).toBe("engine.jobs.execute");
      expect(trace?.outcome).toBe("invalid_args");
      expect(JSON.stringify(trace)).not.toContain("never-persist");
      expect(JSON.stringify(trace)).not.toContain("private-job");
    } finally {
      fixture.store.close();
    }
  });

  test("a valid registered door fails closed while the durable job service is unavailable", async () => {
    const fixture = await hostFixture();
    try {
      const outcome = await fixture.host.dispatch(fixture.owner, "engine.jobs.status", {
        node: { kind: "job", machineId: "machine", operationId: "sample.worker.run", jobId: "job" },
      });
      expect(denial(outcome).rule).toBe("refused");
      const trace = fixture.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
      expect(trace?.door).toBe("engine.jobs.status");
      expect(trace?.outcome).toBe("refused");
      expect(
        fixture.host.canReadGoverned(fixture.owner, {
          kind: "output",
          machineId: "machine",
          operationId: "sample.worker.run",
          jobId: "job",
          outputId: "out",
        }),
      ).toBe(false);
    } finally {
      fixture.store.close();
    }
  });
});

test("stream close attribution retains the original URI after handler-owned node mutation", async () => {
  const fixture = await hostFixture();
  let producer: StreamProducer | undefined;
  const node = { kind: "plugin" as const, pluginId: "sample.streams" };
  const def: ServerPluginDef = {
    manifest: {
      id: "sample.streams",
      version: "1.0.0",
      title: "Streams",
      description: "Stream attribution fixture",
      capabilities: ["containers:read"],
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        streams: [
          {
            id: "updates",
            title: "Updates",
            body: { type: "integer" },
            nodeKinds: ["plugin"],
            readCapability: "containers:read",
            maxFrameBytes: 128,
            maxRingBytes: 1024,
            maxRingFrames: 4,
            maxInstances: 1,
          },
        ],
      },
    },
    actions: [
      defineAction({
        name: "open",
        title: "Open",
        caps: [],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
    ],
    handlers: {
      open: async (ctx) => {
        producer = ctx.streams.open("sample.streams.updates", node);
        return {};
      },
    },
  };
  try {
    const host = await testPluginHost(
      fixture.store,
      fixture.auth,
      fixture.rooms,
      fixture.broker,
      fixture.runtime,
      { settingsPlugins: [def] },
    );
    expect(await host.dispatch(fixture.owner, "sample.streams.open", {})).toEqual({
      ok: true,
      result: {},
    });
    node.pluginId = "mutated-owner";
    producer?.close();
    const traces = fixture.store
      .listEvents({ type: TRACE_ROW_TYPE, limit: 10 })
      .filter((row) => row.door === "sample.streams.open");
    expect(JSON.stringify(traces)).not.toContain("mutated-owner");
    expect(
      traces
        .filter((row) => JSON.stringify(row.payload).includes("streamLifecycle"))
        .map((row) => row.targets),
    ).toEqual([["manifold://plugin/sample.streams"], ["manifold://plugin/sample.streams"]]);
  } finally {
    producer?.close();
    fixture.store.close();
  }
});

test("a declared read action cannot acquire invocation authority from a root caller through either context bridge", async () => {
  const fixture = await hostFixture();
  const def: ServerPluginDef = {
    manifest: {
      id: "sample.reader",
      version: "1.0.0",
      title: "Reader",
      description: "",
      capabilities: ["services:read"],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "read",
        title: "Read",
        caps: ["services:read"],
        input: z.strictObject({}),
        result: z.strictObject({}),
      }),
    ],
    handlers: {
      read: async (ctx) => {
        const args = {
          machineId: "machine",
          serviceId: "service",
          revision: "r1",
          policySha256: "a".repeat(64),
          operationId: "write",
          input: {},
        };
        await expect(ctx.services.invoke(args)).rejects.toThrow("service_unauthorized");
        await expect(
          serveCtxCall("services.invoke", [args], { kind: "dispatch", ctx }),
        ).rejects.toThrow("service_unauthorized");
        await expect(
          serveCtxCall("services.invoke", [{ ...args, url: "https://injected.invalid" }], {
            kind: "dispatch",
            ctx,
          }),
        ).rejects.toThrow();
        return {};
      },
    },
  };
  try {
    const host = await testPluginHost(
      fixture.store,
      fixture.auth,
      fixture.rooms,
      fixture.broker,
      fixture.runtime,
      { settingsPlugins: [def] },
    );
    expect(await host.dispatch(fixture.owner, "sample.reader.read", {})).toEqual({
      ok: true,
      result: {},
    });
  } finally {
    fixture.store.close();
  }
});
