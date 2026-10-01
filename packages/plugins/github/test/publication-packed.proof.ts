import "../../../server/src/shared-modules.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packPlugin } from "@manifold/plugin-kit/pack";
import {
  ENGINE_INSTALL_ACTION,
  ENGINE_SET_ENABLED_ACTION,
  ENGINE_UNINSTALL_ACTION,
} from "@manifold/plugin";
import {
  canonicalJobJson,
  formatManifoldUri,
  JOB_OWNER_PROTOCOL_VERSION,
  JobEventSchema,
  PluginManifestSchema,
  type JobCommand,
  type JobOwner,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../../../server/src/auth.ts";
import { openDatabase } from "../../../server/src/db.ts";
import { IsolateSupervisor } from "../../../server/src/isolate/supervisor.ts";
import { JobService } from "../../../server/src/job-service.ts";
import { silentLogger } from "../../../server/src/log.ts";
import { PLUGIN_UPLOADS_DIR } from "../../../server/src/plugin-installs.ts";
import type { PluginHost } from "../../../server/src/plugin-host.ts";
import { RoomManager } from "../../../server/src/room.ts";
import { ServerStore, TRACE_ROW_TYPE } from "../../../server/src/stores.ts";
import { TerminalBroker } from "../../../server/src/terminal-broker.ts";
import {
  FakeClock,
  FakeRuntime,
  testPluginHost,
  testTileTrees,
} from "../../../server/test/helpers.ts";
import manifestJson from "../manifest.json";
import {
  CAPS,
  ConfigureConnectionResultSchema,
  DOORS,
  PLUGIN_ID,
  PublicationSchema,
  ReadConnectionsResultSchema,
  type Publication,
} from "../src/contract.ts";
import {
  CREDENTIAL_REF,
  PRIVATE_CANARY,
  RESPONSE_CANARY,
  SYNTHETIC_CREDENTIAL,
  REPOSITORY_PATH,
  githubReceiver,
  hash,
  nativePolicy,
  nativeRunner,
} from "./publication-native.fixture.ts";

export interface PackedPublicationReport {
  hardened: boolean;
  accepted: number;
  lostResponseRecovered: boolean;
  receiptSurvivedHandoffFailure: boolean;
  bundleSha256: string;
}

/** Disposable real host using the same author packer, install door, IsolateSupervisor and
 * owner-proof/JobService protocol as plugin-kit and server/native-services fixtures. The
 * native peer's channel is in process; every HTTP effect still crosses a real TCP receiver.
 * Ordinary mode loads actual packed server.js; hardened mode starts the actual guest child.
 * This is NOT real GitHub/TLS, production enrollment, or a fake authored provider. */
export async function runPackedPublicationProof(
  hardened: boolean,
): Promise<PackedPublicationReport> {
  const dataDir = mkdtempSync(join(tmpdir(), "github-publication-packed-"));
  const receiver = await githubReceiver();
  const store = new ServerStore(openDatabase(join(dataDir, "host.db")));
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  // A fresh run-owned root key. Never inherited MANIFOLD variables or user auth caches.
  const key = randomBytes(32).toString("hex");
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const consumerGrant = auth.bootstrapPrincipal({ kind: "human", name: "Fixture publisher" }, root);
  const consumer = auth.authenticate(consumerGrant.token);
  const machineId = auth.enrollMachine("github-publication-fixture", root).machine.id;
  const { metadata, policy } = nativePolicy(machineId);
  const native = await nativeRunner(policy).catch(async (error: unknown) => {
    store.close();
    try {
      await receiver.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
    throw error;
  });
  const jobs = new JobService(store, auth, runtime);
  jobs.setLifecycleRecorder((record) => store.appendTrace(record));
  let supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://127.0.0.1:7777",
    testTileTrees,
  );
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "fixture-owner",
    generation: 1,
    inventoryDigest: hash(policy),
    platforms: ["linux-x64"],
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    resources: {
      tools: {},
      anchors: {},
      services: { [policy.serviceId]: hash(policy) },
      serviceDefinitions: {
        [policy.serviceId]: {
          revision: policy.revision,
          operationIds: Object.keys(policy.operations),
        },
      },
      credentialReferences: [
        { ref: CREDENTIAL_REF, origins: ["https://api.github.com"], available: true },
      ],
    },
  };
  const authorizations = new Map<string, (allowed: boolean) => void>();
  const cancellations = new Map<string, AbortController>();
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const commands: JobCommand[] = [];
  let authorizationSequence = 0;
  let host: PluginHost | undefined;
  const channel = {
    machineId,
    send({ command }: { type: "job_command"; command: JobCommand }): boolean {
      commands.push(command);
      if (command.type === "service_authorized")
        authorizations.get(command.authorizationId)?.(command.allowed);
      else if (command.type === "configure_services")
        native.configure(command.configuration.policies);
      else if (command.type === "service_read_cancel" || command.type === "service_invoke_cancel")
        cancellations.get(command.requestId)?.abort();
      else if (command.type === "service_read" || command.type === "service_invoke") {
        const controller = new AbortController();
        cancellations.set(command.requestId, controller);
        const task = (async () => {
          const reply = await native.call(
            {
              type: "service",
              requestId: command.requestId,
              serviceId: command.serviceId,
              operationId: command.operationId,
              input: command.input,
            },
            {
              serviceId: command.serviceId,
              revision: command.revision,
              operationIds: Object.keys(policy.operations),
            },
            async () => {
              const authorizationId = `fixture-authorization-${++authorizationSequence}`;
              const decision = Promise.withResolvers<boolean>();
              authorizations.set(authorizationId, decision.resolve);
              try {
                jobs.event(
                  channel,
                  JobEventSchema.parse({
                    type: "service_authorize",
                    subject: {
                      kind: command.type === "service_read" ? "read" : "invoke",
                      requestId: command.requestId,
                    },
                    authorizationId,
                    serviceId: command.serviceId,
                    revision: command.revision,
                    policySha256: command.policySha256,
                    operationId: command.operationId,
                  }),
                );
                return await decision.promise;
              } finally {
                authorizations.delete(authorizationId);
              }
            },
            controller.signal,
          );
          jobs.event(
            channel,
            JobEventSchema.parse({
              type:
                command.type === "service_read" ? "service_read_result" : "service_invoke_result",
              requestId: command.requestId,
              reply,
            }),
          );
        })()
          .catch((error: unknown) => {
            failures.push(error);
          })
          .finally(() => {
            cancellations.delete(command.requestId);
          });
        active.add(task);
        void task.finally(() => active.delete(task));
      }
      return true;
    },
  };
  const proveOwner = () => {
    jobs.online(channel, owner, "fixture-epoch");
    const challenge = commands.findLast((command) => command.type === "owner_challenge");
    assert.ok(challenge?.type === "owner_challenge");
    const body = { nonce: challenge.nonce, serverEpoch: challenge.serverEpoch, machineId, owner };
    jobs.event(channel, {
      type: "owner_proof",
      ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString(
        "base64",
      ),
    });
  };
  const dispatch = async (action: string, input: unknown, caller: AuthContext = root) => {
    assert.ok(host);
    const result = await host.dispatch(caller, action, input);
    assert.equal(result.ok, true, `public door refused: ${action}: ${JSON.stringify(result)}`);
    if (!result.ok) throw new Error("unreachable dispatch refusal");
    return result.result;
  };
  const call = (action: string, input: unknown) =>
    dispatch(`${PLUGIN_ID}.${action}`, input, consumer);
  const prepare = async (consumerRef: string) =>
    PublicationSchema.parse(
      await call(DOORS.prepareIssuePublication, {
        connectionId: metadata.connectionId,
        consumerRef,
        publicTitle: "Packed reviewed publication",
        publicBody: "Exact public fixture bytes.\n",
      }),
    );
  const publish = async (prepared: Publication) =>
    PublicationSchema.parse(
      await call(DOORS.publishIssue, {
        operationId: prepared.operationId,
        reviewedDigest: prepared.reviewedDigest,
      }),
    );
  try {
    jobs.configureServiceConfiguration(root, {
      machineId,
      expectedRevision: null,
      policies: [policy],
    });
    proveOwner();
    host = await testPluginHost(store, auth, rooms, broker, runtime, {
      isolates: { runner: supervisor, dataDir },
    });
    host.setJobs(jobs);
    mkdirSync(join(dataDir, PLUGIN_UPLOADS_DIR), { recursive: true });
    const source = join(dataDir, PLUGIN_UPLOADS_DIR, "github.manifold-plugin.json");
    const packed = await packPlugin(join(import.meta.dir, ".."), source);
    const manifest = PluginManifestSchema.parse(manifestJson);
    await dispatch(ENGINE_INSTALL_ACTION, {
      source,
      sha256: packed.sha256,
      hardened,
      grant: manifest.capabilities,
    });
    const wildcardOnly = await host.dispatch(root, `${PLUGIN_ID}.${DOORS.configureConnection}`, {
      ...metadata,
      expectedRevision: null,
    });
    assert.equal(wildcardOnly.ok, false, "engine wildcard must not grant provider authority");
    assert.deepEqual(receiver.accepted, []);
    // A wildcard covers only engine capabilities. Real owner-approved rows
    // authorize this run's principals for the optional provider's own doors.
    auth.grant(
      {
        principal: { kind: "principal", id: root.principal.id },
        node: "manifold://",
        caps: Object.values(CAPS),
        effect: "allow",
        reach: "subtree",
      },
      root,
    );
    auth.grant(
      {
        principal: { kind: "principal", id: consumer.principal.id },
        node: "manifold://",
        caps: [CAPS.read, CAPS.prepare, CAPS.publish],
        effect: "allow",
        reach: "subtree",
      },
      root,
    );
    const installed = host.roster().find((row) => row.manifest.id === PLUGIN_ID);
    assert.equal(installed?.install?.sha256, packed.sha256);
    assert.equal(installed?.install?.hardened, hardened);
    assert.ok(owner.resources);
    jobs.event(channel, {
      type: "resources",
      resources: {
        ...owner.resources,
        credentialReferences: [
          { ref: CREDENTIAL_REF, origins: ["https://api.github.com"], available: false },
        ],
      },
    });
    const missingCredential = await host.dispatch(
      root,
      `${PLUGIN_ID}.${DOORS.configureConnection}`,
      { ...metadata, expectedRevision: null },
    );
    assert.equal(missingCredential.ok, false);
    assert.deepEqual(receiver.accepted, []);
    jobs.event(channel, { type: "resources", resources: owner.resources });
    ConfigureConnectionResultSchema.parse(
      await dispatch(`${PLUGIN_ID}.${DOORS.configureConnection}`, {
        ...metadata,
        expectedRevision: null,
      }),
    );
    assert.equal(
      ReadConnectionsResultSchema.parse(await call(DOORS.readConnections, {})).connections[0]
        ?.connectionId,
      metadata.connectionId,
    );
    const privateInput = await host.dispatch(
      consumer,
      `${PLUGIN_ID}.${DOORS.prepareIssuePublication}`,
      {
        connectionId: metadata.connectionId,
        consumerRef: "forbidden-private-input",
        publicTitle: "Public title",
        publicBody: "Public body",
        privateContext: PRIVATE_CANARY,
      },
    );
    assert.equal(privateInput.ok, false);
    assert.ok(!JSON.stringify(privateInput).includes(PRIVATE_CANARY));
    const prepared = await prepare("packed-first");
    assert.deepEqual(await prepare("packed-first"), prepared);
    assert.deepEqual(receiver.accepted, []);
    const [first, second] = await Promise.all([publish(prepared), publish(prepared)]);
    assert.ok([first.state, second.state].includes("published"));
    const published = PublicationSchema.parse(
      await call(DOORS.readPublication, { operationId: prepared.operationId }),
    );
    assert.equal(published.state, "published");
    assert.equal(published.receipt?.url, "https://github.com/fixture-owner/fixture-repo/issues/1");
    assert.equal(published.receipt?.issueNodeId, "I_fixture_1");
    assert.deepEqual(
      receiver.requests.filter((request) => request.method === "POST"),
      [
        {
          method: "POST",
          path: `${REPOSITORY_PATH}/issues`,
          body: { title: prepared.publicTitle, body: prepared.publicBody },
        },
      ],
    );
    // Code is genuinely absent. An actual independent public-door dispatch fails; there is no
    // fake successful handoff and no provider rollback/deletion/republication to compensate it.
    const handoff = await host.dispatch(consumer, "atyrode.code.reviewInteractiveHandoff", {
      issueUrl: published.receipt!.url,
    });
    assert.equal(handoff.ok, false);
    assert.deepEqual(
      await call(DOORS.readPublication, { operationId: prepared.operationId }),
      published,
    );
    const lost = await prepare("packed-lost-response");
    receiver.state.create = "drop";
    assert.equal((await publish(lost)).state, "outcome_unknown");
    assert.equal(receiver.accepted.length, 2);
    host.close();
    await supervisor.close();
    supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
    host = await testPluginHost(store, auth, rooms, broker, runtime, {
      isolates: { runner: supervisor, dataDir },
    });
    host.setJobs(jobs);
    assert.equal((await prepare("packed-lost-response")).state, "outcome_unknown");
    assert.equal((await publish(lost)).state, "outcome_unknown");
    assert.equal(receiver.accepted.length, 2);
    const recovered = PublicationSchema.parse(
      await call(DOORS.reconcilePublication, { operationId: lost.operationId, issueNumber: 2 }),
    );
    assert.equal(recovered.state, "published");
    assert.equal(recovered.receipt?.issueNumber, 2);
    assert.equal(recovered.receipt?.reviewedDigest, lost.reviewedDigest);
    const denied = await prepare("packed-native-revoked");
    auth.grant(
      {
        principal: { kind: "principal", id: consumer.principal.id },
        node: formatManifoldUri({
          kind: "service",
          machineId,
          serviceId: metadata.serviceId,
          operationId: "create",
        }),
        caps: ["services:invoke"],
        effect: "deny",
        reach: "subtree",
      },
      root,
    );
    const revoked = await host.dispatch(consumer, `${PLUGIN_ID}.${DOORS.publishIssue}`, {
      operationId: denied.operationId,
      reviewedDigest: denied.reviewedDigest,
    });
    assert.equal(revoked.ok, false);
    assert.equal(receiver.accepted.length, 2);
    const publicArtifacts = JSON.stringify({
      published,
      recovered,
      traces: store.listEvents({ type: TRACE_ROW_TYPE, limit: 1000 }),
      roster: host.roster(),
    });
    for (const canary of [PRIVATE_CANARY, RESPONSE_CANARY, SYNTHETIC_CREDENTIAL])
      assert.ok(
        !publicArtifacts.includes(canary),
        "private receiver material escaped the public boundary",
      );
    // Publication input is opaque even though those explicitly public bytes are in SQLite.
    const traces = JSON.stringify(store.listEvents({ type: TRACE_ROW_TYPE, limit: 1000 }));
    assert.ok(!traces.includes(prepared.publicBody));
    assert.deepEqual(failures, []);
    await dispatch(ENGINE_SET_ENABLED_ACTION, { id: PLUGIN_ID, enabled: false });
    await dispatch(ENGINE_UNINSTALL_ACTION, { id: PLUGIN_ID, purge: true });
    return {
      hardened,
      accepted: receiver.accepted.length,
      lostResponseRecovered: true,
      receiptSurvivedHandoffFailure: true,
      bundleSha256: packed.sha256,
    };
  } finally {
    receiver.state.createGate.release();
    receiver.state.readGate?.release();
    jobs.offline(channel);
    for (const controller of cancellations.values()) controller.abort();
    for (const resolve of authorizations.values()) resolve(false);
    native.close();
    await Promise.all(active);
    host?.close();
    await supervisor.close();
    store.close();
    try {
      await receiver.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const reports: PackedPublicationReport[] = [];
  for (const hardened of [false, true]) reports.push(await runPackedPublicationProof(hardened));
  console.log(JSON.stringify({ fixture: "github-publication-fixed-origin-loopback", reports }));
}
