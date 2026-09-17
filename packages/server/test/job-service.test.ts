import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
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
  MachineHalfSchema,
  MachineOperationSchema,
  JobLimitsSchema,
  MachineOperationLimitsSchema,
  JobStartCommandSchema,
  JobRequestSchema,
  type ServicePolicy,
  type Cap,
  JobDeploymentRequestSchema,
  JobDeploymentSchema,
  JobDeploymentDescriptionSchema,
  type JobDeploymentRequest,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobEvent,
  type JobOwner,
  type JobRequest,
  type MachineHalf,
  type JobFollowUpdate,
} from "../../protocol/src/jobs.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService, type JobRecord, type SettledJobDelivery } from "../src/job-service.ts";
import { jobContext } from "../src/job-doors.ts";
import { projectPluginAuthorFacts } from "../src/log.ts";
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

async function instanceFixture(path = ":memory:", protocolVersion = JOB_OWNER_PROTOCOL_VERSION) {
  const provider: MachineHalf = {
    ...machine,
    operations: {
      [operationId]: { ...machine.operations[operationId]!, providesService: true },
    },
  };
  const f = fixture(path, provider);
  f.owner.protocolVersion = protocolVersion;
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

test.each(["same build", "rollback"] as const)(
  "platform-cancelled instance service readmission on %s is automatic and traced (#632)",
  async (recovery) => {
    const dir = mkdtempSync(join(tmpdir(), "job-instance-readmission-"));
    const path = join(dir, "hub.sqlite");
    const { f, policy, provider, start, revision } = await instanceFixture(path);
    const restart = () => {
      f.service.offline(f.channel);
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? provider : null));
      f.commands.length = 0;
    };
    const fact = (command: Extract<JobCommand, { type: "start" }>) => ({
      jobId: command.request.jobId,
      requestDigest: command.request.requestDigest,
      ownerId: command.permit.ownerId,
      ownerGeneration: command.permit.ownerGeneration,
    });
    const ready = (command: Extract<JobCommand, { type: "start" }>) => {
      f.service.event(f.channel, { type: "state", ...fact(command), state: "started" });
      f.service.event(f.channel, {
        type: "service_ready",
        jobId: command.request.jobId,
        service: command.request.service!,
      });
    };
    const finish = (command: Extract<JobCommand, { type: "start" }>) => {
      f.service.event(f.channel, {
        type: "result",
        result: {
          ...fact(command),
          state: "cancelled",
          reason: "cancelled",
          exitCode: null,
          startedAt: f.runtime.now(),
          finishedAt: f.runtime.now(),
          usage: null,
          limits: command.request.limits,
          outputs: [],
        },
      });
      f.service.tick();
      expect(f.service.instanceServices.get(policy.serviceId)?.jobId).toBe(command.request.jobId);
      f.service.event(f.channel, { type: "workload_empty", ...fact(command) });
    };
    const description = () =>
      f.service.describeInstanceService(f.root, { serviceId: policy.serviceId });
    try {
      ready(start);
      expect(description().state).toBe("ready");
      if (recovery === "rollback") restart();
      f.commands.length = 0;
      f.service.setHeldPlugins([pluginId]);
      if (recovery === "rollback") prove(f);
      expect(f.service.jobs.cancellation(start.request.jobId)).toEqual({
        mode: "cancel",
        reason: "plugin_held",
      });
      expect(f.commands).toContainEqual(
        expect.objectContaining({
          type: "cancel",
          jobId: start.request.jobId,
          reason: "plugin_held",
        }),
      );
      finish(start);
      expect(f.service.jobs.get(start.request.jobId)).toMatchObject({
        state: "cancelled",
        ownerClosed: true,
      });
      f.service.tick();
      expect(description()).toMatchObject({ state: "unavailable", reason: "plugin_held" });
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      if (recovery === "rollback") restart();
      f.service.setHeldPlugins([]);
      expect(f.service.jobs.installation(f.machineId, pluginId)?.ready).toBe(false);
      if (recovery === "rollback") prove(f);
      else
        f.service.event(f.channel, {
          type: "installed",
          pluginId,
          installationRevision: "r1",
          artifactSha256: hash,
        });
      f.service.tick();
      const starts = f.commands.filter((command) => command.type === "start");
      expect(starts).toHaveLength(1);
      const replacement = starts[0]!;
      expect(replacement.request.jobId).not.toBe(start.request.jobId);
      ready(replacement);
      expect(description()).toMatchObject({
        state: "ready",
        configuration: { revision, enabled: true },
      });
      expect(f.service.instanceServices.get(policy.serviceId)?.credential).toEqual(
        start.request.credential,
      );
      const readmissions = () =>
        f.store.db
          .query<{ door: string; payload: string }, []>(
            "SELECT door,payload FROM events WHERE json_extract(payload,'$.jobLifecycle')='readmitted'",
          )
          .all()
          .map(({ door, payload }) => ({ door, ...(JSON.parse(payload) as object) }));
      expect(readmissions()).toEqual([
        expect.objectContaining({
          door: "engine.services.configureInstance",
          jobId: replacement.request.jobId,
          previousJobId: start.request.jobId,
          cancelReason: "plugin_held",
        }),
      ]);
      f.service.tick();
      expect(readmissions()).toHaveLength(1);
      expect(f.commands.filter((command) => command.type === "start")).toEqual(starts);

      // Retained operator cancellations must not turn a later proof or hold release into consent.
      for (const [reason, mode] of [
        ["plugin_held", "retire"],
        ["instance_service_disabled", "cancel"],
        ["credential_revoked", "cancel"],
      ] as const) {
        f.service.jobs.cancel(replacement.request.jobId, reason, mode);
        expect(f.service.jobs.cancellation(replacement.request.jobId)).toEqual({ reason, mode });
        if (reason === "credential_revoked")
          f.store.revokeToken(replacement.request.credential.tokenId!, f.runtime.now());
        finish(replacement);
        f.commands.length = 0;
        f.service.setHeldPlugins([pluginId]);
        f.service.setHeldPlugins([]);
        prove(f);
        f.service.tick();
        expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
        expect(f.service.instanceServices.get(policy.serviceId)?.jobId).toBe(
          replacement.request.jobId,
        );
        expect(description().state).toBe("unavailable");
      }
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("platform cancellation is rediscovered after empty proof consumes its start wakeup (#632)", async () => {
  const { f, policy, start } = await instanceFixture();
  const fact = {
    jobId: start.request.jobId,
    requestDigest: start.request.requestDigest,
    ownerId: start.permit.ownerId,
    ownerGeneration: start.permit.ownerGeneration,
  };
  try {
    f.service.event(f.channel, { type: "state", ...fact, state: "started" });
    f.service.setHeldPlugins([pluginId]);
    f.service.setHeldPlugins([]);
    f.service.event(f.channel, {
      type: "installed",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
    });
    f.commands.length = 0;
    f.service.event(f.channel, { type: "workload_empty", ...fact });
    f.service.tick();
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    f.service.event(f.channel, {
      type: "refusal",
      jobId: start.request.jobId,
      reason: "job_unknown",
    });
    expect(f.service.jobs.get(start.request.jobId)).toMatchObject({
      state: "interrupted",
      ownerClosed: true,
    });
    expect(f.service.jobs.cancellation(start.request.jobId)?.reason).toBe("plugin_held");
    f.service.tick();
    const replacement = f.commands.find((command) => command.type === "start");
    expect(replacement).toBeDefined();
    expect(replacement!.request.jobId).not.toBe(start.request.jobId);
    f.service.event(f.channel, {
      type: "state",
      jobId: replacement!.request.jobId,
      requestDigest: replacement!.request.requestDigest,
      ownerId: replacement!.permit.ownerId,
      ownerGeneration: replacement!.permit.ownerGeneration,
      state: "started",
    });
    f.service.event(f.channel, {
      type: "service_ready",
      jobId: replacement!.request.jobId,
      service: replacement!.request.service!,
    });
    expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
      "ready",
    );
  } finally {
    f.store.close();
  }
});

test.each([
  "installation_changed",
  "owner_fenced",
  "owner_restart_effects_unknown",
  "credential_revoked",
])(
  "instance recovery preserves the %s lifetime and cancellation boundary (#632)",
  async (reason) => {
    const { f, policy, start } = await instanceFixture();
    const fact = {
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: start.permit.ownerId,
      ownerGeneration: start.permit.ownerGeneration,
    };
    try {
      f.service.event(f.channel, { type: "state", ...fact, state: "started" });
      if (reason === "owner_restart_effects_unknown") {
        f.service.offline(f.channel);
        f.owner.generation++;
        prove(f);
      } else f.service.jobs.cancel(start.request.jobId, reason);
      if (reason === "credential_revoked")
        f.store.revokeToken(start.request.credential.tokenId!, f.runtime.now());
      f.commands.length = 0;
      f.service.tick();
      expect(f.service.instanceServices.get(policy.serviceId)?.credential).toEqual(
        start.request.credential,
      );
      f.service.event(f.channel, {
        type: "result",
        result: {
          ...fact,
          state: reason === "owner_restart_effects_unknown" ? "interrupted" : "cancelled",
          reason: reason === "owner_restart_effects_unknown" ? reason : "cancelled",
          exitCode: null,
          startedAt: f.runtime.now(),
          finishedAt: f.runtime.now(),
          usage: null,
          limits: start.request.limits,
          outputs: [],
        },
      });
      f.service.tick();
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(f.service.instanceServices.get(policy.serviceId)?.jobId).toBe(start.request.jobId);
      if (reason === "owner_restart_effects_unknown")
        expect(
          f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).reason,
        ).toBe("instance_service_lifetime_unconfirmed");
      f.service.event(f.channel, { type: "workload_empty", ...fact });
      f.service.tick();
      const replacement = f.commands.find((command) => command.type === "start");
      if (reason === "credential_revoked") {
        expect(f.service.jobs.cancellation(start.request.jobId)?.reason).toBe(reason);
        expect(replacement).toBeUndefined();
        expect(f.service.instanceServices.get(policy.serviceId)?.credential).toEqual(
          start.request.credential,
        );
      } else {
        expect(replacement).toBeDefined();
        expect(replacement!.request.jobId).not.toBe(start.request.jobId);
        expect(replacement!.permit.ownerGeneration).toBe(f.owner.generation);
        expect(
          f.store.db
            .query<{ previousJobId: string; cancelReason: string }, []>(
              `SELECT json_extract(payload,'$.previousJobId') AS previousJobId,
               json_extract(payload,'$.cancelReason') AS cancelReason FROM events
               WHERE json_extract(payload,'$.jobLifecycle')='readmitted'`,
            )
            .all(),
        ).toEqual([{ previousJobId: start.request.jobId, cancelReason: reason }]);
      }
    } finally {
      f.store.close();
    }
  },
);

