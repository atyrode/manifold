import { ENGINE_SET_SETTING_ACTION } from "@manifold/plugin";
import type { ActionOutcome } from "@manifold/protocol";
import { describe, expect, test } from "bun:test";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * `engine.plugins.setSetting` — THE ONE DOOR that writes a principal's plugin preferences, and
 * the SHAPE of what it writes.
 *
 * What is defended here is the override map itself, because that map is the durable half of the
 * mechanism: the row rule composes from it at every boot, so "a value the composition can no
 * longer explain" is a bug that outlives the session that made it. Hence the cases: a write
 * lands only where a declaration answers it; the default is stored when a reader CHOOSES it,
 * because "I picked this" outlives a plugin changing its mind; and `null` retracts, leaving the
 * map as empty as it started rather than pinning the default forever.
 */

const OWNER_KEY = "a".repeat(64);

interface Fixture {
  readonly store: ServerStore;
  readonly owner: AuthContext;
  readonly host: PluginHost;
  readonly auth: AuthService;
}

async function fixture(): Promise<Fixture> {
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
    owner,
    auth,
    host: await testPluginHost(store, auth, rooms, broker, runtime, {
      settingsPlugins: [
        {
          manifest: {
            id: "example.settings",
            version: "1.0.0",
            title: "Settings fixture",
            description: "Exercises settings authority and shared storage.",
            capabilities: [],
            contributes: {
              panels: [],
              sections: [],
              elements: [],
              tools: [],
              events: [],
              settings: [
                {
                  id: "mode",
                  title: "Mode",
                  kind: "enum",
                  scope: "workspace",
                  values: [
                    { id: "one", title: "One" },
                    { id: "two", title: "Two" },
                  ],
                  default: "one",
                },
              ],
            },
          },
          actions: [],
          handlers: {},
        },
      ],
    }),
  };
}
/**
 * The least-authority token the mint will issue — `containers:read` is its floor, so this is a
 * visitor who may look and nothing else. It holds none of the authority the other two engine
 * doors demand (`plugins:manage`), which is the point: a preference is the caller's own.
 */
function guest(target: Fixture): AuthContext {
  const grant = target.auth.mintToken(
    { principal: { name: "guest", kind: "human" }, caps: ["containers:read"] },
    target.owner,
  );
  return target.auth.authenticate(grant.token);
}

function refusal(outcome: ActionOutcome): string {
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.denial.message;
}

/**
 * A DECLARED setting from the shipped distribution rather than an invented one: the door
 * validates against the live assembly, so a fixture that made one up would prove nothing about
 * the roster this server actually composes.
 */
const CANVAS_ROW = { plugin: "core.canvas", setting: "new-canvas" } as const;
const CANVAS_REF = "core.canvas.new-canvas";

describe("engine.plugins.setSetting", () => {
  test("workspace writes require authority and are shared with another principal", async () => {
    const target = await fixture();
    const visitor = guest(target);
    const args = { plugin: "example.settings", setting: "mode", value: "two" };
    const ref = "example.settings.mode";
    expect(refusal(await target.host.dispatch(visitor, ENGINE_SET_SETTING_ACTION, args))).toContain(
      "plugins:manage",
    );
    expect(target.store.workspacePluginSetting(ref)).toBeUndefined();
    expect((await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, args)).ok).toBe(
      true,
    );
    expect(target.store.effectivePluginSettings(visitor.principal.id, [ref])).toEqual({
      [ref]: "two",
    });
    expect(target.store.listEvents({ type: "plugin_setting_changed", limit: 10 })).toHaveLength(1);
    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, args);
    expect(target.store.listEvents({ type: "plugin_setting_changed", limit: 10 })).toHaveLength(1);
    expect(target.store.pluginSettings(visitor.principal.id)).toEqual({});
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
    expect(
      (
        await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
          ...args,
          value: "missing",
        })
      ).ok,
    ).toBe(false);
    expect(target.store.workspacePluginSetting(ref)).toBe("two");
    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, { ...args, value: null });
    expect(target.store.effectivePluginSettings(visitor.principal.id, [ref])).toEqual({});
    expect(target.store.listEvents({ type: "plugin_setting_changed", limit: 10 })).toHaveLength(2);
  });
  test("stores the value against the CALLER, keyed by the setting's published ref", async () => {
    const target = await fixture();

    const outcome = await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: false,
    });

    expect(outcome.ok).toBe(true);
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({
      [CANVAS_REF]: false,
    });
  });

  test("needs no capability: it writes the caller, never the workspace", async () => {
    const target = await fixture();
    const visitor = guest(target);

    const outcome = await target.host.dispatch(visitor, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: false,
    });

    expect(outcome.ok).toBe(true);
    expect(target.store.pluginSettings(visitor.principal.id)).toEqual({ [CANVAS_REF]: false });
    // And nobody else's map moved: a preference is not a workspace change.
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
  });

  test("null RETRACTS the opinion, leaving the map as empty as it began", async () => {
    const target = await fixture();
    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: false,
    });

    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: null,
    });

    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
  });

  test("choosing the declared value is STORED, because a choice is not an absence", async () => {
    // `new-canvas` ships true. Writing true explicitly must survive the plugin later shipping
    // false: "I picked this" and "I have no opinion" are different sentences, and only the
    // second one should follow a manifest when it changes its mind.
    const target = await fixture();

    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: true,
    });

    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({ [CANVAS_REF]: true });
  });

  test("writes accumulate as a DELTA rather than replacing the map", async () => {
    const target = await fixture();

    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: false,
    });
    await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      plugin: "core.index",
      setting: "index",
      value: false,
    });

    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({
      "core.canvas.new-canvas": false,
      "core.index.index": false,
    });
  });

  test("refuses a setting the named plugin does not declare, and stores nothing", async () => {
    const target = await fixture();

    const outcome = await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      plugin: "core.canvas",
      setting: "compact",
      value: false,
    });

    expect(refusal(outcome)).toContain("compact");
    expect(refusal(outcome)).toContain("core.canvas");
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
  });

  test("refuses a plugin the roster does not carry", async () => {
    const target = await fixture();

    const outcome = await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      plugin: "core.ghost",
      setting: "new-canvas",
      value: false,
    });

    expect(refusal(outcome)).toContain("core.ghost");
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
  });

  test("refuses an enum string for a boolean declaration before storing it", async () => {
    const target = await fixture();

    const outcome = await target.host.dispatch(target.owner, ENGINE_SET_SETTING_ACTION, {
      ...CANVAS_ROW,
      value: "off",
    });

    expect(outcome.ok).toBe(false);
    expect(target.store.pluginSettings(target.owner.principal.id)).toEqual({});
  });
});
