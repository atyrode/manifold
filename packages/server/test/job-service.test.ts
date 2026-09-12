import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatManifoldUri,
  PluginBundleSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  JobCommandSchema,
  InstanceServiceDescriptionSchema,
  type ServicePolicy,
  type Cap,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type JobRequest,
  type MachineHalf,
  type JobFollowUpdate,
} from "../../protocol/src/jobs.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService, type JobRecord, type SettledJobDelivery } from "../src/job-service.ts";
import { jobContext } from "../src/job-doors.ts";
import { ServerStore } from "../src/stores.ts";
import { FakeRuntime } from "./helpers.ts";

const key = "9".repeat(64);
const pluginId = "sample.worker";
const operationId = `${pluginId}.run`;
const hash = "a".repeat(64);
const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
const machine: MachineHalf = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/worker",
      sha256: hash,
      entrySha256: hash,
      format: "raw",
      entry: ["worker"],
      maxBytes: 4096,
      maxExpandedBytes: 4096,
      maxMembers: 1,
    },
  },
  operations: {
    [operationId]: {
      argv: [{ input: "value" }],
      input: { value: { type: "string", required: true, maxLength: 32 } },
      runtimeTools: [],
      locations: [],
      outputs: [],
      network: "none",
      limits,
      stdin: true,
    },
  },
  locations: {},
};
interface Fixture {
  store: ServerStore;
  auth: AuthService;
  root: AuthContext;
  runtime: FakeRuntime;
  service: JobService;
  machineId: string;
  commands: JobCommand[];
  owner: JobOwner;
  privateKey: KeyObject;
  channel: {
    machineId: string;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
}
function fixture(path = ":memory:", manifest: MachineHalf = machine): Fixture {
  const store = new ServerStore(openDatabase(path));
  const runtime = new FakeRuntime();
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const machineId = auth.enrollMachine("worker", root).machine.id;
  const service = new JobService(store, auth, runtime);
  service.setLifecycleRecorder((record) => store.appendTrace(record));
  service.setManifestResolver((id) => (id === pluginId ? manifest : null));
  const commands: JobCommand[] = [];
  const channel = {
    machineId,
    send: (message: { type: "job_command"; command: JobCommand }) => {
      commands.push(message.command);
      return true;
    },
  };
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "test-owner",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "b".repeat(64),
  };
  service.install(root, {
    machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    machine: manifest,
  });
  return {
    store,
    auth,
    root,
    runtime,
    service,
    machineId,
    commands,
    channel,
    owner,
    privateKey: pair.privateKey,
  };
}
function prove(f: Fixture, wrongNonce = false): void {
  f.service.online(f.channel, f.owner, "epoch");
  const challenge = f.commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = {
    nonce: wrongNonce ? "wrong" : challenge.nonce,
    serverEpoch: challenge.serverEpoch,
    machineId: f.machineId,
    owner: f.owner,
  };
  f.service.event(f.channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), f.privateKey).toString("base64"),
  });
  f.service.event(f.channel, {
    type: "installed",
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
  });
}
function consent(f: Fixture, cap: Cap, enabled = true): void {
  f.service.consent(f.root, {
    machineId: f.machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId }),
    cap,
    enabled,
  });
}
function execute(f: Fixture, jobId = "job", value = "safe") {
  return f.service.execute(f.root, pluginId, "trace-1", {
    jobId,
    machineId: f.machineId,
    operationId,
    input: { value },
    outputs: [],
  });
}

async function instanceFixture(path = ":memory:") {
  const provider: MachineHalf = {
    ...machine,
    operations: {
      [operationId]: { ...machine.operations[operationId]!, providesService: true },
    },
  };
  const f = fixture(path, provider);
  consent(f, "machines:run");
  consent(f, "jobs:cancel");
  prove(f);
  const policy: ServicePolicy = {
    serviceId: `${pluginId}.broker`,
    revision: "one",
    maxConcurrent: 1,
    runtime: {
      scope: "instance",
      pluginId,
      operationId,
      installationRevision: "r1",
      artifactSha256: hash,
      resourceBindingDigest: createHash("sha256").update(canonicalJobJson(null)).digest("hex"),
      input: { value: { literal: "safe" } },
    },
    operations: {
      inspect: {
        method: "GET",
        readable: true,
        path: "/inspect",
        input: {},
        query: {},
        body: [],
        timeoutMs: 1000,
        maxRequestBytes: 1024,
        maxResponseBytes: 4096,
        maxResultBytes: 2048,
        response: { kind: "projected-json", fields: [["state"]], maxArrayItems: 16 },
      },
    },
  };
  const configured = await f.service.configureInstanceService(f.root, {
    serviceId: policy.serviceId,
    expectedRevision: null,
    machineId: f.machineId,
    policy,
    enabled: true,
  });
  const start = f.commands.find((command) => command.type === "start");
  if (!start || !configured.configuration) throw new Error("instance runtime was not admitted");
  return { f, policy, provider, start, revision: configured.configuration.revision };
}

test("disabled services remain stopping through disconnect and terminal results until fenced empty confirmation", async () => {
  const { f, policy, start, revision } = await instanceFixture();
  try {
    const disabled = await f.service.configureInstanceService(f.root, {
      serviceId: policy.serviceId,
      expectedRevision: revision,
      policy,
      enabled: false,
    });
    expect(InstanceServiceDescriptionSchema.parse(disabled).state).toBe("stopping");
    expect(disabled.configuration?.enabled).toBe(false);
    f.service.offline(f.channel);
    expect(
      f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }),
    ).toMatchObject({
      connected: false,
      state: "stopping",
    });
    prove(f);
    f.service.event(f.channel, {
      type: "result",
      result: {
        jobId: start.request.jobId,
        requestDigest: start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "exited",
        exitCode: 0,
        reason: null,
        startedAt: f.runtime.now(),
        finishedAt: f.runtime.now(),
        usage: null,
        limits: start.request.limits,
        outputs: [],
      },
    });
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopping",
    );
    const proof = {
      type: "workload_empty" as const,
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    };
    f.service.event(f.channel, { ...proof, requestDigest: "f".repeat(64) });
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopping",
    );
    f.service.event(f.channel, proof);
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopped",
    );
  } finally {
    f.store.close();
  }
});

