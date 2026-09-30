import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { defineAction } from "@manifold/plugin";
import {
  PluginManifestSchema,
  PluginOwnedRefSchema,
  PublishedReferenceSchema,
  formatManifoldUri,
  ReferenceReceiptRequestSchema,
  ReferenceTerminalReceiptSchema,
  ReferencePublishRequestSchema,
  ReferenceReadFilterRequestSchema,
  ReferenceReadFilterResultSchema,
  ReferenceProbeResultSchema,
  type OwnedReferenceDeclaration,
  type PluginOwnedRef,
  type PublishedReference,
} from "@manifold/protocol";
import { AuthService } from "../src/auth.ts";
import { openDatabase } from "../src/db.ts";
import { InstanceDialer } from "../src/instance-dialer.ts";
import { silentLogger } from "../src/log.ts";
import { PlaceExecutor, assemblyItemNouns, assemblyPlacementVocabulary } from "../src/placement.ts";
import { PluginHost, type ActionCtx, type ServerPluginDef } from "../src/plugin-host.ts";
import { RoomManager } from "../src/room.ts";
import { ServerStore } from "../src/stores.ts";
import { TerminalBroker } from "../src/terminal-broker.ts";
import { createExternalRun } from "./agent-fixtures.ts";
import { FakeClock, FakeRuntime, testEventHub, testTileTrees } from "./helpers.ts";

const closed: (() => void)[] = [];
afterEach(() => {
  for (const close of closed.splice(0).reverse()) close();
});
const declaration: OwnedReferenceDeclaration = {
  kind: "file",
  resolveAction: "resolve",
  readCapability: "vendor.vault:read",
  receiptAction: "receipt",
  listAction: "list",
  createCapability: "vendor.vault:create",
  deleteCapability: "vendor.vault:delete",
  creatorCaps: ["vendor.vault:read", "vendor.vault:delete", "vendor.vault:share"],
  sharing: {
    grantorCapability: "vendor.vault:share",
    prerequisites: ["vendor.vault:read", "vendor.vault:share"],
    grantableCaps: ["vendor.vault:read"],
  },
};

