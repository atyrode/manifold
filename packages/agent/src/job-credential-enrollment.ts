import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import {
  CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS,
  CREDENTIAL_ENROLLMENT_PENDING_LIMIT,
  CREDENTIAL_ENROLLMENT_REPLAY_LIMIT,
  CREDENTIAL_ENROLLMENT_TTL_MS,
  ServiceCredentialEnrollmentError,
  type JobCommand,
  type JobEvent,
  type ServiceCredentialEnrollmentContext,
  type ServiceCredentialEnrollmentKey,
  type ServiceCredentialEnrollmentRefusal,
} from "@manifold/protocol";
import type { HeldServiceCredentialRegistry } from "./job-credentials.ts";

type Prepare = Extract<JobCommand, { type: "credential_enrollment_prepare" }>;
type Commit = Extract<JobCommand, { type: "credential_enrollment_commit" }>;
type Cancel = Extract<JobCommand, { type: "credential_enrollment_cancel" }>;
type Authorized = Extract<JobCommand, { type: "credential_enrollment_authorized" }>;
type EnrollmentEvent = Extract<
  JobEvent,
  {
    type:
      | "credential_enrollment_prepared"
      | "credential_enrollment_result"
      | "credential_enrollment_cancelled"
      | "credential_enrollment_authorize";
  }
>;
interface PendingEnrollment {
  readonly context: Readonly<ServiceCredentialEnrollmentContext>;
  state: "offered" | "consuming" | "authorizing";
  timer: Timer;
  authorizationTimer?: Timer;
  authorize?: ((reply: Pick<Authorized, "allowed" | "reason">) => void) | undefined;
  plaintext?: Uint8Array | undefined;
  terminalReason?: ServiceCredentialEnrollmentRefusal;
}
interface EnrollmentTombstone {
  readonly nonce: string | null;
  readonly reason: ServiceCredentialEnrollmentRefusal;
  readonly published: boolean;
}

/** Owner-private, memory-only control state. No envelope or plaintext is journaled or logged. */
export class JobCredentialEnrollment {
  private readonly pending = new Map<string, PendingEnrollment>();
  private readonly recent = new Map<string, EnrollmentTombstone>();
  private authority: { serverEpoch: string; ownerChallenge: string } | null = null;
  private closed = false;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      machineId: string;
      ownerId: string;
      ownerGeneration: number;
      sources: HeldServiceCredentialRegistry;
      key: ServiceCredentialEnrollmentKey;
      active(): boolean;
      emit(event: EnrollmentEvent): boolean;
      published(): void;
      /** Native clock; explicit seam for deterministic deadline transition tests. */
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Records the exact latest full-owner proof context, never a caller-selected machine epoch. */
  proved(serverEpoch: string, ownerChallenge: string): void {
    this.invalidate("credential_owner_changed");
    if (!this.closed && this.options.active()) this.authority = { serverEpoch, ownerChallenge };
  }