test.each(["running", "exited", "awaiting-empty", "awaiting-result"] as const)(
  "hub restart preserves enabled instance identity and recovers a %s workload",
  async (workload) => {
    const dir = mkdtempSync(join(tmpdir(), "job-instance-restart-"));
    const path = join(dir, "hub.sqlite");
    const { f, policy, provider, start, revision } = await instanceFixture(path);
    const fact = {
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    };
    const result: Extract<JobEvent, { type: "result" }> = {
      type: "result",
      result: {
        ...fact,
        state: "exited",
        exitCode: 0,
        reason: null,
        outputs: [],
        startedAt: f.runtime.now(),
        usage: null,
        limits: start.request.limits,
        finishedAt: f.runtime.now(),
      },
    };
    try {
      f.service.event(f.channel, { type: "state", ...fact, state: "started" });
      f.service.event(f.channel, {
        type: "service_ready",
        jobId: start.request.jobId,
        service: start.request.service!,
      });
      const installation = f.service.describe(f.root, {
        machineId: f.machineId,
        pluginId,
      }).installation;
      const configuration = f.service.describeInstanceService(f.root, {
        serviceId: policy.serviceId,
      }).configuration;
      expect(installation).toMatchObject({ revision: "r1", enabled: true, ready: true });
      expect(configuration).toMatchObject({ revision, enabled: true });
      if (workload !== "running") {
        if (workload !== "awaiting-result") f.service.event(f.channel, result);
        if (workload !== "awaiting-empty")
          f.service.event(f.channel, { type: "workload_empty", ...fact });
      }
      f.service.offline(f.channel);
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? provider : null));
      f.commands.length = 0;
      f.service.tick();
      expect(f.commands).toEqual([]);
      prove(f);
      f.service.tick();
      if (workload === "awaiting-empty" || workload === "awaiting-result") {
        expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
        f.service.event(
          f.channel,
          workload === "awaiting-empty" ? { type: "workload_empty", ...fact } : result,
        );
        f.service.tick();
      }
      const starts = f.commands.filter((command) => command.type === "start");
      expect(starts).toHaveLength(workload === "running" ? 0 : 1);
      const current = workload === "running" ? start : starts[0]!;
      if (workload !== "running") {
        expect(current.request.jobId).not.toBe(start.request.jobId);
        f.service.event(f.channel, {
          type: "state",
          jobId: current.request.jobId,
          requestDigest: current.request.requestDigest,
          ownerId: current.permit.ownerId,
          ownerGeneration: current.permit.ownerGeneration,
          state: "started",
        });
      }
      f.service.event(f.channel, {
        type: "service_ready",
        jobId: current.request.jobId,
        service: current.request.service!,
      });
      expect(
        f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }),
      ).toMatchObject({ state: "ready", configuration });
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation).toEqual(
        installation,
      );
      f.service.tick();
      expect(f.commands.filter((command) => command.type === "start")).toEqual(starts);
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("data-only credential migration and author audit projection preserve enabled native identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "job-instance-migration-"));
  const path = join(dir, "hub.sqlite");
  const { f, policy, provider, start } = await instanceFixture(path);
  try {
    f.service.event(f.channel, {
      type: "state",
      jobId: start.request.jobId,
      requestDigest: start.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    const installationQuery =
      "SELECT revision,artifact,manifest,resource_bindings FROM machine_job_installations";
    const before = f.store.db.query(installationQuery).all();
    const configuration = f.service.describeInstanceService(f.root, {
      serviceId: policy.serviceId,
    }).configuration;
    const authorPayload = { id: pluginId, files: { "worker.ts": "export const fixture = true;" } };
    const trace = f.store.appendTrace({
      actor: f.root.principal.id,
      authority: "root",
      door: "engine.plugins.author",
      containerId: null,
      session: null,
      ts: f.runtime.now(),
      outcome: "ok",
      targets: [],
      payload: authorPayload,
    });
    // #608 changed new author trace projection, not the schema or installation records.
    // Replaying its projection on an elder trace must remain independent of native identity.
    f.store.db
      .query("UPDATE events SET payload=? WHERE id=?")
      .run(JSON.stringify(projectPluginAuthorFacts(authorPayload)), trace);
    // The real v37 -> v38 data-only migration classifies this existing service principal.
    f.store.db
      .query("UPDATE principals SET kind='agent' WHERE id=?")
      .run(start.request.credential.principalId);
    f.store.db.exec(`
ALTER TABLE terminals DROP COLUMN cwd;
ALTER TABLE terminals DROP COLUMN launch_recipe;
DROP TABLE principal_access_pauses;
UPDATE meta SET value='37' WHERE key='schema_version';
`);
    f.service.offline(f.channel);
    f.store.close();
    f.store = new ServerStore(openDatabase(path));
    f.auth = new AuthService(f.store, key, f.runtime);
    f.root = f.auth.authenticate(key);
    f.service = new JobService(f.store, f.auth, f.runtime);
    f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
    f.service.setManifestResolver((id) => (id === pluginId ? provider : null));
    expect(f.store.db.query(installationQuery).all()).toEqual(before);
    expect(f.store.getPrincipal(start.request.credential.principalId)?.kind).toBe("service");
    f.commands.length = 0;
    prove(f);
    f.service.tick();
    f.service.event(f.channel, {
      type: "service_ready",
      jobId: start.request.jobId,
      service: start.request.service!,
    });
    expect(
      f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation,
    ).toMatchObject({ revision: start.request.installationRevision, enabled: true, ready: true });
    expect(
      f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }),
    ).toMatchObject({ state: "ready", configuration });
    expect(
      f.commands.some((command) => command.type === "start" || command.type === "cancel"),
    ).toBe(false);
  } finally {
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([34, 35])(
  "accepted v%s owner keeps instance services and ordinary jobs across reconnect",
  async (protocolVersion) => {
    const { f, policy, start } = await instanceFixture(":memory:", protocolVersion);
    try {
      f.service.event(f.channel, {
        type: "state",
        jobId: start.request.jobId,
        requestDigest: start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "started",
      });
      f.service.offline(f.channel);
      f.commands.length = 0;
      prove(f);
      f.service.event(f.channel, {
        type: "service_ready",
        jobId: start.request.jobId,
        service: start.request.service!,
      });
      expect(
        f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }),
      ).toMatchObject({ state: "ready", connected: true });
      expect(f.service.jobs.cancellation(start.request.jobId)).toBeNull();
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      expect(execute(f, "ordinary").state).toBe("start-committed");
      expect(f.commands.findLast((command) => command.type === "start")).toMatchObject({
        request: { jobId: "ordinary" },
        permit: { ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation },
      });
    } finally {
      f.store.close();
    }
  },
);

test("v35 strict owner parser receives compatible operations only and bound-input work is refused by name", () => {
  const consumerId = `${pluginId}.consume`;
  const manifest: MachineHalf = {
    ...machine,
    operations: {
      ...machine.operations,
      [consumerId]: { ...machine.operations[operationId]!, inputs: ["material"] },
    },
  };
  const f = fixture(":memory:", manifest);
  try {
    const legacyOperation = z.strictObject({
      ...z.strictObject(MachineOperationSchema.shape).omit({ inputs: true, exports: true }).shape,
      limits: MachineOperationLimitsSchema.omit({ inputBytes: true }),
    });
    const legacyMachine = z.strictObject({
      ...MachineHalfSchema.shape,
      operations: z.record(z.string(), legacyOperation),
    });
    const legacyRequest = z.strictObject({
      ...JobRequestSchema.omit({ inputs: true }).shape,
      limits: JobLimitsSchema.omit({ inputBytes: true }),
    });
    const legacyStart = z.strictObject({
      ...JobStartCommandSchema.shape,
      request: legacyRequest,
    });
    const send = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "install") legacyMachine.parse(message.command.machine);
      if (message.command.type === "start") legacyStart.parse(message.command);
      return send(message);
    };
    f.owner.protocolVersion = 35;
    consent(f, "machines:run");
    prove(f);
    const described = f.service.describe(f.root, { machineId: f.machineId, pluginId });
    expect(described.operations?.[operationId]).toMatchObject({ ready: true, reason: null });
    expect(described.operations?.[consumerId]).toMatchObject({
      ready: false,
      reason: "bound_inputs_protocol_unsupported",
    });
    expect(() =>
      f.service.execute(f.root, pluginId, "trace", {
        jobId: "unsupported",
        machineId: f.machineId,
        operationId: consumerId,
        input: { value: "safe" },
        outputs: [],
      }),
    ).toThrow("bound_inputs_protocol_unsupported");
    expect(() =>
      f.service.execute(f.root, pluginId, "trace", {
        jobId: "new-limit",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        limits: { ...limits, inputBytes: 1024 },
      }),
    ).toThrow("bound_inputs_protocol_unsupported");
    expect(execute(f).state).toBe("start-committed");
    expect(f.service.jobs.get("unsupported")).toBeNull();
    expect(f.service.jobs.get("new-limit")).toBeNull();
  } finally {
    f.store.close();
  }
});

test("v35 owner refuses deferred bound-input operations without waiting for an impossible install", () => {
  const f = fixture(":memory:", {
    ...machine,
    operations: { [operationId]: { ...machine.operations[operationId]!, exports: [] } },
  });
  try {
    consent(f, "machines:run");
    expect(execute(f).state).toBe("queued");
    f.owner.protocolVersion = 35;
    prove(f);
    expect(f.service.jobs.get("job")?.state).toBe("refused");
    expect(
      f.commands.filter((command) => command.type === "install" || command.type === "start"),
    ).toEqual([]);
    expect(
      f.service.describe(f.root, { machineId: f.machineId, pluginId }).operations?.[operationId],
    ).toMatchObject({ ready: false, reason: "bound_inputs_protocol_unsupported" });
  } finally {
    f.store.close();
  }
});

test("older owner status and cancellation never replay unparsed fields or rewrite signed admission", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    consent(f, "jobs:read");
    consent(f, "jobs:cancel");
    prove(f);
    const job = f.service.execute(f.root, pluginId, "trace", {
      jobId: "newer-admission",
      machineId: f.machineId,
      operationId,
      input: { value: "safe" },
      outputs: [],
      limits: { ...limits, inputBytes: 1024 },
    });
    const admission = canonicalJobJson({ request: job.request, permit: job.permit });
    f.service.offline(f.channel);
    f.commands.length = 0;
    f.owner.protocolVersion = 35;
    const requestSchema = z.strictObject({
      ...JobRequestSchema.omit({ inputs: true }).shape,
      limits: JobLimitsSchema.omit({ inputBytes: true }),
    });
    const send = f.channel.send;
    f.channel.send = (message) => {
      const command = message.command;
      if ("admission" in command && command.admission)
        requestSchema.parse(command.admission.request);
      return send(message);
    };
    prove(f);
    const node = {
      kind: "job" as const,
      machineId: f.machineId,
      operationId,
      jobId: job.request.jobId,
    };
    expect(f.service.status(f.root, node).state).toBe("start-committed");
    f.service.cancel(f.root, node);
    expect(f.commands.findLast((command) => command.type === "cancel")).toMatchObject({
      type: "cancel",
      jobId: job.request.jobId,
    });
    const retained = f.service.jobs.get(job.request.jobId)!;
    expect(canonicalJobJson({ request: retained.request, permit: retained.permit })).toBe(
      admission,
    );
  } finally {
    f.store.close();
  }
});

test("enabled owner-proved services remint revoked credentials and return ready in one reconcile", async () => {
  const { f, policy, start, revision } = await instanceFixture();
  const ready = (command: Extract<JobCommand, { type: "start" }>) => {
    f.service.event(f.channel, {
      type: "state",
      jobId: command.request.jobId,
      requestDigest: command.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    f.service.event(f.channel, {
      type: "service_ready",
      jobId: command.request.jobId,
      service: command.request.service!,
    });
  };
  try {
    ready(start);
    const describe = () =>
      f.service.describeInstanceService(f.root, { serviceId: policy.serviceId });
    expect(describe().state).toBe("ready");
    expect(() => f.auth.revokePrincipal(start.request.credential.principalId, f.root)).toThrow(
      "service_credential_managed_by_service",
    );
    expect(describe().state).toBe("ready");
    const originalGrants = f.store
      .listGrants({ principalId: start.request.credential.principalId })
      .map(({ node, caps, effect, reach }) => ({ node, caps, effect, reach }));
    const send = f.channel.send;
    f.channel.send = (message) => {
      send(message);
      const command = message.command;
      if (command.type === "cancel" && command.jobId === start.request.jobId) {
        f.service.event(f.channel, {
          type: "result",
          result: {
            jobId: start.request.jobId,
            requestDigest: start.request.requestDigest,
            ownerId: f.owner.ownerId,
            ownerGeneration: f.owner.generation,
            state: "cancelled",
            exitCode: null,
            reason: command.reason,
            startedAt: f.runtime.now(),
            finishedAt: f.runtime.now(),
            usage: null,
            limits: start.request.limits,
            outputs: [],
          },
        });
        f.service.event(f.channel, {
          type: "workload_empty",
          jobId: start.request.jobId,
          requestDigest: start.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
        });
      }
      if (command.type === "start") ready(command);
      return true;
    };
    f.store.revokeToken(start.request.credential.tokenId!, f.runtime.now());
    expect(f.auth.restoreCredential(start.request.credential)).toBeNull();
    f.service.tick();
    const repaired = f.service.instanceServices.get(policy.serviceId)!;
    expect(repaired.revision).toBe(revision);
    expect(repaired.policy).toEqual(policy);
    expect(repaired.credential!.tokenId).not.toBe(start.request.credential.tokenId);
    expect(f.auth.restoreCredential(repaired.credential!)?.principal.kind).toBe("service");
    expect(
      f.store
        .listGrants({ principalId: repaired.credential!.principalId })
        .map(({ node, caps, effect, reach }) => ({ node, caps, effect, reach })),
    ).toEqual(originalGrants);
    expect(describe().state).toBe("ready");
    const events = () =>
      f.store.db
        .query<{ payload: string }, []>(
          "SELECT payload FROM events WHERE type='service_credential_reminted'",
        )
        .all()
        .map((row) => JSON.parse(row.payload) as unknown);
    expect(events()).toEqual([
      {
        serviceId: policy.serviceId,
        machineId: f.machineId,
        previousTokenId: start.request.credential.tokenId,
      },
    ]);
    f.service.tick();
    expect(f.service.instanceServices.get(policy.serviceId)!.credential).toEqual(
      repaired.credential,
    );
    expect(events()).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test.each(["disabled", "unproved", "replacing", "uninstalling"] as const)(
  "%s instance services never remint revoked credentials",
  async (state) => {
    const { f, policy, start, revision } = await instanceFixture();
    try {
      if (state === "disabled" || state === "replacing")
        await f.service.configureInstanceService(f.root, {
          serviceId: policy.serviceId,
          expectedRevision: revision,
          policy: state === "replacing" ? { ...policy, revision: "replacement" } : policy,
          enabled: state !== "disabled",
        });
      if (state === "unproved") f.service.offline(f.channel);
      if (state === "uninstalling") f.service.disablePlugin(pluginId);
      const current = f.service.instanceServices.get(policy.serviceId)!;
      const credential = current.credential ?? start.request.credential;
      f.store.revokeToken(credential.tokenId!, f.runtime.now());
      f.service.tick();
      expect(f.service.instanceServices.get(policy.serviceId)!.credential).toEqual(
        current.credential,
      );
      expect(
        f.store.db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM events WHERE type='service_credential_reminted'",
          )
          .get()!.count,
      ).toBe(0);
    } finally {
      f.store.close();
    }
  },
);

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
    const refused = f.commands.at(-1);
    expect(refused).toMatchObject({
      type: "invocation_reply",
      invocationId: "late-grandchild",
      jobId: null,
    });
    // The machine learns which check refused it. Every reason `invoke` decides was previously
    // replaced by the constant "invocation_refused", which a workload only saw as a 503.
    expect(refused?.type === "invocation_reply" ? refused.reason : null).not.toBe(
      "invocation_refused",
    );
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
      else if (cause === "credential") {
        f.store.revokeToken(start.request.credential.tokenId!, f.runtime.now());
        f.service.tick();
      } else if (cause === "executor") {
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

test("outside-set retirement requires a drained exact pinned identity, not a version allowlist", () => {
  const f = fixture();
  try {
    f.service.jobs.pinOwner(f.machineId, f.owner);
    const legacy = { ...f.owner, protocolVersion: 1 };
    const challenged = (owner: JobOwner): boolean => {
      f.commands.length = 0;
      f.service.online(f.channel, owner, "retirement-epoch");
      return f.commands.some((command) => command.type === "owner_challenge");
    };
    expect(challenged(legacy)).toBe(false);
    f.store.setMachineDraining(f.machineId, true);
    expect(challenged({ ...legacy, publicKey: "other-key" })).toBe(false);
    expect(challenged({ ...legacy, generation: legacy.generation + 1 })).toBe(false);
    expect(challenged({ ...legacy, ownerId: "other-owner" })).toBe(false);
    expect(challenged(legacy)).toBe(true);
    expect(challenged({ ...legacy, protocolVersion: JOB_OWNER_PROTOCOL_VERSION + 1 })).toBe(true);
  } finally {
    f.store.close();
  }
});

test.each([1, JOB_OWNER_PROTOCOL_VERSION + 1])(
  "outside-set v%s owner can only finish durably cancelled work",
  async (protocolVersion) => {
    const { f, policy, start, revision } = await instanceFixture();
    try {
      const uncancelled = execute(f, "uncancelled");
      f.service.event(f.channel, {
        type: "state",
        jobId: start.request.jobId,
        requestDigest: start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "started",
      });
      await f.service.configureInstanceService(f.root, {
        serviceId: policy.serviceId,
        expectedRevision: revision,
        policy,
        enabled: false,
      });
      const node = {
        kind: "job" as const,
        machineId: f.machineId,
        operationId,
        jobId: start.request.jobId,
      };
      f.service.cancel(f.root, node);
      f.store.setMachineDraining(f.machineId, true);
      f.service.offline(f.channel);
      f.commands.length = 0;

      const legacy = { ...f.owner, protocolVersion };
      f.service.online(f.channel, legacy, "retirement-epoch");
      const challenge = f.commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      f.service.cancel(f.root, node);
      expect(f.commands.map((command) => command.type)).toEqual(["owner_challenge"]);
      const body = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId: f.machineId,
        owner: legacy,
      };
      f.service.event(f.channel, {
        type: "owner_proof",
        ...body,
        signature: sign(null, Buffer.from(canonicalJobJson(body)), f.privateKey).toString("base64"),
      });
      expect(() => execute(f, "new-work")).toThrow("owner_protocol_unsupported");
      expect(f.service.jobs.get("new-work")).toBeNull();
      f.service.event(f.channel, {
        type: "workload_empty",
        jobId: uncancelled.request.jobId,
        requestDigest: uncancelled.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
      });
      expect(f.service.jobs.get(uncancelled.request.jobId)?.ownerClosed).toBe(false);

      expect(f.commands.map((command) => command.type)).toEqual([
        "owner_challenge",
        "drain",
        "status",
        "cancel",
      ]);
      expect(f.commands.at(-1)).toMatchObject({
        type: "cancel",
        jobId: start.request.jobId,
      });
      expect(f.commands.at(-1)).not.toHaveProperty("admission");
      expect(
        f.commands.some((command) =>
          ["install", "configure_services", "start"].includes(command.type),
        ),
      ).toBe(false);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId })).toMatchObject({
        connected: false,
        platforms: [],
        installation: { ready: false },
      });

      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      });
      f.service.event(f.channel, {
        type: "service_ready",
        jobId: start.request.jobId,
        service: start.request.service!,
      });
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId })).toMatchObject({
        connected: false,
        installation: { ready: false },
      });
      f.service.event(f.channel, {
        type: "result",
        result: {
          jobId: start.request.jobId,
          requestDigest: start.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "started",
          exitCode: null,
          reason: null,
          startedAt: f.runtime.now(),
          finishedAt: null,
          usage: null,
          limits: start.request.limits,
          outputs: [],
        },
      });
      expect(f.service.jobs.get(start.request.jobId)?.state).toBe("started");
      const empty = {
        type: "workload_empty" as const,
        jobId: start.request.jobId,
        requestDigest: start.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
      };
      f.service.event(f.channel, { ...empty, ownerGeneration: f.owner.generation + 1 });
      expect(f.service.jobs.get(start.request.jobId)?.ownerClosed).toBe(false);
      f.service.event(f.channel, empty);
      expect(f.service.jobs.get(start.request.jobId)?.ownerClosed).toBe(true);
      f.service.offline(f.channel);
      f.commands.length = 0;
      f.service.online(f.channel, legacy, "result-replay-epoch");
      const replayChallenge = f.commands.at(-1);
      if (replayChallenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const replayBody = {
        nonce: replayChallenge.nonce,
        serverEpoch: replayChallenge.serverEpoch,
        machineId: f.machineId,
        owner: legacy,
      };
      f.service.event(f.channel, {
        type: "owner_proof",
        ...replayBody,
        signature: sign(null, Buffer.from(canonicalJobJson(replayBody)), f.privateKey).toString(
          "base64",
        ),
      });
      expect(f.commands.map((command) => command.type)).toEqual([
        "owner_challenge",
        "drain",
        "status",
      ]);
      expect(f.commands.at(-1)).not.toHaveProperty("admission");
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
      expect(f.service.jobs.get(start.request.jobId)).toMatchObject({
        state: "exited",
        ownerClosed: true,
      });
      expect(f.service.describeInstanceService(f.root, { serviceId: policy.serviceId }).state).toBe(
        "stopped",
      );
    } finally {
      f.store.close();
    }
  },
);

