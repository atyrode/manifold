import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  DATA_VERSION_KEY,
  MIGRATION_KEY_PREFIX,
  RESERVED_KEY_PREFIX,
  assertStorageKey,
  assertStorageValue,
  formatDataVersion,
  parseDataVersion,
  type PluginAttribution,
  type PluginStorageAdmin,
} from "@manifold/plugin";
import {
  CapSchema,
  ContainerSchema,
  IndexEntrySchema,
  PrincipalSchema,
  TileLayoutSchema,
  validateTileLayout,
  type Cap,
  type Container,
  type IndexEntry,
  type Principal,
  type TileLayout,
} from "@manifold/protocol";
import { Y } from "@manifold/scene";
import { z } from "zod";

export const EVENTS_RETENTION_DAYS = 30;
export const EVENTS_MAX_PER_CONTAINER = 10_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Workspace-global plugin enablement and per-principal shells live in `meta`. */
const PLUGINS_DISABLED_META = "plugins:disabled";
const PLUGINS_ATTRIBUTION_META = "plugins:attribution";
const ELEMENT_OWNERS_META = "plugins:element-owners";
const DisabledPluginsSchema = z.array(z.string().min(1)).max(256);
const AttributionSchema = z.record(
  z.string().min(1),
  z.strictObject({ by: z.string().min(1), at: z.number().int() }),
);
const ElementOwnersSchema = z.record(z.string().min(1), z.string().min(1));

/**
 * A `meta` row holding JSON, read defensively. Every caller treats an unparseable value as
 * "nothing recorded": the alternative is a workspace that refuses to boot because one row
 * lost its brackets, and none of these facts is worth that.
 */
