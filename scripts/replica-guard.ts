#!/usr/bin/env bun
/**
 * A replicated application cannot serve until its claim is visible in a read-only restore.
 * Shutdown stops the application and replication, verifies every auxiliary database, then
 * publishes the main database's seal. This also supervises an older recovery executable.
 *
 * Assumes one writer and trusted, read-after-write-consistent replica storage. This is not a
 * distributed lease or authentication of hostile object storage. Recovery's non-SQLite files
 * remain pinned to its authenticated checkpoint under the existing recovery contract.
 */
import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const KEY = "replica-writer";
const START_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 10_000;
const SYNC_TIMEOUT_MS = 300_000;

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
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) ||
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
  const database = new Database(path, { readonly: true, strict: true });
  try {
    return record(database);
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

/** Bootstrap checks staging; recovery checks the complete restored set before serving. */
export function requireSealedReplica(path: string): void {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const previous = readRecord(path);
  if (previous === null) throw new ReplicaGuardRefusal("replica_freshness_unestablished");
  if (previous.state !== "sealed") throw new ReplicaGuardRefusal("replica_writer_unsealed");
  requireFiles(dirname(path), previous.databases, deadline);
}

function configuration(
  source: string,
  root: string,
  db: string,
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
    containedFile(root, name);
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
    { stdin: new Blob([config]), stdout: "ignore", stderr: "ignore" },
  );
  await exitBefore(child, deadline);
  return exists(output) ? output : null;
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

async function main(): Promise<void> {
  if (process.argv.length === 4 && process.argv[2] === "validate-restored") {
    requireSealedReplica(process.argv[3]!);
    return;
  }
  const authenticatedBaseline =
    process.argv.length === 4 &&
    process.argv[2] === "--config-stdin" &&
    process.argv[3] === "--authenticated-baseline";
  const fromStdin =
    authenticatedBaseline ||
    (process.argv.length === 3 && process.argv[2] === "--config-stdin");
  if (process.argv.length !== 2 && !fromStdin) throw new ReplicaGuardRefusal("usage_replica_guard");
  const dataDir = resolve(process.env.MANIFOLD_DATA_DIR || "/data");
  const db = join(dataDir, "manifold.db");
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
  let requestedStop = false;
  let replicaExited = false;
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
    application = Bun.spawn(["bun", "packages/server/src/main.ts"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await Promise.race([application.exited, stopped]);
    if (!(await stop(application, STOP_TIMEOUT_MS)) || replicaExited)
      throw new ReplicaGuardRefusal("replica_writer_unsealed");
    const sealDeadline = Date.now() + SYNC_TIMEOUT_MS;
    if (!(await stop(replicator, STOP_TIMEOUT_MS)))
      throw new ReplicaGuardRefusal("replicator_stop_failed");
    // Stop all replication before fingerprinting: Litestream owns internal tables in each DB.
    // Reopening auxiliary databases for replication after this point would invalidate the seal.
    const files = await sealFiles(dataDir, configured.databases, config, staging, sealDeadline);
    const sealed = seal(db, owner, files);
    replicator = Bun.spawn(["litestream", "replicate", "-once", "-config", "/dev/stdin"], {
      stdin: new Blob([configured.main]),
      stdout: "inherit",
      stderr: "inherit",
    });
    await exitBefore(replicator, sealDeadline);
    await observe(db, config, staging, sealed, sealDeadline);
    event("replica_seal_durable");
  } finally {
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
        evt: "hub_replica_boot",
        state: "refused",
        reason: error instanceof ReplicaGuardRefusal ? error.reason : "replica_unavailable",
      }),
    );
    process.exitCode = 1;
  }
}
