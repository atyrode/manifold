import {
  CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES,
  CREDENTIAL_ENROLLMENT_VERSION,
  ServiceConfigurationReadSchema,
  ServiceCredentialEnrollmentCancelReplySchema,
  ServiceCredentialEnrollmentCommitReplySchema,
  ServiceCredentialEnrollmentError,
  ServiceCredentialEnrollmentPrepareArgsSchema,
  ServiceCredentialEnrollmentPrepareReplySchema,
  sealServiceCredentialEnrollment,
  type ServiceCredentialEnrollmentCancelArgs,
  type ServiceCredentialEnrollmentChallenge,
  type ServiceCredentialEnrollmentCommitArgs,
  type ServiceCredentialEnrollmentEnvelope,
  type ServiceCredentialEnrollmentPrepareArgs,
  type ServiceCredentialEnrollmentRefusal,
} from "@manifold/protocol";
import { ActionHttpError, ActionProtocolError, discoverActions, invokeAction } from "@manifold/sdk";
import { selectedInstanceOrigin } from "@manifold/plugin/instance";
import { identityExpired, loadIdentity } from "./identity-storage.ts";

const ACTIONS = {
  read: "engine.services.readConfiguration",
  prepare: "engine.services.prepareCredentialEnrollment",
  commit: "engine.services.commitCredentialEnrollment",
  cancel: "engine.services.cancelCredentialEnrollment",
} as const;

const REFUSAL_WORDS: Record<ServiceCredentialEnrollmentRefusal, string> = {
  credential_unauthorized: "Your current root and exact-machine authority are required. Return to the ordinary workspace to sign in.",
  credential_machine_unknown: "The selected machine is not known to this hub.",
  credential_owner_offline: "The native owner is offline. No value was accepted.",
  credential_owner_unproved: "The native owner has not proved its current identity.",
  credential_protocol_unsupported: "This hub or native owner does not support sealed credential enrollment. Update through the ordinary operator flow.",
  credential_key_unavailable: "The native owner's enrollment key is unavailable.",
  credential_key_version_unsupported: "The native owner's enrollment key version is not supported.",
  credential_key_changed: "The native owner's key changed. Refresh metadata and prepare a new challenge.",
  credential_reference_unknown: "This credential reference is not declared by the native owner.",
  credential_origin_disallowed: "This use origin is not approved for the credential reference.",
  credential_already_held: "A value is already held. Replacement requires an explicit replacement decision.",
  credential_source_unavailable: "The declared owner-local source is unavailable.",
  credential_source_read_only: "The declared owner-local source is read-only and cannot be enrolled here.",
  credential_source_changed: "The owner-local source changed. Refresh metadata before an explicit new attempt.",
  credential_source_invalid: "The declared owner-local source cannot safely accept this value.",
  credential_enrollment_busy: "The native owner is busy with bounded enrollment work. Prepare a new challenge later.",
  credential_enrollment_expired: "The challenge expired. The input was cleared; prepare a new challenge.",
  credential_enrollment_replayed: "This challenge has already been consumed. It cannot be retried.",
  credential_enrollment_unknown: "This challenge is no longer known to the current owner.",
  credential_enrollment_cancelled: "This enrollment was cancelled. The input was cleared.",
  credential_envelope_invalid: "The sealed enrollment was refused as invalid. No automatic retry is made.",
  credential_value_invalid: "Enter between 1 and 16,384 UTF-8 bytes. The invalid input was cleared.",
  credential_storage_failed: "The native owner could not publish the declared credential source.",
  credential_owner_changed: "The native owner changed. Refresh metadata and prepare against its new incarnation.",
  credential_target_mismatch: "The challenge does not match the selected machine, reference and approved use origin.",
};

class PrivateEntryFailure extends Error {
  constructor(readonly reason: "unauthorized" | "unreachable" | "invalid_response" | "unsupported" | "worker_unsupported") {
    super(reason);
  }
}

type ReplySchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

const form = document.querySelector<HTMLFormElement>("#credential-form")!;
const input = document.querySelector<HTMLInputElement>("#credential-value")!;
const replace = document.querySelector<HTMLInputElement>("#credential-replace")!;
const prepareButton = document.querySelector<HTMLButtonElement>("#credential-prepare")!;
const storeButton = document.querySelector<HTMLButtonElement>("#credential-store")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#credential-cancel")!;
const refreshButton = document.querySelector<HTMLButtonElement>("#credential-refresh")!;
const status = document.querySelector<HTMLElement>("#credential-status")!;
const validation = document.querySelector<HTMLElement>("#credential-validation")!;
const challengeStatus = document.querySelector<HTMLElement>("#credential-challenge")!;
const availability = document.querySelector<HTMLElement>("#credential-availability")!;

// Public target hints are not authority. In particular, no query parameter chooses the hub.
const params = new URLSearchParams(window.location.search);
const parsedTarget = ServiceCredentialEnrollmentPrepareArgsSchema.safeParse({
  machineId: params.get("machineId"),
  credentialRef: params.get("credentialRef"),
  origin: params.get("origin"),
  replace: false,
});
window.name = "";
window.opener = null;
window.history.replaceState(null, "", "/credential-entry.html");
const hub = selectedInstanceOrigin();
const identity = loadIdentity(hub);
const target = parsedTarget.success ? parsedTarget.data : null;
document.querySelector<HTMLElement>("#credential-hub")!.textContent = hub;
if (target !== null) {
  document.querySelector<HTMLElement>("#credential-machine")!.textContent = target.machineId;
  document.querySelector<HTMLElement>("#credential-reference")!.textContent = target.credentialRef;
  document.querySelector<HTMLElement>("#credential-origin")!.textContent = target.origin;
}

let retired = false;
let ready = false;
let discovered = false;
let needsRefresh = true;
let held = false;
let busy: "metadata" | "prepare" | "commit" | "cancel" | null = "metadata";
let pendingCommit = false;
let epoch = 0;
let challenge: ServiceCredentialEnrollmentChallenge | null = null;
let expiryTimer: number | undefined;
let plaintext: Uint8Array | null = null;

function clearInput(): void {
  input.value = "";
  input.defaultValue = "";
  input.setCustomValidity("");
  plaintext?.fill(0);
  plaintext = null;
}

function controls(): void {
  prepareButton.disabled = retired || !ready || needsRefresh || busy !== null || pendingCommit || challenge !== null;
  replace.disabled = retired || !ready || busy !== null || pendingCommit || challenge !== null;
  input.disabled = retired || challenge === null || busy !== null || pendingCommit;
  storeButton.disabled = input.disabled;
  refreshButton.disabled = retired || busy !== null || pendingCommit;
  cancelButton.disabled = retired;
}

function dropChallenge(): ServiceCredentialEnrollmentChallenge | null {
  const current = challenge;
  challenge = null;
  clearInput();
  window.clearTimeout(expiryTimer);
  expiryTimer = undefined;
  challengeStatus.textContent = "";
  controls();
  return current;
}

function currentIdentity(): boolean {
  const current = loadIdentity(hub);
  return identity !== null && current !== null && !identityExpired(current) &&
    current.token === identity.token && selectedInstanceOrigin() === hub;
}

async function request<T>(name: string, args: unknown, schema: ReplySchema<T>): Promise<T> {
  if (identity === null) throw new PrivateEntryFailure("unauthorized");
  const { outcome } = await invokeAction(
    { origin: hub, token: identity.token, timeoutMs: 10_000, maxResponseBytes: 1024 * 1024 },
    name,
    args,
  );
  if (!outcome.ok) throw new PrivateEntryFailure("unauthorized");
  const parsed = schema.safeParse(outcome.result);
  if (!parsed.success) throw new PrivateEntryFailure("invalid_response");
  return parsed.data;
}