test("installation acknowledgement requires proof on both initial connection and reconnect", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    for (const jobId of ["before-first-proof", "before-reconnect-proof"]) {
      f.commands.length = 0;
      f.service.online(f.channel, f.owner, "epoch");
      const challenge = f.commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      expect(execute(f, jobId).state).toBe("queued");
      const installed = {
        type: "installed" as const,
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      };
      f.service.event(f.channel, installed);
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.ready,
      ).toBe(false);
      expect(
        f.commands.filter((command) => command.type === "install" || command.type === "start"),
      ).toEqual([]);
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
      expect(f.commands.find((command) => command.type === "install")).toMatchObject({
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      });
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.ready,
      ).toBe(false);
      expect(f.service.jobs.get(jobId)?.state).toBe("queued");
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
      f.service.event(f.channel, installed);
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.ready,
      ).toBe(true);
      expect(f.service.jobs.get(jobId)?.state).toBe("start-committed");
      expect(
        f.commands
          .filter((command) => command.type === "start")
          .map((command) => command.request.jobId),
      ).toEqual([jobId]);
    }
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

const bounded: MachineHalf = {
  ...machine,
  operations: {
    [operationId]: {
      ...machine.operations[operationId]!,
      limits: { ...limits, concurrentJobs: 2 },
    },
  },
};

