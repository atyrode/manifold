import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GuestCtx,
  GuestDatabase,
  GuestLifecycleCtx,
  GuestSqlParam,
  GuestSqlRow,
} from "@manifold/plugin-kit/server";
import {
  PluginManifestSchema,
  type Principal,
  type PluginRoster,
  type ServiceReadArgs,
  type ServiceReply,
} from "@manifold/protocol";
import { openPluginDatabase, pluginDatabasePath } from "../../../server/src/plugin-database.ts";
import { openDatabase } from "../../../server/src/db.ts";
import { ServerStore } from "../../../server/src/stores.ts";
import manifestJson from "../manifest.json";
import {
  ConfigureConnectionResultSchema,
  PLUGIN_ID,
  PublicationSchema,
  type ConnectionMetadata,
  type PrepareIssuePublicationInput,
  type Publication,
} from "../src/contract.ts";
import { handlers, lifecycle } from "../src/publication.ts";
import {
  CREDENTIAL_REF,
  githubReceiver,
  hash,
  nativePolicy,
  nativeRunner,
  type FixtureBarrier,
} from "./publication-native.fixture.ts";

export const draft: PrepareIssuePublicationInput = {
  connectionId: "fixture-connection",
  consumerRef: "consumer-one",
  publicTitle: "Reviewed fixture issue",
  publicBody: "Only these explicit public bytes are approved.\n",
};
export const reviewed = (publication: Publication) => ({
  operationId: publication.operationId,
  reviewedDigest: publication.reviewedDigest,
});

// Tests replace only host authority/attribution seams. Unimplemented context slices throw;
// publication effects, credentials, native projection and SQLite remain real.
function strictSlice<T extends object>(parts: Partial<T>): T {
  return new Proxy(parts, {
    get(target, property) {
      if (!Reflect.has(target, property))
        throw new Error(`unexpected fixture context slice: ${String(property)}`);
      return Reflect.get(target, property);
    },
  }) as T;
}

