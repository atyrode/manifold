import { expect, test } from "bun:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { formatManifoldUri, JOB_OWNER_PROTOCOL_VERSION, type Cap } from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type SettledJob,
} from "../../protocol/src/jobs.ts";
import type { JobSettledCtx } from "@manifold/plugin";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import type { ServerStore } from "../src/stores.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

/**
 * `onJobSettled` — THE ONE WAKE A SERVER HALF HAS FOR ITS OWN FINISHED WORK.
 *
 * A door answers a caller and a panel runs while somebody is looking; a job outlives both, so
 * without this hook a background half learns that its job ended by being asked. What is
 * defended here is the ADDRESSING, because that is what makes the wake safe to hand out: it
 * reaches the plugin whose request the job was and nobody else, and a half that declared no
 * hook is simply not called rather than called with nothing.
 */

const OWNER_KEY = "a".repeat(64);
const hash = "a".repeat(64);
const limits = { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 };

function machineHalf(pluginId: string): MachineHalf {
  return {
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
      [`${pluginId}.run`]: {
        argv: [{ input: "value" }],
        input: { value: { type: "string", required: true, maxLength: 32 } },
        runtimeTools: [],
        locations: [],
        outputs: [],
        network: "none",
        limits,
        stdin: false,
      },
    },
    locations: {},
  };
}

function def(
  pluginId: string,
  onJobSettled?: (ctx: JobSettledCtx, job: SettledJob) => void,
): ServerPluginDef {
  return {
    manifest: {
      id: pluginId,
      version: "1.0.0",
      title: pluginId,
      description: "A worker half that runs one governed operation.",
      capabilities: [],
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine: machineHalf(pluginId),
    },
    actions: [],
    handlers: {},
    ...(onJobSettled ? { lifecycle: { onJobSettled } } : {}),
  };
}

interface Fixture {
  readonly store: ServerStore;
  readonly root: AuthContext;
  readonly host: PluginHost;
  readonly service: JobService;
  readonly machineId: string;
  readonly channel: {
    machineId: string;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
  readonly owner: JobOwner;
  readonly privateKey: KeyObject;
}

async function fixture(defs: readonly ServerPluginDef[]): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
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
    settingsPlugins: [...defs],
  });
  const service = new JobService(store, auth, runtime);
  const machineId = auth.enrollMachine("worker", root).machine.id;
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
  // The host owns the resolvers and the settled fan-out, exactly as `main.ts` composes them.
  host.setJobs(service);
  for (const entry of defs)
    service.install(root, {
      machineId,
      pluginId: entry.manifest.id,
      installationRevision: "r1",
      artifactSha256: hash,
      machine: machineHalf(entry.manifest.id),
    });
  for (const entry of defs)
    for (const cap of ["machines:run", "jobs:read"] as Cap[])
      service.consent(root, {
        machineId,
        pluginId: entry.manifest.id,
        installationRevision: "r1",
        artifactSha256: hash,
        node: formatManifoldUri({
          kind: "operation",
          machineId,
          operationId: `${entry.manifest.id}.run`,
        }),
        cap,
        enabled: true,
      });
  service.online(channel, owner, "epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
  service.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
  });
  for (const entry of defs)
    service.event(channel, {
      type: "installed",
      pluginId: entry.manifest.id,
      installationRevision: "r1",
      artifactSha256: hash,
    });
  return { store, root, host, service, machineId, channel, owner, privateKey: pair.privateKey };
}

/** One job of `pluginId`, run to a sealed result the way its owner reports one. */
function run(f: Fixture, pluginId: string, jobId: string): void {
  const job = f.service.execute(f.root, pluginId, "trace-1", {
    jobId,
    machineId: f.machineId,
    operationId: `${pluginId}.run`,
    input: { value: "safe" },
    outputs: [],
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
      finishedAt: 9,
      usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 4 },
      limits,
      outputs: [{ outputId: "o-1", name: "stdout", sha256: hash, bytes: 4, files: 1 }],
    },
  });
}

test("a settled job wakes the half that started it, with its node and its own authority", async () => {
  const woken: { plugin: string; job: SettledJob }[] = [];
  const journalled: number[] = [];
  const arrived = Promise.withResolvers<void>();
  const f = await fixture([
    def("sample.alpha", (ctx, job) => {
      woken.push({ plugin: "sample.alpha", job });
      // The hook's own job slice, discharged against the job's credential: the wake is
      // actionable rather than an announcement a door has to follow up on.
      journalled.push(
        ctx.jobs.journal({
          node: {
            kind: "job",
            machineId: job.machineId,
            operationId: job.operationId,
            jobId: job.jobId,
          },
        }).events.length,
      );
      arrived.resolve();
    }),
    def("sample.beta", (_ctx, job) => woken.push({ plugin: "sample.beta", job })),
  ]);
  try {
    run(f, "sample.alpha", "job-alpha");
    await arrived.promise;
    expect(woken).toEqual([
      {
        plugin: "sample.alpha",
        job: {
          jobId: "job-alpha",
          machineId: f.machineId,
          operationId: "sample.alpha.run",
          pluginId: "sample.alpha",
          state: "exited",
          exitCode: 0,
          reason: null,
          finishedAt: 9,
          outputs: [{ outputId: "o-1", name: "stdout", sha256: hash, bytes: 4, files: 1 }],
        },
      },
    ]);
    expect(journalled).toEqual([1]);
  } finally {
    f.store.close();
  }
});

test("a half that declared no hook is left alone, and the settle after it still lands", async () => {
  const woken: { plugin: string; jobId: string }[] = [];
  const arrived = Promise.withResolvers<void>();
  const f = await fixture([
    def("sample.alpha", (_ctx, job) => {
      woken.push({ plugin: "sample.alpha", jobId: job.jobId });
      arrived.resolve();
    }),
    def("sample.quiet"),
  ]);
  try {
    // The half without a hook settles FIRST, so the awaited wake proves the fan-out survived it.
    run(f, "sample.quiet", "job-quiet");
    run(f, "sample.alpha", "job-alpha");
    await arrived.promise;
    expect(woken).toEqual([{ plugin: "sample.alpha", jobId: "job-alpha" }]);
    expect(f.service.jobs.get("job-quiet")?.result?.state).toBe("exited");
  } finally {
    f.store.close();
  }
});
