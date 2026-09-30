import "../src/shared-modules.ts";
import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { defineAction } from "@manifold/plugin";
import { z } from "zod";
import {
  canonicalJobJson,
  canonicalNativeTransferPolicy,
  JOB_OWNER_PROTOCOL_VERSION,
  MACHINE_NATIVE_TRANSFERS_PROTOCOL_VERSION,
  ManifoldRefSchema,
  formatManifoldUri,
  type JobCommand,
  type JobOwner,
  type NativeTransferBinding,
  type NativeTransferBeginPutArgs,
  type NativeTransferResult,
  type NativeTransferStatus,
  type NativeTransferTerminalEvidence,
  type NativeTransferPendingAdmission,
} from "@manifold/protocol";
import { AuthService, ServiceError, type AuthContext, type GovernedAdmission } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { ServerStore } from "../src/stores.ts";
import {
  NativeTransferService,
  type NativeTransferChannel,
  type NativeTransferGuard,
} from "../src/native-transfer-service.ts";
import type { JobInstallation } from "../src/job-store.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";
import { JobService } from "../src/job-service.ts";
import type { ActionCtx, PluginHost, ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { silentLogger } from "../src/log.ts";
import { nativeTransferContext } from "../src/native-transfer-context.ts";

const stores: ServerStore[] = [];
const hosts: PluginHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const store of stores.splice(0)) store.close();
});
function fixture(admission?: GovernedAdmission) {
  const store = new ServerStore(openDatabase(":memory:"));
  stores.push(store);
  const runtime = new FakeRuntime();
  const auth = new AuthService(store, "9".repeat(64), runtime, admission);
  const actor = auth.authenticate("9".repeat(64));
  const machineId = auth.enrollMachine("transfer fixture", actor).machine.id;
  const pluginId = "sample.transfer";
  const locationId = `${pluginId}.files`;
  const installation: JobInstallation = {
    machineId,
    pluginId,
    revision: "install1",
    artifact: "",
    enabled: true,
    ready: true,
    purgeRequested: false,
    machine: {
      artifacts: {},
      operations: {},
      locations: {
        [locationId]: {
          anchor: "state",
          components: ["files"],
          revision: "location1",
          kind: "directory",
          managed: true,
        },
      },
      transferPolicy: {
        format: "native-transfer-v1",
        locations: { [locationId]: ["create-child", "read"] },
      },
    },
  };
  installation.artifact = createHash("sha256")
    .update(canonicalNativeTransferPolicy(installation.machine))
    .digest("hex");
  const keys = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "owner1",
    generation: 1,
    platforms: ["linux-x64"],
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    inventoryDigest: "a".repeat(64),
  };
  const controls = {
    consent: "consent1",
    ready: "b".repeat(64),
    current: true,
    declared: true,
    dropCommit: false,
    sourceAvailable: true,
    ownerAvailable: true,
    rejectPut: false,
    invalidRead: false,
    dropBeforeCommit: false,
    dropBeforeBegin: false,
    silentCommit: false,
    prepared: () => {},
    committed: () => {},
    readReply: () => {},
    statusReply: () => {},
  };
  const commands: Extract<JobCommand, { type: "native_transfer" }>[] = [];
  const remote = new Map<
    string,
    {
      binding: NativeTransferBinding;
      status: NativeTransferStatus;
      chunks: Map<number, { offset: number; data: string }>;
    }
  >();
  let service: NativeTransferService;
  const channel: NativeTransferChannel = {
    machineId,
    send: ({ command }) => {
      if (command.type !== "native_transfer") throw new Error("wrong transfer channel");
      commands.push(command);
      expect(
        verify(
          null,
          Buffer.from(canonicalJobJson(command.permit.body)),
          keys.publicKey,
          Buffer.from(command.permit.signature, "base64"),
        ),
      ).toBe(true);
      expect(command.permit.body.commandDigest).toBe(
        createHash("sha256").update(canonicalJobJson(command.request)).digest("hex"),
      );
      queueMicrotask(() => {
        const request = command.request;
        const id = "binding" in request ? request.binding.transferId : request.transferId;
        if ("binding" in request && controls.dropBeforeBegin) {
          service.disconnect(channel);
          return;
        }
        if ("binding" in request)
          remote.set(id, {
            binding: request.binding,
            status: {
              transferId: id,
              mode: request.binding.request.mode,
              state: request.method === "beginRead" ? "ready" : "receiving",
              bytes: request.method === "beginRead" ? 4 : 0,
            },
            chunks: new Map(),
          });
        const row = remote.get(id);
        if (!row) {
          service.event(channel, { type: "native_transfer_result", rpcId: command.rpcId,
            ownerId: owner.ownerId, ownerGeneration: owner.generation,
            result: { ok: false, reason: "native_transfer_unknown" } });
          return;
        }
        let result: NativeTransferResult;
        if (request.method === "beginRead") {
          const source = request.binding.request;
          const sha256 = createHash("sha256").update("data").digest("hex");
          row.status = {
            ...row.status,
            sha256,
            receipt: {
              transferId: id,
              mode: "read",
              requestId: source.requestId,
              machineId,
              pluginId,
              actorId: row.binding.actorId,
              credentialBinding: row.binding.credentialBinding,
              installationRevision: source.installationRevision,
              artifactSha256: source.artifactSha256,
              locationId,
              locationRevision: source.locationRevision,
              ownerId: owner.ownerId,
              ownerGeneration: owner.generation,
              path: `/private/files/${source.relativePath.join("/")}`,
              bytes: 4,
              sha256,
              committedAt: runtime.now(),
            },
          };
        }
        if (request.method === "preparePut") {
          row.status = { ...row.status, state: "verifying" };
          controls.prepared();
        }
        if (request.method === "commitPut") {
          if (controls.dropBeforeCommit) {
            service.disconnect(channel);
            return;
          }
          const source = row.binding.request;
          if (source.mode !== "put") throw new Error("put required");
          row.status = {
            ...row.status,
            state: "committed",
            bytes: source.source.bytes,
            sha256: source.source.sha256,
            receipt: {
              transferId: id,
              mode: "put",
              requestId: source.requestId,
              machineId,
              pluginId,
              actorId: row.binding.actorId,
              credentialBinding: row.binding.credentialBinding,
              installationRevision: source.installationRevision,
              artifactSha256: source.artifactSha256,
              locationId,
              locationRevision: source.locationRevision,
              ownerId: owner.ownerId,
              ownerGeneration: owner.generation,
              path: `/private/files/${source.filename}`,
              bytes: source.source.bytes,
              sha256: source.source.sha256,
              committedAt: runtime.now(),
            },
          };
          if (controls.dropCommit) {
            service.disconnect(channel);
            return;
          }
          controls.committed();
          if (controls.silentCommit) return;
        }
        result = { ok: true, status: row.status };
        if (request.method === "putChunk") {
          const prior = row.chunks.get(request.seq);
          if (
            controls.rejectPut ||
            (prior && (prior.offset !== request.offset || prior.data !== request.data)) ||
            (!prior && (request.seq !== row.chunks.size || request.offset !== row.status.bytes))
          ) {
            result = {
              ok: false,
              reason: "native_transfer_chunk_sequence_mismatch",
              status: row.status,
            };
          } else if (!prior) {
            row.chunks.set(request.seq, { offset: request.offset, data: request.data });
            row.status = {
              ...row.status,
              bytes: row.status.bytes + Buffer.byteLength(request.data, "base64"),
            };
            result = { ok: true, status: row.status };
          }
        }
        if (request.method === "readChunk") {
          const data = Buffer.from("data").subarray(
            request.offset,
            request.offset + request.maxBytes,
          );
          result = {
            ok: true,
            status: row.status,
            data: data.toString("base64"),
            offset: controls.invalidRead ? request.offset + 1 : request.offset,
            eof: request.offset + data.length === 4,
          };
          controls.readReply();
        }
        if (request.method === "status" || request.method === "evidence") controls.statusReply();
        service.event(channel, {
          type: "native_transfer_result",
          rpcId: command.rpcId,
          ownerId: owner.ownerId,
          ownerGeneration: owner.generation,
          result,
        });
      });
      return true;
    },
  };
  const createService = () =>
    new NativeTransferService(
      store,
      auth,
      {
        owner: () => (controls.ownerAvailable ? { owner, channel, seatNonce: "seat1" } : null),
        installation: () => installation,
        held: () => false,
        consent: () => controls.consent,
        sign: (body) =>
          sign(null, Buffer.from(canonicalJobJson(body)), keys.privateKey).toString("base64"),
      },
      () => runtime.now(),
    );
  service = createService();
  const guard: NativeTransferGuard = {
    remainingMs: () => Number.POSITIVE_INFINITY,
    assertCurrent: () => {
      if (!controls.current) throw new Error("transfer_action_unavailable");
    },
    require: () => {
      if (!controls.declared) throw new Error("transfer_requirement_undeclared");
    },
    requireSource: async () => {
      if (!controls.sourceAvailable)
        throw new ServiceError("forbidden", "transfer_source_unavailable");
      return controls.ready;
    },
  };
  const caller = { auth: actor, pluginId, guard };
  const request = {
    mode: "put" as const,
    requestId: "request1",
    machineId,
    installationRevision: installation.revision,
    artifactSha256: installation.artifact,
    locationId,
    locationRevision: "location1",
    filename: "result.bin",
    source: {
      ref: { kind: "file" as const, fileId: "source-file" },
      sha256: createHash("sha256").update("").digest("hex"),
      bytes: 0,
    },
  };
  return {
    store,
    auth,
    actor,
    runtime,
    get service() {
      return service;
    },
    caller,
    request,
    controls,
    commands,
    owner,
    installation,
    keys,
    remote,
    restart() {
      service = createService();
    },
  };
}