function failureWords(error: unknown): string {
  if (error instanceof ServiceCredentialEnrollmentError) return REFUSAL_WORDS[error.reason];
  if (error instanceof ActionProtocolError ||
    (error instanceof PrivateEntryFailure && error.reason === "unsupported")) {
    return "The selected hub's discovered protocol does not support this entry. Use the ordinary update flow.";
  }
  if ((error instanceof ActionHttpError && (error.status === 401 || error.status === 403)) ||
    (error instanceof PrivateEntryFailure && error.reason === "unauthorized")) {
    return REFUSAL_WORDS.credential_unauthorized;
  }
  if (error instanceof PrivateEntryFailure && error.reason === "worker_unsupported") {
    return "The current root worker has not proved private-document bypass support. Return to the ordinary workspace, accept its update activation, then reopen this entry.";
  }
  if (error instanceof PrivateEntryFailure && error.reason === "invalid_response") {
    return "The selected hub returned an invalid enrollment response. The entry is closed; no automatic retry is made.";
  }
  // Never echo transport, crypto, validation or provider error strings into the document/logs.
  return "The outcome could not be confirmed. The input was cleared. Refresh reference metadata before a new attempt; no automatic retry is made.";
}

async function cancelChallenge(current: ServiceCredentialEnrollmentChallenge, stamp: number, notify: boolean): Promise<void> {
  const args: ServiceCredentialEnrollmentCancelArgs = {
    machineId: current.context.machineId,
    requestId: current.context.requestId,
    nonce: current.context.nonce,
  };
  try {
    const reply = await request(ACTIONS.cancel, args, ServiceCredentialEnrollmentCancelReplySchema);
    if (!notify || stamp !== epoch || retired) return;
    status.textContent = reply.kind === "cancelled"
      ? "The native owner confirmed cancellation. The input and working bytes were cleared."
      : reply.kind === "refused"
        ? REFUSAL_WORDS[reply.reason]
        : "Cancellation outcome is unconfirmed. Refresh reference metadata before preparing again.";
  } catch (error: unknown) {
    if (notify && stamp === epoch && !retired) status.textContent = failureWords(error);
  } finally {
    if (notify && stamp === epoch && !retired) {
      busy = null;
      controls();
    }
  }
}

function retire(message: string): void {
  if (retired) return;
  retired = true;
  epoch++;
  busy = null;
  const current = dropChallenge();
  status.textContent = message;
  validation.textContent = "";
  if (current !== null) void cancelChallenge(current, epoch, false);
}

