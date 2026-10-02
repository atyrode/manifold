import "../src/shared-modules.ts";
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { attachServerGuest, defineServerAction } from "../../plugin-kit/src/server.ts";
import {
  canonicalJobJson,
  formatManifoldUri,
  JobCommandSchema,
  IsolateCtxMethodSchema,
  JobEventSchema,
  JOB_OWNER_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  CREDENTIAL_ENROLLMENT_TTL_MS,
  CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS,
  CREDENTIAL_ENROLLMENT_PENDING_LIMIT,
  createServiceCredentialEnrollmentKey,
  sealServiceCredentialEnrollment,
  type ServiceCredentialEnrollmentChallenge,
  type ServiceCredentialEnrollmentContext,
  type ServiceCredentialEnrollmentEnvelope,
  type ServiceCredentialEnrollmentPrepareReply,
  type ServiceCredentialEnrollmentCommitReply,
  type LogEvent,
  type JobCommand,
  MACHINE_SELF_PROVIDER_PROTOCOL_VERSION,
  type JobOwner,
  type MachineHalf,
  type ServicePolicy,
  type ServiceReadArgs,
  type ServiceInvokeArgs,
  type ServiceCharge,
  type JobResourceBindings,
  type Cap,
  type IsolateChildFrame,
  type IsolateHostFrame,
  type PluginManifest,
  type ServiceConfiguration,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { JobService } from "../src/job-service.ts";
import { ServerStore, TRACE_ROW_TYPE } from "../src/stores.ts";
import { FakeClock, FakeRuntime, testPluginHost, testTileTrees } from "./helpers.ts";
import { serviceContext } from "../src/service-doors.ts";
import {
  buildIsolateDef,
  serveCtxCall,
  type IsolateDispatchOutcome,
} from "../src/isolate/proxy-def.ts";
import type { ActionCtx, PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { silentLogger } from "../src/log.ts";
import { ActionAuthorityFence } from "../src/action-authority-fence.ts";

import { createExternalRun } from "./agent-fixtures.ts";
const hash = (value: unknown) => createHash("sha256").update(canonicalJobJson(value)).digest("hex");
const policy: ServicePolicy = {
  serviceId: "native.metadata",
  revision: "r1",
  origin: "https://example.invalid",
  allowLoopbackHttp: false,
  credential: { ref: "native-account", header: "Authorization", prefix: "Bearer " },
  maxConcurrent: 2,
  operations: {
    inspect: {
      method: "GET",
      readable: true,
      path: "/metadata",
      input: {
        query: { type: "string", required: true, maxBytes: 64 },
      },
      query: { q: "query" },
      body: [],
      timeoutMs: 1,
      maxRequestBytes: 1024,
      maxResponseBytes: 4096,
      maxResultBytes: 2048,
      response: { kind: "projected-json", fields: [["remaining"]], maxArrayItems: 16 },
    },
  },
};
function fixture(servicePolicy = policy, mode: "read" | "invoke" = "read", path = ":memory:") {
  const policy = servicePolicy;
  const store = new ServerStore(openDatabase(path));
  const runtime = new FakeRuntime();
  const key = "9".repeat(64);
  const auth = new AuthService(store, key, runtime);
  const root = auth.authenticate(key);
  const machineId = auth.enrollMachine("native", root).machine.id;
  const service = new JobService(store, auth, runtime);
  service.setLifecycleRecorder((record) => store.appendTrace(record));
  const pair = generateKeyPairSync("ed25519");
  const owner: JobOwner = {
    protocolVersion: JOB_OWNER_PROTOCOL_VERSION,
    ownerId: "owner",
    generation: 1,
    inventoryDigest: "a".repeat(64),
    platforms: ["linux-x64"],
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    resources: {
      tools: { helper: "b".repeat(64) },
      anchors: {},
      services: { [policy.serviceId]: hash(policy) },
      serviceDefinitions: {
        [policy.serviceId]: {
          revision: policy.revision,
          operationIds: Object.keys(policy.operations),
        },
      },
      credentialReferences: [{ ref: "native-account", origins: [policy.origin!], available: true }],
    },
  };
  const commands: JobCommand[] = [];
  const channel: {
    machineId: string;
    protocolVersion?: number;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  } = {
    machineId,
    send: ({ command }) => {
      commands.push(command);
      return true;
    },
  };
  const prove = (target = service, seat = channel, identity = owner) => {
    target.online(seat, identity, "epoch");
    const challenge = commands.at(-1);
    if (challenge?.type !== "owner_challenge") throw new Error("missing challenge");
    const body = {
      nonce: challenge.nonce,
      serverEpoch: challenge.serverEpoch,
      machineId,
      owner: identity,
    };
    target.event(seat, {
      type: "owner_proof",
      ...body,
      signature: sign(null, Buffer.from(canonicalJobJson(body)), pair.privateKey).toString(
        "base64",
      ),
    });
  };
  const configuration = service.configureServiceConfiguration(root, {
    machineId,
    expectedRevision: null,
    policies: [policy],
  });
  prove();
  const token = auth.mintToken(
    {
      principal: { name: "service caller", kind: "human" },
      caps: [mode === "read" ? "services:read" : "services:invoke"],
    },
    root,
  );
  const reader = auth.authenticate(token.token);
  const args: ServiceReadArgs = {
    machineId,
    serviceId: policy.serviceId,
    revision: policy.revision,
    policySha256: hash(policy),
    operationId: "inspect",
    input: { query: "private-source-input" },
  };
  const pendingCommand = () => {
    const command = commands.findLast(
      (command) => command.type === (mode === "read" ? "service_read" : "service_invoke"),
    );
    if (command?.type !== "service_read" && command?.type !== "service_invoke")
      throw new Error("missing direct service command");
    return command;
  };
  const authorize = (requestId: string, onChannel = channel) =>
    service.event(
      onChannel,
      JobEventSchema.parse({
        type: "service_authorize",
        subject: { kind: mode, requestId },
        authorizationId: `auth-${requestId}`,
        serviceId: args.serviceId,
        revision: args.revision,
        policySha256: args.policySha256,
        operationId: args.operationId,
      }),
    );
  const result = (requestId: string, onChannel = channel) =>
    service.event(
      onChannel,
      JobEventSchema.parse({
        type: mode === "read" ? "service_read_result" : "service_invoke_result",
        requestId,
        reply: { type: "service_result", requestId, ok: true, result: { remaining: 12 } },
      }),
    );
  return {
    store,
    runtime,
    auth,
    root,
    reader,
    service,
    machineId,
    owner,
    commands,
    channel,
    prove,
    args,
    configuration,
    pendingCommand,
    authorize,
    result,
  };
}

async function enrollmentFixture(replace = false) {
  const recipient = await createServiceCredentialEnrollmentKey();
  const f = fixture();
  f.channel.protocolVersion = PROTOCOL_VERSION;
  f.owner.credentialEnrollment = recipient.metadata;
  f.owner.resources!.credentialReferences![0]!.available = false;
  f.prove();
  const args = {
    machineId: f.machineId,
    credentialRef: "native-account",
    origin: policy.origin!,
    replace,
  };
  const prepareCommand = () => {
    const command = f.commands.findLast(
      (command) => command.type === "credential_enrollment_prepare",
    );
    if (command?.type !== "credential_enrollment_prepare") throw new Error("missing preparation");
    return command;
  };
  const offer = (patch: Partial<ServiceCredentialEnrollmentContext> = {}, emit = true) => {
    const command = prepareCommand();
    const challenge: ServiceCredentialEnrollmentChallenge = {
      key: recipient.metadata,
      context: {
        version: recipient.metadata.version,
        suite: recipient.metadata.suite,
        keyId: recipient.metadata.keyId,
        machineId: f.machineId,
        ownerId: f.owner.ownerId,
        ownerGeneration: f.owner.generation,
        requestId: command.requestId,
        serverEpoch: command.serverEpoch,
        ownerChallenge: command.ownerChallenge,
        credentialRef: args.credentialRef,
        origin: args.origin,
        nonce: randomUUID(),
        expiresAt: f.runtime.now() + CREDENTIAL_ENROLLMENT_TTL_MS,
        replace,
        sourceRevision: replace ? randomUUID() : null,
        ...patch,
      },
    };
    if (emit)
      f.service.event(f.channel, {
        type: "credential_enrollment_prepared",
        requestId: command.requestId,
        reply: { kind: "prepared", challenge },
      });
    return challenge;
  };
  const prepare = async (
    caller = f.root,
    patch: Partial<ServiceCredentialEnrollmentContext> = {},
  ) => {
    const pending = f.service.prepareCredentialEnrollment(f.auth.credentialReference(caller), args);
    offer(patch);
    const reply = await pending;
    if (reply.kind !== "prepared") throw new Error(`preparation refused: ${reply.kind}`);
    return reply.challenge;
  };
  const seal = async (challenge: ServiceCredentialEnrollmentChallenge) => {
    const bytes = new TextEncoder().encode("disposable-enrollment-marker");
    try {
      return await sealServiceCredentialEnrollment(challenge, bytes);
    } finally {
      bytes.fill(0);
    }
  };
  const authorize = (
    challenge: ServiceCredentialEnrollmentChallenge,
    nonce = challenge.context.nonce,
  ) =>
    f.service.event(f.channel, {
      type: "credential_enrollment_authorize",
      requestId: challenge.context.requestId,
      nonce,
    });
  const stored = (challenge: ServiceCredentialEnrollmentChallenge, patch = {}) =>
    f.service.event(f.channel, {
      type: "credential_enrollment_result",
      requestId: challenge.context.requestId,
      reply: {
        kind: "stored",
        credentialRef: args.credentialRef,
        available: true,
        replaced: challenge.context.sourceRevision !== null,
        sourceRevision: randomUUID(),
        ...patch,
      },
    });
  const close = () => {
    f.service.offline(f.channel);
    recipient.close();
    f.store.close();
  };
  return {
    ...f,
    recipient,
    enrollmentArgs: args,
    prepareCommand,
    offer,
    prepare,
    seal,
    authorize,
    stored,
    close,
  };
}

test.each([
  ["offline", "credential_owner_offline"],
  ["unproved", "credential_owner_unproved"],
  ["old-owner", "credential_protocol_unsupported"],
  ["retired-owner", "credential_protocol_unsupported"],
  ["old-transport", "credential_protocol_unsupported"],
  ["unknown-transport", "credential_protocol_unsupported"],
  ["no-transport", "credential_protocol_unsupported"],
  ["missing-key", "credential_key_unavailable"],
  ["invalid-key", "credential_key_unavailable"],
  ["key-version", "credential_key_version_unsupported"],
  ["reference", "credential_reference_unknown"],
  ["origin", "credential_origin_disallowed"],
] as const)("credential preparation refuses %s before owner dispatch", async (failure, reason) => {
  const f = await enrollmentFixture();
  try {
    if (failure === "offline") f.service.offline(f.channel);
    if (failure === "unproved") f.service.online(f.channel, f.owner, "epoch");
    if (failure === "old-owner" || failure === "retired-owner") {
      f.owner.protocolVersion = failure === "old-owner" ? 44 : 46;
      if (failure === "old-owner") f.prove();
      else f.service.online(f.channel, f.owner, "epoch");
    }
    if (failure === "old-transport") f.channel.protocolVersion = PROTOCOL_VERSION - 1;
    if (failure === "unknown-transport") f.channel.protocolVersion = PROTOCOL_VERSION + 1;
    if (failure === "no-transport") delete f.channel.protocolVersion;
    if (failure === "missing-key") delete f.owner.credentialEnrollment;
    if (failure === "invalid-key")
      f.owner.credentialEnrollment = { ...f.recipient.metadata, publicKey: "bad-key" };
    if (failure === "key-version")
      f.owner.credentialEnrollment = { ...f.recipient.metadata, version: 2 };
    const args = {
      ...f.enrollmentArgs,
      ...(failure === "reference" ? { credentialRef: "not-declared" } : {}),
      ...(failure === "origin" ? { origin: "https://other.invalid" } : {}),
    };
    expect(
      await f.service.prepareCredentialEnrollment(f.auth.credentialReference(f.root), args),
    ).toEqual({ kind: "refused", reason });
    expect(
      f.commands.filter((command) => command.type === "credential_enrollment_prepare"),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test("enrollment restores root and exact-machine authority, not owner principal or copied caps", async () => {
  const f = await enrollmentFixture();
  try {
    const ownerToken = f.auth.authenticate(
      f.auth.mintToken(
        {
          principalId: f.root.principal.id,
          caps: ["services:configure"],
        },
        f.root,
      ).token,
    );
    const browser = f.auth.authenticate(
      f.auth.bootstrapPrincipal(
        {
          kind: "human",
          name: "credential browser",
        },
        f.root,
      ).token,
    );
    for (const caller of [
      ownerToken,
      { ...browser, caps: [] },
      {
        ...browser,
        authorityScope: [
          {
            target: formatManifoldUri({ kind: "machine", machineId: "wrong-machine" }),
            reach: "node" as const,
            caps: ["services:configure" as const],
          },
        ],
      },
    ]) {
      expect(
        await f.service.prepareCredentialEnrollment(
          f.auth.credentialReference(caller),
          f.enrollmentArgs,
        ),
      ).toEqual({ kind: "refused", reason: "credential_unauthorized" });
    }
    expect(
      await f.service.prepareCredentialEnrollment(f.auth.credentialReference(f.root), {
        ...f.enrollmentArgs,
        machineId: "unknown-machine",
      }),
    ).toEqual({ kind: "refused", reason: "credential_machine_unknown" });
    const narrowed = { ...browser, caps: ["services:configure" as const] };
    const challenge = await f.prepare(narrowed);
    const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(narrowed), {
      machineId: f.machineId,
      envelope: await f.seal(challenge),
    });
    f.authorize(challenge);
    f.stored(challenge);
    expect(await pending).toMatchObject({ kind: "stored", replaced: false });
  } finally {
    f.close();
  }
});

test("a second root token on the same principal cannot take over an existing offer", async () => {
  const f = await enrollmentFixture();
  try {
    const browser = f.auth.authenticate(
      f.auth.bootstrapPrincipal(
        {
          kind: "human",
          name: "credential browser",
        },
        f.root,
      ).token,
    );
    const sibling = f.auth.authenticate(
      f.auth.mintToken(
        {
          principalId: browser.principal.id,
          caps: ["*"],
        },
        f.root,
      ).token,
    );
    const challenge = await f.prepare(browser);
    const envelope = await f.seal(challenge);
    expect(
      await f.service.commitCredentialEnrollment(f.auth.credentialReference(sibling), {
        machineId: f.machineId,
        envelope,
      }),
    ).toEqual({ kind: "refused", reason: "credential_unauthorized" });
    expect(
      await f.service.cancelCredentialEnrollment(f.auth.credentialReference(sibling), {
        machineId: f.machineId,
        requestId: challenge.context.requestId,
        nonce: challenge.context.nonce,
      }),
    ).toEqual({ kind: "refused", reason: "credential_unauthorized" });
    const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(browser), {
      machineId: f.machineId,
      envelope,
    });
    f.authorize(challenge);
    f.stored(challenge);
    expect(await pending).toMatchObject({ kind: "stored" });
  } finally {
    f.close();
  }
});

const enrollmentContextChanges: Partial<ServiceCredentialEnrollmentContext>[] = [
  { version: 2 },
  { keyId: "0".repeat(64) },
  { machineId: "wrong-machine" },
  { ownerId: "another-owner" },
  { ownerGeneration: 2 },
  { requestId: "00000000-0000-4000-8000-000000000001" },
  { serverEpoch: "another-epoch" },
  { ownerChallenge: "another-proof" },
  { credentialRef: "another-reference" },
  { origin: "https://other.invalid" },
  { nonce: "00000000-0000-4000-8000-000000000002" },
  { expiresAt: 1 },
  { replace: true },
  { sourceRevision: "00000000-0000-4000-8000-000000000003" },
];

test.each([
  ...enrollmentContextChanges.filter(
    (patch) => patch.nonce === undefined && patch.expiresAt === undefined,
  ),
  { expiresAt: 0 },
  { expiresAt: CREDENTIAL_ENROLLMENT_TTL_MS + CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS + 1 },
])("owner offer mismatch %j is never published to the caller", async (patch) => {
  const f = await enrollmentFixture();
  try {
    const pending = f.service.prepareCredentialEnrollment(
      f.auth.credentialReference(f.root),
      f.enrollmentArgs,
    );
    f.offer(patch);
    expect(await pending).toEqual({ kind: "refused", reason: "credential_target_mismatch" });
    expect(f.commands.at(-1)).toMatchObject({ type: "credential_enrollment_cancel", nonce: null });
  } finally {
    f.close();
  }
});

test.each(enrollmentContextChanges)(
  "copied commit context mismatch %j never reaches the native owner",
  async (patch) => {
    const f = await enrollmentFixture();
    try {
      const challenge = await f.prepare();
      const envelope = await f.seal(challenge);
      const changed: ServiceCredentialEnrollmentEnvelope = {
        ...envelope,
        context: { ...envelope.context, ...patch },
      };
      expect(
        await f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
          machineId: f.machineId,
          envelope: changed,
        }),
      ).toEqual({
        kind: "refused",
        reason:
          patch.requestId === undefined
            ? "credential_target_mismatch"
            : "credential_enrollment_unknown",
      });
      expect(
        f.commands.filter((command) => command.type === "credential_enrollment_commit"),
      ).toEqual([]);
    } finally {
      f.close();
    }
  },
);

test("mutating the returned offer cannot change the hub's immutable expected context", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare();
    const original = structuredClone(challenge);
    challenge.context.origin = "https://other.invalid";
    challenge.key.keyId = "0".repeat(64);
    const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
      machineId: f.machineId,
      envelope: await f.seal(original),
    });
    f.authorize(original);
    f.stored(original);
    expect(await pending).toMatchObject({ kind: "stored" });
  } finally {
    f.close();
  }
});

