import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  canonicalNativeTransferPolicy,
  JOB_OWNER_PROTOCOL_COMPAT_VERSIONS,
  JOB_OWNER_PROTOCOL_VERSION,
  JobCommandSchema,
  JobEventSchema,
  MachineHalfSchema,
  jobOwnerMachine,
  jobOwnerSupports,
  type MachineHalf,
} from "../src/jobs.ts";
import { GOVERNED_CAPS } from "../src/capabilities.ts";
import { ActionDelegatesSchema } from "../src/plugin.ts";
import {
  NativeTransferBeginPutArgsSchema,
  NativeTransferBeginReadArgsSchema,
  NativeTransferBindingSchema,
  NativeTransferPermitSchema,
  NativeTransferPutChunkArgsSchema,
  NativeTransferReadChunkResultSchema,
  NativeTransferRequestSchema,
  NativeTransferResultSchema,
  NativeTransferStatusSchema,
  NativeTransferEvidenceBatchSchema,
  NATIVE_TRANSFER_MAX_CHUNK_BYTES,
  NATIVE_TRANSFER_MAX_FILE_BYTES,
  NATIVE_TRANSFER_MAX_LIFETIME_MS,
} from "../src/native-transfers.ts";

const hash = "a".repeat(64);
const machine: MachineHalf = {
  artifacts: {},
  operations: {},
  locations: {
    received: {
      anchor: "state",
      components: ["received"],
      revision: "r1",
      kind: "directory",
      managed: true,
    },
    source: { anchor: "home", components: ["source"], revision: "r2", kind: "directory" },
  },
  transferPolicy: {
    format: "native-transfer-v1",
    locations: { received: ["create-child", "read"], source: ["read"] },
  },
};
const pins = {
  requestId: "request",
  machineId: "machine",
  installationRevision: "installation",
  artifactSha256: hash,
  locationId: "received",
  locationRevision: "r1",
};
const put = {
  ...pins,
  filename: "report.txt",
  source: {
    ref: { kind: "machine" as const, machineId: "source-machine" },
    sha256: hash,
    bytes: 5,
  },
};
const binding = {
  transferId: "transfer",
  pluginId: "sample.transfer",
  actorId: "actor",
  credentialBinding: hash,
  createdAt: 1,
  expiresAt: 60_001,
  request: { mode: "put" as const, ...put },
};
const status = {
  transferId: "transfer",
  mode: "read" as const,
  state: "ready" as const,
  bytes: 5,
  sha256: hash,
  receipt: {
    ...pins,
    transferId: "transfer",
    mode: "read" as const,
    pluginId: "sample.transfer",
    actorId: "actor",
    credentialBinding: hash,
    ownerId: "owner",
    ownerGeneration: 1,
    path: "/approved/report.txt",
    bytes: 5,
    sha256: hash,
    committedAt: 100,
  },
};
const permit = {
  body: {
    permitId: "permit",
    commandDigest: hash,
    transferId: "transfer",
    pluginId: "sample.transfer",
    actorId: "actor",
    credentialBinding: hash,
    machineId: "machine",
    ownerId: "owner",
    ownerGeneration: 1,
    seatNonce: "attachment-challenge",
    issuedAt: 10,
    expiresAt: 5_010,
  },
  signature: Buffer.alloc(64).toString("base64"),
};

test("transfer-only artifacts admit exact retained directories without executable authority", () => {
  expect(MachineHalfSchema.parse(machine).operations).toEqual({});
  expect(MachineHalfSchema.safeParse({ ...machine, transferPolicy: undefined }).success).toBe(
    false,
  );
  for (const locations of [
    {},
    { received: [] },
    { missing: ["read"] },
    { source: ["create-child"] },
    { received: ["create"] },
    { received: ["write"] },
    { received: ["read", "read"] },
  ])
    expect(
      MachineHalfSchema.safeParse({
        ...machine,
        transferPolicy: { format: "native-transfer-v1", locations },
      }).success,
    ).toBe(false);
  for (const change of [{ kind: "file" }, { temporary: true }, { managed: undefined }])
    expect(
      MachineHalfSchema.safeParse({
        ...machine,
        locations: { ...machine.locations, received: { ...machine.locations.received, ...change } },
      }).success,
    ).toBe(false);
  expect(MachineHalfSchema.safeParse({ ...machine, tools: {} }).success).toBe(false);
  expect(GOVERNED_CAPS.includes("locations:create-child")).toBe(true);
  expect(ActionDelegatesSchema.parse(["locations:create-child"])).toEqual([
    "locations:create-child",
  ]);
});