async function fixture() {
  const runtime = new FakeRuntime();
  const clock = new FakeClock(runtime);
  const store = new ServerStore(openDatabase(":memory:"));
  closed.push(() => store.close());
  const auth = new AuthService(store, "a".repeat(64), runtime);
  const root = auth.authenticate("a".repeat(64));
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
  const placement = new PlaceExecutor(
    store,
    rooms,
    broker,
    runtime,
    assemblyPlacementVocabulary(() => []),
    assemblyItemNouns(() => []),
    testTileTrees,
  );
  const state = {
    probe: null as (() => Promise<void>) | null,
    resolve: null as (() => Promise<void>) | null,
    retained: null as ActionCtx | null,
    retainedReceipt: null as ActionCtx | null,
    mutateInReceipt: false,
  };
  const collection = { kind: "plugin" as const, pluginId: "vendor.vault" };
  const createInput = z.strictObject({
    collection: z.strictObject({ kind: z.literal("plugin"), pluginId: z.literal("vendor.vault") }),
  });
  const def: ServerPluginDef = {
    manifest: PluginManifestSchema.parse({
      id: "vendor.vault",
      version: "1.0.0",
      title: "Vault",
      description: "Neutral test reference owner",
      capabilities: [declaration.createCapability, ...declaration.creatorCaps],
      entry: { server: true },
      contributes: { references: [declaration] },
    }),
    actions: [
      defineAction({
        name: "create",
        title: "Create",
        caps: [declaration.createCapability],
        requirements: [{ cap: declaration.createCapability, target: ["collection"] }],
        input: createInput,
        result: PublishedReferenceSchema,
      }),
      defineAction({
        name: "retry",
        title: "Retry publication",
        caps: [declaration.createCapability],
        requirements: [{ cap: declaration.createCapability, target: ["collection"] }],
        input: createInput.extend({ publication: ReferencePublishRequestSchema }),
        result: PublishedReferenceSchema,
      }),
      defineAction({
        name: "delete",
        title: "Delete",
        caps: [declaration.deleteCapability],
        requirements: [{ cap: declaration.deleteCapability, target: ["ref"] }],
        input: ReferenceReceiptRequestSchema,
        result: ReferenceTerminalReceiptSchema,
      }),
      defineAction({
        name: "receipt",
        title: "Receipt",
        caps: [],
        input: ReferenceReceiptRequestSchema,
        result: ReferenceTerminalReceiptSchema,
      }),
      defineAction({
        name: "otherReceipt",
        title: "Other receipt",
        caps: [],
        input: ReferenceReceiptRequestSchema,
        result: ReferenceTerminalReceiptSchema,
      }),
      defineAction({
        name: "list",
        title: "List readable references",
        caps: [],
        trace: "opaque",
        input: ReferenceReadFilterRequestSchema,
        result: ReferenceReadFilterResultSchema,
      }),
      defineAction({
        name: "otherList",
        title: "Not the list door",
        caps: [],
        trace: "opaque",
        input: ReferenceReadFilterRequestSchema,
        result: ReferenceReadFilterResultSchema,
      }),
      defineAction({
        name: "attempt",
        title: "Attempt",
        caps: [],
        input: createInput,
        result: PublishedReferenceSchema,
      }),
      defineAction({
        name: "resolve",
        title: "Resolve",
        caps: [declaration.readCapability],
        requirements: [{ cap: declaration.readCapability, target: ["ref"] }],
        input: z.strictObject({ ref: PluginOwnedRefSchema }),
        result: z.strictObject({ title: z.string().max(128) }),
      }),
      defineAction({
        name: "shareThroughRead",
        title: "Share through read",
        caps: [declaration.readCapability],
        requirements: [{ cap: declaration.readCapability, target: ["ref"] }],
        input: z.strictObject({ ref: PluginOwnedRefSchema }),
        result: z.object({}),
      }),
      defineAction({
        name: "retain",
        title: "Retain",
        caps: [declaration.createCapability],
        requirements: [{ cap: declaration.createCapability, target: ["collection"] }],
        input: createInput,
        result: z.object({}),
      }),
    ],
    handlers: {
      async create(ctx) {
        const preparation = await ctx.references.prepare({
          kind: "file",
          requestId: ctx.newId(),
          bindingDigest: "1".repeat(64),
        });
        await ctx.storage.set(
          `ready:${preparation.preparationId}`,
          JSON.stringify({
            preparationId: preparation.preparationId,
            readyDigest: "2".repeat(64),
            expiresAt: preparation.expiresAt,
          }),
        );
        return ctx.references.publish({
          preparationId: preparation.preparationId,
          readyDigest: "2".repeat(64),
        });
      },
      async retry(ctx, input: { publication: { preparationId: string; readyDigest: string } }) {
        return ctx.references.publish(input.publication);
      },
      async delete(ctx, input: { ref: PluginOwnedRef }) {
        return ctx.references.unpublish(input);
      },
      async receipt(ctx, input: { ref: PluginOwnedRef }) {
        state.retainedReceipt = ctx;
        if (state.mutateInReceipt) await ctx.references.unpublish(input);
        return ctx.references.receipt(input);
      },
      async otherReceipt(ctx, input: { ref: PluginOwnedRef }) {
        return ctx.references.receipt(input);
      },
      async list(ctx, input: z.infer<typeof ReferenceReadFilterRequestSchema>) {
        return ctx.references.readable(input);
      },
      async otherList(ctx, input: z.infer<typeof ReferenceReadFilterRequestSchema>) {
        return ctx.references.readable(input);
      },
      async attempt(ctx) {
        return def.handlers.create!(ctx, undefined as never);
      },
      async resolve(ctx, input: { ref: PluginOwnedRef }) {
        await ctx.references.requirePublished({ ref: input.ref, access: "read" });
        await state.resolve?.();
        return { title: "private reference title" };
      },
      async shareThroughRead(ctx, input: { ref: PluginOwnedRef }) {
        return ctx.references.grant({
          ref: input.ref,
          principalId: root.principal.id,
          caps: [declaration.readCapability],
          previousGrantId: null,
        });
      },
      async retain(ctx) {
        state.retained = ctx;
        return {};
      },
    },
    async probeReady(ctx, input) {
      await state.probe?.();
      const proof = await ctx.storage.get(`ready:${input.preparationId}`);
      return ReferenceProbeResultSchema.parse(proof == null ? null : JSON.parse(proof));
    },
    async reclaimReferences(ctx, receipts) {
      for (const receipt of receipts) await ctx.storage.delete(`ready:${receipt.preparationId}`);
    },
  };
  let host: PluginHost | null = null;
  const events = testEventHub(
    store,
    auth,
    broker,
    () => host!.assembly(),
    runtime,
    silentLogger,
    (actor, node) => host?.canReadGoverned(actor, node) ?? false,
  );
  host = await PluginHost.boot(
    [def],
    store,
    auth,
    rooms,
    broker,
    placement,
    {
      isOnline: () => false,
      getTerminalExecution: () => null,
      getPhysicalCoreCount: () => undefined,
      drain: async () => ({ ok: false, reason: "offline" }),
      repository: async () => ({ ok: false, reason: "offline" }),
    },
    new InstanceDialer(store, runtime, silentLogger, () => "http://localhost:7777"),
    runtime,
    silentLogger,
    events,
  );
  closed.push(() => host!.close());
  const createGrant = auth.grant(
    {
      principal: { kind: "principal", id: root.principal.id },
      node: formatManifoldUri(collection),
      caps: [declaration.createCapability],
      effect: "allow",
      reach: "node",
    },
    root,
  );
  const create = async (): Promise<PublishedReference> => {
    const result = await host!.dispatch(root, "vendor.vault.create", { collection });
    if (!result.ok) throw new Error(result.denial.message);
    return PublishedReferenceSchema.parse(result.result);
  };
  return { store, root, auth, host, state, collection, create, createGrant, runtime };
}