test.each(["offer", "authorization", "result"] as const)(
  "live authority withdrawal at %s closes the original enrollment without replay",
  async (phase) => {
    for (const withdrawal of ["revoke", "expire", "attenuate"] as const) {
      const f = await enrollmentFixture();
      try {
        const browser = f.auth.authenticate(
          f.auth.mintToken(
            {
              principal: { kind: "human", name: "credential browser" },
              caps: ["*"],
            },
            f.root,
          ).token,
        );
        if (browser.expiresAt === undefined) throw new Error("missing human expiry");
        f.runtime.time = browser.expiresAt - 1_000;
        const credential = f.auth.credentialReference(browser);
        let offer: ServiceCredentialEnrollmentChallenge;
        let pending: Promise<
          ServiceCredentialEnrollmentPrepareReply | ServiceCredentialEnrollmentCommitReply
        >;
        if (phase === "offer") {
          pending = f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs);
          offer = f.offer({}, false);
        } else {
          offer = await f.prepare(browser);
          pending = f.service.commitCredentialEnrollment(credential, {
            machineId: f.machineId,
            envelope: await f.seal(offer),
          });
          if (phase === "result") f.authorize(offer);
        }
        if (withdrawal === "revoke") f.auth.revokePrincipal(browser.principal.id, f.root);
        if (withdrawal === "expire") {
          f.runtime.time = browser.expiresAt;
          f.service.tick();
        }
        if (withdrawal === "attenuate")
          f.auth.grant(
            {
              principal: { kind: "principal", id: browser.principal.id },
              node: formatManifoldUri({ kind: "machine", machineId: f.machineId }),
              reach: "node",
              effect: "deny",
              caps: ["services:configure"],
            },
            f.root,
          );
        if (phase === "offer")
          f.service.event(f.channel, {
            type: "credential_enrollment_prepared",
            requestId: offer.context.requestId,
            reply: { kind: "prepared", challenge: offer },
          });
        else if (phase === "authorization") f.authorize(offer);
        else f.stored(offer);
        expect(await pending).toEqual(
          phase === "result"
            ? { kind: "unknown", reason: "credential_outcome_unknown" }
            : { kind: "refused", reason: "credential_unauthorized" },
        );
        const allowed = f.commands.filter(
          (command) => command.type === "credential_enrollment_authorized" && command.allowed,
        );
        expect(allowed).toHaveLength(phase === "result" ? 1 : 0);
        f.prove();
        expect(
          f.commands.filter((command) => command.type === "credential_enrollment_commit"),
        ).toHaveLength(phase === "offer" ? 0 : 1);
      } finally {
        f.close();
      }
    }
  },
);

test.each(["offline", "replacement"] as const)(
  "an %s owner channel cancels only its original seat and never migrates a pending envelope",
  async (failure) => {
    for (const authorized of [false, true]) {
      const f = await enrollmentFixture();
      try {
        const challenge = await f.prepare();
        const envelope = await f.seal(challenge);
        const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
          machineId: f.machineId,
          envelope,
        });
        if (authorized) f.authorize(challenge);
        const replacement = { ...f.channel };
        if (failure === "offline") f.service.offline(f.channel);
        else f.prove(f.service, replacement);
        expect(await pending).toEqual(
          authorized
            ? { kind: "unknown", reason: "credential_outcome_unknown" }
            : { kind: "refused", reason: "credential_owner_offline" },
        );
        f.stored(challenge);
        f.authorize(challenge);
        if (failure === "offline") f.prove(f.service, replacement);
        const before = f.commands.length;
        expect(
          await f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
            machineId: f.machineId,
            envelope,
          }),
        ).toEqual({ kind: "refused", reason: "credential_enrollment_unknown" });
        f.service.offline(f.channel);
        expect(f.commands.length).toBe(before);
        expect(
          f.commands.filter((command) => command.type === "credential_enrollment_commit"),
        ).toHaveLength(1);
        f.service.offline(replacement);
      } finally {
        f.close();
      }
    }
  },
);

test("an action abort before an offer cancels by request identity and ignores a late owner reply", async () => {
  const f = await enrollmentFixture();
  try {
    const abort = new AbortController();
    const pending = f.service.prepareCredentialEnrollment(
      f.auth.credentialReference(f.root),
      f.enrollmentArgs,
      "abort",
      undefined,
      abort.signal,
    );
    abort.abort(new Error("/private/path/never-disclose"));
    f.offer();
    expect(await pending).toEqual({ kind: "refused", reason: "credential_enrollment_cancelled" });
    expect(f.commands.at(-1)).toMatchObject({ type: "credential_enrollment_cancel", nonce: null });
    expect(JSON.stringify(f.store.listEvents({ type: TRACE_ROW_TYPE, limit: 20 }))).not.toContain(
      "/private/path",
    );
  } finally {
    f.close();
  }
});

test.each([false, true])(
  "an aborted action fence after authorization=%s closes every continuation",
  async (authorized) => {
    const f = await enrollmentFixture();
    try {
      let current = true;
      const fence = new ActionAuthorityFence(f.auth, f.root, () => current, null);
      fence.admit([{ cap: "*" }]);
      const challenge = await f.prepare();
      const pending = f.service.commitCredentialEnrollment(
        f.auth.credentialReference(f.root),
        {
          machineId: f.machineId,
          envelope: await f.seal(challenge),
        },
        "fenced",
        fence,
      );
      if (authorized) f.authorize(challenge);
      current = false;
      f.service.tick();
      f.authorize(challenge);
      f.stored(challenge);
      expect(await pending).toEqual(
        authorized
          ? { kind: "unknown", reason: "credential_outcome_unknown" }
          : { kind: "refused", reason: "credential_unauthorized" },
      );
      expect(
        f.commands.filter((command) => command.type === "credential_enrollment_commit"),
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

test.each(["prepare", "offer", "commit", "authorized"] as const)(
  "the %s deadline releases control waiters and refuses all late work",
  async (phase) => {
    const f = await enrollmentFixture();
    try {
      const credential = f.auth.credentialReference(f.root);
      const preparing = f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs);
      let challenge: ServiceCredentialEnrollmentChallenge | undefined;
      let committing: Promise<unknown> | undefined;
      if (phase !== "prepare") {
        f.offer();
        const reply = await preparing;
        if (reply.kind !== "prepared") throw new Error("missing offer");
        challenge = reply.challenge;
        if (phase === "commit" || phase === "authorized") {
          committing = f.service.commitCredentialEnrollment(credential, {
            machineId: f.machineId,
            envelope: await f.seal(challenge),
          });
          if (phase === "authorized") f.authorize(challenge);
        }
      }
      f.runtime.time =
        phase === "offer" ? CREDENTIAL_ENROLLMENT_TTL_MS : CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS;
      f.service.tick();
      if (phase === "prepare")
        expect(await preparing).toEqual({
          kind: "refused",
          reason: "credential_enrollment_expired",
        });
      if (committing)
        expect(await committing).toEqual(
          phase === "authorized"
            ? { kind: "unknown", reason: "credential_outcome_unknown" }
            : { kind: "refused", reason: "credential_enrollment_expired" },
        );
      if (challenge)
        expect(
          await f.service.commitCredentialEnrollment(credential, {
            machineId: f.machineId,
            envelope: await f.seal(challenge),
          }),
        ).toEqual(
          phase === "authorized"
            ? { kind: "unknown", reason: "credential_outcome_unknown" }
            : { kind: "refused", reason: "credential_enrollment_expired" },
        );
      expect(
        f.commands.filter((command) => command.type === "credential_enrollment_cancel"),
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);

test.each([false, true])(
  "explicit cancellation after authorization=%s never promises a rollback",
  async (authorized) => {
    const f = await enrollmentFixture();
    try {
      const credential = f.auth.credentialReference(f.root);
      const challenge = await f.prepare();
      const committing = f.service.commitCredentialEnrollment(credential, {
        machineId: f.machineId,
        envelope: await f.seal(challenge),
      });
      if (authorized) f.authorize(challenge);
      const cancel = f.service.cancelCredentialEnrollment(credential, {
        machineId: f.machineId,
        requestId: challenge.context.requestId,
        nonce: challenge.context.nonce,
      });
      if (!authorized) f.authorize(challenge);
      f.service.event(f.channel, {
        type: "credential_enrollment_cancelled",
        requestId: challenge.context.requestId,
        reply: authorized
          ? { kind: "unknown", reason: "credential_outcome_unknown" }
          : { kind: "cancelled" },
      });
      expect(await committing).toEqual(
        authorized
          ? { kind: "unknown", reason: "credential_outcome_unknown" }
          : { kind: "refused", reason: "credential_enrollment_cancelled" },
      );
      expect(await cancel).toEqual(
        authorized
          ? { kind: "unknown", reason: "credential_outcome_unknown" }
          : { kind: "cancelled" },
      );
      expect(
        await f.service.commitCredentialEnrollment(credential, {
          machineId: f.machineId,
          envelope: await f.seal(challenge),
        }),
      ).toEqual(
        authorized
          ? { kind: "unknown", reason: "credential_outcome_unknown" }
          : { kind: "refused", reason: "credential_enrollment_cancelled" },
      );
    } finally {
      f.close();
    }
  },
);

test("a wrong nonce cannot cancel or authorize the live offer", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare();
    const credential = f.auth.credentialReference(f.root);
    expect(
      await f.service.cancelCredentialEnrollment(credential, {
        machineId: f.machineId,
        requestId: challenge.context.requestId,
        nonce: randomUUID(),
      }),
    ).toEqual({ kind: "refused", reason: "credential_target_mismatch" });
    const pending = f.service.commitCredentialEnrollment(credential, {
      machineId: f.machineId,
      envelope: await f.seal(challenge),
    });
    f.authorize(challenge, randomUUID());
    expect(await pending).toEqual({ kind: "refused", reason: "credential_target_mismatch" });
    expect(
      f.commands.filter(
        (command) => command.type === "credential_enrollment_authorized" && command.allowed,
      ),
    ).toEqual([]);
  } finally {
    f.close();
  }
});

test.each(["before-authorize", "reference", "replacement", "source-revision"] as const)(
  "owner stored result mismatch %s never claims storage",
  async (failure) => {
    const f = await enrollmentFixture(true);
    try {
      const challenge = await f.prepare();
      const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
        machineId: f.machineId,
        envelope: await f.seal(challenge),
      });
      if (failure !== "before-authorize") f.authorize(challenge);
      f.stored(challenge, {
        ...(failure === "reference" ? { credentialRef: "different-reference" } : {}),
        ...(failure === "replacement" ? { replaced: false } : {}),
        ...(failure === "source-revision"
          ? { sourceRevision: challenge.context.sourceRevision }
          : {}),
      });
      expect(await pending).toEqual(
        failure === "before-authorize"
          ? { kind: "refused", reason: "credential_target_mismatch" }
          : { kind: "unknown", reason: "credential_outcome_unknown" },
      );
    } finally {
      f.close();
    }
  },
);

test.each(["false", "throw"] as const)(
  "a %s owner send has a closed result and is never retried",
  async (failure) => {
    const f = await enrollmentFixture();
    try {
      const challenge = await f.prepare();
      const send = f.channel.send;
      f.channel.send = (message) => {
        if (message.command.type !== "credential_enrollment_commit") return send(message);
        if (failure === "throw") throw new Error("/private/crypto/never-disclose");
        return false;
      };
      const envelope = await f.seal(challenge);
      expect(
        await f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
          machineId: f.machineId,
          envelope,
        }),
      ).toEqual({ kind: "refused", reason: "credential_owner_offline" });
      f.channel.send = send;
      expect(
        await f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
          machineId: f.machineId,
          envelope,
        }),
      ).toEqual({ kind: "refused", reason: "credential_owner_offline" });
      expect(JSON.stringify(f.store.listEvents({ type: TRACE_ROW_TYPE, limit: 20 }))).not.toContain(
        "/private/crypto",
      );
    } finally {
      f.close();
    }
  },
);

