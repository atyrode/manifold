import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
  container_id: string;
  epoch: string;
  rev: number;
  hash: string;
  doc: Uint8Array;
}

interface ContainerRow {
  id: string;
  name: string;
  created_at: number;
  sort_order: number;
  discipline: string;
  folder_id: string | null;
}

/**
 * Builds the schema-v3 database migration 4 operates on. It carries every v1 table, not only
 * the three this case asserts about, because opening it replays the WHOLE stack: migration 11
 * renames columns on `events` and would fail against a fixture that omitted it.
 */
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
CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT, name TEXT, color TEXT,
  created_at INTEGER);
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, pad_id TEXT, ts INTEGER,
  principal_id TEXT, type TEXT, payload TEXT);
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
      // Terminal history is untouched — including terminals of retired machines.
      const terminals = db
        .query<{ id: string }, []>("SELECT id FROM terminals ORDER BY id")
        .all()
        .map((row) => row.id);
      expect(terminals).toEqual(["s-new", "s-old", "s-solo"]);

      expect(() => {
        db.query("INSERT INTO machines(id, name, token_id, last_seen) VALUES (?, ?, ?, ?)").run(
          "m-dup",
          "solo-node",
          "t-x",
          1,
        );
      }).toThrow();

      // Migration 7 made every pre-existing container a canvas, migration 9 kept it one while
      // giving each of its three terminals a composition of its own, and migration 11 renamed
      // the discipline column and its tiled value.
      const containers = db
        .query<{ id: string; discipline: string }, []>(
          "SELECT id, discipline FROM containers ORDER BY id",
        )
        .all();
      expect(containers.filter((row) => row.discipline === "canvas").map((row) => row.id)).toEqual([
        "p",
      ]);
      expect(containers.filter((row) => row.discipline === "composition")).toHaveLength(3);

      // Migration 8: the write-only placement id is gone and the rows that carried it are
      // untouched — a terminal's placements live in its container's live state now (#59).
      const terminalColumns = db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('terminals')")
        .all()
        .map((row) => row.name);
      expect(terminalColumns).not.toContain("element_id");
      expect(terminalColumns).toContain("container_id");

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