function nativePins(request: NativeTransferBeginPutArgs) {
  return { requestId: request.requestId, machineId: request.machineId,
    installationRevision: request.installationRevision, artifactSha256: request.artifactSha256,
    locationId: request.locationId, locationRevision: request.locationRevision };
}

test("unadmitted refusals retire only the exact queued product request without inventing a native transfer", async () => {
  const f = fixture();
  const evidence: unknown[] = [];
  f.service.setEvidenceSink(async (_plugin, receipts) => {
    evidence.push(...receipts);
    return true;
  });
  await expect(
    f.service.begin(f.caller, { ...f.request, installationRevision: "stale" }),
  ).rejects.toThrow("installation_changed");
  expect(evidence).toEqual([
    {
      kind: "admission-refused",
      requestId: f.request.requestId,
      actorId: f.actor.principal.id,
      credentialBinding: f.auth.credentialBinding(f.actor),
      mode: "put",
      attemptedAt: f.runtime.now(),
      reason: "installation_changed",
    },
  ]);
  expect(f.commands).toEqual([]);
  expect(f.store.db.query("SELECT id FROM native_transfers").all()).toEqual([]);
  const next = { ...f.request, requestId: "new-intent" };
  const started = await f.service.begin(f.caller, next);
  evidence.length = 0;
  await expect(
    f.service.begin(f.caller, { ...next, filename: "changed.bin" }),
  ).rejects.toThrow("transfer_request_conflict");
  expect(evidence).toEqual([]);
  expect(retained(f, started.transferId).status.state).toBe("receiving");
});

test("failed pre-admission reservation cleanup is explicit rather than a clean refusal", async () => {
  const f = fixture();
  f.service.setEvidenceSink(async () => false);
  await expect(
    f.service.begin(f.caller, { ...f.request, installationRevision: "stale" }),
  ).rejects.toThrow("native_transfer_cleanup_unknown");
  expect(f.commands).toEqual([]);
  expect(f.store.db.query("SELECT id FROM native_transfers").all()).toEqual([]);
  f.restart();
  const evidence: NativeTransferTerminalEvidence[] = [];
  f.service.setEvidenceSink(async (_plugin, receipts) => { evidence.push(...receipts); return true; });
  await f.service.reconcile();
  expect(evidence).toEqual([expect.objectContaining({
    kind: "admission-refused", requestId: f.request.requestId, mode: "put",
    actorId: f.actor.principal.id, credentialBinding: f.auth.credentialBinding(f.actor),
    reason: "installation_changed",
  })]);
  f.service.assertPurgeable(f.caller.pluginId);
  await f.service.reconcile();
  expect(evidence).toHaveLength(1);
});

test("non-admission recovery fences the exact request without source or machine effect authority", async () => {
  const f = fixture();
  f.controls.sourceAvailable = false;
  f.controls.ownerAvailable = false;
  const expected = { kind: "not-admitted", reason: "transfer_unavailable" };
  expect(await f.service.recoverAdmission(f.caller, f.request)).toEqual(expected);
  f.restart();
  expect(await f.service.recoverAdmission(f.caller, f.request)).toEqual(expected);
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_unavailable");
  await expect(f.service.recoverAdmission(f.caller, { ...f.request, filename: "different.bin" }))
    .rejects.toThrow("transfer_request_conflict");
  await expect(f.service.recoverAdmission(f.caller, { ...nativePins(f.request), mode: "read", relativePath: ["different.bin"] }))
    .rejects.toThrow("transfer_request_conflict");
  expect(f.commands).toEqual([]);
  expect(f.store.db.query("SELECT id FROM native_transfers").all()).toEqual([]);
});

function pendingAdmission(
  f: { actor: AuthContext; auth: AuthService; request: NativeTransferPendingAdmission["request"]; runtime: FakeRuntime },
  overrides: Partial<NativeTransferPendingAdmission> = {},
): NativeTransferPendingAdmission {
  return {
    actorId: f.actor.principal.id,
    credentialBinding: f.auth.credentialBinding(f.actor),
    request: f.request,
    createdAt: f.runtime.now(),
    ...overrides,
  };
}

for (const loss of ["revoked", "expired", "nonreturning"] as const) {
  test(`idle owner recovery retires a pre-host reservation with a ${loss} caller and no online machine`, async () => {
    const f = fixture();
    const actor = {
      ...f.auth.authenticate(f.auth.mintToken({
        principal: { name: "original", kind: "human" }, caps: ["locations:create-child"],
      }, f.actor).token),
      expiresAt: 30_000,
    };
    const reservation = pendingAdmission(f, {
      actorId: actor.principal.id, credentialBinding: f.auth.credentialBinding(actor),
    });
    if (loss === "revoked") f.auth.revokePrincipal(actor.principal.id, f.actor);
    if (loss === "expired") f.runtime.time = 30_000;
    f.controls.ownerAvailable = false;
    f.controls.sourceAvailable = false;
    f.restart();
    let pending = true;
    const delivered: NativeTransferTerminalEvidence[] = [];
    f.service.setPendingAdmissionSource({
      owners: () => [f.caller.pluginId],
      probe: async (_plugin, accept) => { accept(pending ? [reservation] : []); return true; },
    });
    f.service.setEvidenceSink(async (pluginId, receipts) => {
      expect(pluginId).toBe(f.caller.pluginId);
      for (const receipt of receipts) {
        if (receipt.kind === "admission-refused" &&
          receipt.actorId === reservation.actorId &&
          receipt.credentialBinding === reservation.credentialBinding &&
          receipt.requestId === reservation.request.requestId) pending = false;
      }
      delivered.push(...receipts);
      return true;
    });
    await f.service.reconcile();
    expect(pending).toBe(false);
    expect(delivered).toEqual([{
      kind: "admission-refused", actorId: reservation.actorId,
      credentialBinding: reservation.credentialBinding, requestId: f.request.requestId,
      mode: "put", attemptedAt: f.runtime.now(), reason: "transfer_unavailable",
    }]);
    f.service.assertPurgeable(f.caller.pluginId);
    if (loss !== "nonreturning")
      await expect(f.service.recoverAdmission({ ...f.caller, auth: actor }, f.request))
        .rejects.toThrow("credential_revoked_or_expired");
    await f.service.reconcile();
    expect(delivered).toHaveLength(1);
    expect(f.commands).toEqual([]);
    expect(f.store.db.query("SELECT id FROM native_transfers").all()).toEqual([]);
  });
}

test("private pending fences isolate plugin, actor, credential, request and complete request arguments", async () => {
  const f = fixture();
  const original = pendingAdmission(f);
  const otherPlugin = "other.transfer";
  const reservations = [
    original,
    { ...original, actorId: "another-actor" },
    { ...original, credentialBinding: "c".repeat(64) },
    { ...original, request: { ...f.request, requestId: "another-request" } },
  ];
  const delivered = new Map<string, NativeTransferTerminalEvidence[]>();
  f.service.setPendingAdmissionSource({
    owners: () => [f.caller.pluginId, otherPlugin],
    probe: async (pluginId, accept) => {
      accept(pluginId === otherPlugin ? [original] : reservations);
      return true;
    },
  });
  f.service.setEvidenceSink(async (pluginId, receipts) => {
    delivered.set(pluginId, [...delivered.get(pluginId) ?? [], ...receipts]);
    return true;
  });
  await f.service.reconcilePendingAdmissions();
  expect(delivered.get(f.caller.pluginId)?.map((entry) => [
    entry.actorId, entry.credentialBinding, entry.requestId,
  ]).sort()).toEqual(reservations.map((entry) => [
    entry.actorId, entry.credentialBinding, entry.request.requestId,
  ]).sort());
  expect(delivered.get(otherPlugin)).toEqual([expect.objectContaining({
    actorId: original.actorId, credentialBinding: original.credentialBinding,
    requestId: original.request.requestId,
  })]);
  for (const request of [
    { ...f.request, filename: "different.bin" },
    { ...f.request, source: { ...f.request.source, bytes: 1 } },
    { ...nativePins(f.request), mode: "read" as const, relativePath: ["different.bin"] },
  ])
    await expect(f.service.recoverAdmission(f.caller, request)).rejects.toThrow("transfer_request_conflict");
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_unavailable");
  expect((await f.service.begin(f.caller, { ...f.request, requestId: "unfenced" })).state).toBe("receiving");
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut"]);
});

