import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobSettledCtx, LifecycleCtx } from "@manifold/plugin";
import { attachServerGuest, type GuestLifecycleCtx } from "@manifold/plugin-kit/server";
import { HostCallError } from "@manifold/plugin-kit";
import {
  formatManifoldUri,
  JOB_OWNER_PROTOCOL_VERSION,
  InstanceServicesDescriptionSchema,
} from "@manifold/protocol";
import type {
  Cap,
  IsolateChildFrame,
  PluginManifest,
  ServicePolicy,
  SettledJob,
  MachineBridgeAnswer,
  MachineInventory,
} from "@manifold/protocol";
import {
  canonicalJobJson,
  type JobCommand,
  type JobOwner,
  type MachineHalf,
} from "../../protocol/src/jobs.ts";
import { AuthService, ServiceError, type AuthContext } from "../src/auth.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import type {
  InstalledPluginRef,
  IsolateLoadResult,
  IsolateRunner,
  IsolateState,
} from "../src/isolate/contract.ts";
import { serveCtxCall } from "../src/isolate/proxy-def.ts";
import { JobService } from "../src/job-service.ts";
import { silentLogger } from "../src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../src/plugin-installs.ts";
import { PluginHost, type ServerPluginDef } from "../src/plugin-host.ts";
import { PlaceExecutor, assemblyItemNouns, assemblyPlacementVocabulary } from "../src/placement.ts";
import { RoomManager } from "../src/room.ts";
import { sha256Hex } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import {
  closeTestStore,
  FakeClock,
  FakeRuntime,
  testEventHub,
  testStore,
  testTileTrees,
  trackTestPluginHost,
} from "./helpers.ts";

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
  remainingHostCallMs(): number {
    return Number.POSITIVE_INFINITY;
  }
  onState(): () => void {
    return () => {};
  }
  async close(): Promise<void> {}
}

