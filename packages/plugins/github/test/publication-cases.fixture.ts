import { expect, test } from "bun:test";
import {
  CAPS,
  LIMITS,
  PublicationSchema,
  ReadConnectionsResultSchema,
  bytes,
  type Publication,
} from "../src/contract.ts";
import { handlers, lifecycle } from "../src/publication.ts";
import { draft, publicationFixture, reviewed } from "./publication-context.fixture.ts";
import {
  PRIVATE_CANARY,
  RESPONSE_CANARY,
  SYNTHETIC_CREDENTIAL,
  REPOSITORY_PATH,
  barrier,
  hash,
  issueEvidence,
  type FixtureBarrier,
} from "./publication-native.fixture.ts";

function refusal(value: unknown) {
  expect(value).toEqual({ refused: expect.stringMatching(/^[a-z][a-z0-9_]*$/) });
  const serialized = JSON.stringify(value);
  for (const privateValue of [PRIVATE_CANARY, RESPONSE_CANARY, SYNTHETIC_CREDENTIAL])
    expect(serialized).not.toContain(privateValue);
}
function unknown(value: unknown): Publication {
  const result = PublicationSchema.parse(value);
  expect(result.state).toBe("outcome_unknown");
  expect(result.receipt).toBeNull();
  return result;
}

async function reach(boundary: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    boundary,
    pending.then((result) => {
      throw new Error(
        `handler settled before the intended native boundary: ${JSON.stringify(result)}`,
      );
    }),
  ]);
}

// Deliberately serial: the receiver owns this test process's HTTPS interception. No test.concurrent.
test("duplicate preparation and clicks share one reviewed payload and one accepted create", async () => {
  const f = await publicationFixture();
  let pending: Promise<unknown> | undefined;
  try {
    const [one, two] = await Promise.all([f.prepare(), f.prepare()]);
    expect(two).toEqual(one);
    expect(one.state).toBe("ready");
    expect(one.publicTitle).toBe(draft.publicTitle);
    expect(one.publicBody).toBe(`${draft.publicBody}\n\n${one.marker}`);
    expect(f.receiver.accepted).toEqual([]);
    f.receiver.state.create = "hold";
    pending = handlers.publishIssue(f.ctx(), reviewed(one));
    await reach(f.receiver.state.createGate.entered, pending);
    expect((await f.publish(two)).state).toBe("dispatching");
    const lookups = f.receiver.requests.filter((request) =>
      request.path.startsWith(`${REPOSITORY_PATH}/issues`),
    ).length;
    expect(
      PublicationSchema.parse(
        await handlers.reconcilePublication(f.ctx(), {
          operationId: one.operationId,
          issueNumber: 1,
        }),
      ).state,
    ).toBe("dispatching");
    expect(
      f.receiver.requests.filter((request) => request.path.startsWith(`${REPOSITORY_PATH}/issues`)),
    ).toHaveLength(lookups);
    f.receiver.state.createGate.release();
    const published = PublicationSchema.parse(await pending);
    expect(published.state).toBe("published");
    expect(published.receipt).toEqual({
      operationId: one.operationId,
      reviewedDigest: one.reviewedDigest,
      repositoryNodeId: "R_fixture_repo",
      issueNodeId: "I_fixture_1",
      issueId: 10001,
      issueNumber: 1,
      url: "https://github.com/fixture-owner/fixture-repo/issues/1",
      accountNodeId: "U_fixture_user",
    });
    expect(f.receiver.requests.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        path: `${REPOSITORY_PATH}/issues`,
        body: { title: one.publicTitle, body: one.publicBody },
      },
    ]);
    expect(await f.publish(one)).toEqual(published);
    expect(await f.prepare()).toEqual(published);
    expect(f.receiver.accepted).toHaveLength(1);
    for (const privateValue of [PRIVATE_CANARY, RESPONSE_CANARY, SYNTHETIC_CREDENTIAL])
      expect(JSON.stringify(published)).not.toContain(privateValue);
  } finally {
    f.receiver.state.createGate.release();
    if (pending) await pending;
    await f.close();
  }
});

