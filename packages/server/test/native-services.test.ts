import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";
import { attachServerGuest, defineServerAction } from "../../plugin-kit/src/server.ts";
import {
  canonicalJobJson,
  formatManifoldUri,
  JobCommandSchema,
  JobEventSchema,
  PROTOCOL_VERSION,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type ServicePolicy,
  type ServiceReadArgs,
  type JobResourceBindings,
  type Cap,
  type IsolateChildFrame,
  type IsolateHostFrame,
  type PluginManifest,
  type ServiceConfiguration,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService } from "../src/job-service.ts";
import { ServerStore } from "../src/stores.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";
import { serviceContext } from "../src/service-doors.ts";
import {
  buildIsolateDef,
  serveCtxCall,
  type IsolateDispatchOutcome,
} from "../src/isolate/proxy-def.ts";
import type { ActionCtx } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { silentLogger } from "../src/log.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const policy: ServicePolicy = {
  serviceId: "native.metadata",
  revision: "r1",
  origin: "https://example.invalid",
  allowLoopbackHttp: false,
  credential: { ref: "native-account", header: "Authorization", prefix: "Bearer " },
  maxConcurrent: 2,
  operations: {
    inspect: {
      method: "GET",
      readable: true,
      path: "/metadata",
      input: {
        query: { type: "string", required: true, maxBytes: 64 },
      },
      query: { q: "query" },
      body: [],
      timeoutMs: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 4096,
      maxResultBytes: 2048,
      response: { kind: "projected-json", fields: [["remaining"]], maxArrayItems: 16 },
    },
  },
};
function fixture(servicePolicy = policy, mode: "read" | "invoke" = "read") {
  const policy = servicePolicy;
  const store = new ServerStore(openDatabase(":memory:"));
  const runtime = new FakeRuntime();
  const key = "9".repeat(64);
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const machineId = auth.enrollMachine("native", root).machine.id;
  const service = new JobService(store, auth, runtime);
  service.setLifecycleRecorder((record) => store.appendTrace(record));
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: PROTOCOL_VERSION,
    ownerId: "owner",
    generation: 1,
    inventoryDigest: "a".repeat(64),
    platforms: ["linux-x64"],
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    resources: {
      tools: { helper: "b".repeat(64) },
      anchors: {},
      services: { [policy.serviceId]: hash(policy) },
      serviceDefinitions: {
        [policy.serviceId]: {
          revision: policy.revision,
          operationIds: Object.keys(policy.operations),
        },
      },
      credentialReferences: [{ ref: "native-account", origins: [policy.origin!], available: true }],
    },
  };
  const commands: JobCommand[] = [];
  const channel = {
    machineId,
    send: ({ command }: { type: "job_command"; command: JobCommand }) => {
      commands.push(command);
      return true;
    },
  };
  const prove = () => {
    service.online(channel, owner, "epoch");
    const challenge = commands.at(-1);
    if (challenge?.type !== "owner_challenge") throw new Error("missing challenge");
    const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
    service.event(channel, {
      type: "owner_proof",
      ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString(
        "base64",
      ),
    });
  };
  const configuration = service.configureServiceConfiguration(root, {
    machineId,
    expectedRevision: null,
    policies: [policy],
  });
  prove();
  const token = auth.mintToken(
    {
      principal: { name: "service caller", kind: "agent" },
      caps: [mode === "read" ? "services:read" : "services:invoke"],
    },
    root,
  );
  const reader = auth.authenticate(token.token);
  const args: ServiceReadArgs = {
    machineId,
    serviceId: policy.serviceId,
    revision: policy.revision,
    policySha256: hash(policy),
    operationId: "inspect",
    input: { query: "private-source-input" },
  };
  const pendingCommand = () => {
    const command = commands.findLast(
      (command) => command.type === (mode === "read" ? "service_read" : "service_invoke"),
    );
    if (command?.type !== "service_read" && command?.type !== "service_invoke")
      throw new Error("missing direct service command");
    return command;
  };
  const authorize = (requestId: string, onChannel = channel) =>
    service.event(
      onChannel,
      JobEventSchema.parse({
        type: "service_authorize",
        subject: { kind: mode, requestId },
        authorizationId: `auth-${requestId}`,
        serviceId: args.serviceId,
        revision: args.revision,
        policySha256: args.policySha256,
        operationId: args.operationId,
      }),
    );
  const result = (requestId: string, onChannel = channel) =>
    service.event(
      onChannel,
      JobEventSchema.parse({
        type: mode === "read" ? "service_read_result" : "service_invoke_result",
        requestId,
        reply: { type: "service_result", requestId, ok: true, result: { remaining: 12 } },
      }),
    );
  return {
    store,
    runtime,
    auth,
    root,
    reader,
    service,
    machineId,
    owner,
    commands,
    channel,
    prove,
    args,
    configuration,
    pendingCommand,
    authorize,
    result,
  };
}

