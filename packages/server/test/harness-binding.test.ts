import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";
import { defineAction } from "@manifold/plugin";
import {
  canonicalJobJson,
  CreateRunResultSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  LaunchRunResultSchema,
  ListHarnessesResultSchema,
  ListHarnessSessionsResultSchema,
  SessionRefSchema,
  type ActionOutcome,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type ServerToAgentMessage,
  type TerminalRuntime,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { SessionChannel } from "../src/session-channel.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  FakeSocket,
  testPluginHost,
  testStore,
  testTileTrees,
} from "./helpers.ts";

const pluginId = "test.harness";
const operationId = `${pluginId}.run`;
const hash = "a".repeat(64);
const machine: MachineHalf = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/harness",
      sha256: hash,
      entrySha256: hash,
      format: "raw",
      entry: ["harness"],
      maxBytes: 4096,
      maxExpandedBytes: 4096,
      maxMembers: 1,
    },
  },
  operations: {
    [operationId]: {
      argv: [],
      input: {},
      runtimeTools: [],
      locations: [],
      outputs: [],
      network: "none",
      limits: { timeoutMs: 60000, memoryBytes: 1048576, processes: 2, outputBytes: 65536 },
      stdin: true,
    },
  },
  locations: {},
};

function result(outcome: ActionOutcome): unknown {
  if (!outcome.ok)
    throw new Error(`action refused: ${outcome.denial.rule}: ${outcome.denial.message}`);
  return outcome.result;
}

