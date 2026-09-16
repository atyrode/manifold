#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { S3Client } from "bun";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const ARCHIVE_MAGIC = Buffer.from("MFRDATA1");
const ENVELOPE_MAGIC = Buffer.from("MFRSEAL1");
const HEADER_BYTES = 4;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 10_000;
const CHECKPOINT_ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_BUILD = /^\d+\.\d+\.\d+$/;
const TRANSIENT_PATHS = new Set([
  "agent.lock",
  "agent.pid",
  "terminal-host.pid",
  "terminal-host/host.sock",
]);

interface ArchiveFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface ArchiveHeader {
  readonly format: 1;
  readonly checkpointId: string;
  readonly sourceBuild: string;
  readonly capturedAt: string;
  readonly files: readonly ArchiveFile[];
}

export interface RecoveryReceipt {
  readonly format: 1;
  readonly checkpointId: string;
  readonly sourceBuild: string;
  readonly object: string;
  readonly objectSha256: string;
  readonly objectBytes: number;
  readonly capturedAt: string;
}

interface CapturedFile extends ArchiveFile {
  readonly data: Buffer;
}

interface RestoredCheckpoint {
  readonly header: ArchiveHeader;
  readonly databases: readonly string[];
}

function fail(message: string): never {
  throw new Error(`full-state recovery: ${message}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`);
  return value;
}

function validateCheckpointId(value: string): string {
  if (!CHECKPOINT_ID.test(value)) fail("checkpoint id is invalid");
  return value;
}

function validateBuild(value: string): string {
  if (!EXACT_BUILD.test(value)) fail("source build must be an exact release");
  return value;
}

function validateSha(value: string): string {
  if (!SHA256.test(value)) fail("checkpoint sha256 is invalid");
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasUnsafePathCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x5c || code === 0x7f) return true;
  }
  return false;
}

function safePath(value: string): string {
  if (value.length === 0 || value.length > 1024 || value.startsWith("/"))
    fail("archive path is invalid");
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component === "." ||
        component === ".." ||
        Buffer.byteLength(component) > 255 ||
        hasUnsafePathCharacter(component),
    )
  )
    fail("archive path is invalid");
  return value;
}

function dataDirectory(): string {
  return resolve(process.env.MANIFOLD_DATA_DIR?.trim() || "/data");
}

function recoveryKey(checkpointId: string, salt: Uint8Array): Buffer {
  const configured = required("MANIFOLD_OWNER_KEY");
  if (!/^[a-fA-F0-9]{64}$/.test(configured))
    fail("MANIFOLD_OWNER_KEY must be exactly 64 hex characters for recovery");
  const material = Buffer.from(configured, "hex");
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        material,
        salt,
        Buffer.from(`manifold/full-state-recovery/${checkpointId}`),
        32,
      ),
    );
  } finally {
    material.fill(0);
  }
}

function assertDatabase(path: string): void {
  const database = new Database(path, { readonly: true });
  try {
    const rows = database.query("PRAGMA integrity_check").all() as Record<string, unknown>[];
    if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok")
      fail(`SQLite integrity check failed for ${basename(path)}`);
  } finally {
    database.close();
  }
}

function readBoundedFile(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      fail("state file exceeds the remaining checkpoint bound or is not a regular file");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      fail("state file changed during capture");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function copyDatabase(source: string, destination: string, limit: number): Buffer {
  const database = new Database(source, { readonly: true });
  try {
    const { page_count: pages } = database.query("PRAGMA page_count").get() as {
      page_count: number;
    };
    const { page_size: pageSize } = database.query("PRAGMA page_size").get() as {
      page_size: number;
    };
    if (pages * pageSize > limit) fail("SQLite state exceeds the remaining checkpoint bound");
    const escaped = destination.replaceAll("'", "''");
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }
  assertDatabase(destination);
  return readBoundedFile(destination, limit);
}

function capturedFiles(root: string): CapturedFile[] {
  const staging = mkdtempSync(join(tmpdir(), "manifold-full-state-"));
  const files: CapturedFile[] = [];
  let total = 0;
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const relativePath = safePath(relative(root, absolute).split(sep).join("/"));
      if (TRANSIENT_PATHS.has(relativePath)) continue;
      const before = lstatSync(absolute);
      if (before.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (before.isSocket() && relativePath === "terminal-host/host.sock") continue;
      if (!before.isFile() || before.nlink !== 1) fail(`unsupported state entry ${relativePath}`);
      if (/\.(?:db-wal|db-shm|db-journal)$/.test(relativePath)) continue;
      if (files.length >= MAX_CHECKPOINT_FILES) fail("checkpoint exceeds the 10,000-file bound");
      const temporary = join(staging, `${String(files.length)}.db`);
      const data = relativePath.endsWith(".db")
        ? copyDatabase(absolute, temporary, MAX_CHECKPOINT_BYTES - total)
        : readBoundedFile(absolute, MAX_CHECKPOINT_BYTES - total);
      if (!relativePath.endsWith(".db")) {
        const after = statSync(absolute);
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs
        )
          fail(`state entry changed during capture: ${relativePath}`);
      }
      total += data.byteLength;
      if (total > MAX_CHECKPOINT_BYTES) fail("checkpoint exceeds the 256 MiB bound");
      files.push({
        path: relativePath,
        bytes: data.byteLength,
        sha256: sha256(data),
        data,
      });
    }
  };
  try {
    visit(root);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((file) => file.path === "manifold.db")) fail("checkpoint has no manifold.db");
  return files;
}