test("projected native reads need service authority, not machine execution or an installed worker", async () => {
  const f = fixture();
  try {
    expect(f.reader.caps).toEqual(["services:read"]);
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
    expect(f.store.db.query("SELECT plugin_id FROM machine_job_installs").all()).toEqual([]);
    const originalSend = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "service_authorized" && message.command.allowed) {
        expect(
          f.store.db.query("SELECT id FROM events WHERE door='engine.services.read'").all().length,
        ).toBe(2);
        expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(2);
      }
      return originalSend(message);
    };
    f.authorize(command.requestId);
    f.result(command.requestId);
    expect(await pending).toEqual({
      type: "service_result",
      requestId: command.requestId,
      ok: true,
      result: { remaining: 12 },
    });
    const durable = JSON.stringify([
      f.store.db.query("SELECT * FROM events").all(),
      f.store.db.query("SELECT * FROM machine_job_decisions").all(),
    ]);
    expect(durable).not.toContain("private-source-input");
    expect(durable).not.toContain("remaining");
    expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(3);
  } finally {
    f.store.close();
  }
});

test("configuration CAS is canonical, root-only, and synchronization never implies invocation success", () => {
  const f = fixture();
  try {
    expect(() =>
      f.service.readServiceConfiguration(f.reader, { machineId: f.machineId }),
    ).toThrow();
    expect(() =>
      f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: null,
        policies: [],
      }),
    ).toThrow("service_configuration_changed");
    expect(f.service.readServiceConfiguration(f.root, { machineId: f.machineId })).toEqual({
      configuration: f.configuration,
      credentialReferences: f.owner.resources!.credentialReferences ?? [],
      connected: true,
      runtimeCandidates: [],
    });
    const changed = f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    expect(changed.revision).not.toBeNull();
    expect(f.commands.at(-1)).toEqual({ type: "configure_services", configuration: changed });
    f.service.offline(f.channel);
    f.prove();
    expect(f.commands.filter((command) => command.type === "configure_services").at(-1)).toEqual({
      type: "configure_services",
      configuration: changed,
    });
  } finally {
    f.store.close();
  }
});

test("stale policy fingerprints and non-readable full or mutating policies cannot use direct reads", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.readService(f.reader, { ...f.args, policySha256: "c".repeat(64) }),
    ).rejects.toThrow("service_binding_mismatch");
    const original = policy.operations.inspect!;
    if ("kind" in original) throw new Error("wrong fixture operation");
    for (const operation of [
      { ...original, readable: false },
      { ...original, readable: false, method: "POST" as const },
      {
        ...original,
        readable: false,
        response: { kind: "json" as const, disclosure: "full" as const },
      },
    ]) {
      const configured = { ...policy, operations: { inspect: operation } };
      const previous = f.service.readServiceConfiguration(f.root, {
        machineId: f.machineId,
      }).configuration;
      f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: previous.revision,
        policies: [configured],
      });
      f.service.event(f.channel, {
        type: "resources",
        resources: {
          ...f.owner.resources!,
          services: { [policy.serviceId]: hash(configured) },
        },
      });
      await expect(
        f.service.readService(f.reader, { ...f.args, policySha256: hash(configured) }),
      ).rejects.toThrow("service_unauthorized");
    }
    expect(f.commands.some((command) => command.type === "service_read")).toBe(false);
  } finally {
    f.store.close();
  }
});

