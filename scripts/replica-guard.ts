#!/usr/bin/env bun
/**
 * A replicated application cannot serve until its claim is visible in a read-only restore.
 * While it serves, the claim's heartbeat advances, so a replacement can tell a stopped writer
 * from an idle one. Shutdown stops the application and publishes the main database's seal: at
 * once when there are no auxiliary databases, otherwise after stopping replication and verifying
 * each of them. Restored history is admitted when sealed, or taken over once its replica stays
 * quiet. This also supervises an older recovery executable.
 *
 * Assumes one writer and trusted, read-after-write-consistent replica storage. This is not a
 * distributed lease or authentication of hostile object storage. Recovery's non-SQLite files
 * remain pinned to its authenticated checkpoint under the existing recovery contract.
 */
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const KEY = "replica-writer";
const HEARTBEAT_KEY = "replica-writer-heartbeat";
const START_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 10_000;
const SYNC_TIMEOUT_MS = 300_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
// A busy beat blocks the supervisor's event loop; the next tick retries instead of waiting long.
const HEARTBEAT_BUSY_TIMEOUT_MS = 1_000;
export const TAKEOVER_QUIET_MS = 30_000;
export const TAKEOVER_DEADLINE_MS = 150_000;
const TAKEOVER_POLL_MS = 2_000;
// Each listing has its own bound, so one in flight at the deadline is not reported unavailable.
const TAKEOVER_POLL_TIMEOUT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface ReplicaFile {
  readonly path: string;
  readonly sha256: string;
}
interface WriterIdentity {
  readonly version: 1;
  readonly epoch: number;
  readonly id: string;
}
interface ActiveWriter extends WriterIdentity {
  readonly state: "active";
  readonly databases: readonly string[];
}
interface SealedWriter extends WriterIdentity {
  readonly state: "sealed";
  readonly databases: readonly ReplicaFile[];
}
type ReplicaWriter = ActiveWriter | SealedWriter;

export class ReplicaGuardRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ReplicaGuardRefusal";
  }
}

function event(state: string): void {
  console.log(JSON.stringify({ evt: "hub_replica_boot", state }));
}

function exists(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function databaseName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "manifold.db" &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function record(database: Database): ReplicaWriter | null {
  const row = database
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(KEY);
  if (row === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw new ReplicaGuardRefusal("replica_writer_invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("epoch" in value) ||
    typeof value.epoch !== "number" ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 1 ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !("state" in value) ||
    (value.state !== "active" && value.state !== "sealed") ||
    !("databases" in value) ||
    !Array.isArray(value.databases)
  )
    throw new ReplicaGuardRefusal("replica_writer_invalid");
  const identity: WriterIdentity = { version: 1, epoch: value.epoch, id: value.id };
  const names = new Set<string>();
  if (value.state === "active") {
    const databases: string[] = [];
    for (const name of value.databases as unknown[]) {
      if (!databaseName(name) || names.has(name))
        throw new ReplicaGuardRefusal("replica_writer_invalid");
      names.add(name);
      databases.push(name);
    }
    return { ...identity, state: "active", databases };
  }
  const databases: ReplicaFile[] = [];
  for (const entry of value.databases as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      !databaseName(entry.path) ||
      !("sha256" in entry) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      names.has(entry.path)
    ) {
      throw new ReplicaGuardRefusal("replica_writer_invalid");
    }
    names.add(entry.path);
    databases.push({ path: entry.path, sha256: entry.sha256 });
  }
  return { ...identity, state: "sealed", databases };
}

function readRecord(path: string): ReplicaWriter | null {
  return readWriter(path).writer;
}

/** Only a heartbeat bound to the same claim proves that its writer beat while it served. */
function heartbeating(database: Database, owner: WriterIdentity): boolean {
  const row = database
    .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
    .get(HEARTBEAT_KEY);
  if (row === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return false;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "epoch" in value &&
    value.epoch === owner.epoch &&
    "id" in value &&
    value.id === owner.id &&
    "beat" in value &&
    typeof value.beat === "number" &&
    Number.isSafeInteger(value.beat) &&
    value.beat >= 0
  );
}

function readWriter(path: string): { writer: ReplicaWriter | null; heartbeat: boolean } {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const writer = record(database);
    return { writer, heartbeat: writer?.state === "active" && heartbeating(database, writer) };
  } finally {
    database.close();
  }
}

