import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RUN_MAX_LIFETIME_MS,
  AGENT_RUN_MAX_RENEWALS,
  AgentPolicyChallengeSchema,
  AcknowledgeAgentPolicyResultSchema,
  AcknowledgeAgentPolicyV2ResultSchema,
  CreateRunCredentialResultSchema,
  FinishAgentRunResultSchema,
  ReloadAgentPolicyResultSchema,
  RenewAgentRunResultSchema,
  RenewAgentRunV2ResultSchema,
  ReportRunActivityV2ResultSchema,
  formatManifoldUri,
  type ActionOutcome,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { silentLogger } from "../src/log.ts";
import type { PluginHost } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { TRACE_ROW_TYPE, type ServerStore } from "../src/stores.ts";
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

    const created = await createExternalRun(fix, {
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
    const created = await createExternalRun(fix, {
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
    const parentCreated = await createExternalRun(fix, {
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

    const outsideCreated = await createExternalRun(fix, {
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
    const parentCreated = await createExternalRun(fix, {
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
    const created = await createExternalRun(fix, {
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
    const rootCreated = await createExternalRun(fix, {
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
      const created = await createExternalRun(fix, {
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

const REPORT_ACTIVITY = "core.access.reportRunActivityV2";
const RENEW = "core.access.renewAgentRunV2";
const KEEP_OPEN = {
  agentJustification: "Keep the harness Run open until its model acknowledges policy.",
};

/** One V2 Agent whose runner admits sibling Runs, each pending until its own acknowledgement. */
async function pendingHarness(fix: Fixture) {
  const registered = await fix.auth.registerAgentV2(
    {
      name: "pending harness",
      purpose: "Hold a harness Run open before its model acknowledges policy.",
      harness: "external",
      context: { profile: {} },
      grant: {
        scope: [{ target: "manifold://", reach: "subtree", caps: ["containers:read"] }],
        maxRunLifetimeMs: 120_000,
        delegation: { maxDepth: 1, maxDescendants: 1 },
        expiresAt: fix.runtime.now() + AGENT_RUN_MAX_LIFETIME_MS,
      },
    },
    fix.owner,
  );
  if (registered.credential === undefined) throw new Error("fixture Agent must be new");
  const runner = fix.auth.authenticate(registered.credential.token);
  const admit = () => {
    const created = fix.auth.createRunV2(
      { agentId: registered.agent.agentId, lifetimeMs: 60_000 },
      runner,
    );
    if (created.credential === undefined) throw new Error("runner admission returned no bearer");
    const token = created.credential.token;
    return { run: created.run, token, actor: fix.auth.authenticate(token) };
  };
  return { runner, admit };
}

async function acknowledgeV2(fix: Fixture, actor: AuthContext) {
  const challenge = AgentPolicyChallengeSchema.parse(
    value(await fix.host.dispatch(actor, "core.access.getAgentPolicy", {})),
  );
  return AcknowledgeAgentPolicyV2ResultSchema.parse(
    value(
      await fix.host.dispatch(actor, "core.access.acknowledgeAgentPolicyV2", {
        revision: challenge.revision,
        acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
      }),
    ),
  );
}

function latestTrace(fix: Fixture) {
  const row = fix.store.listEvents({ type: TRACE_ROW_TYPE, limit: 1 })[0];
  if (row === undefined) throw new Error("dispatch left no trace");
  return row;
}

describe("a Run awaiting policy acknowledgement", () => {
  test("its own credential reports activity and renews within the justification, lease and ceiling", async () => {
    const fix = await fixture();
    const { admit } = await pendingHarness(fix);
    const pending = admit();
    expect(pending.run.state).toBe("pending_policy");
    const reported = ReportRunActivityV2ResultSchema.parse(
      value(
        await fix.host.dispatch(pending.actor, REPORT_ACTIVITY, {
          runId: pending.run.id,
          activity: "working",
        }),
      ),
    );
    expect(reported.run).toMatchObject({ state: "pending_policy", activity: "working" });

    const renew = (actor: AuthContext, lifetimeMs: number, options?: typeof KEEP_OPEN) =>
      fix.host.dispatch(actor, RENEW, { runId: pending.run.id, lifetimeMs }, null, options);
    expect(denial(await renew(pending.actor, 120_000)).rule).toBe("justification_required");
    expect(denial(await renew(pending.actor, 120_000, { agentJustification: " " })).rule).toBe(
      "invalid_justification",
    );
    expect(denial(await renew(pending.actor, AGENT_RUN_MAX_LIFETIME_MS + 1, KEEP_OPEN)).rule).toBe(
      "invalid_args",
    );
    expect(denial(await renew(pending.actor, 180_000, KEEP_OPEN))).toEqual({
      rule: "refused",
      message: "lifetime_exceeds_grant",
    });
    expect(denial(await renew(pending.actor, 60_000, KEEP_OPEN))).toEqual({
      rule: "refused",
      message: "agent run renewal must extend its expiry",
    });
    expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({
      renewals: 0,
      expiresAt: pending.run.expiresAt,
    });
    expect(fix.auth.authenticate(pending.token).agentRunId).toBe(pending.run.id);

    let { actor, token } = pending;
    for (let renewal = 1; renewal <= AGENT_RUN_MAX_RENEWALS; renewal += 1) {
      fix.runtime.time += 1_000;
      const renewed = RenewAgentRunV2ResultSchema.parse(
        value(await renew(actor, 120_000, KEEP_OPEN)),
      );
      expect(renewed.run).toMatchObject({
        state: "pending_policy",
        renewals: renewal,
        expiresAt: fix.runtime.now() + 120_000,
      });
      expect(renewed.revokedCredentials).toBe(1);
      expect(JSON.parse(latestTrace(fix).payload).agentDeclaration).toBe(
        KEEP_OPEN.agentJustification,
      );
      expect(() => fix.auth.authenticate(token)).toThrow("revoked");
      token = renewed.credential.token;
      actor = fix.auth.authenticate(token);
      expect(actor.agentRunId).toBe(pending.run.id);
    }
    fix.runtime.time += 1_000;
    expect(denial(await renew(actor, 120_000, KEEP_OPEN))).toEqual({
      rule: "refused",
      message: "agent run renewal budget exhausted",
    });
    expect(
      value(
        await fix.host.dispatch(actor, REPORT_ACTIVITY, {
          runId: pending.run.id,
          activity: "idle",
        }),
      ),
    ).toMatchObject({ run: { state: "pending_policy", activity: "idle" } });
    expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({
      state: "pending_policy",
      renewals: AGENT_RUN_MAX_RENEWALS,
    });
    fix.store.close();
  });

  test("every other door, and so every authority-bearing action, still requires acknowledgement", async () => {
    const fix = await fixture();
    const { admit } = await pendingHarness(fix);
    const pending = admit();
    const refused: string[] = [];
    for (const action of fix.host.roster().flatMap((entry) => entry.actions)) {
      const policyFree =
        action.name.startsWith("core.access.") &&
        (action.runAccess === "policy" ||
          action.runAccess === "teardown" ||
          action.runAccess === "inspect");
      if (policyFree || action.name === REPORT_ACTIVITY || action.name === RENEW) continue;
      const outcome = await fix.host.dispatch(pending.actor, action.name, {});
      expect({ door: action.name, rule: outcome.ok ? "ok" : outcome.denial.rule }).toEqual({
        door: action.name,
        rule: "policy_required",
      });
      refused.push(action.name);
    }
    expect(refused).toEqual(
      expect.arrayContaining([
        "core.machines.list",
        "core.access.createRunV2",
        "core.access.createChildRunV2",
        "core.access.launchRun",
        "core.access.sendRunInput",
        "core.access.reportRunActivity",
        "core.access.renewAgentRun",
      ]),
    );
    expect((await acknowledgeV2(fix, pending.actor)).run.state).toBe("active");
    expect((await fix.host.dispatch(pending.actor, "core.machines.list", {})).ok).toBe(true);
    fix.store.close();
  });

  test("no other Run's credential, nor its Agent runner's renewal, acts for it", async () => {
    const fix = await fixture();
    const { runner, admit } = await pendingHarness(fix);
    const pending = admit();
    const pendingSibling = admit();
    const activeSibling = admit();
    await acknowledgeV2(fix, activeSibling.actor);
    for (const other of [pendingSibling.actor, activeSibling.actor]) {
      expect(other.principal.id).toBe(pending.actor.principal.id);
      expect(
        denial(
          await fix.host.dispatch(
            other,
            RENEW,
            { runId: pending.run.id, lifetimeMs: 120_000 },
            null,
            KEEP_OPEN,
          ),
        ),
      ).toEqual({ rule: "refused", message: "agent_unavailable" });
      expect(
        denial(
          await fix.host.dispatch(other, REPORT_ACTIVITY, {
            runId: pending.run.id,
            activity: "blocked",
          }),
        ),
      ).toEqual({ rule: "refused", message: "harness_credential_required" });
    }
    expect(
      denial(
        await fix.host.dispatch(
          runner,
          RENEW,
          { runId: pending.run.id, lifetimeMs: 120_000 },
          null,
          KEEP_OPEN,
        ),
      ),
    ).toEqual({ rule: "refused", message: "only an active policy-current run may be renewed" });
    expect(fix.store.getAgentRun(pending.run.id)).toMatchObject({
      state: "pending_policy",
      activity: pending.run.activity,
      renewals: 0,
      expiresAt: pending.run.expiresAt,
    });
    expect(fix.auth.authenticate(pending.token).agentRunId).toBe(pending.run.id);

    // Admission is for a Run that has not yet acknowledged; a stale one regains neither door.
    fix.store.updateAgentRunPolicy(activeSibling.run.id, "0".repeat(64), "policy_stale");
    for (const [door, args] of [
      [RENEW, { runId: activeSibling.run.id, lifetimeMs: 120_000 }],
      [REPORT_ACTIVITY, { runId: activeSibling.run.id, activity: "idle" }],
    ] as const) {
      expect(
        denial(await fix.host.dispatch(activeSibling.actor, door, args, null, KEEP_OPEN)).rule,
      ).toBe("policy_stale");
    }
    fix.store.close();
  });
});