test("retiring an instance preserves admitted descendants but refuses new descendants and still permits force escalation", async () => {
  const { f, policy, start, revision } = await instanceFixture();
  try {
    consent(f, "operations:invoke");
    const target = {
      machineId: f.machineId,
      pluginId,
      operationId,
      installationRevision: "r1",
      artifactSha256: hash,
    };
    const edge = {
      caller: target,
      callee: target,
      resources: [],
      outputs: [],
      maxDepth: 3,
      maxConcurrency: 3,
      aggregate: { timeoutMs: 3000, memoryBytes: 3145728, processes: 3, outputBytes: 196608 },
    };
    f.service.setInvocationEdge(f.root, { edge, enabled: true });
    f.service.jobs.state(start.request.jobId, "started");
    // Recover already-authorized invocation history. This exercises retirement of
    // retained descendants independently of the service principal's current mint shape.
    const base: Omit<JobRequest, "requestDigest"> & { requestDigest?: string } = {
      ...start.request,
    };
    delete base.service;
    delete base.requestDigest;
    const credential = f.auth.credentialReference(f.root);
    for (const jobId of ["admitted-child", "queued-child"]) {
      const unsigned: Omit<JobRequest, "requestDigest"> = {
        ...base,
        jobId,
        parent: { parentJobId: start.request.jobId, invocationId: jobId },
        credential: { ...credential, caps: [...credential.caps] },
        limits,
      };
      const request: JobRequest = {
        ...unsigned,
        requestDigest: createHash("sha256").update(canonicalJobJson(unsigned)).digest("hex"),
      };
      f.service.jobs.reserve(request, f.runtime.now());
      f.store.db
        .query(
          "INSERT INTO job_invocation_reservations(parent_job_id,invocation_id,job_id,root_job_id,depth,request,edge,active) VALUES(?,?,?,?,1,?,?,1)",
        )
        .run(
          start.request.jobId,
          jobId,
          jobId,
          start.request.jobId,
          canonicalJobJson(request),
          canonicalJobJson(edge),
        );
      if (jobId === "admitted-child")
        f.service.jobs.state(jobId, "started", {
          ...start.permit,
          jobId,
          requestDigest: request.requestDigest,
        });
    }
    await f.service.configureInstanceService(f.root, {
      serviceId: policy.serviceId,
      expectedRevision: revision,
      policy,
      enabled: false,
    });
    f.service.event(f.channel, {
      type: "refusal",
      jobId: start.request.jobId,
      reason: "resource_owner_unavailable",
    });
    f.service.tick();
    expect(f.service.jobs.get("admitted-child")?.state).toBe("started");
    expect(f.service.jobs.cancellation("admitted-child")).toBeNull();
    expect(f.service.jobs.get("queued-child")?.state).toBe("refused");
    expect(
      f.commands.some(
        (command) =>
          (command.type === "cancel" || command.type === "retire") &&
          command.jobId === "admitted-child",
      ),
    ).toBe(false);
    f.service.event(f.channel, {
      type: "invocation",
      parentJobId: "admitted-child",
      invocationId: "late-grandchild",
      operationId,
      input: { value: "safe" },
      outputs: [],
    });
    expect(f.commands.at(-1)).toMatchObject({
      type: "invocation_reply",
      invocationId: "late-grandchild",
      jobId: null,
    });
    f.service.cancel(f.root, {
      kind: "job",
      machineId: f.machineId,
      operationId,
      jobId: start.request.jobId,
    });
    expect(f.service.jobs.cancellation("admitted-child")?.mode).toBe("cancel");
    expect(
      f.commands.some((command) => command.type === "cancel" && command.jobId === "admitted-child"),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});

test("disabling a never-admitted service retires it before credential-revocation callbacks", async () => {
  const { f, policy } = await instanceFixture();
  try {
    f.store.setMachineDraining(f.machineId, true);
    const queuedPolicy = { ...policy, serviceId: `${pluginId}.queued` };
    const configured = await f.service.configureInstanceService(f.root, {
      serviceId: queuedPolicy.serviceId,
      expectedRevision: null,
      machineId: f.machineId,
      policy: queuedPolicy,
      enabled: true,
    });
    const queued = f.service.jobs.instanceServiceJobs(queuedPolicy.serviceId)[0]!;
    expect(queued.state).toBe("queued");
    expect(queued.permit).toBeNull();
    await f.service.configureInstanceService(f.root, {
      serviceId: queuedPolicy.serviceId,
      expectedRevision: configured.configuration!.revision,
      policy: queuedPolicy,
      enabled: false,
    });
    expect(f.service.jobs.get(queued.request.jobId)?.state).toBe("cancelled");
    expect(f.service.jobs.cancellation(queued.request.jobId)?.mode).toBe("retire");
    expect(f.auth.restoreCredential(queued.request.credential)).toBeNull();
    expect(f.service.jobs.instanceServiceJobs(queuedPolicy.serviceId)).toEqual([]);
    expect(
      f.commands.some(
        (command) => command.type === "start" && command.request.jobId === queued.request.jobId,
      ),
    ).toBe(false);
  } finally {
    f.store.close();
  }
});

test("replacement replays retirement across restart and waits for confirmed old workload exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-retirement-"));
  const path = join(dir, "hub.sqlite");
  const { f, policy, provider, start, revision } = await instanceFixture(path);
  try {
    await f.service.configureInstanceService(f.root, {
      serviceId: policy.serviceId,
      expectedRevision: revision,
      policy: { ...policy, revision: "two" },
      enabled: true,
    });
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopping",
    );
    const stops = () =>
      f.commands.filter(
        (command) =>
          (command.type === "cancel" || command.type === "retire") &&
          command.jobId === start.request.jobId,
      );
    expect(stops().some((command) => command.type === "retire")).toBe(true);
    expect(stops().some((command) => command.type === "cancel")).toBe(false);
    expect(f.auth.restoreCredential(start.request.credential)).not.toBeNull();
    const retirement = stops().at(-1)!;
    expect(JobCommandSchema.safeParse(retirement).success).toBe(true);
    const ordinaryRequest = { ...start.request };
    delete ordinaryRequest.service;
    expect(
      JobCommandSchema.safeParse({
        ...retirement,
        admission: { request: ordinaryRequest, permit: start.permit },
      }).success,
    ).toBe(false);
    expect(f.commands.filter((command) => command.type === "start")).toHaveLength(1);

    f.service.offline(f.channel);
    f.store.close();
    f.store = new ServerStore(openDatabase(path));
    f.auth = new AuthService(f.store, key, f.runtime);
    f.root = f.auth.authenticate(key);
    f.service = new JobService(f.store, f.auth, f.runtime);
    f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
    f.service.setManifestResolver((id) => (id === pluginId ? provider : null));
    f.commands.length = 0;
    prove(f);
    f.service.tick();
    expect(stops().some((command) => command.type === "retire")).toBe(true);
    expect(stops().some((command) => command.type === "cancel")).toBe(false);
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopping",
    );

    f.service.event(f.channel, {
      type: "refusal",
      jobId: start.request.jobId,
      reason: "resource_owner_unavailable",
    });
    f.service.tick();
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    const proof = {
      type: "workload_empty" as const,
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    };
    f.service.event(f.channel, { ...proof, ownerGeneration: f.owner.generation + 1 });
    f.service.tick();
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    f.service.event(f.channel, proof);
    expect(f.auth.restoreCredential(start.request.credential)).toBeNull();
    f.service.tick();
    const replacement = f.commands.filter((command) => command.type === "start");
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.request.jobId).not.toBe(start.request.jobId);
    expect(f.auth.restoreCredential(replacement[0]!.request.credential)).not.toBeNull();
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "starting",
    );
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["explicit", "consent", "credential", "executor"] as const)(
  "disabled service retirement escalates durably for %s cancellation",
  async (cause) => {
    const { f, policy, start, revision } = await instanceFixture();
    try {
      await f.service.configureInstanceService(f.root, {
        serviceId: policy.serviceId,
        expectedRevision: revision,
        policy,
        enabled: false,
      });
      expect(f.service.jobs.cancellation(start.request.jobId)?.mode).toBe("retire");
      if (cause === "executor") {
        f.service.event(f.channel, {
          type: "refusal",
          jobId: start.request.jobId,
          reason: "resource_owner_unavailable",
        });
        f.service.event(f.channel, {
          type: "workload_empty",
          jobId: start.request.jobId,
          requestDigest: start.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation + 1,
        });
        f.service.tick();
        expect(f.service.jobs.get(start.request.jobId)).toMatchObject({
          state: "interrupted",
          ownerClosed: false,
        });
        expect(f.service.jobs.cancellation(start.request.jobId)?.mode).toBe("retire");
        expect(f.auth.restoreCredential(start.request.credential)).not.toBeNull();
      }
      if (cause === "explicit")
        f.service.cancel(f.root, {
          kind: "job",
          machineId: f.machineId,
          operationId,
          jobId: start.request.jobId,
        });
      else if (cause === "credential")
        f.auth.revokePrincipal(start.request.credential.principalId, f.root);
      else if (cause === "executor") {
        const machine = f.store.getMachine(f.machineId)!;
        f.auth.revokePrincipal(f.store.getToken(machine.tokenId)!.principalId, f.root);
        expect(f.service.jobs.cancellation(start.request.jobId)).toEqual({
          reason: "executor_revoked",
          mode: "cancel",
        });
        expect(f.auth.restoreCredential(start.request.credential)).not.toBeNull();
      } else consent(f, "machines:run", false);
      expect(f.service.jobs.cancellation(start.request.jobId)?.mode).toBe("cancel");
      f.service.offline(f.channel);
      f.commands.length = 0;
      prove(f);
      const stops = f.commands.filter(
        (command) =>
          (command.type === "cancel" || command.type === "retire") &&
          command.jobId === start.request.jobId,
      );
      expect(stops.some((command) => command.type === "cancel")).toBe(true);
      expect(stops.some((command) => command.type === "retire")).toBe(false);
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  },
);

test("executor revocation does not revive a retiring service after fenced empty confirmation", async () => {
  const { f, policy, start, revision } = await instanceFixture();
  try {
    await f.service.configureInstanceService(f.root, {
      serviceId: policy.serviceId,
      expectedRevision: revision,
      policy,
      enabled: false,
    });
    f.service.event(f.channel, {
      type: "refusal",
      jobId: start.request.jobId,
      reason: "resource_owner_unavailable",
    });
    f.service.event(f.channel, {
      type: "workload_empty",
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    });
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "stopped",
    );
    f.commands.length = 0;
    const machine = f.store.getMachine(f.machineId)!;
    f.auth.revokePrincipal(f.store.getToken(machine.tokenId)!.principalId, f.root);
    f.service.offline(f.channel);
    prove(f);
    expect(f.service.jobs.get(start.request.jobId)).toMatchObject({
      state: "interrupted",
      ownerClosed: true,
    });
    expect(f.service.jobs.cancellation(start.request.jobId)?.mode).toBe("retire");
    expect(
      f.commands.filter(
        (command) =>
          (command.type === "cancel" || command.type === "retire" || command.type === "status") &&
          command.jobId === start.request.jobId,
      ),
    ).toEqual([]);
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("polling a queued job cannot interrupt its later admitted start", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    consent(f, "jobs:read");
    execute(f);
    f.service.online(f.channel, f.owner, "epoch");
    const challenge = f.commands.at(-1);
    if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
    const body = {
      nonce: challenge.nonce,
      serverEpoch: challenge.serverEpoch,
      machineId: f.machineId,
      owner: f.owner,
    };
    f.service.event(f.channel, {
      type: "owner_proof",
      ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), f.privateKey).toString("base64"),
    });
    const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
    expect(f.service.status(f.root, node).state).toBe("queued");
    const beforeAdmission = f.commands.filter((command) => command.type === "status");
    f.service.event(f.channel, {
      type: "installed",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
    });
    const admitted = f.service.jobs.get("job")!;
    if (!admitted.permit) throw new Error("fixture did not commit a native start");
    // The owner did not know a queued job; its reply may arrive after installation completes.
    for (const command of beforeAdmission) {
      f.service.event(f.channel, {
        type: "refusal",
        jobId: command.jobId,
        reason: "unknown_job",
      });
    }
    f.service.event(f.channel, {
      type: "state",
      jobId: admitted.request.jobId,
      requestDigest: admitted.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    expect(f.service.status(f.root, node).state).toBe("started");
  } finally {
    f.store.close();
  }
});

test("uncertain service completion holds its lifetime until a fenced empty-tree proof arrives", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    prove(f);
    const admitted = execute(f);
    if (!admitted.permit) throw new Error("fixture did not commit a native start");
    const serviceId = `${pluginId}.broker`;
    const unsigned: Omit<typeof admitted.request, "requestDigest"> & { requestDigest?: string } = {
      ...admitted.request,
      jobId: "service-producer",
      service: { serviceId, revision: "service-r1", policySha256: hash },
    };
    delete unsigned.requestDigest;
    const request = {
      ...unsigned,
      requestDigest: createHash("sha256").update(canonicalJobJson(unsigned)).digest("hex"),
    };
    f.service.jobs.reserve(request, f.runtime.now());
    f.service.jobs.state(request.jobId, "start-committed", {
      ...admitted.permit,
      jobId: request.jobId,
      requestDigest: request.requestDigest,
    });
    f.service.event(f.channel, {
      type: "refusal",
      jobId: request.jobId,
      reason: "resource_owner_unavailable",
    });
    expect(f.service.jobs.get(request.jobId)?.state).toBe("interrupted");
    const outstanding = () =>
      f.service.jobs.instanceServiceJobs(serviceId).map((job) => job.request.jobId);
    expect(outstanding()).toEqual([request.jobId]);
    const proof = {
      type: "workload_empty" as const,
      jobId: request.jobId,
      requestDigest: request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    };
    f.service.event(f.channel, { ...proof, ownerGeneration: f.owner.generation + 1 });
    expect(outstanding()).toEqual([request.jobId]);
    f.service.event(f.channel, proof);
    expect(outstanding()).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("same-generation reconnect recovers a lost started notification without reviving closed work", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    prove(f);
    const job = execute(f);
    const result = {
      jobId: job.request.jobId,
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started" as const,
      exitCode: null,
      reason: null,
      startedAt: f.runtime.now(),
      finishedAt: null,
      usage: null,
      limits: job.request.limits,
      outputs: [],
    };
    f.service.offline(f.channel);
    prove(f);
    f.service.event(f.channel, {
      type: "result",
      result: { ...result, requestDigest: "f".repeat(64) },
    });
    f.service.event(f.channel, { type: "result", result: { ...result, ownerGeneration: 0 } });
    expect(f.service.jobs.get(job.request.jobId)?.state).toBe("start-committed");
    f.service.event(f.channel, { type: "result", result });
    expect(f.service.jobs.get(job.request.jobId)?.state).toBe("started");
    f.service.event(f.channel, { type: "result", result: { ...result, state: "start-committed" } });
    expect(f.service.jobs.get(job.request.jobId)?.state).toBe("started");
    f.service.event(f.channel, {
      type: "result",
      result: { ...result, state: "exited", exitCode: 0, finishedAt: f.runtime.now() },
    });
    f.service.event(f.channel, { type: "result", result });
    expect(f.service.jobs.get(job.request.jobId)?.state).toBe("exited");

    const closed = execute(f, "closed-before-started");
    f.service.event(f.channel, {
      type: "workload_empty",
      jobId: closed.request.jobId,
      requestDigest: closed.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: 1,
    });
    f.service.event(f.channel, {
      type: "result",
      result: {
        ...result,
        jobId: closed.request.jobId,
        requestDigest: closed.request.requestDigest,
      },
    });
    expect(f.service.jobs.get(closed.request.jobId)?.state).toBe("start-committed");
    expect(f.service.jobs.get(closed.request.jobId)?.ownerClosed).toBe(true);

    const priorGeneration = execute(f, "old-generation");
    f.service.offline(f.channel);
    f.owner.generation++;
    prove(f);
    f.service.event(f.channel, {
      type: "result",
      result: {
        ...result,
        jobId: priorGeneration.request.jobId,
        requestDigest: priorGeneration.request.requestDigest,
      },
    });
    expect(f.service.jobs.get(priorGeneration.request.jobId)?.state).toBe("start-committed");
  } finally {
    f.store.close();
  }
});

