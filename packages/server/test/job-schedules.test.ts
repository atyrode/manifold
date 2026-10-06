import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJobJson, type JobRequest } from "@manifold/protocol";
import { openDatabase } from "../src/db.ts";
import { ServerStore } from "../src/stores.ts";
import {
  JobSchedules,
  type JobInvocationSpec,
  type JobScheduleSpec,
} from "../src/job-schedules.ts";
import {
  projectJobCredential,
  readAuthoritySnapshot,
  captureAuthoritySnapshot,
  restoreAuthoritySnapshot,
  type AuthoritySnapshot,
} from "../src/authority-snapshot.ts";
import { AuthService } from "../src/auth.ts";
import { FakeRuntime } from "./helpers.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function signed(overrides: Partial<JobRequest> = {}): JobRequest {
  const body = {
    jobId: "template",
    machineId: "machine",
    pluginId: "test.plugin",
    operationId: "test.plugin/run",
    installationRevision: "revision-1",
    artifactSha256: "a".repeat(64),
    input: {},
    limits: { timeoutMs: 100, memoryBytes: 1024, processes: 1, outputBytes: 100 },
    outputs: [],
    parent: null,
    credential: {
      principalId: "principal",
      tokenId: "token",
      grantId: null,
      caps: [],
      containerScope: null,
      expiresAt: 10000,
    },
    traceId: "trace",
    ...overrides,
  };
  delete body.requestDigest;
  return {
    ...body,
    requestDigest: createHash("sha256").update(canonicalJobJson(body)).digest("hex"),
  };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "job-schedules-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "hub.sqlite");
  let store = new ServerStore(openDatabase(path));
  // Enqueue models the durable job insert, not an in-memory delivery observation.
  store.db.exec("CREATE TABLE enqueued(job_id TEXT PRIMARY KEY, request TEXT NOT NULL)");
  cleanup.push(() => store.close());
  const callbacks = {
    reauthorize: (_request: JobRequest): string | null => null,
    isOnline: (_machine: string) => true,
    enqueue: (request: JobRequest) => {
      store.db
        .query("INSERT INTO enqueued VALUES(?,?)")
        .run(request.jobId, canonicalJobJson(request));
    },
  };
  return {
    get store() {
      return store;
    },
    get jobs() {
      return new JobSchedules(store);
    },
    callbacks,
    requests() {
      return store.db
        .query<{ request: string }, []>("SELECT request FROM enqueued ORDER BY rowid")
        .all()
        .map((row) => JSON.parse(row.request) as JobRequest);
    },
    restart() {
      store.close();
      store = new ServerStore(openDatabase(path));
    },
  };
}
function schedule(overrides: Partial<JobScheduleSpec> = {}): JobScheduleSpec {
  return {
    scheduleId: "schedule",
    revision: "one",
    request: signed(),
    firstNominalAt: 100,
    intervalMs: 100,
    deadlineMs: 50,
    expiresAt: 10000,
    offlinePolicy: "coalesce-one",
    ...overrides,
  };
}
function invocation(overrides: Partial<JobInvocationSpec> = {}): JobInvocationSpec {
  const parent = signed({ jobId: "parent" });
  const child = signed({
    jobId: "child",
    parent: { parentJobId: "parent", invocationId: "invoke-1" },
  });
  const target = {
    machineId: parent.machineId,
    pluginId: parent.pluginId,
    operationId: parent.operationId,
    installationRevision: parent.installationRevision,
    artifactSha256: parent.artifactSha256,
  };
  return {
    parent: { request: parent, state: "started", ownerId: "owner", ownerGeneration: 1 },
    host: { machineId: "machine", ownerId: "owner", ownerGeneration: 1 },
    child,
    edge: {
      caller: target,
      callee: target,
      resources: [],
      outputs: [],
      maxDepth: 2,
      maxConcurrency: 1,
      aggregate: { timeoutMs: 200, memoryBytes: 2048, processes: 2, outputBytes: 200 },
    },
    resources: [],
    now: 100,
    ...overrides,
  };
}

