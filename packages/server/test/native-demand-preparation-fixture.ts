import "../src/shared-modules.ts";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@manifold/plugin-kit/pack";
import {
  canonicalJobJson,
  formatManifoldUri,
  JOB_OWNER_PROTOCOL_VERSION,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type PluginManifest,
  type TerminalRuntime,
} from "@manifold/protocol";
import type { ActionAuthorityFence } from "../src/action-authority-fence.ts";
import { AuthService } from "../src/auth.ts";
import type { InstalledPluginRef, IsolateLoadResult } from "../src/isolate/contract.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import type { ActionCtx } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";

export const NATIVE_PREPARATION_PLUGIN = "test.native-preparation";
const operationId = `${NATIVE_PREPARATION_PLUGIN}.shell`;
const artifact = "b".repeat(64);
const containerId = "native-preparation-home";
const terminalHostId = "native-preparation-host";

export interface NativePreparationPrivateState {
  readonly privateValue: string;
  readonly privateSession: string;
  readonly terminalRuntime: TerminalRuntime;
}

/** Observe real child requests at the host callback; never supply a synthetic reply. */
class RecordingSupervisor extends IsolateSupervisor {
  readonly preparation: unknown[] = [];

  override async load(ref: InstalledPluginRef): Promise<IsolateLoadResult> {
    const loaded = await super.load(ref);
    const invoke = loaded.def.handlers.native;
    if (invoke === undefined) return loaded;
    return {
      ...loaded,
      def: {
        ...loaded.def,
        handlers: {
          ...loaded.def.handlers,
          native: async (ctx, args) => {
            const demand = ctx.prepareNativeDemand;
            const prepared = ctx.admitPrepared;
            return invoke(
              {
                ...ctx,
                ...(demand === undefined
                  ? {}
                  : {
                      prepareNativeDemand: (
                        ...values: Parameters<NonNullable<ActionCtx["prepareNativeDemand"]>>
                      ) => {
                        this.preparation.push({ method: "prepare.native.demand", args: values });
                        return demand(...values);
                      },
                    }),
                ...(prepared === undefined
                  ? {}
                  : {
                      admitPrepared: (
                        ...values: Parameters<NonNullable<ActionCtx["admitPrepared"]>>
                      ) => {
                        this.preparation.push({ method: "prepared", args: values });
                        return prepared(...values);
                      },
                    }),
              },
              args,
            );
          },
        },
      },
    };
  }
}