function inputFixture() {
  const f = fixture();
  consent(f, "machines:run");
  consent(f, "jobs:input");
  consent(f, "jobs:read");
  prove(f);
  const job = execute(f);
  const node = {
    kind: "job" as const,
    machineId: f.machineId,
    operationId,
    jobId: job.request.jobId,
  };
  const identity = {
    jobId: job.request.jobId,
    requestDigest: job.request.requestDigest,
    ownerId: f.owner.ownerId,
    ownerGeneration: f.owner.generation,
  };
  f.service.event(f.channel, { type: "state", ...identity, state: "started" });
  const cursor = (seq: number, closed = false) =>
    f.service.event(f.channel, {
      type: "input_state",
      ...identity,
      nextInputSeq: seq,
      stdinClosed: closed,
    });
  cursor(0);
  const input = (requestId: string, seq = 0) =>
    jobContext(() => f.service, f.root, pluginId, 42).input({
      node,
      requestId,
      seq,
      data: Buffer.from("private-callback").toString("base64"),
      eof: false,
    });
  const authorize = (requestId: string, seq = 0) =>
    f.service.event(f.channel, {
      type: "input_authorize",
      jobId: node.jobId,
      requestId,
      seq,
      parentJobId: null,
    });
  const receipt = (requestId: string, accepted: boolean, seq = 0) =>
    f.service.event(f.channel, {
      type: "input_result",
      jobId: node.jobId,
      requestId,
      seq,
      accepted,
      reason: accepted ? null : "job_input_conflict_or_closed",
      nextInputSeq: accepted ? seq + 1 : seq,
      stdinClosed: false,
    });
  return { ...f, node, input, authorize, receipt, cursor };
}

test("stdin accepts only an owner receipt; stale concurrent input cannot poison a running job", async () => {
  const f = inputFixture();
  try {
    let accepted = false;
    const first = f.input("first").then((result) => {
      accepted = true;
      return result;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBeNull();
    await expect(f.input("stale")).rejects.toThrow("job_input_pending");
    f.receipt("unrelated", false);
    expect(f.service.status(f.root, f.node).state).toBe("started");
    f.authorize("first");
    expect(f.commands.at(-1)).toMatchObject({ type: "input_authorized", allowed: true });
    f.receipt("first", true);
    f.cursor(1);
    expect(await first).toEqual({ accepted: true });
    await expect(f.input("stale-again")).rejects.toThrow("job_input_sequence_conflict");
    expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBe(1);
    expect(f.commands.some((command) => command.type === "cancel")).toBe(false);
    const attempt = f.store.db.query("SELECT * FROM machine_job_inputs").get();
    expect(attempt).toMatchObject({
      request_id: "first",
      actor: f.root.principal.id,
      trace_id: "42",
      state: "accepted",
    });
    expect(JSON.stringify(attempt)).not.toContain("private-callback");
    expect(JSON.stringify(attempt)).not.toContain(
      Buffer.from("private-callback").toString("base64"),
    );
  } finally {
    f.store.close();
  }
});

test.each(["disconnect", "false-send", "throw-send"] as const)(
  "stdin %s leaves an unknown receipt and never replays after reconciliation",
  async (failure) => {
    const f = inputFixture();
    try {
      if (failure !== "disconnect")
        f.channel.send = () => {
          if (failure === "throw-send") throw new Error("private transport detail");
          return false;
        };
      const pending = f.input("uncertain");
      if (failure === "disconnect") f.service.offline(f.channel);
      await expect(pending).rejects.toThrow("job_input_delivery_unknown");
      expect(f.store.db.query("SELECT state FROM machine_job_inputs").get()).toEqual({
        state: "unknown",
      });
      f.channel.send = ({ command }) => {
        f.commands.push(command);
        return true;
      };
      prove(f);
      expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBeNull();
      f.cursor(0); // The owner, not a transport failure, can establish this cursor.
      await expect(f.input("uncertain")).rejects.toThrow("job_input_request_replayed");
      expect(f.commands.filter((command) => command.type === "input")).toHaveLength(
        failure === "disconnect" ? 1 : 0,
      );
      const fresh = f.input("fresh");
      f.authorize("fresh");
      f.receipt("fresh", true);
      f.cursor(1);
      await fresh;
      f.cursor(0); // A late older snapshot cannot rewind consumed native input.
      expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBe(1);
    } finally {
      f.store.close();
    }
  },
);

test("a lost stdin acknowledgment times out without acceptance or automatic replay", async () => {
  const f = inputFixture();
  try {
    const pending = f.input("lost-ack");
    f.authorize("lost-ack");
    await expect(pending).rejects.toThrow("job_input_delivery_unknown");
    expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBeNull();
    f.cursor(1);
    expect(f.service.publicJob(f.service.status(f.root, f.node)).nextInputSeq).toBe(1);
    expect(f.commands.filter((command) => command.type === "input")).toHaveLength(1);
    expect(f.store.db.query("SELECT state FROM machine_job_inputs").get()).toEqual({
      state: "unknown",
    });
    expect(f.service.jobs.get(f.node.jobId)?.state).toBe("started");
  } finally {
    f.store.close();
  }
}, 15000);

test("stdin rechecks current caller and original run authority before writing and acknowledging", async () => {
  for (const phase of ["before-write", "after-write", "original"] as const) {
    const f = inputFixture();
    try {
      const pending = f.input(phase);
      if (phase === "after-write") f.authorize(phase);
      consent(f, phase === "original" ? "machines:run" : "jobs:input", false);
      if (phase !== "after-write") {
        f.authorize(phase);
        expect(f.commands.at(-1)).toMatchObject({ type: "input_authorized", allowed: false });
      }
      f.receipt(phase, phase === "after-write");
      await expect(pending).rejects.toThrow();
      expect(f.service.jobs.get(f.node.jobId)?.state).toBe("started");
    } finally {
      f.store.close();
    }
  }
});

test("stdin rejects disconnected, unproved, not-started and closed streams without dispatch", async () => {
  for (const state of ["offline", "unproved", "starting", "closed"] as const) {
    const f = inputFixture();
    try {
      if (state === "offline") f.service.offline(f.channel);
      if (state === "unproved") f.service.online(f.channel, f.owner, "new-epoch");
      if (state === "starting") f.service.jobs.state(f.node.jobId, "start-committed");
      if (state === "closed") f.cursor(0, true);
      await expect(f.input(state)).rejects.toThrow();
      expect(f.commands.some((command) => command.type === "input")).toBe(false);
    } finally {
      f.store.close();
    }
  }
});

test("authenticated owner receives only selected deduplicated machine members; substituted sources cannot replace the revision", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("private worker bytes");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const bundled: MachineHalf = {
      ...machine,
      artifacts: {
        "linux-x64": {
          ...machine.artifacts["linux-x64"]!,
          url: undefined,
          bundleFile: "worker",
          sha256,
          entrySha256: sha256,
        },
      },
    };
    const tool = { ...bundled.artifacts["linux-x64"]!, bundleFile: "engine" };
    bundled.tools = {
      engine: { "linux-x64": tool, "linux-arm64": { ...tool, bundleFile: "other-platform" } },
      duplicate: { "linux-x64": tool },
      primaryAlias: { "linux-x64": bundled.artifacts["linux-x64"]! },
    };
    const bundle = PluginBundleSchema.parse({
      format: 1,
      manifest: {
        id: pluginId,
        version: "1.0.0",
        title: "Worker",
        description: "Private worker",
        capabilities: [],
        contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        entry: { web: "web.js" },
        machine: bundled,
      },
      files: {
        "web.js": Buffer.from("export {};").toString("base64"),
        worker: bytes.toString("base64"),
        engine: bytes.toString("base64"),
        "other-platform": bytes.toString("base64"),
      },
    });
    f.service.setManifestResolver(() => bundled);
    f.service.setBundleResolver(() => bundle);
    f.service.install(f.root, {
      machineId: f.machineId,
      pluginId,
      installationRevision: "bundled",
      artifactSha256: sha256,
      machine: bundled,
    });
    expect(f.commands).toEqual([]);
    prove(f);
    const command = f.commands.find((command) => command.type === "install");
    if (command?.type !== "install") throw new Error("owner did not receive installation");
    expect(command.installationRevision).toBe("bundled");
    expect(command.artifactSha256).toBe(sha256);
    expect(command.artifact?.bundleFile).toBe("worker");
    expect(Buffer.from(command.artifact!.data, "base64")).toEqual(bytes);
    expect(command.toolArtifacts).toEqual({ engine: bytes.toString("base64") });
    const priorCommands = f.commands.length;
    for (const source of [
      null,
      {
        ...bundle,
        files: { ...bundle.files, worker: Buffer.from("substitution").toString("base64") },
      },
      {
        ...bundle,
        files: { ...bundle.files, engine: Buffer.from("substitution").toString("base64") },
      },
    ]) {
      f.service.setBundleResolver(() => source);
      expect(() =>
        f.service.install(f.root, {
          machineId: f.machineId,
          pluginId,
          installationRevision: "substituted",
          artifactSha256: sha256,
          machine: bundled,
        }),
      ).toThrow();
      expect(f.service.jobs.installation(f.machineId, pluginId)?.revision).toBe("bundled");
      expect(f.commands.length).toBe(priorCommands);
    }
    f.service.setBundleResolver(() => null);
    f.service.offline(f.channel);
    f.commands.length = 0;
    prove(f);
    const unavailable = f.commands.find((command) => command.type === "install");
    if (unavailable?.type !== "install") throw new Error("missing pinned acquisition attempt");
    expect(unavailable.installationRevision).toBe("bundled");
    expect(unavailable.artifactSha256).toBe(sha256);
    expect(unavailable.artifact).toBeUndefined();
    expect(f.commands.some((command) => command.type === "drain")).toBe(true);
  } finally {
    f.store.close();
  }
});

