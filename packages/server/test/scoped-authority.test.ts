import { describe, expect, test } from "bun:test";
import {
  canonicalizeAuthorityScope,
  formatManifoldUri,
  type AuthorityScope,
} from "@manifold/protocol";
import { AuthService, type AuthContext } from "../src/auth.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

function fixture() {
  const runtime = new FakeRuntime();
  runtime.time = 1_800_000_000_000;
  const store = testStore();
  const secret = "c".repeat(64);
  const auth = new AuthService(store, secret, runtime);
  const owner = auth.authenticate(secret);
  const c = runtime.newId();
  const c2 = runtime.newId();
  for (const id of [c, c2])
    store.createContainer({ id, name: id, discipline: "composition", createdAt: runtime.now() });
  const m1 = formatManifoldUri({ kind: "machine", machineId: "account-one" });
  const m2 = formatManifoldUri({ kind: "machine", machineId: "account-two" });
  const placement = formatManifoldUri({ kind: "container", containerId: c });
  const scope: AuthorityScope = [
    {
      target: placement,
      reach: "subtree",
      caps: [
        "containers:read",
        "containers:write",
        "scenes:write",
        "terminals:spawn",
        "terminals:write",
        "agents:delegate",
      ],
    },
    { target: m1, reach: "node", caps: ["machines:shell", "agents:delegate"] },
  ];
  const mint = (requested: AuthorityScope = scope, principalId?: string) =>
    auth.mintTokenV2(
      {
        ...(principalId === undefined
          ? { principal: { name: "ordinary automation", kind: "human" as const } }
          : { principalId }),
        scope: requested,
        containerId: c,
        expiresAt: runtime.now() + 3_600_000,
      },
      owner,
    );
  const acknowledge = (actor: AuthContext) => {
    const policy = auth.agentPolicyChallenge(actor);
    return auth.acknowledgeAgentPolicyV2(
      {
        revision: policy.revision,
        acknowledgements: policy.required.map(({ id, digest }) => ({ id, digest })),
      },
      actor,
    );
  };
  return { runtime, store, auth, owner, c, c2, m1, m2, placement, scope, mint, acknowledge };
}

