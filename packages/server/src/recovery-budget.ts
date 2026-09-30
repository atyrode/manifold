import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  statfsSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseRecoveryAdmission } from "@manifold/protocol";
import { RECOVERY_GATE_FILE, sqliteBusy, withRecoveryGateSync } from "./recovery-gate.ts";

export const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
export const MAX_CHECKPOINT_FILES = 10_000;
export const CHECKPOINT_SAFETY_BYTES = 8 * 1024 * 1024;
export const STORAGE_HEADROOM_BYTES = 16 * 1024 * 1024;
export const RECOVERY_TRANSIENT_PATHS: Readonly<Record<string, true>> = {
  "agent.lock": true,
  "agent.pid": true,
  "manifold.writer": true,
  "manifold.replica-writer": true,
  "terminal-host.pid": true,
  "terminal-host/host.sock": true,
  [RECOVERY_GATE_FILE]: true,
  [`${RECOVERY_GATE_FILE}-journal`]: true,
  [`${RECOVERY_GATE_FILE}-wal`]: true,
  [`${RECOVERY_GATE_FILE}-shm`]: true,
};
const PROFILE = "bounded-wal-v1";
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const GRANULE = 65_536;
const LOCAL_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0x01021994]);

interface Allocation {
  plugin_id: string;
  profile: string;
  max_image_bytes: number;
}
export interface RecoveryInventoryFile {
  readonly path: string;
  readonly bytes: number;
}
interface Inventory {
  readonly files: Map<string, number>;
  readonly allocations: readonly Allocation[];
  readonly stages: readonly Allocation[];
}
class CapacityRefusal extends Error {
  constructor(readonly reason: Exclude<DatabaseRecoveryAdmission, { ok: true }>["reason"]) {
    super(reason);
  }
}

export function boundedWalFamily(maxImageBytes: number): {
  readonly wal: number;
  readonly shm: number;
  readonly physical: number;
} {
  if (
    !Number.isSafeInteger(maxImageBytes) ||
    maxImageBytes <= 0 ||
    maxImageBytes > MAX_IMAGE_BYTES ||
    maxImageBytes % 4096 !== 0
  )
    throw new CapacityRefusal("recovery_unavailable");
  const frames = maxImageBytes / 4096 + 16;
  const wal = 32 + frames * 4120;
  const shm = 32768 * Math.ceil((frames + 34) / 4096);
  // Round each file independently on every supported allocation granule (<=64 KiB).
  const physical = [maxImageBytes, wal, shm].reduce(
    (sum, bytes) => sum + Math.ceil(bytes / GRANULE) * GRANULE,
    0,
  );
  return { wal, shm, physical };
}

function imageRelative(pluginId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId))
    throw new CapacityRefusal("recovery_unavailable");
  return `plugins/${pluginId}/data.db`;
}

/** Journaled migration images are closed byte identities; opening WAL-mode images creates sidecars. */
export function closedRecoveryImages(main: Database): ReadonlySet<string> {
  const paths = new Set<string>();
  if (
    main
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_database_journal'")
      .get()
  ) {
    for (const row of main
      .query<{ plugin_id: string }, []>("SELECT plugin_id FROM plugin_database_journal")
      .all())
      for (const suffix of ["", ".stage", ".backup"])
        paths.add(imageRelative(row.plugin_id) + suffix);
  }
  return paths;
}

