import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS,
  CREDENTIAL_ENROLLMENT_PENDING_LIMIT,
  createServiceCredentialEnrollmentKey,
  sealServiceCredentialEnrollment,
  type JobCommand,
  type JobEvent,
  type ServiceCredentialEnrollmentChallenge,
  type ServiceCredentialEnrollmentContext,
} from "@manifold/protocol";
import { JobCredentialEnrollment } from "../src/job-credential-enrollment.ts";
import { HeldServiceCredentialRegistry } from "../src/job-credentials.ts";
import { HeldDirectory } from "../src/job-files.ts";
import { heldServiceCredentialResolver } from "../src/job-services.ts";
import { JobResources } from "../src/job-resources.ts";

type Authorize = Extract<JobEvent, { type: "credential_enrollment_authorize" }>;
const origin = "https://service.invalid";
const proof = { serverEpoch: "native-fixture-epoch", ownerChallenge: "native-fixture-proof" };

async function fixture(holdDecryption?: Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "native-enrollment-"));
  const sources = new HeldServiceCredentialRegistry();
  sources.declare("key", HeldDirectory.openAbsolute(root, { private: true }), "key", [origin]);
  const resources = new JobResources({
    anchors: {},
    runtimeTools: {},
    credentialReferences: () => sources.references(),
  });
  const key = await createServiceCredentialEnrollmentKey();
  const events: JobEvent[] = [];
  const waits = new Map<string, (event: Authorize) => void>();
  const opened = Promise.withResolvers<Uint8Array>();
  const plaintext: Uint8Array[] = [];
  let now = Date.now();
  let active = true;
  const enrollment = new JobCredentialEnrollment({
    machineId: "fixture-machine",
    ownerId: "fixture-owner",
    ownerGeneration: 7,
    sources,
    key: {
      metadata: key.metadata,
      // Retain observations of real HPKE output to prove byte wiping, not a fake decryption.
      async open(envelope) {
        const bytes = await key.open(envelope);
        plaintext.push(bytes);
        opened.resolve(bytes);
        if (holdDecryption) await holdDecryption;
        return bytes;
      },
      close: () => key.close(),
    },
    active: () => active,
    now: () => now,
    emit(event) {
      events.push(event);
      if (event.type === "credential_enrollment_authorize") {
        waits.get(event.requestId)?.(event);
        waits.delete(event.requestId);
      }
      return active;
    },
    published() {
      resources.refresh({ tools: [], anchors: [], services: [] });
    },
  });
  enrollment.proved(proof.serverEpoch, proof.ownerChallenge);
  const prepare = (replace = false, changes: Partial<Extract<JobCommand, { type: "credential_enrollment_prepare" }>> = {}) => {
    const command: Extract<JobCommand, { type: "credential_enrollment_prepare" }> = {
      type: "credential_enrollment_prepare",
      requestId: randomUUID(),
      ...proof,
      machineId: "fixture-machine",
      credentialRef: "key",
      origin,
      replace,
      ...changes,
    };
    enrollment.prepare(command);
    const event = events.findLast(
      (event) => event.type === "credential_enrollment_prepared" && event.requestId === command.requestId,
    );
    if (!event || event.type !== "credential_enrollment_prepared") throw new Error("missing_prepare_result");
    return { command, reply: event.reply };
  };
  const offer = (replace = false): ServiceCredentialEnrollmentChallenge => {
    const { reply } = prepare(replace);
    if (reply.kind !== "prepared") throw new Error("prepare_refused");
    return reply.challenge;
  };
  const authorize = async (requestId: string): Promise<Authorize> => {
    const found = events.find(
      (event) => event.type === "credential_enrollment_authorize" && event.requestId === requestId,
    );
    if (found?.type === "credential_enrollment_authorize") return found;
    const pending = Promise.withResolvers<Authorize>();
    waits.set(requestId, pending.resolve);
    return pending.promise;
  };
  const result = (requestId: string) => {
    const event = events.findLast(
      (event) => event.type === "credential_enrollment_result" && event.requestId === requestId,
    );
    if (!event || event.type !== "credential_enrollment_result") throw new Error("missing_commit_result");
    return event.reply;
  };
  return {
    root, sources, resources, key, events, enrollment, prepare, offer, authorize, result, plaintext,
    opened: opened.promise,
    resolve: heldServiceCredentialResolver((ref) => sources.currentDescriptor(ref)),
    setNow(value: number) { now = value; },
    disconnect() { active = false; enrollment.invalidate("credential_owner_offline"); },
    close() { enrollment.close(); sources.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

async function envelope(challenge: ServiceCredentialEnrollmentChallenge, value = "synthetic-private-value") {
  const bytes = new TextEncoder().encode(value);
  try {
    return await sealServiceCredentialEnrollment(challenge, bytes);
  } finally {
    bytes.fill(0);
  }
}

describe.skipIf(process.platform !== "linux")("native sealed credential enrollment", () => {
  test("a missing declared source becomes resolvable only after final authorization; explicit replacement is visible", async () => {
    const native = await fixture();
    const signal = new AbortController().signal;
    try {
      const first = native.offer(true);
      expect(first.context.sourceRevision).toBeNull();
      const commit = native.enrollment.commit({ type: "credential_enrollment_commit", envelope: await envelope(first) });
      const authorization = await native.authorize(first.context.requestId);
      await expect(native.resolve("key", signal)).rejects.toThrow("service_credential_unavailable");
      expect(existsSync(join(native.root, "key"))).toBe(false);
      native.enrollment.authorized({ ...authorization, type: "credential_enrollment_authorized", allowed: true, reason: null });
      await commit;
      const initial = native.result(first.context.requestId);
      expect(initial).toMatchObject({ kind: "stored", credentialRef: "key", replaced: false, available: true });
      expect(await native.resolve("key", signal)).toBe("synthetic-private-value");
      expect(native.resources.snapshot().credentialReferences).toEqual([
        { ref: "key", origins: [origin], available: true },
      ]);
      expect(native.prepare(false).reply).toEqual({ kind: "refused", reason: "credential_already_held" });
      const replacement = native.offer(true);
      const next = native.enrollment.commit({ type: "credential_enrollment_commit", envelope: await envelope(replacement, "synthetic-new-value") });
      const authorized = await native.authorize(replacement.context.requestId);
      native.enrollment.authorized({ ...authorized, type: "credential_enrollment_authorized", allowed: true, reason: null });
      await next;
      const stored = native.result(replacement.context.requestId);
      expect(stored).toMatchObject({ kind: "stored", replaced: true });
      if (stored.kind !== "stored") throw new Error("replacement_not_stored");
      expect(stored.sourceRevision).not.toBe(replacement.context.sourceRevision);
      expect(await native.resolve("key", signal)).toBe("synthetic-new-value");
      for (const bytes of native.plaintext) expect(bytes.every((byte) => byte === 0)).toBe(true);
      const observed = JSON.stringify(native.events);
      expect(observed).not.toContain("synthetic-private-value");
      expect(observed).not.toContain("synthetic-new-value");
      expect(observed).not.toContain(native.root);
      expect(observed).not.toContain("ciphertext");
      native.enrollment.cancel({ type: "credential_enrollment_cancel", requestId: replacement.context.requestId, nonce: replacement.context.nonce });
      expect(native.events.at(-1)).toMatchObject({
        type: "credential_enrollment_cancelled",
        reply: { kind: "unknown", reason: "credential_outcome_unknown" },
      });
    } finally { native.close(); }
  });

  test.each(["denied", "cancelled", "expired", "control-timeout"] as const)("%s after decryption never publishes and wipes pending plaintext", async (mode) => {
    const native = await fixture();
    try {
      const offer = native.offer();
      const commit = native.enrollment.commit({ type: "credential_enrollment_commit", envelope: await envelope(offer) });
      const authorization = await native.authorize(offer.context.requestId);
      const bytes = await native.opened;
      expect(bytes[0]).toBe(115);
      if (mode === "cancelled") {
        native.enrollment.cancel({ type: "credential_enrollment_cancel", requestId: offer.context.requestId, nonce: offer.context.nonce });
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      } else {
        if (mode === "expired") native.setNow(offer.context.expiresAt);
        if (mode === "control-timeout")
          native.setNow(offer.context.expiresAt - 120_000 + CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS);
        native.enrollment.authorized({
          ...authorization, type: "credential_enrollment_authorized",
          allowed: mode !== "denied", reason: mode === "denied" ? "credential_unauthorized" : null,
        });
      }
      await commit;
      expect(native.result(offer.context.requestId)).toEqual({
        kind: "refused",
        reason: mode === "denied" ? "credential_unauthorized" : mode === "cancelled" ? "credential_enrollment_cancelled" : mode === "expired" ? "credential_enrollment_expired" : "credential_owner_offline",
      });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(readdirSync(native.root)).toEqual([]);
      // Late allowed messages cannot resurrect a cancelled/expired consumed nonce.
      native.enrollment.authorized({ ...authorization, type: "credential_enrollment_authorized", allowed: true, reason: null });
      expect(native.sources.currentDescriptor("key")).toBeUndefined();
    } finally { native.close(); }
  });

  test.each(["cancelled", "expired", "disconnected", "new-proof", "shutdown"] as const)("%s while decrypting is rechecked before any publication", async (mode) => {
    const gate = Promise.withResolvers<void>();
    const native = await fixture(gate.promise);
    try {
      const offer = native.offer();
      const commit = native.enrollment.commit({ type: "credential_enrollment_commit", envelope: await envelope(offer) });
      const bytes = await native.opened;
      if (mode === "cancelled") native.enrollment.cancel({ type: "credential_enrollment_cancel", requestId: offer.context.requestId, nonce: offer.context.nonce });
      if (mode === "expired") native.setNow(offer.context.expiresAt);
      if (mode === "disconnected") native.disconnect();
      if (mode === "new-proof") native.enrollment.proved("replacement-epoch", "replacement-proof");
      if (mode === "shutdown") native.enrollment.close();
      gate.resolve();
      await commit;
      expect(native.result(offer.context.requestId)).toEqual({
        kind: "refused",
        reason: mode === "cancelled" ? "credential_enrollment_cancelled" : mode === "expired" ? "credential_enrollment_expired" : mode === "disconnected" ? "credential_owner_offline" : "credential_owner_changed",
      });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(native.events.some((event) => event.type === "credential_enrollment_authorize")).toBe(false);
      expect(readdirSync(native.root)).toEqual([]);
      if (mode === "shutdown")
        await expect(native.key.open(await envelope(offer))).rejects.toMatchObject({ reason: "credential_key_changed" });
    } finally { gate.resolve(); native.close(); }
  });

  const mutations: Record<string, Partial<ServiceCredentialEnrollmentContext>> = {
    version: { version: 2 },
    key: { keyId: "f".repeat(64) },
    machine: { machineId: "another-machine" },
    owner: { ownerId: "another-owner" },
    generation: { ownerGeneration: 8 },
    request: { requestId: randomUUID() },
    epoch: { serverEpoch: "another-epoch" },
    proof: { ownerChallenge: "another-proof" },
    reference: { credentialRef: "another-ref" },
    origin: { origin: "https://other.invalid" },
    nonce: { nonce: randomUUID() },
    expiry: { expiresAt: 1 },
    replace: { replace: true },
    revision: { sourceRevision: randomUUID() },
  };
  test.each(Object.entries(mutations))("changed %s context cannot decrypt or publish", async (name, changes) => {
    const native = await fixture();
    try {
      const offer = native.offer();
      const sealed = await envelope(offer);
      await native.enrollment.commit({ type: "credential_enrollment_commit", envelope: { ...sealed, context: { ...sealed.context, ...changes } } });
      expect(native.result(changes.requestId ?? offer.context.requestId)).toEqual({
        kind: "refused",
        reason: name === "version" ? "credential_key_version_unsupported" : name === "key" ? "credential_key_changed" : name === "owner" || name === "generation" ? "credential_owner_changed" : name === "request" ? "credential_enrollment_unknown" : "credential_target_mismatch",
      });
      expect(native.events.some((event) => event.type === "credential_enrollment_authorize")).toBe(false);
      expect(native.plaintext).toEqual([]);
      expect(readdirSync(native.root)).toEqual([]);
    } finally { native.close(); }
  });

  test("invalid ciphertext consumes the nonce before crypto failure, and replay is closed", async () => {
    const native = await fixture();
    try {
      const offer = native.offer();
      const sealed = await envelope(offer);
      const corrupt = { ...sealed, ciphertext: (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1) };
      await native.enrollment.commit({ type: "credential_enrollment_commit", envelope: corrupt });
      expect(native.result(offer.context.requestId)).toEqual({ kind: "refused", reason: "credential_envelope_invalid" });
      await native.enrollment.commit({ type: "credential_enrollment_commit", envelope: sealed });
      expect(native.result(offer.context.requestId)).toEqual({ kind: "refused", reason: "credential_enrollment_replayed" });
      expect(readdirSync(native.root)).toEqual([]);
    } finally { native.close(); }
  });

  test("fatal UTF8 refusal happens before final authorization and clears the native bytes", async () => {
    const native = await fixture();
    const bytes = Uint8Array.of(0xc3, 0x28);
    try {
      const offer = native.offer();
      const sealed = await sealServiceCredentialEnrollment(offer, bytes);
      await native.enrollment.commit({ type: "credential_enrollment_commit", envelope: sealed });
      expect(native.result(offer.context.requestId)).toEqual({ kind: "refused", reason: "credential_value_invalid" });
      expect((await native.opened).every((byte) => byte === 0)).toBe(true);
      expect(native.events.some((event) => event.type === "credential_enrollment_authorize")).toBe(false);
      expect(readdirSync(native.root)).toEqual([]);
    } finally { bytes.fill(0); native.close(); }
  });

  test("pending capacity refuses excess offers, cancellation/expiry releases capacity, and pre-offer abort prevents late preparation", async () => {
    const native = await fixture();
    try {
      const offers = Array.from({ length: CREDENTIAL_ENROLLMENT_PENDING_LIMIT }, () => native.offer());
      expect(native.prepare().reply).toEqual({ kind: "refused", reason: "credential_enrollment_busy" });
      const first = offers[0]!;
      native.enrollment.cancel({ type: "credential_enrollment_cancel", requestId: first.context.requestId, nonce: first.context.nonce });
      const reclaimed = native.offer();
      native.setNow(reclaimed.context.expiresAt);
      const fresh = native.offer();
      expect(fresh.context.expiresAt).toBeGreaterThan(reclaimed.context.expiresAt);
      const requestId = randomUUID();
      native.enrollment.cancel({ type: "credential_enrollment_cancel", requestId, nonce: null });
      expect(native.prepare(false, { requestId }).reply).toEqual({ kind: "refused", reason: "credential_enrollment_cancelled" });
    } finally { native.close(); }
  });

  test("prepare requires the exact current proof epoch and an owner-only active seat", async () => {
    const native = await fixture();
    try {
      expect(native.prepare(false, { serverEpoch: "wrong-epoch" }).reply).toEqual({ kind: "refused", reason: "credential_target_mismatch" });
      expect(native.prepare(false, { ownerChallenge: "wrong-proof" }).reply).toEqual({ kind: "refused", reason: "credential_target_mismatch" });
      native.enrollment.invalidate("credential_owner_changed");
      expect(native.prepare().reply).toEqual({ kind: "refused", reason: "credential_owner_unproved" });
      native.enrollment.proved(proof.serverEpoch, proof.ownerChallenge);
      const prepared = native.prepare();
      native.enrollment.prepare({ ...prepared.command, requestId: randomUUID() }, false);
      expect(native.events.at(-1)).toMatchObject({ reply: { kind: "refused", reason: "credential_unauthorized" } });
      native.disconnect();
      expect(native.prepare().reply).toEqual({ kind: "refused", reason: "credential_owner_offline" });
    } finally { native.close(); }
  });
});
