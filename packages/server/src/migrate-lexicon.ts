import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { LAYOUT_KEY, Y, createSceneDoc } from "@manifold/scene";

/**
 * Schema 11: the lexicon cut, applied to durable state.
 *
 * The tree now speaks one vocabulary — a container has a discipline, a PTY is a terminal, a
 * leaf holds a ref — and the database is the last place still speaking the old one. This
 * migration is one-way and it rewrites the AUTHORITY column (`tokens.caps`), so it takes a
 * pre-migration snapshot (`backup: true`) exactly as schema 9 did.
 *
 * It is CODE rather than plain SQL for one reason, and it is not a stylistic one: two of the
 * renamed names are DOCUMENT data, not schema.
 *
 *   (a) `containers`/`container_folders`/`terminals`, the `container_id` columns and
 *       `containers.discipline` are SQL, and `ALTER TABLE ... RENAME` moves them — including
 *       inside `scene_docs`' primary key, which SQLite rewrites for us.
 *   (b) a composition's tile table lives in its Yjs document, where each leaf stored its
 *       occupant under the key `surface` as `{kind:"pad",padId}` or
 *       `{kind:"terminal",sessionId}`. The canon shape is `ref` holding
 *       `{kind:"container",containerId}` / `{kind:"terminal",terminalId}`, and `TileSchema`
 *       is strict — so a document left alone would fail to parse, `readTileLayout` would
 *       answer null, and the next structural write would seed an EMPTY tree over somebody's
 *       composition. Renaming the schema without rewriting the documents is silent data
 *       loss, which is why both halves ride one transaction.
 *   (c) the same shape is stored again, as JSON, in the per-principal workspace layout
 *       (`meta` key `layout:<principalId>`), whose leaves are panels — so the shell's own
 *       tree needs the same rewrite, plus the one panel id that moved with the lexicon.
 *
 * Every revision of every document is converted, not merely the newest: a room's fallback
 * loading deliberately walks back through older revisions when the newest will not decode,
 * so a half-converted history would let one bad snapshot resurrect a tree nothing can read.
 * The conversion is a pure rename, so every revision converts faithfully.
 */

/** The panel id that moved with the lexicon; stored workspace layouts still name the old one. */
const PANEL_ID_RENAMES: Readonly<Record<string, string>> = {
  "core.shell.pad-view": "core.shell.container-view",
};

const SCHEMA_SQL = `
-- Nothing to reclaim: migration 9 already dropped pads.transient, pads.origin_pad_id
-- and sessions.sort_order (migrate-solo.ts).
ALTER TABLE pads RENAME COLUMN layout TO discipline;
UPDATE pads SET discipline = 'composition' WHERE discipline = 'tiled';
ALTER TABLE pads RENAME TO containers;
ALTER TABLE pad_folders RENAME TO container_folders;
ALTER TABLE sessions RENAME TO terminals;
ALTER TABLE scene_docs RENAME COLUMN pad_id TO container_id;
ALTER TABLE events    RENAME COLUMN pad_id TO container_id;
ALTER TABLE tokens    RENAME COLUMN pad_id TO container_id;
ALTER TABLE terminals RENAME COLUMN pad_id TO container_id;
-- Capabilities are stored as a JSON array of strings, so the rename is a textual one on a
-- closed vocabulary: five names in, five names out, and a cap this workspace never issued
-- cannot be produced by a replace that has nothing to match.
UPDATE tokens SET caps = replace(replace(replace(replace(caps,
  '"pads:read"','"containers:read"'), '"pads:write"','"containers:write"'),
  '"scene:write"','"scenes:write"'), '"terminal:spawn"','"terminals:spawn"');
UPDATE tokens SET caps = replace(caps, '"terminal:write"','"terminals:write"');
-- The event index is created lazily by the store under its canon name; the old one still
-- indexes the renamed column, so it is dropped rather than left as a legacy name in the
-- live schema.
DROP INDEX IF EXISTS events_by_pad_recency;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '11');
`;

interface DocRow {
  container_id: string;
  epoch: string;
  rev: number;
  doc: Uint8Array;
}

interface MetaRow {
  key: string;
  value: string;
}

/**
 * The stored occupant of one leaf, in canon shape, or null when the value is not a ref this
 * workspace ever wrote. A leaf whose stored occupant is unreadable is emptied rather than
 * guessed at: the tile survives as a vacant drop target, which is the one answer that keeps
 * the tree parseable without inventing an address.
 */
