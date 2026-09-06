import { describe, expect, test } from "bun:test";
import type { Container, TileLayout } from "@manifold/protocol";
import { Y, createSceneDoc } from "@manifold/scene";
import { sha256Hex } from "../src/stores.ts";
import { testStore } from "./helpers.ts";

interface EventRow {
  ts: number;
  type: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXPECTED_MAX_PER_CONTAINER = 10_000;

function documentUpdate(value: number): Uint8Array {
  const doc = createSceneDoc();
  doc.getMap<number>("values").set("value", value);
  return Y.encodeStateAsUpdate(doc);
}

const canvasContainer = (id: string, name: string, createdAt: number): Container => ({
  id,
  name,
  createdAt,
  discipline: "canvas",
});

describe("ServerStore event retention", () => {
  test("addEvent prunes rows older than 30 days using the caller timestamp", () => {
    const store = testStore();
    const now = 40 * DAY_MS;
    store.addEvent("expired-container", now - 30 * DAY_MS - 1, null, "expired", {});
    store.addEvent("active-container", now, null, "current", {});

    const expired = store.db
      .query<EventRow, [string]>("SELECT ts, type FROM events WHERE container_id = ?")
      .all("expired-container");
    expect(expired).toEqual([]);
    store.close();
  });

  test("addEvent keeps only the newest 10,000 rows per container", () => {
    const store = testStore();
    const containerId = "retained-container";
    const now = 40 * DAY_MS;
    for (let index = 0; index <= EXPECTED_MAX_PER_CONTAINER; index += 1) {
      store.addEvent(containerId, now + index, null, `recent-${index}`, {});
    }

    const rows = store.db
      .query<EventRow, [string]>(
        "SELECT ts, type FROM events WHERE container_id = ? ORDER BY ts ASC, id ASC",
      )
      .all(containerId);
    expect(rows).toHaveLength(EXPECTED_MAX_PER_CONTAINER);
    expect(rows[0]).toEqual({ ts: now + 1, type: "recent-1" });
    expect(rows.at(-1)).toEqual({
      ts: now + EXPECTED_MAX_PER_CONTAINER,
      type: `recent-${EXPECTED_MAX_PER_CONTAINER}`,
    });
    expect(rows.some((row) => row.type === "recent-0")).toBeFalse();
    store.close();
  });

  test("a trace row is pruned by the same 30-day window as an event row", () => {
    const store = testStore();
    const now = 40 * DAY_MS;
    const stale = store.appendTrace({
      ts: now - 30 * DAY_MS - 1,
      actor: "principal-1",
      authority: "root",
      door: "test.door.stale",
      containerId: null,
      payload: {},
      session: null,
      outcome: "ok",
      targets: [],
    });
    /*
      ONE RETENTION FOR BOTH FAMILIES is half the argument for the ledger being a row family
      rather than a table of its own (ADR 0018 §1): a second table would have needed a second
      pruning, and two prunings drift the first time either is changed. So writing anything
      must expire an old trace exactly as it expires an old event.
     */
    store.addEvent(null, now, null, "token_revoked", {});

    expect(store.listEvents({ limit: 10 }).some((row) => row.id === stale)).toBeFalse();
    // And the settle cannot resurrect what retention removed: the row is gone, not unsettled.
    expect(store.settleTrace(stale, "failed", [])).toBeFalse();
    store.close();
  });
});

describe("ServerStore index", () => {
  test("orders mixed siblings, nests folders, rejects cycles, and promotes children on delete", () => {
    const store = testStore();
    const alpha = canvasContainer("container-a", "Alpha", 10);
    const beta = canvasContainer("container-b", "Beta", 20);
    const gamma = canvasContainer("container-c", "Gamma", 30);
    store.createContainer(alpha);
    store.createContainer(beta);
    store.createContainer(gamma);

    expect(store.createFolder({ id: "folder-1", name: "Focused", createdAt: 40 }, null)).toBeTrue();
    expect(
      store.createFolder({ id: "folder-2", name: "Nested", createdAt: 50 }, "folder-1"),
    ).toBeTrue();
    expect(
      store.createFolder({ id: "folder-invalid", name: "Invalid", createdAt: 60 }, "missing"),
    ).toBeFalse();

    const siblingIds = (parentId: string | null): string[] =>
      store
        .listIndex()
        .filter((item) => item.parentId === parentId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => (item.kind === "container" ? item.container.id : item.id));

    expect(siblingIds(null)).toEqual([alpha.id, beta.id, gamma.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual(["folder-2"]);

    expect(store.moveIndexEntry({ kind: "folder", id: "folder-1" }, null, 1)).toBeTrue();
    expect(store.moveIndexEntry({ kind: "container", id: gamma.id }, "folder-1", 0)).toBeTrue();
    expect(store.moveIndexEntry({ kind: "container", id: beta.id }, "folder-2", 0)).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual([gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);

    expect(store.moveIndexEntry({ kind: "folder", id: "folder-1" }, "folder-2", 0)).toBeFalse();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);

    expect(store.renameFolder("folder-2", "Deep work")).toBeTrue();
    expect(
      store.listIndex().find((item) => item.kind === "folder" && item.id === "folder-2"),
    ).toMatchObject({ name: "Deep work" });

    expect(store.deleteFolder("folder-1")).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);
    expect(
      new Set(
        store
          .listIndex()
          .map((item) => `${item.kind}:${item.kind === "container" ? item.container.id : item.id}`),
      ).size,
    ).toBe(store.listIndex().length);
    expect(store.getContainer(alpha.id)).toEqual(alpha);
    expect(store.getContainer(beta.id)).toEqual(beta);
    expect(store.getContainer(gamma.id)).toEqual(gamma);
    store.close();
  });
});

describe("ServerStore container discipline", () => {
  test("round-trips the discipline a container wears, which is all its row carries", () => {
    const store = testStore();
    const canvas = canvasContainer("container-a", "Canvas", 10);
    const composition: Container = {
      id: "composition-a",
      name: "Composition",
      createdAt: 20,
      discipline: "composition",
    };
    store.createContainer(canvas);
    store.createContainer(composition);

    // A container row IS the container and `discipline` selects which renderer reads it;
    // there is no lifecycle flag or return address beside it any more, so the row
    // round-trips whole.
    expect(store.getContainer(composition.id)).toEqual(composition);
    expect(store.getContainer(canvas.id)).toEqual(canvas);
    expect(store.listContainers()).toEqual([canvas, composition]);

    expect(store.renameContainer(composition.id, "Renamed")).toEqual({
      ...composition,
      name: "Renamed",
    });
    expect(store.deleteContainer(composition.id)).toBeTrue();
    expect(store.getContainer(composition.id)).toBeNull();
    store.close();
  });
});

describe("ServerStore terminal homes", () => {
  test("a row with no home is rejected at the storage boundary", () => {
    const store = testStore();
    store.createContainer(canvasContainer("container-a", "Canvas", 10));
    /*
      Migration 9 gave every terminal a home and nothing since can take it away — a terminal
      is deleted, never unbound. So a null `container_id` is not a state to tolerate on read:
      it means a write went around the broker, and the boundary says so loudly instead of
      handing the rest of the server a homeless terminal.
     */
    store.db
      .query<void, [string]>(
        `INSERT INTO terminals(id, machine_id, container_id, created_by, agent_principal_id,
                               status, exit_code, created_at, name)
         VALUES (?, 'machine', NULL, 'creator', NULL, 'running', NULL, 1, NULL)`,
      )
      .run("homeless");

    expect(() => store.getTerminal("homeless")).toThrow("homeless has no home composition");
    expect(() => store.listTerminals()).toThrow("homeless has no home composition");
    store.close();
  });

  test("listTerminalsForContainer returns only that container's terminals, in creation order", () => {
    const store = testStore();
    const home: Container = {
      id: "home-a",
      name: "Home A",
      createdAt: 1,
      discipline: "composition",
    };
    const other: Container = {
      id: "home-b",
      name: "Home B",
      createdAt: 2,
      discipline: "composition",
    };
    store.createContainer(home);
    store.createContainer(other);
    const terminal = (id: string, containerId: string, createdAt: number): void => {
      store.createTerminal({
        id,
        machineId: "machine",
        containerId,
        createdBy: "creator",
        agentPrincipalId: `agent-${id}`,
        createdAt,
      });
    };
    terminal("later", home.id, 30);
    terminal("elsewhere", other.id, 20);
    terminal("earlier", home.id, 10);

    // A merged composition homes several terminals, and the order it lists them in is the
    // order they were born — the only ordering left now that the pool's explicit one is gone.
    expect(store.listTerminalsForContainer(home.id).map((row) => row.id)).toEqual([
      "earlier",
      "later",
    ]);
    expect(store.listTerminalsForContainer(other.id).map((row) => row.id)).toEqual(["elsewhere"]);
    expect(store.listTerminalsForContainer("home-never")).toEqual([]);
    expect(store.listTerminalsForContainer(home.id)[0]).toEqual({
      id: "earlier",
      machineId: "machine",
      containerId: home.id,
      createdBy: "creator",
      agentPrincipalId: "agent-earlier",
      name: null,
      status: "running",
      exitCode: null,
      createdAt: 10,
    });
    store.close();
  });
});

describe("ServerStore scene documents", () => {
  test("keeps the newest thirty revisions per container", () => {
    const store = testStore();
    for (let rev = 0; rev < 31; rev += 1) {
      store.saveDoc("container", "epoch", rev, rev, documentUpdate(rev));
    }

    const revisions = store.db
      .query<{ rev: number }, [string]>(
        "SELECT rev FROM scene_docs WHERE container_id = ? ORDER BY rev ASC",
      )
      .all("container")
      .map((row) => row.rev);
    expect(revisions).toHaveLength(30);
    expect(revisions[0]).toBe(1);
    expect(revisions.at(-1)).toBe(30);
    expect(store.latestDoc("container")?.rev).toBe(30);
    store.close();
  });

  test("skips hash-mismatched and undecodable newest rows", () => {
    const store = testStore();
    store.saveDoc("container", "epoch", 1, 1, documentUpdate(1));
    store.saveDoc("container", "epoch", 2, 2, documentUpdate(2));
    store.db
      .query<void, [string, string, number]>(
        "UPDATE scene_docs SET hash = ? WHERE container_id = ? AND rev = ?",
      )
      .run("wrong", "container", 2);

    const invalid: number[] = [];
    expect(store.latestDoc("container", (_error, record) => invalid.push(record.rev))?.rev).toBe(1);
    expect(invalid).toEqual([2]);

    const malformed = Uint8Array.of(255, 255);
    store.db
      .query<void, [Uint8Array, string, string, number]>(
        "UPDATE scene_docs SET doc = ?, hash = ? WHERE container_id = ? AND rev = ?",
      )
      .run(malformed, sha256Hex(malformed), "container", 2);
    invalid.length = 0;
    expect(store.latestDoc("container", (_error, record) => invalid.push(record.rev))?.rev).toBe(1);
    expect(invalid).toEqual([2]);
    store.close();
  });
});

describe("ServerStore plugin enablement", () => {
  test("stores the DISABLED set, so a plugin that ships later is on without a write", () => {
    const store = testStore();

    // D4: enablement is workspace-global shared state, not a per-client preference.
    expect([...store.disabledPlugins()]).toEqual([]);
    store.setPluginEnabled("core.canvas.draw", false, "admin", 10);
    store.setPluginEnabled("core.machines", false, "admin", 20);
    expect([...store.disabledPlugins()].sort()).toEqual(["core.canvas.draw", "core.machines"]);

    // Re-enabling REMOVES the row rather than recording an "enabled" fact: the absence of a
    // plugin from this set is what makes a newly-assembled plugin default to on.
    store.setPluginEnabled("core.canvas.draw", true, "admin", 30);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);
    // Idempotent in both directions — a double toggle is not a second disable.
    store.setPluginEnabled("core.machines", false, "admin", 40);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);
    store.setPluginEnabled("core.canvas.draw", true, "admin", 50);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);

    // Attribution rides along: who changed what, and when, is shared state too — every
    // principal in the workspace can answer "why did that section vanish", not just whoever
    // can read the server's logs.
    expect(store.pluginAttribution().get("core.canvas.draw")).toEqual({ by: "admin", at: 50 });
    expect(store.pluginAttribution().get("core.machines")).toEqual({ by: "admin", at: 40 });
    store.close();
  });

