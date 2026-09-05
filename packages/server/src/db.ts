import { renameSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { migrateToGrantRows } from "./migrate-grants.ts";
import { migrateToCanonLexicon, migrateToElementRefs } from "./migrate-lexicon.ts";
import { migrateToSoloCompositions } from "./migrate-solo.ts";

/** Current durable schema revision. Migrations advance this monotonically. */
export const SCHEMA_VERSION = 20;

/**
 * A migration is SQL, or CODE when the move is not expressible as SQL — schema 9 rewrites
 * Yjs documents, which no amount of SQL can do. Either form may declare that the change it
 * makes is not recoverable: `backup: true` takes a consistent snapshot of the database
 * beside itself first, because a one-way data move is the one kind of migration whose
 * mistake cannot be undone by running something else afterwards.
 *
 * A bare string is the common case — SQL that a later migration could always reverse — so it
 * stays the terse form rather than gaining a wrapper object for a flag it never sets.
 */
interface BackedUpSqlMigration {
  readonly backup: boolean;
  readonly sql: string;
}
interface CodeMigration {
  readonly backup: boolean;
  apply(db: Database, path: string): void;
}
type Migration = string | BackedUpSqlMigration | CodeMigration;

const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: `
CREATE TABLE IF NOT EXISTS pads(
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS snapshots(
  pad_id TEXT,
  epoch TEXT,
  rev INTEGER,
  ts INTEGER,
  hash TEXT,
  blob TEXT,
  PRIMARY KEY (pad_id, epoch, rev)
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pad_id TEXT,
  ts INTEGER,
  principal_id TEXT,
  type TEXT,
  payload TEXT
);
CREATE TABLE IF NOT EXISTS principals(
  id TEXT PRIMARY KEY,
  kind TEXT,
  name TEXT,
  color TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tokens(
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE,
  principal_id TEXT,
  caps TEXT,
  pad_id TEXT,
  created_at INTEGER,
  revoked_at INTEGER,
  minted_by TEXT
);
CREATE TABLE IF NOT EXISTS machines(
  id TEXT PRIMARY KEY,
  name TEXT,
  token_id TEXT,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  machine_id TEXT,
  pad_id TEXT,
  element_id TEXT,
  created_by TEXT,
  status TEXT,
  exit_code INTEGER,
  created_at INTEGER,
  agent_principal_id TEXT
);
CREATE TABLE IF NOT EXISTS meta(
  key TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '1');
`,
  2: `
ALTER TABLE pads ADD COLUMN sort_order INTEGER;
ALTER TABLE pads ADD COLUMN folder_id TEXT;
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) - 1 AS position
  FROM pads
)
UPDATE pads
SET sort_order = (SELECT position FROM ordered WHERE ordered.id = pads.id);
CREATE TABLE pad_folders(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '2');
`,
  3: `
ALTER TABLE pad_folders ADD COLUMN parent_folder_id TEXT;
ALTER TABLE pad_folders ADD COLUMN sort_order INTEGER;

UPDATE pad_folders
SET sort_order = COALESCE(
  (SELECT MIN(sort_order) FROM pads WHERE pads.folder_id = pad_folders.id),
  (SELECT COUNT(*) FROM pads) + ROWID
);

CREATE TEMP TABLE tree_migration_order(kind TEXT, id TEXT, sibling_order INTEGER);
INSERT INTO tree_migration_order(kind, id, sibling_order)
SELECT kind, id, ROW_NUMBER() OVER (ORDER BY position, created_at, kind, id) - 1
FROM (
  SELECT 'pad' AS kind, id, sort_order AS position, created_at FROM pads WHERE folder_id IS NULL
  UNION ALL
  SELECT 'folder' AS kind, id, sort_order AS position, created_at FROM pad_folders
);
UPDATE pads
SET sort_order = (
  SELECT sibling_order FROM tree_migration_order
  WHERE tree_migration_order.kind = 'pad' AND tree_migration_order.id = pads.id
)
WHERE folder_id IS NULL;
UPDATE pad_folders
SET sort_order = (
  SELECT sibling_order FROM tree_migration_order
  WHERE tree_migration_order.kind = 'folder' AND tree_migration_order.id = pad_folders.id
);
DROP TABLE tree_migration_order;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY folder_id ORDER BY sort_order, created_at, id) - 1 AS sibling_order
  FROM pads
  WHERE folder_id IS NOT NULL
)
UPDATE pads
SET sort_order = (SELECT sibling_order FROM ranked WHERE ranked.id = pads.id)
WHERE folder_id IS NOT NULL;

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '3');
`,
  4: `
-- Enrollment is idempotent by machine name (#43), so storage must enforce the
-- name's uniqueness (#46). Databases shaped by the pre-#43 always-mint path may
-- hold duplicate names. Non-destructive resolution (#48): the row the live
-- agent authenticates with (most recently seen; tie-break: newest rowid) keeps
-- the bare name; every other duplicate is RETIRED, never deleted — renamed out
-- of the way with its own id as suffix (a UUID cannot collide with a real
-- name) and its token revoked so a stale agent is fenced loudly instead of
-- lingering. Machine rows and their sessions are persisted history; a wrong
-- survivor pick stays recoverable.
-- Amended in place before any durable database applied schema v4 (prod was
-- still v3); version-stamped ephemeral DBs that ran the earlier destructive
-- shape never re-run it, and both shapes satisfy the index.
CREATE TEMP TABLE machine_survivors(id TEXT);
INSERT INTO machine_survivors(id)
SELECT id FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY name ORDER BY last_seen DESC, rowid DESC) AS rank
  FROM machines
)
WHERE rank = 1;
UPDATE tokens
SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE revoked_at IS NULL
  AND id IN (
    SELECT token_id FROM machines
    WHERE id NOT IN (SELECT id FROM machine_survivors)
  );
UPDATE machines
SET name = name || '#' || id
WHERE id NOT IN (SELECT id FROM machine_survivors);
DROP TABLE machine_survivors;

CREATE UNIQUE INDEX IF NOT EXISTS machines_name_unique ON machines(name);

INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '4');
`,
  5: `
CREATE TABLE scene_docs(
  pad_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  rev INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  hash TEXT NOT NULL,
  doc BLOB NOT NULL,
  PRIMARY KEY (pad_id, epoch, rev)
);
DROP TABLE snapshots;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '5');
`,
  6: `
-- Terminals became renameable, durably ordered pool rows (#15, #57): the
-- session row carries the operator-assigned name and its pool position. Both
-- are nullable — pre-#57 sessions have no name and no explicit order, and the
-- pool listing sorts NULL sort_order last so they keep their creation order.
ALTER TABLE sessions ADD COLUMN name TEXT;
ALTER TABLE sessions ADD COLUMN sort_order INTEGER;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '6');
`,
  7: `
-- Container discipline (#15, #57): a View and a Pad are ONE object differing only
-- in their layout. A transient pad is a bubble — an unsplit, unpinned view that
-- dissolves when its last occupant leaves — and origin_pad_id is that bubble's
-- return address, the canvas whose portal element it was born from. The return
-- address never appears on the wire: it is server-side lifecycle state, and
-- clearing it (rename or pin) is what makes a container explicitly claimed.
ALTER TABLE pads ADD COLUMN layout TEXT NOT NULL DEFAULT 'canvas';
ALTER TABLE pads ADD COLUMN transient INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pads ADD COLUMN origin_pad_id TEXT;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '7');
`,
  8: `
-- Placement left the session row (#59). sessions.element_id was written once at
-- birth and never read: a session can be placed several times (mirrors) and in
-- either discipline, so the id of "its" placement was a lie the moment the
-- placement algebra made placements first-class. Live containers are the only
-- source of truth for where a session appears — the column goes.
ALTER TABLE sessions DROP COLUMN element_id;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '8');
`,
  /**
   * Solo compositions (#59). Every terminal now lives in a composition of its own and a
   * canvas references it through a portal, so `pads.transient` (the bubble flag),
   * `pads.origin_pad_id` (the bubble's return address) and `sessions.sort_order` (the pool's
   * ordering) all describe machinery that no longer exists. The rows and documents move
   * too, which is why this one is code.
   */
  9: { backup: true, apply: migrateToSoloCompositions },
  /**
   * Per-plugin storage and element-type reservations (#69). ONE table, because a plugin's
   * durable state is a namespaced key-value surface by contract — the engine has no business
   * knowing a plugin's shape, and a table per plugin would be exactly the bespoke-schema
   * sprawl the plugin engine exists to end.
   *
   * The engine's own reserved keys (`$version`, `$migration:<name>`) live in the same table
   * under the owning plugin's id, so a plugin's rows, its data version and its migration
   * ledger are erased by one `DELETE` when a purge names it. Element-type reservations live
   * under the engine builtin's own id (`$owner:<type>`) and are tombstones: they outlive
   * their owner leaving the build, because the documents that stored the type do not.
   */
  10: `
CREATE TABLE plugin_kv(
  plugin_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
) WITHOUT ROWID;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '10');
`,
  /**
   * The lexicon cut (#69). Tables and columns take the canon names — `containers`,
   * `container_folders`, `terminals`, `*.container_id`, `containers.discipline` with values
   * `canvas` | `composition` — the stored capability vocabulary is rewritten, and the tile
   * tables inside every scene document and every workspace layout move their leaf occupant
   * from `surface` to `ref`. Code, and backed up, because two of those are document data
   * and the whole set must land together or a composition reads as empty (migrate-lexicon.ts).
   */
  11: { backup: true, apply: migrateToCanonLexicon },
  /**
   * Cross-instance sharing (#74). Three tables and one column, and the shape of every one
   * of them is dictated by what already exists rather than by anything new.
   *
   * `shares` is the grant a host hands another instance: a container, a capability set, and
   * the guest ORIGIN it was minted for. The secret is stored the way every other bearer in
   * this schema is stored — as a SHA-256 hash in a `hash` column with a UNIQUE index, never
   * in the clear — so the tokens table's rule ("the raw bearer secret deliberately has no
   * field here") holds for the newest bearer too. `revoked_at` mirrors `tokens.revoked_at`
   * for the same reason: revocation is durable, so it survives the restart that a
   * memory-only fence would forget.
   *
   * `share_tickets` is the dedupe map from one of the GUEST's principals to the host-side
   * principal minted to stand for it, and it exists so that asking twice is idempotent and
   * so that revoking a share can name every identity it created. It is deliberately a
   * mapping rather than a second identity system: the row's `principal_id` is an ordinary
   * principal with an ordinary token, which is what makes the host's doors, its revocation
   * fence and its attendance roster work on a remote guest with no special case anywhere.
   *
   * `dials` is the same grant seen from the GUEST end — one row per outbound instance
   * channel, holding the secret this instance dials OUT with. One dial is one share by
   * ratified design, so the row carries the share's node and caps as the host last
   * reported them: cached vocabulary the guest can draw a row from while the socket is
   * down, never an authority the guest evaluates. Authority is decided at the host's doors
   * and nowhere else. The secret here IS stored in the clear, and that asymmetry with
   * `shares.hash` is the point rather than an oversight: a host only ever VERIFIES a
   * presented secret, which a hash does, while a guest must PRESENT one, which a hash
   * cannot. It is the same trust boundary the auto-spawned agent's raw machine token
   * already sits on (`<data>/agent.token`, mode 600) — one directory, mode 0700, holding
   * the credentials this instance dials out with.
   *
   * `principals.origin` is the principal-origin field wave 1 reserved in prose (CONTRACTS
   * §Identity). NULL means "this instance", which is every row that already exists — the
   * column needs no backfill because absence IS the local answer, and that is the whole
   * reason the field is nullable rather than defaulted to a string.
   */
  12: `
CREATE TABLE shares(
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  container_id TEXT NOT NULL,
  caps TEXT NOT NULL,
  origin TEXT NOT NULL,
  minted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE share_tickets(
  share_id TEXT NOT NULL,
  guest_principal_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, guest_principal_id)
) WITHOUT ROWID;
CREATE TABLE dials(
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  secret TEXT NOT NULL,
  -- NULL only while the handshake is in flight: the host's welcome is what says which
  -- node the share names, and a row that never hears one is deleted rather than kept.
  ref TEXT,
  caps TEXT NOT NULL,
  title TEXT,
  dialed_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX dials_origin_secret_unique ON dials(origin, secret);
ALTER TABLE principals ADD COLUMN origin TEXT;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '12');
`,
  /**
   * The permission waterfall's substrate (#77, ADR 0011). Authority stops being a field on a
   * credential and becomes a row on the node tree: `grants` holds ADR 0011's row verbatim, and
   * `tokens.grant_id` / `shares.grant_id` are how a credential references the authority it was
   * issued. Every existing token and every live share is materialized into a row, so no
   * credential's answer to any authority question moves by so much as one refusal.
   *
   * Code, and backed up, for reasons written where its body is (migrate-grants.ts): the node
   * column is a percent-encoded `manifold://` URI that only one formatter may produce, and a
   * mistake in materializing authority does not look like corrupt data — it looks like a
   * workspace that refuses everything, which is the one failure an operator cannot read off
   * the rows.
   */
  13: { backup: true, apply: migrateToGrantRows },
  /**
   * The trace ledger's columns (#93, axiom A6, ADR 0018). FIVE nullable columns on the ONE
   * journal, and the shape of the change is the whole argument: a trace is a row in the
   * `events` table, not a table of its own.
   *
   * The journal family is the reason. `events` is already the durable, pruned, append-only
   * record of what happened here, already read by exactly one door
   * (`core.events.list`) — so a second table would be a second audit API, a second
   * retention policy and a second thing to remember to read (invariant 14). What a trace
   * needs that an event row does not is the ATTRIBUTION of an exercise of authority, and
   * that is what these columns carry: `door` (the action dispatched), `authority` (the
   * capability set discharged, or `root`), `targets` (the `manifold://` nodes the door named,
   * as a JSON array), `outcome` (`TRACE_OUTCOMES`), and `session` (the socket the dispatch
   * arrived on; NULL means it came through the HTTP action door, which is itself the answer).
   * A row with `door IS NULL` is an ordinary event row and always was.
   *
   * Plain SQL and NO pre-migration snapshot, which is the house rule rather than an
   * exception to it (`backupBeside`): nothing here rewrites a byte of existing data, every
   * existing row's answer to every existing query is unchanged, and the move is reversible by
   * a later migration that drops five columns. The snapshot belongs to migrations 9, 11 and
   * 13, which each move data one way.
   *
   * No index, deliberately. The trail is read newest-first through the two indexes it already
   * has, and `type` — the column `kind: "trace"` filters on — was already documented as a
   * predicate the ordering scan applies rather than a seek (`ServerStore.listEvents`). A
   * third index would cost every write to speed a read nobody has measured.
   */
  14: `
ALTER TABLE events ADD COLUMN door TEXT;
ALTER TABLE events ADD COLUMN authority TEXT;
ALTER TABLE events ADD COLUMN targets TEXT;
ALTER TABLE events ADD COLUMN outcome TEXT;
ALTER TABLE events ADD COLUMN session TEXT;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '14');
`,
  /**
   * Credential expiry (#108, ADR 0019 §2). ONE nullable column on `tokens`, and the
   * nullability is the whole migration: NULL means "does not expire", which is exactly what
   * every row written before this schema meant, so no existing credential's answer to
   * `authenticate` moves by a millisecond.
   *
   * Plain SQL and NO pre-migration snapshot, the house rule rather than an exception to it:
   * nothing here rewrites a byte, and the move is reversible by a later migration that drops
   * one column. Backfilling an expiry onto existing tokens was considered and REJECTED — it
   * would log every browser holding a two-month-old credential out at the deploy, which is
   * the fleet outage ADR 0019 §2 refuses to dress as a security fix. Existing credentials
   * live out their unbounded lives; the bound applies to what is minted from here.
   *
   * No index. `authenticate` reads the column off the row it already fetched by hash, and
   * nothing queries BY expiry: the credential list filters in the reader, over a table whose
   * size is the number of credentials a workspace has ever issued.
   */
  15: `
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '15');
`,
  /**
   * Dead-token grant rows retired (#140). A token's grant row is that one credential's
   * synthesized authority and reaches no other, so once the token is revoked the row answers
   * no question anybody can ask — and migration 13 materialized revoked tokens all the same,
   * as "a faithful account of what was issued". That ruling is reversed: the account of what
   * was issued is the `tokens` row (`caps`, `container_id`, `revoked_at` all stay), a grant row
   * is LIVE authority, and `ServerStore.revokeTokensWhere` now deletes the row in the same
   * transaction that marks the token. This is the same rule applied to history, exactly as 13
   * skipped revoked shares for the reason `revokeShare` deletes theirs.
   *
   * No credential's answer to any authority question moves: a revoked token is refused at
   * authentication before the evaluator is asked, and a row bound to one is reachable through
   * no other credential (`tokenBound`). The second predicate is belt to that brace — a row
   * some LIVE token still references is kept even if a dead one also names it, which the
   * one-row-per-token construction makes impossible and the migration refuses to assume.
   *
   * Backed up, by the house rule: rows go one way here, and a mistake would look like an
   * authority that vanished rather than like corrupt data an operator can read.
   */
  16: {
    backup: true,
    sql: `
DELETE FROM grants
 WHERE id IN (SELECT grant_id FROM tokens WHERE revoked_at IS NOT NULL AND grant_id IS NOT NULL)
   AND id NOT IN (SELECT grant_id FROM tokens WHERE revoked_at IS NULL AND grant_id IS NOT NULL);
UPDATE tokens SET grant_id = NULL
 WHERE revoked_at IS NOT NULL AND grant_id NOT IN (SELECT id FROM grants);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '16');
`,
  },
  /**
   * Installed plugins (ADR 0016 §8 stage 2, #152). One row per plugin a root principal
   * installed from a bundle: the hash the installer pinned, the source as they spelled it, the
   * capability set they consented to, who and when, and where the artifact landed on disk.
   * The MANIFEST is deliberately not a column: it lives in the bundle the row points at, and a
   * bundle that no longer hashes to `sha256` is refused at boot rather than described from a
   * copy the engine would then have to trust (R8, fail-closed).
   *
   * Plain SQL, no snapshot: a new table, nothing rewritten, reversible by a DROP.
   */
  17: `
CREATE TABLE plugin_installs(
  plugin_id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,
  granted_caps TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  bundle_path TEXT NOT NULL
) WITHOUT ROWID;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '17');
`,
  /**
   * The doors an install published (ADR 0016 R8, the boot-refusal fix): the `ActionSummary[]`
   * the assembly published for the row when it was admitted, as JSON. A bundle that fails
   * re-verification at boot still puts its doors on the roster from this column — never from
   * the file — so a dispatch to one answers a traced `unavailable` naming the refusal instead
   * of `unknown_action`, the one rung the ledger does not keep. Existing rows read `[]`: an
   * install admitted before this column has no record of its doors until it is replaced, and
   * an empty list is exactly the doorless row those installs already composed.
   *
   * Plain SQL, no snapshot: one added column with a default, reversible by a DROP COLUMN.
   */
  18: `
ALTER TABLE plugin_installs ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '18');
`,
  /**
   * Contributed element refs (#222). Rewrite every saved scene revision and workspace
   * layout before the strict TileSchema reads them; element payloads and topology stay put.
   * This one-way document vocabulary move uses the same atomic, backed-up runner as 11.
   */
  19: { backup: true, apply: migrateToElementRefs },
  /**
   * Terminal continuity across agent replacement (#278). TWO nullable-or-defaulted columns
   * on `machines`, and both are admission state the hub must not forget across a restart:
   *
   * - `owner_host_id`: the `terminalHostId` the last ADMITTED hello named — the identity of
   *   the process that owns the machine's PTYs — or NULL for a pre-v24 agent that is its own
   *   owner. A same-token newcomer proves continuity against this column when no live socket
   *   is there to prove it against, so a hub restart does not turn every reconnect into an
   *   unproven one.
   * - `draining`: the admission latch `core.machines.drain` sets. It is written BEFORE the
   *   owner is asked, so a hub that restarts between closing admission and hearing the
   *   owner's answer comes back with admission still closed — the one state a maintenance
   *   window cannot afford to lose. `0` is every existing row: nothing was draining before
   *   the column existed.
   *
   * Plain SQL and no snapshot: nothing rewritten, every existing row keeps every answer,
   * reversible by dropping two columns.
   */
  20: `
ALTER TABLE machines ADD COLUMN owner_host_id TEXT;
ALTER TABLE machines ADD COLUMN draining INTEGER NOT NULL DEFAULT 0;
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '20');
`,
};

