import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_TILE_ID } from "@manifold/protocol";
import {
  ELEMENTS_KEY,
  LAYOUT_KEY,
  Y,
  createSceneDoc,
  readElement,
  readTileLayout,
} from "@manifold/scene";
import { openDatabase, SCHEMA_VERSION } from "../src/db.ts";
import { sha256Hex } from "../src/stores.ts";

interface DocRow {
  pad_id: string;
  epoch: string;
  rev: number;
  hash: string;
  doc: Uint8Array;
}

interface PadRow {
  id: string;
  name: string;
  created_at: number;
  sort_order: number;
  layout: string;
  folder_id: string | null;
}

/** Builds the subset of a schema-v3 database that migration 4 operates on. */
function seedPreV4(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
CREATE TABLE machines(id TEXT PRIMARY KEY, name TEXT, token_id TEXT, last_seen INTEGER);
CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE, principal_id TEXT, caps TEXT,
  pad_id TEXT, created_at INTEGER, revoked_at INTEGER, minted_by TEXT);
CREATE TABLE sessions(id TEXT PRIMARY KEY, machine_id TEXT, pad_id TEXT, element_id TEXT,
  created_by TEXT, status TEXT, exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT);
CREATE TABLE snapshots(pad_id TEXT, epoch TEXT, rev INTEGER, ts INTEGER, hash TEXT, blob TEXT,
  PRIMARY KEY(pad_id, epoch, rev));
CREATE TABLE pads(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, sort_order INTEGER,
  folder_id TEXT);
CREATE TABLE pad_folders(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER,
  parent_folder_id TEXT, sort_order INTEGER);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key, value) VALUES ('schema_version', '3');

-- A legacy pad predates the container discipline entirely: migration 7 must give it
-- the canvas defaults rather than leaving nulls behind.
INSERT INTO pads(id, name, created_at, sort_order, folder_id)
VALUES ('p', 'legacy pad', 1, 0, NULL);

INSERT INTO tokens(id, hash, principal_id, created_at, revoked_at)
VALUES ('t-old', 'h-old', 'm-old', 1, NULL),
       ('t-new', 'h-new', 'm-new', 2, NULL),
       ('t-solo', 'h-solo', 'm-solo', 3, NULL),
       ('t-tie-a', 'h-tie-a', 'm-tie-a', 4, NULL),
       ('t-tie-b', 'h-tie-b', 'm-tie-b', 5, NULL);

-- 'dup-node' exists twice from the pre-#43 always-mint path; the live agent is
-- the most recently seen row. 'tie-node' duplicates share last_seen.
INSERT INTO machines(id, name, token_id, last_seen)
VALUES ('m-old', 'dup-node', 't-old', 100),
       ('m-new', 'dup-node', 't-new', 200),
       ('m-solo', 'solo-node', 't-solo', 50),
       ('m-tie-a', 'tie-node', 't-tie-a', 300),
       ('m-tie-b', 'tie-node', 't-tie-b', 300);

INSERT INTO sessions(id, machine_id, pad_id, element_id, created_by, status, created_at)
VALUES ('s-old', 'm-old', 'p', 'e1', 'c', 'running', 1),
       ('s-new', 'm-new', 'p', 'e2', 'c', 'running', 2),
       ('s-solo', 'm-solo', 'p', 'e3', 'c', 'exited', 3);
