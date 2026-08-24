import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  CapSchema,
  PadSchema,
  PrincipalSchema,
  SceneElementSchema,
  type Cap,
  type Pad,
  type Principal,
  type SceneElement,
} from "@manifold/protocol";

interface PadRow {
  id: string;
  name: string;
  created_at: number;
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

interface SnapshotRow {
  pad_id: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  blob: string;
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
  pad_id: string;
  element_id: string;
  created_by: string;
  agent_principal_id: string | null;
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

/** Latest canonical scene snapshot loaded into a room. */
export interface SnapshotRecord {
  padId: string;
  epoch: string;
  rev: number;
  ts: number;
  hash: string;
  elements: readonly SceneElement[];
}

/** Safe identity logged when a corrupt snapshot is skipped during fallback loading. */
export interface InvalidSnapshot {
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
  padId: string;
  elementId: string;
  createdBy: string;
  agentPrincipalId: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  createdAt: number;
}

/** Input required to persist a newly created terminal session. */
export interface NewStoredSession {
  id: string;
  machineId: string;
  padId: string;
  elementId: string;
  createdBy: string;
  agentPrincipalId: string;
  createdAt: number;
}

/** SHA-256 hex encoding used for bearer secrets and snapshot integrity hashes. */
export function sha256Hex(value: string): string {
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

function toSession(row: SessionDbRow): StoredSession {
  if (row.status !== "running" && row.status !== "exited") {
    throw new Error(`invalid persisted session status: ${row.status}`);
  }
  return {
    id: row.id,
    machineId: row.machine_id,
    padId: row.pad_id,
    elementId: row.element_id,
    createdBy: row.created_by,
    agentPrincipalId: row.agent_principal_id,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
  };
}

/** Synchronous repository over the server-owned SQLite schema. */
export class ServerStore {
  constructor(readonly db: Database) {}

  close(): void {
    this.db.close();
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

  listPads(): Pad[] {
    return this.db
      .query<PadRow, []>("SELECT id, name, created_at FROM pads ORDER BY created_at, id")
      .all()
      .map((row) => PadSchema.parse({ id: row.id, name: row.name, createdAt: row.created_at }));
  }

  getPad(id: string): Pad | null {
    const row = this.db
      .query<PadRow, [string]>("SELECT id, name, created_at FROM pads WHERE id = ?")
      .get(id);
    return row === null
      ? null
      : PadSchema.parse({ id: row.id, name: row.name, createdAt: row.created_at });
  }

  createPad(pad: Pad): void {
    PadSchema.parse(pad);
    this.db
      .query<void, [string, string, number]>(
        "INSERT INTO pads(id, name, created_at) VALUES (?, ?, ?)",
      )
      .run(pad.id, pad.name, pad.createdAt);
  }

  deletePad(id: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.query<void, [string]>("DELETE FROM snapshots WHERE pad_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM events WHERE pad_id = ?").run(id);
      this.db.query<void, [string]>("DELETE FROM sessions WHERE pad_id = ?").run(id);
      return this.db.query<void, [string]>("DELETE FROM pads WHERE id = ?").run(id).changes > 0;
    });
    return remove();
  }

  latestSnapshot(
    padId: string,
    onInvalid?: (error: Error, snapshot: InvalidSnapshot) => void,
  ): SnapshotRecord | null {
    const rows = this.db
      .query<SnapshotRow, [string]>(
        `SELECT pad_id, epoch, rev, ts, hash, blob FROM snapshots
         WHERE pad_id = ? ORDER BY ts DESC, rev DESC LIMIT 30`,
      )
      .all(padId);
    for (const row of rows) {
      try {
        if (sha256Hex(row.blob) !== row.hash) {
          throw new Error(`snapshot hash mismatch for pad ${padId}`);
        }
        const parsed: unknown = JSON.parse(row.blob);
        return {
          padId: row.pad_id,
          epoch: row.epoch,
          rev: row.rev,
          ts: row.ts,
          hash: row.hash,
          elements: SceneElementSchema.array().parse(parsed),
        };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("invalid snapshot");
        onInvalid?.(failure, { epoch: row.epoch, rev: row.rev });
      }
    }
    return null;
  }

  saveSnapshot(
    padId: string,
    epoch: string,
    rev: number,
    ts: number,
    elements: readonly SceneElement[],
  ): SnapshotRecord {
    const blob = JSON.stringify(elements);
    const hash = sha256Hex(blob);
    const save = this.db.transaction(() => {
      this.db
        .query<void, [string, string, number, number, string, string]>(
          `INSERT OR REPLACE INTO snapshots(pad_id, epoch, rev, ts, hash, blob)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(padId, epoch, rev, ts, hash, blob);
      this.db
        .query<void, [string, string]>(
          `DELETE FROM snapshots
           WHERE pad_id = ? AND rowid NOT IN (
             SELECT rowid FROM snapshots WHERE pad_id = ?
             ORDER BY ts DESC, rev DESC LIMIT 30
           )`,
        )
        .run(padId, padId);
    });
    save();
    return { padId, epoch, rev, ts, hash, elements: [...elements] };
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
    this.db
      .query<void, [string | null, number, string | null, string, string]>(
        "INSERT INTO events(pad_id, ts, principal_id, type, payload) VALUES (?, ?, ?, ?, ?)",
      )
      .run(padId, ts, principalId, type, JSON.stringify(payload));
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
        "SELECT id, name, token_id, last_seen FROM machines WHERE name = ? ORDER BY rowid LIMIT 1",
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
      .query<void, [string, string, string, string, string, string, string, null, number]>(
        `INSERT INTO sessions(
           id, machine_id, pad_id, element_id, created_by, agent_principal_id,
           status, exit_code, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.machineId,
        session.padId,
        session.elementId,
        session.createdBy,
        session.agentPrincipalId,
        "running",
        null,
        session.createdAt,
      );
  }

  getSession(id: string): StoredSession | null {
    const row = this.db
      .query<SessionDbRow, [string]>(
        `SELECT id, machine_id, pad_id, element_id, created_by, agent_principal_id,
                status, exit_code, created_at
         FROM sessions WHERE id = ?`,
      )
      .get(id);
    return row === null ? null : toSession(row);
  }

  listSessions(): StoredSession[] {
    return this.db
      .query<SessionDbRow, []>(
        `SELECT id, machine_id, pad_id, element_id, created_by, agent_principal_id,
                status, exit_code, created_at
         FROM sessions ORDER BY created_at, id`,
      )
      .all()
      .map(toSession);
  }

  listRunningSessionsForMachine(machineId: string): StoredSession[] {
    return this.db
      .query<SessionDbRow, [string]>(
        `SELECT id, machine_id, pad_id, element_id, created_by, agent_principal_id,
                status, exit_code, created_at
         FROM sessions WHERE machine_id = ? AND status = 'running' ORDER BY created_at, id`,
      )
      .all(machineId)
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
}
