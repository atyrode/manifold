import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ROOT_TILE_ID } from "@manifold/protocol";
import { ELEMENTS_KEY, LAYOUT_KEY, Y, createSceneDoc } from "@manifold/scene";

/**
 * Schema 9: every terminal gets a home.
 *
 * This is the data half of the solo-composition cutover, and it is one-way. Before it, a
 * terminal was a `terminal` scene element on some canvas — or nothing at all, floating in a
 * pool of unbound sessions ordered by `sessions.sort_order`. After it, every terminal lives
 * in a composition of its own and a canvas merely REFERENCES that composition through a
 * portal.
 *
 * Three things move, and they have to move together or the workspace is incoherent:
 *   (a) rows      — a solo composition per session that does not already live in one,
 *                   inheriting the session's label and creation time;
 *   (b) documents — every canvas doc's `terminal` elements become `portal` elements onto
 *                   those compositions, keeping id, geometry and z-order, so the canvas
 *                   looks unchanged and collaborators' element references survive;
 *   (c) ordering  — the retired pool position becomes the solo composition's position in
 *                   the index, which is where an unplaced item is listed from now on.
 *
 * A session already living in a tiled container is left alone: it was already homed.
 *
 * The rewrite runs here rather than through `Room` because a room needs live timers, a
 * logger and a session provider, while a migration has a database and nothing else. It
 * also reads and writes the Yjs maps directly: pre-migration elements carry a `type` the
 * current `SceneElementSchema` deliberately rejects, so the typed scene helpers would
 * refuse to see exactly the elements this migration exists to convert.
 */

interface SessionMigrationRow {
  id: string;
  pad_id: string | null;
  machine_id: string;
  name: string | null;
  created_at: number;
}

interface DocMigrationRow {
  epoch: string;
  rev: number;
  hash: string;
  doc: Uint8Array;
}

/** The same row read across every pad at once, for the final terminal-element sweep. */
interface AnyDocMigrationRow extends DocMigrationRow {
  pad_id: string;
}

interface PadMigrationRow {
  id: string;
  layout: string;
}

interface NullableNumberRow {
  value: number | null;
}

interface NullableNameRow {
  name: string | null;
}

/** One rewrite decided before the transaction opens: null target means the element is stale. */
interface ElementRewrite {
  readonly id: string;
  readonly containerId: string | null;
}

function hashOf(doc: Uint8Array): string {
  return createHash("sha256").update(doc).digest("hex");
}