test("bound terminal admission requires current spawn authority, exact pins and the proved native host", () => {
  const f = fixture();
  try {
    const containerId = "terminal-home";
    f.store.createContainer({
      id: containerId,
      name: "terminal",
      discipline: "composition",
      createdAt: f.runtime.now(),
    });
    const spawnTrace = (actor: AuthContext) =>
      f.store.appendTrace({
        actor: actor.principal.id,
        authority: "terminals:spawn",
        door: "core.terminals.open",
        containerId,
        session: null,
        ts: f.runtime.now(),
        outcome: "ok",
        targets: [],
        payload: {},
      });
    let traceId = spawnTrace(f.root);
    const runtime = {
      pluginId,
      operationId,
      installationRevision: "r1",
      artifactSha256: hash,
      resourceBindingDigest: createHash("sha256").update("null").digest("hex"),
      input: { value: "safe" },
    };
    const binding = {
      terminalId: "native-terminal",
      terminalHostId: "native-host",
      containerId: "new-solo-home",
    };
    const forged = {
      jobId: "forged",
      machineId: f.machineId,
      operationId,
      input: runtime.input,
      outputs: [],
      terminal: binding,
    };
    expect(() => f.service.execute(f.root, pluginId, "trace", forged)).toThrow(
      "native_terminal_admission_required",
    );
    consent(f, "machines:run");
    prove(f);
    expect(() => f.service.admitTerminal(f.root, runtime, f.machineId, binding, traceId)).toThrow();
    f.owner.terminalHostId = "native-host";
    prove(f);
    expect(() =>
      f.service.admitTerminal(
        f.root,
        { ...runtime, installationRevision: "stale" },
        f.machineId,
        binding,
        traceId,
      ),
    ).toThrow();
    expect(() =>
      f.service.admitTerminal(
        f.root,
        runtime,
        f.machineId,
        { ...binding, terminalHostId: "other-host" },
        traceId,
      ),
    ).toThrow();
    const token = f.auth.mintToken(
      {
        principal: { name: "terminal-opener", kind: "agent" },
        caps: ["machines:run", "terminals:spawn"],
      },
      f.root,
    );
    const original = f.auth.authenticate(token.token);
    traceId = spawnTrace(original);
    const first = f.service.admitTerminal(original, runtime, f.machineId, binding, traceId);
    // Admission returns a one-use command to the terminal broker, never a second job-channel start.
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    f.service.tick();
    expect(f.commands.filter((command) => command.type === "cancel")).toEqual([]);
    f.service.cancelTerminal(binding.terminalId);
    expect(f.commands.at(-1)).toMatchObject({ type: "cancel", jobId: first.request.jobId });
    const revoked = f.service.admitTerminal(
      original,
      runtime,
      f.machineId,
      { ...binding, terminalId: "revoked-terminal" },
      traceId,
    );
    f.auth.grant(
      {
        principal: { kind: "principal", id: original.principal.id },
        node: formatManifoldUri({ kind: "container", containerId }),
        caps: ["terminals:spawn"],
        effect: "deny",
        reach: "node",
      },
      f.root,
    );
    f.service.tick();
    expect(
      f.commands.some(
        (command) => command.type === "cancel" && command.jobId === revoked.request.jobId,
      ),
    ).toBe(true);
    // Reusing the original authenticated context cannot outrun current grant revocation.
    expect(() =>
      f.service.admitTerminal(
        original,
        runtime,
        f.machineId,
        { ...binding, terminalId: "denied" },
        traceId,
      ),
    ).toThrow();
    consent(f, "machines:run", false);
    traceId = spawnTrace(f.root);
    expect(() =>
      f.service.admitTerminal(
        f.root,
        runtime,
        f.machineId,
        { ...binding, terminalId: "no-consent" },
        traceId,
      ),
    ).toThrow();
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
  } finally {
    f.store.close();
  }
});
describe("retained job discovery", () => {
  test("bounded pages omit unreadable runs and recheck current authority", () => {
    const f = fixture();
    try {
      consent(f, "jobs:read");
      execute(f, "visible");
      for (let index = 0; index < 256; index++) {
        f.runtime.time++;
        execute(f, `hidden-private-reference-${index}`);
      }
      const token = f.auth.mintToken(
        { principal: { name: "run-reader", kind: "agent" }, caps: ["jobs:read"] },
        f.root,
      );
      const reader = f.auth.authenticate(token.token);
      f.auth.grant(
        {
          principal: { kind: "principal", id: reader.principal.id },
          node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId }),
          caps: ["jobs:read"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      f.auth.grant(
        {
          principal: { kind: "principal", id: reader.principal.id },
          node: formatManifoldUri({
            kind: "job",
            machineId: f.machineId,
            operationId,
            jobId: "visible",
          }),
          caps: ["jobs:read"],
          effect: "allow",
          reach: "node",
        },
        f.root,
      );
      const consumer = jobContext(() => f.service, reader, pluginId, 1);
      const query = { machineId: f.machineId, operationId, limit: 1 };
      const first = consumer.listRuns(query);
      expect(first.runs).toEqual([]);
      if (first.nextCursor === null) throw new Error("bounded scan lost its continuation");
      expect(
        Buffer.from(first.nextCursor, "base64url").includes(
          Buffer.from("hidden-private-reference"),
        ),
      ).toBe(false);
      const next = consumer.listRuns({ ...query, cursor: first.nextCursor });
      expect(next.runs.map((run) => run.job?.jobId)).toEqual(["visible"]);
      expect(next.nextCursor).toBeNull();
      expect(() =>
        consumer.listRuns({ ...query, operationId: "other", cursor: first.nextCursor! }),
      ).toThrow("invalid_job_run_cursor_refresh_required");
      const corrupt = `${first.nextCursor[0] === "A" ? "B" : "A"}${first.nextCursor.slice(1)}`;
      expect(() => consumer.listRuns({ ...query, cursor: corrupt })).toThrow(
        "invalid_job_run_cursor_refresh_required",
      );
      expect(() => f.service.listRuns(reader, pluginId, query, "another.plugin")).toThrow();
      f.auth.revokePrincipal(reader.principal.id, f.root);
      expect(() => consumer.listRuns({ ...query, cursor: first.nextCursor! })).toThrow();
    } finally {
      f.store.close();
    }
  });

  test("an offline occurrence is discoverable without a fabricated job and only after commit", () => {
    const f = fixture();
    try {
      for (const cap of ["machines:run", "operations:invoke", "jobs:read"] as const)
        consent(f, cap);
      const heard: string[] = [];
      f.service.setChangeNotifier({
        run: (node) => {
          const run = f.service
            .listRuns(f.root, pluginId, { machineId: f.machineId })
            .runs.find((row) => row.occurrence?.jobId === node.jobId);
          heard.push(run?.occurrence?.state ?? "missing");
        },
        access: () => heard.push("access"),
      });
      f.service.schedule(f.root, pluginId, "trace", {
        jobId: "template",
        machineId: f.machineId,
        operationId,
        input: { value: "private-input" },
        outputs: [],
        scheduleId: "refresh",
        revision: "first",
        firstNominalAt: 0,
        intervalMs: 100,
        deadlineMs: 50,
        expiresAt: 1000,
        offlinePolicy: "skip",
      });
      expect(() =>
        f.store.transaction(() => {
          f.service.tick();
          expect(heard).toEqual([]);
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(heard).toEqual([]);
      expect(f.service.listRuns(f.root, pluginId, { machineId: f.machineId }).runs).toEqual([]);
      f.service.tick();
      expect(heard).toEqual(["skipped"]);
      const result = f.service.listRuns(f.root, pluginId, { machineId: f.machineId });
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]).toMatchObject({
        job: null,
        occurrence: {
          scheduleId: "refresh",
          state: "skipped",
          nominalAt: 0,
          installationRevision: "r1",
        },
      });
      expect(JSON.stringify(result)).not.toContain("private-input");
      const occurrence = result.runs[0]!.occurrence!;
      expect(() =>
        f.service.status(f.root, {
          kind: "job",
          machineId: f.machineId,
          operationId,
          jobId: occurrence.jobId,
        }),
      ).toThrow("job_not_started");
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  });
});

describe("job lifecycle audit and inspection", () => {
  const lifecycle = (f: Fixture, jobId: string) =>
    f.store
      .listEvents({ type: "trace", limit: 100 })
      .map((row) => ({ row, payload: JSON.parse(row.payload) }))
      .filter(({ payload }) => payload.jobId === jobId && payload.jobLifecycle)
      .reverse();
  const origin = (f: Fixture, door = "sample.worker.run") =>
    String(
      f.store.appendTrace({
        actor: f.root.principal.id,
        authority: "root",
        door,
        containerId: null,
        session: "session-7",
        ts: f.runtime.now(),
        payload: {},
        outcome: null,
        targets: [],
      }),
    );

  test("zero-start refusal and proved execution retain exact authority without payload bytes", () => {
    const f = fixture();
    try {
      const traceId = origin(f);
      const run = (jobId: string) =>
        f.service.execute(f.root, pluginId, traceId, {
          jobId,
          machineId: f.machineId,
          operationId,
          input: { value: "secret-prompt" },
          outputs: [],
        });
      prove(f);
      const denied = run("schedule-not-an-origin");
      expect(denied.state).toBe("refused");
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      const refusal = lifecycle(f, denied.request.jobId);
      expect(refusal.map(({ payload }) => payload.jobLifecycle)).toEqual(["refused"]);
      expect(refusal[0]!.payload).toMatchObject({
        origin: { kind: "action", traceId },
        requester: f.root.principal.id,
        executor: null,
        decision: { grants: [{ allowed: false, authorizer: f.root.principal.id }] },
      });
      consent(f, "machines:run");
      const job = run("real-run");
      const permit = job.permit!;
      f.service.event(f.channel, {
        type: "state",
        jobId: "real-run",
        state: "started",
        requestDigest: job.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
      });
      f.service.event(f.channel, {
        type: "output",
        requestId: "real-run",
        jobId: "real-run",
        outputId: "stdout",
        seq: 1,
        data: Buffer.from("secret-stdout").toString("base64"),
        eof: false,
      });
      f.service.event(f.channel, {
        type: "result",
        result: {
          jobId: "real-run",
          requestDigest: job.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "exited",
          exitCode: 3,
          reason: "secret-stderr",
          startedAt: 0,
          finishedAt: 1,
          usage: null,
          limits,
          outputs: [],
        },
      });
      const rows = lifecycle(f, "real-run");
      expect(rows.map(({ payload }) => payload.jobLifecycle)).toEqual([
        "admitted",
        "start-committed",
        "started",
        "result",
      ]);
      for (const { row, payload } of rows) {
        expect(row).toMatchObject({
          door: "sample.worker.run",
          session: "session-7",
          principalId: f.root.principal.id,
        });
        expect(payload).toMatchObject({
          parentTrace: traceId,
          originTraceAvailable: true,
          executor: { machineId: f.machineId, ownerId: f.owner.ownerId, ownerGeneration: 1 },
          decision: {
            decisionId: permit.decisionId,
            policyRevision: permit.policyRevision,
            grants: [{ allowed: true, authorizer: f.root.principal.id }],
          },
        });
        expect(payload.decision.consents[0].revision).toBe(
          f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents[0]!.revision,
        );
      }
      expect(rows.at(-1)!.payload.exitCode).toBe(3);
      const audit = JSON.stringify(f.store.listEvents({ type: "trace", limit: 100 }));
      for (const secret of [
        "secret-prompt",
        "secret-stdout",
        "secret-stderr",
        Buffer.from("secret-stdout").toString("base64"),
        key,
      ])
        expect(audit).not.toContain(secret);
    } finally {
      f.store.close();
    }
  });

  test("deferred and invocation origins survive loss of their dispatch row", () => {
    const f = fixture();
    try {
      for (const cap of ["machines:run", "operations:invoke"] as const) consent(f, cap);
      prove(f);
      const traceId = origin(f, "sample.worker.schedule");
      f.service.schedule(f.root, pluginId, traceId, {
        jobId: "template",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        scheduleId: "periodic",
        revision: "r1",
        firstNominalAt: f.runtime.now(),
        intervalMs: 100,
        deadlineMs: 50,
        expiresAt: f.runtime.now() + 1000,
        offlinePolicy: "skip",
      });
      f.store.db.query("DELETE FROM events WHERE id=?").run(traceId);
      f.service.tick();
      const scheduled = f.service.jobs.active()[0]!;
      expect(lifecycle(f, scheduled.request.jobId)[0]!.payload.origin).toEqual({
        kind: "schedule",
        door: "sample.worker.schedule",
        traceId,
        scheduleId: "periodic",
        revision: "r1",
        nominalAt: f.runtime.now(),
      });
      expect(lifecycle(f, scheduled.request.jobId)[0]!.row.door).toBe("sample.worker.schedule");
      f.service.event(f.channel, {
        type: "state",
        jobId: scheduled.request.jobId,
        state: "started",
        requestDigest: scheduled.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: 1,
      });
      const target = {
        machineId: f.machineId,
        pluginId,
        operationId,
        installationRevision: "r1",
        artifactSha256: hash,
      };
      f.service.setInvocationEdge(f.root, {
        enabled: true,
        edge: {
          caller: target,
          callee: target,
          resources: [],
          outputs: [],
          maxDepth: 2,
          maxConcurrency: 2,
          aggregate: { timeoutMs: 2000, memoryBytes: 2097152, processes: 2, outputBytes: 131072 },
        },
      });
      f.service.event(f.channel, {
        type: "invocation",
        parentJobId: scheduled.request.jobId,
        invocationId: "child",
        operationId,
        input: { value: "safe" },
        outputs: [],
      });
      const child = f.service.jobs.active().find((job) => job.request.parent !== null)!;
      expect(lifecycle(f, child.request.jobId)[0]!.payload.origin).toEqual({
        kind: "invocation",
        door: "sample.worker.schedule",
        traceId,
        parentJobId: scheduled.request.jobId,
        invocationId: "child",
      });
      expect(lifecycle(f, child.request.jobId)[0]!.row.door).toBe("sample.worker.schedule");
    } finally {
      f.store.close();
    }
  });

  test("runtime candidates follow exact installed service policies without approving an edge", () => {
    const f = fixture();
    try {
      const calleePlugin = "sample.runtime";
      const calleeOperation = `${calleePlugin}.serve`;
      const locationId = `${calleePlugin}.data`;
      const runtimeMachine: MachineHalf = {
        ...machine,
        locations: {
          [locationId]: { anchor: "data", components: ["runtime"], revision: "location-r1" },
        },
        operations: {
          [calleeOperation]: {
            ...machine.operations[operationId]!,
            providesService: true,
            locations: [{ locationId, access: "read" }],
          },
        },
      };
      const policy = {
        serviceId: "sample.service",
        revision: "service-r1",
        maxConcurrent: 1,
        runtime: {
          pluginId: calleePlugin,
          operationId: calleeOperation,
          installationRevision: "callee-r1",
          artifactSha256: hash,
          resourceBindingDigest: createHash("sha256").update(canonicalJobJson(null)).digest("hex"),
          input: { value: { literal: "serve" } },
        },
        operations: {
          inspect: {
            kind: "http-proxy" as const,
            method: "GET" as const,
            path: "/",
            request: { kind: "none" as const },
            response: {
              kind: "stream" as const,
              disclosure: "full" as const,
              contentTypes: ["application/json" as const],
              headers: [],
            },
            timeoutMs: 1000,
            maxRequestBytes: 1024,
            maxResponseBytes: 4096,
          },
        },
      };
      const policySha256 = createHash("sha256").update(canonicalJobJson(policy)).digest("hex");
      const callerMachine: MachineHalf = {
        ...machine,
        operations: {
          [operationId]: {
            ...machine.operations[operationId]!,
            services: [
              { serviceId: policy.serviceId, revision: policy.revision, operationIds: ["inspect"] },
            ],
          },
        },
      };
      f.service.setManifestResolver((id) =>
        id === pluginId ? callerMachine : id === calleePlugin ? runtimeMachine : null,
      );
      f.service.install(f.root, {
        machineId: f.machineId,
        pluginId: calleePlugin,
        installationRevision: "callee-r1",
        artifactSha256: hash,
        machine: runtimeMachine,
      });
      expect(
        f.service
          .readServiceConfiguration(f.root, { machineId: f.machineId })
          .runtimeCandidates.map((candidate) => candidate.runtime),
      ).toEqual([
        {
          pluginId: calleePlugin,
          operationId: calleeOperation,
          installationRevision: "callee-r1",
          artifactSha256: hash,
          resourceBindingDigest: policy.runtime.resourceBindingDigest,
        },
      ]);
      expect(() =>
        jobContext(() => f.service, f.root, pluginId, 1).describe({
          machineId: f.machineId,
          pluginId: calleePlugin,
        }),
      ).toThrow();
      f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: null,
        policies: [policy],
      });
      f.owner.resources = {
        tools: {},
        anchors: {},
        services: { [policy.serviceId]: policySha256 },
        serviceDefinitions: {
          [policy.serviceId]: { revision: policy.revision, operationIds: ["inspect"] },
        },
      };
      prove(f);
      f.service.install(f.root, {
        machineId: f.machineId,
        pluginId,
        installationRevision: "caller-r2",
        artifactSha256: hash,
        machine: callerMachine,
        resourceBindings: {
          tools: {},
          anchors: {},
          services: { [policy.serviceId]: policySha256 },
        },
      });
      const args = { machineId: f.machineId, pluginId };
      const inspected = f.service.inspectInvocations(f.root, args);
      expect(inspected.edges).toEqual([]);
      expect(inspected.unavailable).toEqual([]);
      expect(inspected.candidates).toEqual([
        {
          serviceId: policy.serviceId,
          revision: policy.revision,
          operationIds: ["inspect"],
          policySha256,
          caller: {
            machineId: f.machineId,
            pluginId,
            operationId,
            installationRevision: "caller-r2",
            artifactSha256: hash,
          },
          callee: {
            machineId: f.machineId,
            pluginId: calleePlugin,
            operationId: calleeOperation,
            installationRevision: "callee-r1",
            artifactSha256: hash,
          },
          resources: [{ locationId, access: "read", revision: "location-r1" }],
          locations: runtimeMachine.locations,
          callerLimits: limits,
          calleeLimits: limits,
          outputNames: [],
          outputLocations: {},
        },
      ]);
      const candidate = inspected.candidates[0]!;
      f.service.setInvocationEdge(f.root, {
        enabled: true,
        edge: {
          caller: candidate.caller,
          callee: candidate.callee,
          resources: candidate.resources,
          outputs: [],
          maxDepth: 1,
          maxConcurrency: 1,
          aggregate: limits,
        },
      });
      f.service.install(f.root, {
        machineId: f.machineId,
        pluginId: calleePlugin,
        installationRevision: "callee-r2",
        artifactSha256: hash,
        machine: runtimeMachine,
      });
      expect(
        f.service.readServiceConfiguration(f.root, { machineId: f.machineId }).runtimeCandidates[0]
          ?.runtime.installationRevision,
      ).toBe("callee-r2");
      const changed = f.service.inspectInvocations(f.root, args);
      expect(changed.candidates).toEqual([]);
      expect(changed.unavailable).toEqual([
        {
          caller: candidate.caller,
          serviceId: policy.serviceId,
          revision: policy.revision,
          reason: "service_runtime_changed",
        },
      ]);
      expect(changed.edges[0]?.edge.callee.installationRevision).toBe("callee-r1");
    } finally {
      f.store.close();
    }
  });

  test("root inspection preserves stale exact edges for revocation, never renewed approval", () => {
    const f = fixture();
    try {
      const target = {
        machineId: f.machineId,
        pluginId,
        operationId,
        installationRevision: "r1",
        artifactSha256: hash,
      };
      const edge = {
        caller: target,
        callee: target,
        resources: [],
        outputs: [],
        maxDepth: 2,
        maxConcurrency: 2,
        aggregate: limits,
      };
      const args = { machineId: f.machineId, pluginId };
      f.service.setInvocationEdge(f.root, { edge, enabled: true });
      const token = f.auth.mintToken(
        { principal: { name: "scoped", kind: "agent" }, caps: ["jobs:read"] },
        f.root,
      );
      const scoped = f.auth.authenticate(token.token);
      expect(() =>
        jobContext(() => f.service, scoped, "engine.jobs", 1).inspectInvocations(args),
      ).toThrow();
      expect(() =>
        jobContext(() => f.service, f.root, pluginId, 1).inspectInvocations(args),
      ).toThrow("job_admin_required");
      f.service.install(f.root, {
        machineId: f.machineId,
        pluginId,
        installationRevision: "r2",
        artifactSha256: hash,
        machine,
      });
      const inspection = jobContext(() => f.service, f.root, "engine.jobs", 1).inspectInvocations(
        args,
      );
      expect(inspection.edges).toEqual([{ edge, enabled: true }]);
      expect(inspection.candidates).toEqual([]);
      expect(() => f.service.setInvocationEdge(f.root, { edge, enabled: true })).toThrow(
        "invocation_target_changed",
      );
      expect(() => f.service.setInvocationEdge(scoped, { edge, enabled: false })).toThrow();
      f.service.setInvocationEdge(f.root, { edge, enabled: false });
      expect(f.service.inspectInvocations(f.root, args).edges).toEqual([{ edge, enabled: false }]);
    } finally {
      f.store.close();
    }
  });

  test("revoking an earlier inspected edge cannot replace a newer bounded approval", () => {
    const f = fixture();
    try {
      const target = {
        machineId: f.machineId,
        pluginId,
        operationId,
        installationRevision: "r1",
        artifactSha256: hash,
      };
      const edge = {
        caller: target,
        callee: target,
        resources: [],
        outputs: [],
        maxDepth: 2,
        maxConcurrency: 2,
        aggregate: limits,
      };
      f.service.setInvocationEdge(f.root, { edge, enabled: true });
      const replacement = { ...edge, maxConcurrency: 1 };
      f.service.setInvocationEdge(f.root, { edge: replacement, enabled: true });
      expect(() => f.service.setInvocationEdge(f.root, { edge, enabled: false })).toThrow(
        "invocation_edge_changed",
      );
      expect(
        f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId }).edges,
      ).toEqual([{ edge: replacement, enabled: true }]);
    } finally {
      f.store.close();
    }
  });

  test("describe is current machine-scoped inspection, never consent or stale connectivity", () => {
    const f = fixture();
    try {
      const args = { machineId: f.machineId, pluginId };
      expect(f.service.describe(f.root, args)).toMatchObject({
        connected: false,
        platforms: [],
        installation: { ready: false },
        consents: [],
      });
      prove(f);
      expect(f.service.describe(f.root, args)).toMatchObject({
        connected: true,
        platforms: ["linux-x64"],
        installation: { ready: true },
      });
      f.service.online(f.channel, undefined, "terminal-only");
      expect(f.service.describe(f.root, args)).toMatchObject({
        connected: false,
        platforms: [],
        installation: { ready: false },
      });
      prove(f);
      consent(f, "machines:run");
      consent(f, "machines:run", false);
      expect(f.service.describe(f.root, args).consents[0]!.enabled).toBe(false);
      const token = f.auth.mintToken(
        { principal: { name: "inspector", kind: "human" }, caps: ["machines:run"] },
        f.root,
      );
      const inspector = f.auth.authenticate(token.token);
      f.auth.grant(
        {
          principal: { kind: "principal", id: inspector.principal.id },
          node: formatManifoldUri({ kind: "machine", machineId: "other" }),
          caps: ["machines:run"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      expect(f.service.describe(inspector, args).connected).toBe(true);
      expect(() => f.service.describe(inspector, { ...args, machineId: "other" })).toThrow();
      f.auth.revokePrincipal(inspector.principal.id, f.root);
      expect(() => f.service.describe(inspector, args)).toThrow();
      f.service.offline(f.channel);
      expect(f.service.describe(f.root, args)).toMatchObject({
        connected: false,
        platforms: [],
        installation: { ready: false },
      });
      f.service.online(f.channel, f.owner, "new-epoch");
      expect(f.service.describe(f.root, args)).toMatchObject({
        connected: false,
        installation: { ready: false },
      });
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  });
  test("cancelled queue and interrupted committed start remain distinct, without replaying transitions", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      consent(f, "jobs:cancel");
      execute(f, "queued");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "queued" };
      f.service.cancel(f.root, node);
      f.service.cancel(f.root, node);
      expect(lifecycle(f, "queued").map(({ payload }) => payload.jobLifecycle)).toEqual([
        "cancelled",
      ]);
      expect(lifecycle(f, "queued")[0]!.payload.executor).toBeNull();
      prove(f);
      execute(f, "committed");
      f.service.event(f.channel, {
        type: "refusal",
        jobId: "committed",
        reason: "private-owner-error",
      });
      f.service.event(f.channel, {
        type: "refusal",
        jobId: "committed",
        reason: "private-owner-error",
      });
      expect(lifecycle(f, "committed").map(({ payload }) => payload.jobLifecycle)).toEqual([
        "admitted",
        "start-committed",
        "interrupted",
        "result",
      ]);
      expect(JSON.stringify(lifecycle(f, "committed"))).not.toContain("private-owner-error");
    } finally {
      f.store.close();
    }
  });
});