async function fixture(dependency?: ServerPluginDef) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, "a".repeat(64), runtime);
  const root = auth.authenticate("a".repeat(64));
  const machineId = auth.enrollMachine("harness owner", root).machine.id;
  const containerId = runtime.newId();
  store.createContainer({
    id: containerId,
    name: "Run",
    createdAt: runtime.now(),
    discipline: "composition",
  });
  const descriptor: TerminalRuntime = {
    machineId,
    pluginId,
    operationId,
    installationRevision: "r1",
    artifactSha256: hash,
    resourceBindingDigest: createHash("sha256").update("null").digest("hex"),
    input: {},
  };
  const definition: ServerPluginDef = {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: "Test harness",
      description: "Binding boundary fixture",
      capabilities: ["machines:run", "jobs:read", "jobs:input"],
      ...(dependency
        ? { dependencies: { [dependency.manifest.id]: { type: "required" as const } } }
        : {}),
      machine,
      contributes: {
        panels: [],
        sections: [],
        elements: [],
        tools: [],
        events: [],
        harness: {
          id: "test-harness",
          title: "Test harness",
          profileSchema: { type: "object" },
          sessionRef: "typed",
        },
      },
    },
    actions: [],
    handlers: {},
    harness: {
      profileSchema: z.strictObject({ label: z.string().min(1) }),
      async launch(ctx, run) {
        if (ctx.pluginId !== pluginId) throw new Error("harness context identity mismatch");
        await ctx.storage.set("last-run", run.id);
        return {
          runtime: descriptor,
          session: { harness: "test-harness", machineId, sessionId: run.id },
          reviewDigest: hash,
        };
      },
      async sessions(ctx) {
        const id = await ctx.storage.get("last-run");
        return id ? [{ harness: "test-harness", machineId, sessionId: id }] : [];
      },
      async resolveSession(ctx, ref) {
        return (await ctx.storage.get("last-run")) === ref.sessionId ? ref : null;
      },
      async send(ctx, run, input) {
        const node = ctx.jobs.runTerminal(run.id);
        const job = ctx.jobs.status(node);
        if (job.nextInputSeq === null) throw new Error("input cursor unavailable");
        await ctx.jobs.input({
          node,
          requestId: ctx.newId(),
          seq: job.nextInputSeq,
          data: Buffer.from(input).toString("base64"),
          eof: false,
        });
      },
    },
  };
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    settingsPlugins: dependency ? [definition, dependency] : [definition],
  });
  const service = new JobService(store, auth, runtime);
  host.setJobs(service);
  broker.setJobs(service);
  service.install(root, {
    machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    machine,
  });
  service.consent(root, {
    machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256: hash,
    node: `manifold://machine/${machineId}/operation/${operationId}`,
    cap: "machines:run",
    enabled: true,
  });
  const commands: JobCommand[] = [];
  const sent: ServerToAgentMessage[] = [];
  const channel = {
    machineId,
    protocolVersion: 32,
    terminalHostId: "terminal-host",
    terminalExecution: "governed" as const,
    send(message: ServerToAgentMessage) {
      sent.push(message);
      if (message.type === "job_command") commands.push(message.command);
      return true;
    },
  };
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "native-owner",
    terminalHostId: "terminal-host",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "b".repeat(64),
  };
  const connect = (protocolVersion: number, ownerProtocolVersion: number) => {
    channel.protocolVersion = protocolVersion;
    const advertised = { ...owner, protocolVersion: ownerProtocolVersion };
    service.online(channel, advertised, "epoch");
    if (ownerProtocolVersion === JOB_OWNER_PROTOCOL_VERSION) {
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const proof = {
        nonce: challenge.nonce,
        serverEpoch: challenge.serverEpoch,
        machineId,
        owner: advertised,
      };
      service.event(channel, {
        type: "owner_proof",
        ...proof,
        signature: sign(null, Buffer.from(canonicalJobJson(proof)), pair.privateKey).toString(
          "base64",
        ),
      });
      service.event(channel, {
        type: "installed",
        pluginId,
        installationRevision: "r1",
        artifactSha256: hash,
      });
    }
    broker.setMachineOnline(channel);
  };
  connect(32, JOB_OWNER_PROTOCOL_VERSION);
  const grant = {
    caps: ["containers:read"] as const,
    targets: ["manifold://"],
    reach: "subtree" as const,
    maxRunLifetimeMs: 60000,
    delegation: { maxDepth: 0, maxDescendants: 0 },
    expiresAt: runtime.now() + 600000,
  };
  const registered = auth.registerAgent(
    {
      name: "Harness agent",
      purpose: "Inspect the launch boundary",
      harness: "test-harness",
      grant: { ...grant, caps: [...grant.caps] },
      context: { profile: { label: "reviewed" } },
    },
    root,
  );
  const create = async () =>
    CreateRunResultSchema.parse(
      result(
        await host.dispatch(root, "core.access.createRun", {
          agentId: registered.agent.agentId,
          target: { machineId, containerId },
        }),
      ),
    );
  const launch = async (runId: string) =>
    LaunchRunResultSchema.parse(
      result(await host.dispatch(root, "core.access.launchRun", { runId })),
    );
  const open = async (value: TerminalRuntime, actor: AuthContext = root) => {
    const socket = new FakeSocket();
    const peer = new SessionChannel(runtime.newId(), socket, actor, containerId, "c1");
    const request = {
      elementId: runtime.newId(),
      machineId,
      cols: 80,
      rows: 24,
      placement: "tile" as const,
      runtime: value,
    };
    const admission = z
      .strictObject({ traceId: z.number() })
      .parse(
        result(await host.dispatch(actor, "core.terminals.open", { ...request, containerId })),
      );
    broker.open(peer, { type: "terminal_open", ...request }, admission.traceId);
    return socket;
  };
  return {
    auth,
    root,
    host,
    store,
    clock,
    registered,
    descriptor,
    definition,
    create,
    launch,
    open,
    sent,
    connect,
    duplicate: () =>
      testPluginHost(store, auth, rooms, broker, runtime, {
        settingsPlugins: [
          definition,
          { ...definition, manifest: { ...definition.manifest, id: "test.other-harness" } },
        ],
      }),
    close() {
      host.close();
      store.close();
    },
  };
}