interface TableRow {
  name: string;
}

interface VersionRow {
  value: string;
}

/**
 * SQLite's own consistent snapshot, which is the only safe way to copy a WAL database from
 * inside the process holding it, and the only one that cannot capture a torn write. Skipped
 * for a `:memory:` database, which has no file to copy, and for a database that did not
 * exist yet, which has no pre-migration state to preserve.
 *
 * RETENTION lives here rather than in any migration's body, because "keep the newest image
 * per version" is a property of the RUNNER: every `backup: true` migration wants the identical
 * rule, and a rule written once per migration is invariant-14 debt waiting to drift. The
 * engine never deletes an elder VERSION's image — writing `pre-v11` leaves `pre-v9` exactly
 * where it is, because that file is the operator's recovery inventory and a process that
 * silently deletes a recovery image is a worse outcome than a full disk (docs/CONTRACTS.md
 * §Persistence). The one file it does replace is the SAME version's own predecessor, and that
 * is safe for a reason particular to same-version: a `pre-v11.bak` can only still be sitting
 * there if 11 never committed, so the live database still holds every byte the stale image
 * copies, and keeping both would buy an operator nothing but one more full copy per attempt.
 *
 * `VACUUM INTO` refuses to write a path that exists, so the replacement is staged, and the
 * ORDERING is the whole point. Vacuum into a sibling `.partial`, then rename it over the
 * canonical name, then let the caller open the transaction. Rename is atomic and in the same
 * directory, so no instant ever shows a half-written file under the name an operator recovers
 * from; a vacuum that dies mid-copy takes its `.partial` with it and leaves the previous image
 * untouched; a `.partial` orphaned by a killed process is cleared on the next attempt instead
 * of blocking it forever; and because promotion happens BEFORE the transaction, a migration
 * that then throws finds its own image already on disk under the published name. Promoting
 * after the commit instead would leave a failed attempt's only image — the one case an
 * operator actually needs it — under a temporary name nothing documents.
 */