function canonRef(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const kind = value["kind"];
  if (kind === "terminal") {
    const id = value["sessionId"] ?? value["terminalId"];
    return typeof id === "string" ? { kind: "terminal", terminalId: id } : null;
  }
  if (kind === "pad" || kind === "container") {
    const id = value["padId"] ?? value["containerId"];
    return typeof id === "string" ? { kind: "container", containerId: id } : null;
  }
  if (kind === "text") {
    const id = value["elementId"];
    return typeof id === "string" ? { kind: "text", elementId: id } : null;
  }
  if (kind === "panel") {
    const id = value["panelId"];
    if (typeof id !== "string") return null;
    return { kind: "panel", panelId: PANEL_ID_RENAMES[id] ?? id };
  }
  return null;
}

/**
 * Rewrites one Yjs document's tile table, answering whether anything changed. A document
 * with no layout map is a canvas and has nothing here; a leaf already holding `ref` is left
 * exactly as it is, which is what makes this idempotent under a retry.
 */
function rewriteLayout(doc: Y.Doc): boolean {
  const layout = doc.getMap<Y.Map<unknown>>(LAYOUT_KEY);
  if (layout.size === 0) return false;
  const pending: { readonly tile: Y.Map<unknown>; readonly ref: Record<string, unknown> | null }[] =
    [];
  for (const [, tile] of layout.entries()) {
    if (!(tile instanceof Y.Map)) continue;
    if (!tile.has("surface")) continue;
    pending.push({ tile, ref: canonRef(tile.get("surface")) });
  }
  if (pending.length === 0) return false;
  doc.transact(() => {
    for (const { tile, ref } of pending) {
      tile.delete("surface");
      tile.set("ref", ref);
    }
  });
  return true;
}

/** The same rewrite over a workspace layout's JSON, or null when nothing needed moving. */
function rewriteLayoutJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  let changed = false;
  for (const tile of Object.values(parsed as Record<string, unknown>)) {
    if (typeof tile !== "object" || tile === null) continue;
    const fields = tile as Record<string, unknown>;
    if (!("surface" in fields)) continue;
    const ref = fields["surface"];
    delete fields["surface"];
    fields["ref"] = ref === null ? null : canonRef(ref);
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : null;
}

/**
 * `path` is unused: the pre-migration snapshot is the runner's job (`openDatabase` takes it
 * outside the transaction, because a VACUUM cannot run inside one), and so is its RETENTION —
 * one `<db>.pre-v<version>.bak` per version, replaced when that same version is retried and
 * never pruned across versions by the engine, which is the operator's job (docs/CONTRACTS.md
 * §Persistence). Both live in `backupBeside` rather than here because every backed-up
 * migration wants the identical rule and invariant 14 allows it exactly one implementation.
 * `path` stays in the signature because every code migration is called the same way.
 */
export function migrateToCanonLexicon(db: Database, path: string): void {
  void path;
  db.exec(SCHEMA_SQL);

  const updateDoc = db.query<void, [string, Uint8Array, string, string, number]>(
    `UPDATE scene_docs SET hash = ?, doc = ?
     WHERE container_id = ? AND epoch = ? AND rev = ?`,
  );
  const rows = db.query<DocRow, []>("SELECT container_id, epoch, rev, doc FROM scene_docs").all();
  for (const row of rows) {
    const doc = createSceneDoc();
    try {
      Y.applyUpdate(doc, row.doc);
    } catch {
      // Undecodable already: `latestDoc` skips it, so rewriting it would only replace one
      // unreadable revision with another and destroy the bytes recovery might still want.
      doc.destroy();
      continue;
    }
    const moved = rewriteLayout(doc);
    if (moved) {
      const update = Y.encodeStateAsUpdate(doc);
      updateDoc.run(
        createHash("sha256").update(update).digest("hex"),
        update,
        row.container_id,
        row.epoch,
        row.rev,
      );
    }
    doc.destroy();
  }

  const setMeta = db.query<void, [string, string]>("UPDATE meta SET value = ? WHERE key = ?");
  for (const row of db
    .query<MetaRow, []>("SELECT key, value FROM meta WHERE key LIKE 'layout:%'")
    .all()) {
    const next = rewriteLayoutJson(row.value);
    if (next !== null) setMeta.run(next, row.key);
  }
}