/** A composition document holding exactly one terminal leaf, which is what "solo" means. */
function soloDoc(sessionId: string): Uint8Array {
  const doc = createSceneDoc();
  const layout = doc.getMap<Y.Map<unknown>>(LAYOUT_KEY);
  doc.transact(() => {
    const root = new Y.Map<unknown>();
    root.set("id", ROOT_TILE_ID);
    root.set("dir", null);
    root.set("ratios", []);
    root.set("children", []);
    root.set("surface", { kind: "terminal", sessionId });
    layout.set(ROOT_TILE_ID, root);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/**
 * `path` is unused: the pre-migration snapshot is the runner's job (`openDatabase` takes it
 * outside the transaction, because a VACUUM cannot run inside one). It stays in the
 * signature because every code migration is called the same way, and a migration that DOES
 * need the path should not have to change the shape of the contract to get it.
 */
export function migrateToSoloCompositions(db: Database, path: string): void {
  void path;
  const now = Date.now();
  const insertPad = db.query<void, [string, string, number, number]>(
    `INSERT INTO pads(id, name, created_at, sort_order, folder_id, layout, transient, origin_pad_id)
     VALUES (?, ?, ?, ?, NULL, 'tiled', 0, NULL)`,
  );
  const insertDoc = db.query<void, [string, string, number, number, string, Uint8Array]>(
    `INSERT OR REPLACE INTO scene_docs(pad_id, epoch, rev, ts, hash, doc)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const rehome = db.query<void, [string, string]>("UPDATE sessions SET pad_id = ? WHERE id = ?");
  const machineName = db.query<NullableNameRow, [string]>("SELECT name FROM machines WHERE id = ?");

  const layoutById = new Map<string, string>();
  for (const pad of db.query<PadMigrationRow, []>("SELECT id, layout FROM pads").all()) {
    layoutById.set(pad.id, pad.layout);
  }

  /*
    Homes append past whatever already sits at the index's top level, and pooled sessions
    are ordered first so their retired pool order survives as index order. Everything else
    follows in creation order, which is the order the pool listing used for rows that never
    had an explicit position.
   */
  let position =
    db
      .query<NullableNumberRow, []>(
        "SELECT MAX(sort_order) + 1 AS value FROM pads WHERE folder_id IS NULL",
      )
      .get()?.value ?? 0;
  const homeBySession = new Map<string, string>();
  const sessions = db
    .query<SessionMigrationRow, []>(
      `SELECT id, pad_id, machine_id, name, created_at FROM sessions
       ORDER BY pad_id IS NOT NULL, sort_order IS NULL, sort_order, created_at, id`,
    )
    .all();
  for (const session of sessions) {
    const boundTo = session.pad_id;
    if (boundTo !== null && layoutById.get(boundTo) === "tiled") {
      homeBySession.set(session.id, boundTo);
      continue;
    }
    const homeId = crypto.randomUUID();
    const label = session.name ?? machineName.get(session.machine_id)?.name ?? "terminal";
    insertPad.run(homeId, label, session.created_at, position);
    position += 1;
    const doc = soloDoc(session.id);
    insertDoc.run(homeId, crypto.randomUUID(), 0, now, hashOf(doc), doc);
    rehome.run(homeId, session.id);
    homeBySession.set(session.id, homeId);
  }

  /*
    Canvas documents. Each `terminal` element becomes a `portal` onto its session's home
    under the SAME element id, so anything holding a reference to it keeps working. An
    element naming a session with no row is DROPPED: there is no container for it to point
    at, and leaving it would fail element validation on the next load. The rewrite lands as
    a new revision on the pad's existing epoch, so a client resuming from a pre-migration
    revision resyncs instead of silently disagreeing with the server.
   */
  for (const [padId, layout] of layoutById) {
    if (layout !== "canvas") continue;
    const row = db
      .query<DocMigrationRow, [string]>(
        `SELECT epoch, rev, hash, doc FROM scene_docs
         WHERE pad_id = ? ORDER BY ts DESC, rev DESC LIMIT 1`,
      )
      .get(padId);
    // A corrupt or absent snapshot is left exactly as it is: the room's own fallback
    // loading already walks back through older revisions, and rewriting a document this
    // migration cannot read would destroy the history that recovery depends on.
    if (row === null || hashOf(row.doc) !== row.hash) continue;
    const doc = createSceneDoc();
    try {
      Y.applyUpdate(doc, row.doc);
    } catch {
      doc.destroy();
      continue;
    }
    const elements = doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY);
    const rewrites: ElementRewrite[] = [];
    for (const [id, raw] of elements.entries()) {
      if (raw.get("type") !== "terminal") continue;
      const sessionId = raw.get("sessionId");
      rewrites.push({
        id,
        containerId: typeof sessionId === "string" ? (homeBySession.get(sessionId) ?? null) : null,
      });
    }
    if (rewrites.length === 0) {
      doc.destroy();
      continue;
    }
    doc.transact(() => {
      for (const rewrite of rewrites) {
        const raw = elements.get(rewrite.id);
        if (raw === undefined) continue;
        if (rewrite.containerId === null) {
          elements.delete(rewrite.id);
          continue;
        }
        raw.delete("sessionId");
        raw.set("type", "portal");
        raw.set("containerId", rewrite.containerId);
      }
    });
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    insertDoc.run(padId, row.epoch, row.rev + 1, now, hashOf(update), update);
  }

  /*
    The rewrite lands as a NEW revision, so the pre-cutover ones are still sitting behind it
    — and a room's fallback loading deliberately walks back through older revisions when the
    newest one will not decode. Left alone, that fallback could resurrect a document full of
    element kinds the schema no longer admits, which would quietly drop every terminal on
    the canvas instead of failing loudly.

    So the invariant is made total here: any revision still holding a terminal element is
    deleted, whichever pad it belongs to and whether or not that pad was rewritten. The
    pre-migration backup is the recovery path for a one-way move; a half-converted history
    behind the current revision is not.
   */
  const stale: { readonly padId: string; readonly epoch: string; readonly rev: number }[] = [];
  const allDocs = db
    .query<AnyDocMigrationRow, []>("SELECT pad_id, epoch, rev, hash, doc FROM scene_docs")
    .all();
  for (const row of allDocs) {
    const doc = createSceneDoc();
    try {
      Y.applyUpdate(doc, row.doc);
      for (const [, raw] of doc.getMap<Y.Map<unknown>>(ELEMENTS_KEY).entries()) {
        if (raw.get("type") !== "terminal") continue;
        stale.push({ padId: row.pad_id, epoch: row.epoch, rev: row.rev });
        break;
      }
    } catch {
      // Undecodable either way: `latestDoc` already skips it, so it is nobody's fallback.
    } finally {
      doc.destroy();
    }
  }
  const dropDoc = db.query<void, [string, string, number]>(
    "DELETE FROM scene_docs WHERE pad_id = ? AND epoch = ? AND rev = ?",
  );
  for (const row of stale) dropDoc.run(row.padId, row.epoch, row.rev);

  db.exec(`
ALTER TABLE pads DROP COLUMN transient;
ALTER TABLE pads DROP COLUMN origin_pad_id;
ALTER TABLE sessions DROP COLUMN sort_order;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '9');
`);
}
