import { describe, expect, test } from "bun:test";
import type { Pad, TileLayout } from "@manifold/protocol";
import { Y, createSceneDoc } from "@manifold/scene";
import { sha256Hex } from "../src/stores.ts";
import { testStore } from "./helpers.ts";

interface EventRow {
  ts: number;
  type: string;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXPECTED_MAX_PER_PAD = 10_000;

function documentUpdate(value: number): Uint8Array {
  const doc = createSceneDoc();
  doc.getMap<number>("values").set("value", value);
  return Y.encodeStateAsUpdate(doc);
}

const canvasPad = (id: string, name: string, createdAt: number): Pad => ({
  id,
  name,
  createdAt,
  layout: "canvas",
});

describe("ServerStore event retention", () => {
  test("addEvent prunes rows older than 30 days using the caller timestamp", () => {
    const store = testStore();
    const now = 40 * DAY_MS;
    store.addEvent("expired-pad", now - 30 * DAY_MS - 1, null, "expired", {});
    store.addEvent("active-pad", now, null, "current", {});

    const expired = store.db
      .query<EventRow, [string]>("SELECT ts, type FROM events WHERE pad_id = ?")
      .all("expired-pad");
    expect(expired).toEqual([]);
    store.close();
  });

  test("addEvent keeps only the newest 10,000 rows per pad", () => {
    const store = testStore();
    const padId = "retained-pad";
    const now = 40 * DAY_MS;
    for (let index = 0; index <= EXPECTED_MAX_PER_PAD; index += 1) {
      store.addEvent(padId, now + index, null, `recent-${index}`, {});
    }

    const rows = store.db
      .query<EventRow, [string]>(
        "SELECT ts, type FROM events WHERE pad_id = ? ORDER BY ts ASC, id ASC",
      )
      .all(padId);
    expect(rows).toHaveLength(EXPECTED_MAX_PER_PAD);
    expect(rows[0]).toEqual({ ts: now + 1, type: "recent-1" });
    expect(rows.at(-1)).toEqual({
      ts: now + EXPECTED_MAX_PER_PAD,
      type: `recent-${EXPECTED_MAX_PER_PAD}`,
    });
    expect(rows.some((row) => row.type === "recent-0")).toBeFalse();
    store.close();
  });
});

describe("ServerStore pad tree", () => {
  test("orders mixed siblings, nests folders, rejects cycles, and promotes children on delete", () => {
    const store = testStore();
    const alpha = canvasPad("pad-a", "Alpha", 10);
    const beta = canvasPad("pad-b", "Beta", 20);
    const gamma = canvasPad("pad-c", "Gamma", 30);
    store.createPad(alpha);
    store.createPad(beta);
    store.createPad(gamma);

    expect(
      store.createPadFolder({ id: "folder-1", name: "Focused", createdAt: 40 }, null),
    ).toBeTrue();
    expect(
      store.createPadFolder({ id: "folder-2", name: "Nested", createdAt: 50 }, "folder-1"),
    ).toBeTrue();
    expect(
      store.createPadFolder({ id: "folder-invalid", name: "Invalid", createdAt: 60 }, "missing"),
    ).toBeFalse();

    const siblingIds = (parentId: string | null): string[] =>
      store
        .listPadTree()
        .filter((item) => item.parentId === parentId)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((item) => (item.kind === "pad" ? item.pad.id : item.id));

    expect(siblingIds(null)).toEqual([alpha.id, beta.id, gamma.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual(["folder-2"]);

    expect(store.movePadTreeItem({ kind: "folder", id: "folder-1" }, null, 1)).toBeTrue();
    expect(store.movePadTreeItem({ kind: "pad", id: gamma.id }, "folder-1", 0)).toBeTrue();
    expect(store.movePadTreeItem({ kind: "pad", id: beta.id }, "folder-2", 0)).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);
    expect(siblingIds("folder-1")).toEqual([gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);

    expect(store.movePadTreeItem({ kind: "folder", id: "folder-1" }, "folder-2", 0)).toBeFalse();
    expect(siblingIds(null)).toEqual([alpha.id, "folder-1"]);

    expect(store.renamePadFolder("folder-2", "Deep work")).toBeTrue();
    expect(
      store.listPadTree().find((item) => item.kind === "folder" && item.id === "folder-2"),
    ).toMatchObject({ name: "Deep work" });

    expect(store.deletePadFolder("folder-1")).toBeTrue();
    expect(siblingIds(null)).toEqual([alpha.id, gamma.id, "folder-2"]);
    expect(siblingIds("folder-2")).toEqual([beta.id]);
    expect(
      new Set(
        store
          .listPadTree()
          .map((item) => `${item.kind}:${item.kind === "pad" ? item.pad.id : item.id}`),
      ).size,
    ).toBe(store.listPadTree().length);
    expect(store.getPad(alpha.id)).toEqual(alpha);
    expect(store.getPad(beta.id)).toEqual(beta);
    expect(store.getPad(gamma.id)).toEqual(gamma);
    store.close();
  });
});

describe("ServerStore container discipline", () => {
  test("round-trips the layout a container wears, which is all a pad row carries", () => {
    const store = testStore();
    const canvas = canvasPad("pad-a", "Canvas", 10);
    const composition: Pad = {
      id: "view-a",
      name: "Composition",
      createdAt: 20,
      layout: "tiled",
    };
    store.createPad(canvas);
    store.createPad(composition);

    // A pad row IS the container and `layout` selects its discipline; there is no lifecycle
    // flag or return address beside it any more, so the row round-trips whole.
    expect(store.getPad(composition.id)).toEqual(composition);
    expect(store.getPad(canvas.id)).toEqual(canvas);
    expect(store.listPads()).toEqual([canvas, composition]);

    expect(store.renamePad(composition.id, "Renamed")).toEqual({
      ...composition,
      name: "Renamed",
    });
    expect(store.deletePad(composition.id)).toBeTrue();
    expect(store.getPad(composition.id)).toBeNull();
    store.close();
  });
});

describe("ServerStore terminal homes", () => {
  test("a row with no home is rejected at the storage boundary", () => {
    const store = testStore();
    store.createPad(canvasPad("pad-a", "Canvas", 10));
    /*
      Migration 9 gave every terminal a home and nothing since can take it away — a session
      is deleted, never unbound. So a null `pad_id` is not a state to tolerate on read: it
      means a write went around the broker, and the boundary says so loudly instead of
      handing the rest of the server a homeless terminal.
     */
    store.db
      .query<void, [string]>(
        `INSERT INTO sessions(id, machine_id, pad_id, created_by, agent_principal_id,
                              status, exit_code, created_at, name)
         VALUES (?, 'machine', NULL, 'creator', NULL, 'running', NULL, 1, NULL)`,
      )
      .run("homeless");

    expect(() => store.getSession("homeless")).toThrow("homeless has no home composition");
    expect(() => store.listSessions()).toThrow("homeless has no home composition");
    store.close();
  });

  test("listSessionsForPad returns only that container's terminals, in creation order", () => {
    const store = testStore();
    const home: Pad = { id: "home-a", name: "Home A", createdAt: 1, layout: "tiled" };
    const other: Pad = { id: "home-b", name: "Home B", createdAt: 2, layout: "tiled" };
    store.createPad(home);
    store.createPad(other);
    const session = (id: string, padId: string, createdAt: number): void => {
      store.createSession({
        id,
        machineId: "machine",
        padId,
        createdBy: "creator",
        agentPrincipalId: `agent-${id}`,
        createdAt,
      });
    };
    session("later", home.id, 30);
    session("elsewhere", other.id, 20);
    session("earlier", home.id, 10);

    // A merged composition homes several terminals, and the order it lists them in is the
    // order they were born — the only ordering left now that the pool's explicit one is gone.
    expect(store.listSessionsForPad(home.id).map((row) => row.id)).toEqual(["earlier", "later"]);
    expect(store.listSessionsForPad(other.id).map((row) => row.id)).toEqual(["elsewhere"]);
    expect(store.listSessionsForPad("home-never")).toEqual([]);
    expect(store.listSessionsForPad(home.id)[0]).toEqual({
      id: "earlier",
      machineId: "machine",
      padId: home.id,
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
  test("keeps the newest thirty revisions per pad", () => {
    const store = testStore();
    for (let rev = 0; rev < 31; rev += 1) {
      store.saveDoc("pad", "epoch", rev, rev, documentUpdate(rev));
    }

    const revisions = store.db
      .query<{ rev: number }, [string]>(
        "SELECT rev FROM scene_docs WHERE pad_id = ? ORDER BY rev ASC",
      )
      .all("pad")
      .map((row) => row.rev);
    expect(revisions).toHaveLength(30);
    expect(revisions[0]).toBe(1);
    expect(revisions.at(-1)).toBe(30);
    expect(store.latestDoc("pad")?.rev).toBe(30);
    store.close();
  });

  test("skips hash-mismatched and undecodable newest rows", () => {
    const store = testStore();
    store.saveDoc("pad", "epoch", 1, 1, documentUpdate(1));
    store.saveDoc("pad", "epoch", 2, 2, documentUpdate(2));
    store.db
      .query<void, [string, string, number]>(
        "UPDATE scene_docs SET hash = ? WHERE pad_id = ? AND rev = ?",
      )
      .run("wrong", "pad", 2);

    const invalid: number[] = [];
    expect(store.latestDoc("pad", (_error, record) => invalid.push(record.rev))?.rev).toBe(1);
    expect(invalid).toEqual([2]);

    const malformed = Uint8Array.of(255, 255);
    store.db
      .query<void, [Uint8Array, string, string, number]>(
        "UPDATE scene_docs SET doc = ?, hash = ? WHERE pad_id = ? AND rev = ?",
      )
      .run(malformed, sha256Hex(malformed), "pad", 2);
    invalid.length = 0;
    expect(store.latestDoc("pad", (_error, record) => invalid.push(record.rev))?.rev).toBe(1);
    expect(invalid).toEqual([2]);
    store.close();
  });
});

describe("ServerStore plugin enablement", () => {
  test("stores the DISABLED set, so a plugin that ships later is on without a write", () => {
    const store = testStore();

    // D4: enablement is workspace-global shared state, not a per-client preference.
    expect([...store.disabledPlugins()]).toEqual([]);
    store.setPluginEnabled("core.draw", false, "admin", 10);
    store.setPluginEnabled("core.machines", false, "admin", 20);
    expect([...store.disabledPlugins()].sort()).toEqual(["core.draw", "core.machines"]);

    // Re-enabling REMOVES the row rather than recording an "enabled" fact: the absence of a
    // plugin from this set is what makes a newly-composed plugin default to on.
    store.setPluginEnabled("core.draw", true, "admin", 30);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);
    // Idempotent in both directions — a double toggle is not a second disable.
    store.setPluginEnabled("core.machines", false, "admin", 40);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);
    store.setPluginEnabled("core.draw", true, "admin", 50);
    expect([...store.disabledPlugins()]).toEqual(["core.machines"]);

    // Attribution rides along: who changed what, and when, is shared state too — every
    // principal in the workspace can answer "why did that section vanish", not just whoever
    // can read the server's logs.
    expect(store.pluginAttribution().get("core.draw")).toEqual({ by: "admin", at: 50 });
    expect(store.pluginAttribution().get("core.machines")).toEqual({ by: "admin", at: 40 });
    store.close();
  });

  test("a corrupt enablement row reads as NOTHING disabled, never as everything dark", () => {
    const store = testStore();
    store.setPluginEnabled("core.draw", false, "admin", 1);

    for (const corrupt of ["not json", '"core.draw"', "[42]", "{}", '["", "core.draw"]']) {
      store.setMeta("plugins:disabled", corrupt);
      // The failure mode this refuses: one bad meta value booting a workspace with every
      // plugin off, including the shell — a blank screen with no way back in.
      expect([...store.disabledPlugins()]).toEqual([]);
    }

    // And the store recovers the moment a real write lands.
    store.setPluginEnabled("core.draw", false, "admin", 2);
    expect([...store.disabledPlugins()]).toEqual(["core.draw"]);
    store.close();
  });

  test("element-type reservations are tombstones: claimed once, released only by purge", () => {
    const store = testStore();

    store.claimElementTypes("core.draw", ["draw"]);
    // A second claim by the FIRST owner is a no-op, and a later claimant does not steal it:
    // the reservation is what stops a canvas full of `draw` elements from being silently
    // reinterpreted by whatever ships next under that name. Composition refuses the squat.
    store.claimElementTypes("core.draw", ["draw"]);
    store.claimElementTypes("evil.draw", ["draw"]);
    expect(store.elementOwners().get("draw")).toBe("core.draw");

    expect(store.releaseElementTypes("evil.draw")).toBe(0);
    expect(store.releaseElementTypes("core.draw")).toBe(1);
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
      surface: null,
    },
    side: {
      id: "side",
      dir: null,
      ratios: [],
      children: [],
      surface: { kind: "panel", panelId: "core.shell.sidebar" },
    },
    main: {
      id: "main",
      dir: null,
      ratios: [],
      children: [],
      surface: { kind: "panel", panelId: "core.shell.pad-view" },
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
      // Parses as JSON, fails the schema: a leaf whose surface is not a surface.
      JSON.stringify({ root: { id: "root", dir: null, ratios: [], children: [], surface: 7 } }),
      // Parses AND validates per-node, but is not a tree: a child nothing declares.
      JSON.stringify({
        root: { id: "root", dir: "row", ratios: [1], children: ["ghost"], surface: null },
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

    // Otherwise `core.layout.set` could persist a shell that reads back as null, and a
    // principal's next load would silently discard the arrangement they just made.
    expect(() =>
      store.setWorkspaceLayout("pr-1", {
        root: { id: "root", dir: "row", ratios: [1], children: ["ghost"], surface: null },
      }),
    ).toThrow(/not a valid tile tree/);
    expect(() =>
      store.setWorkspaceLayout("pr-1", { root: { id: "mismatched-id" } } as never as TileLayout),
    ).toThrow();
    expect(store.workspaceLayout("pr-1")).toBeNull();
    store.close();
  });
});