test("one owner cannot evict an unexpired offer to exceed the pending limit", async () => {
  const f = await enrollmentFixture();
  try {
    const credential = f.auth.credentialReference(f.root);
    const pending = Array.from({ length: CREDENTIAL_ENROLLMENT_PENDING_LIMIT }, () =>
      f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs),
    );
    expect(await f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs)).toEqual({
      kind: "refused",
      reason: "credential_enrollment_busy",
    });
    f.service.offline(f.channel);
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: CREDENTIAL_ENROLLMENT_PENDING_LIMIT }, () => ({
        kind: "refused",
        reason: "credential_owner_offline",
      })),
    );
    f.prove();
    const challenge = await f.prepare();
    const cancel = f.service.cancelCredentialEnrollment(credential, {
      machineId: f.machineId,
      requestId: challenge.context.requestId,
      nonce: challenge.context.nonce,
    });
    f.service.event(f.channel, {
      type: "credential_enrollment_cancelled",
      requestId: challenge.context.requestId,
      reply: { kind: "cancelled" },
    });
    expect(await cancel).toEqual({ kind: "cancelled" });
  } finally {
    f.close();
  }
});

test.each([
  ["key", "credential_key_changed"],
  ["owner", "credential_owner_changed"],
  ["generation", "credential_owner_changed"],
  ["reference", "credential_reference_unknown"],
  ["origin", "credential_origin_disallowed"],
] as const)(
  "live %s changes across the commit await cannot gain publication authority",
  async (change, reason) => {
    const f = await enrollmentFixture();
    try {
      const challenge = await f.prepare();
      const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
        machineId: f.machineId,
        envelope: await f.seal(challenge),
      });
      if (change === "key")
        f.owner.credentialEnrollment = { ...f.recipient.metadata, keyId: "0".repeat(64) };
      if (change === "owner") f.owner.ownerId = "another-owner";
      if (change === "generation") f.owner.generation++;
      if (change === "reference" || change === "origin")
        f.service.event(f.channel, {
          type: "resources",
          resources: {
            ...f.owner.resources!,
            credentialReferences:
              change === "reference"
                ? []
                : [
                    {
                      ref: f.enrollmentArgs.credentialRef,
                      origins: ["https://other.invalid"],
                      available: false,
                    },
                  ],
          },
        });
      f.authorize(challenge);
      f.stored(challenge);
      expect(await pending).toEqual({ kind: "refused", reason });
      expect(
        f.commands.filter(
          (command) => command.type === "credential_enrollment_authorized" && command.allowed,
        ),
      ).toEqual([]);
    } finally {
      f.close();
    }
  },
);

test("resources-only refresh preserves the proved key and a declared missing-source offer", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare();
    f.service.event(f.channel, {
      type: "resources",
      resources: { ...f.owner.resources!, tools: {} },
    });
    const pending = f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
      machineId: f.machineId,
      envelope: await f.seal(challenge),
    });
    f.authorize(challenge);
    f.stored(challenge);
    expect(await pending).toMatchObject({ kind: "stored", replaced: false });
  } finally {
    f.close();
  }
});

test("a duplicate commit cannot replay the envelope or disturb the already consuming request", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare();
    const args = { machineId: f.machineId, envelope: await f.seal(challenge) };
    const credential = f.auth.credentialReference(f.root);
    const first = f.service.commitCredentialEnrollment(credential, args);
    expect(await f.service.commitCredentialEnrollment(credential, args)).toEqual({
      kind: "refused",
      reason: "credential_enrollment_replayed",
    });
    f.authorize(challenge);
    f.stored(challenge);
    expect(await first).toMatchObject({ kind: "stored" });
    expect(
      f.commands.filter((command) => command.type === "credential_enrollment_commit"),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

test("an owner cannot reuse another live or consumed enrollment nonce", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare();
    const credential = f.auth.credentialReference(f.root);
    const duplicated = f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs);
    f.offer({ nonce: challenge.context.nonce });
    expect(await duplicated).toEqual({ kind: "refused", reason: "credential_enrollment_replayed" });
    const commit = f.service.commitCredentialEnrollment(credential, {
      machineId: f.machineId,
      envelope: await f.seal(challenge),
    });
    f.authorize(challenge);
    f.stored(challenge);
    expect(await commit).toMatchObject({ kind: "stored" });
    const reused = f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs);
    f.offer({ nonce: challenge.context.nonce });
    expect(await reused).toEqual({ kind: "refused", reason: "credential_enrollment_replayed" });
  } finally {
    f.close();
  }
});

test("replacement before the native offer retires the original request even while the new owner is unproved", async () => {
  const f = await enrollmentFixture();
  try {
    const credential = f.auth.credentialReference(f.root);
    const pending = f.service.prepareCredentialEnrollment(credential, f.enrollmentArgs);
    const replacement = { ...f.channel };
    f.service.online(replacement, f.owner, "epoch");
    const late = f.offer({}, false);
    f.service.event(f.channel, {
      type: "credential_enrollment_prepared",
      requestId: late.context.requestId,
      reply: { kind: "prepared", challenge: late },
    });
    f.service.event(replacement, {
      type: "credential_enrollment_prepared",
      requestId: late.context.requestId,
      reply: { kind: "prepared", challenge: late },
    });
    expect(await pending).toEqual({ kind: "refused", reason: "credential_owner_offline" });
    expect(f.commands.filter((command) => command.type === "credential_enrollment_cancel")).toEqual(
      [{ type: "credential_enrollment_cancel", requestId: late.context.requestId, nonce: null }],
    );
    f.prove(f.service, replacement);
    expect(
      await f.service.commitCredentialEnrollment(credential, {
        machineId: f.machineId,
        envelope: await f.seal(late),
      }),
    ).toEqual({ kind: "refused", reason: "credential_enrollment_unknown" });
    expect(f.commands.filter((command) => command.type === "credential_enrollment_commit")).toEqual(
      [],
    );
    f.service.offline(replacement);
  } finally {
    f.close();
  }
});

test("modest native clock lead preserves the exact offer but never extends hub custody", async () => {
  const f = await enrollmentFixture();
  try {
    const challenge = await f.prepare(f.root, {
      expiresAt: CREDENTIAL_ENROLLMENT_TTL_MS + CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS,
    });
    const envelope = await f.seal(challenge);
    expect(envelope.context.expiresAt).toBe(
      CREDENTIAL_ENROLLMENT_TTL_MS + CREDENTIAL_ENROLLMENT_CONTROL_TIMEOUT_MS,
    );
    f.runtime.time = CREDENTIAL_ENROLLMENT_TTL_MS;
    f.service.tick();
    expect(
      await f.service.commitCredentialEnrollment(f.auth.credentialReference(f.root), {
        machineId: f.machineId,
        envelope,
      }),
    ).toEqual({ kind: "refused", reason: "credential_enrollment_expired" });
    expect(f.commands.filter((command) => command.type === "credential_enrollment_commit")).toEqual(
      [],
    );
  } finally {
    f.close();
  }
});

test("ordinary opaque builtin enrollment uses the late JobService and audits only explicit safe metadata", async () => {
  const f = await enrollmentFixture(true);
  let host: PluginHost | undefined;
  try {
    const observedLogs: unknown[] = [];
    const recordLog = (event: LogEvent, fields?: Readonly<Record<string, unknown>>) => {
      observedLogs.push({ event, fields });
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
    host = await testPluginHost(f.store, f.auth, rooms, broker, f.runtime, {
      logger: { info: recordLog, warn: recordLog, error: recordLog },
    });
    expect(
      await host.dispatch(f.root, "engine.services.prepareCredentialEnrollment", f.enrollmentArgs),
    ).toEqual({ ok: true, result: { kind: "refused", reason: "credential_owner_offline" } });
    host.setJobs(f.service);
    const preparedOnWire = Promise.withResolvers<void>();
    const committedOnWire = Promise.withResolvers<void>();
    const send = f.channel.send;
    f.channel.send = (message) => {
      const sent = send(message);
      if (message.command.type === "credential_enrollment_prepare") preparedOnWire.resolve();
      if (message.command.type === "credential_enrollment_commit") committedOnWire.resolve();
      return sent;
    };
    const opening = host.dispatch(
      f.root,
      "engine.services.prepareCredentialEnrollment",
      f.enrollmentArgs,
    );
    await Promise.race([
      preparedOnWire.promise,
      opening.then(() => {
        throw new Error("preparation settled before owner offer");
      }),
    ]);
    f.offer();
    const prepared = await opening;
    if (!prepared.ok) throw new Error("preparation refused");
    const reply = prepared.result as ServiceCredentialEnrollmentPrepareReply;
    if (reply.kind !== "prepared") throw new Error("missing private offer");
    const challenge = reply.challenge;
    const envelope = await f.seal(challenge);
    expect(
      await host.dispatch(f.reader, "engine.services.commitCredentialEnrollment", {
        machineId: f.machineId,
        envelope,
      }),
    ).toMatchObject({ ok: false, denial: { rule: "forbidden" } });
    const committing = host.dispatch(f.root, "engine.services.commitCredentialEnrollment", {
      machineId: f.machineId,
      envelope,
    });
    await Promise.race([
      committedOnWire.promise,
      committing.then(() => {
        throw new Error("commit settled before owner authorization");
      }),
    ]);
    f.authorize(challenge);
    f.stored(challenge);
    expect(await committing).toMatchObject({
      ok: true,
      result: { kind: "stored", replaced: true },
    });
    expect(
      await host.dispatch(f.root, "engine.services.commitCredentialEnrollment", {
        machineId: f.machineId,
        envelope,
      }),
    ).toEqual({ ok: true, result: { kind: "refused", reason: "credential_enrollment_replayed" } });
    expect(
      await host.dispatch(f.root, "engine.services.cancelCredentialEnrollment", {
        machineId: f.machineId,
        requestId: challenge.context.requestId,
        nonce: challenge.context.nonce,
      }),
    ).toEqual({ ok: true, result: { kind: "unknown", reason: "credential_outcome_unknown" } });
    const traces = f.store.listEvents({ type: TRACE_ROW_TYPE, limit: 100 });
    const audit = traces
      .map((trace) => JSON.parse(trace.payload) as Record<string, unknown>)
      .filter((payload) => payload.serviceLifecycle === "credential-enrollment");
    expect(audit.find((payload) => payload.status === "authorized")).toMatchObject({
      machineId: f.machineId,
      credentialRef: f.enrollmentArgs.credentialRef,
      replace: true,
    });
    expect(audit.find((payload) => payload.status === "stored")).toMatchObject({ replace: true });
    const observations = JSON.stringify({ traces, logs: observedLogs });
    for (const excluded of [
      "disposable-enrollment-marker",
      envelope.ciphertext,
      envelope.enc,
      challenge.context.requestId,
      challenge.context.nonce,
      challenge.context.sourceRevision!,
      challenge.key.keyId,
      challenge.key.publicKey,
    ])
      expect(observations).not.toContain(excluded);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
    expect(
      f.commands.filter((command) => command.type === "credential_enrollment_commit"),
    ).toHaveLength(1);
  } finally {
    host?.close();
    f.close();
  }
});

test("pending native service results retain the original action fence and refuse late withdrawal", async () => {
  const f = fixture();
  try {
    let current = true;
    const fence = new ActionAuthorityFence(f.auth, f.reader, () => current, null);
    fence.admit([
      {
        cap: "services:read",
        ref: {
          kind: "service",
          machineId: f.machineId,
          serviceId: f.args.serviceId,
          operationId: f.args.operationId,
        },
      },
    ]);
    const pending = serviceContext(
      () => f.service,
      f.reader,
      "sample.reader",
      42,
      "read",
      fence,
    ).read(f.args);
    const disclosed = pending.then(
      () => true,
      () => false,
    );
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    fence.close();
    await Promise.resolve();
    current = false;
    f.result(requestId);
    expect(await disclosed).toBe(false);
    expect(
      f.commands.some(
        (command) => command.type === "service_read_cancel" && command.requestId === requestId,
      ),
    ).toBe(true);
  } finally {
    f.store.close();
  }
});

test("direct native service restore preserves selected scoped source rather than projected caps", async () => {
  const f = fixture();
  try {
    const target = formatManifoldUri({
      kind: "service",
      machineId: f.machineId,
      serviceId: f.args.serviceId,
      operationId: f.args.operationId,
    });
    const minted = f.auth.mintTokenV2(
      {
        principal: { name: "scoped-service-reader", kind: "human" },
        scope: [{ target, reach: "node", caps: ["services:read"] }],
        expiresAt: f.runtime.now() + 60_000,
      },
      f.root,
    );
    const reader = f.auth.authenticate(minted.token);
    const first = f.service.readService(reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.result(requestId);
    expect(await first).toMatchObject({ ok: true, result: { remaining: 12 } });
    const second = f.service.readService(reader, f.args);
    const observed = second.then(
      () => "disclosed",
      (error: Error) => error.message,
    );
    const pendingId = f.pendingCommand().requestId;
    f.authorize(pendingId);
    f.auth.grant(
      {
        principal: { kind: "principal", id: reader.principal.id },
        node: target,
        reach: "node",
        caps: ["services:read"],
        effect: "deny",
      },
      f.root,
    );
    f.result(pendingId);
    expect(await observed).toBe("service_unauthorized");
  } finally {
    f.store.close();
  }
});

test("limited consumers can establish metering readiness without configuration authority", async () => {
  const priced: ServicePolicy = {
    ...policy,
    prices: {
      models: { "fixture/model": { inputPerMillion: 1_000_000, outputPerMillion: 5_000_000 } },
    },
    operations: {
      ...policy.operations,
      stream: {
        kind: "http-proxy",
        method: "POST",
        path: "/stream",
        request: { kind: "json", disclosure: "full" },
        response: {
          kind: "stream",
          disclosure: "full",
          contentTypes: ["text/event-stream"],
          headers: [],
        },
        timeoutMs: 1000,
        maxRequestBytes: 4096,
        maxResponseBytes: 4096,
        meter: { kind: "pi-native-usage" },
      },
    },
  };
  const f = fixture(priced);
  try {
    const host = await orchestratorHost(f);
    const describe = async () => {
      const answer = await host.dispatch(f.reader, "engine.services.describe", {
        machineId: f.machineId,
      });
      if (!answer.ok) throw new Error(`Service description refused: ${JSON.stringify(answer)}`);
      return (answer.result as ReturnType<JobService["describeServices"]>).services[0]!;
    };
    expect(
      await host.dispatch(f.reader, "engine.services.readConfiguration", {
        machineId: f.machineId,
      }),
    ).toMatchObject({ ok: false });
    const first = await describe();
    expect(first.policySha256).toBe(hash(priced));
    expect(first.operations.find((operation) => operation.operationId === "stream")).toMatchObject({
      meter: { kind: "pi-native-usage" },
      prices: priced.prices,
    });
    expect(
      first.operations.find((operation) => operation.operationId === "inspect"),
    ).not.toHaveProperty("prices");
    const changed = {
      ...priced,
      revision: "r2",
      prices: {
        models: { "fixture/model": { inputPerMillion: 2_000_000, outputPerMillion: 6_000_000 } },
      },
    };
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [changed],
    });
    const next = await describe();
    expect(next.policySha256).toBe(hash(changed));
    expect(next.operations.find((operation) => operation.operationId === "stream")?.prices).toEqual(
      changed.prices,
    );
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.reader.principal.id },
        node: formatManifoldUri({
          kind: "service",
          machineId: f.machineId,
          serviceId: policy.serviceId,
          operationId: "stream",
        }),
        caps: ["services:read"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    const remaining = await describe();
    expect(remaining.operations.map((operation) => operation.operationId)).toEqual(["inspect"]);
    expect(remaining.operations[0]).not.toHaveProperty("meter");
    expect(remaining.operations[0]).not.toHaveProperty("prices");
  } finally {
    f.store.close();
  }
});