  test("a corrupt enablement row reads as NOTHING disabled, never as everything dark", () => {
    const store = testStore();
    store.setPluginEnabled("core.canvas.draw", false, "admin", 1);

    for (const corrupt of [
      "not json",
      '"core.canvas.draw"',
      "[42]",
      "{}",
      '["", "core.canvas.draw"]',
    ]) {
      store.setMeta("plugins:disabled", corrupt);
      // The failure mode this refuses: one bad meta value booting a workspace with every
      // plugin off, including the shell — a blank screen with no way back in.
      expect([...store.disabledPlugins()]).toEqual([]);
    }

    // And the store recovers the moment a real write lands.
    store.setPluginEnabled("core.canvas.draw", false, "admin", 2);
    expect([...store.disabledPlugins()]).toEqual(["core.canvas.draw"]);
    store.close();
  });

  test("element-type reservations are tombstones: claimed once, released only by purge", () => {
    const store = testStore();

    store.claimElementTypes("core.canvas.draw", ["draw"]);
    // A second claim by the FIRST owner is a no-op, and a later claimant does not steal it:
    // the reservation is what stops a canvas full of `draw` elements from being silently
    // reinterpreted by whatever ships next under that name. Assembly refuses the squat.
    store.claimElementTypes("core.canvas.draw", ["draw"]);
    store.claimElementTypes("evil.draw", ["draw"]);
    expect(store.elementOwners().get("draw")).toBe("core.canvas.draw");

    expect(store.releaseElementTypes("evil.draw")).toBe(0);
    expect(store.releaseElementTypes("core.canvas.draw")).toBe(1);
    expect(store.elementOwners().has("draw")).toBe(false);
    store.close();
  });
});

