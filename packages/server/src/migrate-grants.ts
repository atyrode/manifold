import type { Database } from "bun:sqlite";
import { CapSchema, MANIFOLD_ROOT_URI, formatManifoldUri, type Cap } from "@manifold/protocol";

/**
 * Schema 13: the permission waterfall's substrate (ADR 0011).
 *
 * Authority stops being a field on a credential and becomes a ROW on the node tree. Nothing
 * about what any existing credential MAY DO changes — that is the whole contract of this
 * migration, and `packages/server/test/grant-parity.test.ts` is where it is proved rather
 * than asserted. What changes is where the evaluator reads the answer from.
 *
 * Three moves, and each one is dictated by what already exists:
 *
 *   (a) `grants` holds ADR 0011's row verbatim — who, where, what, allow or deny, how far
 *       down. Nothing in it is hashed and nothing in it is a secret, which is the sharpest
 *       difference between this table and every other authority table in the schema: a token
 *       and a share are BEARER SECRETS, so they store a SHA-256 and never the secret, while a
 *       grant is bookkeeping ABOUT authority and presents nothing to anybody. That is also
 *       why revocation here is a DELETE rather than a `revoked_at` column: with no holder to
 *       keep refusing, absence of the row IS the revocation.
 *
 *   (b) `tokens.grant_id` and `shares.grant_id` are the REFERENCE, and it lives on the
 *       referrer rather than in a join table because each credential references exactly one
 *       row — a token's authority is one cap set at one node, and so is a share's. Putting it
 *       on `tokens` also means `authenticate()` learns the reference from the row it already
 *       fetched, so the hot path gains no query. `caps` and `container_id` stay exactly where
 *       they are: they are what the MINTER CHOSE, which the mint ladder keeps checking, and
 *       the grant row is what the EVALUATOR reads.
 *
 *   (c) every existing row is materialized. A token's caps become a `subtree` allow at
 *       `manifold://` when it is unscoped and at `manifold://container/<id>` when it is
 *       scoped — ADR 0011's "today's cap array is a synthesized root grant; today's
 *       containerScope is a subtree grant at the container" read literally. A share's caps
 *       become a `subtree` allow at the shared container addressed to the guest INSTANCE, so
 *       every ticket principal from that origin inherits the share's authority without the
 *       host minting a row per guest.
 *
 * CODE rather than SQL for one reason that is not stylistic: the node column is a
 * `manifold://` URI, and `formatManifoldUri` percent-encodes every segment. A SQL
 * `'manifold://container/' || container_id` would agree with it for every id this server has
 * ever minted and disagree silently for one holding a `/` or a `%` — and disagreement here is
 * not a formatting nit, it is a grant the evaluator can never find, which reads as an
 * authority that quietly vanished. One formatter, both ends.
 *
 * BACKED UP, and this is a deliberate widening of the criterion `db.ts` states. The move is
 * additive — two columns and a table, no row rewritten — so by the letter of that criterion no
 * snapshot is owed. It takes one anyway because of what a mistake here LOOKS like: not corrupt
 * data an operator can read, but a workspace that refuses every request, which is the one
 * class of failure whose cause is invisible in the rows. The pre-image costs one file and buys
 * the operator a database they can still open.
 *
 * IDS ARE DERIVED from the credential the row was materialized from, rather than minted. A
 * migration has no `RuntimeDeps`, and a derived id is strictly better here than a random one
 * anyway: re-running the materialization produces the identical table, and an operator reading
 * `grants` can see which token or share each row answers for without a join.
 */

/**
 * One stored JSON cap array, or null when the column will not yield one. Parsed with the SAME
 * schema the store's own reader uses, so a column this refuses is exactly a column the running
 * server already refuses — the migration invents no authority for a row nothing can read, and
 * declares none unusable that the server would have accepted.
 */
function storedCaps(raw: string): readonly Cap[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const caps = CapSchema.array().safeParse(parsed);
  return caps.success ? caps.data : null;
}

