import "../src/shared-modules.ts";
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatManifoldUri, PluginBundleSchema, type Cap } from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type JobFollowUpdate,
} from "../../protocol/src/jobs.ts";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService, type JobRecord } from "../src/job-service.ts";
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
function fixture(path = ":memory:"): Fixture {
  const store = new ServerStore(openDatabase(path));
  const runtime = new FakeRuntime();
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const machineId = auth.enrollMachine("worker", root).machine.id;
  const service = new JobService(store, auth, runtime);
  service.setLifecycleRecorder((record) => store.appendTrace(record));
  service.setManifestResolver((id) => (id === pluginId ? machine : null));
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
    machine,
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

test("authenticated owner receives only selected deduplicated machine members; substituted sources cannot replace the revision", () => {
  const f = fixture();
  try {
    const bytes = Buffer.from("private worker bytes");
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const bundled: MachineHalf = {
      ...machine,
      artifacts: { "linux-x64": {
        ...machine.artifacts["linux-x64"]!, url: undefined, bundleFile: "worker",
        sha256, entrySha256: sha256,
      } },
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
        id: pluginId, version: "1.0.0", title: "Worker", description: "Private worker",
        capabilities: [], contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
        entry: { web: "web.js" }, machine: bundled,
      },
      files: { "web.js": Buffer.from("export {};").toString("base64"), worker: bytes.toString("base64"),
        engine: bytes.toString("base64"), "other-platform": bytes.toString("base64") },
    });
    f.service.setManifestResolver(() => bundled);
    f.service.setBundleResolver(() => bundle);
    f.service.install(f.root, {
      machineId: f.machineId, pluginId, installationRevision: "bundled",
      artifactSha256: sha256, machine: bundled,
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
    for (const source of [null,
      { ...bundle, files: { ...bundle.files, worker: Buffer.from("substitution").toString("base64") } },
      { ...bundle, files: { ...bundle.files, engine: Buffer.from("substitution").toString("base64") } }]) {
      f.service.setBundleResolver(() => source);
      expect(() => f.service.install(f.root, {
        machineId: f.machineId, pluginId, installationRevision: "substituted",
        artifactSha256: sha256, machine: bundled,
      })).toThrow();
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
    f.store.createContainer({ id: containerId, name: "terminal", discipline: "composition", createdAt: f.runtime.now() });
    const spawnTrace = (actor: AuthContext) => f.store.appendTrace({
      actor: actor.principal.id, authority: "terminals:spawn", door: "core.terminals.open",
      containerId, session: null, ts: f.runtime.now(), outcome: "ok", targets: [], payload: {},
    });
    let traceId = spawnTrace(f.root);
    const runtime = { pluginId, operationId, installationRevision: "r1", artifactSha256: hash, input: { value: "safe" } };
    const binding = { terminalId: "native-terminal", terminalHostId: "native-host", containerId: "new-solo-home" };
    const forged = { jobId: "forged", machineId: f.machineId, operationId, input: runtime.input, outputs: [], terminal: binding };
    expect(() => f.service.execute(f.root, pluginId, "trace", forged)).toThrow("native_terminal_admission_required");
    consent(f, "machines:run");
    prove(f);
    expect(() => f.service.admitTerminal(f.root, runtime, f.machineId, binding, traceId)).toThrow();
    f.owner.terminalHostId = "native-host";
    prove(f);
    expect(() => f.service.admitTerminal(f.root, { ...runtime, installationRevision: "stale" }, f.machineId, binding, traceId)).toThrow();
    expect(() => f.service.admitTerminal(f.root, runtime, f.machineId, { ...binding, terminalHostId: "other-host" }, traceId)).toThrow();
    const token = f.auth.mintToken({
      principal: { name: "terminal-opener", kind: "agent" },
      caps: ["machines:run", "terminals:spawn"],
    }, f.root);
    const original = f.auth.authenticate(token.token);
    traceId = spawnTrace(original);
    const first = f.service.admitTerminal(original, runtime, f.machineId, binding, traceId);
    // Admission returns a one-use command to the terminal broker, never a second job-channel start.
    expect(f.commands.filter((command) => command.type === "start")).toEqual([]);
    f.service.cancelTerminal(binding.terminalId);
    expect(f.commands.at(-1)).toMatchObject({ type: "cancel", jobId: first.request.jobId });
    f.auth.grant({
      principal: { kind: "principal", id: original.principal.id },
      node: formatManifoldUri({ kind: "container", containerId }),
      caps: ["terminals:spawn"], effect: "deny", reach: "node",
    }, f.root);
    // Reusing the original authenticated context cannot outrun current grant revocation.
    expect(() => f.service.admitTerminal(original, runtime, f.machineId, { ...binding, terminalId: "denied" }, traceId)).toThrow();
    consent(f, "machines:run", false);
    traceId = spawnTrace(f.root);
    expect(() => f.service.admitTerminal(f.root, runtime, f.machineId, { ...binding, terminalId: "no-consent" }, traceId)).toThrow();
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
        traceId,
        parentJobId: scheduled.request.jobId,
        invocationId: "child",
      });
      expect(lifecycle(f, child.request.jobId)[0]!.row.door).toBe("sample.worker.schedule");
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
      expect(() => unrelated.input({ node, seq: 1, data: "eA==", eof: false })).toThrow();
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
      own.input({ node, seq: 1, data: "eA==", eof: false });
      expect(f.commands.at(-1)?.type).toBe("input");
      own.cancel(node);
      expect(f.commands.at(-1)?.type).toBe("cancel");
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
      expect(f.service.jobs.cancellation("expiring-live")).toBe("credential_revoked_or_expired");
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
});