test("changed public bytes, review digest, destination, installation and native pins never silently allocate or post", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    for (const change of [
      { publicTitle: "Changed" },
      { publicBody: "Changed" },
      { connectionId: "second-connection" },
    ]) {
      if ("connectionId" in change)
        await f.configureConnection({ ...f.state.metadata, connectionId: "second-connection" });
      refusal(await handlers.prepareIssuePublication(f.ctx(), { ...draft, ...change }));
    }
    refusal(
      await handlers.publishIssue(f.ctx(), { ...reviewed(ready), reviewedDigest: "f".repeat(64) }),
    );
    f.state.installation = "b".repeat(64);
    refusal(await handlers.prepareIssuePublication(f.ctx(), draft));
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    f.state.installation = "a".repeat(64);
    f.state.policy = { ...f.state.policy, revision: "fixture-r2" };
    f.runner.configure([f.state.policy]);
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    f.state.metadata = {
      ...f.state.metadata,
      serviceRevision: f.state.policy.revision,
      policySha256: hash(f.state.policy),
    };
    await f.configureConnection(f.state.metadata, ready.connection.connectionRevision);
    refusal(await handlers.prepareIssuePublication(f.ctx(), draft));
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
});

test("requester isolation is not a sibling ACL and direct same-requester access preserves the operation", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    const principal = f.state.principal;
    for (const changed of [
      { ...principal, id: "different-human" },
      { ...principal, kind: "agent" as const },
      { ...principal, origin: "https://foreign.example" },
    ]) {
      f.state.principal = changed;
      refusal(await handlers.readPublication(f.ctx(), { operationId: ready.operationId }));
      refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
      refusal(await handlers.reconcilePublication(f.ctx(), { operationId: ready.operationId }));
    }
    f.state.principal = principal;
    refusal(await handlers.readPublication(f.ctx(), { operationId: "0".repeat(32) }));
    f.state.callerPlugin = null;
    f.state.root = false;
    expect(await f.readPublication(ready)).toEqual(ready);
    const published = await f.publish(ready);
    expect(published.state).toBe("published");
    f.state.callerPlugin = "another.authorized.consumer";
    expect(await f.readPublication(ready)).toEqual(published);
    f.state.callerPlugin = "fixture.consumer";
    expect(await f.prepare()).toEqual(published);
    // Direct preparation is a separate namespace, not a claim to the sibling's consumerRef.
    f.state.callerPlugin = null;
    const direct = await f.prepare();
    expect(direct.operationId).not.toBe(ready.operationId);
    expect(f.receiver.accepted).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("root withdrawal during connection validation does not register a destination", async () => {
  const f = await publicationFixture(false);
  const gate = barrier();
  let pending: Promise<unknown> | undefined;
  try {
    f.state.preflightGate = gate;
    pending = handlers.configureConnection(f.ctx(), {
      ...f.state.metadata,
      expectedRevision: null,
    });
    await reach(gate.entered, pending);
    f.state.root = false;
    gate.release();
    refusal(await pending);
    f.state.preflightGate = null;
    f.state.root = true;
    expect(
      ReadConnectionsResultSchema.parse(await handlers.readConnections(f.ctx(), {})).connections,
    ).toEqual([]);
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    gate.release();
    if (pending) await pending;
    await f.close();
  }
});

test("account-read withdrawal during repository validation prevents publication", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    f.state.beforeNativeAuthorization = async (operationId) => {
      if (operationId === "repository") f.state.deniedOperations.add("account");
    };
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    expect(f.receiver.accepted).toEqual([]);
    expect(f.receiver.requests.filter((request) => request.method === "POST")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("account-read withdrawal cannot reveal the connection directory", async () => {
  const f = await publicationFixture();
  try {
    f.state.beforeNativeAuthorization = async (operationId) => {
      if (operationId === "repository") f.state.deniedOperations.add("account");
    };
    refusal(await handlers.readConnections(f.ctx(), {}));
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
});

test("current provider/native authority and credential availability override a root snapshot", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    for (const cap of [CAPS.publish, "services:read", "services:invoke"]) {
      f.state.deniedCaps.add(cap);
      refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
      f.state.deniedCaps.delete(cap);
    }
    f.state.deniedCaps.add(CAPS.read);
    refusal(await handlers.readPublication(f.ctx(), { operationId: ready.operationId }));
    f.state.deniedCaps.delete(CAPS.read);
    f.state.credentialAvailable = false;
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    expect(
      ReadConnectionsResultSchema.parse(await handlers.readConnections(f.ctx(), {})).connections,
    ).toEqual([]);
    f.state.credentialAvailable = true;
    f.state.connected = false;
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    f.state.connected = true;
    f.state.nativeAllowed = false;
    refusal(await handlers.publishIssue(f.ctx(), reviewed(ready)));
    expect(f.receiver.accepted).toEqual([]);
    f.state.nativeAllowed = true;
    expect((await f.publish(ready)).state).toBe("published");
  } finally {
    await f.close();
  }
});

test("revocation while native identity IO is pending prevents create and discloses no payload", async () => {
  const f = await publicationFixture();
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await f.prepare();
    const gate = barrier();
    f.receiver.state.readGate = gate;
    pending = handlers.publishIssue(f.ctx(), reviewed(ready));
    await reach(gate.entered, pending);
    f.state.deniedCaps.add(CAPS.publish);
    gate.release();
    refusal(await pending);
    expect(f.receiver.accepted).toEqual([]);
    f.state.deniedCaps.clear();
    f.receiver.state.readGate = null;
    expect((await f.readPublication(ready)).state).toBe("ready");
  } finally {
    f.receiver.state.readGate?.release();
    if (pending) await pending;
    await f.close();
  }
});

test("revocation after receiver acceptance fences the effect instead of making it retryable", async () => {
  const f = await publicationFixture();
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await f.prepare();
    f.receiver.state.create = "hold";
    pending = handlers.publishIssue(f.ctx(), reviewed(ready));
    await reach(f.receiver.state.createGate.entered, pending);
    f.state.deniedCaps.add("services:invoke");
    f.receiver.state.createGate.release();
    refusal(await pending);
    f.state.deniedCaps.clear();
    unknown(await f.readPublication(ready));
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toHaveLength(1);
  } finally {
    f.receiver.state.createGate.release();
    if (pending) await pending;
    await f.close();
  }
});