  invalidate(reason: ServiceCredentialEnrollmentRefusal): void {
    this.authority = null;
    for (const pending of this.pending.values()) this.retire(pending, reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.invalidate("credential_owner_changed");
    this.options.key.close();
    this.recent.clear();
  }

  private send(event: EnrollmentEvent): boolean {
    try {
      return this.options.emit(event);
    } catch {
      // The generic owner refusal path must never see filesystem/crypto/sink exceptions here.
      return false;
    }
  }

  private remember(requestId: string, tombstone: EnrollmentTombstone): void {
    this.recent.delete(requestId);
    this.recent.set(requestId, tombstone);
    if (this.recent.size > CREDENTIAL_ENROLLMENT_REPLAY_LIMIT)
      this.recent.delete(this.recent.keys().next().value!);
  }

  private retire(
    pending: PendingEnrollment,
    reason: ServiceCredentialEnrollmentRefusal,
    published = false,
  ): void {
    if (this.pending.get(pending.context.requestId) !== pending) return;
    pending.terminalReason = reason;
    clearTimeout(pending.timer);
    clearTimeout(pending.authorizationTimer);
    pending.plaintext?.fill(0);
    pending.plaintext = undefined;
    this.pending.delete(pending.context.requestId);
    this.remember(pending.context.requestId, {
      nonce: pending.context.nonce,
      reason:
        pending.state !== "offered" &&
        reason !== "credential_enrollment_expired" &&
        reason !== "credential_enrollment_cancelled"
          ? "credential_enrollment_replayed"
          : reason,
      published,
    });
    pending.authorize?.({ allowed: false, reason });
    pending.authorize = undefined;
  }

  private check(pending: PendingEnrollment): void {
    if (pending.terminalReason) throw new ServiceCredentialEnrollmentError(pending.terminalReason);
    if (this.now() >= pending.context.expiresAt)
      throw new ServiceCredentialEnrollmentError("credential_enrollment_expired");
    if (this.closed) throw new ServiceCredentialEnrollmentError("credential_owner_changed");
    if (!this.options.active())
      throw new ServiceCredentialEnrollmentError("credential_owner_offline");
    if (
      !this.authority ||
      this.authority.serverEpoch !== pending.context.serverEpoch ||
      this.authority.ownerChallenge !== pending.context.ownerChallenge
    )
      throw new ServiceCredentialEnrollmentError("credential_owner_changed");
    if (this.pending.get(pending.context.requestId) !== pending)
      throw new ServiceCredentialEnrollmentError("credential_enrollment_replayed");
  }

  prepare(command: Prepare, ownerOnly = true): void {
    try {
      if (!ownerOnly) throw new ServiceCredentialEnrollmentError("credential_unauthorized");
      if (this.closed || !this.options.active())
        throw new ServiceCredentialEnrollmentError("credential_owner_offline");
      if (!this.authority) throw new ServiceCredentialEnrollmentError("credential_owner_unproved");
      if (
        command.machineId !== this.options.machineId ||
        command.serverEpoch !== this.authority.serverEpoch ||
        command.ownerChallenge !== this.authority.ownerChallenge
      )
        throw new ServiceCredentialEnrollmentError("credential_target_mismatch");
      for (const pending of this.pending.values())
        if (this.now() >= pending.context.expiresAt)
          this.retire(pending, "credential_enrollment_expired");
      const previous = this.recent.get(command.requestId);
      if (previous) throw new ServiceCredentialEnrollmentError(previous.reason);
      if (this.pending.has(command.requestId))
        throw new ServiceCredentialEnrollmentError("credential_enrollment_replayed");
      if (this.pending.size >= CREDENTIAL_ENROLLMENT_PENDING_LIMIT)
        throw new ServiceCredentialEnrollmentError("credential_enrollment_busy");
      const sourceRevision = this.options.sources.prepare(
        command.credentialRef,
        command.origin,
        command.replace,
      );
      const key = this.options.key.metadata;
      const context = Object.freeze({
        version: key.version,
        suite: key.suite,
        keyId: key.keyId,
        machineId: command.machineId,
        ownerId: this.options.ownerId,
        ownerGeneration: this.options.ownerGeneration,
        requestId: command.requestId,
        serverEpoch: command.serverEpoch,
        ownerChallenge: command.ownerChallenge,
        credentialRef: command.credentialRef,
        origin: command.origin,
        nonce: randomUUID(),
        expiresAt: this.now() + CREDENTIAL_ENROLLMENT_TTL_MS,
        replace: command.replace,
        sourceRevision,
      });
      const pending: PendingEnrollment = {
        context,
        state: "offered",
        timer: setTimeout(() => {
          if (this.pending.get(command.requestId) === pending)
            this.retire(pending, "credential_enrollment_expired");
        }, CREDENTIAL_ENROLLMENT_TTL_MS),
      };
      pending.timer.unref();
      this.pending.set(command.requestId, pending);
      if (
        !this.send({
          type: "credential_enrollment_prepared",
          requestId: command.requestId,
          reply: { kind: "prepared", challenge: { context, key } },
        })
      )
        this.retire(pending, "credential_owner_offline");
    } catch (error) {
      this.send({
        type: "credential_enrollment_prepared",
        requestId: command.requestId,
        reply: {
          kind: "refused",
          reason:
            error instanceof ServiceCredentialEnrollmentError
              ? error.reason
              : "credential_source_invalid",
        },
      });
    }
  }

  async commit(command: Commit, ownerOnly = true): Promise<void> {
    const context = command.envelope.context;
    const pending = this.pending.get(context.requestId);
    let plaintext: Uint8Array | undefined;
    try {
      if (!ownerOnly) throw new ServiceCredentialEnrollmentError("credential_unauthorized");
      if (
        context.ownerId !== this.options.ownerId ||
        context.ownerGeneration !== this.options.ownerGeneration
      )
        throw new ServiceCredentialEnrollmentError("credential_owner_changed");
      const key = this.options.key.metadata;
      if (context.version !== key.version)
        throw new ServiceCredentialEnrollmentError("credential_key_version_unsupported");
      if (context.keyId !== key.keyId || context.suite !== key.suite)
        throw new ServiceCredentialEnrollmentError("credential_key_changed");
      if (!pending) {
        const recent = this.recent.get(context.requestId);
        throw new ServiceCredentialEnrollmentError(
          recent?.reason ?? "credential_enrollment_unknown",
        );
      }
      this.check(pending);
      if (pending.state !== "offered")
        throw new ServiceCredentialEnrollmentError("credential_enrollment_replayed");
      const expected = pending.context;
      if (context.version !== expected.version)
        throw new ServiceCredentialEnrollmentError("credential_key_version_unsupported");
      if (context.keyId !== expected.keyId || context.suite !== expected.suite)
        throw new ServiceCredentialEnrollmentError("credential_key_changed");
      if (
        context.ownerId !== expected.ownerId ||
        context.ownerGeneration !== expected.ownerGeneration
      )
        throw new ServiceCredentialEnrollmentError("credential_owner_changed");
      if (
        context.machineId !== expected.machineId ||
        context.serverEpoch !== expected.serverEpoch ||
        context.ownerChallenge !== expected.ownerChallenge ||
        context.credentialRef !== expected.credentialRef ||
        context.origin !== expected.origin ||
        context.requestId !== expected.requestId ||
        context.nonce !== expected.nonce ||
        context.expiresAt !== expected.expiresAt ||
        context.replace !== expected.replace ||
        context.sourceRevision !== expected.sourceRevision
      )
        throw new ServiceCredentialEnrollmentError("credential_target_mismatch");
      // Consumption precedes every crypto await. Never store the envelope for retries.
      pending.state = "consuming";
      plaintext = await this.options.key.open(command.envelope);
      this.check(pending);
      if (!isUtf8(plaintext))
        throw new ServiceCredentialEnrollmentError("credential_value_invalid");
      pending.plaintext = plaintext;
      pending.state = "authorizing";
      const authorization = Promise.withResolvers<Pick<Authorized, "allowed" | "reason">>();
      pending.authorize = authorization.resolve;
      const authorizationExpiresAt = this.now() + CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS;
      pending.authorizationTimer = setTimeout(() => {
        this.retire(pending, "credential_owner_offline");
      }, CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS);
      pending.authorizationTimer.unref();
      if (
        !this.send({
          type: "credential_enrollment_authorize",
          requestId: context.requestId,
          nonce: context.nonce,
        })
      )
        this.retire(pending, "credential_owner_offline");
      const authorized = await authorization.promise;
      this.check(pending);
      if (this.now() >= authorizationExpiresAt)
        throw new ServiceCredentialEnrollmentError("credential_owner_offline");
      if (!authorized.allowed)
        throw new ServiceCredentialEnrollmentError(authorized.reason ?? "credential_unauthorized");
      const publication = this.options.sources.publish(
        expected.credentialRef,
        expected.origin,
        expected.replace,
        expected.sourceRevision,
        plaintext,
      );
      this.retire(pending, "credential_enrollment_replayed", true);
      let refreshed = true;
      try {
        // The descriptor is current before availability or an installation is announced.
        this.options.published();
      } catch {
        refreshed = false;
      }
      this.send({
        type: "credential_enrollment_result",
        requestId: context.requestId,
        reply:
          publication.durable && refreshed
            ? {
                kind: "stored",
                credentialRef: expected.credentialRef,
                available: true,
                replaced: publication.replaced,
                sourceRevision: publication.sourceRevision,
              }
            : { kind: "unknown", reason: "credential_outcome_unknown" },
      });
    } catch (error) {
      const reason =
        pending?.terminalReason ??
        (error instanceof ServiceCredentialEnrollmentError
          ? error.reason
          : "credential_envelope_invalid");
      if (ownerOnly && pending && this.pending.get(context.requestId) === pending)
        this.retire(pending, reason);
      this.send({
        type: "credential_enrollment_result",
        requestId: context.requestId,
        reply: { kind: "refused", reason },
      });
    } finally {
      plaintext?.fill(0);
    }
  }

  authorized(command: Authorized, ownerOnly = true): void {
    const pending = this.pending.get(command.requestId);
    if (ownerOnly && pending?.state === "authorizing" && pending.context.nonce === command.nonce) {
      const resolve = pending.authorize;
      pending.authorize = undefined;
      resolve?.({ allowed: command.allowed, reason: command.reason });
    }
  }

  cancel(command: Cancel, ownerOnly = true): void {
    try {
      if (!ownerOnly) throw new ServiceCredentialEnrollmentError("credential_unauthorized");
      const pending = this.pending.get(command.requestId);
      const recent = this.recent.get(command.requestId);
      if (command.nonce !== null && command.nonce !== (pending?.context.nonce ?? recent?.nonce))
        throw new ServiceCredentialEnrollmentError("credential_enrollment_unknown");
      if (recent?.published) {
        this.send({
          type: "credential_enrollment_cancelled",
          requestId: command.requestId,
          reply: { kind: "unknown", reason: "credential_outcome_unknown" },
        });
        return;
      }
      if (pending) this.retire(pending, "credential_enrollment_cancelled");
      else if (!recent)
        this.remember(command.requestId, {
          nonce: command.nonce,
          reason: "credential_enrollment_cancelled",
          published: false,
        });
      this.send({
        type: "credential_enrollment_cancelled",
        requestId: command.requestId,
        reply: { kind: "cancelled" },
      });
    } catch (error) {
      this.send({
        type: "credential_enrollment_cancelled",
        requestId: command.requestId,
        reply: {
          kind: "refused",
          reason:
            error instanceof ServiceCredentialEnrollmentError
              ? error.reason
              : "credential_enrollment_unknown",
        },
      });
    }
  }
}
