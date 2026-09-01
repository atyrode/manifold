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
  GrantSchema,
  IndexEntrySchema,
  PrincipalSchema,
  TileLayoutSchema,
  validateTileLayout,
  type Cap,
  type Container,
  type Grant,
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
  origin: string | null;
}

interface ShareRow {
  id: string;
  hash: string;
  container_id: string;
  caps: string;
  origin: string;
  minted_by: string;
  created_at: number;
  revoked_at: number | null;
  grant_id: string | null;
  tickets: number;
}

interface DialRow {
  id: string;
  origin: string;
  secret: string;
  ref: string | null;
  caps: string;
  title: string | null;
  dialed_at: number;
  revoked_at: number | null;
}

interface TicketRow {
  principal_id: string;
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
  grant_id: string | null;
}

interface GrantRow {
  id: string;
  principal_kind: string;
  principal_id: string | null;
  node: string;
  caps: string;
  effect: string;
  reach: string;
  created_by: string;
  created_at: number;
  bound: number;
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

interface EventDbRow {
  id: number;
  container_id: string | null;
  ts: number;
  principal_id: string | null;
  type: string;
  payload: string;
}

interface MetaRow {
  value: string;
}

interface ExistsRow {
  found: number;
}

/**
 * Durable token metadata. The raw bearer secret deliberately has no field here.
 *
 * `grantId` is the token's REFERENCE to the grant row carrying its authority (ADR 0011: "a
 * token's caps array is a set of synthesized root grants"). `caps` and `containerId` stay
 * beside it, and that is not duplication: they are what the minter CHOSE, which the mint
 * ladder keeps checking, while the grant row is where the evaluator reads authority from.
 * A token with no caps to express (an enrolled machine's) references nothing.
 */
export interface TokenRecord {
  id: string;
  hash: string;
  principalId: string;
  mintedBy: string | null;
  caps: readonly Cap[];
  containerId: string | null;
  createdAt: number;
  revokedAt: number | null;
  grantId: string | null;
}

/**
 * A stored grant, plus the one fact the protocol row cannot carry: whether some TOKEN
 * references it.
 *
 * That flag is the whole attenuation rule of the evaluator. A token-referenced row is the
 * synthesized authority of ONE credential and applies only to the credential that holds it —
 * otherwise a principal's narrow token would inherit its own broad token's row, which is both
 * a parity break against the flat model and a live attenuation hole. An UNREFERENCED row is
 * administered authority: it applies to every credential of the principal or class it names,
 * which is what makes a grant door's allow widen and its deny bite.
 */
export interface GrantRecord extends Grant {
  readonly tokenBound: boolean;
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

/**
 * A SHARE this instance hands out: one container, one capability set, one guest origin.
 * Like `TokenRecord`, the raw secret deliberately has no field here — only its hash — and
 * `tickets` is the count of guest identities minted under it, computed by the read rather
 * than kept as a denormalized counter that could drift from the rows it claims to count.
 *
 * `grantId` references the grant row this share's caps became at mint (ADR 0011: "a share is
 * a token minted against a subtree grant at the shared node"). The row names the guest
 * INSTANCE, not any one of its principals, which is why a ticket needs no grant of its own to
 * inherit the share's authority — its principal carries the origin the row names.
 */
export interface ShareRecord {
  id: string;
  hash: string;
  containerId: string;
  caps: readonly Cap[];
  origin: string;
  mintedBy: string;
  createdAt: number;
  revokedAt: number | null;
  grantId: string | null;
  tickets: number;
}

/**
 * The same relationship from the other end: a grant this instance DIALS OUT with. The
 * secret is here in the clear because dialling requires presenting it, which is exactly
 * what a hash cannot do (db.ts migration 12). `ref` and `caps` are the host's last word on
 * what the share names — cached vocabulary this instance draws a row from while the socket
 * is down, and never an authority it evaluates.
 */
export interface DialRecord {
  id: string;
  origin: string;
  secret: string;
  /** NULL only between `createDial` and the host's first welcome; see db.ts migration 12. */
  ref: string | null;
  caps: readonly Cap[];
  title: string | null;
  dialedAt: number;
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

/**
 * One row of the audit trail, camelCased for the wire.
 *
 * `containerId` and `principalId` are both nullable because both are genuinely optional facts:
 * a token revocation is workspace-wide and belongs to no container, and a system-initiated
 * record belongs to no principal. `payload` is the JSON text exactly as `addEvent` stored it —
 * parsing it is the reader's decision, and a row whose payload cannot be parsed must still be
 * readable as a row.
 */
export interface StoredEvent {
  id: number;
  containerId: string | null;
  ts: number;
  principalId: string | null;
  type: string;
  payload: string;
}

/** What a caller may narrow the audit trail by. Omitting a field asks for everything. */
export interface EventFilter {
  readonly containerId?: string;
  readonly type?: string;
  readonly limit: number;
}

/** SHA-256 hex encoding used for bearer secrets and document integrity hashes. */
export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function toToken(row: TokenRow): TokenRecord {
  const caps = parseCaps(row.caps);
  return {
    id: row.id,
    hash: row.hash,
    principalId: row.principal_id,
    mintedBy: row.minted_by,
    caps,
    containerId: row.container_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id,
  };
}

function parseCaps(raw: string): readonly Cap[] {
  const parsed: unknown = JSON.parse(raw);
  return CapSchema.array().parse(parsed);
}

/**
 * A NULL `origin` column means "this instance", and the wire says that by OMITTING the key
 * rather than by carrying a null: `PrincipalSchema` is strict and there is one
 * representation of local. The database keeps a nullable column because SQL has no third
 * way to say absent, and this function is the one place the two spellings meet.
 */
function toPrincipal(row: PrincipalRow): Principal {
  return PrincipalSchema.parse(
    row.origin === null
      ? { id: row.id, kind: row.kind, name: row.name, color: row.color }
      : { id: row.id, kind: row.kind, name: row.name, color: row.color, origin: row.origin },
  );
}

function toShare(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    hash: row.hash,
    containerId: row.container_id,
    caps: parseCaps(row.caps),
    origin: row.origin,
    mintedBy: row.minted_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    grantId: row.grant_id,
    tickets: row.tickets,
  };
}

/**
 * The three-column principal — kind, plus an id whose meaning the kind selects — read back as
 * the discriminated union the protocol defines. A class row carries no id at all, and a bad
 * combination is a THROW rather than a silent narrowing: an authority row this reader could not
 * classify would otherwise be dropped from a walk, which is a denial nobody wrote.
 */
function toGrant(row: GrantRow): GrantRecord {
  const principal =
    row.principal_kind === "instance"
      ? { kind: "instance", origin: row.principal_id }
      : row.principal_kind === "principal"
        ? { kind: "principal", id: row.principal_id }
        : { kind: row.principal_kind };
  return {
    ...GrantSchema.parse({
      id: row.id,
      principal,
      node: row.node,
      caps: JSON.parse(row.caps),
      effect: row.effect,
      reach: row.reach,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }),
    tokenBound: row.bound === 1,
  };
}

/**
 * `bound` is the token reference seen from the grant's side, and it is an EXISTS rather than a
 * join so a row can never be duplicated by the credentials that hold it.
 */
const GRANT_SELECT = `SELECT g.id, g.principal_kind, g.principal_id, g.node, g.caps, g.effect,
          g.reach, g.created_by, g.created_at,
          EXISTS(SELECT 1 FROM tokens t WHERE t.grant_id = g.id) AS bound
   FROM grants g`;

function toDial(row: DialRow): DialRecord {
  return {
    id: row.id,
    origin: row.origin,
    secret: row.secret,
    ref: row.ref,
    caps: parseCaps(row.caps),
    title: row.title,
    dialedAt: row.dialed_at,
    revokedAt: row.revoked_at,
  };
}

const SHARE_SELECT = `SELECT s.id, s.hash, s.container_id, s.caps, s.origin, s.minted_by,
          s.created_at, s.revoked_at, s.grant_id,
          (SELECT COUNT(*) FROM share_tickets t WHERE t.share_id = s.id) AS tickets
   FROM shares s`;

const DIAL_SELECT = `SELECT id, origin, secret, ref, caps, title, dialed_at, revoked_at
   FROM dials`;

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
      .query<void, [string, string, string, string, number, string | null]>(
        `INSERT INTO principals(id, kind, name, color, created_at, origin) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        principal.id,
        principal.kind,
        principal.name,
        principal.color,
        createdAt,
        principal.origin ?? null,
      );
  }

  getPrincipal(id: string): Principal | null {
    const row = this.db
      .query<PrincipalRow, [string]>(
        "SELECT id, kind, name, color, created_at, origin FROM principals WHERE id = ?",
      )
      .get(id);
    return row === null ? null : toPrincipal(row);
  }

  listPrincipals(): Principal[] {
    return this.db
      .query<PrincipalRow, []>(
        "SELECT id, kind, name, color, created_at, origin FROM principals ORDER BY created_at, id",
      )
      .all()
      .map(toPrincipal);
  }

  createToken(record: TokenRecord): void {
    this.db
      .query<
        void,
        [
          string,
          string,
          string,
          string | null,
          string,
          string | null,
          number,
          number | null,
          string | null,
        ]
      >(
        `INSERT INTO tokens(
           id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
           grant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.grantId,
      );
  }

