# ADR 0034: The plugin database — a plugin's own tables beside its key-value ref

Date: 2026-09-12
Status: proposed
Ratified: —

## Context

`ctx.storage` is "the one place a plugin persists anything" (`docs/PLUGINS.md` §4): a
namespaced key-value ref over one `plugin_kv` table in `manifold.db`, string values of at most
64 KiB, a version stamp and a migration ledger the engine writes and the plugin can read but not
forge (`packages/plugin/src/storage.ts`, `packages/server/src/stores.ts:921`). Its own doc states
its limit as a rule rather than a number: "a plugin with genuinely large data has a shape problem
that a key-value ref should not paper over", and §4 sends oversize things to the document plane
(§5). That ruling is right for what it judges — a settings row, a launch ledger of fifty entries,
a stroke list — and it has held for every plugin in the tree.

It does not hold for a plugin whose data is a **graph read by query**. `atyrode.babel` (decision
91 in `atyrode/babel`'s SPEC §2.8, 2026-09-12: Babel becomes a plugin entirely, the hub owns its
state) arrives with 65,818 records, 60,793 links between them, 3,037 observations under 2,445
hypotheses, filings, per-role vote tallies, an append-only disposition log and a ledger of
entities and facts — and every one of its pages is a filter, a sort, a join or an aggregate over
that: "what awaits the operator, most urgent first", "every record filed under this entity",
"support minus oppose per role, split or not", "the newest ruling per record, today". None of it
is a document; none of it is a 64 KiB value; and a key-value ref answers a query only by reading
every key, which is the shape problem the storage doc warns about, arriving from the other side.
The alternatives a plugin has today are worse than the problem: keep a private SQLite file
outside `ctx.storage` (a plugin "whose purge is a guess", §4), or keep the data off the hub in a
service of its own (which is exactly what decision 91 retires: a second place, a second
credential, a second sync).

The engine already holds every ingredient. `manifold.db` is Bun's SQLite (`packages/server/src/db.ts:755`);
the storage contract is already promise-returning for every plugin with a synchronous in-realm
implementation and an RPC'd isolated one (ADR 0016 §4, `packages/server/src/isolate/proxy-def.ts:162`);
the migration ledger and the data version already exist and already run before a plugin serves
(`packages/server/src/plugin-host.ts:1237`); purge already knows how to erase exactly one plugin's
data without knowing its shape. What is missing is one thing: a place a plugin may keep **rows**.

## Decision

1. **A plugin may hold one SQLite database of its own, opened and owned by the engine.** It lives
   at `<dataDir>/plugins/<pluginId>/data.db` — never inside `manifold.db`, so the engine's own
   tables and a plugin's tables cannot contend, corrupt or lock each other, and a purge is a file
   deletion. It is opened lazily on first use with WAL journaling and `strict` mode, and it is the
   plugin's alone: the path is derived from the manifest id, two plugins cannot name each other's
   file, and the engine never reads a plugin's tables for any purpose but purge and count.

2. **The contract is `ctx.database: PluginDatabase`, promise-returning like storage, one contract
   for in-realm and isolated plugins** (ADR 0016 §4's rule applies unchanged: two contracts would
   be two doors onto one concept). In-realm it is synchronous inside — the statement runs before
   the promise is handed back — so `await` costs a microtask; through the isolate proxy the same
   calls cross the boundary as `database.query`, `database.run` and `database.batch`.

   ```ts
   type SqlParam = string | number | bigint | boolean | null | Uint8Array;
   interface PluginDatabase {
     readonly pluginId: string;
     /** One statement, bound parameters, rows back (SELECT and RETURNING); other statements return []. */
     query<Row = Record<string, SqlParam>>(sql: string, params?: readonly SqlParam[]): Promise<readonly Row[]>;
     /** One statement, bound parameters, its change count and last rowid back. */
     run(sql: string, params?: readonly SqlParam[]): Promise<{ changes: number; lastInsertRowid: number }>;
     /** Several statements in one IMMEDIATE transaction, all or none; the results in order. */
     batch(statements: readonly { sql: string; params?: readonly SqlParam[] }[]): Promise<readonly (readonly Record<string, SqlParam>[])[]>;
   }
   ```

   There is deliberately **no open transaction handle** in the plugin-facing contract. A
   transaction that spans a plugin's `await`s would hold a write lock across dispatch turns
   in-realm and across RPC round trips isolated, and its deadline and rollback would be a second
   consistency model beside `compareAndSet`'s. `batch` is the transaction: the statements are
   known before it starts, it runs to completion or rolls back, and it costs one round trip. A
   plugin that needs read-then-decide-then-write does it the way storage does — reads, decides,
   then a `batch` whose first statements are its own guards (`WHERE revision = ?`), and reads the
   change count.