const MIRRORED_TERMINAL = "s-mirrored";
const COMPOSED_TERMINAL = "s-composed";
const ORDERED_POOL_TERMINAL = "s-pool-ordered";
const UNORDERED_POOL_TERMINAL = "s-pool-unordered";
const CANVAS_CONTAINER = "canvas-1";
const COMPOSITION_CONTAINER = "composition-1";

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
    sessionId: MIRRORED_TERMINAL,
    ...PLACED_GEOMETRY["el-terminal"],
  });
  // The same session placed twice: both mirrors must end up pointing at ONE home.
  rawElement(doc, "el-mirror", {
    id: "el-mirror",
    type: "terminal",
    sessionId: MIRRORED_TERMINAL,
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
function compositionDoc(): Uint8Array {
  const doc = createSceneDoc();
  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set("id", ROOT_TILE_ID);
    root.set("dir", null);
    root.set("ratios", []);
    root.set("children", []);
    root.set("surface", { kind: "terminal", sessionId: COMPOSED_TERMINAL });
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
VALUES ('${CANVAS_CONTAINER}', 'Studio', 100, 0, NULL, 'canvas', 0, NULL),
       ('${COMPOSITION_CONTAINER}', 'Pair', 200, 1, NULL, 'tiled', 1, '${CANVAS_CONTAINER}');

INSERT INTO sessions(id, machine_id, pad_id, created_by, status, exit_code, created_at,
                     agent_principal_id, name, sort_order)
VALUES ('${MIRRORED_TERMINAL}', 'm1', '${CANVAS_CONTAINER}', 'creator', 'running', NULL, 310,
          'agent-mirrored', NULL, NULL),
       ('${COMPOSED_TERMINAL}', 'm1', '${COMPOSITION_CONTAINER}', 'creator', 'running', NULL, 320,
          'agent-composed', NULL, NULL),
       ('${ORDERED_POOL_TERMINAL}', 'm1', NULL, 'creator', 'exited', 0, 330,
          'agent-ordered', 'named terminal', 5),
       ('${UNORDERED_POOL_TERMINAL}', 'm1', NULL, 'creator', 'running', NULL, 340,
          'agent-unordered', NULL, NULL);
`);
  const canvas = canvasDoc();
  const composition = compositionDoc();
  const insert = db.query<void, [string, string, number, number, string, Uint8Array]>(
    "INSERT INTO scene_docs(pad_id, epoch, rev, ts, hash, doc) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // The hash must be the document's own sha256 or the migration refuses to touch the row,
  // which is the corrupt-snapshot path rather than the rewrite this fixture is about.
  insert.run(CANVAS_CONTAINER, "epoch-canvas", 4, 1_000, sha256Hex(canvas), canvas);
  insert.run(
    COMPOSITION_CONTAINER,
    "epoch-composition",
    2,
    1_000,
    sha256Hex(composition),
    composition,
  );
  db.close();
}

function latestDoc(db: Database, containerId: string): DocRow {
  const row = db
    .query<DocRow, [string]>(
      `SELECT container_id, epoch, rev, hash, doc FROM scene_docs
       WHERE container_id = ? ORDER BY ts DESC, rev DESC LIMIT 1`,
    )
    .get(containerId);
  if (row === null) throw new Error(`no document for ${containerId}`);
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

      // Migration 9 is a step, not the top of the stack: opening a pre-v9 database runs every
      // later migration too, so the row must equal the CURRENT version rather than this
      // case's own number.
      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
          ?.value,
      ).toBe(String(SCHEMA_VERSION));
      expect(SCHEMA_VERSION).toBe(11);

      // The state the pool and the bubble needed is gone from the schema, not merely unread:
      // a column nobody may write is a column that cannot drift back into meaning something.
      const columns = (table: string): string[] =>
        db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((row) => row.name);
      expect(columns("containers")).not.toContain("transient");
      expect(columns("containers")).not.toContain("origin_pad_id");
      expect(columns("terminals")).not.toContain("sort_order");
      expect(columns("terminals")).toContain("container_id");

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
        .query<DocRow, []>("SELECT container_id, epoch, rev, hash, doc FROM scene_docs")
        .all();
      for (const row of docRows) {
        const doc = decoded(row);
        expect(Object.values(rawTypes(doc))).not.toContain("terminal");
        doc.destroy();
      }
      // The canvas's pre-migration revision carried three of them, so it is DELETED rather
      // than left behind the rewrite: the backup beside the database is the recovery path for
      // a one-way move, and a half-converted history is not.
      expect(docRows.map((row) => `${row.container_id}@${row.rev}`)).not.toContain(
        `${CANVAS_CONTAINER}@4`,
      );
      // The canvas rewrite, the untouched composition, and one document per new home.
      expect(docRows).toHaveLength(5);

      const canvasRow = latestDoc(db, CANVAS_CONTAINER);
      const canvas = decoded(canvasRow);

      // Each surviving element kept its id and its place on the canvas and only changed what
      // it points at, so every collaborator's reference to it still resolves.
      const homeRow = db
        .query<{ container_id: string | null }, [string]>(
          "SELECT container_id FROM terminals WHERE id = ?",
        )
        .get(MIRRORED_TERMINAL);
      const home = homeRow?.container_id;
      if (home === undefined || home === null) throw new Error("mirrored terminal lost its home");
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
        Terminal reachability, which is the migration's whole point: every terminal names a
        composition, and that composition really holds a leaf for it. A terminal that named a
        container with no leaf for it would be homeless in a way no lifecycle rule could fix.

        The leaf is read in POST-11 shape — `ref`, `terminalId` — because migration 11 rewrote
        the documents migration 9 wrote. That is the whole seam between the two: 9 gives every
        terminal a home, 11 renames what the home's leaf calls it.
       */
      const homes = db
        .query<{ id: string; container_id: string | null; discipline: string | null }, []>(
          `SELECT t.id AS id, t.container_id AS container_id, c.discipline AS discipline
           FROM terminals t LEFT JOIN containers c ON c.id = t.container_id ORDER BY t.id`,
        )
        .all();
      expect(homes).toHaveLength(4);
      for (const terminal of homes) {
        expect(terminal.container_id).not.toBeNull();
        expect(terminal.discipline).toBe("composition");
        const doc = decoded(latestDoc(db, terminal.container_id ?? ""));
        const layout = readTileLayout(doc, terminal.container_id ?? "");
        const refs = Object.values(layout ?? {}).map((tile) => tile.ref);
        expect(refs).toContainEqual({ kind: "terminal", terminalId: terminal.id });
        doc.destroy();
      }

      // A terminal already living in a composition was ALREADY homed: no second home is
      // minted for it, which the exact container count is what proves.
      expect(homes.find((terminal) => terminal.id === COMPOSED_TERMINAL)?.container_id).toBe(
        COMPOSITION_CONTAINER,
      );
      const containers = db
        .query<ContainerRow, []>(
          `SELECT id, name, created_at, sort_order, discipline, folder_id FROM containers
           ORDER BY sort_order`,
        )
        .all();
      expect(containers).toHaveLength(5);
      expect(containers.filter((row) => row.discipline === "canvas").map((row) => row.id)).toEqual([
        CANVAS_CONTAINER,
      ]);

      const homeOf = (terminalId: string): ContainerRow => {
        const containerId = homes.find((terminal) => terminal.id === terminalId)?.container_id;
        const container = containers.find((candidate) => candidate.id === containerId);
        if (container === undefined) throw new Error(`no home for ${terminalId}`);
        return container;
      };

      // The retired pool position became the index position: an operator's ordering of
      // unplaced terminals survives as the order their compositions are listed in, and the
      // rows that never had an explicit position follow in creation order.
      const ordered = homeOf(ORDERED_POOL_TERMINAL);
      const unordered = homeOf(UNORDERED_POOL_TERMINAL);
      expect(ordered.sort_order).toBeLessThan(unordered.sort_order);
      expect(homeOf(MIRRORED_TERMINAL).sort_order).toBeGreaterThan(unordered.sort_order);
      for (const container of [ordered, unordered]) {
        expect(container.folder_id).toBeNull();
        expect(container.discipline).toBe("composition");
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

const V10_CANVAS = "canvas-v10";
const V10_COMPOSITION = "composition-v10";
const V10_TERMINAL = "terminal-v10";
const V10_FOLDER = "folder-v10";
const V10_PRINCIPAL = "principal-v10";

/**
 * A composition document exactly as schema 10 wrote one. The retired leaf shape is written as
 * JSON TEXT rather than as an object literal, because that is what it is: bytes a previous
 * release produced, quoted here as data. Spelling it as live syntax would put retired
 * property names back into the tree the lexicon gate reads.
 */
function preLexiconCompositionDoc(): Uint8Array {
  const doc = createSceneDoc();
  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set("id", ROOT_TILE_ID);
    root.set("dir", null);
    root.set("ratios", []);
    root.set("children", []);
    root.set("surface", JSON.parse(`{"kind":"terminal","sessionId":"${V10_TERMINAL}"}`));
    doc.getMap<Y.Map<unknown>>(LAYOUT_KEY).set(ROOT_TILE_ID, root);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** A split whose two leaves hold the two ref forms that MOVED: a terminal and a container. */
function preLexiconSplitDoc(): Uint8Array {
  const doc = createSceneDoc();
  doc.transact(() => {
    const layout = doc.getMap<Y.Map<unknown>>(LAYOUT_KEY);
    const root = new Y.Map<unknown>();
    root.set("id", ROOT_TILE_ID);
    root.set("dir", "row");
    root.set("ratios", [0.5, 0.5]);
    root.set("children", ["t1", "t2"]);
    root.set("surface", null);
    layout.set(ROOT_TILE_ID, root);
    const held = new Y.Map<unknown>();
    held.set("id", "t1");
    held.set("dir", null);
    held.set("ratios", []);
    held.set("children", []);
    held.set("surface", JSON.parse(`{"kind":"pad","padId":"${V10_CANVAS}"}`));
    layout.set("t1", held);
    const vacant = new Y.Map<unknown>();
    vacant.set("id", "t2");
    vacant.set("dir", null);
    vacant.set("ratios", []);
    vacant.set("children", []);
    vacant.set("surface", null);
    layout.set("t2", vacant);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** A canvas document, whose elements the lexicon cut does NOT touch. */
function canvasElementDoc(): Uint8Array {
  const doc = createSceneDoc();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("id", "el-portal");
    map.set("type", "portal");
    map.set("containerId", V10_COMPOSITION);
    map.set("x", 12);
    map.set("y", 24);
    map.set("width", 480);
    map.set("height", 320);
    map.set("zIndex", 2);
    doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).set("el-portal", map);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** The workspace layout a schema-10 shell stored: panel leaves under the retired key. */
const V10_WORKSPACE_LAYOUT = [
  `{"root":{"id":"root","dir":"row","ratios":[0.22,0.78],`,
  `"children":["ws-sidebar","ws-main"],"surface":null},`,
  `"ws-sidebar":{"id":"ws-sidebar","dir":null,"ratios":[],"children":[],`,
  `"surface":{"kind":"panel","panelId":"core.shell.sidebar"}},`,
  `"ws-main":{"id":"ws-main","dir":null,"ratios":[],"children":[],`,
  `"surface":{"kind":"panel","panelId":"core.shell.pad-view"}}}`,
].join("");

/**
 * A schema-10 database on disk: the shape the last release shipped, holding one of everything
 * migration 11 has to move — both container disciplines, a folder, a terminal, tokens carrying
 * the retired capability names, an event row, plugin storage, two revisions of a composition
 * document plus a split and a canvas, and a stored workspace layout.
 */
function seedPreV11(path: string): { readonly canvasHash: string } {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`
CREATE TABLE pads(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER, sort_order INTEGER,
  folder_id TEXT, layout TEXT NOT NULL DEFAULT 'canvas');
CREATE TABLE pad_folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  parent_folder_id TEXT, sort_order INTEGER);
CREATE TABLE machines(id TEXT PRIMARY KEY, name TEXT, token_id TEXT, last_seen INTEGER);
CREATE UNIQUE INDEX machines_name_unique ON machines(name);
CREATE TABLE tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE, principal_id TEXT, caps TEXT,
  pad_id TEXT, created_at INTEGER, revoked_at INTEGER, minted_by TEXT);
CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT, name TEXT, color TEXT,
  created_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY, machine_id TEXT, pad_id TEXT, created_by TEXT,
  status TEXT, exit_code INTEGER, created_at INTEGER, agent_principal_id TEXT, name TEXT);
