import {
  canonicalJobJson,
  JobCommandSchema,
  JobRequestSchema,
  JobResultSchema,
  type JobCommand,
  type JobResult,
  type LogEvent,
} from "@manifold/protocol";
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, readFileSync, writeSync } from "node:fs";
import { z } from "zod";
import type { HeldDirectory } from "./job-files.ts";
import { lockExclusive } from "./job-files.ts";

const MAX_RECORD_BYTES = 1024 * 1024;
// Every checkpoint entry derives from one record within MAX_RECORD_BYTES, and a part holds at
// least one entry, so a part can exceed the ordinary cap only by its own envelope.
const MAX_STORED_RECORD_BYTES = MAX_RECORD_BYTES + 4096;
const CHECKPOINT_PART_BYTES = 512 * 1024;
const SEGMENT_BYTES = 64 * 1024 * 1024;
const SEGMENT_RECORDS = 50_000;
const GENESIS = "0".repeat(64);
const ARCHIVE = "archive";
const RECORD_NAME = /^record-([0-9]{8,16})$/;
const SEGMENT_NAME = /^segment-([0-9]{8,16})$/;

export function jobDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}

export interface JournalRecord {
  readonly sequence: number;
  readonly previous: string;
  readonly body: unknown;
}

type InstallCommand = Extract<JobCommand, { type: "install" }>;
type JournalLog = (
  level: "info" | "warn",
  event: LogEvent,
  fields: Record<string, unknown>,
) => void;

/**
 * What recovery keeps of every job this owner reserved or refused: its identity, single-use
 * permit, latest result and consumed input cursor. The request's content is not kept; nothing
 * after admission reads it, and it is most of what the records hold.
 */
export interface RetainedJob {
  readonly jobId: string;
  readonly requestDigest: string;
  readonly permitId: string;
  readonly pluginId: string;
  readonly service: boolean;
  readonly result: JobResult;
  readonly inputSeq: number;
  readonly inputRequests: ReadonlySet<string>;
}
interface JobEntry extends RetainedJob {
  result: JobResult;
  inputSeq: number;
  readonly inputRequests: Set<string>;
}

export interface JobJournalOptions {
  /** Ordinary record bytes one segment holds before it is checkpointed and archived. */
  segmentBytes?: number;
  /** Ordinary records one segment holds before it is checkpointed and archived. */
  segmentRecords?: number;
  log?: JournalLog;
}

