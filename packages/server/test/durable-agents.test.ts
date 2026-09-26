import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { ServerStore } from "../src/stores.ts";
import { openDatabase } from "../src/db.ts";
import {
  CreateRunCredentialResultSchema,
  type CreateRunRequest,
  type RegisterAgentRequest,
} from "@manifold/protocol";

async function fixture(overrides: Partial<RegisterAgentRequest["grant"]> = {}) {
  let next = 0;
  let now = 1_800_000_000_000;
  const runtime = { newId: () => `durable-${++next}`, now: () => now };
  const db = openDatabase(":memory:");
  const store = new ServerStore(db);
  const ownerSecret = "d".repeat(64);
  const auth = new AuthService(store, ownerSecret, runtime);
  const owner = auth.authenticate(ownerSecret);
  const registration: RegisterAgentRequest = {
    name: "analyst",
    purpose: "Inspect bounded work",
    harness: "external",
    context: { profile: {} },
    grant: {
      caps: ["containers:read", "agents:delegate"],
      targets: ["manifold://"],
      reach: "subtree",
      maxRunLifetimeMs: 600_000,
      delegation: { maxDepth: 2, maxDescendants: 2 },
      expiresAt: now + 3_600_000,
      ...overrides,
    },
  };
  const registered = await auth.registerAgent(registration, owner);
  const runner = auth.authenticate(registered.credential!.token);
  const create = (input: Partial<CreateRunRequest> = {}) =>
    CreateRunCredentialResultSchema.parse(
      auth.createRun({ agentId: registered.agent.agentId, ...input }, runner),
    );
  const acknowledge = (actor: AuthContext) => {
    const policy = auth.agentPolicyChallenge(actor);
    auth.acknowledgeAgentPolicy(
      {
        revision: policy.revision,
        acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
      },
      actor,
    );
  };
  return {
    db,
    store,
    auth,
    owner,
    runner,
    registration,
    registered,
    create,
    acknowledge,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("durable Agent admission", () => {
  test("blocked asynchronous profile validation cannot publish invalid Agents or updates", async () => {
    const fix = await fixture();
    const gate = Promise.withResolvers<void>();
    try {
      const profileSchema = z.object({ allowed: z.boolean() }).refine(async ({ allowed }) => {
        await gate.promise;
        return allowed;
      });
      fix.auth.setAgentProfileValidator(async (_harness, profile) => {
        await profileSchema.parseAsync(profile);
      });
      const agents = fix.store.listAgents();
      const principals = fix.store.listPrincipalsWithCreation();
      const grants = fix.store.listGrants();
      const registration = fix.auth.registerAgent(
        {
          ...fix.registration,
          name: "invalid asynchronous profile",
          context: { profile: { allowed: false } },
        },
        fix.owner,
      );
      const update = fix.auth.updateAgent(
        {
          agentId: fix.registered.agent.agentId,
          purpose: "Must not replace the original purpose",
          grant: { ...fix.registration.grant, caps: ["agents:delegate"] },
          context: { profile: { allowed: false } },
        },
        fix.owner,
      );
      expect(fix.store.listAgents()).toEqual(agents);
      expect(fix.store.listPrincipalsWithCreation()).toEqual(principals);
      expect(fix.store.listGrants()).toEqual(grants);
      const rejected = Promise.allSettled([registration, update]);
      gate.resolve();
      expect(await rejected).toEqual([
        { status: "rejected", reason: expect.any(z.ZodError) },
        { status: "rejected", reason: expect.any(z.ZodError) },
      ]);
      expect(fix.store.listAgents()).toEqual(agents);
      expect(fix.store.listPrincipalsWithCreation()).toEqual(principals);
      expect(fix.store.listGrants()).toEqual(grants);
      expect(fix.auth.authenticate(fix.registered.credential!.token).agentRunnerId).toBe(
        fix.registered.agent.agentId,
      );
    } finally {
      gate.resolve();
      fix.db.close();
    }
  });

  for (const withdrawal of ["caller", "sponsor", "delegation"] as const) {
    test(`profile validation rechecks withdrawn ${withdrawal} authority before mutation`, async () => {
      const fix = await fixture();
      const gate = Promise.withResolvers<void>();
      try {
        const credential = fix.auth.mintToken(
          {
            principal: { name: "async sponsor", kind: "human" },
            caps: ["containers:read", "agents:delegate"],
          },
          fix.owner,
        );
        const sponsor = fix.auth.authenticate(credential.token);
        const registered = await fix.auth.registerAgent(
          { ...fix.registration, name: "sponsored asynchronous profile" },
          sponsor,
        );
        fix.auth.setAgentProfileValidator(() => gate.promise);
        const registration = fix.auth.registerAgent(
          { ...fix.registration, name: "registration awaiting authority" },
          sponsor,
        );
        const update = fix.auth.updateAgent(
          {
            agentId: registered.agent.agentId,
            purpose: "Must not survive authority withdrawal",
            context: { profile: { changed: true } },
          },
          withdrawal === "sponsor" ? fix.owner : sponsor,
        );
        if (withdrawal === "delegation") {
          fix.auth.grant(
            {
              principal: { kind: "principal", id: sponsor.principal.id },
              node: "manifold://",
              effect: "deny",
              reach: "subtree",
              caps: ["agents:delegate"],
            },
            fix.owner,
          );
        } else {
          fix.auth.revokePrincipal(sponsor.principal.id, fix.owner);
        }
        const agents = fix.store.listAgents();
        const principals = fix.store.listPrincipalsWithCreation();
        const grants = fix.store.listGrants();
        const rejected = Promise.allSettled([registration, update]);
        gate.resolve();
        expect(await rejected).toEqual([
          { status: "rejected", reason: expect.objectContaining({ code: "forbidden" }) },
          { status: "rejected", reason: expect.objectContaining({ code: "forbidden" }) },
        ]);
        expect(fix.store.listAgents()).toEqual(agents);
        expect(fix.store.listPrincipalsWithCreation()).toEqual(principals);
        expect(fix.store.listGrants()).toEqual(grants);
      } finally {
        gate.resolve();
        fix.db.close();
      }
    });
  }

  test("concurrent registrations mint one runner credential and preserve retirement", async () => {
    const fix = await fixture();
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    try {
      let validations = 0;
      fix.auth.setAgentProfileValidator(() =>
        ++validations === 1 ? firstGate.promise : secondGate.promise,
      );
      const request = { ...fix.registration, name: "concurrent registration" };
      const first = fix.auth.registerAgent(request, fix.owner);
      const second = fix.auth.registerAgent(request, fix.owner);
      secondGate.resolve();
      const winner = await second;
      expect(winner.created).toBe(true);
      expect(fix.auth.authenticate(winner.credential!.token).agentRunnerId).toBe(
        winner.agent.agentId,
      );
      fix.auth.retireAgent({ agentId: winner.agent.agentId }, fix.owner);
      firstGate.resolve();
      const duplicate = await first;
      expect(duplicate.created).toBe(false);
      expect(duplicate.credential).toBeUndefined();
      expect(duplicate.agent.agentId).toBe(winner.agent.agentId);
      expect(duplicate.agent.state).toBe("retired");
      expect(fix.store.listTokensByPrincipal(winner.agent.principalId)).toHaveLength(1);
      expect(fix.store.listAgents().filter((agent) => agent.name === request.name)).toHaveLength(1);
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      fix.db.close();
    }
  });

  test("validated context patches preserve concurrent grant, purpose and status changes", async () => {
    const fix = await fixture();
    const gate = Promise.withResolvers<void>();
    try {
      fix.auth.setAgentProfileValidator(() => gate.promise);
      const agentId = fix.registered.agent.agentId;
      const context = { profile: { validated: true } };
      const pending = fix.auth.updateAgent({ agentId, context }, fix.owner);
      const grant = { ...fix.registration.grant, caps: ["agents:delegate" as const] };
      await fix.auth.updateAgent({ agentId, purpose: "Newer purpose", grant }, fix.owner);
      fix.auth.disableAgent({ agentId }, fix.owner);
      gate.resolve();
      const updated = await pending;
      expect(updated.agent.context).toEqual(context);
      expect(updated.agent.purpose).toBe("Newer purpose");
      expect(updated.agent.grant).toEqual(grant);
      expect(() => fix.create()).toThrow("agent_disabled");
      expect(updated.agent.state).toBe("disabled");
    } finally {
      gate.resolve();
      fix.db.close();
    }
  });

  test("retirement while profile validation waits cannot be overwritten", async () => {
    const fix = await fixture();
    const gate = Promise.withResolvers<void>();
    try {
      fix.auth.setAgentProfileValidator(() => gate.promise);
      const agentId = fix.registered.agent.agentId;
      const pending = fix.auth.updateAgent(
        { agentId, context: { profile: { changed: true } }, purpose: "Reopen" },
        fix.owner,
      );
      fix.auth.retireAgent({ agentId }, fix.owner);
      const retired = fix.store.getAgent(agentId);
      gate.resolve();
      await expect(pending).rejects.toMatchObject({ code: "forbidden" });
      expect(fix.store.getAgent(agentId)).toEqual(retired);
    } finally {
      gate.resolve();
      fix.db.close();
    }
  });

  test("tool selections are immutable, parent-narrowed snapshots and current grant removal closes calls", async () => {
    const first = {
      door: "sample.tools.read",
      contractDigest: "a".repeat(64),
      maxResultBytes: 100,
    };
    const second = { door: "sample.tools.write", contractDigest: "b".repeat(64) };
    const fix = await fixture({ tools: [first, second] });
    try {
      const bare = fix.create();
      const parent = fix.create({ tools: [first.door] });
      const actor = fix.auth.authenticate(parent.credential.token);
      fix.acknowledge(actor);
      expect(bare.run.tools).toBeUndefined();
      const before = fix.store.listAgentRunTree(parent.run.id).map((run) => run.id);
      expect(() =>
        fix.auth.createChildRun(
          {
            runId: parent.run.id,
            tools: [second.door],
          },
          actor,
        ),
      ).toThrow("tool_exceeds_grant");
      expect(fix.store.listAgentRunTree(parent.run.id).map((run) => run.id)).toEqual(before);
      const child = fix.auth.createChildRun({ runId: parent.run.id, tools: [first.door] }, actor);
      expect(() =>
        fix.auth.prepareNativeRun(child.run.id, { machineId: "machine" }, actor),
      ).toThrow("agent_unavailable");
      expect(fix.store.getAgentRun(child.run.id)?.session).toBeNull();
      expect(child.run.tools).toEqual([first]);
      expect(fix.auth.agentToolGrantRefusal(child.run.id, first.door)).toBeNull();
      await fix.auth.updateAgent(
        {
          agentId: parent.run.agentId,
          grant: {
            ...fix.registration.grant,
            tools: [first, second, { door: "sample.tools.new", contractDigest: "c".repeat(64) }],
          },
        },
        fix.owner,
      );
      expect(fix.store.getAgentRun(parent.run.id)?.tools).toEqual([first]);
      expect(fix.auth.agentToolGrantRefusal(parent.run.id, second.door)).toBe("tool_ungranted");
      await fix.auth.updateAgent(
        {
          agentId: parent.run.agentId,
          grant: { ...fix.registration.grant, tools: [{ ...first, maxResultBytes: 50 }] },
        },
        fix.owner,
      );
      expect(fix.auth.agentToolGrantRefusal(child.run.id, first.door)).toBe("publication_changed");
      await fix.auth.updateAgent(
        {
          agentId: parent.run.agentId,
          grant: { ...fix.registration.grant, tools: [] },
        },
        fix.owner,
      );
      expect(fix.auth.agentToolGrantRefusal(parent.run.id, first.door)).toBe("tool_ungranted");
    } finally {
      fix.db.close();
    }
  });

  test("workspace-scoped Runs bind to native jobs without acquiring sponsor capabilities", async () => {
    const fix = await fixture();
    try {
      const created = fix.create();
      const actor = fix.auth.authenticate(created.credential.token);
      fix.acknowledge(actor);
      fix.auth.bindNativeRun(
        created.run.id,
        "workspace-job",
        { harness: "external", machineId: "machine", sessionId: "workspace-session" },
        { machineId: "machine" },
        fix.owner,
      );
      const bound = fix.auth.nativeRunAuthority(created.run.id, "workspace-job").auth;
      expect(fix.auth.allows(bound, "containers:read")).toBe(true);
      expect(fix.auth.allows(bound, "tokens:mint")).toBe(false);
      expect(() => fix.auth.nativeRunAuthority(created.run.id, "another-job")).toThrow(
        "agent_run_unavailable",
      );
    } finally {
      fix.db.close();
    }
  });

  test("active self can bind once while restoring its exact credential rather than a sibling Run", async () => {
    const fix = await fixture();
    try {
      const first = fix.create({ target: { machineId: "machine", containerId: "inside" } });
      const sibling = fix.create({ target: { machineId: "machine", containerId: "inside" } });
      const firstActor = fix.auth.authenticate(first.credential.token);
      fix.acknowledge(firstActor);
      const session = { harness: "external", machineId: "machine", sessionId: "host-session" };
      expect(() =>
        fix.auth.bindNativeRun(
          first.run.id,
          "job",
          session,
          { machineId: "machine", containerId: "elsewhere" },
          firstActor,
        ),
      ).toThrow("run_launch_unavailable");
      expect(fix.store.getAgentRun(first.run.id)?.session).toBeNull();
      fix.auth.bindNativeRun(
        first.run.id,
        "job",
        session,
        { machineId: "machine", containerId: "inside" },
        firstActor,
      );
      expect(fix.auth.nativeRunAuthority(first.run.id, "job").auth.agentRunId).toBe(first.run.id);
      expect(() => fix.auth.nativeRunAuthority(first.run.id, "other-job")).toThrow(
        "agent_run_unavailable",
      );
      expect(() =>
        fix.auth.bindNativeRun(
          first.run.id,
          "new-job",
          session,
          { machineId: "machine", containerId: "inside" },
          firstActor,
        ),
      ).toThrow("run_launch_unavailable");
      expect(() => fix.auth.claimRunLaunch(first.run.id, fix.owner)).toThrow(
        "run_launch_unavailable",
      );
      fix.auth.finishAgentRun({ runId: first.run.id, outcome: "cancelled" }, fix.owner);
      expect(() => fix.auth.nativeRunAuthority(first.run.id, "job")).toThrow(
        "agent_run_unavailable",
      );
      expect(fix.auth.authenticate(sibling.credential.token).agentRunId).toBe(sibling.run.id);
    } finally {
      fix.db.close();
    }
  });

  test("idempotent registration and two runs share identity but isolate credentials, sessions, inspection and cleanup", async () => {
    const fix = await fixture();
    try {
      const repeated = await fix.auth.registerAgent(fix.registration, fix.owner);
      expect(repeated.agent.agentId).toBe(fix.registered.agent.agentId);
      expect(repeated.created).toBe(false);
      expect(repeated.credential).toBeUndefined();
      expect(fix.auth.listAgents(fix.owner).canRegister).toBe(true);
      expect(fix.auth.listAgents(fix.runner).canRegister).toBe(false);
      expect(fix.auth.getAgent({ agentId: repeated.agent.agentId }, fix.owner).canManage).toBe(
        true,
      );
      expect(fix.auth.getAgent({ agentId: repeated.agent.agentId }, fix.runner).canManage).toBe(
        false,
      );
      const first = fix.create({
        session: { harness: "external", sessionId: "conversation-one", machineId: "machine" },
      });
      const second = fix.create({
        session: { harness: "external", sessionId: "conversation-two", machineId: "machine" },
      });
      const firstActor = fix.auth.authenticate(first.credential.token);
      const secondActor = fix.auth.authenticate(second.credential.token);
      expect(first.run.principal.id).toBe(second.run.principal.id);
      expect(first.run.id).not.toBe(second.run.id);
      expect(firstActor.tokenId).not.toBe(secondActor.tokenId);
      expect(firstActor.agentRunId).toBe(first.run.id);
      expect(secondActor.agentRunId).toBe(second.run.id);
      expect(fix.auth.listRuns({}, firstActor).runs.map((run) => run.id)).toEqual([first.run.id]);
      expect(() => fix.auth.inspectRun({ runId: second.run.id, limit: 50 }, firstActor)).toThrow(
        "agent run inspection unavailable",
      );
      for (const actor of [firstActor, secondActor]) fix.acknowledge(actor);
      const firstTrace = fix.store.appendTrace({
        ts: 1_800_000_000_000,
        actor: firstActor.principal.id,
        runId: first.run.id,
        credentialId: firstActor.tokenId!,
        door: "core.index.list",
        authority: "containers:read",
        containerId: null,
        payload: {},
        session: null,
        outcome: "ok",
        targets: [],
      });
      const secondTrace = fix.store.appendTrace({
        ts: 1_800_000_000_000,
        actor: secondActor.principal.id,
        runId: second.run.id,
        credentialId: secondActor.tokenId!,
        door: "core.index.list",
        authority: "containers:read",
        containerId: null,
        payload: {},
        session: null,
        outcome: "forbidden",
        targets: [],
      });
      const firstProjection = fix.auth.inspectRun({ runId: first.run.id, limit: 50 }, fix.owner);
      const secondProjection = fix.auth.inspectRun({ runId: second.run.id, limit: 50 }, fix.owner);
      expect(firstProjection.traces.map((trace) => trace.traceId)).toEqual([String(firstTrace)]);
      expect(secondProjection.traces.map((trace) => trace.traceId)).toEqual([String(secondTrace)]);
      expect(firstProjection.run.session?.sessionId).toBe("conversation-one");
      expect(secondProjection.run.session?.sessionId).toBe("conversation-two");
      expect(JSON.stringify(firstProjection)).not.toContain("credentialId");
      fix.auth.finishAgentRun({ runId: first.run.id, outcome: "completed" }, firstActor);
      expect(() => fix.auth.authenticate(first.credential.token)).toThrow("revoked");
      expect(fix.auth.authenticate(second.credential.token).agentRunId).toBe(second.run.id);
      expect(fix.auth.getAgent({ agentId: first.run.agentId }, fix.owner).agent.activeRuns).toBe(1);
    } finally {
      fix.db.close();
    }
  });

  test("capability, target, reach, lifetime, delegation, expiry and state refusals create no run or credential", async () => {
    const fix = await fixture({
      targets: ["manifold://container/allowed"],
      reach: "node",
      delegation: { maxDepth: 0, maxDescendants: 0 },
    });
    try {
      const attempts: [Partial<CreateRunRequest>, string][] = [
        [{ caps: ["terminals:write"] }, "cap_exceeds_grant"],
        [{ target: "manifold://container/elsewhere" }, "target_exceeds_grant"],
        [{ reach: "subtree" }, "reach_exceeds_grant"],
        [{ lifetimeMs: 660_000 }, "lifetime_exceeds_grant"],
        [{ delegation: { maxDepth: 1, maxDescendants: 1 } }, "delegation_exceeds_grant"],
        [
          { session: { harness: "other", sessionId: "session", machineId: "machine" } },
          "session_harness_mismatch",
        ],
      ];
      const tokens = fix.store.listTokensByPrincipal(fix.registered.agent.principalId).length;
      for (const [request, reason] of attempts) {
        expect(() => fix.create(request)).toThrow(reason);
        expect(fix.store.listAgentRuns(fix.registered.agent.agentId)).toEqual([]);
        expect(fix.store.listTokensByPrincipal(fix.registered.agent.principalId).length).toBe(
          tokens,
        );
      }
      fix.auth.disableAgent({ agentId: fix.registered.agent.agentId }, fix.owner);
      expect(() => fix.create()).toThrow("agent_disabled");
      fix.auth.enableAgent({ agentId: fix.registered.agent.agentId }, fix.owner);
      const admitted = fix.create();
      expect(admitted.run.target).toBe("manifold://container/allowed");
      fix.advance(3_600_001);
      expect(() =>
        fix.auth.createRun({ agentId: fix.registered.agent.agentId }, fix.owner),
      ).toThrow("grant_expired");
    } finally {
      fix.db.close();
    }
  });

  test("disable settles every active run with one principal fence; retire preserves active credentials and is permanent", async () => {
    const fix = await fixture();
    try {
      const first = fix.create();
      const second = fix.create();
      const fences: string[] = [];
      fix.auth.onRevoked((principalId) => fences.push(principalId));
      fix.auth.disableAgent({ agentId: first.run.agentId }, fix.owner);
      expect(fences).toEqual([first.run.principal.id]);
      for (const created of [first, second]) {
        expect(fix.store.getAgentRun(created.run.id)?.state).toBe("revoked");
        expect(fix.store.getAgentRun(created.run.id)?.cleanupFailure).toBe(
          `disabled by ${fix.owner.principal.id}`,
        );
        expect(() => fix.auth.authenticate(created.credential.token)).toThrow("revoked");
      }
      fix.auth.enableAgent({ agentId: first.run.agentId }, fix.owner);
      const active = fix.create();
      const actor = fix.auth.authenticate(active.credential.token);
      fix.acknowledge(actor);
      fix.auth.retireAgent({ agentId: active.run.agentId }, fix.owner);
      expect(fix.auth.authenticate(active.credential.token).agentRunId).toBe(active.run.id);
      expect(fix.store.getAgentRun(active.run.id)?.state).toBe("active");
      expect(() => fix.create()).toThrow("agent_retired");
      expect(() => fix.auth.enableAgent({ agentId: active.run.agentId }, fix.owner)).toThrow(
        "agent_retired",
      );
      fix.auth.finishAgentRun({ runId: active.run.id, outcome: "completed" }, actor);
      expect(fix.auth.getAgent({ agentId: active.run.agentId }, fix.owner).agent.state).toBe(
        "retired",
      );
    } finally {
      fix.db.close();
    }
  });

  test("Run and agent credentials cannot turn exhausted child budgets into new standing Agents", async () => {
    const fix = await fixture({ delegation: { maxDepth: 0, maxDescendants: 0 } });
    try {
      const parent = fix.create();
      const actor = fix.auth.authenticate(parent.credential.token);
      fix.acknowledge(actor);
      const legacy = fix.auth.mintToken(
        {
          principal: { name: "unbound agent", kind: "human" },
          caps: ["*"],
        },
        fix.owner,
      );
      // Persist the pre-managed identity shape that public minting no longer creates.
      fix.db.query("UPDATE principals SET kind='agent' WHERE id=?").run(legacy.principal.id);
      const principals = fix.store.listPrincipalsWithCreation().length;
      const agents = fix.store.listAgents().length;
      const request: RegisterAgentRequest = {
        ...fix.registration,
        name: "escaped lineage",
        grant: {
          ...fix.registration.grant,
          maxRunLifetimeMs: 60_000,
          expiresAt: parent.run.expiresAt,
          delegation: { maxDepth: 4, maxDescendants: 32 },
        },
      };
      expect(fix.auth.allows(actor, "agents:delegate")).toBe(true);
      for (const caller of [actor, fix.runner, fix.auth.authenticate(legacy.token)]) {
        await expect(fix.auth.registerAgent(request, caller)).rejects.toThrow(
          "agent_registration_requires_human",
        );
        expect(fix.auth.listAgents(caller).canRegister).toBe(false);
      }
      expect(fix.store.listPrincipalsWithCreation().length).toBe(principals);
      expect(fix.store.listAgents().length).toBe(agents);
      expect(fix.auth.listRuns({}, fix.owner).runs.map((run) => run.id)).toEqual([parent.run.id]);
    } finally {
      fix.db.close();
    }
  });

  test("browser sponsors cannot renew or displace a harness credential", async () => {
    const fix = await fixture();
    try {
      const sponsorToken = fix.auth.mintToken(
        {
          principal: { name: "browser sponsor", kind: "human" },
          caps: ["containers:read", "agents:delegate"],
        },
        fix.owner,
      );
      const sponsor = fix.auth.authenticate(sponsorToken.token);
      const agent = await fix.auth.registerAgent(
        { ...fix.registration, name: "browser managed" },
        sponsor,
      );
      const admitted = fix.auth.createRun(
        { agentId: agent.agent.agentId, lifetimeMs: 120_000 },
        sponsor,
      );
      const launchToken = fix.auth.claimRunLaunch(admitted.run.id, sponsor).token!;
      const actor = fix.auth.authenticate(launchToken);
      fix.acknowledge(actor);
      fix.advance(60_000);
      const credentials = fix.store.listTokensByPrincipal(agent.agent.principalId).length;
      for (const browser of [sponsor, fix.owner]) {
        expect(() =>
          fix.auth.renewAgentRun({ runId: admitted.run.id, lifetimeMs: 120_000 }, browser),
        ).toThrow("run_renewal_requires_harness");
        expect(fix.store.listTokensByPrincipal(agent.agent.principalId).length).toBe(credentials);
        expect(fix.store.getAgentRun(admitted.run.id)?.expiresAt).toBe(admitted.run.expiresAt);
        expect(fix.auth.allows(fix.auth.authenticate(launchToken), "containers:read")).toBe(true);
      }
      const renewed = fix.auth.renewAgentRun(
        { runId: admitted.run.id, lifetimeMs: 120_000 },
        fix.auth.authenticate(agent.credential!.token),
      );
      expect(() => fix.auth.authenticate(launchToken)).toThrow("revoked");
      expect(fix.auth.authenticate(renewed.credential.token).agentRunId).toBe(admitted.run.id);
    } finally {
      fix.db.close();
    }
  });

  test("renewal replaces only one run credential, while child budgets and activity are run-relative", async () => {
    const fix = await fixture();
    try {
      const parent = fix.create({ lifetimeMs: 120_000 });
      const sibling = fix.create({ lifetimeMs: 120_000 });
      const actor = fix.auth.authenticate(parent.credential.token);
      fix.acknowledge(actor);
      fix.advance(60_000);
      const renewed = fix.auth.renewAgentRun({ runId: parent.run.id, lifetimeMs: 120_000 }, actor);
      expect(() => fix.auth.authenticate(parent.credential.token)).toThrow("revoked");
      expect(fix.auth.authenticate(sibling.credential.token).agentRunId).toBe(sibling.run.id);
      const renewedActor = fix.auth.authenticate(renewed.credential.token);
      const child = CreateRunCredentialResultSchema.parse(
        fix.auth.createChildRun({ runId: parent.run.id, lifetimeMs: 60_000 }, renewedActor),
      );
      expect(child.run.agentId).toBe(parent.run.agentId);
      expect(child.run.parentRunId).toBe(parent.run.id);
      const childActor = fix.auth.authenticate(child.credential.token);
      expect(() =>
        fix.auth.reportRunActivity({ runId: sibling.run.id, activity: "done" }, childActor),
      ).toThrow("harness_credential_required");
      expect(
        fix.auth.reportRunActivity({ runId: child.run.id, activity: "working" }, childActor).run
          .activity,
      ).toBe("working");
      expect(() =>
        fix.auth.reportRunActivity({ runId: child.run.id, activity: "done" }, fix.owner),
      ).toThrow("harness_credential_required");
      fix.auth.finishAgentRun({ runId: parent.run.id, outcome: "completed" }, renewedActor);
      expect(fix.store.getAgentRun(child.run.id)?.state).toBe("revoked");
      expect(fix.auth.authenticate(sibling.credential.token).agentRunId).toBe(sibling.run.id);
    } finally {
      fix.db.close();
    }
  });

  test("an explicit cross-Agent child remains nested under its parent without granting sibling visibility", async () => {
    const fix = await fixture();
    try {
      const sponsorGrant = fix.auth.mintToken(
        {
          principal: { name: "review sponsor", kind: "human" },
          caps: ["containers:read", "agents:delegate"],
        },
        fix.owner,
      );
      const other = await fix.auth.registerAgent(
        { ...fix.registration, name: "reviewer" },
        fix.auth.authenticate(sponsorGrant.token),
      );
      const parent = fix.create();
      const actor = fix.auth.authenticate(parent.credential.token);
      fix.acknowledge(actor);
      const deny = fix.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: "manifold://",
          effect: "deny",
          reach: "subtree",
          caps: ["containers:read"],
        },
        fix.owner,
      );
      expect(() =>
        fix.auth.createChildRun({ runId: parent.run.id, agentId: other.agent.agentId }, fix.owner),
      ).toThrow("sponsor_authority_unavailable");
      fix.auth.revokeGrant(deny.id, fix.owner);
      expect(() =>
        fix.auth.createChildRun({ runId: parent.run.id, agentId: other.agent.agentId }, actor),
      ).toThrow("agent_unavailable");
      const child = fix.auth.createChildRun(
        { runId: parent.run.id, agentId: other.agent.agentId },
        fix.owner,
      );
      expect(child.run.agentId).toBe(other.agent.agentId);
      expect(child.run.parentRunId).toBe(parent.run.id);
      expect(
        fix.auth
          .listRuns({ agentId: parent.run.agentId }, fix.owner)
          .runs.map((run) => run.id)
          .sort(),
      ).toEqual([child.run.id, parent.run.id].sort());
      expect(
        fix.auth
          .listRuns({}, actor)
          .runs.map((run) => run.id)
          .sort(),
      ).toEqual([child.run.id, parent.run.id].sort());
      const unrelated = fix.auth.createRun({ agentId: other.agent.agentId }, fix.owner);
      expect(
        fix.auth
          .listRuns({ agentId: parent.run.agentId }, fix.owner)
          .runs.some((run) => run.id === unrelated.run.id),
      ).toBe(false);
      expect(() => fix.auth.inspectRun({ runId: unrelated.run.id, limit: 50 }, actor)).toThrow(
        "agent run inspection unavailable",
      );
      const childActor = fix.auth.authenticate(
        fix.auth.claimRunLaunch(child.run.id, fix.owner).token!,
      );
      fix.acknowledge(childActor);
      expect(fix.auth.allows(childActor, "containers:read")).toBe(true);
      fix.auth.revokePrincipal(sponsorGrant.principal.id, fix.owner);
      expect(fix.auth.allows(childActor, "containers:read")).toBe(false);
      expect(fix.auth.allows(actor, "containers:read")).toBe(true);
    } finally {
      fix.db.close();
    }
  });

  test("sponsor updates change reusable context and immediately narrow live Run authority", async () => {
    const fix = await fixture();
    try {
      const run = fix.create();
      const actor = fix.auth.authenticate(run.credential.token);
      fix.acknowledge(actor);
      const outsider = fix.auth.authenticate(
        fix.auth.mintToken(
          { principal: { name: "unrelated sponsor", kind: "human" }, caps: ["agents:delegate"] },
          fix.owner,
        ).token,
      );
      for (const caller of [outsider, fix.runner, actor]) {
        await expect(
          fix.auth.updateAgent({ agentId: run.run.agentId, purpose: "Not authorized" }, caller),
        ).rejects.toThrow("agent_unavailable");
      }
      expect(fix.auth.allows(actor, "containers:read")).toBe(true);
      const context = { instructions: "Only delegate the next bounded task", profile: {} };
      await fix.auth.updateAgent(
        {
          agentId: run.run.agentId,
          purpose: "Narrowed work",
          context,
          grant: { ...fix.registration.grant, caps: ["agents:delegate"] },
        },
        fix.owner,
      );
      const updated = fix.auth.getAgent({ agentId: run.run.agentId }, fix.owner).agent;
      expect(updated.context).toEqual(context);
      expect(updated.purpose).toBe("Narrowed work");
      expect(fix.auth.allows(actor, "containers:read")).toBe(false);
      expect(() => fix.create({ caps: ["containers:read"] })).toThrow("cap_exceeds_grant");
      expect(fix.create().run.caps).toEqual(["agents:delegate"]);
      fix.auth.retireAgent({ agentId: run.run.agentId }, fix.owner);
      await expect(
        fix.auth.updateAgent({ agentId: run.run.agentId, purpose: "Reopen" }, fix.owner),
      ).rejects.toThrow("agent_retired");
    } finally {
      fix.db.close();
    }
  });

  test("browser admission never exposes a run credential or accepts a model-authored managed session", async () => {
    const fix = await fixture();
    try {
      const created = fix.auth.createRun({ agentId: fix.registered.agent.agentId }, fix.owner);
      expect(created.credential).toBeUndefined();
      expect(created.run.session).toBeNull();
      expect(() =>
        fix.auth.createRun(
          {
            agentId: fix.registered.agent.agentId,
            session: { harness: "external", sessionId: "claimed", machineId: "machine" },
          },
          fix.owner,
        ),
      ).toThrow("session_binding_untrusted");
      const parent = fix.create();
      const actor = fix.auth.authenticate(parent.credential.token);
      fix.acknowledge(actor);
      expect(() =>
        fix.auth.createChildRun(
          {
            runId: parent.run.id,
            session: { harness: "external", sessionId: "model-claim", machineId: "machine" },
          },
          actor,
        ),
      ).toThrow("session_binding_untrusted");
    } finally {
      fix.db.close();
    }
  });

  test("registered Agent credential inventory matches its full run withdrawal boundary", async () => {
    const fix = await fixture();
    try {
      const sponsorGrant = fix.auth.mintToken(
        {
          principal: { name: "credential sponsor", kind: "human" },
          caps: ["tokens:mint", "containers:read", "agents:delegate"],
        },
        fix.owner,
      );
      const sponsor = fix.auth.authenticate(sponsorGrant.token);
      const registered = await fix.auth.registerAgent(
        { ...fix.registration, name: "credential-boundary" },
        sponsor,
      );
      const runner = fix.auth.authenticate(registered.credential!.token);
      const own = CreateRunCredentialResultSchema.parse(
        fix.auth.createRun({ agentId: registered.agent.agentId }, runner),
      );
      fix.acknowledge(fix.auth.authenticate(own.credential.token));
      const foreign = fix.auth.createChildRun({ runId: own.run.id }, fix.owner);
      const foreignToken = fix.auth.claimRunLaunch(foreign.run.id, fix.owner).token!;
      const unrelated = fix.create();
      const expected = [
        runner.tokenId!,
        fix.auth.authenticate(own.credential.token).tokenId!,
        fix.auth.authenticate(foreignToken).tokenId!,
      ].sort();

      const row = fix.auth
        .listCredentials(sponsor)
        .find((entry) => entry.principal.id === registered.agent.principalId);
      expect(row?.sessions.map((session) => session.id).sort()).toEqual(expected);
      expect(fix.auth.revokePrincipal(registered.agent.principalId, sponsor)).toBe(3);
      for (const run of [own.run, foreign.run]) {
        expect(fix.store.getAgentRun(run.id)?.state).toBe("revoked");
      }
      for (const token of [registered.credential!.token, own.credential.token, foreignToken]) {
        expect(() => fix.auth.authenticate(token)).toThrow("revoked");
      }
      expect(fix.auth.authenticate(unrelated.credential.token).agentRunId).toBe(unrelated.run.id);
    } finally {
      fix.db.close();
    }
  });

  test("scoped sponsor withdrawal retains an idle registered Agent's lifecycle", async () => {
    const fix = await fixture();
    try {
      fix.store.createContainer({
        id: "container-one",
        name: "bounded credential work",
        createdAt: 1_800_000_000_000,
        discipline: "canvas",
      });
      const sponsorGrant = fix.auth.mintToken(
        {
          principal: { name: "scoped credential sponsor", kind: "human" },
          caps: ["tokens:mint", "containers:read", "agents:delegate"],
          containerId: "container-one",
        },
        fix.owner,
      );
      const sponsor = fix.auth.authenticate(sponsorGrant.token);
      const registered = await fix.auth.registerAgent(
        {
          ...fix.registration,
          name: "idle-scoped-agent",
          grant: { ...fix.registration.grant, targets: ["manifold://container/container-one"] },
        },
        sponsor,
      );

      expect(fix.auth.revokePrincipal(registered.agent.principalId, sponsor)).toBe(1);
      expect(() => fix.auth.authenticate(registered.credential!.token)).toThrow("revoked");
    } finally {
      fix.db.close();
    }
  });
});