/** Same inventory and transient rules as capture; journals are carried by SQLite snapshots. */
export function retainedRecoveryFiles(root: string): string[] {
  const files: string[] = [];
  let directories = 0;
  const visit = (directory: string, prefix: string): void => {
    if (++directories > MAX_CHECKPOINT_FILES) throw new CapacityRefusal("backup_capacity");
    const before = statSync(directory);
    const names = readdirSync(directory).sort();
    for (const name of names) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (RECOVERY_TRANSIENT_PATHS[path] === true) continue;
      if (/[\\\u0000-\u001f\u007f]/.test(path)) throw new CapacityRefusal("backup_capacity");
      const absolute = join(root, path);
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!info.isFile() || info.nlink !== 1) throw new CapacityRefusal("backup_capacity");
      if (/\.(?:db|db\.stage|db\.backup)-(?:wal|shm|journal)$/.test(path)) continue;
      if (files.length === MAX_CHECKPOINT_FILES) throw new CapacityRefusal("backup_capacity");
      files.push(path);
    }
    const after = statSync(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
      throw new CapacityRefusal("backup_capacity");
  };
  visit(root, "");
  // The authorization/grant snapshot must precede every immutable plugin payload snapshot.
  return files.sort((a, b) =>
    a === "manifold.db" ? -1 : b === "manifold.db" ? 1 : a.localeCompare(b),
  );
}

function imageBytes(path: string, main?: Database): number {
  const db = main ?? new Database(path, { readonly: true, strict: true });
  try {
    const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count;
    const size = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size;
    const bytes = Number(pages) * Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new CapacityRefusal("backup_capacity");
    return bytes;
  } finally {
    if (main === undefined) db.close();
  }
}

function inventory(root: string, main: Database): Inventory {
  const files = new Map<string, number>();
  const closedImages = closedRecoveryImages(main);
  for (const path of retainedRecoveryFiles(root)) {
    const absolute = join(root, path);
    const before = lstatSync(absolute);
    const closed = closedImages.has(path);
    if (closed) {
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (existsSync(`${absolute}${suffix}`)) throw new CapacityRefusal("recovery_unavailable");
    }
    const bytes =
      !closed && /\.db(?:\.stage|\.backup)?$/.test(path)
        ? imageBytes(absolute, path === "manifold.db" ? main : undefined)
        : before.size;
    const after = lstatSync(absolute);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new CapacityRefusal("backup_capacity");
    files.set(path, bytes);
  }
  if (!files.has("manifold.db")) throw new CapacityRefusal("recovery_unavailable");
  // Older recovery images predate this optional ledger. A partial schema is invalid.
  const ledgers = main
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('plugin_recovery_allocations','plugin_recovery_stages')",
    )
    .all();
  if (ledgers.length === 1) throw new CapacityRefusal("recovery_unavailable");
  const allocations =
    ledgers.length === 0
      ? []
      : main.query<Allocation, []>("SELECT * FROM plugin_recovery_allocations").all();
  const stages =
    ledgers.length === 0
      ? []
      : main.query<Allocation, []>("SELECT * FROM plugin_recovery_stages").all();
  for (const [rows, suffix] of [
    [allocations, ""],
    [stages, ".stage"],
  ] as const) {
    for (const row of rows) {
      if (row.profile !== PROFILE) throw new CapacityRefusal("recovery_unavailable");
      boundedWalFamily(row.max_image_bytes);
      const path = imageRelative(row.plugin_id) + suffix;
      files.set(path, Math.max(files.get(path) ?? 0, row.max_image_bytes));
    }
  }
  return { files, allocations, stages };
}

/** Exact conservative JSON/header/envelope accounting, including escaped paths and future images. */
export function recoveryArchiveBytes(files: readonly RecoveryInventoryFile[]): number {
  const header = {
    format: 1,
    checkpointId: "x".repeat(96),
    sourceBuild: `${"9".repeat(32)}.${"9".repeat(32)}.${"9".repeat(32)}`,
    capturedAt: "9999-12-31T23:59:59.999Z",
    files: files.map(({ path, bytes }) => ({ path, bytes, sha256: "f".repeat(64) })),
  };
  return (
    8 +
    4 +
    Buffer.byteLength(JSON.stringify(header)) +
    8 +
    32 +
    12 +
    16 +
    files.reduce((sum, file) => sum + file.bytes, 0)
  );
}

