import { describe, expect, spyOn, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJobJson,
  JobEventSchema,
  type JobCommand,
  type JobEvent,
  type JobRequest,
  type JobResult,
} from "@manifold/protocol";
import { artifactCacheKey } from "../src/job-artifacts.ts";
import { HeldDirectory } from "../src/job-files.ts";
import {
  JobJournal,
  jobDigest,
  verifyJobJournal,
  type JobJournalOptions,
} from "../src/job-journal.ts";
import * as nativeRuntime from "../src/job-linux.ts";
import { MachineJobOwner } from "../src/job-owner.ts";
import { JobOutputStore } from "../src/job-outputs.ts";

const linux = process.platform === "linux";
/** The lifetime caps this journal had before segmentation (#848). */
const OLD_JOURNAL_BYTES = 128 * 1024 * 1024;
const limits = { timeoutMs: 5000, memoryBytes: 64 * 1024 * 1024, processes: 8, outputBytes: 65536 };
const artifact = Buffer.from("#!/bin/sh\nexit 0\n");
const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
const artifactSpec = {
  url: "https://example.invalid/fixture",
  sha256: artifactSha256,
  format: "raw" as const,
  entry: ["fixture"],
  entrySha256: artifactSha256,
  maxBytes: artifact.length,
  maxExpandedBytes: artifact.length,
  maxMembers: 1,
};
const install: Extract<JobCommand, { type: "install" }> = {
  type: "install",
  pluginId: "fixture.jobs",
  installationRevision: "r1",
  artifactSha256,
  machine: {
    artifacts: { [`linux-${process.arch}`]: artifactSpec },
    locations: {},
    operations: {
      "fixture.jobs.run": {
        argv: [],
        input: { prompt: { type: "string", required: false, maxLength: 65536 } },
        runtimeTools: [],
        locations: [],
        outputs: [],
        network: "none",
        limits,
        stdin: true,
      },
    },
  },
};

function jobRequest(jobId: string, prompt?: string): JobRequest {
  const body = {
    jobId,
    machineId: "machine",
    pluginId: install.pluginId,
    operationId: "fixture.jobs.run",
    installationRevision: install.installationRevision,
    artifactSha256,
    input: prompt === undefined ? {} : { prompt },
    outputs: [],
    limits,
    parent: null,
    credential: {
      principalId: "actor",
      tokenId: null,
      grantId: null,
      caps: [],
      containerScope: null,
    },
    traceId: "trace",
  };
  return { ...body, requestDigest: jobDigest(body) };
}
function jobResult(
  request: JobRequest,
  ownerId: string,
  ownerGeneration: number,
  state: JobResult["state"],
  reason: string | null = null,
): JobResult {
  return {
    jobId: request.jobId,
    requestDigest: request.requestDigest,
    ownerId,
    ownerGeneration,
    state,
    exitCode: state === "exited" ? 0 : null,
    reason,
    startedAt: null,
    finishedAt: null,
    usage: null,
    limits: request.limits,
    outputs: [],
  };
}
function rejection(journal: JobJournal, jobId: string): unknown {
  const request = jobRequest(jobId);
  return {
    kind: "rejection",
    request,
    permitId: `${jobId}-permit`,
    result: jobResult(
      request,
      journal.ownerId,
      journal.generation,
      "refused",
      "start_not_admitted",
    ),
  };
}

const recordName = (sequence: number) => `record-${String(sequence).padStart(8, "0")}`;
const recordFiles = (directory: string) =>
  readdirSync(directory)
    .filter((name) => /^record-[0-9]+$/.test(name))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)))
    .map((name) => join(directory, name));
const segmentDirectories = (journal: string) =>
  readdirSync(join(journal, "archive"))
    .sort()
    .map((name) => join(journal, "archive", name));
