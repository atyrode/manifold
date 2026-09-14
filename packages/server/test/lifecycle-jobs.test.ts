import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LifecycleCtx } from "@manifold/plugin";
import { formatManifoldUri, JOB_OWNER_PROTOCOL_VERSION } from "@manifold/protocol";
import type { Cap, PluginManifest } from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
} from "../../protocol/src/jobs.ts";
import { AuthService } from "../src/auth.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import type {
  InstalledPluginRef,
  IsolateLoadResult,
  IsolateRunner,
  IsolateState,
} from "../src/isolate/contract.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { PluginHost, type ServerPluginDef } from "../src/plugin-host.ts";
import { PlaceExecutor, assemblyItemNouns, assemblyPlacementVocabulary } from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { sha256Hex } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testEventHub, testStore, testTileTrees } from "./helpers.ts";

/*
  THE ENABLE THAT CAN START A CADENCE (#514).

  A plugin that owns a beat has to register it when it is turned ON: a door needs a caller and
  a settlement needs a job, so a half nobody opens gets neither and its cadence never begins.
  `LifecycleCtx` therefore carries the job slice, bound to the INSTALLER's credential and
  restored from the row at every fan-out. What these two cases hold is that the binding is real
  authority — the schedule it writes is the plugin's own, under the installer's lineage — and
  that it ENDS with the installer's: a row whose consent no longer restores lends nothing, and
  the transition still completes. The wire half is `isolate-proxy.test.ts`.
*/

const OWNER_KEY = "a".repeat(64);
const PLUGIN_ID = "vendor.beat";
const OPERATION_ID = `${PLUGIN_ID}.run`;
const hash = "b".repeat(64);
const SCHEDULE = {
  scheduleId: "beat-1",
  revision: "r1",
  firstNominalAt: 1_000,
  intervalMs: 60_000,
  deadlineMs: 30_000,
  expiresAt: 9_000_000,
  offlinePolicy: "skip" as const,
};

function machineHalf(): MachineHalf {
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
}

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  version: "1.0.0",
  title: "Beat",
  description: "a worker half that owns its own cadence",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  machine: machineHalf(),
  entry: { server: true },
};

/**
 * The beat's DECLARATION alone, with no artifact and no lifecycle. `engine.jobs.install` admits
 * a machine half only against the declared one on the LIVE roster, so a machine cannot carry a
 * plugin's operation until something on the roster declares it. The fixture wants the operation
 * already there when the artifact lands — the state any hub that has run this plugin before is
 * in — so one composition declares it and the hub the cases drive installs over the same store.
 */
const DECLARATION: ServerPluginDef = {
  manifest: {
    id: PLUGIN_ID,
    version: "1.0.0",
    title: "Beat",
    description: "a worker half that owns its own cadence",
    capabilities: [],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    machine: machineHalf(),
  },
  actions: [],
  handlers: {},
};

/** A runner that serves the load from the test itself: the hook is a closure, not a child. */
class StubRunner implements IsolateRunner {
  private readonly states = new Map<string, IsolateState>();
  constructor(private readonly serve: (ref: InstalledPluginRef) => IsolateLoadResult) {}
  async load(ref: InstalledPluginRef): Promise<IsolateLoadResult> {
    this.states.set(ref.pluginId, "running");
    return this.serve(ref);
  }
  async unload(pluginId: string): Promise<void> {
    this.states.set(pluginId, "stopped");
  }
  state(pluginId: string): IsolateState {
    return this.states.get(pluginId) ?? "stopped";
  }
  onState(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

async function fixture(onEnable: (ctx: LifecycleCtx) => void | Promise<void>) {
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
  const dataDir = mkdtempSync(join(tmpdir(), "manifold-lifecycle-jobs-"));
  mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
  const runner = new StubRunner((ref) => ({
    def: { manifest: ref.manifest, actions: [], handlers: {}, lifecycle: { onEnable } },
    lifecycle: { onEnable },
  }));
  const boot = async (
    defs: readonly ServerPluginDef[],
    isolates?: { readonly runner: IsolateRunner; readonly dataDir: string },
  ): Promise<PluginHost> => {
    let host: PluginHost | null = null;
    host = await PluginHost.boot(
      defs,
      store,
      auth,
      rooms,
      broker,
      new PlaceExecutor(
        store,
        rooms,
        broker,
        runtime,
        assemblyPlacementVocabulary(() => host?.roster() ?? []),
        assemblyItemNouns(() => host?.roster() ?? []),
      ),
      {
        isOnline: () => false,
        getTerminalExecution: () => null,
        drain: () => Promise.resolve({ ok: false, reason: "machine is offline" }),
        repository: () =>
          Promise.resolve({ ok: false, reason: "machine is offline: it cannot be asked" }),
      },
      new InstanceDialer(store, runtime, silentLogger, () => "http://localhost:7777"),
      runtime,
      silentLogger,
      testEventHub(
        store,
        auth,
        broker,
        () => {
          if (host === null) throw new Error("the event plane read the assembly before the host");
          return host.assembly();
        },
        runtime,
      ),
      isolates === undefined ? {} : { isolates },
    );
    return host;
  };
  const service = new JobService(store, auth, runtime);

  /*
    THE MACHINE: the plugin's one operation installed, consented and proved against a proved
    job owner. This is the authority a schedule is reauthorized against every time an occurrence
    is due, which is why a hook's slice has to be a credential and not a flag.
  */
  (await boot([DECLARATION])).setJobs(service);
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
    inventoryDigest: "c".repeat(64),
  };
  service.online(channel, owner, "epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
  service.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString("base64"),
  });
  service.install(root, {
    machineId,
    pluginId: PLUGIN_ID,
    installationRevision: "r1",
    artifactSha256: hash,
    machine: machineHalf(),
  });
  for (const cap of ["machines:run", "jobs:read"] as Cap[])
    service.consent(root, {
      machineId,
      pluginId: PLUGIN_ID,
      installationRevision: "r1",
      artifactSha256: hash,
      node: formatManifoldUri({ kind: "operation", machineId, operationId: OPERATION_ID }),
      cap,
      enabled: true,
    });
  service.event(channel, {
    type: "installed",
    pluginId: PLUGIN_ID,
    installationRevision: "r1",
    artifactSha256: hash,
  });