for (const state of ["admitted", "intended", "commit-unknown"] as const) {
  test(`private pending recovery preserves an existing ${state} admission without replay`, async () => {
    const f = fixture();
    let transferId: string;
    if (state === "intended") {
      f.controls.dropBeforeBegin = true;
      await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_disconnected");
      transferId = f.store.db.query<{ id: string }, []>("SELECT id FROM native_transfers").get()!.id;
    } else {
      transferId = (await f.service.begin(f.caller, f.request)).transferId;
      if (state === "commit-unknown") {
        f.controls.dropCommit = true;
        await expect(f.service.commitPut(f.caller, transferId)).rejects.toThrow("outcome_unknown");
      }
    }
    f.controls.ownerAvailable = false;
    f.restart();
    const delivered: NativeTransferTerminalEvidence[] = [];
    f.service.setEvidenceSink(async (_id, receipts) => { delivered.push(...receipts); return true; });
    f.service.setPendingAdmissionSource({
      owners: () => [f.caller.pluginId],
      probe: async (_id, accept) => { accept([pendingAdmission(f)]); return true; },
    });
    await f.service.reconcile();
    expect(await f.service.recoverAdmission(f.caller, f.request)).toEqual({ kind: "admitted", transferId });
    expect(delivered).toEqual([]);
    expect(f.store.db.query("SELECT record FROM native_admission_refusals").all()).toEqual([]);
    expect(f.commands.filter((command) => command.request.method === "beginPut")).toHaveLength(1);
    expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow(
      state === "admitted" ? "active_native_transfers" : "outcome_unknown",
    );
  });
}

test("busy and malformed pending probes remain purge-blocking until a bounded successful retry", async () => {
  const f = fixture();
  let snapshot: unknown = null;
  f.service.setPendingAdmissionSource({
    owners: () => [f.caller.pluginId],
    probe: async (_id, accept) => {
      if (snapshot === null) return false;
      accept(snapshot);
      return true;
    },
  });
  f.service.setEvidenceSink(async () => true);
  for (const invalid of [null, Array.from({ length: 33 }, () => pendingAdmission(f)), [
    { ...pendingAdmission(f), credential: { secret: "not-metadata" } },
  ]]) {
    snapshot = invalid;
    await f.service.reconcilePendingAdmissions();
    expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("native_transfer_cleanup_unknown");
    expect(f.store.db.query("SELECT record FROM native_admission_refusals").all()).toEqual([]);
  }
  snapshot = [pendingAdmission(f)];
  await f.service.reconcilePendingAdmissions();
  f.service.assertPurgeable(f.caller.pluginId);
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_unavailable");
  expect(f.commands).toEqual([]);
});

test("private owner budget counts ACKed fences and cannot be bypassed with producer timestamps", async () => {
  const f = fixture();
  f.runtime.time = 9 * 24 * 60 * 60_000;
  let snapshot = Array.from({ length: 32 }, (_, index) => pendingAdmission(f, {
    request: { ...f.request, requestId: `private-${index}` }, createdAt: 0,
  }));
  const delivered: NativeTransferTerminalEvidence[] = [];
  f.service.setPendingAdmissionSource({
    owners: () => [f.caller.pluginId],
    probe: async (_id, accept) => { accept(snapshot); return true; },
  });
  f.service.setEvidenceSink(async (_id, receipts) => { delivered.push(...receipts); return true; });
  await f.service.reconcilePendingAdmissions();
  expect(delivered).toHaveLength(32);
  expect(delivered.every((entry) =>
    entry.kind === "admission-refused" && entry.attemptedAt === f.runtime.now())).toBe(true);
  snapshot = [pendingAdmission(f, { request: { ...f.request, requestId: "private-overflow" }, createdAt: 0 })];
  await f.service.reconcilePendingAdmissions();
  expect(delivered).toHaveLength(32);
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("native_transfer_cleanup_unknown");
  // Existing authenticated recovery keeps its existing shared bound; private owner metadata
  // cannot spend that caller authority merely by advertising another actor or credential.
  expect(await f.service.recoverAdmission(f.caller, snapshot[0]!.request)).toEqual({
    kind: "not-admitted", reason: "transfer_unavailable",
  });
  expect(delivered).toHaveLength(33);
  await f.service.reconcilePendingAdmissions();
  f.service.assertPurgeable(f.caller.pluginId);
  expect(f.commands).toEqual([]);
});

test("non-admission fence wins atomically against an already-awaited source probe", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<string>();
  const caller = { ...f.caller, guard: { ...f.caller.guard, requireSource: () => gate.promise } };
  const pending = f.service.begin(caller, f.request);
  try {
    expect(await f.service.recoverAdmission(f.caller, f.request)).toEqual({
      kind: "not-admitted", reason: "transfer_unavailable",
    });
    gate.resolve("b".repeat(64));
    await expect(pending).rejects.toThrow("transfer_unavailable");
    expect(f.commands).toEqual([]);
    expect(f.store.db.query("SELECT id FROM native_transfers").all()).toEqual([]);
  } finally {
    gate.resolve("b".repeat(64));
    await pending.catch(() => {});
  }
});

test("an exhausted post-admission budget durably refuses an unsent begin across restart", async () => {
  const f = fixture();
  let remaining = 1000;
  let probes = 0;
  f.caller.guard.remainingMs = () => remaining;
  f.caller.guard.requireSource = async () => {
    if (++probes === 2) remaining = 250;
    return "b".repeat(64);
  };
  f.service.setEvidenceSink(async () => false);
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_action_unavailable");
  const id = f.store.db.query<{ id: string }, []>("SELECT id FROM native_transfers").get()!.id;
  expect(retained(f, id)).toMatchObject({
    beginDispatch: "unsent", status: { state: "refused", reason: "transfer_action_unavailable" },
  });
  expect(f.commands).toEqual([]);
  f.restart();
  const delivered: NativeTransferTerminalEvidence[] = [];
  f.service.setEvidenceSink(async (_plugin, receipts) => { delivered.push(...receipts); return true; });
  await f.service.reconcile();
  expect(await f.service.receipt(f.caller, id)).toEqual({
    transferId: id, state: "refused", reason: "transfer_action_unavailable",
  });
  expect(await f.service.cancel(f.caller, id)).toMatchObject({ state: "refused" });
  await expect(f.service.putChunk(f.caller, { transferId: id, seq: 0, offset: 0, data: new Uint8Array([1]) }))
    .rejects.toThrow("transfer_action_unavailable");
  expect(f.commands).toEqual([]);
  expect(delivered).toEqual([expect.objectContaining({ kind: "terminal", transferId: id, state: "refused" })]);
  f.service.assertPurgeable(f.caller.pluginId);
  remaining = 1000;
  expect((await f.service.begin(f.caller, { ...f.request, requestId: "new-intent" })).state).toBe("receiving");
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut"]);
});

test("coordinator reconstruction retires an unsent journal record without replaying begin", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  let probes = 0;
  f.caller.guard.requireSource = async () => {
    if (++probes !== 2) return "b".repeat(64);
    entered.resolve();
    return release.promise;
  };
  const pending = f.service.begin(f.caller, f.request);
  await entered.promise;
  const id = f.store.db.query<{ id: string }, []>("SELECT id FROM native_transfers").get()!.id;
  expect(retained(f, id)).toMatchObject({ beginDispatch: "unsent", status: { state: "queued" } });
  try {
    f.restart();
    await f.service.reconcile();
    expect(await f.service.receipt(f.caller, id)).toMatchObject({ state: "refused" });
    release.resolve("b".repeat(64));
    await expect(pending).rejects.toThrow("transfer_unavailable");
    expect((await f.service.begin(f.caller, f.request)).state).toBe("refused");
    expect(f.commands).toEqual([]);
    f.service.assertPurgeable(f.caller.pluginId);
  } finally {
    release.resolve("b".repeat(64));
    await pending.catch(() => {});
  }
});

