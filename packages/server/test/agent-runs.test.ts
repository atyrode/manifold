import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentPolicyChallengeSchema,
  AcknowledgeAgentPolicyResultSchema,
  CreateRunCredentialResultSchema,
  FinishAgentRunResultSchema,
  ReloadAgentPolicyResultSchema,
  RenewAgentRunResultSchema,
  formatManifoldUri,
  type ActionOutcome,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import type { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { FakeClock, FakeRuntime, testPluginHost, testStore, testTileTrees } from "./helpers.ts";
import { createExternalRun } from "./agent-fixtures.ts";

const OWNER_KEY = "r".repeat(64);

interface Fixture {
  readonly runtime: FakeRuntime;
  readonly store: ServerStore;
  readonly auth: AuthService;
  readonly owner: AuthContext;
  readonly host: PluginHost;
}

async function fixture(policyFile?: string): Promise<Fixture> {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = testStore();
  const auth = new AuthService(store, OWNER_KEY, runtime, undefined, policyFile);
  const rooms = new RoomManager(store, runtime, clock, silentLogger, testTileTrees);
  const broker = new TerminalBroker(
    store,
    auth,
    rooms,
    runtime,
    clock,
    silentLogger,
    () => "http://localhost:7777",
    testTileTrees,
  );
  rooms.setTerminalProvider((containerId) => broker.listForContainer(containerId));
  rooms.setPendingOpenProvider((containerId) => broker.hasPendingOpenForContainer(containerId));
  return {
    runtime,
    store,
    auth,
    owner: auth.authenticate(OWNER_KEY),
    host: await testPluginHost(store, auth, rooms, broker, runtime),
  };
}

function value(outcome: ActionOutcome): unknown {
  if (!outcome.ok) throw new Error(`expected result, got ${outcome.denial.rule}`);
  return outcome.result;
}

function denial(outcome: ActionOutcome): { rule: string; message: string } {
  if (outcome.ok) throw new Error("expected denial");
  return outcome.denial;
}

async function acknowledge(fix: Fixture, actor: AuthContext) {
  const challenge = AgentPolicyChallengeSchema.parse(
    value(await fix.host.dispatch(actor, "core.access.getAgentPolicy", {})),
  );
  return AcknowledgeAgentPolicyResultSchema.parse(
    value(
      await fix.host.dispatch(actor, "core.access.acknowledgeAgentPolicy", {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
      }),
    ),
  );
}

describe("sponsor-bound agent runs", () => {
  test("policy gates every ordinary action and parent settlement revokes descendants", async () => {
    const fix = await fixture();
    const containerId = fix.runtime.newId();
    fix.store.createContainer({
      id: containerId,
      name: "bounded work",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });

    const created = createExternalRun(fix, {
      name: "planner",
      purpose: "Inspect the bounded workspace and delegate one read-only child.",
      taskRef: "issue:559",
      target: "manifold://",
      reach: "subtree",
      caps: ["agents:delegate", "containers:read"],
    });
    const parent = fix.auth.authenticate(created.credential.token);

    expect(denial(await fix.host.dispatch(parent, "core.machines.list", {})).rule).toBe(
      "policy_required",
    );
    expect((await acknowledge(fix, parent)).run.state).toBe("active");
    expect((await fix.host.dispatch(parent, "core.machines.list", {})).ok).toBe(true);

    const childCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          parent,
          "core.access.createChildRun",
          {
            runId: created.run.id,
            target: formatManifoldUri({ kind: "container", containerId }),
            reach: "subtree",
            caps: ["containers:read"],
          },
          null,
          { agentJustification: "Delegate a bounded child for this run." },
        ),
      ),
    );
    const widened = await fix.host.dispatch(
      parent,
      "core.access.createChildRun",
      {
        runId: created.run.id,
        target: formatManifoldUri({ kind: "container", containerId }),
        reach: "subtree",
        caps: ["terminals:write"],
      },
      null,
      { agentJustification: "Delegate a bounded child for this run." },
    );
    expect(denial(widened)).toEqual({ rule: "refused", message: "cap_exceeds_grant" });
    const child = fix.auth.authenticate(childCreated.credential.token);
    expect(childCreated.run.agentId).toBe(created.run.agentId);
    expect(child.principal.id).toBe(parent.principal.id);
    expect(child.agentRunId).not.toBe(parent.agentRunId);
    expect(child.tokenId).not.toBe(parent.tokenId);
    expect((await acknowledge(fix, child)).run.state).toBe("active");
    const finished = FinishAgentRunResultSchema.parse(
      value(
        await fix.host.dispatch(parent, "core.access.finishAgentRun", {
          runId: created.run.id,
          outcome: "completed",
        }),
      ),
    );
    expect(finished).toMatchObject({ finishedRuns: 2, run: { state: "completed" } });
    expect(fix.store.getAgentRun(childCreated.run.id)?.state).toBe("revoked");
    expect(() => fix.auth.authenticate(created.credential.token)).toThrow("revoked");
    expect(() => fix.auth.authenticate(childCreated.credential.token)).toThrow("revoked");
    fix.store.close();
  });
  test("a child remains bounded by the sponsor waterfall at every descendant node", async () => {
    const fix = await fixture();
    const containerId = fix.runtime.newId();
    const containerNode = formatManifoldUri({ kind: "container", containerId });
    fix.store.createContainer({
      id: containerId,
      name: "denied descendant",
      createdAt: fix.runtime.now(),
      discipline: "canvas",
    });
    const created = createExternalRun(fix, {
      name: "parent",
      purpose: "Delegate without escaping a descendant-specific denial.",
      target: "manifold://",
      reach: "subtree",
      caps: ["agents:delegate", "containers:read"],
    });
    const parent = fix.auth.authenticate(created.credential.token);
    await acknowledge(fix, parent);
    fix.auth.grant(
      {
        principal: { kind: "principal", id: created.run.principal.id },
        node: containerNode,
        caps: ["containers:read"],
        effect: "deny",
        reach: "subtree",
      },
      fix.owner,
    );
    expect(fix.auth.effectiveCaps(parent, containerNode).has("containers:read")).toBe(false);

    const childCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          parent,
          "core.access.createChildRun",
          {
            runId: created.run.id,
            target: "manifold://",
            reach: "subtree",
            caps: ["containers:read"],
          },
          null,
          { agentJustification: "Delegate a bounded child for this run." },
        ),
      ),
    );
    const child = fix.auth.authenticate(childCreated.credential.token);
    await acknowledge(fix, child);
    expect(fix.auth.effectiveCaps(child, containerNode).has("containers:read")).toBe(false);
    fix.store.close();
  });

  test("generic revocation is transitive and scoped credentials cannot clean up elsewhere", async () => {
    const fix = await fixture();
    const firstContainerId = fix.runtime.newId();
    const secondContainerId = fix.runtime.newId();
    for (const [id, name] of [
      [firstContainerId, "first"],
      [secondContainerId, "second"],
    ] as const) {
      fix.store.createContainer({
        id,
        name,
        createdAt: fix.runtime.now(),
        discipline: "canvas",
      });
    }
    const parentCreated = createExternalRun(fix, {
      name: "revoked-parent",
      purpose: "Prove generic revocation settles the complete run subtree.",
      target: "manifold://",
      reach: "subtree",
      caps: ["agents:delegate", "containers:read"],
    });
    const parent = fix.auth.authenticate(parentCreated.credential.token);
    await acknowledge(fix, parent);
    const childCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          parent,
          "core.access.createChildRun",
          {
            runId: parentCreated.run.id,
            target: formatManifoldUri({ kind: "container", containerId: secondContainerId }),
            reach: "subtree",
            caps: ["containers:read"],
          },
          null,
          { agentJustification: "Delegate a bounded child for this run." },
        ),
      ),
    );
    expect(
      (
        await fix.host.dispatch(fix.owner, "core.access.revoke", {
          principalId: parentCreated.run.principal.id,
        })
      ).ok,
    ).toBe(true);
    expect(fix.store.getAgentRun(parentCreated.run.id)?.state).toBe("revoked");
    expect(fix.store.getAgentRun(childCreated.run.id)?.state).toBe("revoked");
    expect(() => fix.auth.authenticate(childCreated.credential.token)).toThrow("revoked");

    const outsideCreated = createExternalRun(fix, {
      name: "outside",
      purpose: "Remain outside a narrow cleanup credential.",
      target: formatManifoldUri({ kind: "container", containerId: secondContainerId }),
      reach: "subtree",
      caps: ["containers:read"],
    });
    const narrow = fix.auth.mintToken(
      {
        principalId: fix.owner.principal.id,
        caps: ["containers:read"],
        containerId: firstContainerId,
      },
      fix.owner,
    );
    const narrowOwner = fix.auth.authenticate(narrow.token);
    expect(
      denial(
        await fix.host.dispatch(narrowOwner, "core.access.finishAgentRun", {
          runId: outsideCreated.run.id,
          outcome: "cancelled",
        }),
      ).rule,
    ).toBe("refused");
    fix.store.close();
  });

  test("expiry withdraws a hot run subtree before teardown can claim success", async () => {
    const fix = await fixture();
    const parentCreated = createExternalRun(fix, {
      name: "expiring-parent",
      purpose: "Prove expiry is a backstop rather than successful teardown.",
      target: "manifold://",
      reach: "subtree",
      caps: ["agents:delegate", "containers:read"],
      lifetimeMs: 60_000,
    });
    const parent = fix.auth.authenticate(parentCreated.credential.token);
    await acknowledge(fix, parent);
    const childCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          parent,
          "core.access.createChildRun",
          {
            runId: parentCreated.run.id,
            target: "manifold://",
            reach: "subtree",
            caps: ["containers:read"],
            lifetimeMs: 60_000,
          },
          null,
          { agentJustification: "Delegate a bounded child for this run." },
        ),
      ),
    );
    fix.runtime.time += 60_000;

    expect(
      denial(
        await fix.host.dispatch(parent, "core.access.finishAgentRun", {
          runId: parentCreated.run.id,
          outcome: "completed",
        }),
      ),
    ).toMatchObject({ rule: "forbidden" });
    expect(fix.store.getAgentRun(parentCreated.run.id)?.state).toBe("expired");
    expect(fix.store.getAgentRun(childCreated.run.id)?.state).toBe("revoked");
    fix.store.close();
  });

  test("renewal replaces the credential without extending the run silently", async () => {
    const fix = await fixture();
    const created = createExternalRun(fix, {
      name: "renewed",
      purpose: "Exercise explicit harness renewal.",
      target: "manifold://",
      reach: "subtree",
      caps: ["containers:read"],
      lifetimeMs: 60_000,
    });
    const original = fix.auth.authenticate(created.credential.token);
    await acknowledge(fix, original);
    const renewed = RenewAgentRunResultSchema.parse(
      value(
        await fix.host.dispatch(
          original,
          "core.access.renewAgentRun",
          { runId: created.run.id, lifetimeMs: 120_000 },
          null,
          { agentJustification: "Extend this bounded read-only task." },
        ),
      ),
    );
    expect(renewed.run).toMatchObject({
      renewals: 1,
      expiresAt: fix.runtime.now() + 120_000,
    });
    expect(renewed.revokedCredentials).toBe(1);
    expect(() => fix.auth.authenticate(created.credential.token)).toThrow("revoked");
    const replacement = fix.auth.authenticate(renewed.credential.token);
    expect((await fix.host.dispatch(replacement, "core.machines.list", {})).ok).toBe(true);
    fix.store.close();
  });

  test("each ancestor enforces its own descendant budget", async () => {
    const fix = await fixture();
    const rootCreated = createExternalRun(fix, {
      name: "bounded-root",
      purpose: "Delegate through a branch with a lower local budget.",
      target: "manifold://",
      reach: "subtree",
      caps: ["agents:delegate", "containers:read"],
      maxDescendants: 3,
    });
    const root = fix.auth.authenticate(rootCreated.credential.token);
    await acknowledge(fix, root);
    const branchCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          root,
          "core.access.createChildRun",
          {
            runId: rootCreated.run.id,
            target: "manifold://",
            reach: "subtree",
            caps: ["agents:delegate", "containers:read"],
            delegation: { maxDepth: rootCreated.run.maxDepth, maxDescendants: 1 },
          },
          null,
          { agentJustification: "Delegate a branch within this run envelope." },
        ),
      ),
    );
    const branch = fix.auth.authenticate(branchCreated.credential.token);
    await acknowledge(fix, branch);
    const leafCreated = CreateRunCredentialResultSchema.parse(
      value(
        await fix.host.dispatch(
          branch,
          "core.access.createChildRun",
          {
            runId: branchCreated.run.id,
            target: "manifold://",
            reach: "subtree",
            caps: ["agents:delegate", "containers:read"],
          },
          null,
          { agentJustification: "Delegate the remaining bounded work." },
        ),
      ),
    );
    const leaf = fix.auth.authenticate(leafCreated.credential.token);
    await acknowledge(fix, leaf);

    expect(
      denial(
        await fix.host.dispatch(
          leaf,
          "core.access.createChildRun",
          {
            runId: leafCreated.run.id,
            target: "manifold://",
            reach: "subtree",
            caps: ["containers:read"],
          },
          null,
          { agentJustification: "Attempt a child within the ancestor budget." },
        ),
      ),
    ).toEqual({ rule: "refused", message: "delegation_exceeds_grant" });
    fix.store.close();
  });

  test("a trusted policy reload suspends active runs until exact re-acknowledgement", async () => {
    const directory = mkdtempSync(join(tmpdir(), "manifold-agent-policy-"));
    const policyFile = join(directory, "operator.txt");
    writeFileSync(policyFile, "Operator policy revision one.\n");
    const fix = await fixture(policyFile);
    try {
      const created = createExternalRun(fix, {
        name: "policy-reader",
        purpose: "Exercise live policy replacement.",
        target: "manifold://",
        reach: "subtree",
        caps: ["containers:read"],
      });
      const actor = fix.auth.authenticate(created.credential.token);
      const first = await acknowledge(fix, actor);
      writeFileSync(policyFile, "Operator policy revision two.\n");

      const reloaded = ReloadAgentPolicyResultSchema.parse(
        value(await fix.host.dispatch(fix.owner, "core.access.reloadAgentPolicy", {})),
      );
      expect(reloaded.suspendedRuns).toBe(1);
      expect(reloaded.revision).not.toBe(first.run.policyRevision);
      expect(denial(await fix.host.dispatch(actor, "core.machines.list", {})).rule).toBe(
        "policy_stale",
      );
      expect(
        denial(
          await fix.host.dispatch(actor, "core.access.renewAgentRun", {
            runId: created.run.id,
            lifetimeMs: 60_000,
          }),
        ).rule,
      ).toBe("policy_stale");

      const challenge = AgentPolicyChallengeSchema.parse(
        value(await fix.host.dispatch(actor, "core.access.getAgentPolicy", {})),
      );
      expect(challenge.required.find(({ id }) => id === "operator")?.body).toBe(
        "Operator policy revision two.\n",
      );
      const wrong = await fix.host.dispatch(actor, "core.access.acknowledgeAgentPolicy", {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({
          id,
          digest: id === "operator" ? "0".repeat(64) : digest,
        })),
      });
      expect(denial(wrong).rule).toBe("refused");
      expect((await acknowledge(fix, actor)).run.state).toBe("active");
      expect((await fix.host.dispatch(actor, "core.machines.list", {})).ok).toBe(true);

      writeFileSync(policyFile, "Operator policy revision one.\n");
      value(await fix.host.dispatch(fix.owner, "core.access.reloadAgentPolicy", {}));
      const reissued = AgentPolicyChallengeSchema.parse(
        value(await fix.host.dispatch(actor, "core.access.getAgentPolicy", {})),
      );
      expect(reissued.revision).toBe(first.run.policyRevision);
      expect(reissued.acknowledgedAt).toBeUndefined();
      expect((await acknowledge(fix, actor)).run.state).toBe("active");
    } finally {
      fix.store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