CREATE TABLE scene_docs(pad_id TEXT NOT NULL, epoch TEXT NOT NULL, rev INTEGER NOT NULL,
  ts INTEGER NOT NULL, hash TEXT NOT NULL, doc BLOB NOT NULL,
  PRIMARY KEY (pad_id, epoch, rev));
CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, pad_id TEXT, ts INTEGER,
  principal_id TEXT, type TEXT, payload TEXT);
CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)) WITHOUT ROWID;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX events_by_timestamp ON events(ts);
CREATE INDEX events_by_pad_recency ON events(pad_id, ts DESC, id DESC);
INSERT INTO meta(key, value) VALUES ('schema_version', '10');
INSERT INTO meta(key, value) VALUES ('plugins:disabled', '["core.draw"]');
INSERT INTO meta(key, value) VALUES ('layout:${V10_PRINCIPAL}', '${V10_WORKSPACE_LAYOUT}');

INSERT INTO principals(id, kind, name, color, created_at)
VALUES ('${V10_PRINCIPAL}', 'human', 'alex', '#1971c2', 10);
INSERT INTO machines(id, name, token_id, last_seen) VALUES ('m1', 'workhorse', 't-machine', 11);

INSERT INTO pad_folders(id, name, created_at, parent_folder_id, sort_order)
VALUES ('${V10_FOLDER}', 'Work', 20, NULL, 0);
INSERT INTO pads(id, name, created_at, sort_order, folder_id, layout)
VALUES ('${V10_CANVAS}', 'Sketch', 30, 1, '${V10_FOLDER}', 'canvas'),
       ('${V10_COMPOSITION}', 'Pair', 40, 2, NULL, 'tiled');