describe("durable job schedules", () => {
  test("restart deduplicates nominal identity and retains pinned credential and artifact", () => {
    const f = fixture();
    f.jobs.putSchedule(schedule());
    f.jobs.tick(110, f.callbacks);
    const first = f.requests()[0]!;
    f.restart();
    f.jobs.tick(120, f.callbacks);
    expect(f.requests()).toEqual([first]);
    expect(first.credential).toEqual(schedule().request.credential);
    expect(first.artifactSha256).toBe(schedule().request.artifactSha256);
    expect(() =>
      f.jobs.putSchedule(schedule({ request: signed({ artifactSha256: "b".repeat(64) }) })),
    ).toThrow("schedule-revision-conflict");
  });
  test("offline backlog coalesces once and expires without a late start", () => {
    const f = fixture();
    f.jobs.putSchedule(schedule());
    f.jobs.tick(110, { ...f.callbacks, isOnline: () => false });
    f.restart();
    f.jobs.tick(340, { ...f.callbacks, isOnline: () => false });
    f.jobs.tick(345, f.callbacks);
    expect(f.requests().map((request) => f.jobs.getOccurrence(request.jobId)?.nominal)).toEqual([
      300,
    ]);
    expect(f.jobs.startRefusal(f.requests()[0]!.jobId, 350)).toBe("schedule-deadline-expired");
    f.jobs.tick(450, f.callbacks);
    expect(f.requests()).toHaveLength(1);
  });
  test("skip never retries an offline occurrence and revocation disables future work", () => {
    const f = fixture();
    f.jobs.putSchedule(schedule({ offlinePolicy: "skip" }));
    f.jobs.tick(110, { ...f.callbacks, isOnline: () => false });
    f.jobs.tick(120, f.callbacks);
    expect(f.requests()).toEqual([]);
    f.jobs.tick(210, { ...f.callbacks, reauthorize: () => "token-revoked" });
    f.restart();
    f.jobs.tick(310, f.callbacks);
    expect(f.requests()).toEqual([]);
    expect(f.jobs.listSchedules()).toEqual([]);
  });
  test("replacement invalidates queued starts instead of retargeting", () => {
    const f = fixture();
    f.jobs.putSchedule(schedule());
    f.jobs.tick(110, f.callbacks);
    const first = f.requests()[0]!;
    f.jobs.putSchedule(
      schedule({ revision: "two", request: signed({ artifactSha256: "b".repeat(64) }) }),
    );
    expect(f.jobs.startRefusal(first.jobId, 120)).toBe("schedule-replaced");
    expect(f.jobs.getOccurrence(first.jobId)?.request).toBe(canonicalJobJson(first));
  });
  test("enqueue failure rolls occurrence reservation and cadence back together", () => {
    const f = fixture();
    f.jobs.putSchedule(schedule());
    expect(() =>
      f.jobs.tick(110, {
        ...f.callbacks,
        enqueue: (request) => {
          f.callbacks.enqueue(request);
          throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    expect(f.requests()).toEqual([]);
    f.restart();
    f.jobs.tick(110, f.callbacks);
    expect(f.requests().map((request) => f.jobs.getOccurrence(request.jobId)?.nominal)).toEqual([
      100,
    ]);
  });
});

describe("nested invocation reservations", () => {
  test("proof-bound parent and exact artifact/resource edge refuse before enqueue", () => {
    const f = fixture();
    const spec = invocation();
    expect(() =>
      f.jobs.reserveInvocation(
        { ...spec, host: { ...spec.host, ownerGeneration: 2 } },
        f.callbacks,
      ),
    ).toThrow("invocation-parent-not-host-bound");
    expect(() =>
      f.jobs.reserveInvocation(
        { ...spec, child: signed({ ...spec.child, artifactSha256: "b".repeat(64) }) },
        f.callbacks,
      ),
    ).toThrow("invocation-edge-mismatch");
    expect(() =>
      f.jobs.reserveInvocation(
        { ...spec, resources: [{ locationId: "private", revision: "1", access: "read" }] },
        f.callbacks,
      ),
    ).toThrow("invocation-edge-mismatch");
    expect(() =>
      f.jobs.reserveInvocation(spec, { ...f.callbacks, reauthorize: () => "grant-revoked" }),
    ).toThrow("grant-revoked");
    expect(f.requests()).toEqual([]);
  });
  test("restart dedupe, concurrent ceiling, and lifetime aggregate remain durable", () => {
    const f = fixture();
    const spec = invocation();
    expect(f.jobs.reserveInvocation(spec, f.callbacks)).toBe("reserved");
    f.restart();
    expect(f.jobs.reserveInvocation(spec, f.callbacks)).toBe("duplicate");
    const second = {
      ...spec,
      child: signed({
        jobId: "second",
        parent: { parentJobId: "parent", invocationId: "invoke-2" },
      }),
    };
    expect(() => f.jobs.reserveInvocation(second, f.callbacks)).toThrow(
      "invocation-depth-or-concurrency-limit",
    );
    f.jobs.finishInvocation("child");
    f.jobs.reserveInvocation(second, f.callbacks);
    f.jobs.finishInvocation("second");
    const third = {
      ...spec,
      child: signed({
        jobId: "third",
        parent: { parentJobId: "parent", invocationId: "invoke-3" },
      }),
    };
    expect(() => f.jobs.reserveInvocation(third, f.callbacks)).toThrow(
      "invocation-aggregate-limit",
    );
    expect(f.requests().map((request) => request.jobId)).toEqual(["child", "second"]);
  });
  test("a deeper edge cannot raise the root's durable depth ceiling", () => {
    const f = fixture();
    const first = invocation();
    first.edge.maxDepth = 1;
    first.edge.maxConcurrency = 10;
    f.jobs.reserveInvocation(first, f.callbacks);
    const nested = invocation({
      parent: { ...first.parent, request: first.child },
      child: signed({
        jobId: "grandchild",
        parent: { parentJobId: "child", invocationId: "next" },
      }),
      edge: { ...first.edge, maxDepth: 10 },
    });
    expect(() => f.jobs.reserveInvocation(nested, f.callbacks)).toThrow(
      "invocation-depth-or-concurrency-limit",
    );
    expect(f.requests().map((request) => request.jobId)).toEqual(["child"]);
  });
  test("a child's timeout budget is its parent's less every earlier child's, fixed on replay (#1064)", () => {
    const f = fixture();
    const spec = invocation();
    const parent = spec.parent.request;
    expect(f.jobs.childTimeoutBudget(parent, "invoke-1")).toBe(100);
    f.jobs.reserveInvocation(
      {
        ...spec,
        child: signed({ ...spec.child, limits: { ...spec.child.limits, timeoutMs: 30 } }),
      },
      f.callbacks,
    );
    // A settled child keeps its share: the owner never returns budget to the parent.
    f.jobs.finishInvocation("child");
    expect(f.jobs.childTimeoutBudget(parent, "invoke-2")).toBe(70);
    f.jobs.reserveInvocation(
      {
        ...spec,
        child: signed({
          jobId: "second",
          parent: { parentJobId: "parent", invocationId: "invoke-2" },
          limits: { ...spec.child.limits, timeoutMs: 70 },
        }),
      },
      f.callbacks,
    );
    f.restart();
    expect(f.jobs.childTimeoutBudget(parent, "invoke-3")).toBe(0);
    // A replay keeps its own recorded timeout, whatever later siblings took.
    expect(f.jobs.childTimeoutBudget(parent, "invoke-1")).toBe(30);
    expect(f.jobs.childTimeoutBudget(signed({ jobId: "other" }), "invoke-3")).toBe(100);
  });
  test("failed enqueue rolls back aggregate and invocation identity", () => {
    const f = fixture();
    const spec = invocation();
    expect(() =>
      f.jobs.reserveInvocation(spec, {
        ...f.callbacks,
        enqueue: (request) => {
          f.callbacks.enqueue(request);
          throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    expect(f.jobs.reserveInvocation(spec, f.callbacks)).toBe("reserved");
    expect(f.requests().map((request) => request.jobId)).toEqual(["child"]);
  });
  test("a parent output prefix attenuates fresh exact leases without permitting sibling roots", () => {
    const f = fixture();
    const spec = invocation();
    spec.edge.outputs = [
      {
        name: "capture",
        locationId: "parent.data",
        components: ["captures"],
        maxSuffixComponents: 2,
      },
    ];
    const binding = {
      name: "capture",
      locationId: "parent.data",
      components: ["captures", "attempt-1", "producer"],
    };
    const child = signed({ ...spec.child, outputs: [binding] });
    for (const output of [
      { ...binding, locationId: "callee.private" },
      { ...binding, components: ["captures-other", "attempt-1"] },
      { ...binding, components: ["captures"] },
      { ...binding, components: ["captures", "attempt-1", "producer", "escape"] },
    ])
      expect(() =>
        f.jobs.reserveInvocation(
          { ...spec, child: signed({ ...child, outputs: [output] }) },
          f.callbacks,
        ),
      ).toThrow("invocation-output-mismatch");
    expect(f.requests()).toEqual([]);
    expect(f.jobs.reserveInvocation({ ...spec, child }, f.callbacks)).toBe("reserved");
    expect(f.requests()[0]?.outputs).toEqual([binding]);
    f.restart();
    expect(f.jobs.reserveInvocation({ ...spec, child }, f.callbacks)).toBe("duplicate");
  });
  test("zero suffix authority remains exact and cannot add a descendant component", () => {
    const f = fixture();
    const spec = invocation();
    const binding = {
      name: "capture",
      locationId: "parent.data",
      components: ["captures", "fixed"],
    };
    spec.edge.outputs = [{ ...binding, maxSuffixComponents: 0 }];
    expect(() =>
      f.jobs.reserveInvocation(
        {
          ...spec,
          child: signed({
            ...spec.child,
            outputs: [{ ...binding, components: [...binding.components, "extra"] }],
          }),
        },
        f.callbacks,
      ),
    ).toThrow("invocation-output-mismatch");
    expect(
      f.jobs.reserveInvocation(
        { ...spec, child: signed({ ...spec.child, outputs: [binding] }) },
        f.callbacks,
      ),
    ).toBe("reserved");
  });
});

test("schedule restart reauthorizes faithful scope and a live deny prevents future occurrences", () => {
  const f = fixture();
  const runtime = new FakeRuntime();
  let auth = new AuthService(f.store, "schedule-owner", runtime);
  const owner = auth.authenticate("schedule-owner");
  const machineId = auth.enrollMachine("scheduled-account", owner).machine.id;
  const target = `manifold://machine/${machineId}`;
  const minted = auth.mintTokenV2(
    {
      principal: { name: "scoped-schedule", kind: "human" },
      scope: [{ target, reach: "subtree", caps: ["machines:run"] }],
      expiresAt: runtime.now() + 60_000,
    },
    owner,
  );
  const caller = auth.authenticate(minted.token);
  const snapshot = captureAuthoritySnapshot(auth, caller);
  const spec = schedule({
    authoritySnapshot: snapshot,
    request: signed({ machineId, credential: projectJobCredential(snapshot.credential) }),
  });
  const callbacks = {
    ...f.callbacks,
    reauthorize: (_request: JobRequest, authoritySnapshot?: AuthoritySnapshot) => {
      const current =
        authoritySnapshot === undefined ? null : restoreAuthoritySnapshot(auth, authoritySnapshot);
      return current !== null && auth.allowsNode(current, "machines:run", target, "subtree")
        ? null
        : "scope-withdrawn";
    },
  };
  f.jobs.putSchedule(spec);
  f.jobs.tick(110, { ...callbacks, isOnline: () => false });
  f.restart();
  auth = new AuthService(f.store, "schedule-owner", runtime);
  f.jobs.tick(120, callbacks);
  const first = f.requests()[0]!;
  expect(f.jobs.getOccurrence(first.jobId)?.state).toBe("enqueued");
  expect(first.credential).not.toHaveProperty("authorityScope");
  auth.grant(
    {
      principal: { kind: "principal", id: caller.principal.id },
      node: target,
      reach: "subtree",
      caps: ["machines:run"],
      effect: "deny",
    },
    auth.authenticate("schedule-owner"),
  );
  f.jobs.tick(210, callbacks);
  expect(f.jobs.listSchedules()).toEqual([]);
  expect(f.requests()).toEqual([first]);
});

test("invocation persistence retains full parent scope and refuses a child that drops it", () => {
  const f = fixture();
  const base = invocation();
  const snapshot: AuthoritySnapshot = {
    credential: {
      ...base.parent.request.credential,
      authorityScope: [
        { target: "manifold://machine/machine", reach: "subtree", caps: ["jobs:input"] },
      ],
    },
  };
  const parent = { ...base.parent, authoritySnapshot: snapshot };
  const spec = { ...base, parent, authoritySnapshot: snapshot };
  expect(() => f.jobs.reserveInvocation({ ...base, parent }, f.callbacks)).toThrow(
    "invocation-credential-ceiling",
  );
  expect(f.jobs.reserveInvocation(spec, f.callbacks)).toBe("reserved");
  f.restart();
  expect(readAuthoritySnapshot(f.store, "invocation", spec.child.jobId)).toEqual(snapshot);
  expect(f.jobs.reserveInvocation(spec, f.callbacks)).toBe("duplicate");
});