test("native authorization revoked while invoke is admitted makes unknown without reaching the receiver", async () => {
  const f = await publicationFixture();
  const gate = barrier();
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await f.prepare();
    f.state.beforeNativeAuthorization = async (operationId) => {
      if (operationId === "create") await gate.wait();
    };
    pending = handlers.publishIssue(f.ctx(), reviewed(ready));
    await reach(gate.entered, pending);
    f.state.nativeAllowed = false;
    gate.release();
    unknown(await pending);
    f.state.beforeNativeAuthorization = null;
    f.state.nativeAllowed = true;
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    gate.release();
    if (pending) await pending;
    await f.close();
  }
});

test.each(["before", "after"] as const)(
  "receipt persistence uncertainty %s the real SQLite write never repeats an accepted create",
  async (fault) => {
    const f = await publicationFixture();
    let pending: Promise<unknown> | undefined;
    try {
      const ready = await f.prepare();
      f.receiver.state.create = "hold";
      pending = handlers.publishIssue(f.ctx(), reviewed(ready));
      await reach(f.receiver.state.createGate.entered, pending);
      const accepted = f.receiver.accepted[0];
      if (!accepted) throw new Error("receipt fault was reached without receiver acceptance");
      f.state.nextDatabaseRunFault = fault;
      f.receiver.state.createGate.release();
      const answer = PublicationSchema.parse(await pending);
      const receipt = {
        operationId: ready.operationId,
        reviewedDigest: ready.reviewedDigest,
        repositoryNodeId: ready.connection.repositoryNodeId,
        issueNodeId: accepted.node_id,
        issueId: accepted.id,
        issueNumber: accepted.number,
        url: accepted.html_url,
        accountNodeId: ready.connection.accountNodeId,
      };
      if (fault === "before") {
        unknown(answer);
        expect(answer.candidateIssueNumber).toBe(accepted.number);
        expect(answer.reconciliation).toBe("receipt_uncommitted");
      } else {
        expect(answer.state).toBe("published");
        expect(answer.receipt).toEqual(receipt);
        expect(answer.candidateIssueNumber).toBeNull();
        expect(answer.reconciliation).toBeNull();
      }
      expect(await f.readPublication(ready)).toEqual(answer);
      await f.restart();
      expect(await f.prepare()).toEqual(answer);
      expect(await f.publish(ready)).toEqual(answer);
      const reconciled = PublicationSchema.parse(
        await handlers.reconcilePublication(f.ctx(), {
          operationId: ready.operationId,
          issueNumber: accepted.number,
        }),
      );
      expect(reconciled.state).toBe("published");
      expect(reconciled.receipt).toEqual(receipt);
      expect(await f.publish(ready)).toEqual(reconciled);
      expect(f.receiver.accepted).toHaveLength(1);
      expect(f.receiver.requests.filter((request) => request.method === "POST")).toEqual([
        {
          method: "POST",
          path: `${REPOSITORY_PATH}/issues`,
          body: { title: ready.publicTitle, body: ready.publicBody },
        },
      ]);
    } finally {
      f.receiver.state.createGate.release();
      if (pending) await pending;
      await f.close();
    }
  },
);

