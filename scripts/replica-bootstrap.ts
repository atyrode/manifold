#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { openDatabase, SCHEMA_VERSION } from "../packages/server/src/index.ts";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const ACK_NAME = ".replica-init-once.json";
const ACK_LIFETIME_MS = 15 * 60 * 1000;
const LITESTREAM_CONFIG = resolve(import.meta.dir, "../infra/litestream.yml");
const RECOVERY_SETTINGS = [
  "MANIFOLD_RECOVERY_CHECKPOINT",
  "MANIFOLD_RECOVERY_SHA256",
  "MANIFOLD_RECOVERY_EXPECTED_BUILD",
  "MANIFOLD_RECOVERY_BASE_IMAGE",
] as const;

class BootstrapRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BootstrapRefusal";
  }
}

function state(value: string): void {
  console.log(JSON.stringify({ evt: "hub_replica_boot", state: value }));
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function requireNoJournals(db: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"])
    if (exists(`${db}${suffix}`)) throw new BootstrapRefusal("local_history_unusable");
}

function requireHistory(path: string, reason: string): void {
  let database: Database | undefined;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size === 0) throw new BootstrapRefusal(reason);
    database = new Database(path, { readonly: true, strict: true });
    const integrity = database
      .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new BootstrapRefusal(reason);
    const row = database
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
      .get();
    const version = Number(row?.value);
    if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION)
      throw new BootstrapRefusal(reason);
  } catch {
    // SQLite and I/O errors can contain private paths or data. The refusal remains visible.
    throw new BootstrapRefusal(reason);
  } finally {
    database?.close();
  }
}

function acknowledge(dataDir: string, db: string, target: string): void {
  if (exists(db)) throw new BootstrapRefusal("local_history_exists");
  requireNoJournals(db);
  if (exists(join(dataDir, ACK_NAME)))
    throw new BootstrapRefusal("initialization_acknowledgement_exists");
  const fd = openSync(
    join(dataDir, ACK_NAME),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(
      fd,
      JSON.stringify({ version: 1, target, expiresAt: Date.now() + ACK_LIFETIME_MS }),
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dataDir);
  state("initialization_acknowledged");
}

function discardAcknowledgement(dataDir: string): void {
  const path = join(dataDir, ACK_NAME);
  if (!exists(path)) {
    state("initialization_acknowledgement_absent");
    return;
  }
  unlinkSync(path);
  syncDirectory(dataDir);
  state("initialization_acknowledgement_discarded");
}

function consumeAcknowledgement(dataDir: string, target: string): boolean {
  const path = join(dataDir, ACK_NAME);
  if (!exists(path)) return false;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 4096 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600
    ) {
      throw new BootstrapRefusal("initialization_acknowledgement_invalid");
    }
    const record: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const now = Date.now();
    if (
      typeof record !== "object" ||
      record === null ||
      !("version" in record) ||
      record.version !== 1 ||
      !("target" in record) ||
      record.target !== target ||
      !("expiresAt" in record) ||
      typeof record.expiresAt !== "number" ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= now ||
      record.expiresAt > now + ACK_LIFETIME_MS
    ) {
      throw new BootstrapRefusal("initialization_acknowledgement_invalid");
    }
  } catch {
    throw new BootstrapRefusal("initialization_acknowledgement_invalid");
  } finally {
    closeSync(fd);
  }
  // Durably consume intent before any recovery attempt, even one that will fail.
  unlinkSync(path);
  syncDirectory(dataDir);
  state("initialization_acknowledgement_consumed");
  return true;
}

function initialize(db: string): void {
  // Build only in private staging; incomplete initialization must never become local history.
  const fd = openSync(db, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  closeSync(fd);
  const database = openDatabase(db);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

function prepare(dataDir: string, db: string, target: string): void {
  const mayInitialize = consumeAcknowledgement(dataDir, target);
  if (exists(db)) {
    requireHistory(db, "local_history_unusable");
    state("local_history");
    return;
  }
  requireNoJournals(db);

  const staging = mkdtempSync(join(dataDir, ".replica-restore-"));
  try {
    const restored = join(staging, "manifold.db");
    state("restoring");
    const result = Bun.spawnSync(
      [
        "timeout",
        "300",
        "litestream",
        "restore",
        "-if-replica-exists",
        "-integrity-check",
        "full",
        "-config",
        LITESTREAM_CONFIG,
        "-o",
        restored,
        db,
      ],
      { stdout: "ignore", stderr: "ignore", env: { ...process.env, MANIFOLD_DATA_DIR: dataDir } },
    );
    if (result.exitCode !== 0)
      throw new BootstrapRefusal(
        result.exitCode === 124 ? "replica_timeout" : "replica_unavailable",
      );
    const hasHistory = exists(restored);
    if (hasHistory) {
      requireHistory(restored, "restored_history_unusable");
    } else {
      state("empty_replica");
      if (!mayInitialize) throw new BootstrapRefusal("initialization_required");
      initialize(restored);
    }
    // Staging is on the same filesystem. A hard link publishes without replacing any history.
    requireNoJournals(db);
    linkSync(restored, db);
    syncDirectory(dataDir);
    state(hasHistory ? "restored" : "initialized");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (
    rest.length !== 0 ||
    (command !== "acknowledge" && command !== "discard" && command !== "prepare")
  )
    throw new BootstrapRefusal("usage_acknowledge_discard_or_prepare");
  if (RECOVERY_SETTINGS.some((name) => process.env[name]))
    throw new BootstrapRefusal("full_state_recovery_requires_recovery_image");
  const dataDir = resolve(process.env.MANIFOLD_DATA_DIR || "/data");
  if (command === "discard") {
    discardAcknowledgement(dataDir);
    return;
  }
  const bucket = process.env.MANIFOLD_REPLICA_BUCKET;
  const endpoint = process.env.MANIFOLD_REPLICA_ENDPOINT;
  if (!bucket || !endpoint) throw new BootstrapRefusal("replica_configuration_missing");
  const accessKey = process.env.LITESTREAM_ACCESS_KEY_ID;
  const secretKey = process.env.LITESTREAM_SECRET_ACCESS_KEY;
  if (!accessKey || !secretKey) throw new BootstrapRefusal("replica_credentials_missing");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  process.env.MANIFOLD_DATA_DIR = dataDir;
  const db = join(dataDir, "manifold.db");
  // Bind the exact configuration and its inputs, including custom prefixes and storage identity,
  // without persisting their values. Any configuration change requires a fresh decision.
  const configuration = readFileSync(LITESTREAM_CONFIG, "utf8");
  const fingerprint = createHash("sha256").update(
    JSON.stringify([endpoint, bucket, accessKey, secretKey, configuration]),
  );
  // Record Go os.ExpandEnv inputs, not a second YAML parser or configuration interpreter.
  for (const match of configuration.matchAll(
    /\$(?:\{([^}]+)\}|([0-9*#$@!?-])|([A-Za-z_][A-Za-z0-9_]*))/g,
  )) {
    const variable = match[1] ?? match[2] ?? match[3];
    if (variable) fingerprint.update(JSON.stringify([variable, process.env[variable] ?? ""]));
  }
  const target = fingerprint.digest("hex");
  if (command === "acknowledge") acknowledge(dataDir, db, target);
  else prepare(dataDir, db, target);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(
      JSON.stringify({
        evt: "hub_replica_boot",
        state: "refused",
        reason: error instanceof BootstrapRefusal ? error.reason : "storage_or_process_error",
      }),
    );
    process.exit(1);
  }
}
