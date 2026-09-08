import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalJobJson, formatManifoldUri, type JobCommand, type JobOwner, type MachineHalf,
  type ServicePolicy, type ServiceReadArgs, type JobResourceBindings,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService } from "../src/job-service.ts";
import { ServerStore } from "../src/stores.ts";
import { FakeRuntime } from "./helpers.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const policy: ServicePolicy = {
  serviceId: "native.metadata", revision: "r1", origin: "https://example.invalid", allowLoopbackHttp: false,
  credential: { ref: "native-account", header: "Authorization", prefix: "Bearer " }, maxConcurrent: 2,
  operations: {
    inspect: {
      method: "GET", readable: true, path: "/metadata", input: {
        query: { type: "string", required: true, maxBytes: 64 },
      }, query: { q: "query" }, body: [], timeoutMs: 1, maxRequestBytes: 1024,
      maxResponseBytes: 4096, maxResultBytes: 2048,
      response: { kind: "projected-json", fields: [["remaining"]], maxArrayItems: 16 },
    },
  },
};
function fixture() {
  const store = new ServerStore(openDatabase(":memory:"));
  const runtime = new FakeRuntime();
  const key = "9".repeat(64);
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const machineId = auth.enrollMachine("native", root).machine.id;
  const service = new JobService(store, auth, runtime);
  service.setLifecycleRecorder(record => store.appendTrace(record));
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    ownerId: "owner", generation: 1, inventoryDigest: "a".repeat(64), platforms: ["linux-x64"],
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    resources: {
      tools: { helper: "b".repeat(64) }, anchors: {}, services: { [policy.serviceId]: hash(policy) },
      serviceDefinitions: { [policy.serviceId]: { revision: policy.revision, operationIds: ["inspect"] } },
      credentialReferences: [{ ref: "native-account", origins: [policy.origin!], available: true }],
    },
  };
  const commands: JobCommand[] = [];
  const channel = { machineId, send: ({ command }: { type: "job_command"; command: JobCommand }) => {
    commands.push(command); return true;
  } };
  const prove = () => {
    service.online(channel, owner, "epoch");
    const challenge = commands.at(-1);
    if (challenge?.type !== "owner_challenge") throw new Error("missing challenge");
    const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
    service.event(channel, { type: "owner_proof", ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64") });
  };
  const configuration = service.configureServiceConfiguration(root, { machineId, expectedRevision: null, policies: [policy] });
  prove();
  const token = auth.mintToken({ principal: { name: "metadata reader", kind: "agent" }, caps: ["services:invoke"] }, root);
  const reader = auth.authenticate(token.token);
  const args: ServiceReadArgs = { machineId, serviceId: policy.serviceId, revision: policy.revision,
    policySha256: hash(policy), operationId: "inspect", input: { query: "private-source-input" } };
  const pendingCommand = () => {
    const command = commands.findLast(command => command.type === "service_read");
    if (command?.type !== "service_read") throw new Error("missing read command");
    return command;
  };
  const authorize = (requestId: string, onChannel = channel) => service.event(onChannel, {
    type: "service_authorize", subject: { kind: "read", requestId }, authorizationId: `auth-${requestId}`,
    serviceId: args.serviceId, revision: args.revision, policySha256: args.policySha256, operationId: args.operationId,
  });
  const result = (requestId: string, onChannel = channel) => service.event(onChannel, {
    type: "service_read_result", requestId,
    reply: { type: "service_result", requestId, ok: true, result: { remaining: 12 } },
  });
  return { store, runtime, auth, root, reader, service, machineId, owner, commands, channel, prove,
    args, configuration, pendingCommand, authorize, result };
}

test("projected native reads need service authority, not machine execution or an installed worker", async () => {
  const f = fixture();
  try {
    expect(f.reader.caps).toEqual(["services:invoke"]);
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
    expect(f.store.db.query("SELECT plugin_id FROM machine_job_installs").all()).toEqual([]);
    const originalSend = f.channel.send;
    f.channel.send = message => {
      if (message.command.type === "service_authorized" && message.command.allowed) {
        expect(f.store.db.query("SELECT id FROM events WHERE door='engine.services.read'").all().length).toBe(2);
        expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(2);
      }
      return originalSend(message);
    };
    f.authorize(command.requestId);
    f.result(command.requestId);
    expect(await pending).toEqual({ type: "service_result", requestId: command.requestId, ok: true, result: { remaining: 12 } });
    const durable = JSON.stringify([
      f.store.db.query("SELECT * FROM events").all(),
      f.store.db.query("SELECT * FROM machine_job_decisions").all(),
    ]);
    expect(durable).not.toContain("private-source-input");
    expect(durable).not.toContain("remaining");
    expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(3);
  } finally { f.store.close(); }
});

test("configuration CAS is canonical, root-only, and synchronization never implies invocation success", () => {
  const f = fixture();
  try {
    expect(() => f.service.readServiceConfiguration(f.reader, { machineId: f.machineId })).toThrow();
    expect(() => f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId, expectedRevision: null, policies: [],
    })).toThrow("service_configuration_changed");
    expect(f.service.readServiceConfiguration(f.root, { machineId: f.machineId })).toEqual({
      configuration: f.configuration, credentialReferences: f.owner.resources!.credentialReferences,
    });
    const changed = f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId, expectedRevision: f.configuration.revision, policies: [],
    });
    expect(changed.revision).not.toBeNull();
    expect(f.commands.at(-1)).toEqual({ type: "configure_services", configuration: changed });
    f.service.offline(f.channel);
    f.prove();
    expect(f.commands.filter(command => command.type === "configure_services").at(-1)).toEqual({
      type: "configure_services", configuration: changed,
    });
  } finally { f.store.close(); }
});