test("absent provisioning, unsupported identities and extra private/proxy input refuse without create", async () => {
  const f = await publicationFixture(false);
  try {
    f.state.root = false;
    refusal(
      await handlers.configureConnection(f.ctx(), { ...f.state.metadata, expectedRevision: null }),
    );
    f.state.root = true;
    f.state.credentialAvailable = false;
    refusal(
      await handlers.configureConnection(f.ctx(), { ...f.state.metadata, expectedRevision: null }),
    );
    f.state.credentialAvailable = true;
    await f.configureConnection();
    for (const injected of [
      { privateContext: PRIVATE_CANARY },
      { token: SYNTHETIC_CREDENTIAL },
      { callerPlugin: "fixture.consumer" },
      { url: "http://127.0.0.1/escape" },
    ]) {
      refusal(await handlers.prepareIssuePublication(f.ctx(), { ...draft, ...injected }));
    }
    for (const mutate of [
      () => {
        f.receiver.state.account.type = "Bot";
      },
      () => {
        f.receiver.state.account.node_id = "U_other";
      },
      () => {
        f.receiver.state.repository.node_id = "R_other";
      },
      () => {
        f.receiver.state.repository.archived = true;
      },
      () => {
        f.receiver.state.repository.has_issues = false;
      },
      () => {
        f.receiver.state.repository.html_url = "https://github.com/other/repo";
      },
    ]) {
      const account = structuredClone(f.receiver.state.account);
      const repository = structuredClone(f.receiver.state.repository);
      mutate();
      refusal(await handlers.prepareIssuePublication(f.ctx(), draft));
      f.receiver.state.account = account;
      f.receiver.state.repository = repository;
    }
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
});

test("UTF-8 and final marker bytes are bounded before retention or native create", async () => {
  const f = await publicationFixture();
  try {
    const first = await f.prepare();
    const overhead = bytes(first.publicBody) - bytes(draft.publicBody);
    const maximum = {
      ...draft,
      consumerRef: "maximum",
      publicTitle: "é".repeat(LIMITS.titleBytes / 2),
      publicBody: "x".repeat(LIMITS.bodyBytes - overhead),
    };
    const ready = await f.prepare(maximum);
    expect(bytes(ready.publicTitle)).toBe(LIMITS.titleBytes);
    expect(bytes(ready.publicBody)).toBe(LIMITS.bodyBytes);
    refusal(
      await handlers.prepareIssuePublication(f.ctx(), {
        ...maximum,
        consumerRef: "too-large-body",
        publicBody: `${maximum.publicBody}x`,
      }),
    );
    refusal(
      await handlers.prepareIssuePublication(f.ctx(), {
        ...draft,
        publicTitle: `${maximum.publicTitle}x`,
      }),
    );
    refusal(await handlers.prepareIssuePublication(f.ctx(), { ...draft, publicTitle: "\ud800" }));
    refusal(
      await handlers.prepareIssuePublication(f.ctx(), {
        ...draft,
        consumerRef: "json-encoding-overflow",
        publicBody: "\u0000".repeat(11_000),
      }),
    );
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
});

test("the encoded JSON plus fixed request target fits exactly, and one extra byte refuses", async () => {
  const f = await publicationFixture();
  try {
    const first = await f.prepare();
    const targetBytes = bytes(`${REPOSITORY_PATH}/issues`);
    const framingBytes = bytes(
      JSON.stringify({
        title: draft.publicTitle,
        body: `\n\n${first.marker}`,
      }),
    );
    const available = 65_536 - targetBytes - framingBytes;
    // NUL costs one retained UTF-8 byte but six JSON bytes; fill the exact remainder with ASCII.
    const publicBody = "\u0000".repeat(Math.floor(available / 6)) + "x".repeat(available % 6);
    const ready = await f.prepare({
      ...draft,
      consumerRef: "encoded-request-boundary",
      publicBody,
    });
    expect(
      bytes(JSON.stringify({ title: ready.publicTitle, body: ready.publicBody })) + targetBytes,
    ).toBe(65_536);
    refusal(
      await handlers.prepareIssuePublication(f.ctx(), {
        ...draft,
        consumerRef: "encoded-request-overflow",
        publicBody: `${publicBody}x`,
      }),
    );
    expect(f.receiver.accepted).toEqual([]);
    expect((await f.publish(ready)).state).toBe("published");
    expect(f.receiver.requests.filter((request) => request.method === "POST")).toEqual([
      {
        method: "POST",
        path: `${REPOSITORY_PATH}/issues`,
        body: { title: ready.publicTitle, body: ready.publicBody },
      },
    ]);
  } finally {
    await f.close();
  }
});

test("active-call ceiling covers reads as well as creates and releases every denied slot", async () => {
  const f = await publicationFixture();
  const gates: FixtureBarrier[] = [];
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < LIMITS.activeCalls; index++) {
      const gate = barrier();
      gates.push(gate);
      f.state.preflightGate = gate;
      pending.push(
        handlers.prepareIssuePublication(f.ctx(), { ...draft, consumerRef: `held-${index}` }),
      );
      await reach(gate.entered, pending[index]!);
    }
    refusal(await handlers.readConnections(f.ctx(), {}));
    refusal(await handlers.prepareIssuePublication(f.ctx(), { ...draft, consumerRef: "over-cap" }));
    expect(f.receiver.accepted).toEqual([]);
    f.state.preflightGate = null;
    for (const gate of gates) gate.release();
    for (const answer of await Promise.all(pending))
      expect(PublicationSchema.parse(answer).state).toBe("ready");
    expect((await f.prepare()).state).toBe("ready");
  } finally {
    f.state.preflightGate = null;
    for (const gate of gates) gate.release();
    await Promise.all(pending);
    await f.close();
  }
});

