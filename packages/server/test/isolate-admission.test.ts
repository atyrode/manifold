import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { PluginManifest } from "@manifold/protocol";
import type { ActionPreparationCtx, PreparedRequirement } from "@manifold/protocol";
import {
  AgentSchema,
  AgentRunSchema,
  HARDENED_CONTRACT_VERSION,
  type AgentRunAuthority,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { IsolateDenial } from "../src/isolate/contract.ts";
import { IsolateSupervisor } from "../src/isolate/supervisor.ts";
import { silentLogger } from "../src/log.ts";
import type { ActionCtx } from "../src/plugin-host.ts";
import { FakeRuntime, testStore } from "./helpers.ts";

const manifest: PluginManifest = {
  id: "test.admissionguest",
  version: "1.0.0",
  title: "Admission adversary",
  description: "",
  capabilities: [],
  contributes: { panels: [], sections: [], elements: [], tools: [], events: [] },
  entry: { server: true },
};

test("an isolated process cannot write or claim success before host admission, even after a refusal", async () => {
  const runtime = new FakeRuntime();
  const store = testStore();
  const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
  const storage = store.pluginStorage(manifest.id);
  const principal = { id: "fixture", kind: "agent" as const, name: "Fixture", color: "#123456" };
  let allowed = false;
  const declarationRefusal = new Error("agent declaration required");
  const ctx = {
    traceId: 1,
    principal,
    auth: { principal, caps: [], isRoot: false, containerScope: null, allows: () => false },
    containerScope: null,
    storage,
    now: () => runtime.now(),
    admitPrepared: () => {
      if (!allowed) throw declarationRefusal;
    },
    emit: () => {
      throw new Error("fixture declares no emissions");
    },
  } as unknown as ActionCtx;
  try {
    const { def } = await supervisor.load({
      pluginId: manifest.id,
      manifest,
      dir: resolve(import.meta.dir, "fixtures/isolate-admission-guest"),
    });
    const invoke = def.handlers.write;
    if (invoke === undefined) throw new Error("fixture has no handler");
    await expect(
      invoke(ctx, { key: "before-prepare", prepare: false } as never),
    ).rejects.toBeInstanceOf(IsolateDenial);
    await expect(invoke(ctx, { key: "after-refusal" } as never)).rejects.toBe(declarationRefusal);
    allowed = true;
    await invoke(ctx, { key: "admitted" } as never);
    // The accepted round-trip drains the preceding malicious calls on this same child channel.
    expect(await storage.get("before-prepare")).toBeNull();
    expect(await storage.get("after-refusal")).toBeNull();
    expect(await storage.get("admitted")).toBe("written");
  } finally {
    await supervisor.close();
    store.close();
  }
});

test("sealed preparation keeps child normalization private, denies mutations and stops review before effects", async () => {
  const runtime = new FakeRuntime();
  const store = testStore();
  const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
  const preparedManifest: PluginManifest = {
    ...manifest,
    id: "test.preparationguest",
    capabilities: ["containers:read", "machines:read"],
  };
  const storage = store.pluginStorage(preparedManifest.id);
  const target = { kind: "container" as const, containerId: "approved" };
  const demand: PreparedRequirement = {
    cap: "machines:read",
    node: "manifold://machine/exact",
    reach: "node",
  };
  const principal = { id: "fixture", kind: "human" as const, name: "Fixture", color: "#123456" };
  let facts = 0;
  const preparation: ActionPreparationCtx = {
    terminals: {
      resolveMachine: async () => {
        facts += 1;
        return {
          machineId: "exact",
          terminalHostId: "owner",
          terminalExecution: "unconfined",
        };
      },
      stored: async () => null,
    },
    containers: { placement: async () => "tile" },
    native: { demand: async () => [] },
  };
  const captured: { targets: readonly unknown[]; requirements: readonly PreparedRequirement[] }[] =
    [];
  const ctx = {
    traceId: 1,
    callerPlugin: null,
    agentRun: null,
    principal,
    auth: { principal, caps: [], isRoot: false, containerScope: null, allows: () => false },
    containerScope: null,
    storage,
    preparation,
    prepareResolveMachine: preparation.terminals.resolveMachine,
    now: () => runtime.now(),
    admitPrepared: (
      targets: readonly unknown[],
      requirements: readonly PreparedRequirement[] = [],
    ) => {
      captured.push({ targets, requirements });
    },
    emit: () => {
      throw new Error("no emissions declared");
    },
  } as unknown as ActionCtx;
  const ref = {
    pluginId: preparedManifest.id,
    manifest: preparedManifest,
    dir: resolve(import.meta.dir, "fixtures/isolate-preparation-guest"),
    hardenedContract: HARDENED_CONTRACT_VERSION,
    serverBinding: { prepareActions: { open: { caps: ["machines:read" as const] } } },
  };
  try {
    const { def } = await supervisor.load(ref);
    await def.handlers.capture!(ctx, null as never);
    const args = { target, secret: "transport-secret", mode: "review" };
    expect(await def.handlers.open!({ ...ctx, preparationMode: "review" }, args as never)).toEqual({
      targets: [target],
      additionalRequirements: [demand],
    });
    expect(await storage.get("handler-effect")).toBeNull();
    expect(captured.at(-1)).toEqual({ targets: [target], requirements: [demand] });
    expect(await def.handlers.open!(ctx, { ...args, mode: "mutate" } as never)).toMatchObject({
      refused: expect.stringContaining("preparation"),
    });
    expect(await storage.get("preparation-effect")).toBeNull();
    expect(await storage.get("handler-effect")).toBeNull();
    expect(await def.handlers.open!(ctx, { ...args, mode: "execute" } as never)).toEqual({
      machineId: "exact",
      preparationClosed: true,
    });
    expect(await storage.get("handler-effect")).toBe("exact");
    expect(facts).toBe(3);
  } finally {
    await supervisor.close();
    store.close();
  }
});

test.each(["transform", "preprocess"] as const)(
  "legacy %s review cannot borrow a live dispatch's storage, identity or job authority",
  async (parser) => {
    const runtime = new FakeRuntime();
    const store = testStore();
    const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
    const declared: PluginManifest = {
      ...manifest,
      id: "test.legacyparser",
      capabilities: ["containers:read", "machines:mint", "jobs:cancel"],
    };
    const storage = store.pluginStorage(declared.id);
    const ownerKey = "a".repeat(64);
    const auth = new AuthService(store, ownerKey, runtime);
    const owner = auth.authenticate(ownerKey);
    const cancelled: string[] = [];
    const identity: Pick<ActionCtx["identity"], "enrollMachine"> = {
      enrollMachine: (name) => {
        const { machine, machineToken } = auth.enrollMachine(name, owner);
        return {
          ok: true,
          value: {
            created: true,
            machine: { id: machine.id, name: machine.name },
            machineToken,
          },
        };
      },
    };
    const jobs: Pick<ActionCtx["jobs"], "cancel"> = {
      cancel: (node) => {
        cancelled.push(node.jobId);
        return { accepted: true };
      },
    };
    const ctx = {
      traceId: 1,
      callerPlugin: null,
      agentRun: null,
      principal: owner.principal,
      auth: {
        principal: owner.principal,
        caps: ["*"],
        isRoot: true,
        containerScope: null,
        allows: () => true,
      },
      containerScope: null,
      storage,
      identity,
      jobs,
      now: () => runtime.now(),
      admitPrepared: () => {},
      emit: () => {
        throw new Error("no emissions declared");
      },
    } as unknown as ActionCtx;
    const target = { kind: "container" as const, containerId: "approved" };
    const reviewed: (readonly unknown[])[] = [];
    const reviewCtx: ActionCtx = {
      ...ctx,
      preparationMode: "review",
      admitPrepared: (targets) => {
        reviewed.push(targets);
      },
    };
    let holding: Promise<unknown> | undefined;
    try {
      const { def } = await supervisor.load({
        pluginId: declared.id,
        manifest: declared,
        dir: resolve(import.meta.dir, "fixtures/isolate-legacy-parser-guest"),
        hardenedContract: HARDENED_CONTRACT_VERSION,
      });
      holding = def.handlers.hold!(ctx, null as never);
      void holding.catch(() => {});
      await def.handlers.ready!(ctx, null as never);
      for (const mode of ["direct", "microtask", "descendant"] as const) {
        const key = `${parser}-${mode}`;
        const before = reviewed.length;
        const outcome = await def.handlers[parser]!(reviewCtx, {
          mode,
          key,
          text: "secret",
          target,
        } as never);
        if (mode === "descendant") {
          expect(outcome).toEqual({ targets: [target], additionalRequirements: [] });
          expect(reviewed).toEqual([[target]]);
        } else {
          expect(outcome).toMatchObject({ refused: expect.any(String) });
          expect(reviewed.length).toBe(before);
        }
        // The checkpoint releases and drains a parser descendant only AFTER review answered.
        expect(await def.handlers.checkpoint!(ctx, null as never)).toEqual({
          handled: 0,
          blocked: [true, true, true],
        });
        expect(await storage.get(key)).toBeNull();
        expect(store.getMachineByName(key)).toBeNull();
        expect(cancelled).toEqual([]);
      }
      expect(await storage.keys()).toEqual([]);
      expect(
        await def.handlers[parser]!(ctx, {
          mode: "pure",
          key: "ordinary",
          text: "child-owned",
          target,
        } as never),
      ).toEqual({ text: "child-owned!", blocked: [false, false, false] });
      expect(await storage.get("ordinary")).toBe("child-owned!");
      expect(store.getMachineByName("ordinary")).toMatchObject({ name: "ordinary" });
      expect(cancelled).toEqual(["ordinary"]);
      await def.handlers.finish!(ctx, null as never);
      expect(await holding).toBeNull();
      expect(await storage.get("retained-after-review")).toBe("admitted");
    } finally {
      await supervisor.close();
      await holding?.catch(() => {});
      store.close();
    }
  },
);

test("a guest cannot add or replace its preparer ceiling at load", async () => {
  const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime: new FakeRuntime() });
  try {
    await expect(
      supervisor.load({
        pluginId: "test.preparationguest",
        manifest: {
          ...manifest,
          id: "test.preparationguest",
          capabilities: ["containers:read", "machines:read"],
        },
        dir: resolve(import.meta.dir, "fixtures/isolate-preparation-guest"),
        hardenedContract: HARDENED_CONTRACT_VERSION,
        serverBinding: { prepareActions: { open: { caps: [] } } },
      }),
    ).rejects.toThrow("sealed artifact binding");
  } finally {
    await supervisor.close();
  }
});