const SCHEMA_SQL = `
CREATE TABLE grants(
  id TEXT PRIMARY KEY,
  -- 'principal' | 'any-human' | 'any-agent' | 'instance'. The kind selects what principal_id
  -- means: a principal id, an instance origin, or nothing at all for a class row.
  principal_kind TEXT NOT NULL,
  principal_id TEXT,
  -- A manifold:// URI. The workspace root is the bare scheme, 'manifold://', which is the one
  -- node with no ManifoldRef form: there is nothing to discriminate and no second spelling.
  node TEXT NOT NULL,
  caps TEXT NOT NULL,
  effect TEXT NOT NULL,
  reach TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- The evaluator's one query narrows by node and by principal together, so both arms of its
-- WHERE get an index: a workspace where every token carries a root grant would otherwise hand
-- the walk the whole table on every request.
CREATE INDEX grants_by_principal ON grants(principal_kind, principal_id, node);
CREATE INDEX grants_by_node ON grants(node);
ALTER TABLE tokens ADD COLUMN grant_id TEXT;
ALTER TABLE shares ADD COLUMN grant_id TEXT;
-- Read on every authority question: whether some token references this row, which is what
-- decides that a credential's synthesized authority applies to that credential alone.
CREATE INDEX tokens_by_grant ON tokens(grant_id);
INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', '13');
`;

interface TokenRow {
  id: string;
  principal_id: string;
  minted_by: string | null;
  caps: string;
  container_id: string | null;
  created_at: number;
}

interface ShareRow {
  id: string;
  container_id: string;
  caps: string;
  origin: string;
  minted_by: string;
  created_at: number;
}

/**
 * `path` is unused, exactly as it is in the other two code migrations: the snapshot and its
 * retention are the runner's job (`backupBeside`), because every backed-up migration wants the
 * identical rule and invariant 14 allows it one implementation. The parameter stays in the
 * signature because every code migration is called the same way.
 */
export function migrateToGrantRows(db: Database, path: string): void {
  void path;
  db.exec(SCHEMA_SQL);

  const insertGrant = db.query<
    void,
    [string, string, string | null, string, string, string, string, string, number]
  >(
    `INSERT INTO grants(
       id, principal_kind, principal_id, node, caps, effect, reach, created_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  /*
    EVERY token, revoked ones included. A revoked token is refused at authentication, long
    before any authority question is asked, so its row can never fire — and materializing it
    keeps the table a faithful account of what was issued rather than a filtered view whose
    filter somebody later has to remember.
  */
  const bindToken = db.query<void, [string, string]>("UPDATE tokens SET grant_id = ? WHERE id = ?");
  for (const token of db
    .query<TokenRow, []>(
      "SELECT id, principal_id, minted_by, caps, container_id, created_at FROM tokens",
    )
    .all()) {
    const caps = storedCaps(token.caps);
    /*
      No caps to express, no row. An enrolled machine's token carries `[]` — its authority is
      to BE a machine, not to do anything as a principal — and a grant granting nothing would
      be a row that answers no question. A column that will not parse is left alone for the
      same reason it is left alone today: the store's own reader throws on it, so the token is
      already unusable, and inventing an authority for it here would be the migration deciding
      something the workspace never decided.
    */
    if (caps === null || caps.length === 0) continue;
    const node =
      token.container_id === null
        ? MANIFOLD_ROOT_URI
        : formatManifoldUri({ kind: "container", containerId: token.container_id });
    const id = `grant-token-${token.id}`;
    insertGrant.run(
      id,
      "principal",
      token.principal_id,
      node,
      JSON.stringify(caps),
      "allow",
      "subtree",
      // A token minted with no actor recorded is attributed to its own subject rather than to
      // an empty string: the column is NOT NULL because "nobody created this authority" is not
      // a fact any row is allowed to state.
      token.minted_by ?? token.principal_id,
      token.created_at,
    );
    bindToken.run(id, token.id);
  }

  /*
    LIVE shares only. A revoked share's pipe is already cut and every ticket it minted is
    already fenced, so materializing its row would put authority in the table for a
    relationship this instance has ended — and `revokeShare` deletes the row for exactly that
    reason, which makes skipping it here the same rule applied to history.
  */
  const bindShare = db.query<void, [string, string]>("UPDATE shares SET grant_id = ? WHERE id = ?");
  for (const share of db
    .query<ShareRow, []>(
      `SELECT id, container_id, caps, origin, minted_by, created_at
       FROM shares WHERE revoked_at IS NULL`,
    )
    .all()) {
    const caps = storedCaps(share.caps);
    if (caps === null || caps.length === 0) continue;
    const id = `grant-share-${share.id}`;
    insertGrant.run(
      id,
      "instance",
      share.origin,
      formatManifoldUri({ kind: "container", containerId: share.container_id }),
      JSON.stringify(caps),
      "allow",
      "subtree",
      share.minted_by,
      share.created_at,
    );
    bindShare.run(id, share.id);
  }
}