/** The fields these tests read or forge on a stored record; the journal itself validates all. */
interface StoredRecord {
  sequence: number;
  previous: string;
  body: {
    kind?: string;
    signature?: string;
    entries?: { job?: { result: JobResult } }[];
    result?: JobResult;
  };
}
const readRecord = (path: string) => JSON.parse(readFileSync(path, "utf8")) as StoredRecord;
/** Rewrites records in order so each links to the one before it, as a forger with disk access would. */
function rechain(paths: readonly string[], previous: string): void {
  for (const path of paths) {
    const record = readRecord(path);
    const text = canonicalJobJson({ ...record, previous });
    writeFileSync(path, text);
    previous = createHash("sha256").update(text).digest("hex");
  }
}
const digestOf = (path: string) =>
  createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
const openJournal = (path: string, options?: JobJournalOptions) =>
  new JobJournal(HeldDirectory.openAbsolute(path, { private: true }), options);
function verifyAt(path: string) {
  const directory = HeldDirectory.openAbsolute(path, { private: true });
  try {
    return verifyJobJournal(directory);
  } finally {
    directory.close();
  }
}

/** Writes a journal exactly as a pre-segmentation owner left it: one flat chain from record 1. */
function writeLegacyJournal(
  root: string,
  history: (ownerId: string) => Iterable<unknown>,
): { records: number; bytes: number; digest: string } {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  writeFileSync(
    join(root, "identity"),
    JSON.stringify({
      privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      publicKey,
    }),
    { mode: 0o600 },
  );
  const all = createHash("sha256");
  let previous = "0".repeat(64);
  let sequence = 0;
  let bytes = 0;
  for (const body of history(createHash("sha256").update(publicKey).digest("hex"))) {
    sequence += 1;
    const text = canonicalJobJson({ sequence, previous, body });
    writeFileSync(join(root, recordName(sequence)), text, { mode: 0o600 });
    previous = createHash("sha256").update(text).digest("hex");
    bytes += Buffer.byteLength(text);
    all.update(text);
  }
  return { records: sequence, bytes, digest: all.digest("hex") };
}

interface OwnerFixture {
  readonly journalPath: string;
  readonly events: JobEvent[];
  readonly launches: Array<() => void>;
  launchCount(): number;
  open(options?: JobJournalOptions): Promise<{ owner: MachineJobOwner; journal: JobJournal }>;
  start(
    owner: MachineJobOwner,
    request: JobRequest,
    permitId: string,
    generation?: number,
  ): Promise<void>;
  admission(
    owner: MachineJobOwner,
    request: JobRequest,
    permitId: string,
    generation: number,
  ): object;
  until(predicate: (event: JobEvent) => boolean): Promise<JobEvent>;
  close(): void;
}

/**
 * A real owner over a real journal and output store. Only the kernel boundary is replaced:
 * descendant recovery, the cgroup preflight and the native spawn, whose workloads exit when
 * the test says so.
 */