test("legacy harness consumers receive faithful nested caps or refuse before posting scoped snapshots", async () => {
  const runtime = new FakeRuntime();
  const store = testStore();
  const supervisor = new IsolateSupervisor({ logger: silentLogger, runtime });
  const declared: PluginManifest = {
    ...manifest,
    id: "test.legacyauthority",
    contributes: {
      ...manifest.contributes,
      harness: { id: "legacy", title: "Legacy", profileSchema: {}, sessionRef: "typed" },
    },
  };
  const storage = store.pluginStorage(declared.id);
  const principal = { id: "fixture", kind: "agent" as const, name: "Fixture", color: "#123456" };
  const ctx = {
    traceId: 1,
    callerPlugin: null,
    agentRun: null,
    principal,
    containerScope: null,
    storage,
    auth: {
      principal,
      caps: ["scenes:write", "machines:shell"],
      isRoot: false,
      allows: () => true,
    },
    now: () => runtime.now(),
    emit: () => {},
  } as unknown as ActionCtx;
  const run = AgentRunSchema.parse({
    id: "r1",
    agentId: "a1",
    session: null,
    activity: "idle",
    principal,
    rootRunId: "r1",
    parentRunId: null,
    authorizedByPrincipalId: principal.id,
    authorizationPath: "principal",
    authorizationCredential: {
      tokenId: null,
      grantId: null,
      caps: ["scenes:write"],
      containerScope: null,
    },
    purpose: "test",
    target: "manifold://",
    reach: "subtree",
    caps: ["scenes:write"],
    createdAt: 1,
    expiresAt: 1000,
    renewals: 0,
    maxDepth: 0,
    maxDescendants: 0,
    depth: 0,
    cleanupOwnerPrincipalId: principal.id,
    state: "active",
    policyRevision: "a".repeat(64),
    cleanup: { revokedCredentials: 0, revokedGrants: 0 },
  });
  const agent = AgentSchema.parse({
    agentId: "a1",
    principalId: principal.id,
    sponsorPrincipalId: "sponsor",
    name: "Legacy",
    purpose: "test",
    harness: "legacy",
    grant: {
      caps: ["scenes:write"],
      targets: ["manifold://"],
      reach: "subtree",
      maxRunLifetimeMs: 60000,
      delegation: { maxDepth: 0, maxDescendants: 0 },
      expiresAt: 1000,
    },
    context: { profile: {} },
    state: "idle",
    activeRuns: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  try {
    const { def } = await supervisor.load({
      pluginId: declared.id,
      manifest: declared,
      dir: resolve(import.meta.dir, "fixtures/isolate-legacy-authority-guest"),
      hardenedContract: 7,
    });
    const harness = def.harness!;
    await expect(
      harness.launch(
        ctx,
        {
          ...run,
          caps: ["scenes:write", "machines:shell"],
          authorizationCredential: {
            ...run.authorizationCredential,
            caps: ["scenes:write", "machines:shell"],
          },
        },
        { ...agent, grant: { ...agent.grant, caps: ["scenes:write", "machines:shell"] } },
        { machineId: "m1" },
      ),
    ).rejects.toThrow("scoped_authority_requires_v2");
    expect(await storage.get("legacy-received")).toBeNull();
    const scoped: AgentRunAuthority = {
      ...run,
      authorityScope: [
        { target: "manifold://container/approved", reach: "subtree", caps: ["scenes:write"] },
        { target: "manifold://machine/m1", reach: "node", caps: ["machines:read"] },
      ],
    };
    await expect(harness.send(ctx, scoped, "hello")).rejects.toThrow(
      "scoped_authority_requires_v2",
    );
    expect(await storage.get("legacy-received")).toBeNull();
    await expect(harness.send(ctx, { ...run, caps: ["machines:shell"] }, "hello")).rejects.toThrow(
      "scoped_authority_requires_v2",
    );
    expect(await storage.get("legacy-received")).toBeNull();
  } finally {
    await supervisor.close();
    store.close();
  }
});