describe("ServerStore workspace layouts", () => {
  const shell: TileLayout = {
    root: {
      id: "root",
      dir: "row",
      ratios: [0.3, 0.7],
      children: ["side", "main"],
      ref: null,
    },
    side: {
      id: "side",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: "core.shell.sidebar" },
    },
    main: {
      id: "main",
      dir: null,
      ratios: [],
      children: [],
      ref: { kind: "panel", panelId: "core.shell.container-view" },
    },
  };

  test("a shell is stored per principal, and one principal's tree is nobody else's", () => {
    const store = testStore();

    // A2: the workspace layout is per-principal view state that the SERVER holds, so a
    // second device and a driving agent see the same shell — but never each other's.
    expect(store.workspaceLayout("pr-1")).toBeNull();
    store.setWorkspaceLayout("pr-1", shell);
    expect(store.workspaceLayout("pr-1")).toEqual(shell);
    expect(store.workspaceLayout("pr-2")).toBeNull();
    store.close();
  });

  test("a stored shell that went bad reads as null, so the door can hand back the default", () => {
    const store = testStore();
    store.setWorkspaceLayout("pr-1", shell);

    for (const corrupt of [
      "{oops",
      "null",
      "[]",
      // Parses as JSON, fails the schema: a leaf whose ref is not a ref.
      JSON.stringify({ root: { id: "root", dir: null, ratios: [], children: [], ref: 7 } }),
      // Parses AND validates per-node, but is not a tree: a child nothing declares.
      JSON.stringify({
        root: { id: "root", dir: "row", ratios: [1], children: ["ghost"], ref: null },
      }),
    ]) {
      store.setMeta("layout:pr-1", corrupt);
      // Null means "never written" and "unreadable" alike, deliberately: both answers are
      // "give this principal a working workspace", never a blank screen.
      expect(store.workspaceLayout("pr-1")).toBeNull();
    }
    store.close();
  });

  test("a tree the reader would reject is refused on the way IN", () => {
    const store = testStore();

    // Otherwise `core.space.setLayout` could persist a shell that reads back as null, and a
    // principal's next load would silently discard the arrangement they just made.
    expect(() =>
      store.setWorkspaceLayout("pr-1", {
        root: { id: "root", dir: "row", ratios: [1], children: ["ghost"], ref: null },
      }),
    ).toThrow(/not a valid tile tree/);
    expect(() =>
      store.setWorkspaceLayout("pr-1", { root: { id: "mismatched-id" } } as never as TileLayout),
    ).toThrow();
    expect(store.workspaceLayout("pr-1")).toBeNull();
    store.close();
  });
});