test("ordinary jobs keep their prior schema and cannot obtain create-child through job mounts", () => {
  const ordinary: MachineHalf = {
    artifacts: {},
    locations: machine.locations,
    operations: {
      run: {
        argv: [],
        input: {},
        runtimeTools: [],
        locations: [{ locationId: "source", access: "read" }],
        outputs: [],
        network: "none",
        limits: { timeoutMs: 1_000, memoryBytes: 1_048_576, processes: 1, outputBytes: 65_536 },
      },
    },
  };
  expect(MachineHalfSchema.parse(ordinary)).toEqual(ordinary);
  expect(jobOwnerMachine(43, ordinary)).toEqual(ordinary);
  expect(
    MachineHalfSchema.safeParse({ ...ordinary, transferPolicy: machine.transferPolicy }).success,
  ).toBe(false);
  expect(
    MachineHalfSchema.safeParse({
      ...ordinary,
      operations: {
        run: {
          ...ordinary.operations.run,
          locations: [{ locationId: "received", access: "create-child" }],
        },
      },
    }).success,
  ).toBe(false);
});

test("inline policy identity binds complete declarations and rights, not object insertion order", () => {
  const digest = (value: MachineHalf) =>
    createHash("sha256").update(canonicalNativeTransferPolicy(value)).digest("hex");
  const reordered: MachineHalf = {
    ...machine,
    locations: { source: machine.locations.source!, received: machine.locations.received! },
    transferPolicy: {
      format: "native-transfer-v1",
      locations: { source: ["read"], received: ["read", "create-child"] },
    },
  };
  expect(digest(reordered)).toBe(digest(machine));
  for (const change of [
    { revision: "r3" },
    { components: ["different"] },
    { guestPath: "/home/job/reviewed" },
  ])
    expect(
      digest({
        ...machine,
        locations: {
          ...machine.locations,
          received: { ...machine.locations.received!, ...change },
        },
      }),
    ).not.toBe(digest(machine));
  expect(
    digest({
      ...machine,
      transferPolicy: {
        format: "native-transfer-v1",
        locations: { received: ["read"], source: ["read"] },
      },
    }),
  ).not.toBe(digest(machine));
  expect(JSON.parse(canonicalNativeTransferPolicy(machine))).toEqual({
    format: "native-transfer-v1",
    locations: {
      received: { location: machine.locations.received, access: ["create-child", "read"] },
      source: { location: machine.locations.source, access: ["read"] },
    },
  });
});

test("older owners refuse the entire inline policy, never an empty job projection", () => {
  for (const version of JOB_OWNER_PROTOCOL_COMPAT_VERSIONS) {
    if (version === JOB_OWNER_PROTOCOL_VERSION) continue;
    expect(jobOwnerSupports(version, "nativeTransfers")).toBe(false);
    expect(jobOwnerMachine(version, machine)).toBeNull();
  }
  expect(jobOwnerMachine(JOB_OWNER_PROTOCOL_VERSION, machine)).toBe(machine);
  expect(jobOwnerMachine(JOB_OWNER_PROTOCOL_VERSION + 1, machine)).toBeNull();
  const install = {
    type: "install",
    pluginId: "sample.transfer",
    installationRevision: "r1",
    machine,
    artifactSha256: hash,
  };
  expect(JobCommandSchema.parse(install)).toEqual(install);
  expect(
    JobCommandSchema.safeParse({ ...install, artifact: { bundleFile: "worker", data: "YQ==" } })
      .success,
  ).toBe(false);
  expect(JobCommandSchema.safeParse({ ...install, toolArtifacts: {} }).success).toBe(false);
});

test("public transfer arguments cannot override floor identity or escape an approved root", () => {
  expect(NativeTransferBeginPutArgsSchema.parse(put).filename).toBe("report.txt");
  for (const injected of [
    { pluginId: "other.plugin" },
    { actorId: "other" },
    { credentialBinding: hash },
    { transferId: "selected" },
  ])
    expect(NativeTransferBeginPutArgsSchema.safeParse({ ...put, ...injected }).success).toBe(false);
  for (const filename of ["", ".", "..", "../escape", "x/y", "x\\y", "bad\0name", "é".repeat(128)])
    expect(NativeTransferBeginPutArgsSchema.safeParse({ ...put, filename }).success).toBe(false);
  for (const relativePath of [[], ["..", "escape"], ["a/b"], Array(17).fill("a")])
    expect(NativeTransferBeginReadArgsSchema.safeParse({ ...pins, relativePath }).success).toBe(
      false,
    );
  expect(
    NativeTransferBeginReadArgsSchema.parse({ ...pins, relativePath: ["nested", "report.txt"] })
      .relativePath,
  ).toEqual(["nested", "report.txt"]);
  expect(
    NativeTransferBeginReadArgsSchema.safeParse({ ...put, relativePath: ["report.txt"] }).success,
  ).toBe(false);
  expect(
    NativeTransferBeginPutArgsSchema.safeParse({
      ...put,
      source: { ...put.source, bytes: NATIVE_TRANSFER_MAX_FILE_BYTES + 1 },
    }).success,
  ).toBe(false);
});