INSERT INTO sessions(id, machine_id, pad_id, created_by, status, exit_code, created_at,
                     agent_principal_id, name)
VALUES ('${V10_TERMINAL}', 'm1', '${V10_COMPOSITION}', '${V10_PRINCIPAL}', 'running', NULL, 50,
        NULL, 'build');

-- Two tokens: a workspace root and a pad-scoped one, both carrying retired cap names. The
-- hashes are what a pasted bearer secret still hashes to, so they must survive untouched.
INSERT INTO tokens(id, hash, principal_id, caps, pad_id, created_at, revoked_at, minted_by)
VALUES ('t-root', 'h-root', '${V10_PRINCIPAL}',
          '["pads:read","pads:write","scene:write","terminal:spawn","terminal:write","tokens:mint"]',
          NULL, 60, NULL, '${V10_PRINCIPAL}'),
       ('t-scoped', 'h-scoped', '${V10_PRINCIPAL}', '["pads:read","scene:write"]',
          '${V10_CANVAS}', 61, NULL, '${V10_PRINCIPAL}'),
       ('t-machine', 'h-machine', '${V10_PRINCIPAL}', '["terminal:spawn"]', NULL, 62, NULL,
          '${V10_PRINCIPAL}');

INSERT INTO events(pad_id, ts, principal_id, type, payload)
VALUES ('${V10_COMPOSITION}', 70, '${V10_PRINCIPAL}', 'terminal.opened', '{}');
INSERT INTO plugin_kv(plugin_id, key, value) VALUES ('core.draw', 'strokes', '3');
`);
  const composition = preLexiconCompositionDoc();
  const split = preLexiconSplitDoc();
  const canvas = canvasElementDoc();
  const canvasHash = sha256Hex(canvas);
  const insert = db.query<void, [string, string, number, number, string, Uint8Array]>(
    "INSERT INTO scene_docs(pad_id, epoch, rev, ts, hash, doc) VALUES (?, ?, ?, ?, ?, ?)",
  );
  // Two revisions of the composition, because a room's fallback loading walks BACK through
  // them: a revision left in the old shape would be resurrectable as an unreadable tree.
  insert.run(V10_COMPOSITION, "epoch-1", 1, 1_000, sha256Hex(composition), composition);
  insert.run(V10_COMPOSITION, "epoch-1", 2, 2_000, sha256Hex(split), split);
  insert.run(V10_CANVAS, "epoch-2", 1, 1_500, canvasHash, canvas);
  db.close();
  // The canvas hash is handed back because a Yjs document's encoding is not reproducible: a
  // fresh doc gets a fresh client id, so byte-identity can only be checked against the bytes
  // that were actually stored.
  return { canvasHash };
}

describe("migration 11: the lexicon cut", () => {
  test("renames the schema, rewrites caps and every stored tile tree, and loses no data", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-lexicon-"));
    const path = join(dir, "manifold.db");
    try {
      const seeded = seedPreV11(path);
      const db = openDatabase(path);

      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
          ?.value,
      ).toBe("11");

      // A one-way move that rewrites the authority column takes its pre-migration image first.
      expect(existsSync(`${path}.pre-v11.bak`)).toBeTrue();

      // The tables carry the canon names and the retired ones are GONE, not shadowed: a
      // lingering `pads` would let a stale query keep working against a dead shape.
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      expect(tables).toContain("containers");
      expect(tables).toContain("container_folders");
      expect(tables).toContain("terminals");
      expect(tables).not.toContain("pads");
      expect(tables).not.toContain("pad_folders");
      expect(tables).not.toContain("sessions");

      const columns = (table: string): string[] =>
        db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(table)
          .map((row) => row.name);
      expect(columns("containers")).toContain("discipline");
      expect(columns("containers")).not.toContain("layout");
      for (const table of ["scene_docs", "events", "tokens", "terminals"]) {
        expect(columns(table)).toContain("container_id");
        expect(columns(table)).not.toContain("pad_id");
      }
      // `scene_docs`' renamed column is part of its primary key, and SQLite moves the key
      // definition with it — so the composite lookup every room does still resolves.
      expect(
        db
          .query<DocRow, [string, string, number]>(
            `SELECT container_id, epoch, rev, hash, doc FROM scene_docs
             WHERE container_id = ? AND epoch = ? AND rev = ?`,
          )
          .get(V10_COMPOSITION, "epoch-1", 2),
      ).not.toBeNull();

      // The index whose NAME carried the retired word is dropped; the store recreates it
      // under the canon name on first use.
      const indexes = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => row.name);
      expect(indexes).not.toContain("events_by_pad_recency");

      /*
        DATA INTACT is the whole claim of a rename-in-place, so it is checked field by field
        rather than by row count: ids, names, birth times, sibling order, folder membership
        and the terminal's home all survive, and only the discipline VALUE moved.
       */
      const containers = db
        .query<ContainerRow, []>(
          `SELECT id, name, created_at, sort_order, discipline, folder_id FROM containers
           ORDER BY sort_order`,
        )
        .all();
      expect(containers).toEqual([
        {
          id: V10_CANVAS,
          name: "Sketch",
          created_at: 30,
          sort_order: 1,
          discipline: "canvas",
          folder_id: V10_FOLDER,
        },
        {
          id: V10_COMPOSITION,
          name: "Pair",
          created_at: 40,
          sort_order: 2,
          // The one value that moved: `tiled` was the discipline's old name for the species
          // the plugin that renders it is called after.
          discipline: "composition",
          folder_id: null,
        },
      ]);
      expect(
        db
          .query<{ id: string; name: string; sort_order: number }, []>(
            "SELECT id, name, sort_order FROM container_folders",
          )
          .all(),
      ).toEqual([{ id: V10_FOLDER, name: "Work", sort_order: 0 }]);
      expect(
        db
          .query<{ id: string; container_id: string | null; name: string | null }, []>(
            "SELECT id, container_id, name FROM terminals",
          )
          .all(),
      ).toEqual([{ id: V10_TERMINAL, container_id: V10_COMPOSITION, name: "build" }]);
      expect(
        db
          .query<{ container_id: string | null; type: string }, []>(
            "SELECT container_id, type FROM events",
          )
          .all(),
      ).toEqual([{ container_id: V10_COMPOSITION, type: "terminal.opened" }]);
      // Plugin storage and the disabled set are namespaced state the lexicon never touched.
      expect(
        db.query<{ value: string }, []>("SELECT value FROM plugin_kv WHERE key = 'strokes'").get()
          ?.value,
      ).toBe("3");
      expect(
        db
          .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'plugins:disabled'")
          .get()?.value,
      ).toBe('["core.draw"]');

      /*
        Capabilities are the reason this migration takes a backup: it rewrites the authority
        column in place. Migrating the rows rather than wiping them is what preserves every
        credential in existence — the raw bearer secret still hashes to the same `hash`, and
        only the cap payload moved — so the hashes are asserted alongside the new names.
       */
      const tokens = db
        .query<{ id: string; hash: string; caps: string; container_id: string | null }, []>(
          "SELECT id, hash, caps, container_id FROM tokens ORDER BY id",
        )
        .all();
      expect(tokens).toEqual([
        { id: "t-machine", hash: "h-machine", caps: '["terminals:spawn"]', container_id: null },
        {
          id: "t-root",
          hash: "h-root",
          caps: '["containers:read","containers:write","scenes:write","terminals:spawn","terminals:write","tokens:mint"]',
          container_id: null,
        },
        {
          id: "t-scoped",
          hash: "h-scoped",
          caps: '["containers:read","scenes:write"]',
          container_id: V10_CANVAS,
        },
      ]);

      /*
        THE DOCUMENT HALF, and the reason this migration is code rather than SQL: a leaf's
        occupant is document data. Every revision is converted — not merely the newest — and
        the proof is that `readTileLayout` PARSES them, because `TileSchema` is strict and a
        surviving `surface` key would answer null and let the next structural write seed an
        empty tree over somebody's composition.
       */
      const docRows = db
        .query<DocRow, []>(
          "SELECT container_id, epoch, rev, hash, doc FROM scene_docs ORDER BY container_id, rev",
        )
        .all();
      expect(docRows).toHaveLength(3);
      for (const row of docRows) {
        expect(row.hash).toBe(sha256Hex(row.doc));
        const doc = decoded(row);
        for (const [, tile] of doc.getMap<Y.Map<unknown>>(LAYOUT_KEY).entries()) {
          expect(tile.has("surface")).toBeFalse();
        }
        doc.destroy();
      }

      const soloRow = docRows.find((row) => row.container_id === V10_COMPOSITION && row.rev === 1);
      if (soloRow === undefined) throw new Error("the composition's first revision is missing");
      const solo = decoded(soloRow);
      expect(readTileLayout(solo, V10_COMPOSITION)).toEqual({
        root: {
          id: ROOT_TILE_ID,
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "terminal", terminalId: V10_TERMINAL },
        },
      });
      solo.destroy();

      const splitRow = docRows.find((row) => row.container_id === V10_COMPOSITION && row.rev === 2);
      if (splitRow === undefined) throw new Error("the composition's second revision is missing");
      const split = decoded(splitRow);
      expect(readTileLayout(split, V10_COMPOSITION)).toEqual({
        root: {
          id: ROOT_TILE_ID,
          dir: "row",
          ratios: [0.5, 0.5],
          children: ["t1", "t2"],
          ref: null,
        },
        // The container form moved BOTH its discriminant and its id field, and the vacant
        // leaf stayed vacant: a null occupant is a drop target, not a missing one.
        t1: {
          id: "t1",
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "container", containerId: V10_CANVAS },
        },
        t2: { id: "t2", dir: null, ratios: [], children: [], ref: null },
      });
      split.destroy();

      // A canvas holds elements rather than tiles, and elements were already canon: the
      // migration must leave that document byte-identical rather than re-encoding it.
      const canvasRow = latestDoc(db, V10_CANVAS);
      expect(canvasRow.hash).toBe(seeded.canvasHash);
      const canvas = decoded(canvasRow);
      expect(readElement(canvas, "el-portal")).toEqual({
        id: "el-portal",
        type: "portal",
        containerId: V10_COMPOSITION,
        x: 12,
        y: 24,
        width: 480,
        height: 320,
        zIndex: 2,
      });
      canvas.destroy();

      /*
        The workspace layout is the same tile shape stored as JSON, so it moves the same way —
        and the one panel id that moved with the lexicon is remapped, because a stored layout
        naming a dead panel would render an inert placeholder where the shell's own view was.
       */
      const workspace = db
        .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
        .get(`layout:${V10_PRINCIPAL}`);
      expect(workspace).not.toBeNull();
      expect(JSON.parse(workspace?.value ?? "null")).toEqual({
        root: {
          id: "root",
          dir: "row",
          ratios: [0.22, 0.78],
          children: ["ws-sidebar", "ws-main"],
          ref: null,
        },
        "ws-sidebar": {
          id: "ws-sidebar",
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "panel", panelId: "core.shell.sidebar" },
        },
        "ws-main": {
          id: "ws-main",
          dir: null,
          ratios: [],
          children: [],
          ref: { kind: "panel", panelId: "core.shell.container-view" },
        },
      });

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh database boots straight to the canon schema, with no migration to replay", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-fresh-"));
    const path = join(dir, "manifold.db");
    try {
      const db = openDatabase(path);
      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
          ?.value,
      ).toBe(String(SCHEMA_VERSION));
      const tables = db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name);
      expect(tables).toContain("containers");
      expect(tables).toContain("terminals");
      expect(tables).not.toContain("pads");
      // Nothing to back up: a database that did not exist has no pre-migration state, so the
      // snapshot is skipped rather than written as an empty file beside a new install.
      expect(existsSync(`${path}.pre-v11.bak`)).toBeFalse();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Every pre-migration image sitting beside the database, sorted. The filter is `.pre-v`
 * rather than `.bak` on purpose: a leaked `.bak.partial` staging file is exactly the leak
 * these tests exist to catch, so it has to show up in the list instead of hiding from it.
 */
function backupsIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.includes(".pre-v"))
    .sort();
}

/** A snapshot is a whole database; these read it back to prove WHICH state it captured. */
function snapshotVersion(file: string): string | undefined {
  const db = new Database(file, { strict: true });
  try {
    return db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get()?.value;
  } finally {
    db.close();
  }
}

function snapshotTables(file: string): string[] {
  const db = new Database(file, { strict: true });
  try {
    return db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("pre-migration snapshot retention", () => {
  test("one image per backed-up version, each capturing the state before its own migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-retention-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV9(path);
      openDatabase(path).close();

      // Two backed-up migrations replayed, two images, no third file: `VACUUM INTO` cannot
      // overwrite, so the staging name has to be gone by the time the runner returns.
      expect(backupsIn(dir)).toEqual(["manifold.db.pre-v11.bak", "manifold.db.pre-v9.bak"]);

      // Each image is PRE its own migration, not a copy of the finished database — which is
      // the only property that makes it worth keeping.
      expect(snapshotVersion(`${path}.pre-v9.bak`)).toBe("8");
      expect(snapshotVersion(`${path}.pre-v11.bak`)).toBe("10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed migration keeps its image, and the retry replaces its own version only", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-db-retry-"));
    const path = join(dir, "manifold.db");
    try {
      seedPreV9(path);
      // A hand repair left a table under the name migration 11 renames into, so
      // `ALTER TABLE pads RENAME TO containers` fails. 9 and 10 commit first — which is
      // precisely the state a retry starts from: schema 10 on disk, `pre-v11.bak` written.
      const botched = new Database(path, { strict: true });
      botched.exec("CREATE TABLE containers(id TEXT PRIMARY KEY)");
      botched.close();

      expect(() => openDatabase(path)).toThrow();

      // The image the failed attempt took survives the failure, under the published name and
      // at the version it was taken for. An attempt that destroyed its own snapshot on the
      // way out would leave an operator with nothing to recover to.
      expect(snapshotVersion(`${path}.pre-v11.bak`)).toBe("10");
      expect(snapshotTables(`${path}.pre-v11.bak`)).toContain("containers");
      const elder = readFileSync(`${path}.pre-v9.bak`);

      const repaired = new Database(path, { strict: true });
      repaired.exec("DROP TABLE containers");
      repaired.close();
      const db = openDatabase(path);
      expect(
        db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get()
          ?.value,
      ).toBe("11");
      db.close();

      // Still one image for version 11, not two: a retried version replaces its predecessor
      // rather than leaving a full copy of the database per attempt.
      expect(backupsIn(dir)).toEqual(["manifold.db.pre-v11.bak", "manifold.db.pre-v9.bak"]);
      // And the survivor is the RETRY's image, not the failed attempt's — the stray table the
      // first attempt tripped over is absent from it.
      expect(snapshotTables(`${path}.pre-v11.bak`)).not.toContain("containers");
      expect(snapshotTables(`${path}.pre-v11.bak`)).toContain("pads");
      // An elder version's image is the operator's recovery inventory: byte for byte untouched
      // by a later migration, a failure, or a retry.
      expect(readFileSync(`${path}.pre-v9.bak`)).toEqual(elder);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
