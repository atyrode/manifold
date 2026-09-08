import { expect, test } from "bun:test";
import {
  MachineArtifactSchema,
  MachineLocationSchema,
  MachineOperationSchema,
  JobOutputBindingSchema,
  ListJobRunsArgsSchema,
  ListJobRunsResultSchema,
  PublicJobRunSchema,
  PublicScheduleOccurrenceSchema,
  type PublicJob,
  type PublicScheduleOccurrence,
} from "../src/jobs.ts";

const location = { anchor: "config", components: ["vault"], revision: "r1", kind: "file" };
test("guest paths permit exact hidden files but never home-root or noncanonical paths", () => {
  expect(
    MachineLocationSchema.parse({ ...location, guestPath: "/home/job/.config/auth/vault.json" })
      .guestPath,
  ).toBe("/home/job/.config/auth/vault.json");
  for (const guestPath of [
    "/home/job",
    "/home/job/",
    "/home/job/../vault",
    "/home/job/a/../../vault",
    "/home/job/./vault",
    "/home/job//vault",
    "/home/job/a/",
    "/etc/vault",
    "/home/job/a\\b",
  ]) {
    expect(MachineLocationSchema.safeParse({ ...location, guestPath }).success).toBe(false);
  }
});

test("named resources admit hidden account directories without admitting traversal", () => {
  expect(
    MachineLocationSchema.safeParse({
      anchor: "home",
      components: [".omp", "agent", "sessions"],
      revision: "r1",
    }).success,
  ).toBe(true);
  for (const component of [".", "..", "../.omp", "/.omp", ".omp/agent", ".omp\\agent"]) {
    expect(
      MachineLocationSchema.safeParse({
        anchor: "home",
        components: [component],
        revision: "r1",
      }).success,
    ).toBe(false);
  }
});

const artifact = {
  url: "https://example.invalid/tool",
  sha256: "a".repeat(64),
  entrySha256: "b".repeat(64),
  format: "tar.gz",
  entry: ["main"],
  maxBytes: 4096,
  maxExpandedBytes: 8192,
  maxMembers: 8,
};
test("artifact executable bundles pin selected members and never admit URL credentials or raw companion files", () => {
  const files = { helper: { entry: ["bin", "helper"], sha256: "c".repeat(64) } };
  expect(MachineArtifactSchema.parse({ ...artifact, files }).files).toEqual(files);
  expect(MachineArtifactSchema.safeParse({ ...artifact, files, format: "raw" }).success).toBe(
    false,
  );
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      url: "https://user:secret@example.invalid/tool",
    }).success,
  ).toBe(false);
  expect(
    MachineArtifactSchema.safeParse({
      ...artifact,
      files: { helper: { entry: ["..", "tool"], sha256: "c".repeat(64) } },
    }).success,
  ).toBe(false);
});

test("owner-retained stdout and stderr cannot be caller-declared or rebound as filesystem outputs", () => {
  const operation = {
    argv: [],
    input: {},
    runtimeTools: ["custom-runner"],
    locations: [],
    network: "none",
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    stdin: false,
  };
  expect(MachineOperationSchema.parse({ ...operation, outputs: ["report"] }).outputs).toEqual([
    "report",
  ]);
  for (const name of ["stdout", "stderr"]) {
    expect(MachineOperationSchema.safeParse({ ...operation, outputs: [name] }).success).toBe(false);
    expect(
      JobOutputBindingSchema.safeParse({
        name,
        locationId: "sample.worker.data",
        components: ["output"],
      }).success,
    ).toBe(false);
  }
});

const occurrence: PublicScheduleOccurrence = {
  scheduleId: "schedule",
  revision: "schedule-revision",
  nominalAt: 100,
  jobId: "scheduled-job",
  machineId: "machine",
  pluginId: "sample.worker",
  operationId: "sample.worker.run",
  installationRevision: "retained-revision",
  artifactSha256: "a".repeat(64),
  state: "skipped",
  reason: "machine-offline",
};

test("run discovery bounds its public query and pagination without admitting authority overrides", () => {
  expect(ListJobRunsArgsSchema.parse({ machineId: "machine", limit: 100 }).limit).toBe(100);
  for (const args of [
    { machineId: "" },
    { machineId: "m".repeat(129) },
    { machineId: "machine", operationId: "" },
    { machineId: "machine", limit: 0 },
    { machineId: "machine", limit: 101 },
    { machineId: "machine", limit: 1.5 },
    { machineId: "machine", cursor: "" },
    { machineId: "machine", cursor: "c".repeat(2049) },
    { machineId: "machine", credential: { tokenId: "private" } },
    { machineId: "machine", pluginId: "other-plugin" },
  ])
    expect(ListJobRunsArgsSchema.safeParse(args).success).toBe(false);
  const run = { job: null, occurrence };
  expect(
    ListJobRunsResultSchema.parse({ runs: Array(100).fill(run), nextCursor: "opaque" }).nextCursor,
  ).toBe("opaque");
  expect(
    ListJobRunsResultSchema.safeParse({ runs: Array(101).fill(run), nextCursor: null }).success,
  ).toBe(false);
  expect(ListJobRunsResultSchema.safeParse({ runs: [], nextCursor: "" }).success).toBe(false);
});

test("occurrence-only runs expose honest skipped state and reject private persisted fields", () => {
  expect(PublicJobRunSchema.parse({ job: null, occurrence }).occurrence).toEqual(occurrence);
  expect(PublicJobRunSchema.safeParse({ job: null, occurrence: null }).success).toBe(false);
  for (const privateField of ["request", "input", "credential", "requestDigest", "permit"]) {
    expect(
      PublicScheduleOccurrenceSchema.safeParse({ ...occurrence, [privateField]: "private" })
        .success,
    ).toBe(false);
  }
  for (const invalid of [
    { nominalAt: -1 },
    { nominalAt: Number.MAX_SAFE_INTEGER + 1 },
    { state: "exited" },
    { reason: "r".repeat(2049) },
  ]) {
    expect(PublicScheduleOccurrenceSchema.safeParse({ ...occurrence, ...invalid }).success).toBe(
      false,
    );
  }
});

test("a run cannot pair job metadata with a different occurrence identity or immutable pin", () => {
  const job: PublicJob = {
    jobId: occurrence.jobId,
    machineId: occurrence.machineId,
    pluginId: occurrence.pluginId,
    operationId: occurrence.operationId,
    installationRevision: occurrence.installationRevision,
    artifactSha256: occurrence.artifactSha256,
    state: "queued",
    result: null,
    authority: {
      origin: { kind: "action", traceId: "trace" },
      requester: "principal",
      executor: null,
      decision: null,
    },
  };
  expect(PublicJobRunSchema.parse({ job, occurrence }).job).toEqual(job);
  for (const field of [
    "jobId",
    "machineId",
    "pluginId",
    "operationId",
    "installationRevision",
    "artifactSha256",
  ]) {
    expect(
      PublicJobRunSchema.safeParse({
        job,
        occurrence: {
          ...occurrence,
          [field]: field === "artifactSha256" ? "b".repeat(64) : "other",
        },
      }).success,
    ).toBe(false);
  }
});