export interface JobJournalVerification {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly records: number;
  readonly segments: number;
  readonly checkpoints: number;
  readonly generation: number;
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RetainedJobSchema = z.strictObject({
  jobId: JobRequestSchema.shape.jobId,
  requestDigest: JobRequestSchema.shape.requestDigest,
  permitId: z.string(),
  pluginId: JobRequestSchema.shape.pluginId,
  service: z.boolean(),
  result: JobResultSchema,
  inputSeq: count,
  inputRequests: z.array(z.string()),
});
const CheckpointEntrySchema = z.union([
  z.strictObject({ install: z.looseObject({}) }),
  z.strictObject({ job: RetainedJobSchema }),
]);
const CheckpointPartSchema = z.strictObject({
  kind: z.literal("checkpoint_part"),
  entries: z.array(z.unknown()).min(1),
});
const CheckpointSchema = z.strictObject({
  kind: z.literal("checkpoint"),
  archive: z.strictObject({
    first: count.positive(),
    last: count.positive(),
    head: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  draining: z.boolean(),
  entries: count,
  generation: count,
  parts: count,
  signature: z.string().max(1024),
});

function recordName(sequence: number): string {
  return `record-${String(sequence).padStart(8, "0")}`;
}
function segmentName(first: number): string {
  return `segment-${String(first).padStart(8, "0")}`;
}
function installKey(command: InstallCommand): string {
  return `${command.pluginId}\0${command.installationRevision}`;
}
/** The one payload a checkpoint signature covers: its chain position and every other field. */
function checkpointPayload(sequence: number, previous: string, body: object): Buffer {
  return Buffer.from(canonicalJobJson({ sequence, previous, body }));
}

/**
 * The state recovery rebuilds, kept current on every append so a checkpoint never rereads
 * history. `prepare` validates a body completely before returning the mutation it implies.
 */
class JournalState {
  draining = false;
  readonly installs = new Map<string, InstallCommand>();
  readonly jobs = new Map<string, JobEntry>();
  readonly permits = new Set<string>();

  get size(): number {
    return this.installs.size + this.jobs.size;
  }

  prepare(body: unknown): () => void {
    if (body === null || typeof body !== "object") throw new Error("invalid_job_journal_record");
    switch (Reflect.get(body, "kind")) {
      case "invocation":
        return () => {};
      case "drain": {
        const draining = Reflect.get(body, "draining") === true;
        return () => {
          this.draining = draining;
        };
      }
      case "install": {
        const command = JobCommandSchema.parse(Reflect.get(body, "command"));
        if (command.type !== "install") throw new Error("invalid_install_record");
        return () => {
          this.installs.set(installKey(command), command);
        };
      }
      case "reservation":
      case "rejection": {
        const request = JobRequestSchema.parse(Reflect.get(body, "request"));
        const permitId = Reflect.get(body, "permitId");
        if (
          typeof permitId !== "string" ||
          this.permits.has(permitId) ||
          this.jobs.has(request.jobId)
        )
          throw new Error("duplicate_reservation_record");
        const job: JobEntry = {
          jobId: request.jobId,
          requestDigest: request.requestDigest,
          permitId,
          pluginId: request.pluginId,
          service: request.service !== undefined,
          result: JobResultSchema.parse(Reflect.get(body, "result")),
          inputSeq: 0,
          inputRequests: new Set(),
        };
        return () => {
          this.jobs.set(job.jobId, job);
          this.permits.add(permitId);
        };
      }
      case "input": {
        const job = this.jobs.get(String(Reflect.get(body, "jobId")));
        if (!job) throw new Error("unknown_job");
        const seq = Reflect.get(body, "nextInputSeq");
        const requestId = Reflect.get(body, "requestId");
        if (
          typeof seq !== "number" ||
          !Number.isSafeInteger(seq) ||
          seq !== job.inputSeq + 1 ||
          typeof requestId !== "string"
        )
          throw new Error("invalid_input_journal");
        return () => {
          job.inputSeq = seq;
          job.inputRequests.add(requestId);
        };
      }
      case "result": {
        const result = JobResultSchema.parse(Reflect.get(body, "result"));
        const job = this.jobs.get(result.jobId);
        if (!job || job.requestDigest !== result.requestDigest)
          throw new Error("orphan_job_result");
        return () => {
          job.result = result;
        };
      }
      default:
        throw new Error("unknown_job_journal_record");
    }
  }

  /** Installations in first-recorded order, then jobs in admission order: replay order. */
  *entries(): Generator<object> {
    for (const install of this.installs.values()) yield { install };
    for (const job of this.jobs.values())
      yield { job: { ...job, inputRequests: [...job.inputRequests] } };
  }

  *parts(limit: number): Generator<object[]> {
    let part: object[] = [];
    let bytes = 0;
    for (const entry of this.entries()) {
      const size = Buffer.byteLength(canonicalJobJson(entry)) + 1;
      if (part.length > 0 && bytes + size > limit) {
        yield part;
        part = [];
        bytes = 0;
      }
      part.push(entry);
      bytes += size;
    }
    if (part.length > 0) yield part;
  }

  restore(raw: unknown): void {
    const parsed = CheckpointEntrySchema.safeParse(raw);
    if (!parsed.success) throw new Error("journal_checkpoint_corrupt");
    const entry = parsed.data;
    if ("install" in entry) {
      const command = JobCommandSchema.parse(entry.install);
      if (command.type !== "install") throw new Error("invalid_install_record");
      const key = installKey(command);
      if (this.installs.has(key)) throw new Error("journal_checkpoint_corrupt");
      this.installs.set(key, command);
      return;
    }
    const { inputRequests, ...job } = entry.job;
    const requests = new Set(inputRequests);
    if (
      requests.size !== inputRequests.length ||
      this.jobs.has(job.jobId) ||
      this.permits.has(job.permitId)
    )
      throw new Error("journal_checkpoint_corrupt");
    this.jobs.set(job.jobId, { ...job, inputRequests: requests });
    this.permits.add(job.permitId);
  }

  equals(other: JournalState): boolean {
    if (this.draining !== other.draining || this.size !== other.size) return false;
    const theirs = other.entries();
    for (const entry of this.entries())
      if (canonicalJobJson(entry) !== canonicalJobJson(theirs.next().value)) return false;
    return true;
  }
}

/** One checkpoint part, not yet proved by the signed checkpoint that follows it. */
interface CheckpointPart {
  readonly sequence: number;
  /** The first part's link is the chain head its checkpoint claims to continue. */
  readonly previous: string;
  readonly entries: readonly unknown[];
}

interface ArchiveRange {
  readonly first: number;
  readonly last: number;
}

/**
 * Replays one contiguous run of records. From sequence 1 it folds every record; from anywhere
 * else it folds nothing until a verified checkpoint supplies the state. A checkpoint reached
 * while folding must equal the state its sealed records replay to.
 */
class Replay {
  state = new JournalState();
  generation = 0;
  folding: boolean;
  last: number;
  head: string | null;
  /** First sequence of the current segment: sequence 1, or the newest checkpoint's first part. */
  segmentFirst: number;
  segmentBytes = 0;
  segmentRecords = 0;
  checkpoints = 0;
  readonly sealed: ArchiveRange[] = [];
  /** The current run of consecutive parts. A rotation that failed before its signature leaves
   * parts a later one follows directly, so only the run's last `parts` belong to a checkpoint. */
  private parts: CheckpointPart[] = [];

  constructor(
    readonly first: number,
    private readonly publicKey: KeyObject,
  ) {
    this.folding = first === 1;
    this.head = this.folding ? GENESIS : null;
    this.last = first - 1;
    this.segmentFirst = first;
  }

  visit(record: JournalRecord, size: number, digest: string): void {
    if (record.sequence !== this.last + 1 || (this.head !== null && record.previous !== this.head))
      throw new Error("journal_corrupt");
    const kind =
      record.body !== null && typeof record.body === "object"
        ? Reflect.get(record.body, "kind")
        : undefined;
    if (kind === "checkpoint_part") {
      const parsed = CheckpointPartSchema.safeParse(record.body);
      if (!parsed.success) throw new Error("journal_checkpoint_corrupt");
      if (this.parts.at(-1)?.sequence !== record.sequence - 1) this.parts = [];
      this.parts.push({
        sequence: record.sequence,
        previous: record.previous,
        entries: parsed.data.entries,
      });
    } else if (kind === "checkpoint") {
      this.seal(record);
    } else {
      this.parts = [];
      if (this.folding) {
        if (kind === "generation") {
          const next = Reflect.get(record.body as object, "generation");
          if (!Number.isSafeInteger(next) || next !== this.generation + 1)
            throw new Error("journal_generation_corrupt");
          this.generation = next;
        } else this.state.prepare(record.body)();
        this.segmentBytes += size;
        this.segmentRecords += 1;
      }
    }
    this.last = record.sequence;
    this.head = digest;
  }

  private seal(record: JournalRecord): void {
    const parsed = CheckpointSchema.safeParse(record.body);
    if (!parsed.success) throw new Error("journal_checkpoint_corrupt");
    const { signature, ...body } = parsed.data;
    const firstPart = record.sequence - body.parts;
    const parts = body.parts === 0 ? [] : this.parts.slice(-body.parts);
    if (
      parts.length !== body.parts ||
      (parts.length > 0 &&
        (parts[0]!.sequence !== firstPart || parts.at(-1)!.sequence !== record.sequence - 1)) ||
      body.archive.head !== (parts[0]?.previous ?? record.previous) ||
      body.archive.last !== firstPart - 1 ||
      body.archive.first > body.archive.last
    )
      throw new Error("journal_checkpoint_corrupt");
    // The signature covers this record's link, which commits to every part before it.
    if (
      !verify(
        null,
        checkpointPayload(record.sequence, record.previous, body),
        this.publicKey,
        Buffer.from(signature, "base64"),
      )
    )
      throw new Error("journal_checkpoint_signature_invalid");
    const restored = new JournalState();
    for (const part of parts) for (const entry of part.entries) restored.restore(entry);
    restored.draining = body.draining;
    if (restored.size !== body.entries) throw new Error("journal_checkpoint_corrupt");
    if (
      this.folding &&
      (body.archive.first !== this.segmentFirst ||
        body.generation !== this.generation ||
        !restored.equals(this.state))
    )
      throw new Error("journal_checkpoint_mismatch");
    this.state = restored;
    this.generation = body.generation;
    this.folding = true;
    this.sealed.push({ first: body.archive.first, last: body.archive.last });
    this.segmentFirst = firstPart;
    this.segmentBytes = 0;
    this.segmentRecords = 0;
    this.checkpoints += 1;
    this.parts = [];
  }
}

function recordSequences(directory: HeldDirectory): number[] {
  const sequences: number[] = [];
  for (const name of directory.names()) {
    const match = RECORD_NAME.exec(name);
    if (!match) continue;
    const sequence = Number(match[1]);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || name !== recordName(sequence))
      throw new Error("journal_corrupt");
    sequences.push(sequence);
  }
  sequences.sort((a, b) => a - b);
  for (let at = 1; at < sequences.length; at++)
    if (sequences[at] !== sequences[0]! + at) throw new Error("journal_gap");
  return sequences;
}

function archivedSegments(archive: HeldDirectory): { name: string; first: number }[] {
  const segments: { name: string; first: number }[] = [];
  for (const name of archive.names()) {
    const match = SEGMENT_NAME.exec(name);
    const first = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(first) || first < 1 || name !== segmentName(first))
      throw new Error("journal_archive_corrupt");
    segments.push({ name, first });
  }
  return segments.sort((a, b) => a.first - b.first);
}

function readRecord(
  directory: HeldDirectory,
  sequence: number,
): { record: JournalRecord; size: number; digest: string } {
  const fd = directory.openFile(recordName(sequence));
  let bytes: Buffer;
  try {
    if (fstatSync(fd).size > MAX_STORED_RECORD_BYTES) throw new Error("journal_record_oversize");
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  if (bytes.length > MAX_STORED_RECORD_BYTES) throw new Error("journal_record_oversize");
  const text = bytes.toString("utf8");
  let record: JournalRecord;
  try {
    record = JSON.parse(text) as JournalRecord;
  } catch {
    throw new Error("journal_corrupt");
  }
  if (
    record === null ||
    typeof record !== "object" ||
    record.sequence !== sequence ||
    typeof record.previous !== "string" ||
    canonicalJobJson(record) !== text
  )
    throw new Error("journal_corrupt");
  // The text is the record's canonical form, so this is jobDigest(record) without reserializing.
  return { record, size: bytes.length, digest: createHash("sha256").update(text).digest("hex") };
}

function readIdentity(directory: HeldDirectory): { privateKey: string; publicKey: string } {
  const fd = directory.openFile("identity");
  try {
    if (fstatSync(fd).size > 16384) throw new Error("owner_identity_oversize");
    const data = readFileSync(fd);
    if (data.length > 16384) throw new Error("owner_identity_oversize");
    const identity: unknown = JSON.parse(data.toString("utf8"));
    if (
      identity === null ||
      typeof identity !== "object" ||
      typeof Reflect.get(identity, "privateKey") !== "string" ||
      typeof Reflect.get(identity, "publicKey") !== "string"
    )
      throw new Error("owner_identity_invalid");
    return identity as { privateKey: string; publicKey: string };
  } finally {
    closeSync(fd);
  }
}

/**
 * Immutable, hash-chained, fsynced records in bounded segments. When the live segment is full,
 * a checkpoint signed by the owner identity carries the replay state and the chain head, and
 * the sealed records move unchanged into `archive/`. Startup reads only the live segment, and
 * a single oversized record is the only append the journal refuses. Tombstones are never evicted.
 */
export class JobJournal {
  readonly ownerId: string;
  readonly publicKey: string;
  readonly generation: number;
  private readonly key: KeyObject;
  private readonly lockFd: number;
  private readonly segmentLimit: { readonly bytes: number; readonly records: number };
  private readonly log: JournalLog | undefined;
  private state = new JournalState();
  private sequence = 0;
  private previous = GENESIS;
  private recorded = 0;
  private segmentFirst = 1;
  private segmentBytes = 0;
  private segmentRecords = 0;
  /** Checkpointed ranges whose records may still be live after an interrupted archive move. */
  private sealed: ArchiveRange[] = [];
  private closed = false;

  constructor(
    private readonly directory: HeldDirectory,
    options: JobJournalOptions = {},
  ) {
    this.segmentLimit = {
      bytes: options.segmentBytes ?? SEGMENT_BYTES,
      records: options.segmentRecords ?? SEGMENT_RECORDS,
    };
    this.log = options.log;
    this.lockFd = directory.openFile("owner.lock", constants.O_RDWR | constants.O_CREAT);
    try {
      lockExclusive(this.lockFd);
      let identity: { privateKey: string; publicKey: string };
      if (directory.names().includes("identity")) identity = readIdentity(directory);
      else {
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
      this.load();
      this.generation = this.recorded + 1;
      // A live segment over its limit, including a whole pre-segmentation journal, is
      // checkpointed and archived by this first append.
      this.appendRecord({ kind: "generation", generation: this.generation }, () => {
        this.recorded = this.generation;
      });
    } catch (error) {
      closeSync(this.lockFd);
      directory.close();
      throw error;
    }
  }

  /** The admission latch as last recorded. */
  get draining(): boolean {
    return this.state.draining;
  }
  /** Each installation's last recorded command, in first-recorded order. */
  installations(): IterableIterator<InstallCommand> {
    return this.state.installs.values();
  }
  /** Every job this owner ever reserved or refused, from any generation. */
  job(jobId: string): RetainedJob | undefined {
    return this.state.jobs.get(jobId);
  }
  jobs(): IterableIterator<RetainedJob> {
    return this.state.jobs.values();
  }
  /** A permit is single-use for this owner's lifetime, across every segment. */
  permitConsumed(permitId: string): boolean {
    return this.state.permits.has(permitId);
  }

  append(body: unknown): void {
    if (this.closed) throw new Error("journal_closed");
    this.appendRecord(body, this.state.prepare(body));
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

  private load(): void {
    const live = recordSequences(this.directory);
    if (live.length === 0) {
      if (this.directory.names().includes(ARCHIVE)) throw new Error("journal_gap");
      return;
    }
    const replay = new Replay(live[0]!, createPublicKey(this.publicKey));
    // Streaming: one record at a time, folded into the retained state and dropped.
    for (const sequence of live) {
      const { record, size, digest } = readRecord(this.directory, sequence);
      replay.visit(record, size, digest);
    }
    if (!replay.folding) throw new Error("journal_checkpoint_missing");
    for (let sequence = live[0]!; sequence < replay.segmentFirst; sequence++)
      if (!replay.sealed.some((range) => range.first <= sequence && sequence <= range.last))
        throw new Error("journal_gap");
    this.state = replay.state;
    this.sequence = replay.last;
    this.previous = replay.head!;
    this.recorded = replay.generation;
    this.segmentFirst = replay.segmentFirst;
    this.segmentBytes = replay.segmentBytes;
    this.segmentRecords = replay.segmentRecords;
    this.sealed = live[0]! < replay.segmentFirst ? replay.sealed : [];
    this.archiveSealed();
  }

  private appendRecord(body: unknown, commit: () => void): void {
    let bytes = this.encode(body);
    if (bytes.length > MAX_RECORD_BYTES) throw new Error("journal_record_oversize");
    if (
      this.segmentRecords > 0 &&
      (this.segmentBytes + bytes.length > this.segmentLimit.bytes ||
        this.segmentRecords >= this.segmentLimit.records)
    ) {
      this.rotate();
      bytes = this.encode(body);
    }
    this.write(bytes);
    this.segmentBytes += bytes.length;
    this.segmentRecords += 1;
    commit();
  }

  /** Checkpoints the state this segment replays to, then archives the sealed segment. */
  private rotate(): void {
    this.archiveSealed();
    const archive = { first: this.segmentFirst, last: this.sequence, head: this.previous };
    const segmentBytes = this.segmentBytes;
    let parts = 0;
    for (const entries of this.state.parts(CHECKPOINT_PART_BYTES)) {
      const bytes = this.encode({ kind: "checkpoint_part", entries });
      if (bytes.length > MAX_STORED_RECORD_BYTES) throw new Error("journal_record_oversize");
      this.write(bytes);
      parts += 1;
    }
    const body = {
      kind: "checkpoint",
      archive,
      draining: this.state.draining,
      entries: this.state.size,
      generation: this.recorded,
      parts,
    };
    const signature = sign(
      null,
      checkpointPayload(this.sequence + 1, this.previous, body),
      this.key,
    ).toString("base64");
    this.write(this.encode({ ...body, signature }));
    this.segmentFirst = archive.last + 1;
    this.segmentBytes = 0;
    this.segmentRecords = 0;
    this.sealed = [{ first: archive.first, last: archive.last }];
    this.archiveSealed();
    this.log?.("info", "journal_segment_sealed", {
      first: archive.first,
      last: archive.last,
      segmentBytes,
      checkpointEntries: body.entries,
      checkpointParts: parts,
      generation: body.generation,
    });
  }

  /** Idempotent: moves every still-live record of each sealed range into its archive segment. */
  private archiveSealed(): void {
    if (this.sealed.length === 0) return;
    const live = new Set(this.directory.names());
    const archive = this.directory.openChild(ARCHIVE, { create: true });
    try {
      for (const range of this.sealed) {
        const segment = archive.openChild(segmentName(range.first), { create: true });
        try {
          for (let sequence = range.first; sequence <= range.last; sequence++) {
            const name = recordName(sequence);
            if (live.has(name)) this.directory.moveInto(name, segment);
          }
          segment.sync();
        } finally {
          segment.close();
        }
      }
      archive.sync();
    } finally {
      archive.close();
    }
    this.directory.sync();
    this.sealed = [];
  }

  private encode(body: unknown): Buffer {
    return Buffer.from(
      canonicalJobJson({ sequence: this.sequence + 1, previous: this.previous, body }),
    );
  }

  private write(bytes: Buffer): void {
    const sequence = this.sequence + 1;
    const name = recordName(sequence);
    const fd = this.directory.createFile(name);
    try {
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
    } catch (error) {
      // Never acknowledged: removing it keeps one failed append, a rotation's included, from
      // holding the next record's name or leaving a torn record for the next start.
      try {
        this.directory.unlink(name);
      } catch (cleanup) {
        if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
          throw new AggregateError([error, cleanup], "journal_write_cleanup_failed");
      }
      throw error;
    }
    this.sequence = sequence;
    this.previous = createHash("sha256").update(bytes).digest("hex");
  }
}

/**
 * Rereads every archived segment and then the live records, without the owner lock: chain
 * continuity, each checkpoint's signature, and that each checkpoint equals the state its sealed
 * records replay to. Memory is bounded by that state, not by history. A rotation concurrent
 * with the read can fail verification; it cannot make a tampered journal pass.
 */
export function verifyJobJournal(directory: HeldDirectory): JobJournalVerification {
  const publicKey = createPublicKey(readIdentity(directory).publicKey);
  let replay: Replay | null = null;
  let records = 0;
  const walk = (held: HeldDirectory, sequences: readonly number[]): void => {
    for (const sequence of sequences) {
      const { record, size, digest } = readRecord(held, sequence);
      replay ??= new Replay(sequence, publicKey);
      replay.visit(record, size, digest);
      records += 1;
    }
  };
  const archived: { first: number; last: number }[] = [];
  if (directory.names().includes(ARCHIVE)) {
    const archive = directory.openChild(ARCHIVE);
    try {
      for (const { name, first } of archivedSegments(archive)) {
        const segment = archive.openChild(name);
        try {
          const sequences = recordSequences(segment);
          if (sequences[0] !== first) throw new Error("journal_archive_corrupt");
          walk(segment, sequences);
          archived.push({ first, last: sequences.at(-1)! });
        } finally {
          segment.close();
        }
      }
    } finally {
      archive.close();
    }
  }
  const live = recordSequences(directory);
  walk(directory, live);
  const verified = replay as Replay | null;
  if (verified === null || !verified.folding) throw new Error("journal_checkpoint_missing");
  // Every archived record lies inside the checkpointed range its segment is named for.
  for (const segment of archived)
    if (
      !verified.sealed.some((range) => range.first === segment.first && segment.last <= range.last)
    )
      throw new Error("journal_archive_corrupt");
  return {
    firstSequence: verified.first,
    lastSequence: verified.last,
    records,
    segments: archived.length,
    checkpoints: verified.checkpoints,
    generation: verified.generation,
  };
}