test("transfer components reject normalization aliases and ambiguous platform names", () => {
  const refused = [
    "cafe\u0301.txt",
    "C:report.txt",
    "report.txt:stream",
    "report.",
    "report ",
    "CON",
    "prn.txt",
    "Aux.log",
    "nul",
    "COM1",
    "com9.txt",
    "LPT1.log",
    "lpt9",
  ];
  for (const filename of refused) {
    expect(NativeTransferBeginPutArgsSchema.safeParse({ ...put, filename }).success).toBe(false);
    expect(
      NativeTransferBeginReadArgsSchema.safeParse({ ...pins, relativePath: ["nested", filename] })
        .success,
    ).toBe(false);
  }
  for (const filename of [
    "café.txt",
    "CONSOLE.txt",
    "COM10",
    "LPT10.txt",
    ".report",
    "report name.txt",
    `${"é".repeat(127)}x`,
  ]) {
    expect(NativeTransferBeginPutArgsSchema.parse({ ...put, filename }).filename).toBe(filename);
    expect(
      NativeTransferBeginReadArgsSchema.parse({ ...pins, relativePath: [filename] }).relativePath,
    ).toEqual([filename]);
  }
});

test("binding and permits bound lifetime, command mode and full caller identity", () => {
  expect(NativeTransferRequestSchema.parse({ method: "beginPut", binding }).method).toBe(
    "beginPut",
  );
  expect(NativeTransferRequestSchema.safeParse({ method: "beginRead", binding }).success).toBe(
    false,
  );
  expect(
    NativeTransferBindingSchema.safeParse({ ...binding, expiresAt: binding.createdAt }).success,
  ).toBe(false);
  expect(
    NativeTransferBindingSchema.safeParse({
      ...binding,
      expiresAt: binding.createdAt + NATIVE_TRANSFER_MAX_LIFETIME_MS + 1,
    }).success,
  ).toBe(false);
  expect(
    NativeTransferPermitSchema.safeParse({ ...permit, body: { ...permit.body, expiresAt: 5_011 } })
      .success,
  ).toBe(false);
  for (const omitted of [
    "commandDigest",
    "credentialBinding",
    "actorId",
    "ownerGeneration",
    "seatNonce",
    "transferId",
  ]) {
    const body: Record<string, unknown> = { ...permit.body };
    delete body[omitted];
    expect(NativeTransferPermitSchema.safeParse({ ...permit, body }).success).toBe(false);
  }
  const command = {
    type: "native_transfer",
    rpcId: "rpc",
    request: { method: "status", transferId: "transfer" },
    permit,
  };
  expect(JobCommandSchema.parse(command)).toEqual(command);
  expect(JobCommandSchema.safeParse({ ...command, permit: undefined }).success).toBe(false);
});

test("chunk byte bounds count base64 padding, require offset and forbid partial read replies", () => {
  const data = new Uint8Array(NATIVE_TRANSFER_MAX_CHUNK_BYTES);
  const request = { transferId: "transfer", seq: 0, offset: 0, data };
  expect(NativeTransferPutChunkArgsSchema.parse(request).data.byteLength).toBe(data.byteLength);
  expect(
    NativeTransferPutChunkArgsSchema.safeParse({ ...request, offset: undefined }).success,
  ).toBe(false);
  expect(
    NativeTransferPutChunkArgsSchema.safeParse({
      ...request,
      data: new Uint8Array(data.byteLength + 1),
    }).success,
  ).toBe(false);
  expect(
    NativeTransferRequestSchema.parse({
      ...request,
      method: "putChunk",
      data: Buffer.from(data).toString("base64"),
    }).method,
  ).toBe("putChunk");
  // Both encode to the same number of characters; the decoded byte ceiling is authoritative.
  expect(
    NativeTransferRequestSchema.safeParse({
      ...request,
      method: "putChunk",
      data: Buffer.alloc(data.byteLength + 1).toString("base64"),
    }).success,
  ).toBe(false);
  expect(NativeTransferResultSchema.safeParse({ ok: true, status, data: "YQ==" }).success).toBe(
    false,
  );
  expect(
    NativeTransferResultSchema.safeParse({ ok: true, status, data: "YQ==", offset: 5, eof: true })
      .success,
  ).toBe(false);
  expect(
    NativeTransferReadChunkResultSchema.safeParse({
      data: new Uint8Array(1),
      status,
      offset: 5,
      eof: true,
    }).success,
  ).toBe(false);
});