test("connection and retained operation ceilings refuse new keys but preserve existing exact retries", async () => {
  const f = await publicationFixture();
  try {
    for (let index = 1; index < LIMITS.connections; index++)
      await f.configureConnection({ ...f.state.metadata, connectionId: `connection-${index}` });
    refusal(
      await handlers.configureConnection(f.ctx(), {
        ...f.state.metadata,
        connectionId: "too-many-connections",
        expectedRevision: null,
      }),
    );
    const original = await f.prepare();
    for (let index = 1; index < LIMITS.operations; index++)
      await f.prepare({ ...draft, consumerRef: `bounded-${index}` });
    refusal(
      await handlers.prepareIssuePublication(f.ctx(), {
        ...draft,
        consumerRef: "over-operation-bound",
      }),
    );
    expect(await f.prepare()).toEqual(original);
    expect(await f.readPublication(original)).toEqual(original);
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
}, 120_000);

test("retained public text exhausts its byte bound before the operation-count bound", async () => {
  const f = await publicationFixture();
  try {
    let last: Publication | undefined;
    let refused = false;
    let count = 0;
    const input = { ...draft, publicBody: "x".repeat(32_000) };
    for (; count < LIMITS.operations; count++) {
      const answer = await handlers.prepareIssuePublication(f.ctx(), {
        ...input,
        consumerRef: `large-${count}`,
      });
      if ("refused" in answer) {
        refusal(answer);
        refused = true;
        break;
      }
      last = PublicationSchema.parse(answer);
    }
    expect(refused).toBe(true);
    expect(count * bytes(input.publicBody)).toBeLessThanOrEqual(LIMITS.retainedBytes);
    expect(count).toBeLessThan(LIMITS.operations);
    if (!last) throw new Error("retention refused the first legal draft");
    expect(await f.prepare({ ...input, consumerRef: `large-${count - 1}` })).toEqual(last);
    expect(await f.readPublication(last)).toEqual(last);
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
}, 120_000);

test("accepted create with lost response remains unknown across close/reopen and every retry", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    f.receiver.state.create = "drop";
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toHaveLength(1);
    await f.restart();
    unknown(await f.prepare());
    unknown(await f.publish(ready));
    unknown(await f.publish(ready));
    unknown(await f.readPublication(ready));
    expect(f.receiver.accepted).toHaveLength(1);
    const reconciled = PublicationSchema.parse(
      await handlers.reconcilePublication(f.ctx(), { operationId: ready.operationId }),
    );
    expect(reconciled.state).toBe("published");
    expect(reconciled.receipt?.issueNumber).toBe(1);
    expect(f.receiver.accepted).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("restoring an old ready database image cannot replay an already accepted create", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    const staleImage = f.snapshot("old-ready");
    expect((await f.publish(ready)).state).toBe("published");
    await f.restore(staleImage);
    expect(unknown(await f.prepare()).reconciliation).toBe("recovery_fence");
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toHaveLength(1);
    const confirmed = PublicationSchema.parse(
      await handlers.reconcilePublication(f.ctx(), {
        operationId: ready.operationId,
        issueNumber: 1,
      }),
    );
    expect(confirmed.state).toBe("published");
    expect(confirmed.receipt?.reviewedDigest).toBe(ready.reviewedDigest);
  } finally {
    await f.close();
  }
});

test("restoring a dispatching database image fences create before explicit known-number recovery", async () => {
  const f = await publicationFixture();
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await f.prepare();
    f.receiver.state.create = "hold";
    pending = handlers.publishIssue(f.ctx(), reviewed(ready));
    await reach(f.receiver.state.createGate.entered, pending);
    const staleImage = f.snapshot("old-dispatching");
    f.receiver.state.createGate.release();
    expect(PublicationSchema.parse(await pending).state).toBe("published");
    await f.restore(staleImage);
    expect(unknown(await f.readPublication(ready)).reconciliation).toBe("recovery_fence");
    unknown(await f.prepare());
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toHaveLength(1);
    expect(
      PublicationSchema.parse(
        await handlers.reconcilePublication(f.ctx(), {
          operationId: ready.operationId,
          issueNumber: 1,
        }),
      ).state,
    ).toBe("published");
  } finally {
    f.receiver.state.createGate.release();
    if (pending) await pending;
    await f.close();
  }
});