  getTokenByHash(hash: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
                grant_id
         FROM tokens WHERE hash = ?`,
      )
      .get(hash);
    return row === null ? null : toToken(row);
  }

  getToken(id: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, container_id, created_at, revoked_at,
                grant_id
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

  /*
    GRANTS — authority as rows (ADR 0011). Nothing here is hashed and nothing is a secret: a
    grant is bookkeeping ABOUT authority, so the discipline that governs the tokens table
    ("the raw bearer secret deliberately has no field here") has nothing to say about it. What
    governs this table instead is the shape of the one query the evaluator runs on every
    authority question, which is why every read below goes through `GRANT_SELECT`.
  */

  /** Writes one row. The caller owns the transaction, because a grant rarely lands alone. */
  createGrant(grant: Grant): void {
    GrantSchema.parse(grant);
    const principalId =
      grant.principal.kind === "principal"
        ? grant.principal.id
        : grant.principal.kind === "instance"
          ? grant.principal.origin
          : null;
    this.db
      .query<void, [string, string, string | null, string, string, string, string, string, number]>(
        `INSERT INTO grants(
           id, principal_kind, principal_id, node, caps, effect, reach, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        grant.id,
        grant.principal.kind,
        principalId,
        grant.node,
        JSON.stringify(grant.caps),
        grant.effect,
        grant.reach,
        grant.createdBy,
        grant.createdAt,
      );
  }