function fingerprint(path: string, deadline: number): string {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = new Bun.CryptoHasher("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      if (Date.now() >= deadline) throw new ReplicaGuardRefusal("replica_freshness_timeout");
      const size = readSync(file, buffer, 0, buffer.length, null);
      if (size === 0) return hash.digest("hex");
      hash.update(size === buffer.length ? buffer : buffer.subarray(0, size));
    }
  } finally {
    closeSync(file);
  }
}

function containedFile(root: string, name: string): string {
  let path = root;
  for (const part of name.split("/")) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink())
      throw new ReplicaGuardRefusal("replica_database_path_invalid");
  }
  if (!lstatSync(path).isFile()) throw new ReplicaGuardRefusal("replica_database_path_invalid");
  return path;
}

function requireFiles(root: string, files: readonly ReplicaFile[], deadline: number): void {
  for (const file of files) {
    if (fingerprint(containedFile(root, file.path), deadline) !== file.sha256) {
      throw new ReplicaGuardRefusal("replica_database_set_incomplete");
    }
  }
}

/** How a restored active writer is observed and its history replaced. Injected for tests. */
export interface TakeoverIO {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The replica's combined position for every admitted database; throws unless done by `deadline`. */
  readonly position: (deadline: number) => Promise<string>;
  /** Replaces the admitted files with a fresh restore and returns the main database's path. */
  readonly restore: () => Promise<string>;
}

/**
 * An operator's authorization to take over one legacy writer, which never heartbeats. Every
 * replicated start validates it first, so a malformed value refuses before any history is claimed
 * rather than lying latent until a later restore needs it.
 */
export function takeoverSetting(): string | undefined {
  const value = process.env.MANIFOLD_REPLICA_TAKEOVER?.trim();
  if (!value) return undefined;
  if (!UUID.test(value)) throw new ReplicaGuardRefusal("replica_takeover_invalid");
  return value;
}

/**
 * Waits until the stopped writer's replica has stayed unchanged for the quiet window, then
 * admits a final restore of the same claim. A writer that is still replicating never goes quiet.
 * Returns how long the admitted position stayed unchanged.
 */
async function quietTakeover(owner: ActiveWriter, io: TakeoverIO): Promise<number> {
  const deadline = io.now() + TAKEOVER_DEADLINE_MS;
  const poll = async (): Promise<string> => {
    try {
      return await io.position(io.now() + TAKEOVER_POLL_TIMEOUT_MS);
    } catch {
      throw new ReplicaGuardRefusal("replica_unavailable");
    }
  };
  let quiet = await poll();
  let since = io.now();
  for (;;) {
    const now = io.now();
    if (now >= deadline) throw new ReplicaGuardRefusal("replica_writer_active");
    await io.sleep(Math.min(TAKEOVER_POLL_MS, deadline - now));
    const polledAt = io.now();
    const position = await poll();
    if (position !== quiet) {
      quiet = position;
      since = io.now();
      continue;
    }
    if (polledAt - since < TAKEOVER_QUIET_MS) continue;
    const restored = readRecord(await io.restore());
    if (restored?.state !== "active" || restored.epoch !== owner.epoch || restored.id !== owner.id)
      throw new ReplicaGuardRefusal("replica_writer_changed");
    // The admitted files must be the quiet position, not a write that landed during the restore.
    const checkedAt = io.now();
    const confirmed = await poll();
    if (confirmed === quiet) return checkedAt - since;
    quiet = confirmed;
    since = io.now();
  }
}

/**
 * Bootstrap checks staging; recovery checks the complete restored set before serving. A sealed
 * handoff is admitted at once. An active writer that stopped without sealing is taken over, losing
 * only writes it never replicated; a legacy one without a heartbeat needs the operator's setting.
 */
export function admitRestoredHistory(path: string, io: TakeoverIO): Promise<void> {
  return admitHistory(path, io, "hub_replica_boot");
}

async function admitHistory(
  path: string,
  io: TakeoverIO,
  evt: "hub_replica_boot" | "hub_replica_observation",
  deadline = Date.now() + START_TIMEOUT_MS,
): Promise<void> {
  const setting = takeoverSetting();
  const { writer: previous, heartbeat } = readWriter(path);
  if (previous === null) throw new ReplicaGuardRefusal("replica_freshness_unestablished");
  if (previous.state === "sealed") {
    if (setting !== undefined)
      console.log(JSON.stringify({ evt, state: "replica_takeover_setting_unused" }));
    requireFiles(dirname(path), previous.databases, deadline);
    return;
  }
  const legacy = !heartbeat;
  if (legacy && setting !== previous.id) throw new ReplicaGuardRefusal("replica_writer_unsealed");
  if (!legacy && setting !== undefined)
    console.log(JSON.stringify({ evt, state: "replica_takeover_setting_unused" }));
  console.log(
    JSON.stringify({
      evt,
      state: "replica_takeover_waiting",
      epoch: previous.epoch,
      legacy,
    }),
  );
  const quietMs = await quietTakeover(previous, io);
  console.log(
    JSON.stringify({
      evt,
      state: "replica_takeover",
      epoch: previous.epoch,
      legacy,
      quietMs,
    }),
  );
}