test.each(["disconnect", "false-send", "throw-send", "revoke", "lost-result"] as const)(
  "read %s rejects, cancels, and is never replayed",
  async (failure) => {
    const f = fixture();
    try {
      const send = f.channel.send;
      if (failure === "false-send" || failure === "throw-send")
        f.channel.send = (message) => {
          if (message.command.type !== "service_read") return send(message);
          if (failure === "throw-send") throw new Error("private-transport-detail");
          return false;
        };
      const pending = f.service.readService(f.reader, f.args);
      if (failure === "disconnect") f.service.offline(f.channel);
      if (failure === "revoke") f.auth.revokePrincipal(f.reader.principal.id, f.root);
      if (failure === "lost-result") f.authorize(f.pendingCommand().requestId);
      await expect(pending).rejects.toThrow(
        failure === "revoke"
          ? "service_unauthorized"
          : failure === "lost-result"
            ? "service_timeout"
            : "service_unavailable",
      );
      expect(f.commands.some((command) => command.type === "service_read_cancel")).toBe(true);
      const dispatched = f.commands.filter((command) => command.type === "service_read").length;
      f.channel.send = send;
      f.prove();
      expect(f.commands.filter((command) => command.type === "service_read").length).toBe(
        dispatched,
      );
    } finally {
      f.store.close();
    }
  },
  10000,
);

test("foreign-channel, unbound and revoked service authorizations cannot disclose a read", async () => {
  const f = fixture();
  try {
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    const foreign = { machineId: f.machineId, send: f.channel.send };
    f.authorize(command.requestId, foreign);
    f.result(command.requestId, foreign);
    expect(f.commands.some((command) => command.type === "service_authorized")).toBe(false);
    f.authorize("unbound");
    expect(f.commands.findLast((command) => command.type === "service_authorized")).toMatchObject({
      allowed: false,
    });
    f.authorize(command.requestId);
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.reader.principal.id },
        node: formatManifoldUri({
          kind: "service",
          machineId: f.machineId,
          serviceId: policy.serviceId,
          operationId: "inspect",
        }),
        caps: ["services:read"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    f.result(command.requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(f.service.describeServices(f.reader, { machineId: f.machineId }).services).toEqual([]);
  } finally {
    f.store.close();
  }
});

function install(f: {
  service: JobService;
  root: AuthContext;
  machineId: string;
  channel: {
    machineId: string;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
}) {
  const artifactSha256 = "d".repeat(64);
  const pluginId = "native.worker";
  const operationId = `${pluginId}.service`;
  const independent = `${pluginId}.independent`;
  const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };
  const base = {
    argv: [{ literal: "worker" }],
    input: {},
    runtimeTools: [],
    locations: [],
    outputs: [],
    network: "none" as const,
    limits,
    stdin: false,
  };
  const machine: MachineHalf = {
    requiresResourceBindings: true,
    artifacts: {
      "linux-x64": {
        url: "https://example.invalid/worker",
        sha256: artifactSha256,
        entrySha256: artifactSha256,
        format: "raw",
        entry: ["worker"],
        maxBytes: 4096,
        maxExpandedBytes: 4096,
        maxMembers: 1,
      },
    },
    operations: {
      [operationId]: {
        ...base,
        runtimeTools: ["helper"],
        services: [
          { serviceId: policy.serviceId, revision: policy.revision, operationIds: ["inspect"] },
        ],
      },
      [independent]: base,
    },
    locations: {},
  };
  const resourceBindings: JobResourceBindings = {
    tools: { helper: "b".repeat(64) },
    services: { [policy.serviceId]: hash(policy) },
    anchors: {},
  };
  f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
  const args = {
    machineId: f.machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256,
    machine,
    resourceBindings,
  };
  f.service.install(f.root, args);
  f.service.event(f.channel, {
    type: "installed",
    pluginId,
    installationRevision: "r1",
    artifactSha256,
    resources: {
      artifactAvailable: true,
      tools: [],
      operations: [
        { operationId, available: true },
        { operationId: independent, available: true },
      ],
    },
  });
  return { ...args, operationId, independent };
}

test("resource promotion, projected operation pins and managed availability refuse only affected operations", () => {
  const f = fixture();
  try {
    const installed = install(f);
    const describe = () =>
      f.service.describe(f.root, { machineId: f.machineId, pluginId: installed.pluginId });
    const before = describe();
    expect(before.operations![installed.operationId]?.ready).toBe(true);
    expect(before.operations![installed.independent]?.resourceBindingDigest).toBe(
      hash({ tools: {}, services: {}, anchors: {} }),
    );
    expect(() =>
      f.service.install(f.root, {
        ...installed,
        installationRevision: "stale",
        resourceBindings: {
          ...installed.resourceBindings,
          tools: { helper: "c".repeat(64) },
        },
      }),
    ).toThrow("resource_revision_changed");
    expect(() =>
      f.service.execute(f.root, installed.pluginId, "trace", {
        jobId: "stale",
        machineId: f.machineId,
        operationId: installed.independent,
        input: {},
        outputs: [],
        resourceBindingDigest: "c".repeat(64),
      }),
    ).toThrow("resource_bindings_changed");
    f.service.event(f.channel, {
      type: "resources",
      resources: { ...f.owner.resources!, tools: {} },
    });
    expect(describe().operations![installed.operationId]).toMatchObject({
      ready: false,
      reason: "tools_unavailable",
    });
    expect(describe().operations![installed.independent]).toEqual(
      before.operations![installed.independent],
    );
    f.service.event(f.channel, {
      type: "installed",
      pluginId: installed.pluginId,
      installationRevision: "r1",
      artifactSha256: installed.artifactSha256,
      resources: {
        artifactAvailable: false,
        tools: [],
        operations: [
          { operationId: installed.operationId, available: false, reason: "managed_tool_missing" },
          { operationId: installed.independent, available: true },
        ],
      },
    });
    expect(describe().operations![installed.independent]?.ready).toBe(true);
  } finally {
    f.store.close();
  }
});

test("job service effects require a live matching installed binding and fresh native consent", () => {
  const f = fixture();
  try {
    const installed = install(f);
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId: installed.pluginId,
      installationRevision: "r1",
      artifactSha256: installed.artifactSha256,
      node: formatManifoldUri({
        kind: "operation",
        machineId: f.machineId,
        operationId: installed.operationId,
      }),
      cap: "machines:run",
      enabled: true,
    });
    const job = f.service.execute(f.root, installed.pluginId, "trace", {
      jobId: "live",
      machineId: f.machineId,
      operationId: installed.operationId,
      input: {},
      outputs: [],
    });
    const event = {
      type: "service_authorize" as const,
      subject: { kind: "job" as const, jobId: "live" },
      authorizationId: "auth-live",
      serviceId: policy.serviceId,
      revision: policy.revision,
      policySha256: hash(policy),
      operationId: "inspect",
    };
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.event(f.channel, {
      type: "state",
      jobId: "live",
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: true });
    f.service.event(f.channel, { ...event, operationId: "unbound" });
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
  } finally {
    f.store.close();
  }
});