export async function nativePreparationFixture(
  hardened = true,
  invalidLiteral = false,
  withResources = false,
) {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-native-preparation-"));
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const ownerKey = randomBytes(32).toString("hex");
  const serviceRef: { current: JobService | null } = { current: null };
  const auth = new AuthService(store, ownerKey, runtime, {
    decide: (request) => {
      const service = serviceRef.current;
      if (service === null) throw new Error("native preparation service is not initialized");
      return service.decide(request);
    },
  });
  const root = auth.authenticate(ownerKey);
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
  const runner = new RecordingSupervisor({ logger: silentLogger, runtime });
  const host = await testPluginHost(store, auth, rooms, broker, runtime, {
    isolates: { runner, dataDir },
  });
  const service = new JobService(store, auth, runtime);
  serviceRef.current = service;
  host.setJobs(service);
  const fences: ActionAuthorityFence[] = [];
  const close = async () => {
    for (const fence of fences) fence.close();
    host.close();
    await runner.close();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    const machineId = auth.enrollMachine("native preparation account", root).machine.id;
    store.createContainer({
      id: containerId,
      name: "Native preparation",
      discipline: "composition",
      createdAt: runtime.now(),
    });
    const resourceBindings = withResources
      ? { tools: { node: "a".repeat(64) }, anchors: {}, services: {} }
      : undefined;
    const machine: MachineHalf = {
      ...(withResources ? { requiresResourceBindings: true } : {}),
      artifacts: {
        "linux-x64": {
          url: "https://example.invalid/native-preparation",
          sha256: artifact,
          entrySha256: artifact,
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
          runtimeTools: withResources ? ["node"] : [],
          locations: [],
          outputs: [],
          network: "none",
          limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
          stdin: true,
        },
      },
      locations: {},
    };
    machine.operations[`${NATIVE_PREPARATION_PLUGIN}.other`] = structuredClone(
      machine.operations[operationId]!,
    );
    machine.artifacts["linux-arm64"] = {
      ...machine.artifacts["linux-x64"]!,
      sha256: "d".repeat(64),
      entrySha256: "d".repeat(64),
    };
    const manifest: PluginManifest = {
      id: NATIVE_PREPARATION_PLUGIN,
      version: "1.0.0",
      title: "Native preparation",
      description: "",
      capabilities: ["terminals:spawn", "machines:run"],
      entry: { server: true },
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
      machine,
    };
    // Generated opaque sentinels are never credentials, fixture output, or public response data.
    const privateValue = randomBytes(12).toString("hex");
    const privateSession = randomBytes(12).toString("hex");
    const terminalRuntime: TerminalRuntime = {
      machineId,
      pluginId: NATIVE_PREPARATION_PLUGIN,
      operationId,
      installationRevision: "one",
      artifactSha256: artifact,
      resourceBindingDigest: createHash("sha256")
        .update(canonicalJobJson(resourceBindings ?? null))
        .digest("hex"),
      input: { value: invalidLiteral ? 1 : privateValue },
      session: { harness: "native-preparation", machineId, sessionId: privateSession },
    };
    const authorDir = join(dataDir, "author");
    mkdirSync(authorDir);
    mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR));
    writeFileSync(join(authorDir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(
      join(authorDir, "server.ts"),
      `
import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
import { defineServerAction, defineServerPlugin } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@manifold/plugin-kit/server")))};
const runtime = ${JSON.stringify(terminalRuntime)};
${invalidLiteral ? "" : `runtime.input.value = ${JSON.stringify(`  ${privateValue}  `)}.trim();`}
const definition = {
  manifest: ${JSON.stringify(manifest)},
  actions: [defineServerAction({
    name: "native", title: "Native", caps: ["terminals:spawn"], input: z.null(), result: z.null(),
  })],
  prepareActions: {
    native: {
      caps: ["machines:run"],
      async prepare(ctx) {
        const additionalRequirements = await ctx.native.demand(runtime, runtime.machineId, ${JSON.stringify(containerId)});
        return { args: null, targets: [], additionalRequirements };
      },
    },
  },
  handlers: { native: async () => null },
};
defineServerPlugin(definition);
export default definition;
`,
    );
    const packed = await packPlugin(
      authorDir,
      join(dataDir, PLUGIN_UPLOADS_DIR, "native-preparation.manifold-plugin.json"),
    );
    await host.install(
      { source: packed.file, sha256: packed.sha256, hardened, grant: ["terminals:spawn"] },
      root.principal.id,
      auth.credentialReference(root),
    );
    const commands: JobCommand[] = [];
    const channel = {
      machineId,
      send: ({ command }: { type: "job_command"; command: JobCommand }) => {
        commands.push(command);
        return true;
      },
    };
    const keys = generateKeyPairSync("ed25519");
    const owner: JobOwner = {
      protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
      ownerId: "native-preparation-owner",
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      generation: 1,
      platforms: ["linux-x64", "linux-arm64"],
      inventoryDigest: "c".repeat(64),
      terminalHostId,
      ...(resourceBindings === undefined
        ? {}
        : { resources: { ...resourceBindings, serviceDefinitions: {} } }),
    };
    const prove = (installed = true) => {
      service.online(channel, owner, "native-preparation-epoch");
      const challenge = commands.at(-1);
      if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
      const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
      service.event(channel, {
        type: "owner_proof",
        ...body,
        signature: sign(null, Buffer.from(canonicalJobJson(body)), keys.privateKey).toString(
          "base64",
        ),
      });
      if (installed)
        service.event(channel, {
          type: "installed",
          pluginId: NATIVE_PREPARATION_PLUGIN,
          installationRevision: "one",
          artifactSha256: artifact,
        });
    };
    if (withResources) prove(false);
    service.install(root, {
      machineId,
      pluginId: NATIVE_PREPARATION_PLUGIN,
      installationRevision: "one",
      artifactSha256: artifact,
      machine,
      ...(resourceBindings === undefined ? {} : { resourceBindings }),
    });
    const operationNode = formatManifoldUri({ kind: "operation", machineId, operationId });
    service.consent(root, {
      machineId,
      pluginId: NATIVE_PREPARATION_PLUGIN,
      installationRevision: "one",
      artifactSha256: artifact,
      node: operationNode,
      cap: "machines:run",
      enabled: true,
    });
    prove();
    return {
      auth,
      root,
      host,
      broker,
      store,
      service,
      machine,
      resourceBindings,
      owner,
      commands,
      channel,
      terminalRuntime,
      terminal: { terminalId: "prepared-terminal", terminalHostId, containerId },
      privateValue,
      privateSession,
      preparation: runner.preparation,
      operationNode,
      prove,
      review: () => host.prepareActionInput(root, `${NATIVE_PREPARATION_PLUGIN}.native`, null),
      async capture() {
        const handoff: { value?: { fence: ActionAuthorityFence } } = {};
        const outcome = await host.dispatch(
          root,
          `${NATIVE_PREPARATION_PLUGIN}.native`,
          null,
          null,
          {
            onPrepared: (_args, fence) => {
              fences.push(fence);
              handoff.value = { fence };
            },
          },
        );
        if (!outcome.ok || handoff.value === undefined)
          throw new Error("native preparation did not reach real host admission");
        // Native admission is reached from a terminal-open trace, not the preparer's
        // action trace. Keep the real prepared fence but emulate that broker-owned origin.
        const traceId = store.appendTrace({
          actor: root.principal.id,
          authority: "terminals:spawn",
          door: "core.terminals.open",
          containerId,
          session: null,
          ts: runtime.now(),
          outcome: "ok",
          targets: [],
          payload: {},
        });
        return { fence: handoff.value.fence, traceId };
      },
      effects: () => ({
        jobs: store.db.query("SELECT COUNT(*) AS count FROM machine_jobs").get(),
        decisions: store.db.query("SELECT COUNT(*) AS count FROM machine_job_decisions").get(),
        consents: store.db.query("SELECT COUNT(*) AS count FROM machine_job_consents").get(),
        tokens: store.db.query("SELECT COUNT(*) AS count FROM tokens").get(),
        terminals: store.listTerminals().map(({ id }) => id),
        commands: commands.length,
      }),
      traces: () => store.db.query("SELECT payload FROM events WHERE type='trace'").all(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
