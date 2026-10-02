import { expect, test } from "bun:test";
import {
  base64ToBytes,
  bytesToBase64,
  CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES,
  CREDENTIAL_ENROLLMENT_SUITE,
  CREDENTIAL_ENROLLMENT_VERSION,
  createServiceCredentialEnrollmentKey,
  sealServiceCredentialEnrollment,
  ServiceCredentialEnrollmentEnvelopeSchema,
  type ServiceCredentialEnrollmentContext,
} from "../src/index.ts";

function context(keyId: string): ServiceCredentialEnrollmentContext {
  return {
    version: CREDENTIAL_ENROLLMENT_VERSION,
    suite: CREDENTIAL_ENROLLMENT_SUITE,
    keyId,
    machineId: "synthetic-machine",
    ownerId: "synthetic-owner",
    ownerGeneration: 1,
    requestId: crypto.randomUUID(),
    serverEpoch: "synthetic-epoch",
    ownerChallenge: "synthetic-proof",
    credentialRef: "synthetic",
    origin: "https://service.example.invalid",
    nonce: crypto.randomUUID(),
    expiresAt: 1_900_000_000_000,
    replace: false,
    sourceRevision: null,
  };
}

test("sealed enrollment authenticates every target, authority and replacement context field", async () => {
  const key = await createServiceCredentialEnrollmentKey();
  const plaintext = new Uint8Array([83, 89, 78, 84, 72, 69, 84, 73, 67]);
  try {
    const binding = context(key.metadata.keyId);
    const envelope = await sealServiceCredentialEnrollment({ context: binding, key: key.metadata }, plaintext);
    const changes: Partial<ServiceCredentialEnrollmentContext>[] = [
      { machineId: "other-machine" },
      { ownerId: "other-owner" },
      { ownerGeneration: 2 },
      { requestId: crypto.randomUUID() },
      { serverEpoch: "other-epoch" },
      { ownerChallenge: "other-proof" },
      { credentialRef: "other-reference" },
      { origin: "https://other.example.invalid" },
      { nonce: crypto.randomUUID() },
      { expiresAt: binding.expiresAt + 1 },
      { replace: true },
      { sourceRevision: crypto.randomUUID() },
    ];
    for (const change of changes) {
      await expect(key.open({ ...envelope, context: { ...binding, ...change } })).rejects.toMatchObject({
        reason: "credential_envelope_invalid",
      });
    }
    const ciphertext = base64ToBytes(envelope.ciphertext);
    ciphertext[0]! ^= 1;
    await expect(key.open({ ...envelope, ciphertext: bytesToBase64(ciphertext) })).rejects.toMatchObject({
      reason: "credential_envelope_invalid",
    });
    const opened = await key.open(envelope);
    try { expect(opened).toEqual(plaintext); } finally { opened.fill(0); }
  } finally {
    plaintext.fill(0);
    key.close();
  }
});

test("recipient rotation and closure make earlier sealed values unusable", async () => {
  const first = await createServiceCredentialEnrollmentKey();
  const next = await createServiceCredentialEnrollmentKey();
  const plaintext = new Uint8Array([83]);
  try {
    const envelope = await sealServiceCredentialEnrollment({ context: context(first.metadata.keyId), key: first.metadata }, plaintext);
    await expect(next.open(envelope)).rejects.toMatchObject({ reason: "credential_key_changed" });
    first.close();
    await expect(first.open(envelope)).rejects.toMatchObject({ reason: "credential_key_changed" });
  } finally {
    plaintext.fill(0);
    first.close();
    next.close();
  }
});

test("value and ciphertext bounds preserve the complete maximum credential and refuse overflow", async () => {
  const key = await createServiceCredentialEnrollmentKey();
  const plaintext = new Uint8Array(CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES).fill(83);
  try {
    const challenge = { context: context(key.metadata.keyId), key: key.metadata };
    const envelope = await sealServiceCredentialEnrollment(challenge, plaintext);
    const opened = await key.open(envelope);
    try { expect(opened).toEqual(plaintext); } finally { opened.fill(0); }
    await expect(sealServiceCredentialEnrollment(challenge, new Uint8Array())).rejects.toMatchObject({ reason: "credential_value_invalid" });
    await expect(sealServiceCredentialEnrollment(challenge, new Uint8Array(CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES + 1))).rejects.toMatchObject({ reason: "credential_value_invalid" });
    expect(ServiceCredentialEnrollmentEnvelopeSchema.safeParse({
      ...envelope,
      ciphertext: bytesToBase64(new Uint8Array(CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES + 17)),
    }).success).toBe(false);
    expect(ServiceCredentialEnrollmentEnvelopeSchema.safeParse({
      ...envelope,
      ciphertext: bytesToBase64(new Uint8Array(16)),
    }).success).toBe(false);
    expect(ServiceCredentialEnrollmentEnvelopeSchema.safeParse({
      ...envelope,
      enc: bytesToBase64(new Uint8Array(64)),
    }).success).toBe(false);
  } finally {
    plaintext.fill(0);
    key.close();
  }
});

test("unknown envelope/key versions refuse by name without using a different cryptographic mode", async () => {
  const key = await createServiceCredentialEnrollmentKey();
  const plaintext = new Uint8Array([83]);
  try {
    const challenge = { context: context(key.metadata.keyId), key: key.metadata };
    const envelope = await sealServiceCredentialEnrollment(challenge, plaintext);
    await expect(key.open({ ...envelope, context: { ...envelope.context, version: 2 } })).rejects.toMatchObject({ reason: "credential_key_version_unsupported" });
    await expect(sealServiceCredentialEnrollment({ ...challenge, key: { ...key.metadata, version: 2 } }, plaintext)).rejects.toMatchObject({ reason: "credential_key_version_unsupported" });
  } finally {
    plaintext.fill(0);
    key.close();
  }
});