async function fixture(
  onEnable: (ctx: LifecycleCtx) => void | Promise<void>,
  options: {
    capabilities?: Cap[];
    lifecycleTimeoutMs?: number;
    onJobSettled?: (ctx: JobSettledCtx, job: SettledJob) => void | Promise<void>;
  } = {},
) {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime);
  const root = auth.authenticate(OWNER_KEY);
  const online = new Set<string>();
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
  const lifecycle = {
    onEnable,
    ...(options.onJobSettled === undefined ? {} : { onJobSettled: options.onJobSettled }),
  };
  const runner = new StubRunner((ref) => ({
    def: { manifest: ref.manifest, actions: [], handlers: {}, lifecycle },
    lifecycle,
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
        isOnline: (machineId) => online.has(machineId),
        getTerminalExecution: () => null,
        getPhysicalCoreCount: () => undefined,
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
      {
        ...(isolates === undefined ? {} : { isolates }),
        ...(options.lifecycleTimeoutMs === undefined
          ? {}
          : { lifecycleTimeoutMs: options.lifecycleTimeoutMs }),
      },
    );
    trackTestPluginHost(store, host);
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
      manifest: { ...MANIFEST, capabilities: options.capabilities ?? MANIFEST.capabilities },
      files: { "server.js": Buffer.from("export {};").toString("base64") },
    }),
  );
  const source = join(dataDir, PLUGIN_UPLOADS_DIR, "beat.manifold-plugin.json");
  writeFileSync(source, bytes);
  return {
    runtime,
    channel,
    owner,
    store,
    auth,
    root,
    host,
    service,
    machineId,
    online,
    request: { source, sha256: sha256Hex(bytes), hardened: true as const },
    close: () => {
      closeTestStore(store);
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

const METADATA_CAPS: Cap[] = ["containers:read", "services:read"];
type MetadataHook = LifecycleCtx | GuestLifecycleCtx;

/** Exercise the same host authority through the actual guest SDK and correlated proxy. */
async function metadataGuest(ctx: LifecycleCtx, run: (ctx: MetadataHook) => Promise<void>) {
  let receive: (frame: unknown) => void = () => {};
  const completed = Promise.withResolvers<Extract<IsolateChildFrame, { t: "hooked" }>>();
  attachServerGuest(
    { manifest: MANIFEST, actions: [], handlers: {}, lifecycle: { onEnable: run } },
    {
      onMessage: (listener) => {
        receive = listener;
      },
      send: (frame) => {
        if (frame.t === "call") {
          void serveCtxCall(frame.method, frame.args, { kind: "hook", ctx }).then(
            (result) => receive({ t: "reply", id: frame.id, ok: true, result }),
            (error: unknown) =>
              receive({
                t: "reply",
                id: frame.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
          );
        } else if (frame.t === "hooked") completed.resolve(frame);
      },
      warn: () => {},
      exit: () => {},
    },
  );
  receive({ t: "load", pluginId: PLUGIN_ID, manifest: MANIFEST, dir: "/unused" });
  receive({
    t: "hook",
    id: "metadata",
    hook: "onEnable",
    ...(ctx.host === undefined ? {} : { metadata: true }),
  });
  const result = await completed.promise;
  if (!result.ok) throw new Error(result.error);
}

function metadataService(
  service: JobService,
  root: AuthContext,
  machineId: string,
  serviceId: string,
  expectedRevision: string | null = null,
) {
  const policy: ServicePolicy = {
    serviceId,
    revision: expectedRevision === null ? "first" : "next",
    maxConcurrent: 1,
    runtime: {
      scope: "instance",
      pluginId: PLUGIN_ID,
      operationId: OPERATION_ID,
      installationRevision: "r1",
      artifactSha256: hash,
      resourceBindingDigest: sha256Hex(canonicalJobJson(null)),
      input: {},
    },
    operations: {
      inspect: {
        // Listing metadata must not require the paid/effectful operation to be readable.
        method: "POST",
        readable: false,
        invocable: true,
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
  // Persist real policy metadata without starting a native/provider process.
  return service.instanceServices.configure(
    root,
    { serviceId, expectedRevision, machineId, policy, enabled: false },
    PLUGIN_ID,
    "metadata-fixture",
    [],
  ).current;
}

async function metadataFailure(read: () => unknown) {
  try {
    await read();
    return "allowed";
  } catch (error) {
    if (error instanceof ServiceError) return error.code;
    if (error instanceof HostCallError) return error.method;
    if (error instanceof Error) return error.name;
    throw error;
  }
}

for (const mode of ["in-realm", "hardened"] as const) {
  const invoke = (ctx: LifecycleCtx, run: (ctx: MetadataHook) => Promise<void>) =>
    mode === "hardened" ? metadataGuest(ctx, run) : run(ctx);

  test(`${mode} lifecycle reads current roster and invoke-only policy metadata, rechecking resource grants after awaits`, async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const f = await fixture(
      (ctx) =>
        invoke(ctx, async (metadata) => {
          const roster = await metadata.host!.roster();
          seen.push(roster.find((row) => row.manifest.id === PLUGIN_ID)?.install?.sha256);
          seen.push(await metadata.host!.enabled(PLUGIN_ID));
          seen.push(await metadata.services!.listInstances({}));
          entered.resolve();
          await resume.promise;
          seen.push(await metadata.services!.listInstances({}));
        }),
      { capabilities: METADATA_CAPS },
    );
    try {
      const visible = metadataService(f.service, f.root, f.machineId, `${PLUGIN_ID}.visible`);
      const hidden = metadataService(f.service, f.root, f.machineId, `${PLUGIN_ID}.hidden`);
      const minted = f.auth.mintToken(
        {
          principal: { name: "metadata-reader", kind: "human" },
          caps: METADATA_CAPS,
        },
        f.root,
      );
      const installer = f.auth.authenticate(minted.token);
      const hide = (serviceId: string) =>
        f.auth.grant(
          {
            principal: { kind: "principal", id: installer.principal.id },
            node: formatManifoldUri({
              kind: "service",
              machineId: f.machineId,
              serviceId,
              operationId: "inspect",
            }),
            caps: ["services:read"],
            effect: "deny",
            reach: "node",
          },
          f.root,
        );
      hide(hidden.serviceId);
      const installing = f.host.install(
        f.request,
        installer.principal.id,
        f.auth.credentialReference(installer),
      );
      await entered.promise;
      hide(visible.serviceId);
      resume.resolve();
      await installing;
      expect(seen[0]).toBe(f.request.sha256);
      expect(seen[1]).toBe(true);
      expect(seen[2]).toMatchObject({
        defaultOwner: null,
        services: [
          {
            serviceId: visible.serviceId,
            configuration: { revision: visible.revision, enabled: false },
            state: "stopped",
          },
        ],
      });
      expect(InstanceServicesDescriptionSchema.parse(seen[2]).services).toHaveLength(1);
      expect(seen[3]).toEqual({ defaultOwner: null, services: [] });
    } finally {
      resume.resolve();
      f.close();
    }
  });

  test(`${mode} invoke authority alone cannot authorize lifecycle service metadata`, async () => {
    let enabled: boolean | undefined;
    let result: unknown;
    let failure: unknown;
    const f = await fixture(
      (ctx) =>
        invoke(ctx, async (metadata) => {
          enabled = await metadata.host!.enabled(PLUGIN_ID);
          try {
            result = await metadata.services!.listInstances({});
          } catch (error) {
            failure = error;
          }
        }),
      { capabilities: METADATA_CAPS },
    );
    try {
      metadataService(f.service, f.root, f.machineId, `${PLUGIN_ID}.invoke-only`);
      const minted = f.auth.mintToken(
        {
          principal: { name: "invoker", kind: "human" },
          caps: ["containers:read", "services:invoke"],
        },
        f.root,
      );
      const installer = f.auth.authenticate(minted.token);
      await f.host.install(
        f.request,
        installer.principal.id,
        f.auth.credentialReference(installer),
      );
      expect(enabled).toBe(true);
      expect(result).toBeUndefined();
      if (mode === "hardened") {
        expect(failure).toBeInstanceOf(HostCallError);
        expect(failure).toMatchObject({ method: "services.listInstances" });
      } else {
        expect(failure).toBeInstanceOf(ServiceError);
        expect(failure).toMatchObject({ code: "forbidden" });
      }
    } finally {
      f.close();
    }
  });

  test(`${mode} lifecycle inventory observes live fleet enrollment, connection, drain and revocation`, async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const seen: MachineBridgeAnswer<MachineInventory>[] = [];
    const f = await fixture(
      (ctx) =>
        invoke(ctx, async (metadata) => {
          seen.push(await metadata.machines!.inventory());
          entered.resolve();
          await resume.promise;
          seen.push(await metadata.machines!.inventory());
        }),
      { capabilities: ["containers:read"] },
    );
    try {
      const minted = f.auth.mintToken(
        {
          principal: { name: "fleet-reader", kind: "human" },
          caps: ["containers:read"],
        },
        f.root,
      );
      const installer = f.auth.authenticate(minted.token);
      const installing = f.host.install(
        f.request,
        installer.principal.id,
        f.auth.credentialReference(installer),
      );
      await entered.promise;
      f.online.add(f.machineId);
      f.store.setMachineDraining(f.machineId, true);
      const withdrawn = f.auth.enrollMachine("withdrawn", f.root).machine.id;
      f.auth.revokeMachine(withdrawn, f.root);
      resume.resolve();
      await installing;
      const [before, after] = seen;
      if (!before?.ok || !after?.ok) throw new Error("authorized inventory was refused");
      expect(before.value.machines.map((machine) => machine.id)).toEqual([f.machineId]);
      expect(before.value.machines[0]).toMatchObject({
        id: f.machineId,
        name: "worker",
        online: false,
        revoked: false,
        draining: false,
        terminalExecution: null,
        lastRefusal: null,
      });
      expect(after.value.machines.map((machine) => machine.id).sort()).toEqual(
        [f.machineId, withdrawn].sort(),
      );
      expect(after.value.machines.find((machine) => machine.id === f.machineId)).toMatchObject({
        online: true,
        draining: true,
        revoked: false,
      });
      expect(after.value.machines.find((machine) => machine.id === withdrawn)).toMatchObject({
        name: "withdrawn",
        online: false,
        revoked: true,
      });
    } finally {
      resume.resolve();
      f.close();
    }
  });

  for (const withdrawal of ["revoked", "expired", "grant"] as const) {
    test(`${mode} lifecycle ${withdrawal} authority cannot survive an awaited operation`, async () => {
      const entered = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const seen: string[] = [];
      const f = await fixture(
        (ctx) =>
          invoke(ctx, async (metadata) => {
            seen.push(String(await metadata.host!.enabled(PLUGIN_ID)));
            entered.resolve();
            await resume.promise;
            seen.push(await metadataFailure(() => metadata.host!.roster()));
            seen.push(await metadataFailure(() => metadata.services!.listInstances({})));
            const inventory = await metadata.machines!.inventory();
            seen.push(inventory.ok ? "allowed" : inventory.code);
          }),
        { capabilities: METADATA_CAPS },
      );
      try {
        const minted = f.auth.mintToken(
          {
            principal: { name: "metadata-installer", kind: "human" },
            caps: METADATA_CAPS,
          },
          f.root,
        );
        const installer = f.auth.authenticate(minted.token);
        const installing = f.host.install(
          f.request,
          installer.principal.id,
          f.auth.credentialReference(installer),
        );
        await entered.promise;
        if (withdrawal === "revoked") f.auth.revokePrincipal(installer.principal.id, f.root);
        else if (withdrawal === "expired") f.runtime.time = minted.expiresAt! + 1;
        else
          f.auth.grant(
            {
              principal: { kind: "principal", id: installer.principal.id },
              node: "manifold://",
              caps: METADATA_CAPS,
              effect: "deny",
              reach: "subtree",
            },
            f.root,
          );
        resume.resolve();
        await installing;
        expect(seen[0]).toBe("true");
        expect(seen[1]).toBe(mode === "hardened" ? "host.roster" : "forbidden");
        if (withdrawal === "grant") {
          // Service listing retains normal per-ref filtering; zero visible refs is empty.
          expect(seen[2]).toBe("allowed");
        } else expect(seen[2]).toBe(mode === "hardened" ? "services.listInstances" : "forbidden");
        expect(seen[3]).toBe("forbidden");
      } finally {
        resume.resolve();
        f.close();
      }
    });
  }
}

test("metadata requires admitted manifest and install grant even for the owner installer", async () => {
  // Ordinary named read caps are granted by default; an ungranted wildcard exercises
  // a declared ceiling whose flat install grant actually withholds metadata authority.
  for (const declared of [false, true]) {
    const seen: string[] = [];
    const f = await fixture(
      async (ctx) => {
        seen.push(await metadataFailure(() => ctx.host!.roster()));
        seen.push(await metadataFailure(() => ctx.services!.listInstances({})));
        const inventory = ctx.machines!.inventory();
        seen.push(inventory.ok ? "allowed" : inventory.code);
      },
      { capabilities: declared ? ["*"] : [] },
    );
    try {
      await f.host.install(
        { ...f.request, grant: [] },
        f.root.principal.id,
        f.auth.credentialReference(f.root),
      );
      expect(seen).toEqual(["forbidden", "forbidden", "forbidden"]);
    } finally {
      f.close();
    }
  }
});

test("absent, revoked and expired installer lineage never borrows the enabling administrator", async () => {
  for (const state of ["absent", "revoked", "expired"] as const) {
    const seen: boolean[] = [];
    const f = await fixture(
      (ctx) => {
        seen.push(
          ctx.host !== undefined || ctx.services !== undefined || ctx.machines !== undefined,
        );
      },
      {
        capabilities: METADATA_CAPS,
      },
    );
    try {
      const minted = f.auth.mintToken(
        {
          principal: { name: "old-installer", kind: "human" },
          caps: METADATA_CAPS,
        },
        f.root,
      );
      const installer = f.auth.authenticate(minted.token);
      await f.host.install(
        f.request,
        installer.principal.id,
        state === "absent" ? null : f.auth.credentialReference(installer),
      );
      if (state === "revoked") f.auth.revokePrincipal(installer.principal.id, f.root);
      if (state === "expired") f.runtime.time = minted.expiresAt! + 1;
      await f.host.setEnabled(PLUGIN_ID, false, f.root.principal.id);
      await f.host.setEnabled(PLUGIN_ID, true, f.root.principal.id);
      expect(seen).toEqual([state !== "absent", false]);
    } finally {
      f.close();
    }
  }
});

test("metadata handles end when the hook returns or times out, including continuations", async () => {
  for (const timeout of [false, true]) {
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    let held: LifecycleCtx | undefined;
    const seen: string[] = [];
    const f = await fixture(
      async (ctx) => {
        held = ctx;
        seen.push(String(ctx.host!.enabled(PLUGIN_ID)));
        if (timeout) {
          await resume.promise;
          seen.push(await metadataFailure(() => ctx.host!.roster()));
          seen.push(await metadataFailure(() => ctx.services!.listInstances({})));
          seen.push(await metadataFailure(() => ctx.machines!.inventory()));
        }
        finished.resolve();
      },
      { capabilities: METADATA_CAPS, lifecycleTimeoutMs: 20 },
    );
    try {
      await f.host.install(f.request, f.root.principal.id, f.auth.credentialReference(f.root));
      resume.resolve();
      await finished.promise;
      expect(seen[0]).toBe("true");
      expect(() => held!.host!.roster()).toThrow(Error);
      expect(() => held!.services!.listInstances({})).toThrow(Error);
      expect(() => held!.machines!.inventory()).toThrow(Error);
      await expect(serveCtxCall("host.roster", [], { kind: "hook", ctx: held! })).rejects.toThrow(
        Error,
      );
      await expect(
        serveCtxCall("services.listInstances", [{}], { kind: "hook", ctx: held! }),
      ).rejects.toThrow(Error);
      await expect(
        serveCtxCall("machines.inventory", [], { kind: "hook", ctx: held! }),
      ).rejects.toThrow(Error);
      if (timeout) expect(seen.slice(1)).toEqual(["Error", "Error", "Error"]);
    } finally {
      resume.resolve();
      f.close();
    }
  }
});

test("each hook metadata read observes the current service policy identity", async () => {
  const seen: string[] = [];
  let replace = () => {};
  const f = await fixture(
    async (ctx) => {
      seen.push(ctx.services!.listInstances({}).services[0]!.configuration!.revision);
      await Promise.resolve();
      replace();
      seen.push(ctx.services!.listInstances({}).services[0]!.configuration!.revision);
    },
    { capabilities: METADATA_CAPS },
  );
  try {
    const before = metadataService(f.service, f.root, f.machineId, `${PLUGIN_ID}.policy`);
    let after = "";
    replace = () => {
      after = metadataService(
        f.service,
        f.root,
        f.machineId,
        before.serviceId,
        before.revision,
      ).revision;
    };
    await f.host.install(f.request, f.root.principal.id, f.auth.credentialReference(f.root));
    expect(after).not.toBe(before.revision);
    expect(seen).toEqual([before.revision, after]);
  } finally {
    f.close();
  }
});

test("settled metadata uses the job credential instead of an owner or absent installer and rechecks it after waits", async () => {
  for (const scenario of [
    "owner-installer",
    "absent-installer",
    "attenuated-install",
    "job-without-read",
  ] as const) {
    const installedByOwner = scenario !== "absent-installer";
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const inventories: MachineBridgeAnswer<MachineInventory>[] = [];
    let ordinary: unknown;
    const f = await fixture(
      (ctx) => {
        ordinary = ctx.services?.listInstances({});
      },
      {
        capabilities: scenario === "attenuated-install" ? ["*"] : METADATA_CAPS,
        onJobSettled: async (ctx) => {
          seen.push(await metadataFailure(() => ctx.host!.enabled(PLUGIN_ID)));
          seen.push(ctx.services!.listInstances({}));
          inventories.push(ctx.machines!.inventory());
          entered.resolve();
          await resume.promise;
          seen.push(await metadataFailure(() => ctx.host!.roster()));
          seen.push(await metadataFailure(() => ctx.services!.listInstances({})));
          inventories.push(ctx.machines!.inventory());
          seen.push(await metadataFailure(() => ctx.jobs.schedules()));
          seen.push(await metadataFailure(() => ctx.storage.set("late", "no")));
          finished.resolve();
        },
      },
    );
    try {
      const service = metadataService(f.service, f.root, f.machineId, `${PLUGIN_ID}.settled`);
      await f.host.install(
        scenario === "attenuated-install" ? { ...f.request, grant: ["*"] } : f.request,
        f.root.principal.id,
        installedByOwner ? f.auth.credentialReference(f.root) : null,
      );
      if (installedByOwner)
        expect(ordinary).toMatchObject({ services: [{ serviceId: service.serviceId }] });
      else expect(ordinary).toBeUndefined();
      const minted = f.auth.mintToken(
        {
          principal: { name: "job-caller", kind: "human" },
          caps: [
            ...(scenario === "job-without-read" ? ["services:read" as const] : METADATA_CAPS),
            "machines:run",
            "jobs:read",
          ],
        },
        f.root,
      );
      const caller = f.auth.authenticate(minted.token);
      f.auth.grant(
        {
          principal: { kind: "principal", id: caller.principal.id },
          node: formatManifoldUri({
            kind: "service",
            machineId: f.machineId,
            serviceId: service.serviceId,
            operationId: "inspect",
          }),
          caps: ["services:read"],
          effect: "deny",
          reach: "node",
        },
        f.root,
      );
      const jobId = "metadata-settlement";
      const job = f.service.execute(caller, PLUGIN_ID, "metadata-test", {
        jobId,
        machineId: f.machineId,
        operationId: OPERATION_ID,
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
          usage: { elapsedMs: 1, memoryBytes: 1, processes: 1, outputBytes: 0 },
          limits: { timeoutMs: 1000, memoryBytes: 1048576, processes: 1, outputBytes: 65536 },
          outputs: [],
        },
      });
      await entered.promise;
      if (scenario === "attenuated-install") {
        await f.host.install(
          { ...f.request, grant: [], replace: true },
          f.root.principal.id,
          f.auth.credentialReference(f.root),
        );
      } else f.auth.revokePrincipal(caller.principal.id, f.root);
      resume.resolve();
      await finished.promise;
      expect(seen.slice(0, 2)).toEqual([
        scenario === "job-without-read" ? "forbidden" : "allowed",
        { defaultOwner: null, services: [] },
      ]);
      if (scenario === "job-without-read") {
        expect(inventories[0]).toMatchObject({ ok: false, code: "forbidden" });
        expect(inventories[0]).not.toHaveProperty("value");
      } else {
        expect(inventories[0]).toMatchObject({
          ok: true,
          value: { machines: [{ id: f.machineId, name: "worker" }] },
        });
      }
      expect(inventories[1]).toMatchObject({ ok: false, code: "forbidden" });
      expect(inventories[1]).not.toHaveProperty("value");
      expect(seen.slice(2)).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);
    } finally {
      resume.resolve();
      f.close();
    }
  }
});

test("a credential-bearing lifecycle metadata slice cannot access machine or service effects, policies or secrets", async () => {
  const methods = [
    "machines.drain",
    "machines.repository",
    "machines.isOnline",
    "machines.getTerminalExecution",
    "identity.enrollMachine",
    "identity.rotateMachineToken",
    "identity.revokeMachine",
    "identity.forgetMachine",
    "services.describe",
    "services.describeInstance",
    "services.read",
    "services.invoke",
    "services.readInstance",
    "services.invokeInstance",
    "services.readConfiguration",
    "services.readInstanceConfiguration",
    "services.configureConfiguration",
    "services.configureInstance",
  ] as const;
  const refusals: string[] = [];
  const f = await fixture(
    async (ctx) => {
      for (const method of methods) {
        refusals.push(
          await metadataFailure(() => serveCtxCall(method, [{}], { kind: "hook", ctx })),
        );
      }
    },
    { capabilities: METADATA_CAPS },
  );
  try {
    await f.host.install(f.request, f.root.principal.id, f.auth.credentialReference(f.root));
    expect(refusals).toEqual(methods.map(() => "Error"));
  } finally {
    f.close();
  }
});