function ownerFixture(root: string): OwnerFixture {
  const keys = generateKeyPairSync("ed25519");
  const journalPath = join(root, "journal");
  mkdirSync(journalPath, { recursive: true, mode: 0o700 });
  const protectedRoot = HeldDirectory.openAbsolute(root, { private: true });
  const cache = protectedRoot.openChild("cache", { create: true });
  writeFileSync(join(root, "cache", artifactCacheKey(artifactSpec, artifactSha256)), artifact, {
    mode: 0o500,
  });
  const managedState = protectedRoot.openChild("locations", { create: true });
  const delegatedCgroup = protectedRoot.openChild("cgroup", { create: true });
  // The spawn is replaced, but admission still holds the launcher descriptor it would pass.
  const bubblewrapFd = cache.openRuntimeFile(artifactCacheKey(artifactSpec, artifactSha256));
  const outputs = JobOutputStore.open(protectedRoot.openChild("outputs", { create: true }));
  const events: JobEvent[] = [];
  const launches: Array<() => void> = [];
  const recover = spyOn(nativeRuntime, "recoverLinuxJobs").mockResolvedValue(undefined);
  const preflight = spyOn(nativeRuntime, "preflightLinuxJob").mockReturnValue(0);
  const launch = spyOn(nativeRuntime, "startLinuxJob").mockImplementation(async () => {
    const exited = Promise.withResolvers<nativeRuntime.LinuxJobResult>();
    const startedAt = Date.now();
    const exit = () =>
      exited.resolve({
        exitCode: 0,
        signal: null,
        reason: "exited",
        startedAt,
        finishedAt: Date.now(),
        empty: true,
        boundary: "linux-bubblewrap-cgroup-v2",
        usage: {
          wallMs: 1,
          cpuUsec: 1,
          memoryPeakBytes: 1,
          processesPeak: 1,
          outputBytes: 0,
          oomKills: 0,
        },
      });
    launches.push(exit);
    return {
      result: exited.promise,
      childDelegation: delegatedCgroup,
      ownsLoopbackListener: () => false,
      ownsLoopbackConnection: () => false,
      release() {},
      input: async () => {},
      endInput() {},
      cancel: async () => {
        exit();
        return exited.promise;
      },
    };
  });
  const waiters: Array<{
    predicate: (event: JobEvent) => boolean;
    resolve(event: JobEvent): void;
  }> = [];
  let owner: MachineJobOwner | undefined;
  const admission = (
    current: MachineJobOwner,
    request: JobRequest,
    permitId: string,
    generation: number,
  ) => {
    const now = Date.now();
    const body = {
      permitId,
      jobId: request.jobId,
      requestDigest: request.requestDigest,
      ownerId: current.identity.ownerId,
      ownerGeneration: generation,
      decisionId: "decision",
      policyRevision: "policy",
      issuedAt: now,
      expiresAt: now + 30_000,
    };
    return {
      request,
      permit: {
        ...body,
        signature: sign(null, Buffer.from(canonicalJobJson(body)), keys.privateKey).toString(
          "base64",
        ),
      },
    };
  };
  return {
    journalPath,
    events,
    launches,
    launchCount: () => launch.mock.calls.length,
    async open(options) {
      const journal = openJournal(journalPath, options);
      owner = await MachineJobOwner.open({
        machineId: "machine",
        admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
        journal,
        cache,
        managedState,
        outputs,
        delegatedCgroup,
        bubblewrapFd,
        anchors: {},
        runtimeTools: {},
        protectedDirectories: [protectedRoot],
        artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
      });
      const current = owner;
      current.attach((raw) => {
        const event = JobEventSchema.parse(raw);
        events.push(event);
        if (event.type === "input_authorize")
          void current.execute({
            type: "input_authorized",
            jobId: event.jobId,
            requestId: event.requestId,
            allowed: true,
          });
        for (const waiter of [...waiters])
          if (waiter.predicate(event)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(event);
          }
        return true;
      });
      return { owner: current, journal };
    },
    async start(current, request, permitId, generation = current.identity.generation) {
      await current.execute({
        type: "start",
        ...admission(current, request, permitId, generation),
      });
    },
    admission,
    until(predicate) {
      const seen = events.find(predicate);
      if (seen) return Promise.resolve(seen);
      const { promise, resolve } = Promise.withResolvers<JobEvent>();
      waiters.push({ predicate, resolve });
      return promise;
    },
    close() {
      recover.mockRestore();
      preflight.mockRestore();
      launch.mockRestore();
      outputs.close();
      closeSync(bubblewrapFd);
      for (const directory of [managedState, delegatedCgroup, cache, protectedRoot])
        directory.close();
    },
  };
}
const settledResult = (jobId: string) => (event: JobEvent) =>
  event.type === "result" &&
  event.result.jobId === jobId &&
  !["start-committed", "started"].includes(event.result.state);