test("re-enable fences a live dispatch and its delayed receipt continuation", async () => {
  const f = await publicationFixture();
  let pending: Promise<unknown> | undefined;
  try {
    const ready = await f.prepare();
    f.receiver.state.create = "hold";
    pending = handlers.publishIssue(f.ctx(), reviewed(ready));
    await reach(f.receiver.state.createGate.entered, pending);
    await lifecycle.onDisable?.(f.hook());
    await lifecycle.onEnable?.(f.hook());
    f.receiver.state.createGate.release();
    refusal(await pending);
    unknown(await f.readPublication(ready));
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toHaveLength(1);
  } finally {
    f.receiver.state.createGate.release();
    if (pending) await pending;
    await f.close();
  }
});

test("explicit reconciliation fences ready before a future publish", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    unknown(await handlers.reconcilePublication(f.ctx(), { operationId: ready.operationId }));
    unknown(await f.publish(ready));
    expect(f.receiver.accepted).toEqual([]);
  } finally {
    await f.close();
  }
});

const badEvidence = [
  "empty",
  "multiple",
  "pr",
  "malformed",
  "unsafe-id",
  "unsafe-number",
  "unsafe-url",
  "foreign-repository",
  "foreign-account",
  "changed-title",
  "changed-body",
  "repeated-identity",
  "incomplete",
] as const;
for (const mode of badEvidence)
  test(`reconciliation stays unknown for ${mode} evidence and never repeats create`, async () => {
    const f = await publicationFixture();
    try {
      const ready = await f.prepare();
      f.receiver.state.create = "drop";
      unknown(await f.publish(ready));
      const exact = issueEvidence(ready);
      f.receiver.state.list = (page) => {
        switch (mode) {
          case "empty":
            return [];
          case "multiple":
            return page === 1 ? [exact, issueEvidence(ready, 2)] : [];
          case "pr":
            return [
              {
                ...exact,
                pull_request: { url: `https://api.github.com${REPOSITORY_PATH}/pulls/1` },
              },
            ];
          case "malformed":
            return [{ ...exact, user: null }];
          case "unsafe-id":
            return [{ ...exact, id: Number.MAX_SAFE_INTEGER + 1 }];
          case "unsafe-number":
            return [{ ...exact, number: Number.MAX_SAFE_INTEGER + 1 }];
          case "unsafe-url":
            return [{ ...exact, html_url: `${exact.html_url}?redirect=outside` }];
          case "foreign-repository":
            return [{ ...exact, repository_url: "https://api.github.com/repos/other/repo" }];
          case "foreign-account":
            return [{ ...exact, user: { ...exact.user, node_id: "U_other" } }];
          case "changed-title":
            return [{ ...exact, title: `${exact.title} edited` }];
          case "changed-body":
            return [{ ...exact, body: `${exact.body} edited` }];
          case "repeated-identity":
            return page === 1
              ? [exact, issueEvidence({ ...ready, publicBody: "unrelated" }, 2)]
              : [exact];
          case "incomplete":
            return [
              issueEvidence(
                page === 1 ? ready : { ...ready, publicBody: "unrelated" },
                page * 2 - 1,
              ),
              issueEvidence({ ...ready, publicBody: "unrelated" }, page * 2),
            ];
        }
      };
      const answer = await handlers.reconcilePublication(f.ctx(), {
        operationId: ready.operationId,
      });
      // The real native leaf projection refuses user:null before provider evidence parsing.
      if (mode === "malformed") refusal(answer);
      else unknown(answer);
      unknown(await f.readPublication(ready));
      unknown(await f.publish(ready));
      expect(f.receiver.accepted).toHaveLength(1);
      const pages = f.receiver.requests.filter((request) =>
        request.path.startsWith(`${REPOSITORY_PATH}/issues?`),
      );
      expect(pages.length).toBeLessThanOrEqual(LIMITS.pages);
      if (mode === "incomplete") expect(pages).toHaveLength(LIMITS.pages);
    } finally {
      await f.close();
    }
  });