interface FilesystemBudget {
  path: string;
  remaining: number;
  inodes: number;
}
function physicalCapacity(
  root: string,
  state: Inventory,
  scratchDir: string,
  additionalBytes: number,
): void {
  if (process.platform !== "linux") throw new CapacityRefusal("recovery_unavailable");
  const filesystems = new Map<number, FilesystemBudget>();
  const claim = (path: string, remaining: number, inodes: number): void => {
    let existing = path;
    let missingComponents = 0;
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) throw new CapacityRefusal("recovery_unavailable");
      existing = parent;
      missingComponents++;
    }
    const stat = statSync(existing);
    inodes += Math.max(0, missingComponents - 1);
    const previous = filesystems.get(stat.dev);
    if (previous === undefined) filesystems.set(stat.dev, { path: existing, remaining, inodes });
    else {
      previous.remaining += remaining;
      previous.inodes += inodes;
    }
  };
  claim(root, 0, 0);
  for (const path of state.files.keys()) claim(join(root, path), 0, 0);
  claim(join(root, "manifold.db"), additionalBytes, 0);
  for (const row of state.allocations) {
    const path = join(root, imageRelative(row.plugin_id));
    let allocated = 0;
    let present = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (!existsSync(`${path}${suffix}`)) continue;
      const info = lstatSync(`${path}${suffix}`);
      if (!info.isFile() || info.nlink !== 1) throw new CapacityRefusal("recovery_unavailable");
      allocated += info.blocks * 512;
      present++;
    }
    claim(
      path,
      Math.max(0, boundedWalFamily(row.max_image_bytes).physical - allocated),
      3 - present,
    );
  }
  for (const row of state.stages) {
    const path = join(root, imageRelative(row.plugin_id));
    // Old canonical/backup plus the new full family, even across an interrupted rename.
    // Do not credit partially materialized stages: unknown crash state is charged in full.
    claim(path, boundedWalFamily(row.max_image_bytes).physical, 4);
  }
  // Capture's VACUUM destinations are deleted before its sealed output is written.
  claim(resolve(scratchDir), MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_FILES + 1);
  for (const budget of filesystems.values()) {
    const fs = statfsSync(budget.path);
    if (!LOCAL_FILESYSTEMS.has(fs.type >>> 0) || fs.bsize <= 0 || fs.bsize > GRANULE)
      throw new CapacityRefusal("recovery_unavailable");
    if (
      fs.bavail * fs.bsize < budget.remaining + STORAGE_HEADROOM_BYTES ||
      fs.ffree < budget.inodes + 16
    )
      throw new CapacityRefusal("storage_capacity");
  }
}

function refusal(error: unknown): DatabaseRecoveryAdmission {
  if (error instanceof CapacityRefusal) return { ok: false, reason: error.reason };
  if (sqliteBusy(error)) return { ok: false, reason: "database_busy" };
  if (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOSPC" || error.code === "EDQUOT")
  )
    return { ok: false, reason: "storage_capacity" };
  return { ok: false, reason: "backup_capacity" };
}

export function inspectRecoveryCapacity(
  dataDir: string,
  main: Database,
  options: {
    readonly additionalBytes?: number;
    readonly additionalFiles?: number;
    readonly scratchDir?: string;
  } = {},
): DatabaseRecoveryAdmission {
  try {
    const state = inventory(resolve(dataDir), main);
    const entries = [...state.files].map(([path, bytes]) => ({ path, bytes }));
    const extraBytes = options.additionalBytes ?? 0;
    const extraFiles = options.additionalFiles ?? 0;
    if (
      !Number.isSafeInteger(extraBytes) ||
      extraBytes < 0 ||
      !Number.isSafeInteger(extraFiles) ||
      extraFiles < 0
    )
      throw new CapacityRefusal("backup_capacity");
    // Unknown future names conservatively reserve the maximum admissible encoded path metadata.
    if (
      entries.length + extraFiles > MAX_CHECKPOINT_FILES ||
      recoveryArchiveBytes(entries) + extraBytes + extraFiles * 25_000 + CHECKPOINT_SAFETY_BYTES >
        MAX_CHECKPOINT_BYTES
    )
      throw new CapacityRefusal("backup_capacity");
    physicalCapacity(resolve(dataDir), state, options.scratchDir ?? tmpdir(), extraBytes);
    return { ok: true };
  } catch (error) {
    return refusal(error);
  }
}

