import { canonicalJobJson } from "@manifold/protocol";
import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, readFileSync, writeSync } from "node:fs";
import type { HeldDirectory } from "./job-files.ts";
import { lockExclusive } from "./job-files.ts";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_JOURNAL_BYTES = 128 * 1024 * 1024;
const MAX_RECORDS = 100_000;

export function jobDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}

export interface JournalRecord {
  readonly sequence: number;
  readonly previous: string;
  readonly body: unknown;
}

/** Immutable, hash-chained, fsynced records. Capacity exhaustion refuses new work; never evicts tombstones. */
export class JobJournal {
  readonly ownerId: string;
  readonly publicKey: string;
  readonly generation: number;
  readonly records: readonly unknown[];
  private readonly key: KeyObject;
  private readonly lockFd: number;
  private sequence = 0;
  private previous = "0".repeat(64);
  private bytes = 0;
  private closed = false;

  constructor(private readonly directory: HeldDirectory) {
    this.lockFd = directory.openFile("owner.lock", constants.O_RDWR | constants.O_CREAT);
    try {
      lockExclusive(this.lockFd);
      let identity: { privateKey: string; publicKey: string };
      if (directory.names().includes("identity")) {
        const fd = directory.openFile("identity");
        try {
          if (fstatSync(fd).size > 16384) throw new Error("owner_identity_oversize");
          const data = readFileSync(fd);
          if (data.length > 16384) throw new Error("owner_identity_oversize");
          identity = JSON.parse(data.toString("utf8"));
        } finally {
          closeSync(fd);
        }
      } else {
        const pair = generateKeyPairSync("ed25519");
        identity = {
          privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        };
        directory.atomicWrite("identity", Buffer.from(JSON.stringify(identity)));
      }
      this.key = createPrivateKey(identity.privateKey);
      this.publicKey = identity.publicKey;
      if (
        createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString() !==
        this.publicKey
      )
        throw new Error("owner_identity_key_mismatch");
      this.ownerId = createHash("sha256").update(this.publicKey).digest("hex");
      const records: unknown[] = [];
      let generation = 0;
      const names = directory
        .names()
        .filter((name) => /^record-[0-9]{8}$/.test(name))
        .sort();
      if (names.length > MAX_RECORDS) throw new Error("journal_capacity");
      for (const name of names) {
        if (name !== this.recordName(this.sequence + 1)) throw new Error("journal_gap");
        const fd = directory.openFile(name);
        let bytes: Buffer;
        try {
          if (fstatSync(fd).size > MAX_RECORD_BYTES) throw new Error("journal_capacity");
          bytes = readFileSync(fd);
        } finally {
          closeSync(fd);
        }
        if (bytes.length > MAX_RECORD_BYTES || this.bytes + bytes.length > MAX_JOURNAL_BYTES)
          throw new Error("journal_capacity");
        const record = JSON.parse(bytes.toString("utf8")) as JournalRecord;
        if (
          record.sequence !== this.sequence + 1 ||
          record.previous !== this.previous ||
          canonicalJobJson(record) !== bytes.toString("utf8")
        )
          throw new Error("journal_corrupt");
        this.sequence = record.sequence;
        this.previous = jobDigest(record);
        this.bytes += bytes.length;
        records.push(record.body);
        if (
          record.body !== null &&
          typeof record.body === "object" &&
          Reflect.get(record.body, "kind") === "generation"
        ) {
          const next = Reflect.get(record.body, "generation");
          if (!Number.isSafeInteger(next) || next !== generation + 1)
            throw new Error("journal_generation_corrupt");
          generation = next;
        }
      }
      this.generation = generation + 1;
      this.append({ kind: "generation", generation: this.generation });
      this.records = records;
    } catch (error) {
      closeSync(this.lockFd);
      directory.close();
      throw error;
    }
  }

  append(body: unknown): void {
    if (this.closed) throw new Error("journal_closed");
    const record = { sequence: this.sequence + 1, previous: this.previous, body };
    const bytes = Buffer.from(canonicalJobJson(record));
    if (
      bytes.length > MAX_RECORD_BYTES ||
      this.bytes + bytes.length > MAX_JOURNAL_BYTES ||
      this.sequence >= MAX_RECORDS
    )
      throw new Error("journal_capacity");
    const fd = this.directory.createFile(this.recordName(record.sequence));
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (!written) throw new Error("journal_short_write");
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.directory.sync();
    this.sequence = record.sequence;
    this.previous = jobDigest(record);
    this.bytes += bytes.length;
  }

  proof(body: unknown): string {
    return sign(null, Buffer.from(canonicalJobJson(body)), this.key).toString("base64");
  }
  inventoryDigest(): string {
    return this.previous;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.lockFd);
    this.directory.close();
  }
  private recordName(sequence: number): string {
    return `record-${String(sequence).padStart(8, "0")}`;
  }
}