test("unique exact evidence requires exhaustion; a known-number read independently confirms exact evidence", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    f.receiver.state.create = "drop";
    unknown(await f.publish(ready));
    f.receiver.state.list = (page) =>
      page === 1
        ? [issueEvidence(ready), issueEvidence({ ...ready, publicBody: "unrelated" }, 2)]
        : [];
    const confirmed = PublicationSchema.parse(
      await handlers.reconcilePublication(f.ctx(), { operationId: ready.operationId }),
    );
    expect(confirmed.state).toBe("published");
    expect(
      f.receiver.requests
        .filter((request) => request.path.startsWith(`${REPOSITORY_PATH}/issues?`))
        .map((request) => new URL(request.path, "https://api.github.com").searchParams.get("page")),
    ).toEqual(["1", "2"]);
    const second = await f.prepare({ ...draft, consumerRef: "known-number" });
    unknown(await f.publish(second));
    f.receiver.state.specific = (number) => ({ ...issueEvidence(second, number), body: "changed" });
    unknown(
      await handlers.reconcilePublication(f.ctx(), {
        operationId: second.operationId,
        issueNumber: 2,
      }),
    );
    f.receiver.state.specific = (number) => issueEvidence(second, number);
    const numbered = PublicationSchema.parse(
      await handlers.reconcilePublication(f.ctx(), {
        operationId: second.operationId,
        issueNumber: 2,
      }),
    );
    expect(numbered.state).toBe("published");
    expect(numbered.receipt?.issueNumber).toBe(2);
    expect(f.receiver.accepted).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("invalid create receipt can recover and proved publication survives later changed evidence", async () => {
  const f = await publicationFixture();
  try {
    const ready = await f.prepare();
    f.receiver.state.createResponse = (issue) => ({ ...issue, id: Number.MAX_SAFE_INTEGER + 1 });
    unknown(await f.publish(ready));
    const published = PublicationSchema.parse(
      await handlers.reconcilePublication(f.ctx(), {
        operationId: ready.operationId,
        issueNumber: 1,
      }),
    );
    expect(published.state).toBe("published");
    expect(await f.readPublication(ready)).toEqual(published);
    f.receiver.state.specific = () => ({ missing: true });
    f.receiver.state.list = () => [];
    expect(
      await handlers.reconcilePublication(f.ctx(), { operationId: ready.operationId }),
    ).toEqual(published);
    expect(await f.publish(ready)).toEqual(published);
    expect(f.receiver.accepted).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("actual packed ordinary and hardened public-door consumers run in an isolated process", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/publication-packed.proof.ts`], {
    stdout: "pipe",
    stderr: "pipe",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("MANIFOLD_")),
    ),
  });
  // A real child process requires a real kill deadline; this is not a sleep or a race trigger.
  const deadline = setTimeout(() => child.kill(), 110_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`packed consumer exited ${code}: ${stderr}`);
    const result = JSON.parse(stdout) as {
      reports: {
        hardened: boolean;
        accepted: number;
        lostResponseRecovered: boolean;
        receiptSurvivedHandoffFailure: boolean;
      }[];
    };
    expect(
      result.reports.map(
        ({ hardened, accepted, lostResponseRecovered, receiptSurvivedHandoffFailure }) => ({
          hardened,
          accepted,
          lostResponseRecovered,
          receiptSurvivedHandoffFailure,
        }),
      ),
    ).toEqual([
      {
        hardened: false,
        accepted: 2,
        lostResponseRecovered: true,
        receiptSurvivedHandoffFailure: true,
      },
      {
        hardened: true,
        accepted: 2,
        lostResponseRecovered: true,
        receiptSurvivedHandoffFailure: true,
      },
    ]);
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
}, 120_000);