function readJsonMeta(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface PluginKvRow {
  value: string;
}
interface PluginKvKeyRow {
  key: string;
}
interface PluginKvCountRow {
  total: number;
}

interface ContainerRow {
  id: string;
  name: string;
  created_at: number;
  discipline: string;
}
interface IndexRow {
  kind: "container" | "folder";
  id: string;
  name: string;
  created_at: number;
  parent_id: string | null;
  sort_order: number;
  discipline: string;
}
interface TreeRef {
  kind: "container" | "folder";
  id: string;
}

interface PrincipalRow {
  id: string;
  kind: string;
  name: string;
  color: string;
  created_at: number;
}

interface TokenRow {
  id: string;
  hash: string;
  principal_id: string;
  minted_by: string | null;
  caps: string;
  container_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface DocRow {
  container_id: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}

interface MachineRow {
  id: string;
  name: string;
  token_id: string;
  last_seen: number;
}

interface MachineAuthRow extends MachineRow {
  hash: string;
  principal_id: string;
  revoked_at: number | null;
}

interface TerminalDbRow {
  id: string;
  machine_id: string;
  container_id: string | null;
  created_by: string;
  agent_principal_id: string | null;
  name: string | null;
  status: string;
  exit_code: number | null;
  created_at: number;
}

interface MetaRow {
  value: string;
}

interface ExistsRow {
  found: number;
}

/** Durable token metadata. The raw bearer secret deliberately has no field here. */
export interface TokenRecord {
  id: string;
  hash: string;
  principalId: string;
  mintedBy: string | null;
  caps: readonly Cap[];
  containerId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

/** Latest canonical Yjs document loaded into a room. */
export interface DocRecord {
  containerId: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  doc: Uint8Array;
}

/** Safe identity logged when a corrupt document row is skipped during fallback loading. */
export interface InvalidDoc {
  epoch: string;
  rev: number;
}

/** Persisted machine identity and its last contact time. */
export interface MachineRecord {
  id: string;
  name: string;
  tokenId: string;
  lastSeen: number;
}

/** Machine identity resulting from a hashed-token lookup. */
export interface MachineAuthRecord extends MachineRecord {
  tokenPrincipalId: string;
  revokedAt: number | null;
}

/** Durable terminal row; geometry/controller remain live broker state by schema. */
export interface StoredTerminal {
  id: string;
  machineId: string;
  /** The container this terminal lives in. Never null: a terminal is `homed: "eager"`. */
  containerId: string;
  createdBy: string;
  agentPrincipalId: string | null;
  name: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
}

/** Input required to persist a newly created terminal. */
export interface NewStoredTerminal {
  id: string;
  machineId: string;
  containerId: string;
  createdBy: string;
  agentPrincipalId: string;
  createdAt: number;
}

/** SHA-256 hex encoding used for bearer secrets and document integrity hashes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toToken(row: TokenRow): TokenRecord {
  const parsed: unknown = JSON.parse(row.caps);
  const caps = CapSchema.array().parse(parsed);
  return {
    id: row.id,
    hash: row.hash,
    principalId: row.principal_id,
    mintedBy: row.minted_by,
    caps,
    containerId: row.container_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function toMachine(row: MachineRow): MachineRecord {
  return { id: row.id, name: row.name, tokenId: row.token_id, lastSeen: row.last_seen };
}

/**
 * A container row is the whole object: `discipline` selects which of its two disciplines the
 * container wears. There is no lifecycle flag beside it any more — nothing dissolves under
 * anybody, so there is nothing to mark as provisional and no return address to remember.
 */
function toContainer(row: {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly discipline: string;
}): Container {
  if (row.discipline !== "canvas" && row.discipline !== "composition") {
    throw new Error(`invalid persisted container discipline: ${row.discipline}`);
  }
  return { id: row.id, name: row.name, createdAt: row.created_at, discipline: row.discipline };
}

function toTerminal(row: TerminalDbRow): StoredTerminal {
  if (row.status !== "running" && row.status !== "exited") {
    throw new Error(`invalid persisted terminal status: ${row.status}`);
  }
  if (row.container_id === null) {
    // Migration 9 gave every terminal a home and nothing since can take it away: a terminal
    // is deleted, never unbound. A null here means a write went around the broker.
    throw new Error(`terminal ${row.id} has no home composition`);
  }
  return {
    id: row.id,
    machineId: row.machine_id,
    containerId: row.container_id,
    createdBy: row.created_by,
    agentPrincipalId: row.agent_principal_id,
    name: row.name,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
  };
}

/** Synchronous repository over the server-owned SQLite schema. */
export class ServerStore {
  private readonly eventCountByContainer = new Map<string, number>();

  constructor(readonly db: Database) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS events_by_timestamp ON events(ts);
      CREATE INDEX IF NOT EXISTS events_by_container_recency
        ON events(container_id, ts DESC, id DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  getMeta(key: string): string | null {
    return (
      this.db.query<MetaRow, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ??
      null
    );
  }

  setMeta(key: string, value: string): void {
    this.db
      .query<void, [string, string]>("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(key, value);
  }

  /**
   * Which plugins an administrator turned off, workspace-globally. Stored as the DISABLED
   * set rather than the enabled one so a plugin that ships later is on by default and no
   * write is owed when the assembly grows. A corrupt row reads as "nothing disabled":
   * the alternative is a workspace that boots with every plugin dark because one meta value
   * lost its brackets.
   */
  disabledPlugins(): ReadonlySet<string> {
    const parsed = DisabledPluginsSchema.safeParse(
      readJsonMeta(this.getMeta(PLUGINS_DISABLED_META)),
    );
    return new Set(parsed.success ? parsed.data : []);
  }

  /**
   * Flips one plugin, and records WHO and WHEN. Attribution is workspace-global shared
   * state like the flag itself: "the machines section vanished" is a question every
   * principal in the workspace can now answer without reading a log they cannot see.
   */
  setPluginEnabled(id: string, enabled: boolean, changedBy: string, changedAt: number): void {
    const disabled = new Set(this.disabledPlugins());
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.setMeta(PLUGINS_DISABLED_META, JSON.stringify([...disabled].sort()));
    const attribution = new Map(this.pluginAttribution());
    attribution.set(id, { by: changedBy, at: changedAt });
    this.setMeta(
      PLUGINS_ATTRIBUTION_META,
      JSON.stringify(
        Object.fromEntries([...attribution].sort(([left], [right]) => (left < right ? -1 : 1))),
      ),
    );
  }

  /** Who last flipped each plugin, and when. A corrupt row reads as "nobody knows". */
  pluginAttribution(): ReadonlyMap<string, PluginAttribution> {
    const parsed = AttributionSchema.safeParse(
      readJsonMeta(this.getMeta(PLUGINS_ATTRIBUTION_META)),
    );
    return new Map(Object.entries(parsed.success ? parsed.data : {}));
  }

  /**
   * ELEMENT-TYPE RESERVATIONS — wire type → the plugin that claimed it. A tombstone, not a
   * cache: it survives the owner being disabled, going dormant, or leaving the build, because
   * the documents that stored `type: "draw"` survive all three. Assembly refuses a
   * different plugin claiming a reserved type, so a canvas full of one plugin's elements can
   * never be silently reinterpreted by whatever ships next under that name.
   */
  elementOwners(): ReadonlyMap<string, string> {
    const parsed = ElementOwnersSchema.safeParse(readJsonMeta(this.getMeta(ELEMENT_OWNERS_META)));
    return new Map(Object.entries(parsed.success ? parsed.data : {}));
  }

  /** Claims unreserved types for `pluginId`; existing reservations are left alone. */
  claimElementTypes(pluginId: string, types: readonly string[]): void {
    const owners = new Map(this.elementOwners());
    let changed = false;
    for (const type of types) {
      if (owners.has(type)) continue;
      owners.set(type, pluginId);
      changed = true;
    }
    if (!changed) return;
    this.writeElementOwners(owners);
  }

  /** Releases every reservation held by `pluginId` — the purge verb's hands, and only its. */
  releaseElementTypes(pluginId: string): number {
    const owners = new Map(this.elementOwners());
    let released = 0;
    for (const [type, owner] of owners) {
      if (owner !== pluginId) continue;
      owners.delete(type);
      released += 1;
    }
    if (released > 0) this.writeElementOwners(owners);
    return released;
  }

  private writeElementOwners(owners: ReadonlyMap<string, string>): void {
    this.setMeta(
      ELEMENT_OWNERS_META,
      JSON.stringify(
        Object.fromEntries([...owners].sort(([left], [right]) => (left < right ? -1 : 1))),
      ),
    );
  }

  /**
   * PER-PLUGIN STORAGE, bound to one plugin id. The engine hands this to a plugin as
   * `ctx.storage`; the plugin sees a namespaced key-value store and never the database,
   * so two plugins cannot read each other's rows and a purge erases exactly one namespace.
   *
   * Returned as the ADMIN handle. `PluginHost` keeps that and hands plugins the narrower
   * `PluginStorage` view, whose `set`/`delete` refuse the engine's reserved keys — a plugin
   * cannot forge its own data version or a ledger entry saying a migration already ran.
   */
  pluginStorage(pluginId: string): PluginStorageAdmin {
    const read = (key: string): string | null =>
      this.db
        .query<PluginKvRow, [string, string]>(
          "SELECT value FROM plugin_kv WHERE plugin_id = ? AND key = ?",
        )
        .get(pluginId, key)?.value ?? null;
    const write = (key: string, value: string): void => {
      this.db
        .query<void, [string, string, string]>(
          "INSERT OR REPLACE INTO plugin_kv(plugin_id, key, value) VALUES (?, ?, ?)",
        )
        .run(pluginId, key, value);
    };
    const drop = (key: string): void => {
      this.db
        .query<void, [string, string]>("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?")
        .run(pluginId, key);
    };
    const scan = (prefix: string): readonly string[] =>
      this.db
        .query<PluginKvKeyRow, [string, string]>(
          "SELECT key FROM plugin_kv WHERE plugin_id = ? AND key LIKE ? || '%' ORDER BY key",
        )
        .all(pluginId, prefix)
        .map((row) => row.key);
    return {
      pluginId,
      get: (key) => read(key),
      set: (key, value) => {
        assertStorageKey(key);
        assertStorageValue(key, value);
        write(key, value);
      },
      delete: (key) => {
        assertStorageKey(key);
        drop(key);
      },
      // A plugin's own keys only: the engine's reserved rows are not part of the keyspace it
      // iterates, or every `keys()` consumer would have to learn to skip them.
      keys: (prefix) => scan(prefix ?? "").filter((key) => !key.startsWith(RESERVED_KEY_PREFIX)),
      dataVersion: () => {
        const raw = read(DATA_VERSION_KEY);
        return raw === null ? null : parseDataVersion(raw);
      },
      appliedMigrations: () =>
        scan(MIGRATION_KEY_PREFIX).map((key) => key.slice(MIGRATION_KEY_PREFIX.length)),
      stampDataVersion: (version) => {
        write(DATA_VERSION_KEY, formatDataVersion(version));
      },
      recordMigration: (name, applied) => {
        write(`${MIGRATION_KEY_PREFIX}${name}`, String(applied));
      },
      clear: () => {
        const removed = this.db
          .query<PluginKvCountRow, [string]>(
            "SELECT count(*) AS total FROM plugin_kv WHERE plugin_id = ?",
          )
          .get(pluginId)?.total;
        this.db.query<void, [string]>("DELETE FROM plugin_kv WHERE plugin_id = ?").run(pluginId);
        return removed ?? 0;
      },
    };
  }

  /**
   * One principal's workspace tree — the shell itself, as a tile composition. Null means
   * "never written", which the door answers with the default layout; an unreadable or
   * structurally invalid stored tree ALSO reads as null, because a principal whose stored
   * shell went bad must get a working workspace back rather than a blank screen.
   */
  workspaceLayout(principalId: string): TileLayout | null {
    const raw = this.getMeta(`layout:${principalId}`);
    if (raw === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = TileLayoutSchema.safeParse(decoded);
    if (!parsed.success || !validateTileLayout(parsed.data)) return null;
    return parsed.data;
  }

  /** Refuses to persist a tree the reader would then have to reject. */
  setWorkspaceLayout(principalId: string, layout: TileLayout): void {
    const parsed = TileLayoutSchema.parse(layout);
    if (!validateTileLayout(parsed)) {
      throw new Error("workspace layout is not a valid tile tree");
    }
    this.setMeta(`layout:${principalId}`, JSON.stringify(parsed));
  }

  listIndex(): IndexEntry[] {
    return this.db
      .query<IndexRow, []>(
        `SELECT kind, id, name, created_at, parent_id, sort_order, discipline
         FROM (
           SELECT 'container' AS kind, id, name, created_at, folder_id AS parent_id, sort_order,
                  discipline
           FROM containers
           UNION ALL
           SELECT 'folder' AS kind, id, name, created_at, parent_folder_id AS parent_id, sort_order,
                  'canvas' AS discipline
           FROM container_folders
         )
         ORDER BY COALESCE(parent_id, ''), sort_order, created_at, id`,
      )
      .all()
      .map((row) =>
        row.kind === "container"
          ? IndexEntrySchema.parse({
              kind: "container",
              container: toContainer(row),
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            })
          : IndexEntrySchema.parse({
              kind: "folder",
              id: row.id,
              name: row.name,
              createdAt: row.created_at,
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            }),
      );
  }

  listContainers(): Container[] {
    return this.listIndex()
      .filter(
        (item): item is Extract<IndexEntry, { kind: "container" }> => item.kind === "container",
      )
      .map((item) => item.container);
  }

  getContainer(id: string): Container | null {
    const row = this.db
      .query<ContainerRow, [string]>(
        "SELECT id, name, created_at, discipline FROM containers WHERE id = ?",
      )
      .get(id);
    return row === null ? null : ContainerSchema.parse(toContainer(row));
  }

  private siblingRefs(parentId: string | null): TreeRef[] {
    return this.db
      .query<TreeRef, [string | null, string | null]>(
        `SELECT 'container' AS kind, id, sort_order FROM containers WHERE folder_id IS ?
         UNION ALL
         SELECT 'folder' AS kind, id, sort_order FROM container_folders
         WHERE parent_folder_id IS ?
         ORDER BY sort_order, kind, id`,
      )
      .all(parentId, parentId)
      .map(({ kind, id }) => ({ kind, id }));
  }

  private setTreePosition(item: TreeRef, parentId: string | null, sortOrder: number): void {
    if (item.kind === "container") {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE containers SET folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    } else {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE container_folders SET parent_folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    }
  }

  private reindexSiblings(parentId: string | null, siblings: readonly TreeRef[]): void {
    siblings.forEach((item, index) => this.setTreePosition(item, parentId, index));
  }

  /** Persists a container at the top level of the index. */
  createContainer(container: Container): void {
    ContainerSchema.parse(container);
    this.db
      .query<void, [string, string, number, number, string]>(
        `INSERT INTO containers(id, name, created_at, sort_order, folder_id, discipline)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        container.id,
        container.name,
        container.createdAt,
        this.siblingRefs(null).length,
        container.discipline,
      );
  }

  createFolder(
    folder: { readonly id: string; readonly name: string; readonly createdAt: number },
    parentId: string | null,
  ): boolean {
    if (
      parentId !== null &&
      this.db
        .query<ExistsRow, [string]>("SELECT 1 AS found FROM container_folders WHERE id = ?")
        .get(parentId) === null
    ) {
      return false;
    }
    const sortOrder = this.siblingRefs(parentId).length;
    this.db
      .query<void, [string, string, number, string | null, number]>(
        `INSERT INTO container_folders(id, name, created_at, parent_folder_id, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(folder.id, folder.name, folder.createdAt, parentId, sortOrder);
    return true;
  }

  renameFolder(id: string, name: string): boolean {
    return (
      this.db
        .query<void, [string, string]>("UPDATE container_folders SET name = ? WHERE id = ?")
        .run(name, id).changes > 0
    );
  }

  deleteFolder(id: string): boolean {
    return this.db.transaction(() => {
      const folder = this.listIndex().find(
        (item): item is Extract<IndexEntry, { kind: "folder" }> =>
          item.kind === "folder" && item.id === id,
      );
      if (folder === undefined) return false;
      const siblings = this.siblingRefs(folder.parentId).filter(
        (item) => !(item.kind === "folder" && item.id === id),
      );
      const children = this.siblingRefs(id);
      const insertionIndex = Math.min(folder.sortOrder, siblings.length);
      siblings.splice(insertionIndex, 0, ...children);
      for (const child of children) this.setTreePosition(child, folder.parentId, 0);
      this.db.query<void, [string]>("DELETE FROM container_folders WHERE id = ?").run(id);
      this.reindexSiblings(folder.parentId, siblings);
      return true;
    })();
  }

  moveIndexEntry(item: TreeRef, parentId: string | null, index: number): boolean {
    return this.db.transaction(() => {
      const tree = this.listIndex();
      const current = tree.find((candidate) =>
        candidate.kind === "container"
          ? item.kind === "container" && candidate.container.id === item.id
          : item.kind === "folder" && candidate.id === item.id,
      );
      if (current === undefined) return false;
      if (parentId !== null) {
        const parent = tree.find(
          (candidate) => candidate.kind === "folder" && candidate.id === parentId,
        );
        if (parent === undefined) return false;
      }
      if (item.kind === "folder") {
        let ancestorId = parentId;
        while (ancestorId !== null) {
          if (ancestorId === item.id) return false;
          const ancestor = tree.find(
            (candidate) => candidate.kind === "folder" && candidate.id === ancestorId,
          );
          ancestorId = ancestor?.parentId ?? null;
        }
      }
      const oldParentId = current.parentId;
      const oldSiblings = this.siblingRefs(oldParentId).filter(
        (candidate) => !(candidate.kind === item.kind && candidate.id === item.id),
      );
      const destination =
        oldParentId === parentId
          ? oldSiblings
          : this.siblingRefs(parentId).filter(
              (candidate) => !(candidate.kind === item.kind && candidate.id === item.id),
            );
      destination.splice(Math.min(index, destination.length), 0, item);
      if (oldParentId !== parentId) this.reindexSiblings(oldParentId, oldSiblings);
      this.reindexSiblings(parentId, destination);
      return true;
    })();
  }

  renameContainer(id: string, name: string): Container | null {
    const result = this.db
      .query<void, [string, string]>("UPDATE containers SET name = ? WHERE id = ?")
      .run(name, id);
    return result.changes === 0 ? null : this.getContainer(id);
  }

  deleteContainer(id: string): boolean {
    this.eventCountByContainer.delete(id);
    return this.db.transaction(() => {
      const current = this.listIndex().find(
        (item): item is Extract<IndexEntry, { kind: "container" }> =>
          item.kind === "container" && item.container.id === id,
      );
      if (current === undefined) return false;
      this.db.query<void, [string]>("DELETE FROM scene_docs WHERE container_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM events WHERE container_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM terminals WHERE container_id = ?").run(id);
      const removed = this.db.query<void, [string]>("DELETE FROM containers WHERE id = ?").run(id);
      if (removed.changes === 0) return false;
      this.reindexSiblings(
        current.parentId,
        this.siblingRefs(current.parentId).filter(
          (item) => !(item.kind === "container" && item.id === id),
        ),
      );
      return true;
    })();
  }

  latestDoc(
    containerId: string,
    onInvalid?: (error: Error, record: InvalidDoc) => void,
  ): DocRecord | null {
    const rows = this.db
      .query<DocRow, [string]>(
        `SELECT container_id, epoch, rev, ts, hash, doc FROM scene_docs
         WHERE container_id = ? ORDER BY ts DESC, rev DESC LIMIT 30`,
      )
      .all(containerId);
    for (const row of rows) {
      try {
        if (sha256Hex(row.doc) !== row.hash) {
          throw new Error(`scene document hash mismatch for container ${containerId}`);
        }
        const probe = new Y.Doc();
        Y.applyUpdate(probe, row.doc);
        probe.destroy();
        return {
          containerId: row.container_id,
          epoch: row.epoch,
          rev: row.rev,
          ts: row.ts,
          hash: row.hash,
          doc: new Uint8Array(row.doc),
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("invalid scene document");
        onInvalid?.(failure, { epoch: row.epoch, rev: row.rev });
      }
    }
    return null;
  }

  saveDoc(containerId: string, epoch: string, rev: number, ts: number, doc: Uint8Array): DocRecord {
    const hash = sha256Hex(doc);
    const save = this.db.transaction(() => {
      this.db
        .query<void, [string, string, number, number, string, Uint8Array]>(
          `INSERT OR REPLACE INTO scene_docs(container_id, epoch, rev, ts, hash, doc)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(containerId, epoch, rev, ts, hash, doc);
      this.db
        .query<void, [string, string]>(
          `DELETE FROM scene_docs
           WHERE container_id = ? AND rowid NOT IN (
             SELECT rowid FROM scene_docs WHERE container_id = ?
             ORDER BY ts DESC, rev DESC LIMIT 30
           )`,
        )
        .run(containerId, containerId);
    });
    save();
    return { containerId, epoch, rev, ts, hash, doc: new Uint8Array(doc) };
  }

  createPrincipal(principal: Principal, createdAt: number): void {
    PrincipalSchema.parse(principal);
    this.db
      .query<void, [string, string, string, string, number]>(
        `INSERT INTO principals(id, kind, name, color, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(principal.id, principal.kind, principal.name, principal.color, createdAt);
  }

  getPrincipal(id: string): Principal | null {
    const row = this.db
      .query<PrincipalRow, [string]>(
        "SELECT id, kind, name, color, created_at FROM principals WHERE id = ?",
      )
      .get(id);
    return row === null
      ? null
      : PrincipalSchema.parse({
          id: row.id,
          kind: row.kind,
          name: row.name,
          color: row.color,
        });
  }

  listPrincipals(): Principal[] {
    return this.db
      .query<PrincipalRow, []>(
        "SELECT id, kind, name, color, created_at FROM principals ORDER BY created_at, id",
      )
      .all()
      .map((row) =>
        PrincipalSchema.parse({
          id: row.id,
          kind: row.kind,
          name: row.name,
          color: row.color,
        }),
      );
  }

  createToken(record: TokenRecord): void {
    this.db
      .query<
        void,
        [string, string, string, string | null, string, string | null, number, number | null]
      >(
        `INSERT INTO tokens(
           id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.hash,
        record.principalId,
        record.mintedBy,
        JSON.stringify(record.caps),
        record.containerId,
        record.createdAt,
        record.revokedAt,
      );
  }

  getTokenByHash(hash: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at
         FROM tokens WHERE hash = ?`,
      )
      .get(hash);
    return row === null ? null : toToken(row);
  }

  getToken(id: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at
         FROM tokens WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toToken(row);
  }

  /** Whether this actor originally issued a token while creating the target identity. */
  principalMintedBy(principalId: string, minterId: string): boolean {
    const row = this.db
      .query<ExistsRow, [string, string]>(
        `SELECT 1 AS found FROM tokens
         WHERE principal_id = ? AND minted_by = ? LIMIT 1`,
      )
      .get(principalId, minterId);
    return row?.found === 1;
  }

  revokeTokensByPrincipal(principalId: string, revokedAt: number, containerId?: string): number {
    if (containerId !== undefined) {
      return this.db
        .query<void, [number, string, string]>(
          `UPDATE tokens SET revoked_at = ?
           WHERE principal_id = ? AND container_id = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, principalId, containerId).changes;
    }
    return this.db
      .query<void, [number, string]>(
        "UPDATE tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, principalId).changes;
  }

  revokeToken(tokenId: string, revokedAt: number): boolean {
    return (
      this.db
        .query<void, [number, string]>(
          "UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, tokenId).changes > 0
    );
  }

  addEvent(
    containerId: string | null,
    ts: number,
    principalId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const retainedCount = this.transaction((): number | null => {
      this.db
        .query<void, [string | null, number, string | null, string, string]>(
          `INSERT INTO events(container_id, ts, principal_id, type, payload)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(containerId, ts, principalId, type, JSON.stringify(payload));
      this.db
        .query<void, [number]>("DELETE FROM events WHERE ts < ?")
        .run(ts - EVENTS_RETENTION_DAYS * MILLISECONDS_PER_DAY);
      if (containerId === null) return null;

      const cachedCount = this.eventCountByContainer.get(containerId);
      let count =
        cachedCount === undefined
          ? this.db
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM events WHERE container_id = ?",
              )
              .get(containerId)!.count
          : cachedCount + 1;
      if (count <= EVENTS_MAX_PER_CONTAINER) return count;
      this.db
        .query<void, [string, number]>(
          `DELETE FROM events
           WHERE id IN (
             SELECT id FROM events WHERE container_id = ?
             ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(containerId, EVENTS_MAX_PER_CONTAINER);
      count = EVENTS_MAX_PER_CONTAINER;
      return count;
    });
    if (containerId !== null && retainedCount !== null) {
      this.eventCountByContainer.set(containerId, retainedCount);
    }
  }

  createMachine(machine: MachineRecord): void {
    this.db
      .query<void, [string, string, string, number]>(
        "INSERT INTO machines(id, name, token_id, last_seen) VALUES (?, ?, ?, ?)",
      )
      .run(machine.id, machine.name, machine.tokenId, machine.lastSeen);
  }

  updateMachineToken(machineId: string, tokenId: string, at: number): void {
    this.db
      .query<void, [string, number, string]>(
        "UPDATE machines SET token_id = ?, last_seen = ? WHERE id = ?",
      )
      .run(tokenId, at, machineId);
  }

  getMachine(id: string): MachineRecord | null {
    const row = this.db
      .query<MachineRow, [string]>(
        "SELECT id, name, token_id, last_seen FROM machines WHERE id = ?",
      )
      .get(id);
    return row === null ? null : toMachine(row);
  }

  getMachineByName(name: string): MachineRecord | null {
    const row = this.db
      .query<MachineRow, [string]>(
        "SELECT id, name, token_id, last_seen FROM machines WHERE name = ?",
      )
      .get(name);
    return row === null ? null : toMachine(row);
  }

  listMachines(): MachineRecord[] {
    return this.db
      .query<MachineRow, []>("SELECT id, name, token_id, last_seen FROM machines ORDER BY name, id")
      .all()
      .map(toMachine);
  }

  authenticateMachine(hash: string): MachineAuthRecord | null {
    const row = this.db
      .query<MachineAuthRow, [string]>(
        `SELECT m.id, m.name, m.token_id, m.last_seen,
                t.hash, t.principal_id, t.revoked_at
         FROM machines m JOIN tokens t ON t.id = m.token_id
         WHERE t.hash = ?`,
      )
      .get(hash);
    if (row === null) return null;
    return {
      id: row.id,
      name: row.name,
      tokenId: row.token_id,
      lastSeen: row.last_seen,
      tokenPrincipalId: row.principal_id,
      revokedAt: row.revoked_at,
    };
  }

  touchMachine(machineId: string, name: string, at: number): void {
    this.db
      .query<void, [string, number, string]>(
        "UPDATE machines SET name = ?, last_seen = ? WHERE id = ?",
      )
      .run(name, at, machineId);
  }

  createTerminal(terminal: NewStoredTerminal): void {
    this.db
      .query<void, [string, string, string, string, string, string, null, number, null]>(
        `INSERT INTO terminals(
           id, machine_id, container_id, created_by, agent_principal_id,
           status, exit_code, created_at, name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        terminal.id,
        terminal.machineId,
        terminal.containerId,
        terminal.createdBy,
        terminal.agentPrincipalId,
        "running",
        null,
        terminal.createdAt,
        null,
      );
  }

  getTerminal(id: string): StoredTerminal | null {
    const row = this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM terminals WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toTerminal(row);
  }

  listTerminals(): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, []>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM terminals ORDER BY created_at, id`,
      )
      .all()
      .map(toTerminal);
  }

  listRunningTerminalsForMachine(machineId: string): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM terminals WHERE machine_id = ? AND status = 'running' ORDER BY created_at, id`,
      )
      .all(machineId)
      .map(toTerminal);
  }
  listRunningTerminals(): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, []>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM terminals WHERE status = 'running' ORDER BY created_at, id`,
      )
      .all()
      .map(toTerminal);
  }

  deleteTerminal(id: string): boolean {
    return this.db.query<void, [string]>("DELETE FROM terminals WHERE id = ?").run(id).changes > 0;
  }

  markTerminalExited(id: string, exitCode: number | null): boolean {
    return (
      this.db
        .query<void, [number | null, string]>(
          "UPDATE terminals SET status = 'exited', exit_code = ? WHERE id = ?",
        )
        .run(exitCode, id).changes > 0
    );
  }

  /**
   * Moves a terminal to a different home container. A terminal is never unbound: it is
   * deleted, or it lives somewhere. Which is why this takes no null.
   */
  updateTerminalContainer(id: string, containerId: string): void {
    this.db
      .query<void, [string, string]>("UPDATE terminals SET container_id = ? WHERE id = ?")
      .run(containerId, id);
  }

  /** Sets or clears a terminal's operator-assigned display name. */
  updateTerminalName(id: string, name: string | null): void {
    this.db
      .query<void, [string | null, string]>("UPDATE terminals SET name = ? WHERE id = ?")
      .run(name, id);
  }

  /** Terminals homed in one container, in creation order. */
  listTerminalsForContainer(containerId: string): StoredTerminal[] {
    return this.db
      .query<TerminalDbRow, [string]>(
        `SELECT id, machine_id, container_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM terminals WHERE container_id = ? ORDER BY created_at, id`,
      )
      .all(containerId)
      .map(toTerminal);
  }
}
