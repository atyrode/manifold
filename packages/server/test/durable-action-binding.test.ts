import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "@manifold/plugin-kit/pack";
import {
  canonicalJobJson,
  formatManifoldUri,
  JOB_OWNER_PROTOCOL_VERSION,
  type AuthoredCap,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
  type PluginManifest,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";

const OWNER_KEY = "d".repeat(64);
const PLUGIN_ID = "test.durable-binding";
const OPERATION_ID = `${PLUGIN_ID}.run`;
const ARTIFACT_HASH = "b".repeat(64);
const machine: MachineHalf = {
  artifacts: {
    "linux-x64": {
      url: "https://example.invalid/worker",
      sha256: ARTIFACT_HASH,
      entrySha256: ARTIFACT_HASH,
      format: "raw",
      entry: ["worker"],
      maxBytes: 4096,
      maxExpandedBytes: 4096,
      maxMembers: 1,
    },
  },
  operations: {
    [OPERATION_ID]: {
      argv: [{ input: "value" }],
      input: { value: { type: "string", required: true, maxLength: 32 } },
      runtimeTools: [],
      locations: [],
      outputs: [],
      network: "none",
      limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
      stdin: false,
    },
  },
  locations: {},
};

async function fixture(preparerCaps: readonly AuthoredCap[] = ["plugins:manage", "tokens:mint"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-durable-binding-"));
  const path = join(dataDir, "hub.sqlite");
  const runtime = new FakeRuntime();
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "binding-owner",
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    generation: 1,
    platforms: ["linux-x64"],
    inventoryDigest: "c".repeat(64),
  };
  const commands: JobCommand[] = [];
  let store: ServerStore;
  let auth: AuthService;
  let service: JobService;
  let runner: IsolateSupervisor;
  let host: PluginHost;
  async function boot() {
    store = new ServerStore(openDatabase(path));
    auth = new AuthService(store, OWNER_KEY, runtime, {
      decide: (request) => service.decide(request),
    });
    const clock = new FakeClock(runtime);
    const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
    const broker = new TerminalBroker(
      store, auth, rooms, runtime, clock, silentLogger,
      () => "http://localhost:7777", testTileTrees,
    );
    runner = new IsolateSupervisor({ logger: silentLogger, runtime });
    host = await testPluginHost(store, auth, rooms, broker, runtime, {
      isolates: { runner, dataDir },
    });
    service = new JobService(store, auth, runtime);
    host.setJobs(service);
  }
  await boot();
  const root = () => auth.authenticate(OWNER_KEY);
  const machineId = auth.enrollMachine("scheduled account", root()).machine.id;
  const channel = {
    machineId,
    send: ({ command }: { type: "job_command"; command: JobCommand }) => {
      commands.push(command);
      return true;
    },
  };
  const prove = () => {
    service.online(channel, owner, "binding-epoch");
    const challenge = commands.at(-1);
    if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
    const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
    service.event(channel, {
      type: "owner_proof",
      ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
    });
    service.event(channel, {
      type: "installed", pluginId: PLUGIN_ID, installationRevision: "one",
      artifactSha256: ARTIFACT_HASH,
    });
  };
  const manifest: PluginManifest = {
    id: PLUGIN_ID,
    version: "1.0.0",
    title: "Durable binding",
    description: "",
    capabilities: ["machines:run", "machines:read", "tokens:mint", "plugins:manage"],
    dataVersion: { major: 1, minor: 0 },
    purges: ["storage"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    entry: { server: true },
    machine,
  };
  const authorDir = join(dataDir, "author");
  mkdirSync(authorDir);
  mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR));
  writeFileSync(join(authorDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(authorDir, "server.ts"), `
import { z } from ${JSON.stringify(fileURLToPath(import.meta.resolve("zod")))};
import { defineServerAction, defineServerPlugin } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@manifold/plugin-kit/server")))};
const input = z.strictObject({
  operation: z.strictObject({
    kind: z.literal("operation"), machineId: z.string(),
    operationId: z.literal(${JSON.stringify(OPERATION_ID)}),
  }),
  scheduleId: z.string(), extra: z.boolean(),
});
const scheduleAction = (name, caps, delegates) => defineServerAction({
  name, title: name, caps: ["machines:run", ...caps], delegates, input, result: z.strictObject({}),
  requirements: ["machines:run", ...caps].map(cap => ({ cap, target: ["operation"] })),
});
const prepare = async (_ctx, args) => ({
  args, targets: args.operation === undefined ? [] : [args.operation],
  additionalRequirements: args.extra ? [{ cap: "tokens:mint", node: "manifold://", reach: "node" }] : [],
});
const register = async (ctx, args) => {
  await ctx.jobs.schedule({
    jobId: "template-" + args.scheduleId, machineId: args.operation.machineId,
    operationId: args.operation.operationId, input: { value: args.scheduleId }, outputs: [],
    scheduleId: args.scheduleId, revision: "one", firstNominalAt: 1000,
    intervalMs: 60000, deadlineMs: 30000, expiresAt: 60000, offlinePolicy: "coalesce-one",
  });
  return {};
};
const definition = {
  manifest: ${JSON.stringify(manifest)},
  actions: [
    scheduleAction("declared", ["tokens:mint"], ["machines:run"]),
    scheduleAction("delegated", [], ["machines:run", "machines:read"]),
    scheduleAction("prepared", [], ["machines:run"]),
    defineServerAction({ name: "record", title: "Record", caps: [],
      input: z.strictObject({ value: z.string().trim(), extra: z.boolean() }),
      result: z.strictObject({ value: z.string() }),
    }),
  ],
  prepareActions: {
    prepared: { caps: ${JSON.stringify(preparerCaps)}, prepare },
    record: { caps: ${JSON.stringify(preparerCaps)}, prepare },
  },
  handlers: {
    declared: register, delegated: register, prepared: register,
    async record(ctx, args) {
      await ctx.storage.set("recorded", args.value);
      return { value: args.value };
    },
  },
};
defineServerPlugin(definition);
export default definition;
`);
  const packed = await packPlugin(authorDir, join(dataDir, PLUGIN_UPLOADS_DIR, "binding.manifold-plugin.json"));
  const request = { source: packed.file, sha256: packed.sha256, hardened: false };
  return {
    get store() { return store; },
    get host() { return host; },
    get service() { return service; },
    runtime, root, commands, machineId, prove,
    async install(grant: AuthoredCap[], replace = false) {
      return host.install({ ...request, grant, replace }, root().principal.id, auth.credentialReference(root()));
    },
    installNative() {
      service.install(root(), {
        machineId, pluginId: PLUGIN_ID, installationRevision: "one",
        artifactSha256: ARTIFACT_HASH, machine,
      });
      for (const cap of ["machines:run", "operations:invoke"] as const)
        service.consent(root(), {
          machineId, pluginId: PLUGIN_ID, installationRevision: "one",
          artifactSha256: ARTIFACT_HASH,
          node: formatManifoldUri({ kind: "operation", machineId, operationId: OPERATION_ID }),
          cap, enabled: true,
        });
      prove();
    },
    async reopen() {
      host.close();
      await runner.close();
      store.close();
      await boot();
      prove();
    },
    async close() {
      host.close();
      await runner.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function occurrenceId(scheduleId: string) {
  return `schedule-${createHash("sha256").update(canonicalJobJson([scheduleId, "one", 1000])).digest("hex")}`;
}

test("a real packed multi-cap preparer installs in-realm and executes its normalized effect", async () => {
  const f = await fixture(["tokens:mint", "plugins:manage"]);
  try {
    expect(await f.install(["tokens:mint"])).toMatchObject({ id: PLUGIN_ID });
    expect(await f.host.dispatch(f.root(), `${PLUGIN_ID}.record`, { value: "  admitted  ", extra: true })).toEqual({
      ok: true, result: { value: "admitted" },
    });
    expect(await f.store.pluginStorage(PLUGIN_ID).get("recorded")).toBe("admitted");
  } finally {
    await f.close();
  }
});

for (const reopen of [false, true]) {
  test(`same-artifact ordinary grant narrowing fences scheduled admission (reopen: ${String(reopen)})`, async () => {
    const f = await fixture();
    try {
      expect(await f.install(["tokens:mint"])).toMatchObject({ id: PLUGIN_ID });
      f.installNative();
      for (const [action, scheduleId, extra] of [
        ["declared", "declared", false],
        ["delegated", "delegated", false],
        ["prepared", "prepared", true],
        ["prepared", "unused-mode", false],
      ] as const) {
        expect(await f.host.dispatch(f.root(), `${PLUGIN_ID}.${action}`, {
          operation: { kind: "operation", machineId: f.machineId, operationId: OPERATION_ID },
          scheduleId, extra,
        })).toEqual({ ok: true, result: {} });
      }
      expect(await f.host.dispatch(f.root(), "engine.jobs.schedules", {})).toMatchObject({
        ok: true,
        result: ["declared", "delegated", "prepared", "unused-mode"].map((scheduleId) => ({ scheduleId })),
      });
      // Same bytes and native consent; only the installer-withheld ordinary ceiling changes.
      expect(await f.install([], true)).toMatchObject({ id: PLUGIN_ID, grantedCaps: ["machines:read"] });
      if (reopen) await f.reopen();
      f.runtime.time = 1000;
      f.service.tick();
      for (const scheduleId of ["declared", "prepared"]) {
        expect(f.service.jobs.get(occurrenceId(scheduleId))).toBeNull();
        expect(f.service.jobSchedules.getOccurrence(occurrenceId(scheduleId))).toBeNull();
      }
      expect(await f.host.dispatch(f.root(), "engine.jobs.schedules", {})).toMatchObject({
        ok: true,
        result: [{ scheduleId: "delegated" }, { scheduleId: "unused-mode" }],
      });
      // Ordinary delegated defaults and an unselected preparer mode remain admitted.
      for (const scheduleId of ["delegated", "unused-mode"])
        expect(f.service.jobs.get(occurrenceId(scheduleId))?.state).toBe("start-committed");
      expect(f.commands.filter((command) => command.type === "start").map((command) => command.request.jobId)).toEqual([
        occurrenceId("delegated"), occurrenceId("unused-mode"),
      ]);
    } finally {
      await f.close();
    }
  });
}