test("named refusals and unknown outcomes survive the event boundary without sensitive text", () => {
  const event = {
    type: "native_transfer_result",
    rpcId: "rpc",
    ownerId: "owner",
    ownerGeneration: 1,
    result: {
      ok: false,
      reason: "outcome_unknown",
      status: {
        transferId: "transfer",
        mode: "put",
        state: "outcome_unknown",
        bytes: 5,
        reason: "native_transfer_recovery_unknown",
      },
    },
  };
  expect(JobEventSchema.parse(event)).toEqual(event);
  expect(
    NativeTransferResultSchema.safeParse({ ok: false, reason: "/private/path failed" }).success,
  ).toBe(false);
  expect(
    NativeTransferResultSchema.safeParse({ ok: false, reason: "native_transfer_secret_account_id" })
      .success,
  ).toBe(false);
  expect(
    NativeTransferStatusSchema.safeParse({ ...status, reason: "well_formed_but_undeclared" })
      .success,
  ).toBe(false);
  expect(
    NativeTransferStatusSchema.safeParse({
      ...status,
      receipt: {
        ...pins,
        transferId: "another",
        mode: "read",
        pluginId: "sample.transfer",
        actorId: "actor",
        credentialBinding: hash,
        ownerId: "owner",
        ownerGeneration: 1,
        path: "/approved/report.txt",
        bytes: 5,
        sha256: hash,
        committedAt: 100,
      },
    }).success,
  ).toBe(false);
});

test("publication receipts cannot turn an uncertain or prepared put into success", () => {
  const receipt = {
    ...pins,
    transferId: "transfer",
    mode: "put",
    pluginId: "sample.transfer",
    actorId: "actor",
    credentialBinding: hash,
    ownerId: "owner",
    ownerGeneration: 1,
    path: "/approved/report.txt",
    bytes: 5,
    sha256: hash,
    committedAt: 100,
  };
  const committed = { ...status, mode: "put", state: "committed", receipt };
  expect(NativeTransferStatusSchema.parse(committed)).toEqual(committed);
  expect(NativeTransferStatusSchema.safeParse({ ...committed, receipt: undefined }).success).toBe(
    false,
  );
  for (const state of ["verifying", "ready", "cancelled", "refused", "expired", "outcome_unknown"])
    expect(NativeTransferStatusSchema.safeParse({ ...committed, state }).success).toBe(false);
  for (const changed of [{ bytes: 6 }, { sha256: "b".repeat(64) }, { transferId: "other" }])
    expect(
      NativeTransferStatusSchema.safeParse({ ...committed, receipt: { ...receipt, ...changed } })
        .success,
    ).toBe(false);
  const snapshot = { ...status, receipt: { ...receipt, mode: "read" } };
  expect(NativeTransferStatusSchema.parse(snapshot)).toEqual(snapshot);
  expect(NativeTransferStatusSchema.safeParse({ ...snapshot, receipt: undefined }).success).toBe(
    false,
  );
  expect(NativeTransferStatusSchema.safeParse({ ...snapshot, sha256: undefined }).success).toBe(
    false,
  );
});

test("unadmitted evidence cannot claim a native transfer or disclose effect metadata", () => {
  const refused = {
    kind: "admission-refused",
    requestId: "request",
    actorId: "actor",
    credentialBinding: hash,
    mode: "put",
    attemptedAt: 1234,
    reason: "installation_changed",
  };
  expect(NativeTransferEvidenceBatchSchema.parse([refused])).toEqual([refused]);
  for (const extra of [
    { transferId: "invented" },
    { state: "committed" },
    { path: "/private/file" },
    { data: "private bytes" },
    { reason: "EIO /private/path" },
  ])
    expect(NativeTransferEvidenceBatchSchema.safeParse([{ ...refused, ...extra }]).success).toBe(
      false,
    );
  expect(
    NativeTransferEvidenceBatchSchema.safeParse([{ ...refused, attemptedAt: -1 }]).success,
  ).toBe(false);
  expect(
    NativeTransferEvidenceBatchSchema.safeParse(Array.from({ length: 65 }, () => refused)).success,
  ).toBe(false);
});