test("a declared concurrency refuses the execute over an operation's ceiling until a job settles", () => {
  const f = fixture(":memory:", bounded);
  try {
    consent(f, "machines:run");
    prove(f);
    const first = execute(f, "one");
    const second = execute(f, "two");
    expect([first.state, second.state]).toEqual(["start-committed", "start-committed"]);
    const refused = execute(f, "three");
    expect(refused.state).toBe("refused");
    expect(f.service.jobs.authority(refused).decision?.refusal).toBe("concurrency_limit");
    expect(
      f.commands.some((command) => command.type === "start" && command.request.jobId === "three"),
    ).toBe(false);
    f.service.event(f.channel, {
      type: "result",
      result: {
        jobId: first.request.jobId,
        requestDigest: first.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "exited",
        exitCode: 0,
        reason: null,
        startedAt: f.runtime.now(),
        finishedAt: f.runtime.now(),
        usage: null,
        limits: first.request.limits,
        outputs: [],
      },
    });
    const fourth = execute(f, "four");
    expect(fourth.state).toBe("start-committed");
    expect(
      f.commands.some((command) => command.type === "start" && command.request.jobId === "four"),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});

test("an operation that declares no concurrency admits every job its caller posts", () => {
  const f = fixture();
  try {
    consent(f, "machines:run");
    prove(f);
    for (const jobId of ["one", "two", "three"]) {
      expect(execute(f, jobId).state).toBe("start-committed");
    }
    expect(f.commands.filter((command) => command.type === "start").length).toBe(3);
  } finally {
    f.store.close();
  }
});

test("a schedule occurrence at the ceiling is refused, not started beside the jobs holding it", () => {
  const f = fixture(":memory:", bounded);
  try {
    for (const cap of ["machines:run", "jobs:read"] as const) consent(f, cap);
    prove(f);
    expect([execute(f, "one").state, execute(f, "two").state]).toEqual([
      "start-committed",
      "start-committed",
    ]);
    f.service.schedule(f.root, pluginId, "trace-1", {
      jobId: "template",
      machineId: f.machineId,
      operationId,
      input: { value: "safe" },
      outputs: [],
      scheduleId: "beat",
      revision: "r1",
      firstNominalAt: f.runtime.now(),
      intervalMs: 100,
      deadlineMs: 50,
      expiresAt: f.runtime.now() + 1000,
      offlinePolicy: "skip",
    });
    f.service.tick();
    const occurrence = f.service
      .listRuns(f.root, pluginId, { machineId: f.machineId })
      .runs.find((row) => row.occurrence)!.occurrence!;
    const scheduled = f.service.jobs.get(occurrence.jobId)!;
    expect(scheduled.state).toBe("refused");
    expect(f.service.jobs.authority(scheduled).decision?.refusal).toBe("concurrency_limit");
    expect(
      f.commands.some(
        (command) => command.type === "start" && command.request.jobId === occurrence.jobId,
      ),
    ).toBe(false);
  } finally {
    f.store.close();
  }
});

test("proved reconnect admits queued work in durable reservation order at the concurrency ceiling", () => {
  const f = fixture(":memory:", bounded);
  try {
    for (const cap of ["machines:run", "jobs:read"] as const) consent(f, cap);
    f.service.offline(f.channel);
    expect([execute(f, "A").state, execute(f, "B").state]).toEqual(["queued", "queued"]);

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

    f.service.schedule(f.root, pluginId, "trace-1", {
      jobId: "template",
      machineId: f.machineId,
      operationId,
      input: { value: "safe" },
      outputs: [],
      scheduleId: "S",
      revision: "r1",
      firstNominalAt: f.runtime.now(),
      intervalMs: 100,
      deadlineMs: 50,
      expiresAt: f.runtime.now() + 1000,
      offlinePolicy: "skip",
    });
    f.service.tick();
    const occurrence = f.service
      .listRuns(f.root, pluginId, { machineId: f.machineId })
      .runs.find((row) => row.occurrence)!.occurrence!;
    expect(f.service.jobs.get(occurrence.jobId)?.state).toBe("queued");
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);

    f.service.event(f.channel, {
      type: "installed",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
    });
    expect(
      f.commands
        .filter((command) => command.type === "start")
        .map((command) => command.request.jobId),
    ).toEqual(["A", "B"]);
    expect([f.service.jobs.get("A")?.state, f.service.jobs.get("B")?.state]).toEqual([
      "start-committed",
      "start-committed",
    ]);
    const scheduled = f.service.jobs.get(occurrence.jobId)!;
    expect(scheduled.state).toBe("refused");
    expect(f.service.jobs.authority(scheduled).decision?.refusal).toBe("concurrency_limit");

    const admittedA = f.service.jobs.get("A")!;
    const retriedA = execute(f, "A");
    expect(retriedA.state).toBe("start-committed");
    expect(retriedA.permit).toEqual(admittedA.permit);
    expect(
      f.commands
        .filter((command) => command.type === "start")
        .map((command) => command.request.jobId),
    ).toEqual(["A", "B"]);
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
      machineId: f.machineId,
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
        { ...runtime, machineId: "another-machine" },
        f.machineId,
        binding,
        traceId,
      ),
    ).toThrow("terminal_runtime_destination_changed");
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
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
        principal: { name: "terminal-opener", kind: "human" },
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

test("terminal restart re-admits fresh runtime under current home write authority", () => {
  const f = fixture(":memory:", {
    ...machine,
    operations: {
      [operationId]: {
        ...machine.operations[operationId]!,
        limits: { ...limits, concurrentJobs: 1 },
      },
    },
  });
  try {
    consent(f, "machines:run");
    f.owner.terminalHostId = "native-host";
    prove(f);
    const terminal = { terminalId: "restart", terminalHostId: "native-host", containerId: "home" };
    const runtime = {
      machineId: f.machineId,
      pluginId,
      operationId,
      installationRevision: "r1",
      artifactSha256: hash,
      resourceBindingDigest: createHash("sha256").update("null").digest("hex"),
      input: { value: "safe" },
    };
    f.store.createContainer({
      id: "home",
      name: "terminal",
      discipline: "composition",
      createdAt: 0,
    });
    f.store.createTerminal({
      id: terminal.terminalId,
      machineId: f.machineId,
      containerId: "home",
      createdBy: f.root.principal.id,
      agentPrincipalId: null,
      createdAt: 0,
      launchRecipe: { cols: 80, rows: 24, env: {}, runtime },
    });
    const grant = f.auth.mintToken(
      {
        principal: { name: "restart-writer", kind: "human" },
        caps: ["terminals:write", "machines:run"],
      },
      f.root,
    );
    const writer = f.auth.authenticate(grant.token);
    const traceId = f.store.appendTrace({
      actor: writer.principal.id,
      authority: "terminals:write",
      door: "core.terminals.restart",
      containerId: null,
      session: null,
      ts: 0,
      outcome: null,
      targets: [],
      payload: { terminalId: "restart" },
    });
    expect(() =>
      f.service.admitTerminal(
        writer,
        { ...runtime, input: { value: "substituted" } },
        f.machineId,
        terminal,
        traceId,
      ),
    ).toThrow("terminal_restart_recipe_changed");
    expect(() =>
      f.service.admitTerminal(
        writer,
        runtime,
        f.machineId,
        { ...terminal, terminalId: "another" },
        traceId,
      ),
    ).toThrow("terminal_restart_recipe_changed");
    const first = f.service.admitTerminal(writer, runtime, f.machineId, terminal, traceId);
    const second = f.service.admitTerminal(writer, runtime, f.machineId, terminal, traceId);
    expect(second.request.jobId).not.toBe(first.request.jobId);
    expect(second.permit).not.toEqual(first.permit);
    f.service.cancelTerminal(terminal.terminalId, second.request.jobId);
    expect(
      f.commands.filter((command) => command.type === "cancel").map((command) => command.jobId),
    ).toEqual([second.request.jobId]);
    f.auth.grant(
      {
        principal: { kind: "principal", id: writer.principal.id },
        node: formatManifoldUri({ kind: "container", containerId: "home" }),
        caps: ["terminals:write"],
        effect: "deny",
        reach: "node",
      },
      f.root,
    );
    expect(() =>
      f.service.admitTerminal(writer, runtime, f.machineId, terminal, traceId),
    ).toThrow();
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
        { principal: { name: "run-reader", kind: "human" }, caps: ["jobs:read"] },
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
        { principal: { name: "scoped", kind: "human" }, caps: ["jobs:read"] },
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
          principal: { name: "runner", kind: "human" },
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
          principal: { name: "runner", kind: "human" },
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
          principal: { name: "replay-runner", kind: "human" },
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

  /** The owner's facts for one job, the shape every job event repeats. */
  function identity(job: JobRecord) {
    return {
      jobId: job.request.jobId,
      requestDigest: job.request.requestDigest,
      ownerId: "test-owner",
      ownerGeneration: 1,
    };
  }

  test("a running workload's stage reaches a follower live and the journal after settle", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const updates: JobFollowUpdate[] = [];
      const follow = f.service.follow(f.root, node, (update) => updates.push(update));
      f.service.event(f.channel, { type: "state", ...identity(job), state: "started" });
      f.service.event(f.channel, {
        type: "job_progress",
        ...identity(job),
        stage: "at the model",
        message: "drawing evr_85c8994c",
        fraction: 0.25,
        at: 1757770000000,
      });
      expect(updates.flatMap((u) => (u.type === "event" ? [u.event.type] : []))).toEqual([
        "state",
        "job_progress",
      ]);
      expect(updates.at(-1)).toMatchObject({
        type: "event",
        event: {
          type: "job_progress",
          stage: "at the model",
          message: "drawing evr_85c8994c",
          fraction: 0.25,
          at: 1757770000000,
        },
      });
      follow.close();
      settle(f, job);
      const page = f.service.journal(f.root, node, 0, 64);
      expect(page.events.map((frame) => frame.event.type)).toEqual([
        "state",
        "job_progress",
        "result",
      ]);
    } finally {
      f.store.close();
    }
  });

  test("a stage for a job the hub has not seen start is dropped, live and durably", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const job = execute(f);
      consent(f, "jobs:read");
      const node = { kind: "job" as const, machineId: f.machineId, operationId, jobId: "job" };
      const updates: JobFollowUpdate[] = [];
      const follow = f.service.follow(f.root, node, (update) => updates.push(update));
      expect(f.service.jobs.get("job")?.state).toBe("start-committed");
      f.service.event(f.channel, {
        type: "job_progress",
        ...identity(job),
        stage: "at the model",
        at: 1757770000000,
      });
      expect(updates).toEqual([]);
      follow.close();
      f.service.event(f.channel, { type: "state", ...identity(job), state: "started" });
      settle(f, job);
      expect(
        f.service.journal(f.root, node, 0, 64).events.map((frame) => frame.event.type),
      ).toEqual(["state", "result"]);
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

describe("metered inference journal and ceilings", () => {
  const ceiling = { calls: 4, costMicros: 50_000 } as const;
  const metered: MachineHalf = {
    ...machine,
    operations: {
      [operationId]: {
        ...machine.operations[operationId]!,
        limits: { ...limits, inference: ceiling },
      },
    },
  };
  const node = (f: Fixture) => ({
    kind: "job" as const,
    machineId: f.machineId,
    operationId,
    jobId: "job",
  });
  /** A job the owner has confirmed running: the only state a metered call can be reported for. */
  function started(f: Fixture): JobRequest {
    consent(f, "machines:run");
    prove(f);
    const job = execute(f);
    f.service.event(f.channel, {
      type: "state",
      state: "started",
      jobId: "job",
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
    });
    return job.request;
  }
  function facts(f: Fixture, request: JobRequest) {
    return {
      jobId: "job",
      requestDigest: request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      serviceId: "atyrode.babel.inference",
    };
  }
  const usage = {
    calls: 1,
    inputTokens: 1200,
    outputTokens: 340,
    cachedInputTokens: 200,
    costMicros: 4200,
  };
  function call(
    f: Fixture,
    request: JobRequest,
    overrides: Record<string, unknown> = {},
  ): JobEvent {
    return {
      type: "inference_call",
      ...facts(f, request),
      operationId: "chat",
      model: "openai/gpt-5",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      costMicros: usage.costMicros,
      elapsedMs: 812,
      status: 200,
      ...overrides,
    } as JobEvent;
  }
  /** Settles the job so the retained journal becomes readable, carrying `usage.inference`. */
  function settle(f: Fixture, request: JobRequest, inference?: typeof usage): void {
    f.service.event(f.channel, {
      type: "result",
      result: {
        jobId: "job",
        requestDigest: request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "exited",
        exitCode: 0,
        reason: null,
        startedAt: 0,
        finishedAt: 7,
        usage: {
          elapsedMs: 1,
          memoryBytes: 1,
          processes: 1,
          outputBytes: 0,
          ...(inference ? { inference } : {}),
        },
        limits: request.limits,
        outputs: [],
      },
    });
  }

  test("a metered call and a ceiling refusal reach a live follower and the retained journal", () => {
    const f = fixture();
    try {
      const request = started(f);
      consent(f, "jobs:read");
      const updates: JobFollowUpdate[] = [];
      const follow = f.service.follow(f.root, node(f), (update) => updates.push(update));
      f.service.event(f.channel, call(f, request));
      f.service.event(f.channel, {
        type: "inference_ceiling",
        ...facts(f, request),
        operationId: "chat",
        ceiling: "costMicros",
        reached: usage,
      });
      expect(
        updates.map((update) => (update.type === "event" ? update.event.type : update.type)),
      ).toEqual(["inference_call", "inference_usage", "inference_ceiling"]);
      const delivered = updates[0];
      if (delivered?.type !== "event" || delivered.event.type !== "inference_call")
        throw new Error("metered call missing from the follow stream");
      // The numbers a follower reads are the owner's, unrounded and unsummarised.
      expect(delivered.event).toMatchObject({
        model: "openai/gpt-5",
        inputTokens: 1200,
        outputTokens: 340,
        cachedInputTokens: 200,
        costMicros: 4200,
        status: 200,
      });
      follow.close();
      settle(f, request);
      expect(
        f.service.journal(f.root, node(f), 0, 64).events.map((frame) => frame.event.type),
      ).toEqual(["state", "inference_call", "inference_ceiling", "result"]);
    } finally {
      f.store.close();
    }
  });

  test("five hundred metered calls retain an exact durable total outside the bounded journal", () => {
    const dir = mkdtempSync(join(tmpdir(), "job-inference-usage-"));
    const path = join(dir, "hub.sqlite");
    const f = fixture(path);
    try {
      const request = started(f);
      consent(f, "jobs:read");
      const total = (calls: number) => ({
        calls,
        inputTokens: (calls * (calls + 1)) / 2,
        outputTokens: (calls * (calls + 1)) / 2 + calls,
        cachedInputTokens: Math.floor((calls * calls) / 4),
        costMicros: calls * (calls + 1),
        lastModel: `openai/gpt-${calls}`,
      });
      const report = (index: number) =>
        f.service.event(
          f.channel,
          call(f, request, {
            model: `openai/gpt-${index}`,
            inputTokens: index,
            outputTokens: index + 1,
            cachedInputTokens: Math.floor(index / 2),
            costMicros: index * 2,
          }),
        );
      for (let index = 1; index <= 400; index++) report(index);

      // Recreate the service so the late follower can only learn the total from durable state.
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
      f.commands.length = 0;
      prove(f);
      const updates: JobFollowUpdate[] = [];
      const follow = f.service.follow(f.root, node(f), (update) => updates.push(update));
      expect(follow.snapshot.inferenceUsage).toEqual(total(400));

      report(401);
      const firstCall = updates[0];
      if (firstCall?.type !== "event" || firstCall.event.type !== "inference_call")
        throw new Error("metered call 401 missing from the follow stream");
      expect(firstCall.event.model).toBe("openai/gpt-401");
      expect(updates[1]).toEqual({
        type: "inference_usage",
        inferenceUsage: total(401),
      });
      expect(updates).toHaveLength(2);

      for (let index = 402; index <= 500; index++) report(index);
      expect(updates).toHaveLength(200);
      for (let offset = 0; offset < 100; offset++) {
        const index = offset + 401;
        const delivered = updates[offset * 2];
        if (delivered?.type !== "event" || delivered.event.type !== "inference_call")
          throw new Error(`metered call ${index} missing or out of order`);
        expect(delivered.event.model).toBe(`openai/gpt-${index}`);
        expect(updates[offset * 2 + 1]).toEqual({
          type: "inference_usage",
          inferenceUsage: total(index),
        });
      }
      follow.close();

      const exact = total(500);
      const settledUsage = {
        calls: exact.calls,
        inputTokens: exact.inputTokens,
        outputTokens: exact.outputTokens,
        cachedInputTokens: exact.cachedInputTokens,
        costMicros: exact.costMicros,
      };
      settle(f, request, settledUsage);
      const page = f.service.journal(f.root, node(f), 0, 128);
      expect(page.events).toHaveLength(128);
      expect(page.firstSeq).toBe(375);
      expect(page.events[0]).toMatchObject({
        seq: 375,
        event: { type: "inference_call", model: "openai/gpt-374" },
      });
      expect(page.inferenceUsage).toEqual(exact);
      expect(f.service.status(f.root, node(f)).result?.usage?.inference).toEqual(settledUsage);
      expect(f.service.status(f.root, node(f)).result?.usage?.inference).not.toHaveProperty(
        "lastModel",
      );
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a metered call is ignored on a wrong digest, a stale generation and another machine's channel", () => {
    const f = fixture();
    try {
      const request = started(f);
      consent(f, "jobs:read");
      f.service.event(f.channel, call(f, request, { requestDigest: "c".repeat(64) }));
      f.service.event(f.channel, call(f, request, { ownerGeneration: f.owner.generation + 1 }));
      // A second proved machine is still not this job's owner: the fact is bound to the run.
      const other = f.auth.enrollMachine("other", f.root).machine.id;
      const commands: JobCommand[] = [];
      const channel = {
        machineId: other,
        send: (message: { type: "job_command"; command: JobCommand }) => {
          commands.push(message.command);
          return true;
        },
      };
      const pair = generateKeyPairSync("ed25519");
      const owner: JobOwner = {
        ...f.owner,
        ownerId: "other-owner",
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      };
      f.service.online(channel, owner, "epoch");
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const body = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId: other,
        owner,
      };
      f.service.event(channel, {
        type: "owner_proof",
        ...body,
        signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString(
          "base64",
        ),
      });
      f.service.event(channel, call(f, request));
      settle(f, request);
      expect(
        f.service.journal(f.root, node(f), 0, 64).events.map((frame) => frame.event.type),
      ).toEqual(["state", "result"]);
    } finally {
      f.store.close();
    }
  });

  test("a metered call for a job the owner never started is ignored", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      const job = execute(f);
      expect(job.state).toBe("queued");
      consent(f, "jobs:read");
      const updates: JobFollowUpdate[] = [];
      f.service.follow(f.root, node(f), (update) => updates.push(update));
      prove(f);
      // Admitted and committed, but no owner `started`: a call before the run exists is not a fact.
      f.service.event(f.channel, call(f, job.request));
      expect(f.service.jobs.get("job")?.state).toBe("start-committed");
      expect(updates).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("a declared inference ceiling survives a request that omits one and cannot be raised", () => {
    const f = fixture(":memory:", metered);
    try {
      consent(f, "machines:run");
      prove(f);
      f.service.execute(f.root, pluginId, "trace-1", {
        jobId: "job",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        limits,
      });
      expect(f.service.jobs.get("job")?.request.limits.inference).toEqual(ceiling);
      expect(() =>
        f.service.execute(f.root, pluginId, "trace-1", {
          jobId: "over",
          machineId: f.machineId,
          operationId,
          input: { value: "safe" },
          outputs: [],
          limits: { ...limits, inference: { calls: 4, costMicros: 50_001 } },
        }),
      ).toThrow("limit_exceeded");
      // Naming only one of a declared pair drops the other, which is raising it.
      expect(() =>
        f.service.execute(f.root, pluginId, "trace-1", {
          jobId: "partial",
          machineId: f.machineId,
          operationId,
          input: { value: "safe" },
          outputs: [],
          limits: { ...limits, inference: { calls: 1 } },
        }),
      ).toThrow("limit_exceeded");
      f.service.execute(f.root, pluginId, "trace-1", {
        jobId: "lower",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        limits: { ...limits, inference: { calls: 1, costMicros: 10 } },
      });
      expect(f.service.jobs.get("lower")?.request.limits.inference).toEqual({
        calls: 1,
        costMicros: 10,
      });
    } finally {
      f.store.close();
    }
  });

  test("an operation declaring no ceiling still accepts a caller's own", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      f.service.execute(f.root, pluginId, "trace-1", {
        jobId: "job",
        machineId: f.machineId,
        operationId,
        input: { value: "safe" },
        outputs: [],
        limits: { ...limits, inference: { costMicros: 250_000 } },
      });
      expect(f.service.jobs.get("job")?.request.limits.inference).toEqual({ costMicros: 250_000 });
    } finally {
      f.store.close();
    }
  });

  test("settled inference totals survive storage and reach status and the journal unchanged", () => {
    const f = fixture();
    try {
      const request = started(f);
      consent(f, "jobs:read");
      settle(f, request, usage);
      expect(f.service.status(f.root, node(f)).result?.usage?.inference).toEqual(usage);
      expect(f.service.publicJob(f.service.jobs.get("job")!).result?.usage?.inference).toEqual(
        usage,
      );
      const settled = f.service.journal(f.root, node(f), 0, 64).events.at(-1)?.event;
      if (settled?.type !== "result") throw new Error("settled result missing from the journal");
      expect(settled.result.usage?.inference).toEqual(usage);
    } finally {
      f.store.close();
    }
  });
});

describe("reviewed native deployment approvals", () => {
  function request(
    f: Fixture,
    deploymentId: string,
    operationIds: string[] = [],
  ): JobDeploymentRequest {
    return {
      deploymentId,
      pluginId,
      targets: [{ machineId: f.machineId, platform: "linux-x64" }],
      operationIds,
    };
  }
  function apply(f: Fixture, value: JobDeploymentRequest) {
    const review = f.service.reviewDeployment(f.root, value);
    return {
      review,
      deployment: f.service.applyDeployment(
        f.root,
        { request: value, reviewDigest: review.reviewDigest },
        "deployment-trace",
      ),
    };
  }
  function replacement(f: Fixture): MachineHalf {
    const next = structuredClone(machine);
    next.artifacts["linux-x64"]!.sha256 = "c".repeat(64);
    next.artifacts["linux-x64"]!.entrySha256 = "c".repeat(64);
    f.service.setManifestResolver((id) => (id === pluginId ? next : null));
    return next;
  }
  function boundFixture() {
    const f = fixture();
    f.owner.resources = {
      tools: { node: "d".repeat(64) },
      services: {},
      anchors: {},
      serviceDefinitions: {},
    };
    prove(f);
    const bound = structuredClone(machine);
    bound.requiresResourceBindings = true;
    bound.operations[operationId]!.runtimeTools = ["node"];
    f.service.setManifestResolver((id) => (id === pluginId ? bound : null));
    f.service.install(f.root, {
      machineId: f.machineId,
      pluginId,
      installationRevision: "bound",
      artifactSha256: hash,
      machine: bound,
      resourceBindings: { tools: { node: "d".repeat(64) }, services: {}, anchors: {} },
    });
    f.service.offline(f.channel);
    f.commands.length = 0;
    return { f, bound };
  }

  function runtimeDeploymentFixture() {
    const locationId = `${pluginId}.data`;
    const provider: MachineHalf = {
      ...machine,
      locations: {
        [locationId]: { anchor: "data", components: ["runtime"], revision: "data-r1" },
      },
      operations: {
        [operationId]: {
          ...machine.operations[operationId]!,
          providesService: true,
          locations: [{ locationId, access: "read" }],
        },
      },
    };
    const f = fixture(":memory:", provider);
    const callerPlugin = "sample.consumer";
    const selectedOperation = `${callerPlugin}.run`;
    const unselectedOperation = `${callerPlugin}.other`;
    const policy: ServicePolicy = {
      serviceId: "sample.service",
      revision: "service-r1",
      maxConcurrent: 1,
      runtime: {
        pluginId,
        operationId,
        installationRevision: "r1",
        artifactSha256: hash,
        resourceBindingDigest: createHash("sha256").update(canonicalJobJson(null)).digest("hex"),
        input: { value: { literal: "serve" } },
      },
      operations: {
        inspect: {
          kind: "http-proxy",
          method: "GET",
          path: "/inspect",
          request: { kind: "none" },
          response: {
            kind: "stream",
            disclosure: "full",
            contentTypes: ["application/json"],
            headers: [],
          },
          timeoutMs: 1000,
          maxRequestBytes: 1024,
          maxResponseBytes: 4096,
        },
      },
    };
    const callerOperation = {
      ...machine.operations[operationId]!,
      services: [
        { serviceId: policy.serviceId, revision: policy.revision, operationIds: ["inspect"] },
      ],
    };
    const consumer: MachineHalf = {
      ...machine,
      operations: {
        [selectedOperation]: callerOperation,
        [unselectedOperation]: callerOperation,
      },
    };
    f.service.setManifestResolver((id) =>
      id === pluginId ? provider : id === callerPlugin ? consumer : null,
    );
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: null,
      policies: [policy],
    });
    f.owner.resources = {
      tools: {},
      anchors: {},
      services: {
        [policy.serviceId]: createHash("sha256").update(canonicalJobJson(policy)).digest("hex"),
      },
      serviceDefinitions: {
        [policy.serviceId]: { revision: policy.revision, operationIds: ["inspect"] },
      },
    };
    consent(f, "machines:run");
    consent(f, "operations:invoke");
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
      node: formatManifoldUri({ kind: "location", machineId: f.machineId, locationId }),
      cap: "locations:read",
      enabled: true,
    });
    prove(f);
    f.service.event(f.channel, {
      type: "installed",
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
      resources: {
        artifactAvailable: true,
        tools: [],
        operations: [{ operationId, available: true }],
      },
    });
    const value: JobDeploymentRequest = {
      deploymentId: "first-runtime-install",
      pluginId: callerPlugin,
      targets: [{ machineId: f.machineId, platform: "linux-x64" }],
      operationIds: [selectedOperation],
    };
    const acknowledge = () => {
      const install = f.service.jobs.installation(f.machineId, callerPlugin)!;
      f.service.event(f.channel, {
        type: "installed",
        pluginId: callerPlugin,
        installationRevision: install.revision,
        artifactSha256: install.artifact,
        resources: {
          artifactAvailable: true,
          tools: [],
          operations: [
            { operationId: selectedOperation, available: true },
            { operationId: unselectedOperation, available: true },
          ],
        },
      });
    };
    f.commands.length = 0;
    return {
      f,
      provider,
      consumer,
      policy,
      value,
      callerPlugin,
      selectedOperation,
      unselectedOperation,
      locationId,
      acknowledge,
    };
  }

  test("first install reviews exact runtime authority and commits it before native dispatch", () => {
    const { f, value, callerPlugin, selectedOperation, locationId, acknowledge } =
      runtimeDeploymentFixture();
    try {
      expect(f.service.jobs.installation(f.machineId, callerPlugin)).toBeNull();
      const review = f.service.reviewDeployment(f.root, value);
      expect(review.approvable).toBe(true);
      const target = review.targets[0]!;
      expect(target.invocationEdges).toEqual([
        {
          edge: {
            caller: {
              machineId: f.machineId,
              pluginId: callerPlugin,
              operationId: selectedOperation,
              installationRevision: target.installationRevision!,
              artifactSha256: hash,
            },
            callee: {
              machineId: f.machineId,
              pluginId,
              operationId,
              installationRevision: "r1",
              artifactSha256: hash,
            },
            resources: [{ locationId, revision: "data-r1", access: "read" }],
            outputs: [],
            maxDepth: 1,
            maxConcurrency: 1,
            aggregate: limits,
          },
          approved: false,
          revision: null,
        },
      ]);
      expect(
        f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId: callerPlugin })
          .edges,
      ).toEqual([]);
      const send = f.channel.send;
      f.channel.send = (message) => {
        if (message.command.type === "install" && message.command.pluginId === callerPlugin) {
          expect(
            f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId: callerPlugin })
              .edges,
          ).toEqual([{ edge: target.invocationEdges[0]!.edge, enabled: true }]);
          expect(
            f.service
              .describe(f.root, { machineId: f.machineId, pluginId: callerPlugin })
              .consents.filter((row) => row.enabled)
              .map((row) => row.cap)
              .sort(),
          ).toEqual(target.consents.map((row) => row.cap).sort());
        }
        return send(message);
      };
      const deployment = f.service.applyDeployment(
        f.root,
        { request: value, reviewDigest: review.reviewDigest },
        "first-runtime",
      );
      expect(JobDeploymentSchema.parse(deployment).targets[0]!.state).toBe("installing");
      acknowledge();
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("ready");
      const parent = f.service.execute(f.root, callerPlugin, "runtime-parent", {
        jobId: "runtime-parent",
        machineId: f.machineId,
        operationId: selectedOperation,
        input: { value: "safe" },
        outputs: [],
      });
      expect(parent.state).toBe("start-committed");
      f.service.jobs.state(parent.request.jobId, "started");
      f.service.event(f.channel, {
        type: "invocation",
        parentJobId: parent.request.jobId,
        invocationId: "runtime-child",
        operationId,
        input: { value: "serve" },
        outputs: [],
      });
      const child = f.service.jobs.active().find((job) => job.request.parent !== null);
      expect(child?.state).toBe("start-committed");
      expect(child?.request).toMatchObject({
        pluginId,
        operationId,
        installationRevision: "r1",
        outputs: [],
        parent: { parentJobId: parent.request.jobId, invocationId: "runtime-child" },
      });
    } finally {
      f.store.close();
    }
  });

  test("an approved edge admits a child the caller's own credential could never authorize", () => {
    const { f, value, callerPlugin, selectedOperation, acknowledge } = runtimeDeploymentFixture();
    try {
      const review = f.service.reviewDeployment(f.root, value);
      f.service.applyDeployment(
        f.root,
        { request: value, reviewDigest: review.reviewDigest },
        "edge-runtime",
      );
      acknowledge();
      // Everything a job credential can legitimately carry, and nothing more: the one
      // governed capability deliberately absent is the one this hop used to demand.
      const granted: Cap[] = [
        "containers:read",
        "containers:write",
        "machines:run",
        "jobs:read",
        "jobs:input",
        "jobs:cancel",
        "locations:read",
        "locations:write",
        "locations:create",
        "services:read",
        "services:invoke",
        "network:host",
      ];
      const token = f.auth.mintToken(
        { principal: { name: "edge-caller", kind: "human" }, caps: granted },
        f.root,
      );
      const caller = f.auth.authenticate(token.token);
      f.auth.grant(
        {
          principal: { kind: "principal", id: caller.principal.id },
          node: formatManifoldUri({ kind: "machine", machineId: f.machineId }),
          caps: granted,
          effect: "allow",
          reach: "subtree",
        },
        f.root,
      );
      const parent = f.service.execute(caller, callerPlugin, "edge-parent", {
        jobId: "edge-parent",
        machineId: f.machineId,
        operationId: selectedOperation,
        input: { value: "safe" },
        outputs: [],
      });
      expect(parent.state).toBe("start-committed");
      // The authority for the hop is the approved edge. A job credential is minted from what
      // its operation declares it needs, which never includes `operations:invoke`, so before
      // #710 only a `*`-holding principal could invoke a declared, consented edge.
      expect(parent.request.credential.caps).not.toContain("operations:invoke");
      expect(parent.request.credential.caps).not.toContain("*");
      f.service.jobs.state(parent.request.jobId, "started");
      f.service.event(f.channel, {
        type: "invocation",
        parentJobId: parent.request.jobId,
        invocationId: "edge-child",
        operationId,
        input: { value: "serve" },
        outputs: [],
      });
      const child = f.service.jobs.active().find((job) => job.request.parent !== null);
      expect(child?.state).toBe("start-committed");
      expect(f.commands.at(-1)).toMatchObject({
        type: "invocation_reply",
        invocationId: "edge-child",
      });
    } finally {
      f.store.close();
    }
  });

  test("subset and install-only reviews never approve unrelated runtime operations", () => {
    const { f, value, callerPlugin, selectedOperation, unselectedOperation, acknowledge } =
      runtimeDeploymentFixture();
    try {
      const installOnly = apply(f, {
        ...value,
        deploymentId: "runtime-install-only",
        operationIds: [],
      });
      expect(installOnly.review.targets[0]!.invocationEdges).toEqual([]);
      expect(installOnly.review.targets[0]!.consents).toEqual([]);
      expect(installOnly.deployment.targets[0]!.state).toBe("installing");
      acknowledge();
      const { review } = apply(f, value);
      acknowledge();
      const inspection = f.service.inspectInvocations(f.root, {
        machineId: f.machineId,
        pluginId: callerPlugin,
      });
      expect(inspection.edges.map(({ edge }) => edge.caller.operationId)).toEqual([
        selectedOperation,
      ]);
      expect(review.targets[0]!.invocationEdges.map(({ edge }) => edge.caller.operationId)).toEqual(
        [selectedOperation],
      );
      const description = f.service.describe(f.root, {
        machineId: f.machineId,
        pluginId: callerPlugin,
      });
      expect(description.operations?.[selectedOperation]?.ready).toBe(true);
      expect(description.operations?.[unselectedOperation]?.ready).toBe(false);
      expect(description.consents.some((row) => row.node.endsWith(unselectedOperation))).toBe(
        false,
      );
      expect(() =>
        f.service.execute(f.root, callerPlugin, "unselected", {
          jobId: "unselected",
          machineId: f.machineId,
          operationId: unselectedOperation,
          input: { value: "safe" },
          outputs: [],
        }),
      ).toThrow("service_runtime_edge_missing");
      expect(f.commands.some((command) => command.type === "start")).toBe(false);
    } finally {
      f.store.close();
    }
  });

  test("changed callee installation, service policy, or callee consent invalidates first-install review without effects", () => {
    for (const change of ["callee", "policy", "consent"] as const) {
      const { f, value, provider, policy, callerPlugin } = runtimeDeploymentFixture();
      try {
        const review = f.service.reviewDeployment(f.root, value);
        expect(review.approvable).toBe(true);
        if (change === "callee") {
          f.service.install(f.root, {
            machineId: f.machineId,
            pluginId,
            installationRevision: "r2",
            artifactSha256: hash,
            machine: provider,
          });
        } else if (change === "policy") {
          f.service.configureServiceConfiguration(f.root, {
            machineId: f.machineId,
            expectedRevision: f.service.readServiceConfiguration(f.root, { machineId: f.machineId })
              .configuration.revision,
            policies: [{ ...policy, maxConcurrent: 2 }],
          });
        } else {
          consent(f, "operations:invoke", false);
          consent(f, "operations:invoke", true);
        }
        f.commands.length = 0;
        expect(() =>
          f.service.applyDeployment(
            f.root,
            {
              request: value,
              reviewDigest: review.reviewDigest,
            },
            "stale-runtime",
          ),
        ).toThrow("deployment_review_stale");
        expect(f.service.jobs.installation(f.machineId, callerPlugin)).toBeNull();
        expect(
          f.service.describe(f.root, { machineId: f.machineId, pluginId: callerPlugin }).consents,
        ).toEqual([]);
        expect(
          f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId: callerPlugin })
            .edges,
        ).toEqual([]);
        expect(f.commands).toEqual([]);
      } finally {
        f.store.close();
      }
    }
  });

  test("revoked runtime edges cannot be restored by deployment replay, even after regrant", () => {
    const { f, value, callerPlugin, acknowledge } = runtimeDeploymentFixture();
    try {
      const { review } = apply(f, value);
      acknowledge();
      const edge = review.targets[0]!.invocationEdges[0]!.edge;
      const args = { request: value, reviewDigest: review.reviewDigest };
      const originalConsents = f.service.describe(f.root, {
        machineId: f.machineId,
        pluginId: callerPlugin,
      }).consents;
      f.service.setInvocationEdge(f.root, { edge, enabled: false });
      f.commands.length = 0;
      expect(f.service.applyDeployment(f.root, args, "replay-revoked").targets[0]!.state).toBe(
        "needs_review",
      );
      f.service.tick();
      expect(
        f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId: callerPlugin })
          .edges,
      ).toEqual([{ edge, enabled: false }]);
      f.service.setInvocationEdge(f.root, { edge, enabled: true });
      expect(f.service.applyDeployment(f.root, args, "replay-regranted").targets[0]).toMatchObject({
        state: "needs_review",
        reason: "invocation_edge_changed",
      });
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId: callerPlugin }).consents,
      ).toEqual(originalConsents);
      expect(f.commands).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("changed edge authority fences review and the write-ahead claim without reinstallation or regrant", () => {
    for (const boundary of ["review", "claim"] as const) {
      const { f, value, callerPlugin, acknowledge } = runtimeDeploymentFixture();
      try {
        const first = apply(f, value);
        acknowledge();
        const original = first.review.targets[0]!.invocationEdges[0]!.edge;
        const tighter = { ...original, aggregate: { ...limits, timeoutMs: limits.timeoutMs - 1 } };
        f.service.setInvocationEdge(f.root, { edge: tighter, enabled: true });
        const next = { ...value, deploymentId: `edge-change-${boundary}` };
        const review = f.service.reviewDeployment(f.root, next);
        expect(review.targets[0]!.invocationEdges[0]).toMatchObject({
          edge: tighter,
          approved: true,
        });
        const consents = f.service.describe(f.root, {
          machineId: f.machineId,
          pluginId: callerPlugin,
        }).consents;
        const revision = f.service.jobs.installation(f.machineId, callerPlugin)!.revision;
        if (boundary === "review") {
          f.service.setInvocationEdge(f.root, { edge: tighter, enabled: false });
        } else {
          f.service.setLifecycleRecorder((record) => {
            f.store.appendTrace(record);
            if (record.payload.deploymentLifecycle === "applying")
              f.service.setInvocationEdge(f.root, { edge: tighter, enabled: false });
          });
        }
        f.commands.length = 0;
        const applyChanged = () =>
          f.service.applyDeployment(
            f.root,
            {
              request: next,
              reviewDigest: review.reviewDigest,
            },
            "changed-edge",
          );
        if (boundary === "review") expect(applyChanged).toThrow("deployment_review_stale");
        else expect(applyChanged().targets[0]!.state).toBe("needs_review");
        f.service.tick();
        expect(f.service.jobs.installation(f.machineId, callerPlugin)!.revision).toBe(revision);
        expect(
          f.service.describe(f.root, { machineId: f.machineId, pluginId: callerPlugin }).consents,
        ).toEqual(consents);
        expect(
          f.service.inspectInvocations(f.root, { machineId: f.machineId, pluginId: callerPlugin })
            .edges,
        ).toEqual([{ edge: tighter, enabled: false }]);
        expect(f.commands).toEqual([]);
      } finally {
        f.store.close();
      }
    }
  });

  test("stale review refuses before installation or consent effects", () => {
    const f = fixture();
    try {
      prove(f);
      const value = request(f, "stale", [operationId]);
      const review = f.service.reviewDeployment(f.root, value);
      replacement(f);
      f.commands.length = 0;
      expect(() =>
        f.service.applyDeployment(
          f.root,
          { request: value, reviewDigest: review.reviewDigest },
          "trace",
        ),
      ).toThrow("deployment_review_stale");
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.revision,
      ).toBe("r1");
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      expect(f.commands).toEqual([]);
      expect(f.service.listDeployments(f.root, { pluginId, limit: 20 }).deployments).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("install-only is explicit, waits for native acknowledgement, and grants no execution", () => {
    const f = fixture();
    try {
      prove(f);
      replacement(f);
      const value = request(f, "install-only");
      expect(
        JobDeploymentRequestSchema.safeParse({ ...value, operationIds: undefined }).success,
      ).toBe(false);
      f.commands.length = 0;
      const { review, deployment } = apply(f, value);
      expect(review.targets[0]!.consents).toEqual([]);
      expect(JobDeploymentSchema.parse(deployment).targets[0]!.state).toBe("installing");
      const install = f.commands.find((command) => command.type === "install");
      if (install?.type !== "install") throw new Error("reviewed install missing");
      const reviewedInstallationRevision = review.targets[0]!.installationRevision;
      if (reviewedInstallationRevision === null)
        throw new Error("reviewed installation revision missing");
      expect(install.installationRevision).toBe(reviewedInstallationRevision);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: install.installationRevision,
        artifactSha256: install.artifactSha256,
      });
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("ready");
      expect(execute(f, "install-is-not-consent").state).toBe("refused");
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("every administrative method refuses non-root and plugin handles remain confined", () => {
    const f = fixture();
    try {
      prove(f);
      const value = request(f, "admin");
      const { review, deployment } = apply(f, value);
      const token = f.auth.mintToken(
        { principal: { name: "inspector", kind: "human" }, caps: ["machines:run"] },
        f.root,
      );
      const reader = f.auth.authenticate(token.token);
      expect(() => f.service.reviewDeployment(reader, value)).toThrow("deployment_admin_required");
      expect(() =>
        f.service.applyDeployment(
          reader,
          { request: value, reviewDigest: review.reviewDigest },
          "trace",
        ),
      ).toThrow("deployment_admin_required");
      expect(() => f.service.readDeployment(reader, { deploymentId: value.deploymentId })).toThrow(
        "deployment_admin_required",
      );
      expect(() => f.service.listDeployments(reader, { pluginId, limit: 20 })).toThrow(
        "deployment_admin_required",
      );
      expect(() =>
        f.service.cancelDeployment(reader, {
          deploymentId: value.deploymentId,
          expectedRevision: deployment.revision,
        }),
      ).toThrow("deployment_admin_required");
      const product = jobContext(() => f.service, reader, pluginId, 1);
      expect(
        JobDeploymentDescriptionSchema.parse(
          product.describeDeployment({ machineId: f.machineId, pluginId }),
        ).installation,
      ).toMatchObject({ revision: "r1", machine });
      expect(() =>
        product.describeDeployment({ machineId: f.machineId, pluginId: "other.worker" }),
      ).toThrow();
      expect(() =>
        product.applyDeployment({ request: value, reviewDigest: review.reviewDigest }),
      ).toThrow("job_admin_required");
      f.auth.revokePrincipal(token.principal.id, f.root);
      expect(() => product.describeDeployment({ machineId: f.machineId, pluginId })).toThrow();
    } finally {
      f.store.close();
    }
  });

  test("offline approved native pins apply once on proved reconnect, never on unproved transport", () => {
    const { f } = boundFixture();
    try {
      const value = request(f, "offline-pins", [operationId]);
      const { review, deployment } = apply(f, value);
      expect(deployment.targets[0]!.state).toBe("pending");
      expect(review.targets[0]!.resources).toEqual([
        { group: "tools", name: "node", sha256: "d".repeat(64) },
      ]);
      expect(f.commands).toEqual([]);
      prove(f, true);
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("pending");
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      prove(f);
      const before = f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents;
      expect(before.find((consent) => consent.cap === "machines:run")?.enabled).toBe(true);
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("installing");
      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: "bound",
        artifactSha256: hash,
        resources: {
          artifactAvailable: true,
          tools: [{ alias: "node", managed: false, available: true }],
          operations: [{ operationId, available: true }],
        },
      });
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("ready");
      f.service.offline(f.channel);
      prove(f);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
        before,
      );
      expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("unknown offline resources cannot become a future automatic binding", () => {
    const f = fixture();
    try {
      prove(f);
      f.service.offline(f.channel);
      const unknown = structuredClone(machine);
      unknown.requiresResourceBindings = true;
      unknown.operations[operationId]!.runtimeTools = ["new-tool"];
      f.service.setManifestResolver(() => unknown);
      const value = request(f, "unknown-pins");
      const review = f.service.reviewDeployment(f.root, value);
      expect(review.targets[0]).toMatchObject({
        approvable: false,
        reason: "resource_evidence_unknown",
      });
      expect(() =>
        f.service.applyDeployment(
          f.root,
          { request: value, reviewDigest: review.reviewDigest },
          "trace",
        ),
      ).toThrow("deployment_unapprovable");
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.revision,
      ).toBe("r1");
    } finally {
      f.store.close();
    }
  });

  test("changed resource pins or declaration permanently fence a pending approval", () => {
    for (const change of ["resources", "declaration"] as const) {
      const { f, bound } = boundFixture();
      try {
        const value = request(f, `changed-${change}`, [operationId]);
        apply(f, value);
        if (change === "resources") f.owner.resources!.tools.node = "e".repeat(64);
        else
          f.service.setManifestResolver(() => ({
            ...bound,
            operations: { [operationId]: { ...bound.operations[operationId]!, network: "host" } },
          }));
        prove(f);
        expect(
          f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
        ).toBe("needs_review");
        expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
          [],
        );
        f.owner.resources!.tools.node = "d".repeat(64);
        f.service.setManifestResolver(() => bound);
        prove(f);
        expect(
          f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
        ).toBe("needs_review");
        expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
          [],
        );
      } finally {
        f.store.close();
      }
    }
  });

  test("executor revocation and changed consent cannot grant a pending scope", () => {
    for (const change of ["executor", "consent"] as const) {
      const f = fixture();
      try {
        prove(f);
        f.service.offline(f.channel);
        const value = request(f, `revoked-${change}`, [operationId]);
        apply(f, value);
        if (change === "executor") f.auth.revokeMachine(f.machineId, f.root);
        else consent(f, "machines:run", false);
        prove(f);
        expect(
          f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
        ).toBe("needs_review");
        expect(
          f.service
            .describe(f.root, { machineId: f.machineId, pluginId })
            .consents.filter((row) => row.enabled),
        ).toEqual([]);
      } finally {
        f.store.close();
      }
    }
  });

  test("same approval is idempotent, conflicting identity refuses, and revoked consent never resurrects", () => {
    const f = fixture();
    try {
      prove(f);
      const value = request(f, "deduplicated", [operationId]);
      const { review, deployment } = apply(f, value);
      const args = { request: value, reviewDigest: review.reviewDigest };
      const original = f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents;
      expect(f.service.applyDeployment(f.root, args, "another-trace")).toEqual(deployment);
      expect(() =>
        f.service.applyDeployment(
          f.root,
          { ...args, request: { ...value, operationIds: [] } },
          "conflict",
        ),
      ).toThrow("deployment_id_conflict");
      consent(f, "machines:run", false);
      const revoked = f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents;
      expect(revoked).not.toEqual(original);
      expect(f.service.applyDeployment(f.root, args, "old-approval").targets[0]!.state).toBe(
        "needs_review",
      );
      prove(f);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
        revoked,
      );
      expect(execute(f, "must-remain-denied").state).toBe("refused");
    } finally {
      f.store.close();
    }
  });

  test("competing pending targets refuse; cancellation stops only unapplied effects", () => {
    const f = fixture();
    try {
      prove(f);
      f.service.offline(f.channel);
      const first = request(f, "first", [operationId]);
      const { deployment } = apply(f, first);
      const other = request(f, "competing");
      const review = f.service.reviewDeployment(f.root, other);
      expect(() =>
        f.service.applyDeployment(
          f.root,
          { request: other, reviewDigest: review.reviewDigest },
          "trace",
        ),
      ).toThrow("deployment_target_pending");
      expect(() =>
        f.service.cancelDeployment(f.root, {
          deploymentId: first.deploymentId,
          expectedRevision: deployment.revision + 1,
        }),
      ).toThrow("deployment_revision_stale");
      const cancelled = f.service.cancelDeployment(f.root, {
        deploymentId: first.deploymentId,
        expectedRevision: deployment.revision,
      });
      expect(cancelled.targets[0]!.state).toBe("cancelled");
      prove(f);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.revision,
      ).toBe("r1");
      const completed = apply(f, other).deployment;
      const preserved = f.service.cancelDeployment(f.root, {
        deploymentId: other.deploymentId,
        expectedRevision: completed.revision,
      });
      expect(preserved.targets[0]!.state).toBe("ready");
      expect(
        f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.ready,
      ).toBe(true);
    } finally {
      f.store.close();
    }
  });

  test("cancel between write-ahead claim and effects cannot grant consent", () => {
    const f = fixture();
    try {
      prove(f);
      const value = request(f, "cancel-at-fence", [operationId]);
      f.service.setLifecycleRecorder((record) => {
        f.store.appendTrace(record);
        if (record.payload.deploymentLifecycle === "applying") {
          const current = f.service.readDeployment(f.root, { deploymentId: value.deploymentId });
          f.service.cancelDeployment(f.root, {
            deploymentId: value.deploymentId,
            expectedRevision: current.revision,
          });
        }
      });
      const { deployment } = apply(f, value);
      expect(deployment.targets[0]!.state).toBe("cancelled");
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual([]);
      f.service.tick();
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("cancelled");
    } finally {
      f.store.close();
    }
  });

  test("busy native work stays live while a reviewed replacement waits", () => {
    const f = fixture();
    try {
      consent(f, "machines:run");
      prove(f);
      const live = execute(f, "live");
      replacement(f);
      f.commands.length = 0;
      const value = request(f, "wait-for-work");
      const { deployment } = apply(f, value);
      expect(deployment.targets[0]).toMatchObject({
        state: "pending",
        reason: "active_installation",
      });
      expect(f.service.jobs.get(live.request.jobId)?.state).toBe("start-committed");
      expect(f.commands).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("terminal history retention preserves live approvals and permanently fences retired IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-deployment-retention-"));
    const path = join(dir, "db.sqlite");
    const f = fixture(path);
    try {
      prove(f);
      const destination = (name: string): Fixture => {
        const machineId = f.auth.enrollMachine(name, f.root).machine.id;
        const target = { ...f, machineId, channel: { machineId, send: f.channel.send } };
        f.service.install(f.root, {
          machineId,
          pluginId,
          installationRevision: "r1",
          artifactSha256: hash,
          machine,
        });
        prove(target);
        return target;
      };
      const pending = destination("pending");
      f.service.offline(pending.channel);
      const pendingApproval = apply(
        pending,
        request(pending, "keep-pending", [operationId]),
      ).deployment;
      const applying = destination("applying");
      f.service.offline(applying.channel);
      apply(applying, request(applying, "keep-applying", [operationId]));
      // Persist the actual crash boundary: admission claimed, effects not yet committed.
      f.store.db
        .query(
          "UPDATE machine_job_deployment_targets SET phase='applying',attempt='interrupted' WHERE deployment_id=?",
        )
        .run("keep-applying");
      const uncertain = destination("uncertain");
      f.service.offline(uncertain.channel);
      apply(uncertain, request(uncertain, "keep-uncertain", [operationId]));
      f.store.db
        .query(
          "UPDATE machine_job_deployment_targets SET phase='needs_review',reason='deployment_application_uncertain' WHERE deployment_id=?",
        )
        .run("keep-uncertain");
      const installing = destination("installing");
      f.service.install(f.root, {
        machineId: installing.machineId,
        pluginId,
        installationRevision: "awaiting-ack",
        artifactSha256: hash,
        machine,
      });
      const installingApproval = apply(
        installing,
        request(installing, "keep-installing"),
      ).deployment;
      expect(installingApproval.targets[0]!.state).toBe("installing");
      const cancelled = destination("cancelled-history");
      f.service.offline(cancelled.channel);
      const staleRequest = request(cancelled, "history-1");
      let staleDigest = "";
      let staleRevision = 0;
      // More than 256 of EACH terminal kind, not just 256 cumulative attempts.
      for (let index = 0; index < 514; index++) {
        f.runtime.time = index + 1;
        const target = index % 2 === 0 ? f : cancelled;
        const value = request(target, `history-${index}`);
        const { review, deployment } = apply(target, value);
        if (target === cancelled) {
          const result = f.service.cancelDeployment(f.root, {
            deploymentId: value.deploymentId,
            expectedRevision: deployment.revision,
          });
          expect(result.targets[0]!.state).toBe("cancelled");
          if (index === 1) {
            staleDigest = review.reviewDigest;
            staleRevision = result.revision;
          }
        } else expect(deployment.targets[0]!.state).toBe("ready");
      }
      expect(() => f.service.readDeployment(f.root, { deploymentId: "history-261" })).toThrow(
        "deployment_not_found",
      );
      expect(
        f.service.readDeployment(f.root, { deploymentId: "history-262" }).targets[0]!.state,
      ).toBe("ready");
      // A failed admission must roll back the terminal payload pruned to make its room.
      const competing = request(pending, "competing-at-capacity");
      const competingReview = f.service.reviewDeployment(f.root, competing);
      expect(() =>
        f.service.applyDeployment(
          f.root,
          {
            request: competing,
            reviewDigest: competingReview.reviewDigest,
          },
          "competing",
        ),
      ).toThrow("deployment_target_pending");
      expect(
        f.service.readDeployment(f.root, { deploymentId: "history-262" }).targets[0]!.state,
      ).toBe("ready");
      // Oldest means approval time first, even if wall clock moved backwards.
      f.runtime.time = 0;
      const backdatedRequest = request(f, "backdated-terminal");
      const backdated = apply(f, backdatedRequest);
      f.runtime.time = 515;
      expect(apply(f, request(f, "new-retained-approval")).deployment.targets[0]!.state).toBe(
        "ready",
      );
      expect(() =>
        f.service.readDeployment(f.root, { deploymentId: backdatedRequest.deploymentId }),
      ).toThrow("deployment_not_found");
      const listed = f.service.listDeployments(f.root, { pluginId, limit: 100 }).deployments;
      expect(listed[0]!.deploymentId).toBe("new-retained-approval");
      expect(
        listed.some((deployment) => deployment.deploymentId === backdatedRequest.deploymentId),
      ).toBe(false);
      expect(
        f.service.describeDeployment(f.root, { machineId: f.machineId, pluginId }, pluginId)
          .deployment?.deploymentId,
      ).toBe("new-retained-approval");
      expect(() => f.service.reviewDeployment(f.root, staleRequest)).toThrow(
        "deployment_id_retired",
      );
      expect(() =>
        f.service.applyDeployment(
          f.root,
          {
            request: staleRequest,
            reviewDigest: staleDigest,
          },
          "stale-cancelled",
        ),
      ).toThrow("deployment_id_retired");
      expect(() =>
        f.service.cancelDeployment(f.root, {
          deploymentId: staleRequest.deploymentId,
          expectedRevision: staleRevision,
        }),
      ).toThrow("deployment_not_found");
      expect(() =>
        f.service.applyDeployment(
          f.root,
          {
            request: backdatedRequest,
            reviewDigest: backdated.review.reviewDigest,
          },
          "stale-completed",
        ),
      ).toThrow("deployment_id_retired");
      expect(f.service.readDeployment(f.root, { deploymentId: "keep-pending" })).toEqual(
        pendingApproval,
      );
      expect(f.service.readDeployment(f.root, { deploymentId: "keep-installing" })).toEqual(
        installingApproval,
      );
      for (const deploymentId of ["keep-applying", "keep-uncertain"])
        expect(f.service.readDeployment(f.root, { deploymentId }).targets[0]).toMatchObject({
          state: "needs_review",
          reason: "deployment_application_uncertain",
        });
      prove(pending);
      expect(
        f.service.readDeployment(f.root, { deploymentId: "keep-pending" }).targets[0]!.state,
      ).toBe("ready");
      expect(execute(pending, "retained-pending-starts").state).toBe("start-committed");
      f.service.event(installing.channel, {
        type: "installed",
        pluginId,
        installationRevision: "awaiting-ack",
        artifactSha256: hash,
      });
      expect(
        f.service.readDeployment(f.root, { deploymentId: "keep-installing" }).targets[0]!.state,
      ).toBe("ready");
      // Compact replay fences outlive the process, unlike an in-memory retired-ID cache.
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
      expect(() =>
        f.service.applyDeployment(
          f.root,
          {
            request: staleRequest,
            reviewDigest: staleDigest,
          },
          "stale-after-restart",
        ),
      ).toThrow("deployment_id_retired");
      expect(() =>
        f.service.readDeployment(f.root, { deploymentId: staleRequest.deploymentId }),
      ).toThrow("deployment_not_found");
      expect(
        f.service.readDeployment(f.root, { deploymentId: "keep-applying" }).targets[0],
      ).toMatchObject({
        state: "needs_review",
        reason: "deployment_application_uncertain",
      });
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("capacity refuses only while every retained review still awaits native acknowledgement", () => {
    const f = fixture();
    try {
      prove(f);
      f.service.install(f.root, {
        machineId: f.machineId,
        pluginId,
        installationRevision: "awaiting-ack",
        artifactSha256: hash,
        machine,
      });
      for (let index = 0; index < 256; index++)
        expect(apply(f, request(f, `installing-${index}`)).deployment.targets[0]!.state).toBe(
          "installing",
        );
      const value = request(f, "after-capacity");
      const review = f.service.reviewDeployment(f.root, value);
      const args = { request: value, reviewDigest: review.reviewDigest };
      expect(() => f.service.applyDeployment(f.root, args, "full")).toThrow("deployment_capacity");
      for (const deploymentId of ["installing-0", "installing-255"])
        expect(f.service.readDeployment(f.root, { deploymentId }).targets[0]!.state).toBe(
          "installing",
        );
      expect(() => f.service.readDeployment(f.root, { deploymentId: value.deploymentId })).toThrow(
        "deployment_not_found",
      );
      f.service.event(f.channel, {
        type: "installed",
        pluginId,
        installationRevision: "awaiting-ack",
        artifactSha256: hash,
      });
      expect(f.service.applyDeployment(f.root, args, "acknowledged").targets[0]!.state).toBe(
        "ready",
      );
      // All approval timestamps tie: admission order breaks the tie deterministically.
      expect(() => f.service.readDeployment(f.root, { deploymentId: "installing-0" })).toThrow(
        "deployment_not_found",
      );
      expect(
        f.service.readDeployment(f.root, { deploymentId: "installing-1" }).targets[0]!.state,
      ).toBe("ready");
    } finally {
      f.store.close();
    }
  });

  test("migration preserves edge-free deployment readiness and live native work without regrant or restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-deployment-edge-free-upgrade-"));
    const path = join(dir, "db.sqlite");
    const provider: MachineHalf = {
      ...machine,
      operations: {
        [operationId]: { ...machine.operations[operationId]!, providesService: true },
      },
    };
    const f = fixture(path, provider);
    try {
      prove(f);
      const value = request(f, "legacy-edge-free", [operationId]);
      expect(apply(f, value).deployment.targets[0]!.state).toBe("ready");
      const running = execute(f, "legacy-live-worker");
      f.service.jobs.state(running.request.jobId, "started");
      const installation = f.service.jobs.installation(f.machineId, pluginId);
      const consents = f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents;
      const stored = f.store.db
        .query<{ approval: string }, [string]>(
          "SELECT approval FROM machine_job_deployments WHERE deployment_id=?",
        )
        .get(value.deploymentId)!;
      const legacy = JSON.parse(stored.approval);
      for (const target of legacy.review.targets) delete target.invocationEdges;
      for (const evidence of legacy.evidence) {
        delete evidence.invocations;
        delete evidence.invocationApprovals;
      }
      const body = { ...legacy.review, reviewDigest: undefined };
      const reviewDigest = createHash("sha256")
        .update(
          canonicalJobJson({ ...body, evidence: legacy.evidence, credential: legacy.credential }),
        )
        .digest("hex");
      legacy.review.reviewDigest = reviewDigest;
      f.store.db
        .query("UPDATE machine_job_deployments SET approval=? WHERE deployment_id=?")
        .run(canonicalJobJson(legacy), value.deploymentId);
      // Remove every post-v33 addition so migration 35 recreates the pre-v37 run schema.
      f.store.db.exec(`
UPDATE machine_job_deployment_targets SET receipt=json_extract(receipt,'$.consents');
ALTER TABLE job_invocation_edges DROP COLUMN revision;
DROP TABLE agent_run_policy_snapshots;
DROP TABLE agent_runs;
DROP INDEX tokens_runner_agent;
DROP INDEX tokens_agent_run;
DROP INDEX events_agent_run;
DROP INDEX machine_jobs_agent_run;
DROP INDEX job_schedule_occurrences_agent_run;
DROP INDEX terminals_agent_run;
ALTER TABLE tokens DROP COLUMN runner_agent_id;
ALTER TABLE tokens DROP COLUMN run_id;
ALTER TABLE events DROP COLUMN run_id;
ALTER TABLE events DROP COLUMN credential_id;
ALTER TABLE machine_jobs DROP COLUMN run_id;
ALTER TABLE job_schedule_occurrences DROP COLUMN run_id;
ALTER TABLE terminals DROP COLUMN run_id;
DROP TABLE agents;
DROP TABLE principal_access_pauses;
DELETE FROM meta WHERE key='agent-runs:declarations-after-event-id';
ALTER TABLE terminals DROP COLUMN cwd;
ALTER TABLE terminals DROP COLUMN launch_recipe;
UPDATE meta SET value='33' WHERE key='schema_version';
`);
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? provider : null));
      f.commands.length = 0;
      prove(f);
      expect(f.service.jobs.get(running.request.jobId)?.state).toBe("started");
      expect(
        f.commands.some((command) => command.type === "start" || command.type === "cancel"),
      ).toBe(false);
      expect(f.service.jobs.installation(f.machineId, pluginId)).toEqual(installation);
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
        consents,
      );
      expect(
        f.service.readDeployment(f.root, { deploymentId: value.deploymentId }).targets[0]!.state,
      ).toBe("ready");
      f.commands.length = 0;
      expect(
        f.service.applyDeployment(f.root, { request: value, reviewDigest }, "legacy-replay")
          .targets[0]!.state,
      ).toBe("ready");
      expect(f.commands).toEqual([]);
      expect(f.service.jobs.get(running.request.jobId)?.state).toBe("started");
      expect(f.service.describe(f.root, { machineId: f.machineId, pluginId }).consents).toEqual(
        consents,
      );
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart preserves applied receipts and fences an uncertain interrupted claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "manifold-deployment-restart-"));
    const path = join(dir, "db.sqlite");
    const f = fixture(path);
    try {
      prove(f);
      const applied = request(f, "durable-effects", [operationId]);
      apply(f, applied);
      consent(f, "machines:run", false);
      f.service.offline(f.channel);
      const interrupted = request(f, "uncertain");
      apply(f, interrupted);
      // The durable write-ahead fence with no receipt is precisely the crash boundary.
      f.store.db
        .query(
          "UPDATE machine_job_deployment_targets SET phase='applying',attempt='lost-process' WHERE deployment_id=?",
        )
        .run(interrupted.deploymentId);
      f.store.close();
      f.store = new ServerStore(openDatabase(path));
      f.auth = new AuthService(f.store, key, f.runtime);
      f.root = f.auth.authenticate(key);
      f.service = new JobService(f.store, f.auth, f.runtime);
      f.service.setLifecycleRecorder((record) => f.store.appendTrace(record));
      f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
      prove(f);
      expect(
        f.service.readDeployment(f.root, { deploymentId: interrupted.deploymentId }).targets[0],
      ).toMatchObject({ state: "needs_review", reason: "deployment_application_uncertain" });
      expect(
        f.service.readDeployment(f.root, { deploymentId: applied.deploymentId }).targets[0],
      ).toMatchObject({ state: "needs_review", reason: "consent_changed" });
      expect(execute(f, "restart-must-not-grant").state).toBe("refused");
      expect(
        f.store.listEvents({ type: "trace", limit: 100 }).some((row) => {
          const payload = JSON.parse(row.payload);
          return (
            payload.deploymentLifecycle === "needs_review" &&
            payload.parentTrace === "deployment-trace"
          );
        }),
      ).toBe(true);
    } finally {
      f.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deferred installation attribution precedes its effects and retains the original dispatch", () => {
    const f = fixture();
    try {
      prove(f);
      f.service.offline(f.channel);
      replacement(f);
      const value = request(f, "deferred-trace");
      const traceId = String(
        f.store.appendTrace({
          actor: f.root.principal.id,
          authority: "root",
          door: "engine.jobs.applyDeployment",
          containerId: null,
          session: "operator-session",
          ts: f.runtime.now(),
          payload: {},
          outcome: null,
          targets: [],
        }),
      );
      const review = f.service.reviewDeployment(f.root, value);
      f.service.applyDeployment(
        f.root,
        { request: value, reviewDigest: review.reviewDigest },
        traceId,
      );
      f.service.setLifecycleRecorder((record) => {
        if (record.payload.deploymentLifecycle === "applying")
          expect(
            f.service.describe(f.root, { machineId: f.machineId, pluginId }).installation?.revision,
          ).toBe("r1");
        f.store.appendTrace(record);
      });
      prove(f);
      const records = f.store
        .listEvents({ type: "trace", limit: 100 })
        .map((row) => ({ row, payload: JSON.parse(row.payload) }))
        .filter(({ payload }) => payload.deploymentId === value.deploymentId);
      expect(records.map(({ payload }) => payload.deploymentLifecycle).sort()).toEqual([
        "applied",
        "applying",
      ]);
      for (const { row, payload } of records) {
        expect(row).toMatchObject({
          principalId: f.root.principal.id,
          authority: "root",
          door: "engine.jobs.applyDeployment",
          session: "operator-session",
        });
        expect(payload).toMatchObject({
          parentTrace: traceId,
          originTraceAvailable: true,
          reviewDigest: review.reviewDigest,
        });
      }
    } finally {
      f.store.close();
    }
  });
});