describe("correlated ordinary-shell authority", () => {
  test("C remains the context anchor while only the explicit M entry authorizes shell creation", () => {
    const f = fixture();
    try {
      const issued = f.mint();
      const actor = f.auth.authenticate(issued.token);
      expect(actor.containerScope).toBe(f.c);
      expect(f.auth.allows(actor, "terminals:spawn", f.c)).toBe(true);
      expect(f.auth.allows(actor, "terminals:spawn", f.c2)).toBe(false);
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(true);
      expect(f.auth.allowsNode(actor, "machines:shell", f.m2)).toBe(false);
      expect(f.auth.allowsNode(actor, "terminals:spawn", f.m1)).toBe(false);
      expect(f.auth.holdsRoot(actor)).toBe(false);
      expect(
        f.auth
          .listCredentialsV2(f.owner)
          .flatMap((row) => row.sessions)
          .find((row) => row.id === actor.tokenId)?.authorityScope,
      ).toEqual(actor.authorityScope);
      expect(() => f.auth.listCredentials(f.owner)).toThrow("scoped_authority_requires_v2");
    } finally {
      f.store.close();
    }
  });

  test("same-principal credentials cannot borrow another token's machine grant rows", () => {
    const f = fixture();
    try {
      const first = f.mint();
      const secondScope: AuthorityScope = [
        f.scope[0]!,
        { target: f.m2, reach: "node", caps: ["machines:shell"] },
      ];
      const second = f.mint(secondScope, first.principal.id);
      const a = f.auth.authenticate(first.token);
      const b = f.auth.authenticate(second.token);
      expect(f.auth.allowsNode(a, "machines:shell", f.m2)).toBe(false);
      expect(f.auth.allowsNode(b, "machines:shell", f.m1)).toBe(false);
      f.store.revokeToken(a.tokenId!, f.runtime.now());
      expect(f.auth.allowsNode(a, "machines:shell", f.m1)).toBe(false);
      expect(f.auth.allowsNode(b, "machines:shell", f.m2)).toBe(true);
      expect(f.auth.allows(b, "terminals:spawn", f.c)).toBe(true);
    } finally {
      f.store.close();
    }
  });

  test("a live machine deny withdraws one leg without converting placement into machine authority", () => {
    const f = fixture();
    try {
      const issued = f.mint();
      const actor = f.auth.authenticate(issued.token);
      const denied = f.auth.grant(
        {
          principal: { kind: "principal", id: actor.principal.id },
          node: f.m1,
          reach: "node",
          effect: "deny",
          caps: ["machines:shell"],
        },
        f.owner,
      );
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(false);
      expect(f.auth.allows(actor, "terminals:spawn", f.c)).toBe(true);
      f.auth.revokeGrant(denied.id, f.owner);
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(true);
      f.runtime.time = issued.expiresAt;
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(false);
    } finally {
      f.store.close();
    }
  });

  test("restoration preserves correlation, rejects omission and expansion, and permits honest empty attenuation", () => {
    const f = fixture();
    try {
      const actor = f.auth.authenticate(f.mint().token);
      const reference = f.auth.credentialReference(actor);
      const restored = f.auth.restoreCredential(reference)!;
      expect(restored.containerScope).toBe(f.c);
      expect(f.auth.allowsNode(restored, "machines:shell", f.m1)).toBe(true);
      expect(f.auth.allowsNode(restored, "machines:shell", f.m2)).toBe(false);
      const { authorityScope: _scope, ...omitted } = reference;
      expect(f.auth.restoreCredential(omitted)).toBeNull();
      expect(
        f.auth.restoreCredential({
          ...reference,
          authorityScope: [{ target: f.m2, reach: "node", caps: ["machines:shell"] }],
        }),
      ).toBeNull();
      const empty = f.auth.restoreCredential({ ...reference, authorityScope: [] })!;
      expect(f.auth.allows(empty, "containers:read", f.c)).toBe(false);
      expect(f.auth.allowsNode(empty, "machines:shell", f.m1)).toBe(false);
      expect(f.auth.ceilingCaps(empty)).toEqual([]);
      const noRights = f.auth.authenticate(f.mint([]).token);
      expect(noRights.authorityScope).toEqual([]);
      expect(f.auth.allows(noRights, "containers:read", f.c)).toBe(false);
    } finally {
      f.store.close();
    }
  });

  test("root-node permission cannot authorize workspace subtree issuance, while exact future H remains deny-sensitive", () => {
    const f = fixture();
    try {
      const node = f.auth.mintTokenV2(
        {
          principal: { name: "node only", kind: "human" },
          scope: [
            { target: "manifold://", reach: "node", caps: ["tokens:mint", "containers:read"] },
          ],
          expiresAt: f.runtime.now() + 600_000,
        },
        f.owner,
      );
      const actor = f.auth.authenticate(node.token);
      expect(f.auth.allowsNode(actor, "containers:read", "manifold://", "node")).toBe(true);
      expect(f.auth.allowsNode(actor, "containers:read", "manifold://", "subtree")).toBe(false);
      const before = f.store.listPrincipalsWithCreation();
      expect(() =>
        f.auth.mintTokenV2(
          {
            principal: { name: "must not exist", kind: "human" },
            scope: [{ target: "manifold://", reach: "subtree", caps: ["containers:read"] }],
            expiresAt: f.runtime.now() + 300_000,
          },
          actor,
        ),
      ).toThrow("scoped_authority_exceeds_issuer");
      expect(f.store.listPrincipalsWithCreation()).toEqual(before);
      const broad = f.auth.mintToken(
        {
          principal: { name: "canvas author", kind: "human" },
          caps: ["tokens:mint", "containers:read"],
        },
        f.owner,
      );
      const author = f.auth.authenticate(broad.token);
      f.auth.grant(
        {
          principal: { kind: "principal", id: author.principal.id },
          node: f.placement,
          reach: "subtree",
          effect: "deny",
          caps: ["containers:read"],
        },
        f.owner,
      );
      expect(f.auth.allowsNode(author, "containers:read", "manifold://", "subtree")).toBe(true);
      expect(f.auth.allowsNode(author, "containers:read", f.placement)).toBe(false);
      expect(() =>
        f.auth.mintTokenV2(
          {
            principal: { name: "denied subtree", kind: "human" },
            scope: [{ target: "manifold://", reach: "subtree", caps: ["containers:read"] }],
            expiresAt: f.runtime.now() + 300_000,
          },
          author,
        ),
      ).toThrow("scoped_authority_exceeds_issuer");
    } finally {
      f.store.close();
    }
  });

  test("a narrowed native ceiling cannot recover engine caps from the correlated scope union", () => {
    const f = fixture();
    try {
      const issued = f.mint([
        { target: f.placement, reach: "subtree", caps: ["containers:read"] },
        { target: f.m1, reach: "subtree", caps: ["machines:run", "operations:invoke"] },
      ]);
      const actor = f.auth.authenticate(issued.token);
      const narrowed = f.auth.restoreCredential({
        ...f.auth.credentialReference(actor),
        caps: ["containers:read"],
      })!;
      expect(
        f.auth.ceilingAdmits(narrowed, "machines:run", {
          kind: "machine",
          machineId: "account-one",
        }),
      ).toBe(false);
      expect(f.auth.ceilingCaps(narrowed)).toEqual(["containers:read"]);
    } finally {
      f.store.close();
    }
  });

  test("share issuance cannot launder C1-only authority into a different container", async () => {
    const f = fixture();
    try {
      const issued = f.auth.mintTokenV2(
        {
          principal: { name: "Scoped sharer", kind: "human" },
          scope: [
            { target: "manifold://", reach: "subtree", caps: ["tokens:mint"] },
            { target: f.placement, reach: "subtree", caps: ["scenes:write"] },
          ],
          expiresAt: f.runtime.now() + 600_000,
        },
        f.owner,
      );
      const actor = f.auth.authenticate(issued.token);
      const before = f.auth.listShares(f.owner);
      await expect(
        Promise.resolve().then(() =>
          f.auth.mintShare(
            {
              node: { kind: "container", containerId: f.c2 },
              caps: ["scenes:write"],
              origin: "https://guest.test",
            },
            actor,
          ),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(f.auth.listShares(f.owner)).toEqual(before);
      const share = f.auth.mintShare(
        {
          node: { kind: "container", containerId: f.c },
          caps: ["scenes:write"],
          origin: "https://guest.test",
        },
        actor,
      );
      expect(share.share.ref).toEqual({ kind: "container", containerId: f.c });
    } finally {
      f.store.close();
    }
  });

  test("ordinary terminal lifecycle credentials retain local control but grant neither creation leg", () => {
    const f = fixture();
    try {
      const terminal = f.auth.mintTerminalLifecycleToken("retained-pty", f.c, f.owner.principal.id);
      const actor = f.auth.authenticate(terminal.token);
      expect(f.auth.allows(actor, "containers:read", f.c)).toBe(true);
      expect(f.auth.allows(actor, "terminals:write", f.c)).toBe(true);
      expect(f.auth.allows(actor, "terminals:spawn", f.c)).toBe(false);
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(false);
    } finally {
      f.store.close();
    }
  });
});

describe("scoped durable Agent and Run lifecycle", () => {
  test("a V1 write blocked in profile validation cannot mutate a newly scoped successor grant", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    try {
      const registration = await f.auth.registerAgent(
        {
          name: "concurrent migration",
          purpose: "Original purpose",
          harness: "external",
          context: { profile: {} },
          grant: {
            caps: ["containers:read", "agents:delegate"],
            targets: ["manifold://"],
            reach: "subtree",
            maxRunLifetimeMs: 120_000,
            delegation: { maxDepth: 0, maxDescendants: 0 },
            expiresAt: f.runtime.now() + 600_000,
          },
        },
        f.owner,
      );
      f.auth.setAgentProfileValidator(async (_harness, profile) => {
        if (
          typeof profile === "object" &&
          profile !== null &&
          "hold" in profile &&
          profile.hold === true
        )
          await gate.promise;
      });
      const pending = f.auth.updateAgent(
        {
          agentId: registration.agent.agentId,
          purpose: "Must not replace the successor",
          context: { profile: { hold: true } },
        },
        f.owner,
      );
      await f.auth.updateAgentV2(
        {
          agentId: registration.agent.agentId,
          grant: {
            scope: f.scope,
            maxRunLifetimeMs: 120_000,
            delegation: { maxDepth: 0, maxDescendants: 0 },
            expiresAt: f.runtime.now() + 600_000,
          },
        },
        f.owner,
      );
      gate.resolve();
      await expect(pending).rejects.toThrow("scoped_authority_requires_v2");
      const successor = f.auth.getAgentV2({ agentId: registration.agent.agentId }, f.owner).agent;
      expect(successor.purpose).toBe("Original purpose");
      expect(successor.context.profile).toEqual({});
      expect(successor.grant.scope).toEqual(canonicalizeAuthorityScope(f.scope));
    } finally {
      gate.resolve();
      f.store.close();
    }
  });

  test("a V2 child inherits the actual retained legacy parent rather than the wider standing Agent", async () => {
    const f = fixture();
    try {
      const registration = await f.auth.registerAgent(
        {
          name: "Retained legacy parent",
          purpose: "Keep the narrowed execution",
          harness: "external",
          context: { profile: {} },
          grant: {
            caps: ["containers:read", "agents:delegate"],
            targets: ["manifold://"],
            reach: "subtree",
            maxRunLifetimeMs: 300_000,
            delegation: { maxDepth: 2, maxDescendants: 3 },
            expiresAt: f.runtime.now() + 600_000,
          },
        },
        f.owner,
      );
      const runner = f.auth.authenticate(registration.credential!.token);
      const parent = f.auth.createRun(
        {
          agentId: registration.agent.agentId,
          target: f.placement,
          reach: "subtree",
          caps: ["containers:read", "agents:delegate"],
          lifetimeMs: 120_000,
        },
        runner,
      );
      const parentActor = f.auth.authenticate(parent.credential!.token);
      f.acknowledge(parentActor);
      const child = f.auth.createChildRunV2(
        { runId: parent.run.id, lifetimeMs: 60_000 },
        parentActor,
      );
      const childActor = f.auth.authenticate(child.credential!.token);
      f.acknowledge(childActor);
      expect(child.run.scope).toEqual([
        {
          target: f.placement,
          reach: "subtree",
          caps: ["agents:delegate", "containers:read"],
        },
      ]);
      expect(f.auth.allows(childActor, "containers:read", f.c)).toBe(true);
      expect(f.auth.allows(childActor, "containers:read", f.c2)).toBe(false);
    } finally {
      f.store.close();
    }
  });

  test("V2 admission, policy, child attenuation, renewal and settlement never flatten correlated rights", async () => {
    const f = fixture();
    try {
      const sponsor = f.auth.authenticate(f.mint().token);
      const registration = await f.auth.registerAgentV2(
        {
          name: "bounded worker",
          purpose: "Use only the approved composition and account",
          harness: "external",
          context: { profile: {} },
          grant: {
            scope: f.scope,
            maxRunLifetimeMs: 600_000,
            delegation: { maxDepth: 2, maxDescendants: 3 },
            expiresAt: f.runtime.now() + 3_000_000,
          },
        },
        sponsor,
      );
      const runner = f.auth.authenticate(registration.credential!.token);
      const created = f.auth.createRunV2(
        { agentId: registration.agent.agentId, target: f.placement, lifetimeMs: 300_000 },
        runner,
      );
      let worker = f.auth.authenticate(created.credential!.token);
      expect(created.run.scope).toEqual(registration.agent.grant.scope);
      expect(worker.containerScope).toBe(f.c);
      expect(f.auth.allowsNode(worker, "machines:shell", f.m1)).toBe(false);
      expect(f.acknowledge(worker).run.scope).toEqual(created.run.scope);
      expect(f.auth.allowsNode(worker, "machines:shell", f.m1)).toBe(true);
      expect(f.auth.allowsNode(worker, "machines:shell", f.m2)).toBe(false);
      expect(f.auth.inspectRunV2({ runId: created.run.id, limit: 50 }, f.owner).run.scope).toEqual(
        created.run.scope,
      );
      expect(() => f.auth.inspectRun({ runId: created.run.id, limit: 50 }, f.owner)).toThrow(
        "scoped_authority_requires_v2",
      );
      const tokensBefore = f.store.listTokensByPrincipal(worker.principal.id);
      expect(() =>
        f.auth.createChildRunV2(
          {
            runId: created.run.id,
            scope: [{ target: f.m2, reach: "node", caps: ["machines:shell"] }],
            lifetimeMs: 60_000,
          },
          worker,
        ),
      ).toThrow("scope_exceeds_grant");
      expect(f.store.listTokensByPrincipal(worker.principal.id)).toEqual(tokensBefore);
      const child = f.auth.createChildRunV2(
        { runId: created.run.id, scope: [f.scope[0]!], target: f.placement, lifetimeMs: 120_000 },
        worker,
      );
      const childActor = f.auth.authenticate(child.credential!.token);
      f.acknowledge(childActor);
      expect(f.auth.allows(childActor, "terminals:spawn", f.c)).toBe(true);
      expect(f.auth.allowsNode(childActor, "machines:shell", f.m1)).toBe(false);
      f.runtime.time += 1;
      const renewed = f.auth.renewAgentRunV2(
        { runId: created.run.id, lifetimeMs: 300_000 },
        worker,
      );
      worker = f.auth.authenticate(renewed.credential.token);
      expect(renewed.run.scope).toEqual(created.run.scope);
      expect(f.auth.allowsNode(worker, "machines:shell", f.m1)).toBe(true);
      const finished = f.auth.finishAgentRunV2(
        { runId: created.run.id, outcome: "completed" },
        runner,
      );
      expect(finished.finishedRuns).toBe(2);
      expect(f.auth.restoreCredential(f.auth.credentialReference(worker))).toBeNull();
      expect(f.auth.restoreCredential(f.auth.credentialReference(childActor))).toBeNull();
    } finally {
      f.store.close();
    }
  });

  test("empty V2 standing and Run scopes remain empty through lifecycle and refuse V1 minima", async () => {
    const f = fixture();
    try {
      const registration = await f.auth.registerAgentV2(
        {
          name: "no working authority",
          purpose: "Lifecycle bookkeeping only",
          harness: "external",
          context: { profile: {} },
          grant: {
            scope: [],
            maxRunLifetimeMs: 120_000,
            delegation: { maxDepth: 0, maxDescendants: 0 },
            expiresAt: f.runtime.now() + 600_000,
          },
        },
        f.owner,
      );
      const runner = f.auth.authenticate(registration.credential!.token);
      const run = f.auth.createRunV2(
        { agentId: registration.agent.agentId, lifetimeMs: 60_000 },
        runner,
      );
      const actor = f.auth.authenticate(run.credential!.token);
      f.acknowledge(actor);
      expect(run.run.scope).toEqual([]);
      expect(run.run.caps).toEqual([]);
      expect(actor.authorityScope).toEqual([]);
      expect(f.auth.allows(actor, "containers:read", f.c)).toBe(false);
      expect(f.auth.allowsNode(actor, "machines:shell", f.m1)).toBe(false);
      expect(() => f.auth.getAgent({ agentId: registration.agent.agentId }, f.owner)).toThrow(
        "scoped_authority_requires_v2",
      );
      const outsider = f.auth.authenticate(f.mint([]).token);
      expect(() =>
        f.auth.finishAgentRun({ runId: run.run.id, outcome: "completed" }, outsider),
      ).toThrow("agent_unavailable");
      expect(() =>
        f.auth.finishAgentRun({ runId: run.run.id, outcome: "completed" }, runner),
      ).toThrow("scoped_authority_requires_v2");
      expect(f.store.getAgentRun(run.run.id)?.state).toBe("active");
      expect(
        f.auth.finishAgentRunV2({ runId: run.run.id, outcome: "completed" }, runner).run.scope,
      ).toEqual([]);
    } finally {
      f.store.close();
    }
  });

  test("withdrawing the sponsor machine leg before admission has no Run or credential effect", async () => {
    const f = fixture();
    try {
      const sponsor = f.auth.authenticate(f.mint().token);
      const registration = await f.auth.registerAgentV2(
        {
          name: "fenced worker",
          purpose: "Prove live machine delegation",
          harness: "external",
          context: { profile: {} },
          grant: {
            scope: f.scope,
            maxRunLifetimeMs: 600_000,
            delegation: { maxDepth: 1, maxDescendants: 1 },
            expiresAt: f.runtime.now() + 3_000_000,
          },
        },
        sponsor,
      );
      const runner = f.auth.authenticate(registration.credential!.token);
      const runs = f.store.listAgentRuns(registration.agent.agentId);
      const tokens = f.store.listTokensByPrincipal(registration.agent.principalId);
      expect(() =>
        f.auth.createRunV2(
          { agentId: registration.agent.agentId, target: f.placement, lifetimeMs: 60_000 },
          runner,
          () => {
            f.auth.grant(
              {
                principal: { kind: "principal", id: sponsor.principal.id },
                node: f.m1,
                reach: "node",
                effect: "deny",
                caps: ["machines:shell"],
              },
              f.owner,
            );
          },
        ),
      ).toThrow("sponsor_authority_unavailable");
      expect(f.store.listAgentRuns(registration.agent.agentId)).toEqual(runs);
      expect(f.store.listTokensByPrincipal(registration.agent.principalId)).toEqual(tokens);
    } finally {
      f.store.close();
    }
  });
});