/** A direct URL has the same fail-closed old-worker boundary as the manager launcher. */
async function requirePrivateBypass(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const controller = navigator.serviceWorker.controller;
  if (controller === null) return; // No controller: the document and graph are network-only.
  const supported = await new Promise<boolean>((resolve) => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => finish(false), 2000);
    const finish = (value: boolean): void => {
      window.clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(value);
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      finish(data !== null && typeof data === "object" &&
        Reflect.get(data, "type") === "manifold.private-credential-bypass" &&
        Reflect.get(data, "version") === 1 && Reflect.get(data, "supported") === true);
    };
    try {
      controller.postMessage({ type: "manifold.private-credential-bypass", version: 1 }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
  if (!supported || navigator.serviceWorker.controller !== controller) {
    throw new PrivateEntryFailure("worker_unsupported");
  }
}

async function readMetadata(): Promise<void> {
  if (retired || pendingCommit || target === null || identity === null) return;
  if (!currentIdentity()) {
    retire("Your selected hub or sign-in changed or expired. Reopen from the ordinary workspace.");
    return;
  }
  const stamp = ++epoch;
  busy = "metadata";
  ready = false;
  needsRefresh = true;
  const previous = dropChallenge();
  if (previous !== null) void cancelChallenge(previous, stamp, false);
  validation.textContent = "";
  status.textContent = "Reading current authorized credential-reference metadata…";
  controls();
  try {
    await requirePrivateBypass();
    if (!currentIdentity()) throw new PrivateEntryFailure("unauthorized");
    if (!discovered) {
      const protocol = await discoverActions({ origin: hub, token: identity.token, timeoutMs: 10_000, maxResponseBytes: 4 * 1024 * 1024 });
      if (!Object.values(ACTIONS).every((name) => protocol.actions.some((action) => action.name === name))) {
        throw new PrivateEntryFailure("unsupported");
      }
      discovered = true;
    }
    if (stamp !== epoch || retired) return;
    if (!currentIdentity()) throw new PrivateEntryFailure("unauthorized");
    const metadata = await request(ACTIONS.read, { machineId: target.machineId }, ServiceConfigurationReadSchema);
    if (stamp !== epoch || retired) return;
    if (!currentIdentity()) throw new PrivateEntryFailure("unauthorized");
    if (!metadata.connected) throw new ServiceCredentialEnrollmentError("credential_owner_offline");
    const references = metadata.credentialReferences.filter((reference) => reference.ref === target.credentialRef);
    if (references.length !== 1) throw new ServiceCredentialEnrollmentError("credential_reference_unknown");
    const reference = references[0]!;
    if (!reference.origins.includes(target.origin)) throw new ServiceCredentialEnrollmentError("credential_origin_disallowed");
    held = reference.available;
    availability.textContent = held ? "A value is held; explicit replacement is required" : "No value is currently held";
    ready = true;
    needsRefresh = false;
    status.textContent = "Metadata verified. Prepare a single-use challenge before entering a value.";
  } catch (error: unknown) {
    if (stamp === epoch && !retired) {
      status.textContent = failureWords(error);
      if ((error instanceof PrivateEntryFailure && ["unauthorized", "unsupported", "worker_unsupported", "invalid_response"].includes(error.reason)) ||
        error instanceof ActionProtocolError ||
        (error instanceof ActionHttpError && (error.status === 401 || error.status === 403))) {
        retire(failureWords(error));
      }
    }
  } finally {
    if (stamp === epoch && !retired) {
      busy = null;
      controls();
    }
  }
}

async function prepare(): Promise<void> {
  if (retired || !ready || needsRefresh || target === null || busy !== null || pendingCommit || challenge !== null) return;
  clearInput();
  if (!currentIdentity()) {
    retire("Your selected hub or sign-in changed or expired. Reopen from the ordinary workspace.");
    return;
  }
  if (held && !replace.checked) {
    validation.textContent = "A value is already held. Explicitly confirm replacement before preparing.";
    replace.focus();
    return;
  }
  const args: ServiceCredentialEnrollmentPrepareArgs = { ...target, replace: replace.checked };
  const stamp = ++epoch;
  busy = "prepare";
  validation.textContent = "";
  status.textContent = "Preparing a bounded, single-use challenge with the current proved native owner…";
  controls();
  try {
    const reply = await request(ACTIONS.prepare, args, ServiceCredentialEnrollmentPrepareReplySchema);
    if (stamp !== epoch || retired) {
      if (reply.kind === "prepared") void cancelChallenge(reply.challenge, epoch, false);
      return;
    }
    if (!currentIdentity()) {
      if (reply.kind === "prepared") void cancelChallenge(reply.challenge, stamp, false);
      retire("Your selected hub or sign-in changed. The entry was cleared; reopen from the ordinary workspace.");
      return;
    }
    if (reply.kind !== "prepared") {
      needsRefresh = true;
      status.textContent = reply.kind === "refused" ? REFUSAL_WORDS[reply.reason] : "Preparation outcome is unconfirmed. Refresh metadata before preparing again.";
      if (reply.kind === "refused" && reply.reason === "credential_unauthorized") retire(REFUSAL_WORDS[reply.reason]);
      return;
    }
    challenge = reply.challenge;
    const { context, key } = challenge;
    if (context.machineId !== args.machineId || context.credentialRef !== args.credentialRef ||
      context.origin !== args.origin || context.replace !== args.replace) {
      throw new ServiceCredentialEnrollmentError("credential_target_mismatch");
    }
    if (context.version !== CREDENTIAL_ENROLLMENT_VERSION || key.version !== CREDENTIAL_ENROLLMENT_VERSION) {
      throw new ServiceCredentialEnrollmentError("credential_key_version_unsupported");
    }
    if (context.keyId !== key.keyId) throw new ServiceCredentialEnrollmentError("credential_key_changed");
    if (context.expiresAt <= Date.now()) throw new ServiceCredentialEnrollmentError("credential_enrollment_expired");
    challengeStatus.textContent = `Owner ${context.ownerId} · incarnation ${context.ownerGeneration} · expires ${new Date(context.expiresAt).toLocaleTimeString()}`;
    expiryTimer = window.setTimeout(() => {
      epoch++;
      const expired = dropChallenge();
      busy = null;
      needsRefresh = true;
      status.textContent = REFUSAL_WORDS.credential_enrollment_expired;
      controls();
      if (expired !== null) void cancelChallenge(expired, epoch, false);
    }, context.expiresAt - Date.now());
    status.textContent = "Challenge prepared. Enter the value only in this private document, then seal and store it.";
  } catch (error: unknown) {
    if (stamp === epoch && !retired) {
      needsRefresh = true;
      const previous = dropChallenge();
      if (previous !== null) void cancelChallenge(previous, stamp, false);
      status.textContent = failureWords(error);
      if ((error instanceof ActionHttpError && (error.status === 401 || error.status === 403)) ||
        (error instanceof PrivateEntryFailure && error.reason === "unauthorized")) retire(failureWords(error));
    }
  } finally {
    if (stamp === epoch && !retired) {
      busy = null;
      controls();
      if (challenge !== null) input.focus();
    }
  }
}

async function commit(): Promise<void> {
  const current = challenge;
  const stamp = epoch;
  if (retired || current === null || target === null || busy !== null || pendingCommit) {
    if (!pendingCommit) clearInput();
    return;
  }
  pendingCommit = true;
  let bytes: Uint8Array | null = null;
  let envelope: ServiceCredentialEnrollmentEnvelope | null = null;
  try {
    if (!currentIdentity()) {
      retire("Your selected hub or sign-in changed or expired. The input was cleared; reopen from the ordinary workspace.");
      return;
    }
    if (Date.now() >= current.context.expiresAt) throw new ServiceCredentialEnrollmentError("credential_enrollment_expired");
    bytes = new Uint8Array(CREDENTIAL_ENROLLMENT_MAX_VALUE_BYTES);
    plaintext = bytes;
    const encoded = new TextEncoder().encodeInto(input.value, bytes);
    const complete = encoded.read === input.value.length && encoded.written > 0;
    // No await, state copy, attribute, URL, storage or message ever receives the input string.
    input.value = "";
    input.defaultValue = "";
    if (!complete) throw new ServiceCredentialEnrollmentError("credential_value_invalid");
    busy = "commit";
    validation.textContent = "";
    status.textContent = "Sealing for the native owner. The DOM input has been cleared…";
    controls();
    envelope = await sealServiceCredentialEnrollment(current, bytes.subarray(0, encoded.written));
    bytes.fill(0);
    plaintext = null;
    if (stamp !== epoch || retired) return;
    if (!currentIdentity()) {
      retire("Your selected hub or sign-in changed. The entry was cleared; reopen from the ordinary workspace.");
      return;
    }
    if (Date.now() >= current.context.expiresAt) throw new ServiceCredentialEnrollmentError("credential_enrollment_expired");
    status.textContent = "Requesting native publication under your current authority…";
    const args: ServiceCredentialEnrollmentCommitArgs = { machineId: target.machineId, envelope };
    const reply = await request(ACTIONS.commit, args, ServiceCredentialEnrollmentCommitReplySchema);
    if (stamp !== epoch || retired) return;
    if (reply.kind === "stored" && reply.credentialRef !== target.credentialRef) {
      throw new PrivateEntryFailure("invalid_response");
    }
    epoch++;
    dropChallenge();
    replace.checked = false;
    needsRefresh = reply.kind !== "stored";
    if (reply.kind === "stored") {
      held = true;
      availability.textContent = "A value is held; explicit replacement is required";
      status.textContent = reply.replaced
        ? "The native owner confirmed explicit replacement. This document retains no value."
        : "The native owner confirmed initial enrollment. This document retains no value.";
    } else if (reply.kind === "refused") {
      status.textContent = REFUSAL_WORDS[reply.reason];
      if (reply.reason === "credential_unauthorized") retire(REFUSAL_WORDS[reply.reason]);
    } else {
      status.textContent = "Publication outcome is unconfirmed. Refresh reference metadata before a new attempt; do not automatically retry this challenge.";
    }
  } catch (error: unknown) {
    if (stamp === epoch && !retired) {
      epoch++;
      needsRefresh = true;
      const previous = dropChallenge();
      if (previous !== null) void cancelChallenge(previous, epoch, false);
      status.textContent = failureWords(error);
      if (error instanceof ServiceCredentialEnrollmentError && error.reason === "credential_value_invalid") {
        validation.textContent = REFUSAL_WORDS.credential_value_invalid;
      }
      if ((error instanceof ActionHttpError && (error.status === 401 || error.status === 403)) ||
        (error instanceof PrivateEntryFailure && error.reason === "unauthorized")) retire(failureWords(error));
    }
  } finally {
    bytes?.fill(0);
    bytes = null;
    envelope = null;
    clearInput();
    pendingCommit = false;
    if (busy === "commit") busy = null;
    controls();
  }
}

function cancel(): void {
  if (retired) return;
  const stamp = ++epoch;
  const current = dropChallenge();
  needsRefresh = true;
  busy = current === null ? null : "cancel";
  status.textContent = current === null
    ? "The entry was cleared. Any late preparation response will be cancelled; refresh metadata before a new attempt."
    : "The input was cleared. Asking the native owner to cancel the single-use challenge…";
  validation.textContent = "";
  replace.checked = false;
  controls();
  if (current !== null) void cancelChallenge(current, stamp, true);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void commit();
});
prepareButton.addEventListener("click", () => { void prepare(); });
cancelButton.addEventListener("click", cancel);
refreshButton.addEventListener("click", () => { void readMetadata(); });
input.addEventListener("input", () => { validation.textContent = ""; });
window.addEventListener("storage", () => {
  if (!currentIdentity()) retire("Your selected hub or sign-in changed. The entry was cleared; reopen from the ordinary workspace.");
});
window.addEventListener("offline", cancel);
window.addEventListener("pagehide", () => retire("This entry was closed and its input cleared."));
window.addEventListener("pageshow", (event) => {
  if (event.persisted) retire("A restored document cannot reuse an enrollment challenge. Reopen from the ordinary workspace.");
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => retire("The root worker changed. The entry was cleared; reopen from the ordinary workspace."));
}
if (identity?.expiresInMs !== undefined && identity.receivedAt !== undefined) {
  window.setTimeout(() => retire("Your local sign-in expired. The entry was cleared; return to the ordinary workspace to sign in."),
    Math.max(0, identity.expiresInMs - (Date.now() - identity.receivedAt)));
}

clearInput();
if (window.top !== window) {
  retire("Private credential entry cannot run inside a frame. Open it from the ordinary plugin manager.");
} else if (target === null) {
  retire("Open a declared credential reference from the ordinary plugin manager. No credential value can be entered without a verified target.");
} else if (identity === null || identityExpired(identity)) {
  retire(REFUSAL_WORDS.credential_unauthorized);
} else {
  void readMetadata();
}
controls();