/**
 * The ordinary configuration's main-database object path, exported for Litestream's expansion.
 * The default is the historical fixed path. A dedicated prefix lets a deployment without a
 * durable volume continue history that a recovery image established under this supervisor's
 * claim/seal contract. Relative segments and the full-state checkpoint namespace are refused.
 * Bun children inherit the startup environment unless given `env`, so every Litestream child
 * receives `{ ...process.env }` to see this default.
 */
export function ordinaryReplicaPath(): string {
  const value = process.env.MANIFOLD_REPLICA_PATH?.trim() || "manifold.db";
  const parts = value.split("/");
  if (
    value.length > 512 ||
    parts[0] === "manifold-full-state" ||
    !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))
  )
    throw new ReplicaGuardRefusal("replica_path_invalid");
  process.env.MANIFOLD_REPLICA_PATH = value;
  return value;
}

function configuration(
  source: string,
  root: string,
  db: string,
  requireLocalFiles = true,
): { databases: string[]; main: string } {
  const value: unknown = Bun.YAML.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("dbs" in value) ||
    !Array.isArray(value.dbs) ||
    "exec" in value
  ) {
    throw new ReplicaGuardRefusal("replica_configuration_invalid");
  }
  const databases: string[] = [];
  let main: object | undefined;
  for (const entry of value.dbs as unknown[]) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("path" in entry) ||
      typeof entry.path !== "string"
    ) {
      throw new ReplicaGuardRefusal("replica_configuration_invalid");
    }
    const expanded = entry.path.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_match, braced: string | undefined, bare: string | undefined) => {
        const variable = process.env[braced ?? bare ?? ""];
        if (variable === undefined) throw new ReplicaGuardRefusal("replica_configuration_invalid");
        return variable;
      },
    );
    const absolute = resolve(expanded);
    if (!isAbsolute(expanded)) throw new ReplicaGuardRefusal("replica_database_path_invalid");
    if (absolute === db) {
      if (main !== undefined) throw new ReplicaGuardRefusal("replica_configuration_invalid");
      main = { ...entry, path: absolute };
      continue;
    }
    const name = relative(root, absolute).split(sep).join("/");
    if (
      !databaseName(name) ||
      databases.includes(name) ||
      name === "manifold.writer" ||
      name === "manifold.replica-writer"
    ) {
      throw new ReplicaGuardRefusal("replica_database_path_invalid");
    }
    if (requireLocalFiles) containedFile(root, name);
    databases.push(name);
  }
  if (main === undefined) throw new ReplicaGuardRefusal("replica_configuration_invalid");
  databases.sort();
  // Feed the filtered config through stdin: credentials in a supplied config never get copied
  // to another persistent file. Only the main database is reopened after auxiliary seals.
  return { databases, main: JSON.stringify({ ...value, dbs: [main] }) };
}

function claim(path: string, databases: readonly string[]): ActiveWriter {
  const database = new Database(path, { strict: true });
  try {
    return database
      .transaction(() => {
        const previous = record(database);
        const prior =
          previous?.state === "sealed"
            ? previous.databases.map((file) => file.path)
            : (previous?.databases ?? []);
        if (prior.some((name) => !databases.includes(name)))
          throw new ReplicaGuardRefusal("replica_database_set_incomplete");
        const epoch = (previous?.epoch ?? 0) + 1;
        if (!Number.isSafeInteger(epoch)) throw new ReplicaGuardRefusal("replica_epoch_exhausted");
        const next: ActiveWriter = {
          version: 1,
          epoch,
          id: crypto.randomUUID(),
          state: "active",
          databases,
        };
        database
          .query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
          .run(KEY, JSON.stringify(next));
        // Every claim this guard writes is heartbeat-bearing, so a kill at any later point
        // leaves history that a replacement can take over without an operator's setting.
        database
          .query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
          .run(HEARTBEAT_KEY, JSON.stringify({ version: 1, epoch, id: next.id, beat: 0 }));
        return next;
      })
      .immediate();
  } finally {
    database.close();
  }
}

