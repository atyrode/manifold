import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  CapSchema,
  PadSchema,
  PadTreeItemSchema,
  PrincipalSchema,
  TileLayoutSchema,
  validateTileLayout,
  type Cap,
  type Pad,
  type PadTreeItem,
  type Principal,
  type TileLayout,
} from "@manifold/protocol";
import { Y } from "@manifold/scene";
import { z } from "zod";

export const EVENTS_RETENTION_DAYS = 30;
export const EVENTS_MAX_PER_PAD = 10_000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Workspace-global plugin enablement and per-principal shells live in `meta`. */
const PLUGINS_DISABLED_META = "plugins:disabled";
const DisabledPluginsSchema = z.array(z.string().min(1)).max(256);

interface PadRow {
  id: string;
  name: string;
  created_at: number;
  layout: string;
}
interface PadTreeRow {
  kind: "pad" | "folder";
  id: string;
  name: string;
  created_at: number;
  parent_id: string | null;
  sort_order: number;
  layout: string;
}
interface TreeRef {
  kind: "pad" | "folder";
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
  pad_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

interface DocRow {
  pad_id: string;
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

interface SessionDbRow {
  id: string;
  machine_id: string;
  pad_id: string | null;
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
  padId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

/** Latest canonical Yjs document loaded into a room. */
export interface DocRecord {
  padId: string;
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

/** Durable terminal session row; geometry/controller remain live broker state by schema. */
export interface StoredSession {
  id: string;
  machineId: string;
  /** The composition this terminal lives in. Never null: a terminal is `homed: "eager"`. */
  padId: string;
  createdBy: string;
  agentPrincipalId: string | null;
  name: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
}

/** Input required to persist a newly created terminal session. */
export interface NewStoredSession {
  id: string;
  machineId: string;
  padId: string;
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
    padId: row.pad_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function toMachine(row: MachineRow): MachineRecord {
  return { id: row.id, name: row.name, tokenId: row.token_id, lastSeen: row.last_seen };
}

/**
 * A pad row IS the container: `layout` selects which of its two disciplines it wears. There
 * is no lifecycle flag beside it any more — nothing dissolves under anybody, so there is
 * nothing to mark as provisional and no return address to remember.
 */
function toPad(row: {
  readonly id: string;
  readonly name: string;
  readonly created_at: number;
  readonly layout: string;
}): Pad {
  if (row.layout !== "canvas" && row.layout !== "tiled") {
    throw new Error(`invalid persisted pad layout: ${row.layout}`);
  }
  return { id: row.id, name: row.name, createdAt: row.created_at, layout: row.layout };
}

function toSession(row: SessionDbRow): StoredSession {
  if (row.status !== "running" && row.status !== "exited") {
    throw new Error(`invalid persisted session status: ${row.status}`);
  }
  if (row.pad_id === null) {
    // Migration 9 gave every session a home and nothing since can take it away: a session
    // is deleted, never unbound. A null here means a write went around the broker.
    throw new Error(`session ${row.id} has no home composition`);
  }
  return {
    id: row.id,
    machineId: row.machine_id,
    padId: row.pad_id,
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
  private readonly eventCountByPad = new Map<string, number>();

  constructor(readonly db: Database) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS events_by_timestamp ON events(ts);
      CREATE INDEX IF NOT EXISTS events_by_pad_recency ON events(pad_id, ts DESC, id DESC);
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
   * write is owed when the composition grows. A corrupt row reads as "nothing disabled":
   * the alternative is a workspace that boots with every plugin dark because one meta value
   * lost its brackets.
   */
  disabledPlugins(): ReadonlySet<string> {
    const raw = this.getMeta(PLUGINS_DISABLED_META);
    if (raw === null) return new Set();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return new Set();
    }
    const parsed = DisabledPluginsSchema.safeParse(decoded);
    return new Set(parsed.success ? parsed.data : []);
  }

  setPluginEnabled(id: string, enabled: boolean): void {
    const disabled = new Set(this.disabledPlugins());
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.setMeta(PLUGINS_DISABLED_META, JSON.stringify([...disabled].sort()));
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

  listPadTree(): PadTreeItem[] {
    return this.db
      .query<PadTreeRow, []>(
        `SELECT kind, id, name, created_at, parent_id, sort_order, layout
         FROM (
           SELECT 'pad' AS kind, id, name, created_at, folder_id AS parent_id, sort_order, layout
           FROM pads
           UNION ALL
           SELECT 'folder' AS kind, id, name, created_at, parent_folder_id AS parent_id, sort_order,
                  'canvas' AS layout
           FROM pad_folders
         )
         ORDER BY COALESCE(parent_id, ''), sort_order, created_at, id`,
      )
      .all()
      .map((row) =>
        row.kind === "pad"
          ? PadTreeItemSchema.parse({
              kind: "pad",
              pad: toPad(row),
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            })
          : PadTreeItemSchema.parse({
              kind: "folder",
              id: row.id,
              name: row.name,
              createdAt: row.created_at,
              parentId: row.parent_id,
              sortOrder: row.sort_order,
            }),
      );
  }

  listPads(): Pad[] {
    return this.listPadTree()
      .filter((item): item is Extract<PadTreeItem, { kind: "pad" }> => item.kind === "pad")
      .map((item) => item.pad);
  }

  getPad(id: string): Pad | null {
    const row = this.db
      .query<PadRow, [string]>("SELECT id, name, created_at, layout FROM pads WHERE id = ?")
      .get(id);
    return row === null ? null : PadSchema.parse(toPad(row));
  }

  private siblingRefs(parentId: string | null): TreeRef[] {
    return this.db
      .query<TreeRef, [string | null, string | null]>(
        `SELECT 'pad' AS kind, id, sort_order FROM pads WHERE folder_id IS ?
         UNION ALL
         SELECT 'folder' AS kind, id, sort_order FROM pad_folders WHERE parent_folder_id IS ?
         ORDER BY sort_order, kind, id`,
      )
      .all(parentId, parentId)
      .map(({ kind, id }) => ({ kind, id }));
  }

  private setTreePosition(item: TreeRef, parentId: string | null, sortOrder: number): void {
    if (item.kind === "pad") {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE pads SET folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    } else {
      this.db
        .query<void, [string | null, number, string]>(
          "UPDATE pad_folders SET parent_folder_id = ?, sort_order = ? WHERE id = ?",
        )
        .run(parentId, sortOrder, item.id);
    }
  }

  private reindexSiblings(parentId: string | null, siblings: readonly TreeRef[]): void {
    siblings.forEach((item, index) => this.setTreePosition(item, parentId, index));
  }

  /** Persists a container at the top level of the index. */
  createPad(pad: Pad): void {
    PadSchema.parse(pad);
    this.db
      .query<void, [string, string, number, number, string]>(
        `INSERT INTO pads(id, name, created_at, sort_order, folder_id, layout)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(pad.id, pad.name, pad.createdAt, this.siblingRefs(null).length, pad.layout);
  }

  createPadFolder(
    folder: { readonly id: string; readonly name: string; readonly createdAt: number },
    parentId: string | null,
  ): boolean {
    if (
      parentId !== null &&
      this.db
        .query<ExistsRow, [string]>("SELECT 1 AS found FROM pad_folders WHERE id = ?")
        .get(parentId) === null
    ) {
      return false;
    }
    const sortOrder = this.siblingRefs(parentId).length;
    this.db
      .query<void, [string, string, number, string | null, number]>(
        `INSERT INTO pad_folders(id, name, created_at, parent_folder_id, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(folder.id, folder.name, folder.createdAt, parentId, sortOrder);
    return true;
  }

  renamePadFolder(id: string, name: string): boolean {
    return (
      this.db
        .query<void, [string, string]>("UPDATE pad_folders SET name = ? WHERE id = ?")
        .run(name, id).changes > 0
    );
  }

  deletePadFolder(id: string): boolean {
    return this.db.transaction(() => {
      const folder = this.listPadTree().find(
        (item): item is Extract<PadTreeItem, { kind: "folder" }> =>
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
      this.db.query<void, [string]>("DELETE FROM pad_folders WHERE id = ?").run(id);
      this.reindexSiblings(folder.parentId, siblings);
      return true;
    })();
  }

  movePadTreeItem(item: TreeRef, parentId: string | null, index: number): boolean {
    return this.db.transaction(() => {
      const tree = this.listPadTree();
      const current = tree.find((candidate) =>
        candidate.kind === "pad"
          ? item.kind === "pad" && candidate.pad.id === item.id
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

  renamePad(id: string, name: string): Pad | null {
    const result = this.db
      .query<void, [string, string]>("UPDATE pads SET name = ? WHERE id = ?")
      .run(name, id);
    return result.changes === 0 ? null : this.getPad(id);
  }

  deletePad(id: string): boolean {
    this.eventCountByPad.delete(id);
    return this.db.transaction(() => {
      const current = this.listPadTree().find(
        (item): item is Extract<PadTreeItem, { kind: "pad" }> =>
          item.kind === "pad" && item.pad.id === id,
      );
      if (current === undefined) return false;
      this.db.query<void, [string]>("DELETE FROM scene_docs WHERE pad_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM events WHERE pad_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM sessions WHERE pad_id = ?").run(id);
      const removed = this.db.query<void, [string]>("DELETE FROM pads WHERE id = ?").run(id);
      if (removed.changes === 0) return false;
      this.reindexSiblings(
        current.parentId,
        this.siblingRefs(current.parentId).filter(
          (item) => !(item.kind === "pad" && item.id === id),
        ),
      );
      return true;
    })();
  }

  latestDoc(
    padId: string,
    onInvalid?: (error: Error, record: InvalidDoc) => void,
  ): DocRecord | null {
    const rows = this.db
      .query<DocRow, [string]>(
        `SELECT pad_id, epoch, rev, ts, hash, doc FROM scene_docs
         WHERE pad_id = ? ORDER BY ts DESC, rev DESC LIMIT 30`,
      )
      .all(padId);
    for (const row of rows) {
      try {
        if (sha256Hex(row.doc) !== row.hash) {
          throw new Error(`scene document hash mismatch for pad ${padId}`);
        }
        const probe = new Y.Doc();
        Y.applyUpdate(probe, row.doc);
        probe.destroy();
        return {
          padId: row.pad_id,
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

  saveDoc(padId: string, epoch: string, rev: number, ts: number, doc: Uint8Array): DocRecord {
    const hash = sha256Hex(doc);
    const save = this.db.transaction(() => {
      this.db
        .query<void, [string, string, number, number, string, Uint8Array]>(
          `INSERT OR REPLACE INTO scene_docs(pad_id, epoch, rev, ts, hash, doc)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(padId, epoch, rev, ts, hash, doc);
      this.db
        .query<void, [string, string]>(
          `DELETE FROM scene_docs
           WHERE pad_id = ? AND rowid NOT IN (
             SELECT rowid FROM scene_docs WHERE pad_id = ?
             ORDER BY ts DESC, rev DESC LIMIT 30
           )`,
        )
        .run(padId, padId);
    });
    save();
    return { padId, epoch, rev, ts, hash, doc: new Uint8Array(doc) };
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
           id, hash, principal_id, minted_by, caps, pad_id, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.hash,
        record.principalId,
        record.mintedBy,
        JSON.stringify(record.caps),
        record.padId,
        record.createdAt,
        record.revokedAt,
      );
  }

  getTokenByHash(hash: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, pad_id, created_at, revoked_at
         FROM tokens WHERE hash = ?`,
      )
      .get(hash);
    return row === null ? null : toToken(row);
  }

  getToken(id: string): TokenRecord | null {
    const row = this.db
      .query<TokenRow, [string]>(
        `SELECT id, hash, principal_id, minted_by, caps, pad_id, created_at, revoked_at
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

  revokeTokensByPrincipal(principalId: string, revokedAt: number, padId?: string): number {
    if (padId !== undefined) {
      return this.db
        .query<void, [number, string, string]>(
          `UPDATE tokens SET revoked_at = ?
           WHERE principal_id = ? AND pad_id = ? AND revoked_at IS NULL`,
        )
        .run(revokedAt, principalId, padId).changes;
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
    padId: string | null,
    ts: number,
    principalId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    const retainedCount = this.transaction((): number | null => {
      this.db
        .query<void, [string | null, number, string | null, string, string]>(
          "INSERT INTO events(pad_id, ts, principal_id, type, payload) VALUES (?, ?, ?, ?, ?)",
        )
        .run(padId, ts, principalId, type, JSON.stringify(payload));
      this.db
        .query<void, [number]>("DELETE FROM events WHERE ts < ?")
        .run(ts - EVENTS_RETENTION_DAYS * MILLISECONDS_PER_DAY);
      if (padId === null) return null;

      const cachedCount = this.eventCountByPad.get(padId);
      let count =
        cachedCount === undefined
          ? this.db
              .query<{ count: number }, [string]>(
                "SELECT COUNT(*) AS count FROM events WHERE pad_id = ?",
              )
              .get(padId)!.count
          : cachedCount + 1;
      if (count <= EVENTS_MAX_PER_PAD) return count;
      this.db
        .query<void, [string, number]>(
          `DELETE FROM events
           WHERE id IN (
             SELECT id FROM events WHERE pad_id = ?
             ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(padId, EVENTS_MAX_PER_PAD);
      count = EVENTS_MAX_PER_PAD;
      return count;
    });
    if (padId !== null && retainedCount !== null) {
      this.eventCountByPad.set(padId, retainedCount);
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

  createSession(session: NewStoredSession): void {
    this.db
      .query<void, [string, string, string, string, string, string, null, number, null]>(
        `INSERT INTO sessions(
           id, machine_id, pad_id, created_by, agent_principal_id,
           status, exit_code, created_at, name
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.machineId,
        session.padId,
        session.createdBy,
        session.agentPrincipalId,
        "running",
        null,
        session.createdAt,
        null,
      );
  }

  getSession(id: string): StoredSession | null {
    const row = this.db
      .query<SessionDbRow, [string]>(
        `SELECT id, machine_id, pad_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM sessions WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toSession(row);
  }

  listSessions(): StoredSession[] {
    return this.db
      .query<SessionDbRow, []>(
        `SELECT id, machine_id, pad_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM sessions ORDER BY created_at, id`,
      )
      .all()
      .map(toSession);
  }

  listRunningSessionsForMachine(machineId: string): StoredSession[] {
    return this.db
      .query<SessionDbRow, [string]>(
        `SELECT id, machine_id, pad_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM sessions WHERE machine_id = ? AND status = 'running' ORDER BY created_at, id`,
      )
      .all(machineId)
      .map(toSession);
  }
  listRunningSessions(): StoredSession[] {
    return this.db
      .query<SessionDbRow, []>(
        `SELECT id, machine_id, pad_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM sessions WHERE status = 'running' ORDER BY created_at, id`,
      )
      .all()
      .map(toSession);
  }

  deleteSession(id: string): boolean {
    return this.db.query<void, [string]>("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  markSessionExited(id: string, exitCode: number | null): boolean {
    return (
      this.db
        .query<void, [number | null, string]>(
          "UPDATE sessions SET status = 'exited', exit_code = ? WHERE id = ?",
        )
        .run(exitCode, id).changes > 0
    );
  }

  /**
   * Moves a session to a different home composition. A session is never unbound: it is
   * deleted, or it lives somewhere. Which is why this takes no null.
   */
  updateSessionPad(id: string, padId: string): void {
    this.db
      .query<void, [string, string]>("UPDATE sessions SET pad_id = ? WHERE id = ?")
      .run(padId, id);
  }

  /** Sets or clears a session's operator-assigned display name. */
  updateSessionName(id: string, name: string | null): void {
    this.db
      .query<void, [string | null, string]>("UPDATE sessions SET name = ? WHERE id = ?")
      .run(name, id);
  }

  /** Sessions homed in one container, in creation order. */
  listSessionsForPad(padId: string): StoredSession[] {
    return this.db
      .query<SessionDbRow, [string]>(
        `SELECT id, machine_id, pad_id, created_by, agent_principal_id,
                status, exit_code, created_at, name
         FROM sessions WHERE pad_id = ? ORDER BY created_at, id`,
      )
      .all(padId)
      .map(toSession);
  }
}
