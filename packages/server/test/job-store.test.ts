import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJobJson, JobRequestSchema, type JobRequest } from "@manifold/protocol";
import { openDatabase } from "../src/db.ts";
import { JOB_SCHEDULE_SCHEMA_SQL } from "../src/job-schedules.ts";
import { JobStore } from "../src/job-store.ts";
import { ServerStore } from "../src/stores.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const filter = { pluginId: "sample.worker", machineId: "machine" };
function request(jobId: string, overrides: Partial<JobRequest> = {}): JobRequest {
  return JobRequestSchema.parse({
    ...filter,
    jobId,
    operationId: "sample.worker.run",
    installationRevision: "retained-revision",
    artifactSha256: "a".repeat(64),
    input: { private: "never-public" },
    limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
    outputs: [],
    parent: null,
    credential: {
      principalId: "principal",
      tokenId: "private-token",
      grantId: null,
      caps: [],
      containerScope: null,
    },
    traceId: "trace",
    requestDigest: "b".repeat(64),
    ...overrides,
  });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "job-runs-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.sqlite");
  let store = new ServerStore(openDatabase(path));
  store.db.exec(JOB_SCHEDULE_SCHEMA_SQL);
  cleanup.push(() => store.close());
  let jobs = new JobStore(store, () => {});
  return {
    get store() {
      return store;
    },
    get jobs() {
      return jobs;
    },
    reopen() {
      store.close();
      store = new ServerStore(openDatabase(path));
      jobs = new JobStore(store, () => {});
    },
    occurrence(value: JobRequest, nominal: number, state = "pending") {
      store.db
        .query(
          "INSERT INTO job_schedule_occurrences(schedule_id,revision,nominal,job_id,request,deadline,state,reason) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          `schedule-${value.jobId}`,
          "schedule-revision",
          nominal,
          value.jobId,
          canonicalJobJson(value),
          nominal + 1000,
          state,
          state === "skipped" ? "machine-offline" : null,
        );
    },
  };
}

test("native input cursor and unknown attempts survive restart without permitting replay or rewind", () => {
  const f = fixture();
  const job = f.jobs.reserve(request("stdin"), 1);
  f.jobs.inputCursor("stdin", 4, false);
  expect(f.jobs.reserveInput(job, "attempt", 4, "input-actor", "input-trace")).toBe(true);
  f.jobs.inputResult("stdin", "attempt", "unknown", "job_input_delivery_unknown");
  f.reopen();
  expect(f.jobs.reserveInput(f.jobs.get("stdin")!, "attempt", 4, "input-actor", "input-trace")).toBe(false);
  expect(f.jobs.get("stdin")).toMatchObject({ nextInputSeq: 4, stdinClosed: false, state: "queued" });
  f.jobs.inputCursor("stdin", 5, true);
  f.jobs.inputCursor("stdin", 4, false);
  f.reopen();
  expect(f.jobs.get("stdin")).toMatchObject({ nextInputSeq: 5, stdinClosed: true, state: "queued" });
  expect(f.store.db.query("SELECT * FROM machine_job_inputs").get()).toEqual({
    job_id: "stdin", request_id: "attempt", seq: 4, actor: "input-actor",
    trace_id: "input-trace", decision_id: null, state: "unknown", reason: "job_input_delivery_unknown",
  });
});

test("durable discovery de-duplicates scheduled jobs and continues strictly through tied timestamps", () => {
  const f = fixture();
  f.jobs.reserve(request("newest"), 101);
  f.jobs.reserve(request("z-direct"), 100);
  f.jobs.reserve(request("a-direct"), 100);
  f.occurrence(request("z-scheduled"), 100, "enqueued");
  f.jobs.reserve(request("z-scheduled"), 999);
  f.occurrence(request("a-scheduled"), 100, "skipped");
  f.occurrence(request("older"), 99, "refused");
  f.reopen();

  const first = f.jobs.runCandidates(filter, 2);
  expect(first.map((run) => run.position)).toEqual([
    { at: 101, source: 0, jobId: "newest" },
    { at: 100, source: 1, jobId: "z-scheduled" },
  ]);
  expect(first[1]?.job?.request.jobId).toBe("z-scheduled");
  expect(first[1]?.occurrence?.state).toBe("enqueued");
  const second = f.jobs.runCandidates({ ...filter, before: first[1]!.position }, 2);
  expect(second.map((run) => run.position)).toEqual([
    { at: 100, source: 1, jobId: "a-scheduled" },
    { at: 100, source: 0, jobId: "z-direct" },
  ]);
  expect(second[0]?.job).toBeNull();
  expect(second[0]?.occurrence).toMatchObject({ state: "skipped", reason: "machine-offline" });
  const third = f.jobs.runCandidates({ ...filter, before: second[1]!.position }, 2);
  expect(third.map((run) => run.position.jobId)).toEqual(["a-direct", "older"]);
  expect(f.jobs.runCandidates({ ...filter, before: third[1]!.position }, 2)).toEqual([]);
});

test("candidate filters use exact durable targets for direct jobs and every occurrence state", () => {
  const f = fixture();
  f.jobs.reserve(request("direct"), 10);
  for (const [index, state] of ["pending", "enqueued", "skipped", "refused"].entries()) {
    f.occurrence(request(state), 20 + index, state);
  }
  for (const [index, overrides] of [
    { machineId: "machine-other" },
    { pluginId: "sample.worker-other" },
    { operationId: "sample.worker.run-other" },
  ].entries()) {
    f.jobs.reserve(request(`foreign-direct-${index}`, overrides), 100);
    f.occurrence(request(`foreign-occurrence-${index}`, overrides), 100);
  }
  const runs = f.jobs.runCandidates({ ...filter, operationId: "sample.worker.run" }, 100);
  expect(runs.map((run) => run.position.jobId)).toEqual([
    "refused",
    "skipped",
    "enqueued",
    "pending",
    "direct",
  ]);
  expect(runs.map((run) => run.request.installationRevision)).toEqual(
    Array(5).fill("retained-revision"),
  );
  expect(f.jobs.runCandidates(filter, 100).map((run) => run.position.jobId)).toEqual([
    "foreign-occurrence-2",
    "foreign-direct-2",
    "refused",
    "skipped",
    "enqueued",
    "pending",
    "direct",
  ]);
});

test("candidate reads enforce their hard bound and parse stored requests before returning records", () => {
  const f = fixture();
  for (const limit of [0, -1, 1.5, 258, NaN, Infinity]) {
    expect(() => f.jobs.runCandidates(filter, limit)).toThrow("invalid-job-run-limit");
  }
  for (let index = 0; index < 258; index++) f.jobs.reserve(request(`job-${index}`), index);
  expect(f.jobs.runCandidates(filter, 1).map((run) => run.position.jobId)).toEqual(["job-257"]);
  const bounded = f.jobs.runCandidates(filter, 257);
  expect(bounded.length).toBe(257);
  expect(bounded.at(-1)?.position.jobId).toBe("job-1");
  f.occurrence(request("corrupt"), 1000);
  f.store.db
    .query("UPDATE job_schedule_occurrences SET request=? WHERE job_id=?")
    .run(JSON.stringify({ ...request("corrupt"), credential: "invalid" }), "corrupt");
  expect(() => f.jobs.runCandidates(filter, 1)).toThrow();
});