function seal(path: string, owner: ActiveWriter, databases: readonly ReplicaFile[]): SealedWriter {
  const database = new Database(path, { strict: true });
  try {
    return database
      .transaction(() => {
        const current = record(database);
        if (
          current?.id !== owner.id ||
          current.epoch !== owner.epoch ||
          current.state !== "active"
        ) {
          throw new ReplicaGuardRefusal("replica_writer_changed");
        }
        const sealed: SealedWriter = { ...owner, state: "sealed", databases };
        database.query("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(sealed), KEY);
        return sealed;
      })
      .immediate();
  } finally {
    database.close();
  }
}

export interface Heartbeat {
  stop(): void;
}

/**
 * Advances the claim's heartbeat through a dedicated connection while the stored record is
 * still this owner's active claim. Replication carries each beat, so a replacement sees a live
 * writer's replica advance. A lost claim stops beating and calls `onOwnershipLost` once.
 */
export function startHeartbeat(
  path: string,
  owner: { readonly epoch: number; readonly id: string },
  onOwnershipLost: () => void,
): Heartbeat {
  const database = new Database(path, { strict: true });
  database.run(`PRAGMA busy_timeout = ${HEARTBEAT_BUSY_TIMEOUT_MS}`);
  let timer: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    database.close();
  };
  const advance = database.transaction((beat: number): boolean => {
    let current: ReplicaWriter | null;
    try {
      current = record(database);
    } catch (error) {
      if (error instanceof ReplicaGuardRefusal) return false;
      throw error;
    }
    if (current?.state !== "active" || current.epoch !== owner.epoch || current.id !== owner.id)
      return false;
    database
      .query("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)")
      .run(HEARTBEAT_KEY, JSON.stringify({ version: 1, epoch: owner.epoch, id: owner.id, beat }));
    return true;
  });
  let beat = 0;
  timer = setInterval(() => {
    let owned: boolean;
    try {
      owned = advance.immediate(beat + 1);
    } catch {
      // SQLite errors can contain private paths or data; the next tick retries.
      console.log(JSON.stringify({ evt: "hub_replica_heartbeat", state: "failed" }));
      return;
    }
    if (!owned) {
      stop();
      onOwnershipLost();
      return;
    }
    beat += 1;
  }, HEARTBEAT_INTERVAL_MS);
  return { stop };
}