describe.skipIf(!linux)("segmented owner journal", () => {
  test("generation and signing identity survive restart; concurrent owner cannot take its lock", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-"));
    try {
      const first = openJournal(root);
      const ownerId = first.ownerId;
      const publicKey = first.publicKey;
      const body = { nonce: "fresh", serverEpoch: "epoch", machineId: "machine", generation: 1 };
      expect(
        verify(
          null,
          Buffer.from(canonicalJobJson(body)),
          createPublicKey(publicKey),
          Buffer.from(first.proof(body), "base64"),
        ),
      ).toBe(true);
      expect(
        verify(
          null,
          Buffer.from(canonicalJobJson({ ...body, nonce: "other" })),
          createPublicKey(publicKey),
          Buffer.from(first.proof(body), "base64"),
        ),
      ).toBe(false);
      expect(() => openJournal(root)).toThrow("job_owner_already_locked");
      first.append(rejection(first, "reserved"));
      first.close();
      const second = openJournal(root);
      expect(second.ownerId).toBe(ownerId);
      expect(second.publicKey).toBe(publicKey);
      expect(second.generation).toBe(2);
      expect(second.job("reserved")).toMatchObject({
        permitId: "reserved-permit",
        result: { state: "refused", ownerGeneration: 1 },
      });
      expect(second.permitConsumed("reserved-permit")).toBe(true);
      second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing, torn or unparseable records refuse recovery instead of forgetting effects", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-"));
    try {
      const journal = openJournal(root);
      journal.append({ kind: "drain", draining: true });
      journal.append({ kind: "drain", draining: false });
      // A body replay would reject never becomes durable.
      expect(() => journal.append({ kind: "reservation", jobId: "partial" })).toThrow();
      expect(() => journal.append({ kind: "checkpoint", parts: 0 })).toThrow(
        "unknown_job_journal_record",
      );
      journal.close();
      expect(recordFiles(root)).toHaveLength(3);
      unlinkSync(join(root, recordName(2)));
      expect(() => openJournal(root)).toThrow("journal_gap");
      writeFileSync(join(root, recordName(2)), '{"sequence":2', { mode: 0o600 });
      expect(() => openJournal(root)).toThrow("journal_corrupt");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("segments rotate with no lifetime total, and a restart reads only the live segment", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-"));
    try {
      const segmentRecords = 40;
      const journal = openJournal(root, { segmentRecords });
      const appended = 1200;
      for (let index = 0; index < appended; index++) {
        if (index % 10 === 0) journal.append(rejection(journal, `job-${index}`));
        else journal.append({ kind: "drain", draining: index % 2 === 0 });
      }
      const head = journal.inventoryDigest();
      journal.close();
      const segments = segmentDirectories(root);
      expect(segments.length).toBeGreaterThanOrEqual(appended / segmentRecords - 1);
      const archived = segments.flatMap(recordFiles);
      const live = recordFiles(root);
      // One chain, every sequence exactly once, split between the archive and the live segment.
      expect([...archived, ...live].map((path) => readRecord(path).sequence)).toEqual(
        Array.from({ length: archived.length + live.length }, (_, index) => index + 1),
      );
      expect(readRecord(live[0]!).body.kind).toBe("checkpoint_part");
      expect(live.length).toBeLessThanOrEqual(segmentRecords + 2);
      const reopened = openJournal(root, { segmentRecords });
      expect(reopened.generation).toBe(2);
      expect(reopened.draining).toBe(false);
      expect([...reopened.jobs()].map((job) => job.jobId)).toEqual(
        Array.from({ length: appended / 10 }, (_, index) => `job-${index * 10}`),
      );
      expect(readRecord(join(root, recordName(archived.length + live.length + 1))).previous).toBe(
        head,
      );
      reopened.close();
      expect(verifyAt(root)).toMatchObject({
        firstSequence: 1,
        segments: segmentDirectories(root).length,
        checkpoints: segmentDirectories(root).length,
        generation: 2,
      });
      // Startup never needs the archive, and verification starts at the oldest checkpoint left.
      const [oldest, next] = segmentDirectories(root);
      rmSync(oldest!, { recursive: true });
      openJournal(root, { segmentRecords }).close();
      expect(verifyAt(root)).toMatchObject({
        firstSequence: readRecord(recordFiles(next!)[0]!).sequence,
        segments: segmentDirectories(root).length,
        generation: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a pre-segmentation journal past the old caps converts once, keeps its archive and keeps admitting", async () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-legacy-"));
    const fixture = ownerFixture(root);
    let current: { owner: MachineJobOwner; journal: JobJournal } | undefined;
    try {
      const jobs = 2_200;
      const prompt = "x".repeat(60_000);
      const legacy = writeLegacyJournal(fixture.journalPath, function* (ownerId) {
        yield { kind: "generation", generation: 1 };
        yield { kind: "install", command: install };
        yield { kind: "drain", draining: true };
        yield { kind: "drain", draining: false };
        for (let index = 0; index < jobs; index++) {
          const generation = index < jobs / 2 ? 1 : 2;
          if (index === jobs / 2) yield { kind: "generation", generation: 2 };
          const request = jobRequest(`legacy-${index}`, prompt);
          yield {
            kind: "reservation",
            request,
            permitId: `legacy-permit-${index}`,
            result: jobResult(request, ownerId, generation, "start-committed"),
          };
          yield {
            kind: "invocation",
            parentJobId: request.jobId,
            invocationId: `invocation-${index}`,
            digest: "b".repeat(64),
          };
          yield { kind: "result", result: jobResult(request, ownerId, generation, "exited") };
        }
        const refused = jobRequest("legacy-refused");
        yield {
          kind: "rejection",
          request: refused,
          permitId: "legacy-refused-permit",
          result: jobResult(refused, ownerId, 2, "refused", "start_not_admitted"),
        };
        const running = jobRequest("legacy-running");
        yield {
          kind: "reservation",
          request: running,
          permitId: "legacy-running-permit",
          result: jobResult(running, ownerId, 2, "started"),
        };
        for (const [seq, requestId] of ["input-0", "input-1"].entries())
          yield { kind: "input", jobId: running.jobId, requestId, nextInputSeq: seq + 1 };
      });
      // The pre-segmentation owner refused to load this journal (journal_capacity).
      expect(legacy.bytes).toBeGreaterThan(OLD_JOURNAL_BYTES);

      const logs: Record<string, unknown>[] = [];
      const log: JobJournalOptions["log"] = (_level, event, fields) =>
        logs.push({ event, ...fields });
      current = await fixture.open({ log });
      expect(logs).toEqual([
        expect.objectContaining({
          event: "journal_segment_sealed",
          first: 1,
          last: legacy.records,
          segmentBytes: legacy.bytes,
          checkpointEntries: jobs + 3,
          generation: 2,
        }),
      ]);
      // Every legacy record is retained unchanged, off the startup path.
      const [segment, ...others] = segmentDirectories(fixture.journalPath);
      expect(others).toEqual([]);
      const archived = recordFiles(segment!);
      expect(archived).toHaveLength(legacy.records);
      const replayed = createHash("sha256");
      for (const path of archived) replayed.update(readFileSync(path, "utf8"));
      expect(replayed.digest("hex")).toBe(legacy.digest);
      // What startup now reads: the checkpoint and this generation's own records.
      const liveBytes = () =>
        recordFiles(fixture.journalPath).reduce((total, path) => total + statSync(path).size, 0);
      expect(liveBytes()).toBeLessThan(legacy.bytes / 20);

      const { owner, journal } = current;
      expect(journal.generation).toBe(3);
      expect(journal.draining).toBe(false);
      expect([...journal.installations()]).toEqual([install]);
      expect(journal.job("legacy-7")).toMatchObject({
        permitId: "legacy-permit-7",
        result: { state: "exited", ownerGeneration: 1 },
      });
      // The one reserved execution nobody observed finishing is interrupted, not forgotten.
      expect(journal.job("legacy-running")).toMatchObject({
        inputSeq: 2,
        result: { state: "interrupted", reason: "owner_restart_effects_unknown" },
      });

      // Converted history still answers: its original admission reads the recorded result,
      // and a newly signed permit for the same job neither reserves nor runs it again.
      const old = jobRequest("legacy-7", prompt);
      await owner.execute({
        type: "status",
        jobId: old.jobId,
        admission: fixture.admission(owner, old, "legacy-permit-7", 1),
      });
      await fixture.start(owner, old, "renewed-permit");
      expect(
        fixture.events.filter(
          (event) => event.type === "result" && event.result.jobId === old.jobId,
        ),
      ).toEqual([
        { type: "result", result: expect.objectContaining({ state: "exited" }) },
        { type: "result", result: expect.objectContaining({ state: "exited" }) },
      ]);
      expect(journal.permitConsumed("renewed-permit")).toBe(false);

      // And new work is admitted, run and settled.
      await fixture.start(owner, jobRequest("fresh-0"), "fresh-permit-0");
      expect(fixture.launchCount()).toBe(1);
      fixture.launches.shift()!();
      expect(await fixture.until(settledResult("fresh-0"))).toMatchObject({
        result: { state: "exited", exitCode: 0 },
      });
      await owner.shutdown();
      current = undefined;

      logs.length = 0;
      current = await fixture.open({ log });
      expect(logs).toEqual([]);
      expect(segmentDirectories(fixture.journalPath)).toEqual([segment!]);
      expect(recordFiles(segment!)).toHaveLength(legacy.records);
      expect(liveBytes()).toBeLessThan(legacy.bytes / 20);
      expect(current.journal.generation).toBe(4);
      expect(current.journal.job("fresh-0")?.result.state).toBe("exited");
      expect(verifyAt(fixture.journalPath)).toMatchObject({
        firstSequence: 1,
        segments: 1,
        checkpoints: 1,
        generation: 4,
      });
    } finally {
      await current?.owner.shutdown();
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("permits, job identities and input sequences stay refused across checkpoints and restarts", async () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-replay-"));
    const fixture = ownerFixture(root);
    let current: { owner: MachineJobOwner; journal: JobJournal } | undefined;
    try {
      const seed = openJournal(fixture.journalPath);
      seed.append({ kind: "install", command: install });
      seed.close();
      const segmentRecords = 6;
      current = await fixture.open({ segmentRecords });
      let { owner, journal } = current;
      const admitted = owner.identity.generation;
      const first = jobRequest("first");
      await fixture.start(owner, first, "first-permit");
      for (const [seq, requestId] of ["first-input-0", "first-input-1"].entries()) {
        await owner.execute({
          type: "input",
          jobId: first.jobId,
          requestId,
          seq,
          data: Buffer.from(requestId).toString("base64"),
          eof: seq === 1,
        });
        expect(fixture.events.at(-2)).toMatchObject({ type: "input_result", accepted: true });
      }
      fixture.launches.shift()!();
      await fixture.until(settledResult(first.jobId));
      // Enough further admissions to checkpoint and archive several segments.
      for (let index = 0; index < 5; index++) {
        const request = jobRequest(`filler-${index}`);
        await fixture.start(owner, request, `filler-permit-${index}`);
        fixture.launches.shift()!();
        await fixture.until(settledResult(request.jobId));
      }
      expect(segmentDirectories(fixture.journalPath).length).toBeGreaterThanOrEqual(3);
      expect(fixture.launchCount()).toBe(6);

      const refusals = async (generation: number) => {
        fixture.events.length = 0;
        // A consumed permit admits nothing else.
        const other = jobRequest(`other-${generation}`);
        await fixture.start(owner, other, "first-permit");
        expect(fixture.events).toContainEqual({
          type: "refusal",
          jobId: other.jobId,
          reason: "job_identity_changed",
        });
        expect(journal.job(other.jobId)).toBeUndefined();
        // A renewed permit for a recorded job replays its record, never its execution.
        await fixture.start(owner, first, `renewed-${generation}`);
        expect(fixture.events).toContainEqual({
          type: "result",
          result: expect.objectContaining({ jobId: first.jobId, state: "exited" }),
        });
        expect(journal.permitConsumed(`renewed-${generation}`)).toBe(false);
        // A consumed input request stays uncertain; the next sequence is never reissued.
        for (const [requestId, reason] of [
          ["first-input-1", "job_input_delivery_unknown"],
          ["another-input", "job_input_conflict_or_closed"],
        ]) {
          await owner.execute({
            type: "input",
            jobId: first.jobId,
            requestId: requestId!,
            seq: 1,
            data: "",
            eof: true,
          });
          expect(fixture.events.at(-1)).toMatchObject({
            type: "input_result",
            accepted: false,
            reason,
            nextInputSeq: 2,
          });
        }
        expect(fixture.launchCount()).toBe(6);
      };
      await refusals(admitted);

      await owner.shutdown();
      current = undefined;
      current = await fixture.open({ segmentRecords });
      ({ owner, journal } = current);
      expect(journal.generation).toBe(admitted + 1);
      expect(recordFiles(fixture.journalPath).length).toBeLessThanOrEqual(segmentRecords + 4);
      await refusals(admitted + 1);
      // The original admission still reads the recorded result, not an invented absence.
      fixture.events.length = 0;
      await owner.execute({
        type: "status",
        jobId: first.jobId,
        admission: fixture.admission(owner, first, "first-permit", admitted),
      });
      expect(fixture.events).toEqual([
        {
          type: "workload_empty",
          jobId: first.jobId,
          requestDigest: first.requestDigest,
          ownerId: owner.identity.ownerId,
          ownerGeneration: admitted,
        },
        { type: "result", result: expect.objectContaining({ state: "exited" }) },
        expect.objectContaining({ type: "input_state", nextInputSeq: 2, stdinClosed: true }),
      ]);
      await owner.shutdown();
      current = undefined;
      expect(verifyAt(fixture.journalPath)).toMatchObject({
        firstSequence: 1,
        generation: admitted + 1,
      });
    } finally {
      await current?.owner.shutdown();
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a failed append or rotation leaves no torn record, and the next one continues the chain", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-failure-"));
    const sync = HeldDirectory.prototype.sync;
    const failing = spyOn(HeldDirectory.prototype, "sync");
    try {
      const journal = openJournal(root, { segmentRecords: 4 });
      for (let index = 0; index < 3; index++) journal.append(rejection(journal, `job-${index}`));
      const full = recordFiles(root).length;
      // The next append rotates: its checkpoint part becomes durable, then the signed
      // checkpoint's own write fails after its file exists.
      let syncs = 0;
      failing.mockImplementation(function (this: HeldDirectory) {
        syncs += 1;
        if (syncs === 2) throw Object.assign(new Error("injected_io_failure"), { code: "EIO" });
        sync.call(this);
      });
      expect(() => journal.append(rejection(journal, "job-3"))).toThrow("injected_io_failure");
      failing.mockRestore();
      expect(recordFiles(root)).toHaveLength(full + 1);
      expect(readRecord(recordFiles(root).at(-1)!).body.kind).toBe("checkpoint_part");
      journal.append(rejection(journal, "job-3"));
      journal.close();
      const reopened = openJournal(root, { segmentRecords: 4 });
      expect([...reopened.jobs()].map((job) => job.jobId)).toEqual([
        "job-0",
        "job-1",
        "job-2",
        "job-3",
      ]);
      reopened.close();
      expect(verifyAt(root)).toMatchObject({ firstSequence: 1, checkpoints: 1, generation: 2 });
    } finally {
      failing.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an interrupted rotation completes at the next start", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-crash-"));
    try {
      const journal = openJournal(root, { segmentRecords: 8 });
      for (let index = 0; index < 20; index++) journal.append(rejection(journal, `job-${index}`));
      journal.close();
      // Crash after the checkpoint became durable, part way through moving its sealed records.
      const segments = segmentDirectories(root);
      const newest = segments.at(-1)!;
      for (const path of recordFiles(newest).slice(2))
        renameSync(path, join(root, path.slice(newest.length + 1)));
      // And a later crash while writing the next checkpoint, before its signature.
      const live = recordFiles(root);
      const tail = readRecord(live.at(-1)!);
      const dangling = canonicalJobJson({
        sequence: tail.sequence + 1,
        previous: digestOf(live.at(-1)!),
        body: { kind: "checkpoint_part", entries: [{ install }] },
      });
      writeFileSync(join(root, recordName(tail.sequence + 1)), dangling, { mode: 0o600 });

      const reopened = openJournal(root, { segmentRecords: 8 });
      expect(segmentDirectories(root)).toEqual(segments);
      expect(readRecord(recordFiles(root)[0]!).body.kind).toBe("checkpoint_part");
      expect([...reopened.jobs()]).toHaveLength(20);
      expect([...reopened.installations()]).toEqual([]);
      for (let index = 20; index < 40; index++)
        reopened.append(rejection(reopened, `job-${index}`));
      reopened.close();
      expect(verifyAt(root)).toMatchObject({ firstSequence: 1, generation: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tampering with a checkpoint refuses startup, and tampering with the archive fails verification", () => {
    const root = mkdtempSync(join(tmpdir(), "job-journal-tamper-"));
    const snapshot = mkdtempSync(join(tmpdir(), "job-journal-snapshot-"));
    try {
      const journal = openJournal(root, { segmentRecords: 8 });
      for (let index = 0; index < 20; index++) journal.append(rejection(journal, `job-${index}`));
      journal.close();
      const verified = verifyAt(root);
      expect(verified.checkpoints).toBeGreaterThanOrEqual(2);
      const files = [...segmentDirectories(root).flatMap(recordFiles), ...recordFiles(root)];
      const original = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));
      const restore = () => {
        for (const [path, text] of original) writeFileSync(path, text);
      };
      const live = recordFiles(root);
      const sealAt = live.findIndex((path) => readRecord(path).body.kind === "checkpoint");
      const chainBefore = (path: string) => readRecord(path).previous;
      const refused = (reason: string) => {
        expect(() => openJournal(root)).toThrow(reason);
        expect(() => verifyAt(root)).toThrow(reason);
      };

      // A rewritten checkpoint entry breaks the chain; a forger who relinks it lacks the key.
      const part = readRecord(live[0]!);
      part.body.entries![0]!.job!.result.state = "exited";
      writeFileSync(live[0]!, canonicalJobJson(part));
      refused("journal_corrupt");
      rechain(live, part.previous);
      refused("journal_checkpoint_signature_invalid");
      restore();

      // A checkpoint signed by any other key is refused even when perfectly linked.
      const seal = readRecord(live[sealAt]!);
      const unsigned = { ...seal.body };
      delete unsigned.signature;
      const forger = generateKeyPairSync("ed25519");
      seal.body.signature = sign(
        null,
        Buffer.from(
          canonicalJobJson({ sequence: seal.sequence, previous: seal.previous, body: unsigned }),
        ),
        forger.privateKey,
      ).toString("base64");
      writeFileSync(live[sealAt]!, canonicalJobJson(seal));
      rechain(live.slice(sealAt), seal.previous);
      refused("journal_checkpoint_signature_invalid");
      restore();

      // The archive is never read at startup; verification rereads all of it.
      const archived = segmentDirectories(root).flatMap(recordFiles);
      const target = archived[5]!;
      const record = readRecord(target);
      record.body.result!.reason = "forged";
      writeFileSync(target, canonicalJobJson(record));
      openJournal(root).close();
      restore();
      for (const path of recordFiles(root)) if (!original.has(path)) unlinkSync(path);
      writeFileSync(target, canonicalJobJson(record));
      expect(() => verifyAt(root)).toThrow("journal_corrupt");
      // Relinking the rest of that segment still contradicts the next checkpoint's signed head.
      const segment = recordFiles(segmentDirectories(root)[0]!);
      rechain(segment.slice(segment.indexOf(target)), chainBefore(target));
      expect(() => verifyAt(root)).toThrow("journal_corrupt");
      rechain(
        [...segmentDirectories(root).slice(1).flatMap(recordFiles), ...recordFiles(root)],
        digestOf(segment.at(-1)!),
      );
      expect(() => verifyAt(root)).toThrow("journal_checkpoint_corrupt");
      restore();
      // A missing archived record is a gap, not a shorter history.
      renameSync(target, join(snapshot, "moved"));
      expect(() => verifyAt(root)).toThrow("journal_gap");
      renameSync(join(snapshot, "moved"), target);
      expect(verifyAt(root)).toMatchObject({ checkpoints: verified.checkpoints });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(snapshot, { recursive: true, force: true });
    }
  });
});