test("v35 native reads keep working with service authority, not machine execution or an installed worker", async () => {
  const f = fixture();
  f.owner.protocolVersion = 35;
  f.prove();
  try {
    expect(f.reader.caps).toEqual(["services:read"]);
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
    expect(f.store.db.query("SELECT plugin_id FROM machine_job_installs").all()).toEqual([]);
    const originalSend = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "service_authorized" && message.command.allowed) {
        expect(
          f.store.db.query("SELECT id FROM events WHERE door='engine.services.read'").all().length,
        ).toBe(2);
        expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(2);
      }
      return originalSend(message);
    };
    f.authorize(command.requestId);
    f.result(command.requestId);
    expect(await pending).toEqual({
      type: "service_result",
      requestId: command.requestId,
      ok: true,
      result: { remaining: 12 },
    });
    const durable = JSON.stringify([
      f.store.db.query("SELECT * FROM events").all(),
      f.store.db.query("SELECT * FROM machine_job_decisions").all(),
    ]);
    expect(durable).not.toContain("private-source-input");
    expect(durable).not.toContain("remaining");
    expect(f.store.db.query("SELECT action FROM machine_job_decisions").all().length).toBe(3);
  } finally {
    f.store.close();
  }
});

test("contextual policies are projected for either legacy fence without disrupting ordinary reads", async () => {
  for (const [transport, owner] of [
    [MACHINE_SELF_PROVIDER_PROTOCOL_VERSION - 1, JOB_OWNER_PROTOCOL_VERSION],
    // The last owner RPC before job-scoped self-provider runtime identity (v37).
    [MACHINE_SELF_PROVIDER_PROTOCOL_VERSION, 36],
    [undefined, JOB_OWNER_PROTOCOL_VERSION],
  ] as const) {
    const f = fixture();
    try {
      if (transport === undefined) delete f.channel.protocolVersion;
      else f.channel.protocolVersion = transport;
      f.owner.protocolVersion = owner;
      const contextual: ServicePolicy = {
        serviceId: "native.contextual",
        revision: "r1",
        maxConcurrent: 1,
        runtime: {
          pluginId: "native.provider",
          operationId: "native.provider.serve",
          artifactSha256: "a".repeat(64),
          resourceBindingDigest: hash(null),
          input: {},
        },
        operations: {
          inspect: {
            kind: "http-proxy",
            method: "GET",
            path: "/inspect",
            request: { kind: "none" },
            response: {
              kind: "stream",
              disclosure: "full",
              contentTypes: ["application/json"],
              headers: [],
            },
            timeoutMs: 1000,
            maxRequestBytes: 1024,
            maxResponseBytes: 4096,
          },
        },
      };
      const pinned: ServicePolicy = {
        ...contextual,
        serviceId: "native.pinned",
        runtime: { ...contextual.runtime!, installationRevision: "provider-r1" },
      };
      const configuration = f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: f.configuration.revision,
        policies: [policy, contextual, pinned],
      });
      f.commands.length = 0;
      f.prove();
      const replay = f.commands.findLast((command) => command.type === "configure_services");
      expect(replay).toEqual({
        type: "configure_services",
        configuration: { revision: hash([policy, pinned]), policies: [policy, pinned] },
      });
      expect(f.service.readServiceConfiguration(f.root, { machineId: f.machineId })).toMatchObject({
        connected: true,
        configuration,
      });
      expect(
        f.service
          .describeServices(f.root, { machineId: f.machineId })
          .services.find((value) => value.serviceId === contextual.serviceId)?.operations[0],
      ).toMatchObject({ ready: false, reason: "service_runtime_unsupported" });
      const pending = f.service.readService(f.reader, f.args);
      const command = f.pendingCommand();
      f.authorize(command.requestId);
      f.result(command.requestId);
      expect(await pending).toMatchObject({ ok: true, result: { remaining: 12 } });
      f.channel.protocolVersion = MACHINE_SELF_PROVIDER_PROTOCOL_VERSION;
      f.owner.protocolVersion = JOB_OWNER_PROTOCOL_VERSION;
      f.commands.length = 0;
      f.prove();
      expect(f.commands.findLast((command) => command.type === "configure_services")).toEqual({
        type: "configure_services",
        configuration,
      });
    } finally {
      f.store.close();
    }
  }
});

test("configuration CAS is canonical, root-only, and synchronization never implies invocation success", () => {
  const f = fixture();
  try {
    expect(() =>
      f.service.readServiceConfiguration(f.reader, { machineId: f.machineId }),
    ).toThrow();
    expect(() =>
      f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: null,
        policies: [],
      }),
    ).toThrow("service_configuration_changed");
    expect(f.service.readServiceConfiguration(f.root, { machineId: f.machineId })).toEqual({
      configuration: f.configuration,
      credentialReferences: f.owner.resources!.credentialReferences ?? [],
      connected: true,
      runtimeCandidates: [],
    });
    const changed = f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    expect(changed.revision).not.toBeNull();
    expect(f.commands.at(-1)).toEqual({ type: "configure_services", configuration: changed });
    f.service.offline(f.channel);
    f.prove();
    expect(f.commands.filter((command) => command.type === "configure_services").at(-1)).toEqual({
      type: "configure_services",
      configuration: changed,
    });
  } finally {
    f.store.close();
  }
});