test("browser descriptors bind distinct runs without returning or journaling their credential", async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const second = await f.create();
    expect(first.credential).toBeUndefined();
    const a = await f.launch(first.run.id);
    const b = await f.launch(second.run.id);
    expect(a.runtime.launchBinding).not.toBe(b.runtime.launchBinding);
    expect(a.runtime.input).toEqual({});
    const other = f.auth.mintToken(
      {
        principal: { name: "Another opener", kind: "human" },
        caps: ["containers:read", "terminals:spawn"],
      },
      f.root,
    );
    await f.open(a.runtime, f.auth.authenticate(other.token));
    await f.open({ ...a.runtime, input: { changed: true } });
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    await f.open(a.runtime);
    const firstCreate = f.sent.find((message) => message.type === "create");
    if (firstCreate?.type !== "create" || !firstCreate.runtime?.privateEnv)
      throw new Error("native run launch missing");
    const token = firstCreate.runtime.privateEnv.MANIFOLD_RUN_TOKEN;
    expect(f.auth.authenticate(token).agentRunId).toBe(first.run.id);
    expect(firstCreate.runtime.request.terminal?.runId).toBe(first.run.id);
    expect(firstCreate.env).toEqual({});
    expect(JSON.stringify([first, a, firstCreate.runtime.request])).not.toContain(token);
    await f.open(a.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toHaveLength(1);
    await f.open(b.runtime);
    const creates = f.sent.filter((message) => message.type === "create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.runtime?.privateEnv?.MANIFOLD_RUN_ID).toBe(second.run.id);
    expect(creates[1]?.runtime?.privateEnv?.MANIFOLD_RUN_TOKEN).not.toBe(token);
    expect(f.auth.agentRunPolicyState(f.auth.authenticate(token))).toBe("pending_policy");
  } finally {
    f.close();
  }
});

test("expired launch bindings cannot reach native admission", async () => {
  const f = await fixture();
  try {
    const created = await f.create();
    const launch = await f.launch(created.run.id);
    f.clock.advance(60001);
    await f.open(launch.runtime);
    expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
  } finally {
    f.close();
  }
});

test("live harness inventory owns profile validation and loses execution on disable", async () => {
  const f = await fixture();
  try {
    const inventory = ListHarnessesResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnesses", {})),
    );
    expect(inventory.harnesses.map((harness) => harness.id)).toContain("test-harness");
    expect(() =>
      f.auth.registerAgent(
        {
          name: "Invalid",
          purpose: "Bad profile",
          harness: "test-harness",
          grant: f.registered.agent.grant,
          context: { profile: { label: 7 } },
        },
        f.root,
      ),
    ).toThrow("harness profile invalid");
    const created = await f.create();
    result(
      await f.host.dispatch(f.root, "engine.plugins.setEnabled", { id: pluginId, enabled: false }),
    );
    expect(
      (await f.host.dispatch(f.root, "core.access.launchRun", { runId: created.run.id })).ok,
    ).toBe(false);
    const disabled = ListHarnessesResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnesses", {})),
    );
    expect(disabled.harnesses.map((harness) => harness.id)).not.toContain("test-harness");
  } finally {
    f.close();
  }
});

test("harness session inventory bounds retained transcripts and reports truncation at the limit", async () => {
  const f = await fixture();
  try {
    const harness = f.definition.harness;
    if (!harness) throw new Error("fixture harness missing");
    const sessions = Array.from({ length: 101 }, (_, index) => ({
      harness: "test-harness",
      machineId: f.descriptor.machineId,
      sessionId: `retained-${index}`,
    }));
    harness.sessions = async () => sessions;
    const request = { harness: "test-harness", target: { machineId: f.descriptor.machineId } };
    const truncated = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(truncated).toEqual({ sessions: sessions.slice(0, 100), truncated: true });

    sessions.pop();
    const complete = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(complete).toEqual({ sessions, truncated: false });
  } finally {
    f.close();
  }
});