`);
  db.close();
}

describe("migration 4: machines.name uniqueness", () => {
  test("retires losers by rename keeping all rows, revokes their tokens, enforces the index", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-migration-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV4(path);
      const db = openDatabase(path);

      const version = db
        .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
        .get();
      expect(version?.value).toBe(String(SCHEMA_VERSION));

      const machines = db
        .query<{ id: string; name: string }, []>("SELECT id, name FROM machines ORDER BY id")
        .all();
      expect(machines).toEqual([
        { id: "m-new", name: "dup-node" },
        // Retired, never deleted: losers keep their row under a collision-proof name.
        { id: "m-old", name: "dup-node#m-old" },
        { id: "m-solo", name: "solo-node" },
        // Equal last_seen: the newer rowid (later enrollment) keeps the bare name.
        { id: "m-tie-a", name: "tie-node#m-tie-a" },
        { id: "m-tie-b", name: "tie-node" },
      ]);

      const revoked = db
        .query<{ id: string; revoked_at: number | null }, []>(
          "SELECT id, revoked_at FROM tokens ORDER BY id",
        )
        .all();
      expect(revoked.filter((row) => row.revoked_at !== null).map((row) => row.id)).toEqual([
        "t-old",
        "t-tie-a",
      ]);

      // Session history is untouched — including sessions of retired machines.
      const sessions = db
        .query<{ id: string }, []>("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((row) => row.id);
      expect(sessions).toEqual(["s-new", "s-old", "s-solo"]);

      expect(() => {
        db.query("INSERT INTO machines(id, name, token_id, last_seen) VALUES (?, ?, ?, ?)").run(
          "m-dup",
          "solo-node",
          "t-x",
          1,
        );
      }).toThrow();

      // Migration 7 made every pre-existing pad a canvas, and migration 9 kept it one while
      // giving each of its three sessions a composition of its own to live in.
      const pads = db
        .query<{ id: string; layout: string }, []>("SELECT id, layout FROM pads ORDER BY id")
        .all();
      expect(pads.filter((pad) => pad.layout === "canvas").map((pad) => pad.id)).toEqual(["p"]);
      expect(pads.filter((pad) => pad.layout === "tiled")).toHaveLength(3);

      // Migration 8: the write-only placement id is gone and the rows that carried it are
      // untouched — a session's placements live in its container's live state now (#59).
      const sessionColumns = db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('sessions')")
        .all()
        .map((row) => row.name);
      expect(sessionColumns).not.toContain("element_id");
      expect(sessionColumns).toContain("pad_id");

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Writes one element the way a pre-cutover client did: a raw `Y.Map` carrying whatever
 * `type` that era used. It cannot go through `writeElement`, because the current
 * `SceneElementSchema` rejects the `terminal` kind this fixture exists to produce.
 */
function rawElement(doc: Y.Doc, id: string, fields: Readonly<Record<string, unknown>>): void {
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(fields)) map.set(key, value);
    doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).set(id, map);
  });
}

const MIRRORED_SESSION = "s-mirrored";
const TILED_SESSION = "s-tiled";
const ORDERED_POOL_SESSION = "s-pool-ordered";
const UNORDERED_POOL_SESSION = "s-pool-unordered";
const CANVAS_PAD = "canvas-1";
const TILED_PAD = "tiled-1";

/** The geometry each surviving element must still carry once it is a portal. */
const PLACED_GEOMETRY = {
  "el-terminal": { x: 10, y: 20, width: 640, height: 400, zIndex: 3 },
  "el-mirror": { x: 700, y: 80, width: 320, height: 240, zIndex: 7 },
} as const;

const NOTE_ELEMENT = {
  id: "el-note",
  type: "text",
  text: "keep me",
  fontSize: 18,
  color: "#2563eb",
  x: 5,
  y: 6,
  width: 240,
  height: 120,
  zIndex: 1,
} as const;

/** A pre-migration canvas document: two mirrors of one terminal, one stale, one note. */
function canvasDoc(): Uint8Array {
  const doc = createSceneDoc();
  rawElement(doc, "el-terminal", {
    id: "el-terminal",
    type: "terminal",
    sessionId: MIRRORED_SESSION,
    ...PLACED_GEOMETRY["el-terminal"],
  });
  // The same session placed twice: both mirrors must end up pointing at ONE home.
  rawElement(doc, "el-mirror", {
    id: "el-mirror",
    type: "terminal",
    sessionId: MIRRORED_SESSION,
    ...PLACED_GEOMETRY["el-mirror"],
  });
  // A session row that no longer exists: there is no container to point at, so the element
  // cannot survive as anything.
  rawElement(doc, "el-stale", {
    id: "el-stale",
    type: "terminal",
    sessionId: "s-ghost",
    x: 1,
    y: 2,
    width: 300,
    height: 200,
    zIndex: 9,
  });
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(NOTE_ELEMENT)) {
      if (key !== "text") map.set(key, value);
    }
    map.set("text", new Y.Text(NOTE_ELEMENT.text));
    doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).set(NOTE_ELEMENT.id, map);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** A pre-migration composition already homing its terminal in a tile leaf. */
function tiledDoc(): Uint8Array {
  const doc = createSceneDoc();
  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set("id", ROOT_TILE_ID);
    root.set("dir", null);
    root.set("ratios", []);
    root.set("children", []);
    root.set("surface", { kind: "terminal", sessionId: TILED_SESSION });
    doc.getMap<Y.Map<unknown>>(LAYOUT_KEY).set(ROOT_TILE_ID, root);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/**
 * A schema-v8 database on disk, holding every shape migration 9 has to move: a canvas
 * carrying terminal elements (including mirrors and a stale one), a composition that already
 * homes its terminal, and two pooled sessions whose retired pool order has to survive as
 * index order.
 */
function seedPreV9(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
CREATE TABLE pads(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, sort_order INTEGER,
  folder_id TEXT, layout TEXT NOT NULL DEFAULT 'canvas', transient INTEGER NOT NULL DEFAULT 0,
  origin_pad_id TEXT);
CREATE TABLE pad_folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  parent_folder_id TEXT, sort_order INTEGER);
CREATE TABLE machines(id TEXT PRIMARY KEY, name TEXT, token_id TEXT, last_seen INTEGER);
CREATE UNIQUE INDEX machines_name_unique ON machines(name);
CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE, principal_id TEXT, caps TEXT,
  pad_id TEXT, created_at INTEGER, revoked_at INTEGER, minted_by TEXT);
CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT, name TEXT, color TEXT,
  created_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, machine_id TEXT, pad_id TEXT, created_by TEXT,
  status TEXT, exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT, name TEXT,
  sort_order INTEGER);
CREATE TABLE scene_docs(pad_id TEXT NOT NULL, epoch TEXT NOT NULL, rev INTEGER NOT NULL,
  ts INTEGER NOT NULL, hash TEXT NOT NULL, doc BLOB NOT NULL,
  PRIMARY KEY (pad_id, epoch, rev));
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, pad_id TEXT, ts INTEGER,
  principal_id TEXT, type TEXT, payload TEXT);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
INSERT INTO meta(key, value) VALUES ('schema_version', '8');

INSERT INTO machines(id, name, token_id, last_seen) VALUES ('m1', 'workhorse', 't1', 1);

-- A canvas, and a composition that was a BUBBLE: the transient flag and its return address
-- are dropped rather than interpreted, because nothing dissolves under anybody any more.
INSERT INTO pads(id, name, created_at, sort_order, folder_id, layout, transient, origin_pad_id)
VALUES ('${CANVAS_PAD}', 'Board', 100, 0, NULL, 'canvas', 0, NULL),
       ('${TILED_PAD}', 'Pair', 200, 1, NULL, 'tiled', 1, '${CANVAS_PAD}');

INSERT INTO sessions(id, machine_id, pad_id, created_by, status, exit_code, created_at,
                     agent_principal_id, name, sort_order)
VALUES ('${MIRRORED_SESSION}', 'm1', '${CANVAS_PAD}', 'creator', 'running', NULL, 310,
          'agent-mirrored', NULL, NULL),
       ('${TILED_SESSION}', 'm1', '${TILED_PAD}', 'creator', 'running', NULL, 320,
          'agent-tiled', NULL, NULL),
       ('${ORDERED_POOL_SESSION}', 'm1', NULL, 'creator', 'exited', 0, 330,
          'agent-ordered', 'named terminal', 5),
       ('${UNORDERED_POOL_SESSION}', 'm1', NULL, 'creator', 'running', NULL, 340,
          'agent-unordered', NULL, NULL);
`);
  const canvas = canvasDoc();
  const tiled = tiledDoc();
  const insert = db.query<void, [string, string, number, number, string, Uint8Array]>(
    "INSERT INTO scene_docs(pad_id, epoch, rev, ts, hash, doc) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // The hash must be the document's own sha256 or the migration refuses to touch the row,
  // which is the corrupt-snapshot path rather than the rewrite this fixture is about.
  insert.run(CANVAS_PAD, "epoch-canvas", 4, 1_000, sha256Hex(canvas), canvas);
  insert.run(TILED_PAD, "epoch-tiled", 2, 1_000, sha256Hex(tiled), tiled);
  db.close();
}

