import { describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJobJson,
  canonicalNativeTransferPolicy,
  JobCommandSchema,
  MachineHalfSchema,
  NativeTransferResultSchema,
  NATIVE_TRANSFER_MAX_FILE_BYTES,
  type JobCommand,
  type JobEvent,
  type NativeTransferBinding,
  type NativeTransferRequest,
  type NativeTransferResult,
} from "@manifold/protocol";
import { HeldDirectory, fileIdentity } from "../src/job-files.ts";
import { JobJournal, jobDigest, verifyJobJournal } from "../src/job-journal.ts";
import { DirectoryExclusions, resolveManagedTransferRoot } from "../src/job-locations.ts";
import { JobOutputStore } from "../src/job-outputs.ts";
import {
  NativeTransferOwner,
  validateNativeTransferInstallation,
} from "../src/native-transfers.ts";
import { FrameWriter } from "../src/ipc-framing.ts";
import { MachineJobOwner } from "../src/job-owner.ts";
import * as nativeRuntime from "../src/job-linux.ts";
import * as snapshots from "../src/native-transfer-snapshot.ts";

type TransferCommand = Extract<JobCommand, { type: "native_transfer" }>;
type PutBinding = Extract<NativeTransferRequest, { method: "beginPut" }>["binding"];
type ReadBinding = Extract<NativeTransferRequest, { method: "beginRead" }>["binding"];
const supported =
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");
const hash = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "native-transfer-"));
  const root = HeldDirectory.openAbsolute(path, { private: true });
  const control = root.openChild("control", { create: true });
  const managedState = control.openChild("locations", { create: true });
  const sources = root.openChild("sources", { create: true });
  const documents = sources.openChild("documents", { create: true });
  const outputRoot = control.openChild("outputs", { create: true });
  const outputs = JobOutputStore.open(outputRoot);
  const keys = generateKeyPairSync("ed25519");
  const machine = MachineHalfSchema.parse({
    artifacts: {},
    operations: {},
    locations: {
      "fixture.files.destination": {
        anchor: "state",
        components: ["destination"],
        revision: "one",
        kind: "directory",
        managed: true,
      },
      "fixture.files.source": {
        anchor: "data",
        components: ["documents"],
        revision: "one",
        kind: "directory",
      },
    },
    transferPolicy: {
      format: "native-transfer-v1",
      locations: {
        "fixture.files.destination": ["create-child", "read"],
        "fixture.files.source": ["read"],
      },
    },
  });
  const install: Extract<JobCommand, { type: "install" }> = {
    type: "install",
    pluginId: "fixture.files",
    installationRevision: "install-one",
    machine,
    artifactSha256: hash(canonicalNativeTransferPolicy(machine)),
    resourceBindings: { anchors: { data: "a".repeat(64) }, tools: {}, services: {} },
  };
  let enabled = true;
  let anchorDigest = "a".repeat(64);
  let seat = new AbortController();
  let seatNonce = randomUUID();
  let journal = new JobJournal(control.openChild("journal", { create: true }), {
    segmentRecords: 5,
  });
  journal.append({ kind: "install", command: install });
  const makeOwner = () =>
    new NativeTransferOwner({
      machineId: "machine",
      journal,
      admissionKey: keys.publicKey,
      managedState,
      anchors: { data: sources },
      exclusions: new DirectoryExclusions([control]),
      outputs,
      installation: (pluginId, revision) =>
        pluginId === install.pluginId && revision === install.installationRevision
          ? { command: install, enabled }
          : undefined,
      anchorDigest: () => anchorDigest,
      seat: () => seat.signal,
      draining: () => false,
      seatNonce: () => seatNonce,
      assertRootAvailable: (fd) => outputs.assertCreateAllowed(fd),
    });
  let owner = makeOwner();
  function binding(mode: "put", data?: Buffer, actorId?: string): PutBinding;
  function binding(mode: "read", data?: Buffer, actorId?: string): ReadBinding;
  function binding(
    mode: "put" | "read",
    data: Buffer = Buffer.from("native bytes"),
    actorId = "actor",
  ): NativeTransferBinding {
    const now = Date.now();
    const pins = {
      requestId: randomUUID(),
      machineId: "machine",
      installationRevision: install.installationRevision,
      artifactSha256: install.artifactSha256,
      locationRevision: "one",
    };
    return {
      transferId: randomUUID(),
      pluginId: install.pluginId,
      actorId,
      credentialBinding: "b".repeat(64),
      createdAt: now,
      expiresAt: now + 15 * 60_000,
      request:
        mode === "put"
          ? {
              ...pins,
              mode,
              locationId: "fixture.files.destination",
              filename: "delivered.bin",
              source: {
                ref: { kind: "plugin", pluginId: "fixture.files" },
                sha256: hash(data),
                bytes: data.length,
              },
            }
          : { ...pins, mode, locationId: "fixture.files.source", relativePath: ["source.bin"] },
    };
  }
  function command(
    request: NativeTransferRequest,
    identity: NativeTransferBinding,
    nonce = seatNonce,
  ): TransferCommand {
    const issuedAt = Date.now();
    const body = {
      permitId: randomUUID(),
      commandDigest: jobDigest(request),
      transferId: identity.transferId,
      pluginId: identity.pluginId,
      actorId: identity.actorId,
      credentialBinding: identity.credentialBinding,
      machineId: "machine",
      ownerId: journal.ownerId,
      ownerGeneration: journal.generation,
      seatNonce: nonce,
      issuedAt,
      expiresAt: issuedAt + 5000,
    };
    return {
      type: "native_transfer",
      rpcId: randomUUID(),
      request,
      permit: {
        body,
        signature: sign(null, Buffer.from(canonicalJobJson(body)), keys.privateKey).toString(
          "base64",
        ),
      },
    };
  }
  async function call(
    identity: NativeTransferBinding,
    request: NativeTransferRequest,
  ): Promise<NativeTransferResult> {
    const parsed = JobCommandSchema.parse(command(request, identity));
    if (parsed.type !== "native_transfer") throw new Error("unexpected_command");
    return NativeTransferResultSchema.parse(await owner.execute(parsed));
  }
  async function prepare(identity: PutBinding, bytes: Buffer) {
    expect((await call(identity, { method: "beginPut", binding: identity })).ok).toBe(true);
    if (bytes.length)
      expect(
        (
          await call(identity, {
            method: "putChunk",
            transferId: identity.transferId,
            seq: 0,
            offset: 0,
            data: bytes.toString("base64"),
          })
        ).ok,
      ).toBe(true);
    const result = await call(identity, { method: "preparePut", transferId: identity.transferId });
    expect(result).toMatchObject({
      ok: true,
      status: { state: "verifying", sha256: hash(bytes), bytes: bytes.length },
    });
  }
  return {
    path,
    root,
    control,
    managedState,
    documents,
    sources,
    outputs,
    install,
    binding,
    command,
    call,
    prepare,
    admissionPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    get owner() {
      return owner;
    },
    get journal() {
      return journal;
    },
    challenge() {
      seatNonce = randomUUID();
      return seatNonce;
    },
    disable() {
      enabled = false;
      owner.invalidate(install.pluginId);
    },
    changeAnchor() {
      anchorDigest = "c".repeat(64);
    },
    changeSeat() {
      seat.abort();
      owner.invalidate();
      seat = new AbortController();
    },
    reopen() {
      owner.close();
      journal.close();
      journal = new JobJournal(control.openChild("journal"), { segmentRecords: 5 });
      owner = makeOwner();
      owner.recover();
    },
    close() {
      owner.close();
      journal.close();
      outputs.close();
      for (const held of [outputRoot, documents, sources, managedState, control, root])
        held.close();
      rmSync(path, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!supported)("native owner transfer boundaries", () => {
  test("exclusive publication records actual pins and survives checkpoint/restart without replay", async () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("exact delivered contents");
      const identity = f.binding("put", bytes);
      await f.prepare(identity, bytes);
      const destination = join(
        f.path,
        "control",
        "locations",
        "fixture.files",
        "destination",
        "delivered.bin",
      );
      expect(existsSync(destination)).toBe(false);
      const reply = await f.call(identity, {
        method: "commitPut",
        transferId: identity.transferId,
      });
      expect(reply).toMatchObject({
        ok: true,
        status: {
          state: "committed",
          bytes: bytes.length,
          sha256: hash(bytes),
          receipt: {
            requestId: identity.request.requestId,
            installationRevision: "install-one",
            locationRevision: "one",
            ownerId: f.journal.ownerId,
            ownerGeneration: f.journal.generation,
            path: destination,
          },
        },
      });
      expect(readFileSync(destination)).toEqual(bytes);
      const generation = f.journal.generation;
      f.reopen();
      const status = await f.call(identity, { method: "status", transferId: identity.transferId });
      expect(status).toMatchObject({
        ok: true,
        status: { state: "committed", receipt: { ownerGeneration: generation } },
      });
      expect(f.journal.generation).toBe(generation + 1);
      const directory = f.control.openChild("journal");
      try {
        expect(verifyJobJournal(directory).lastSequence).toBeGreaterThan(5);
      } finally {
        directory.close();
      }
    } finally {
      f.close();
    }
  });

  test("private evidence reads the original journal across disable, reconnect and restart without reopening the copy", async () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("independent delivered copy");
      const identity = f.binding("put", bytes);
      await f.prepare(identity, bytes);
      const committed = await f.call(identity, {
        method: "commitPut",
        transferId: identity.transferId,
      });
      const generation = f.journal.generation;
      const evidence = {
        method: "evidence" as const,
        transferId: identity.transferId,
        bindingDigest: jobDigest(identity),
        ownerGeneration: generation,
      };
      f.disable();
      f.changeSeat();
      f.challenge();
      f.reopen();
      // Removing installation authority cannot erase a journaled publication, nor may a
      // status-only observation need to reopen a caller-selected destination.
      f.install.installationRevision = "replaced-installation";
      const recovered = await f.call(identity, evidence);
      expect(recovered).toEqual(committed);
      const signed = f.command(evidence, identity);
      expect(f.owner.deliveryRefusal(signed, new AbortController().signal)).toBe(
        "native_transfer_seat_changed",
      );
      expect(await f.call(identity, { ...evidence, bindingDigest: "0".repeat(64) })).toEqual({
        ok: false,
        reason: "native_transfer_identity_changed",
      });
      expect(await f.call(identity, { ...evidence, ownerGeneration: generation + 1 })).toEqual({
        ok: false,
        reason: "native_transfer_identity_changed",
      });
      expect(await f.call(identity, { method: "status", transferId: identity.transferId })).toEqual(
        { ok: false, reason: "native_transfer_installation_changed" },
      );
      expect(f.journal.nativeTransfer(identity.transferId)?.reservedBytes).toBe(0);
      expect(f.owner.hasUnknown(identity.pluginId)).toBe(false);
      expect(
        readFileSync(
          join(f.path, "control", "locations", "fixture.files", "destination", "delivered.bin"),
        ),
      ).toEqual(bytes);
    } finally {
      f.close();
    }
  });

  test("short chunks have explicit offsets and durable bounded idempotent retry receipts", async () => {
    const f = fixture();
    try {
      const identity = f.binding("put", Buffer.from("abcdef"));
      await f.call(identity, { method: "beginPut", binding: identity });
      const first = {
        method: "putChunk" as const,
        transferId: identity.transferId,
        seq: 0,
        offset: 0,
        data: Buffer.from("ab").toString("base64"),
      };
      expect(await f.call(identity, first)).toMatchObject({ ok: true, status: { bytes: 2 } });
      expect(await f.call(identity, first)).toMatchObject({ ok: true, status: { bytes: 2 } });
      expect(await f.call(identity, { ...first, offset: 1 })).toMatchObject({
        ok: false,
        reason: "native_transfer_chunk_sequence_mismatch",
      });
      expect(
        await f.call(identity, { ...first, data: Buffer.from("zz").toString("base64") }),
      ).toMatchObject({ ok: false, reason: "native_transfer_chunk_sequence_mismatch" });
      expect(
        await f.call(identity, {
          ...first,
          seq: 1,
          offset: 2,
          data: Buffer.from("cdef").toString("base64"),
        }),
      ).toMatchObject({ ok: true, status: { bytes: 6 } });
      expect(
        await f.call(identity, { method: "preparePut", transferId: identity.transferId }),
      ).toMatchObject({ ok: true, status: { state: "verifying", sha256: hash("abcdef") } });
      expect(f.journal.nativeTransfer(identity.transferId)?.chunks).toEqual([
        { seq: 0, offset: 0, bytes: 2, sha256: hash("ab") },
        { seq: 1, offset: 2, bytes: 4, sha256: hash("cdef") },
      ]);
    } finally {
      f.close();
    }
  });

  test("collision never overwrites even identical bytes and failed verification cannot publish", async () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("retained existing bytes");
      const identity = f.binding("put", bytes);
      await f.prepare(identity, bytes);
      const destination = join(
        f.path,
        "control",
        "locations",
        "fixture.files",
        "destination",
        "delivered.bin",
      );
      writeFileSync(destination, bytes, { mode: 0o600 });
      const fd = openSync(destination, constants.O_RDONLY);
      const original = fileIdentity(fd);
      closeSync(fd);
      expect(
        await f.call(identity, { method: "commitPut", transferId: identity.transferId }),
      ).toMatchObject({ ok: true, status: { state: "refused", reason: "destination_exists" } });
      const retained = openSync(destination, constants.O_RDONLY);
      try {
        expect(fileIdentity(retained)).toBe(original);
      } finally {
        closeSync(retained);
      }
      expect(readFileSync(destination)).toEqual(bytes);
      const mismatch = f.binding("put", Buffer.from("right"));
      await f.call(mismatch, { method: "beginPut", binding: mismatch });
      await f.call(mismatch, {
        method: "putChunk",
        transferId: mismatch.transferId,
        seq: 0,
        offset: 0,
        data: Buffer.from("wrong").toString("base64"),
      });
      expect(
        await f.call(mismatch, { method: "preparePut", transferId: mismatch.transferId }),
      ).toMatchObject({
        ok: false,
        reason: "native_transfer_hash_mismatch",
        status: { state: "failed" },
      });
      expect(
        await f.call(mismatch, { method: "commitPut", transferId: mismatch.transferId }),
      ).toMatchObject({ ok: false, reason: "native_transfer_not_active" });
    } finally {
      f.close();
    }
  });

  test("every continuation authenticates complete request, credential, generation, expiry and seat", async () => {
    const f = fixture();
    try {
      const identity = f.binding("put");
      await f.call(identity, { method: "beginPut", binding: identity });
      const request = { method: "status" as const, transferId: identity.transferId };
      const signed = f.command(request, identity);
      expect(
        await f.owner.execute({
          ...signed,
          request: { method: "cancel", transferId: identity.transferId },
        }),
      ).toEqual({ ok: false, reason: "native_transfer_permit_binding_mismatch" });
      const stranger = { ...identity, credentialBinding: "d".repeat(64) };
      expect(await f.owner.execute(f.command(request, stranger))).toEqual({
        ok: false,
        reason: "native_transfer_permit_binding_mismatch",
      });
      expect(
        await f.owner.execute({
          ...signed,
          permit: { ...signed.permit, signature: Buffer.alloc(64).toString("base64") },
        }),
      ).toEqual({ ok: false, reason: "native_transfer_permit_invalid" });
      expect(
        await f.owner.execute({
          ...signed,
          permit: {
            ...signed.permit,
            body: {
              ...signed.permit.body,
              ownerGeneration: signed.permit.body.ownerGeneration + 1,
            },
          },
        }),
      ).toEqual({ ok: false, reason: "native_transfer_permit_binding_mismatch" });
      expect(
        await f.owner.execute({
          ...signed,
          permit: { ...signed.permit, body: { ...signed.permit.body, issuedAt: 1, expiresAt: 2 } },
        }),
      ).toEqual({ ok: false, reason: "native_transfer_permit_expired" });
      f.changeSeat();
      expect(await f.call(identity, request)).toMatchObject({
        ok: true,
        status: { state: "cancelled" },
      });
      f.disable();
      expect(await f.call(identity, request)).toEqual({
        ok: false,
        reason: "native_transfer_installation_changed",
      });
    } finally {
      f.close();
    }
  });

  test("a still-valid commit permit cannot cross a fresh proved seat nonce", async () => {
    const f = fixture();
    try {
      const bytes = Buffer.from("not published after reconnect");
      const identity = f.binding("put", bytes);
      await f.prepare(identity, bytes);
      const old = f.command({ method: "commitPut", transferId: identity.transferId }, identity);
      f.challenge();
      expect(await f.owner.execute(old)).toEqual({
        ok: false,
        reason: "native_transfer_seat_changed",
      });
      expect(
        existsSync(
          join(f.path, "control", "locations", "fixture.files", "destination", "delivered.bin"),
        ),
      ).toBe(false);
      expect(
        await f.call(identity, { method: "status", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "verifying" },
      });
    } finally {
      f.close();
    }
  });

  test("owner challenge and detach fence an old uncommitted publication permit", async () => {
    const f = fixture();
    const cache = f.control.openChild("cache", { create: true });
    const recovery = spyOn(nativeRuntime, "recoverLinuxJobs").mockResolvedValue(undefined);
    let owner: MachineJobOwner | undefined;
    try {
      owner = await MachineJobOwner.open({
        machineId: "machine",
        admissionPublicKey: f.admissionPublicKey,
        journal: f.journal,
        cache,
        managedState: f.managedState,
        outputs: f.outputs,
        delegatedCgroup: f.control,
        bubblewrapFd: -1,
        anchors: { data: f.sources },
        runtimeTools: {},
        protectedDirectories: [f.control],
        artifactAuthority: { origins: [], maxRedirects: 0, timeoutMs: 1000 },
      });
      const events: JobEvent[] = [];
      let detach = owner.attach((event) => {
        events.push(event);
        return true;
      });
      const nonce = randomUUID();
      await owner.execute({
        type: "owner_challenge",
        machineId: "machine",
        admissionPublicKey: f.admissionPublicKey,
        serverEpoch: "epoch-one",
        nonce,
      });
      await owner.execute(f.install);
      const bytes = Buffer.from("never delivered after a new owner seat");
      const identity = f.binding("put", bytes);
      for (const request of [
        { method: "beginPut", binding: identity },
        {
          method: "putChunk",
          transferId: identity.transferId,
          seq: 0,
          offset: 0,
          data: bytes.toString("base64"),
        },
        { method: "preparePut", transferId: identity.transferId },
      ] satisfies NativeTransferRequest[])
        await owner.execute(f.command(request, identity, nonce));
      expect(events.at(-1)).toMatchObject({
        type: "native_transfer_result",
        result: { ok: true, status: { state: "verifying" } },
      });
      const old = f.command(
        { method: "commitPut", transferId: identity.transferId },
        identity,
        nonce,
      );
      detach();
      detach = owner.attach((event) => {
        events.push(event);
        return true;
      });
      await owner.execute({
        type: "owner_challenge",
        machineId: "machine",
        admissionPublicKey: f.admissionPublicKey,
        serverEpoch: "epoch-two",
        nonce: randomUUID(),
      });
      await owner.execute(old);
      expect(events.at(-1)).toMatchObject({
        type: "native_transfer_result",
        rpcId: old.rpcId,
        result: { ok: false, reason: "native_transfer_seat_changed" },
      });
      expect(
        existsSync(
          join(f.path, "control", "locations", "fixture.files", "destination", "delivered.bin"),
        ),
      ).toBe(false);
      expect(cache.names()).toEqual([]);
      detach();
    } finally {
      recovery.mockRestore();
      await owner?.shutdown();
      cache.close();
      f.close();
    }
  });

  test("create-child refuses broad roots, writer aliases and root replacement", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    try {
      const declaration = f.install.machine.locations["fixture.files.destination"]!;
      expect(() =>
        resolveManagedTransferRoot(
          f.managedState,
          "fixture.files",
          { ...declaration, managed: undefined },
          () => {},
        ),
      ).toThrow("invalid_transfer_location");
      release = f.outputs.retainWriter(f.managedState.fd);
      const refused = f.binding("put");
      expect((await f.call(refused, { method: "beginPut", binding: refused })).ok).toBe(false);
      release();
      release = undefined;
      const identity = f.binding("put");
      await f.call(identity, { method: "beginPut", binding: identity });
      const parent = f.managedState.openChild("fixture.files");
      const held = parent.openChild("destination");
      try {
        expect(() => f.owner.assertLocationAvailable(held.fd)).toThrow(
          "native_transfer_location_busy",
        );
        renameSync(`${parent.procPath}/destination`, `${parent.procPath}/old-destination`);
        const replacement = parent.openChild("destination", { create: true });
        replacement.close();
        expect(
          await f.call(identity, {
            method: "putChunk",
            transferId: identity.transferId,
            seq: 0,
            offset: 0,
            data: Buffer.from("x").toString("base64"),
          }),
        ).toMatchObject({ ok: false, reason: "native_transfer_root_changed" });
        expect(existsSync(`${parent.procPath}/destination/delivered.bin`)).toBe(false);
      } finally {
        held.close();
        parent.close();
      }
    } finally {
      release?.();
      f.close();
    }
  });

  test("ordinary Linux read snapshots are immutable and a writable source fd refuses honestly", async () => {
    const f = fixture();
    try {
      const original = Buffer.alloc(600_000, 0x41);
      writeFileSync(`${f.documents.procPath}/source.bin`, original, { mode: 0o600 });
      const writer = f.documents.openFile("source.bin", constants.O_RDWR);
      try {
        const identity = f.binding("read");
        expect(await f.call(identity, { method: "beginRead", binding: identity })).toMatchObject({
          ok: false,
          reason: "native_source_writer_active",
          status: { state: "refused" },
        });
      } finally {
        closeSync(writer);
      }
      const identity = f.binding("read");
      expect(await f.call(identity, { method: "beginRead", binding: identity })).toMatchObject({
        ok: true,
        status: { state: "ready", bytes: original.length, sha256: hash(original) },
      });
      writeFileSync(`${f.documents.procPath}/source.bin`, "changed after snapshot");
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < original.length; offset += 256 * 1024) {
        const reply = await f.call(identity, {
          method: "readChunk",
          transferId: identity.transferId,
          offset,
          maxBytes: 256 * 1024,
        });
        if (!reply.ok || reply.data === undefined) throw new Error("read_refused");
        chunks.push(Buffer.from(reply.data, "base64"));
        expect(reply.offset).toBe(offset);
        expect(reply.eof).toBe(offset + chunks.at(-1)!.length === original.length);
      }
      expect(Buffer.concat(chunks)).toEqual(original);
      expect(
        await f.call(identity, { method: "cancel", transferId: identity.transferId }),
      ).toMatchObject({ ok: true, status: { state: "cancelled", receipt: undefined } });
      expect(
        await f.call(identity, {
          method: "readChunk",
          transferId: identity.transferId,
          offset: 0,
          maxBytes: 10,
        }),
      ).toMatchObject({ ok: false, reason: "native_transfer_not_active" });
    } finally {
      f.close();
    }
  });

  test("read rejects symlinks, hard-link aliases, excluded roots and changed reviewed anchor pins", async () => {
    const f = fixture();
    try {
      writeFileSync(`${f.documents.procPath}/real`, "private", { mode: 0o600 });
      symlinkSync("real", `${f.documents.procPath}/source.bin`);
      let identity = f.binding("read");
      expect((await f.call(identity, { method: "beginRead", binding: identity })).ok).toBe(false);
      rmSync(`${f.documents.procPath}/source.bin`);
      linkSync(`${f.documents.procPath}/real`, `${f.documents.procPath}/source.bin`);
      identity = f.binding("read");
      expect((await f.call(identity, { method: "beginRead", binding: identity })).ok).toBe(false);
      f.changeAnchor();
      identity = f.binding("read");
      expect(await f.call(identity, { method: "beginRead", binding: identity })).toEqual({
        ok: false,
        reason: "native_transfer_anchor_changed",
      });
      const exclusions = new DirectoryExclusions([f.control]);
      expect(() => exclusions.assertSource(f.control.fd, true)).toThrow(
        "private_owner_source_overlap",
      );
    } finally {
      f.close();
    }
  });

  test("lost ACK requires the prepared inode and exact verified content, not either alone", async () => {
    for (const [renameHappened, mutated] of [
      [true, false],
      [false, false],
      [true, true],
    ]) {
      const f = fixture();
      try {
        const bytes = Buffer.from("published inode identity");
        const identity = f.binding("put", bytes);
        await f.prepare(identity, bytes);
        const record = f.journal.nativeTransfer(identity.transferId)!;
        const parent = f.managedState.openChild("fixture.files");
        const destination = parent.openChild("destination");
        try {
          const originalPublish = HeldDirectory.prototype.publish;
          const failure = spyOn(HeldDirectory.prototype, "publish").mockImplementation(function (
            this: HeldDirectory,
            temporary,
            filename,
            exclusive,
          ) {
            if (temporary === record.temporary) {
              if (renameHappened) originalPublish.call(this, temporary, filename, exclusive);
              throw new Error("simulated_lost_publication_ack");
            }
            return originalPublish.call(this, temporary, filename, exclusive);
          });
          try {
            expect(
              await f.call(identity, { method: "commitPut", transferId: identity.transferId }),
            ).toMatchObject({
              ok: true,
              status: { state: "outcome_unknown", reason: "outcome_unknown" },
            });
          } finally {
            failure.mockRestore();
          }
          if (!renameHappened)
            writeFileSync(`${destination.procPath}/delivered.bin`, bytes, { mode: 0o600 });
          const actual = mutated ? Buffer.alloc(bytes.length, 0x5a) : bytes;
          if (mutated) {
            chmodSync(`${destination.procPath}/delivered.bin`, 0o600);
            writeFileSync(`${destination.procPath}/delivered.bin`, actual);
            const fd = destination.openFile("delivered.bin");
            try {
              expect(fileIdentity(fd)).toBe(record.prepared!.identity);
            } finally {
              closeSync(fd);
            }
          }
          const originalGeneration = f.journal.generation;
          f.reopen();
          const reply = await f.call(identity, {
            method: "evidence",
            transferId: identity.transferId,
            bindingDigest: jobDigest(identity),
            ownerGeneration: originalGeneration,
          });
          expect(reply).toMatchObject({
            ok: true,
            status: { state: renameHappened && !mutated ? "committed" : "outcome_unknown" },
          });
          if (renameHappened && !mutated)
            expect(reply).toMatchObject({
              status: { receipt: { ownerGeneration: originalGeneration } },
            });
          else {
            const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 7 * 24 * 60 * 60_000 + 1);
            try {
              expect(
                await f.call(identity, { method: "status", transferId: identity.transferId }),
              ).toMatchObject({
                ok: true,
                status: { state: "outcome_unknown" },
              });
              expect(
                await f.call(identity, { method: "cancel", transferId: identity.transferId }),
              ).toMatchObject({
                ok: true,
                status: { state: "outcome_unknown" },
              });
              expect(f.journal.nativeTransfer(identity.transferId)?.reservedBytes).toBe(
                bytes.length,
              );
              expect(existsSync(`${destination.procPath}/${record.temporary}`)).toBe(
                !renameHappened,
              );
              expect(readFileSync(`${destination.procPath}/delivered.bin`)).toEqual(actual);
            } finally {
              clock.mockRestore();
            }
          }
        } finally {
          destination.close();
          parent.close();
        }
      } finally {
        f.close();
      }
    }
  });

  test("quota is reserved before bytes and cancelled transfers release only private siblings", async () => {
    const f = fixture();
    try {
      const first = f.binding("put");
      if (first.request.mode !== "put") throw new Error("wrong_mode");
      first.request.source.bytes = NATIVE_TRANSFER_MAX_FILE_BYTES;
      expect((await f.call(first, { method: "beginPut", binding: first })).ok).toBe(true);
      const second = f.binding("read");
      writeFileSync(
        `${f.documents.procPath}/source.bin`,
        Buffer.alloc(NATIVE_TRANSFER_MAX_FILE_BYTES),
        { mode: 0o600 },
      );
      expect((await f.call(second, { method: "beginRead", binding: second })).ok).toBe(true);
      const third = f.binding("read", undefined, "other-actor");
      expect(await f.call(third, { method: "beginRead", binding: third })).toMatchObject({
        ok: false,
        reason: "native_transfer_private_capacity",
      });
      await f.call(first, { method: "cancel", transferId: first.transferId });
      expect(f.journal.nativeTransfer(first.transferId)?.reservedBytes).toBe(0);
      expect(readFileSync(`${f.documents.procPath}/source.bin`).length).toBe(
        NATIVE_TRANSFER_MAX_FILE_BYTES,
      );
    } finally {
      f.close();
    }
  });

  test("idle expiry removes a receiving sibling, never an unrelated destination", async () => {
    const f = fixture();
    let clock: { mockRestore(): void } | undefined;
    try {
      const identity = f.binding("put");
      await f.call(identity, { method: "beginPut", binding: identity });
      const record = f.journal.nativeTransfer(identity.transferId)!;
      const destination = join(f.path, "control", "locations", "fixture.files", "destination");
      writeFileSync(join(destination, "delivered.bin"), "preexisting", { mode: 0o600 });
      const now = Date.now();
      clock = spyOn(Date, "now").mockReturnValue(now + 60_001);
      expect(
        await f.call(identity, { method: "status", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "expired", reason: "native_transfer_expired" },
      });
      expect(existsSync(join(destination, record.temporary!))).toBe(false);
      expect(readFileSync(join(destination, "delivered.bin"), "utf8")).toBe("preexisting");
    } finally {
      clock?.mockRestore();
      f.close();
    }
  });

  test.each(["status", "beginPut"] as const)(
    "%s observes idle expiry despite polls and begin retries",
    async (method) => {
      const f = fixture();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now);
      try {
        const identity = f.binding("put");
        expect(await f.call(identity, { method: "beginPut", binding: identity })).toMatchObject({
          ok: true,
          status: { state: "receiving" },
        });
        const admitted = f.journal.nativeTransfer(identity.transferId)!;
        for (const elapsed of [20_000, 40_000, 59_999]) {
          clock.mockReturnValue(now + elapsed);
          expect(
            await f.call(identity, { method: "status", transferId: identity.transferId }),
          ).toMatchObject({
            ok: true,
            status: { state: "receiving" },
          });
          expect(await f.call(identity, { method: "beginPut", binding: identity })).toMatchObject({
            ok: true,
            status: { state: "receiving" },
          });
        }
        expect(f.journal.nativeTransfer(identity.transferId)).toEqual(admitted);
        clock.mockReturnValue(now + 60_000);
        expect(
          await f.call(
            identity,
            method === "status"
              ? { method, transferId: identity.transferId }
              : { method, binding: identity },
          ),
        ).toMatchObject({
          ok: true,
          status: { state: "expired", reason: "native_transfer_expired" },
        });
        expect(f.journal.nativeTransfer(identity.transferId)).toMatchObject({
          reservedBytes: 0,
          lastProgressAt: now,
          updatedAt: now + 60_000,
        });
      } finally {
        clock.mockRestore();
        f.close();
      }
    },
  );

  test("duplicate ACKs and rejected chunks cannot retain an idle reservation", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const identity = f.binding("put", Buffer.from("abcd"));
      await f.call(identity, { method: "beginPut", binding: identity });
      const chunk = {
        method: "putChunk" as const,
        transferId: identity.transferId,
        seq: 0,
        offset: 0,
        data: Buffer.from("ab").toString("base64"),
      };
      clock.mockReturnValue(now + 10_000);
      expect(await f.call(identity, chunk)).toMatchObject({ ok: true, status: { bytes: 2 } });
      const accepted = f.journal.nativeTransfer(identity.transferId)!;
      clock.mockReturnValue(now + 30_000);
      expect(await f.call(identity, chunk)).toMatchObject({ ok: true, status: { bytes: 2 } });
      clock.mockReturnValue(now + 40_000);
      expect(await f.call(identity, { ...chunk, offset: 1 })).toMatchObject({
        ok: false,
        reason: "native_transfer_chunk_sequence_mismatch",
      });
      clock.mockReturnValue(now + 50_000);
      expect(
        await f.call(identity, {
          ...chunk,
          seq: 1,
          offset: 2,
          data: Buffer.from("cde").toString("base64"),
        }),
      ).toMatchObject({
        ok: false,
        reason: "native_transfer_length_mismatch",
      });
      clock.mockReturnValue(now + 69_999);
      expect(await f.call(identity, chunk)).toMatchObject({ ok: true, status: { bytes: 2 } });
      expect(f.journal.nativeTransfer(identity.transferId)).toEqual(accepted);
      clock.mockReturnValue(now + 70_000);
      expect(await f.call(identity, chunk)).toMatchObject({
        ok: false,
        reason: "native_transfer_expired",
        status: { state: "expired", bytes: 2 },
      });
      expect(f.journal.nativeTransfer(identity.transferId)?.reservedBytes).toBe(0);
    } finally {
      clock.mockRestore();
      f.close();
    }
  });

  test("accepted put bytes renew idle time only until their next no-progress cutoff", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const identity = f.binding("put", Buffer.from("abcdef"));
      await f.call(identity, { method: "beginPut", binding: identity });
      const chunk = {
        method: "putChunk" as const,
        transferId: identity.transferId,
        seq: 0,
        offset: 0,
        data: Buffer.from("ab").toString("base64"),
      };
      clock.mockReturnValue(now + 59_000);
      expect(await f.call(identity, chunk)).toMatchObject({ ok: true, status: { bytes: 2 } });
      clock.mockReturnValue(now + 60_000);
      expect(
        await f.call(identity, { method: "status", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "receiving", bytes: 2 },
      });
      clock.mockReturnValue(now + 100_000);
      expect(
        await f.call(identity, {
          ...chunk,
          seq: 1,
          offset: 2,
          data: Buffer.from("cd").toString("base64"),
        }),
      ).toMatchObject({
        ok: true,
        status: { bytes: 4 },
      });
      clock.mockReturnValue(now + 159_999);
      expect(
        await f.call(identity, { method: "status", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "receiving", bytes: 4 },
      });
      clock.mockReturnValue(now + 160_000);
      expect(
        await f.call(identity, {
          ...chunk,
          seq: 2,
          offset: 4,
          data: Buffer.from("ef").toString("base64"),
        }),
      ).toMatchObject({
        ok: false,
        reason: "native_transfer_expired",
        status: { state: "expired", bytes: 4 },
      });
      expect(f.journal.nativeTransfer(identity.transferId)).toMatchObject({
        reservedBytes: 0,
        lastProgressAt: now + 100_000,
      });
    } finally {
      clock.mockRestore();
      f.close();
    }
  });

  test("prepare advances the lifecycle once and repeated prepares cannot defer expiry", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const identity = f.binding("put", Buffer.alloc(0));
      await f.call(identity, { method: "beginPut", binding: identity });
      clock.mockReturnValue(now + 59_000);
      const prepare = { method: "preparePut" as const, transferId: identity.transferId };
      expect(await f.call(identity, prepare)).toMatchObject({
        ok: true,
        status: { state: "verifying" },
      });
      const prepared = f.journal.nativeTransfer(identity.transferId)!;
      for (const elapsed of [60_000, 100_000, 118_999]) {
        clock.mockReturnValue(now + elapsed);
        expect(await f.call(identity, prepare)).toMatchObject({
          ok: true,
          status: { state: "verifying" },
        });
      }
      expect(f.journal.nativeTransfer(identity.transferId)).toEqual(prepared);
      clock.mockReturnValue(now + 119_000);
      expect(
        await f.call(identity, { method: "commitPut", transferId: identity.transferId }),
      ).toMatchObject({
        ok: false,
        reason: "native_transfer_expired",
        status: { state: "expired" },
      });
      expect(
        existsSync(
          join(f.path, "control", "locations", "fixture.files", "destination", "delivered.bin"),
        ),
      ).toBe(false);
    } finally {
      clock.mockRestore();
      f.close();
    }
  });

  test.each(["putChunk", "preparePut"] as const)(
    "%s crossing idle expiry during fsync preserves expiry and cleanup",
    async (method) => {
      const f = fixture();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now);
      let sync: { mockRestore(): void } | undefined;
      try {
        const bytes = method === "putChunk" ? Buffer.from("a") : Buffer.alloc(0);
        const identity = f.binding("put", bytes);
        expect(await f.call(identity, { method: "beginPut", binding: identity })).toMatchObject({
          ok: true,
          status: { state: "receiving" },
        });
        const record = f.journal.nativeTransfer(identity.transferId)!;
        const destination = join(f.path, "control", "locations", "fixture.files", "destination");
        writeFileSync(join(destination, "delivered.bin"), "preexisting", { mode: 0o600 });
        const originalSync = fs.fsyncSync;
        sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          originalSync(fd);
          if (fileIdentity(fd) === record.temporaryIdentity) clock.mockReturnValue(now + 60_000);
        });
        clock.mockReturnValue(now + 59_999);
        expect(
          await f.call(
            identity,
            method === "putChunk"
              ? {
                  method,
                  transferId: identity.transferId,
                  seq: 0,
                  offset: 0,
                  data: bytes.toString("base64"),
                }
              : { method, transferId: identity.transferId },
          ),
        ).toMatchObject({
          ok: false,
          reason: "native_transfer_expired",
          status: { state: "expired", reason: "native_transfer_expired", bytes: 0 },
        });
        expect(f.journal.nativeTransfer(identity.transferId)).toMatchObject({
          reservedBytes: 0,
          lastProgressAt: now,
          status: { state: "expired" },
        });
        expect(existsSync(join(destination, record.temporary!))).toBe(false);
        expect(readFileSync(join(destination, "delivered.bin"), "utf8")).toBe("preexisting");
      } finally {
        sync?.mockRestore();
        clock.mockRestore();
        f.close();
      }
    },
  );

  test("only nonempty reads beyond the delivered high-water offset renew idle time", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      writeFileSync(`${f.documents.procPath}/source.bin`, "abcdefgh", { mode: 0o600 });
      const identity = f.binding("read");
      expect(await f.call(identity, { method: "beginRead", binding: identity })).toMatchObject({
        ok: true,
        status: { state: "ready", bytes: 8 },
      });
      const chunk = {
        method: "readChunk" as const,
        transferId: identity.transferId,
        offset: 0,
        maxBytes: 2,
      };
      clock.mockReturnValue(now + 10_000);
      expect(await f.call(identity, chunk)).toMatchObject({
        ok: true,
        data: Buffer.from("ab").toString("base64"),
      });
      clock.mockReturnValue(now + 30_000);
      expect(await f.call(identity, chunk)).toMatchObject({
        ok: true,
        data: Buffer.from("ab").toString("base64"),
      });
      clock.mockReturnValue(now + 59_000);
      expect(await f.call(identity, { ...chunk, offset: 1, maxBytes: 3 })).toMatchObject({
        ok: true,
        data: Buffer.from("bcd").toString("base64"),
      });
      const delivered = f.journal.nativeTransfer(identity.transferId)!;
      expect(delivered).toMatchObject({ readHighWaterOffset: 4, lastProgressAt: now + 59_000 });
      clock.mockReturnValue(now + 70_000);
      expect(await f.call(identity, { method: "beginRead", binding: identity })).toMatchObject({
        ok: true,
        status: { state: "ready" },
      });
      clock.mockReturnValue(now + 90_000);
      expect(await f.call(identity, { ...chunk, maxBytes: 4 })).toMatchObject({
        ok: true,
        data: Buffer.from("abcd").toString("base64"),
      });
      clock.mockReturnValue(now + 110_000);
      expect(await f.call(identity, { ...chunk, offset: 8 })).toMatchObject({
        ok: true,
        data: "",
        eof: true,
      });
      clock.mockReturnValue(now + 118_999);
      expect(await f.call(identity, { ...chunk, offset: 2 })).toMatchObject({
        ok: true,
        data: Buffer.from("cd").toString("base64"),
      });
      expect(f.journal.nativeTransfer(identity.transferId)).toEqual(delivered);
      clock.mockReturnValue(now + 119_000);
      expect(await f.call(identity, { ...chunk, offset: 4, maxBytes: 4 })).toMatchObject({
        ok: false,
        reason: "native_transfer_expired",
        status: { state: "expired", receipt: undefined },
      });
      f.reopen();
      expect(f.journal.nativeTransfer(identity.transferId)).toMatchObject({
        readHighWaterOffset: 4,
        lastProgressAt: now + 59_000,
        updatedAt: now + 119_000,
        reservedBytes: 0,
        status: { state: "expired" },
      });
    } finally {
      clock.mockRestore();
      f.close();
    }
  });

  test("accepted progress cannot extend the absolute fifteen-minute deadline", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const identity = f.binding("put", Buffer.alloc(20, 0x61));
      await f.call(identity, { method: "beginPut", binding: identity });
      const chunk = {
        method: "putChunk" as const,
        transferId: identity.transferId,
        data: Buffer.from("a").toString("base64"),
      };
      for (let seq = 0; seq < 17; seq++) {
        clock.mockReturnValue(now + (seq + 1) * 50_000);
        expect(await f.call(identity, { ...chunk, seq, offset: seq })).toMatchObject({
          ok: true,
          status: { state: "receiving", bytes: seq + 1 },
        });
      }
      clock.mockReturnValue(now + 899_999);
      expect(await f.call(identity, { ...chunk, seq: 17, offset: 17 })).toMatchObject({
        ok: true,
        status: { state: "receiving", bytes: 18 },
      });
      expect(f.journal.nativeTransfer(identity.transferId)).toMatchObject({
        lastProgressAt: now + 899_999,
        binding: { expiresAt: now + 900_000 },
      });
      clock.mockReturnValue(now + 900_000);
      expect(await f.call(identity, { ...chunk, seq: 18, offset: 18 })).toMatchObject({
        ok: false,
        reason: "native_transfer_expired",
        status: { state: "expired", bytes: 18 },
      });
      expect(f.journal.nativeTransfer(identity.transferId)?.reservedBytes).toBe(0);
    } finally {
      clock.mockRestore();
      f.close();
    }
  });

  test("active limits apply across actors without keeping failed admissions alive", async () => {
    const f = fixture();
    try {
      writeFileSync(`${f.documents.procPath}/source.bin`, "small snapshot", { mode: 0o600 });
      for (const actor of ["one", "one", "two", "two"]) {
        const identity = f.binding("read", undefined, actor);
        expect(await f.call(identity, { method: "beginRead", binding: identity })).toMatchObject({
          ok: true,
          status: { state: "ready" },
        });
        if (
          actor === "one" &&
          [...f.journal.nativeTransfers()].filter((record) => record.status.state === "ready")
            .length === 2
        ) {
          const excess = f.binding("read", undefined, "one");
          expect(await f.call(excess, { method: "beginRead", binding: excess })).toEqual({
            ok: false,
            reason: "native_transfer_active_limit",
          });
        }
      }
      const excess = f.binding("read", undefined, "three");
      expect(await f.call(excess, { method: "beginRead", binding: excess })).toEqual({
        ok: false,
        reason: "native_transfer_active_limit",
      });
    } finally {
      f.close();
    }
  });

  test.each(["cancel", "expire"] as const)(
    "%s retains helper quota until exit, including against another actor",
    async (ending) => {
      const f = fixture();
      const now = Date.now();
      const clock = spyOn(Date, "now").mockReturnValue(now);
      const entered = Promise.withResolvers<void>();
      const exited = Promise.withResolvers<void>();
      let pending: Promise<NativeTransferResult> | undefined;
      const snapshot = snapshots.stableNativeSnapshot;
      let held = false;
      const helper = spyOn(snapshots, "stableNativeSnapshot").mockImplementation(
        async (fd, reservedBytes, signal) => {
          if (held) return snapshot(fd, reservedBytes, signal);
          held = true;
          entered.resolve();
          await exited.promise;
          throw new Error("native_transfer_cancelled");
        },
      );
      try {
        writeFileSync(
          `${f.documents.procPath}/source.bin`,
          Buffer.alloc(NATIVE_TRANSFER_MAX_FILE_BYTES),
          { mode: 0o600 },
        );
        const first = f.binding("read");
        pending = f.call(first, { method: "beginRead", binding: first });
        await entered.promise;
        if (ending === "expire") {
          clock.mockReturnValue(now + 59_999);
          expect(
            await f.call(first, { method: "status", transferId: first.transferId }),
          ).toMatchObject({
            ok: true,
            status: { state: "verifying" },
          });
          expect(await f.call(first, { method: "beginRead", binding: first })).toMatchObject({
            ok: true,
            status: { state: "verifying" },
          });
          clock.mockReturnValue(now + 60_000);
        }
        expect(
          await f.call(first, {
            method: ending === "cancel" ? "cancel" : "status",
            transferId: first.transferId,
          }),
        ).toMatchObject({
          ok: true,
          status: { state: ending === "cancel" ? "cancelled" : "expired" },
        });
        expect(f.journal.nativeTransfer(first.transferId)?.reservedBytes).toBe(
          NATIVE_TRANSFER_MAX_FILE_BYTES,
        );
        const put = f.binding("put");
        if (put.request.mode !== "put") throw new Error("wrong_mode");
        put.request.source.bytes = NATIVE_TRANSFER_MAX_FILE_BYTES;
        expect((await f.call(put, { method: "beginPut", binding: put })).ok).toBe(true);
        const blocked = f.binding("read", undefined, "another-actor");
        expect(await f.call(blocked, { method: "beginRead", binding: blocked })).toMatchObject({
          ok: false,
          reason: "native_transfer_private_capacity",
        });
        exited.resolve();
        await pending;
        expect(f.journal.nativeTransfer(first.transferId)?.reservedBytes).toBe(0);
        const admitted = f.binding("read", undefined, "another-actor");
        expect(await f.call(admitted, { method: "beginRead", binding: admitted })).toMatchObject({
          ok: true,
          status: { state: "ready", bytes: NATIVE_TRANSFER_MAX_FILE_BYTES },
        });
      } finally {
        exited.resolve();
        await pending;
        helper.mockRestore();
        clock.mockRestore();
        f.close();
      }
    },
  );

  test("physical storage exhaustion is named and cannot leave a publishable preparation", async () => {
    const f = fixture();
    const create = HeldDirectory.prototype.createFile;
    const failure = spyOn(HeldDirectory.prototype, "createFile").mockImplementation(function (
      this: HeldDirectory,
      name,
      mode,
    ) {
      if (name.startsWith(".native-transfer-"))
        throw Object.assign(new Error("/private/source/name must not cross the boundary"), {
          code: "ENOSPC",
        });
      return create.call(this, name, mode);
    });
    try {
      const identity = f.binding("put");
      expect(await f.call(identity, { method: "beginPut", binding: identity })).toMatchObject({
        ok: false,
        reason: "storage_capacity",
        status: { state: "failed", reason: "storage_capacity" },
      });
      expect(
        await f.call(identity, { method: "status", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "failed", reason: "storage_capacity" },
      });
      expect(
        await f.call(identity, { method: "commitPut", transferId: identity.transferId }),
      ).toMatchObject({
        ok: false,
        reason: "native_transfer_not_active",
      });
    } finally {
      failure.mockRestore();
      f.close();
    }
  });

  test("receipt retention expires even when status is the only later request", async () => {
    const f = fixture();
    let clock: { mockRestore(): void } | undefined;
    try {
      const identity = f.binding("put", Buffer.alloc(0));
      await f.prepare(identity, Buffer.alloc(0));
      expect(
        await f.call(identity, { method: "commitPut", transferId: identity.transferId }),
      ).toMatchObject({
        ok: true,
        status: { state: "committed" },
      });
      const now = Date.now();
      clock = spyOn(Date, "now").mockReturnValue(now + 7 * 24 * 60 * 60_000 + 1);
      expect(await f.call(identity, { method: "status", transferId: identity.transferId })).toEqual(
        {
          ok: false,
          reason: "native_transfer_unknown",
        },
      );
      expect(f.journal.nativeTransfer(identity.transferId)).toBeUndefined();
      expect(
        existsSync(
          join(f.path, "control", "locations", "fixture.files", "destination", "delivered.bin"),
        ),
      ).toBe(true);
    } finally {
      clock?.mockRestore();
      f.close();
    }
  });

  test("inline artifact hash covers selected full location declarations and never accepts delivered executables", () => {
    const f = fixture();
    try {
      const changed = structuredClone(f.install);
      changed.machine.locations["fixture.files.destination"]!.components = ["elsewhere"];
      expect(() => validateNativeTransferInstallation(changed)).toThrow(
        "native_transfer_artifact_mismatch",
      );
      expect(() =>
        validateNativeTransferInstallation({
          ...f.install,
          artifact: { bundleFile: "worker", data: "AA==" },
        }),
      ).toThrow("native_transfer_artifact_invalid");
    } finally {
      f.close();
    }
  });
});

test("native private frames cannot borrow the larger artifact backlog budget", () => {
  const written: Uint8Array[] = [];
  let overflow = 0;
  const writer = new FrameWriter(
    {
      write(bytes) {
        written.push(bytes);
        return 0;
      },
      end() {},
    },
    (bytes) => {
      overflow = bytes;
    },
    32 * 1024 * 1024,
  );
  const frame = { data: "x".repeat(512 * 1024 - 32) };
  for (let n = 0; n < 4; n++) expect(writer.send(frame, 2 * 1024 * 1024)).toBe(true);
  expect(writer.send(frame, 2 * 1024 * 1024)).toBe(false);
  expect(overflow).toBeGreaterThan(2 * 1024 * 1024);
  expect(written).toHaveLength(1);
});