test("duplicate harness ids fail assembly instead of shadowing the owning runtime", async () => {
  const f = await fixture();
  try {
    await expect(f.duplicate()).rejects.toThrow('duplicate harness "test-harness"');
  } finally {
    f.close();
  }
});

test("private launches refuse older transports and owners before disclosure and again at native admission", async () => {
  const f = await fixture();
  try {
    const pending = await f.create();
    const bound = await f.launch(pending.run.id);
    const unlaunched = await f.create();
    for (const [transport, owner] of [
      [31, JOB_OWNER_PROTOCOL_VERSION],
      [32, JOB_OWNER_PROTOCOL_VERSION - 1],
    ] as const) {
      f.connect(transport, owner);
      const refused = await f.host.dispatch(f.root, "core.access.launchRun", {
        runId: unlaunched.run.id,
      });
      expect(refused).toMatchObject({
        ok: false,
        denial: { message: "run_launch_protocol_unsupported" },
      });
      const socket = await f.open(bound.runtime);
      expect(socket.messages()).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "forbidden",
          message: "run_launch_protocol_unsupported",
        }),
      );
      expect(f.sent.filter((message) => message.type === "create")).toEqual([]);
    }
    // Compatibility refusal does not consume an otherwise valid one-use launch binding.
    f.connect(32, JOB_OWNER_PROTOCOL_VERSION);
    await f.open(bound.runtime);
    const create = f.sent.find((message) => message.type === "create");
    expect(create?.runtime?.privateEnv?.MANIFOLD_RUN_ID).toBe(pending.run.id);
    const current = await f.launch(unlaunched.run.id);
    expect(current.runtime.launchBinding).not.toBe(bound.runtime.launchBinding);
  } finally {
    f.close();
  }
});

test("harness dependency calls retain the owning plugin and the incoming call chain", async () => {
  const catalog = "test.harness-catalog";
  const inventory = z.strictObject({ sessions: SessionRefSchema.array() });
  let returnToAccess = false;
  const dependency: ServerPluginDef = {
    manifest: {
      id: catalog,
      version: "1.0.0",
      title: "Harness catalog",
      description: "Resolves retained harness conversations",
      capabilities: [],
      dependencies: { "core.access": { type: "required" } },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "sessions",
        title: "Resolve conversations",
        caps: [],
        input: z.strictObject({ machineId: z.string() }),
        result: inventory,
      }),
    ],
    handlers: {
      async sessions(ctx: ActionCtx, input: { machineId: string }) {
        if (returnToAccess) {
          // A lost incoming frame must fail the assertion, not recurse without a bound.
          returnToAccess = false;
          return ctx.actions.call({
            plugin: "core.access",
            action: "listHarnessSessions",
            input: { harness: "test-harness", target: input },
          });
        }
        return {
          sessions: [
            { harness: "test-harness", machineId: input.machineId, sessionId: "retained" },
          ],
        };
      },
    },
  };
  const f = await fixture(dependency);
  try {
    f.definition.harness!.sessions = async (ctx, target) =>
      inventory.parse(
        await ctx.actions.call({ plugin: catalog, action: "sessions", input: target }),
      ).sessions;
    const request = { harness: "test-harness", target: { machineId: f.descriptor.machineId } };
    const listed = ListHarnessSessionsResultSchema.parse(
      result(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)),
    );
    expect(listed.sessions).toEqual([
      { harness: "test-harness", machineId: f.descriptor.machineId, sessionId: "retained" },
    ]);
    returnToAccess = true;
    expect(await f.host.dispatch(f.root, "core.access.listHarnessSessions", request)).toMatchObject(
      {
        ok: false,
        denial: { rule: "refused", message: expect.stringContaining("dispatch_cycle:") },
      },
    );
  } finally {
    f.close();
  }
});