function latestDoc(db: Database, padId: string): DocRow {
  const row = db
    .query<DocRow, [string]>(
      `SELECT pad_id, epoch, rev, hash, doc FROM scene_docs
       WHERE pad_id = ? ORDER BY ts DESC, rev DESC LIMIT 1`,
    )
    .get(padId);
  if (row === null) throw new Error(`no document for ${padId}`);
  return row;
}

function decoded(row: DocRow): Y.Doc {
  const doc = createSceneDoc();
  Y.applyUpdate(doc, row.doc);
  return doc;
}

/** Element ids and their raw `type`, read past the schema so retired kinds are visible. */
function rawTypes(doc: Y.Doc): Record<string, unknown> {
  const types: Record<string, unknown> = {};
  for (const [id, map] of doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).entries()) {
    types[id] = map.get("type");
  }
  return types;
}

describe("migration 9: solo compositions", () => {
  test("homes every terminal, rewrites canvas terminals as portals, and retires pool order", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-solo-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV9(path);
      const db = openDatabase(path);

      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
          ?.value,
      ).toBe("9");
      expect(SCHEMA_VERSION).toBe(9);

      // The state the pool and the bubble needed is gone from the schema, not merely unread:
      // a column nobody may write is a column that cannot drift back into meaning something.
      const columns = (table: string): string[] =>
        db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((row) => row.name);
      expect(columns("pads")).not.toContain("transient");
      expect(columns("pads")).not.toContain("origin_pad_id");
      expect(columns("sessions")).not.toContain("sort_order");
      expect(columns("sessions")).toContain("pad_id");

      // A one-way data move is the one migration whose mistake cannot be undone by running
      // something else afterwards, so the pre-migration image sits beside the database.
      expect(existsSync(`${path}.pre-v9.bak`)).toBeTrue();

      /*
        The headline, and it is TOTAL: no revision anywhere still holds a `terminal` element.
        That kind no longer exists in the element schema, and a room's fallback loading
        deliberately walks back through older revisions — so a survivor sitting behind the
        rewrite could be resurrected and would then have every terminal on the canvas
        silently dropped as invalid instead of failing loudly.
       */
      const docRows = db
        .query<DocRow, []>("SELECT pad_id, epoch, rev, hash, doc FROM scene_docs")
        .all();
      for (const row of docRows) {
        const doc = decoded(row);
        expect(Object.values(rawTypes(doc))).not.toContain("terminal");
        doc.destroy();
      }
      // The canvas's pre-migration revision carried three of them, so it is DELETED rather
      // than left behind the rewrite: the backup beside the database is the recovery path for
      // a one-way move, and a half-converted history is not.
      expect(docRows.map((row) => `${row.pad_id}@${row.rev}`)).not.toContain(`${CANVAS_PAD}@4`);
      // The canvas rewrite, the untouched composition, and one document per new home.
      expect(docRows).toHaveLength(5);

      const canvasRow = latestDoc(db, CANVAS_PAD);
      const canvas = decoded(canvasRow);

      // Each surviving element kept its id and its place on the canvas and only changed what
      // it points at, so every collaborator's reference to it still resolves.
      const homeRow = db
        .query<{ pad_id: string | null }, [string]>("SELECT pad_id FROM sessions WHERE id = ?")
        .get(MIRRORED_SESSION);
      const home = homeRow?.pad_id;
      if (home === undefined || home === null) throw new Error("mirrored session lost its home");
      for (const [id, geometry] of Object.entries(PLACED_GEOMETRY)) {
        expect(readElement(canvas, id)).toEqual({
          id,
          type: "portal",
          containerId: home,
          ...geometry,
        });
      }
      // Two mirrors of one terminal are two references to ONE composition: a terminal lives
      // in exactly one place however many canvases show it.
      expect(rawTypes(canvas)).toEqual({
        "el-terminal": "portal",
        "el-mirror": "portal",
        "el-note": "text",
      });
      // An element naming a session with no row has nothing to reference, so it goes.
      expect(readElement(canvas, "el-stale")).toBeNull();
      // Furniture is not touched at all: same fields, same text, same z-order.
      expect(readElement(canvas, NOTE_ELEMENT.id)).toEqual(NOTE_ELEMENT);

      // A new revision on the SAME epoch: a client resuming from a pre-migration revision
      // resyncs against this instead of silently disagreeing with the server.
      expect(canvasRow.epoch).toBe("epoch-canvas");
      expect(canvasRow.rev).toBe(5);
      expect(canvasRow.hash).toBe(sha256Hex(canvasRow.doc));
      canvas.destroy();

      /*
        Session reachability, which is the migration's whole point: every terminal names a
        composition, and that composition really holds a leaf for it. A terminal that named a
        container with no leaf for it would be homeless in a way no lifecycle rule could fix.
       */
      const homes = db
        .query<{ id: string; pad_id: string | null; layout: string | null }, []>(
          `SELECT s.id AS id, s.pad_id AS pad_id, p.layout AS layout
           FROM sessions s LEFT JOIN pads p ON p.id = s.pad_id ORDER BY s.id`,
        )
        .all();
      expect(homes).toHaveLength(4);
      for (const session of homes) {
        expect(session.pad_id).not.toBeNull();
        expect(session.layout).toBe("tiled");
        const doc = decoded(latestDoc(db, session.pad_id ?? ""));
        const layout = readTileLayout(doc, session.pad_id ?? "");
        const surfaces = Object.values(layout ?? {}).map((node) => node.surface);
        expect(surfaces).toContainEqual({ kind: "terminal", sessionId: session.id });
        doc.destroy();
      }

      // A session already living in a composition was ALREADY homed: no second home is
      // minted for it, which the exact pad count is what proves.
      expect(homes.find((session) => session.id === TILED_SESSION)?.pad_id).toBe(TILED_PAD);
      const pads = db
        .query<PadRow, []>(
          "SELECT id, name, created_at, sort_order, layout, folder_id FROM pads ORDER BY sort_order",
        )
        .all();
      expect(pads).toHaveLength(5);
      expect(pads.filter((pad) => pad.layout === "canvas").map((pad) => pad.id)).toEqual([
        CANVAS_PAD,
      ]);

      const homeOf = (sessionId: string): PadRow => {
        const padId = homes.find((session) => session.id === sessionId)?.pad_id;
        const pad = pads.find((candidate) => candidate.id === padId);
        if (pad === undefined) throw new Error(`no home for ${sessionId}`);
        return pad;
      };

      // The retired pool position became the index position: an operator's ordering of
      // unplaced terminals survives as the order their compositions are listed in, and the
      // rows that never had an explicit position follow in creation order.
      const ordered = homeOf(ORDERED_POOL_SESSION);
      const unordered = homeOf(UNORDERED_POOL_SESSION);
      expect(ordered.sort_order).toBeLessThan(unordered.sort_order);
      expect(homeOf(MIRRORED_SESSION).sort_order).toBeGreaterThan(unordered.sort_order);
      for (const pad of [ordered, unordered]) {
        expect(pad.folder_id).toBeNull();
        expect(pad.layout).toBe("tiled");
      }

      // A home inherits its terminal's label and birth time, so the index reads the same
      // after the upgrade as the pool did before it.
      expect(ordered.name).toBe("named terminal");
      expect(ordered.created_at).toBe(330);
      expect(unordered.name).toBe("workhorse");
      expect(unordered.created_at).toBe(340);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