function archive(
  checkpointId: string,
  sourceBuild: string,
  files: readonly CapturedFile[],
): Buffer {
  const header: ArchiveHeader = {
    format: 1,
    checkpointId,
    sourceBuild,
    capturedAt: new Date().toISOString(),
    files: files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })),
  };
  const encoded = Buffer.from(JSON.stringify(header));
  const envelopeBytes = ENVELOPE_MAGIC.byteLength + SALT_BYTES + IV_BYTES + TAG_BYTES;
  const size =
    ARCHIVE_MAGIC.byteLength +
    HEADER_BYTES +
    encoded.byteLength +
    files.reduce((sum, file) => sum + file.bytes, 0) +
    envelopeBytes;
  if (size > MAX_CHECKPOINT_BYTES) fail("checkpoint including metadata exceeds the 256 MiB bound");
  const length = Buffer.allocUnsafe(HEADER_BYTES);
  length.writeUInt32BE(encoded.byteLength);
  return Buffer.concat([ARCHIVE_MAGIC, length, encoded, ...files.map((file) => file.data)]);
}

export function sealCheckpoint(
  checkpointId: string,
  sourceBuild: string,
  plaintext: Buffer,
): Buffer {
  validateCheckpointId(checkpointId);
  validateBuild(sourceBuild);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = recoveryKey(checkpointId, salt);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(checkpointId));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([ENVELOPE_MAGIC, salt, iv, ciphertext, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

function unsealCheckpoint(checkpointId: string, sealed: Buffer): Buffer {
  const minimum = ENVELOPE_MAGIC.byteLength + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (
    sealed.byteLength < minimum ||
    !sealed.subarray(0, ENVELOPE_MAGIC.byteLength).equals(ENVELOPE_MAGIC)
  )
    fail("checkpoint envelope is invalid");
  const saltStart = ENVELOPE_MAGIC.byteLength;
  const ivStart = saltStart + SALT_BYTES;
  const ciphertextStart = ivStart + IV_BYTES;
  const tagStart = sealed.byteLength - TAG_BYTES;
  const key = recoveryKey(checkpointId, sealed.subarray(saltStart, ivStart));
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      sealed.subarray(ivStart, ciphertextStart),
    );
    decipher.setAAD(Buffer.from(checkpointId));
    decipher.setAuthTag(sealed.subarray(tagStart));
    try {
      return Buffer.concat([
        decipher.update(sealed.subarray(ciphertextStart, tagStart)),
        decipher.final(),
      ]);
    } catch {
      return fail("checkpoint authentication failed");
    }
  } finally {
    key.fill(0);
  }
}

function parseHeader(value: unknown): ArchiveHeader {
  if (value === null || typeof value !== "object") fail("checkpoint header is invalid");
  const row = value as Record<string, unknown>;
  if (
    row.format !== 1 ||
    typeof row.checkpointId !== "string" ||
    typeof row.sourceBuild !== "string" ||
    typeof row.capturedAt !== "string" ||
    !Array.isArray(row.files)
  )
    fail("checkpoint header is invalid");
  const files = row.files.map((candidate): ArchiveFile => {
    if (candidate === null || typeof candidate !== "object") fail("checkpoint file is invalid");
    const file = candidate as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string"
    )
      fail("checkpoint file is invalid");
    return {
      path: safePath(file.path),
      bytes: file.bytes,
      sha256: validateSha(file.sha256),
    };
  });
  validateCheckpointId(row.checkpointId);
  validateBuild(row.sourceBuild);
  return {
    format: 1,
    checkpointId: row.checkpointId,
    sourceBuild: row.sourceBuild,
    capturedAt: row.capturedAt,
    files,
  };
}

function emptyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (readdirSync(path).length !== 0) fail("recovery data directory is not empty");
}

function extractArchive(
  root: string,
  checkpointId: string,
  expectedBuild: string,
  plaintext: Buffer,
): RestoredCheckpoint {
  const prefix = ARCHIVE_MAGIC.byteLength + HEADER_BYTES;
  if (
    plaintext.byteLength < prefix ||
    !plaintext.subarray(0, ARCHIVE_MAGIC.byteLength).equals(ARCHIVE_MAGIC)
  )
    fail("checkpoint archive is invalid");
  const headerBytes = plaintext.readUInt32BE(ARCHIVE_MAGIC.byteLength);
  if (headerBytes === 0 || prefix + headerBytes > plaintext.byteLength)
    fail("checkpoint header length is invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.subarray(prefix, prefix + headerBytes).toString("utf8"));
  } catch {
    return fail("checkpoint header JSON is invalid");
  }
  const header = parseHeader(parsed);
  if (header.checkpointId !== checkpointId) fail("checkpoint identity does not match");
  if (header.sourceBuild !== expectedBuild) fail("checkpoint source build does not match rollback");
  const seen = new Set<string>();
  for (const file of header.files) {
    if (seen.has(file.path)) fail("checkpoint contains duplicate paths");
    const components = file.path.split("/");
    for (let index = 1; index < components.length; index += 1)
      if (seen.has(components.slice(0, index).join("/")))
        fail("checkpoint contains a file/directory collision");
    seen.add(file.path);
  }
  emptyDirectory(root);
  let offset = prefix + headerBytes;
  const databases: string[] = [];
  for (const file of header.files) {
    const end = offset + file.bytes;
    if (end > plaintext.byteLength) fail("checkpoint file extends past the archive");
    const contents = plaintext.subarray(offset, end);
    if (sha256(contents) !== file.sha256) fail(`checkpoint file digest mismatch: ${file.path}`);
    const destination = resolve(root, ...file.path.split("/"));
    if (!destination.startsWith(`${root}${sep}`))
      fail("checkpoint path escaped the data directory");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, contents, { flag: "wx", mode: 0o600 });
    if (file.path.endsWith(".db")) {
      assertDatabase(destination);
      databases.push(destination);
    }
    offset = end;
  }
  if (offset !== plaintext.byteLength) fail("checkpoint has trailing bytes");
  if (!seen.has("manifold.db")) fail("checkpoint has no manifold.db");
  return { header, databases };
}

function objectClient(): S3Client {
  return new S3Client({
    accessKeyId: required("LITESTREAM_ACCESS_KEY_ID"),
    secretAccessKey: required("LITESTREAM_SECRET_ACCESS_KEY"),
    bucket: required("MANIFOLD_REPLICA_BUCKET"),
    endpoint: required("MANIFOLD_REPLICA_ENDPOINT"),
    region: process.env.MANIFOLD_REPLICA_REGION?.trim() || "us-east-1",
  });
}

function objectName(checkpointId: string): string {
  return `manifold-full-state/${checkpointId}.mfr`;
}