test("unknown owner ID cannot turn a retained dispatch intent into proof of non-admission", async () => {
  const f = fixture();
  f.controls.dropBeforeBegin = true;
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("transfer_disconnected");
  const id = f.store.db.query<{ id: string }, []>("SELECT id FROM native_transfers").get()!.id;
  expect(retained(f, id).beginDispatch).toBe("intended");
  expect(f.remote.has(id)).toBe(false);
  f.restart();
  f.owner.generation++;
  f.runtime.time += 8 * 24 * 60 * 60_000;
  await f.service.reconcile();
  expect(await f.service.recoverAdmission(f.caller, f.request)).toEqual({ kind: "admitted", transferId: id });
  expect(await f.service.receipt(f.caller, id)).toMatchObject({ state: "outcome_unknown" });
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("outcome_unknown");
  expect(f.commands.filter((command) => command.request.method === "beginPut")).toHaveLength(1);
});

test("non-admission fences share the native receipt bound and retain failed delivery through aging", async () => {
  const f = fixture();
  const active = await f.service.begin(f.caller, f.request);
  f.service.setEvidenceSink(async () => false);
  await f.service.recoverAdmission(f.caller, { ...f.request, requestId: "fenced" });
  const row = f.store.db.query<{ record: string }, []>("SELECT record FROM native_admission_refusals").get()!;
  const refusal = JSON.parse(row.record);
  f.store.transaction(() => {
    for (let index = 0; index < 998; index++) {
      const request = { ...f.request, requestId: `capacity-${index}` };
      const record = { ...refusal, requestId: request.requestId,
        requestDigest: createHash("sha256").update(canonicalJobJson(request)).digest("hex") };
      f.store.db.query(
        "INSERT INTO native_admission_refusals(plugin_id,actor_id,credential_binding,request_id,record,updated_at) VALUES (?,?,?,?,?,?)",
      ).run(record.pluginId, record.actorId, record.credentialBinding, record.requestId, canonicalJobJson(record), f.runtime.now());
    }
  });
  const overflow = { ...f.request, requestId: "overflow" };
  await expect(f.service.recoverAdmission(f.caller, overflow)).rejects.toThrow("transfer_receipt_limit");
  f.service.setPendingAdmissionSource({
    owners: () => [f.caller.pluginId],
    probe: async (_id, accept) => {
      accept([pendingAdmission(f, { request: overflow })]);
      return true;
    },
  });
  await f.service.reconcilePendingAdmissions();
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("native_transfer_cleanup_unknown");
  f.runtime.time += 8 * 24 * 60 * 60_000;
  f.controls.ownerAvailable = false;
  await expect(f.service.recoverAdmission(f.caller, overflow)).rejects.toThrow("transfer_receipt_limit");
  f.service.setEvidenceSink(async () => true);
  await f.service.reconcile();
  await f.service.reconcilePendingAdmissions();
  expect(await f.service.recoverAdmission(f.caller, overflow)).toEqual({
    kind: "not-admitted", reason: "transfer_unavailable",
  });
  expect(retained(f, active.transferId).status.state).toBe("outcome_unknown");
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("outcome_unknown");
});

test("exhausted preparation budget refuses before creating or dispatching a commit decision", async () => {
  const f = fixture();
  let remaining = 1000;
  f.caller.guard.remainingMs = () => remaining;
  const started = await f.service.begin(f.caller, f.request);
  f.controls.prepared = () => {
    remaining = 250;
  };
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "transfer_action_unavailable",
  );
  expect(retained(f, started.transferId).commitDecision).toBeUndefined();
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut", "preparePut"]);
});

test("lost committed acknowledgement respects the remaining outer budget and reconciles without replay", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  let remaining = 1000;
  f.caller.guard.remainingMs = () => remaining;
  f.controls.prepared = () => {
    remaining = 300;
  };
  f.controls.silentCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  expect(retained(f, started.transferId).status.state).toBe("outcome_unknown");
  f.caller.guard.remainingMs = () => Number.POSITIVE_INFINITY;
  expect(await f.service.receipt(f.caller, started.transferId)).toEqual({
    transferId: started.transferId,
    state: "committed",
  });
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
});

for (const boundary of ["prepare", "commit"] as const) {
  test(`lifetime abort at ${boundary} preserves the publication decision boundary`, async () => {
    const f = fixture();
    const controller = new AbortController();
    const caller = { ...f.caller, guard: { ...f.caller.guard, signal: controller.signal } };
    const started = await f.service.begin(caller, f.request);
    if (boundary === "prepare") f.controls.prepared = () => controller.abort();
    else f.controls.committed = () => controller.abort();
    await expect(f.service.commitPut(caller, started.transferId)).rejects.toThrow(
      boundary === "prepare" ? "transfer_action_unavailable" : "outcome_unknown",
    );
    expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(
      boundary === "prepare" ? 0 : 1,
    );
    expect(retained(f, started.transferId).commitDecision !== undefined).toBe(
      boundary === "commit",
    );
  });
}

test("consent revoked after preparation refuses before the signed publish decision", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.prepared = () => {
    f.controls.consent = "revoked";
  };
  const context = nativeTransferContext(
    () => f.service,
    f.actor,
    f.caller.pluginId,
    f.caller.guard,
  );
  await expect(context.commitPut({ transferId: started.transferId })).rejects.toMatchObject({
    name: "NativeTransferError",
    reason: "consent_changed",
    message: "consent_changed",
  });
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut", "preparePut"]);
  const record = f.store.db
    .query<{ record: string }, [string]>("SELECT record FROM native_transfers WHERE id=?")
    .get(started.transferId)!;
  expect(JSON.parse(record.record).commitDecision).toBeUndefined();
});

test("source publication identity and declared location are checked on every continuation", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.ready = "c".repeat(64);
  await expect(f.service.status(f.caller, started.transferId)).rejects.toThrow(
    "transfer_source_changed",
  );
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut"]);
  f.controls.ready = "b".repeat(64);
  f.controls.declared = false;
  await expect(f.service.status(f.caller, started.transferId)).rejects.toThrow(
    "transfer_requirement_undeclared",
  );
});

test("lost publish acknowledgement retains unknown and reconciles without issuing a second commit", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.dropCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  const stored = f.store.db
    .query<{ record: string }, [string]>("SELECT record FROM native_transfers WHERE id=?")
    .get(started.transferId)!;
  expect(JSON.parse(stored.record).status.state).toBe("outcome_unknown");
  const status = await f.service.commitPut(f.caller, started.transferId);
  expect(status.state).toBe("committed");
  expect(status.receipt?.sha256).toBe(f.request.source.sha256);
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
});

test("plugin purge refuses active and unknown native outcomes until reconciliation", async () => {
  const f = fixture();
  class FixtureJobs extends JobService {
    override readonly nativeTransfers = f.service;
  }
  const jobs = new FixtureJobs(f.store, f.auth, f.runtime);
  const started = await f.service.begin(f.caller, f.request);
  expect(() => jobs.purgePlugin(f.caller.pluginId)).toThrow("active_native_transfers");
  f.controls.dropCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  f.store.setPluginEnabled(f.caller.pluginId, false, f.actor.principal.id, f.runtime.now());
  expect(() => jobs.purgePlugin(f.caller.pluginId)).toThrow("outcome_unknown");
  expect(retained(f, started.transferId).status.state).toBe("outcome_unknown");
  f.store.setPluginEnabled(f.caller.pluginId, true, f.actor.principal.id, f.runtime.now());
  const reconciled = await f.service.status(f.caller, started.transferId);
  expect(reconciled.state).toBe("committed");
  jobs.purgePlugin(f.caller.pluginId);
  expect(retained(f, started.transferId).status).toEqual(reconciled);
});

test("changed request and caller credential cannot reuse a retained transfer", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  await expect(
    f.service.begin(f.caller, { ...f.request, filename: "another.bin" }),
  ).rejects.toThrow("transfer_request_conflict");
  const confined = { ...f.actor, caps: ["locations:read" as const] };
  await expect(
    f.service.status({ ...f.caller, auth: confined }, started.transferId),
  ).rejects.toThrow("transfer_unavailable");
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut"]);
});

test("read bytes queued before dispatch revocation never reach the consumer", async () => {
  const f = fixture();
  const pins = nativePins(f.request);
  const started = await f.service.begin(f.caller, {
    ...pins,
    mode: "read",
    relativePath: ["source.bin"],
  });
  f.controls.readReply = () => {
    f.controls.current = false;
  };
  await expect(
    f.service.readChunk(f.caller, { transferId: started.transferId, offset: 0, maxBytes: 4 }),
  ).rejects.toThrow("transfer_action_unavailable");
});