3. **Migrations are the existing migrations.** `PluginMigration.migrate` gains a second
   parameter, `database` — `migrate(storage, database)` — additive, so every migration in the
   tree keeps compiling and keeps meaning what it meant. The ledger stays where it is: named
   entries under `$migration:` in `plugin_kv`, the version stamp in `$version`, so a plugin has
   ONE data version and ONE ledger whether its data is keys, rows or both, and `applyMigrations`
   (`plugin-host.ts:1237`) runs the chain exactly as today. A migration creates its tables with
   ordinary `CREATE TABLE` statements through `database.run`; there is no schema DSL, because
   SQL is the schema DSL and a second one would be the second convention CONTRACTS forbids.

4. **Bounds are stated numbers, checked by the engine, refused as `PluginDatabaseError`
   rejections** (the same failure path storage uses — a rejection, never a throw):
   - statement text ≤ 64 KiB; parameters ≤ 999 per statement (SQLite's own bound); a `batch` ≤
     256 statements;
   - rows returned per call ≤ 10,000 and result bytes ≤ 4 MiB — a plugin pages, the engine does
     not buffer a table into a promise;
   - a call runs under a 5-second deadline; a `batch` past it is rolled back;
   - the file is capped: `PRAGMA max_page_count` from the manifest's `database.maxBytes`
     (default 256 MiB, ceiling 4 GiB — the engine's ceiling, not the plugin's word), so a runaway
     plugin fills its own file and nothing else;
   - `ATTACH`, `DETACH`, `VACUUM`, `PRAGMA` and `load_extension` are refused lexically before
     execution, and the file is opened with `trusted_schema` off. This is a guard against the
     plugin reaching outside its file, not a sandbox: an in-realm plugin already runs in the
     engine's process (ADR 0025), and a hardened one reaches the database only through the
     proxy, which is the boundary.

5. **Lifecycle follows storage's, to the letter.** Disable retains the file; uninstall without
   purge retains it; purge closes and deletes `data.db`, `data.db-wal` and `data.db-shm` and reports
   what it removed beside storage's row count; `count()` for the uninstall guard is the file's
   page count, so a plugin with rows is refused a silent uninstall the way one with keys is. The
   engine's own backup of `<dataDir>` includes `plugins/`; a plugin's tables are not in
   `manifold.db` and must not be assumed to be.

6. **The manifest declares it.** `database?: { maxBytes?: number }` on the manifest; a plugin
   that declares nothing gets no `ctx.database` (the slice is absent, `slice_unavailable` through
   the proxy), so the file exists only for plugins that asked, and the plugin manager can show
   which ones hold one and how big it is.

7. **What it is not.** It is not a document plane (§5 stays the place for large blobs and
   collaborative text), not a shared database (no plugin reads another's rows; cross-plugin data
   travels through actions and events as it does today), not a query API over the engine's own
   tables (the roster, grants and jobs stay behind their doors), and not a replacement for
   `ctx.storage` (a preference is still a key).

## Alternatives considered

- **Raise the value limit.** Turns the key-value ref into an object store and still answers no
  query; the storage doc's own argument.
- **A document-plane collection with indexes.** The document plane is collaborative and
  replicated by design (ADR 0008); Babel's records are single-writer, append-only rows with
  relations, and the plane's cost model is wrong for sixty thousand of them.
- **Tables inside `manifold.db` prefixed by plugin id.** One file, one lock, one corruption
  radius shared between the engine and every plugin, and a purge that has to know table names.
  The engine's own tables and a plugin's belong to different owners; separate files say so.
- **An open transaction handle.** Rejected above: a lock held across a plugin's awaits, plus a
  second consistency story beside `compareAndSet`. `batch` gives all-or-none without it.
- **Leave it to the plugin (a private file).** A plugin whose purge is a guess; forbidden by §4
  already.

## Consequences

- `atyrode.babel` can start (its plan's P1). Any plugin whose data is row-shaped gets the same
  door; the settings plugin, the launch ledger and the draw plugin keep using keys.
- New engine surface: `packages/plugin/src/database.ts` (contract, bounds, error), `stores.ts`
  gains `pluginDatabase(pluginId)` beside `pluginStorage`, `plugin-host.ts` assembles `ctx.database`
  for declaring plugins and threads it into migrations, `proxy-def.ts` serves the three methods,
  purge and count widen, the manifest schema gains `database`, `docs/PLUGINS.md` §4 gains "Your
  tables", and the kit's `verify` exercises query, run, batch, a migration and purge.
- Revisit triggers: a plugin needs cross-statement read-your-writes inside one transaction that
  `batch` cannot express (the answer is then a bounded transaction with a deadline, added as a
  fourth method, not a change to the three); or the engine grows a backup primitive, at which
  point `plugins/*/data.db` must be in it explicitly.