test("active action declarations, not plugin manifest or caller authority, constrain each reference method", async () => {
  const f = await fixture();
  expect(
    await f.host.dispatch(f.root, "vendor.vault.attempt", { collection: f.collection }),
  ).toMatchObject({
    ok: false,
    denial: { rule: "refused", message: "reference_unavailable" },
  });
  const published = await f.create();
  expect(
    await f.host.dispatch(f.root, "vendor.vault.shareThroughRead", { ref: published.ref }),
  ).toMatchObject({
    ok: false,
    denial: { rule: "refused", message: "reference_unavailable" },
  });
  await f.host.dispatch(f.root, "vendor.vault.retain", { collection: f.collection });
  expect(f.state.retained?.credentialBinding).toBe(f.auth.credentialBinding(f.root));
  await expect(
    f.state.retained!.references.prepare({
      kind: "file",
      requestId: "outside-dispatch",
      bindingDigest: "1".repeat(64),
    }),
  ).rejects.toThrow("reference_unavailable");
});

test("generic resolver projects no name for denied, disabled, missing, quarantined or post-await revoked references", async () => {
  const f = await fixture();
  const published = await f.create();
  const reader = f.auth.authenticate(
    f.auth.mintToken(
      { principal: { kind: "human", name: "reader" }, caps: ["containers:read"] },
      f.root,
    ).token,
  );
  const unavailable = { exists: false, title: null };
  expect(await f.host.resolveOwnedReference(reader, published.ref)).toEqual(unavailable);
  expect(await f.host.resolveOwnedReference(reader, { kind: "file", fileId: "missing" })).toEqual(
    unavailable,
  );
  const read = f.auth.grant(
    {
      principal: { kind: "principal", id: reader.principal.id },
      node: formatManifoldUri(published.ref),
      caps: [declaration.readCapability],
      effect: "allow",
      reach: "node",
    },
    f.root,
  );
  expect(await f.host.resolveOwnedReference(reader, published.ref)).toEqual({
    exists: true,
    title: "private reference title",
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.resolve = async () => {
    entered.resolve();
    await release.promise;
  };
  const resolving = f.host.resolveOwnedReference(reader, published.ref);
  await entered.promise;
  f.auth.revokeGrant(read.id, f.root);
  release.resolve();
  expect(await resolving).toEqual(unavailable);
  f.state.resolve = null;
  await f.host.setEnabled("vendor.vault", false, f.root.principal.id);
  expect(await f.host.resolveOwnedReference(f.root, published.ref)).toEqual(unavailable);
  await f.host.setEnabled("vendor.vault", true, f.root.principal.id);
  await f.store.pluginStorage("vendor.vault").delete(`ready:${published.preparationId}`);
  expect(await f.host.resolveOwnedReference(f.root, published.ref)).toEqual(unavailable);
  expect(
    f.store.db
      .query("SELECT state FROM reference_publications WHERE node=?")
      .get(formatManifoldUri(published.ref)),
  ).toEqual({ state: "quarantined" });
});

test("disable/re-enable fences an earlier in-flight probe even when the definition object is unchanged", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.probe = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.dispatch(f.root, "vendor.vault.create", { collection: f.collection });
  await entered.promise;
  await f.host.setEnabled("vendor.vault", false, f.root.principal.id);
  await f.host.setEnabled("vendor.vault", true, f.root.principal.id);
  release.resolve();
  expect(await pending).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  expect(f.store.db.query("SELECT state FROM reference_publications").all()).toEqual([
    { state: "aborted" },
  ]);
  expect(f.store.db.query("SELECT grant_id FROM reference_grant_provenance").all()).toEqual([]);
});

test("a create-only door reconciles a publication ACK without a new read-target declaration and rechecks create after its probe", async () => {
  const f = await fixture();
  const published = await f.create();
  const args = {
    collection: f.collection,
    publication: {
      preparationId: published.preparationId,
      readyDigest: published.readyDigest,
    },
  };
  expect(await f.host.dispatch(f.root, "vendor.vault.retry", args)).toEqual({
    ok: true,
    result: published,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.state.probe = async () => {
    entered.resolve();
    await release.promise;
  };
  const pending = f.host.dispatch(f.root, "vendor.vault.retry", args);
  await entered.promise;
  f.auth.revokeGrant(f.createGrant.id, f.root);
  release.resolve();
  expect(await pending).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  expect(f.auth.allowsRef(f.root, declaration.readCapability, published.ref)).toBe(true);
  expect(f.store.db.query("SELECT role FROM reference_grant_provenance").all()).toEqual([
    { role: "creator" },
  ]);
});

test("lost delete ACK is reachable only through the exact original-credential receipt door after ordinary deletion admission closes", async () => {
  const f = await fixture();
  const published = await f.create();
  const expected = { ref: published.ref, preparationId: published.preparationId, state: "deleted" };
  expect(await f.host.dispatch(f.root, "vendor.vault.delete", { ref: published.ref })).toEqual({
    ok: true,
    result: expected,
  });
  expect(f.auth.allowsRef(f.root, declaration.deleteCapability, published.ref)).toBe(false);
  expect(
    await f.host.dispatch(f.root, "vendor.vault.delete", { ref: published.ref }),
  ).toMatchObject({ ok: false, denial: { rule: "forbidden" } });
  expect(await f.host.dispatch(f.root, "vendor.vault.receipt", { ref: published.ref })).toEqual({
    ok: true,
    result: expected,
  });
  expect(
    await f.host.dispatch(f.root, "vendor.vault.otherReceipt", { ref: published.ref }),
  ).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  const replacement = f.auth.authenticate(
    f.auth.mintToken({ principalId: f.root.principal.id, caps: ["containers:read"] }, f.root).token,
  );
  expect(
    await f.host.dispatch(replacement, "vendor.vault.receipt", { ref: published.ref }),
  ).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  await expect(f.state.retainedReceipt!.references.receipt({ ref: published.ref })).rejects.toThrow(
    "reference_unavailable",
  );
  const unrelated = await f.create();
  expect(
    await f.host.dispatch(f.root, "vendor.vault.receipt", { ref: unrelated.ref }),
  ).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  f.state.mutateInReceipt = true;
  expect(
    await f.host.dispatch(f.root, "vendor.vault.receipt", { ref: unrelated.ref }),
  ).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
  expect(await f.host.resolveOwnedReference(f.root, unrelated.ref)).toEqual({
    exists: true,
    title: "private reference title",
  });
});

test.each(["expiry", "revocation"])(
  "receipt authority belongs to the deleter operation, not the creator, and enforces pause and %s",
  async (cutoff) => {
    const f = await fixture();
    const published = await f.create();
    const deleter = {
      ...f.auth.authenticate(
        f.auth.mintToken(
          {
            principal: { kind: "human", name: "deleter" },
            caps: ["containers:read"],
          },
          f.root,
        ).token,
      ),
      expiresAt: f.runtime.now() + 100,
    };
    const authority = f.auth.grant(
      {
        principal: { kind: "principal", id: deleter.principal.id },
        node: formatManifoldUri(published.ref),
        caps: [declaration.deleteCapability],
        effect: "allow",
        reach: "node",
      },
      f.root,
    );
    const deleted = await f.host.dispatch(deleter, "vendor.vault.delete", { ref: published.ref });
    expect(deleted.ok).toBe(true);
    f.auth.revokeGrant(authority.id, f.root);
    expect(await f.host.dispatch(deleter, "vendor.vault.receipt", { ref: published.ref })).toEqual(
      deleted,
    );
    expect(
      await f.host.dispatch(f.root, "vendor.vault.receipt", { ref: published.ref }),
    ).toMatchObject({ ok: false, denial: { message: "reference_unavailable" } });
    f.auth.pausePrincipalAccess({ principalId: deleter.principal.id }, f.root);
    expect(
      (await f.host.dispatch(deleter, "vendor.vault.receipt", { ref: published.ref })).ok,
    ).toBe(false);
    f.auth.resumePrincipalAccess({ principalId: deleter.principal.id }, f.root);
    expect(await f.host.dispatch(deleter, "vendor.vault.receipt", { ref: published.ref })).toEqual(
      deleted,
    );
    if (cutoff === "expiry") f.runtime.time += 100;
    else f.auth.revokePrincipal(deleter.principal.id, f.root);
    expect(
      (await f.host.dispatch(deleter, "vendor.vault.receipt", { ref: published.ref })).ok,
    ).toBe(false);
  },
);

test("scope-only reference reconciliation still enforces live Run acknowledgement, sponsor pause and durable agent envelope", async () => {
  const f = await fixture();
  const published = await f.create();
  const sponsor = f.auth.authenticate(
    f.auth.mintToken(
      {
        principal: { kind: "human", name: "sponsor" },
        caps: ["agents:delegate", "containers:read"],
      },
      f.root,
    ).token,
  );
  const created = await createExternalRun(
    { auth: f.auth, runtime: f.runtime, owner: f.root },
    {
      name: "Scope check",
      purpose: "Observe receipt confinement",
      target: "manifold://",
      reach: "subtree",
      caps: ["containers:read"],
    },
    sponsor,
  );
  const actor = f.auth.authenticate(created.credential.token);
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(false);
  const challenge = f.auth.agentPolicyChallenge(actor);
  f.auth.acknowledgeAgentPolicy(
    {
      revision: challenge.revision,
      acknowledgements: challenge.required.map(({ id, digest }) => ({ id, digest })),
    },
    actor,
  );
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(true);
  // Scope containment never invents a resource permission: this Run has no file capabilities.
  expect(f.auth.allowsRef(actor, declaration.readCapability, published.ref)).toBe(false);
  f.auth.pausePrincipalAccess({ principalId: sponsor.principal.id }, f.root);
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(false);
  f.auth.resumePrincipalAccess({ principalId: sponsor.principal.id }, f.root);
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(true);
  const agent = f.store.getAgent(created.run.agentId)!;
  await f.auth.updateAgent(
    {
      agentId: agent.agentId,
      grant: {
        ...agent.grant,
        targets: ["manifold://plugin/vendor.other"],
        reach: "node",
      },
    },
    f.root,
  );
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(false);
  await f.auth.updateAgent({ agentId: agent.agentId, grant: agent.grant }, f.root);
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(true);
  f.auth.revokePrincipal(sponsor.principal.id, f.root);
  expect(f.auth.containsReferenceTarget(actor, published.ref)).toBe(false);
});

test("the library filter discloses only currently readable published identities through its declared door", async () => {
  const f = await fixture();
  const first = await f.create();
  const second = await f.create();
  const reader = f.auth.authenticate(
    f.auth.mintToken(
      {
        principal: { kind: "human", name: "library-reader" },
        caps: ["containers:read"],
      },
      f.root,
    ).token,
  );
  const input = {
    kind: "file",
    refs: [first.ref, second.ref, { kind: "file", fileId: "missing" }],
  };
  expect(await f.host.dispatch(reader, "vendor.vault.list", input)).toMatchObject({
    ok: true,
    result: [],
  });
  const grant = f.auth.grant(
    {
      principal: { kind: "principal", id: reader.principal.id },
      node: formatManifoldUri(first.ref),
      caps: [declaration.readCapability],
      effect: "allow",
      reach: "node",
    },
    f.root,
  );
  expect(await f.host.dispatch(reader, "vendor.vault.list", input)).toMatchObject({
    ok: true,
    result: [first],
  });
  expect(await f.host.dispatch(reader, "vendor.vault.otherList", input)).toMatchObject({
    ok: false,
    denial: { message: "reference_unavailable" },
  });
  f.auth.revokeGrant(grant.id, f.root);
  expect(await f.host.dispatch(reader, "vendor.vault.list", input)).toMatchObject({
    ok: true,
    result: [],
  });
});

test("the library filter removes an earlier candidate revoked while a later readiness probe waits", async () => {
  const f = await fixture();
  const first = await f.create();
  const second = await f.create();
  const reader = f.auth.authenticate(
    f.auth.mintToken(
      {
        principal: { kind: "human", name: "library-revocation-reader" },
        caps: ["containers:read"],
      },
      f.root,
    ).token,
  );
  const grants = [first, second].map((publication) =>
    f.auth.grant(
      {
        principal: { kind: "principal", id: reader.principal.id },
        node: formatManifoldUri(publication.ref),
        caps: [declaration.readCapability],
        effect: "allow",
        reach: "node",
      },
      f.root,
    ),
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let probes = 0;
  f.state.probe = async () => {
    if (++probes !== 2) return;
    entered.resolve();
    await release.promise;
  };
  const result = f.host.dispatch(reader, "vendor.vault.list", {
    kind: "file",
    refs: [first.ref, second.ref],
  });
  try {
    await entered.promise;
    f.auth.revokeGrant(grants[0]!.id, f.root);
  } finally {
    release.resolve();
  }
  expect(await result).toMatchObject({ ok: true, result: [second] });
});