test("old owner and replaced owner generation refuse before command delivery", async () => {
  const f = fixture();
  f.owner.protocolVersion = 43;
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("native_transfer_unsupported");
  expect(f.commands).toEqual([]);
  f.owner.protocolVersion = JOB_OWNER_PROTOCOL_VERSION;
  await expect(f.service.begin(f.caller, f.request)).rejects.toThrow("native_transfer_unsupported");
  const started = await f.service.begin(f.caller, { ...f.request, requestId: "after-upgrade" });
  f.owner.generation++;
  await expect(
    f.service.putChunk(f.caller, {
      transferId: started.transferId,
      seq: 0,
      offset: 0,
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow("owner_fenced");
});

test("concurrent source probes cannot oversubscribe per-principal reservations", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<string>();
  const caller = { ...f.caller, guard: { ...f.caller.guard, requireSource: () => gate.promise } };
  const requests = [0, 1, 2].map((index) =>
    f.service.begin(caller, {
      ...f.request,
      requestId: `concurrent-${index}`,
      filename: `file-${index}.bin`,
    }),
  );
  gate.resolve("b".repeat(64));
  const results = await Promise.allSettled(requests);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  const denied = results.find((result) => result.status === "rejected");
  expect(denied?.status === "rejected" && denied.reason.message).toBe("transfer_concurrency_limit");
  expect(
    f.store.db.query<{ count: number }, []>("SELECT count(*) AS count FROM native_transfers").get()
      ?.count,
  ).toBe(2);
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut", "beginPut"]);
});

test("elapsed admission remains charged until exact owner cleanup evidence arrives", async () => {
  const f = fixture();
  const first = await f.service.begin(f.caller, f.request);
  f.controls.dropCommit = true;
  await expect(f.service.commitPut(f.caller, first.transferId)).rejects.toThrow("outcome_unknown");
  const idle = await f.service.begin(f.caller, {
    ...f.request,
    requestId: "idle",
    filename: "idle.bin",
  });
  f.remote.get(idle.transferId)!.status = {
    ...idle,
    state: "outcome_unknown",
    reason: "native_transfer_cleanup_unknown",
  };
  const delivered: NativeTransferTerminalEvidence[] = [];
  f.service.setEvidenceSink(async (_plugin, receipts) => {
    delivered.push(...receipts);
    return true;
  });
  f.runtime.time += 16 * 60_000;
  const fresh = { ...f.request, requestId: "fresh", filename: "fresh.bin" };
  await expect(f.service.begin(f.caller, fresh)).rejects.toThrow("transfer_concurrency_limit");
  expect(await f.service.receipt(f.caller, idle.transferId)).toMatchObject({
    state: "outcome_unknown", reason: "native_transfer_cleanup_unknown",
  });
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("outcome_unknown");
  await f.service.reconcile();
  expect(delivered).not.toContainEqual(expect.objectContaining({ transferId: idle.transferId }));
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("outcome_unknown");
  f.remote.get(idle.transferId)!.status = { ...idle, state: "expired", reason: "transfer_expired" };
  await f.service.reconcile();
  expect(
    delivered.filter((value) => value.kind === "terminal" && value.transferId === idle.transferId),
  ).toEqual([
    expect.objectContaining({ kind: "terminal", transferId: idle.transferId, state: "expired" }),
  ]);
  f.service.assertPurgeable(f.caller.pluginId);
  expect((await f.service.begin(f.caller, { ...fresh, requestId: "after-cleanup" })).state).toBe("receiving");
});

test("terminal action never waits for background evidence queued behind its own owner turn", async () => {
  const f = fixture();
  const prior = await f.service.begin(f.caller, f.request);
  await f.service.commitPut(f.caller, prior.transferId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered: string[] = [];
  f.service.setEvidenceSink(async (_plugin, receipts) => {
    if (delivered.length === 0) {
      entered.resolve();
      await release.promise;
    }
    delivered.push(
      ...receipts.flatMap((receipt) => (receipt.kind === "terminal" ? [receipt.transferId] : [])),
    );
    return true;
  });
  const background = f.service.reconcile();
  await entered.promise;
  try {
    const next = await f.service.begin(f.caller, {
      ...f.request,
      requestId: "next",
      filename: "next.bin",
    });
    let result: NativeTransferStatus | undefined;
    const completion = f.service.commitPut(f.caller, next.transferId).then((status) => {
      result = status;
    });
    // This fixture dispatches through microtasks only. Drain that event-loop turn without
    // releasing the blocked callback: a completion waiting on it remains observably absent.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(result?.state).toBe("committed");
    expect(retained(f, next.transferId).status.state).toBe("committed");
    release.resolve();
    await completion;
    await background;
    await f.service.reconcile();
    expect(delivered).toEqual([prior.transferId, next.transferId]);
    f.service.assertPurgeable(f.caller.pluginId);
  } finally {
    release.resolve();
    await background;
  }
});

test("unexpected host exceptions never disclose paths as native refusals", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  const context = nativeTransferContext(() => f.service, f.actor, f.caller.pluginId, {
    ...f.caller.guard,
    assertCurrent: () => {
      throw new Error("EIO reading /private/customer-name/secrets");
    },
  });
  await expect(context.status({ transferId: started.transferId })).rejects.toMatchObject({
    name: "NativeTransferError",
    reason: "native_transfer_unavailable",
    message: "native_transfer_unavailable",
  });
  expect(f.commands.map((command) => command.request.method)).toEqual(["beginPut"]);
});

test("pre-consumption status does not erase a dispatched unknown publish decision", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.dropBeforeCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  expect((await f.service.status(f.caller, started.transferId)).state).toBe("outcome_unknown");
  expect((await f.service.commitPut(f.caller, started.transferId)).state).toBe("outcome_unknown");
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
});

test("post-publication revocation retains the receipt but discloses only uncertainty", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.committed = () => {
    f.controls.current = false;
  };
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  const stored = f.store.db
    .query<{ record: string }, [string]>("SELECT record FROM native_transfers WHERE id=?")
    .get(started.transferId)!;
  expect(JSON.parse(stored.record).status.state).toBe("committed");
  f.controls.current = true;
  expect((await f.service.commitPut(f.caller, started.transferId)).state).toBe("committed");
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
});

function retained(f: { store: ServerStore }, transferId: string) {
  const row = f.store.db
    .query<{ record: string; updated_at: number }, [string]>(
      "SELECT record,updated_at FROM native_transfers WHERE id=?",
    )
    .get(transferId)!;
  return { ...JSON.parse(row.record), updatedAt: row.updated_at };
}

const losses = [
  "consent",
  "source",
  "source identity",
  "credential revocation",
  "credential expiry",
  "owner",
  "installation",
  "dispatch",
] as const;
for (const method of ["commitPut", "status", "cancel"] as const) {
  for (const loss of losses) {
    test(`${method} privately retains evidence but discloses uncertainty after ${loss} loss`, async () => {
      const f = fixture();
      const minted = f.auth.mintToken(
        {
          principal: { name: "transfer caller", kind: "human" },
          caps: ["locations:create-child"],
        },
        f.actor,
      );
      const actor = { ...f.auth.authenticate(minted.token), expiresAt: 30_000 };
      const context = nativeTransferContext(
        () => f.service,
        actor,
        f.caller.pluginId,
        f.caller.guard,
      );
      const request = { ...nativePins(f.request), filename: f.request.filename, source: f.request.source };
      const started = await context.beginPut(request);
      f.controls.dropCommit = true;
      await expect(context.commitPut({ transferId: started.transferId })).rejects.toMatchObject({
        reason: "outcome_unknown",
      });
      const decision = retained(f, started.transferId).commitDecision;
      expect(typeof decision).toBe("string");
      switch (loss) {
        case "consent":
          f.controls.consent = "revoked";
          break;
        case "source":
          f.controls.sourceAvailable = false;
          break;
        case "source identity":
          f.controls.ready = "c".repeat(64);
          break;
        case "credential revocation":
          f.auth.revokePrincipal(actor.principal.id, f.actor);
          break;
        case "credential expiry":
          f.runtime.time = 30_000;
          break;
        case "owner":
          f.controls.ownerAvailable = false;
          break;
        case "installation":
          f.installation.enabled = false;
          break;
        case "dispatch":
          f.controls.current = false;
          break;
      }
      await expect(context[method]({ transferId: started.transferId })).rejects.toMatchObject({
        name: "NativeTransferError",
        reason: "outcome_unknown",
        message: "outcome_unknown",
      });
      expect(retained(f, started.transferId)).toMatchObject({
        commitDecision: decision,
        status: { state: loss === "owner" ? "outcome_unknown" : "committed" },
      });
      expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(
        1,
      );
    });
  }
}