describe("durable job authority", () => {
  test("product schedule management is installation-owned even with the owner credential", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      consent(f, "operations:invoke");
      const own = jobContext(() => f.service, f.root, pluginId, 1);
      const unrelated = jobContext(() => f.service, f.root, "unrelated.plugin", 2);
      own.schedule({
        jobId: "template",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        scheduleId: "schedule",
        revision: "one",
        firstNominalAt: f.runtime.now() + 100,
        intervalMs: 100,
        deadlineMs: 50,
        expiresAt: f.runtime.now() + 10000,
        offlinePolicy: "coalesce-one",
      });
      expect(own.schedules().map((s) => s.scheduleId)).toEqual(["schedule"]);
      expect(unrelated.schedules()).toEqual([]);
      expect(() =>
        unrelated.disableSchedule({ scheduleId: "schedule", revision: "one" }),
      ).toThrow();
      expect(() =>
        unrelated.consent({
          machineId: f.machineId,
          pluginId,
          installationRevision: "r1",
          artifactSha256: hash,
          node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId }),
          cap: "jobs:read",
          enabled: true,
        }),
      ).toThrow();
      own.disableSchedule({ scheduleId: "schedule", revision: "one" });
      expect(own.schedules()).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("owner-dispatched product contexts cannot read or control another plugin's job", () => {
    const f = fixture();
    try {
      for (const cap of ["machines:run", "jobs:read", "jobs:input", "jobs:cancel"] as const)
        consent(f, cap);
      prove(f);
      execute(f);
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const unrelated = jobContext(() => f.service, f.root, "unrelated.plugin", 1);
      const own = jobContext(() => f.service, f.root, pluginId, 2);
      const admin = jobContext(() => f.service, f.root, "engine.jobs", 3);
      const before = f.commands.length;
      expect(() => unrelated.status(node)).toThrow();
      expect(() => unrelated.follow(node, () => {})).toThrow();
      expect(() =>
        unrelated.input({ node, requestId: "denied-input", seq: 1, data: "eA==", eof: false }),
      ).toThrow();
      expect(() => unrelated.cancel(node)).toThrow();
      expect(() =>
        unrelated.output({
          node: { ...node, kind: "output", outputId: "stdout" },
          offset: 0,
          maxBytes: 10,
        }),
      ).toThrow();
      expect(f.commands.length).toBe(before);
      expect(own.status(node).jobId).toBe("job");
      expect(admin.status(node).jobId).toBe("job");
    } finally {
      f.store.close();
    }
  });

  test("deleting the winning grant cancels a committed job durably while offline, not unrelated jobs", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      const token = f.auth.mintToken(
        {
          principal: { name: "runner", kind: "agent" },
          caps: ["machines:run"],
        },
        f.root,
      );
      const runner = f.auth.authenticate(token.token);
      const principal = { kind: "principal" as const, id: runner.principal.id };
      f.auth.grant(
        {
          principal,
          node: formatManifoldUri({ kind: "machine", machineId: f.machineId }),
          caps: ["machines:run"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      const grant = f.auth.grant(
        {
          principal,
          node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId }),
          caps: ["machines:run"],
          effect: "allow",
          reach: "subtree",
        },
        f.root,
      );
      prove(f);
      f.service.execute(runner, pluginId, "runner-trace", {
        jobId: "runner",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
      });
      const admitted = f.store
        .listEvents({ type: "trace", limit: 100 })
        .map((row) => JSON.parse(row.payload))
        .find((payload) => payload.jobId === "runner" && payload.jobLifecycle === "admitted");
      expect(admitted).toMatchObject({
        requester: runner.principal.id,
        decision: {
          grants: [{ grantId: grant.id, authorizer: f.root.principal.id, allowed: true }],
        },
        executor: { machineId: f.machineId, ownerId: f.owner.ownerId, ownerGeneration: 1 },
      });
      expect(admitted.requester).not.toBe(admitted.decision.grants[0].authorizer);
      execute(f, "unrelated");
      expect(f.service.jobs.get("runner")?.state).toBe("start-committed");
      f.service.offline(f.channel);
      f.auth.revokeGrant(grant.id, f.root);
      expect(f.service.jobs.cancellation("runner")).not.toBeNull();
      expect(f.service.jobs.cancellation("unrelated")).toBeNull();
      const before = f.commands.length;
      prove(f);
      expect(
        f.commands
          .slice(before)
          .filter((c) => c.type === "cancel")
          .map((c) => c.jobId),
      ).toContain("runner");
      expect(f.commands.slice(before).filter((c) => c.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("a new winning deny cancels after start and expiry is reconciled on the bounded tick", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      const token = f.auth.mintToken(
        {
          principal: { name: "runner", kind: "agent" },
          caps: ["machines:run"],
        },
        f.root,
      );
      const runner = f.auth.authenticate(token.token);
      prove(f);
      f.service.execute(runner, pluginId, "runner-trace", {
        jobId: "runner",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
      });
      const started = f.commands.find((c) => c.type === "start");
      if (started?.type !== "start") throw new Error("start missing");
      f.service.event(f.channel, {
        type: "state",
        state: "started",
        jobId: "runner",
        requestDigest: started.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
      });
      f.auth.grant(
        {
          principal: { kind: "principal", id: runner.principal.id },
          node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId }),
          caps: ["machines:run"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      expect(f.commands.filter((c) => c.type === "cancel").map((c) => c.jobId)).toContain("runner");
      f.service.execute({ ...f.root, expiresAt: f.runtime.now() + 10 }, pluginId, "expiry", {
        jobId: "expiring-live",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
      });
      f.runtime.time += 11;
      f.service.tick();
      expect(f.service.jobs.cancellation("expiring-live")).toEqual({
        reason: "credential_revoked_or_expired",
        mode: "cancel",
      });
      expect(f.commands.filter((c) => c.type === "cancel").map((c) => c.jobId)).toContain(
        "expiring-live",
      );
    } finally {
      f.store.close();
    }
  });

  test("even root sends zero starts until exact consent, and revoking consent blocks later jobs", () => {
    const f = fixture();
    try {
      prove(f);
      execute(f, "without-consent");
      expect(f.commands.filter((c) => c.type === "start")).toEqual([]);
      consent(f, "machines:run");
      execute(f, "with-consent");
      expect(f.commands.filter((c) => c.type === "start").map((c) => c.request.jobId)).toEqual([
        "with-consent",
      ]);
      consent(f, "machines:run", false);
      execute(f, "after-revocation");
      expect(f.commands.filter((c) => c.type === "start").map((c) => c.request.jobId)).toEqual([
        "with-consent",
      ]);
    } finally {
      f.store.close();
    }
  });

  test("a correctly signed proof for the wrong challenge never unlocks execution", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f, true);
      execute(f);
      expect(f.commands.filter((c) => c.type === "start")).toEqual([]);
      expect(f.service.jobs.owner(f.machineId)).toBeNull();
    } finally {
      f.store.close();
    }
  });

  test("an accepted durable reservation cannot execute twice after reopening the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-dedupe-"));
    const path = join(dir, "hub.sqlite");
    const f = fixture(path);
    let reopened: ServerStore | null = null;
    try {
      consent(f, "machines:run");
      consent(f, "jobs:read");
      prove(f);
      const first = execute(f);
      execute(f);
      expect(f.commands.filter((c) => c.type === "start")).toHaveLength(1);
      f.store.close();
      reopened = new ServerStore(openDatabase(path));
      const auth = new AuthService(reopened, key, f.runtime);
      const service = new JobService(reopened, auth, f.runtime);
      service.setLifecycleRecorder((record) => reopened!.appendTrace(record));
      service.setManifestResolver((id) => (id === pluginId ? machine : null));
      const resumed = {
        ...f,
        store: reopened,
        auth,
        root: auth.authenticate(key),
        service,
        commands: [] as JobCommand[],
      };
      resumed.channel = {
        machineId: f.machineId,
        send: (message) => {
          resumed.commands.push(message.command);
          return true;
        },
      };
      prove(resumed);
      expect(execute(resumed).request.requestDigest).toBe(first.request.requestDigest);
      expect(resumed.commands.filter((c) => c.type === "start")).toEqual([]);
      expect(() => execute(resumed, "job", "changed")).toThrow();
      expect(resumed.commands.filter((c) => c.type === "start")).toEqual([]);
    } finally {
      reopened?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("execute replay requires current job-read authority without starting again", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      const token = f.auth.mintToken(
        {
          principal: { name: "replay-runner", kind: "agent" },
          caps: ["machines:run", "jobs:read"],
        },
        f.root,
      );
      const runner = f.auth.authenticate(token.token);
      const consumer = jobContext(() => f.service, runner, pluginId, 1);
      const args = {
        jobId: "replay",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
      };
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: args.jobId };
      prove(f);
      // Admission can acknowledge a fresh start without granting result inspection.
      expect(consumer.execute(args).state).toBe("start-committed");
      expect(() => consumer.execute(args)).toThrow();
      const job = f.service.jobs.get(args.jobId)!;
      f.service.event(f.channel, {
        type: "result",
        result: {
          jobId: args.jobId,
          requestDigest: job.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "exited",
          exitCode: 0,
          reason: null,
          startedAt: 0,
          finishedAt: 1,
          usage: null,
          limits,
          outputs: [{ outputId: "stdout", name: "stdout", sha256: hash, bytes: 3, files: 1 }],
        },
      });
      consent(f, "jobs:read");
      const completed = consumer.status(node);
      expect(completed.result?.outputs).toEqual([
        { outputId: "stdout", name: "stdout", sha256: hash, bytes: 3, files: 1 },
      ]);
      expect(consumer.execute(args)).toEqual(completed);
      const deny = f.auth.grant(
        {
          principal: { kind: "principal", id: runner.principal.id },
          node: formatManifoldUri(node),
          caps: ["jobs:read"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      expect(() => consumer.status(node)).toThrow();
      expect(() => consumer.execute(args)).toThrow();
      f.auth.revokeGrant(deny.id, f.root);
      expect(consumer.execute(args)).toEqual(completed);
      consent(f, "jobs:read", false);
      expect(() => consumer.status(node)).toThrow();
      expect(() => consumer.execute(args)).toThrow();
      consent(f, "jobs:read");
      expect(consumer.execute(args)).toEqual(completed);
      expect(
        f.commands
          .filter((command) => command.type === "start")
          .map((command) => command.request.jobId),
      ).toEqual([args.jobId]);
    } finally {
      f.store.close();
    }
  });

  test("retained consumers reacquire old revision authority after replacement and restart without replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-retained-revision-"));
    const path = join(dir, "hub.sqlite");
    const f = fixture(path);
    const nextHash = "c".repeat(64);
    const nextMachine = structuredClone(machine);
    nextMachine.artifacts["linux-x64"]!.sha256 = nextHash;
    nextMachine.artifacts["linux-x64"]!.entrySha256 = nextHash;
    const replacement = {
      machineId: f.machineId,
      pluginId,
      installationRevision: "r2",
      artifactSha256: nextHash,
      machine: nextMachine,
    };
    const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "retained" };
    const output = { ...node, kind: "output" as const, outputId: "stdout" };
    const operation = formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId });
    const nextConsent = (cap: Cap, enabled = true) =>
      f.service.consent(f.root, {
        machineId: f.machineId,
        pluginId,
        installationRevision: "r2",
        artifactSha256: nextHash,
        node: operation,
        cap,
        enabled,
      });
    const finish = (job: JobRecord) =>
      f.service.event(f.channel, {
        type: "result",
        result: {
          jobId: job.request.jobId,
          requestDigest: job.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "exited",
          exitCode: 0,
          reason: null,
          startedAt: 0,
          finishedAt: 1,
          usage: null,
          limits,
          outputs: [{ outputId: "stdout", name: "stdout", sha256: hash, bytes: 3, files: 1 }],
        },
      });
    const deliverOutput = () => {
      const request = f.commands.at(-1);
      if (request?.type !== "output_read") throw new Error("retained output read missing");
      f.service.event(f.channel, {
        type: "output",
        jobId: node.jobId,
        outputId: output.outputId,
        requestId: request.requestId,
        seq: 0,
        data: "YWJj",
        eof: true,
      });
    };
    try {
      consent(f, "machines:run");
      consent(f, "jobs:read");
      prove(f);
      const original = execute(f, node.jobId);
      f.service.setManifestResolver((id) => (id === pluginId ? nextMachine : null));
      expect(() => f.service.install(f.root, replacement)).toThrow("active_installation");
      finish(original);
      const readerToken = f.auth.mintToken(
        { principal: { name: "retained-reader", kind: "human" }, caps: ["jobs:read"] },
        f.root,
      );
      const reader = f.auth.authenticate(readerToken.token);
      // Keep the same product consumer and canonical references across replacement/reopen.
      const consumer = jobContext(() => f.service, reader, pluginId, 1);
      const originalPublic = consumer.status(node);
      const retainedRuns = () => consumer.listRuns({ machineId: f.machineId }).runs;
      expect(retainedRuns()).toEqual([{ job: originalPublic, occurrence: null }]);
      const updates: JobFollowUpdate[] = [];
      consumer.follow(node, (event) => updates.push(event));
      const inFlight = consumer.output({ node: output, offset: 0, maxBytes: 3 });
      const pendingCommand = f.commands.at(-1);
      f.service.install(f.root, replacement);
      expect(updates).toEqual([]);
      if (pendingCommand?.type !== "output_read") throw new Error("pending read missing");
      f.service.event(f.channel, {
        type: "output",
        jobId: node.jobId,
        outputId: output.outputId,
        requestId: pendingCommand.requestId,
        seq: 0,
        data: "YWJj",
        eof: true,
      });
      expect((await inFlight).data).toBe("YWJj");
      expect(consumer.status(node)).toEqual(originalPublic);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      const retained = { machineId: f.machineId, pluginId, installationRevision: "r1" };
      expect(f.service.describe(f.root, retained)).toMatchObject({
        installation: { revision: "r1", artifactSha256: hash, ready: false },
        consents: [
          { cap: "jobs:read", enabled: true },
          { cap: "machines:run", enabled: true },
        ],
      });
      expect(f.service.describe(f.root, retained).retainedInstallations).toEqual([
        { revision: "r1", artifactSha256: hash },
      ]);
      expect(
        f.service.describe(f.root, { ...retained, installationRevision: "unknown" }).installation,
      ).toBeNull();
      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: "r2",
        artifactSha256: nextHash,
      });
      expect(execute(f, "new-denied").state).toBe("refused");
      nextConsent("jobs:read");
      consent(f, "jobs:read", false);
      expect(updates).toEqual([{ type: "closed", reason: "authority_revoked" }]);
      expect(() => consumer.status(node)).toThrow();
      expect(retainedRuns().some((run) => run.job?.jobId === node.jobId)).toBe(false);
      // A retained job reference selects its immutable revision but shares that revision's
      // operation consent, just like the canonical operation administration path.
      f.service.consent(f.root, {
        ...retained,
        artifactSha256: hash,
        node: formatManifoldUri(node),
        cap: "jobs:read",
        enabled: true,
      });
      expect(consumer.status(node)).toEqual(originalPublic);
      expect(retainedRuns()).toContainEqual({ job: originalPublic, occurrence: null });
      const firstRead = consumer.output({ node: output, offset: 0, maxBytes: 3 });
      deliverOutput();
      expect((await firstRead).data).toBe("YWJj");
      consent(f, "jobs:read", false);
      expect(() => consumer.status(node)).toThrow();
      expect(consumer.status({ ...node, jobId: "new-denied" }).state).toBe("refused");
      expect(() =>
        f.service.consent(f.root, {
          ...retained,
          artifactSha256: nextHash,
          node: operation,
          cap: "jobs:read",
          enabled: true,
        }),
      ).toThrow();
      consent(f, "jobs:read");
      const deny = f.auth.grant(
        {
          principal: { kind: "principal", id: reader.principal.id },
          node: formatManifoldUri(node),
          caps: ["jobs:read"],
          effect: "deny",
          reach: "subtree",
        },
        f.root,
      );
      expect(() => consumer.status(node)).toThrow();
      expect(retainedRuns().some((run) => run.job?.jobId === node.jobId)).toBe(false);
      expect(() => consumer.output({ node: output, offset: 0, maxBytes: 3 })).toThrow();
      f.auth.revokeGrant(deny.id, f.root);
      expect(consumer.status(node)).toEqual(originalPublic);

      f.service.offline(f.channel);
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? nextMachine : null));
      f.commands.length = 0;
      prove(f);
      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: "r2",
        artifactSha256: nextHash,
      });
      expect(consumer.status(node)).toEqual(originalPublic);
      expect(retainedRuns()).toContainEqual({ job: originalPublic, occurrence: null });
      const afterRestart = consumer.follow(node, () => {});
      expect(afterRestart.snapshot.result).toEqual(originalPublic.result);
      expect(afterRestart.snapshot.events).toEqual([]);
      expect(afterRestart.snapshot.unavailable).toEqual({ fromSeq: 1, toSeq: 1 });
      afterRestart.close();
      const reopenedRead = consumer.output({ node: output, offset: 0, maxBytes: 3 });
      deliverOutput();
      expect((await reopenedRead).data).toBe("YWJj");
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(() => execute(f, node.jobId)).toThrow("job_digest_conflict");
      expect(() => execute(f, node.jobId, "changed")).toThrow("job_digest_conflict");
      // Regranting old execution consent cannot admit the new artifact.
      consent(f, "machines:run");
      expect(execute(f, "new-still-denied").state).toBe("refused");
      nextConsent("machines:run");
      const next = execute(f, "new-approved");
      expect(next.request.artifactSha256).toBe(nextHash);
      expect(
        f.commands
          .filter((command) => command.type === "start")
          .map((command) => command.request.jobId),
      ).toEqual(["new-approved"]);
      expect(execute(f, "new-approved").request.requestDigest).toBe(next.request.requestDigest);
      finish(next);
      consent(f, "jobs:read", false);
      expect(() => consumer.status(node)).toThrow();
      expect(consumer.status({ ...node, jobId: "new-approved" }).state).toBe("exited");
      consent(f, "jobs:read");
      f.service.disablePlugin(pluginId);
      expect(() => consumer.status(node)).toThrow();
      expect(retainedRuns()).toEqual([]);
      f.service.install(f.root, replacement);
      expect(consumer.status(node)).toEqual(originalPublic);
      f.service.disablePlugin(pluginId);
      f.service.purgePlugin(pluginId);
      f.service.install(f.root, replacement);
      expect(() => consumer.output({ node: output, offset: 0, maxBytes: 3 })).toThrow();
      expect(consumer.status(node)).toEqual(originalPublic);
      f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
      f.service.install(f.root, { ...retained, artifactSha256: hash, machine });
      prove(f);
      expect(execute(f, node.jobId).request.requestDigest).toBe(original.request.requestDigest);
      expect(() => execute(f, node.jobId, "changed")).toThrow("job_digest_conflict");
      f.service.setManifestResolver((id) => (id === pluginId ? nextMachine : null));
      expect(() =>
        f.service.install(f.root, { ...replacement, installationRevision: "r1" }),
      ).toThrow("installation_revision_conflict");
      expect(
        f.commands
          .filter((command) => command.type === "start")
          .map((command) => command.request.jobId),
      ).toEqual(["new-approved"]);
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("read consent protects existence and output access, including root and invented output IDs", () => {
    const f = fixture();
    try {
      execute(f);
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      expect(() => f.service.status(f.root, node)).toThrow();
      expect(f.service.canReadGoverned(f.root, node)).toBe(false);
      consent(f, "jobs:read");
      expect(f.service.status(f.root, node).request.jobId).toBe("job");
      const attenuated = { ...f.root, caps: [] };
      expect(f.service.canReadGoverned(attenuated, node)).toBe(false);
      expect(() => f.service.status(attenuated, node)).toThrow();
      expect(f.service.canReadGoverned(f.root, { ...node, jobId: "invented" })).toBe(false);
      expect(() =>
        f.service.output(f.root, { ...node, kind: "output", outputId: "invented" }, 0, 10),
      ).toThrow();
      consent(f, "jobs:read", false);
      expect(() => f.service.status(f.root, node)).toThrow();
    } finally {
      f.store.close();
    }
  });

  test("live follows close on a gap or revoked consent without delivering private bytes", () => {
    const f = fixture();
    try {
      execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const updates: JobFollowUpdate[] = [];
      const follow = f.service.follow(f.root, node, (event) => updates.push(event));
      expect(follow.snapshot).toMatchObject({ jobId: "job", seq: 0 });
      const output = {
        type: "output" as const,
        jobId: "job",
        requestId: "job",
        outputId: "stdout",
        seq: 1,
        data: "YQ==",
        eof: false,
      };
      f.service.publishJobEvent("job", output);
      f.service.publishJobEvent("job", { ...output, seq: 3, data: "c2VjcmV0" });
      expect(updates.map((event) => event.type)).toEqual(["event", "closed"]);
      expect(updates.at(-1)).toEqual({ type: "closed", reason: "gap" });
      expect(JSON.stringify(updates)).not.toContain("c2VjcmV0");
      const revoked: JobFollowUpdate[] = [];
      f.service.follow(f.root, node, (event) => revoked.push(event));
      consent(f, "jobs:read", false);
      f.service.publishJobEvent("job", output);
      expect(revoked).toEqual([{ type: "closed", reason: "authority_revoked" }]);
      follow.close();
    } finally {
      f.store.close();
    }
  });

  test("late observers get the durable watermark and reentrant publications remain ordered", () => {
    const f = fixture();
    try {
      execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const output = {
        type: "output" as const,
        jobId: "job",
        requestId: "job",
        outputId: "stdout",
        seq: 1,
        data: "YQ==",
        eof: false,
      };
      f.service.publishJobEvent("job", output);
      const first: number[] = [];
      const second: number[] = [];
      const follow = f.service.follow(f.root, node, (update) => {
        if (update.type !== "event") return;
        first.push(update.seq);
        if (update.seq === 2) f.service.publishJobEvent("job", { ...output, seq: 3 });
      });
      const other = f.service.follow(f.root, node, (update) => {
        if (update.type === "event") second.push(update.seq);
      });
      expect(follow.snapshot.seq).toBe(1);
      f.service.publishJobEvent("job", { ...output, seq: 2 });
      expect(first).toEqual([2, 3]);
      expect(second).toEqual([2, 3]);
      follow.close();
      other.close();
      const restarted = new JobService(f.store, f.auth, f.runtime);
      restarted.setLifecycleRecorder((record) => f.store.appendTrace(record));
      restarted.setManifestResolver((id) => (id === pluginId ? machine : null));
      const afterRestart = restarted.follow(f.root, node, () => {});
      expect(afterRestart.snapshot.seq).toBe(3);
      expect(afterRestart.snapshot.events).toEqual([]);
      expect(afterRestart.snapshot.unavailable).toEqual({ fromSeq: 1, toSeq: 3 });
      afterRestart.close();
    } finally {
      f.store.close();
    }
  });

  test("a queued credential expiring while offline never receives a start permit", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      const expiring = { ...f.root, expiresAt: f.runtime.now() + 10 };
      f.service.execute(expiring, pluginId, "trace-expiry", {
        jobId: "expiring",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
      });
      f.runtime.time += 11;
      prove(f);
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(f.service.jobs.get("expiring")?.state).toBe("refused");
    } finally {
      f.store.close();
    }
  });

  test("machine transport possession cannot replace a pinned owner key at a newer generation", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      f.service.offline(f.channel);
      const replacement = generateKeyPairSync("ed25519");
      const attacker: JobOwner = {
        ...f.owner,
        generation: f.owner.generation + 1,
        publicKey: replacement.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
      const commands: JobCommand[] = [];
      const channel = {
        machineId: f.machineId,
        send: (message: { type: "job_command"; command: JobCommand }) => {
          commands.push(message.command);
          return true;
        },
      };
      f.service.online(channel, attacker, "new-epoch");
      execute(f, "after-replacement");
      expect(commands).toEqual([]);
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(f.service.jobs.owner(f.machineId)?.publicKey).toBe(f.owner.publicKey);
    } finally {
      f.store.close();
    }
  });

  test("late stdout replay reports the exact unavailable prefix rather than claiming a complete transcript", () => {
    const f = fixture();
    try {
      execute(f);
      consent(f, "jobs:read");
      const data = Buffer.alloc(65536, 97).toString("base64");
      for (let seq = 1; seq <= 5; seq++)
        f.service.publishJobEvent("job", {
          type: "output",
          jobId: "job",
          requestId: "job",
          outputId: "stdout",
          seq,
          data,
          eof: false,
        });
      const follow = f.service.follow(
        f.root,
        { kind: "job", machineId: f.machineId, operationId, jobId: "job" },
        () => {},
      );
      expect(follow.snapshot.seq).toBe(5);
      expect(follow.snapshot.events.map((frame) => frame.seq)).toEqual([4, 5]);
      expect(follow.snapshot.firstSeq).toBe(4);
      expect(follow.snapshot.unavailable).toEqual({ fromSeq: 1, toSeq: 3 });
      expect(Buffer.byteLength(JSON.stringify(follow.snapshot.events))).toBeLessThanOrEqual(262144);
      follow.close();
    } finally {
      f.store.close();
    }
  });

  test("sealed stdout is privately readable and an in-flight read cannot outlive consent", async () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      f.service.event(f.channel, {
        type: "result",
        result: {
          jobId: "job",
          requestDigest: job.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "exited",
          exitCode: 0,
          reason: null,
          startedAt: 0,
          finishedAt: 1,
          usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 3 },
          limits,
          outputs: [{ outputId: "stdout", name: "stdout", sha256: hash, bytes: 3, files: 1 }],
        },
      });
      const node = {
        kind: "output" as const,
        machineId: f.machineId,
        operationId,
        jobId: "job",
        outputId: "stdout",
      };
      expect(() => f.service.output(f.root, node, 0, 3)).toThrow();
      consent(f, "jobs:read");
      const read = f.service.output(f.root, node, 0, 3);
      const request = f.commands.at(-1);
      if (request?.type !== "output_read") throw new Error("private output read missing");
      f.service.event(f.channel, {
        type: "output",
        jobId: "job",
        outputId: "stdout",
        requestId: request.requestId,
        seq: 0,
        data: "YWJj",
        eof: true,
      });
      expect((await read).data).toBe("YWJj");
      const pending = f.service.output(f.root, node, 0, 3);
      const next = f.commands.at(-1);
      if (next?.type !== "output_read") throw new Error("second private output read missing");
      consent(f, "jobs:read", false);
      f.service.event(f.channel, {
        type: "output",
        jobId: "job",
        outputId: "stdout",
        requestId: next.requestId,
        seq: 0,
        data: "YWJj",
        eof: true,
      });
      await expect(pending).rejects.toThrow("output_authority_revoked");
    } finally {
      f.store.close();
    }
  });

  /** The owner's sealed two-output result, which is what both readers need. */
  function settle(f: Fixture, job: JobRecord): void {
    f.service.event(f.channel, {
      type: "result",
      result: {
        jobId: "job",
        requestDigest: job.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "exited",
        exitCode: 0,
        reason: null,
        startedAt: 0,
        finishedAt: 7,
        usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 8 },
        limits,
        outputs: [
          { outputId: "o-out", name: "stdout", sha256: hash, bytes: 5, files: 1 },
          { outputId: "o-err", name: "stderr", sha256: "b".repeat(64), bytes: 3, files: 1 },
        ],
      },
    });
  }
  function finished(f: Fixture): JobRecord {
    consent(f, "machines:run");
    prove(f);
    const job = execute(f);
    settle(f, job);
    return job;
  }
  /** Answers the owner's pending private read with `data`, the way a proved machine would. */
  function answerRead(f: Fixture, data: string, eof: boolean): void {
    const request = f.commands.at(-1);
    if (request?.type !== "output_read") throw new Error("private output read missing");
    f.service.event(f.channel, {
      type: "output",
      jobId: "job",
      outputId: request.outputId,
      requestId: request.requestId,
      seq: 0,
      data,
      eof,
    });
  }

  test("a named output of a finished job pages exactly against its sealed length", async () => {
    const f = fixture();
    try {
      finished(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const first = f.service.outputs(f.root, node, "stdout", 0, 3);
      answerRead(f, "YWJj", false);
      expect(await first).toEqual({
        jobId: "job",
        outputId: "o-out",
        name: "stdout",
        sha256: hash,
        files: 1,
        total: 5,
        offset: 0,
        data: "YWJj",
        eof: false,
      });
      const second = f.service.outputs(f.root, node, "stdout", 3, 3);
      const command = f.commands.at(-1);
      if (command?.type !== "output_read") throw new Error("second page missing");
      expect({
        offset: command.offset,
        maxBytes: command.maxBytes,
        outputId: command.outputId,
      }).toEqual({ offset: 3, maxBytes: 3, outputId: "o-out" });
      answerRead(f, "ZGU=", true);
      expect(await second).toMatchObject({ offset: 3, data: "ZGU=", eof: true, total: 5 });
      // The name selects the output; nothing here ever quoted an owner-minted id.
      const other = f.service.outputs(f.root, node, "stderr", 0, 8);
      answerRead(f, "Zmls", true);
      expect(await other).toMatchObject({ outputId: "o-err", total: 3, name: "stderr" });
    } finally {
      f.store.close();
    }
  });

  test("outputs refuses another plugin, an unfinished job and a name the result never sealed", async () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      await expect(f.service.outputs(f.root, node, "stdout", 0, 4)).rejects.toThrow(
        "job_unfinished",
      );
      expect(f.commands.some((command) => command.type === "output_read")).toBe(false);
      settle(f, job);
      await expect(f.service.outputs(f.root, node, "stdout", 0, 4, "other.plugin")).rejects.toThrow(
        "governed_authority_refused",
      );
      await expect(f.service.outputs(f.root, node, "report", 0, 4)).rejects.toThrow(
        "unknown_job_output",
      );
      expect(f.commands.some((command) => command.type === "output_read")).toBe(false);
    } finally {
      f.store.close();
    }
  });

  test("the journal retains lifecycle frames of a finished job and pages them, byte frames excluded", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      f.service.publishJobEvent("job", {
        type: "state",
        jobId: "job",
        requestDigest: job.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "started",
      });
      f.service.publishJobEvent("job", {
        type: "output",
        jobId: "job",
        requestId: "job",
        outputId: "stdout",
        seq: 1,
        data: "YWJj",
        eof: false,
      });
      settle(f, job);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const page = f.service.journal(f.root, node, 0, 64);
      expect(page.events.map((frame) => frame.event.type)).toEqual(["state", "result"]);
      // Sequence 2 was the stdout frame: a hole is the contract, not a lost record.
      expect(page.events.map((frame) => frame.seq)).toEqual([1, 3]);
      expect({ firstSeq: page.firstSeq, nextAfter: page.nextAfter, jobId: page.jobId }).toEqual({
        firstSeq: 1,
        nextAfter: null,
        jobId: "job",
      });
      const first = f.service.journal(f.root, node, 0, 1);
      expect(first.events.map((frame) => frame.seq)).toEqual([1]);
      expect(first.nextAfter).toBe(1);
      const next = f.service.journal(f.root, node, first.nextAfter!, 1);
      expect(next.events.map((frame) => frame.seq)).toEqual([3]);
      expect(f.service.journal(f.root, node, 3, 1).events).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("the journal refuses another plugin and a job that has not finished", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      f.service.publishJobEvent("job", {
        type: "state",
        jobId: "job",
        requestDigest: job.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "started",
      });
      expect(() => f.service.journal(f.root, node, 0, 64)).toThrow("job_unfinished");
      settle(f, job);
      expect(() => f.service.journal(f.root, node, 0, 64, "other.plugin")).toThrow(
        "governed_authority_refused",
      );
      expect(f.service.journal(f.root, node, 0, 64).events.length).toBeGreaterThan(0);
    } finally {
      f.store.close();
    }
  });

  test("a settled job is announced to its own plugin with its own credential", () => {
    const f = fixture();
    try {
      const deliveries: SettledJobDelivery[] = [];
      f.service.setSettledListener((delivery) => deliveries.push(delivery));
      finished(f);
      expect(deliveries.map((delivery) => delivery.settled)).toEqual([
        {
          jobId: "job",
          machineId: f.machineId,
          operationId,
          pluginId,
          state: "exited",
          exitCode: 0,
          reason: null,
          finishedAt: 7,
          outputs: [
            { outputId: "o-out", name: "stdout", sha256: hash, bytes: 5, files: 1 },
            { outputId: "o-err", name: "stderr", sha256: "b".repeat(64), bytes: 3, files: 1 },
          ],
        },
      ]);
      // The wake carries the job's own restored credential, never ambient plugin authority.
      expect(deliveries[0]?.auth?.principal.id).toBe(f.root.principal.id);
      expect(deliveries[0]?.traceId).toBe("trace-1");
    } finally {
      f.store.close();
    }
  });
});