/** Floor-only ledger: a missing/disabled image remains charged until durable purge. */
export class RecoveryBudget {
  constructor(
    readonly dataDir: string,
    private readonly main: Database,
  ) {}

  allocation(pluginId: string): number | null {
    return (
      this.main
        .query<Allocation, [string]>("SELECT * FROM plugin_recovery_allocations WHERE plugin_id=?")
        .get(pluginId)?.max_image_bytes ?? null
    );
  }

  ensureAllocation(pluginId: string, maxImageBytes: number): DatabaseRecoveryAdmission {
    try {
      boundedWalFamily(maxImageBytes);
      imageRelative(pluginId);
      const existing = this.allocation(pluginId);
      if (existing !== null && existing >= maxImageBytes) return { ok: true };
      // A nested savepoint is not durable allocation; never create a file before the outer commit.
      if (this.main.inTransaction) return { ok: false, reason: "database_busy" };
      return withRecoveryGateSync(this.dataDir, () =>
        this.main
          .transaction(() => {
            this.main
              .query(
                `INSERT INTO plugin_recovery_allocations(plugin_id,profile,max_image_bytes) VALUES (?,?,?)
           ON CONFLICT(plugin_id) DO UPDATE SET max_image_bytes=MAX(max_image_bytes,excluded.max_image_bytes)`,
              )
              .run(pluginId, PROFILE, maxImageBytes);
            const result = inspectRecoveryCapacity(this.dataDir, this.main);
            if (!result.ok) throw new CapacityRefusal(result.reason);
            return result;
          })
          .immediate(),
      );
    } catch (error) {
      return refusal(error);
    }
  }

  admit(pluginId: string): DatabaseRecoveryAdmission {
    if (this.allocation(pluginId) === null) return { ok: false, reason: "recovery_unavailable" };
    return inspectRecoveryCapacity(this.dataDir, this.main);
  }

  reserveStage(pluginId: string, maxImageBytes: number): void {
    const allocation = this.ensureAllocation(pluginId, maxImageBytes);
    if (!allocation.ok) throw new Error(`${allocation.reason}: recovery allocation refused`);
    if (this.main.inTransaction) throw new CapacityRefusal("database_busy");
    withRecoveryGateSync(this.dataDir, () =>
      this.main
        .transaction(() => {
          this.main
            .query(
              "INSERT INTO plugin_recovery_stages(plugin_id,profile,max_image_bytes) VALUES (?,?,?)",
            )
            .run(pluginId, PROFILE, maxImageBytes);
          const result = inspectRecoveryCapacity(this.dataDir, this.main);
          if (!result.ok) throw new CapacityRefusal(result.reason);
        })
        .immediate(),
    );
  }

  releaseStageAfterCleanup(pluginId: string): void {
    const path = join(this.dataDir, imageRelative(pluginId));
    for (const image of [".stage", ".backup"])
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        if (existsSync(`${path}${image}${suffix}`))
          throw new Error("recovery stage is still retained");
    const directory = dirname(path);
    if (existsSync(directory)) {
      const fd = openSync(directory, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.main.query("DELETE FROM plugin_recovery_stages WHERE plugin_id=?").run(pluginId);
  }

  releaseAfterPurge(pluginId: string): void {
    const path = join(this.dataDir, imageRelative(pluginId));
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(`${path}${suffix}`)) throw new Error("recovery image is still retained");
    this.releaseStageAfterCleanup(pluginId);
    this.main.query("DELETE FROM plugin_recovery_allocations WHERE plugin_id=?").run(pluginId);
  }
}