for (const method of ["commitPut", "status", "cancel"] as const) {
  test(`${method} withholds queued reconciliation evidence after authority loss`, async () => {
    const f = fixture();
    const context = nativeTransferContext(
      () => f.service,
      f.actor,
      f.caller.pluginId,
      f.caller.guard,
    );
    const started = await f.service.begin(f.caller, f.request);
    f.controls.dropCommit = true;
    await expect(context.commitPut({ transferId: started.transferId })).rejects.toMatchObject({
      reason: "outcome_unknown",
    });
    f.controls.statusReply = () => {
      f.controls.consent = "revoked";
    };
    await expect(context[method]({ transferId: started.transferId })).rejects.toMatchObject({
      reason: "outcome_unknown",
      message: "outcome_unknown",
    });
    expect(retained(f, started.transferId).status).toMatchObject({
      state: "committed",
      receipt: { path: "/private/files/result.bin" },
    });
    // The receipt stays private even on a subsequent call; cancel cannot introduce a new effect.
    await expect(context[method]({ transferId: started.transferId })).rejects.toMatchObject({
      reason: "outcome_unknown",
    });
  });

  test(`${method} reveals no unknown-record oracle to a different actor, credential or plugin`, async () => {
    const f = fixture();
    const started = await f.service.begin(f.caller, f.request);
    f.controls.dropCommit = true;
    await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
      "outcome_unknown",
    );
    const other = f.auth.authenticate(
      f.auth.mintToken(
        {
          principal: { name: "another caller", kind: "human" },
          caps: ["locations:create-child"],
        },
        f.actor,
      ).token,
    );
    f.controls.current = false;
    for (const caller of [
      { ...f.caller, auth: other },
      { ...f.caller, auth: { ...f.actor, caps: ["locations:create-child" as const] } },
      { ...f.caller, pluginId: "sample.other" },
    ]) {
      const context = nativeTransferContext(
        () => f.service,
        caller.auth,
        caller.pluginId,
        caller.guard,
      );
      for (const transferId of [started.transferId, "absent-transfer"])
        await expect(context[method]({ transferId })).rejects.toMatchObject({
          name: "NativeTransferError",
          reason: "transfer_unavailable",
          message: "transfer_unavailable",
        });
    }
    expect(retained(f, started.transferId).status.state).toBe("outcome_unknown");
    expect(f.commands.map((command) => command.request.method)).toEqual([
      "beginPut",
      "preparePut",
      "commitPut",
    ]);
  });
}

for (const loss of [
  "source deletion",
  "credential expiry",
  "credential revocation",
  "consent revision",
] as const) {
  test(`private evidence survives host restart and owner reconnection after ${loss}`, async () => {
    const f = fixture();
    const minted = f.auth.mintToken(
      {
        principal: { name: "original", kind: "human" },
        caps: ["locations:create-child"],
      },
      f.actor,
    );
    const actor = { ...f.auth.authenticate(minted.token), expiresAt: 30_000 };
    const caller = { ...f.caller, auth: actor };
    const started = await f.service.begin(caller, f.request);
    f.controls.dropCommit = true;
    await expect(f.service.commitPut(caller, started.transferId)).rejects.toThrow(
      "outcome_unknown",
    );
    f.controls.ownerAvailable = false;
    if (loss === "source deletion") f.controls.sourceAvailable = false;
    if (loss === "credential expiry") f.runtime.time = 30_000;
    if (loss === "credential revocation") f.auth.revokePrincipal(actor.principal.id, f.actor);
    if (loss === "consent revision") f.controls.consent = "new-consent-revision";
    f.restart();
    const delivered: unknown[] = [];
    f.service.setEvidenceSink(async (_plugin, receipts) => {
      delivered.push(...receipts);
      return true;
    });
    await f.service.reconcile();
    expect(() => f.service.assertPurgeable(caller.pluginId)).toThrow("outcome_unknown");
    f.owner.generation++;
    f.controls.ownerAvailable = true;
    await f.service.reconcile(f.request.machineId);
    expect(retained(f, started.transferId)).toMatchObject({
      evidenceDelivered: true,
      status: { state: "committed", receipt: { ownerGeneration: 1 } },
    });
    expect(delivered).toEqual([
      {
        kind: "terminal",
        transferId: started.transferId,
        requestId: f.request.requestId,
        actorId: actor.principal.id,
        credentialBinding: f.auth.credentialBinding(actor),
        mode: "put",
        state: "committed",
      },
    ]);
    f.service.assertPurgeable(caller.pluginId);
    if (loss === "credential expiry" || loss === "credential revocation")
      await expect(f.service.receipt(caller, started.transferId)).rejects.toThrow(
        "credential_revoked_or_expired",
      );
    else
      expect(await f.service.receipt(caller, started.transferId)).toEqual({
        transferId: started.transferId,
        state: "committed",
      });
    await expect(f.service.receipt(f.caller, started.transferId)).rejects.toThrow(
      "transfer_unavailable",
    );
    await expect(f.service.status(caller, started.transferId)).rejects.toThrow("outcome_unknown");
    expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
    expect(f.commands.filter((command) => command.request.method === "evidence")).toHaveLength(1);
  });
}

test("evidence never trusts another owner or a lower generation and never expires uncertainty as success", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.dropBeforeCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  for (const owner of [
    { ...f.owner, ownerId: "replacement" },
    { ...f.owner, generation: 0 },
    { ...f.owner, publicKey: "replacement-key" },
  ]) {
    const original = { ...f.owner };
    Object.assign(f.owner, owner);
    await f.service.reconcile();
    Object.assign(f.owner, original);
  }
  expect(f.commands.filter((command) => command.request.method === "evidence")).toHaveLength(0);
  f.runtime.time = 8 * 24 * 60 * 60_000;
  await f.service.reconcile();
  expect(retained(f, started.transferId).status.state).toBe("outcome_unknown");
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("outcome_unknown");
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
  f.remote.get(started.transferId)!.status = {
    transferId: started.transferId,
    mode: "put",
    state: "outcome_unknown",
    bytes: 0,
    reason: "native_transfer_cleanup_unknown",
  };
  expect(await f.service.receipt(f.caller, started.transferId)).toEqual({
    transferId: started.transferId,
    state: "outcome_unknown",
    reason: "native_transfer_cleanup_unknown",
  });
});

test("failed product cleanup retains terminal evidence until bounded replay acknowledges reservation release", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.dropCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  let attempts = 0;
  f.service.setEvidenceSink(async () => {
    attempts++;
    throw new Error("storage_capacity");
  });
  await f.service.reconcile();
  expect(attempts).toBe(1);
  f.runtime.time = 8 * 24 * 60 * 60_000;
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow(
    "native_transfer_cleanup_unknown",
  );
  expect(retained(f, started.transferId).status.state).toBe("committed");
  f.service.setEvidenceSink(async () => {
    attempts++;
    return true;
  });
  await f.service.reconcile();
  expect(attempts).toBe(2);
  f.service.assertPurgeable(f.caller.pluginId);
  expect(f.commands.filter((command) => command.request.method === "evidence")).toHaveLength(1);
});

test("proved terminal recovery frees hub admission without permitting a second publication", async () => {
  const f = fixture();
  f.controls.dropCommit = true;
  for (let index = 0; index < 2; index++) {
    const transfer = await f.service.begin(f.caller, {
      ...f.request,
      requestId: `lost-${index}`,
      filename: `lost-${index}.bin`,
    });
    await expect(f.service.commitPut(f.caller, transfer.transferId)).rejects.toThrow(
      "outcome_unknown",
    );
  }
  const next = { ...f.request, requestId: "next", filename: "next.bin" };
  await expect(f.service.begin(f.caller, next)).rejects.toThrow("transfer_concurrency_limit");
  await f.service.reconcile();
  f.service.assertPurgeable(f.caller.pluginId);
  await expect(f.service.begin(f.caller, next)).rejects.toThrow("transfer_concurrency_limit");
  expect((await f.service.begin(f.caller, { ...next, requestId: "after-recovery" })).state).toBe("receiving");
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(2);
});