function backupBeside(db: Database, path: string, version: number, from: number): void {
  if (from === 0) return;
  if (path === "" || path === ":memory:" || path.startsWith("file::memory:")) return;
  const target = `${path}.pre-v${version}.bak`;
  const staging = `${target}.partial`;
  rmSync(staging, { force: true });
  try {
    db.exec(`VACUUM INTO '${staging.replaceAll("'", "''")}'`);
  } catch (error) {
    rmSync(staging, { force: true });
    throw error;
  }
  renameSync(staging, target);
}

/** Litestream's checkpoint takes short write locks; wait rather than fail a competing write. */
const SQLITE_BUSY_TIMEOUT_MS = 5000;

/** Opens a Bun SQLite database, enables WAL, and applies numbered migrations atomically. */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true, strict: true });
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  const meta = db
    .query<TableRow, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  const row =
    meta === null
      ? null
      : db.query<VersionRow, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row === null ? 0 : Number(row.value);
  if (!Number.isInteger(current) || current < 0 || current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`unsupported database schema version: ${row?.value ?? "missing"}`);
  }

  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) {
      db.close();
      throw new Error(`missing database migration ${version}`);
    }
    // The snapshot is taken OUTSIDE the transaction because a VACUUM cannot run inside
    // one — which is also what makes it a true pre-migration image: nothing this migration
    // does has happened yet. It is equally why a throw below cannot cost the image: by the
    // time the transaction opens the file already carries its final name.
    if (typeof migration !== "string" && migration.backup) {
      backupBeside(db, path, version, current);
    }
    const migrate = db.transaction(() => {
      if (typeof migration === "string") db.exec(migration);
      else if ("sql" in migration) db.exec(migration.sql);
      else migration.apply(db, path);
    });
    migrate();
  }
  return db;
}