test("root browser tokens retain bounded service configuration authority until revoked", () => {
  const f = fixture();
  try {
    const grant = f.auth.bootstrapPrincipal({ kind: "human", name: "Browser owner" }, f.root);
    const browser = f.auth.authenticate(grant.token);
    const delegated: AuthContext = { ...browser, caps: ["services:configure"] };
    expect(
      f.service.readServiceConfiguration(delegated, { machineId: f.machineId }).configuration,
    ).toEqual(f.configuration);
    expect(() =>
      f.service.readServiceConfiguration({ ...browser, caps: [] }, { machineId: f.machineId }),
    ).toThrow();
    const nonOwner = f.auth.authenticate(
      f.auth.mintToken(
        {
          principal: { kind: "human", name: "Configuration delegate" },
          caps: ["services:configure"],
        },
        f.root,
      ).token,
    );
    expect(() =>
      f.service.readServiceConfiguration(nonOwner, { machineId: f.machineId }),
    ).toThrow();
    const changed = f.service.configureServiceConfiguration(delegated, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    expect(
      f.service.readServiceConfiguration(browser, { machineId: f.machineId }).configuration,
    ).toEqual(changed);
    f.auth.revokePrincipal(browser.principal.id, f.root);
    expect(() =>
      f.service.readServiceConfiguration(delegated, { machineId: f.machineId }),
    ).toThrow();
  } finally {
    f.store.close();
  }
});

test("instance setup requires configuration authority, not service invocation authority", async () => {
  const f = fixture();
  const serviceId = "native.orchestrator.instance";
  const definition: ServicePolicy = {
    serviceId,
    revision: "1",
    maxConcurrent: 1,
    operations: policy.operations,
    runtime: {
      scope: "instance",
      pluginId: "native.orchestrator",
      operationId: "native.orchestrator.serve",
      installationRevision: "install-1",
      artifactSha256: "a".repeat(64),
      resourceBindingDigest: "b".repeat(64),
      input: {},
    },
  };
  try {
    const administrator = serviceContext(
      () => f.service,
      { ...f.root, caps: ["services:configure"] },
      "native.orchestrator",
      1,
      "read",
    );
    const configured = await administrator.configureInstance({
      serviceId,
      expectedRevision: null,
      machineId: f.machineId,
      policy: definition,
      enabled: false,
    });
    expect(f.service.describeInstanceService(f.root, { serviceId })).toMatchObject({
      state: "stopped",
      owner: { machineId: f.machineId },
      configuration: {
        revision: configured.configuration!.revision,
        pluginId: "native.orchestrator",
        enabled: false,
      },
    });
    const invoker = serviceContext(
      () => f.service,
      { ...f.root, caps: ["services:invoke"] },
      "native.orchestrator",
      2,
      "invoke",
    );
    await expect(
      invoker.configureInstance({
        serviceId,
        expectedRevision: configured.configuration!.revision,
        machineId: f.machineId,
        policy: { ...definition, revision: "2" },
        enabled: false,
      }),
    ).rejects.toThrow();
    expect(f.service.describeInstanceService(f.root, { serviceId }).configuration!.revision).toBe(
      configured.configuration!.revision,
    );
  } finally {
    f.store.close();
  }
});

test("stale policy fingerprints and non-readable full or mutating policies cannot use direct reads", async () => {
  const f = fixture();
  try {
    await expect(
      f.service.readService(f.reader, { ...f.args, policySha256: "c".repeat(64) }),
    ).rejects.toThrow("service_binding_mismatch");
    const original = policy.operations.inspect!;
    if ("kind" in original) throw new Error("wrong fixture operation");
    for (const operation of [
      { ...original, readable: false },
      { ...original, readable: false, method: "POST" as const },
      {
        ...original,
        readable: false,
        response: { kind: "json" as const, disclosure: "full" as const },
      },
    ]) {
      const configured = { ...policy, operations: { inspect: operation } };
      const previous = f.service.readServiceConfiguration(f.root, {
        machineId: f.machineId,
      }).configuration;
      f.service.configureServiceConfiguration(f.root, {
        machineId: f.machineId,
        expectedRevision: previous.revision,
        policies: [configured],
      });
      f.service.event(f.channel, {
        type: "resources",
        resources: {
          ...f.owner.resources!,
          services: { [policy.serviceId]: hash(configured) },
        },
      });
      await expect(
        f.service.readService(f.reader, { ...f.args, policySha256: hash(configured) }),
      ).rejects.toThrow("service_unauthorized");
    }
    expect(f.commands.some((command) => command.type === "service_read")).toBe(false);
  } finally {
    f.store.close();
  }
});

test.each(["disconnect", "false-send", "throw-send", "revoke", "lost-result"] as const)(
  "read %s rejects, cancels, and is never replayed",
  async (failure) => {
    const f = fixture();
    try {
      const send = f.channel.send;
      if (failure === "false-send" || failure === "throw-send")
        f.channel.send = (message) => {
          if (message.command.type !== "service_read") return send(message);
          if (failure === "throw-send") throw new Error("private-transport-detail");
          return false;
        };
      const pending = f.service.readService(f.reader, f.args);
      if (failure === "disconnect") f.service.offline(f.channel);
      if (failure === "revoke") f.auth.revokePrincipal(f.reader.principal.id, f.root);
      if (failure === "lost-result") f.authorize(f.pendingCommand().requestId);
      await expect(pending).rejects.toThrow(
        failure === "revoke"
          ? "service_unauthorized"
          : failure === "lost-result"
            ? "service_timeout"
            : "service_unavailable",
      );
      expect(f.commands.some((command) => command.type === "service_read_cancel")).toBe(true);
      const dispatched = f.commands.filter((command) => command.type === "service_read").length;
      f.channel.send = send;
      f.prove();
      expect(f.commands.filter((command) => command.type === "service_read").length).toBe(
        dispatched,
      );
    } finally {
      f.store.close();
    }
  },
  10000,
);

test("foreign-channel, unbound and revoked service authorizations cannot disclose a read", async () => {
  const f = fixture();
  try {
    const pending = f.service.readService(f.reader, f.args);
    const command = f.pendingCommand();
    const foreign = { machineId: f.machineId, send: f.channel.send };
    f.authorize(command.requestId, foreign);
    f.result(command.requestId, foreign);
    expect(f.commands.some((command) => command.type === "service_authorized")).toBe(false);
    f.authorize("unbound");
    expect(f.commands.findLast((command) => command.type === "service_authorized")).toMatchObject({
      allowed: false,
    });
    f.authorize(command.requestId);
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.reader.principal.id },
        node: formatManifoldUri({
          kind: "service",
          machineId: f.machineId,
          serviceId: policy.serviceId,
          operationId: "inspect",
        }),
        caps: ["services:read"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    f.result(command.requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(f.service.describeServices(f.reader, { machineId: f.machineId }).services).toEqual([]);
  } finally {
    f.store.close();
  }
});

function install(
  f: {
    service: JobService;
    root: AuthContext;
    machineId: string;
    channel: {
      machineId: string;
      send(message: { type: "job_command"; command: JobCommand }): boolean;
    };
  },
  servicePolicy = policy,
  inference?: { costMicros: number },
) {
  const artifactSha256 = "d".repeat(64);
  const pluginId = "native.worker";
  const operationId = `${pluginId}.service`;
  const independent = `${pluginId}.independent`;
  const limits = {
    timeoutMs: 1000,
    memoryBytes: 1048576,
    processes: 1,
    outputBytes: 65536,
    ...(inference ? { inference } : {}),
  };
  const base = {
    argv: [{ literal: "worker" }],
    input: {},
    runtimeTools: [],
    locations: [],
    outputs: [],
    network: "none" as const,
    limits,
    stdin: false,
  };
  const machine: MachineHalf = {
    requiresResourceBindings: true,
    artifacts: {
      "linux-x64": {
        url: "https://example.invalid/worker",
        sha256: artifactSha256,
        entrySha256: artifactSha256,
        format: "raw",
        entry: ["worker"],
        maxBytes: 4096,
        maxExpandedBytes: 4096,
        maxMembers: 1,
      },
    },
    operations: {
      [operationId]: {
        ...base,
        runtimeTools: ["helper"],
        services: [
          {
            serviceId: servicePolicy.serviceId,
            revision: servicePolicy.revision,
            operationIds: Object.keys(servicePolicy.operations),
          },
        ],
      },
      [independent]: base,
    },
    locations: {},
  };
  const resourceBindings: JobResourceBindings = {
    tools: { helper: "b".repeat(64) },
    services: { [servicePolicy.serviceId]: hash(servicePolicy) },
    anchors: {},
  };
  f.service.setManifestResolver((id) => (id === pluginId ? machine : null));
  const args = {
    machineId: f.machineId,
    pluginId,
    installationRevision: "r1",
    artifactSha256,
    machine,
    resourceBindings,
  };
  f.service.install(f.root, args);
  f.service.event(f.channel, {
    type: "installed",
    pluginId,
    installationRevision: "r1",
    artifactSha256,
    resources: {
      artifactAvailable: true,
      tools: [],
      operations: [
        { operationId, available: true },
        { operationId: independent, available: true },
      ],
    },
  });
  return { ...args, operationId, independent };
}

test("resource promotion, projected operation pins and managed availability refuse only affected operations", () => {
  const f = fixture();
  try {
    const installed = install(f);
    const describe = () =>
      f.service.describe(f.root, { machineId: f.machineId, pluginId: installed.pluginId });
    const before = describe();
    expect(before.operations![installed.operationId]?.ready).toBe(true);
    expect(
      f.service.describe(f.root, {
        machineId: f.machineId,
        pluginId: installed.pluginId,
        includeServiceBindings: true,
      }).operations![installed.operationId]!.serviceBindings,
    ).toEqual({});
    expect(before.operations![installed.independent]?.resourceBindingDigest).toBe(
      hash({ tools: {}, services: {}, anchors: {} }),
    );
    expect(() =>
      f.service.install(f.root, {
        ...installed,
        installationRevision: "stale",
        resourceBindings: {
          ...installed.resourceBindings,
          tools: { helper: "c".repeat(64) },
        },
      }),
    ).toThrow("resource_revision_changed");
    expect(() =>
      f.service.execute(f.root, installed.pluginId, "trace", {
        jobId: "stale",
        machineId: f.machineId,
        operationId: installed.independent,
        input: {},
        outputs: [],
        resourceBindingDigest: "c".repeat(64),
      }),
    ).toThrow("resource_bindings_changed");
    f.service.event(f.channel, {
      type: "resources",
      resources: { ...f.owner.resources!, tools: {} },
    });
    expect(describe().operations![installed.operationId]).toMatchObject({
      ready: false,
      reason: "tools_unavailable",
    });
    expect(describe().operations![installed.independent]).toEqual(
      before.operations![installed.independent],
    );
    f.service.event(f.channel, {
      type: "installed",
      pluginId: installed.pluginId,
      installationRevision: "r1",
      artifactSha256: installed.artifactSha256,
      resources: {
        artifactAvailable: false,
        tools: [],
        operations: [
          { operationId: installed.operationId, available: false, reason: "managed_tool_missing" },
          { operationId: installed.independent, available: true },
        ],
      },
    });
    expect(describe().operations![installed.independent]?.ready).toBe(true);
  } finally {
    f.store.close();
  }
});

test("job service effects require a live matching installed binding and fresh native consent", () => {
  const f = fixture();
  try {
    const installed = install(f);
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId: installed.pluginId,
      installationRevision: "r1",
      artifactSha256: installed.artifactSha256,
      node: formatManifoldUri({
        kind: "operation",
        machineId: f.machineId,
        operationId: installed.operationId,
      }),
      cap: "machines:run",
      enabled: true,
    });
    const job = f.service.execute(f.root, installed.pluginId, "trace", {
      jobId: "live",
      machineId: f.machineId,
      operationId: installed.operationId,
      input: {},
      outputs: [],
    });
    const event = {
      type: "service_authorize" as const,
      subject: { kind: "job" as const, jobId: "live" },
      authorizationId: "auth-live",
      serviceId: policy.serviceId,
      revision: policy.revision,
      policySha256: hash(policy),
      operationId: "inspect",
    };
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.event(f.channel, {
      type: "state",
      jobId: "live",
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: true });
    f.service.event(f.channel, { ...event, operationId: "unbound" });
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    f.service.event(f.channel, event);
    expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: false });
  } finally {
    f.store.close();
  }
});