test("status and begin retries do not renew an idle reservation or its retention timestamp", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.runtime.time = 30_000;
  await f.service.status(f.caller, started.transferId);
  f.runtime.time = 59_000;
  await f.service.begin(f.caller, f.request);
  expect(retained(f, started.transferId)).toMatchObject({ touchedAt: 0, updatedAt: 0 });
  f.runtime.time = 60_000;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "transfer_expired",
  );
  await f.service.begin(f.caller, {
    ...f.request,
    requestId: "replacement",
    filename: "replacement.bin",
  });
  expect(retained(f, started.transferId).status.state).toBe("outcome_unknown");
  expect(f.commands.map((command) => command.request.method)).toEqual([
    "beginPut",
    "status",
    "status",
    "beginPut",
  ]);
});

test("accepted put bytes renew idle time but rejected and replayed chunks cannot", async () => {
  const f = fixture();
  const request = { ...f.request, source: { ...f.request.source, bytes: 4 } };
  const started = await f.service.begin(f.caller, request);
  const chunk = { transferId: started.transferId, seq: 0, offset: 0, data: new Uint8Array([1]) };
  f.runtime.time = 50_000;
  expect((await f.service.putChunk(f.caller, chunk)).bytes).toBe(1);
  f.runtime.time = 100_000;
  expect((await f.service.putChunk(f.caller, { ...chunk, seq: 1, offset: 1 })).bytes).toBe(2);
  expect(retained(f, started.transferId).touchedAt).toBe(100_000);
  f.runtime.time = 130_000;
  await f.service.putChunk(f.caller, chunk);
  f.runtime.time = 159_000;
  f.controls.rejectPut = true;
  await expect(f.service.putChunk(f.caller, { ...chunk, seq: 2, offset: 2 })).rejects.toThrow(
    "native_transfer_chunk_sequence_mismatch",
  );
  expect(retained(f, started.transferId)).toMatchObject({ touchedAt: 100_000, updatedAt: 100_000 });
  f.runtime.time = 160_000;
  f.controls.rejectPut = false;
  await expect(f.service.putChunk(f.caller, { ...chunk, seq: 2, offset: 2 })).rejects.toThrow(
    "transfer_expired",
  );
});

test("new read ranges renew idle time but replayed and invalid ranges cannot", async () => {
  const f = fixture();
  const pins = nativePins(f.request);
  const started = await f.service.begin(f.caller, {
    ...pins,
    mode: "read",
    relativePath: ["source.bin"],
  });
  const chunk = { transferId: started.transferId, offset: 0, maxBytes: 1 };
  f.runtime.time = 50_000;
  expect(Buffer.from((await f.service.readChunk(f.caller, chunk)).data).toString()).toBe("d");
  f.runtime.time = 100_000;
  expect(
    Buffer.from((await f.service.readChunk(f.caller, { ...chunk, offset: 1 })).data).toString(),
  ).toBe("a");
  expect(retained(f, started.transferId)).toMatchObject({ touchedAt: 100_000, readHighWater: 2 });
  f.runtime.time = 130_000;
  await f.service.readChunk(f.caller, chunk);
  f.runtime.time = 159_000;
  f.controls.invalidRead = true;
  await expect(f.service.readChunk(f.caller, { ...chunk, offset: 2 })).rejects.toThrow(
    "transfer_reply_invalid",
  );
  expect(retained(f, started.transferId)).toMatchObject({ touchedAt: 100_000, readHighWater: 2 });
  f.runtime.time = 160_000;
  f.controls.invalidRead = false;
  await expect(f.service.readChunk(f.caller, { ...chunk, offset: 2 })).rejects.toThrow(
    "transfer_expired",
  );
});

test("accepted progress cannot extend the absolute fifteen-minute lifetime", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, {
    ...f.request,
    source: { ...f.request.source, bytes: 20 },
  });
  for (let seq = 0; seq < 17; seq++) {
    f.runtime.time += 50_000;
    expect(
      (
        await f.service.putChunk(f.caller, {
          transferId: started.transferId,
          seq,
          offset: seq,
          data: new Uint8Array([1]),
        })
      ).bytes,
    ).toBe(seq + 1);
  }
  f.runtime.time = 900_000;
  await expect(
    f.service.putChunk(f.caller, {
      transferId: started.transferId,
      seq: 17,
      offset: 17,
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow("transfer_expired");
});

async function readActionFixture(options: {
  lateJobs?: boolean;
  beforeBegin?: (ctx: ActionCtx, request: NativeTransferPendingAdmission["request"]) => Promise<void>;
  pending?: ServerPluginDef["pendingNativeTransfers"];
  reconcile?: ServerPluginDef["reconcileNativeTransfers"];
} = {}) {
  const f = fixture({ decide: (request) => jobs.decide(request) });
  const importCap = "sample.transfer:import";
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const delivered: string[] = [];
  const pins = nativePins(f.request);
  const plugin: ServerPluginDef = {
    manifest: {
      id: f.caller.pluginId,
      version: "1.0.0",
      title: "Transfer authority fixture",
      description: "",
      capabilities: [importCap, "locations:read"],
      machine: f.installation.machine,
      contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    },
    actions: [
      defineAction({
        name: "read",
        title: "Read",
        caps: [importCap, "locations:read"],
        requirements: [
          { cap: importCap, target: ["source"] },
          { cap: "locations:read", target: ["location"] },
        ],
        input: z.strictObject({ source: ManifoldRefSchema, location: ManifoldRefSchema }),
        result: z.strictObject({ text: z.string() }),
      }),
    ],
    ...(options.pending ? { pendingNativeTransfers: options.pending } : {}),
    ...(options.reconcile ? { reconcileNativeTransfers: options.reconcile } : {}),
    handlers: {
      read: async (ctx) => {
        await options.beforeBegin?.(ctx, { ...pins, mode: "read", relativePath: ["source.bin"] });
        const transfer = await ctx.nativeTransfers.beginRead({
          ...pins,
          relativePath: ["source.bin"],
        });
        started.resolve();
        await resume.promise;
        const chunk = await ctx.nativeTransfers.readChunk({
          transferId: transfer.transferId,
          offset: 0,
          maxBytes: 4,
        });
        const text = Buffer.from(chunk.data).toString();
        delivered.push(text);
        return { text };
      },
    },
  };
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
    settingsPlugins: [plugin],
  });
  hosts.push(host);
  // Exercise the actual host guard and coordinator, with only the private owner channel simulated.
  class FixtureJobs extends JobService {
    override readonly nativeTransfers = f.service;
  }
  const jobs: JobService = new FixtureJobs(f.store, f.auth, f.runtime);
  if (!options.lateJobs) host.setJobs(jobs);
  else jobs.setManifestResolver((pluginId) => pluginId === plugin.manifest.id ? plugin.manifest.machine ?? null : null);
  const commands: JobCommand[] = [];
  const channel = {
    machineId: f.request.machineId,
    protocolVersion: MACHINE_NATIVE_TRANSFERS_PROTOCOL_VERSION,
    send: (message: { type: "job_command"; command: JobCommand }) => {
      commands.push(message.command);
      return true;
    },
  };
  jobs.online(channel, f.owner, "fixture-epoch");
  const challenge = commands.at(-1);
  if (challenge?.type !== "owner_challenge") throw new Error("owner challenge missing");
  const body = {
    nonce: challenge.nonce,
    serverEpoch: challenge.serverEpoch,
    machineId: channel.machineId,
    owner: f.owner,
  };
  jobs.event(channel, {
    type: "owner_proof",
    ...body,
    signature: sign(null, Buffer.from(canonicalJobJson(body)), f.keys.privateKey).toString(
      "base64",
    ),
  });
  jobs.install(f.actor, {
    machineId: f.request.machineId,
    pluginId: f.caller.pluginId,
    installationRevision: f.installation.revision,
    artifactSha256: f.installation.artifact,
    machine: f.installation.machine,
  });
  const location = {
    kind: "location" as const,
    machineId: f.request.machineId,
    locationId: f.request.locationId,
  };
  jobs.consent(f.actor, {
    machineId: f.request.machineId,
    pluginId: f.caller.pluginId,
    installationRevision: f.installation.revision,
    artifactSha256: f.installation.artifact,
    node: formatManifoldUri(location),
    cap: "locations:read",
    enabled: true,
  });
  jobs.event(channel, {
    type: "installed",
    pluginId: f.caller.pluginId,
    installationRevision: f.installation.revision,
    artifactSha256: f.installation.artifact,
  });
  const actor = f.auth.authenticate(
    f.auth.mintToken(
      {
        principal: { name: "importer", kind: "human" },
        caps: ["locations:read"],
      },
      f.actor,
    ).token,
  );
  const source = { kind: "machine" as const, machineId: f.request.machineId };
  const grant = f.auth.grant(
    {
      principal: { kind: "principal", id: actor.principal.id },
      node: formatManifoldUri(source),
      caps: [importCap],
      effect: "allow",
      reach: "node",
    },
    f.actor,
  );
  const revoke = () => {
    expect(f.auth.revokeGrant(grant.id, f.actor)).toBe(1);
    expect(f.auth.allowsRef(actor, "locations:read", location)).toBe(true);
    expect(f.auth.allowsRef(actor, importCap, source)).toBe(false);
  };
  return {
    ...f,
    started,
    resume,
    delivered,
    revoke,
    registerJobs: () => host.setJobs(jobs),
    tick: () => jobs.tick(),
    nativeActor: actor,
    readRequest: { ...pins, mode: "read" as const, relativePath: ["source.bin"] },
    dispatch: () => host.dispatch(actor, "sample.transfer.read", { source, location }),
  };
}