test("stale policy fingerprints and non-readable full or mutating policies cannot use direct reads", async () => {
  const f = fixture();
  try {
    await expect(f.service.readService(f.reader, { ...f.args, policySha256: "c".repeat(64) })).rejects.toThrow("service_binding_mismatch");
    const original = policy.operations.inspect!;
    if ("kind" in original) throw new Error("wrong fixture operation");
    for (const operation of [
      { ...original, readable: false },
      { ...original, readable: false, method: "POST" as const },
      { ...original, readable: false, response: { kind: "json" as const, disclosure: "full" as const } },
    ]) {
      const configured = { ...policy, operations: { inspect: operation } };
      const previous = f.service.readServiceConfiguration(f.root, { machineId: f.machineId }).configuration;
      f.service.configureServiceConfiguration(f.root, { machineId: f.machineId, expectedRevision: previous.revision, policies: [configured] });
      f.service.event(f.channel, { type: "resources", resources: {
        ...f.owner.resources!, services: { [policy.serviceId]: hash(configured) },
      } });
      await expect(f.service.readService(f.reader, { ...f.args, policySha256: hash(configured) })).rejects.toThrow("service_unauthorized");
    }
    expect(f.commands.some(command => command.type === "service_read")).toBe(false);
  } finally { f.store.close(); }
});

test.each(["disconnect", "false-send", "throw-send", "revoke", "lost-result"] as const)(
  "read %s rejects, cancels, and is never replayed", async failure => {
    const f = fixture();
    try {
      const send = f.channel.send;
      if (failure === "false-send" || failure === "throw-send") f.channel.send = message => {
        if (message.command.type !== "service_read") return send(message);
        if (failure === "throw-send") throw new Error("private-transport-detail");
        return false;
      };
      const pending = f.service.readService(f.reader, f.args);
      if (failure === "disconnect") f.service.offline(f.channel);
      if (failure === "revoke") f.auth.revokePrincipal(f.reader.principal.id, f.root);
      if (failure === "lost-result") f.authorize(f.pendingCommand().requestId);
      await expect(pending).rejects.toThrow(failure === "revoke" ? "service_unauthorized" : failure === "lost-result" ? "service_timeout" : "service_unavailable");
      expect(f.commands.some(command => command.type === "service_read_cancel")).toBe(true);
      const dispatched = f.commands.filter(command => command.type === "service_read").length;
      f.channel.send = send;
      f.prove();
      expect(f.commands.filter(command => command.type === "service_read").length).toBe(dispatched);
    } finally { f.store.close(); }
  }, 10000,
);

