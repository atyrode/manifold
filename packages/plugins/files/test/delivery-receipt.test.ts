import { describe, expect, test } from "bun:test";
import {
  BeginFileDeliverySchema,
  FileDescriptorSchema,
  FileNativeResultSchema,
} from "../src/contract.ts";
import { verifiedDeliveryReceipt } from "../src/delivery-receipt.ts";

function fixture() {
  const file = FileDescriptorSchema.parse({
    ref: { kind: "file", fileId: "source" },
    home: { kind: "root" },
    ownerId: "creator",
    name: "source.bin",
    declaredMediaType: null,
    mediaType: "application/octet-stream",
    bytes: 4,
    sha256: "a".repeat(64),
    createdAt: 1,
    image: null,
  });
  const intent = BeginFileDeliverySchema.parse({
    requestId: "1234567890123_delivery",
    ref: file.ref,
    machine: { kind: "machine", machineId: "chosen-not-terminal-owner" },
    location: { kind: "location", machineId: "chosen-not-terminal-owner", locationId: "managed" },
    installationRevision: "install",
    artifactSha256: "b".repeat(64),
    locationId: "managed",
    locationRevision: "consent",
    filename: "source.bin",
  });
  const receipt = {
    transferId: "native-put",
    mode: "put",
    requestId: intent.requestId,
    machineId: intent.machine.machineId,
    installationRevision: intent.installationRevision,
    artifactSha256: intent.artifactSha256,
    locationId: intent.locationId,
    locationRevision: intent.locationRevision,
    pluginId: "core.files",
    actorId: "creator",
    credentialBinding: "c".repeat(64),
    ownerId: "native-owner",
    ownerGeneration: 3,
    path: "/actual-private-root/source.bin",
    bytes: file.bytes,
    sha256: file.sha256,
    committedAt: 2,
  };
  const result = FileNativeResultSchema.parse({
    transfer: {
      transferId: "file-delivery",
      ref: file.ref,
      kind: "delivery",
      state: "completed",
      bytes: file.bytes,
      offset: file.bytes,
      sequence: 1,
      chunkBytes: 262144,
      createdAt: 1,
      expiresAt: 60_001,
      reason: null,
    },
    native: {
      transferId: receipt.transferId,
      mode: "put",
      state: "committed",
      bytes: file.bytes,
      sha256: file.sha256,
      receipt,
    },
  });
  return { file, intent, result };
}

describe("verified destination path admission", () => {
  test("only the completed owner's receipt supplies the actual path, including an explicitly different machine", () => {
    const { file, intent, result } = fixture();
    expect(verifiedDeliveryReceipt(file, intent, result)?.path).toBe(
      "/actual-private-root/source.bin",
    );
    expect(verifiedDeliveryReceipt(file, intent, { ...result, native: null })).toBeNull();
    for (const state of ["publishing", "outcome_unknown", "cancelled", "refused"] as const) {
      expect(
        verifiedDeliveryReceipt(file, intent, {
          ...result,
          transfer: { ...result.transfer, state },
        }),
      ).toBeNull();
    }
  });

  test("a valid receipt from a different source, request, machine or consent cannot be offered for insertion", () => {
    const { file, intent, result } = fixture();
    expect(verifiedDeliveryReceipt({ ...file, sha256: "d".repeat(64) }, intent, result)).toBeNull();
    expect(verifiedDeliveryReceipt({ ...file, bytes: 5 }, intent, result)).toBeNull();
    expect(
      verifiedDeliveryReceipt(file, { ...intent, requestId: "1234567890123_other" }, result),
    ).toBeNull();
    expect(
      verifiedDeliveryReceipt(
        file,
        { ...intent, machine: { kind: "machine", machineId: "terminal-owner" } },
        result,
      ),
    ).toBeNull();
    expect(
      verifiedDeliveryReceipt(file, { ...intent, locationRevision: "new-consent" }, result),
    ).toBeNull();
    expect(
      verifiedDeliveryReceipt(file, { ...intent, artifactSha256: "e".repeat(64) }, result),
    ).toBeNull();
  });
});