describe("a job input bound to an earlier job's sealed output", () => {
  const producerId = `${pluginId}.prepare`;
  const consumerId = `${pluginId}.review`;
  const otherPlugin = "other.consumer";
  const otherConsumerId = `${otherPlugin}.review`;
  const base = {
    argv: [],
    input: {},
    runtimeTools: [],
    locations: [],
    outputs: [],
    network: "none" as const,
    limits,
    stdin: false,
  };
  const sealedId = `${pluginId}.sealed`;
  const producing: MachineHalf = {
    ...machine,
    locations: {
      [sealedId]: {
        anchor: "runtime" as const,
        components: ["sealed"],
        revision: "1",
        kind: "directory" as const,
      },
    },
    operations: {
      // `material` may leave the plugin; `notes` is declared, sealed and never exported.
      [producerId]: {
        ...base,
        locations: [{ locationId: sealedId, access: "write" as const }],
        outputs: ["material", "notes"],
        exports: ["material"],
      },
      [consumerId]: { ...base, inputs: ["material", "notes"] },
    },
  };
  const consuming: MachineHalf = {
    ...machine,
    operations: { [otherConsumerId]: { ...base, inputs: ["material", "notes"] } },
  };
  const allow = (f: Fixture, plugin: string, operation: string, cap: Cap, enabled = true) =>
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId: plugin,
      installationRevision: "r1",
      artifactSha256: hash,
      node: formatManifoldUri({
        kind: "operation",
        machineId: f.machineId,
        operationId: operation,
      }),
      cap,
      enabled,
    });
  function bound(): Fixture {
    const f = fixture(":memory:", producing);
    f.service.setManifestResolver((id) =>
      id === pluginId ? producing : id === otherPlugin ? consuming : null,
    );
    f.service.install(f.root, {
      machineId: f.machineId,
      pluginId: otherPlugin,
      installationRevision: "r1",
      artifactSha256: hash,
      machine: consuming,
    });
    allow(f, pluginId, producerId, "machines:run");
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId,
      installationRevision: "r1",
      artifactSha256: hash,
      node: formatManifoldUri({
        kind: "location",
        machineId: f.machineId,
        locationId: sealedId,
      }),
      cap: "locations:write",
      enabled: true,
    });
    allow(f, pluginId, producerId, "jobs:read");
    allow(f, pluginId, consumerId, "machines:run");
    allow(f, otherPlugin, otherConsumerId, "machines:run");
    prove(f);
    f.service.event(f.channel, {
      type: "installed",
      pluginId: otherPlugin,
      installationRevision: "r1",
      artifactSha256: hash,
    });
    return f;
  }
  /** The producer's settled run, with both names sealed the way its owner reported them. */
  function seal(f: Fixture, jobId = "producer"): JobRecord {
    const job = f.service.execute(f.root, pluginId, "trace-produce", {
      jobId,
      machineId: f.machineId,
      operationId: producerId,
      input: {},
      outputs: [
        { name: "material", locationId: sealedId, components: ["material"] },
        { name: "notes", locationId: sealedId, components: ["notes"] },
      ],
    });
    f.service.event(f.channel, {
      type: "result",
      result: {
        jobId,
        requestDigest: job.request.requestDigest,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        state: "exited",
        exitCode: 0,
        reason: null,
        startedAt: 0,
        finishedAt: 7,
        usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 4096 },
        limits,
        outputs: [
          { outputId: "o-material", name: "material", sha256: hash, bytes: 2048, files: 2 },
          { outputId: "o-notes", name: "notes", sha256: "b".repeat(64), bytes: 1024, files: 1 },
        ],
      },
    });
    return job;
  }
  const consume = (
    f: Fixture,
    inputs: JobRequest["inputs"],
    jobId = "consumer",
    plugin = pluginId,
    operation = consumerId,
    limitOverride?: JobRequest["limits"],
  ) =>
    f.service.execute(f.root, plugin, "trace-consume", {
      jobId,
      machineId: f.machineId,
      operationId: operation,
      input: {},
      outputs: [],
      inputs,
      ...(limitOverride ? { limits: limitOverride } : {}),
    });

  test("the admitted job echoes its bindings and inherits the operation's own output ceiling", () => {
    const f = bound();
    try {
      seal(f);
      const job = consume(f, [
        { name: "material", from: { jobId: "producer", output: "material" } },
      ]);
      expect(job.state).toBe("start-committed");
      expect(job.request.inputs).toEqual([
        { name: "material", from: { jobId: "producer", output: "material" } },
      ]);
      expect(job.request.limits.inputBytes).toBe(limits.outputBytes);
      expect(f.service.publicJob(job).inputs).toEqual(job.request.inputs);
      const start = f.commands.findLast((command) => command.type === "start");
      expect(start?.type === "start" && start.request.inputs).toEqual(job.request.inputs);
      // A consumer's input name is its own; it need not match the name the producer sealed.
      expect(
        consume(f, [{ name: "notes", from: { jobId: "producer", output: "material" } }], "renamed")
          .state,
      ).toBe("start-committed");
    } finally {
      f.store.close();
    }
  });

  test("a name the operation never declared is refused before anything else is asked", () => {
    const f = bound();
    try {
      seal(f);
      expect(() =>
        consume(f, [{ name: "corpus", from: { jobId: "producer", output: "material" } }]),
      ).toThrow("unknown_input:corpus");
      expect(() =>
        consume(f, [
          { name: "material", from: { jobId: "producer", output: "material" } },
          { name: "material", from: { jobId: "producer", output: "notes" } },
        ]),
      ).toThrow("duplicate_input");
    } finally {
      f.store.close();
    }
  });

  test("the source must exist, be settled, have sealed that name, and live on this machine", () => {
    const f = bound();
    try {
      expect(() =>
        consume(f, [{ name: "material", from: { jobId: "absent", output: "material" } }]),
      ).toThrow("input_source_unavailable:material");
      // Started is not settled: nothing is immutable until the owner seals it.
      const running = f.service.execute(f.root, pluginId, "trace-produce", {
        jobId: "running",
        machineId: f.machineId,
        operationId: producerId,
        input: {},
        outputs: [],
      });
      expect(running.state).toBe("start-committed");
      expect(() =>
        consume(f, [{ name: "material", from: { jobId: "running", output: "material" } }]),
      ).toThrow("input_source_unavailable:material");
      seal(f);
      expect(() =>
        consume(f, [{ name: "material", from: { jobId: "producer", output: "unsealed" } }]),
      ).toThrow("input_source_unavailable:material");
      // Bytes never cross a machine: a consumer elsewhere cannot reach this archive.
      const second = f.auth.enrollMachine("elsewhere", f.root).machine.id;
      f.service.install(f.root, {
        machineId: second,
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
        machine: producing,
      });
      f.service.consent(f.root, {
        machineId: second,
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
        node: formatManifoldUri({
          kind: "operation",
          machineId: second,
          operationId: consumerId,
        }),
        cap: "machines:run",
        enabled: true,
      });
      expect(() =>
        f.service.execute(f.root, pluginId, "trace-consume", {
          jobId: "remote",
          machineId: second,
          operationId: consumerId,
          input: {},
          outputs: [],
          inputs: [{ name: "material", from: { jobId: "producer", output: "material" } }],
        }),
      ).toThrow("input_source_unavailable:material");
    } finally {
      f.store.close();
    }
  });

  test("another plugin binds only an exported output; the producing plugin needs no export", () => {
    const f = bound();
    try {
      seal(f);
      allow(f, pluginId, producerId, "jobs:read");
      expect(() =>
        consume(
          f,
          [{ name: "notes", from: { jobId: "producer", output: "notes" } }],
          "outsider",
          otherPlugin,
          otherConsumerId,
        ),
      ).toThrow("input_not_exported:notes");
      expect(
        consume(
          f,
          [{ name: "material", from: { jobId: "producer", output: "material" } }],
          "welcome",
          otherPlugin,
          otherConsumerId,
        ).state,
      ).toBe("start-committed");
      // The same plugin reads its own unexported output: an export names what LEAVES a plugin.
      expect(
        consume(f, [{ name: "notes", from: { jobId: "producer", output: "notes" } }], "insider")
          .state,
      ).toBe("start-committed");
    } finally {
      f.store.close();
    }
  });

  test("the export replaces the caller-plugin pin but never the read authority at the source", () => {
    const f = bound();
    try {
      seal(f);
      allow(f, pluginId, producerId, "jobs:read", false);
      expect(() =>
        consume(
          f,
          [{ name: "material", from: { jobId: "producer", output: "material" } }],
          "unauthorized",
          otherPlugin,
          otherConsumerId,
        ),
      ).toThrow("input_authority_refused:material");
      // Its own plugin fares no better: the export is not a substitute for `jobs:read`.
      expect(() =>
        consume(f, [{ name: "material", from: { jobId: "producer", output: "material" } }]),
      ).toThrow("input_authority_refused:material");
      allow(f, pluginId, producerId, "jobs:read");
      expect(
        consume(
          f,
          [{ name: "material", from: { jobId: "producer", output: "material" } }],
          "authorized",
          otherPlugin,
          otherConsumerId,
        ).state,
      ).toBe("start-committed");
    } finally {
      f.store.close();
    }
  });

  test("an input ceiling only lowers, and a deferred start asks every question again", () => {
    const f = bound();
    try {
      seal(f);
      expect(() =>
        consume(
          f,
          [{ name: "material", from: { jobId: "producer", output: "material" } }],
          "greedy",
          pluginId,
          consumerId,
          { ...limits, inputBytes: limits.outputBytes + 1 },
        ),
      ).toThrow("limit_exceeded");
      expect(
        consume(
          f,
          [{ name: "material", from: { jobId: "producer", output: "material" } }],
          "modest",
          pluginId,
          consumerId,
          { ...limits, inputBytes: 4096 },
        ).request.limits.inputBytes,
      ).toBe(4096);
      // Offline: the job is admitted and queued, and its start happens later.
      f.service.offline(f.channel);
      const queued = consume(
        f,
        [{ name: "material", from: { jobId: "producer", output: "material" } }],
        "deferred",
      );
      expect(queued.state).toBe("queued");
      allow(f, pluginId, producerId, "jobs:read", false);
      prove(f);
      const settled = f.service.jobs.get("deferred")!;
      expect(settled.state).toBe("refused");
      expect(f.service.jobs.authority(settled).decision?.refusal).toBe(
        "input_authority_refused:material",
      );
      expect(
        f.commands.some(
          (command) => command.type === "start" && command.request.jobId === "deferred",
        ),
      ).toBe(false);
    } finally {
      f.store.close();
    }
  });
});
