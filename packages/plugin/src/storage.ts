import type { PluginDataVersion } from "@manifold/protocol";

/**
 * PER-PLUGIN STORAGE — the one place a plugin may keep durable data of its own.
 *
 * A plugin never sees the database. It gets a namespaced key-value ref bound to its
 * manifest id, plus a versioned migration ledger, and that is the whole substrate: two
 * plugins cannot read each other's rows, a purge can erase exactly one plugin's data
 * without knowing anything about its shape, and "which plugin owns this row" is answered by
 * the key's namespace rather than by a comment.
 *
 * The API is SYNCHRONOUS today. The substrate underneath is Bun's SQLite, which is
 * synchronous; an async facade over it would add a promise per read for no concurrency, and
 * would make a data migration — which must be all-or-nothing — interleavable with dispatch.
 *
 * That ruling is already reversed on paper: ADR 0016 §4 (ratified, R3) migrates this
 * interface to a promise-returning one for EVERY plugin, first-party included, and the
 * migration ships with stage 1 of the isolation runner (#151) — one storage contract for
 * in-realm and isolated plugins alike, no dual-contract period, no shim. Until it lands,
 * write call sites so the change is a type change rather than a rewrite: one storage call
 * per statement, never a chain of synchronous reads inside a single expression.
 *
 * Values are strings. A plugin that wants structure serializes it (its own schema, its own
 * versioning) exactly as the server's `meta` rows already do: the engine has no business
 * knowing whether a plugin's blob is JSON, and typing this ref as `unknown` would only
 * move a `JSON.parse` from the caller into the floor.
 *
 * Wave 1 ships the ref and the ledger. The domain tables that today live in bespoke
 * SQLite tables owned by floor code (terminal names, machine rows, view state) move onto
 * this ref in the conversion batch — that move is what the version/ledger machinery
 * below exists for, and why it ships before its first real occupant.
 */
export interface PluginStorage {
  /** The manifest id this handle is bound to; every key below is namespaced by it. */
  readonly pluginId: string;
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  /** Every key this plugin holds, sorted, optionally narrowed to a prefix. */
  keys(prefix?: string): readonly string[];
  /** The data version last stamped by the engine; null when this plugin stored nothing yet. */
  dataVersion(): PluginDataVersion | null;
  /** Names of the migrations already applied, sorted — the ledger. */
  appliedMigrations(): readonly string[];
}

/**
 * The engine's half of the same ref. `set`/`delete` on a `PluginStorage` refuse reserved
 * keys, so a plugin cannot forge its own data version or ledger entry; the engine writes
 * those through here instead. `clear` is the purge verb's hands.
 */
export interface PluginStorageAdmin extends PluginStorage {
  stampDataVersion(version: PluginDataVersion): void;
  recordMigration(name: string, applied: number): void;
  /** Erases every row of this plugin, reserved keys included, and reports how many went. */
  clear(): number;
}

/**
 * Keys are ASCII, bounded, and free of the reserved prefix. The pattern is deliberately
 * generous about interior punctuation (`:` and `.` are how a plugin builds its own
 * sub-namespaces, e.g. `element:abc123`) and strict about the first character, which is what
 * keeps engine-reserved keys unforgeable.
 */
export const PLUGIN_STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Engine-reserved keys start with this; a plugin write naming one is refused. */
export const RESERVED_KEY_PREFIX = "$";

/** The stamped data version of a plugin's stored data. */
export const DATA_VERSION_KEY = `${RESERVED_KEY_PREFIX}version`;

/** One row per applied migration name: the ledger, so a migration runs at most once. */
export const MIGRATION_KEY_PREFIX = `${RESERVED_KEY_PREFIX}migration:`;

/**
 * A value is one string, bounded so a plugin cannot turn the workspace's database into its
 * own object store by accident. A plugin with genuinely large data has a shape problem that
 * a key-value ref should not paper over.
 */
export const MAX_STORAGE_VALUE_BYTES = 64 * 1024;

/** A refused storage operation: an authoring bug, so it throws rather than returning null. */
export class PluginStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginStorageError";
  }
}

/** Validates a key a PLUGIN supplied. Reserved keys are the engine's alone. */
export function assertStorageKey(key: string): void {
  if (key.startsWith(RESERVED_KEY_PREFIX)) {
    throw new PluginStorageError(
      `storage key "${key}" is reserved: keys starting with "${RESERVED_KEY_PREFIX}" belong to the engine`,
    );
  }
  if (!PLUGIN_STORAGE_KEY_PATTERN.test(key)) {
    throw new PluginStorageError(
      `storage key "${key}" is not a valid key (ASCII, 1-128 chars, starting alphanumeric)`,
    );
  }
}