  getGrant(id: string): GrantRecord | null {
    const row = this.db.query<GrantRow, [string]>(`${GRANT_SELECT} WHERE g.id = ?`).get(id);
    return row === null ? null : toGrant(row);
  }

  /**
   * Removes a row, and with it the authority it carried — immediately and completely.
   *
   * A DELETE rather than a `revoked_at` tombstone, and the asymmetry with tokens and shares is
   * deliberate. Those two are BEARER SECRETS: a secret already handed over cannot be taken
   * back, so the row has to survive to keep refusing what still presents it. A grant presents
   * nothing. There is no holder to refuse, so the absence of the row IS the revocation, and a
   * tombstone would only add a second state the evaluator has to remember to skip.
   *
   * A share that referenced this row loses its reference rather than its own existence: the
   * share row stays exactly as revocable, listable and auditable as it was.
   */
  deleteGrant(id: string): boolean {
    return this.transaction(() => {
      this.db.query<void, [string]>("UPDATE shares SET grant_id = NULL WHERE grant_id = ?").run(id);
      return this.db.query<void, [string]>("DELETE FROM grants WHERE id = ?").run(id).changes > 0;
    });
  }

  /**
   * Every row, or the rows one node or one principal answers for. A read, and the filters narrow
   * it for an administrator's convenience rather than for secrecy — there is no secret here.
   */
  listGrants(
    filter: { node?: string | undefined; principalId?: string | undefined } = {},
  ): GrantRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.node !== undefined) {
      clauses.push("g.node = ?");
      params.push(filter.node);
    }
    if (filter.principalId !== undefined) {
      clauses.push("g.principal_kind = 'principal' AND g.principal_id = ?");
      params.push(filter.principalId);
    }
    const where =
      clauses.length === 0 ? "" : ` WHERE ${clauses.map((one) => `(${one})`).join(" AND ")}`;
    return this.db
      .query<GrantRow, string[]>(`${GRANT_SELECT}${where} ORDER BY g.created_at, g.id`)
      .all(...params)
      .map(toGrant);
  }

  /**
   * THE EVALUATOR'S ONE QUERY: every row on a containment path that could answer for this
   * principal, by id or by class. Called on every authority question, so the narrowing happens
   * in SQL rather than in the walk — a workspace where every token has a root grant would
   * otherwise hand the evaluator the whole table on every request.
   *
   * A principal with no `origin` belongs to this instance, and `principal_id = NULL` matches
   * nothing in SQL, so instance rows sit out a local principal's walk without a branch here.
   */
  grantsFor(principal: Principal, path: readonly string[]): GrantRecord[] {
    if (path.length === 0) return [];
    const placeholders = path.map(() => "?").join(", ");
    return this.db
      .query<GrantRow, (string | null)[]>(
        `${GRANT_SELECT}
         WHERE g.node IN (${placeholders})
           AND ( (g.principal_kind = 'principal' AND g.principal_id = ?)
              OR g.principal_kind = ?
              OR (g.principal_kind = 'instance' AND g.principal_id = ?) )`,
      )
      .all(
        ...path,
        principal.id,
        principal.kind === "human" ? "any-human" : "any-agent",
        principal.origin ?? null,
      )
      .map(toGrant);
  }

  /*
    SHARES — what this instance hands out. Every read below counts its own tickets with a
    correlated subquery rather than keeping a column, because a stale counter beside the
    rows it counts is the kind of lie that only shows up in an audit.
  */

  createShare(record: Omit<ShareRecord, "tickets">): void {
    this.db
      .query<
        void,
        [string, string, string, string, string, string, number, number | null, string | null]
      >(
        `INSERT INTO shares(
           id, hash, container_id, caps, origin, minted_by, created_at, revoked_at, grant_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.hash,
        record.containerId,
        JSON.stringify(record.caps),
        record.origin,
        record.mintedBy,
        record.createdAt,
        record.revokedAt,
        record.grantId,
      );
  }

  getShareByHash(hash: string): ShareRecord | null {
    const row = this.db.query<ShareRow, [string]>(`${SHARE_SELECT} WHERE s.hash = ?`).get(hash);
    return row === null ? null : toShare(row);
  }

  getShare(id: string): ShareRecord | null {
    const row = this.db.query<ShareRow, [string]>(`${SHARE_SELECT} WHERE s.id = ?`).get(id);
    return row === null ? null : toShare(row);
  }

  listShares(): ShareRecord[] {
    return this.db
      .query<ShareRow, []>(`${SHARE_SELECT} ORDER BY s.created_at, s.id`)
      .all()
      .map(toShare);
  }

  revokeShare(shareId: string, revokedAt: number): boolean {
    return (
      this.db
        .query<void, [number, string]>(
          "UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, shareId).changes > 0
    );
  }

  /**
   * The host-side principal standing for one of the guest's, minted once and reused. The
   * insert is `OR IGNORE` and the read follows it in the same transaction, so two
   * `ticket_request`s racing on one socket resolve to the SAME principal instead of
   * quietly minting a second identity for the same person.
   */
  claimShareTicket(
    shareId: string,
    guestPrincipalId: string,
    principalId: string,
    createdAt: number,
  ): string {
    return this.transaction(() => {
      this.db
        .query<void, [string, string, string, number]>(
          `INSERT OR IGNORE INTO share_tickets(share_id, guest_principal_id, principal_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(shareId, guestPrincipalId, principalId, createdAt);
      const row = this.db
        .query<TicketRow, [string, string]>(
          "SELECT principal_id FROM share_tickets WHERE share_id = ? AND guest_principal_id = ?",
        )
        .get(shareId, guestPrincipalId);
      return row === null ? principalId : row.principal_id;
    });
  }

  /** Every host-side principal a share has minted — the exact set a revocation must fence. */
  shareTicketPrincipals(shareId: string): string[] {
    return this.db
      .query<TicketRow, [string]>(
        "SELECT principal_id FROM share_tickets WHERE share_id = ? ORDER BY created_at, principal_id",
      )
      .all(shareId)
      .map((row) => row.principal_id);
  }

  /*
    DIALS — what this instance dials out with. The guest half of the same relationship.
  */

  createDial(record: DialRecord): void {
    this.db
      .query<
        void,
        [string, string, string, string | null, string, string | null, number, number | null]
      >(
        `INSERT INTO dials(
           id, origin, secret, ref, caps, title, dialed_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.origin,
        record.secret,
        record.ref,
        JSON.stringify(record.caps),
        record.title,
        record.dialedAt,
        record.revokedAt,
      );
  }

  getDial(id: string): DialRecord | null {
    const row = this.db.query<DialRow, [string]>(`${DIAL_SELECT} WHERE id = ?`).get(id);
    return row === null ? null : toDial(row);
  }

  getDialByOriginSecret(origin: string, secret: string): DialRecord | null {
    const row = this.db
      .query<DialRow, [string, string]>(`${DIAL_SELECT} WHERE origin = ? AND secret = ?`)
      .get(origin, secret);
    return row === null ? null : toDial(row);
  }

  listDials(): DialRecord[] {
    return this.db.query<DialRow, []>(`${DIAL_SELECT} ORDER BY dialed_at, id`).all().map(toDial);
  }

  /**
   * What the host told us this share names, written back after every `welcome`. A dial's
   * cached vocabulary is refreshed by the authority that owns it and by nothing else.
   */
  updateDialGrant(id: string, ref: string, caps: readonly Cap[], title: string | null): void {
    this.db
      .query<void, [string, string, string | null, string]>(
        "UPDATE dials SET ref = ?, caps = ?, title = ? WHERE id = ?",
      )
      .run(ref, JSON.stringify(caps), title, id);
  }

  revokeDial(id: string, revokedAt: number): boolean {
    return (
      this.db
        .query<void, [number, string]>(
          "UPDATE dials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, id).changes > 0
    );
  }

  /**
   * Erases a dial that never completed its handshake. Deliberately a DELETE and not a
   * revocation: nothing was ever granted, so there is no authority to record the end of,
   * and a `revoked` row for a partnership that never existed would be a lie in the one
   * table an operator reads to answer "who can see my work".
   */
  deleteDial(id: string): boolean {
    return this.db.query<void, [string]>("DELETE FROM dials WHERE id = ?").run(id).changes > 0;
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

  /**
   * THE audit trail, read back. Newest first, and index-backed in both shapes.
   *
   * `addEvent` is the only writer and it has always been append-only; this is the read that
   * makes the rows reachable by something other than a SQL prompt (`core.events.list`). Two
   * queries rather than one, and the split is the index rather than taste: narrowing by
   * container hits `events_by_container_recency (container_id, ts DESC, id DESC)` — the exact
   * shape of the filter and the ordering together — while the unfiltered read walks
   * `events_by_timestamp (ts)` backwards. A single query with `(?1 IS NULL OR container_id = ?1)`
   * would read better and would defeat both: SQLite cannot plan an index seek through an `OR`
   * on the indexed column, so the workspace-wide read would become a table scan and sort as
   * the trail grows.
   *
   * `type` gets exactly that sentinel treatment, and there it is free: no index covers `type`,
   * so it is a predicate the ordering scan applies either way.
   *
   * `ts DESC, id DESC` is the recency order the retention pruning already uses, so "newest"
   * means the same thing to the reader and to the writer that decides what to drop. The `id`
   * tiebreak matters because `ts` is the caller's clock and two records can share a
   * millisecond.
   *
   * `limit` is required, not optional: an unbounded read of a 10,000-row-per-container trail
   * is a door that can be asked to allocate the whole table, and the bound belongs to the
   * caller's contract rather than to a default buried here.
   */
  listEvents(filter: EventFilter): readonly StoredEvent[] {
    const type = filter.type ?? null;
    const rows =
      filter.containerId === undefined
        ? this.db
            .query<EventDbRow, [string | null, number]>(
              `SELECT id, container_id, ts, principal_id, type, payload
                 FROM events
                WHERE (?1 IS NULL OR type = ?1)
                ORDER BY ts DESC, id DESC
                LIMIT ?2`,
            )
            .all(type, filter.limit)
        : this.db
            .query<EventDbRow, [string, string | null, number]>(
              `SELECT id, container_id, ts, principal_id, type, payload
                 FROM events
                WHERE container_id = ?1 AND (?2 IS NULL OR type = ?2)
                ORDER BY ts DESC, id DESC
                LIMIT ?3`,
            )
            .all(filter.containerId, type, filter.limit);
    return rows.map((row) => ({
      id: row.id,
      containerId: row.container_id,
      ts: row.ts,
      principalId: row.principal_id,
      type: row.type,
      payload: row.payload,
    }));
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