test("credential availability changes revoke pending reads and disable only service dependencies", async () => {
  const f = fixture();
  try {
    const installed = install(f);
    const pending = f.service.readService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        services: {},
        credentialReferences: [
          { ref: "native-account", origins: [policy.origin!], available: false },
        ],
      },
    });
    f.result(requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(
      f.service.describeServices(f.reader, { machineId: f.machineId }).services[0]?.operations[0]
        ?.ready,
    ).toBe(false);
    const operations = f.service.describe(f.root, {
      machineId: f.machineId,
      pluginId: installed.pluginId,
    }).operations!;
    expect(operations[installed.operationId]?.ready).toBe(false);
    expect(operations[installed.independent]?.ready).toBe(true);
  } finally {
    f.store.close();
  }
});

function invocationFixture() {
  const original = policy.operations.inspect!;
  if ("kind" in original) throw new Error("wrong fixture operation");
  return fixture(
    {
      ...policy,
      operations: {
        inspect: {
          ...original,
          method: "PATCH",
          readable: false,
          invocable: true,
        },
      },
    },
    "invoke",
  );
}

/** Real guest registration and ctx-call bridge; only the process transport is in memory. */
async function orchestratorHost(f: {
  store: ServerStore;
  auth: AuthService;
  runtime: FakeRuntime;
  service: JobService;
  machineId: string;
  args: ServiceReadArgs;
  configuration: ServiceConfiguration;
}) {
  const manifest: PluginManifest = {
    id: "native.orchestrator",
    version: "1.0.0",
    title: "Orchestrator",
    description: "",
    capabilities: ["services:read", "services:invoke", "services:configure", "machines:run"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    entry: { server: true },
  };
  const action = (name: string, delegates: readonly Cap[]) =>
    defineServerAction({
      name,
      title: name,
      caps: [],
      delegates,
      input: z.strictObject({}),
      result: z.unknown(),
    });
  let receive: (frame: unknown) => void = () => {
    throw new Error("guest not attached");
  };
  let active: ActionCtx | undefined;
  let settle: (outcome: IsolateDispatchOutcome) => void = () => {
    throw new Error("no dispatch");
  };
  const warnings: string[] = [];
  const loaded = Promise.withResolvers<Extract<IsolateChildFrame, { t: "loaded" }>>();
  attachServerGuest(
    {
      manifest,
      actions: [
        action("invoke", ["services:invoke"]),
        action("readOnly", ["services:read"]),
        action("configure", ["services:configure"]),
        action("undeclared", []),
      ],
      handlers: {
        invoke: (ctx) => ctx.services.invoke(f.args),
        readOnly: (ctx) => ctx.services.invoke(f.args),
        configure: (ctx) =>
          ctx.services.configureConfiguration({
            machineId: f.machineId,
            expectedRevision: f.configuration.revision,
            policies: [],
          }),
        undeclared: (ctx) => ctx.jobs.describe({ machineId: f.machineId, pluginId: manifest.id }),
      },
    },
    {
      onMessage: (listener) => {
        receive = listener;
      },
      exit: (code) => {
        throw new Error(`guest exited ${code}`);
      },
      warn: (message) => {
        warnings.push(message);
      },
      send: (frame) => {
        if (frame.t === "loaded") loaded.resolve(frame);
        else if (frame.t === "load_failed") loaded.reject(new Error(frame.error));
        else if (frame.t === "dispatched") settle(frame.outcome);
        else if (frame.t === "call") {
          if (!active) throw new Error("host call outside dispatch");
          void serveCtxCall(frame.method, frame.args, { kind: "dispatch", ctx: active }).then(
            (result) =>
              receive({ t: "reply", id: frame.id, ok: true, result } satisfies IsolateHostFrame),
            (error: unknown) =>
              receive({
                t: "reply",
                id: frame.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies IsolateHostFrame),
          );
        }
      },
    },
  );
  receive({
    t: "load",
    pluginId: manifest.id,
    manifest,
    dir: "/unused",
  } satisfies IsolateHostFrame);
  const proxy = buildIsolateDef(manifest, await loaded.promise, {
    dispatch: (action, args, ctx) => {
      const pending = Promise.withResolvers<IsolateDispatchOutcome>();
      active = ctx;
      settle = pending.resolve;
      receive({
        t: "dispatch",
        id: String(ctx.traceId),
        action,
        args,
        ctx: {
          traceId: ctx.traceId,
          principal: ctx.principal,
          caps: [...ctx.auth.caps],
          isRoot: ctx.auth.isRoot,
          containerScope: ctx.containerScope,
          now: ctx.now(),
        },
      } satisfies IsolateHostFrame);
      return pending.promise;
    },
    hook: async () => {
      throw new Error("no lifecycle hook declared");
    },
  });
  const clock = new FakeClock(f.runtime);
  const rooms = new RoomManager(f.store, f.runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    f.store,
    f.auth,
    rooms,
    f.runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  const host = await testPluginHost(f.store, f.auth, rooms, broker, f.runtime, {
    settingsPlugins: [proxy.def],
  });
  host.setJobs(f.service);
  return host;
}

test("targetless guest delegates invoke only with concrete source authority and current native consent", async () => {
  const f = invocationFixture();
  try {
    const host = await orchestratorHost(f);
    let started = Promise.withResolvers<string>();
    const send = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "service_invoke") started.resolve(message.command.requestId);
      return send(message);
    };
    const pending = host.dispatch(f.reader, "native.orchestrator.invoke", {});
    const requestId = await Promise.race([
      started.promise,
      pending.then((outcome) => {
        throw new Error(`dispatch settled before native invocation: ${JSON.stringify(outcome)}`);
      }),
    ]);
    f.authorize(requestId);
    f.result(requestId);
    expect(await pending).toMatchObject({
      ok: true,
      result: { ok: true, result: { remaining: 12 } },
    });
    const denied = f.auth.mintToken(
      { principal: { name: "no source right", kind: "agent" }, caps: ["services:read"] },
      f.root,
    );
    expect(
      await host.dispatch(f.auth.authenticate(denied.token), "native.orchestrator.invoke", {}),
    ).toMatchObject({ ok: false });
    started = Promise.withResolvers<string>();
    const revoked = host.dispatch(f.reader, "native.orchestrator.invoke", {});
    const revokedRequestId = await Promise.race([
      started.promise,
      revoked.then((outcome) => {
        throw new Error(`dispatch settled before native invocation: ${JSON.stringify(outcome)}`);
      }),
    ]);
    f.authorize(revokedRequestId);
    const target = formatManifoldUri({
      kind: "service",
      machineId: f.machineId,
      serviceId: f.args.serviceId,
      operationId: f.args.operationId,
    });
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.reader.principal.id },
        node: target,
        caps: ["services:invoke"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    f.result(revokedRequestId);
    expect(await revoked).toMatchObject({ ok: false });
    expect(await host.dispatch(f.reader, "native.orchestrator.invoke", {})).toMatchObject({
      ok: false,
    });
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    expect(await host.dispatch(f.root, "native.orchestrator.invoke", {})).toMatchObject({
      ok: false,
    });
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(2);
  } finally {
    f.store.close();
  }
});

test("guest declarations cannot borrow root native methods or replace owner configuration authority", async () => {
  const f = invocationFixture();
  try {
    const host = await orchestratorHost(f);
    expect(await host.dispatch(f.root, "native.orchestrator.readOnly", {})).toMatchObject({
      ok: false,
    });
    expect(await host.dispatch(f.root, "native.orchestrator.undeclared", {})).toMatchObject({
      ok: false,
    });
    expect(await host.dispatch(f.reader, "native.orchestrator.configure", {})).toMatchObject({
      ok: false,
    });
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    expect(await host.dispatch(f.root, "native.orchestrator.configure", {})).toMatchObject({
      ok: true,
      result: { policies: [] },
    });
  } finally {
    f.store.close();
  }
});

test("direct mutations require invocation authority and an explicit projected policy, never a read grant", async () => {
  const f = invocationFixture();
  try {
    const readToken = f.auth.mintToken(
      { principal: { name: "read only", kind: "agent" }, caps: ["services:read"] },
      f.root,
    );
    const readOnly = f.auth.authenticate(readToken.token);
    await expect(f.service.invokeService(readOnly, f.args)).rejects.toThrow("service_unauthorized");
    await expect(f.service.readService(f.root, f.args)).rejects.toThrow("service_unauthorized");
    const context = serviceContext(() => f.service, f.root, "native.reader", 1, "read");
    await expect(context.invoke(f.args)).rejects.toThrow("service_unauthorized");
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    await expect(
      f.service.invokeService(f.reader, { ...f.args, revision: "stale" }),
    ).rejects.toThrow("service_binding_mismatch");
    await expect(
      f.service.invokeService(f.reader, { ...f.args, policySha256: "c".repeat(64) }),
    ).rejects.toThrow("service_binding_mismatch");
    const pending = serviceContext(() => f.service, f.reader, "native.writer", 7, "invoke").invoke(
      f.args,
    );
    const command = JobCommandSchema.parse(f.pendingCommand());
    expect(command.type).toBe("service_invoke");
    f.authorize(f.pendingCommand().requestId);
    f.result(f.pendingCommand().requestId);
    expect(await pending).toMatchObject({ ok: true, result: { remaining: 12 } });
    const events = f.store.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE door='engine.services.invoke'",
      )
      .all();
    expect(events.map((event) => JSON.parse(event.payload).callerPluginId)).toEqual([
      "native.writer",
      "native.writer",
      "native.writer",
    ]);
    expect(JSON.stringify(events)).not.toContain("private-source-input");
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("an unmarked GET operation cannot be upgraded to an invocation", async () => {
  const f = fixture();
  try {
    await expect(f.service.invokeService(f.root, f.args)).rejects.toThrow("service_unauthorized");
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
  } finally {
    f.store.close();
  }
});

test.each(["revoke", "policy", "disconnect"] as const)(
  "direct invocation %s cancels without disclosing or replaying",
  async (failure) => {
    const f = invocationFixture();
    try {
      const pending = f.service.invokeService(f.reader, f.args);
      const requestId = f.pendingCommand().requestId;
      f.authorize(requestId);
      if (failure === "revoke") f.auth.revokePrincipal(f.reader.principal.id, f.root);
      if (failure === "policy")
        f.service.configureServiceConfiguration(f.root, {
          machineId: f.machineId,
          expectedRevision: f.configuration.revision,
          policies: [],
        });
      if (failure === "disconnect") f.service.offline(f.channel);
      f.result(requestId);
      await expect(pending).rejects.toThrow(
        failure === "disconnect" ? "service_unavailable" : "service_unauthorized",
      );
      const cancel = f.commands.find((command) => command.type === "service_invoke_cancel");
      expect(JobCommandSchema.parse(cancel)).toEqual({ type: "service_invoke_cancel", requestId });
      f.prove();
      expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
    } finally {
      f.store.close();
    }
  },
);

test("read authorization and result frames cannot discharge a pending invocation", async () => {
  const f = invocationFixture();
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_read_result",
        requestId,
        reply: { type: "service_result", requestId, ok: true, result: { remaining: 999 } },
      }),
    );
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_authorize",
        subject: { kind: "read", requestId },
        authorizationId: "wrong-mode",
        serviceId: f.args.serviceId,
        revision: f.args.revision,
        policySha256: f.args.policySha256,
        operationId: f.args.operationId,
      }),
    );
    expect(f.commands.findLast((command) => command.type === "service_authorized")).toMatchObject({
      allowed: false,
    });
    await expect(pending).rejects.toThrow("service_unauthorized");
  } finally {
    f.store.close();
  }
});