function writeRecoveryConfig(
  root: string,
  checkpointId: string,
  databases: readonly string[],
  configPath: string,
  listPath: string,
): void {
  for (const path of [configPath, listPath]) {
    const absolute = resolve(path);
    if (absolute === root || absolute.startsWith(`${root}${sep}`))
      fail("recovery control files must be outside the data directory");
  }
  if (resolve(configPath) === resolve(listPath)) fail("recovery control files must be distinct");
  const rows = databases.map((database) => {
    const relativePath = safePath(relative(root, database).split(sep).join("/"));
    return `  - path: ${JSON.stringify(database)}\n    replicas:\n      - type: s3\n        bucket: \${MANIFOLD_REPLICA_BUCKET}\n        path: ${JSON.stringify(`manifold-recovery/${checkpointId}/${relativePath}`)}\n        endpoint: \${MANIFOLD_REPLICA_ENDPOINT}\n        force-path-style: true\n        snapshot-interval: 1h\n        retention: 720h`;
  });
  writeFileSync(configPath, `dbs:\n${rows.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(listPath, `${databases.join("\n")}\n`, { flag: "wx", mode: 0o600 });
}

async function readCheckpointObject(checkpointId: string): Promise<Buffer> {
  const stream = objectClient().file(objectName(checkpointId)).stream().getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await stream.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CHECKPOINT_BYTES) fail("checkpoint object exceeds the recovery bound");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await stream.cancel();
    stream.releaseLock();
  }
}

async function capture(checkpointId: string): Promise<void> {
  validateCheckpointId(checkpointId);
  const sourceBuild = validateBuild(required("MANIFOLD_BUILD"));
  const root = dataDirectory();
  const files = capturedFiles(root);
  const plaintext = archive(checkpointId, sourceBuild, files);
  const capturedAt = JSON.parse(
    plaintext
      .subarray(
        ARCHIVE_MAGIC.byteLength + HEADER_BYTES,
        ARCHIVE_MAGIC.byteLength + HEADER_BYTES + plaintext.readUInt32BE(ARCHIVE_MAGIC.byteLength),
      )
      .toString("utf8"),
  ).capturedAt as string;
  const sealed = sealCheckpoint(checkpointId, sourceBuild, plaintext);
  plaintext.fill(0);
  for (const file of files) file.data.fill(0);
  const client = objectClient();
  const object = objectName(checkpointId);
  const target = client.file(object);
  if (await target.exists()) fail("checkpoint object already exists");
  await target.write(sealed, { type: "application/octet-stream" });
  const uploaded = await readCheckpointObject(checkpointId);
  const objectSha256 = sha256(sealed);
  if (sha256(uploaded) !== objectSha256) fail("uploaded checkpoint did not read back exactly");
  const receipt: RecoveryReceipt = {
    format: 1,
    checkpointId,
    sourceBuild,
    object,
    objectSha256,
    objectBytes: sealed.byteLength,
    capturedAt,
  };
  sealed.fill(0);
  uploaded.fill(0);
  console.log(JSON.stringify(receipt));
}

async function restore(
  checkpointId: string,
  expectedSha256: string,
  verifyOnly = false,
): Promise<void> {
  validateCheckpointId(checkpointId);
  validateSha(expectedSha256);
  const expectedBuild = validateBuild(
    required(verifyOnly ? "MANIFOLD_BUILD" : "MANIFOLD_RECOVERY_EXPECTED_BUILD"),
  );
  const sealed = await readCheckpointObject(checkpointId);
  if (sha256(sealed) !== expectedSha256) fail("checkpoint object sha256 does not match");
  const plaintext = unsealCheckpoint(checkpointId, sealed);
  sealed.fill(0);
  const root = verifyOnly
    ? mkdtempSync(join(tmpdir(), "manifold-recovery-verify-"))
    : dataDirectory();
  try {
    const restored = extractArchive(root, checkpointId, expectedBuild, plaintext);
    if (!verifyOnly)
      writeRecoveryConfig(
        root,
        checkpointId,
        restored.databases,
        required("MANIFOLD_RECOVERY_LITESTREAM_CONFIG"),
        required("MANIFOLD_RECOVERY_DATABASES_FILE"),
      );
    console.log(
      JSON.stringify({
        format: restored.header.format,
        checkpointId,
        sourceBuild: restored.header.sourceBuild,
        capturedAt: restored.header.capturedAt,
        files: restored.header.files.length,
        databases: restored.databases.length,
      }),
    );
  } finally {
    plaintext.fill(0);
    if (verifyOnly) rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, checkpointId, digest, ...rest] = process.argv.slice(2);
  if (rest.length !== 0 || checkpointId === undefined)
    fail("usage: full-state-recovery <capture ID | verify ID SHA256 | restore ID SHA256>");
  if (command === "capture" && digest === undefined) return capture(checkpointId);
  if (command === "restore" && digest !== undefined) return restore(checkpointId, digest);
  if (command === "verify" && digest !== undefined) return restore(checkpointId, digest, true);
  fail("usage: full-state-recovery <capture ID | verify ID SHA256 | restore ID SHA256>");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "full-state recovery failed");
    process.exit(1);
  }
}