/** Validates a value a plugin supplied. */
export function assertStorageValue(key: string, value: string): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_STORAGE_VALUE_BYTES) {
    throw new PluginStorageError(
      `storage value for "${key}" is ${String(bytes)} bytes, over the ${String(MAX_STORAGE_VALUE_BYTES)}-byte limit`,
    );
  }
}

/** `{ major: 2, minor: 1 }` → `"2.1"`, the stamped on-disk form. */
export function formatDataVersion(version: PluginDataVersion): string {
  return `${String(version.major)}.${String(version.minor)}`;
}

/** The inverse; null for anything that is not two non-negative integers. */
export function parseDataVersion(text: string): PluginDataVersion | null {
  const match = /^(\d{1,9})\.(\d{1,9})$/.exec(text);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Total order on data versions: major first, then minor. */
export function compareDataVersion(left: PluginDataVersion, right: PluginDataVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  return left.minor - right.minor;
}

/**
 * ONE NAMED MIGRATION. The name — not the version — is what the ledger records, because a
 * name is stable under rebase, reordering and version renumbering, and "did this exact
 * transformation already run?" is the only question a ledger has to answer.
 *
 * `to` is the data version this migration produces, so a chain can be planned without
 * running anything, and `assembleRoster` can refuse a migration claiming to reach past the
 * version its own code declares.
 *
 * Synchronous for the reason `PluginStorage` is: a migration is all-or-nothing over a
 * synchronous substrate, and an `await` inside one is an invitation to serve half-migrated
 * data.
 */
export interface PluginMigration {
  readonly name: string;
  readonly to: PluginDataVersion;
  migrate(storage: PluginStorage): void;
}

/**
 * What the engine must do about a plugin's stored data before that plugin serves. The
 * ratified Home-Assistant asymmetry, in one pure function:
 *
 * - **minor differences pass in BOTH directions.** A minor bump promises the old code can
 *   still read the new data; that promise is the definition of "minor", and enforcing it
 *   again here would only forbid rollbacks that are safe by construction.
 * - **a major bump forward requires a declared, unapplied migration chain** reaching the
 *   declared major. Absent one, composition refuses (`data_migration_missing`): new code
 *   over old data it cannot read is the corruption this mechanism exists to prevent.
 * - **a major downgrade refuses** (`data_downgrade`). Old code cannot be trusted with newer
 *   data and no migration runs backwards — HA's own rule.
 * - **no declared `dataVersion` means unversioned**: never refuses, never migrates. A plugin
 *   that keeps no durable data must not be made to think about any of this.
 */
export type DataPlan =
  | { readonly kind: "ok"; readonly stamp: PluginDataVersion | null }
  | {
      readonly kind: "migrate";
      readonly run: readonly PluginMigration[];
      readonly stamp: PluginDataVersion;
    }
  | {
      readonly kind: "refused";
      readonly reason: "data_downgrade" | "data_migration_missing";
      readonly detail: string;
    };

export function planDataMigration(input: {
  readonly pluginId: string;
  readonly declared: PluginDataVersion | undefined;
  readonly stored: PluginDataVersion | null;
  readonly applied: ReadonlySet<string>;
  readonly migrations: readonly PluginMigration[];
}): DataPlan {
  const { pluginId, declared, stored, applied, migrations } = input;
  if (declared === undefined) return { kind: "ok", stamp: null };
  if (stored === null) return { kind: "ok", stamp: declared };
  if (stored.major > declared.major) {
    return {
      kind: "refused",
      reason: "data_downgrade",
      detail: `plugin "${pluginId}" stored data at ${formatDataVersion(stored)} but its code declares ${formatDataVersion(declared)}: a major downgrade is refused, no migration runs backwards`,
    };
  }
  if (stored.major === declared.major) return { kind: "ok", stamp: declared };

  const run = [...migrations]
    .filter((migration) => !applied.has(migration.name))
    .filter((migration) => compareDataVersion(migration.to, stored) > 0)
    .sort(
      (left, right) => compareDataVersion(left.to, right.to) || (left.name < right.name ? -1 : 1),
    );
  const reached = run.at(-1)?.to;
  if (reached === undefined || reached.major < declared.major) {
    return {
      kind: "refused",
      reason: "data_migration_missing",
      detail: `plugin "${pluginId}" stored data at ${formatDataVersion(stored)} and its code declares ${formatDataVersion(declared)}, but no unapplied migration reaches major ${String(declared.major)}`,
    };
  }
  return { kind: "migrate", run, stamp: declared };
}