async function exitBefore(child: Bun.Subprocess, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    child.kill("SIGKILL");
    await child.exited;
    throw new ReplicaGuardRefusal("replica_freshness_timeout");
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), remaining);
  try {
    if ((await child.exited) !== 0) {
      throw new ReplicaGuardRefusal(
        Date.now() >= deadline ? "replica_freshness_timeout" : "replica_unavailable",
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** An observation owns every read-only subprocess until it has exited. */
interface ReadOnlyScope {
  check(): void;
  track(child: Bun.Subprocess): () => void;
}

/** An absent replica leaves no output, like the entrypoints' `-if-replica-exists` restores. */
async function restoreTo(
  db: string,
  config: string,
  output: string,
  deadline: number,
  scope?: ReadOnlyScope,
): Promise<boolean> {
  scope?.check();
  const child = Bun.spawn(
    [
      "litestream",
      "restore",
      "-if-replica-exists",
      "-integrity-check",
      "full",
      "-config",
      "/dev/stdin",
      "-o",
      output,
      db,
    ],
    { env: { ...process.env }, stdin: new Blob([config]), stdout: "ignore", stderr: "ignore" },
  );
  const untrack = scope?.track(child);
  try {
    await exitBefore(child, deadline);
    scope?.check();
    return exists(output);
  } finally {
    if (scope !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    untrack?.();
  }
}

/** Private restores never replace authoritative local files. Calls reuse owned staging serially. */
async function restore(
  db: string,
  config: string,
  staging: string,
  deadline: number,
): Promise<string | null> {
  const output = join(staging, "restored.db");
  if (Date.now() >= deadline) throw new ReplicaGuardRefusal("replica_freshness_timeout");
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    rmSync(`${output}${suffix}`, { force: true });
  return (await restoreTo(db, config, output, deadline)) ? output : null;
}

async function restoredRecord(
  db: string,
  config: string,
  staging: string,
  deadline: number,
): Promise<ReplicaWriter | null> {
  const path = await restore(db, config, staging, deadline);
  if (path === null) return null;
  const value = readRecord(path);
  if (value === null) throw new ReplicaGuardRefusal("replica_freshness_unestablished");
  return value;
}

/**
 * The replica's position: the maximum TXID over every compaction level of each database, as
 * listed by `litestream ltx -level all -json`. Compaction keeps it; only a new write advances it.
 */
export function replicaPosition(
  databases: readonly string[],
  config: string,
  deadline: number,
): Promise<string> {
  return listedReplicaPosition(databases, config, deadline);
}

async function listedReplicaPosition(
  databases: readonly string[],
  config: string,
  deadline: number,
  scope?: ReadOnlyScope,
): Promise<string> {
  const positions: string[] = [];
  for (const db of databases) {
    scope?.check();
    const child = Bun.spawn(
      ["litestream", "ltx", "-config", "/dev/stdin", "-level", "all", "-json", db],
      { env: { ...process.env }, stdin: new Blob([config]), stdout: "pipe", stderr: "ignore" },
    );
    const untrack = scope?.track(child);
    try {
      const [listing] = await Promise.all([
        new Response(child.stdout).text(),
        exitBefore(child, deadline),
      ]);
      scope?.check();
      const files: unknown = JSON.parse(listing);
      if (!Array.isArray(files)) throw new ReplicaGuardRefusal("replica_unavailable");
      let maximum = 0n;
      for (const file of files as unknown[]) {
        if (
          typeof file !== "object" ||
          file === null ||
          !("max_txid" in file) ||
          typeof file.max_txid !== "string" ||
          !/^[0-9a-f]{16}$/.test(file.max_txid)
        )
          throw new ReplicaGuardRefusal("replica_unavailable");
        const txid = BigInt(`0x${file.max_txid}`);
        if (txid > maximum) maximum = txid;
      }
      positions.push(maximum.toString(16));
    } finally {
      if (scope !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      untrack?.();
    }
  }
  return JSON.stringify(positions);
}

/** Replaces one in-place recovery file only when its replica exists, as the entrypoint does. */
async function restoreInPlace(db: string, config: string, deadline: number): Promise<void> {
  const output = join(dirname(db), `.${basename(db)}.takeover-${crypto.randomUUID()}`);
  try {
    if (!(await restoreTo(db, config, output, deadline))) return;
    // Read-only validation leaves an empty WAL and an index for the file being replaced; neither
    // may be paired with the new one.
    for (const suffix of ["-wal", "-shm"]) rmSync(`${db}${suffix}`, { force: true });
    renameSync(output, db);
  } finally {
    for (const suffix of ["", "-wal", "-shm", "-journal", ".tmp"])
      rmSync(`${output}${suffix}`, { force: true });
  }
}

/**
 * Recovery observes and restores every configured database. The entrypoint's settings are read
 * only when a takeover needs them, so sealed validation keeps its existing inputs.
 */
function recoveryTakeover(main: string): TakeoverIO {
  let settings: { readonly config: string; readonly databases: readonly string[] } | undefined;
  const load = (): { readonly config: string; readonly databases: readonly string[] } => {
    if (settings !== undefined) return settings;
    const configPath = process.env.MANIFOLD_RECOVERY_LITESTREAM_CONFIG;
    const listPath = process.env.MANIFOLD_RECOVERY_DATABASES_FILE;
    if (!configPath || !listPath) throw new ReplicaGuardRefusal("replica_configuration_invalid");
    const listed = readFileSync(listPath, "utf8")
      .split("\n")
      .filter((database) => database !== "" && database !== main);
    // The main database's record is re-read after restoring it, so it is restored last.
    settings = { config: readFileSync(configPath, "utf8"), databases: [...listed, main] };
    return settings;
  };
  return {
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    position: async (deadline) => {
      const { config, databases } = load();
      return replicaPosition(databases, config, deadline);
    },
    restore: async () => {
      const { config, databases } = load();
      for (const database of databases)
        await restoreInPlace(database, config, Date.now() + START_TIMEOUT_MS);
      return main;
    },
  };
}

async function observe(
  db: string,
  config: string,
  staging: string,
  expected: ReplicaWriter,
  deadline: number,
  interrupted?: () => boolean,
): Promise<void> {
  const databases = JSON.stringify(expected.databases);
  for (;;) {
    if (interrupted?.()) throw new ReplicaGuardRefusal("replica_start_interrupted");
    const actual = await restoredRecord(db, config, staging, deadline);
    if (
      actual?.id === expected.id &&
      actual.epoch === expected.epoch &&
      actual.state === expected.state &&
      JSON.stringify(actual.databases) === databases
    )
      return;
    if (
      actual !== null &&
      (actual.epoch > expected.epoch ||
        (actual.epoch === expected.epoch && actual.id !== expected.id))
    ) {
      throw new ReplicaGuardRefusal("replica_writer_conflict");
    }
    if (Date.now() >= deadline) throw new ReplicaGuardRefusal("replica_freshness_timeout");
    await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
}

async function sealFiles(
  root: string,
  names: readonly string[],
  config: string,
  staging: string,
  deadline: number,
): Promise<ReplicaFile[]> {
  const files: ReplicaFile[] = [];
  for (const name of names) {
    const path = containedFile(root, name);
    const database = new Database(path, { strict: true });
    try {
      const checkpoint = database
        .query<{ log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(FULL)")
        .get();
      if (checkpoint === null || checkpoint.checkpointed < checkpoint.log)
        throw new ReplicaGuardRefusal("replica_database_uncheckpointed");
    } finally {
      database.close();
    }
    const sha256 = fingerprint(path, deadline);
    const restored = await restore(path, config, staging, deadline);
    if (restored === null || fingerprint(restored, deadline) !== sha256)
      throw new ReplicaGuardRefusal("replica_database_set_incomplete");
    files.push({ path: name, sha256 });
  }
  return files;
}

async function stop(child: Bun.Subprocess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode === 0;
  child.kill("SIGTERM");
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    return (await child.exited) === 0 && !forced;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An exact-image admission rehearsal, not bootstrap: only restore/ltx children are reachable.
 * All restored bytes (including auxiliary databases) belong to this run and are discarded.
 * A successful observation says nothing about a future handoff from a still-serving writer.
 */
async function observeReplica(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const staging = mkdtempSync(join(tmpdir(), "manifold-replica-observation-"));
  const children = new Set<Bun.Subprocess>();
  const { promise: interrupted, resolve: wakeInterrupted } = Promise.withResolvers<void>();
  let requestedStop = false;
  let targetSha256: string | undefined;
  let reason: string | undefined;
  const onSignal = (): void => {
    requestedStop = true;
    for (const child of children) child.kill("SIGKILL");
    wakeInterrupted();
  };
  const scope: ReadOnlyScope = {
    check() {
      if (requestedStop) throw new ReplicaGuardRefusal("replica_observation_interrupted");
      if (Date.now() >= deadline) throw new ReplicaGuardRefusal("replica_freshness_timeout");
    },
    track(child) {
      children.add(child);
      return () => children.delete(child);
    },
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    takeoverSetting();
    const root = resolve(process.env.MANIFOLD_DATA_DIR || "/data");
    process.env.MANIFOLD_DATA_DIR = root;
    ordinaryReplicaPath();
    const db = join(root, "manifold.db");
    const configPath =
      process.env.MANIFOLD_RECOVERY_LITESTREAM_CONFIG ||
      resolve(import.meta.dir, "../infra/litestream.yml");
    // Open first, then classify/read that descriptor: a pathname check can race a FIFO/symlink.
    let configFile: number;
    try {
      configFile = openSync(
        configPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOOP")
        throw new ReplicaGuardRefusal("replica_configuration_invalid");
      throw error;
    }
    let config: string;
    try {
      if (!fstatSync(configFile).isFile())
        throw new ReplicaGuardRefusal("replica_configuration_invalid");
      config = readFileSync(configFile, "utf8");
    } finally {
      closeSync(configFile);
    }
    const configured = configuration(config, root, db, false);
    const databases = [...configured.databases.map((name) => join(root, name)), db];
    // Bind the exact config and its environment expansion without disclosing any input value.
    // This is a target fingerprint, not a credential or an authentication receipt.
    const hash = new Bun.CryptoHasher("sha256").update(config);
    for (const match of config.matchAll(
      /\$(?:\{([^}]+)\}|([0-9*#$@!?-])|([A-Za-z_][A-Za-z0-9_]*))/g,
    )) {
      const name = match[1] ?? match[2] ?? match[3]!;
      hash.update(JSON.stringify([name, process.env[name] ?? ""]));
    }
    targetSha256 = hash.digest("hex");
    const main = join(staging, "manifold.db");
    const restoreMain = async (): Promise<string> => {
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        rmSync(`${main}${suffix}`, { force: true });
      if (!(await restoreTo(db, config, main, deadline, scope)))
        throw new ReplicaGuardRefusal("replica_writer_changed");
      return main;
    };
    if (!(await restoreTo(db, config, main, deadline, scope)))
      throw new ReplicaGuardRefusal("replica_freshness_unestablished");
    const requireConfiguredSet = (): void => {
      const writer = readRecord(main);
      const names =
        writer?.state === "sealed"
          ? writer.databases.map((file) => file.path)
          : (writer?.databases ?? []);
      if (names.some((name) => !configured.databases.includes(name)))
        throw new ReplicaGuardRefusal("replica_database_set_incomplete");
    };
    const restoreAuxiliary = async (): Promise<void> => {
      requireConfiguredSet();
      for (const name of configured.databases) {
        const output = join(staging, name);
        mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
        for (const suffix of ["", "-wal", "-shm", "-journal"])
          rmSync(`${output}${suffix}`, { force: true });
        if (!(await restoreTo(join(root, name), config, output, deadline, scope)))
          throw new ReplicaGuardRefusal("replica_database_set_incomplete");
      }
    };
    // A seal checks every auxiliary fingerprint. A legacy unsealed claim must retain its
    // immediate authoritative refusal before any quiet-window or auxiliary work is attempted.
    if (readRecord(main)?.state === "sealed") await restoreAuxiliary();
    await admitHistory(
      main,
      {
        now: () => Date.now(),
        sleep: async (ms) => {
          scope.check();
          const { promise: elapsed, resolve: wakeSleep } = Promise.withResolvers<void>();
          const timer = setTimeout(wakeSleep, Math.min(ms, deadline - Date.now()));
          try {
            await Promise.race([elapsed, interrupted]);
            scope.check();
          } finally {
            clearTimeout(timer);
          }
        },
        position: (pollDeadline) =>
          listedReplicaPosition(databases, config, Math.min(deadline, pollDeadline), scope),
        restore: async () => {
          await restoreAuxiliary();
          await restoreMain();
          requireConfiguredSet();
          return main;
        },
      },
      "hub_replica_observation",
      deadline,
    );
    scope.check();
  } catch (error) {
    reason = requestedStop
      ? "replica_observation_interrupted"
      : Date.now() >= deadline
        ? "replica_freshness_timeout"
        : error instanceof ReplicaGuardRefusal
          ? error.reason
          : "replica_unavailable";
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all([...children].map((child) => child.exited));
    rmSync(staging, { recursive: true, force: true });
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  const result = {
    evt: "hub_replica_observation",
    state: reason === undefined ? "admitted" : "refused",
    ...(targetSha256 === undefined ? {} : { targetSha256 }),
    ...(reason === undefined ? {} : { reason }),
  };
  if (reason === undefined) console.log(JSON.stringify(result));
  else {
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "observe") {
    if (process.argv.length !== 3) throw new ReplicaGuardRefusal("usage_replica_observation");
    await observeReplica();
    return;
  }
  if (process.argv.length === 4 && process.argv[2] === "validate-restored") {
    const path = process.argv[3]!;
    await admitRestoredHistory(path, recoveryTakeover(path));
    return;
  }
  const authenticatedBaseline =
    process.argv.length === 4 &&
    process.argv[2] === "--config-stdin" &&
    process.argv[3] === "--authenticated-baseline";
  const fromStdin =
    authenticatedBaseline || (process.argv.length === 3 && process.argv[2] === "--config-stdin");
  if (process.argv.length !== 2 && !fromStdin) throw new ReplicaGuardRefusal("usage_replica_guard");
  takeoverSetting();
  const dataDir = resolve(process.env.MANIFOLD_DATA_DIR || "/data");
  const db = join(dataDir, "manifold.db");
  if (!fromStdin) ordinaryReplicaPath();
  const config = fromStdin
    ? await Bun.stdin.text()
    : readFileSync(
        process.env.MANIFOLD_RECOVERY_LITESTREAM_CONFIG ||
          resolve(import.meta.dir, "../infra/litestream.yml"),
        "utf8",
      );
  const configured = configuration(config, dataDir, db);
  const deadline = Date.now() + START_TIMEOUT_MS;
  const staging = mkdtempSync(join(tmpdir(), "manifold-replica-guard-"));
  // The application owns manifold.writer. This lock covers the supervisor's entire seal.
  let lock: Database | undefined;
  let replicator: Bun.Subprocess | undefined;
  let application: Bun.Subprocess | undefined;
  let heartbeat: Heartbeat | undefined;
  let requestedStop = false;
  let replicaExited = false;
  let ownershipLost = false;
  const { promise: stopped, resolve: wakeStop } = Promise.withResolvers<void>();
  const onSignal = (): void => {
    requestedStop = true;
    wakeStop();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    lock = new Database(join(dataDir, "manifold.replica-writer"), { strict: true });
    lock.run("PRAGMA locking_mode = EXCLUSIVE");
    lock.run("CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
    lock.run("BEGIN EXCLUSIVE");
    lock.run("COMMIT");
    const previous = readRecord(db);
    // The recovery entrypoint has verified every baseline byte before this internal handoff.
    // VACUUM checkpoint copies need not retain a prior replica seal's physical file hashes.
    if (!authenticatedBaseline && previous?.state === "sealed")
      requireFiles(dataDir, previous.databases, deadline);
    // Retained local storage is authoritative, but cannot replace newer or conflicting remote
    // history. Untracked remote history is uncertain and requires reviewed migration, not adoption.
    const remote = await restoredRecord(db, config, staging, deadline);
    if (authenticatedBaseline && remote !== null)
      throw new ReplicaGuardRefusal("authenticated_baseline_replica_not_empty");
    if (
      remote !== null &&
      (previous === null ||
        remote.epoch > previous.epoch ||
        (remote.epoch === previous.epoch &&
          (remote.id !== previous.id ||
            (previous.state === "active" && remote.state === "sealed"))))
    ) {
      throw new ReplicaGuardRefusal("local_history_behind_replica");
    }
    if (authenticatedBaseline) {
      // A compacted checkpoint may inherit tracking state for another replica namespace.
      // Reset only local Litestream files, after proving the new replica is empty.
      for (const name of ["manifold.db", ...configured.databases]) {
        await exitBefore(
          Bun.spawn(["litestream", "reset", "-config", "/dev/stdin", join(dataDir, name)], {
            env: { ...process.env },
            stdin: new Blob([config]),
            stdout: "inherit",
            stderr: "inherit",
          }),
          deadline,
        );
      }
    }
    if (requestedStop) throw new ReplicaGuardRefusal("replica_start_interrupted");
    const owner = claim(db, configured.databases);
    event("replica_claim_waiting");
    replicator = Bun.spawn(["litestream", "replicate", "-config", "/dev/stdin"], {
      env: { ...process.env },
      stdin: new Blob([config]),
      stdout: "inherit",
      stderr: "inherit",
    });
    void replicator.exited.then(() => {
      replicaExited = true;
      wakeStop();
    });
    await observe(db, config, staging, owner, deadline, () => requestedStop || replicaExited);
    if (requestedStop || replicaExited) throw new ReplicaGuardRefusal("replica_start_interrupted");
    event("replica_claim_durable");
    heartbeat = startHeartbeat(db, owner, () => {
      ownershipLost = true;
      wakeStop();
    });
    application = Bun.spawn(["bun", "packages/server/src/main.ts"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await Promise.race([application.exited, stopped]);
    heartbeat.stop();
    const applicationStopped = await stop(application, STOP_TIMEOUT_MS);
    if (ownershipLost) throw new ReplicaGuardRefusal("replica_writer_changed");
    if (!applicationStopped || replicaExited)
      throw new ReplicaGuardRefusal("replica_writer_unsealed");
    const sealDeadline = Date.now() + SYNC_TIMEOUT_MS;
    // Without auxiliary databases nothing needs fingerprints, so the seal is written while
    // replication runs and the replicator's final sync carries it within a short stop grace.
    // A kill before it lands leaves the heartbeat-bearing claim for a takeover.
    let sealed = configured.databases.length === 0 ? seal(db, owner, []) : undefined;
    if (!(await stop(replicator, STOP_TIMEOUT_MS)))
      throw new ReplicaGuardRefusal("replicator_stop_failed");
    // Stop all replication before fingerprinting: Litestream owns internal tables in each DB.
    // Reopening auxiliary databases for replication after this point would invalidate the seal.
    sealed ??= seal(
      db,
      owner,
      await sealFiles(dataDir, configured.databases, config, staging, sealDeadline),
    );
    replicator = Bun.spawn(["litestream", "replicate", "-once", "-config", "/dev/stdin"], {
      env: { ...process.env },
      stdin: new Blob([configured.main]),
      stdout: "inherit",
      stderr: "inherit",
    });
    await exitBefore(replicator, sealDeadline);
    await observe(db, config, staging, sealed, sealDeadline);
    event("replica_seal_durable");
  } finally {
    heartbeat?.stop();
    if (application !== undefined) await stop(application, STOP_TIMEOUT_MS);
    if (replicator !== undefined) await stop(replicator, STOP_TIMEOUT_MS);
    lock?.close();
    rmSync(staging, { recursive: true, force: true });
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: process.argv[2] === "observe" ? "hub_replica_observation" : "hub_replica_boot",
        state: "refused",
        reason: error instanceof ReplicaGuardRefusal ? error.reason : "replica_unavailable",
      }),
    );
    process.exitCode = 1;
  }
}