  // The hub the cases drive: the same store, declaring nothing of its own, so installing the
  // artifact is the first time this plugin reaches THIS roster — and that install is an enable.
  const host = await boot([], { runner, dataDir });
  host.setJobs(service);

  const bytes = Buffer.from(
    JSON.stringify({
      format: 1,
      hardenedContract: 2,
      manifest: MANIFEST,
      files: { "server.js": Buffer.from("export {};").toString("base64") },
    }),
  );
  const source = join(dataDir, PLUGIN_UPLOADS_DIR, "beat.manifold-plugin.json");
  writeFileSync(source, bytes);
  return {
    store,
    auth,
    root,
    host,
    service,
    machineId,
    request: { source, sha256: sha256Hex(bytes), hardened: true as const },
    close: () => {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("an enable hook holds the installer's job authority and registers its own cadence with it", async () => {
  let machineId = "";
  const completed: boolean[] = [];
  const f = await fixture(async (ctx) => {
    const jobs = ctx.jobs;
    if (jobs === undefined) throw new Error("the enable hook was given no job slice");
    await jobs.schedule({
      ...SCHEDULE,
      jobId: "beat-job",
      machineId,
      operationId: OPERATION_ID,
      input: { value: "scan" },
      outputs: [],
    });
    completed.push(true);
  });
  machineId = f.machineId;
  try {
    // Installing an ENABLED row IS an enable, so the hook fires inside the install itself.
    expect(
      await f.host.install(f.request, f.root.principal.id, f.auth.credentialReference(f.root)),
    ).toEqual({ id: PLUGIN_ID, version: "1.0.0", grantedCaps: [] });
    expect(completed).toEqual([true]);
    // A hook that throws is only logged, so the durable row is what proves the write landed.
    const stored = f.service.jobSchedules.listSchedules();
    expect(stored.map((spec) => spec.scheduleId)).toEqual([SCHEDULE.scheduleId]);
    expect(stored[0]?.request.pluginId).toBe(PLUGIN_ID);
    expect(stored[0]?.request.credential.principalId).toBe(f.root.principal.id);
    // A hook is not a door: the job's origin is the lifecycle, never an invented ledger row.
    expect(stored[0]?.request.traceId).toBe("plugin-lifecycle");
  } finally {
    f.close();
  }
});

test("an installer whose credential no longer restores lends no slice, and the transition still lands", async () => {
  const held: boolean[] = [];
  const f = await fixture((ctx) => {
    held.push(ctx.jobs !== undefined);
  });
  try {
    // A delegate installs it, under a real minted credential rather than the owner key.
    const minted = f.auth.mintToken(
      { principal: { name: "installer", kind: "human" }, caps: ["jobs:read"] },
      f.root,
    );
    const installer = f.auth.authenticate(minted.token);
    expect(
      await f.host.install(
        f.request,
        installer.principal.id,
        f.auth.credentialReference(installer),
      ),
    ).toEqual({ id: PLUGIN_ID, version: "1.0.0", grantedCaps: [] });
    expect(held).toEqual([true]);

    /*
      The delegate is revoked. The row stands and the plugin is still woken — a hook has no vote
      and cannot be made to fail by the loss — but the authority behind it is gone, so the slice
      is ABSENT rather than a handle whose every call would refuse.
    */
    f.auth.revokePrincipal(installer.principal.id, f.root);
    expect(f.auth.restoreCredential(f.auth.credentialReference(installer))).toBeNull();
    expect(await f.host.setEnabled(PLUGIN_ID, false, "admin")).toEqual({ ok: true });
    expect(await f.host.setEnabled(PLUGIN_ID, true, "admin")).toEqual({ ok: true });
    expect(held).toEqual([true, false]);
    expect(f.host.roster().find((row) => row.manifest.id === PLUGIN_ID)?.enabled).toBe(true);
  } finally {
    f.close();
  }
});