test("owner refusals remain named refusals even before upstream authorization", async () => {
  const f = invocationFixture();
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_invoke_result",
        requestId,
        reply: { type: "service_result", requestId, ok: false, refusal: "service_input_invalid" },
      }),
    );
    expect(await pending).toEqual({
      type: "service_result",
      requestId,
      ok: false,
      refusal: "service_input_invalid",
    });
  } finally {
    f.store.close();
  }
});

function bodyInvocationFixture() {
  const inspect = policy.operations.inspect!;
  if ("kind" in inspect) throw new Error("wrong fixture operation");
  const f = fixture(
    {
      ...policy,
      operations: {
        inspect,
        enroll: {
          ...inspect,
          method: "POST",
          readable: false,
          invocable: true,
          body: [{ path: ["credential", "key"], value: { credentialRef: "enrollment-source" } }],
        },
      },
    },
    "invoke",
  );
  f.args.operationId = "enroll";
  return f;
}

test("hub checks each body source and origin without disabling unrelated metadata operations", async () => {
  const f = bodyInvocationFixture();
  try {
    for (const source of [
      undefined,
      { ref: "enrollment-source", origins: [policy.origin!], available: false },
      { ref: "enrollment-source", origins: ["https://other.invalid"], available: true },
    ]) {
      // Even stale operation advertisements cannot override fresh source availability.
      f.service.event(f.channel, {
        type: "resources",
        resources: {
          ...f.owner.resources!,
          credentialReferences: [
            { ref: "native-account", origins: [policy.origin!], available: true },
            ...(source ? [source] : []),
          ],
        },
      });
      const described = f.service.describeServices(f.root, { machineId: f.machineId }).services[0]!;
      expect(
        described.operations.find((operation) => operation.operationId === "inspect"),
      ).toMatchObject({ ready: true });
      expect(
        described.operations.find((operation) => operation.operationId === "enroll"),
      ).toMatchObject({
        ready: false,
        reason: "service_credential_unavailable",
      });
      await expect(f.service.invokeService(f.root, f.args)).rejects.toThrow(
        "service_credential_unavailable",
      );
    }
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        credentialReferences: [
          { ref: "native-account", origins: [policy.origin!], available: true },
          { ref: "enrollment-source", origins: [policy.origin!], available: true },
        ],
      },
    });
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.result(requestId);
    expect(await pending).toMatchObject({ ok: true });
  } finally {
    f.store.close();
  }
});

test("body source disappearance revokes pending invocations without affecting metadata authority", async () => {
  const f = bodyInvocationFixture();
  try {
    const available = [
      { ref: "native-account", origins: [policy.origin!], available: true },
      { ref: "enrollment-source", origins: [policy.origin!], available: true },
    ];
    f.service.event(f.channel, {
      type: "resources",
      resources: { ...f.owner.resources!, credentialReferences: available },
    });
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        credentialReferences: [available[0]!],
      },
    });
    f.result(requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(
      f.commands.some(
        (command) => command.type === "service_invoke_cancel" && command.requestId === requestId,
      ),
    ).toBe(true);
    const operations = f.service.describeServices(f.root, { machineId: f.machineId }).services[0]!
      .operations;
    expect(operations.find((operation) => operation.operationId === "inspect")?.ready).toBe(true);
    expect(operations.find((operation) => operation.operationId === "enroll")?.ready).toBe(false);
  } finally {
    f.store.close();
  }
});