export async function publicationFixture(configure = true) {
  const dataDir = mkdtempSync(join(tmpdir(), "github-publication-source-"));
  const receiver = await githubReceiver();
  const store = new ServerStore(openDatabase(join(dataDir, "host.db")));
  let database = openPluginDatabase({
    dataDir,
    pluginId: PLUGIN_ID,
    maxBytes: manifestJson.database.maxBytes,
  });
  const initial = nativePolicy();
  const state = {
    metadata: initial.metadata,
    policy: initial.policy,
    credentialAvailable: true,
    connected: true,
    nativeAllowed: true,
    deniedCaps: new Set<string>(),
    deniedOperations: new Set<string>(),
    // Native authority remains operation-scoped even when other grants stay live.
    root: true,
    installation: "a".repeat(64),
    enabled: true,
    callerPlugin: "fixture.consumer" as string | null,
    principal: {
      id: "fixture-human",
      kind: "human",
      name: "Fixture human",
      color: "#123456",
    } as Principal,
    preflightGate: null as FixtureBarrier | null,
    beforeNativeAuthorization: null as ((operationId: string) => Promise<void>) | null,
    nextDatabaseRunFault: null as "before" | "after" | null,
  };
  const runner = await nativeRunner(state.policy, () => state.credentialAvailable).catch(
    async (error: unknown) => {
      database.close();
      store.close();
      try {
        await receiver.close();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
      throw error;
    },
  );
  // A one-shot host-response fault around the next real SQLite write. Tests arm this only
  // after receiver acceptance; no SQL inspection, table knowledge, or fake database result.
  const guestDatabase: GuestDatabase = {
    pluginId: PLUGIN_ID,
    query<Row extends GuestSqlRow>(sql: string, params?: readonly GuestSqlParam[]) {
      return database.query<Row>(sql, params);
    },
    async run(sql, params) {
      const fault = state.nextDatabaseRunFault;
      state.nextDatabaseRunFault = null;
      if (fault === "before") throw new Error("fixture database write unavailable");
      const result = await database.run(sql, params);
      if (fault === "after") throw new Error("fixture database write response lost");
      return result;
    },
    batch: (statements) => database.batch(statements),
  };
  const invoke = async (args: ServiceReadArgs): Promise<ServiceReply> => {
    assert.equal(args.machineId, state.metadata.machineId);
    assert.equal(args.policySha256, hash(state.policy));
    return runner.call(
      {
        type: "service",
        requestId: randomBytes(16).toString("hex"),
        serviceId: args.serviceId,
        operationId: args.operationId,
        input: args.input,
      },
      {
        serviceId: args.serviceId,
        revision: args.revision,
        operationIds: Object.keys(state.policy.operations),
      },
      async (request) => {
        await state.beforeNativeAuthorization?.(request.operationId);
        return state.nativeAllowed && state.connected;
      },
    );
  };
  const roster = (): PluginRoster => [
    {
      manifest: PluginManifestSchema.parse(manifestJson),
      enabled: state.enabled,
      source: "plugin",
      actions: [],
      install: {
        sha256: state.installation,
        source: "fixture-local-bundle",
        grantedCaps: PluginManifestSchema.parse(manifestJson).capabilities,
        installedBy: "fixture-human",
        installedAt: 1,
      },
    },
  ];
  let trace = 0;
  const ctx = (): GuestCtx =>
    strictSlice<GuestCtx>({
      traceId: ++trace,
      pluginId: PLUGIN_ID,
      callerPlugin: state.callerPlugin,
      principal: { ...state.principal },
      agentRun: null,
      containerScope: null,
      now: () => 1,
      newId: async () => randomBytes(16).toString("hex"),
      database: guestDatabase,
      storage: store.pluginStorage(PLUGIN_ID),
      auth: {
        principal: { ...state.principal },
        caps: ["services:read", "services:invoke", "services:configure"],
        containerScope: null,
        get isRoot() {
          return state.root;
        },
        allows: async (cap, ref) => {
          if (cap === "services:read" || cap === "services:invoke") {
            assert.equal(ref?.kind, "service", "native authority must be operation-scoped");
            if (ref?.kind === "service") {
              assert.equal(ref.machineId, state.metadata.machineId);
              assert.equal(ref.serviceId, state.metadata.serviceId);
              assert.ok(typeof ref.operationId === "string", "native grant must name an operation");
              assert.ok(Object.hasOwn(state.policy.operations, ref.operationId));
              if (state.deniedOperations.has(ref.operationId)) return false;
            }
          }
          return !state.deniedCaps.has(cap);
        },
      },
      host: {
        roster: async () => roster(),
        enabled: async (id) => id === PLUGIN_ID && state.enabled,
      },
      services: strictSlice<GuestCtx["services"]>({
        readConfiguration: async () => {
          if (state.preflightGate) await state.preflightGate.wait();
          return {
            connected: state.connected,
            configuration: { revision: hash([state.policy]), policies: [state.policy] },
            credentialReferences: [
              {
                ref: CREDENTIAL_REF,
                origins: ["https://api.github.com"],
                available: state.credentialAvailable,
              },
            ],
            runtimeCandidates: [],
          };
        },
        describe: async () => {
          if (state.preflightGate) await state.preflightGate.wait();
          return {
            machineId: state.metadata.machineId,
            connected: state.connected,
            services: [
              {
                serviceId: state.policy.serviceId,
                revision: state.policy.revision,
                policySha256: hash(state.policy),
                operations: Object.entries(state.policy.operations).map(
                  ([operationId, operation]) => ({
                    operationId,
                    readable: !("kind" in operation) && operation.readable === true,
                    invocable: !("kind" in operation) && operation.invocable === true,
                    ready: state.connected && state.credentialAvailable,
                    reason: state.credentialAvailable ? null : "service_credential_unavailable",
                  }),
                ),
              },
            ],
          };
        },
        read: invoke,
        invoke,
      }),
    });
  const hook = (): GuestLifecycleCtx =>
    strictSlice<GuestLifecycleCtx>({
      pluginId: PLUGIN_ID,
      storage: store.pluginStorage(PLUGIN_ID),
      database,
      now: () => 1,
    });
  const configureConnection = async (
    metadata: ConnectionMetadata = state.metadata,
    expectedRevision: string | null = null,
  ) =>
    ConfigureConnectionResultSchema.parse(
      await handlers.configureConnection(ctx(), { ...metadata, expectedRevision }),
    ).connection;
  const prepare = async (input: PrepareIssuePublicationInput = draft) =>
    PublicationSchema.parse(await handlers.prepareIssuePublication(ctx(), input));
  const publish = async (publication: Publication) =>
    PublicationSchema.parse(await handlers.publishIssue(ctx(), reviewed(publication)));
  const readPublication = async (publication: Publication) =>
    PublicationSchema.parse(
      await handlers.readPublication(ctx(), { operationId: publication.operationId }),
    );
  const reopenDatabase = () => {
    database = openPluginDatabase({
      dataDir,
      pluginId: PLUGIN_ID,
      maxBytes: manifestJson.database.maxBytes,
    });
  };
  try {
    await lifecycle.onEnable?.(hook());
    if (configure) await configureConnection();
  } catch (error) {
    runner.close();
    database.close();
    store.close();
    try {
      await receiver.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
    throw error;
  }
  return {
    dataDir,
    receiver,
    state,
    runner,
    ctx,
    hook,
    prepare,
    publish,
    readPublication,
    configureConnection,
    async restart() {
      await lifecycle.onDisable?.(hook());
      database.close();
      reopenDatabase();
      await lifecycle.onEnable?.(hook());
    },
    snapshot(name: string) {
      database.close();
      const path = join(dataDir, `${name}.db`);
      copyFileSync(pluginDatabasePath(dataDir, PLUGIN_ID), path);
      return path;
    },
    async restore(path: string) {
      await lifecycle.onDisable?.(hook());
      database.close();
      copyFileSync(path, pluginDatabasePath(dataDir, PLUGIN_ID));
      reopenDatabase();
      await lifecycle.onEnable?.(hook());
    },
    async close() {
      state.preflightGate?.release();
      runner.close();
      try {
        await lifecycle.onDisable?.(hook());
      } finally {
        database.close();
        store.close();
        try {
          await receiver.close();
        } finally {
          rmSync(dataDir, { recursive: true, force: true });
        }
      }
    },
  };
}