test("foreign-channel, unbound and revoked service authorizations cannot disclose a read", async () => {
  const f = fixture();
  try {
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    const foreign = { machineId: f.machineId, send: f.channel.send };
    f.authorize(command.requestId, foreign);
    f.result(command.requestId, foreign);
    expect(f.commands.some(command => command.type === "service_authorized")).toBe(false);
    f.authorize("unbound");
    expect(f.commands.findLast(command => command.type === "service_authorized")).toMatchObject({ allowed: false });
    f.authorize(command.requestId);
    f.auth.grant({ principal: { kind: "principal", id: f.reader.principal.id },
      node: formatManifoldUri({ kind: "service", machineId: f.machineId, serviceId: policy.serviceId, operationId: "inspect" }),
      caps: ["services:invoke"], effect: "deny", reach: "subtree" }, f.root);
    f.result(command.requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(f.service.describeServices(f.reader, { machineId: f.machineId }).services).toEqual([]);
  } finally { f.store.close(); }
});

function install(f: {
  service: JobService; root: AuthContext; machineId: string;
  channel: { machineId: string; send(message: { type: "job_command"; command: JobCommand }): boolean };
}) {
  const artifactSha256 = "d".repeat(64);
  const pluginId = "native.worker";
  const operationId = `${pluginId}.service`;
  const independent = `${pluginId}.independent`;
  const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
  const base = { argv: [{ literal: "worker" }], input: {}, runtimeTools: [], locations: [], outputs: [], network: "none" as const, limits, stdin: false };
  const machine: MachineHalf = {
    requiresResourceBindings: true,
    artifacts: { "linux-x64": { url: "https://example.invalid/worker", sha256: artifactSha256,
      entrySha256: artifactSha256, format: "raw", entry: ["worker"], maxBytes: 4096, maxExpandedBytes: 4096, maxMembers: 1 } },
    operations: {
      [operationId]: { ...base, runtimeTools: ["helper"], services: [{ serviceId: policy.serviceId, revision: policy.revision, operationIds: ["inspect"] }] },
      [independent]: base,
    }, locations: {},
  };
  const resourceBindings: JobResourceBindings = { tools: { helper: "b".repeat(64) }, services: { [policy.serviceId]: hash(policy) }, anchors: {} };
  f.service.setManifestResolver(id => id === pluginId ? machine : null);
  const args = { machineId: f.machineId, pluginId, installationRevision: "r1", artifactSha256, machine, resourceBindings };
  f.service.install(f.root, args);
  f.service.event(f.channel, { type: "installed", pluginId, installationRevision: "r1", artifactSha256,
    resources: { artifactAvailable: true, tools: [], operations: [
      { operationId, available: true }, { operationId: independent, available: true },
    ] } });
  return { ...args, operationId, independent };
}

test("resource promotion, projected operation pins and managed availability refuse only affected operations", () => {
  const f = fixture();
  try {
    const installed = install(f);
    const describe = () => f.service.describe(f.root, { machineId: f.machineId, pluginId: installed.pluginId });
    const before = describe();
    expect(before.operations![installed.operationId]?.ready).toBe(true);
    expect(before.operations![installed.independent]?.resourceBindingDigest).toBe(hash({ tools: {}, services: {}, anchors: {} }));
    expect(() => f.service.install(f.root, { ...installed, installationRevision: "stale", resourceBindings: {
      ...installed.resourceBindings, tools: { helper: "c".repeat(64) },
    } })).toThrow("resource_revision_changed");
    expect(() => f.service.execute(f.root, installed.pluginId, "trace", {
      jobId: "stale", machineId: f.machineId, operationId: installed.independent, input: {}, outputs: [],
      resourceBindingDigest: "c".repeat(64),
    })).toThrow("resource_bindings_changed");
    f.service.event(f.channel, { type: "resources", resources: { ...f.owner.resources!, tools: {} } });
    expect(describe().operations![installed.operationId]).toMatchObject({ ready: false, reason: "tools_unavailable" });
    expect(describe().operations![installed.independent]).toEqual(before.operations![installed.independent]);
    f.service.event(f.channel, { type: "installed", pluginId: installed.pluginId, installationRevision: "r1", artifactSha256: installed.artifactSha256,
      resources: { artifactAvailable: false, tools: [], operations: [
        { operationId: installed.operationId, available: false, reason: "managed_tool_missing" },
        { operationId: installed.independent, available: true },
      ] } });
    expect(describe().operations![installed.independent]?.ready).toBe(true);
  } finally { f.store.close(); }
});

test("job service effects require a live matching installed binding and fresh native consent", () => {
  const f = fixture();
  try {
    const installed = install(f);
    f.service.consent(f.root, { machineId: f.machineId, pluginId: installed.pluginId, installationRevision: "r1",
      artifactSha256: installed.artifactSha256, node: formatManifoldUri({ kind: "operation", machineId: f.machineId, operationId: installed.operationId }),
      cap: "machines:run", enabled: true });
    const job = f.service.execute(f.root, installed.pluginId, "trace", {
      jobId: "live", machineId: f.machineId, operationId: installed.operationId, input: {}, outputs: [],
    });
    const event = { type: "service_authorize" as const, subject: { kind: "job" as const, jobId: "live" }, authorizationId: "auth-live",
      serviceId: policy.serviceId, revision: policy.revision, policySha256: hash(policy), operationId: "inspect" };
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.event(f.channel, { type: "state", jobId: "live", requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId, ownerGeneration: f.owner.generation, state: "started" });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: true });
    f.service.event(f.channel, { ...event, operationId: "unbound" });
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.configureServiceConfiguration(f.root, { machineId: f.machineId, expectedRevision: f.configuration.revision, policies: [] });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
  } finally { f.store.close(); }
});

test("credential availability changes revoke pending reads and disable only service dependencies", async () => {
  const f = fixture();
  try {
    const installed = install(f);
    const pending = f.service.readService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.event(f.channel, { type: "resources", resources: {
      ...f.owner.resources!, services: {},
      credentialReferences: [{ ref: "native-account", origins: [policy.origin!], available: false }],
    } });
    f.result(requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(f.service.describeServices(f.reader, { machineId: f.machineId }).services[0]?.operations[0]?.ready).toBe(false);
    const operations = f.service.describe(f.root, { machineId: f.machineId, pluginId: installed.pluginId }).operations!;
    expect(operations[installed.operationId]?.ready).toBe(false);
    expect(operations[installed.independent]?.ready).toBe(true);
  } finally { f.store.close(); }
});