test("one job's post, owner events, authorization, tick and cancel cost the same over 1k and 20k retained jobs (#841)", () => {
  /*
    The hub repeats this work for every job it runs, on its only thread, while the settled jobs
    it retains only grow. The median cycle is timed over two histories twenty times apart: a
    cycle that scans retained rows grows with them, one that reads live rows through an index
    does not. The bound is loose enough for a noisy runner and far below a scan's growth.
  */
  const medianCycle = (retained: number): number => {
    const f = fixture();
    try {
      const installed = install(f);
      const machineId = f.machineId;
      const operationId = installed.operationId;
      for (const cap of ["machines:run", "jobs:cancel"] as const)
        f.service.consent(f.root, {
          machineId,
          pluginId: installed.pluginId,
          installationRevision: "r1",
          artifactSha256: installed.artifactSha256,
          node: formatManifoldUri({ kind: "operation", machineId, operationId }),
          cap,
          enabled: true,
        });
      const post = (jobId: string) =>
        f.service.execute(f.root, installed.pluginId, "trace", {
          jobId,
          machineId,
          operationId,
          input: {},
          outputs: [],
        });
      post("template");
      f.store.db
        .query(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
           INSERT INTO machine_jobs(job_id,machine_id,plugin_id,digest,request,state,permit,created_at,owner_closed)
           SELECT 'retained-' || i, machine_id, plugin_id, digest,
             json_set(request, '$.jobId', 'retained-' || i, '$.input.padding', ?2),
             CASE i % 10 WHEN 0 THEN 'interrupted' ELSE 'exited' END, permit, i, i % 10 != 0
           FROM n, machine_jobs WHERE job_id = 'template'`,
        )
        .run(retained, "x".repeat(2048));
      let cycles = 0;
      const cycle = () => {
        const jobId = `cycle-${cycles++}`;
        const job = post(jobId);
        f.service.event(f.channel, {
          type: "state",
          jobId,
          requestDigest: job.request.requestDigest,
          ownerId: f.owner.ownerId,
          ownerGeneration: f.owner.generation,
          state: "started",
        });
        f.service.event(f.channel, { type: "resources", resources: f.owner.resources! });
        f.service.event(f.channel, {
          type: "installed",
          pluginId: installed.pluginId,
          installationRevision: "r1",
          artifactSha256: installed.artifactSha256,
          resources: {
            artifactAvailable: true,
            tools: [],
            operations: [{ operationId, available: true }],
          },
        });
        f.service.event(f.channel, {
          type: "service_authorize",
          subject: { kind: "job", jobId },
          authorizationId: `authorize-${jobId}`,
          serviceId: policy.serviceId,
          revision: policy.revision,
          policySha256: hash(policy),
          operationId: "inspect",
        });
        expect(f.commands.at(-1)).toMatchObject({ type: "service_authorized", allowed: true });
        f.service.tick();
        f.service.cancel(f.root, { kind: "job", machineId, operationId, jobId });
        expect(f.commands.at(-1)).toMatchObject({ type: "cancel", jobId });
      };
      cycle();
      const samples: number[] = [];
      for (let sample = 0; sample < 7; sample++) {
        const started = performance.now();
        cycle();
        samples.push(performance.now() - started);
      }
      return samples.sort((a, b) => a - b)[3]!;
    } finally {
      f.store.close();
    }
  };
  const small = medianCycle(1_000);
  const large = medianCycle(20_000);
  expect(large).toBeLessThan(small * 3 + 15);
}, 60_000);

test("an owner that authorized a call and then would not serve it says so in the ledger (#708)", () => {
  const f = fixture();
  try {
    const installed = install(f);
    f.service.consent(f.root, {
      machineId: f.machineId,
      pluginId: installed.pluginId,
      installationRevision: "r1",
      artifactSha256: installed.artifactSha256,
      node: formatManifoldUri({
        kind: "operation",
        machineId: f.machineId,
        operationId: installed.operationId,
      }),
      cap: "machines:run",
      enabled: true,
    });
    const job = f.service.execute(f.root, installed.pluginId, "trace", {
      jobId: "live",
      machineId: f.machineId,
      operationId: installed.operationId,
      input: {},
      outputs: [],
    });
    f.service.event(f.channel, {
      type: "state",
      jobId: "live",
      requestDigest: job.request.requestDigest,
      ownerId: f.owner.ownerId,
      ownerGeneration: f.owner.generation,
      state: "started",
    });
    const refused = {
      type: "service_refused" as const,
      subject: { kind: "job" as const, jobId: "live" },
      authorizationId: "auth-live",
      serviceId: policy.serviceId,
      revision: policy.revision,
      policySha256: hash(policy),
      operationId: "inspect",
      reason: "service_runtime_child_not_started" as const,
    };
    f.service.event(f.channel, refused);
    const rows = f.store.listEvents({ type: TRACE_ROW_TYPE, limit: 4 }).map((row) => ({
      outcome: row.outcome,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
    const record = rows.find((row) => row.payload.ownerRefusal !== undefined);
    // The owner's own word, against the call it names, refused rather than permitted: this is
    // the only place a service the hub reports ready can be seen refusing every call.
    expect(record).toMatchObject({
      outcome: "forbidden",
      payload: {
        serviceLifecycle: "invoke",
        jobId: "live",
        serviceId: policy.serviceId,
        operationId: "inspect",
        ownerRefusal: "service_runtime_child_not_started",
      },
    });
    // A refusal for a job this channel does not own is not recorded against that job at all.
    f.service.event(f.channel, { ...refused, subject: { kind: "job", jobId: "absent" } });
    expect(
      f.store
        .listEvents({ type: TRACE_ROW_TYPE, limit: 8 })
        .filter(
          (row) => (JSON.parse(row.payload) as Record<string, unknown>).ownerRefusal !== undefined,
        ),
    ).toHaveLength(1);
  } finally {
    f.store.close();
  }
});

test("credential availability changes revoke pending reads and disable only service dependencies", async () => {
  const f = fixture();
  try {
    const installed = install(f);
    const pending = f.service.readService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        services: {},
        credentialReferences: [
          { ref: "native-account", origins: [policy.origin!], available: false },
        ],
      },
    });
    f.result(requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(
      f.service.describeServices(f.reader, { machineId: f.machineId }).services[0]?.operations[0]
        ?.ready,
    ).toBe(false);
    const operations = f.service.describe(f.root, {
      machineId: f.machineId,
      pluginId: installed.pluginId,
    }).operations!;
    expect(operations[installed.operationId]?.ready).toBe(false);
    expect(operations[installed.independent]?.ready).toBe(true);
  } finally {
    f.store.close();
  }
});

function invocationFixture() {
  const original = policy.operations.inspect!;
  if ("kind" in original) throw new Error("wrong fixture operation");
  return fixture(
    {
      ...policy,
      operations: {
        inspect: {
          ...original,
          method: "PATCH",
          readable: false,
          invocable: true,
        },
      },
    },
    "invoke",
  );
}

/** Real guest registration and ctx-call bridge; only the process transport is in memory. */
async function orchestratorHost(f: {
  store: ServerStore;
  auth: AuthService;
  runtime: FakeRuntime;
  service: JobService;
  machineId: string;
  args: ServiceReadArgs;
  configuration: ServiceConfiguration;
}) {
  const manifest: PluginManifest = {
    id: "native.orchestrator",
    version: "1.0.0",
    title: "Orchestrator",
    description: "",
    capabilities: ["services:read", "services:invoke", "services:configure", "machines:run"],
    contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
    entry: { server: true },
  };
  const action = (name: string, delegates: readonly Cap[]) =>
    defineServerAction({
      name,
      title: name,
      caps: [],
      delegates,
      input: z.strictObject({}),
      result: z.unknown(),
    });
  let receive: (frame: unknown) => void = () => {
    throw new Error("guest not attached");
  };
  let active: ActionCtx | undefined;
  let settle: (outcome: IsolateDispatchOutcome) => void = () => {
    throw new Error("no dispatch");
  };
  let rejectDispatch: (error: unknown) => void = () => {
    throw new Error("no dispatch");
  };
  const warnings: string[] = [];
  const loaded = Promise.withResolvers<Extract<IsolateChildFrame, { t: "loaded" }>>();
  attachServerGuest(
    {
      manifest,
      actions: [
        action("invoke", ["services:invoke"]),
        action("readOnly", ["services:read"]),
        action("configure", ["services:configure"]),
        action("undeclared", []),
      ],
      handlers: {
        invoke: (ctx) => ctx.services.invoke(f.args),
        readOnly: (ctx) => ctx.services.invoke(f.args),
        configure: (ctx) =>
          ctx.services.configureConfiguration({
            machineId: f.machineId,
            expectedRevision: f.configuration.revision,
            policies: [],
          }),
        undeclared: (ctx) => ctx.jobs.describe({ machineId: f.machineId, pluginId: manifest.id }),
      },
    },
    {
      onMessage: (listener) => {
        receive = listener;
      },
      exit: (code) => {
        throw new Error(`guest exited ${code}`);
      },
      warn: (message) => {
        warnings.push(message);
      },
      send: (frame) => {
        if (frame.t === "loaded") loaded.resolve(frame);
        else if (frame.t === "load_failed") loaded.reject(new Error(frame.error));
        else if (frame.t === "dispatched") settle(frame.outcome);
        else if (frame.t === "prepared") {
          try {
            if (active?.admitPrepared === undefined) throw new Error("missing admission");
            active.admitPrepared(frame.targets);
            receive({ t: "admitted", id: frame.id, allowed: true } satisfies IsolateHostFrame);
          } catch (error) {
            rejectDispatch(error);
            receive({ t: "admitted", id: frame.id, allowed: false } satisfies IsolateHostFrame);
          }
        } else if (frame.t === "call") {
          if (!active) throw new Error("host call outside dispatch");
          void serveCtxCall(IsolateCtxMethodSchema.parse(frame.method), frame.args, {
            kind: "dispatch",
            ctx: active,
          }).then(
            (result) =>
              receive({ t: "reply", id: frame.id, ok: true, result } satisfies IsolateHostFrame),
            (error: unknown) =>
              receive({
                t: "reply",
                id: frame.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              } satisfies IsolateHostFrame),
          );
        }
      },
    },
  );
  receive({
    t: "load",
    pluginId: manifest.id,
    manifest,
    dir: "/unused",
  } satisfies IsolateHostFrame);
  const proxy = buildIsolateDef(manifest, await loaded.promise, {
    dispatch: (action, args, ctx) => {
      const pending = Promise.withResolvers<IsolateDispatchOutcome>();
      active = ctx;
      settle = pending.resolve;
      rejectDispatch = pending.reject;
      receive({
        t: "dispatch",
        id: String(ctx.traceId),
        action,
        args,
        ctx: {
          traceId: ctx.traceId,
          principal: ctx.principal,
          caps: [...ctx.auth.caps],
          isRoot: ctx.auth.isRoot,
          containerScope: ctx.containerScope,
          now: ctx.now(),
        },
      } satisfies IsolateHostFrame);
      return pending.promise;
    },
    harness: async () => {
      throw new Error("no harness declared by this service fixture");
    },
    hook: async () => {
      throw new Error("no lifecycle hook declared");
    },
    settled: async () => {
      throw new Error("no lifecycle hook declared");
    },
    migrate: async () => {
      throw new Error("no migration declared by this service fixture");
    },
  });
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
    settingsPlugins: [proxy.def],
  });
  host.setJobs(f.service);
  return host;
}

test("targetless guest delegates invoke only with concrete source authority and current native consent", async () => {
  const f = invocationFixture();
  try {
    const host = await orchestratorHost(f);
    let started = Promise.withResolvers<string>();
    const send = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "service_invoke") started.resolve(message.command.requestId);
      return send(message);
    };
    const pending = host.dispatch(f.reader, "native.orchestrator.invoke", {});
    const requestId = await Promise.race([
      started.promise,
      pending.then((outcome) => {
        throw new Error(`dispatch settled before native invocation: ${JSON.stringify(outcome)}`);
      }),
    ]);
    f.authorize(requestId);
    f.result(requestId);
    expect(await pending).toMatchObject({
      ok: true,
      result: { ok: true, result: { remaining: 12 } },
    });
    const denied = f.auth.mintToken(
      { principal: { name: "no source right", kind: "human" }, caps: ["services:read"] },
      f.root,
    );
    expect(
      await host.dispatch(f.auth.authenticate(denied.token), "native.orchestrator.invoke", {}),
    ).toMatchObject({ ok: false });
    started = Promise.withResolvers<string>();
    const revoked = host.dispatch(f.reader, "native.orchestrator.invoke", {});
    const revokedRequestId = await Promise.race([
      started.promise,
      revoked.then((outcome) => {
        throw new Error(`dispatch settled before native invocation: ${JSON.stringify(outcome)}`);
      }),
    ]);
    f.authorize(revokedRequestId);
    const target = formatManifoldUri({
      kind: "service",
      machineId: f.machineId,
      serviceId: f.args.serviceId,
      operationId: f.args.operationId,
    });
    f.auth.grant(
      {
        principal: { kind: "principal", id: f.reader.principal.id },
        node: target,
        caps: ["services:invoke"],
        effect: "deny",
        reach: "subtree",
      },
      f.root,
    );
    f.result(revokedRequestId);
    expect(await revoked).toMatchObject({ ok: false });
    expect(await host.dispatch(f.reader, "native.orchestrator.invoke", {})).toMatchObject({
      ok: false,
    });
    f.service.configureServiceConfiguration(f.root, {
      machineId: f.machineId,
      expectedRevision: f.configuration.revision,
      policies: [],
    });
    expect(await host.dispatch(f.root, "native.orchestrator.invoke", {})).toMatchObject({
      ok: false,
    });
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(2);
  } finally {
    f.store.close();
  }
});

test("guest declarations cannot borrow root native methods or replace owner configuration authority", async () => {
  const f = invocationFixture();
  try {
    const host = await orchestratorHost(f);
    const grant = f.auth.bootstrapPrincipal({ kind: "human", name: "Browser owner" }, f.root);
    const browser = f.auth.authenticate(grant.token);
    expect(await host.dispatch(browser, "native.orchestrator.readOnly", {})).toMatchObject({
      ok: false,
    });
    expect(await host.dispatch(browser, "native.orchestrator.undeclared", {})).toMatchObject({
      ok: false,
    });
    expect(await host.dispatch(f.reader, "native.orchestrator.configure", {})).toMatchObject({
      ok: false,
    });
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    expect(await host.dispatch(browser, "native.orchestrator.configure", {})).toMatchObject({
      ok: true,
      result: { policies: [] },
    });
  } finally {
    f.store.close();
  }
});

test("direct mutations require invocation authority and an explicit projected policy, never a read grant", async () => {
  const f = invocationFixture();
  try {
    const readToken = f.auth.mintToken(
      { principal: { name: "read only", kind: "human" }, caps: ["services:read"] },
      f.root,
    );
    const readOnly = f.auth.authenticate(readToken.token);
    await expect(f.service.invokeService(readOnly, f.args)).rejects.toThrow("service_unauthorized");
    await expect(f.service.readService(f.root, f.args)).rejects.toThrow("service_unauthorized");
    const context = serviceContext(() => f.service, f.root, "native.reader", 1, "read");
    await expect(context.invoke(f.args)).rejects.toThrow("service_unauthorized");
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    await expect(
      f.service.invokeService(f.reader, { ...f.args, revision: "stale" }),
    ).rejects.toThrow("service_binding_mismatch");
    await expect(
      f.service.invokeService(f.reader, { ...f.args, policySha256: "c".repeat(64) }),
    ).rejects.toThrow("service_binding_mismatch");
    const pending = serviceContext(() => f.service, f.reader, "native.writer", 7, "invoke").invoke(
      f.args,
    );
    const command = JobCommandSchema.parse(f.pendingCommand());
    expect(command.type).toBe("service_invoke");
    f.authorize(f.pendingCommand().requestId);
    f.result(f.pendingCommand().requestId);
    expect(await pending).toMatchObject({ ok: true, result: { remaining: 12 } });
    const events = f.store.db
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE door='engine.services.invoke'",
      )
      .all();
    expect(events.map((event) => JSON.parse(event.payload).callerPluginId)).toEqual([
      "native.writer",
      "native.writer",
      "native.writer",
    ]);
    expect(JSON.stringify(events)).not.toContain("private-source-input");
    expect(f.store.db.query("SELECT job_id FROM machine_jobs").all()).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("an unmarked GET operation cannot be upgraded to an invocation", async () => {
  const f = fixture();
  try {
    await expect(f.service.invokeService(f.root, f.args)).rejects.toThrow("service_unauthorized");
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
  } finally {
    f.store.close();
  }
});

test.each(["revoke", "policy", "disconnect"] as const)(
  "direct invocation %s cancels without disclosing or replaying",
  async (failure) => {
    const f = invocationFixture();
    try {
      const pending = f.service.invokeService(f.reader, f.args);
      const requestId = f.pendingCommand().requestId;
      f.authorize(requestId);
      if (failure === "revoke") f.auth.revokePrincipal(f.reader.principal.id, f.root);
      if (failure === "policy")
        f.service.configureServiceConfiguration(f.root, {
          machineId: f.machineId,
          expectedRevision: f.configuration.revision,
          policies: [],
        });
      if (failure === "disconnect") f.service.offline(f.channel);
      f.result(requestId);
      await expect(pending).rejects.toThrow(
        failure === "disconnect" ? "service_unavailable" : "service_unauthorized",
      );
      const cancel = f.commands.find((command) => command.type === "service_invoke_cancel");
      expect(JobCommandSchema.parse(cancel)).toEqual({ type: "service_invoke_cancel", requestId });
      f.prove();
      expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
    } finally {
      f.store.close();
    }
  },
);

test("read authorization and result frames cannot discharge a pending invocation", async () => {
  const f = invocationFixture();
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_read_result",
        requestId,
        reply: { type: "service_result", requestId, ok: true, result: { remaining: 999 } },
      }),
    );
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_authorize",
        subject: { kind: "read", requestId },
        authorizationId: "wrong-mode",
        serviceId: f.args.serviceId,
        revision: f.args.revision,
        policySha256: f.args.policySha256,
        operationId: f.args.operationId,
      }),
    );
    expect(f.commands.findLast((command) => command.type === "service_authorized")).toMatchObject({
      allowed: false,
    });
    await expect(pending).rejects.toThrow("service_unauthorized");
  } finally {
    f.store.close();
  }
});

test("owner refusals remain named refusals even before upstream authorization", async () => {
  const f = invocationFixture();
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_invoke_result",
        requestId,
        reply: { type: "service_result", requestId, ok: false, refusal: "service_input_invalid" },
      }),
    );
    expect(await pending).toEqual({
      type: "service_result",
      requestId,
      ok: false,
      refusal: "service_input_invalid",
    });
  } finally {
    f.store.close();
  }
});

function bodyInvocationFixture() {
  const inspect = policy.operations.inspect!;
  if ("kind" in inspect) throw new Error("wrong fixture operation");
  const f = fixture(
    {
      ...policy,
      operations: {
        inspect,
        enroll: {
          ...inspect,
          method: "POST",
          readable: false,
          invocable: true,
          body: [{ path: ["credential", "key"], value: { credentialRef: "enrollment-source" } }],
        },
      },
    },
    "invoke",
  );
  f.args.operationId = "enroll";
  return f;
}

test("hub checks each body source and origin without disabling unrelated metadata operations", async () => {
  const f = bodyInvocationFixture();
  try {
    for (const source of [
      undefined,
      { ref: "enrollment-source", origins: [policy.origin!], available: false },
      { ref: "enrollment-source", origins: ["https://other.invalid"], available: true },
    ]) {
      // Even stale operation advertisements cannot override fresh source availability.
      f.service.event(f.channel, {
        type: "resources",
        resources: {
          ...f.owner.resources!,
          credentialReferences: [
            { ref: "native-account", origins: [policy.origin!], available: true },
            ...(source ? [source] : []),
          ],
        },
      });
      const described = f.service.describeServices(f.root, { machineId: f.machineId }).services[0]!;
      expect(
        described.operations.find((operation) => operation.operationId === "inspect"),
      ).toMatchObject({ ready: true });
      expect(
        described.operations.find((operation) => operation.operationId === "enroll"),
      ).toMatchObject({
        ready: false,
        reason: "service_credential_unavailable",
      });
      await expect(f.service.invokeService(f.root, f.args)).rejects.toThrow(
        "service_credential_unavailable",
      );
    }
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        credentialReferences: [
          { ref: "native-account", origins: [policy.origin!], available: true },
          { ref: "enrollment-source", origins: [policy.origin!], available: true },
        ],
      },
    });
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.result(requestId);
    expect(await pending).toMatchObject({ ok: true });
  } finally {
    f.store.close();
  }
});

test("body source disappearance revokes pending invocations without affecting metadata authority", async () => {
  const f = bodyInvocationFixture();
  try {
    const available = [
      { ref: "native-account", origins: [policy.origin!], available: true },
      { ref: "enrollment-source", origins: [policy.origin!], available: true },
    ];
    f.service.event(f.channel, {
      type: "resources",
      resources: { ...f.owner.resources!, credentialReferences: available },
    });
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.event(f.channel, {
      type: "resources",
      resources: {
        ...f.owner.resources!,
        credentialReferences: [available[0]!],
      },
    });
    f.result(requestId);
    await expect(pending).rejects.toThrow("service_unauthorized");
    expect(
      f.commands.some(
        (command) => command.type === "service_invoke_cancel" && command.requestId === requestId,
      ),
    ).toBe(true);
    const operations = f.service.describeServices(f.root, { machineId: f.machineId }).services[0]!
      .operations;
    expect(operations.find((operation) => operation.operationId === "inspect")?.ready).toBe(true);
    expect(operations.find((operation) => operation.operationId === "enroll")?.ready).toBe(false);
  } finally {
    f.store.close();
  }
});

function accountingPolicy(ceiling = 30): ServicePolicy {
  const original = policy.operations.inspect!;
  if ("kind" in original) throw new Error("wrong fixture operation");
  return {
    ...policy,
    directCostCeilingMicros: ceiling,
    prices: {
      models: {
        "fixture/model": {
          contextTokens: 10,
          inputPerMillion: 1_000_000,
          outputPerMillion: 1_000_000,
        },
      },
    },
    operations: {
      inspect: {
        ...original,
        method: "POST",
        readable: false,
        invocable: true,
        path: "/v1/chat/completions",
        query: {},
        body: [
          { path: ["model"], value: { literal: "fixture/model" } },
          { path: ["messages", 0, "role"], value: { literal: "user" } },
          { path: ["messages", 0, "content"], value: { input: "query" } },
        ],
        meter: { kind: "openai-usage", modelId: "fixture/model" },
      },
    },
  };
}

function accountingFixture(servicePolicy = accountingPolicy(), path = ":memory:") {
  const f = fixture(servicePolicy, "invoke", path);
  f.channel.protocolVersion = PROTOCOL_VERSION;
  f.prove();
  const args: ServiceInvokeArgs = {
    ...f.args,
    accounting: { callId: "call-a", maxCostMicros: 20 },
  };
  const outcome = (
    requestId: string,
    charge: ServiceCharge | undefined,
    target = f.service,
    ok = true,
    channel = f.channel,
  ) =>
    target.event(
      channel,
      JobEventSchema.parse({
        type: "service_invoke_result",
        requestId,
        reply: {
          type: "service_result",
          requestId,
          ...(ok
            ? { ok: true, result: { remaining: 12 } }
            : { ok: false, refusal: "service_upstream_refused" }),
          ...(charge ? { charge } : {}),
        },
      }),
    );
  const known = (callId = args.accounting!.callId, costMicros = 7): ServiceCharge => ({
    callId,
    reservedMicros: 20,
    status: "known",
    costMicros,
  });
  return { ...f, args, outcome, known, policy: servicePolicy };
}

interface AccountingExecutionFixture {
  service: JobService;
  auth: AuthService;
  root: AuthContext;
  runtime: FakeRuntime;
  machineId: string;
  owner: JobOwner;
  policy: ServicePolicy;
  channel: {
    machineId: string;
    protocolVersion?: number;
    send(message: { type: "job_command"; command: JobCommand }): boolean;
  };
}

function replaceAccountingPolicy(f: AccountingExecutionFixture, next: ServicePolicy) {
  const current = f.service.readServiceConfiguration(f.root, { machineId: f.machineId });
  f.service.configureServiceConfiguration(f.root, {
    machineId: f.machineId,
    expectedRevision: current.configuration.revision,
    policies: [next],
  });
  f.owner.resources = {
    ...f.owner.resources!,
    services: { [next.serviceId]: hash(next) },
    serviceDefinitions: {
      [next.serviceId]: { revision: next.revision, operationIds: Object.keys(next.operations) },
    },
  };
  f.service.event(f.channel, { type: "resources", resources: f.owner.resources });
}

test("bounded calls reserve concurrently, recover without replay, and charge once", async () => {
  const f = accountingFixture();
  try {
    const first = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    const secondArgs = { ...f.args, accounting: { callId: "call-b", maxCostMicros: 20 } };
    await expect(f.service.invokeService(f.reader, secondArgs)).rejects.toThrow(
      "service_ceiling_exceeded",
    );
    expect(await f.service.invokeService(f.reader, f.args)).toMatchObject({
      ok: true,
      result: null,
      accounting: { state: "reserved", reservedMicros: 20, chargedMicros: null },
    });
    f.authorize(requestId);
    f.outcome(requestId, f.known());
    expect(await first).toMatchObject({
      ok: true,
      result: { remaining: 12 },
      accounting: { requestId, state: "settled", reservedMicros: 20, chargedMicros: 7 },
    });
    f.outcome(requestId, f.known("call-a", 1));
    const recovered = await f.service.invokeService(f.reader, {
      ...f.args,
      accounting: { ...f.args.accounting!, receiptOnly: true },
    });
    expect(recovered).toMatchObject({ result: null, accounting: { chargedMicros: 7 } });
    expect(recovered).not.toHaveProperty("charge");
    const second = f.service.invokeService(f.reader, secondArgs);
    const secondId = f.pendingCommand().requestId;
    f.authorize(secondId);
    f.outcome(secondId, f.known("call-b", 20));
    await second;
    await expect(
      f.service.invokeService(f.reader, {
        ...f.args,
        accounting: { callId: "call-c", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(2);
    const retained = JSON.stringify(
      f.store.db.query("SELECT * FROM native_service_attempts").all(),
    );
    expect(retained).not.toContain("private-source-input");
    expect(retained).not.toContain("remaining");
    expect(retained).not.toContain("https://");
    expect(retained).not.toContain("native-account");
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("bounded invocation rejects lower ceilings, caller prices, and changed exact-call identity", async () => {
  const f = accountingFixture();
  try {
    await expect(
      f.service.invokeService(f.reader, {
        ...f.args,
        accounting: { ...f.args.accounting!, maxCostMicros: 19 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    const host = await orchestratorHost(f);
    for (const forged of [
      { ...f.args, accounting: { ...f.args.accounting, reservedMicros: 0 } },
      { ...f.args, accounting: { ...f.args.accounting, "private-price-source": 0 } },
      { ...f.args, prices: { inputPerMillion: 0 } },
    ]) {
      const refused = await host.dispatch(f.reader, "engine.services.invoke", forged);
      expect(refused).toMatchObject({ ok: false, denial: { rule: "invalid_args" } });
      expect(JSON.stringify(refused)).not.toContain("private-price-source");
      expect(JSON.stringify(refused)).not.toContain("private-source-input");
    }
    expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    for (const changed of [
      { ...f.args, input: { query: "different prompt" } },
      { ...f.args, revision: "another-policy" },
      { ...f.args, policySha256: "c".repeat(64) },
      { ...f.args, accounting: { ...f.args.accounting!, maxCostMicros: 21 } },
    ])
      await expect(f.service.invokeService(f.reader, changed)).rejects.toThrow(
        "service_accounting_mismatch",
      );
    f.authorize(requestId);
    f.outcome(requestId, f.known());
    await pending;
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test.each(["disconnect", "lost-approval", "lost-result", "policy"] as const)(
  "bounded %s preserves maximum exposure and accepts original late settlement",
  async (failure) => {
    const f = accountingFixture(accountingPolicy(20));
    try {
      const pending = f.service.invokeService(f.reader, f.args);
      const requestId = f.pendingCommand().requestId;
      const send = f.channel.send;
      if (failure === "lost-approval")
        f.channel.send = (message) =>
          message.command.type === "service_authorized" && message.command.allowed
            ? false
            : send(message);
      f.authorize(requestId);
      if (failure === "disconnect") f.service.offline(f.channel);
      if (failure === "policy") replaceAccountingPolicy(f, { ...f.policy, revision: "r2" });
      await expect(pending).rejects.toThrow(
        failure === "lost-result"
          ? "service_timeout"
          : failure === "disconnect"
            ? "service_unavailable"
            : "service_unauthorized",
      );
      f.channel.send = send;
      const receiptArgs = { ...f.args, accounting: { ...f.args.accounting!, receiptOnly: true } };
      expect(await f.service.invokeService(f.reader, receiptArgs)).toMatchObject({
        result: null,
        accounting: { state: "unresolved", reservedMicros: 20, chargedMicros: null },
      });
      if (failure === "disconnect") f.prove();
      const nextArgs = {
        ...f.args,
        ...(failure === "policy"
          ? { revision: "r2", policySha256: hash({ ...f.policy, revision: "r2" }) }
          : {}),
        accounting: { callId: "call-b", maxCostMicros: 20 },
      };
      await expect(f.service.invokeService(f.reader, nextArgs)).rejects.toThrow(
        "service_ceiling_exceeded",
      );
      if (failure === "policy")
        await expect(
          f.service.invokeService(f.reader, {
            ...f.args,
            accounting: { callId: "stale-new-call", maxCostMicros: 20 },
          }),
        ).rejects.toThrow("service_binding_mismatch");
      f.outcome(requestId, f.known());
      expect(await f.service.invokeService(f.reader, receiptArgs)).toMatchObject({
        accounting: { state: "settled", chargedMicros: 7 },
      });
      expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
    } finally {
      f.service.offline(f.channel);
      f.store.close();
    }
  },
  10000,
);

test("native charge forgery stays unresolved, while valid charged failures and nonattempts settle", async () => {
  const f = accountingFixture(accountingPolicy(20));
  try {
    const refused = f.service.invokeService(f.reader, f.args);
    const refusedId = f.pendingCommand().requestId;
    f.outcome(
      refusedId,
      {
        callId: "call-a",
        reservedMicros: 20,
        status: "not_dispatched",
        costMicros: 0,
      },
      f.service,
      false,
    );
    expect(await refused).toMatchObject({
      ok: false,
      accounting: { state: "settled", chargedMicros: 0 },
    });
    const args = { ...f.args, accounting: { callId: "call-b", maxCostMicros: 20 } };
    const pending = f.service.invokeService(f.reader, args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.outcome(requestId, { ...f.known("call-b", 1), reservedMicros: 1 });
    expect(await pending).toMatchObject({
      accounting: { state: "unresolved", chargedMicros: null },
    });
    await expect(
      f.service.invokeService(f.reader, {
        ...args,
        accounting: { callId: "call-c", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    f.outcome(requestId, f.known("wrong-call", 0));
    expect(await f.service.invokeService(f.reader, args)).toMatchObject({
      accounting: { state: "unresolved", chargedMicros: null },
    });
    f.outcome(requestId, f.known("call-b", 7), f.service, false);
    expect(await f.service.invokeService(f.reader, args)).toMatchObject({
      result: null,
      accounting: { state: "settled", chargedMicros: 7 },
    });
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("receipt recovery uses the original actor and current service authority, never root visibility", async () => {
  const f = accountingFixture(accountingPolicy(100));
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    const receiptArgs = { ...f.args, accounting: { ...f.args.accounting!, receiptOnly: true } };
    await expect(f.service.invokeService(f.root, receiptArgs)).rejects.toThrow(
      "service_accounting_unavailable",
    );
    expect(() =>
      f.service.readServiceConfiguration(f.reader, { machineId: f.machineId }),
    ).toThrow();
    f.auth.revokePrincipal(f.reader.principal.id, f.root);
    await expect(pending).rejects.toThrow("service_unauthorized");
    f.outcome(requestId, f.known());
    await expect(f.service.invokeService(f.reader, receiptArgs)).rejects.toThrow(
      "service_unauthorized",
    );
    expect(f.store.directServiceAttempt(f.reader.principal.id, "call-a")).toMatchObject({
      state: "settled",
      chargedMicros: 7,
    });
    const independent = f.service.invokeService(f.root, f.args);
    const independentId = f.pendingCommand().requestId;
    expect(independentId).not.toBe(requestId);
    f.authorize(independentId);
    f.outcome(independentId, f.known());
    expect(await independent).toMatchObject({ accounting: { requestId: independentId } });
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("reopening SQLite preserves exposure, exact-id recovery, and authenticated late settlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manifold-direct-accounting-"));
  const path = join(directory, "hub.sqlite");
  const f = accountingFixture(accountingPolicy(20), path);
  let reopened: ServerStore | undefined;
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.offline(f.channel);
    await expect(pending).rejects.toThrow("service_unavailable");
    f.store.close();
    reopened = new ServerStore(openDatabase(path));
    const auth = new AuthService(reopened, "9".repeat(64), f.runtime);
    const restarted = new JobService(reopened, auth, f.runtime);
    restarted.setLifecycleRecorder((record) => reopened!.appendTrace(record));
    const args = { ...f.args, accounting: { ...f.args.accounting!, receiptOnly: true } };
    expect(await restarted.invokeService(f.reader, args)).toMatchObject({
      accounting: { requestId, state: "unresolved", chargedMicros: null },
    });
    f.prove(restarted);
    await expect(
      restarted.invokeService(f.reader, {
        ...f.args,
        accounting: { callId: "after-restart", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    f.outcome(requestId, f.known(), restarted, true, { ...f.channel });
    expect(await restarted.invokeService(f.reader, args)).toMatchObject({
      accounting: { state: "unresolved" },
    });
    f.outcome(requestId, f.known(), restarted);
    f.outcome(requestId, f.known("call-a", 0), restarted);
    expect(await restarted.invokeService(f.reader, f.args)).toMatchObject({
      result: null,
      accounting: { state: "settled", chargedMicros: 7 },
    });
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
    restarted.offline(f.channel);
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded quotes need explicit installed prices and modern owners; ordinary invocation remains unmetered", async () => {
  for (const scenario of [
    "unpriced",
    "default-price",
    "unbounded",
    "unmetered",
    "legacy-owner",
    "legacy-transport",
    "ordinary",
  ] as const) {
    const definition = accountingPolicy();
    if (scenario === "unpriced") delete definition.prices;
    if (scenario === "unbounded") delete definition.prices!.models["fixture/model"]!.contextTokens;
    if (scenario === "default-price")
      definition.prices = { models: {}, default: definition.prices!.models["fixture/model"]! };
    if (scenario === "unmetered") {
      const operation = definition.operations.inspect!;
      if ("kind" in operation) throw new Error("wrong fixture operation");
      delete operation.meter;
    }
    const f = accountingFixture(definition);
    try {
      if (scenario === "legacy-owner") {
        f.owner.protocolVersion = 43;
        f.prove();
        const configured = f.commands.findLast((command) => command.type === "configure_services");
        expect(configured).toMatchObject({ configuration: { policies: [] } });
      }
      if (scenario === "legacy-transport") {
        f.channel.protocolVersion = 51;
        f.prove();
        expect(
          f.service
            .describeServices(f.reader, { machineId: f.machineId })
            .services[0]!.operations.find((operation) => operation.operationId === "inspect"),
        ).toMatchObject({
          ready: false,
          reason: "service_accounting_protocol_unsupported",
        });
      }
      if (scenario === "ordinary") {
        const args = {
          machineId: f.args.machineId,
          serviceId: f.args.serviceId,
          revision: f.args.revision,
          policySha256: f.args.policySha256,
          operationId: f.args.operationId,
          input: f.args.input,
        };
        const pending = f.service.invokeService(f.reader, args);
        const requestId = f.pendingCommand().requestId;
        f.authorize(requestId);
        f.outcome(requestId, undefined);
        expect(await pending).toEqual({
          type: "service_result",
          requestId,
          ok: true,
          result: { remaining: 12 },
        });
        expect(f.store.directServiceAttempt(f.reader.principal.id, "call-a")).toBeNull();
      } else {
        await expect(f.service.invokeService(f.reader, f.args)).rejects.toThrow(
          scenario === "unpriced" || scenario === "default-price"
            ? "service_price_unknown"
            : scenario === "unbounded"
              ? "service_accounting_bound_unknown"
              : scenario === "unmetered"
                ? "service_accounting_unsupported"
                : "service_accounting_protocol_unsupported",
        );
        expect(f.commands.some((command) => command.type === "service_invoke")).toBe(false);
      }
    } finally {
      f.service.offline(f.channel);
      f.store.close();
    }
  }
});

async function accountingExecution(f: AccountingExecutionFixture) {
  const installed = install(f, f.policy, { costMicros: 30 });
  f.service.consent(f.root, {
    machineId: f.machineId,
    pluginId: installed.pluginId,
    installationRevision: "r1",
    artifactSha256: installed.artifactSha256,
    node: formatManifoldUri({
      kind: "operation",
      machineId: f.machineId,
      operationId: installed.operationId,
    }),
    cap: "machines:run",
    enabled: true,
  });
  f.service.setAgentTools({
    harnessPlugin: () => installed.pluginId,
    call: async () => {
      throw new Error("no agent tool transport required");
    },
  });
  f.channel.protocolVersion = PROTOCOL_VERSION;
  const run = await createExternalRun(
    { auth: f.auth, runtime: f.runtime, owner: f.root },
    {
      name: "accounting execution",
      purpose: "Use the governed direct service",
      target: "manifold://",
      reach: "subtree",
      caps: ["services:invoke"],
    },
  );
  const actor = f.auth.authenticate(run.credential.token);
  const challenge = f.auth.agentPolicyChallenge(actor);
  f.auth.acknowledgeAgentPolicy(
    {
      revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
    },
    actor,
  );
  const job = f.service.execute(f.root, installed.pluginId, "accounting-execution", {
    jobId: "accounting-execution",
    machineId: f.machineId,
    operationId: installed.operationId,
    input: {},
    outputs: [],
    agentRun: {
      runId: run.run.id,
      sessionId: "accounting-session",
      target: { machineId: f.machineId },
    },
  });
  f.service.event(f.channel, {
    type: "state",
    jobId: job.request.jobId,
    requestDigest: job.request.requestDigest,
    ownerId: f.owner.ownerId,
    ownerGeneration: f.owner.generation,
    state: "started",
  });
  return actor;
}

test("persisted native execution ceilings reserve concurrent direct calls independently of service allowance", async () => {
  const f = accountingFixture(accountingPolicy(100));
  try {
    const actor = await accountingExecution(f);
    const first = f.service.invokeService(actor, f.args);
    const requestId = f.pendingCommand().requestId;
    const secondArgs = { ...f.args, accounting: { callId: "call-b", maxCostMicros: 20 } };
    await expect(f.service.invokeService(actor, secondArgs)).rejects.toThrow(
      "service_ceiling_exceeded",
    );
    f.authorize(requestId);
    f.outcome(requestId, f.known());
    await first;
    const second = f.service.invokeService(actor, secondArgs);
    const secondId = f.pendingCommand().requestId;
    f.authorize(secondId);
    f.outcome(secondId, f.known("call-b", 20));
    await second;
    await expect(
      f.service.invokeService(actor, {
        ...f.args,
        accounting: { callId: "call-c", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("a native execution with metered proxy authority refuses a direct monetary guarantee, not ordinary calls", async () => {
  const definition = accountingPolicy(100);
  definition.operations.proxy = {
    kind: "http-proxy",
    method: "POST",
    path: "/v1/chat/completions",
    request: { kind: "json", disclosure: "full" },
    response: {
      kind: "stream",
      disclosure: "full",
      contentTypes: ["application/json"],
      headers: [],
    },
    timeoutMs: 1000,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
    meter: { kind: "openai-usage" },
  };
  const f = accountingFixture(definition);
  try {
    const actor = await accountingExecution(f);
    await expect(f.service.invokeService(actor, f.args)).rejects.toThrow(
      "service_accounting_execution_mixed_lanes",
    );
    const ordinary = {
      machineId: f.args.machineId,
      serviceId: f.args.serviceId,
      revision: f.args.revision,
      policySha256: f.args.policySha256,
      operationId: f.args.operationId,
      input: f.args.input,
    };
    const pending = f.service.invokeService(actor, ordinary);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.outcome(requestId, undefined);
    expect(await pending).toMatchObject({ ok: true, result: { remaining: 12 } });
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("the public service door offers a bounded quote and exact receipt without configuration authority", async () => {
  const f = accountingFixture();
  try {
    const host = await orchestratorHost(f);
    expect(
      await host.dispatch(f.reader, "engine.services.describe", { machineId: f.machineId }),
    ).toMatchObject({
      ok: true,
      result: {
        services: [
          {
            serviceId: f.args.serviceId,
            policySha256: f.args.policySha256,
            operations: [
              {
                operationId: "inspect",
                meter: { kind: "openai-usage", modelId: "fixture/model" },
                accounting: { modelId: "fixture/model", reservedMicros: 20 },
              },
            ],
          },
        ],
      },
    });
    const lower = await host.dispatch(f.reader, "engine.services.invoke", {
      ...f.args,
      accounting: { ...f.args.accounting, maxCostMicros: 19 },
    });
    expect(lower).toMatchObject({ ok: false });
    expect(JSON.stringify(lower)).toContain("service_ceiling_exceeded");
    expect(
      await host.dispatch(f.reader, "engine.services.readConfiguration", {
        machineId: f.machineId,
      }),
    ).toMatchObject({ ok: false });
    const started = Promise.withResolvers<string>();
    const send = f.channel.send;
    f.channel.send = (message) => {
      if (message.command.type === "service_invoke") started.resolve(message.command.requestId);
      return send(message);
    };
    const pending = host.dispatch(f.reader, "engine.services.invoke", f.args);
    const requestId = await Promise.race([
      started.promise,
      pending.then(() => {
        throw new Error("bounded door settled before dispatch");
      }),
    ]);
    f.authorize(requestId);
    f.outcome(requestId, f.known(), f.service, false);
    expect(await pending).toMatchObject({
      ok: true,
      result: { ok: false, refusal: "service_upstream_refused", accounting: { chargedMicros: 7 } },
    });
    const receipt = await host.dispatch(f.reader, "engine.services.invoke", {
      ...f.args,
      accounting: { ...f.args.accounting, receiptOnly: true },
    });
    expect(receipt).toMatchObject({
      ok: true,
      result: {
        ok: true,
        result: null,
        accounting: { requestId, state: "settled", chargedMicros: 7 },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private-source-input");
    expect(JSON.stringify(receipt)).not.toContain("native-account");
    expect(JSON.stringify(receipt)).not.toContain("https://");
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("a changed installed model cannot replace an unresolved original or reset its allowance", async () => {
  const f = accountingFixture(accountingPolicy(20));
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    const next = accountingPolicy(20);
    next.revision = "model-replacement";
    next.prices = { models: { "fixture/new-model": next.prices!.models["fixture/model"]! } };
    const operation = next.operations.inspect!;
    if ("kind" in operation) throw new Error("wrong fixture operation");
    operation.meter = { kind: "openai-usage", modelId: "fixture/new-model" };
    operation.body[0] = { path: ["model"], value: { literal: "fixture/new-model" } };
    replaceAccountingPolicy(f, next);
    await expect(pending).rejects.toThrow("service_unauthorized");
    const replaced = { ...f.args, revision: next.revision, policySha256: hash(next) };
    await expect(f.service.invokeService(f.reader, replaced)).rejects.toThrow(
      "service_accounting_mismatch",
    );
    await expect(
      f.service.invokeService(f.reader, {
        ...replaced,
        accounting: { callId: "new-model-call", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    f.outcome(requestId, f.known());
    expect(await f.service.invokeService(f.reader, f.args)).toMatchObject({
      result: null,
      accounting: { modelId: "fixture/model", state: "settled", chargedMicros: 7 },
    });
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("a replacement owner generation cannot settle an original generation's unknown exposure", async () => {
  const f = accountingFixture(accountingPolicy(20));
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    f.authorize(requestId);
    f.service.offline(f.channel);
    await expect(pending).rejects.toThrow("service_unavailable");
    f.owner.generation++;
    f.prove();
    f.outcome(requestId, f.known("call-a", 0));
    expect(await f.service.invokeService(f.reader, f.args)).toMatchObject({
      result: null,
      accounting: { state: "unresolved", reservedMicros: 20, chargedMicros: null },
    });
    await expect(
      f.service.invokeService(f.reader, {
        ...f.args,
        accounting: { callId: "after-owner-restart", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});

test("generic JSON-usage mappings share the installed quote, atomic allowance, and bounded receipt", async () => {
  const definition = accountingPolicy(20);
  const operation = definition.operations.inspect!;
  if ("kind" in operation) throw new Error("wrong fixture operation");
  operation.meter = { kind: "json-usage", modelId: "fixture/model" };
  operation.body = [
    { path: ["model"], value: { literal: "fixture/model" } },
    { path: ["state"], value: { input: "query" } },
    { path: ["questions", 0, "id"], value: { literal: "question" } },
    { path: ["questions", 0, "text"], value: { input: "query" } },
  ];
  operation.response = { kind: "projected-json", fields: [["answers"]], maxArrayItems: 16 };
  const f = accountingFixture(definition);
  try {
    const pending = f.service.invokeService(f.reader, f.args);
    const requestId = f.pendingCommand().requestId;
    await expect(
      f.service.invokeService(f.reader, {
        ...f.args,
        accounting: { callId: "parallel-json-call", maxCostMicros: 20 },
      }),
    ).rejects.toThrow("service_ceiling_exceeded");
    f.authorize(requestId);
    f.service.event(
      f.channel,
      JobEventSchema.parse({
        type: "service_invoke_result",
        requestId,
        reply: {
          type: "service_result",
          requestId,
          ok: true,
          result: { answers: { question: "answer" } },
          charge: f.known(),
        },
      }),
    );
    expect(await pending).toMatchObject({
      ok: true,
      result: { answers: { question: "answer" } },
      accounting: {
        modelId: "fixture/model",
        state: "settled",
        reservedMicros: 20,
        chargedMicros: 7,
      },
    });
    expect(await f.service.invokeService(f.reader, f.args)).toMatchObject({
      result: null,
      accounting: { state: "settled", chargedMicros: 7 },
    });
    expect(f.commands.filter((command) => command.type === "service_invoke")).toHaveLength(1);
  } finally {
    f.service.offline(f.channel);
    f.store.close();
  }
});