for (const abandoned of [false, true]) {
  test(`startup pending probe waits for an active reservation and ${abandoned ? "retries its abandoned row without another caller" : "preserves its eventual admission"}`, async () => {
    const reserved = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const reclaimed = Promise.withResolvers<void>();
    let pending: NativeTransferPendingAdmission[] = [];
    const evidence: NativeTransferTerminalEvidence[] = [];
    const f = await readActionFixture({
      lateJobs: true,
      beforeBegin: async (ctx, request) => {
        pending.push({ actorId: ctx.auth.principal.id, credentialBinding: ctx.credentialBinding,
          request, createdAt: ctx.now() });
        reserved.resolve();
        await proceed.promise;
        if (abandoned) throw new Error("reservation abandoned before host admission");
      },
      pending: async () => pending,
      reconcile: async (_ctx, receipts) => {
        evidence.push(...receipts);
        pending = pending.filter((entry) => !receipts.some((receipt) =>
          receipt.actorId === entry.actorId && receipt.credentialBinding === entry.credentialBinding &&
          receipt.requestId === entry.request.requestId));
        if (!pending.length) reclaimed.resolve();
      },
    });
    const action = f.dispatch();
    const outcome = action.catch((error: unknown) => error);
    await reserved.promise;
    f.registerJobs();
    await f.service.reconcilePendingAdmissions();
    expect(pending).toHaveLength(1);
    expect(evidence).toEqual([]);
    expect(f.store.db.query("SELECT record FROM native_admission_refusals").all()).toEqual([]);
    proceed.resolve();
    if (abandoned) {
      expect(await outcome).toBeInstanceOf(Error);
      await reclaimed.promise;
      await f.service.reconcilePendingAdmissions();
      expect(pending).toEqual([]);
      expect(evidence).toEqual([expect.objectContaining({
        kind: "admission-refused", mode: "read", reason: "transfer_unavailable",
      })]);
      f.service.assertPurgeable(f.caller.pluginId);
      expect(f.commands).toEqual([]);
    } else {
      await f.started.promise;
      f.resume.resolve();
      expect(await outcome).toEqual({ ok: true, result: { text: "data" } });
      await f.service.reconcilePendingAdmissions();
      expect(evidence).toEqual([]);
      expect(pending).toHaveLength(1);
      expect(f.commands.map((command) => command.request.method)).toEqual(["beginRead", "readChunk"]);
      expect(f.store.db.query("SELECT record FROM native_admission_refusals").all()).toEqual([]);
    }
  });
}

test("existing job maintenance retries unavailable pending owners and failed ACKs without another actor", async () => {
  let unavailable = true;
  let acknowledge = false;
  let pending: NativeTransferPendingAdmission[] = [];
  const attempted = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  const f = await readActionFixture({
    beforeBegin: async (ctx, request) => {
      pending = [{ actorId: ctx.auth.principal.id, credentialBinding: ctx.credentialBinding,
        request, createdAt: ctx.now() }];
      throw new Error("reservation abandoned");
    },
    pending: async () => {
      if (unavailable) throw new Error("private owner temporarily unavailable");
      return pending;
    },
    reconcile: async (_ctx, receipts) => {
      attempted.resolve();
      if (!acknowledge) throw new Error("private ACK temporarily unavailable");
      pending = pending.filter((entry) => !receipts.some((receipt) =>
        receipt.actorId === entry.actorId && receipt.credentialBinding === entry.credentialBinding &&
        receipt.requestId === entry.request.requestId));
      retired.resolve();
    },
  });
  await expect(f.dispatch()).rejects.toThrow("reservation abandoned");
  f.auth.revokePrincipal(f.nativeActor.principal.id, f.actor);
  f.controls.ownerAvailable = false;
  await f.service.reconcilePendingAdmissions();
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("native_transfer_cleanup_unknown");
  unavailable = false;
  f.tick();
  await attempted.promise;
  // Drain the failed ACK before simulating the next production maintenance tick.
  await f.service.reconcilePendingAdmissions();
  expect(pending).toHaveLength(1);
  expect(() => f.service.assertPurgeable(f.caller.pluginId)).toThrow("native_transfer_cleanup_unknown");
  acknowledge = true;
  f.tick();
  await retired.promise;
  await f.service.reconcilePendingAdmissions();
  expect(pending).toEqual([]);
  f.service.assertPurgeable(f.caller.pluginId);
  expect(f.commands).toEqual([]);
});

test("an idle pending snapshot excludes a new action until its metadata fence commits", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  let actionEntered = false;
  let snapshot: NativeTransferPendingAdmission[] = [];
  const f = await readActionFixture({
    pending: async () => {
      if (hold) {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    },
    reconcile: async () => {},
    beforeBegin: async () => { actionEntered = true; },
  });
  // Drain startup/owner/consent passes before deliberately suspending a fresh idle snapshot.
  await f.service.reconcilePendingAdmissions();
  snapshot = [pendingAdmission(f, {
    actorId: f.nativeActor.principal.id,
    credentialBinding: f.auth.credentialBinding(f.nativeActor),
    request: f.readRequest,
  })];
  hold = true;
  const probe = f.service.reconcilePendingAdmissions();
  await entered.promise;
  const action = f.dispatch();
  await Promise.resolve();
  expect(actionEntered).toBe(false);
  expect(f.commands).toEqual([]);
  hold = false;
  release.resolve();
  await probe;
  expect((await action).ok).toBe(false);
  await f.service.reconcile();
  f.service.assertPurgeable(f.caller.pluginId);
  expect(actionEntered).toBe(true);
  expect(f.commands).toEqual([]);
});

for (const queued of [false, true]) {
  test(`host rechecks a revoked non-location action requirement ${queued ? "before queued read disclosure" : "after a suspended read"}`, async () => {
    const f = await readActionFixture();
    const outcome = f.dispatch();
    await Promise.race([
      f.started.promise,
      outcome.then(() => {
        throw new Error("read never suspended");
      }),
    ]);
    if (queued) f.controls.readReply = f.revoke;
    else f.revoke();
    f.resume.resolve();
    expect(await outcome).toEqual({
      ok: false,
      denial: { rule: "refused", message: "transfer_authority_refused" },
    });
    expect(f.delivered).toEqual([]);
    expect(f.commands.map((command) => command.request.method)).toEqual(
      queued ? ["beginRead", "readChunk"] : ["beginRead"],
    );
  });
}

test("observation-only polling cannot retain terminal receipts beyond seven days", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  expect((await f.service.commitPut(f.caller, started.transferId)).state).toBe("committed");
  f.runtime.time = 7 * 24 * 60 * 60_000 - 1;
  expect((await f.service.status(f.caller, started.transferId)).state).toBe("committed");
  expect(retained(f, started.transferId).updatedAt).toBe(0);
  f.runtime.time += 2;
  await f.service.begin(f.caller, { ...f.request, requestId: "fresh", filename: "fresh.bin" });
  await expect(f.service.status(f.caller, started.transferId)).rejects.toThrow(
    "transfer_unavailable",
  );
});

test("reconciliation can record terminal evidence but never renew progress or permit new effects", async () => {
  const f = fixture();
  const started = await f.service.begin(f.caller, f.request);
  f.controls.dropCommit = true;
  await expect(f.service.commitPut(f.caller, started.transferId)).rejects.toThrow(
    "outcome_unknown",
  );
  f.runtime.time = 50_000;
  await expect(
    f.service.putChunk(f.caller, {
      transferId: started.transferId,
      seq: 0,
      offset: 0,
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow("outcome_unknown");
  expect((await f.service.cancel(f.caller, started.transferId)).state).toBe("committed");
  expect(retained(f, started.transferId)).toMatchObject({ touchedAt: 0, updatedAt: 50_000 });
  expect(f.commands.filter((command) => command.request.method === "commitPut")).toHaveLength(1);
  expect(f.commands.some((command) => command.request.method === "putChunk")).toBe(false);
});
